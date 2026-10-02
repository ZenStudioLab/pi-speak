import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SELECTION_MESSAGES, selectLatestAnswer } from "./session.ts";
import { SpeechController, type SpeakDeps } from "./speech-job.ts";
import { normalizeExplicitText, prepareAnswerText } from "./text.ts";

export const SPEAK_USAGE = [
  "Usage:",
  "  /speak                 speak the latest completed answer",
  "  /speak text <text>     speak the supplied text",
  "  /speak stop            stop speech started by this extension",
  "  /speak replay          replay the last clip without regenerating it",
  "  /speak status          show configuration and state",
].join("\n");

const NOT_AVAILABLE = (name: string) => `/speak ${name} is not available in this version.`;

async function handleSpeak(args: string, ctx: ExtensionCommandContext, controller: SpeechController): Promise<void> {
  const ui = ctx.ui;
  const trimmed = args.trim();
  const word = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();

  if (word === "stop") return controller.stop(ui);
  if (word === "status") return controller.status(ui);
  if (word === "summary" || word === "cache-clear") return ui.notify(NOT_AVAILABLE(word), "info");
  if (word !== "" && word !== "text" && word !== "replay") return ui.notify(SPEAK_USAGE, "info");

  if (ctx.mode !== "tui") {
    ui.notify("/speak works only in the interactive terminal, so nothing was spoken.", "warning");
    return;
  }

  if (word === "replay") return controller.replay(ui);

  if (word === "text") {
    const text = normalizeExplicitText(trimmed.slice("text".length));
    if (text === "") return ui.notify(SPEAK_USAGE, "info");
    return controller.speak(text, ui);
  }

  speakLatestAnswer(ctx, controller);
}

function speakLatestAnswer(ctx: ExtensionCommandContext, controller: SpeechController): void {
  const ui = ctx.ui;
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ui.notify("The agent is still working. Run /speak again when it has finished.", "warning");
    return;
  }
  const selection = selectLatestAnswer(ctx.sessionManager.buildSessionProjection().messages);
  if (!selection.ok) return ui.notify(SELECTION_MESSAGES[selection.reason], "warning");
  const prepared = prepareAnswerText(selection.text);
  if (prepared === "") return ui.notify("The latest answer has nothing speakable (only code or markup).", "warning");
  controller.speak(prepared, ui);
}

/**
 * Registers `/speak` and four lifecycle handlers that can only cancel this extension's own work.
 * Nothing is read, spawned, or sent at registration.
 */
export function registerSpeak(pi: ExtensionAPI, controller: SpeechController): void {
  pi.registerCommand("speak", {
    description: "Speak a Pi answer or supplied text (explicit request only)",
    handler: (args, ctx) => handleSpeak(args, ctx, controller),
  });

  const reset = () => controller.resetSession();
  pi.on("session_shutdown", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_tree", reset);
}

/** Speech happens only when the user runs `/speak`; loading does nothing else. */
export default function speak(pi: ExtensionAPI, overrides: Partial<SpeakDeps> = {}): void {
  registerSpeak(
    pi,
    new SpeechController({ env: process.env, fetchFn: globalThis.fetch, now: Date.now, ...overrides }),
  );
}
