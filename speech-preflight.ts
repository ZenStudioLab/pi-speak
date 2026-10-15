import { resolveExecutable } from "./audio.ts";
import {
  API_KEY_ENV,
  PROVIDER_HARD_LIMIT_CEILINGS,
  effectiveSpeechProvider,
  loadConfig,
  readProviderApiKey,
  type SpeakConfig,
  type SpeechProvider,
} from "./config.ts";
import type { SpeakDeps, SpeakUi } from "./speech-job.ts";
import { checkLength } from "./text.ts";

/** The most characters one speech request may carry: the configured limit, capped by the provider's own ceiling. */
export const effectiveHardLimit = (config: SpeakConfig, provider: SpeechProvider): number =>
  Math.min(config.hardLimitChars, PROVIDER_HARD_LIMIT_CEILINGS[provider]);

/** What preflight reads of a job. */
export interface PreflightJob {
  ui: SpeakUi;
  speechProviderOverride?: SpeechProvider;
  /** The one-command or session locale; undefined means the configured one. */
  locale?: string;
  /** False once another job or a cancel has replaced this one. */
  isCurrent(): boolean;
}

/**
 * Config, then the length limit, then the player: every check runs before any billable request.
 * Returns undefined, after telling the user why, when the job must not go on or is no longer current.
 */
export async function preflightSpeech(
  deps: SpeakDeps,
  job: PreflightJob,
  text?: string,
  generation = true,
  localized = false,
): Promise<SpeakConfig | undefined> {
  const loaded = await loadConfig(deps.env, deps.readFile, deps.home);
  if (!job.isCurrent()) return undefined;
  if (!loaded.ok) {
    job.ui.notify(`Speech is not configured: ${loaded.problem}`, "warning");
    return undefined;
  }
  const provider = effectiveSpeechProvider(loaded.config, job.speechProviderOverride);
  const config: SpeakConfig = {
    ...loaded.config,
    provider,
    locale: job.locale ?? loaded.config.locale,
    hardLimitChars: effectiveHardLimit(loaded.config, provider),
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
  if (generation) {
    const apiKey = readProviderApiKey(deps.env, provider);
    if (localized && !apiKey) {
      job.ui.notify(
        `${provider === "elevenlabs" ? API_KEY_ENV : "DEEPGRAM_API_KEY"} is not set. Nothing was sent.`,
        "warning",
      );
      return undefined;
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
    if (provider === "deepgram") {
      const voice = config.providers.deepgram.voice;
      if (
        !voice ||
        voice === "SET_YOUR_AUTHORIZED_VOICE_ID" ||
        !/-[a-z]{2}$/i.test(voice)
      ) {
        job.ui.notify(
          "Deepgram speech is not configured: set providers.deepgram.voice to an authorized voice ending in -<lang>. Nothing was sent.",
          "warning",
        );
        return undefined;
      }
    }
    if (localized && provider === "deepgram") {
      const voice = config.providers.deepgram.voice!;
      const voiceLanguage = voice.slice(voice.lastIndexOf("-") + 1).toLowerCase();
      const localeLanguage = config.locale.split("-")[0]!.toLowerCase();
      if (voiceLanguage !== localeLanguage) {
        job.ui.notify(
          `Deepgram voice language ${voiceLanguage} does not match locale ${config.locale} (primary language ${localeLanguage}). Use /speak original or another provider. Nothing was sent.`,
          "warning",
        );
        return undefined;
      }
    }
  }
  const player = await resolveExecutable(config.player.command, deps.env);
  if (!job.isCurrent()) return undefined;
  if (!player) {
    job.ui.notify(
      `The audio player "${config.player.command}" was not found. Install it or set player.command in the configuration. Nothing was sent.`,
      "warning",
    );
    return undefined;
  }
  return config;
}
