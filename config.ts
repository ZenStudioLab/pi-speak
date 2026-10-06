import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const VOICE_ID_PLACEHOLDER = "SET_YOUR_AUTHORIZED_VOICE_ID";
export const API_KEY_ENV = "ELEVENLABS_API_KEY";
export const HARD_LIMIT_CEILING = 4000;
const MAX_CONFIG_BYTES = 64 * 1024;

export interface SpeakConfig {
  provider: "elevenlabs";
  voiceId: string;
  modelId: string;
  outputFormat: string;
  voiceRevision: number;
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
  provider: "elevenlabs",
  outputFormat: "mp3_44100_128",
  voiceRevision: 1,
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
  "voiceId",
  "modelId",
  "outputFormat",
  "voiceRevision",
  "locale",
  "translation",
  "hardLimitChars",
  "requestTimeoutMs",
  "player",
  "cache",
]);

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

function parseVoiceId(value: unknown): string {
  if (
    typeof value === "string" &&
    (value === VOICE_ID_PLACEHOLDER || value.startsWith("SET_"))
  )
    fail("voiceId is still the placeholder; set your authorized voice ID");
  return checkedString(
    value,
    "voiceId",
    /^[A-Za-z0-9_-]{6,64}$/,
    "voiceId must be 6-64 letters, digits, underscores, or hyphens",
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

function parseLocale(value: unknown): string {
  if (typeof value !== "string" || value === "")
    fail("locale must be a non-empty BCP-47 language tag");
  try {
    return Intl.getCanonicalLocales(value)[0]!;
  } catch {
    return fail("locale must be a valid BCP-47 language tag");
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

function buildConfig(raw: Record<string, unknown>): SpeakConfig {
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0)
    fail(
      `unknown configuration key(s): ${unknown.join(", ")}. Secrets belong in ${API_KEY_ENV}, not in this file`,
    );
  if ((raw.provider ?? DEFAULTS.provider) !== "elevenlabs")
    fail('provider must be "elevenlabs"');
  return {
    provider: "elevenlabs",
    voiceId: parseVoiceId(raw.voiceId),
    locale: parseLocale(raw.locale === undefined ? "vi" : raw.locale),
    translation: parseTranslation(raw.translation),
    modelId: checkedString(
      raw.modelId,
      "modelId",
      /^[A-Za-z0-9_.-]{1,64}$/,
      "modelId contains unsupported characters",
    ),
    outputFormat: checkedString(
      raw.outputFormat ?? DEFAULTS.outputFormat,
      "outputFormat",
      /^[a-z0-9_]{1,32}$/,
      "outputFormat must be lowercase letters, digits, and underscores",
    ),
    voiceRevision: integerInRange(
      raw.voiceRevision ?? DEFAULTS.voiceRevision,
      "voiceRevision",
      1,
      1_000_000,
    ),
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

/** Reads and validates the configuration on demand; nothing is read when the extension loads. */
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

/** Status lines with no secret: only the last four voice characters and whether a key exists. */
export function describeConfig(
  config: SpeakConfig,
  keyPresent: boolean,
): string[] {
  return [
    `provider: ${config.provider}`,
    `voice: ...${config.voiceId.slice(-4)} (revision ${config.voiceRevision})`,
    `model: ${config.modelId}`,
    `locale: ${config.locale}`,
    `translation: ${config.translation ? `${config.translation.provider}/${config.translation.model} (thinking: ${config.translation.thinking ?? "host default"})` : "not configured"}`,
    `format: ${config.outputFormat}`,
    `player: ${config.player.command}`,
    `limit: ${config.hardLimitChars} characters, timeout ${config.requestTimeoutMs} ms`,
    `cache: ${config.cache.ttlDays} days, ${config.cache.maxBytes} bytes`,
    `${API_KEY_ENV}: ${keyPresent ? "present" : "missing"}`,
  ];
}
