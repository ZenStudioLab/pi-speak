import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TranslationFailureRecord } from "../translation-failure.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ShortcutHandler = (ctx: ExtensionCommandContext) => Promise<void>;

/**
 * The part of the Pi host the extension talks to: the commands, shortcuts, events, and tools it registers,
 * the entries it appends, and the active tool set. Like the 1.1.0 host, registering a tool activates it
 * unless its definition says `defaultActive: false`.
 */
export function createFakePi(
  options: {
    entryFailure?: boolean;
    entrySink?: (customType: string, data: TranslationFailureRecord) => void;
    /** The tools that are active before the extension registers anything, such as `["read", "bash"]`. */
    activeTools?: string[];
  } = {},
) {
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, ShortcutHandler>();
  const events = new Map<string, (event?: unknown, ctx?: unknown) => void>();
  const entries: { customType: string; data: TranslationFailureRecord }[] = [];
  const tools = new Map<string, ToolDefinition & { defaultActive?: boolean }>();
  let active = [...(options.activeTools ?? [])];
  /** The name lists passed to `setActiveTools`, in order. */
  const setActiveToolsCalls: string[][] = [];
  let submitted = 0;
  // SAFETY: registerSpeak uses these members only; the others of ExtensionAPI are never reached.
  const api = {
    appendEntry(customType: string, data: TranslationFailureRecord) {
      if (options.entryFailure) throw new Error("session persistence unavailable");
      options.entrySink?.(customType, data);
      entries.push({ customType, data });
    },
    registerCommand: (name: string, definition: { handler: CommandHandler }) =>
      commands.set(name, definition.handler),
    registerShortcut: (key: string, definition: { handler: ShortcutHandler }) =>
      shortcuts.set(key, definition.handler),
    registerTool(definition: ToolDefinition & { defaultActive?: boolean }) {
      tools.set(definition.name, definition);
      if (definition.defaultActive !== false) active = [...active, definition.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      setActiveToolsCalls.push([...names]);
      active = [...names];
    },
    sendUserMessage: () => {
      submitted++;
    },
    sendMessage: () => {
      submitted++;
    },
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => void) => {
      events.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    commands,
    shortcuts,
    events,
    entries,
    tools,
    setActiveToolsCalls,
    get activeTools() {
      return [...active];
    },
    get submitted() {
      return submitted;
    },
  };
}
