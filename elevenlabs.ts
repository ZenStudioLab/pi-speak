export const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;

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

/** Replaces every occurrence of the key so no message can leak it. */
export function redact(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.split(apiKey).join("[redacted]");
}

/** A provider error status such as `quota_exceeded`, only when it has a harmless shape. */
async function providerStatus(response: Response): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      detail?: { status?: unknown };
    };
    const status = parsed?.detail?.status;
    return typeof status === "string" && /^[a-z_]{3,40}$/.test(status)
      ? ` (${status})`
      : "";
  } catch {
    return "";
  }
}

async function failureForStatus(response: Response): Promise<SynthesisResult> {
  const code = response.status;
  if (code >= 300 && code < 400)
    return fail(
      "redirect",
      "ElevenLabs answered with a redirect, which is not followed.",
    );
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

async function readCapped(
  response: Response,
): Promise<Uint8Array | "too-large"> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * One text-to-speech request to the fixed production origin. No redirect is followed, no
 * retry is attempted, and the result is accepted only as nonempty audio within the size cap.
 */
export async function synthesize(
  request: SynthesisRequest,
  fetchFn: typeof fetch = fetch,
): Promise<SynthesisResult> {
  const { apiKey } = request;
  const url =
    `${ELEVENLABS_ORIGIN}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}` +
    `?output_format=${encodeURIComponent(request.outputFormat)}`;
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(request.timeoutMs),
  ]);

  const interrupted = (): SynthesisResult =>
    request.signal.aborted
      ? fail("cancelled", "Speech generation was cancelled.")
      : fail(
          "timeout",
          `ElevenLabs did not finish within ${Math.round(request.timeoutMs / 1000)} s. The request was aborted and not retried. ${UNKNOWN_BILLING}`,
        );

  try {
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/*",
      },
      body: JSON.stringify({ text: request.text, model_id: request.modelId }),
    });
    if (!response.ok) return await failureForStatus(response);
    const type = response.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("audio/"))
      return fail(
        "bad-response",
        "ElevenLabs returned something that is not audio, so it was discarded.",
      );
    const body = await readCapped(response);
    if (body === "too-large")
      return fail(
        "too-large",
        "The audio was larger than the 10 MiB limit and was discarded.",
      );
    if (body.byteLength === 0)
      return fail("bad-response", "ElevenLabs returned empty audio.");
    return { ok: true, bytes: body };
  } catch {
    if (signal.aborted) return interrupted();
    return fail(
      "network",
      redact(
        `Could not reach ElevenLabs. The request was not retried. ${UNKNOWN_BILLING}`,
        apiKey,
      ),
    );
  }
}
