import {
  describeConfig,
  loadConfig,
  readProviderApiKey,
  type SpeechProvider,
  type SpeakConfig,
} from "./config.ts";
import type { AudioCache } from "./cache.ts";
import { findRecorder } from "./record.ts";
import type { SpeakDeps, SpeakUi } from "./speech-job.ts";

/** The session state `/speak status` reports besides the configuration. */
export interface StatusState {
  speechProvider: SpeechProvider | undefined;
  inputProviderOverride: SpeechProvider | undefined;
  speechLocale: string | undefined;
  /** The phase of the running speech job, or undefined when idle. */
  jobPhase: string | undefined;
}

/** `/speak status`: redacted configuration, key presence, job state, and cache usage; no request is made. */
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
  lines.push(`job: ${state.jobPhase ?? "idle"}`);
  ui.notify(lines.join("\n"), "info");
}
