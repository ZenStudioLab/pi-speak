import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  playerArgs,
  childEnvironment,
  resolveExecutable,
  startPlayer,
  type SpawnFn,
} from "../audio.ts";
import { API_KEY, FakeChild } from "./harness.ts";

const node = process.execPath;
const run = (
  script: string,
  file = "unused",
  env: Record<string, string> = {},
) =>
  startPlayer({
    command: node,
    args: ["-e", script, "{file}"],
    file,
    env: { PATH: process.env.PATH ?? "", ...env },
  });

test("the audio path stays one argument, whatever characters it has", async () => {
  assert.deepEqual(playerArgs(["--x", "{file}", "-y"], "/a b/$(c);d.mp3"), [
    "--x",
    "/a b/$(c);d.mp3",
    "-y",
  ]);
  const hostile = "a b;$(x)'\"`";
  const exit = await run(
    "process.exit(process.argv.at(-1) === process.env.EXPECT ? 0 : 9)",
    hostile,
    { EXPECT: hostile },
  ).done;
  assert.deepEqual(exit, { kind: "finished" });
});

test("both provider keys are removed from the player's environment and audio settings stay", async () => {
  const clean = childEnvironment({ ELEVENLABS_API_KEY: API_KEY, DEEPGRAM_API_KEY: "deep-secret", PULSE_SERVER: "pulse", KEEP: "1" });
  assert.deepEqual(clean, { PULSE_SERVER: "pulse", KEEP: "1" });
  const exit = await run(
    "process.exit(process.env.ELEVENLABS_API_KEY === undefined && process.env.DEEPGRAM_API_KEY === undefined && process.env.PULSE_SERVER === 'pulse' && process.env.KEEP === '1' ? 0 : 7)",
    "f",
    {
      ELEVENLABS_API_KEY: API_KEY,
      DEEPGRAM_API_KEY: "deep-secret",
      PULSE_SERVER: "pulse",
      KEEP: "1",
    },
  ).done;
  assert.deepEqual(exit, { kind: "finished" });
});

test("a player that exits nonzero is a failure with bounded, printable diagnostics", async () => {
  const exit = await run(
    "console.error('boom\\u0007' + 'x'.repeat(5000)); process.exit(2)",
  ).done;
  assert.equal(exit.kind, "failed");
  assert.ok(
    exit.kind === "failed" && exit.detail.startsWith("exit code 2: boom"),
  );
  assert.ok(exit.kind === "failed" && exit.detail.length < 260);
  assert.ok(exit.kind === "failed" && !exit.detail.includes("\u0007"));
});

test("a player that cannot start is a failure, not a crash", async () => {
  const exit = await startPlayer({
    command: "/nonexistent/player",
    args: ["{file}"],
    file: "f",
    env: {},
  }).done;
  assert.equal(exit.kind, "failed");
});

test("stopping ends only that player and is reported as stopped, never as a failure", async () => {
  const player = run("setInterval(() => {}, 1000)");
  await new Promise((resolve) => setTimeout(resolve, 100));
  player.stop();
  player.stop();
  assert.deepEqual(await player.done, { kind: "stopped" });
});

test("a player that ignores SIGTERM is killed after the grace period", async () => {
  const child = new FakeChild();
  child.autoExitOnKill = false;
  const original = child.kill.bind(child);
  child.kill = (signal) => {
    original(signal);
    if (signal === "SIGKILL")
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    return true;
  };
  // SAFETY: startPlayer uses only stderr, once, and kill on the child.
  const spawnFn = (() => child) as unknown as SpawnFn;
  const player = startPlayer({
    command: "p",
    args: ["{file}"],
    file: "f",
    env: {},
    spawnFn,
    killGraceMs: 20,
  });
  // The production kill timer is unref'd so a stuck player cannot keep Pi alive; hold the loop open here.
  const keepAlive = setTimeout(() => undefined, 2000);
  player.stop();
  try {
    assert.deepEqual(await player.done, { kind: "stopped" });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("spawn is called without a shell and with stdin and stdout ignored", () => {
  const seen: { options: unknown }[] = [];
  const child = new FakeChild();
  // SAFETY: startPlayer uses only stderr, once, and kill on the child.
  const spawnFn = ((
    _command: string,
    _args: readonly string[],
    options: unknown,
  ) => {
    seen.push({ options });
    return child;
  }) as unknown as SpawnFn;
  startPlayer({
    command: "p",
    args: ["{file}"],
    file: "f",
    env: { ELEVENLABS_API_KEY: API_KEY },
    spawnFn,
  });
  assert.deepEqual(seen[0].options, {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: {},
  });
});

test("executables are found by absolute path or on PATH, and only when executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speak-exec-"));
  try {
    await writeFile(join(dir, "runnable"), "#!/bin/sh\n");
    await chmod(join(dir, "runnable"), 0o755);
    await writeFile(join(dir, "plain"), "data");
    assert.equal(
      await resolveExecutable("runnable", { PATH: dir }),
      join(dir, "runnable"),
    );
    assert.equal(
      await resolveExecutable(join(dir, "runnable"), {}),
      join(dir, "runnable"),
    );
    assert.equal(await resolveExecutable("plain", { PATH: dir }), undefined);
    assert.equal(
      await resolveExecutable("missing-player", { PATH: dir }),
      undefined,
    );
    assert.equal(
      await resolveExecutable(dirname(node) ? "node" : "node", {
        PATH: dirname(node),
      }),
      join(dirname(node), "node"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
