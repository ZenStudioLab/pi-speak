import {
  boundedRequest,
  MAX_RESPONSE_BYTES,
  providerStatus,
  readCapped,
  redact,
} from "./bounded-request.ts";

export const DEEPGRAM_ORIGIN = "https://api.deepgram.com";
export const MAX_AUDIO_BYTES = MAX_RESPONSE_BYTES;

export interface DeepgramSynthesisRequest {
  text: string;
  voice: string;
  apiKey: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type DeepgramSynthesisFailure =
  | "auth"
  | "permission"
  | "not-found"
  | "invalid"
  | "too-long"
  | "rate-limit"
  | "server"
  | "timeout"
  | "cancelled"
  | "network"
  | "redirect"
  | "bad-response"
  | "too-large";

export type DeepgramSynthesisResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: DeepgramSynthesisFailure; message: string };

const UNKNOWN_BILLING = "Whether the attempt was billed is unknown.";

const fail = (
  kind: DeepgramSynthesisFailure,
  message: string,
): DeepgramSynthesisResult => ({ ok: false, kind, message });

async function failureForStatus(
  response: Response,
  apiKey: string,
): Promise<DeepgramSynthesisResult> {
  const code = response.status;
  const detail = await providerStatus(response);
  const safe = (message: string) => redact(message, apiKey);
  if (code === 401)
    return fail(
      "auth",
      safe(`Deepgram rejected the API key (401)${detail}. Check DEEPGRAM_API_KEY.`),
    );
  if (code === 403)
    return fail(
      "permission",
      safe(`Deepgram denied access (403)${detail}. Check the key permissions.`),
    );
  if (code === 400 || code === 404)
    return fail(
      "not-found",
      safe(`Deepgram could not find the voice or model (HTTP ${code})${detail}. Check the Aura voice.`),
    );
  if (code === 413)
    return fail(
      "too-long",
      safe(`Deepgram rejected text longer than its 2000-character limit (413)${detail}. Use a shorter passage.`),
    );
  if (code === 429)
    return fail(
      "rate-limit",
      safe(`Deepgram reported a rate limit or quota problem (429)${detail}. Nothing was retried.`),
    );
  if (code >= 500)
    return fail(
      "server",
      `Deepgram had a server error (HTTP ${code}). Nothing was retried. ${UNKNOWN_BILLING}`,
    );
  return fail(
    "invalid",
    safe(`Deepgram rejected the request (HTTP ${code})${detail}.`),
  );
}

/** One bounded text-to-speech request to Deepgram's fixed production origin. */
export async function synthesize(
  request: DeepgramSynthesisRequest,
  fetchFn: typeof fetch = fetch,
): Promise<DeepgramSynthesisResult> {
  if (!request.apiKey.trim())
    return fail("auth", "DEEPGRAM_API_KEY is not set. Nothing was sent.");
  const url = `${DEEPGRAM_ORIGIN}/v1/speak?model=${encodeURIComponent(request.voice)}&encoding=mp3`;
  const result = await boundedRequest(
    fetchFn,
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${request.apiKey}`,
        "Content-Type": "application/json",
        accept: "audio/*",
      },
      body: JSON.stringify({ text: request.text }),
    },
    request.timeoutMs,
    request.signal,
    async (response) => {
      if (!response.ok) return undefined;
      const type = response.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("audio/")) return undefined;
      return readCapped(response);
    },
  );
  if (!result.ok) {
    if (result.kind === "cancelled")
      return fail("cancelled", "Speech generation was cancelled.");
    if (result.kind === "timeout")
      return fail(
        "timeout",
        `Deepgram did not finish within ${Math.round(request.timeoutMs / 1000)} s. The request was aborted and not retried. ${UNKNOWN_BILLING}`,
      );
    if (result.kind === "redirect")
      return fail(
        "redirect",
        "Deepgram answered with a redirect, which is not followed.",
      );
    return fail(
      "network",
      redact(
        `Could not reach Deepgram. The request was not retried. ${UNKNOWN_BILLING}`,
        request.apiKey,
      ),
    );
  }
  const response = result.response;
  if (!response.ok) return await failureForStatus(response, request.apiKey);
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("audio/"))
    return fail(
      "bad-response",
      "Deepgram returned something that is not audio, so it was discarded.",
    );
  const body = result.value;
  if (body === undefined)
    return fail(
      "bad-response",
      "Deepgram returned something that is not audio, so it was discarded.",
    );
  if (body === "too-large")
    return fail(
      "too-large",
      "The audio was larger than 20 MiB and was discarded.",
    );
  if (body.byteLength === 0)
    return fail("bad-response", "Deepgram returned empty audio.");
  return { ok: true, bytes: body };
}
