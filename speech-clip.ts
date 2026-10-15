import { cacheKey, clipExtension } from "./cache.ts";
import type { SpeakConfig } from "./config.ts";
import { synthesize as synthesizeDeepgram } from "./deepgram.ts";
import { synthesize as synthesizeElevenLabs } from "./elevenlabs.ts";
import { NORMALIZER_VERSION } from "./text.ts";

/** Where a spoken clip lives in the cache. */
export interface Clip {
  key: string;
  extension: string;
}

/** The cache identity of `text` spoken with the effective provider, voice, format, and locale. */
export function clipFor(config: SpeakConfig, text: string, localized: boolean): Clip {
  return {
    key: cacheKey({
      text,
      provider: config.provider,
      voiceId:
        config.provider === "elevenlabs"
          ? config.providers.elevenlabs.voiceId ?? ""
          : config.providers.deepgram.voice ?? "",
      modelId:
        config.provider === "elevenlabs"
          ? config.providers.elevenlabs.modelId ?? ""
          : "aura",
      outputFormat:
        config.provider === "elevenlabs"
          ? config.providers.elevenlabs.outputFormat
          : "mp3",
      voiceRevision:
        config.provider === "elevenlabs"
          ? config.providers.elevenlabs.voiceRevision
          : 0,
      normalizerVersion: NORMALIZER_VERSION,
      speechLocale: localized ? config.locale : "original",
    }),
    extension: config.provider === "elevenlabs"
      ? clipExtension(config.providers.elevenlabs.outputFormat)
      : "mp3",
  };
}

/** One synthesis request to the effective provider. */
export function synthesizeClip(
  config: SpeakConfig,
  text: string,
  apiKey: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
) {
  return config.provider === "elevenlabs"
    ? synthesizeElevenLabs(
        {
          text,
          voiceId: config.providers.elevenlabs.voiceId ?? "",
          modelId: config.providers.elevenlabs.modelId ?? "",
          outputFormat: config.providers.elevenlabs.outputFormat,
          apiKey,
          timeoutMs: config.requestTimeoutMs,
          signal,
        },
        fetchFn,
      )
    : synthesizeDeepgram(
        {
          text,
          voice: config.providers.deepgram.voice ?? "",
          apiKey,
          timeoutMs: config.requestTimeoutMs,
          signal,
        },
        fetchFn,
      );
}
