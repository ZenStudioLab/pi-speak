import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SELECTION_MESSAGES, selectSessionAnswer } from "./session.ts";
import { SpeechController, type SpeakDeps } from "./speech-job.ts";
import { normalizeExplicitText, prepareAnswerText } from "./text.ts";
import type { TranslationFailureRecord } from "./translation-failure.ts";

export const SPEAK_USAGE = [
  "Usage:",
  "  /speak                 speak the latest answer in the configured locale (default vi)",
  "  /speak original        speak the latest answer without translation",
  "  /speak text <text>     speak the supplied text",
  "  /speak stop            stop speech started by this extension",
  "  /speak replay          replay the last clip without regenerating it",
  "  /speak status          show configuration and state",
  "  /speak quota           show ElevenLabs account quota and billing figures",
  "  /speak provider [elevenlabs|deepgram|reset]  select speech provider for this session",
].join("\n");

export const TALK_USAGE =
  "Usage: /talk provider [deepgram|elevenlabs|reset]";

const NOT_AVAILABLE = (name: string) =>
  `/speak ${name} is not available in this version.`;

async function handleSpeak(
  args: string,
  ctx: ExtensionCommandContext,
  controller: SpeechController,
  recordFailure: (record: TranslationFailureRecord) => void,
): Promise<void> {
  const ui = ctx.ui;
  const trimmed = args.trim();
  const word = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();

  if (word === "stop") return controller.stop(ui);
  if (word === "status") return controller.status(ui);
  if (word === "quota") return controller.quota(ui);
  if (word === "provider") {
    const name = trimmed.split(/\s+/)[1] as "elevenlabs" | "deepgram" | "reset" | undefined;
    if (trimmed.split(/\s+/).length > 2)
      return ui.notify(SPEAK_USAGE, "info");
    return controller.provider("speech", name, ui);
  }
  if (word === "summary" || word === "cache-clear")
    return ui.notify(NOT_AVAILABLE(word), "info");
  if (
    word !== "" &&
    word !== "original" &&
    word !== "text" &&
    word !== "replay"
  )
    return ui.notify(SPEAK_USAGE, "info");

  if (ctx.mode !== "tui") {
    ui.notify(
      "/speak works only in the interactive terminal, so nothing was spoken.",
      "warning",
    );
    return;
  }

  if (word === "replay") return controller.replay(ui);

  if (word === "text") {
    const text = normalizeExplicitText(trimmed.slice("text".length));
    if (text === "") return ui.notify(SPEAK_USAGE, "info");
    return controller.speak(text, ui);
  }

  speakLatestAnswer(ctx, controller, word === "original", recordFailure);
}

function speakLatestAnswer(
  ctx: ExtensionCommandContext,
  controller: SpeechController,
  original: boolean,
  recordFailure: (record: TranslationFailureRecord) => void,
): void {
  const ui = ctx.ui;
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ui.notify(
      "The agent is still working. Run /speak again when it has finished.",
      "warning",
    );
    return;
  }
  const selection = selectSessionAnswer(ctx.sessionManager, ctx.cwd);
  if (!selection.ok)
    return ui.notify(SELECTION_MESSAGES[selection.reason], "warning");
  const prepared = prepareAnswerText(selection.text);
  if (prepared === "")
    return ui.notify(
      "The latest answer has nothing speakable (only code or markup).",
      "warning",
    );
  if (original) controller.speak(prepared, ui);
  else
    controller.speakLocalized(prepared, ui, ctx.modelRegistry, recordFailure);
}

/**
 * Registers `/speak` and four lifecycle handlers that can only cancel this extension's own work.
 * Nothing is read, spawned, or sent at registration.
 */
export function registerSpeak(
  pi: ExtensionAPI,
  controller: SpeechController,
): void {
  pi.registerCommand("speak", {
    description: "Speak a Pi answer or supplied text (explicit request only)",
    handler: (args, ctx) =>
      handleSpeak(args, ctx, controller, (record) =>
        pi.appendEntry("speak-translation-failure", record),
      ),
  });
  pi.registerCommand("talk", {
    description: "Select the voice input provider for this session",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if ((parts.length !== 1 && parts.length !== 2) || parts[0] !== "provider") {
        controller.talkUsage(ctx.ui);
        return;
      }
      if (parts.length === 1) {
        await controller.provider("input", undefined, ctx.ui);
        return;
      }
      const name = parts[1] as "deepgram" | "elevenlabs" | "reset";
      if (!["deepgram", "elevenlabs", "reset"].includes(name)) {
        controller.talkUsage(ctx.ui);
        return;
      }
      await controller.provider("input", name, ctx.ui);
    },
  });

  const reset = () => controller.resetSession();
  pi.on("session_shutdown", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_tree", reset);
}

/** Speech happens only when the user runs `/speak`; loading does nothing else. */
export default function speak(
  pi: ExtensionAPI,
  overrides: Partial<SpeakDeps> = {},
): void {
  registerSpeak(
    pi,
    new SpeechController({
      env: process.env,
      fetchFn: globalThis.fetch,
      now: Date.now,
      ...overrides,
    }),
  );
}
