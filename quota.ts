import { ELEVENLABS_ORIGIN } from "./elevenlabs.ts";

const MAX_QUOTA_BYTES = 64 * 1024;
export const QUOTA_TIMEOUT_MS = 10_000;

export type QuotaResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

const invalid = (): QuotaResult => ({
  ok: false,
  message:
    "ElevenLabs returned an invalid quota response. No quota or cost was estimated.",
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function allowance(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function currency(value: unknown): string | undefined {
  return typeof value === "string" && /^(usd|eur|inr|pln|gbp)$/.test(value)
    ? value.toUpperCase()
    : undefined;
}

function formatQuota(value: unknown): QuotaResult {
  const data = object(value);
  const used = data.character_count;
  const limit = data.character_limit;
  if (!allowance(used) || !allowance(limit)) return invalid();
  const reset = data.next_character_count_reset_unix;
  const resetDate =
    allowance(reset) && reset <= 8_640_000_000_000
      ? new Date(reset * 1000).toISOString()
      : "unavailable";
  const overage = object(data.current_overage);
  const overageCurrency = currency(overage.currency);
  const amount = overage.amount;
  const overageCost =
    typeof amount === "string" &&
    amount.length <= 40 &&
    /^\d+(\.\d+)?$/.test(amount) &&
    overageCurrency
      ? `${amount} ${overageCurrency}`
      : "unavailable";
  const invoice = object(data.next_invoice);
  const invoiceCurrency = currency(data.currency);
  const cents = invoice.amount_due_cents;
  const invoiceCost =
    typeof cents === "number" && Number.isSafeInteger(cents) && invoiceCurrency
      ? `${(cents / 100).toFixed(2)} ${invoiceCurrency}`
      : "unavailable";
  const count = (n: number) => n.toLocaleString("en-US");
  return {
    ok: true,
    message: [
      "ElevenLabs quota (account-wide, not just /speak):",
      `credits used: ${count(used)} / ${count(limit)}`,
      `credits remaining: ${count(Math.max(0, limit - used))}`,
      `usage: ${limit > 0 ? `${((used / limit) * 100).toFixed(1)}%` : "unavailable (zero allowance)"}`,
      ...(used > limit
        ? [`over allowance: ${count(used - limit)} credits`]
        : []),
      `next reset (UTC): ${resetDate}`,
      `current overage (provider-reported): ${overageCost}`,
      `next invoice (provider-reported): ${invoiceCost}`,
      "Per-speech cost and PAYG balance/total spend: unavailable from this lookup.",
      "Credits are not a guaranteed number of speech characters. Invoice and overage are not added together.",
    ].join("\n"),
  };
}

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function quotaFailure(
  response: Response,
  apiKey: string,
): Promise<QuotaResult> {
  // Preserve the HTTP evidence even if the error body cannot be read or parsed.
  let detail: Record<string, unknown> = {};
  try {
    detail = object(object(await readJson(response, 4096)).detail);
  } catch {
    // Only structured, bounded identifiers are useful; arbitrary error text is not.
  }
  const fields = ["type", "code", "status"] as const;
  const safe = fields.flatMap((name) => {
    const value = detail[name];
    return typeof value === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(value) &&
      (apiKey === "" || !value.includes(apiKey))
      ? [{ name, value }]
      : [];
  });
  const values = safe.map(({ value }) => value);
  const code = response.status;
  const evidence = safe.map(({ name, value }) => `; ${name}=${value}`).join("");
  let guidance = "";
  if (
    values.includes("missing_permissions") ||
    values.includes("authorization_error")
  )
    guidance =
      " The provider reports missing access. Check this key's subscription-read permissions.";
  else if (
    values.includes("authentication_error") ||
    values.includes("invalid_api_key")
  )
    guidance =
      " The provider reports authentication failure. Check this Pi process's ELEVENLABS_API_KEY and the key's validity.";
  else if (code === 401)
    guidance =
      " The specific authentication/access cause was not supplied or could not be read.";
  else if (code === 403)
    guidance =
      " ElevenLabs denied subscription access; the specific restriction is unconfirmed.";
  else if (code === 429) guidance = " The request was rate-limited.";
  else if (code >= 300 && code < 400)
    guidance = " The redirect was not followed.";
  else if (code >= 500) guidance = " ElevenLabs reported a server error.";
  return {
    ok: false,
    message: `ElevenLabs quota lookup failed (HTTP ${code}${evidence}).${guidance} No retry was made.`,
  };
}

/** One read-only account lookup; no speech, retries, raw errors or account-data storage. */
export async function fetchQuota(
  apiKey: string,
  fetchFn: typeof fetch,
  cancellation: AbortSignal,
  timeoutMs = QUOTA_TIMEOUT_MS,
): Promise<QuotaResult> {
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(timeoutMs),
  ]);
  try {
    const response = await fetchFn(
      `${ELEVENLABS_ORIGIN}/v1/user/subscription`,
      {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "xi-api-key": apiKey, accept: "application/json" },
      },
    );
    if (!response.ok) return await quotaFailure(response, apiKey);
    return formatQuota(await readJson(response, MAX_QUOTA_BYTES));
  } catch {
    return {
      ok: false,
      message: signal.aborted
        ? "ElevenLabs quota lookup was cancelled or timed out. No retry was made."
        : "ElevenLabs quota lookup failed; the request cause is unknown. No retry was made.",
    };
  }
}
