import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnFn } from "../audio.ts";
import { pushToTalkKeys, type Shortcuts } from "../config.ts";
import { HoldSpace, type HoldClock } from "../hold-space.ts";
import { registerSpeak } from "../index.ts";
import { LiveSession } from "../live.ts";
import type { RealtimeSocket } from "../realtime.ts";
import { SpeakAloudSwitch } from "../speak-aloud.ts";
import { SpeechController } from "../speech-job.ts";
import { TalkController, type SendMessage } from "../talk.ts";
import type { TranslationRegistry } from "../translation.ts";
import type { TranslationFailureRecord } from "../translation-failure.ts";
import { createFakePi } from "./fake-pi.ts";

export const API_KEY = "test-secret-key-123";
export const VALID_CONFIG = {
  providers: {
    elevenlabs: {
      voiceId: "AbCdEf1234567890",
      modelId: "eleven_flash_v2_5",
    },
  },
  player: { command: "fakeplayer", args: ["--play", "{file}"] },
};

export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: (NodeJS.Signals | number | undefined)[] = [];
  autoExitOnKill = true;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.autoExitOnKill)
      queueMicrotask(() => {
        this.emit("exit", null, signal ?? "SIGTERM");
        this.emit("close", null, signal ?? "SIGTERM");
      });
    return true;
  }
  /** Ends the process as Node does: `exit` first, then `close` once the output has closed. */
  finish(code: number): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
  /** Delivers recorded PCM as the recorder's stdout. */
  emitAudio(bytes: Uint8Array): void {
    this.stdout.emit("data", Buffer.from(bytes));
  }
}

/** A live transcription socket that does only what a test tells it to; nothing is networked. */
export class FakeSocket {
  sent: string[] = [];
  closes: (number | undefined)[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  readonly url: string;
  readonly init: { headers: Record<string, string> };
  constructor(url: string, init: { headers: Record<string, string> }) {
    this.url = url;
    this.init = init;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closes.push(code);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  /** Delivers a server message; an object is sent as JSON. */
  message(body: unknown): void {
    this.emit("message", typeof body === "string" ? body : JSON.stringify(body));
  }
  committed(text: string): void {
    this.message({ message_type: "committed_transcript", text });
  }
  /** The client's messages, parsed. */
  chunks(): { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number }[] {
    return this.sent.map((data) => JSON.parse(data));
  }
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export const audioResponse = (): Response =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface CtxOptions {
  mode?: string;
  idle?: boolean;
  pending?: boolean;
  messages?: unknown[];
  cwd?: string;
  sessionManager?: Pick<
    ExtensionCommandContext["sessionManager"],
    "getHeader" | "getBranch"
  >;
  registry?: TranslationRegistry;
  /** Leaves `ctx.model` undefined, as when no model is selected. */
  noModel?: boolean;
  /** Read at each call, so a test can change the agent's state while the context is in use; wins over `idle`. */
  isIdle?: () => boolean;
}

export async function createHarness(
  options: {
    config?: unknown;
    apiKey?: string | null;
    deepgramKey?: string | null;
    /** Recording tools to install on the fake PATH, such as `["rec"]`. */
    recorders?: string[];
    readFile?: (path: string) => Promise<string>;
    entryFailure?: boolean;
    widgetFailure?: boolean;
    entrySink?: (customType: string, data: TranslationFailureRecord) => void;
    /**
     * Makes the fake `pi.sendUserMessage` fail as the host does: it returns normally and the failure
     * is only reported later, to `hostErrors`.
     */
    sendFailure?: string;
    /** Makes the fake `pi.sendUserMessage` throw this message synchronously. */
    sendThrows?: string;
    /** The keys registered at load; each mode not given has its built-in default. */
    shortcuts?: Partial<Shortcuts>;
    /** The commands, prompt templates and skills `pi.getCommands()` lists. */
    commands?: { name: string; source: string }[];
    /** Makes `pi.getCommands()` throw. */
    commandListFailure?: boolean;
    /** Subscribes a Space-hold detector with this clock on each `session_start`, as `input.holdSpace` does. */
    holdClock?: HoldClock;
    /** Leaves each live transcription socket unopened until the test calls `open`. */
    holdSockets?: boolean;
    /** The time and timers of live mode's idle limit and mute tail; the system clock when omitted. */
    liveClock?: Pick<HoldClock, "now" | "setTimer">;
    /** The tools that are active before the extension registers anything. */
    activeTools?: string[];
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "speak-harness-"));
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "fakeplayer"), "#!/bin/sh\n");
  await chmod(join(dir, "bin", "fakeplayer"), 0o755);
  for (const tool of options.recorders ?? []) {
    await writeFile(join(dir, "bin", tool), "#!/bin/sh\n");
    await chmod(join(dir, "bin", tool), 0o755);
  }
  const env: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    PATH: join(dir, "bin"),
    UNRELATED: "kept",
  };
  if (options.apiKey !== null)
    env.ELEVENLABS_API_KEY = options.apiKey ?? API_KEY;
  if (options.deepgramKey !== undefined && options.deepgramKey !== null)
    env.DEEPGRAM_API_KEY = options.deepgramKey;
  if (options.config !== null) {
    await mkdir(join(dir, "config", "pi-speak"), { recursive: true });
    await writeFile(
      join(dir, "config", "pi-speak", "config.json"),
      JSON.stringify(options.config ?? VALID_CONFIG),
    );
  }

  const fetchCalls: FetchCall[] = [];
  let behavior: (call: FetchCall) => Promise<Response> = async () =>
    audioResponse();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    fetchCalls.push(call);
    return behavior(call);
  }) as typeof fetch;

  const children: FakeChild[] = [];
  const spawnCalls: {
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }[] = [];
  // SAFETY: Only the members startPlayer uses (stderr, once, kill) exist on the fake child.
  const spawnFn = ((
    command: string,
    args: readonly string[],
    spawnOptions: Record<string, unknown>,
  ) => {
    const child = new FakeChild();
    children.push(child);
    spawnCalls.push({ command, args: [...args], options: spawnOptions });
    return child;
  }) as unknown as SpawnFn;

  const sockets: FakeSocket[] = [];
  const webSocketFn = (url: string, init: { headers: Record<string, string> }) => {
    const socket = new FakeSocket(url, init);
    sockets.push(socket);
    if (!options.holdSockets) queueMicrotask(() => socket.emit("open"));
    return socket as unknown as RealtimeSocket;
  };
  const deps = {
    env,
    fetchFn,
    spawnFn,
    webSocketFn,
    now: Date.now,
    readFile: options.readFile ?? ((path: string) => readFile(path, "utf8")),
  };
  const registered: Shortcuts = {
    send: ["alt+t"],
    transcribe: ["alt+shift+t"],
    command: ["alt+m"],
    skill: ["alt+i"],
    holdSpace: options.holdClock !== undefined,
    ...options.shortcuts,
  };
  const controller = new SpeechController(deps, registered);
  // A manual clock keeps the 0.5 s minimum and the elapsed time exact.
  let clock = 1_000_000;
  const editor = { text: "" };
  /** Messages passed to `pi.sendUserMessage`, with the composer text seen at the moment of the call. */
  const sent: { text: string; options: unknown; composerAtCall: string }[] = [];
  /** Failures the host reports after `pi.sendUserMessage` has already returned (`runner.emitError`). */
  const hostErrors: string[] = [];
  /** What `pi.getCommands()` lists. */
  const listed: { name: string; source: string }[] = [...(options.commands ?? [])];
  const sendMessage: SendMessage = (text, sendOptions) => {
    if (sendOptions.expandPromptTemplates !== false) throw new Error("templates must not be expanded");
    sent.push({ text, options: sendOptions, composerAtCall: editor.text });
    if (options.sendThrows) throw new Error(options.sendThrows);
    if (options.sendFailure) hostErrors.push(options.sendFailure);
  };
  const host = createFakePi(options);
  // `talk` is built after `live` and consulted only when `/talk live` runs.
  const live = new LiveSession(
    deps,
    controller,
    sendMessage,
    registered,
    (): string | undefined => talk.liveBlock(),
    new SpeakAloudSwitch(host.api),
    options.liveClock,
  );
  const talk = new TalkController(
    { ...deps, now: () => clock },
    controller,
    sendMessage,
    registered,
    () => {
      if (options.commandListFailure) throw new Error("command list unavailable");
      return listed;
    },
    live,
  );
  const { commands, shortcuts, events, entries } = host;
  const hold = options.holdClock && new HoldSpace(talk, pushToTalkKeys(registered), options.holdClock);
  registerSpeak(host.api, controller, talk, live, registered, hold);

  const notices: { message: string; level?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const talkStatuses: (string | undefined)[] = [];
  const liveStatuses: (string | undefined)[] = [];
  const keyListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const widgets: { key: string; content: string[] | undefined }[] = [];
  let aborts = 0;
  const statusSink = (key: string) =>
    key === "speak-talk" ? talkStatuses : key === "speak-live" ? liveStatuses : statuses;

  async function run(args: string, ctxOptions: CtxOptions = {}) {
    const cwd = ctxOptions.cwd ?? dir;
    let sessionManager = ctxOptions.sessionManager;
    if (!sessionManager) {
      const session = SessionManager.inMemory(cwd);
      for (const message of ctxOptions.messages ?? [])
        session.appendMessage(message as never);
      sessionManager = session;
    }
    // SAFETY: The router uses this UI, registry, cwd, idle/pending flags and the real session boundary.
    const ctx = {
      mode: ctxOptions.mode ?? "tui",
      cwd,
      modelRegistry: ctxOptions.registry,
      ui: {
        notify: (message: string, level?: string) =>
          notices.push({ message, level }),
        setStatus: (key: string, text: string | undefined) => statusSink(key).push(text),
        setWidget: (key: string, content: string[] | undefined) => {
          if (options.widgetFailure) throw new Error("widget unavailable");
          widgets.push({ key, content });
        },
      },
      isIdle: () => ctxOptions.isIdle?.() ?? ctxOptions.idle ?? true,
      hasPendingMessages: () => ctxOptions.pending ?? false,
      sessionManager,
      abort: () => aborts++,
    } as unknown as ExtensionCommandContext;
    await commands.get("speak")!(args, ctx);
  }

  function talkContext(ctxOptions: CtxOptions = {}) {
    const cwd = ctxOptions.cwd ?? dir;
    // SAFETY: /talk and the shortcut use only the mode, the UI, and the editor and key hooks below.
    return {
      mode: ctxOptions.mode ?? "tui",
      cwd,
      model: ctxOptions.noModel ? undefined : { id: "test-model" },
      modelRegistry: ctxOptions.registry,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        setStatus: (key: string, text: string | undefined) => statusSink(key).push(text),
        setWidget: () => undefined,
        getEditorText: () => editor.text,
        setEditorText: (text: string) => {
          editor.text = text;
        },
        onTerminalInput: (listener: (data: string) => { consume?: boolean } | undefined) => {
          keyListeners.add(listener);
          return () => keyListeners.delete(listener);
        },
      },
      isIdle: () => ctxOptions.isIdle?.() ?? ctxOptions.idle ?? true,
      hasPendingMessages: () => false,
      sessionManager: SessionManager.inMemory(cwd),
      abort: () => aborts++,
    } as unknown as ExtensionCommandContext;
  }

  async function runTalk(args: string, ctxOptions: CtxOptions = {}) {
    await commands.get("talk")!(args, talkContext(ctxOptions));
  }

  /** Presses the first registered send shortcut (`alt+t` unless `shortcuts` was given). */
  async function pressShortcut(ctxOptions: CtxOptions = {}) {
    await shortcuts.get(registered.send[0]!)!(talkContext(ctxOptions));
  }

  /** Presses the first registered transcribe-only shortcut (`alt+shift+t` unless `shortcuts` was given). */
  async function pressTranscribeShortcut(ctxOptions: CtxOptions = {}) {
    await shortcuts.get(registered.transcribe[0]!)!(talkContext(ctxOptions));
  }

  /** Presses the first registered command key (`alt+m` unless `shortcuts` was given). */
  async function pressCommandShortcut(ctxOptions: CtxOptions = {}) {
    await shortcuts.get(registered.command[0]!)!(talkContext(ctxOptions));
  }

  /** Presses the first registered skill key (`alt+i` unless `shortcuts` was given). */
  async function pressSkillShortcut(ctxOptions: CtxOptions = {}) {
    await shortcuts.get(registered.skill[0]!)!(talkContext(ctxOptions));
  }

  /** Presses one registered key by name, whichever mode it belongs to. */
  async function pressKey(key: string, ctxOptions: CtxOptions = {}) {
    await shortcuts.get(key)!(talkContext(ctxOptions));
  }

  /** Sends a key to the terminal-input listeners; true when one consumed it (the editor never sees it). */
  function sendKey(data: string): boolean {
    let consumed = false;
    for (const listener of [...keyListeners])
      if (listener(data)?.consume) consumed = true;
    return consumed;
  }

  return {
    dir,
    env,
    talkContext,
    /** Fires `session_start` for a new context, which subscribes the Space-hold listener. */
    sessionStart: (ctxOptions: CtxOptions = {}) => events.get("session_start")!(undefined, talkContext(ctxOptions)),
    controller,
    fetchCalls,
    sockets,
    children,
    spawnCalls,
    notices,
    statuses,
    widgets,
    events,
    entries,
    /** The fake Pi host: registered tools, the active tool set, and the `setActiveTools` calls. */
    host,
    run,
    runTalk,
    pressShortcut,
    pressTranscribeShortcut,
    pressCommandShortcut,
    pressSkillShortcut,
    pressKey,
    sendKey,
    sent,
    hostErrors,
    talkStatuses,
    liveStatuses,
    editor,
    keyListeners,
    shortcuts,
    get submitted() {
      return host.submitted + sent.length;
    },
    advance(ms: number) {
      clock += ms;
    },
    /** The recorder processes started so far, in order. */
    recorderChildren: () =>
      children.filter((_, i) => /\/(rec|arecord|ffmpeg)$/.test(spawnCalls[i]!.command)),
    get aborts() {
      return aborts;
    },
    async writeConfig(config: unknown) {
      await writeFile(
        join(dir, "config", "pi-speak", "config.json"),
        JSON.stringify(config),
      );
    },
    setFetch(next: (call: FetchCall) => Promise<Response>) {
      behavior = next;
    },
    /** Waits (polling real I/O) until the condition holds; fails the test after the timeout. */
    async until(condition: () => boolean, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline)
          throw new Error("condition not reached before the timeout");
        await tick();
      }
    },
    async cacheFiles() {
      return readdir(join(dir, "cache", "pi-speak")).catch(
        () => [] as string[],
      );
    },
    messages: () => notices.map((notice) => notice.message).join("\n"),
    async cleanup() {
      live.resetSession();
      talk.resetSession();
      controller.resetSession();
      await controller.whenIdle();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const answer = (text: string) => [
  { role: "user", content: "question", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
  },
];
