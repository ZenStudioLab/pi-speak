import assert from "node:assert/strict";
import { test } from "node:test";
import { afterStart, pendingFetch, players, settle, speakAloud, startLive } from "./live-harness.ts";
import { baseConfig, useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();
const OTHER_TOOLS = ["read", "bash"];

const sentTexts = (h: Harness) => h.sent.map((message) => message.text);
const ended = (h: Harness) => h.until(() => h.liveStatuses.at(-1) === undefined);
const liveOn = async (h: Harness) => {
  await h.run("status");
  return /live mode: on/.test(h.notices.at(-1)!.message);
};

for (const said of [
  "Dừng cuộc hội thoại.",
  "dung cuoc hoi thoai",
  "  DỪNG, cuộc hội thoại!  ",
  "stop the conversation!",
  "STOP THE CONVERSATION",
])
  test(`the default phrase ${JSON.stringify(said)} ends live mode and is never sent, stored, or repeated`, async () => {
    const h = await harness({ activeTools: OTHER_TOOLS });
    h.editor.text = "draft";
    const { child, socket } = await startLive(h);
    socket.committed(said);
    await ended(h);
    await settle();
    assert.equal(h.sent.length, 0);
    assert.equal(h.editor.text, "draft", "not added to the composer");
    const messages = afterStart(h);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /^Live mode ended because you said the stop phrase\./);
    assert.ok(!h.messages().toLowerCase().includes(said.trim().toLowerCase()), "the transcript is not repeated");
    assert.deepEqual(child.signals, ["SIGINT"], "the microphone closes");
    assert.ok(socket.closes.length >= 1, "the connection closes");
    assert.deepEqual(h.host.activeTools, OTHER_TOOLS, "speak_aloud is removed");
    assert.equal(h.aborts, 0, "the agent is not aborted");
    assert.equal(await liveOn(h), false);
  });

test("ending by the phrase also stops the update being spoken and drops the waiting ones", async () => {
  const h = await harness();
  h.setFetch(pendingFetch);
  const { socket } = await startLive(h);
  await speakAloud(h, "Đang chạy các bài test.");
  await speakAloud(h, "Xong rồi.");
  await h.until(() => h.fetchCalls.length === 1);
  socket.committed("Stop the conversation");
  await ended(h);
  await settle();
  assert.equal(h.fetchCalls.length, 1, "the waiting update never starts");
  assert.equal(players(h).length, 0);
});

for (const said of [
  "Okay, stop the conversation about tests and look at the loader",
  "stop the conversation please",
  "Dừng cuộc hội thoại này",
  "stop the conversation stop the conversation",
  "Dừng cuộc hội",
  "stop the conversations",
])
  test(`the turn ${JSON.stringify(said)} is not the whole phrase, so it is sent to Pi and live mode stays on`, async () => {
    const h = await harness();
    const { child, socket } = await startLive(h);
    socket.committed(said);
    await h.until(() => h.sent.length === 1);
    assert.deepEqual(sentTexts(h), [said]);
    assert.equal(afterStart(h).length, 0);
    assert.deepEqual(child.signals, []);
    assert.equal(await liveOn(h), true);
  });

test("a turn committed just before the phrase is still sent, the phrase is not, and live mode then ends", async () => {
  const h = await harness();
  const { socket } = await startLive(h);
  socket.committed("check the loader tests");
  socket.committed("Stop the conversation.");
  await ended(h);
  assert.deepEqual(sentTexts(h), ["check the loader tests"]);
  assert.equal(afterStart(h).length, 1);
});

test("segments committed after the phrase are dropped, before and after live mode has ended", async () => {
  const h = await harness();
  const { socket } = await startLive(h);
  socket.committed("first request");
  socket.committed("dung cuoc hoi thoai");
  socket.committed("second request");
  socket.committed("third request");
  await ended(h);
  socket.committed("fourth request");
  await settle();
  assert.deepEqual(sentTexts(h), ["first request"]);
  assert.equal(h.editor.text, "");
  assert.equal(afterStart(h).length, 1, "one end message and no turn warnings");
});

test("an empty live stop phrase list turns the feature off: the phrase is sent like any turn", async () => {
  const h = await harness({ config: baseConfig({ liveStopPhrases: [] }) });
  const { socket } = await startLive(h);
  socket.committed("Stop the conversation");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(sentTexts(h), ["Stop the conversation"]);
  assert.equal(await liveOn(h), true);
});

test("the push-to-talk stop phrases are separate: they do not end live mode, and a live phrase is not read from them", async () => {
  const h = await harness({ config: baseConfig({ stopPhrases: ["let's go"], liveStopPhrases: ["that is all"] }) });
  const { socket } = await startLive(h);
  socket.committed("let's go");
  socket.committed("Stop the conversation");
  await h.until(() => h.sent.length === 2);
  socket.committed("That is all!");
  await ended(h);
  assert.deepEqual(sentTexts(h), ["let's go", "Stop the conversation"]);
});

for (const [name, input, line] of [
  ["the first default phrase", {}, /^● Live — listening · alt\+t cuts Pi off · \/talk live ends live mode · or say "Dừng cuộc hội thoại"$/],
  ["the first configured phrase", { liveStopPhrases: ["end it", "stop"] }, / · or say "end it"$/],
  ["no phrase when the feature is off", { liveStopPhrases: [] }, /^● Live — listening · alt\+t cuts Pi off · \/talk live ends live mode$/],
] as const)
  test(`the status line names ${name}`, async () => {
    const h = await harness({ config: baseConfig(input) });
    await startLive(h);
    assert.match(h.liveStatuses.at(-1)!, line);
  });

for (const [name, value] of [
  ["a string", "stop"],
  ["a phrase with no letter or digit", ["..."]],
] as const)
  test(`${name} as input.liveStopPhrases refuses /talk live with the configuration error and opens nothing`, async () => {
    const h = await harness({ config: baseConfig({ liveStopPhrases: value }) });
    await h.runTalk("live");
    assert.match(h.messages(), /Live mode is not configured: .*input\.liveStopPhrases.*Live mode was not started/s);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.recorderChildren().length, 0);
    assert.equal(h.liveStatuses.length, 0);
    assert.equal(await liveOn(h), false);
  });
