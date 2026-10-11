import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { TranslationRegistry } from "../translation.ts";

export const TRANSLATION_CONFIG = {
  provider: "test-provider",
  model: "test-translator",
};
export const translatedMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "test-provider",
  model: "test-translator",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

/** Registry boundary inputs, not an implementation of translation. */
export function translationFixture() {
  const model = {
    provider: "test-provider",
    id: "test-translator",
    maxTokens: 8192,
  } as Model<Api>;
  const calls: {
    model: Model<Api>;
    context: Context;
    options: ModelsSimpleStreamOptions;
  }[] = [];
  const lookups: [string, string][] = [];
  let behavior: () => Promise<AssistantMessage> = async () =>
    translatedMessage("Bản dựng chưa vượt qua kiểm tra ở phiên bản 1.2.3.");
  let authenticated = true,
    found = true,
    resolved = true;
  const registry: TranslationRegistry = {
    find(provider, id) {
      lookups.push([provider, id]);
      return found ? model : undefined;
    },
    hasConfiguredAuth() {
      return authenticated;
    },
    async getApiKeyAndHeaders() {
      return resolved
        ? { ok: true, apiKey: "hidden-translation-key" }
        : { ok: false, error: "hidden-auth-error" };
    },
    // SAFETY: translation only uses the stream's result(); no fake stream events are needed.
    streamSimple(selected, context, options) {
      calls.push({ model: selected, context, options: options! });
      return { result: () => behavior() } as ReturnType<
        TranslationRegistry["streamSimple"]
      >;
    },
  };
  return {
    registry,
    model,
    calls,
    lookups,
    setResult(next: () => Promise<AssistantMessage>) {
      behavior = next;
    },
    missingModel() {
      found = false;
    },
    missingAuth() {
      authenticated = false;
    },
    failedAuth() {
      resolved = false;
    },
  };
}
