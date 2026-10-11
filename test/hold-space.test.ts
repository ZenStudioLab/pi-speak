import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HoldSpace, resetSpentHold, type HoldTarget } from "../hold-space.ts";
import type { HoldHandle, TalkContext } from "../talk-state.ts";
import { FakeClock } from "./hold-clock.ts";
import {
  audio,
  baseConfig,
  sessionEvent,
  useTalkHarness,
  type Harness,
} from "./talk-harness.ts";

const harness = useTalkHarness();
beforeEach(resetSpentHold);

const SPACE_RELEASE = "\x1b[32;1:3u";
const SEND_KEY_CSI_U = "\x1b[116;3u";

/** Sends input to the listeners and, like the editor, types a single printable character that nobody consumed. */
function typeKey(h: Harness, data: string): boolean {
  const consumed = h.sendKey(data);
  if (!consumed && data.length === 1 && data >= " ") h.editor.text += data;
  return consumed;
}

async function setup(options: { input?: Record<string, unknown>; editor?: string } = {}) {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock, config: baseConfig(options.input) });
  h.sessionStart();
  h.editor.text = options.editor ?? "Draft";
  return { h, clock };
}

const recordingNow = (h: Harness) => /^● Recording/.test(h.talkStatuses.at(-1) ?? "");

/** The press, the first repeat after 500 ms, and two repeats 30 ms apart; the fourth Space recognizes the hold. */
async function beginHold(h: Harness, clock: FakeClock) {
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    typeKey(h, " ");
  }
  await h.until(() => recordingNow(h));
  return h.recorderChildren().at(-1)!;
}

/** Spaces every 30 ms while the hold goes on. */
function keepHolding(h: Harness, clock: FakeClock, count = 3) {
  for (let i = 0; i < count; i++) {
    clock.advance(30);
    assert.equal(typeKey(h, " "), true, "a Space of an engaged hold is consumed");
  }
}

/** Lets go: no Space for 300 ms, after the recording has lasted past the 0.5 s minimum. */
function letGo(h: Harness, clock: FakeClock) {
  h.advance(2000);
  clock.advance(300);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a tap types a space and starts nothing", async () => {
  const { h, clock } = await setup();
  assert.equal(typeKey(h, " "), false);
  clock.advance(1000);
  assert.equal(typeKey(h, " "), false);
  assert.equal(h.editor.text, "Draft  ");
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(clock.pending, 0);
});

test("holding Space records from the fourth Space, removes the typed Spaces once the recorder runs, and letting go sends", async () => {
  const { h, clock } = await setup();
  const child = await beginHold(h, clock);
  assert.equal(h.editor.text, "Draft", "the three typed Spaces are gone once the recorder runs");
  assert.match(h.talkStatuses.at(-1)!, /release Space to send/);
  audio(child);
  keepHolding(h, clock);
  assert.equal(h.recorderChildren().length, 1);
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Draft xin chào"]);
  assert.equal(h.editor.text, "");
  assert.deepEqual(child.signals, ["SIGINT"]);
});

test("a recording started with a key does not mention Space in its status line", async () => {
  const { h } = await setup();
  await h.pressShortcut();
  await h.until(() => recordingNow(h));
  assert.doesNotMatch(h.talkStatuses.at(-1)!, /Space/);
});

test("at the time cap the held line of a hold-started recording says releasing Space sends, and letting go sends the held audio", async () => {
  const { h, clock } = await setup({ input: { maxSeconds: 1 } });
  const child = await beginHold(h, clock);
  audio(child, 40000);
  await h.until(() => (h.talkStatuses.at(-1) ?? "").includes("limit reached"));
  assert.match(h.talkStatuses.at(-1)!, /release Space to send/);
  keepHolding(h, clock);
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Draft xin chào"]);
});

test("a tap before the hold counts in the run of Spaces that is removed", async () => {
  const { h, clock } = await setup({ editor: "x" });
  typeKey(h, " ");
  clock.advance(1000);
  await beginHold(h, clock);
  assert.equal(h.editor.text, "x");
});

test("letting go while the recording is still starting cancels it and the typed Spaces stay", async () => {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock, config: baseConfig({ provider: "elevenlabs", stopOnPhrase: true }), holdSockets: true });
  h.sessionStart();
  h.editor.text = "Draft";
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    typeKey(h, " ");
  }
  await h.until(() => h.sockets.length === 1);
  clock.advance(300);
  assert.match(h.messages(), /Recording cancelled/);
  h.sockets[0]!.emit("open");
  await settle();
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.editor.text, "Draft   ");
  assert.equal(h.sent.length, 0);
});

test("a reported Space release ends the hold at once", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  h.advance(2000);
  assert.equal(h.sendKey(SPACE_RELEASE), false);
  await h.until(() => h.sent.length === 1);
  assert.equal(clock.pending, 0);
});

test("Escape during a hold discards the recording, later Spaces are consumed, and nothing starts or is sent", async () => {
  const { h, clock } = await setup();
  const child = await beginHold(h, clock);
  assert.equal(h.sendKey("\x1b"), true);
  assert.deepEqual(child.signals, ["SIGINT"]);
  keepHolding(h, clock, 6);
  letGo(h, clock);
  await settle();
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.talkStatuses.at(-1), undefined, "letting go did not touch the discarded recording");
});

test("a hold whose recording the stop phrase already sent does nothing more when Space is released", async () => {
  const { h, clock } = await setup({ input: { provider: "elevenlabs", stopOnPhrase: true } });
  const child = await beginHold(h, clock);
  audio(child);
  h.sockets[0]!.committed("hello, let's go");
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Draft hello"]);
  keepHolding(h, clock, 4);
  letGo(h, clock);
  await settle();
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.sent.length, 1);
});

test("a hold whose recording a key already stopped and transcribed does nothing more when Space is released", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  h.advance(2000);
  await h.pressTranscribeShortcut();
  await h.until(() => h.editor.text === "Draft xin chào");
  keepHolding(h, clock, 4);
  letGo(h, clock);
  await settle();
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft xin chào");
});

test("a refused start is reported once, the Spaces stay, later Spaces are consumed, and no further attempt is made", async () => {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock, config: baseConfig(), deepgramKey: null });
  h.sessionStart();
  h.editor.text = "Draft";
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    typeKey(h, " ");
  }
  await h.until(() => h.notices.length === 1);
  assert.match(h.messages(), /DEEPGRAM_API_KEY is not set/);
  keepHolding(h, clock, 5);
  letGo(h, clock);
  await settle();
  assert.equal(h.notices.length, 1);
  assert.equal(h.editor.text, "Draft   ");
  assert.equal(h.recorderChildren().length, 0);
});

for (const [state, begin] of [
  ["recording", async (h: Harness) => { await h.pressShortcut(); await h.until(() => recordingNow(h)); }],
  ["a recording attempt that is still starting", async (h: Harness) => { void h.pressShortcut(); await h.until(() => h.sockets.length === 1); }],
] as const)
  test(`a hold during ${state} begun with a key is busy: every Space types and that recording is unaffected`, async () => {
    const clock = new FakeClock();
    const h = await harness({ holdClock: clock, config: baseConfig({ provider: "elevenlabs", stopOnPhrase: state !== "recording" }), holdSockets: state !== "recording" });
    h.sessionStart();
    h.editor.text = "Draft";
    await begin(h);
    for (const gap of [0, 500, 30, 30, 30, 30]) {
      clock.advance(gap);
      assert.equal(typeKey(h, " "), false);
    }
    assert.equal(h.editor.text, "Draft      ");
    assert.equal(h.recorderChildren().length, state === "recording" ? 1 : 0);
    if (state === "recording") {
      h.advance(2000);
      await h.pressTranscribeShortcut();
      await h.until(() => h.talkStatuses.at(-1) === undefined);
    } else h.sockets[0]!.emit("open");
    typeKey(h, " ");
    clock.advance(30);
    typeKey(h, " ");
    letGo(h, clock);
    await settle();
    assert.equal(h.recorderChildren().length, 1, "the key-started recording is the only one: no recording starts when it ends");
    assert.equal(h.sent.length, 0);
  });

test("a stall where the release timer and queued Spaces are due together keeps the hold going", async () => {
  const { h, clock } = await setup();
  const child = await beginHold(h, clock);
  audio(child);
  h.advance(2000);
  clock.stall(700);
  assert.equal(clock.pending, 1, "the timer fired and its decision waits for pending input");
  for (let i = 0; i < 3; i++) assert.equal(typeKey(h, " "), true);
  clock.flush();
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  clock.advance(300);
  await h.until(() => h.sent.length === 1);
});

test("a Space within 300 ms of the last continues the same hold, and the release is still one send", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  clock.advance(250);
  assert.equal(typeKey(h, " "), true);
  keepHolding(h, clock, 2);
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
  assert.equal(h.recorderChildren().length, 1);
});

test("the release of an arrow key or of Escape, and the terminal's cell-size reply, are ignored during a hold", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  for (const ignored of ["\x1b[1;1:3A", "\x1b[27;1:3u", "\x1b[97;1:3u", "\x1b[6;18;9t"]) {
    assert.equal(h.sendKey(ignored), false, "the editor still sees them");
    clock.advance(30);
    typeKey(h, " ");
  }
  assert.equal(recordingNow(h), true);
  assert.equal(h.sent.length, 0);
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
});

test("the send key as an escape sequence during a hold sends once, and letting go adds nothing", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  h.advance(2000);
  assert.equal(h.sendKey(SEND_KEY_CSI_U), false, "the key passes through to its own handler");
  assert.equal(recordingNow(h), true, "it did not discard the recording");
  await h.pressShortcut();
  await h.until(() => h.sent.length === 1);
  keepHolding(h, clock, 3);
  letGo(h, clock);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(h.notices.length, 0, "no warning");
});

const OTHER_INPUT = [
  ["a letter", "x"],
  ["a Vietnamese letter", "ề"],
  ["a key that cannot be decoded", "\x1b[15;5~"],
  ["an arrow key", "\x1b[A"],
  ["bracketed paste", "\x1b[200~pasted\x1b[201~"],
  ["a paste that looks like a key release", "\x1b[200~a:3u b\x1b[201~"],
] as const;

for (const [name, data] of OTHER_INPUT)
  test(`${name} during a hold reaches the editor and discards the recording, and the release sends nothing`, async () => {
    const { h, clock } = await setup();
    const child = await beginHold(h, clock);
    audio(child);
    h.advance(2000);
    assert.equal(typeKey(h, data), false);
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.match(h.messages(), /Recording discarded/);
    keepHolding(h, clock, 4);
    letGo(h, clock);
    await settle();
    assert.equal(h.sent.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.recorderChildren().length, 1);
    if (data === "x") assert.equal(h.editor.text, "Draftx");
  });

test("other input during a hold with the stop phrase on discards the recording and sends no message, though streamed audio is not recalled", async () => {
  const { h, clock } = await setup({ input: { provider: "elevenlabs", stopOnPhrase: true } });
  audio(await beginHold(h, clock));
  assert.ok(h.sockets[0]!.chunks().length > 0, "audio already streamed");
  h.advance(2000);
  typeKey(h, "x");
  assert.equal(h.sockets[0]!.closes.length, 1);
  letGo(h, clock);
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

test("other input while the hold's recording is starting cancels the attempt", async () => {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock, config: baseConfig({ provider: "elevenlabs", stopOnPhrase: true }), holdSockets: true });
  h.sessionStart();
  h.editor.text = "Draft";
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    typeKey(h, " ");
  }
  await h.until(() => h.sockets.length === 1);
  typeKey(h, "x");
  h.sockets[0]!.emit("open");
  letGo(h, clock);
  await settle();
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.editor.text, "Draft   x");
});

test("other input while the hold's recording is held at the time cap discards it", async () => {
  const { h, clock } = await setup({ input: { maxSeconds: 1 } });
  audio(await beginHold(h, clock), 40000);
  await h.until(() => (h.talkStatuses.at(-1) ?? "").includes("limit reached"));
  typeKey(h, "x");
  letGo(h, clock);
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

test("with the cursor inside the text the typed Spaces stay and are sent with the draft", async () => {
  const { h, clock } = await setup();
  for (const gap of [0, 500, 30]) {
    clock.advance(gap);
    typeKey(h, " ");
  }
  h.editor.text = "Dra   ft";
  clock.advance(30);
  typeKey(h, " ");
  await h.until(() => recordingNow(h));
  audio(h.recorderChildren()[0]!);
  assert.equal(h.editor.text, "Dra   ft");
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
  assert.deepEqual(h.sent.map((m) => m.text), ["Dra   ft xin chào"]);
});

for (const [gap, recognized] of [[100, true], [150, false]] as const)
  test(`Spaces ${gap} ms apart ${recognized ? "are key repeats and recognize a hold at the third" : "are not key repeats, so every Space types"}`, async () => {
    const { h, clock } = await setup();
    for (let i = 0; i < 5; i++) {
      clock.advance(gap);
      typeKey(h, " ");
      if (recognized && i === 2) break;
    }
    if (recognized) await h.until(() => recordingNow(h));
    else {
      await settle();
      assert.equal(h.recorderChildren().length, 0);
      assert.equal(h.editor.text, "Draft     ");
    }
  });

test("after a hold ends, the next hold is recognized again", async () => {
  const { h, clock } = await setup();
  audio(await beginHold(h, clock));
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
  clock.advance(1000);
  await beginHold(h, clock);
  assert.equal(h.recorderChildren().length, 2);
});

test("a session change during a hold discards the recording and clears the timers; repeats stay consumed, and the first input after the quiet gap types", async () => {
  const { h, clock } = await setup();
  const child = await beginHold(h, clock);
  sessionEvent(h);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(clock.pending, 0);
  h.sessionStart();
  keepHolding(h, clock, 5);
  assert.equal(h.recorderChildren().length, 1, "the later repeats start nothing");
  // The repeats re-armed the timer; a second session change clears it again.
  sessionEvent(h);
  assert.equal(clock.pending, 0);
  h.sessionStart();
  clock.time += 400;
  assert.equal(typeKey(h, " "), false, "more than 300 ms after the last Space, the input is handled normally");
  assert.equal(h.sent.length, 0);
  assert.equal(h.recorderChildren().length, 1);
});

test("a hold spent before Pi runs the extension factory again stays spent for the new detector, which starts nothing and ends it by arrival time", () => {
  const clock = new FakeClock();
  const handle = {} as HoldHandle;
  const runtime = () => {
    const calls = { started: 0, ended: [] as [HoldHandle, string][] };
    const target: HoldTarget = {
      startHold: () => (calls.started++, handle),
      endHold: (hold, outcome) => void calls.ended.push([hold, outcome]),
    };
    let listener: (data: string) => { consume: true } | undefined = () => undefined;
    const ctx = {
      mode: "tui",
      ui: { onTerminalInput: (fn: typeof listener) => ((listener = fn), () => undefined), getEditorText: () => "", setEditorText: () => undefined },
    } as unknown as TalkContext;
    const detector = new HoldSpace(target, [], clock);
    detector.attach(ctx);
    return { calls, detector, input: (data: string) => listener(data) };
  };
  const before = runtime();
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    before.input(" ");
  }
  assert.equal(before.calls.started, 1);
  before.detector.reset();
  const after = runtime();
  for (let i = 0; i < 4; i++) {
    clock.advance(30);
    assert.deepEqual(after.input(" "), { consume: true }, "a repeat of the earlier hold is consumed");
  }
  assert.equal(after.calls.started, 0, "the new detector recognizes no hold from those repeats");
  after.detector.reset();
  clock.time += 400;
  assert.equal(after.input(" "), undefined, "the first input after the quiet gap is handled normally");
  assert.equal(after.calls.started, 0);
  assert.deepEqual(after.calls.ended, [[handle, "send"]], "the earlier hold ends once, through the new detector");
});

test("tree navigation clears the hold's timers and recording but keeps the listener, so the next hold is recognized", async () => {
  const { h, clock } = await setup();
  await beginHold(h, clock);
  sessionEvent(h, "session_tree");
  assert.equal(clock.pending, 0);
  h.advance(2000);
  clock.advance(1000);
  audio(await beginHold(h, clock));
  assert.equal(h.recorderChildren().length, 2);
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
});

test("a session replacement subscribes again, and the earlier listener does nothing", async () => {
  const { h, clock } = await setup();
  sessionEvent(h);
  h.sessionStart();
  clock.advance(1000);
  audio(await beginHold(h, clock));
  assert.equal(h.recorderChildren().length, 1, "one hold starts one recording, not one per listener");
  letGo(h, clock);
  await h.until(() => h.sent.length === 1);
});

test("nothing touches the context after shutdown, even when a timer and queued Spaces were due", async () => {
  const clock = new FakeClock();
  const h = await harness({ holdClock: clock, config: baseConfig() });
  const touched: string[] = [];
  const ctx = h.talkContext();
  h.events.get("session_start")!(undefined, new Proxy(ctx, { get: (target, key, receiver) => (touched.push(String(key)), Reflect.get(target, key, receiver)) }));
  await beginHold(h, clock);
  clock.stall(700);
  sessionEvent(h, "session_shutdown");
  touched.length = 0;
  clock.flush();
  clock.advance(1000);
  for (let i = 0; i < 4; i++) {
    clock.advance(30);
    h.sendKey(" ");
  }
  clock.advance(1000);
  for (const gap of [0, 500, 30, 30]) {
    clock.advance(gap);
    assert.equal(h.sendKey(" "), false, "a new hold is not recognized without a session");
  }
  await settle();
  assert.deepEqual(touched, []);
  assert.equal(h.sent.length, 0);
  assert.equal(h.recorderChildren().length, 1);
});

test("with the setting off, no listener exists and every Space reaches the editor", async () => {
  const h = await harness();
  assert.equal(h.events.has("session_start"), false);
  for (let i = 0; i < 6; i++) assert.equal(typeKey(h, " "), false);
  assert.equal(h.keyListeners.size, 0);
  assert.equal(h.recorderChildren().length, 0);
});
