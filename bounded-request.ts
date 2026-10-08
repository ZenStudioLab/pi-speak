export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;

export type BoundedFailure = "timeout" | "cancelled" | "network" | "redirect";

export type BoundedRequestResult<T = undefined> =
  | {
      ok: true;
      response: Response;
      /** What `consume` returned; undefined when the response was an HTTP error. */
      value: T | undefined;
      /** The harmless provider status (see `providerStatus`) of an HTTP error, else empty. */
      detail: string;
    }
  | { ok: false; kind: BoundedFailure };

/**
 * Executes one request with a total deadline and without following redirects. The body is read
 * inside the same boundary: `consume` reads a successful response, and an HTTP error's body is
 * read here, so a body that stalls, is cancelled, or fails is classified like the request itself.
 */
export async function boundedRequest<T = undefined>(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  ownerSignal: AbortSignal,
  consume: (response: Response) => Promise<T> = async () => undefined as T,
): Promise<BoundedRequestResult<T>> {
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await fetchFn(url, {
      ...init,
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400)
      return { ok: false, kind: "redirect" };
    if (!response.ok)
      return { ok: true, response, value: undefined, detail: await providerStatus(response) };
    const value = await consume(response);
    return { ok: true, response, value, detail: "" };
  } catch {
    return {
      ok: false,
      kind: ownerSignal.aborted ? "cancelled" : signal.aborted ? "timeout" : "network",
    };
  }
}

/** Reads a response body incrementally and never retains more than the configured cap. */
export async function readCapped(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Uint8Array | "too-large"> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads only a bounded, structured provider status; arbitrary response text is discarded.
 * A body that cannot be read rejects, so the caller's deadline handling classifies it.
 */
export async function providerStatus(response: Response): Promise<string> {
  const body = await readCapped(response, MAX_ERROR_BODY_BYTES);
  if (body === "too-large") return "";
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as {
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

/** Replaces every occurrence of a key so no displayed message can leak it. */
export function redact(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.split(apiKey).join("[redacted]");
}
