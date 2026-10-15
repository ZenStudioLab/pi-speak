import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetSpentHold } from "../hold-space.ts";
import { API_KEY, audioResponse } from "./harness.ts";
import { FakeClock } from "./hold-clock.ts";
import { afterStart, settle, startLive } from "./live-harness.ts";
import { baseConfig, sessionEvent, startRecording, useTalkHarness, audio, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();
beforeEach(resetSpentHold);

const liveOn = async (h: Harness) => {
  await h.run("status");
  return /live mode: on/.test(h.notices.at(-1)!.message);
};

test("/talk live starts live mode and a second /talk live ends it and closes the microphone", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  assert.match(h.liveStatuses.at(-1)!, /^● Live — listening · alt\+t cuts Pi off · \/talk live ends live mode · or say "Dừng cuộc hội thoại"$/);
  assert.equal(await liveOn(h), true);
  await h.runTalk("live");
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.ok(socket.closes.length >= 1, "the connection is closed");
  assert.equal(h.liveStatuses.at(-1), undefined);
  assert.match(h.messages(), /Live mode ended/);
  assert.equal(await liveOn(h), false);
  assert.equal(h.fetchCalls.length, 0, "no upload and no speech request");
});

test("the start message names ElevenLabs, the language setting, the cut-off key, and how to end live mode", async () => {
  const detected = await harness({ config: baseConfig({ language: undefined }) });
  await startLive(detected);
  assert.match(detected.notices[0]!.message, /ElevenLabs/);
  assert.match(detected.notices[0]!.message, /detected for each turn/);
  assert.match(detected.notices[0]!.message, /alt\+t cuts Pi off/);
  assert.match(detected.notices[0]!.message, /\/talk live ends live mode/);
  const fixed = await harness();
  await startLive(fixed);
  assert.match(fixed.notices[0]!.message, /fixed to vi/);
});

test("the connection uses the existing realtime parameters, with the key only in its header, and the recorder streams without it", async () => {
  const h = await harness();
  const { socket } = await startLive(h);
  const url = new URL(socket.url);
  assert.equal(`${url.origin}${url.pathname}`, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    model_id: "scribe_v2_realtime",
    audio_format: "pcm_16000",
    commit_strategy: "vad",
    vad_silence_threshold_secs: "1",
    language_code: "vi",
  });
  assert.deepEqual(socket.init, { headers: { "xi-api-key": API_KEY } });
  assert.ok(!socket.url.includes(API_KEY));
  const recorderEnv = h.spawnCalls[0]!.options.env as Record<string, string | undefined>;
  assert.ok(!Object.values(recorderEnv).includes(API_KEY), "the recorder never sees the key");
  assert.ok(!h.spawnCalls[0]!.args.includes(API_KEY));
});

test("input.language is sent as language_code only when it is set", async () => {
  const h = await harness({ config: baseConfig({ language: undefined }) });
  const { socket } = await startLive(h);
  assert.equal(new URL(socket.url).searchParams.has("language_code"), false);
});

test("recorder chunks reach the connection while live mode is on, and nothing is kept or capped", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
  const { child, socket } = await startLive(h);
  for (let i = 0; i < 40; i++) audio(child, 3200);
  assert.equal(socket.chunks().length, 40, "more than maxSeconds of audio is still streamed");
  assert.ok(socket.chunks().every((chunk) => !chunk.commit));
  assert.deepEqual(child.signals, []);
});

test("the recorder starts only after the connection opens, and a connection that does not open ends the start without a retry", async () => {
  const h = await harness({ holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  await settle();
  assert.equal(h.recorderChildren().length, 0, "the recorder waits for the connection");
  h.sockets[0]!.emit("error");
  await starting;
  assert.match(h.messages(), /could not be reached.*Nothing was retried.*Live mode was not started/s);
  await settle();
  assert.equal(h.sockets.length, 1, "no retry");
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(await liveOn(h), false);
  assert.equal(h.liveStatuses.length, 0);
});

test("a connection that fails while the recorder is starting ends live mode with no idle timer, status line, or start message", async () => {
  const clock = new FakeClock();
  const h = await harness({ liveClock: clock, holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  h.sockets[0]!.emit("open");
  h.sockets[0]!.emit("close");
  await starting;
  assert.equal(h.recorderChildren().length, 1, "the recorder had started");
  assert.deepEqual(h.recorderChildren()[0]!.signals, ["SIGINT"]);
  assert.match(h.messages(), /closed the connection unexpectedly.*Live mode ended/s);
  assert.doesNotMatch(h.messages(), /Live mode is on|was not started/);
  assert.equal(clock.pending, 0, "no idle timer");
  assert.equal(h.liveStatuses.at(-1), undefined);
  assert.equal(await liveOn(h), false);
});

test("live mode listens with ElevenLabs whatever the input and speech providers and their overrides select", async () => {
  const h = await harness({ config: { ...baseConfig({ provider: "deepgram" }), provider: "deepgram" } });
  await h.runTalk("provider deepgram");
  await h.run("provider deepgram");
  await startLive(h);
  assert.match(h.sockets[0]!.url, /^wss:\/\/api\.elevenlabs\.io\//);
  assert.match(h.notices.at(-1)!.message, /uses ElevenLabs to listen and to speak/);
  assert.equal(h.fetchCalls.length, 0);
});

const refusals: [string, Parameters<typeof harness>[0], RegExp][] = [
  ["a missing key", { apiKey: null }, /ELEVENLABS_API_KEY is not set/],
  ["a missing recording tool", { recorders: [] }, /No recording tool was found \(looked for rec, arecord, ffmpeg\)/],
  ["an invalid live setting", { config: baseConfig({ liveListenWhileSpeaking: "yes" }) }, /input\.liveListenWhileSpeaking must be true or false/],
  ["an invalid idle limit", { config: baseConfig({ liveIdleMinutes: 0 }) }, /input\.liveIdleMinutes/],
  [
    "a missing ElevenLabs voice",
    { config: { ...baseConfig(), providers: { elevenlabs: { modelId: "eleven_flash_v2_5" } } } },
    /providers\.elevenlabs\.voiceId/,
  ],
  [
    "a missing audio player",
    { config: { ...baseConfig(), player: { command: "no-such-player", args: ["{file}"] } } },
    /audio player "no-such-player" was not found/,
  ],
];
for (const [name, options, message] of refusals)
  test(`${name} refuses live mode with a message that names it, and opens nothing`, async () => {
    const h = await harness(options);
    await h.runTalk("live");
    assert.match(h.messages(), message);
    assert.match(h.messages(), /Live mode was not started/);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.spawnCalls.length, 0);
    assert.equal(h.liveStatuses.length, 0);
  });

test("live mode is available only in the interactive terminal", async () => {
  const h = await harness();
  await h.runTalk("live", { mode: "print" });
  assert.match(h.messages(), /interactive terminal/);
  assert.equal(h.sockets.length, 0);
});

test("a push-to-talk recording blocks live mode and continues unchanged", async () => {
  const h = await harness();
  const child = await startRecording(h);
  await h.runTalk("live");
  assert.match(h.messages(), /Stop or discard it before starting live mode/);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(child.signals, []);
  assert.match(h.talkStatuses.at(-1)!, /^● Recording/);
});

test("a recording held at the time cap blocks live mode", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
  const child = await startRecording(h);
  audio(child, 40000);
  await h.until(() => /limit reached/.test(h.talkStatuses.at(-1) ?? ""));
  await h.runTalk("live");
  assert.match(h.messages(), /Stop or discard it before starting live mode/);
  assert.equal(h.sockets.length, 0);
});

test("a transcription in flight blocks live mode", async () => {
  const h = await harness();
  h.setFetch(() => new Promise<Response>(() => undefined));
  const child = await startRecording(h);
  audio(child);
  h.advance(2000);
  await h.pressTranscribeShortcut();
  await h.until(() => h.fetchCalls.length === 1);
  await h.runTalk("live");
  assert.match(h.messages(), /transcription is in progress/);
  assert.equal(h.sockets.length, 0);
});

/** `/speak text` is playing and the next press has to wait for its player to exit. */
async function playerStopping(h: Harness, action: () => Promise<void>) {
  h.setFetch(async () => audioResponse());
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  const player = h.children[0]!;
  player.autoExitOnKill = false;
  const pending = action();
  await h.until(() => player.signals.includes("SIGTERM"));
  return { player, pending };
}

test("live mode stops this extension's own speech before it opens the connection or the microphone", async () => {
  const h = await harness();
  const { player, pending } = await playerStopping(h, () => h.runTalk("live"));
  await settle();
  assert.equal(h.sockets.length, 0, "nothing opens while the player is still exiting");
  assert.equal(h.recorderChildren().length, 0);
  player.emit("exit", null, "SIGTERM");
  await pending;
  assert.equal(h.sockets.length, 1);
  assert.equal(h.recorderChildren().length, 1);
  assert.deepEqual(player.signals, ["SIGTERM"]);
});

test("while live mode is starting, every push-to-talk control is refused and /talk live cancels the start", async () => {
  const h = await harness();
  const { player, pending } = await playerStopping(h, () => h.runTalk("live"));
  await h.pressShortcut();
  await h.pressTranscribeShortcut();
  assert.equal(h.notices.filter((n) => /Live mode is starting/.test(n.message)).length, 2);
  await h.runTalk("live");
  assert.match(h.messages(), /Live mode start cancelled/);
  player.emit("exit", null, "SIGTERM");
  await pending;
  assert.equal(h.sockets.length, 0, "the cancelled start opened nothing");
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(await liveOn(h), false);
});

test("a /talk live that cancels a start during the connection closes it and never starts the recorder", async () => {
  const h = await harness({ holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  await h.runTalk("live");
  await starting;
  assert.ok(h.sockets[0]!.closes.length >= 1);
  h.sockets[0]!.emit("open");
  await settle();
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(await liveOn(h), false);
});

test("a push-to-talk attempt that is still starting blocks /talk live", async () => {
  const h = await harness();
  const { player, pending } = await playerStopping(h, () => h.pressShortcut());
  await h.runTalk("live");
  assert.match(h.messages(), /starting, in progress, or held/);
  assert.equal(h.sockets.length, 0);
  player.emit("exit", null, "SIGTERM");
  await pending;
  await h.until(() => h.recorderChildren().length === 1);
  assert.equal(h.sockets.length, 0);
});

for (const [name, act] of [
  ["the transcribe-only shortcut", (h: Harness) => h.pressTranscribeShortcut()],
  ["the command shortcut", (h: Harness) => h.pressCommandShortcut()],
  ["the skill shortcut", (h: Harness) => h.pressSkillShortcut()],
  ["/talk", (h: Harness) => h.runTalk("")],
  ["/talk send", (h: Harness) => h.runTalk("send")],
  ["/talk command", (h: Harness) => h.runTalk("command")],
  ["/talk skill", (h: Harness) => h.runTalk("skill")],
] as const)
  test(`${name} during live mode starts no recording and names /talk live`, async () => {
    const h = await harness();
    const { child } = await startLive(h);
    await act(h);
    assert.match(afterStart(h).join("\n"), /Run \/talk live to end live mode/);
    assert.equal(h.spawnCalls.length, 1, "only the live recorder exists");
    assert.deepEqual(child.signals, []);
    assert.equal(h.talkStatuses.length, 0);
    assert.equal(await liveOn(h), true);
  });

test("the send key during live mode changes nothing and says nothing is being spoken", async () => {
  const h = await harness();
  const { child } = await startLive(h);
  await h.pressShortcut();
  assert.deepEqual(afterStart(h), ["Nothing is being spoken."]);
  assert.equal(h.aborts, 0, "the agent is not aborted");
  assert.deepEqual(child.signals, []);
  assert.equal(await liveOn(h), true);
});

test("a Space hold during live mode is busy: Spaces keep typing and nothing starts", async () => {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock });
  h.sessionStart();
  await startLive(h);
  let consumed = 0;
  for (const gap of [0, 500, 30, 30, 30, 30]) {
    clock.advance(gap);
    if (h.sendKey(" ")) consumed++;
  }
  assert.equal(consumed, 0, "no Space is consumed");
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.talkStatuses.length, 0);
});

test("Escape is not intercepted during live mode", async () => {
  const h = await harness();
  const { child } = await startLive(h);
  assert.equal(h.sendKey("\x1b"), false);
  assert.deepEqual(child.signals, []);
  assert.equal(await liveOn(h), true);
});

for (const args of ["text hello", "", "original", "in vi", "replay"])
  test(`/speak ${args} during live mode is refused with a message and makes no request`, async () => {
    const h = await harness();
    h.setFetch(async () => audioResponse());
    await h.run("text earlier clip");
    await h.until(() => h.children.length === 1);
    h.children[0]!.finish(0);
    await h.controller.whenIdle();
    await startLive(h);
    const fetches = h.fetchCalls.length;
    await h.run(args);
    assert.match(afterStart(h).join("\n"), /\/speak is unavailable during live mode.*\/talk live/);
    assert.equal(h.fetchCalls.length, fetches);
    assert.equal(h.children.length, 2, "no player started for the refused command");
    assert.equal(await liveOn(h), true);
  });

test("/speak stop, status, provider, locale, help and /talk provider keep working during live mode", async () => {
  const h = await harness();
  const { child } = await startLive(h);
  const before = h.notices.length;
  await h.run("stop");
  await h.run("provider");
  await h.run("locale");
  await h.run("help");
  await h.runTalk("provider");
  await h.runTalk("help");
  const shown = h.notices.slice(before).map((notice) => notice.message);
  assert.equal(shown.length, 6);
  assert.ok(shown.every((message) => !/unavailable during live mode/.test(message)));
  assert.match(shown[0]!, /Nothing is being generated or played/);
  assert.match(shown[1]!, /speech provider: /);
  assert.deepEqual(child.signals, []);
  await h.run("status");
  for (const line of [/live mode: on/, /live idle limit: 5 minutes/, /live listen while speaking: off/])
    assert.match(h.notices.at(-1)!.message, line);
});

test("a provider selected during live mode applies to push-to-talk after live mode ends", async () => {
  const h = await harness({ config: baseConfig({ provider: "elevenlabs" }) });
  await startLive(h);
  await h.runTalk("provider deepgram");
  await h.runTalk("live");
  assert.match(h.messages(), /input provider: deepgram \(session override\)/);
  const child = await startRecording(h);
  audio(child);
  h.advance(2000);
  await h.pressTranscribeShortcut();
  await h.until(() => h.fetchCalls.length === 1);
  assert.match(h.fetchCalls[0]!.url, /deepgram/);
});

test("a lost connection ends live mode with a message, stops the recorder, and does not reconnect", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  socket.emit("close");
  assert.match(afterStart(h).join("\n"), /closed the connection unexpectedly.*Live mode ended/s);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(h.liveStatuses.at(-1), undefined);
  await settle();
  assert.equal(h.sockets.length, 1, "no reconnect");
  assert.equal(await liveOn(h), false);
});

test("a provider error ends live mode with its sanitized class, once, however many failures follow", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  socket.message({ message_type: "auth_error", error: `bad key ${API_KEY}` });
  socket.emit("close");
  socket.emit("error");
  child.finish(1);
  await settle();
  const ended = afterStart(h).filter((message) => /Live mode ended/.test(message));
  assert.equal(ended.length, 1);
  assert.match(ended[0]!, /rejected the API key/);
  assert.ok(!h.messages().includes(API_KEY));
  assert.deepEqual(child.signals, ["SIGINT"]);
});

test("a recorder that exits on its own ends live mode, closes the connection, and keeps the key out of the message", async () => {
  const h = await harness();
  const { child, socket } = await startLive(h);
  child.stderr.emit("data", Buffer.from(`device busy for ${API_KEY}`));
  child.finish(1);
  await h.until(() => h.liveStatuses.at(-1) === undefined);
  assert.match(afterStart(h).join("\n"), /Recording failed: rec exited on its own.*Live mode ended/s);
  assert.ok(!h.messages().includes(API_KEY), "the key is redacted");
  assert.ok(socket.closes.length >= 1);
  assert.equal(await liveOn(h), false);
});

for (const event of ["session_before_switch", "session_before_fork", "session_tree", "session_shutdown"])
  test(`${event} ends live mode silently: recorder stopped, connection closed, status cleared`, async () => {
    const h = await harness();
    const { child, socket } = await startLive(h);
    sessionEvent(h, event);
    sessionEvent(h, event);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.ok(socket.closes.length >= 1);
    assert.equal(h.liveStatuses.at(-1), undefined);
    assert.equal(afterStart(h).length, 0, "no message");
    assert.equal(await liveOn(h), false);
  });

test("with live mode off, loading and every lifecycle event open no connection or recorder and speak nothing", async () => {
  const h = await harness();
  for (const event of h.events.keys()) if (event !== "session_start") sessionEvent(h, event);
  await h.run("status");
  assert.match(h.notices.at(-1)!.message, /live mode: off/);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.liveStatuses.length, 0);
});
