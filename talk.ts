import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  API_KEY_ENV,
  DEEPGRAM_API_KEY_ENV,
  loadConfig,
  readProviderApiKey,
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

/** Push-to-talk needs only the run mode and the UI of the context that pressed the key. */
export type TalkContext = Pick<ExtensionContext, "mode" | "ui">;
type TalkUi = TalkContext["ui"];

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
  shortcut: string;
  startedAt: number;
  level: number;
  /** Audio held at the time cap; never sent until the user presses again. */
  pcm: Buffer | undefined;
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
  private active: Starting | Recording | undefined;

  constructor(deps: SpeakDeps, speech: SpeechController) {
    this.deps = deps;
    this.speech = speech;
    speech.speechBlock = () =>
      this.active && this.active.phase !== "transcribing"
        ? "A recording is in progress or held. Stop or discard it before starting speech."
        : undefined;
  }

  /** `/talk` and the shortcut: start, stop and transcribe, or transcribe a held recording. */
  async press(ctx: TalkContext): Promise<void> {
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
      ui.notify("The microphone is still starting.", "info");
    } else if (active.phase === "transcribing") {
      ui.notify(
        "A transcription is still in progress. Wait for it to finish.",
        "warning",
      );
    } else if (active.phase === "held") {
      this.send(active, active.pcm!);
    } else if (this.deps.now() - active.startedAt < MIN_RECORDING_MS) {
      this.release(active);
      ui.notify(
        "Recording discarded: it was shorter than 0.5 seconds. Nothing was sent.",
        "info",
      );
    } else {
      active.phase = "transcribing";
      active.unsubscribeInput?.();
      active.unsubscribeInput = undefined;
      this.render(active);
      active.handle.stop();
    }
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
      shortcut: input.shortcut,
      startedAt: this.deps.now(),
      level: 0,
      pcm: undefined,
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
      this.send(rec, exit.pcm);
    } else {
      rec.phase = "held";
      rec.pcm = exit.pcm;
      this.render(rec);
    }
  }

  private send(rec: Recording, pcm: Buffer): void {
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
        this.release(rec);
        if (!result.ok) {
          if (result.kind !== "cancelled")
            rec.ui.notify(this.redactKeys(result.message), "error");
        } else if (result.text === "") {
          rec.ui.notify("Nothing was recognized. The composer is unchanged.", "info");
        } else {
          this.append(rec.ui, result.text);
        }
      },
      () => {
        if (this.active !== rec) return;
        this.release(rec);
        rec.ui.notify("Transcription failed. Nothing was retried.", "error");
      },
    );
  }

  /** Adds the transcript after the existing text; it is never submitted or replaced. */
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
    try {
      rec.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // The status line is cosmetic; a replaced session's UI may refuse updates.
    }
  }

  private render(rec: Recording): void {
    let text: string;
    if (rec.phase === "recording") {
      const bar = LEVEL_BARS[rec.level - 1] ?? "·";
      text = `● Recording ${formatElapsed(this.deps.now() - rec.startedAt)} ${bar} — ${rec.shortcut} stop · Esc discard`;
    } else if (rec.phase === "held") {
      text = `Recording limit reached (${rec.maxSeconds} s), not sent — ${rec.shortcut} transcribe · Esc discard`;
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
