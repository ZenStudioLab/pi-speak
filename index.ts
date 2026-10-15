import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { canonicalLocale, loadConfig, pushToTalkKeys, type Shortcuts } from "./config.ts";
import { HoldSpace } from "./hold-space.ts";
import { LiveSession } from "./live.ts";
import { SELECTION_MESSAGES, selectSessionAnswer } from "./session.ts";
import { SpeakAloudSwitch, registerSpeakAloud } from "./speak-aloud.ts";
import { SpeechController, type SpeakDeps } from "./speech-job.ts";
import { TalkController, type SendMessage } from "./talk.ts";
import { normalizeExplicitText, prepareAnswerText } from "./text.ts";
import type { TranslationFailureRecord } from "./translation-failure.ts";

const DEFAULT_SHORTCUTS: Shortcuts = {
  send: ["alt+t"],
  transcribe: ["alt+shift+t"],
  command: ["alt+m"],
  skill: ["alt+i"],
  live: ["alt+l"],
  holdSpace: false,
};

const NOT_AVAILABLE = (name: string) =>
  `/speak ${name} is not available in this version.`;

async function handleSpeak(
  args: string,
  ctx: ExtensionCommandContext,
  controller: SpeechController,
  live: LiveSession,
  recordFailure: (record: TranslationFailureRecord) => void,
): Promise<void> {
  const ui = ctx.ui;
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const word = (parts[0] ?? "").toLowerCase();

  if (word === "help" || word === "?") return controller.help(ui);
  if (word === "stop") {
    live.dropWaitingUpdates();
    return controller.stop(ui);
  }
  if (word === "status") return controller.status(ui, () => live.phase);
  if (word === "quota") return controller.quota(ui);
  if (word === "provider") {
    const name = parts[1] as "elevenlabs" | "deepgram" | "reset" | undefined;
    if (parts.length > 2) return controller.help(ui);
    return controller.provider("speech", name, ui);
  }
  if (word === "locale") {
    if (parts.length > 2) return controller.help(ui);
    return controller.locale(parts[1], ui);
  }
  if (word === "summary" || word === "cache-clear")
    return ui.notify(NOT_AVAILABLE(word), "info");
  if (
    word !== "" &&
    word !== "original" &&
    word !== "in" &&
    word !== "text" &&
    word !== "replay"
  )
    return controller.help(ui);

  // Every form from here on produces speech, which live mode refuses before any other check.
  const liveBlock = live.speechBlock();
  if (liveBlock) return ui.notify(liveBlock, "warning");

  let oneCommandLocale: string | undefined;
  if (word === "in") {
    if (parts.length !== 2) return controller.help(ui);
    oneCommandLocale = canonicalLocale(parts[1]!);
    if (!oneCommandLocale)
      return ui.notify(
        `"${parts[1]!.slice(0, 40)}" is not a valid BCP-47 language tag. Nothing was translated or spoken.`,
        "warning",
      );
  }

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
    if (text === "") return controller.help(ui);
    return controller.speak(text, ui);
  }

  speakLatestAnswer(ctx, controller, word === "original", recordFailure, oneCommandLocale);
}

function speakLatestAnswer(
  ctx: ExtensionCommandContext,
  controller: SpeechController,
  original: boolean,
  recordFailure: (record: TranslationFailureRecord) => void,
  locale: string | undefined,
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
    controller.speakLocalized(prepared, ui, ctx.modelRegistry, recordFailure, locale);
}

/**
 * Registers `/speak`, `/talk`, every push-to-talk shortcut and the live key, the inactive `speak_aloud` tool, four
 * lifecycle handlers that can only cancel this extension's own work or end live mode, a handler that
 * keeps `speak_aloud` out of agent runs outside live mode, a handler that reads a finished answer aloud
 * while live mode is on, and three compaction handlers that only
 * note whether Pi is compacting. With `holdSpace`, it also subscribes the Space listener on each session start. Nothing
 * is read, spawned, or sent at registration.
 */
export function registerSpeak(
  pi: ExtensionAPI,
  controller: SpeechController,
  talk: TalkController,
  live: LiveSession,
  shortcuts: Shortcuts = DEFAULT_SHORTCUTS,
  holdSpace?: HoldSpace,
): void {
  pi.registerCommand("speak", {
    description: "Speak a Pi answer or supplied text (explicit request only)",
    handler: (args, ctx) =>
      handleSpeak(args, ctx, controller, live, (record) =>
        pi.appendEntry("speak-translation-failure", record),
      ),
  });
  pi.registerCommand("talk", {
    description: "Dictate into the composer by push-to-talk (`send` also sends it, `command` and `skill` fill in a spoken command or skill), talk with Pi hands-free (`live`), or select the voice input provider",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return talk.press(ctx, "transcribe");
      if (parts.length === 1 && (parts[0] === "send" || parts[0] === "command" || parts[0] === "skill"))
        return talk.press(ctx, parts[0]);
      if (parts.length === 1 && parts[0] === "live") return live.toggle(ctx);
      if (parts.length === 1 && (parts[0] === "help" || parts[0] === "?"))
        return controller.help(ctx.ui);
      if (parts.length > 2 || parts[0] !== "provider") return controller.help(ctx.ui);
      const name = parts[1] as "deepgram" | "elevenlabs" | "reset" | undefined;
      if (name !== undefined && !["deepgram", "elevenlabs", "reset"].includes(name))
        return controller.help(ctx.ui);
      await controller.provider("input", name, ctx.ui);
    },
  });
  for (const key of shortcuts.send)
    pi.registerShortcut(key as KeyId, {
      description: "Start or stop push-to-talk voice input; stopping sends the transcribed message",
      handler: (ctx) => talk.press(ctx, "send", true),
    });
  for (const key of shortcuts.transcribe)
    pi.registerShortcut(key as KeyId, {
      description: "Start or stop push-to-talk voice input; stopping only adds the text to the composer",
      handler: (ctx) => talk.press(ctx, "transcribe", true),
    });

  for (const key of shortcuts.command)
    pi.registerShortcut(key as KeyId, {
      description: "Start or stop push-to-talk voice input; stopping puts a spoken command into the editor (nothing runs)",
      handler: (ctx) => talk.press(ctx, "command", true),
    });
  for (const key of shortcuts.skill)
    pi.registerShortcut(key as KeyId, {
      description: "Start or stop push-to-talk voice input; stopping puts a spoken skill into the editor (nothing runs)",
      handler: (ctx) => talk.press(ctx, "skill", true),
    });
  for (const key of shortcuts.live)
    pi.registerShortcut(key as KeyId, {
      description: "Start or end live mode, as /talk live does (ending also while Pi speaks)",
      handler: (ctx) => live.toggle(ctx),
    });

  registerSpeakAloud(pi, live);
  const reset = () => {
    controller.resetSession();
    talk.resetSession();
    live.resetSession();
    holdSpace?.reset();
  };
  if (holdSpace) pi.on("session_start", (_event, ctx) => holdSpace.attach(ctx));
  pi.on("session_shutdown", () => {
    reset();
    holdSpace?.detach();
  });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_tree", reset);
  // The only place besides live mode's own start and end that changes the active tools; it does so only when
  // a host restored or activated the tool (design D3), never at load.
  pi.on("before_agent_start", () => {
    live.removeToolOutsideLive();
  });
  // With live mode off the handler returns before it reads the context; with it on, the finished answer is read
  // aloud as `/speak original` would speak it (D17). A run that was aborted or failed has no final answer to select.
  pi.on("agent_end", (_event, ctx) => {
    if (live.phase !== "on") return;
    const selection = selectSessionAnswer(ctx.sessionManager, ctx.cwd);
    if (!selection.ok) return;
    const prepared = prepareAnswerText(selection.text);
    if (prepared !== "") live.speakReply(prepared);
  });
  // These only record the state; none returns a result, so compaction is never cancelled or changed.
  pi.on("session_before_compact", () => {
    talk.setCompacting(true);
  });
  pi.on("session_compact", () => {
    talk.setCompacting(false);
  });
  pi.on("session_compact_failed", () => {
    talk.setCompacting(false);
  });
}

/**
 * Speech and recording happen only when the user runs `/speak`, `/talk`, or a shortcut. Loading
 * reads the configuration file once, for the shortcuts, and does nothing else.
 */
export default async function speak(
  pi: ExtensionAPI,
  overrides: Partial<SpeakDeps> = {},
): Promise<void> {
  const deps: SpeakDeps = {
    env: process.env,
    fetchFn: globalThis.fetch,
    now: Date.now,
    ...overrides,
  };
  // If the file cannot be read now, the default keys are registered and the problem shows on first use.
  const loaded = await loadConfig(deps.env, deps.readFile, deps.home);
  const shortcuts: Shortcuts = loaded.ok
    ? {
        send: loaded.config.input.shortcut,
        transcribe: loaded.config.input.transcribeShortcut,
        command: loaded.config.input.commandShortcut,
        skill: loaded.config.input.skillShortcut,
        live: loaded.config.input.liveShortcut,
        holdSpace: loaded.config.input.holdSpace,
      }
    : DEFAULT_SHORTCUTS;
  const controller = new SpeechController(deps, shortcuts);
  const sendMessage: SendMessage = (text, options) => pi.sendUserMessage(text, options);
  // `talk` is built after `live` and consulted only when the user runs `/talk live`.
  const live = new LiveSession(
    deps,
    controller,
    sendMessage,
    shortcuts,
    (): string | undefined => talk.liveBlock(),
    new SpeakAloudSwitch(pi),
  );
  const talk = new TalkController(deps, controller, sendMessage, shortcuts, () => pi.getCommands(), live);
  registerSpeak(
    pi,
    controller,
    talk,
    live,
    shortcuts,
    shortcuts.holdSpace ? new HoldSpace(talk, pushToTalkKeys(shortcuts)) : undefined,
  );
}
