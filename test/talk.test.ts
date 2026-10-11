import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { audioResponse, type CtxOptions } from "./harness.ts";
import {
  audio,
  baseConfig,
  json,
  mixed,
  respond,
  sessionEvent,
  startRecording,
  stopAndSettle,
  stopWith,
  useTalkHarness,
  type Harness,
  type PressKey,
  type Stop,
} from "./talk-harness.ts";

const harness = useTalkHarness();


test("speech commands, status, and provider selection start no recorder", async () => {
  const h = await harness();
  await h.run("text hello");
  await h.run("status");
  await h.run("provider deepgram");
  await h.runTalk("provider elevenlabs");
  sessionEvent(h, "session_shutdown");
  assert.equal(h.recorderChildren().length, 0);
});

test("a missing key for the selected provider is named and starts no recorder or request", async () => {
  const h = await harness({ deepgramKey: null });
  await h.pressShortcut();
  assert.match(h.messages(), /DEEPGRAM_API_KEY is not set/);
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.fetchCalls.length, 0);
  await h.runTalk("provider elevenlabs");
  await h.pressShortcut();
  assert.equal(h.recorderChildren().length, 1, "ELEVENLABS_API_KEY is set, so the override records");
});

test("an unknown /talk argument shows the combined help, changes nothing, and makes no request", async () => {
  const h = await harness();
  await h.run("help");
  const help = h.notices.at(-1)!.message;
  for (const args of ["bogus", "send now", "provider whisper", "provider deepgram extra"]) {
    await h.runTalk(args);
    assert.equal(h.notices.at(-1)!.message, help);
  }
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

for (const mode of ["rpc", "json", "print"])
  test(`voice input is unsupported in ${mode} mode and records nothing`, async () => {
    const h = await harness();
    await h.runTalk("", { mode });
    await h.pressShortcut({ mode });
    assert.equal(h.notices.length, 2);
    assert.match(h.notices[0]!.message, /works only in the interactive terminal/);
    assert.equal(h.recorderChildren().length, 0);
    assert.equal(h.fetchCalls.length, 0);
  });

test("/talk starts, the shortcut stops, and exactly one Deepgram request carries the recording", async () => {
  const h = await harness();
  await h.runTalk("");
  await h.until(() => h.recorderChildren().length === 1);
  const child = h.recorderChildren()[0]!;
  audio(child);
  await stopAndSettle(h);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(h.fetchCalls.length, 1);
  const call = h.fetchCalls[0]!;
  assert.equal(
    call.url,
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=vi",
  );
  const wav = call.init.body as Uint8Array;
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(wav.length, 44 + 3200);
  assert.equal(h.editor.text, "xin chào");
});

test("a recording is sent to ElevenLabs as one multipart upload without audio-event tags", async () => {
  const h = await harness({ config: baseConfig({ provider: "elevenlabs", language: undefined }) });
  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0]!.url, "https://api.elevenlabs.io/v1/speech-to-text");
  const form = h.fetchCalls[0]!.init.body as FormData;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("tag_audio_events"), "false");
  assert.equal(form.has("language_code"), false);
  assert.equal(h.editor.text, "xin chào");
});

test("the indicator follows the recording: recording with time and level, then transcribing, then nothing", async () => {
  const h = await harness();
  const child = await startRecording(h);
  h.advance(3000);
  child.emitAudio(new Uint8Array(new Int16Array(1600).fill(30000).buffer));
  await stopAndSettle(h);
  const lines = h.talkStatuses.filter(Boolean) as string[];
  assert.match(lines[0]!, /Recording 0:00 .* alt\+t stop and send · alt\+shift\+t stop, transcribe only · alt\+m stop, command · alt\+i stop, skill · Esc discard/);
  assert.match(lines[1]!, /Recording 0:03 █ .* alt\+t stop and send/);
  assert.equal(lines.at(-1), "Transcribing…");
  assert.equal(h.talkStatuses.at(-1), undefined);
});

test("the transcript is appended to the composer with one space and nothing is submitted", async () => {
  for (const [existing, expected] of [
    ["Refactor the loader", "Refactor the loader xin chào"],
    ["Refactor the loader ", "Refactor the loader xin chào"],
    ["Refactor\n", "Refactor\nxin chào"],
    ["", "xin chào"],
  ] as const) {
    const h = await harness();
    h.editor.text = existing;
    audio(await startRecording(h));
    await stopAndSettle(h);
    assert.equal(h.editor.text, expected);
    assert.equal(h.submitted, 0);
  }
});

test("an empty transcript leaves the composer unchanged and says nothing was recognized", async () => {
  const h = await harness();
  respond(h, "");
  h.editor.text = "keep me";
  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.equal(h.editor.text, "keep me");
  assert.match(h.messages(), /Nothing was recognized/);
});

test("Escape while recording stops the recorder, sends nothing, and never reaches the editor", async () => {
  const h = await harness();
  const child = await startRecording(h);
  audio(child);
  assert.equal(h.sendKey("a"), false, "other keys pass through");
  assert.equal(h.sendKey("\r"), false, "Enter is never intercepted");
  assert.equal(h.sendKey("\x1b"), true);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.equal(h.sendKey("\x1b"), false, "the key is released once the recording is gone");
  await h.until(() => h.fetchCalls.length === 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.editor.text, "");
});

test("a recording stopped at the time cap is held unsent, and the next press transcribes it once", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
  const child = await startRecording(h);
  audio(child, 40000);
  await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.match(h.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent — alt\+t send · alt\+shift\+t transcribe only · alt\+m command · alt\+i skill · Esc discard/);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.notices.length, 0, "a requested stop is not a failure");
  await h.pressTranscribeShortcut();
  await h.until(() => h.editor.text !== "");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal((h.fetchCalls[0]!.init.body as Uint8Array).length, 44 + 32000);
  await h.pressTranscribeShortcut();
  assert.equal(h.recorderChildren().length, 2, "the press after delivery starts a new recording");
});

test("a control pressed after the time cap, before the recorder exits, uploads once after the exit; Escape then discards", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
  h.editor.text = "Draft";
  const child = await startRecording(h);
  child.autoExitOnKill = false;
  audio(child, 40000);
  assert.match(h.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent/, "held at once, before the recorder exits");
  await h.pressTranscribeShortcut();
  assert.equal(h.talkStatuses.at(-1), "Transcribing…");
  assert.equal(h.fetchCalls.length, 0, "nothing is uploaded before the recorder exits");
  child.finish(0);
  await h.until(() => h.talkStatuses.at(-1) === undefined && h.fetchCalls.length === 1);
  assert.equal(h.editor.text, "Draft xin chào");
  assert.equal(h.sent.length, 0);

  const discarded = await harness({ config: baseConfig({ maxSeconds: 1 }) });
  const second = await startRecording(discarded);
  second.autoExitOnKill = false;
  audio(second, 40000);
  assert.match(discarded.talkStatuses.at(-1)!, /Recording limit reached \(1 s\), not sent/);
  assert.equal(discarded.sendKey("\x1b"), true);
  second.finish(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(discarded.fetchCalls.length, 0);
  assert.equal(discarded.talkStatuses.at(-1), undefined);
});

test("a recording started with a transcribe key and stopped with the second send key is sent, and every key is registered", async () => {
  const keys = { send: ["alt+t", "alt+y"], transcribe: ["alt+shift+t", "alt+shift+y"] };
  const h = await harness({
    shortcuts: keys,
    config: baseConfig({ shortcut: keys.send, transcribeShortcut: keys.transcribe }),
  });
  assert.deepEqual([...h.shortcuts.keys()], [...keys.send, ...keys.transcribe, "alt+m", "alt+i"]);
  h.editor.text = "Draft";
  await h.pressKey("alt+shift+y");
  await h.until(() => h.recorderChildren().length === 1);
  audio(h.recorderChildren()[0]!);
  assert.match(h.talkStatuses.at(-1)!, /— alt\+t \/ alt\+y stop and send · alt\+shift\+t \/ alt\+shift\+y stop, transcribe only ·/);
  h.advance(2000);
  await h.pressKey("alt+y");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Draft xin chào"]);
  assert.equal(h.editor.text, "");

  const capped = await harness({
    shortcuts: keys,
    config: baseConfig({ shortcut: keys.send, transcribeShortcut: keys.transcribe, maxSeconds: 1 }),
  });
  audio(await startRecording(capped), 40000);
  assert.match(capped.talkStatuses.at(-1)!, /not sent — alt\+t \/ alt\+y send · alt\+shift\+t \/ alt\+shift\+y transcribe only ·/);
});

test("Escape or a session change discards a held recording; the next shortcut starts a new one", async () => {
  for (const discard of [() => undefined, (h: Harness) => sessionEvent(h)]) {
    const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
    const child = await startRecording(h);
    audio(child, 40000);
    await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
    if (discard.length === 0) assert.equal(h.sendKey("\x1b"), true);
    else discard(h);
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.equal(h.fetchCalls.length, 0);
    await startRecording(h);
    assert.equal(h.recorderChildren().length, 2);
    assert.equal(h.fetchCalls.length, 0, "the discarded audio is never sent");
  }
});

test("a tap shorter than 0.5 seconds is discarded with a message and nothing is sent", async () => {
  const h = await harness();
  const child = await startRecording(h);
  audio(child);
  h.advance(400);
  await h.pressTranscribeShortcut();
  assert.match(h.messages(), /shorter than 0.5 seconds/);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.talkStatuses.at(-1), undefined);
});

test("a press during transcription is refused, Escape is not taken, and no second recording starts", async () => {
  const h = await harness();
  let release!: (response: Response) => void;
  h.setFetch(() => new Promise<Response>((resolve) => (release = resolve)));
  audio(await startRecording(h));
  h.advance(2000);
  await h.pressTranscribeShortcut();
  await h.until(() => h.fetchCalls.length === 1);
  await h.pressTranscribeShortcut();
  await h.runTalk("");
  assert.equal(h.notices.filter((n) => /still in progress/.test(n.message)).length, 2);
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.sendKey("\x1b"), false);
  release(json({ results: { channels: [{ alternatives: [{ transcript: "ok" }] }] } }));
  await h.until(() => h.editor.text === "ok");
});

test("starting a recording stops this extension's own player and waits for its exit; speech is refused while recording", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  const player = h.children[0]!;
  player.autoExitOnKill = false;
  const pressed = h.pressShortcut();
  await h.until(() => player.signals.includes("SIGTERM"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.recorderChildren().length, 0, "the recorder waits for the player's real exit");
  assert.equal(h.messages(), "");
  await h.run("text refused");
  assert.match(h.messages(), /recording is in progress or held/);
  player.emit("exit", null, "SIGTERM");
  await pressed;
  await h.until(() => h.recorderChildren().length === 1);
  assert.deepEqual(player.signals, ["SIGTERM"], "nothing else was signalled");
  const fetchesBefore = h.fetchCalls.length;
  await h.run("text still refused");
  assert.equal(h.fetchCalls.length, fetchesBefore);
  assert.equal(h.children.length, 2, "no new player started");
});

/** Presses the shortcut while this extension's player is still stopping, which holds the start. */
async function pressWhilePlayerStops(h: Harness) {
  h.setFetch(async () => audioResponse());
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  const player = h.children[0]!;
  player.autoExitOnKill = false;
  const pressed = h.pressShortcut();
  await h.until(() => player.signals.includes("SIGTERM"));
  return { player, pressed, fetchesBefore: h.fetchCalls.length };
}

test("Escape while the recording is starting cancels the attempt, is consumed, and starts no recorder", async () => {
  const h = await harness();
  const { player, pressed, fetchesBefore } = await pressWhilePlayerStops(h);
  assert.equal(h.sendKey("\x1b"), true);
  assert.equal(h.talkStatuses.at(-1), undefined);
  player.emit("exit", null, "SIGTERM");
  await pressed;
  assert.equal(h.spawnCalls.length, 1, "only the player was spawned");
  assert.equal(h.fetchCalls.length, fetchesBefore);
  assert.equal(h.keyListeners.size, 0);
  assert.equal(h.sendKey("\x1b"), false, "Escape reaches the editor once nothing is starting or recording");
});

for (const second of ["pressShortcut", "pressTranscribeShortcut"] as const)
test(`a second press of ${second === "pressShortcut" ? "the send" : "the transcribe-only"} shortcut while the recording is starting cancels the attempt and starts no recorder`, async () => {
  const h = await harness();
  const { player, pressed, fetchesBefore } = await pressWhilePlayerStops(h);
  await h[second]();
  assert.match(h.messages(), /Recording cancelled/);
  assert.equal(h.talkStatuses.at(-1), undefined);
  player.emit("exit", null, "SIGTERM");
  await pressed;
  assert.equal(h.spawnCalls.length, 1, "only the player was spawned");
  assert.equal(h.fetchCalls.length, fetchesBefore);
  assert.equal(h.keyListeners.size, 0);
  assert.equal(h.sendKey("\x1b"), false);
});

test("no recording tool names the tools looked for and starts nothing", async () => {
  const h = await harness({ recorders: [] });
  await h.pressTranscribeShortcut();
  assert.match(h.messages(), /looked for rec, arecord, ffmpeg/);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.sendKey("\x1b"), false);
});

test("a recorder that exits on its own, or records nothing, is reported and sends nothing", async () => {
  const h = await harness();
  const first = await startRecording(h);
  audio(first);
  first.finish(1);
  await h.until(() => /Recording failed/.test(h.messages()));
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.equal(h.sendKey("\x1b"), false);

  const second = await startRecording(h);
  h.advance(2000);
  await h.pressShortcut();
  await h.until(() => h.notices.filter((n) => /Recording failed/.test(n.message)).length === 2);
  assert.match(h.notices.at(-1)!.message, /recorded no audio/);
  assert.deepEqual(second.signals, ["SIGINT"]);
  assert.equal(h.fetchCalls.length, 0);
});

test("shutdown or session replacement during a recording stops the recorder and leaves no file", async () => {
  for (const event of ["session_shutdown", "session_before_switch", "session_before_fork", "session_tree"]) {
    const h = await harness();
    const child = await startRecording(h);
    audio(child);
    sessionEvent(h, event);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.equal(h.sendKey("\x1b"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.fetchCalls.length, 0);
    const files = (await readdir(h.dir, { recursive: true })).filter((name) => /\.(wav|pcm|raw)$/.test(name));
    assert.deepEqual(files, []);
  }
});

for (const stop of ["pressShortcut", "pressTranscribeShortcut"] as const)
test(`a transcript that arrives after the session was replaced is dropped, even when stopped with ${stop}`, async () => {
  const h = await harness();
  let release!: (response: Response) => void;
  h.setFetch(() => new Promise<Response>((resolve) => (release = resolve)));
  audio(await startRecording(h));
  h.advance(2000);
  await h[stop]();
  await h.until(() => h.fetchCalls.length === 1);
  sessionEvent(h);
  assert.equal((h.fetchCalls[0]!.init.signal as AbortSignal).aborted, true);
  release(json({ results: { channels: [{ alternatives: [{ transcript: "late" }] }] } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.editor.text, "");
  assert.equal(h.sent.length, 0, "a dropped transcript is never sent");
  assert.equal(h.messages(), "");
  assert.equal(h.talkStatuses.at(-1), undefined);
});

test("a session override applies from the next recording and is not written to the configuration", async () => {
  const h = await harness({ config: baseConfig({ provider: "deepgram" }), apiKey: "eleven-test-key" });
  const path = join(h.dir, "config", "pi-speak", "config.json");
  const before = await readFile(path, "utf8");
  await h.runTalk("provider elevenlabs");
  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.equal(new URL(h.fetchCalls[0]!.url).host, "api.elevenlabs.io");
  assert.equal(await readFile(path, "utf8"), before);

  const restarted = await harness({ config: baseConfig({ provider: "deepgram" }), apiKey: "eleven-test-key" });
  audio(await startRecording(restarted));
  await stopAndSettle(restarted);
  assert.equal(new URL(restarted.fetchCalls[0]!.url).host, "api.deepgram.com");
});

test("provider, model, and language are fixed when a recording starts", async () => {
  const h = await harness({ apiKey: "eleven-test-key" });
  audio(await startRecording(h));
  await h.runTalk("provider elevenlabs");
  await h.writeConfig(baseConfig({ language: "en" }));
  await stopAndSettle(h);
  assert.deepEqual(h.fetchCalls.map((call) => new URL(call.url).host), ["api.deepgram.com"]);
  assert.match(h.fetchCalls[0]!.url, /language=vi$/);

  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.deepEqual(h.fetchCalls.map((call) => new URL(call.url).host), ["api.deepgram.com", "api.elevenlabs.io"]);
});

test("a malformed input.language is reported and no recording starts", async () => {
  const h = await harness({ config: baseConfig({ language: "not a tag!" }) });
  await h.pressTranscribeShortcut();
  assert.match(h.messages(), /input\.language/);
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

test("a provider failure is shown sanitized, not retried or rerouted, and clears the indicator", async () => {
  const key = "deepgramtokenkey";
  const h = await harness({ deepgramKey: key, apiKey: "eleven-test-key" });
  h.setFetch(async () => json({ detail: { status: key } }, 401));
  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.equal(h.fetchCalls.length, 1);
  assert.match(h.messages(), /Deepgram rejected the API key/);
  assert.doesNotMatch(h.messages(), new RegExp(key));
  assert.equal(h.editor.text, "");
  assert.equal(h.sendKey("\x1b"), false);
  h.setFetch(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
  audio(await startRecording(h));
  await stopAndSettle(h);
  assert.equal(h.fetchCalls.length, 2);
  assert.match(h.notices.at(-1)!.message, /redirect, which is not followed/);
});

const startWith = async (h: Harness, start: Stop) => {
  const wanted = h.recorderChildren().length + 1;
  await stopWith(h, start);
  await h.until(() => h.recorderChildren().length === wanted);
  return h.recorderChildren()[wanted - 1]!;
};
const SENDS: Stop[] = ["pressShortcut", "send"];

// Each stop is paired with a start from the other family, so the start cannot be what decides.
for (const [start, stop] of [
  ["pressTranscribeShortcut", "pressShortcut"],
  ["talk", "send"],
  ["pressShortcut", "pressTranscribeShortcut"],
  ["send", "talk"],
] as const)
    test(`started with ${start}, stopped with ${stop}: the stopping control ${SENDS.includes(stop) ? "sends the composer" : "only transcribes"}`, async () => {
      const h = await harness();
      h.editor.text = "Refactor the loader";
      audio(await startWith(h, start));
      h.advance(2000);
      await stopWith(h, stop);
      await h.until(() => h.talkStatuses.at(-1) === undefined && h.fetchCalls.length === 1);
      if (SENDS.includes(stop)) {
        assert.deepEqual(h.sent.map((m) => m.text), ["Refactor the loader xin chào"]);
        assert.deepEqual(h.sent[0]!.options, { expandPromptTemplates: false });
        assert.equal(h.sent[0]!.composerAtCall, "Refactor the loader xin chào", "cleared only after the call returned");
        assert.equal(h.editor.text, "");
      } else {
        assert.equal(h.sent.length, 0);
        assert.equal(h.editor.text, "Refactor the loader xin chào");
      }
    });

/** Presses the send shortcut as the stopping control, with the agent idle or working. */
async function sendAs(h: Harness, idle: boolean, context: CtxOptions = {}) {
  h.advance(2000);
  await h.pressShortcut({ ...context, idle });
  await h.until(() => h.talkStatuses.at(-1) === undefined && h.fetchCalls.length === 1);
}

for (const [label, idle, sendWhenBusy, expected] of [
  ["idle", true, undefined, { expandPromptTemplates: false }],
  ["busy by default", false, undefined, { deliverAs: "steer", expandPromptTemplates: false }],
  ["busy with interrupt", false, "interrupt", { deliverAs: "steer", expandPromptTemplates: false }],
  ["busy with wait", false, "wait", { deliverAs: "followUp", expandPromptTemplates: false }],
] as const)
  test(`a sent message while ${label} is delivered as ${JSON.stringify(expected)}`, async () => {
    const h = await harness({ config: baseConfig({ sendWhenBusy }) });
    audio(await startRecording(h));
    await sendAs(h, idle);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]!.options, expected);
  });

test("sendWhenBusy is read when the message is sent, not when the recording starts", async () => {
  const h = await harness();
  audio(await startRecording(h));
  await h.writeConfig(baseConfig({ sendWhenBusy: "wait" }));
  await sendAs(h, false);
  assert.deepEqual(h.sent[0]!.options, { deliverAs: "followUp", expandPromptTemplates: false });
});

test("a recording held at the time cap is sent or only transcribed by the control that releases it", async () => {
  for (const [stop, sends] of [["pressShortcut", true], ["pressTranscribeShortcut", false], ["send", true], ["talk", false]] as const) {
    const h = await harness({ config: baseConfig({ maxSeconds: 1 }) });
    h.editor.text = "Draft";
    audio(await startRecording(h), 40000);
    await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
    await stopWith(h, stop);
    await h.until(() => h.talkStatuses.at(-1) === undefined && h.fetchCalls.length === 1);
    assert.equal(h.sent.length, sends ? 1 : 0, stop);
    assert.equal(h.editor.text, sends ? "" : "Draft xin chào", stop);
  }
});

test("a slash command in the composer is sent as plain text with template expansion off", async () => {
  const h = await harness();
  h.editor.text = "/compact";
  audio(await startRecording(h));
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent[0]!.text, "/compact xin chào");
  assert.equal((h.sent[0]!.options as { expandPromptTemplates: boolean }).expandPromptTemplates, false);
  assert.equal(h.fetchCalls.length, 1);
});

test("an empty transcript in send mode sends nothing and leaves the composer unchanged", async () => {
  const h = await harness();
  respond(h, "");
  h.editor.text = "keep me";
  audio(await startRecording(h));
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "keep me");
  assert.match(h.messages(), /Nothing was recognized/);
});

test("a failed transcription in send mode sends nothing", async () => {
  const h = await harness();
  h.setFetch(async () => json({ detail: "bad" }, 401));
  audio(await startRecording(h));
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent.length, 0);
  assert.match(h.messages(), /Deepgram rejected the API key/);
});

test("when the send call throws the draft and transcript stay in the composer and the error is shown", async () => {
  const h = await harness({ sendThrows: "agent unavailable" });
  h.editor.text = "Draft";
  audio(await startRecording(h));
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent.length, 1);
  assert.equal(h.editor.text, "Draft xin chào");
  assert.match(h.notices.at(-1)!.message, /Not sent: agent unavailable\. The draft and transcript are still in the composer/);
  assert.equal(h.notices.at(-1)!.level, "error");
});

test("a refusal the host reports after the send call returned is not seen by the extension: the composer is already cleared", async () => {
  const h = await harness({ sendFailure: "no API key for the selected provider" });
  h.editor.text = "Draft";
  audio(await startRecording(h));
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent.length, 1);
  assert.equal(h.editor.text, "");
  assert.deepEqual(h.hostErrors, ["no API key for the selected provider"]);
  assert.equal(h.notices.length, 0, "Pi, not this extension, shows that error");
});

for (const sendWhenBusy of ["interrupt", "wait"] as const)
  test(`a send during compaction with sendWhenBusy ${sendWhenBusy} sends nothing, keeps the draft and transcript, and says to press Enter`, async () => {
    const h = await harness({ config: baseConfig({ sendWhenBusy }) });
    h.editor.text = "Draft";
    audio(await startRecording(h));
    assert.equal(h.events.get("session_before_compact")!() as unknown, undefined, "compaction is never cancelled or changed");
    await sendAs(h, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.editor.text, "Draft xin chào");
    assert.equal(h.talkStatuses.at(-1), undefined);
    assert.match(h.notices.at(-1)!.message, /added to the composer but not sent: Pi is compacting the conversation\. Press Enter to queue the message/);
  });

for (const end of ["session_compact", "session_compact_failed"])
  test(`${end} ends the compaction block, so the next send goes out`, async () => {
    const h = await harness();
    h.events.get("session_before_compact")!();
    h.events.get(end)!();
    audio(await startRecording(h));
    await sendAs(h, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.editor.text, "");
  });

test("a send with no model selected sends nothing, keeps the draft and transcript, and says why", async () => {
  const h = await harness();
  h.editor.text = "Draft";
  audio(await startRecording(h));
  await sendAs(h, true, { noModel: true });
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft xin chào");
  assert.equal(h.talkStatuses.at(-1), undefined);
  assert.match(h.notices.at(-1)!.message, /added to the composer but not sent: no model is selected/);
});

test("the status lines name the shortcuts registered at load, not the file as edited since", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1, shortcut: "ctrl+alt+m", transcribeShortcut: "ctrl+alt+n" }) });
  audio(await startRecording(h), 40000);
  await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
  const lines = mixed(h.talkStatuses);
  assert.match(lines, /Recording 0:00 .* alt\+t stop and send · alt\+shift\+t stop, transcribe only/);
  assert.match(lines, /not sent — alt\+t send · alt\+shift\+t transcribe only/);
  assert.doesNotMatch(lines, /ctrl\+alt/);
});

test("if the configuration cannot be read at send time the transcript is added but not sent", async () => {
  const h = await harness();
  audio(await startRecording(h));
  await h.writeConfig({ input: { shortcut: "alt+t", transcribeShortcut: "alt+t" } });
  await stopAndSettle(h, "pressShortcut");
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "xin chào");
  assert.match(h.notices.at(-1)!.message, /added to the composer but not sent: input\.shortcut, input\.transcribeShortcut, input\.commandShortcut and input\.skillShortcut must be different/);
});

test("equal shortcuts are a configuration error: nothing records and the error names both settings", async () => {
  const h = await harness({ config: baseConfig({ shortcut: "alt+x", transcribeShortcut: "ALT+X" }) });
  await h.pressShortcut();
  await h.pressTranscribeShortcut();
  assert.equal(h.notices.length, 2);
  assert.ok(h.notices.every((n) => /input\.shortcut, input\.transcribeShortcut, input\.commandShortcut and input\.skillShortcut must be different/.test(n.message)));
  assert.equal(h.recorderChildren().length, 0);
});

// Voice command and skill keys: the transcript is matched at the stop, and only the editor changes.
const LISTED = [
  { name: "opsx-apply-loop", source: "extension" },
  { name: "review", source: "prompt" },
  { name: "foo-bar", source: "extension" },
  { name: "foobar", source: "prompt" },
  { name: "skill:review-convergence", source: "skill" },
  { name: "skill:online-llm-interactive", source: "skill" },
];
const ALIASES = { model: "/model", "new session": "/new", "apply it": "/opsx-apply-loop now" };

/** Records `transcript` and stops with `stop`; the recording starts with the same key unless `start` says otherwise. */
async function dictate(h: Harness, transcript: string, stop: PressKey, start: PressKey = stop) {
  respond(h, transcript);
  audio(await startRecording(h, start));
  await stopAndSettle(h, stop);
}

for (const [name, stop, editor, transcript, expected, warning] of [
  ["a spoken command goes to the start of the editor, before the draft", "pressCommandShortcut", "fix the login bug", "op sx apply loop, add speak voice input.", "/opsx-apply-loop add speak voice input fix the login bug", undefined],
  ["a prompt template is a command too", "pressCommandShortcut", "", "Review the diff", "/review the diff", undefined],
  ["a command alone replaces a blank editor", "pressCommandShortcut", "  ", "opsx apply loop", "/opsx-apply-loop", undefined],
  ["a spoken skill becomes /skill:<name>", "pressSkillShortcut", "", "Review convergence.", "/skill:review-convergence", undefined],
  ["an alias reaches a command that Pi does not list, in an empty editor", "pressCommandShortcut", "", "Model.", "/model", undefined],
  ["an alias to a listed command takes the alias target as written", "pressCommandShortcut", "my draft", "apply it", "/opsx-apply-loop now my draft", undefined],
  ["an interactive alias with a draft is appended, with a warning", "pressCommandShortcut", "fix the login bug", "new session", "fix the login bug new session", /needs an empty editor/],
  ["an interactive alias with words after it is appended, with a warning", "pressCommandShortcut", "", "model please", "model please", /needs an empty editor/],
  ["a draft's edge whitespace does not double the spaces", "pressCommandShortcut", "  fix the login bug \n", "Review the diff", "/review the diff fix the login bug", undefined],
  ["words in another order match a skill", "pressSkillShortcut", "", "LLM online interactive check the spec", "/skill:online-llm-interactive check the spec", undefined],
  ["a skill name does not match in command mode", "pressCommandShortcut", "", "online llm interactive", "online llm interactive", /No command matched/],
  ["a skill name with its prefix does not match in command mode", "pressCommandShortcut", "", "skill online llm interactive", "skill online llm interactive", /No command matched/],
  ["words that match no command are appended, with a warning", "pressCommandShortcut", "Draft", "order a pizza", "Draft order a pizza", /No command matched/],
  ["words that match no skill are appended, with a warning", "pressSkillShortcut", "", "order a pizza", "order a pizza", /No skill matched/],
  ["a command name does not match in skill mode", "pressSkillShortcut", "", "review the diff", "review the diff", /No skill matched/],
  ["two different names with one spelling are appended, with a warning naming both", "pressCommandShortcut", "", "foo bar", "foo bar", /\/foo-bar, \/foobar/],
] as [string, PressKey, string, string, string, RegExp | undefined][])
  test(`voice command: ${name}`, async () => {
    const h = await harness({ config: baseConfig({ commandAliases: ALIASES }), commands: LISTED });
    h.editor.text = editor;
    await dictate(h, transcript, stop);
    assert.equal(h.editor.text, expected);
    assert.equal(h.submitted, 0, "nothing is sent and no command runs");
    const warnings = h.notices.filter((notice) => notice.level === "warning");
    if (warning) {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!.message, warning);
      assert.ok(!warnings[0]!.message.includes(transcript), "a warning never repeats the transcript");
    } else assert.equal(h.notices.length, 0);
  });

test("the key that stops the recording decides the mode: a send-key start stopped with the skill key matches skills and sends nothing", async () => {
  const h = await harness({ commands: LISTED });
  await dictate(h, "review convergence", "pressSkillShortcut", "pressShortcut");
  assert.equal(h.editor.text, "/skill:review-convergence");
  assert.equal(h.submitted, 0);
  await dictate(h, "review convergence", "pressTranscribeShortcut", "pressCommandShortcut");
  assert.equal(h.editor.text, "/skill:review-convergence review convergence", "stopping with the transcribe-only key appends the words");
});

for (const word of ["command", "skill"] as const)
  test(`/talk ${word} starts a recording and stops it in ${word} mode, like its key`, async () => {
    const h = await harness({ commands: LISTED });
    respond(h, word === "skill" ? "review convergence" : "opsx apply loop");
    await h.runTalk(word);
    await h.until(() => h.recorderChildren().length === 1);
    audio(h.recorderChildren()[0]!);
    h.advance(2000);
    await h.runTalk(word);
    await h.until(() => h.editor.text !== "");
    assert.equal(h.editor.text, word === "skill" ? "/skill:review-convergence" : "/opsx-apply-loop");
  });

test("a recording held at the time cap is delivered in the mode of the command key that releases it", async () => {
  const h = await harness({ config: baseConfig({ maxSeconds: 1 }), commands: LISTED });
  respond(h, "opsx apply loop with tests");
  audio(await startRecording(h), 40000);
  await h.until(() => mixed(h.talkStatuses).includes("limit reached"));
  await h.pressCommandShortcut();
  await h.until(() => h.editor.text !== "");
  assert.equal(h.editor.text, "/opsx-apply-loop with tests");
  assert.equal(h.submitted, 0);
});

test("an empty transcript in command mode changes nothing", async () => {
  const h = await harness({ commands: LISTED });
  h.editor.text = "Draft";
  await dictate(h, "", "pressCommandShortcut");
  assert.equal(h.editor.text, "Draft");
  assert.match(h.notices.at(-1)!.message, /Nothing was recognized/);
});

test("a command transcript that arrives after a session change is dropped", async () => {
  const h = await harness({ commands: LISTED });
  let release!: () => void;
  h.setFetch(
    () =>
      new Promise((resolve) => {
        release = () => resolve(json({ results: { channels: [{ alternatives: [{ transcript: "opsx apply loop" }] }] } }));
      }),
  );
  audio(await startRecording(h, "pressCommandShortcut"));
  h.advance(2000);
  await h.pressCommandShortcut();
  await h.until(() => h.fetchCalls.length === 1);
  sessionEvent(h);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.editor.text, "");
});

for (const [name, options, setup, warning] of [
  ["the configuration cannot be read at the stop", {}, async (h: Harness) => h.writeConfig({ input: { shortcut: "alt+x", transcribeShortcut: "alt+x" } }), /no command was matched: input\.shortcut/],
  ["Pi's command list cannot be read", { commandListFailure: true }, async () => undefined, /command list could not be read/],
] as const)
  test(`when ${name}, the words are appended with a warning and nothing runs`, async () => {
    const h = await harness({ commands: LISTED, ...options });
    respond(h, "opsx apply loop");
    audio(await startRecording(h, "pressCommandShortcut"));
    await setup(h);
    await stopAndSettle(h, "pressCommandShortcut");
    assert.equal(h.editor.text, "opsx apply loop");
    assert.match(h.notices.at(-1)!.message, warning);
    assert.equal(h.submitted, 0);
  });
