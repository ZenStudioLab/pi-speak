import {
  describeConfig,
  loadConfig,
  readProviderApiKey,
  type SpeechProvider,
  type SpeakConfig,
} from "./config.ts";
import type { AudioCache } from "./cache.ts";
import type { LivePhase } from "./live.ts";
import { findRecorder } from "./record.ts";
import type { SpeakDeps, SpeakUi } from "./speech-job.ts";

/** The session state `/speak status` reports besides the configuration. */
export interface StatusState {
  speechProvider: SpeechProvider | undefined;
  inputProviderOverride: SpeechProvider | undefined;
  speechLocale: string | undefined;
  /** Read after the awaits below, so it is the phase when the report is written; undefined when idle. */
  jobPhase: () => string | undefined;
  /** Read like `jobPhase`. */
  livePhase: () => LivePhase;
}

/** `/speak status`: redacted configuration, key presence, job and live mode state, and cache usage; no request is made. */
export async function reportStatus(
  deps: SpeakDeps,
  state: StatusState,
  cacheFor: (config: SpeakConfig) => AudioCache,
  ui: SpeakUi,
): Promise<void> {
  const loaded = await loadConfig(deps.env, deps.readFile, deps.home);
  const lines: string[] = [];
  if (loaded.ok) {
    const recordingTool = (await findRecorder(deps.env))?.path;
    lines.push(
      ...describeConfig(
        loaded.config,
        {
          elevenlabs: readProviderApiKey(deps.env, "elevenlabs") !== undefined,
          deepgram: readProviderApiKey(deps.env, "deepgram") !== undefined,
        },
        {
          speechProvider: state.speechProvider,
          inputProviderOverride: state.inputProviderOverride,
          speechLocale: state.speechLocale,
          recordingTool: recordingTool ? recordingTool : "not found",
        },
      ),
    );
    lines.push(
      `live idle limit: ${loaded.config.input.liveIdleMinutes} minutes`,
      `live listen while speaking: ${loaded.config.input.liveListenWhileSpeaking ? "on" : "off"}`,
    );
    const cache = cacheFor(loaded.config);
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
  lines.push(`live mode: ${state.livePhase()}`, `job: ${state.jobPhase() ?? "idle"}`);
  ui.notify(lines.join("\n"), "info");
}
