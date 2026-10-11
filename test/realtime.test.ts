import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchStopPhrase,
  openRealtime,
  realtimeUrl,
  type RealtimeFailure,
  type RealtimeSession,
  type WebSocketFn,
} from "../realtime.ts";
import { FakeSocket } from "./harness.ts";

const KEY = "eleven-secret-key-456";

/** Starts opening a session on a fake socket; `hold` leaves the socket unopened for the test to open. */
function start(options: { language?: string; timeoutMs?: number; hold?: boolean; signal?: AbortSignal } = {}) {
  const sockets: FakeSocket[] = [];
  const webSocketFn: WebSocketFn = (url, init) => {
    const socket = new FakeSocket(url, init);
    sockets.push(socket);
    if (!options.hold) queueMicrotask(() => socket.emit("open"));
    return socket as never;
  };
  const opening = openRealtime({
    apiKey: KEY,
    language: options.language,
    timeoutMs: options.timeoutMs ?? 1000,
    signal: options.signal ?? new AbortController().signal,
    webSocketFn,
  });
  return { opening, sockets };
}

async function connect(options: Parameters<typeof start>[0] = {}) {
  const { opening, sockets } = start(options);
  return { opened: await opening, sockets, socket: sockets[0]! };
}

async function session(options: Parameters<typeof connect>[0] = {}) {
  const { opened, socket, sockets } = await connect(options);
  assert.ok(opened.ok);
  const events: string[] = [];
  const failures: RealtimeFailure[] = [];
  opened.session.listen({
    onCommitted: () => events.push(opened.session.text),
    onFailure: (failure) => failures.push(failure),
  });
  return { live: opened.session as RealtimeSession, socket, sockets, events, failures };
}

test("the connection uses the fixed URL and query, and the key only in the xi-api-key header", async () => {
  const { opened, socket } = await connect({ language: "vi-VN" });
  assert.ok(opened.ok);
  assert.equal(
    socket.url,
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=1&language_code=vi",
  );
  assert.deepEqual(socket.init, { headers: { "xi-api-key": KEY } });
  assert.ok(!socket.url.includes(KEY));
  assert.equal(realtimeUrl(undefined).includes("language_code"), false);
});

test("a connection that does not open within the deadline fails as a timeout, is closed, and is not retried", async () => {
  const { opened, sockets } = await connect({ hold: true, timeoutMs: 20 });
  assert.ok(!opened.ok);
  assert.equal(opened.failure.kind, "timeout");
  assert.match(opened.failure.message, /did not open within 0 s/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.closes.length, 1);
  sockets[0]!.emit("open");
  assert.equal(sockets.length, 1, "a late open changes nothing");
});

test("a connection that errors, closes, or throws before it opens fails as a network error without the key", async () => {
  for (const event of ["error", "close"]) {
    const { opening, sockets } = start({ hold: true });
    sockets[0]!.emit(event);
    const opened = await opening;
    assert.ok(!opened.ok);
    assert.equal(opened.failure.kind, "network");
    assert.equal(sockets.length, 1);
  }
  const thrown = await openRealtime({
    apiKey: KEY,
    language: undefined,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    webSocketFn: () => {
      throw new Error(`bad ${KEY}`);
    },
  });
  assert.ok(!thrown.ok);
  assert.equal(thrown.failure.kind, "network");
  assert.ok(!thrown.failure.message.includes(KEY));
});

test("cancelling while the connection opens, or before it starts, closes the socket", async () => {
  const cancel = new AbortController();
  const { opening, sockets } = start({ hold: true, signal: cancel.signal });
  cancel.abort();
  const opened = await opening;
  assert.ok(!opened.ok);
  assert.equal(opened.failure.kind, "cancelled");
  assert.equal(sockets[0]!.closes.length, 1);

  const aborted = new AbortController();
  aborted.abort();
  const early = start({ signal: aborted.signal });
  assert.equal((await early.opening).ok, false);
  assert.equal(early.sockets.length, 0);
});

test("audio is sent as input_audio_chunk messages and a late chunk after the final commit is dropped", async () => {
  const { live, socket } = await session();
  live.sendAudio(new Uint8Array([1, 2, 3]));
  assert.deepEqual(socket.chunks(), [
    { message_type: "input_audio_chunk", audio_base_64: "AQID", commit: false, sample_rate: 16000 },
  ]);
  void live.finish(1000);
  live.sendAudio(new Uint8Array([4]));
  assert.equal(socket.sent.length, 2);
});

test("committed transcripts are joined with single spaces and partial transcripts are ignored", async () => {
  const { socket, events, live } = await session();
  socket.message({ message_type: "session_started", session_id: "s", config: {} });
  socket.message({ message_type: "partial_transcript", text: "hel" });
  socket.committed("  Hello there ");
  socket.message({ message_type: "partial_transcript", text: "wor" });
  socket.committed("world");
  socket.committed("");
  assert.deepEqual(events, ["Hello there", "Hello there world", "Hello there world"]);
  assert.equal(live.text, "Hello there world");
});

test("the final commit sends an empty committed chunk, resolves with the next committed text, and is not announced as a segment", async () => {
  const { live, socket, events, failures } = await session();
  socket.committed("first part");
  const result = live.finish(1000);
  assert.deepEqual(socket.chunks().at(-1), {
    message_type: "input_audio_chunk",
    audio_base_64: "",
    commit: true,
    sample_rate: 16000,
  });
  socket.committed("last part");
  assert.deepEqual(await result, { ok: true, text: "first part last part" });
  assert.deepEqual(events, ["first part"]);
  assert.deepEqual(failures, []);
});

test("a final commit with no answer within the deadline fails as a timeout and closes the socket", async () => {
  const { live, socket, failures } = await session();
  const result = await live.finish(20);
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "timeout");
  assert.match(result.failure.message, /did not return the final text/);
  assert.equal(socket.closes.length, 1);
  assert.deepEqual(failures, [], "the failure is returned by finish, not announced a second time");
});

const ERROR_CLASSES = [
  ["auth_error", "auth", /rejected the API key \(auth_error\)/],
  ["unaccepted_terms", "auth", /unaccepted_terms/],
  ["quota_exceeded", "quota", /quota_exceeded/],
  ["resource_exhausted", "quota", /resource_exhausted/],
  ["rate_limited", "rate-limit", /rate_limited/],
  ["commit_throttled", "rate-limit", /commit_throttled/],
  ["queue_overflow", "rate-limit", /queue_overflow/],
  ["session_time_limit_exceeded", "time-limit", /session_time_limit_exceeded/],
  ["chunk_size_exceeded", "too-large", /chunk_size_exceeded/],
  ["input_error", "invalid", /input_error/],
  ["invalid_request", "invalid", /invalid_request/],
  ["insufficient_audio_activity", "invalid", /insufficient_audio_activity/],
  ["transcriber_error", "server", /transcriber_error/],
  ["error", "provider", /reported an error \(error\)/],
] as const;

for (const [type, kind, named] of ERROR_CLASSES)
  test(`a ${type} message ends the session as ${kind}, names the class, hides the provider text and the key, and closes the socket`, async () => {
    const { socket, failures, sockets } = await session();
    socket.message({ message_type: type, error: `provider text with ${KEY}` });
    socket.committed("too late");
    socket.message({ message_type: type });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.kind, kind);
    assert.match(failures[0]!.message, /^ElevenLabs live transcription /);
    assert.match(failures[0]!.message, named);
    assert.doesNotMatch(failures[0]!.message, /provider text|eleven-secret/);
    assert.equal(socket.closes.length, 1);
    assert.equal(sockets.length, 1, "nothing reconnects");
  });

for (const type of ["insufficient_audio_activity", "commit_throttled"])
  test(`a ${type} message while the final commit is awaited settles it with the text committed so far, but ends the session otherwise`, async () => {
    const pending = await session();
    pending.socket.committed("first part");
    const result = pending.live.finish(1000);
    pending.socket.message({ message_type: type, error: `provider text with ${KEY}` });
    assert.deepEqual(await result, { ok: true, text: "first part" });
    assert.deepEqual(pending.failures, []);
    assert.equal(pending.socket.closes.length, 0, "the caller closes the session, not the settling");

    const idle = await session();
    idle.socket.committed("first part");
    idle.socket.message({ message_type: type });
    assert.equal(idle.failures.length, 1);
    assert.match(idle.failures[0]!.message, new RegExp(type));
    assert.equal(idle.socket.closes.length, 1);
  });

test("no timer is left after a successful open or after a settled final commit", async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = realSet(() => {
      live.delete(timer);
      callback(...args);
    }, ms);
    live.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    live.delete(timer);
    realClear(timer);
  }) as typeof clearTimeout;
  try {
    const { live: first, socket } = await session({ timeoutMs: 60_000 });
    assert.equal(live.size, 0, "the open timer is cleared once the connection opens");
    const committed = first.finish(60_000);
    assert.equal(live.size, 1, "the final commit waits under one timer");
    socket.committed("last part");
    await committed;
    assert.equal(live.size, 0, "the final commit timer is cleared once it is answered");

    const { live: second, socket: other } = await session();
    const nothing = second.finish(60_000);
    other.message({ message_type: "insufficient_audio_activity" });
    await nothing;
    assert.equal(live.size, 0, "the final commit timer is cleared when nothing was left to commit");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const timer of live) realClear(timer as Parameters<typeof clearTimeout>[0]);
  }
});

test("an error message while the final commit is awaited is returned by finish", async () => {
  const { live, socket, failures } = await session();
  const result = live.finish(1000);
  socket.message({ message_type: "auth_error", error: "x" });
  const settled = await result;
  assert.ok(!settled.ok);
  assert.equal(settled.failure.kind, "auth");
  assert.deepEqual(failures, []);
});

test("an unexpected close or a socket error ends the session, but closing it ourselves does not", async () => {
  const closed = await session();
  closed.socket.emit("close");
  assert.deepEqual(closed.failures.map((failure) => failure.kind), ["closed"]);
  assert.match(closed.failures[0]!.message, /closed the connection unexpectedly/);
  closed.socket.emit("error");
  assert.equal(closed.failures.length, 1);

  const errored = await session();
  errored.socket.emit("error");
  assert.deepEqual(errored.failures.map((failure) => failure.kind), ["network"]);

  const ours = await session();
  ours.live.close();
  ours.socket.emit("close");
  ours.socket.committed("late");
  assert.deepEqual(ours.failures, []);
  assert.equal(ours.live.text, "");
  assert.equal(ours.socket.closes.length, 1);
});

test("closing while the final commit is awaited cancels it", async () => {
  const { live } = await session();
  const result = live.finish(1000);
  live.close();
  const settled = await result;
  assert.ok(!settled.ok && settled.failure.kind === "cancelled");
});

test("a failure before the handlers are attached is replayed to them", async () => {
  const { opened, socket } = await connect();
  assert.ok(opened.ok);
  socket.emit("close");
  const failures: RealtimeFailure[] = [];
  opened.session.listen({ onCommitted: () => undefined, onFailure: (failure) => failures.push(failure) });
  assert.deepEqual(failures.map((failure) => failure.kind), ["closed"]);
});

test("a message over 64 KiB ends the session as too large, while one of exactly 64 KiB is read", async () => {
  const envelope = JSON.stringify({ message_type: "committed_transcript", text: "" }).length;
  const padded = (bytes: number) =>
    JSON.stringify({ message_type: "committed_transcript", text: "a".repeat(bytes - envelope) });
  const exact = await session();
  exact.socket.message(padded(64 * 1024));
  assert.equal(exact.failures.length, 0);
  assert.equal(exact.live.text.length, 64 * 1024 - envelope);

  const over = await session();
  over.socket.message(padded(64 * 1024 + 1));
  assert.deepEqual(over.failures.map((failure) => failure.kind), ["too-large"]);
  assert.match(over.failures[0]!.message, /larger than 64 KiB/);
});

test("committed text beyond 1 MiB in total ends the session as too large", async () => {
  const { socket, failures, live } = await session();
  const segment = "a".repeat(60_000);
  let sent = 0;
  while (failures.length === 0 && sent < 30) {
    socket.committed(segment);
    sent++;
  }
  assert.equal(sent, 18, "the 18th segment passes 1 MiB");
  assert.deepEqual(failures.map((failure) => failure.kind), ["too-large"]);
  assert.match(failures[0]!.message, /more than 1 MiB/);
  assert.ok(live.text.length <= 1024 * 1024);
});

test("a message that is not JSON text, or a transcript without text, is discarded as a bad response", async () => {
  for (const data of ["{ not json", new Uint8Array([1]), JSON.stringify({ message_type: "committed_transcript" })]) {
    const { socket, failures } = await session();
    socket.emit("message", data);
    assert.deepEqual(failures.map((failure) => failure.kind), ["bad-response"]);
  }
});

const MATCHES: [string, string, string[], string | undefined][] = [
  ["a trailing phrase is removed with the comma before it", "and add a test, let's go", ["let's go"], "and add a test"],
  ["curly apostrophes in the text", "and add a test, let’s go.", ["let's go"], "and add a test"],
  ["curly apostrophes in the phrase", "and add a test, let's go", ["let’s go"], "and add a test"],
  ["case is ignored", "And add a test. LET'S GO!", ["let's go"], "And add a test"],
  ["runs of whitespace and punctuation are one separator", "add a test —  \n let's   go ...", ["let's go"], "add a test"],
  ["punctuation inside the phrase is a separator", "add a test, let's, go", ["let's go"], "add a test"],
  ["only the phrase", "Let's go.", ["let's go"], ""],
  ["the phrase in the middle", "let's go through the loader", ["let's go"], undefined],
  ["the phrase followed by words", "let's go home", ["let's go"], undefined],
  ["whole words only", "outlet's go", ["let's go"], undefined],
  ["whole words only after the phrase", "let's going", ["let's go"], undefined],
  ["a different apostrophe-less spelling", "lets go", ["let's go"], undefined],
  ["earlier punctuation is kept", "Fix it. Then add a test, let's go", ["let's go"], "Fix it. Then add a test"],
  ["the last occurrence counts", "let's go, then let's go", ["let's go"], "let's go, then"],
  ["any configured phrase", "ship it, send it", ["let's go", "send it"], "ship it"],
  ["the longest matching phrase wins", "ok, let's go", ["go", "let's go"], "ok"],
  ["Vietnamese with diacritics", "Hãy sửa lỗi này, ĐI THÔI.", ["đi thôi"], "Hãy sửa lỗi này"],
  ["decomposed text against a composed phrase", `Sửa lỗi, ${"thôi".normalize("NFD")} ${"đi".normalize("NFD")}`, ["thôi đi"], "Sửa lỗi"],
  ["a composed text against a decomposed phrase", "Sửa lỗi, đi thôi", ["đi thôi".normalize("NFD")], "Sửa lỗi"],
  ["a missing diacritic is a different word", "Sửa lỗi, di thoi", ["đi thôi"], undefined],
  ["empty text", "", ["let's go"], undefined],
  ["a phrase of only punctuation never matches", "hello !!!", ["!!!"], undefined],
  ["no phrases", "let's go", [], undefined],
];
for (const [name, text, phrases, expected] of MATCHES)
  test(`stop phrase matching: ${name}`, () => {
    assert.equal(matchStopPhrase(text, phrases), expected);
  });
