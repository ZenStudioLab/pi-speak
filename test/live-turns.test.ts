import assert from "node:assert/strict";
import { test } from "node:test";
import { API_KEY } from "./harness.ts";
import { afterStart, settle, startLive } from "./live-harness.ts";
import { baseConfig, sessionEvent, useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();

const sentTexts = (h: Harness) => h.sent.map((message) => message.text);

test("a turn is sent as one plain message while a draft sits in the composer, and the composer is left alone", async () => {
  const h = await harness();
  h.editor.text = "Refactor the loader";
  const { socket } = await startLive(h);
  socket.committed("what does the config loader do");
  await h.until(() => h.sent.length === 1);
  assert.equal(h.sent[0]!.text, "what does the config loader do");
  assert.deepEqual(h.sent[0]!.options, { expandPromptTemplates: false });
  assert.equal(h.sent[0]!.composerAtCall, "Refactor the loader");
  assert.equal(h.editor.text, "Refactor the loader");
  assert.equal(afterStart(h).length, 0);
});

test("only new committed text becomes each turn, in the order it was committed", async () => {
  const h = await harness();
  const { socket } = await startLive(h);
  socket.committed("first request");
  socket.committed("second request");
  socket.committed("third request");
  await h.until(() => h.sent.length === 3);
  assert.deepEqual(sentTexts(h), ["first request", "second request", "third request"]);
});

for (const dropped of ["...", "—", "?!"])
  test(`the segment ${JSON.stringify(dropped)} has no letter or digit, so nothing is sent, changed, or shown`, async () => {
    const h = await harness();
    h.editor.text = "draft";
    const { socket } = await startLive(h);
    socket.committed(dropped);
    socket.committed("hello there");
    await h.until(() => h.sent.length === 1);
    assert.deepEqual(sentTexts(h), ["hello there"], "the dropped text does not ride along with the next turn");
    assert.equal(h.editor.text, "draft");
    assert.equal(afterStart(h).length, 0);
  });

for (const short of ["Ừ.", "yes.", "42"])
  test(`the short answer ${JSON.stringify(short)} is sent as a turn`, async () => {
    const h = await harness();
    const { socket } = await startLive(h);
    socket.committed(short);
    await h.until(() => h.sent.length === 1);
    assert.deepEqual(sentTexts(h), [short]);
  });

test("a spoken slash command is sent as ordinary words, and the stop phrases have no effect", async () => {
  const h = await harness({ config: baseConfig({ provider: "elevenlabs", stopOnPhrase: true, stopPhrases: ["let's go"] }) });
  const { child, socket } = await startLive(h);
  socket.committed("/compact now please");
  socket.committed("check the tests, let's go");
  await h.until(() => h.sent.length === 2);
  assert.deepEqual(sentTexts(h), ["/compact now please", "check the tests, let's go"]);
  assert.deepEqual(h.sent[0]!.options, { expandPromptTemplates: false });
  assert.deepEqual(child.signals, [], "the phrase did not stop the recorder");
  assert.equal(h.talkStatuses.length, 0);
});

for (const [name, input, idle, expected] of [
  ["idle", {}, true, { expandPromptTemplates: false }],
  ["working, sendWhenBusy omitted", {}, false, { deliverAs: "steer", expandPromptTemplates: false }],
  ["working, sendWhenBusy interrupt", { sendWhenBusy: "interrupt" }, false, { deliverAs: "steer", expandPromptTemplates: false }],
  ["working, sendWhenBusy wait", { sendWhenBusy: "wait" }, false, { deliverAs: "followUp", expandPromptTemplates: false }],
] as const)
  test(`a turn while the agent is ${name} is delivered as ${JSON.stringify(expected)}`, async () => {
    const h = await harness({ config: baseConfig(input) });
    const { socket } = await startLive(h, { isIdle: () => idle });
    socket.committed("also check the tests");
    await h.until(() => h.sent.length === 1);
    assert.deepEqual(h.sent[0]!.options, expected);
  });

test("sendWhenBusy is read when the turn is sent, not when live mode started", async () => {
  const h = await harness();
  const { socket } = await startLive(h, { isIdle: () => false });
  await h.writeConfig(baseConfig({ sendWhenBusy: "wait" }));
  socket.committed("check the tests");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent[0]!.options, { deliverAs: "followUp", expandPromptTemplates: false });
});

const fallbacks: [string, Parameters<typeof harness>[0], Parameters<typeof startLive>[1], RegExp][] = [
  ["no model is selected", {}, { noModel: true }, /no model is selected/],
  ["the send call throws", { sendThrows: "host refused" }, {}, /host refused/],
];
for (const [name, options, context, message] of fallbacks)
  test(`when ${name}, the turn is added to the composer after the draft, a message says why, and live mode stays on`, async () => {
    const h = await harness(options);
    h.editor.text = "Refactor";
    const { child, socket } = await startLive(h, context);
    socket.committed("secret words spoken");
    await h.until(() => h.editor.text !== "Refactor");
    assert.equal(h.editor.text, "Refactor secret words spoken");
    const warnings = afterStart(h);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, message);
    assert.ok(!warnings[0]!.includes("secret words"), "a warning never repeats the transcript");
    assert.deepEqual(child.signals, []);
    assert.equal(h.fetchCalls.length, 0);
  });

test("a turn during compaction is added to the composer with a message, and turns are sent again once compaction ends", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  sessionEvent(h, "session_before_compact");
  socket.committed("held during compaction");
  await h.until(() => h.editor.text === "held during compaction");
  assert.equal(h.sent.length, 0);
  assert.match(afterStart(h).join("\n"), /Pi is compacting the conversation/);
  sessionEvent(h, "session_compact");
  socket.committed("after compaction");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(sentTexts(h), ["after compaction"]);
  assert.deepEqual(child.signals, []);
});

test("a turn is kept in the composer when the configuration became invalid, and live mode stays on", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  await h.writeConfig({ ...baseConfig(), unknownKey: true });
  socket.committed("spoken after the edit");
  await h.until(() => h.editor.text === "spoken after the edit");
  assert.equal(h.sent.length, 0);
  assert.match(afterStart(h).join("\n"), /configuration has an error/);
  assert.deepEqual(child.signals, []);
});

for (const [name, end] of [
  ["/talk live", (h: Harness) => h.runTalk("live")],
  ["a session change", async (h: Harness) => sessionEvent(h, "session_before_switch")],
] as const)
  test(`a segment committed before ${name} ended live mode, but not yet sent, is dropped`, async () => {
    const h = await harness();
    const { socket } = await startLive(h);
    socket.committed("too late to send");
    await end(h);
    await settle();
    assert.equal(h.sent.length, 0);
    assert.equal(h.editor.text, "");
    socket.committed("after the end");
    await settle();
    assert.equal(h.sent.length, 0);
  });

test("a failure message that would carry the key omits it", async () => {
  const h = await harness({ sendThrows: `unauthorized: Bearer ${API_KEY}` });
  const { socket } = await startLive(h);
  socket.committed("hello there");
  await h.until(() => h.editor.text === "hello there");
  assert.match(afterStart(h).join("\n"), /unauthorized/);
  assert.ok(!h.messages().includes(API_KEY));
});
