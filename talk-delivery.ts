import { loadConfig, type ConfigResult } from "./config.ts";
import type { SpeakDeps } from "./speech-job.ts";
import type { DeliveryContext, SendMessage, TalkMode, TalkUi } from "./talk-state.ts";
import { matchVoiceCommand, type VoiceMode } from "./voice-command.ts";

/** What `pi.getCommands()` lists; skills come as `skill:<name>`. */
export type ListCommands = () => readonly { name: string; source: string }[];

/**
 * Puts a finished transcript into the composer: appended as dictation, sent, or matched to a command
 * or skill. Nothing here reads the recording; the controller has already checked that the transcript is
 * still due. Warnings never repeat the transcript.
 */
export class TranscriptDelivery {
  /** Pi refuses a prompt while it compacts the conversation, so a send must not start then. */
  compacting = false;
  private readonly deps: Pick<SpeakDeps, "env" | "readFile" | "home">;
  private readonly sendMessage: SendMessage;
  private readonly listCommands: ListCommands;
  private readonly redactKeys: (message: string) => string;

  constructor(
    deps: Pick<SpeakDeps, "env" | "readFile" | "home">,
    sendMessage: SendMessage,
    listCommands: ListCommands,
    redactKeys: (message: string) => string,
  ) {
    this.deps = deps;
    this.sendMessage = sendMessage;
    this.listCommands = listCommands;
    this.redactKeys = redactKeys;
  }

  /** Every mode but transcribe-only reads the configuration when the transcript arrives (`sendWhenBusy`, aliases). */
  async prepare(mode: TalkMode): Promise<ConfigResult | undefined> {
    if (mode === "transcribe") return undefined;
    return loadConfig(this.deps.env, this.deps.readFile, this.deps.home);
  }

  /**
   * Appends the transcript and, in send mode, sends the whole composer as plain text. `sendWhenBusy`
   * is read now. Pi reports a refusal of `pi.sendUserMessage` only later, so the refusals visible
   * beforehand (no model, compaction in progress) keep the text in the composer without sending. The
   * composer is cleared only after the send call returns; if it throws, the draft and transcript stay
   * and the error is shown.
   */
  deliver(
    ui: TalkUi,
    text: string,
    delivery: { mode: TalkMode; context: DeliveryContext },
    loaded: ConfigResult | undefined,
  ): void {
    const { mode, context } = delivery;
    if (mode === "command" || mode === "skill") return this.deliverVoiceCommand(ui, text, mode, loaded!);
    this.append(ui, text);
    if (!loaded) return;
    if (!loaded.ok)
      return ui.notify(
        `The transcript was added to the composer but not sent: ${loaded.problem}`,
        "error",
      );
    if (!context.model)
      return ui.notify(
        "The transcript was added to the composer but not sent: no model is selected. Select a model, then press Enter.",
        "warning",
      );
    if (this.compacting)
      return ui.notify(
        "The transcript was added to the composer but not sent: Pi is compacting the conversation. Press Enter to queue the message.",
        "warning",
      );
    try {
      const deliverAs = loaded.config.input.sendWhenBusy === "wait" ? "followUp" : "steer";
      this.sendMessage(
        ui.getEditorText(),
        context.isIdle()
          ? { expandPromptTemplates: false }
          : { deliverAs, expandPromptTemplates: false },
      );
      ui.setEditorText("");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ui.notify(
        `Not sent: ${this.redactKeys(reason)}. The draft and transcript are still in the composer.`,
        "error",
      );
    }
  }

  /** Adds the transcript after the existing text; it is never replaced. */
  append(ui: TalkUi, text: string): void {
    const current = ui.getEditorText();
    const separator = current !== "" && !/\s$/.test(current) ? " " : "";
    ui.setEditorText(`${current}${separator}${text}`);
  }

  /**
   * Command and skill delivery: nothing is sent and nothing runs. A listed target becomes the start of the
   * editor, followed by the spoken arguments and the old draft. An unlisted one (Pi's interactive commands)
   * goes in alone, into an empty editor. Anything else is appended like dictation, with a warning.
   */
  private deliverVoiceCommand(ui: TalkUi, text: string, mode: VoiceMode, loaded: ConfigResult): void {
    const noun = mode === "skill" ? "skill" : "command";
    if (!loaded.ok) {
      this.append(ui, text);
      return ui.notify(
        `The words were added to the composer, but no ${noun} was matched: ${loaded.problem}`,
        "warning",
      );
    }
    let commands: ReturnType<ListCommands>;
    try {
      commands = this.listCommands();
    } catch {
      this.append(ui, text);
      return ui.notify(`Pi's command list could not be read, so no ${noun} was matched. The words were added to the composer.`, "warning");
    }
    const match = matchVoiceCommand(
      text,
      mode,
      {
        commands: commands.filter((c) => c.source === "extension" || c.source === "prompt").map((c) => c.name),
        skills: commands.filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, "")),
      },
      loaded.config.input.commandAliases,
    );
    if (match.kind === "none") {
      this.append(ui, text);
      return ui.notify(`No ${noun} matched what you said. The words were added to the composer.`, "warning");
    }
    if (match.kind === "ambiguous") {
      this.append(ui, text);
      const listed = match.names.map((name) => (mode === "skill" ? `/skill:${name}` : `/${name}`)).join(", ");
      return ui.notify(`More than one ${noun} matches what you said (${listed}). The words were added to the composer.`, "warning");
    }
    const draft = ui.getEditorText();
    if (match.listed) {
      return ui.setEditorText([match.target, match.args, draft.trim()].filter((part) => part !== "").join(" "));
    }
    if (draft.trim() === "" && match.args === "") return ui.setEditorText(match.target);
    this.append(ui, text);
    ui.notify(
      "That command needs an empty editor with nothing spoken after it, so the words were added to the composer instead.",
      "warning",
    );
  }
}
