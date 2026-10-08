import {
  MAX_TRANSCRIPT_RESPONSE_BYTES,
  readCapped,
  redact,
  type BoundedFailure,
} from "./bounded-request.ts";

/** What both providers' transcription clients accept and return. */
export interface TranscriptionRequest {
  /** One complete WAV file. */
  wav: Uint8Array<ArrayBuffer>;
  model: string;
  /** Canonical BCP-47 tag; when omitted the provider detects the language. */
  language?: string;
  apiKey: string;
  timeoutMs: number;
  /** The owning recording's cancellation signal. */
  signal: AbortSignal;
}

export type TranscriptionFailure =
  | "auth"
  | "permission"
  | "not-found"
  | "invalid"
  | "rate-limit"
  | "server"
  | "timeout"
  | "cancelled"
  | "network"
  | "redirect"
  | "bad-response"
  | "too-large";

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; kind: TranscriptionFailure; message: string };

export interface TranscriptionProvider {
  name: "Deepgram" | "ElevenLabs";
  keyEnv: string;
  /** The configuration key that names the transcription model. */
  modelSetting: string;
}

const UNKNOWN_BILLING = "Whether the attempt was billed is unknown.";

export const transcriptionFailure = (
  kind: TranscriptionFailure,
  message: string,
): TranscriptionResult => ({ ok: false, kind, message });

export function missingKey(provider: TranscriptionProvider): TranscriptionResult {
  return transcriptionFailure(
    "auth",
    `${provider.keyEnv} is not set. Nothing was sent.`,
  );
}

/** Maps a failure of the request itself (not an HTTP status) to a sanitized result. */
export function transportFailure(
  provider: TranscriptionProvider,
  kind: BoundedFailure,
  timeoutMs: number,
  apiKey: string,
): TranscriptionResult {
  if (kind === "cancelled")
    return transcriptionFailure("cancelled", "Transcription was cancelled.");
  if (kind === "timeout")
    return transcriptionFailure(
      "timeout",
      `${provider.name} did not finish within ${Math.round(timeoutMs / 1000)} s. The request was aborted and not retried. ${UNKNOWN_BILLING}`,
    );
  if (kind === "redirect")
    return transcriptionFailure(
      "redirect",
      `${provider.name} answered with a redirect, which is not followed.`,
    );
  return transcriptionFailure(
    "network",
    redact(
      `Could not reach ${provider.name}. The request was not retried. ${UNKNOWN_BILLING}`,
      apiKey,
    ),
  );
}

/** Maps an HTTP error to a sanitized result; the provider's free text is never shown. */
export function statusFailure(
  provider: TranscriptionProvider,
  code: number,
  detail: string,
  apiKey: string,
): TranscriptionResult {
  const { name } = provider;
  const safe = (kind: TranscriptionFailure, message: string) =>
    transcriptionFailure(kind, redact(message, apiKey));
  if (code === 401)
    return safe(
      "auth",
      `${name} rejected the API key (401)${detail}. Check ${provider.keyEnv}.`,
    );
  if (code === 403)
    return safe(
      "permission",
      `${name} denied access (403)${detail}. The key or plan may not allow transcription.`,
    );
  if (code === 404)
    return safe(
      "not-found",
      `${name} could not find the transcription model (404)${detail}. Check ${provider.modelSetting}.`,
    );
  if (code === 429)
    return safe(
      "rate-limit",
      `${name} reported a rate limit or quota problem (429)${detail}. Nothing was retried.`,
    );
  if (code >= 500)
    return transcriptionFailure(
      "server",
      `${name} had a server error (HTTP ${code}). Nothing was retried. ${UNKNOWN_BILLING}`,
    );
  return safe("invalid", `${name} rejected the request (HTTP ${code})${detail}.`);
}

/** Reads a transcription response of at most 1 MiB; anything but a JSON document is `invalid`. */
export async function readJson(
  response: Response,
): Promise<{ json: unknown } | "too-large" | "invalid"> {
  const body = await readCapped(response, MAX_TRANSCRIPT_RESPONSE_BYTES);
  if (body === "too-large") return "too-large";
  try {
    return { json: JSON.parse(Buffer.from(body).toString("utf8")) as unknown };
  } catch {
    return "invalid";
  }
}

/** Turns the outcome of `readJson` into a transcript, or a sanitized failure naming the provider. */
export function transcriptFrom(
  provider: TranscriptionProvider,
  body: Awaited<ReturnType<typeof readJson>> | undefined,
  pick: (json: unknown) => unknown,
): TranscriptionResult {
  if (body === "too-large")
    return transcriptionFailure(
      "too-large",
      "The transcription response was larger than 1 MiB and was discarded.",
    );
  const text = body === undefined || body === "invalid" ? undefined : pick(body.json);
  if (typeof text !== "string")
    return transcriptionFailure(
      "bad-response",
      `${provider.name} returned something that is not a transcript, so it was discarded.`,
    );
  return { ok: true, text: text.trim() };
}
