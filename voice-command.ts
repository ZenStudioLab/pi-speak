/** A spoken phrase and the line it stands for, from `input.commandAliases`. */
export interface CommandAlias {
  phrase: string;
  /** One line starting with `/`; `/skill:<name>` makes it a skill alias. */
  target: string;
}

/** The names Pi lists: extension commands and prompt templates, and skills without their `skill:` prefix. */
export interface ListedNames {
  commands: readonly string[];
  skills: readonly string[];
}

export type VoiceMode = "command" | "skill";

export type VoiceMatch =
  | { kind: "match"; target: string; args: string; listed: boolean }
  | { kind: "none" }
  | { kind: "ambiguous"; names: string[] };

export const MAX_PHRASE_TOKENS = 8;
const SKILL_PREFIX = "skill:";

/** The words of a text: runs of non-whitespace characters. */
export const tokensOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** NFKC, lowercased, keeping only letters and digits, so "Op SX apply-loop" equals `opsx-apply-loop`. */
export const collapse = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The first word of an alias target without its `/`, which is what Pi would look up. */
const targetName = (target: string): string => target.slice(1).split(/\s+/)[0] ?? "";

const isSkillAlias = (alias: CommandAlias): boolean => alias.target.startsWith(`/${SKILL_PREFIX}`);

function isListed(target: string, listed: ListedNames): boolean {
  const name = targetName(target);
  return name.startsWith(SKILL_PREFIX)
    ? listed.skills.includes(name.slice(SKILL_PREFIX.length))
    : listed.commands.includes(name);
}

/** The words of a candidate: its NFKC lowercased form split on runs of anything but letters and digits. */
const wordsOf = (text: string): string[] =>
  text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Words in any order, with repeats counted: equal keys mean equal multisets. */
const multisetKey = (words: readonly string[]): string => [...words].sort().join(" ");

/** How a pass compares the leading tokens of a transcript with a candidate phrase. */
interface Comparison {
  spoken(tokens: readonly string[]): string;
  candidate(phrase: string): string;
}

const IN_ORDER: Comparison = {
  spoken: (tokens) => collapse(tokens.join(" ")),
  candidate: collapse,
};

const ANY_ORDER: Comparison = {
  spoken: (tokens) => multisetKey(tokens.map(collapse).filter(Boolean)),
  candidate: (phrase) => multisetKey(wordsOf(phrase)),
};

/**
 * Matches the start of a transcript against Pi's names and the aliases of one mode. The longest run
 * of 1 to 8 leading words whose collapsed form equals a candidate wins; at that length an alias beats a
 * name, and two different names are ambiguous. Only if that finds nothing does a second pass compare
 * the same runs as words in any order, repeats counted. Pure: it reads and writes nothing.
 */
export function matchVoiceCommand(
  transcript: string,
  mode: VoiceMode,
  listed: ListedNames,
  aliases: readonly CommandAlias[],
): VoiceMatch {
  const words = tokensOf(transcript);
  const names = [...new Set(mode === "skill" ? listed.skills : listed.commands)];
  const modeAliases = aliases.filter((alias) => isSkillAlias(alias) === (mode === "skill"));
  for (const comparison of [IN_ORDER, ANY_ORDER])
    for (let length = Math.min(MAX_PHRASE_TOKENS, words.length); length >= 1; length--) {
      const key = comparison.spoken(words.slice(0, length));
      if (key === "") continue;
      const alias = modeAliases.find((candidate) => comparison.candidate(candidate.phrase) === key);
      const named = alias ? [] : names.filter((name) => comparison.candidate(name) === key);
      if (!alias && named.length === 0) continue;
      if (named.length > 1) return { kind: "ambiguous", names: named };
      const args = words
        .slice(length)
        .join(" ")
        .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
      if (alias) return { kind: "match", target: alias.target, args, listed: isListed(alias.target, listed) };
      const prefix = mode === "skill" ? `/${SKILL_PREFIX}` : "/";
      return { kind: "match", target: `${prefix}${named[0]}`, args, listed: true };
    }
  return { kind: "none" };
}
