import assert from "node:assert/strict";
import { test } from "node:test";
import { audioResponse } from "./harness.ts";
import { FakeClock } from "./hold-clock.ts";
import { afterStart, pendingFetch, players, settle, speakAloud, spokenTexts, startLive } from "./live-harness.ts";
import { audio, baseConfig, sessionEvent, useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();
const OTHER_TOOLS = ["read", "bash"];
const KEY_LINE = "alt+t cuts Pi off · /talk live ends live mode";

/** Live mode with an update playing and a second one waiting behind it. */
async function playingWithOneWaiting(h: Harness) {
  h.setFetch(async () => audioResponse());
  const live = await startLive(h);
  await speakAloud(h, "Đang chạy các bài test.");
  await speakAloud(h, "Xong rồi.");
  await h.until(() => players(h).length === 1);
  return { ...live, player: players(h)[0]! };
}

const sentChunk = (h: Harness, index: number) => {
  const bytes = Buffer.from(h.sockets[0]!.chunks()[index]!.audio_base_64, "base64");
  return { length: bytes.length, first: bytes[0], last: bytes[bytes.length - 1] };
};

const liveOn = async (h: Harness) => {
  await h.run("status");
  return /live mode: on/.test(h.notices.at(-1)!.message);
};

test("while an update plays, the same amount of silence replaces the microphone and the connection stays open", async () => {
  const h = await harness();
  const { child, socket, player } = await playingWithOneWaiting(h);
  audio(child, 3200);
  audio(child, 1600);
  assert.equal(socket.chunks().length, 2, "the connection keeps receiving audio at the normal rate");
  assert.deepEqual([sentChunk(h, 0), sentChunk(h, 1)], [
    { length: 3200, first: 0, last: 0 },
    { length: 1600, first: 0, last: 0 },
  ]);
  assert.equal(socket.closes.length, 0);
  player.finish(0);
  await settle();
});

test("microphone audio is sent before the update's player starts and 500 ms after it exits, and silence in between", async () => {
  const clock = new FakeClock();
  const h = await harness({ liveClock: clock });
  h.setFetch(async () => audioResponse());
  const { child } = await startLive(h);
  audio(child, 3200);
  await speakAloud(h, "Đang kiểm tra.");
  await h.until(() => players(h).length === 1);
  audio(child, 3200);
  players(h)[0]!.finish(0);
  await settle();
  clock.advance(300);
  audio(child, 3200);
  clock.advance(199);
  audio(child, 3200);
  clock.advance(1);
  audio(child, 3200);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => sentChunk(h, index).first),
    [1, 0, 0, 0, 1],
    "heard, muted while playing, muted at 300 ms and at 499 ms, heard again at 500 ms",
  );
  assert.ok([0, 1, 2, 3, 4].every((index) => sentChunk(h, index).length === 3200));
});

test("with input.liveListenWhileSpeaking on, microphone audio keeps being sent while Pi speaks", async () => {
  const h = await harness({ config: baseConfig({ liveListenWhileSpeaking: true }) });
  const { child, player } = await playingWithOneWaiting(h);
  audio(child, 3200);
  assert.equal(sentChunk(h, 0).first, 1);
  player.finish(0);
  await settle();
});

test("the send key cuts Pi off: playback stops, the waiting update is dropped, and the agent and live mode carry on", async () => {
  const h = await harness();
  const { child, player } = await playingWithOneWaiting(h);
  await h.pressShortcut();
  assert.deepEqual(player.signals, ["SIGTERM"]);
  await settle();
  assert.equal(h.fetchCalls.length, 1, "the waiting update was never requested");
  assert.equal(players(h).length, 1);
  assert.equal(h.aborts, 0, "the agent is not aborted");
  assert.deepEqual(child.signals, [], "the microphone stays open");
  assert.equal(await liveOn(h), true);
  assert.doesNotMatch(afterStart(h).join("\n"), /Nothing is being spoken/);
  await h.pressShortcut();
  assert.match(afterStart(h).join("\n"), /^Nothing is being spoken\.$/m, "a second press finds nothing to cut off");
});

test("/speak stop during live mode ends playback, drops the waiting update, and live mode stays on", async () => {
  const h = await harness();
  const { player } = await playingWithOneWaiting(h);
  await h.run("stop");
  assert.deepEqual(player.signals, ["SIGTERM"]);
  await settle();
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(players(h).length, 1);
  assert.match(h.messages(), /Stopped\./);
  assert.equal(await liveOn(h), true);
});

test("the send key also cuts off an update that is still being synthesized", async () => {
  const h = await harness();
  h.setFetch(pendingFetch);
  await startLive(h);
  await speakAloud(h, "Đang kiểm tra.");
  await h.until(() => h.fetchCalls.length === 1);
  await h.pressShortcut();
  await settle();
  assert.equal(players(h).length, 0, "nothing plays once the request is aborted");
  assert.deepEqual(afterStart(h), [], "no message, and no failure for the cancelled request");
  assert.equal(await liveOn(h), true);
});

test("with the setting on, the first non-empty partial transcript cuts Pi off and the words become a turn once committed", async () => {
  const h = await harness({ config: baseConfig({ liveListenWhileSpeaking: true }) });
  const { socket, player } = await playingWithOneWaiting(h);
  socket.message({ message_type: "partial_transcript", text: "dừng" });
  assert.deepEqual(player.signals, ["SIGTERM"]);
  await settle();
  assert.equal(h.fetchCalls.length, 1, "the waiting update is dropped");
  assert.equal(h.sent.length, 0, "nothing is sent before the pause");
  socket.committed("dừng lại, làm việc khác");
  await h.until(() => h.sent.length === 1);
  assert.equal(h.sent[0]!.text, "dừng lại, làm việc khác");
  assert.equal(await liveOn(h), true);
});

test("with the setting off, speaking while an update plays does not cut Pi off and sends nothing", async () => {
  const h = await harness();
  const { socket, child, player } = await playingWithOneWaiting(h);
  audio(child, 3200);
  socket.message({ message_type: "partial_transcript", text: "dừng" });
  await settle();
  assert.deepEqual(player.signals, [], "playback continues");
  assert.equal(sentChunk(h, 0).first, 0, "what the microphone heard never reached the provider");
  assert.equal(h.sent.length, 0);
  player.finish(0);
  await settle();
  assert.equal(players(h).length, 2, "the waiting update still plays after it");
});

test("the status line says Pi is speaking with the cut-off key while an update is spoken, and listening afterwards", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  assert.equal(h.liveStatuses.at(-1), `● Live — listening · ${KEY_LINE}`);
  await speakAloud(h, "Đang kiểm tra.");
  await h.until(() => players(h).length === 1);
  assert.equal(h.liveStatuses.at(-1), `● Live — Pi speaking · ${KEY_LINE}`);
  players(h)[0]!.finish(0);
  await h.until(() => /listening/.test(h.liveStatuses.at(-1) ?? ""));
  assert.equal(h.liveStatuses.at(-1), `● Live — listening · ${KEY_LINE}`);
});

for (const [name, end] of [
  ["/talk live", (h: Harness) => h.runTalk("live")],
  ["a lost connection", (h: Harness) => h.sockets[0]!.emit("close")],
] as const)
  test(`ending live mode by ${name} while Pi speaks stops the update, drops the waiting one, and removes the tool`, async () => {
    const h = await harness({ activeTools: OTHER_TOOLS });
    const { player } = await playingWithOneWaiting(h);
    await end(h);
    assert.deepEqual(player.signals, ["SIGTERM"]);
    await settle();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(players(h).length, 1);
    assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
    assert.equal(h.liveStatuses.at(-1), undefined);
    assert.equal(await liveOn(h), false);
  });

test("a session switched while Pi speaks stops playback, leaves live mode off in the new session, and keeps the tool out of its runs", async () => {
  const h = await harness({ activeTools: OTHER_TOOLS });
  const { player } = await playingWithOneWaiting(h);
  sessionEvent(h, "session_before_switch");
  assert.deepEqual(player.signals, ["SIGTERM"]);
  await settle();
  assert.equal(h.fetchCalls.length, 1, "the waiting update is dropped");
  assert.equal(players(h).length, 1);
  assert.equal(await liveOn(h), false);
  assert.equal(h.liveStatuses.at(-1), undefined);
  h.events.get("before_agent_start")!();
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS, "speak_aloud is not declared to the model in the new session");
  assert.match(await speakAloud(h, "Xin chào."), /live mode is off/);
  assert.deepEqual(spokenTexts(h), ["Đang chạy các bài test."]);
});
