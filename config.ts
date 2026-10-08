import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const VOICE_ID_PLACEHOLDER = "SET_YOUR_AUTHORIZED_VOICE_ID";
export const API_KEY_ENV = "ELEVENLABS_API_KEY";
export const DEEPGRAM_API_KEY_ENV = "DEEPGRAM_API_KEY";
export const HARD_LIMIT_CEILING = 10000;
export const PROVIDER_HARD_LIMIT_CEILINGS = {
  elevenlabs: 10000,
  deepgram: 2000,
} as const;
const MAX_CONFIG_BYTES = 64 * 1024;

export type SpeechProvider = "elevenlabs" | "deepgram";

export interface ElevenLabsConfig {
  voiceId?: string;
  modelId?: string;
  outputFormat: string;
  voiceRevision: number;
  sttModel: string;
}

export interface DeepgramConfig {
  voice?: string;
  sttModel: string;
}

export interface SpeakConfig {
  provider: SpeechProvider;
  providers: { elevenlabs: ElevenLabsConfig; deepgram: DeepgramConfig };
  input: {
    provider: SpeechProvider;
    language?: string;
    maxSeconds: number;
    shortcut: string;
  };
  locale: string;
  translation?: { provider: string; model: string; thinking?: ThinkingLevel };
  hardLimitChars: number;
  requestTimeoutMs: number;
  player: { command: string; args: string[] };
  cache: { maxBytes: number; ttlDays: number };
}

export type ConfigResult =
  | { ok: true; config: SpeakConfig }
  | { ok: false; problem: string };

export type Env = Readonly<Record<string, string | undefined>>;

const DEFAULTS = {
  provider: "elevenlabs" as const,
  outputFormat: "mp3_44100_128",
  voiceRevision: 1,
  elevenLabsSttModel: "scribe_v2",
  deepgramSttModel: "nova-3",
  inputProvider: "deepgram" as const,
  inputMaxSeconds: 60,
  inputShortcut: "alt+t",
  hardLimitChars: HARD_LIMIT_CEILING,
  requestTimeoutMs: 45_000,
  player: {
    command: "ffplay",
    args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "{file}"],
  },
  cache: { maxBytes: 100 * 1024 * 1024, ttlDays: 7 },
} as const;

const TOP_LEVEL_KEYS = new Set([
  "provider",
  "providers",
  "input",
  "locale",
  "translation",
  "hardLimitChars",
  "requestTimeoutMs",
  "player",
  "cache",
]);
const FLAT_KEY_LOCATIONS: Record<string, string> = {
  voiceId: "providers.elevenlabs.voiceId",
  modelId: "providers.elevenlabs.modelId",
  outputFormat: "providers.elevenlabs.outputFormat",
  voiceRevision: "providers.elevenlabs.voiceRevision",
};

/** `$XDG_CONFIG_HOME/pi-speak/config.json`, falling back to `~/.config/pi-speak/config.json`. */
export function configPath(env: Env, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "pi-speak", "config.json");
}

/** `$XDG_CACHE_HOME/pi-speak`, falling back to `~/.cache/pi-speak`. */
export function cacheDir(env: Env, home: string = homedir()): string {
  const base = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return join(base, "pi-speak");
}

/** The API key is read only from the environment and never from the configuration file. */
export function readApiKey(env: Env): string | undefined {
  return env[API_KEY_ENV]?.trim() || undefined;
}

export function readProviderApiKey(
  env: Env,
  provider: SpeechProvider,
): string | undefined {
  const name = provider === "elevenlabs" ? API_KEY_ENV : DEEPGRAM_API_KEY_ENV;
  return env[name]?.trim() || undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class ConfigProblem extends Error {}

function fail(problem: string): never {
  throw new ConfigProblem(problem);
}

function integerInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    fail(`${name} must be an integer`);
  if (value < min || value > max)
    fail(`${name} must be between ${min} and ${max}`);
  return value;
}

function checkedString(
  value: unknown,
  name: string,
  pattern: RegExp,
  message: string,
): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} is not set`);
  if (!pattern.test(value)) fail(message);
  return value;
}

function optionalString(
  value: unknown,
  name: string,
  pattern: RegExp,
  message: string,
): string | undefined {
  if (value === undefined) return undefined;
  return checkedString(value, name, pattern, message);
}

function parseVoiceId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (value === VOICE_ID_PLACEHOLDER || value.startsWith("SET_"))
  )
    fail(`${name} is still the placeholder; set your authorized voice ID`);
  return checkedString(
    value,
    name,
    /^[A-Za-z0-9_-]{6,64}$/,
    `${name} must be 6-64 letters, digits, underscores, or hyphens`,
  );
}

function parsePlayer(value: unknown): SpeakConfig["player"] {
  if (!isRecord(value)) fail("player must be an object");
  const command = value.command ?? DEFAULTS.player.command;
  const args = value.args ?? DEFAULTS.player.args;
  if (typeof command !== "string" || command.trim() === "")
    fail("player.command must be a non-empty string");
  if (
    !Array.isArray(args) ||
    !args.every((arg): arg is string => typeof arg === "string")
  )
    fail("player.args must be an array of strings");
  if (args.filter((arg) => arg === "{file}").length !== 1)
    fail('player.args must contain the element "{file}" exactly once');
  return { command, args: [...args] };
}

function parseCache(value: unknown): SpeakConfig["cache"] {
  if (!isRecord(value)) fail("cache must be an object");
  return {
    maxBytes: integerInRange(
      value.maxBytes ?? DEFAULTS.cache.maxBytes,
      "cache.maxBytes",
      1024 * 1024,
      2 ** 40,
    ),
    ttlDays: integerInRange(
      value.ttlDays ?? DEFAULTS.cache.ttlDays,
      "cache.ttlDays",
      1,
      365,
    ),
  };
}

function parseLocale(value: unknown, name = "locale"): string {
  if (typeof value !== "string" || value === "")
    fail(`${name} must be a non-empty BCP-47 language tag`);
  try {
    return Intl.getCanonicalLocales(value)[0]!;
  } catch {
    return fail(`${name} must be a valid BCP-47 language tag`);
  }
}

function parseTranslation(value: unknown): SpeakConfig["translation"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => key !== "provider" && key !== "model" && key !== "thinking",
    )
  )
    fail(
      "translation must contain only provider, model, and thinking; credentials belong in Pi authentication",
    );
  const levels: readonly ThinkingLevel[] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (
    value.thinking !== undefined &&
    !levels.includes(value.thinking as ThinkingLevel)
  )
    fail(
      "translation.thinking must be minimal, low, medium, high, xhigh, or max",
    );
  const name = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
  return {
    provider: checkedString(
      value.provider,
      "translation.provider",
      name,
      "translation.provider contains unsupported characters",
    ),
    model: checkedString(
      value.model,
      "translation.model",
      name,
      "translation.model contains unsupported characters",
    ),
    ...(value.thinking === undefined
      ? {}
      : { thinking: value.thinking as ThinkingLevel }),
  };
}

function parseProviders(value: unknown): SpeakConfig["providers"] {
  if (value === undefined) return {
    elevenlabs: {
      outputFormat: DEFAULTS.outputFormat,
      voiceRevision: DEFAULTS.voiceRevision,
      sttModel: DEFAULTS.elevenLabsSttModel,
    },
    deepgram: { sttModel: DEFAULTS.deepgramSttModel },
  };
  if (!isRecord(value)) fail("providers must be an object");
  const unknown = Object.keys(value).filter(
    (key) => key !== "elevenlabs" && key !== "deepgram",
  );
  if (unknown.length > 0)
    fail(`providers contains unknown key(s): ${unknown.join(", ")}`);
  const eleven = value.elevenlabs;
  if (eleven !== undefined && !isRecord(eleven))
    fail("providers.elevenlabs must be an object");
  const deepgram = value.deepgram;
  if (deepgram !== undefined && !isRecord(deepgram))
    fail("providers.deepgram must be an object");
  const elevenKeys = ["voiceId", "modelId", "outputFormat", "voiceRevision", "sttModel"];
  if (eleven && Object.keys(eleven).some((key) => !elevenKeys.includes(key)))
    fail("providers.elevenlabs contains an unknown key");
  const deepgramKeys = ["voice", "sttModel"];
  if (deepgram && Object.keys(deepgram).some((key) => !deepgramKeys.includes(key)))
    fail("providers.deepgram contains an unknown key");
  return {
    elevenlabs: {
      voiceId: parseVoiceId(eleven?.voiceId, "providers.elevenlabs.voiceId"),
      modelId: optionalString(
        eleven?.modelId,
        "providers.elevenlabs.modelId",
        /^[A-Za-z0-9_.-]{1,64}$/,
        "providers.elevenlabs.modelId contains unsupported characters",
      ),
      outputFormat: checkedString(
        eleven?.outputFormat ?? DEFAULTS.outputFormat,
        "providers.elevenlabs.outputFormat",
        /^[a-z0-9_]{1,32}$/,
        "providers.elevenlabs.outputFormat must be lowercase letters, digits, and underscores",
      ),
      voiceRevision: integerInRange(
        eleven?.voiceRevision ?? DEFAULTS.voiceRevision,
        "providers.elevenlabs.voiceRevision",
        1,
        1_000_000,
      ),
      sttModel: checkedString(
        eleven?.sttModel ?? DEFAULTS.elevenLabsSttModel,
        "providers.elevenlabs.sttModel",
        /^[A-Za-z0-9_.-]{1,64}$/,
        "providers.elevenlabs.sttModel contains unsupported characters",
      ),
    },
    deepgram: {
      voice: optionalString(
        deepgram?.voice,
        "providers.deepgram.voice",
        /^[A-Za-z0-9_.-]{1,128}$/,
        "providers.deepgram.voice contains unsupported characters",
      ),
      sttModel: checkedString(
        deepgram?.sttModel ?? DEFAULTS.deepgramSttModel,
        "providers.deepgram.sttModel",
        /^[A-Za-z0-9_.-]{1,64}$/,
        "providers.deepgram.sttModel contains unsupported characters",
      ),
    },
  };
}

function parseInput(value: unknown): SpeakConfig["input"] {
  if (value === undefined)
    return {
      provider: DEFAULTS.inputProvider,
      maxSeconds: DEFAULTS.inputMaxSeconds,
      shortcut: DEFAULTS.inputShortcut,
    };
  if (!isRecord(value)) fail("input must be an object");
  const unknown = Object.keys(value).filter(
    (key) => !["provider", "language", "maxSeconds", "shortcut"].includes(key),
  );
  if (unknown.length > 0)
    fail(`input contains unknown key(s): ${unknown.join(", ")}`);
  const provider = value.provider ?? DEFAULTS.inputProvider;
  if (provider !== "deepgram" && provider !== "elevenlabs")
    fail('input.provider must be "deepgram" or "elevenlabs"');
  return {
    provider,
    language:
      value.language === undefined
        ? undefined
        : parseLocale(value.language, "input.language"),
    maxSeconds: integerInRange(
      value.maxSeconds ?? DEFAULTS.inputMaxSeconds,
      "input.maxSeconds",
      1,
      300,
    ),
    shortcut: checkedString(
      value.shortcut ?? DEFAULTS.inputShortcut,
      "input.shortcut",
      /^.{1,100}$/,
      "input.shortcut must be a non-empty string",
    ),
  };
}

function buildConfig(raw: Record<string, unknown>): SpeakConfig {
  const old = Object.keys(raw).filter((key) => FLAT_KEY_LOCATIONS[key]);
  if (old.length > 0)
    fail(
      `${old[0]} is no longer a top-level setting; use ${FLAT_KEY_LOCATIONS[old[0]!]}`,
    );
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0)
    fail(
      `unknown configuration key(s): ${unknown.join(", ")}. Secrets belong in ${API_KEY_ENV}, not in this file`,
    );
  const provider = raw.provider ?? DEFAULTS.provider;
  if (provider !== "elevenlabs" && provider !== "deepgram")
    fail('provider must be "elevenlabs" or "deepgram"');
  return {
    provider,
    providers: parseProviders(raw.providers),
    input: parseInput(raw.input),
    locale: parseLocale(raw.locale === undefined ? "vi" : raw.locale),
    translation: parseTranslation(raw.translation),
    hardLimitChars: integerInRange(
      raw.hardLimitChars ?? DEFAULTS.hardLimitChars,
      "hardLimitChars",
      1,
      HARD_LIMIT_CEILING,
    ),
    requestTimeoutMs: integerInRange(
      raw.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      "requestTimeoutMs",
      1_000,
      120_000,
    ),
    player: parsePlayer(raw.player ?? DEFAULTS.player),
    cache: parseCache(raw.cache ?? DEFAULTS.cache),
  };
}

/** Validates parsed JSON. Messages name keys only and never echo configured values. */
export function parseConfig(raw: unknown): ConfigResult {
  if (!isRecord(raw))
    return { ok: false, problem: "configuration must be a JSON object" };
  try {
    return { ok: true, config: buildConfig(raw) };
  } catch (error) {
    if (error instanceof ConfigProblem)
      return { ok: false, problem: error.message };
    throw error;
  }
}

/** Reads and validates the configuration on demand, and once at load for `input.shortcut`. */
export async function loadConfig(
  env: Env,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  home?: string,
): Promise<ConfigResult> {
  const path = configPath(env, home);
  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      problem:
        code === "ENOENT"
          ? `no configuration file at ${path}`
          : `cannot read ${path}`,
    };
  }
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
    return {
      ok: false,
      problem: `${path} is larger than ${MAX_CONFIG_BYTES} bytes`,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${path} is not valid JSON` };
  }
  return parseConfig(raw);
}

export function effectiveSpeechProvider(
  config: SpeakConfig,
  override?: SpeechProvider,
): SpeechProvider {
  return override ?? config.provider;
}

/** Status lines contain only redacted settings and key presence, never credential values. */
export function describeConfig(
  config: SpeakConfig,
  keyPresent: boolean | { elevenlabs: boolean; deepgram: boolean },
  options: {
    speechProvider?: SpeechProvider;
    inputProviderOverride?: SpeechProvider;
    recordingTool?: string;
  } = {},
): string[] {
  const keys =
    typeof keyPresent === "boolean"
      ? { elevenlabs: keyPresent, deepgram: false }
      : keyPresent;
  const provider = options.speechProvider ?? config.provider;
  const voice = provider === "elevenlabs"
    ? config.providers.elevenlabs.voiceId
      ? `...${config.providers.elevenlabs.voiceId.slice(-4)} (revision ${config.providers.elevenlabs.voiceRevision})`
      : "not configured"
    : config.providers.deepgram.voice
      ? `...${config.providers.deepgram.voice.slice(-4)}`
      : "not configured";
  const model = provider === "elevenlabs"
    ? config.providers.elevenlabs.modelId ?? "not configured"
    : "Aura voice model";
  const format = provider === "elevenlabs" ? config.providers.elevenlabs.outputFormat : "mp3";
  const limit = Math.min(config.hardLimitChars, PROVIDER_HARD_LIMIT_CEILINGS[provider]);
  const inputProvider = options.inputProviderOverride ?? config.input.provider;
  return [
    `speech provider: ${provider}${options.speechProvider ? " (session override)" : ""}`,
    `voice: ${voice}`,
    `model: ${model}`,
    `format: ${format}`,
    `player: ${config.player.command}`,
    `limit: ${limit} characters, timeout ${config.requestTimeoutMs} ms`,
    `input provider: ${inputProvider}${options.inputProviderOverride ? " (session override)" : ""}`,
    `input model: ${inputProvider === "elevenlabs" ? config.providers.elevenlabs.sttModel : config.providers.deepgram.sttModel}`,
    `input language: ${config.input.language ?? "auto-detect"}`,
    `${API_KEY_ENV}: ${keys.elevenlabs ? "present" : "missing"}`,
    `${DEEPGRAM_API_KEY_ENV}: ${keys.deepgram ? "present" : "missing"}`,
    `recording tool: ${options.recordingTool ?? "not found"}`,
    `locale: ${config.locale}`,
    `translation: ${config.translation ? `${config.translation.provider}/${config.translation.model} (thinking: ${config.translation.thinking ?? "host default"})` : "not configured"}`,
    `cache: ${config.cache.ttlDays} days, ${config.cache.maxBytes} bytes`,
  ];
}