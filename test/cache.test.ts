import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  AudioCache,
  CacheError,
  cacheKey,
  clipExtension,
  type CacheKeyInput,
} from "../cache.ts";

const base: CacheKeyInput = {
  text: "Hello there.",
  provider: "elevenlabs",
  voiceId: "voice-one",
  modelId: "model-one",
  outputFormat: "mp3_44100_128",
  voiceRevision: 1,
  normalizerVersion: 1,
};
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2, 12);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speak-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cache = (
  overrides: Partial<ConstructorParameters<typeof AudioCache>[0]> = {},
) =>
  new AudioCache({
    root: join(dir, "cache"),
    maxBytes: 1000,
    ttlDays: 7,
    now: () => NOW,
    ...overrides,
  });

const age = (path: string, ms: number) =>
  utimes(path, new Date(NOW - ms), new Date(NOW - ms));

test("the key is stable and changes with every input that affects the audio", () => {
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.match(cacheKey(base), /^[0-9a-f]{64}$/);
  const changes: Partial<CacheKeyInput>[] = [
    { text: "Hello there!" },
    { provider: "other" },
    { voiceId: "voice-two" },
    { modelId: "model-two" },
    { outputFormat: "mp3_22050_32" },
    { voiceRevision: 2 },
    { normalizerVersion: 2 },
    { speechLocale: "vi" },
    { speechLocale: "en" },
  ];
  const keys = new Set([
    cacheKey(base),
    ...changes.map((change) => cacheKey({ ...base, ...change })),
  ]);
  assert.equal(keys.size, changes.length + 1);
});

test("clip extensions come from the codec and are filesystem-safe", () => {
  assert.equal(clipExtension("mp3_44100_128"), "mp3");
  assert.equal(clipExtension("../../x"), "bin");
});

test("a stored clip is a hit, with private permissions and no source text on disk", async () => {
  const c = cache();
  const key = cacheKey(base);
  assert.equal(await c.get(key, "mp3"), undefined);
  const path = await c.put(key, "mp3", Buffer.from("AUDIO"));
  assert.equal(await c.get(key, "mp3"), path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(c.root)).mode & 0o777, 0o700);
  assert.equal((await readFile(path)).toString(), "AUDIO");
  const names = await readdir(c.root);
  assert.deepEqual(names, [`${key}.mp3`]);
  assert.ok(!names.join().includes("Hello"));
});

test("an empty file or a non-regular entry is not a hit", async () => {
  const c = cache();
  await c.ensureDir();
  const empty = cacheKey({ ...base, text: "empty" });
  await writeFile(c.pathFor(empty, "mp3"), "");
  assert.equal(await c.get(empty, "mp3"), undefined);
  const linked = cacheKey({ ...base, text: "linked" });
  await writeFile(join(dir, "outside"), "OUTSIDE");
  await symlink(join(dir, "outside"), c.pathFor(linked, "mp3"));
  assert.equal(await c.get(linked, "mp3"), undefined);
});

test("a cache directory that is a symlink is refused", async () => {
  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "cache"));
  await assert.rejects(() => cache().ensureDir(), CacheError);
});

test("a directory owned by another user is refused", async () => {
  await assert.rejects(
    () => cache({ uid: 424242 }).ensureDir(),
    /another user/,
  );
});

test("a loose directory mode is tightened to owner-only", async () => {
  const c = cache();
  await mkdir(c.root, { mode: 0o755 });
  await c.ensureDir();
  assert.equal((await stat(c.root)).mode & 0o777, 0o700);
});

test("expired clips are evicted but fresh ones and the protected one stay", async () => {
  const c = cache({ maxBytes: 10_000 });
  const old = await c.put(
    cacheKey({ ...base, text: "old" }),
    "mp3",
    Buffer.from("x"),
  );
  const fresh = await c.put(
    cacheKey({ ...base, text: "fresh" }),
    "mp3",
    Buffer.from("x"),
  );
  const playing = await c.put(
    cacheKey({ ...base, text: "playing" }),
    "mp3",
    Buffer.from("x"),
  );
  await age(old, 8 * DAY);
  await age(playing, 9 * DAY);
  assert.deepEqual(await c.evict(playing), [old]);
  assert.deepEqual(
    (await readdir(c.root)).sort(),
    [fresh, playing].map((p) => p.split("/").pop()).sort(),
  );
});

test("oldest clips go first when over the size cap, sparing the protected clip", async () => {
  const c = cache({ maxBytes: 250 });
  const keys = ["a", "b", "c"].map((text) => cacheKey({ ...base, text }));
  const [a, b, cPath] = [
    await c.put(keys[0], "mp3", Buffer.alloc(100)),
    await c.put(keys[1], "mp3", Buffer.alloc(100)),
    await c.put(keys[2], "mp3", Buffer.alloc(100)),
  ];
  await age(a, 3000);
  await age(b, 2000);
  await age(cPath, 1000);
  assert.deepEqual(await c.evict(a), [b]);
  const remaining = await readdir(c.root);
  assert.equal(remaining.length, 2);
  assert.ok(
    remaining.includes(`${keys[0]}.mp3`) &&
      remaining.includes(`${keys[2]}.mp3`),
  );
});

test("eviction ignores symlinks, foreign files, and fresh temporary files but removes stale temporaries", async () => {
  const c = cache({ maxBytes: 1 });
  await c.ensureDir();
  await writeFile(join(dir, "outside"), "OUTSIDE");
  await symlink(join(dir, "outside"), join(c.root, `${"0".repeat(64)}.mp3`));
  await writeFile(join(c.root, "notes.txt"), "keep");
  const fresh = join(c.root, `${"1".repeat(64)}.aaaa.tmp`);
  const stale = join(c.root, `${"2".repeat(64)}.bbbb.tmp`);
  await writeFile(fresh, "t");
  await writeFile(stale, "t");
  await utimes(fresh, new Date(NOW), new Date(NOW));
  await age(stale, 2 * 60 * 60 * 1000);
  assert.deepEqual(await c.evict(), [stale]);
  assert.equal(await readFile(join(dir, "outside"), "utf8"), "OUTSIDE");
  assert.equal((await readdir(c.root)).length, 3);
});

test("a failed write leaves no temporary file behind", async () => {
  const c = cache();
  const key = cacheKey(base);
  await c.ensureDir();
  await mkdir(c.pathFor(key, "mp3"));
  await assert.rejects(() => c.put(key, "mp3", Buffer.from("x")));
  assert.deepEqual(
    (await readdir(c.root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
