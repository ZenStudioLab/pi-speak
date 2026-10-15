import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { SpawnFn } from "../audio.ts";
import {
  BYTES_PER_SECOND,
  RECORDER_ARGS,
  findRecorder,
  inputLevel,
  startRecorder,
  wavFromPcm,
} from "../record.ts";
import { FakeChild } from "./harness.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A PATH holding empty executables with these names. */
async function pathWith(...tools: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "speak-record-"));
  dirs.push(dir);
  await mkdir(join(dir, "bin"));
  for (const tool of tools) {
    await writeFile(join(dir, "bin", tool), "#!/bin/sh\n");
    await chmod(join(dir, "bin", tool), 0o755);
  }
  return join(dir, "bin");
}

function fakeSpawn() {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  // SAFETY: Only the members startRecorder uses (stdout, stderr, once, kill) exist on the fake child.
  const spawnFn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args: [...args], options });
    return child;
  }) as unknown as SpawnFn;
  return { calls, children, spawnFn };
}

async function start(maxSeconds = 60, extra: { killGraceMs?: number; onLevel?: (level: number) => void } = {}) {
  const spawned = fakeSpawn();
  const result = await startRecorder({
    env: { PATH: await pathWith("rec") },
    maxSeconds,
    spawnFn: spawned.spawnFn,
    ...extra,
  });
  assert.ok(result.ok);
  return { ...spawned, handle: result.handle, child: spawned.children[0]! };
}

/** A streaming recorder (`retain: false`) that reports its chunks and levels. */
async function startStreaming() {
  const spawned = fakeSpawn();
  const chunks: Buffer[] = [];
  const levels: number[] = [];
  const result = await startRecorder({
    env: { PATH: await pathWith("rec") },
    retain: false,
    spawnFn: spawned.spawnFn,
    onChunk: (chunk) => chunks.push(chunk),
    onLevel: (level) => levels.push(level),
  });
  assert.ok(result.ok);
  return { ...spawned, handle: result.handle, child: spawned.children[0]!, chunks, levels };
}

const pcm = (bytes: number) => new Uint8Array(bytes).fill(1);

for (const [available, expected] of [
  [["rec", "arecord", "ffmpeg"], "rec"],
  [["arecord", "ffmpeg"], "arecord"],
  [["ffmpeg"], "ffmpeg"],
] as const)
  test(`the recorder lookup prefers ${expected} among ${available.join(", ")} and runs it with fixed arguments and no shell`, async () => {
    const env = { PATH: await pathWith(...available) };
    const spawned = fakeSpawn();
    const result = await startRecorder({ env, maxSeconds: 60, spawnFn: spawned.spawnFn });
    assert.ok(result.ok);
    assert.equal((await findRecorder(env))?.tool, expected);
    assert.equal(spawned.calls.length, 1);
    assert.ok(spawned.calls[0]!.command.endsWith(`/${expected}`));
    assert.deepEqual(spawned.calls[0]!.args, [...RECORDER_ARGS[expected]]);
    assert.equal(spawned.calls[0]!.options.shell, false);
  });

test("no recording tool starts nothing and names the tools it looked for", async () => {
  const spawned = fakeSpawn();
  const result = await startRecorder({
    env: { PATH: await pathWith() },
    maxSeconds: 60,
    spawnFn: spawned.spawnFn,
  });
  assert.deepEqual(result, { ok: false, tried: ["rec", "arecord", "ffmpeg"] });
  assert.equal(spawned.calls.length, 0);
});

test("the recorder never receives either provider key but keeps audio settings", async () => {
  const spawned = fakeSpawn();
  await startRecorder({
    env: {
      PATH: await pathWith("rec"),
      ELEVENLABS_API_KEY: "eleven-secret",
      DEEPGRAM_API_KEY: "deepgram-secret",
      PULSE_SERVER: "unix:/run/pulse",
    },
    maxSeconds: 60,
    spawnFn: spawned.spawnFn,
  });
  const env = spawned.calls[0]!.options.env as Record<string, string>;
  assert.equal(env.ELEVENLABS_API_KEY, undefined);
  assert.equal(env.DEEPGRAM_API_KEY, undefined);
  assert.equal(env.PULSE_SERVER, "unix:/run/pulse");
  assert.doesNotMatch(JSON.stringify(spawned.calls[0]!.args), /secret/);
});

test("a requested stop keeps its audio, sends SIGINT, and is not a failure", async () => {
  const { child, handle } = await start();
  child.emitAudio(pcm(3200));
  child.emitAudio(pcm(3200));
  handle.stop();
  handle.stop();
  const exit = await handle.done;
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(exit.kind, "stopped");
  if (exit.kind === "stopped") {
    assert.equal(exit.pcm.length, 6400);
    assert.equal(exit.capped, false);
  }
});

test("a recorder that exits on its own is a failure even when it produced audio", async () => {
  const { child, handle } = await start();
  child.emitAudio(pcm(3200));
  child.stderr.emit("data", Buffer.from("cannot open device\u0007"));
  child.finish(1);
  const exit = await handle.done;
  assert.equal(exit.kind, "failed");
  if (exit.kind === "failed") {
    assert.match(exit.detail, /exited on its own \(exit code 1\): cannot open device/);
    assert.doesNotMatch(exit.detail, /\u0007/);
  }
});

test("audio that arrives after the recorder exits but before its output closes is kept", async () => {
  const { child, handle } = await start();
  child.autoExitOnKill = false;
  child.emitAudio(pcm(3200));
  handle.stop();
  child.emit("exit", null, "SIGINT");
  child.emitAudio(pcm(1600));
  child.emit("close", null, "SIGINT");
  const exit = await handle.done;
  assert.equal(exit.kind, "stopped");
  if (exit.kind === "stopped") assert.equal(exit.pcm.length, 4800);
});

test("a recorder that cannot run is a failure", async () => {
  const { child, handle } = await start();
  child.emit("error", new Error("spawn rec ENOENT"));
  const exit = await handle.done;
  assert.equal(exit.kind, "failed");
});

test("a requested stop that produced no audio is a failure", async () => {
  const { handle } = await start();
  handle.stop();
  const exit = await handle.done;
  assert.equal(exit.kind, "failed");
  if (exit.kind === "failed") assert.match(exit.detail, /no audio/);
});

test("audio stops growing at maxSeconds, which stops the recorder and reports the cap", async () => {
  const { child, handle } = await start(1);
  assert.equal(BYTES_PER_SECOND, 32000);
  child.emitAudio(pcm(20000));
  child.emitAudio(pcm(20000));
  child.emitAudio(pcm(20000));
  const exit = await handle.done;
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(exit.kind, "stopped");
  if (exit.kind === "stopped") {
    assert.equal(exit.pcm.length, 32000);
    assert.equal(exit.capped, true);
  }
});

test("a streaming recorder has no cap, keeps no audio, and still reports every chunk and level", async () => {
  const { child, handle, chunks, levels } = await startStreaming();
  const seconds = 130; // more than the 120 s push-to-talk default cap
  for (let i = 0; i < seconds; i++) child.emitAudio(pcm(BYTES_PER_SECOND));
  assert.equal(chunks.length, seconds);
  assert.equal(levels.length, seconds);
  assert.deepEqual(child.signals, []);
  handle.stop();
  const exit = await handle.done;
  assert.deepEqual(child.signals, ["SIGINT"]);
  // Lengths, not buffers: a failing deepEqual on megabytes of audio makes Node's diff exhaust memory.
  assert.equal(exit.kind, "stopped");
  if (exit.kind === "stopped") {
    assert.equal(exit.pcm.length, 0);
    assert.equal(exit.capped, false);
  }
});

test("a requested stop of a streaming recorder that heard nothing is still a stop, not a failure", async () => {
  const { handle } = await startStreaming();
  handle.stop();
  assert.deepEqual(await handle.done, { kind: "stopped", pcm: Buffer.alloc(0), capped: false });
});

test("a streaming recorder that exits on its own is a failure", async () => {
  const { child, handle } = await startStreaming();
  child.emitAudio(pcm(3200));
  child.finish(1);
  const exit = await handle.done;
  assert.equal(exit.kind, "failed");
  if (exit.kind === "failed") assert.match(exit.detail, /exited on its own \(exit code 1\)/);
});

test("a recorder that ignores SIGINT is killed after the grace period", async () => {
  const { child, handle } = await start(60, { killGraceMs: 10 });
  child.autoExitOnKill = false;
  child.emitAudio(pcm(3200));
  handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
  child.finish(0);
  assert.equal((await handle.done).kind, "stopped");
});

test("each chunk reports a coarse level", async () => {
  const levels: number[] = [];
  const { child, handle } = await start(60, { onLevel: (level) => levels.push(level) });
  child.emitAudio(new Uint8Array(3200));
  const loud = new Int16Array(1600).fill(30000);
  child.emitAudio(new Uint8Array(loud.buffer));
  handle.stop();
  await handle.done;
  assert.equal(levels[0], 0);
  assert.ok(levels[1]! >= 7 && levels[1]! <= 8);
  assert.equal(inputLevel(new Uint8Array(0)), 0);
});

test("the in-memory WAV header describes 16 kHz mono 16-bit PCM", () => {
  const wav = wavFromPcm(pcm(100));
  const view = new DataView(wav.buffer);
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  assert.equal(wav.length, 144);
  assert.deepEqual([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.equal(view.getUint32(4, true), 136);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 100);
  assert.equal(wav[44], 1);
});
