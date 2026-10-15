import { resolveExecutable } from "./audio.ts";
import { API_KEY_ENV, formatKeys, loadConfig, readProviderApiKey, type Shortcuts } from "./config.ts";
import { redact } from "./elevenlabs.ts";
import { systemClock, type HoldClock } from "./hold-space.ts";
import { LiveSpeech } from "./live-speech.ts";
import { matchesLiveStopPhrase, nodeWebSocket, openRealtime, type RealtimeSession } from "./realtime.ts";
import { RECORDER_TOOLS, findRecorder, startRecorder, type RecorderExit, type RecorderHandle } from "./record.ts";
import type { SpeakAloudSwitch } from "./speak-aloud.ts";
import type { SpeakDeps, SpeechController } from "./speech-job.ts";
import { effectiveHardLimit } from "./speech-preflight.ts";
import { TranscriptDelivery } from "./talk-delivery.ts";
import type { SendMessage, TalkContext, TalkMode, TalkUi } from "./talk-state.ts";
import { checkLength } from "./text.ts";

const STATUS_KEY = "speak-live";
/** How often the idle limit is checked; the limit is in minutes, so a coarse timer is enough (D9). */
const IDLE_CHECK_MS = 15_000;
const HAS_WORDS = /[\p{L}\p{N}]/u;

export type LivePhase = "off" | "starting" | "on";

/** The attempt to start live mode, from `/talk live` until the microphone is open. */
interface Starting {
  phase: "starting";
  ui: TalkUi;
  /** Aborted when the start is cancelled or the session is replaced, which ends a pending connection. */
  cancel: AbortController;
}

/** The live session: one connection and one streaming recorder, open until live mode ends. */
interface On {
  phase: "on";
  ui: TalkUi;
  /** The idle state and model of the context that started live mode, read again for each turn. */
  context: Pick<TalkContext, "isIdle" | "model">;
  session: RealtimeSession;
  recorder: RecorderHandle;
  /** Pi's spoken updates: the queue, and whether the microphone is muted. */
  updates: LiveSpeech;
  /** The most characters one update may have, fixed when live mode starts. */
  speechLimit: number;
  /** How much of `session.text` has already become turns. */
  delivered: number;
  /** Turns are sent one after the other, in the order they were committed. */
  sending: Promise<void>;
  /** The live stop phrases, read when live mode started. */
  stopPhrases: string[];
  idleLimitMs: number;
  /** When the current stretch of agent idleness began; undefined while the agent works. */
  idleSince: number | undefined;
  stopIdleTimer: () => void;
}

/**
 * Owns live mode: it starts only when the user runs `/talk live` and never again after it ends. Every
 * continuation re-checks that its attempt is still the current one, so a cancelled or ended session can
 * never send a turn or reopen the microphone. Nothing here retries or reconnects.
 */
export class LiveSession {
  private readonly deps: Pick<SpeakDeps, "env" | "readFile" | "home" | "spawnFn" | "webSocketFn">;
  private readonly speech: SpeechController;
  private readonly sendMessage: SendMessage;
  private readonly delivery: TranscriptDelivery;
  private readonly shortcuts: Shortcuts;
  private readonly recordingBlock: () => string | undefined;
  private readonly tools: Pick<SpeakAloudSwitch, "add" | "remove">;
  private readonly clock: Pick<HoldClock, "now" | "setTimer">;
  private state: Starting | On | undefined;

  constructor(
    deps: Pick<SpeakDeps, "env" | "readFile" | "home" | "spawnFn" | "webSocketFn">,
    speech: SpeechController,
    sendMessage: SendMessage,
    shortcuts: Shortcuts,
    /** Why a push-to-talk recording or transcription forbids live mode right now, or undefined. */
    recordingBlock: () => string | undefined,
    /** Declares `speak_aloud` to the model only while live mode is on. */
    tools: Pick<SpeakAloudSwitch, "add" | "remove">,
    clock: Pick<HoldClock, "now" | "setTimer"> = systemClock,
  ) {
    this.deps = deps;
    this.speech = speech;
    this.sendMessage = sendMessage;
    // Only `append` and `compacting` are used; a live turn never reads the composer or lists commands.
    this.delivery = new TranscriptDelivery(deps, sendMessage, () => [], (message) => this.redactKey(message));
    this.shortcuts = shortcuts;
    this.recordingBlock = recordingBlock;
    this.tools = tools;
    this.clock = clock;
  }

  get phase(): LivePhase {
    return this.state?.phase ?? "off";
  }

  /** `/talk live`: ends live mode, cancels a start in progress, or starts it. */
  async toggle(ctx: TalkContext): Promise<void> {
    const ui = ctx.ui;
    if (ctx.mode !== "tui") {
      ui.notify("Live mode works only in the interactive terminal, so nothing was started.", "warning");
      return;
    }
    if (this.state?.phase === "starting") return this.end("Live mode start cancelled. Nothing was recorded.");
    if (this.state) return this.end("Live mode ended. The microphone is closed.");
    const blocked = this.recordingBlock();
    if (blocked) {
      ui.notify(blocked, "warning");
      return;
    }
    await this.start(ctx);
  }

  /** A push-to-talk key or `/talk` form while live mode is on or starting; only the send key, not `/talk send`, cuts Pi off. */
  press(ui: TalkUi, mode: TalkMode, fromShortcut: boolean): void {
    const state = this.state;
    if (mode === "send" && fromShortcut && state?.phase === "on") {
      if (!state.updates.cutOff()) ui.notify("Nothing is being spoken.", "info");
      return;
    }
    ui.notify(
      `Live mode is ${this.state?.phase === "on" ? "on" : "starting"}. Run /talk live to end live mode; push-to-talk is unavailable meanwhile.`,
      "warning",
    );
  }

  /** Why `/speak` must not speak now, or undefined; the message names how to end live mode. */
  speechBlock(): string | undefined {
    return this.state
      ? "/speak is unavailable during live mode. Run /talk live to end live mode first."
      : undefined;
  }

  /**
   * The `speak_aloud` tool: queues Pi's text behind the updates already waiting and says why it will not be
   * spoken. It never waits for synthesis or playback. Whether the text fits is decided against the limit read
   * when live mode started; the speech job checks the limit again when the update starts.
   */
  speakAloud(text: string): string {
    const on = this.state;
    if (on?.phase !== "on") return "Nothing will be spoken: live mode is off.";
    if (text.trim() === "") return "Nothing will be spoken: the text is empty.";
    const length = checkLength(text, on.speechLimit);
    if (!length.ok)
      return `Nothing will be spoken: the text is ${length.length} characters and the speech limit is ${length.limit}. Shorten it and call again.`;
    // Speaking is activity, so a short update between two idle checks still restarts the idle clock.
    on.idleSince = this.clock.now();
    on.updates.enqueue(text);
    return "Queued: the update will be spoken in order.";
  }

  /** `/speak stop` while live mode is on also drops the updates that have not started. */
  dropWaitingUpdates(): void {
    if (this.state?.phase === "on") this.state.updates.dropWaiting();
  }

  /** An agent run is starting: a host that restored or activated `speak_aloud` must not declare it outside live mode. */
  removeToolOutsideLive(): void {
    if (this.state?.phase !== "on") this.tools.remove();
  }

  /** Pi refuses a prompt while it compacts the conversation, so a turn must not be sent then. */
  setCompacting(compacting: boolean): void {
    this.delivery.compacting = compacting;
  }

  /** Lifecycle cleanup (session replacement, fork, tree navigation, reload, shutdown): ends live mode silently. */
  resetSession(): void {
    this.end();
  }

  /** The checks, then the connection, then the recorder; every await re-checks that this attempt is current. */
  private async start(ctx: TalkContext): Promise<void> {
    const ui = ctx.ui;
    const claim: Starting = { phase: "starting", ui, cancel: new AbortController() };
    this.state = claim;
    const refuse = (message: string) => {
      // A cancelled or replaced attempt ends silently.
      if (this.state !== claim) return;
      this.state = undefined;
      ui.notify(`${message} Live mode was not started.`, "warning");
    };
    const loaded = await loadConfig(this.deps.env, this.deps.readFile, this.deps.home);
    if (this.state !== claim) return;
    if (!loaded.ok) return refuse(`Live mode is not configured: ${loaded.problem}.`);
    const { input, providers, player, requestTimeoutMs } = loaded.config;
    const apiKey = readProviderApiKey(this.deps.env, "elevenlabs");
    if (!apiKey) return refuse(`${API_KEY_ENV} is not set.`);
    if (!providers.elevenlabs.voiceId || !providers.elevenlabs.modelId)
      return refuse("Live mode speaks with ElevenLabs: set providers.elevenlabs.voiceId and providers.elevenlabs.modelId.");
    if (!(await findRecorder(this.deps.env)))
      return refuse(`No recording tool was found (looked for ${RECORDER_TOOLS.join(", ")}).`);
    if (this.state !== claim) return;
    if (!(await resolveExecutable(player.command, this.deps.env)))
      return refuse(`The audio player "${player.command}" was not found. Install it or set player.command.`);
    if (this.state !== claim) return;

    // The microphone must not hear this extension's own speech.
    await this.speech.stopOwnAudio();
    if (this.state !== claim) return;
    const opened = await openRealtime({
      apiKey,
      language: input.language,
      timeoutMs: requestTimeoutMs,
      signal: claim.cancel.signal,
      webSocketFn: this.deps.webSocketFn ?? nodeWebSocket,
    });
    if (this.state !== claim) {
      if (opened.ok) opened.session.close();
      return;
    }
    if (!opened.ok) return refuse(this.redactKey(opened.failure.message));
    const session = opened.session;
    const updates = new LiveSpeech(this.speech, ui, this.clock, () => this.render());
    // The recorder starts only once the connection is open, so no audio is lost while waiting for it.
    // While Pi speaks, the same amount of silence takes the place of the microphone (D6), unless barge-in is on.
    const started = await startRecorder({
      retain: false,
      env: this.deps.env,
      spawnFn: this.deps.spawnFn,
      onChunk: (chunk) =>
        session.sendAudio(!input.liveListenWhileSpeaking && updates.muted ? Buffer.alloc(chunk.length) : chunk),
    });
    if (this.state !== claim) {
      if (started.ok) started.handle.stop();
      session.close();
      return;
    }
    if (!started.ok) {
      session.close();
      return refuse(`No recording tool was found (looked for ${started.tried.join(", ")}).`);
    }

    const on: On = {
      phase: "on",
      ui,
      context: ctx,
      session,
      recorder: started.handle,
      updates,
      speechLimit: effectiveHardLimit(loaded.config, "elevenlabs"),
      delivered: 0,
      sending: Promise.resolve(),
      stopPhrases: input.liveStopPhrases,
      idleLimitMs: input.liveIdleMinutes * 60_000,
      idleSince: this.clock.now(),
      stopIdleTimer: () => undefined,
    };
    this.state = on;
    session.listen({
      onCommitted: () => this.onCommitted(on),
      onFailure: (failure) => this.fail(on, `${this.redactKey(failure.message)} Live mode ended.`),
      // Any partial transcript while Pi speaks is the user's voice (barge-in); with muting on none can arrive.
      onPartial: input.liveListenWhileSpeaking ? () => this.cutOffByVoice(on) : undefined,
    });
    // A failure that arrived while the recorder was starting is reported by `listen` at once and has ended live mode.
    if (this.state !== on) return;
    void on.recorder.done.then((exit) => this.onRecorderExit(on, exit));
    this.scheduleIdleCheck(on);
    this.tools.add();
    this.render();
    ui.notify(
      `Live mode is on. It uses ElevenLabs to listen and to speak, and the microphone streams to ElevenLabs until you end it. The spoken language is ${input.language ? `fixed to ${input.language}` : "detected for each turn"}. ${formatKeys(this.shortcuts.send)} cuts Pi off; /talk live ends live mode.`,
      "info",
    );
  }

  private cutOffByVoice(on: On): void {
    if (this.state === on) on.updates.cutOff();
  }

  /**
   * A committed segment is one turn: only its new words count. A turn that is a live stop phrase is never sent
   * and ends live mode behind the turns still waiting; text with no letter or digit is dropped.
   */
  private onCommitted(on: On): void {
    if (this.state !== on) return;
    const text = on.session.text;
    const turn = text.slice(on.delivered).trim();
    on.delivered = text.length;
    if (matchesLiveStopPhrase(turn, on.stopPhrases)) {
      // Behind the turns already waiting; the turns after it find live mode ended and are dropped.
      on.sending = on.sending.then(() => {
        if (this.state === on) this.end("Live mode ended because you said the stop phrase. The microphone is closed.");
      });
      return;
    }
    if (!HAS_WORDS.test(turn)) return;
    on.sending = on.sending.then(() => this.send(on, turn));
  }

  /**
   * Sends one turn as plain text without touching the composer. `sendWhenBusy` is read now. Pi reports a
   * refusal of `pi.sendUserMessage` only later, so the refusals visible beforehand (no model, compaction)
   * and a failing call add the turn to the composer instead; live mode stays on.
   */
  private async send(on: On, turn: string): Promise<void> {
    const loaded = await loadConfig(this.deps.env, this.deps.readFile, this.deps.home);
    if (this.state !== on) return;
    on.idleSince = this.clock.now();
    if (!loaded.ok) return this.keepInComposer(on, turn, `the configuration has an error (${loaded.problem})`);
    if (!on.context.model) return this.keepInComposer(on, turn, "no model is selected");
    if (this.delivery.compacting) return this.keepInComposer(on, turn, "Pi is compacting the conversation");
    try {
      const deliverAs = loaded.config.input.sendWhenBusy === "wait" ? "followUp" : "steer";
      this.sendMessage(
        turn,
        on.context.isIdle() ? { expandPromptTemplates: false } : { deliverAs, expandPromptTemplates: false },
      );
    } catch (error) {
      this.keepInComposer(on, turn, this.redactKey(error instanceof Error ? error.message : String(error)));
    }
  }

  private keepInComposer(on: On, turn: string, reason: string): void {
    this.delivery.append(on.ui, turn);
    on.ui.notify(`A spoken turn was not sent: ${reason}. It was added to the composer.`, "warning");
  }

  private onRecorderExit(on: On, exit: RecorderExit): void {
    if (exit.kind === "failed") this.fail(on, `Recording failed: ${this.redactKey(exit.detail)}. Live mode ended.`);
  }

  private fail(on: On, message: string): void {
    if (this.state === on) this.end(message, "error");
  }

  private scheduleIdleCheck(on: On): void {
    on.stopIdleTimer = this.clock.setTimer(() => this.checkIdle(on), IDLE_CHECK_MS);
  }

  /** Counts only time in which the agent is idle, so long agent work never ends live mode. */
  private checkIdle(on: On): void {
    if (this.state !== on) return;
    if (!on.context.isIdle() || on.updates.busy) on.idleSince = undefined;
    else on.idleSince ??= this.clock.now();
    if (on.idleSince !== undefined && this.clock.now() - on.idleSince >= on.idleLimitMs)
      return this.end("Live mode ended because it was idle. The microphone is closed.");
    this.scheduleIdleCheck(on);
  }

  /** Ends the attempt or session on every path: timer, recorder, connection, Pi's speech, status line, and tool. Idempotent. */
  private end(message?: string, level: "info" | "error" = "info"): void {
    const state = this.state;
    if (!state) return;
    this.state = undefined;
    if (state.phase === "starting") state.cancel.abort();
    else {
      state.stopIdleTimer();
      state.recorder.stop();
      state.session.close();
      state.updates.end();
      this.clearStatus(state.ui);
    }
    if (message) state.ui.notify(message, level);
    if (state.phase === "on") this.tools.remove();
  }

  /** The status line: whether the microphone is listening or Pi is speaking, with the keys that matter. */
  private render(): void {
    const on = this.state;
    if (on?.phase !== "on") return;
    const stopPhrase = on.stopPhrases[0] ? ` · or say "${on.stopPhrases[0]}"` : "";
    try {
      on.ui.setStatus(
        STATUS_KEY,
        `● Live — ${on.updates.busy ? "Pi speaking" : "listening"} · ${formatKeys(this.shortcuts.send)} cuts Pi off · /talk live ends live mode${stopPhrase}`,
      );
    } catch {
      // The status line is cosmetic; a replaced session's UI may refuse updates.
    }
  }

  private clearStatus(ui: TalkUi): void {
    try {
      ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // As in `render`.
    }
  }

  private redactKey(message: string): string {
    return redact(message, readProviderApiKey(this.deps.env, "elevenlabs") ?? "").slice(0, 300);
  }
}
