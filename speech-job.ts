import { randomUUID } from "node:crypto";
import {
  startPlayer,
  resolveExecutable,
  type PlayerHandle,
  type SpawnFn,
} from "./audio.ts";
import { AudioCache, cacheKey, clipExtension } from "./cache.ts";
import {
  API_KEY_ENV,
  PROVIDER_HARD_LIMIT_CEILINGS,
  cacheDir,
  describeConfig,
  effectiveSpeechProvider,
  loadConfig,
  readApiKey,
  readProviderApiKey,
  type Env,
  type SpeakConfig,
  type SpeechProvider,
} from "./config.ts";
import { redact, synthesize } from "./elevenlabs.ts";
import { fetchQuota } from "./quota.ts";
import { NORMALIZER_VERSION, checkLength } from "./text.ts";
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
}

type Phase = "preparing" | "translating" | "generating" | "playing";

interface Job {
  controller: AbortController;
  speechProviderOverride?: SpeechProvider;
  phase: Phase;
  player?: PlayerHandle;
  ui: SpeakUi;
  recordFailure?: (record: TranslationFailureRecord) => void;
}

interface Clip {
  key: string;
  extension: string;
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
  private readonly translator = new Translator();
  private job: Job | undefined;
  private lastClip: Clip | undefined;
  private task: Promise<void> = Promise.resolve();
  private quotaRequest: AbortController | undefined;
  private quotaTask: Promise<void> = Promise.resolve();
  private speechProviderOverride: SpeechProvider | undefined;
  private inputProviderOverride: SpeechProvider | undefined;

  constructor(deps: SpeakDeps) {
    this.deps = deps;
  }

  /** Resolves when the current speech and quota work have ended. */
  async whenIdle(): Promise<void> {
    await Promise.all([this.task, this.quotaTask]);
  }

  speak(text: string, ui: SpeakUi): void {
    const job = this.begin(ui);
    if (job) this.task = this.run(job, () => this.generateAndPlay(job, text));
  }

  speakLocalized(
    text: string,
    ui: SpeakUi,
    registry: TranslationRegistry | undefined,
    recordFailure?: (record: TranslationFailureRecord) => void,
  ): void {
    const job = this.begin(ui, recordFailure);
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
    this.quotaRequest?.abort();
    this.quotaRequest = undefined;
  }

  async provider(
    kind: "speech" | "input",
    name: SpeechProvider | "reset" | undefined,
    ui: SpeakUi,
  ): Promise<void> {
    if (name !== undefined && name !== "reset" && name !== "elevenlabs" && name !== "deepgram") {
      ui.notify(kind === "speech" ? "Usage: /speak provider [elevenlabs|deepgram|reset]" : "Usage: /talk provider [deepgram|elevenlabs|reset]", "info");
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

  talkUsage(ui: SpeakUi): void {
    ui.notify("Usage: /talk provider [deepgram|elevenlabs|reset]", "info");
  }

  /** Quota is independent of speech; do not block Pi's stop command while waiting. */
  quota(ui: SpeakUi): void {
    if (this.quotaRequest) {
      ui.notify("A quota lookup is already pending.", "info");
      return;
    }
    const apiKey = readApiKey(this.deps.env);
    if (!apiKey) {
      ui.notify(
        `${API_KEY_ENV} is not set. Quota was not requested.`,
        "warning",
      );
      return;
    }
    const request = new AbortController();
    this.quotaRequest = request;
    ui.notify("Checking ElevenLabs quota...", "info");
    this.quotaTask = fetchQuota(apiKey, this.deps.fetchFn, request.signal)
      .then((result) => {
        if (this.quotaRequest === request)
          ui.notify(
            redact(result.message, apiKey),
            result.ok ? "info" : "error",
          );
      })
      .catch(() => undefined) // A replaced UI must not create an unhandled rejection.
      .finally(() => {
        if (this.quotaRequest === request) this.quotaRequest = undefined;
      });
  }

  async status(ui: SpeakUi): Promise<void> {
    const loaded = await loadConfig(
      this.deps.env,
      this.deps.readFile,
      this.deps.home,
    );
    const lines: string[] = [];
    if (loaded.ok) {
      const recordingTool =
        (await resolveExecutable("rec", this.deps.env)) ??
        (await resolveExecutable("arecord", this.deps.env)) ??
        (await resolveExecutable("ffmpeg", this.deps.env));
      lines.push(
        ...describeConfig(
          loaded.config,
          {
            elevenlabs: readProviderApiKey(this.deps.env, "elevenlabs") !== undefined,
            deepgram: readProviderApiKey(this.deps.env, "deepgram") !== undefined,
          },
          {
            speechProvider: this.speechProviderOverride,
            inputProviderOverride: this.inputProviderOverride,
            recordingTool: recordingTool ? recordingTool : "not found",
          },
        ),
      );
      const cache = this.cacheFor(loaded.config);
      try {
        const stats = await cache.stats();
        lines.push(
          `cache: ${cache.root} (${stats.files} clips, ${stats.bytes} bytes)`,
        );
      } catch {
        lines.push(`cache: ${cache.root} (unreadable)`);
      }
    } else {
      lines.push(`not configured: ${loaded.problem}`);
    }
    lines.push(`job: ${this.job ? this.job.phase : "idle"}`);
    ui.notify(lines.join("\n"), "info");
  }

  private begin(
    ui: SpeakUi,
    recordFailure?: (record: TranslationFailureRecord) => void,
  ): Job | undefined {
    if (this.job) {
      ui.notify(
        "Speech is already active. Use /speak stop to end it.",
        "warning",
      );
      return undefined;
    }
    const job: Job = {
      controller: new AbortController(),
      speechProviderOverride: this.speechProviderOverride,
      phase: "preparing",
      ui,
      recordFailure,
    };
    this.job = job;
    this.show(job, "preparing");
    return job;
  }

  private live(job: Job): boolean {
    return this.job === job;
  }

  private show(job: Job, text: Phase | undefined): void {
    try {
      job.ui.setWidget?.(
        PROGRESS_KEY,
        text === undefined ? undefined : [`Speech: ${PHASE_LABELS[text]}...`],
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

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redact(message, readApiKey(this.deps.env) ?? "").slice(0, 200);
  }

  private cacheFor(config: SpeakConfig): AudioCache {
    return new AudioCache({
      root: cacheDir(this.deps.env, this.deps.home),
      maxBytes: config.cache.maxBytes,
      ttlDays: config.cache.ttlDays,
      now: this.deps.now,
    });
  }

  /** Config, then the length limit, then the player: every check runs before any billable request. */
  private async preflight(
    job: Job,
    text?: string,
  ): Promise<SpeakConfig | undefined> {
    const loaded = await loadConfig(
      this.deps.env,
      this.deps.readFile,
      this.deps.home,
    );
    if (!this.live(job)) return undefined;
    if (!loaded.ok) {
      job.ui.notify(`Speech is not configured: ${loaded.problem}`, "warning");
      return undefined;
    }
    const provider = effectiveSpeechProvider(loaded.config, job.speechProviderOverride);
    if (provider === "deepgram") {
      job.ui.notify(
        "Deepgram speech is not available yet. Nothing was sent. Use /speak provider elevenlabs.",
        "warning",
      );
      return undefined;
    }
    const config: SpeakConfig = {
      ...loaded.config,
      provider,
      hardLimitChars: Math.min(
        loaded.config.hardLimitChars,
        PROVIDER_HARD_LIMIT_CEILINGS[provider],
      ),
    };
    if (text !== undefined) {
      const length = checkLength(text, config.hardLimitChars);
      if (!length.ok) {
        job.ui.notify(
          `That text is ${length.length} characters and the ${provider} limit is ${length.limit}. Nothing was sent. Use /speak text with a shorter passage.`,
          "warning",
        );
        return undefined;
      }
    }
    if (
      provider === "elevenlabs" &&
      (!config.providers.elevenlabs.voiceId || !config.providers.elevenlabs.modelId)
    ) {
      job.ui.notify(
        "ElevenLabs speech is not configured: set providers.elevenlabs.voiceId and providers.elevenlabs.modelId. Nothing was sent.",
        "warning",
      );
      return undefined;
    }
    const player = await resolveExecutable(
      config.player.command,
      this.deps.env,
    );
    if (!this.live(job)) return undefined;
    if (!player) {
      job.ui.notify(
        `The audio player "${config.player.command}" was not found. Install it or set player.command in the configuration. Nothing was sent.`,
        "warning",
      );
      return undefined;
    }
    return config;
  }

  private async generateAndPlay(
    job: Job,
    text: string,
    localized = false,
    registry?: TranslationRegistry,
  ): Promise<void> {
    const config = await this.preflight(job, text);
    if (!config) return;
    if (localized) {
      if (!readApiKey(this.deps.env)) {
        job.ui.notify(
          `${API_KEY_ENV} is not set. Nothing was sent.`,
          "warning",
        );
        return;
      }
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
    const clip: Clip = {
      key: cacheKey({
        text,
        provider: config.provider,
        voiceId: config.providers.elevenlabs.voiceId ?? "",
        modelId: config.providers.elevenlabs.modelId ?? "",
        outputFormat: config.providers.elevenlabs.outputFormat,
        voiceRevision: config.providers.elevenlabs.voiceRevision,
        normalizerVersion: NORMALIZER_VERSION,
        speechLocale: localized ? config.locale : "original",
      }),
      extension: clipExtension(config.providers.elevenlabs.outputFormat),
    };

    let path = await cache.get(clip.key, clip.extension);
    if (!this.live(job)) return;
    if (!path) {
      const apiKey = readApiKey(this.deps.env);
      if (!apiKey) {
        job.ui.notify(
          `${API_KEY_ENV} is not set. Nothing was sent.`,
          "warning",
        );
        return;
      }
      job.phase = "generating";
      this.show(job, "generating");
      const result = await synthesize(
        {
          text,
          voiceId: config.providers.elevenlabs.voiceId ?? "",
          modelId: config.providers.elevenlabs.modelId ?? "",
          outputFormat: config.providers.elevenlabs.outputFormat,
          apiKey,
          timeoutMs: config.requestTimeoutMs,
          signal: job.controller.signal,
        },
        this.deps.fetchFn,
      );
      if (!this.live(job)) return;
      if (!result.ok) {
        if (result.kind !== "cancelled") job.ui.notify(result.message, "error");
        return;
      }
      path = await cache.put(clip.key, clip.extension, result.bytes);
      if (!this.live(job)) return;
    }
    await this.playClip(job, config, cache, clip, path);
  }

  private async replayClip(job: Job, clip: Clip): Promise<void> {
    const config = await this.preflight(job);
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
    const exit = await player.done;
    if (exit.kind === "failed" && this.live(job))
      job.ui.notify(`Playback failed: ${exit.detail}`, "error");
  }
}
