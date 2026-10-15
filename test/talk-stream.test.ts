import assert from "node:assert/strict";
import { test } from "node:test";
import type { CtxOptions } from "./harness.ts";
import {
  audio,
  baseConfig,
  mixed,
  respond,
  sessionEvent,
  startRecording,
  stopAndSettle,
  stopWith,
  useTalkHarness,
  type Harness,
  type Stop,
} from "./talk-harness.ts";

const harness = useTalkHarness();

// Spoken stop phrase: the recording streams to ElevenLabs live transcription while the feature is on.
const liveConfig = (input: Record<string, unknown> = {}) =>
  baseConfig({ provider: "elevenlabs", stopOnPhrase: true, ...input });
const COMMIT = { message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 };

/** Starts a streamed recording; the connection is already open when the recorder starts. */
async function startLive(h: Harness) {
  const child = await startRecording(h);
  assert.equal(h.sockets.length, 1);
  return { child, socket: h.sockets.at(-1)! };
}

/** Stops a streamed recording with a control, checks the final commit, and answers it when `finalText` is given. */
async function stopLive(
  h: Harness,
  socket: ReturnType<Harness["sockets"]["at"]> & object,
  stop: Stop,
  finalText?: string,
  context: CtxOptions = {},
) {
  h.advance(2000);
  const before = socket.sent.length;
  if (stop === "pressShortcut" || stop === "pressTranscribeShortcut") await h[stop](context);
  else await stopWith(h, stop);
  await h.until(() => socket.sent.length === before + 1);
  assert.deepEqual(socket.chunks().at(-1), COMMIT);
  if (finalText === undefined) return;
  socket.committed(finalText);
  await h.until(() => h.talkStatuses.at(-1) === undefined);
}

test("the live pause and live languages do not reach push-to-talk: its connection keeps a 1-second pause and sends no secondary_languages", async () => {
  const h = await harness({ config: liveConfig({ language: undefined, livePauseSeconds: 3, liveLanguages: ["vi", "en"] }) });
  await startLive(h);
  const url = new URL(h.sockets[0]!.url);
  assert.equal(url.searchParams.get("vad_silence_threshold_secs"), "1");
  assert.equal(url.searchParams.has("secondary_languages"), false);
});

test("with the stop phrase on, the connection opens before the recorder and carries the key only in its header", async () => {
  const h = await harness({ config: liveConfig(), holdSockets: true });
  const pressed = h.pressShortcut();
  await h.until(() => h.sockets.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.recorderChildren().length, 0, "the recorder waits for the connection");
  h.sockets[0]!.emit("open");
  await pressed;
  assert.equal(h.recorderChildren().length, 1);
  assert.match(h.sockets[0]!.url, /^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime\?.*language_code=vi$/);
  assert.deepEqual(h.sockets[0]!.init, { headers: { "xi-api-key": "test-secret-key-123" } });
  assert.equal(h.fetchCalls.length, 0);
});

test("each recorded chunk is streamed while the audio is kept for the level bar and the time cap", async () => {
  const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
  const { child, socket } = await startLive(h);
  child.emitAudio(new Uint8Array(new Int16Array(1600).fill(30000).buffer));
  child.emitAudio(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(socket.chunks().map((chunk) => [chunk.message_type, chunk.commit, chunk.sample_rate]), [
    ["input_audio_chunk", false, 16000],
    ["input_audio_chunk", false, 16000],
  ]);
  assert.match(mixed(h.talkStatuses), /Recording 0:00 █ /);
  audio(child, 40000);
  await h.until(() => socket.chunks().at(-1)?.commit === true);
  assert.match(mixed(h.talkStatuses), /limit reached/);
  assert.equal(socket.chunks().length, 4, "two chunks, the capped part of the third, and the final commit");
  assert.equal(h.fetchCalls.length, 0);
});

test("a stop phrase at the end of a committed segment stops, removes the phrase, and sends the dictation", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "Refactor the loader";
  const { child, socket } = await startLive(h);
  audio(child);
  socket.message({ message_type: "partial_transcript", text: "and add a test let's" });
  assert.deepEqual(child.signals, []);
  socket.committed("and add a test, let's go");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Refactor the loader and add a test"]);
  assert.deepEqual(h.sent[0]!.options, { expandPromptTemplates: false });
  assert.equal(h.editor.text, "");
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.ok(socket.closes.length >= 1);
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.equal(h.sendKey("\x1b"), false);
  assert.equal(h.fetchCalls.length, 0, "the streamed audio is never uploaded");
});

test("a phrase in the middle of speech does not stop the recording", async () => {
  const h = await harness({ config: liveConfig() });
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("let's go through the loader");
  socket.committed("and then let's go");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["let's go through the loader and then"], "the phrase counts at the end of the joined text");

  const second = await harness({ config: liveConfig() });
  const live = await startLive(second);
  audio(live.child);
  live.socket.committed("let's go through the loader");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(live.child.signals, []);
  assert.equal(second.sent.length, 0);
  assert.match(second.talkStatuses.at(-1)!, /^● Recording/);
  assert.equal(second.sendKey("\x1b"), true, "the recording is still running");
});

test("saying only the stop phrase stops, sends nothing, and leaves the composer unchanged", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "keep me";
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("Let's go.");
  await h.until(() => h.talkStatuses.at(-1) === undefined);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "keep me");
  assert.match(h.messages(), /Only the stop phrase was heard/);
});

for (const [name, context, config, expected] of [
  ["no model selected", { noModel: true }, liveConfig(), /not sent: no model is selected/],
  ["the agent working with sendWhenBusy wait", { idle: false }, liveConfig({ sendWhenBusy: "wait" }), { deliverAs: "followUp", expandPromptTemplates: false }],
  ["the agent working by default", { idle: false }, liveConfig(), { deliverAs: "steer", expandPromptTemplates: false }],
] as const)
  test(`a phrase stop follows the send path with ${name}`, async () => {
    const h = await harness({ config });
    h.editor.text = "Draft";
    const child = await startWithContext(h, context);
    audio(child);
    h.sockets[0]!.committed("add a test, let's go");
    await h.until(() => h.talkStatuses.at(-1) === undefined);
    if (expected instanceof RegExp) {
      assert.equal(h.sent.length, 0);
      assert.equal(h.editor.text, "Draft add a test");
      assert.match(h.notices.at(-1)!.message, expected);
    } else {
      assert.deepEqual(h.sent.map((m) => m.options), [expected]);
      assert.equal(h.editor.text, "");
    }
  });

/** Starts a recording with the send shortcut in a given context, whose idle state and model a phrase stop uses. */
async function startWithContext(h: Harness, context: CtxOptions) {
  await h.pressShortcut(context);
  await h.until(() => h.recorderChildren().length === 1);
  return h.recorderChildren()[0]!;
}

test("a phrase stop during compaction keeps the draft and text in the composer, and sends nothing", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "Draft";
  h.events.get("session_before_compact")!();
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("add a test, let's go");
  await h.until(() => h.talkStatuses.at(-1) === undefined);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft add a test");
  assert.match(h.notices.at(-1)!.message, /Pi is compacting the conversation/);
});

test("with the feature off, a recording opens no connection and is uploaded once", async () => {
  for (const config of [baseConfig({ provider: "elevenlabs" }), baseConfig({ provider: "elevenlabs", stopOnPhrase: false })]) {
    const h = await harness({ config });
    audio(await startRecording(h));
    await stopAndSettle(h);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.fetchCalls.length, 1);
  }
});

test("with the stop phrase on and Deepgram as the input provider, nothing is recorded and no connection is made", async () => {
  const h = await harness({ config: baseConfig({ stopOnPhrase: true }) });
  await h.pressShortcut();
  await h.pressTranscribeShortcut();
  assert.equal(h.notices.length, 2);
  assert.ok(h.notices.every((n) => /stop phrase needs ElevenLabs/.test(n.message)));
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.keyListeners.size, 0);
  await h.runTalk("provider elevenlabs");
  await h.pressShortcut();
  assert.equal(h.sockets.length, 1, "the session override selects ElevenLabs, so it streams");
});

for (const [name, config, press] of [
  ["Deepgram, which cannot stream", baseConfig({ stopOnPhrase: true }), "pressCommandShortcut"],
  ["ElevenLabs, which could", liveConfig(), "pressSkillShortcut"],
] as const)
  test(`a recording started with the command or skill key never streams, even with the stop phrase on and ${name}`, async () => {
    const h = await harness({ config, commands: [{ name: "skill:review-convergence", source: "skill" }, { name: "opsx-apply-loop", source: "extension" }] });
    respond(h, press === "pressSkillShortcut" ? "review convergence" : "opsx apply loop");
    audio(await startRecording(h, press));
    assert.equal(h.sockets.length, 0);
    await stopAndSettle(h, press);
    assert.equal(h.fetchCalls.length, 1, "it is uploaded once at the stop");
    assert.equal(h.editor.text, press === "pressSkillShortcut" ? "/skill:review-convergence" : "/opsx-apply-loop");
    assert.equal(h.submitted, 0);
  });

test("a streamed recording stopped with the command key is matched against its committed text, and nothing is sent", async () => {
  const h = await harness({ config: liveConfig(), commands: [{ name: "opsx-apply-loop", source: "extension" }] });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  audio(child);
  await stopLive(h, socket, "pressCommandShortcut", "op sx apply loop, with tests.");
  assert.equal(h.editor.text, "/opsx-apply-loop with tests Draft");
  assert.equal(h.submitted, 0);
  assert.equal(h.fetchCalls.length, 0, "the streamed audio is not uploaded a second time");
});

test("a streamed recording started on ElevenLabs keeps streaming when the provider override changes", async () => {
  const h = await harness({ config: liveConfig() });
  const { child, socket } = await startLive(h);
  audio(child);
  await h.runTalk("provider deepgram");
  await stopLive(h, socket, "pressTranscribeShortcut", "hello");
  assert.equal(h.editor.text, "hello");
  assert.equal(h.fetchCalls.length, 0);
});

for (const [stop, sends] of [["pressShortcut", true], ["send", true], ["pressTranscribeShortcut", false], ["talk", false]] as const)
  test(`stopping a streamed recording with ${stop} requests the final commit and ${sends ? "sends the composer" : "only adds the text"}, without removing a phrase`, async () => {
    const h = await harness({ config: liveConfig() });
    h.editor.text = "Draft";
    const { child, socket } = await startLive(h);
    audio(child);
    socket.committed("first part");
    await stopLive(h, socket, stop, "then let's go");
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.ok(socket.closes.length >= 1);
    if (sends) {
      assert.deepEqual(h.sent.map((m) => m.text), ["Draft first part then let's go"]);
      assert.equal(h.editor.text, "");
    } else {
      assert.equal(h.sent.length, 0);
      assert.equal(h.editor.text, "Draft first part then let's go");
    }
    assert.equal(h.fetchCalls.length, 0);
  });

test("a key stop waits for the final commit: the status says transcribing and Escape is no longer taken", async () => {
  const h = await harness({ config: liveConfig() });
  const { child, socket } = await startLive(h);
  audio(child);
  await stopLive(h, socket, "pressTranscribeShortcut");
  assert.equal(h.talkStatuses.at(-1), "Transcribing…");
  assert.equal(h.sendKey("\x1b"), false);
  await h.pressTranscribeShortcut();
  assert.match(h.messages(), /still in progress/);
  socket.committed("done");
  await h.until(() => h.editor.text === "done");
});

test("an empty final text in send mode sends nothing and says nothing was recognized", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "keep me";
  const { child, socket } = await startLive(h);
  audio(child);
  await stopLive(h, socket, "pressShortcut", "");
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "keep me");
  assert.match(h.messages(), /Nothing was recognized/);
});

test("a final commit that gets no answer within the request deadline ends the recording, adds the earlier text, and sends nothing", async () => {
  const h = await harness({ config: { ...liveConfig(), requestTimeoutMs: 1000 } });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("first part");
  await stopLive(h, socket, "pressShortcut");
  await h.until(() => h.talkStatuses.at(-1) === undefined, 3000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft first part");
  assert.match(h.notices.at(-1)!.message, /did not return the final text within 1 s\. Nothing was retried\. Nothing was sent\. The text transcribed so far was added/);
  assert.equal(h.sockets.length, 1, "no reconnect");
});

test("Escape while streaming closes the stream at once, sends no message, and is consumed", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("some words");
  assert.equal(h.sendKey("\x1b"), true);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.ok(socket.closes.length >= 1);
  socket.committed("let's go");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.editor.text, "Draft");
  assert.equal(h.sent.length, 0);
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.equal(h.fetchCalls.length, 0);
});

test("Escape while the connection is opening cancels the attempt, closes the socket, and starts no recorder", async () => {
  const h = await harness({ config: liveConfig(), holdSockets: true });
  const pressed = h.pressShortcut();
  await h.until(() => h.sockets.length === 1);
  assert.equal(h.sendKey("\x1b"), true);
  await pressed;
  assert.ok(h.sockets[0]!.closes.length >= 1);
  h.sockets[0]!.emit("open");
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.keyListeners.size, 0);
});

test("a connection that cannot be opened is reported, records nothing, and is not retried", async () => {
  const h = await harness({ config: liveConfig(), holdSockets: true });
  const pressed = h.pressShortcut();
  await h.until(() => h.sockets.length === 1);
  h.sockets[0]!.emit("error");
  await pressed;
  assert.match(h.notices.at(-1)!.message, /ElevenLabs live transcription could not be reached.*Nothing was recorded or sent/);
  assert.doesNotMatch(h.messages(), /test-secret-key/);
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.keyListeners.size, 0);
});

test("no recording tool closes the connection that was opened for it", async () => {
  const h = await harness({ config: liveConfig(), recorders: [] });
  await h.pressShortcut();
  assert.match(h.messages(), /looked for rec, arecord, ffmpeg/);
  assert.ok(h.sockets[0]!.closes.length >= 1);
});

for (const [name, close] of [
  ["the connection closes unexpectedly", (socket: FakeSocketLike) => socket.emit("close")],
  ["the provider reports an authentication error", (socket: FakeSocketLike) => socket.message({ message_type: "auth_error", error: "test-secret-key-123" })],
  ["the provider reports a session time limit", (socket: FakeSocketLike) => socket.message({ message_type: "session_time_limit_exceeded" })],
] as const)
  test(`when ${name} mid-recording, the committed text is added to the composer, nothing is sent or retried, and nothing leaks`, async () => {
    const h = await harness({ config: liveConfig() });
    h.editor.text = "Draft";
    const { child, socket } = await startLive(h);
    audio(child);
    socket.committed("first words");
    close(socket);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.equal(h.editor.text, "Draft first words");
    assert.equal(h.sent.length, 0);
    assert.equal(h.notices.at(-1)!.level, "error");
    assert.match(h.notices.at(-1)!.message, /^ElevenLabs live transcription .*Nothing was retried\. Nothing was sent\. The text transcribed so far was added to the composer\.$/);
    assert.doesNotMatch(h.messages(), /test-secret-key|auth_error.*test-secret/);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.fetchCalls.length, 0, "no fallback to the one-shot upload");
    assert.equal(h.sendKey("\x1b"), false);
  });

test("a failure before any text was committed adds nothing to the composer", async () => {
  const h = await harness({ config: liveConfig() });
  const { child, socket } = await startLive(h);
  audio(child);
  socket.message({ message_type: "quota_exceeded" });
  assert.equal(h.editor.text, "");
  assert.doesNotMatch(h.messages(), /added to the composer/);
  assert.match(h.messages(), /quota_exceeded/);
});

test("a failure while the final commit is awaited adds the earlier text and sends nothing", async () => {
  const h = await harness({ config: liveConfig() });
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("first words");
  await stopLive(h, socket, "pressShortcut");
  socket.message({ message_type: "rate_limited" });
  await h.until(() => h.talkStatuses.at(-1) === undefined);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "first words");
  assert.match(h.notices.at(-1)!.message, /rate_limited/);
});

test("at the time cap the final text is held, and the next control delivers it in its own mode", async () => {
  for (const [stop, sends] of [["pressShortcut", true], ["pressTranscribeShortcut", false]] as const) {
    const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
    h.editor.text = "Draft";
    const { child, socket } = await startLive(h);
    audio(child, 40000);
    await h.until(() => socket.sent.length === 2);
    assert.deepEqual(socket.chunks().at(-1), COMMIT);
    socket.committed("held words, let's go");
    await h.until(() => socket.closes.length >= 1);
    assert.match(h.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent/);
    assert.equal(h.sent.length, 0, "a phrase in held text sends nothing");
    assert.equal(h.editor.text, "Draft");
    await h[stop]();
    await h.until(() => h.talkStatuses.at(-1) === undefined);
    assert.equal(h.sent.length, sends ? 1 : 0);
    assert.equal(h.editor.text, sends ? "" : "Draft held words, let's go");
    assert.equal(h.fetchCalls.length, 0);
  }
});

test("a control pressed at the time cap before the final text arrives delivers it once it does", async () => {
  const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
  const { child, socket } = await startLive(h);
  audio(child, 40000);
  await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
  await h.pressShortcut();
  assert.equal(h.talkStatuses.at(-1), "Transcribing…");
  socket.committed("late words");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["late words"]);
});

test("Escape or a session change discards held streamed text", async () => {
  for (const discard of ["escape", "session"] as const) {
    const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
    const { child, socket } = await startLive(h);
    audio(child, 40000);
    await h.until(() => socket.sent.length === 2);
    socket.committed("held words");
    await h.until(() => socket.closes.length >= 1);
    if (discard === "escape") assert.equal(h.sendKey("\x1b"), true);
    else sessionEvent(h);
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.equal(h.editor.text, "");
    assert.equal(h.sent.length, 0);
    await startRecording(h);
    assert.equal(h.sockets.length, 2, "the next shortcut starts a new streamed recording");
    assert.equal(h.sent.length, 0, "the discarded text is never sent");
  }
});

test("a tap shorter than 0.5 seconds, or a recorder that exits on its own, closes the stream and sends nothing", async () => {
  const tap = await harness({ config: liveConfig() });
  const first = await startLive(tap);
  audio(first.child);
  tap.advance(400);
  await tap.pressTranscribeShortcut();
  assert.match(tap.messages(), /shorter than 0.5 seconds/);
  assert.ok(first.socket.closes.length >= 1);
  assert.equal(first.socket.chunks().at(-1)!.commit, false, "no final commit was requested");

  const dead = await harness({ config: liveConfig() });
  const second = await startLive(dead);
  audio(second.child);
  second.child.finish(1);
  await dead.until(() => /Recording failed/.test(dead.messages()));
  assert.ok(second.socket.closes.length >= 1);
  assert.equal(dead.sent.length + tap.sent.length, 0);
});

test("shutdown or session replacement closes the stream and drops late messages", async () => {
  for (const event of ["session_shutdown", "session_before_switch", "session_before_fork", "session_tree"]) {
    const h = await harness({ config: liveConfig() });
    h.editor.text = "Draft";
    const { child, socket } = await startLive(h);
    audio(child);
    sessionEvent(h, event);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.ok(socket.closes.length >= 1);
    socket.committed("add a test, let's go");
    socket.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.editor.text, "Draft");
    assert.equal(h.sent.length, 0);
    assert.equal(h.messages(), "");
    assert.equal(h.talkStatuses.at(-1), undefined);
  }
});

test("a session change while the connection is opening closes it and starts no recorder", async () => {
  const h = await harness({ config: liveConfig(), holdSockets: true });
  const pressed = h.pressShortcut();
  await h.until(() => h.sockets.length === 1);
  sessionEvent(h);
  await pressed;
  assert.ok(h.sockets[0]!.closes.length >= 1);
  assert.equal(h.recorderChildren().length, 0);
});

test("a final commit answered with insufficient_audio_activity or commit_throttled sends the text committed so far, with no error", async () => {
  for (const type of ["insufficient_audio_activity", "commit_throttled"]) {
    const h = await harness({ config: liveConfig() });
    h.editor.text = "Draft";
    const { child, socket } = await startLive(h);
    audio(child);
    socket.committed("first part");
    await stopLive(h, socket, "pressShortcut");
    socket.message({ message_type: type });
    await h.until(() => h.sent.length === 1);
    assert.deepEqual(h.sent.map((m) => m.text), ["Draft first part"]);
    assert.equal(h.editor.text, "");
    assert.deepEqual(h.notices, [], `${type} is not shown as an error`);
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.equal(h.fetchCalls.length, 0);
  }
});

test("a recorder failure during a streamed recording adds the committed text unsent, or nothing when none was committed", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  audio(child);
  socket.committed("first words");
  child.finish(1);
  await h.until(() => /Recording failed/.test(h.messages()));
  assert.equal(h.editor.text, "Draft first words");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.at(-1)!.level, "error");
  assert.match(h.notices.at(-1)!.message, /^Recording failed: .*\. Nothing was sent\. The text transcribed so far was added to the composer\.$/);
  assert.ok(socket.closes.length >= 1);
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.equal(h.sendKey("\x1b"), false);
  assert.equal(h.fetchCalls.length, 0);

  const bare = await harness({ config: liveConfig() });
  bare.editor.text = "Draft";
  const quiet = await startLive(bare);
  audio(quiet.child);
  quiet.child.finish(1);
  await bare.until(() => /Recording failed/.test(bare.messages()));
  assert.equal(bare.editor.text, "Draft");
  assert.equal(bare.sent.length, 0);
  assert.doesNotMatch(bare.messages(), /added to the composer/);
});

test("a phrase segment that arrives after a transcribe-only key stop, before the recorder exits, is appended with the phrase kept and nothing is sent", async () => {
  const h = await harness({ config: liveConfig() });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  audio(child);
  child.autoExitOnKill = false;
  h.advance(2000);
  await h.pressTranscribeShortcut();
  assert.deepEqual(child.signals, ["SIGINT"]);
  socket.committed("add a test, let's go");
  assert.equal(h.sent.length, 0);
  child.finish(0);
  await h.until(() => socket.sent.length === 1);
  assert.deepEqual(socket.chunks().at(-1), COMMIT);
  socket.committed("");
  await h.until(() => h.talkStatuses.at(-1) === undefined);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft add a test, let's go");
});

test("a phrase segment that arrives after the time cap, before the recorder exits, is held and sent only by the next control", async () => {
  const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  child.autoExitOnKill = false;
  audio(child, 40000);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.match(h.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent/, "held at once, before the recorder exits");
  socket.committed("add a test, let's go");
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft");
  assert.deepEqual(child.signals, ["SIGINT"], "the phrase does not stop the recording a second time");
  child.finish(0);
  await h.until(() => socket.chunks().at(-1)?.commit === true);
  socket.committed("");
  await h.until(() => socket.closes.length >= 1);
  assert.match(h.talkStatuses.at(-1)!, /Recording limit reached/);
  assert.equal(h.sent.length, 0);
  await h.pressShortcut();
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Draft add a test, let's go"], "the phrase is kept");
  assert.equal(h.editor.text, "");
});

test("a control pressed after the time cap, before the recorder exits, waits for the final text and delivers once", async () => {
  const h = await harness({ config: liveConfig({ maxSeconds: 1 }) });
  h.editor.text = "Draft";
  const { child, socket } = await startLive(h);
  child.autoExitOnKill = false;
  audio(child, 40000);
  assert.match(h.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent/, "held at once, before the recorder exits");
  await h.pressTranscribeShortcut();
  assert.equal(h.talkStatuses.at(-1), "Transcribing…");
  socket.committed("held words");
  assert.equal(socket.chunks().at(-1)!.commit, false, "no final commit before the recorder exits");
  assert.equal(h.editor.text, "Draft");
  child.finish(0);
  await h.until(() => socket.chunks().at(-1)?.commit === true);
  assert.equal(h.editor.text, "Draft");
  socket.committed("");
  await h.until(() => h.talkStatuses.at(-1) === undefined);
  assert.equal(h.editor.text, "Draft held words");
  assert.equal(h.sent.length, 0);
});

type FakeSocketLike = Harness["sockets"][number];
