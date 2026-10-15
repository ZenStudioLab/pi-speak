import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock } from "./hold-clock.ts";
import { afterStart, startLive } from "./live-harness.ts";
import { baseConfig, useTalkHarness } from "./talk-harness.ts";

const harness = useTalkHarness();
const TICK = 15_000;

/** A harness whose idle timer runs on a fake clock; the agent is idle unless `agent.busy` is set. */
async function setup(input: Record<string, unknown> = { liveIdleMinutes: 1 }) {
  const clock = new FakeClock();
  const h = await harness({ config: baseConfig(input), liveClock: clock });
  const agent = { busy: false };
  const live = await startLive(h, { isIdle: () => !agent.busy });
  return { h, clock, agent, ...live };
}

const idleMessages = (h: Awaited<ReturnType<typeof setup>>["h"]) =>
  afterStart(h).filter((message) => /because it was idle/.test(message));

test("live mode ends after the idle limit with the idle message, and no timer remains", async () => {
  const { h, clock, child, socket } = await setup();
  clock.advance(45_000);
  assert.equal(idleMessages(h).length, 0, "still on before the limit");
  clock.advance(TICK);
  assert.equal(idleMessages(h).length, 1);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.ok(socket.closes.length >= 1);
  assert.equal(h.liveStatuses.at(-1), undefined);
  assert.equal(clock.pending, 0);
});

test("the default limit is five minutes", async () => {
  const { h, clock } = await setup({});
  for (let elapsed = TICK; elapsed < 300_000; elapsed += TICK) clock.advance(TICK);
  assert.equal(idleMessages(h).length, 0, "still on after 4 minutes 45 seconds");
  clock.advance(TICK);
  assert.equal(idleMessages(h).length, 1);
});

test("agent work does not count: the limit runs only from when the agent becomes idle", async () => {
  const { h, clock, agent } = await setup();
  agent.busy = true;
  for (let i = 0; i < 40; i++) clock.advance(TICK);
  assert.equal(idleMessages(h).length, 0, "ten minutes of agent work");
  agent.busy = false;
  clock.advance(TICK);
  clock.advance(45_000);
  assert.equal(idleMessages(h).length, 0, "45 seconds of idleness");
  clock.advance(TICK);
  assert.equal(idleMessages(h).length, 1);
});

test("a turn that was sent restarts the idle count", async () => {
  const { h, clock, socket } = await setup();
  clock.advance(45_000);
  socket.committed("are you there");
  await h.until(() => h.sent.length === 1);
  clock.advance(45_000);
  assert.equal(idleMessages(h).length, 0, "90 seconds since start, 45 since the turn");
  clock.advance(TICK);
  assert.equal(idleMessages(h).length, 1);
});

test("no timer remains after /talk live ends live mode, after a failure, or after a session change", async () => {
  for (const end of [
    (h: Awaited<ReturnType<typeof setup>>) => h.h.runTalk("live"),
    async (h: Awaited<ReturnType<typeof setup>>) => h.socket.emit("close"),
    async (h: Awaited<ReturnType<typeof setup>>) => h.h.events.get("session_before_switch")!(),
  ]) {
    const started = await setup();
    assert.equal(started.clock.pending, 1, "one idle timer while live mode is on");
    await end(started);
    assert.equal(started.clock.pending, 0);
    started.clock.advance(120_000);
    assert.equal(idleMessages(started.h).length, 0);
  }
});

test("while live mode is starting no idle timer exists", async () => {
  const clock = new FakeClock();
  const h = await harness({ liveClock: clock, holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  assert.equal(clock.pending, 0);
  await h.runTalk("live");
  await starting;
  assert.equal(clock.pending, 0);
});
