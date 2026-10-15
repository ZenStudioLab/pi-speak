import type { SpeechProvider } from "./config.ts";
import {
  checkedString,
  fail,
  integerInRange,
  isRecord,
  parseLocale,
} from "./config-validation.ts";
import {
  collapse,
  MAX_PHRASE_TOKENS,
  tokensOf,
  type CommandAlias,
} from "./voice-command.ts";

export interface InputConfig {
  provider: SpeechProvider;
  language?: string;
  maxSeconds: number;
  shortcut: string[];
  transcribeShortcut: string[];
  commandShortcut: string[];
  skillShortcut: string[];
  /** Keys that start live mode and end it, as `/talk live` does. */
  liveShortcut: string[];
  sendWhenBusy: "interrupt" | "wait";
  stopOnPhrase: boolean;
  stopPhrases: string[];
  commandAliases: CommandAlias[];
  holdSpace: boolean;
  /** Minutes of agent idleness after which live mode ends. */
  liveIdleMinutes: number;
  /** Keep sending microphone audio while Pi speaks, so speaking cuts Pi off. */
  liveListenWhileSpeaking: boolean;
  /** Whole-turn phrases that end live mode when said; empty turns the feature off. */
  liveStopPhrases: string[];
  /** Seconds of silence after which the provider ends a live turn. */
  livePauseSeconds: number;
  /** Languages live mode listens for, besides `language`; empty means no limit. */
  liveLanguages: string[];
}

const DEFAULTS = {
  provider: "deepgram" as const,
  maxSeconds: 120,
  shortcut: "alt+t",
  transcribeShortcut: "alt+shift+t",
  commandShortcut: "alt+m",
  skillShortcut: "alt+i",
  liveShortcut: "alt+l",
  sendWhenBusy: "interrupt" as const,
  stopOnPhrase: false,
  stopPhrases: ["let's go"],
  holdSpace: false,
  liveIdleMinutes: 5,
  liveListenWhileSpeaking: false,
  liveStopPhrases: ["Dừng cuộc hội thoại", "Stop the conversation"],
  livePauseSeconds: 2,
  liveLanguages: [] as string[],
} as const;

const INPUT_KEYS = [
  "provider",
  "language",
  "maxSeconds",
  "shortcut",
  "transcribeShortcut",
  "commandShortcut",
  "skillShortcut",
  "liveShortcut",
  "sendWhenBusy",
  "stopOnPhrase",
  "stopPhrases",
  "commandAliases",
  "holdSpace",
  "liveIdleMinutes",
  "liveListenWhileSpeaking",
  "liveStopPhrases",
  "livePauseSeconds",
  "liveLanguages",
];
const SHORTCUT_SETTINGS = ["shortcut", "transcribeShortcut", "commandShortcut", "skillShortcut", "liveShortcut"] as const;
const MAX_ALIASES = 50;

function parseStopPhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    fail("input.stopPhrases must be a list of 1 to 10 phrases");
  return value.map((phrase) => {
    const trimmed = typeof phrase === "string" ? phrase.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 40)
      fail("input.stopPhrases entries must be strings of 1 to 40 characters");
    return trimmed;
  });
}

/** 0 to 10 phrases that can match a turn, so each needs a letter or digit; an empty list turns the feature off. */
function parseLiveStopPhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10)
    fail("input.liveStopPhrases must be a list of 0 to 10 phrases");
  return value.map((phrase) => {
    const trimmed = typeof phrase === "string" ? phrase.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 40 || !/[\p{L}\p{N}]/u.test(trimmed))
      fail("input.liveStopPhrases entries must be strings of 1 to 40 characters with at least one letter or digit");
    return trimmed;
  });
}

/** The provider accepts a silence threshold of 0.3 to 3 seconds and refuses anything else. */
function parseLivePauseSeconds(value: unknown): number {
  if (typeof value !== "number" || !(value >= 0.3 && value <= 3))
    fail("input.livePauseSeconds must be a number from 0.3 to 3");
  return value;
}

/** 0 to 10 language tags, each valid as `input.language` is. */
function parseLiveLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10)
    fail("input.liveLanguages must be a list of 0 to 10 language tags");
  return value.map((tag) => parseLocale(tag, "input.liveLanguages entries"));
}

/** One key or a list of 1 to 4 keys, as a list. */
function parseShortcutKeys(value: unknown, name: string): string[] {
  const keys = Array.isArray(value) ? value : [value];
  if (keys.length < 1 || keys.length > 4)
    fail(`${name} must be one key or a list of 1 to 4 keys`);
  return keys.map((key) =>
    checkedString(key, name, /^.{1,100}$/, `${name} must be a non-empty string or a list of 1 to 4 non-empty strings`),
  );
}

/** At most 50 phrases of 1 to 40 characters and 8 words, none sharing a collapsed form, each mapped to a one-line target starting with `/`. */
function parseCommandAliases(value: unknown): CommandAlias[] {
  if (!isRecord(value)) fail("input.commandAliases must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_ALIASES)
    fail(`input.commandAliases can hold at most ${MAX_ALIASES} entries`);
  const forms = new Set<string>();
  return entries.map(([rawPhrase, target]) => {
    const phrase = rawPhrase.trim();
    if (phrase.length < 1 || phrase.length > 40)
      fail("input.commandAliases phrases must be 1 to 40 characters");
    if (tokensOf(phrase).length > MAX_PHRASE_TOKENS)
      fail(`input.commandAliases phrases can have at most ${MAX_PHRASE_TOKENS} words`);
    const form = collapse(phrase);
    if (form === "")
      fail("input.commandAliases phrases need at least one letter or digit");
    if (forms.has(form))
      fail("input.commandAliases has two phrases that are the same once spaces and punctuation are ignored");
    forms.add(form);
    if (
      typeof target !== "string" ||
      target.length < 2 ||
      target.length > 200 ||
      !target.startsWith("/") ||
      /[\r\n\u2028\u2029]/.test(target)
    )
      fail("input.commandAliases targets must be one line of 2 to 200 characters starting with /");
    return { phrase, target };
  });
}

/** Parses the `input` block; an absent block gives the defaults. Messages name keys only. */
export function parseInput(value: unknown): InputConfig {
  const input = value === undefined ? {} : value;
  if (!isRecord(input)) fail("input must be an object");
  const unknown = Object.keys(input).filter((key) => !INPUT_KEYS.includes(key));
  if (unknown.length > 0)
    fail(`input contains unknown key(s): ${unknown.join(", ")}`);
  const provider = input.provider ?? DEFAULTS.provider;
  if (provider !== "deepgram" && provider !== "elevenlabs")
    fail('input.provider must be "deepgram" or "elevenlabs"');
  const sendWhenBusy = input.sendWhenBusy ?? DEFAULTS.sendWhenBusy;
  if (sendWhenBusy !== "interrupt" && sendWhenBusy !== "wait")
    fail('input.sendWhenBusy must be "interrupt" or "wait"');
  const stopOnPhrase = input.stopOnPhrase ?? DEFAULTS.stopOnPhrase;
  if (typeof stopOnPhrase !== "boolean") fail("input.stopOnPhrase must be true or false");
  const holdSpace = input.holdSpace ?? DEFAULTS.holdSpace;
  if (typeof holdSpace !== "boolean") fail("input.holdSpace must be true or false");
  const liveListenWhileSpeaking = input.liveListenWhileSpeaking ?? DEFAULTS.liveListenWhileSpeaking;
  if (typeof liveListenWhileSpeaking !== "boolean")
    fail("input.liveListenWhileSpeaking must be true or false");
  const [shortcut, transcribeShortcut, commandShortcut, skillShortcut, liveShortcut] = SHORTCUT_SETTINGS.map(
    (name) => parseShortcutKeys(input[name] ?? DEFAULTS[name], `input.${name}`),
  ) as [string[], string[], string[], string[], string[]];
  const seen = new Set<string>();
  for (const key of [...shortcut, ...transcribeShortcut, ...commandShortcut, ...skillShortcut, ...liveShortcut]) {
    if (seen.has(key.toLowerCase()))
      fail(`input.shortcut, input.transcribeShortcut, input.commandShortcut, input.skillShortcut and input.liveShortcut must be different keys; "${key}" is repeated`);
    seen.add(key.toLowerCase());
  }
  return {
    provider,
    language:
      input.language === undefined
        ? undefined
        : parseLocale(input.language, "input.language"),
    maxSeconds: integerInRange(
      input.maxSeconds ?? DEFAULTS.maxSeconds,
      "input.maxSeconds",
      1,
      300,
    ),
    shortcut,
    transcribeShortcut,
    commandShortcut,
    skillShortcut,
    liveShortcut,
    sendWhenBusy,
    stopOnPhrase,
    stopPhrases: parseStopPhrases(input.stopPhrases ?? DEFAULTS.stopPhrases),
    commandAliases: input.commandAliases === undefined ? [] : parseCommandAliases(input.commandAliases),
    holdSpace,
    liveIdleMinutes: integerInRange(
      input.liveIdleMinutes ?? DEFAULTS.liveIdleMinutes,
      "input.liveIdleMinutes",
      1,
      60,
    ),
    liveListenWhileSpeaking,
    liveStopPhrases: parseLiveStopPhrases(input.liveStopPhrases ?? DEFAULTS.liveStopPhrases),
    livePauseSeconds: parseLivePauseSeconds(input.livePauseSeconds ?? DEFAULTS.livePauseSeconds),
    liveLanguages: parseLiveLanguages(input.liveLanguages ?? DEFAULTS.liveLanguages),
  };
}
