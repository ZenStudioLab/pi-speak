import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  API_KEY_ENV,
  DEEPGRAM_API_KEY_ENV,
  loadConfig,
  readProviderApiKey,
  type Shortcuts,
  type SpeechProvider,
} from "./config.ts";
import { transcribe as transcribeDeepgram } from "./deepgram.ts";
import { redact, transcribe as transcribeElevenLabs } from "./elevenlabs.ts";
import {
  startRecorder,
  wavFromPcm,
  type RecorderExit,
  type RecorderHandle,
} from "./record.ts";
import type { SpeakDeps, SpeechController } from "./speech-job.ts";

/** Push-to-talk needs only the run mode, the UI, and the idle state and model of the context that pressed the key. */
export type TalkContext = Pick<ExtensionContext, "mode" | "ui" | "isIdle" | "model">;
type TalkUi = TalkContext["ui"];

/** What the control that stops a recording asks for: send the composer, or only add the text to it. */
export type TalkMode = "send" | "transcribe";

/** `pi.sendUserMessage`; always plain text, delivered to a running turn only with `deliverAs`. */
export type SendMessage = (
  text: string,
  options: { deliverAs?: "steer" | "followUp"; expandPromptTemplates: false },
) => void;

const STATUS_KEY = "speak-talk";
const MIN_RECORDING_MS = 500;
const LEVEL_BARS = "▁▂▃▄▅▆▇█";

/** Placeholder for a press that is still checking configuration or starting the recorder. */
interface Starting {
  phase: "starting";
}

/** One recording and what it needs afterwards; its provider settings are fixed when it starts. */
interface Recording {
  phase: "recording" | "held" | "transcribing";
  ui: TalkUi;
  handle: RecorderHandle;
  provider: SpeechProvider;
  model: string;
  language: string | undefined;
  apiKey: string;
  timeoutMs: number;
  maxSeconds: number;
  startedAt: number;
  level: number;
  /** Audio held at the time cap; never sent until the user presses again. */
  pcm: Buffer | undefined;
  /** Set by the stopping control, which alone decides whether the transcript is sent. */
  delivery: { mode: TalkMode; context: Pick<TalkContext, "isIdle" | "model"> } | undefined;
  unsubscribeInput: (() => void) | undefined;
  cancel: AbortController;
}

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
    if (!active) return this.start(ui);
    if (active.phase === "starting") {
      this.cancelStarting(active, ui);
    } else if (active.phase === "transcribing") {
      ui.notify(
        "A transcription is still in progress. Wait for it to finish.",
        "warning",
      );
    } else if (active.phase === "held") {
      active.delivery = { mode, context: ctx };
      this.upload(active, active.pcm!);
    } else if (this.deps.now() - active.startedAt < MIN_RECORDING_MS) {
      this.release(active);
      ui.notify(
        "Recording discarded: it was shorter than 0.5 seconds. Nothing was sent.",
        "info",
      );
    } else {
      active.phase = "transcribing";
      active.delivery = { mode, context: ctx };
      active.unsubscribeInput?.();
      active.unsubscribeInput = undefined;
      this.render(active);
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
    if (active && active.phase !== "starting") this.release(active);
  }

  private async start(ui: TalkUi): Promise<void> {
    const claim: Starting = { phase: "starting" };
    this.active = claim;
    // Escape cancels an attempt that is not recording yet, so it never reaches the editor.
    const unsubscribeStarting = ui.onTerminalInput((data) => {
      if (this.active !== claim || !matchesKey(data, "escape")) return undefined;
      this.cancelStarting(claim, ui);
      return { consume: true };
    });
    try {
      await this.begin(ui, claim);
    } finally {
      unsubscribeStarting();
    }
  }

  /** Clearing the claim makes every `this.active !== claim` check in `begin` end the attempt. */
  private cancelStarting(claim: Starting, ui: TalkUi): void {
    if (this.active === claim) this.active = undefined;
    this.clearStatus(ui);
    ui.notify("Recording cancelled. Nothing was recorded or sent.", "info");
  }

  private async begin(ui: TalkUi, claim: Starting): Promise<void> {
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
    const apiKey = readProviderApiKey(this.deps.env, provider);
    if (!apiKey)
      return abandon(
        `${provider === "elevenlabs" ? API_KEY_ENV : DEEPGRAM_API_KEY_ENV} is not set. Nothing was recorded or sent.`,
      );

    // The microphone must not hear this extension's own speech.
    await this.speech.stopOwnAudio();
    if (this.active !== claim) return;
    let recording: Recording | undefined;
    const started = await startRecorder({
      env: this.deps.env,
      maxSeconds: input.maxSeconds,
      spawnFn: this.deps.spawnFn,
      onLevel: (level) => {
        if (!recording || this.active !== recording || recording.phase !== "recording")
          return;
        recording.level = level;
        this.render(recording);
      },
    });
    if (this.active !== claim) {
      if (started.ok) started.handle.stop();
      return;
    }
    if (!started.ok)
      return abandon(
        `No recording tool was found (looked for ${started.tried.join(", ")}). Nothing was recorded.`,
      );

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
    this.render(current);
    void started.handle.done.then((exit) => this.onRecorderExit(current, exit));
  }

  private onRecorderExit(rec: Recording, exit: RecorderExit): void {
    if (this.active !== rec) return;
    if (exit.kind === "failed") {
      this.release(rec);
      rec.ui.notify(
        `Recording failed: ${this.redactKeys(exit.detail)}. Nothing was sent.`,
        "error",
      );
    } else if (rec.phase === "transcribing") {
      this.upload(rec, exit.pcm);
    } else {
      rec.phase = "held";
      rec.pcm = exit.pcm;
      this.render(rec);
    }
  }

  private upload(rec: Recording, pcm: Buffer): void {
    rec.phase = "transcribing";
    rec.pcm = undefined;
    rec.unsubscribeInput?.();
    rec.unsubscribeInput = undefined;
    this.render(rec);
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
      text = `● Recording ${formatElapsed(this.deps.now() - rec.startedAt)} ${bar} — ${this.shortcuts.send} stop and send · ${this.shortcuts.transcribe} stop, transcribe only · Esc discard`;
    } else if (rec.phase === "held") {
      text = `Recording limit reached (${rec.maxSeconds} s), not sent — ${this.shortcuts.send} send · ${this.shortcuts.transcribe} transcribe only · Esc discard`;
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
