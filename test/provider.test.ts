import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_AUDIO_BYTES,
  redact,
  synthesize,
  transcribe as transcribeElevenLabs,
  type SynthesisRequest,
} from "../elevenlabs.ts";
import {
  synthesize as synthesizeDeepgram,
  transcribe as transcribeDeepgram,
  type DeepgramSynthesisRequest,
} from "../deepgram.ts";
import type { TranscriptionRequest } from "../transcription.ts";
import { API_KEY, audioResponse } from "./harness.ts";

const request = (
  overrides: Partial<SynthesisRequest> = {},
): SynthesisRequest => ({
  text: "Hello there.",
  voiceId: "voice123456",
  modelId: "eleven_flash_v2_5",
  outputFormat: "mp3_44100_128",
  apiKey: API_KEY,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  ...overrides,
});

function recordingFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("sends one request of the documented shape to the fixed origin and returns the audio", async () => {
  const { calls, fetchFn } = recordingFetch(async () => audioResponse());
  const result = await synthesize(request(), fetchFn);
  assert.ok(result.ok);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.elevenlabs.io/v1/text-to-speech/voice123456?output_format=mp3_44100_128",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["xi-api-key"],
    API_KEY,
  );
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    text: "Hello there.",
    model_id: "eleven_flash_v2_5",
  });
});

test("the voice ID cannot change the destination", async () => {
  const { calls, fetchFn } = recordingFetch(async () => audioResponse());
  await synthesize(request({ voiceId: "../evil?x=1#" }), fetchFn);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://api.elevenlabs.io");
  assert.equal(url.pathname, "/v1/text-to-speech/..%2Fevil%3Fx%3D1%23");
});

const failures: [string, () => Response, string, RegExp][] = [
  [
    "401",
    () => new Response("{}", { status: 401 }),
    "auth",
    /rejected the API key/,
  ],
  [
    "403",
    () => new Response("{}", { status: 403 }),
    "permission",
    /denied access/,
  ],
  [
    "404",
    () => new Response("{}", { status: 404 }),
    "not-found",
    /voice or model/,
  ],
  ["422", () => new Response("{}", { status: 422 }), "invalid", /HTTP 422/],
  [
    "429",
    () => new Response("{}", { status: 429 }),
    "rate-limit",
    /Nothing was retried/,
  ],
  [
    "500",
    () => new Response("{}", { status: 500 }),
    "server",
    /billed is unknown/,
  ],
  [
    "a redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    "redirect",
    /not followed/,
  ],
  [
    "a JSON body with 200",
    () =>
      new Response('{"detail":"nope"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    "bad-response",
    /not audio/,
  ],
  [
    "an empty audio body",
    () =>
      new Response(new Uint8Array(), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    "bad-response",
    /empty audio/,
  ],
];
for (const [name, respond, kind, message] of failures)
  test(`${name} fails as ${kind} after exactly one request and never echoes the key`, async () => {
    const { calls, fetchFn } = recordingFetch(async () => respond());
    const result = await synthesize(request(), fetchFn);
    assert.ok(!result.ok);
    assert.equal(result.kind, kind);
    assert.match(result.message, message);
    assert.doesNotMatch(result.message, new RegExp(API_KEY));
    assert.equal(calls.length, 1, "no automatic retry");
  });

test("only a harmless provider status code is surfaced, never the provider's free text", async () => {
  const body = (status: string) =>
    JSON.stringify({ detail: { status, message: `leaked ${API_KEY}` } });
  const quota = await synthesize(
    request(),
    async () => new Response(body("quota_exceeded"), { status: 429 }),
  );
  assert.ok(!quota.ok);
  assert.match(quota.message, /\(quota_exceeded\)/);
  assert.doesNotMatch(quota.message, new RegExp(API_KEY));
  const odd = await synthesize(
    request(),
    async () =>
      new Response(body("<script>alert(1)</script>"), { status: 429 }),
  );
  assert.ok(!odd.ok);
  assert.doesNotMatch(odd.message, /script/);
});

test("an oversize response is cut off and discarded", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
    },
  });
  const result = await synthesize(
    request(),
    async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  assert.ok(!result.ok);
  assert.equal(result.kind, "too-large");
  assert.ok(
    pulls <= MAX_AUDIO_BYTES / chunk.byteLength + 3,
    `read ${pulls} chunks`,
  );
});

test("a request that outlives the deadline is aborted, reported as unknown-billing, and not retried", async () => {
  const { calls, fetchFn } = recordingFetch(
    () => new Promise<Response>(() => undefined),
  );
  // fetch rejects when its signal fires, as the real one does.
  const abortable = ((url: string | URL, init?: RequestInit) => {
    const pending = fetchFn(url, init);
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("timed out", "TimeoutError")),
      );
      void pending.then(resolve);
    });
  }) as typeof fetch;
  // AbortSignal.timeout uses an unref'd timer; Pi's loop is always alive, a bare test process is not.
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    const result = await synthesize(request({ timeoutMs: 30 }), abortable);
    assert.ok(!result.ok);
    assert.equal(result.kind, "timeout");
    assert.match(result.message, /billed is unknown/);
    assert.equal(calls.length, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the owning job's abort is reported as cancelled, not as a failure", async () => {
  const controller = new AbortController();
  const hanging = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    })) as typeof fetch;
  const pending = synthesize(request({ signal: controller.signal }), hanging);
  controller.abort();
  const result = await pending;
  assert.ok(!result.ok);
  assert.equal(result.kind, "cancelled");
});

test("a network error is reported without an automatic retry and without the key", async () => {
  const { calls, fetchFn } = recordingFetch(async () => {
    throw new TypeError(`fetch failed for ${API_KEY}`);
  });
  const result = await synthesize(request(), fetchFn);
  assert.ok(!result.ok);
  assert.equal(result.kind, "network");
  assert.doesNotMatch(result.message, new RegExp(API_KEY));
  assert.equal(calls.length, 1);
});

const deepgramRequest = (
  overrides: Partial<DeepgramSynthesisRequest> = {},
): DeepgramSynthesisRequest => ({
  text: "Hello there.",
  voice: "aura-2-thalia-en",
  apiKey: API_KEY,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  ...overrides,
});

test("Deepgram sends one fixed Aura MP3 request and returns audio", async () => {
  const { calls, fetchFn } = recordingFetch(async () => audioResponse());
  const result = await synthesizeDeepgram(deepgramRequest(), fetchFn);
  assert.ok(result.ok);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(calls[0].url, "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { text: "Hello there." });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Token ${API_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
});

for (const [name, response, kind, message] of [
  ["JSON error document", () => new Response('{"error":"nope"}', { status: 200, headers: { "content-type": "application/json" } }), "bad-response", /not audio/],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }), "redirect", /not followed/],
  ["authentication failure", () => new Response("{}", { status: 401 }), "auth", /rejected the API key/],
] as const)
  test(`Deepgram ${name} is sanitized and not retried`, async () => {
    const { calls, fetchFn } = recordingFetch(async () => response());
    const result = await synthesizeDeepgram(deepgramRequest(), fetchFn);
    assert.ok(!result.ok);
    assert.equal(result.kind, kind);
    assert.match(result.message, message);
    assert.doesNotMatch(result.message, new RegExp(API_KEY));
    assert.equal(calls.length, 1);
  });

test("Deepgram missing key makes no request", async () => {
  const { calls, fetchFn } = recordingFetch(async () => audioResponse());
  const result = await synthesizeDeepgram(deepgramRequest({ apiKey: "" }), fetchFn);
  assert.ok(!result.ok);
  assert.equal(result.kind, "auth");
  assert.equal(calls.length, 0);
});

test("Deepgram timeout is unknown-billing and makes no ElevenLabs request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true }),
    );
  }) as typeof fetch;
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    const result = await synthesizeDeepgram(deepgramRequest({ timeoutMs: 20 }), fetchFn);
    assert.ok(!result.ok);
    assert.equal(result.kind, "timeout");
    assert.match(result.message, /billed is unknown/);
    assert.equal(calls.length, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("redact removes every occurrence of the key", () => {
  assert.equal(
    redact(`a ${API_KEY} b ${API_KEY}`, API_KEY),
    "a [redacted] b [redacted]",
  );
  assert.equal(redact("nothing here", ""), "nothing here");
});

const transcriptionRequest = (
  overrides: Partial<TranscriptionRequest> = {},
): TranscriptionRequest => ({
  wav: new Uint8Array([82, 73, 70, 70, 1, 2, 3]),
  model: "stt-model",
  apiKey: API_KEY,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const deepgramTranscript = (transcript: string) =>
  json({ results: { channels: [{ alternatives: [{ transcript }] }] } });
const elevenLabsTranscript = (text: string) => json({ text, language_code: "vie" });

test("Deepgram transcription uploads the WAV once with the model and the configured language", async () => {
  const { calls, fetchFn } = recordingFetch(async () => deepgramTranscript(" xin chào "));
  const result = await transcribeDeepgram(
    transcriptionRequest({ model: "nova-3", language: "vi" }),
    fetchFn,
  );
  assert.deepEqual(result, { ok: true, text: "xin chào" });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=vi",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Token ${API_KEY}`);
  assert.equal(headers["Content-Type"], "audio/wav");
  assert.deepEqual([...(calls[0].init.body as Uint8Array)], [82, 73, 70, 70, 1, 2, 3]);
});

test("Deepgram transcription detects the language when none is configured", async () => {
  const { calls, fetchFn } = recordingFetch(async () => deepgramTranscript("hello"));
  await transcribeDeepgram(transcriptionRequest({ model: "nova-3" }), fetchFn);
  assert.equal(
    calls[0].url,
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true",
  );
});

test("ElevenLabs transcription posts one multipart form without audio-event tags", async () => {
  const { calls, fetchFn } = recordingFetch(async () => elevenLabsTranscript("hello there"));
  const result = await transcribeElevenLabs(
    transcriptionRequest({ model: "scribe_v2", language: "vi" }),
    fetchFn,
  );
  assert.deepEqual(result, { ok: true, text: "hello there" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(calls[0].init.redirect, "manual");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], API_KEY);
  const form = calls[0].init.body as FormData;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("tag_audio_events"), "false");
  assert.equal(form.get("language_code"), "vi");
  const file = form.get("file") as File;
  assert.equal(file.type, "audio/wav");
  assert.equal(file.size, 7);
});

test("ElevenLabs transcription omits the language when none is configured", async () => {
  const { calls, fetchFn } = recordingFetch(async () => elevenLabsTranscript("hello"));
  await transcribeElevenLabs(transcriptionRequest(), fetchFn);
  assert.equal((calls[0].init.body as FormData).has("language_code"), false);
});

const transcribers = [
  ["Deepgram", transcribeDeepgram, deepgramTranscript, "api.deepgram.com", "DEEPGRAM_API_KEY"],
  ["ElevenLabs", transcribeElevenLabs, elevenLabsTranscript, "api.elevenlabs.io", "ELEVENLABS_API_KEY"],
] as const;

for (const [name, transcribe, transcript, host, keyEnv] of transcribers) {
  const failures: [string, () => Response, string, RegExp][] = [
    ["401", () => new Response("{}", { status: 401 }), "auth", new RegExp(`rejected the API key.*${keyEnv}`)],
    ["403", () => new Response("{}", { status: 403 }), "permission", /denied access/],
    ["404", () => new Response("{}", { status: 404 }), "not-found", /sttModel/],
    ["422", () => new Response("{}", { status: 422 }), "invalid", /HTTP 422/],
    ["429", () => new Response("{}", { status: 429 }), "rate-limit", /Nothing was retried/],
    ["500", () => new Response("{}", { status: 500 }), "server", /billed is unknown/],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }), "redirect", /not followed/],
    ["a non-JSON body with 200", () => new Response("<html>", { status: 200 }), "bad-response", /not a transcript/],
    ["JSON without a transcript", () => json({ unexpected: true }), "bad-response", /not a transcript/],
    ["an oversize response", () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }), "too-large", /1 MiB/],
  ];
  for (const [label, respond, kind, message] of failures)
    test(`${name} transcription ${label} fails as ${kind} after one request to its own origin only`, async () => {
      const { calls, fetchFn } = recordingFetch(async () => respond());
      const result = await transcribe(transcriptionRequest(), fetchFn);
      assert.ok(!result.ok);
      assert.equal(result.kind, kind);
      assert.match(result.message, message);
      assert.doesNotMatch(result.message, new RegExp(API_KEY));
      assert.equal(calls.length, 1, "no retry and no other-provider request");
      assert.equal(new URL(calls[0].url).host, host);
    });

  test(`${name} transcription of silence returns an empty transcript`, async () => {
    const { fetchFn } = recordingFetch(async () => transcript(""));
    assert.deepEqual(await transcribe(transcriptionRequest(), fetchFn), { ok: true, text: "" });
  });

  test(`${name} transcription never echoes the key from an error status`, async () => {
    const apiKey = "abcdefghijk";
    const { fetchFn } = recordingFetch(async () => json({ detail: { status: apiKey } }, 401));
    const result = await transcribe(transcriptionRequest({ apiKey }), fetchFn);
    assert.ok(!result.ok);
    assert.doesNotMatch(result.message, new RegExp(apiKey));
  });

  test(`${name} transcription without a key makes no request`, async () => {
    const { calls, fetchFn } = recordingFetch(async () => transcript("x"));
    const result = await transcribe(transcriptionRequest({ apiKey: " " }), fetchFn);
    assert.ok(!result.ok);
    assert.match(result.message, new RegExp(`${keyEnv} is not set`));
    assert.equal(calls.length, 0);
  });

  test(`${name} transcription timeout and cancellation are sanitized and not retried`, async () => {
    const owner = new AbortController();
    const calls: unknown[] = [];
    const hanging = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(1);
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
      );
    }) as typeof fetch;
    const keepAlive = setTimeout(() => undefined, 2000);
    try {
      const timedOut = await transcribe(transcriptionRequest({ timeoutMs: 20 }), hanging);
      assert.ok(!timedOut.ok);
      assert.equal(timedOut.kind, "timeout");
      assert.match(timedOut.message, /billed is unknown/);
      const pending = transcribe(transcriptionRequest({ signal: owner.signal }), hanging);
      owner.abort();
      const cancelled = await pending;
      assert.ok(!cancelled.ok);
      assert.equal(cancelled.kind, "cancelled");
      assert.equal(calls.length, 2);
    } finally {
      clearTimeout(keepAlive);
    }
  });
}
