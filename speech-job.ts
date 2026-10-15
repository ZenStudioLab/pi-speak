import { randomUUID } from "node:crypto";
import {
  startPlayer,
  type PlayerHandle,
  type SpawnFn,
} from "./audio.ts";
import { AudioCache } from "./cache.ts";
import {
  API_KEY_ENV,
  cacheDir,
  canonicalLocale,
  loadConfig,
  readProviderApiKey,
  type Env,
  type Shortcuts,
  type SpeakConfig,
  type SpeechProvider,
} from "./config.ts";
import { redact } from "./elevenlabs.ts";
import type { LivePhase } from "./live.ts";
import { QuotaLookup } from "./quota-lookup.ts";
import { buildHelp } from "./help.ts";
import type { WebSocketFn } from "./realtime.ts";
import { clipFor, synthesizeClip, type Clip } from "./speech-clip.ts";
import { preflightSpeech } from "./speech-preflight.ts";
import { reportStatus } from "./speech-status.ts";
import { Translator, type TranslationRegistry } from "./translation.ts";
import {
  TranslationError,
  type TranslationFailureRecord,
} from "./translation-failure.ts";

export interface SpeakUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
  setWidget?(key: string, content: string[] | undefined): void;
}

export interface SpeakDeps {
  env: Env;
  fetchFn: typeof fetch;
  spawnFn?: SpawnFn;
  now: () => number;
  home?: string;
  readFile?: (path: string) => Promise<string>;
  /** Opens the live transcription socket; Node's global `WebSocket` when omitted. */
  webSocketFn?: WebSocketFn;
}

/** What `speakLive` needs of the live session: where to show messages and when the player starts and exits. */
export interface LiveSpeechHooks {
  ui: SpeakUi;
  /** The player has started; not called when the update ends before playback. */
  onPlayerStart(): void;
  /** The player has exited, however it ended; called once after `onPlayerStart`. */
  onPlayerExit(): void;
}

type Phase = "preparing" | "translating" | "generating" | "playing";

interface Job {
  controller: AbortController;
  speechProviderOverride?: SpeechProvider;
  /** The one-command or session locale, fixed at job start; undefined means the configured one. */
  locale?: string;
  provider?: SpeechProvider;
  phase: Phase;
  player?: PlayerHandle;
  ui: SpeakUi;
  recordFailure?: (record: TranslationFailureRecord) => void;
  /** Set only for live-mode updates. */
  liveHooks?: LiveSpeechHooks;
}

const STATUS_KEY = "speak";
const PROGRESS_KEY = "speak-progress";
const PHASE_LABELS: Record<Phase, string> = {
  preparing: "Preparing",
  translating: "Translating",
  generating: "ElevenLabs",
  playing: "Playing",
};

const ignoreFailure = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  );

/**
 * Owns the single speech job of this Pi process. A job is claimed synchronously, so two quick
 * commands cannot both pass the "already active" check. Every continuation re-checks that its job
 * is still the current one, so a cancelled job can never start playback or touch a newer job.
 */
export class SpeechController {
  private readonly deps: SpeakDeps;
  private readonly shortcuts: Shortcuts;
  private readonly translator = new Translator();
  private job: Job | undefined;
  private lastClip: Clip | undefined;
  private task: Promise<void> = Promise.resolve();
  private readonly quotaLookup: QuotaLookup;
  private speechProviderOverride: SpeechProvider | undefined;
  private inputProviderOverride: SpeechProvider | undefined;
  private speechLocaleOverride: string | undefined;
  /** Returns a reason while new audio must not start (the microphone is in use), else undefined. */
  speechBlock: (() => string | undefined) | undefined;

  constructor(deps: SpeakDeps, shortcuts: Shortcuts) {
    this.deps = deps;
    this.shortcuts = shortcuts;
    this.quotaLookup = new QuotaLookup(deps);
  }

  /** The session-only voice-input provider, applied over the configured one. */
  get inputOverride(): SpeechProvider | undefined {
    return this.inputProviderOverride;
  }

  /** Resolves when the current speech and quota work have ended. */
  async whenIdle(): Promise<void> {
    await Promise.all([this.task, this.quotaLookup.whenDone()]);
  }

  speak(text: string, ui: SpeakUi): void {
    const job = this.begin(ui);
    if (job) this.task = this.run(job, () => this.generateAndPlay(job, text));
  }

  /**
   * Speaks one live-mode update with ElevenLabs whatever the session or configured provider is,
   * and without `speechBlock`, which refuses `/speak` while live mode is on. Otherwise it is
   * `speak(text)`: same preflight, length limit, cache, player, and progress line. Resolves when
   * the job has ended, including when it was cancelled before playback.
   */
  speakLive(text: string, hooks: LiveSpeechHooks): Promise<void> {
    const job = this.begin(hooks.ui, undefined, undefined, hooks);
    if (!job) return Promise.resolve();
    this.task = this.run(job, () => this.generateAndPlay(job, text));
    return this.task;
  }

  speakLocalized(
    text: string,
    ui: SpeakUi,
    registry: TranslationRegistry | undefined,
    recordFailure?: (record: TranslationFailureRecord) => void,
    oneCommandLocale?: string,
  ): void {
    const job = this.begin(ui, recordFailure, oneCommandLocale);
    if (job)
      this.task = this.run(job, () =>
        this.generateAndPlay(job, text, true, registry),
      );
  }

  replay(ui: SpeakUi): void {
    const clip = this.lastClip;
    if (!clip) {
      ui.notify("Nothing to replay in this session.", "info");
      return;
    }
    const job = this.begin(ui);
    if (job) this.task = this.run(job, () => this.replayClip(job, clip));
  }

  /** Ends this extension's own generation and playback and waits for the player to really exit. */
  async stopOwnAudio(): Promise<void> {
    if (this.job) this.cancel(this.job);
    await this.task;
  }

  stop(ui: SpeakUi): void {
    const job = this.job;
    if (!job) {
      ui.notify("Nothing is being generated or played.", "info");
      return;
    }
    this.cancel(job);
    ui.notify("Stopped.", "info");
  }

  /** Lifecycle cleanup: cancel this extension's own work and forget the previous session's clip. */
  resetSession(): void {
    if (this.job) this.cancel(this.job);
    this.lastClip = undefined;
    this.translator.clear();
    this.quotaLookup.cancel();
  }

  async provider(
    kind: "speech" | "input",
    name: SpeechProvider | "reset" | undefined,
    ui: SpeakUi,
  ): Promise<void> {
    if (name !== undefined && name !== "reset" && name !== "elevenlabs" && name !== "deepgram") {
      await this.help(ui);
      return;
    }
    if (name !== undefined) {
      if (kind === "speech") this.speechProviderOverride = name === "reset" ? undefined : name;
      else this.inputProviderOverride = name === "reset" ? undefined : name;
    }
    const loaded = await loadConfig(this.deps.env, this.deps.readFile, this.deps.home);
    if (!loaded.ok) {
      ui.notify(`not configured: ${loaded.problem}`, "warning");
      return;
    }
    const override = kind === "speech" ? this.speechProviderOverride : this.inputProviderOverride;
    const configured = kind === "speech" ? loaded.config.provider : loaded.config.input.provider;
    ui.notify(`${kind} provider: ${override ?? configured}${override ? " (session override)" : ""}`, "info");
  }

  /** `/speak locale [<tag>|reset]`: report, set, or clear the session locale. No request is made. */
  async locale(arg: string | undefined, ui: SpeakUi): Promise<void> {
    if (arg !== undefined && arg !== "reset") {
      const tag = canonicalLocale(arg);
      if (!tag) {
        ui.notify(`"${arg.slice(0, 40)}" is not a valid BCP-47 language tag. The speech locale is unchanged.`, "warning");
        return;
      }
      this.speechLocaleOverride = tag;
    } else if (arg === "reset") {
      this.speechLocaleOverride = undefined;
    }
    const loaded = await loadConfig(this.deps.env, this.deps.readFile, this.deps.home);
    const override = this.speechLocaleOverride;
    if (!override && !loaded.ok) {
      ui.notify(`not configured: ${loaded.problem}`, "warning");
      return;
    }
    const effective = override ?? (loaded.ok ? loaded.config.locale : "");
    ui.notify(`speech locale: ${effective}${override ? " (session override)" : ""}`, "info");
  }

  /** The combined `/speak` and `/talk` help; it reads the local configuration only. */
  async help(ui: SpeakUi): Promise<void> {
    ui.notify(await buildHelp(this.deps, this.speechLocaleOverride, this.shortcuts), "info");
  }

  /** Quota is independent of speech; do not block Pi's stop command while waiting. */
  quota(ui: SpeakUi): void {
    this.quotaLookup.start(ui);
  }

  status(ui: SpeakUi, livePhase: () => LivePhase): Promise<void> {
    return reportStatus(
      this.deps,
      {
        speechProvider: this.speechProviderOverride,
        inputProviderOverride: this.inputProviderOverride,
        speechLocale: this.speechLocaleOverride,
        jobPhase: () => this.job?.phase,
        livePhase,
      },
      (config) => this.cacheFor(config),
      ui,
    );
  }

  private begin(
    ui: SpeakUi,
    recordFailure?: (record: TranslationFailureRecord) => void,
    oneCommandLocale?: string,
    liveHooks?: LiveSpeechHooks,
  ): Job | undefined {
    const blocked = liveHooks ? undefined : this.speechBlock?.();
    if (blocked) {
      ui.notify(blocked, "warning");
      return undefined;
    }
    if (this.job) {
      ui.notify(
        "Speech is already active. Use /speak stop to end it.",
        "warning",
      );
      return undefined;
    }
    const job: Job = {
      controller: new AbortController(),
      speechProviderOverride: liveHooks ? "elevenlabs" : this.speechProviderOverride,
      locale: oneCommandLocale ?? this.speechLocaleOverride,
      phase: "preparing",
      ui,
      recordFailure,
      liveHooks,
    };
    this.job = job;
    this.show(job, "preparing");
    return job;
  }

  private live(job: Job): boolean {
    return this.job === job;
  }

  private show(job: Job, text: Phase | undefined): void {
    const label = text === "generating"
      ? job.provider === "deepgram" ? "Deepgram" : "ElevenLabs"
      : text === undefined ? undefined : PHASE_LABELS[text];
    try {
      job.ui.setWidget?.(
        PROGRESS_KEY,
        label === undefined ? undefined : [`Speech: ${label}...`],
      );
    } catch {
      // Progress is cosmetic; a UI failure must not block speech or cancellation.
    }
    try {
      job.ui.setStatus?.(
        STATUS_KEY,
        text === undefined ? undefined : `speak: ${text}`,
      );
    } catch {
      return; // A replaced session's UI may refuse updates; the status line is cosmetic.
    }
  }

  private cancel(job: Job): void {
    if (this.job === job) this.job = undefined;
    job.controller.abort();
    job.player?.stop();
    this.show(job, undefined);
  }

  private async run(job: Job, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (this.live(job)) {
        let reference = "";
        if (
          error instanceof TranslationError &&
          error.failure &&
          job.recordFailure
        ) {
          const diagnosticId = randomUUID();
          try {
            job.recordFailure({ ...error.failure, diagnosticId });
            reference = ` [diagnostic ${diagnosticId}]`;
          } catch {
            // Persistence is best effort; never replace or hide the speech failure.
          }
        }
        if (this.live(job))
          job.ui.notify(
            `Speech failed: ${this.describeError(error)}${reference}`,
            "error",
          );
      }
    } finally {
      // Only the current job may release the claim or touch the status line; a cancelled job has
      // already cleaned up and must not disturb whatever replaced it.
      if (this.job === job) {
        this.job = undefined;
        this.show(job, undefined);
      }
    }
  }

  private redactFailureMessage(message: string): string {
    return redact(
      redact(
        message,
        readProviderApiKey(this.deps.env, "elevenlabs") ?? "",
      ),
      readProviderApiKey(this.deps.env, "deepgram") ?? "",
    ).slice(0, 200);
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.redactFailureMessage(message);
  }

  private cacheFor(config: SpeakConfig): AudioCache {
    return new AudioCache({
      root: cacheDir(this.deps.env, this.deps.home),
      maxBytes: config.cache.maxBytes,
      ttlDays: config.cache.ttlDays,
      now: this.deps.now,
    });
  }

  private preflight(
    job: Job,
    text?: string,
    generation = true,
    localized = false,
  ): Promise<SpeakConfig | undefined> {
    return preflightSpeech(this.deps, { ...job, isCurrent: () => this.live(job) }, text, generation, localized);
  }

  private async generateAndPlay(
    job: Job,
    text: string,
    localized = false,
    registry?: TranslationRegistry,
  ): Promise<void> {
    const config = await this.preflight(job, text, true, localized);
    if (!config) return;
    job.provider = config.provider;
    if (localized) {
      text = await this.translator.render({
        text,
        config,
        registry,
        signal: job.controller.signal,
        onStart: () => {
          job.phase = "translating";
          this.show(job, "translating");
        },
      });
      if (!this.live(job)) return;
    }
    const cache = this.cacheFor(config);
    const clip = clipFor(config, text, localized);

    let path = await cache.get(clip.key, clip.extension);
    if (!this.live(job)) return;
    if (!path) {
      const apiKey = readProviderApiKey(this.deps.env, config.provider);
      if (!apiKey) {
        job.ui.notify(
          `${config.provider === "elevenlabs" ? API_KEY_ENV : "DEEPGRAM_API_KEY"} is not set. Nothing was sent.`,
          "warning",
        );
        return;
      }
      job.phase = "generating";
      this.show(job, "generating");
      const result = await synthesizeClip(config, text, apiKey, job.controller.signal, this.deps.fetchFn);
      if (!this.live(job)) return;
      if (!result.ok) {
        if (result.kind !== "cancelled")
          job.ui.notify(this.redactFailureMessage(result.message), "error");
        return;
      }
      path = await cache.put(clip.key, clip.extension, result.bytes);
      if (!this.live(job)) return;
    }
    await this.playClip(job, config, cache, clip, path);
  }

  private async replayClip(job: Job, clip: Clip): Promise<void> {
    const config = await this.preflight(job, undefined, false);
    if (!config) return;
    const cache = this.cacheFor(config);
    const path = await cache.get(clip.key, clip.extension);
    if (!this.live(job)) return;
    if (!path) {
      this.lastClip = undefined;
      job.ui.notify(
        "The last clip is no longer in the cache, so there is nothing to replay.",
        "warning",
      );
      return;
    }
    await this.playClip(job, config, cache, clip, path);
  }

  private async playClip(
    job: Job,
    config: SpeakConfig,
    cache: AudioCache,
    clip: Clip,
    path: string,
  ): Promise<void> {
    this.lastClip = clip;
    // Eviction is housekeeping; failing to prune must not block playback.
    await ignoreFailure(cache.evict(path));
    if (!this.live(job)) return;
    job.phase = "playing";
    this.show(job, "playing");
    const player = startPlayer({
      command: config.player.command,
      args: config.player.args,
      file: path,
      env: this.deps.env,
      spawnFn: this.deps.spawnFn,
    });
    job.player = player;
    this.signalLive(job, "onPlayerStart");
    const exit = await player.done;
    this.signalLive(job, "onPlayerExit");
    if (exit.kind === "failed" && this.live(job))
      job.ui.notify(`Playback failed: ${exit.detail}`, "error");
  }

  /** A failing hook must neither orphan the tracked player nor skip the exit hook, which lifts the live mute. */
  private signalLive(job: Job, hook: "onPlayerStart" | "onPlayerExit"): void {
    try {
      job.liveHooks?.[hook]();
    } catch {
      // Live bookkeeping only; the player keeps its normal stop path.
    }
  }
}
