import assert from "node:assert/strict";
import { test } from "node:test";
import { audioResponse } from "./harness.ts";
import { afterStart, players, settle, speakAloud, startLive } from "./live-harness.ts";
import { baseConfig, sessionEvent, useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();

const partial = (h: Harness, text: string) => h.sockets[0]!.message({ message_type: "partial_transcript", text });
const wordsWidgets = (h: Harness) => h.widgets.filter((widget) => widget.key === "speak-live-words");
/** What the widget shows now: its lines, or undefined once it is cleared or was never shown. */
const shown = (h: Harness) => wordsWidgets(h).at(-1)?.content;

test("a partial transcript is shown above the editor and replaced by each newer one", async () => {
  const h = await harness();
  await startLive(h);
  partial(h, "check the");
  assert.deepEqual(shown(h), ["Hearing: check the"]);
  assert.equal(wordsWidgets(h).at(-1)!.placement, "aboveEditor");
  partial(h, "check the loader tests");
  assert.deepEqual(shown(h), ["Hearing: check the loader tests"]);
});

test("the widget clears when the segment is committed, and the words then arrive as the turn", async () => {
  const h = await harness();
  const { socket } = await startLive(h);
  partial(h, "check the loader tests");
  socket.committed("check the loader tests");
  assert.equal(shown(h), undefined);
  await h.until(() => h.sent.length === 1);
  assert.equal(h.sent[0]!.text, "check the loader tests");
  partial(h, "and then");
  assert.deepEqual(shown(h), ["Hearing: and then"], "the next segment shows again");
});

for (const [name, end] of [
  ["/talk live", (h: Harness) => h.runTalk("live")],
  ["the live key", (h: Harness) => h.pressLiveShortcut()],
  ["a session switch", async (h: Harness) => sessionEvent(h, "session_before_switch")],
  ["a reload", async (h: Harness) => sessionEvent(h, "session_shutdown")],
  ["a lost connection", async (h: Harness) => h.sockets[0]!.emit("close")],
] as const)
  test(`the widget clears when live mode ends by ${name}, and a late partial shows nothing`, async () => {
    const h = await harness();
    await startLive(h);
    partial(h, "check the loader");
    assert.ok(shown(h), "shown first");
    await end(h);
    assert.equal(shown(h), undefined);
    partial(h, "too late");
    assert.equal(shown(h), undefined);
  });

test("the words are only displayed: the composer, the session, and every message stay free of them", async () => {
  const h = await harness();
  await startLive(h);
  h.editor.text = "my draft";
  partial(h, "secret words spoken aloud");
  assert.equal(h.editor.text, "my draft");
  await h.runTalk("live");
  assert.equal(h.editor.text, "my draft");
  assert.equal(h.sent.length, 0, "nothing was sent");
  assert.equal(h.submitted, 0);
  assert.ok(!h.messages().includes("secret words"), "no message repeats them");
  assert.deepEqual(afterStart(h), ["Live mode ended. The microphone is closed."]);
});

test("a long partial keeps its last words, cut at a word, so that it fits", async () => {
  const h = await harness();
  await startLive(h);
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
  partial(h, words.join(" "));
  const [line] = shown(h)!;
  assert.match(line!, /^Hearing: …word\d+ /);
  assert.ok(line!.endsWith(" word119"), "the newest words are kept");
  assert.ok(line!.length <= "Hearing: …".length + 200, `short enough, was ${line!.length}`);
  const first = /^Hearing: …(word\d+)/.exec(line!)![1]!;
  assert.ok(words.includes(first), "the cut falls on a whole word");
});

test("with the setting off, a partial that arrives while Pi speaks is shown but does not cut Pi off", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  await speakAloud(h, "Đang chạy các bài test.");
  await h.until(() => players(h).length === 1);
  partial(h, "dừng");
  assert.deepEqual(shown(h), ["Hearing: dừng"]);
  await settle();
  assert.deepEqual(players(h)[0]!.signals, [], "playback continues");
  players(h)[0]!.finish(0);
  await settle();
});

test("with the setting on, a partial that arrives while Pi speaks is shown and cuts Pi off", async () => {
  const h = await harness({ config: baseConfig({ liveListenWhileSpeaking: true }) });
  h.setFetch(async () => audioResponse());
  await startLive(h);
  await speakAloud(h, "Đang chạy các bài test.");
  await h.until(() => players(h).length === 1);
  partial(h, "dừng");
  assert.deepEqual(shown(h), ["Hearing: dừng"]);
  assert.deepEqual(players(h)[0]!.signals, ["SIGTERM"]);
  await settle();
});
