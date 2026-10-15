import { API_KEY_ENV, readApiKey } from "./config.ts";
import { redact } from "./elevenlabs.ts";
import { fetchQuota } from "./quota.ts";
import type { SpeakDeps, SpeakUi } from "./speech-job.ts";

/** The one pending `/speak quota` lookup, which is independent of speech jobs and never blocks `/speak stop`. */
export class QuotaLookup {
  private readonly deps: Pick<SpeakDeps, "env" | "fetchFn">;
  private request: AbortController | undefined;
  private task: Promise<void> = Promise.resolve();

  constructor(deps: Pick<SpeakDeps, "env" | "fetchFn">) {
    this.deps = deps;
  }

  /** Resolves when the current lookup has ended. */
  whenDone(): Promise<void> {
    return this.task;
  }

  start(ui: SpeakUi): void {
    if (this.request) {
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
    this.request = request;
    ui.notify("Checking ElevenLabs quota...", "info");
    this.task = fetchQuota(apiKey, this.deps.fetchFn, request.signal)
      .then((result) => {
        if (this.request === request)
          ui.notify(
            redact(result.message, apiKey),
            result.ok ? "info" : "error",
          );
      })
      .catch(() => undefined) // A replaced UI must not create an unhandled rejection.
      .finally(() => {
        if (this.request === request) this.request = undefined;
      });
  }

  /** Abandons the pending lookup; its result is no longer shown. */
  cancel(): void {
    this.request?.abort();
    this.request = undefined;
  }
}
