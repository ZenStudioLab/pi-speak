import { redact } from "./bounded-request.ts";
import { SAMPLE_RATE } from "./record.ts";

const REALTIME_ORIGIN = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

/** The part of a WebSocket this client uses; tests pass a fake. */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type WebSocketFn = (
  url: string,
  init: { headers: Record<string, string> },
) => RealtimeSocket;

/** Node's built-in `WebSocket`, which sends custom headers when given `{ headers }`. */
export const nodeWebSocket: WebSocketFn = (url, init) => {
  const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => RealtimeSocket;
  return new NodeWebSocket(url, init);
};

export type RealtimeFailureKind =
  | "auth"
  | "quota"
  | "rate-limit"
  | "time-limit"
  | "too-large"
  | "invalid"
  | "server"
  | "provider"
  | "network"
  | "closed"
  | "timeout"
  | "cancelled"
  | "bad-response";

/** A sanitized failure: the message names a class and never carries provider text or the key. */
export interface RealtimeFailure {
  kind: RealtimeFailureKind;
  message: string;
}

export type RealtimeResult =
  | { ok: true; text: string }
  | { ok: false; failure: RealtimeFailure };

export interface RealtimeHandlers {
  /** A committed segment was added to `session.text`. */
  onCommitted(): void;
  /** The connection failed or closed while no final commit was awaited. */
  onFailure(failure: RealtimeFailure): void;
  /** Live mode only: a non-empty partial transcript arrived. Partials are never added to `session.text`. */
  onPartial?(text: string): void;
}

export interface RealtimeSession {
  /** Committed segments joined by single spaces. */
  readonly text: string;
  /** Replays a failure that happened before the handlers were attached. */
  listen(handlers: RealtimeHandlers): void;
  sendAudio(pcm: Uint8Array): void;
  /** Requests the final commit and resolves with all committed text, or the failure. */
  finish(timeoutMs: number): Promise<RealtimeResult>;
  close(): void;
}

export type OpenResult =
  | { ok: true; session: RealtimeSession }
  | { ok: false; failure: RealtimeFailure };

/** The server's error message types and the class each one is shown as. */
const ERROR_CLASSES: Record<string, [RealtimeFailureKind, string]> = {
  auth_error: ["auth", "rejected the API key (auth_error). Check ELEVENLABS_API_KEY"],
  unaccepted_terms: ["auth", "reports that the terms were not accepted (unaccepted_terms)"],
  quota_exceeded: ["quota", "reported that the quota is used up (quota_exceeded)"],
  resource_exhausted: ["quota", "ran out of resources (resource_exhausted)"],
  rate_limited: ["rate-limit", "rate limited the connection (rate_limited)"],
  commit_throttled: ["rate-limit", "throttled commits (commit_throttled)"],
  queue_overflow: ["rate-limit", "could not keep up with the audio (queue_overflow)"],
  session_time_limit_exceeded: ["time-limit", "ended the session at its time limit (session_time_limit_exceeded)"],
  chunk_size_exceeded: ["too-large", "refused an audio chunk as too large (chunk_size_exceeded)"],
  input_error: ["invalid", "rejected the input (input_error)"],
  invalid_request: ["invalid", "rejected the request (invalid_request)"],
  insufficient_audio_activity: ["invalid", "found too little audio activity (insufficient_audio_activity)"],
  transcriber_error: ["server", "had a transcriber error (transcriber_error)"],
  error: ["provider", "reported an error (error)"],
};

/** `wss://…/realtime` with the fixed model, format, and 1-second pause; the key is never in the URL. */
export function realtimeUrl(language: string | undefined): string {
  const query = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    audio_format: "pcm_16000",
    commit_strategy: "vad",
    vad_silence_threshold_secs: "1",
  });
  // The realtime API takes ISO 639 codes, so only the primary subtag of the BCP-47 tag is sent.
  if (language) query.set("language_code", language.split("-")[0]!);
  return `${REALTIME_ORIGIN}?${query}`;
}

/** While the final commit is awaited, these answers mean there was nothing left to commit: the text so far is final. */
const NOTHING_TO_COMMIT = new Set(["insufficient_audio_activity", "commit_throttled"]);

const failure = (apiKey: string, kind: RealtimeFailureKind, message: string): RealtimeFailure => ({
  kind,
  message: redact(`ElevenLabs live transcription ${message}`, apiKey),
});

const chunkMessage = (audioBase64: string, commit: boolean): string =>
  JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: audioBase64,
    commit,
    sample_rate: SAMPLE_RATE,
  });

class Session implements RealtimeSession {
  text = "";
  private readonly socket: RealtimeSocket;
  private readonly apiKey: string;
  private handlers: RealtimeHandlers | undefined;
  private failed: RealtimeFailure | undefined;
  private ended = false;
  private finishing = false;
  private textBytes = 0;
  private pending: ((result: RealtimeResult) => void) | undefined;

  constructor(socket: RealtimeSocket, apiKey: string) {
    this.socket = socket;
    this.apiKey = apiKey;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("error", () =>
      this.fail("network", "had a connection error. Nothing was retried."),
    );
    socket.addEventListener("close", () =>
      this.fail("closed", "closed the connection unexpectedly. Nothing was retried."),
    );
  }

  listen(handlers: RealtimeHandlers): void {
    this.handlers = handlers;
    if (this.failed) handlers.onFailure(this.failed);
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.ended || this.finishing) return;
    this.send(chunkMessage(Buffer.from(pcm).toString("base64"), false));
  }

  finish(timeoutMs: number): Promise<RealtimeResult> {
    if (this.failed) return Promise.resolve({ ok: false, failure: this.failed });
    if (this.ended)
      return Promise.resolve({ ok: false, failure: failure(this.apiKey, "cancelled", "was closed.") });
    this.finishing = true;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.fail(
            "timeout",
            `did not return the final text within ${Math.round(timeoutMs / 1000)} s. Nothing was retried.`,
          ),
        timeoutMs,
      );
      this.pending = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.send(chunkMessage("", true));
    });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.pending?.({ ok: false, failure: failure(this.apiKey, "cancelled", "was closed.") });
    this.pending = undefined;
    this.closeSocket();
  }

  private send(data: string): void {
    try {
      this.socket.send(data);
    } catch {
      this.fail("network", "could not send audio. Nothing was retried.");
    }
  }

  private closeSocket(): void {
    try {
      this.socket.close(1000);
    } catch {
      // The socket is being abandoned either way.
    }
  }

  private fail(kind: RealtimeFailureKind, message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.failed = failure(this.apiKey, kind, message);
    this.closeSocket();
    if (this.pending) this.pending({ ok: false, failure: this.failed });
    else this.handlers?.onFailure(this.failed);
    this.pending = undefined;
  }

  private onMessage(data: unknown): void {
    if (this.ended) return;
    if (typeof data !== "string")
      return this.fail("bad-response", "sent something that is not text, so it was discarded.");
    if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
      return this.fail("too-large", "sent a message larger than 64 KiB, so the recording was ended.");
    let message: { message_type?: unknown; text?: unknown };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return this.fail("bad-response", "sent something that is not a message, so it was discarded.");
    }
    const type = typeof message?.message_type === "string" ? message.message_type : "";
    if (this.pending && NOTHING_TO_COMMIT.has(type)) return this.settle();
    const errorClass = Object.hasOwn(ERROR_CLASSES, type) ? ERROR_CLASSES[type] : undefined;
    if (errorClass)
      return this.fail(errorClass[0], `${errorClass[1]}. Nothing was retried.`);
    if (type === "partial_transcript") {
      if (typeof message.text === "string" && message.text.trim() !== "")
        this.handlers?.onPartial?.(message.text.trim());
      return;
    }
    // Every other message type is ignored.
    if (type !== "committed_transcript") return;
    if (typeof message.text !== "string")
      return this.fail("bad-response", "sent a transcript that is not text, so it was discarded.");
    const text = message.text.trim();
    this.textBytes += Buffer.byteLength(text);
    if (this.textBytes > MAX_TEXT_BYTES)
      return this.fail("too-large", "returned more than 1 MiB of text, so the recording was ended.");
    if (text !== "") this.text = this.text === "" ? text : `${this.text} ${text}`;
    if (this.pending) this.settle();
    else this.handlers?.onCommitted();
  }

  /** Answers the awaited final commit with the text committed so far. */
  private settle(): void {
    this.pending?.({ ok: true, text: this.text });
    this.pending = undefined;
  }
}

/**
 * Opens the one live transcription connection of a recording: no retry, no reconnect. It must open
 * within `timeoutMs` and can be cancelled with `signal`; either way the socket is closed.
 */
export function openRealtime(options: {
  apiKey: string;
  language: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
  webSocketFn: WebSocketFn;
}): Promise<OpenResult> {
  const { apiKey, signal } = options;
  return new Promise((resolve) => {
    let settled = false;
    let socket: RealtimeSocket | undefined;
    const settle = (result: OpenResult) => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const abandon = (kind: RealtimeFailureKind, message: string) => {
      if (settled) return;
      try {
        socket?.close();
      } catch {
        // The socket is being abandoned either way.
      }
      settle({ ok: false, failure: failure(apiKey, kind, message) });
    };
    const timer = setTimeout(
      () =>
        abandon(
          "timeout",
          `did not open within ${Math.round(options.timeoutMs / 1000)} s. Nothing was retried.`,
        ),
      options.timeoutMs,
    );
    const onAbort = () => abandon("cancelled", "connection was cancelled.");
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      socket = options.webSocketFn(realtimeUrl(options.language), {
        headers: { "xi-api-key": apiKey },
      });
    } catch {
      return abandon("network", "could not be reached. Nothing was retried.");
    }
    const opened = socket;
    opened.addEventListener("open", () => {
      if (!settled) settle({ ok: true, session: new Session(opened, apiKey) });
    });
    const notOpened = () =>
      abandon("network", "could not be reached. Check ELEVENLABS_API_KEY and the network. Nothing was retried.");
    opened.addEventListener("error", notOpened);
    opened.addEventListener("close", notOpened);
  });
}

const WORD = /[^\s\p{P}]+(?:['’‘][^\s\p{P}]+)*/gu;

const spokenWords = (text: string) =>
  [...text.matchAll(WORD)].map((match) => ({
    start: match.index,
    word: match[0].toLowerCase().normalize("NFC").replace(/[’‘ʼ]/g, "'"),
  }));

/**
 * When the text ends, as whole words, with one of the phrases, returns the text before it without
 * the separators in between; otherwise undefined. Words are compared lower-cased, in Unicode NFC,
 * with curly apostrophes made straight; whitespace and punctuation only separate them. Of several
 * matching phrases the longest wins.
 */
export function matchStopPhrase(text: string, phrases: readonly string[]): string | undefined {
  const spoken = spokenWords(text);
  let start: number | undefined;
  for (const phrase of phrases) {
    const wanted = spokenWords(phrase);
    const first = spoken.length - wanted.length;
    if (wanted.length === 0 || first < 0) continue;
    if (wanted.every(({ word }, i) => word === spoken[first + i]!.word))
      start = Math.min(start ?? first, first);
  }
  return start === undefined
    ? undefined
    : text.slice(0, spoken[start]!.start).replace(/[\s\p{P}]+$/u, "");
}

const foldDiacritics = (word: string) => word.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");

/**
 * Whether the whole text equals one of the phrases, word by word. Words are compared as `matchStopPhrase`
 * compares them, and diacritics are ignored too, `đ` counting as `d`: a transcript often gets a tone mark wrong.
 */
export function matchesLiveStopPhrase(text: string, phrases: readonly string[]): boolean {
  const spoken = spokenWords(text).map(({ word }) => foldDiacritics(word));
  return phrases.some((phrase) => {
    const wanted = spokenWords(phrase).map(({ word }) => foldDiacritics(word));
    return wanted.length > 0 && wanted.length === spoken.length && wanted.every((word, i) => word === spoken[i]);
  });
}
