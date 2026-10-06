import { isAbsolute, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type AnswerSelection =
  | { ok: true; text: string }
  | {
      ok: false;
      reason:
        | "no-turn"
        | "no-answer"
        | "not-final"
        | "no-text"
        | "project-mismatch";
    };

export const SELECTION_MESSAGES: Record<
  Exclude<AnswerSelection, { ok: true }>["reason"],
  string
> = {
  "project-mismatch":
    "The current session's project is unavailable or does not match this working directory, so nothing was spoken.",
  "no-turn": "There is no conversation turn to speak yet.",
  "no-answer": "The latest turn has no assistant answer yet.",
  "not-final":
    "The latest answer was not completed normally (aborted, errored, truncated, or still a tool call), so nothing was spoken.",
  "no-text": "The latest answer has no text to speak.",
};

interface Block {
  type?: unknown;
  text?: unknown;
}

type Role = "user" | "assistant" | "other";

/** Messages with any other role (tool results, custom or compaction messages) are never spoken. */
function roleOf(message: unknown): Role {
  const role =
    typeof message === "object" && message !== null
      ? (message as { role?: unknown }).role
      : undefined;
  return role === "user" || role === "assistant" ? role : "other";
}

function lastIndexWhere(messages: readonly unknown[], role: Role): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (roleOf(messages[index]) === role) return index;
  return -1;
}

/**
 * Picks the answer to speak from original active-branch messages: the last assistant
 * message after the last user message, and only when it finished normally. An older turn is
 * never used as a fallback.
 */
export function selectLatestAnswer(
  messages: readonly unknown[],
): AnswerSelection {
  const user = lastIndexWhere(messages, "user");
  if (user < 0) return { ok: false, reason: "no-turn" };
  const assistant = lastIndexWhere(messages, "assistant");
  if (assistant < user) return { ok: false, reason: "no-answer" };

  const message = messages[assistant] as {
    stopReason?: unknown;
    content?: unknown;
  };
  if (message.stopReason !== "stop") return { ok: false, reason: "not-final" };

  const blocks: Block[] = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter((part) => part !== "")
    .join("\n\n");
  return text === "" ? { ok: false, reason: "no-text" } : { ok: true, text };
}

/** Compaction and context edits change model context, not the original transcript to speak. */
export function selectSessionAnswer(
  manager: Pick<
    ExtensionCommandContext["sessionManager"],
    "getHeader" | "getBranch"
  >,
  cwd: string,
): AnswerSelection {
  const project = manager.getHeader()?.cwd;
  if (
    typeof project !== "string" ||
    !isAbsolute(project) ||
    !isAbsolute(cwd) ||
    resolve(project) !== resolve(cwd)
  )
    return { ok: false, reason: "project-mismatch" };

  return selectLatestAnswer(
    manager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
  );
}
