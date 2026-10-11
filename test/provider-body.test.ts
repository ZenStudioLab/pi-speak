import assert from "node:assert/strict";
import { test } from "node:test";
import {
  synthesize,
  transcribe as transcribeElevenLabs,
  type SynthesisRequest,
} from "../elevenlabs.ts";
import {
  synthesize as synthesizeDeepgram,
  transcribe as transcribeDeepgram,
} from "../deepgram.ts";
import { API_KEY } from "./harness.ts";

const request = (overrides: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
  text: "Hello there.",
  voiceId: "voice123456",
  modelId: "eleven_flash_v2_5",
  outputFormat: "mp3_44100_128",
  apiKey: API_KEY,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  ...overrides,
});

test("a response-body timeout after headers is sanitized as unknown-billing timeout", async () => {
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const fetchFn = (async (_url: string | URL, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyStarted();
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("timed out", "TimeoutError")),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } },
    )) as typeof fetch;
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    const resultPromise = synthesize(request({ timeoutMs: 20 }), fetchFn);
    await started;
    const result = await resultPromise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "timeout");
      assert.match(result.message, /billed is unknown/);
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a response-body cancellation after headers is sanitized as cancelled", async () => {
  const owner = new AbortController();
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const fetchFn = (async (_url: string | URL, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyStarted();
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } },
    )) as typeof fetch;
  const resultPromise = synthesize(request({ signal: owner.signal }), fetchFn);
  await started;
  owner.abort();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "cancelled");
});

test("a response stream error after headers is sanitized as network failure", async () => {
  const fetchFn = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private stream failure"));
        },
      }),
      { status: 200, headers: { "content-type": "audio/mpeg" } },
    )) as typeof fetch;
  const result = await synthesize(request(), fetchFn);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "network");
    assert.match(result.message, /billed is unknown/);
    assert.doesNotMatch(result.message, /private stream failure/);
  }
});

/** Every client reads an HTTP error's body inside the bounded request, so a stalled body is a timeout. */
const clients: [string, (signal: AbortSignal, timeoutMs: number, fetchFn: typeof fetch) => Promise<{ ok: boolean; kind?: string }>][] = [
  ["ElevenLabs speech", (signal, timeoutMs, fetchFn) => synthesize(request({ signal, timeoutMs }), fetchFn)],
  ["Deepgram speech", (signal, timeoutMs, fetchFn) => synthesizeDeepgram({ text: "Hi.", voice: "aura-2-thalia-en", apiKey: API_KEY, signal, timeoutMs }, fetchFn)],
  ["ElevenLabs transcription", (signal, timeoutMs, fetchFn) => transcribeElevenLabs({ wav: new Uint8Array(4), model: "scribe_v2", apiKey: API_KEY, signal, timeoutMs }, fetchFn)],
  ["Deepgram transcription", (signal, timeoutMs, fetchFn) => transcribeDeepgram({ wav: new Uint8Array(4), model: "nova-3", apiKey: API_KEY, signal, timeoutMs }, fetchFn)],
];

/** A 401 whose body never arrives until the signal fires, then fails as the real one does. */
function stalledErrorBody(onPull: () => void, abortName: string): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          onPull();
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("stopped", abortName)),
            { once: true },
          );
        },
      }),
      { status: 401 },
    )) as typeof fetch;
}

for (const [name, call] of clients) {
  test(`${name}: an error body that times out after the headers is classified as a timeout`, async () => {
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => (started = resolve));
    const keepAlive = setTimeout(() => undefined, 2000);
    try {
      const pending = call(new AbortController().signal, 20, stalledErrorBody(started, "TimeoutError"));
      await bodyStarted;
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.kind, "timeout");
    } finally {
      clearTimeout(keepAlive);
    }
  });

  test(`${name}: an error body cancelled after the headers is classified as cancelled`, async () => {
    const owner = new AbortController();
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => (started = resolve));
    const pending = call(owner.signal, 5000, stalledErrorBody(started, "AbortError"));
    await bodyStarted;
    owner.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.kind, "cancelled");
  });
}
