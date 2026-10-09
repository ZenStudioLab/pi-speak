import { matchesKey } from "@earendil-works/pi-tui";
import {
  API_KEY_ENV,
  DEEPGRAM_API_KEY_ENV,
  formatKeys,
  loadConfig,
  readProviderApiKey,
  type Shortcuts,
} from "./config.ts";
import { transcribe as transcribeDeepgram } from "./deepgram.ts";
import { redact, transcribe as transcribeElevenLabs } from "./elevenlabs.ts";
import {
  matchStopPhrase,
  nodeWebSocket,
  openRealtime,
  type RealtimeSession,
} from "./realtime.ts";
import { startRecorder, wavFromPcm, type RecorderExit } from "./record.ts";
import type { SpeakDeps, SpeechController } from "./speech-job.ts";
import type {
  Recording,
  SendMessage,
  Starting,
  TalkContext,
  TalkMode,
  TalkUi,
} from "./talk-state.ts";

export type { SendMessage, TalkContext, TalkMode } from "./talk-state.ts";

const STATUS_KEY = "speak-talk";
const MIN_RECORDING_MS = 500;
const LEVEL_BARS = "▁▂▃▄▅▆▇█";

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * Owns the single recording or transcription of this Pi process. Nothing here runs until the
 * user presses the shortcut or runs `/talk`; every continuation re-checks that its recording is
 * still the active one, so a discarded or replaced recording can never send audio or change the
 * composer.
 */
export class TalkController {
  private readonly deps: SpeakDeps;
  private readonly speech: SpeechController;
  private readonly sendMessage: SendMessage;
  private readonly shortcuts: Shortcuts;
  private active: Starting | Recording | undefined;
  private compacting = false;

  constructor(
    deps: SpeakDeps,
    speech: SpeechController,
    sendMessage: SendMessage,
    shortcuts: Shortcuts,
  ) {
    this.deps = deps;
    this.speech = speech;
    this.sendMessage = sendMessage;
    this.shortcuts = shortcuts;
    speech.speechBlock = () =>
      this.active && this.active.phase !== "transcribing"
        ? "A recording is in progress or held. Stop or discard it before starting speech."
        : undefined;
  }

  /**
   * A shortcut or `/talk [send]`: start, stop and transcribe, or transcribe a held recording. A press
   * that only starts a recording carries no decision; the stopping `mode` is what counts.
   */
  async press(ctx: TalkContext, mode: TalkMode): Promise<void> {
    const ui = ctx.ui;
    if (ctx.mode !== "tui") {
      ui.notify(
        "Voice input works only in the interactive terminal, so nothing was recorded.",
        "warning",
      );
      return;
    }
    const active = this.active;
    if (!active) return this.start(ctx);
    if (active.phase === "starting") {
      this.cancelStarting(active, ui);
    } else if (active.phase === "transcribing") {
      ui.notify(
        "A transcription is still in progress. Wait for it to finish.",
        "warning",
      );
    } else if (active.phase === "held") {
      active.delivery = { mode, context: ctx };
      // Held at the cap but not yet exited: transcribe once the recorder has exited.
      if (!active.live && active.pcm) this.upload(active, active.pcm);
      else {
        this.beginTranscribing(active);
        if (active.live?.text !== undefined) this.deliverStreamed(active);
      }
    } else if (this.deps.now() - active.startedAt < MIN_RECORDING_MS) {
      this.release(active);
      ui.notify(
        "Recording discarded: it was shorter than 0.5 seconds. Nothing was sent.",
        "info",
      );
    } else {
      active.delivery = { mode, context: ctx };
      this.beginTranscribing(active);
      active.handle.stop();
    }
  }

  /** Pi refuses a prompt while it compacts the conversation, so a send must not start then. */
  setCompacting(compacting: boolean): void {
    this.compacting = compacting;
  }

  /** Lifecycle cleanup: discards a recording or held audio and drops any transcript still due. */
  resetSession(): void {
    const active = this.active;
    this.active = undefined;
    if (active?.phase === "starting") active.cancel.abort();
    else if (active) this.release(active);
  }

  private async start(ctx: Pick<TalkContext, "ui" | "isIdle" | "model">): Promise<void> {
    const ui = ctx.ui;
    const claim: Starting = { phase: "starting", cancel: new AbortController() };
    this.active = claim;
    // Escape cancels an attempt that is not recording yet, so it never reaches the editor.
    const unsubscribeStarting = ui.onTerminalInput((data) => {
      if (this.active !== claim || !matchesKey(data, "escape")) return undefined;
      this.cancelStarting(claim, ui);
      return { consume: true };
    });
    try {
      await this.begin(ctx, claim);
    } finally {
      unsubscribeStarting();
    }
  }

  /** Clearing the claim makes every `this.active !== claim` check in `begin` end the attempt. */
  private cancelStarting(claim: Starting, ui: TalkUi): void {
    if (this.active === claim) this.active = undefined;
    claim.cancel.abort();
    this.clearStatus(ui);
    ui.notify("Recording cancelled. Nothing was recorded or sent.", "info");
  }

  private async begin(
    ctx: Pick<TalkContext, "ui" | "isIdle" | "model">,
    claim: Starting,
  ): Promise<void> {
    const ui = ctx.ui;
    const abandon = (message: string) => {
      if (this.active === claim) this.active = undefined;
      ui.notify(message, "warning");
    };
    const loaded = await loadConfig(
      this.deps.env,
      this.deps.readFile,
      this.deps.home,
    );
    if (this.active !== claim) return;
    if (!loaded.ok)
      return abandon(`Voice input is not configured: ${loaded.problem}`);
    const { input, providers, requestTimeoutMs } = loaded.config;
    const provider = this.speech.inputOverride ?? input.provider;
    if (input.stopOnPhrase && provider !== "elevenlabs")
      return abandon(
        "The stop phrase needs ElevenLabs, but the voice input provider is Deepgram. Nothing was recorded or sent. Run /talk provider elevenlabs, or turn off input.stopOnPhrase.",
      );
    const apiKey = readProviderApiKey(this.deps.env, provider);
    if (!apiKey)
      return abandon(
        `${provider === "elevenlabs" ? API_KEY_ENV : DEEPGRAM_API_KEY_ENV} is not set. Nothing was recorded or sent.`,
      );

    // The microphone must not hear this extension's own speech.
    await this.speech.stopOwnAudio();
    if (this.active !== claim) return;
    // The recorder starts only once the connection is open, so no audio is lost while waiting for it.
    let session: RealtimeSession | undefined;
    if (input.stopOnPhrase) {
      const opened = await openRealtime({
        apiKey,
        language: input.language,
        timeoutMs: requestTimeoutMs,
        signal: claim.cancel.signal,
        webSocketFn: this.deps.webSocketFn ?? nodeWebSocket,
      });
      if (this.active !== claim) {
        if (opened.ok) opened.session.close();
        return;
      }
      if (!opened.ok)
        return abandon(`${this.redactKeys(opened.failure.message)} Nothing was recorded or sent.`);
      session = opened.session;
    }
    let recording: Recording | undefined;
    const started = await startRecorder({
      env: this.deps.env,
      maxSeconds: input.maxSeconds,
      spawnFn: this.deps.spawnFn,
      onChunk: (chunk) => session?.sendAudio(chunk),
      // The cap holds the recording at once, not when the recorder exits, so a late phrase cannot send it.
      onCapped: () => {
        if (!recording || this.active !== recording || recording.phase !== "recording") return;
        recording.phase = "held";
        this.render(recording);
      },
      onLevel: (level) => {
        if (!recording || this.active !== recording || recording.phase !== "recording")
          return;
        recording.level = level;
        this.render(recording);
      },
    });
    if (this.active !== claim) {
      if (started.ok) started.handle.stop();
      session?.close();
      return;
    }
    if (!started.ok) {
      session?.close();
      return abandon(
        `No recording tool was found (looked for ${started.tried.join(", ")}). Nothing was recorded.`,
      );
    }

    const current: Recording = {
      phase: "recording",
      ui,
      handle: started.handle,
      provider,
      model: providers[provider].sttModel,
      language: input.language,
      apiKey,
      timeoutMs: requestTimeoutMs,
      maxSeconds: input.maxSeconds,
      startedAt: this.deps.now(),
      level: 0,
      pcm: undefined,
      live: session && { session, phrases: input.stopPhrases, context: ctx, text: undefined },
      delivery: undefined,
      unsubscribeInput: undefined,
      cancel: new AbortController(),
    };
    recording = current;
    this.active = current;
    // Only Escape is taken, and only while the audio can still be discarded.
    current.unsubscribeInput = ui.onTerminalInput((data) => {
      if (this.active !== current || !matchesKey(data, "escape")) return undefined;
      this.release(current);
      ui.notify("Recording discarded. Nothing was sent.", "info");
      return { consume: true };
    });
    session?.listen({
      onCommitted: () => this.onCommitted(current),
      onFailure: (failure) => {
        if (this.active === current) this.failStream(current, failure.message);
      },
    });
    this.render(current);
    void started.handle.done.then((exit) => this.onRecorderExit(current, exit));
  }

  private onRecorderExit(rec: Recording, exit: RecorderExit): void {
    if (this.active !== rec) return;
    if (exit.kind === "failed") {
      if (rec.live) return this.failStream(rec, `Recording failed: ${exit.detail}.`);
      this.release(rec);
      rec.ui.notify(
        `Recording failed: ${this.redactKeys(exit.detail)}. Nothing was sent.`,
        "error",
      );
    } else if (rec.live) {
      if (rec.live.text !== undefined) return;
      if (rec.phase === "recording") rec.phase = "held";
      if (rec.phase === "held") this.render(rec);
      this.finishStream(rec);
    } else if (rec.phase === "transcribing") {
      this.upload(rec, exit.pcm);
    } else {
      rec.phase = "held";
      rec.pcm = exit.pcm;
      this.render(rec);
    }
  }

  /** Moves to transcription, where Escape no longer discards. */
  private beginTranscribing(rec: Recording): void {
    rec.phase = "transcribing";
    rec.unsubscribeInput?.();
    rec.unsubscribeInput = undefined;
    this.render(rec);
  }

  /** The recorder has stopped (key or time cap): requests the final commit and keeps its text. */
  private finishStream(rec: Recording): void {
    const live = rec.live!;
    void live.session.finish(rec.timeoutMs).then((result) => {
      if (this.active !== rec) return;
      if (!result.ok) return this.failStream(rec, result.failure.message);
      live.session.close();
      live.text = result.text;
      if (rec.delivery) this.deliverStreamed(rec);
    });
  }

  /** A committed segment arrived: a stop phrase at its end stops the recording and sends the rest. */
  private onCommitted(rec: Recording): void {
    const live = rec.live!;
    if (this.active !== rec || rec.phase !== "recording") return;
    const rest = matchStopPhrase(live.session.text, live.phrases);
    if (rest === undefined) return;
    live.text = rest;
    live.session.close();
    rec.delivery = { mode: "send", context: live.context };
    this.beginTranscribing(rec);
    rec.handle.stop();
    this.deliverStreamed(rec, "Only the stop phrase was heard. Nothing was sent and the composer is unchanged.");
  }

  private deliverStreamed(
    rec: Recording,
    nothing = "Nothing was recognized. The composer is unchanged.",
  ): void {
    const text = rec.live!.text!;
    if (text !== "") {
      void this.deliver(rec, text);
      return;
    }
    this.release(rec);
    rec.ui.notify(nothing, "info");
  }

  /** A failed stream or recorder ends the recording; the text already committed is added to the composer, unsent. */
  private failStream(rec: Recording, message: string): void {
    const text = rec.live!.session.text;
    this.release(rec);
    if (text !== "") this.append(rec.ui, text);
    rec.ui.notify(
      `${this.redactKeys(message)} Nothing was sent.${text !== "" ? " The text transcribed so far was added to the composer." : ""}`,
      "error",
    );
  }

  private upload(rec: Recording, pcm: Buffer): void {
    rec.pcm = undefined;
    this.beginTranscribing(rec);
    const request = {
      wav: wavFromPcm(pcm),
      model: rec.model,
      language: rec.language,
      apiKey: rec.apiKey,
      timeoutMs: rec.timeoutMs,
      signal: rec.cancel.signal,
    };
    const transcribe =
      rec.provider === "deepgram" ? transcribeDeepgram : transcribeElevenLabs;
    void transcribe(request, this.deps.fetchFn).then(
      (result) => {
        if (this.active !== rec) return;
        if (result.ok && result.text !== "") return this.deliver(rec, result.text);
        this.release(rec);
        if (!result.ok) {
          if (result.kind !== "cancelled")
            rec.ui.notify(this.redactKeys(result.message), "error");
        } else {
          rec.ui.notify("Nothing was recognized. The composer is unchanged.", "info");
        }
      },
      () => {
        if (this.active !== rec) return;
        this.release(rec);
        rec.ui.notify("Transcription failed. Nothing was retried.", "error");
      },
    );
  }

  /**
   * Appends the transcript and, in send mode, sends the whole composer as plain text. `sendWhenBusy`
   * is read now. Pi reports a refusal of `pi.sendUserMessage` only later, so the refusals visible
   * beforehand (no model, compaction in progress) keep the text in the composer without sending. The
   * composer is cleared only after the send call returns; if it throws, the draft and transcript stay
   * and the error is shown.
   */
  private async deliver(rec: Recording, text: string): Promise<void> {
    const { ui } = rec;
    const { mode, context } = rec.delivery!;
    const loaded =
      mode === "send"
        ? await loadConfig(this.deps.env, this.deps.readFile, this.deps.home)
        : undefined;
    if (this.active !== rec) return;
    this.release(rec);
    this.append(ui, text);
    if (!loaded) return;
    if (!loaded.ok)
      return ui.notify(
        `The transcript was added to the composer but not sent: ${loaded.problem}`,
        "error",
      );
    if (!context.model)
      return ui.notify(
        "The transcript was added to the composer but not sent: no model is selected. Select a model, then press Enter.",
        "warning",
      );
    if (this.compacting)
      return ui.notify(
        "The transcript was added to the composer but not sent: Pi is compacting the conversation. Press Enter to queue the message.",
        "warning",
      );
    try {
      const deliverAs = loaded.config.input.sendWhenBusy === "wait" ? "followUp" : "steer";
      this.sendMessage(
        ui.getEditorText(),
        context.isIdle()
          ? { expandPromptTemplates: false }
          : { deliverAs, expandPromptTemplates: false },
      );
      ui.setEditorText("");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ui.notify(
        `Not sent: ${this.redactKeys(reason)}. The draft and transcript are still in the composer.`,
        "error",
      );
    }
  }

  /** Adds the transcript after the existing text; it is never replaced. */
  private append(ui: TalkUi, text: string): void {
    const current = ui.getEditorText();
    const separator = current !== "" && !/\s$/.test(current) ? " " : "";
    ui.setEditorText(`${current}${separator}${text}`);
  }

  /** Ends this recording on every path: recorder, keys, request, held audio, and status line. */
  private release(rec: Recording): void {
    if (this.active === rec) this.active = undefined;
    rec.unsubscribeInput?.();
    rec.unsubscribeInput = undefined;
    rec.handle.stop();
    rec.live?.session.close();
    rec.cancel.abort();
    rec.pcm = undefined;
    this.clearStatus(rec.ui);
  }

  private clearStatus(ui: TalkUi): void {
    try {
      ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // The status line is cosmetic; a replaced session's UI may refuse updates.
    }
  }

  private render(rec: Recording): void {
    let text: string;
    if (rec.phase === "recording") {
      const bar = LEVEL_BARS[rec.level - 1] ?? "·";
      text = `● Recording ${formatElapsed(this.deps.now() - rec.startedAt)} ${bar} — ${formatKeys(this.shortcuts.send)} stop and send · ${formatKeys(this.shortcuts.transcribe)} stop, transcribe only · Esc discard`;
    } else if (rec.phase === "held") {
      text = `Recording limit reached (${rec.maxSeconds} s), not sent — ${formatKeys(this.shortcuts.send)} send · ${formatKeys(this.shortcuts.transcribe)} transcribe only · Esc discard`;
    } else {
      text = "Transcribing…";
    }
    try {
      rec.ui.setStatus(STATUS_KEY, text);
    } catch {
      return;
    }
  }

  private redactKeys(message: string): string {
    return redact(
      redact(message, readProviderApiKey(this.deps.env, "elevenlabs") ?? ""),
      readProviderApiKey(this.deps.env, "deepgram") ?? "",
    ).slice(0, 300);
  }
}
