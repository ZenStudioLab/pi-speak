/** Metadata only: never attach a provider error, message content, or credentials. */
export interface TranslationFailure {
  version: 1;
  code:
    | "setup"
    | "timeout"
    | "provider-error"
    | "provider-aborted"
    | "truncated"
    | "incomplete"
    | "unsupported-content"
    | "no-text"
    | "code-markup"
    | "output-length"
    | "unknown";
  stage: "setup" | "authentication" | "request" | "validation";
  timestamp: number;
  elapsedMs: number;
  provider?: string;
  model?: string;
  locale: string;
  thinking?: string;
  inferenceStarted: boolean;
  billingUncertain: boolean;
  maxTokens?: number;
  stopReason?:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred"
    | "unknown";
  blocks?: { text: number; thinking: number; tool: number; other: number };
}

export interface TranslationFailureRecord extends TranslationFailure {
  diagnosticId: string;
}

export class TranslationError extends Error {
  readonly failure: TranslationFailure | undefined;

  constructor(message: string, failure?: TranslationFailure) {
    super(message);
    this.name = "TranslationError";
    this.failure = failure;
  }
}
