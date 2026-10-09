import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpeechProvider } from "./config.ts";
import type { RealtimeSession } from "./realtime.ts";
import type { RecorderHandle } from "./record.ts";

/** Push-to-talk needs only the run mode, the UI, and the idle state and model of the context that pressed the key. */
export type TalkContext = Pick<ExtensionContext, "mode" | "ui" | "isIdle" | "model">;
export type TalkUi = TalkContext["ui"];

/** What the control that stops a recording asks for: send the composer, or only add the text to it. */
export type TalkMode = "send" | "transcribe";

/** `pi.sendUserMessage`; always plain text, delivered to a running turn only with `deliverAs`. */
export type SendMessage = (
  text: string,
  options: { deliverAs?: "steer" | "followUp"; expandPromptTemplates: false },
) => void;

/** Placeholder for a press that is still checking configuration or starting the recorder. */
export interface Starting {
  phase: "starting";
  /** Aborted when the attempt is cancelled or the session is replaced, which ends a pending connection. */
  cancel: AbortController;
}

/** The live transcription of a streamed recording (the stop phrase is on). */
export interface LiveStream {
  session: RealtimeSession;
  phrases: readonly string[];
  /** The context of the press that started the recording; a stop phrase has no press of its own. */
  context: Pick<TalkContext, "isIdle" | "model">;
  /** The text to deliver, once it is final; the recorder's later exit then changes nothing. */
  text: string | undefined;
}

/** One recording and what it needs afterwards; its provider settings are fixed when it starts. */
export interface Recording {
  phase: "recording" | "held" | "transcribing";
  ui: TalkUi;
  handle: RecorderHandle;
  provider: SpeechProvider;
  model: string;
  language: string | undefined;
  apiKey: string;
  timeoutMs: number;
  maxSeconds: number;
  startedAt: number;
  level: number;
  /** Audio held at the time cap; never sent until the user presses again. */
  pcm: Buffer | undefined;
  live: LiveStream | undefined;
  /** Set by the stopping control, which alone decides whether the transcript is sent. */
  delivery: { mode: TalkMode; context: Pick<TalkContext, "isIdle" | "model"> } | undefined;
  unsubscribeInput: (() => void) | undefined;
  cancel: AbortController;
}
