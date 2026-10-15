import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveSession } from "./live.ts";

export const SPEAK_ALOUD = "speak_aloud";

/**
 * Adds or removes `speak_aloud` among the active tools, leaving the others as they are. It never calls
 * `setActiveTools` when nothing would change: a call that deactivates anything drops the tools the host is
 * still restoring (design D3).
 */
export class SpeakAloudSwitch {
  private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

  constructor(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
    this.pi = pi;
  }

  add(): void {
    const active = this.pi.getActiveTools();
    if (!active.includes(SPEAK_ALOUD)) this.pi.setActiveTools([...active, SPEAK_ALOUD]);
  }

  remove(): void {
    const active = this.pi.getActiveTools();
    if (active.includes(SPEAK_ALOUD)) this.pi.setActiveTools(active.filter((name) => name !== SPEAK_ALOUD));
  }
}

const parameters = Type.Object({
  text: Type.String({
    description:
      "What to say, in the language of the user's latest spoken message. Short and speakable: no code blocks, tables, or long paths.",
  }),
});

/** Registers `speak_aloud`, inactive: live mode adds it to the active tools while it is on. */
export function registerSpeakAloud(pi: Pick<ExtensionAPI, "registerTool">, live: Pick<LiveSession, "speakAloud">): void {
  // `defaultActive` is typed only from pi 1.x on; older hosts ignore it, and the agent-run handler covers them.
  const tool: ToolDefinition<typeof parameters> & { defaultActive?: boolean } = {
    name: SPEAK_ALOUD,
    label: "Speak aloud",
    description:
      "Speak a short update aloud to the user, who is talking with you by voice in live mode. The text is spoken exactly as written, in the user's own voice. The call returns at once, and the update waits behind any earlier one.",
    promptGuidelines: [
      "The user is talking to you by voice. Use speak_aloud to say a short acknowledgement when you start on a request, brief progress during long work, and a short summary when you finish.",
      "Write speak_aloud text in the language of the user's latest spoken message. Keep it short and speakable, with no code blocks, tables, or long paths.",
      "Speaking does not replace the written answer, which remains the full record.",
    ],
    parameters,
    defaultActive: false,
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: live.speakAloud(params.text) }], details: undefined };
    },
  };
  pi.registerTool(tool);
}
