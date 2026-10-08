import {
  boundedRequest,
  MAX_RESPONSE_BYTES,
  providerStatus,
  readCapped,
  redact,
} from "./bounded-request.ts";

export const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
export const MAX_AUDIO_BYTES = MAX_RESPONSE_BYTES;

export interface SynthesisRequest {
  text: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  apiKey: string;
  timeoutMs: number;
  /** The owning job's cancellation signal. */
  signal: AbortSignal;
}

export type SynthesisFailure =
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

export type SynthesisResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: SynthesisFailure; message: string };

const UNKNOWN_BILLING = "Whether the attempt was billed is unknown.";

const fail = (kind: SynthesisFailure, message: string): SynthesisResult => ({
  ok: false,
  kind,
  message,
});

async function failureForStatus(response: Response): Promise<SynthesisResult> {
  const code = response.status;
  const detail = await providerStatus(response);
  if (code === 401)
    return fail(
      "auth",
      `ElevenLabs rejected the API key (401)${detail}. Check ELEVENLABS_API_KEY.`,
    );
  if (code === 403)
    return fail(
      "permission",
      `ElevenLabs denied access (403)${detail}. The key or plan may not allow this voice or model.`,
    );
  if (code === 404)
    return fail(
      "not-found",
      `ElevenLabs could not find the voice or model (404)${detail}. Check voiceId and modelId.`,
    );
  if (code === 429)
    return fail(
      "rate-limit",
      `ElevenLabs reported a rate limit or quota problem (429)${detail}. Nothing was retried.`,
    );
  if (code >= 500)
    return fail(
      "server",
      `ElevenLabs had a server error (HTTP ${code}). Nothing was retried. ${UNKNOWN_BILLING}`,
    );
  return fail(
    "invalid",
    `ElevenLabs rejected the request (HTTP ${code})${detail}.`,
  );
}

/** One bounded text-to-speech request to the fixed production origin. */
export async function synthesize(
  request: SynthesisRequest,
  fetchFn: typeof fetch = fetch,
): Promise<SynthesisResult> {
  const url =
    `${ELEVENLABS_ORIGIN}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}` +
    `?output_format=${encodeURIComponent(request.outputFormat)}`;
  const result = await boundedRequest(
    fetchFn,
    url,
    {
      method: "POST",
      headers: {
        "xi-api-key": request.apiKey,
        "content-type": "application/json",
        accept: "audio/*",
      },
      body: JSON.stringify({ text: request.text, model_id: request.modelId }),
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
        `ElevenLabs did not finish within ${Math.round(request.timeoutMs / 1000)} s. The request was aborted and not retried. ${UNKNOWN_BILLING}`,
      );
    if (result.kind === "redirect")
      return fail(
        "redirect",
        "ElevenLabs answered with a redirect, which is not followed.",
      );
    return fail(
      "network",
      redact(
        `Could not reach ElevenLabs. The request was not retried. ${UNKNOWN_BILLING}`,
        request.apiKey,
      ),
    );
  }
  const response = result.response;
  if (!response.ok) return await failureForStatus(response);
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("audio/"))
    return fail(
      "bad-response",
      "ElevenLabs returned something that is not audio, so it was discarded.",
    );
  const body = result.value;
  if (body === undefined)
    return fail(
      "bad-response",
      "ElevenLabs returned something that is not audio, so it was discarded.",
    );
  if (body === "too-large")
    return fail(
      "too-large",
      "The audio was larger than 20 MiB and was discarded.",
    );
  if (body.byteLength === 0)
    return fail("bad-response", "ElevenLabs returned empty audio.");
  return { ok: true, bytes: body };
}

export { redact } from "./bounded-request.ts";
