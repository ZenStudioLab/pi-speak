import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, audioResponse } from "./harness.ts";
import { afterStart, players, settle, speakAloud, spokenTexts, startLive } from "./live-harness.ts";
import { baseConfig, useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();

const liveOn = async (h: Harness) => {
  await h.run("status");
  return /live mode: on/.test(h.notices.at(-1)!.message);
};

/** Lets each of the first `count` players run to its end, one after the other, as the queue starts them. */
async function playThrough(h: Harness, count: number) {
  for (let i = 0; i < count; i++) {
    await h.until(() => players(h).length > i);
    players(h)[i]!.finish(0);
  }
  await settle();
}

const run = (stopReason: string, content: unknown[]) => [
  { role: "user", content: "question", timestamp: 1 },
  { role: "assistant", content, stopReason, timestamp: 2 },
];
const text = (value: string) => [{ type: "text", text: value }];

test("a finished run is read aloud paragraph by paragraph, without its code, behind an update already waiting, and live mode keeps listening", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  await speakAloud(h, "Đang kiểm tra.");
  h.agentEnd({ messages: answer("First paragraph here.\n\nSecond paragraph here.\n\n```js\nconst code = 1;\n```\n\nThird paragraph here.") });
  await playThrough(h, 4);
  assert.deepEqual(spokenTexts(h), ["Đang kiểm tra.", "First paragraph here.", "Second paragraph here.", "Third paragraph here."]);
  assert.equal(h.submitted, 0, "no tool call or message was needed");
  assert.match(h.liveStatuses.at(-1)!, /listening/);
  assert.deepEqual(afterStart(h), []);
  assert.equal(await liveOn(h), true);
});

test("the answer is cleaned as /speak original cleans it", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  h.agentEnd({ messages: answer("**Bold** words with a [link](https://example.com/x) and `inline` code.") });
  await playThrough(h, 1);
  assert.deepEqual(spokenTexts(h), ["Bold words with a link and inline code."]);
});

test("a long paragraph is queued as several parts of at most 1,000 characters, in order", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here and keeps going a little.`);
  h.agentEnd({ messages: answer(sentences.join(" ")) });
  await playThrough(h, 2);
  const spoken = spokenTexts(h);
  assert.equal(spoken.length, 2);
  assert.ok(spoken.every((part) => part.length <= 1000));
  assert.equal(spoken.join(" "), sentences.join(" "));
});

const LIMIT = { ...baseConfig(), hardLimitChars: 40 };
const paragraph = (letter: string) => letter.repeat(20);

test("parts are queued while their total stays within the speech limit, and one message says the rest was not read", async () => {
  const h = await harness({ config: LIMIT });
  h.setFetch(async () => audioResponse());
  await startLive(h);
  h.agentEnd({ messages: answer([paragraph("a"), paragraph("b"), paragraph("c")].join("\n\n")) });
  await playThrough(h, 2);
  assert.deepEqual(spokenTexts(h), [paragraph("a"), paragraph("b")]);
  const messages = afterStart(h);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /longer than the speech limit \(40 characters\).* the rest of it was not read aloud/);
  assert.ok(!/[abc]{5}/.test(messages[0]!), "the message repeats none of the answer");
});

test("an answer exactly at the speech limit is read whole, with no message", async () => {
  const h = await harness({ config: LIMIT });
  h.setFetch(async () => audioResponse());
  await startLive(h);
  h.agentEnd({ messages: answer([paragraph("a"), paragraph("b")].join("\n\n")) });
  await playThrough(h, 2);
  assert.deepEqual(spokenTexts(h), [paragraph("a"), paragraph("b")]);
  assert.deepEqual(afterStart(h), []);
});

test("the send key cuts a reply off: its remaining parts are dropped, the agent is not aborted, and live mode stays on", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  h.agentEnd({ messages: answer("One.\n\nTwo.\n\nThree.") });
  await h.until(() => players(h).length === 1);
  await h.pressShortcut({ idle: false });
  assert.deepEqual(players(h)[0]!.signals, ["SIGTERM"]);
  await settle();
  assert.deepEqual(spokenTexts(h), ["One."], "Two and Three are never requested");
  assert.equal(h.aborts, 0);
  assert.equal(await liveOn(h), true);
});

for (const [name, messages] of [
  ["an aborted run", run("aborted", text("Half an answer."))],
  ["a failed run", run("error", text("Half an answer."))],
  ["an answer with no text", run("stop", [{ type: "thinking", thinking: "hmm" }])],
  ["an answer with nothing speakable once cleaned", run("stop", text("```js\nconst a = 1;\n```"))],
  ["a run that ended before any answer", [{ role: "user", content: "question", timestamp: 1 }]],
] as const)
  test(`${name} speaks nothing and shows no message`, async () => {
    const h = await harness();
    await startLive(h);
    h.agentEnd({ messages: [...messages] });
    await settle();
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(players(h).length, 0);
    assert.deepEqual(afterStart(h), []);
  });

test("a run that ends while live mode is off speaks nothing and shows no message", async () => {
  const h = await harness();
  h.agentEnd({ messages: answer("A fine answer.") });
  await settle();
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(players(h).length, 0);
  assert.equal(h.notices.length, 0);
});

test("a run that ends after live mode ended speaks nothing and shows no message", async () => {
  const h = await harness();
  await startLive(h);
  await h.runTalk("live");
  const before = h.notices.length;
  h.agentEnd({ messages: answer("A fine answer.") });
  await settle();
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(players(h).length, 0);
  assert.equal(h.notices.length, before);
});
