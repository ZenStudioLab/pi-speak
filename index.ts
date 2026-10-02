import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SPEAK_USAGE = [
  "Usage:",
  "  /speak                 speak the latest completed answer",
  "  /speak text <text>     speak the supplied text",
  "  /speak stop            stop speech started by this extension",
  "  /speak replay          replay the last clip without regenerating it",
  "  /speak status          show configuration and state",
].join("\n");

/** Speech happens only when the user runs `/speak`; loading registers the command and does nothing else. */
export default function speak(pi: ExtensionAPI): void {
  pi.registerCommand("speak", {
    description: "Speak a Pi answer or supplied text (explicit request only)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(SPEAK_USAGE, "info");
    },
  });
}
