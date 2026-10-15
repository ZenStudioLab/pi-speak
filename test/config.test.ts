import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VOICE_ID_PLACEHOLDER,
  cacheDir,
  canonicalLocale,
  configPath,
  describeConfig,
  loadConfig,
  parseConfig,
  readApiKey,
} from "../config.ts";

const valid = {
  providers: {
    elevenlabs: { voiceId: "AbCdEf1234567890", modelId: "eleven_flash_v2_5" },
  },
};

test("a minimal configuration gets the documented defaults", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  assert.equal(result.config.locale, "vi");
  assert.equal(result.config.translation, undefined);
  assert.equal(result.config.provider, "elevenlabs");
  assert.equal(result.config.input.provider, "deepgram");
  assert.equal(result.config.input.maxSeconds, 120);
  assert.deepEqual(result.config.input.shortcut, ["alt+t"]);
  assert.deepEqual(result.config.input.transcribeShortcut, ["alt+shift+t"]);
  assert.equal(result.config.input.sendWhenBusy, "interrupt");
  assert.equal(result.config.input.stopOnPhrase, false);
  assert.deepEqual(result.config.input.stopPhrases, ["let's go"]);
  assert.equal(result.config.providers.elevenlabs.outputFormat, "mp3_44100_128");
  assert.equal(result.config.providers.elevenlabs.voiceRevision, 1);
  assert.equal(result.config.providers.elevenlabs.sttModel, "scribe_v2");
  assert.equal(result.config.providers.deepgram.sttModel, "nova-3");
  assert.equal(result.config.hardLimitChars, 10000);
  assert.equal(result.config.requestTimeoutMs, 45_000);
  assert.equal(result.config.cache.ttlDays, 7);
  assert.equal(result.config.cache.maxBytes, 100 * 1024 * 1024);
  assert.equal(result.config.player.command, "ffplay");
  assert.ok(result.config.player.args.includes("{file}"));
});

const invalid: [string, unknown, RegExp][] = [
  ["not an object", [], /JSON object/],
  [
    "placeholder voice",
    { providers: { elevenlabs: { ...valid.providers.elevenlabs, voiceId: VOICE_ID_PLACEHOLDER } } },
    /placeholder/,
  ],
  [
    "unsafe voice characters",
    { providers: { elevenlabs: { ...valid.providers.elevenlabs, voiceId: "a/b/c/d/e/f" } } },
    /voiceId must be/,
  ],
  [
    "limit above the ceiling",
    { ...valid, hardLimitChars: 10001 },
    /hardLimitChars must be between/,
  ],
  [
    "limit of zero",
    { ...valid, hardLimitChars: 0 },
    /hardLimitChars must be between/,
  ],
  [
    "fractional timeout",
    { ...valid, requestTimeoutMs: 1500.5 },
    /requestTimeoutMs must be an integer/,
  ],
  [
    "timeout too short",
    { ...valid, requestTimeoutMs: 10 },
    /requestTimeoutMs must be between/,
  ],
  [
    "player without file token",
    { ...valid, player: { args: ["-x"] } },
    /exactly once/,
  ],
  [
    "player with two file tokens",
    { ...valid, player: { args: ["{file}", "{file}"] } },
    /exactly once/,
  ],
  [
    "cache cap too small",
    { ...valid, cache: { maxBytes: 10 } },
    /cache.maxBytes must be between/,
  ],
  ["other provider", { ...valid, provider: "google" }, /provider must be/],
  ["empty locale", { ...valid, locale: "" }, /locale must be/],
  ["malformed locale", { ...valid, locale: "vi_VN" }, /locale must be/],
  ["null locale", { ...valid, locale: null }, /locale must be/],
  [
    "invalid translation",
    { ...valid, translation: {} },
    /translation.provider is not set/,
  ],
  ...["unknown", null, 1].map((thinking): [string, unknown, RegExp] => [
    `invalid translation thinking ${thinking}`,
    {
      ...valid,
      translation: { provider: "openai-codex", model: "gpt-6-luna", thinking },
    },
    /translation.thinking must be/,
  ]),
  [
    "translation credentials",
    {
      ...valid,
      translation: { provider: "openai", model: "gpt-test", apiKey: "secret" },
    },
    /credentials belong/,
  ],
];
for (const [name, input, expected] of invalid)
  test(`rejects ${name}`, () => {
    const result = parseConfig(input);
    assert.ok(!result.ok);
    assert.match(result.problem, expected);
  });

test("locale is canonical and translation setup is explicit and non-secret", () => {
  const result = parseConfig({
    ...valid,
    locale: "VI-vn",
    translation: { provider: "openai-codex", model: "gpt-test" },
  });
  assert.ok(result.ok);
  assert.equal(result.config.locale, "vi-VN");
  assert.deepEqual(result.config.translation, {
    provider: "openai-codex",
    model: "gpt-test",
  });
  assert.match(
    describeConfig(result.config, true).join("\n"),
    /locale: vi-VN\ntranslation: openai-codex\/gpt-test/,
  );
});

test("translation thinking accepts native levels, stays isolated, and is shown in status", () => {
  for (const thinking of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    const result = parseConfig({
      ...valid,
      translation: { provider: "openai-codex", model: "gpt-6-luna", thinking },
    });
    assert.ok(result.ok);
    assert.equal(result.config.translation?.thinking, thinking);
    assert.match(
      describeConfig(result.config, false).join("\n"),
      new RegExp(`thinking: ${thinking}`),
    );
  }
  const omitted = parseConfig({
    ...valid,
    translation: { provider: "openai-codex", model: "gpt-6-luna" },
  });
  assert.ok(omitted.ok);
  assert.equal(omitted.config.translation?.thinking, undefined);
  assert.match(
    describeConfig(omitted.config, false).join("\n"),
    /thinking: host default/,
  );
});

test("an unknown key is named but its value is never echoed", () => {
  const result = parseConfig({ ...valid, apiKey: "sk-super-secret-value" });
  assert.ok(!result.ok);
  assert.match(result.problem, /apiKey/);
  assert.match(result.problem, /ELEVENLABS_API_KEY/);
  assert.doesNotMatch(result.problem, /super-secret/);
});

test("loadConfig reports a missing file, invalid JSON, and oversize files without throwing", async () => {
  const env = { XDG_CONFIG_HOME: "/cfg" };
  const missing = await loadConfig(env, async () => {
    throw Object.assign(new Error("x"), { code: "ENOENT" });
  });
  assert.ok(!missing.ok);
  assert.match(
    missing.problem,
    /no configuration file at \/cfg\/pi-speak\/config\.json/,
  );
  const bad = await loadConfig(env, async () => "{nope");
  assert.ok(!bad.ok && /not valid JSON/.test(bad.problem));
  const big = await loadConfig(env, async () => " ".repeat(70 * 1024));
  assert.ok(!big.ok && /larger than/.test(big.problem));
  const good = await loadConfig(env, async () => JSON.stringify(valid));
  assert.ok(good.ok);
});

test("paths follow XDG with a home fallback", () => {
  assert.equal(
    configPath({ XDG_CONFIG_HOME: "/x" }, "/h"),
    "/x/pi-speak/config.json",
  );
  assert.equal(configPath({}, "/h"), "/h/.config/pi-speak/config.json");
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/c" }, "/h"), "/c/pi-speak");
  assert.equal(cacheDir({}, "/h"), "/h/.cache/pi-speak");
});

test("the API key comes only from the environment and is trimmed", () => {
  assert.equal(readApiKey({ ELEVENLABS_API_KEY: "  abc  " }), "abc");
  assert.equal(readApiKey({ ELEVENLABS_API_KEY: "   " }), undefined);
  assert.equal(readApiKey({}), undefined);
});

const aliasesOf = (count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`phrase ${i}`, `/target${i}`]));

test("provider blocks and input settings are parsed independently", () => {
  const result = parseConfig({
    provider: "deepgram",
    providers: {
      elevenlabs: { voiceId: "AbCdEf1234567890", modelId: "eleven_flash_v2_5", sttModel: "scribe_v2" },
      deepgram: { voice: "aura-2-thalia-en", sttModel: "nova-3" },
    },
    input: {
      provider: "elevenlabs",
      language: "VI-vn",
      maxSeconds: 300,
      shortcut: "ctrl+r",
      transcribeShortcut: "ctrl+shift+r",
      sendWhenBusy: "wait",
    },
  });
  assert.ok(result.ok);
  assert.equal(result.config.input.maxSeconds, 300);
  assert.deepEqual(result.config.input.shortcut, ["ctrl+r"]);
  assert.deepEqual(result.config.input.transcribeShortcut, ["ctrl+shift+r"]);
  assert.equal(result.config.input.sendWhenBusy, "wait");
  assert.equal(result.config.provider, "deepgram");
  assert.equal(result.config.input.language, "vi-VN");
  assert.equal(result.config.providers.deepgram.voice, "aura-2-thalia-en");
});

for (const [key, location] of Object.entries({
  voiceId: "providers.elevenlabs.voiceId",
  modelId: "providers.elevenlabs.modelId",
  outputFormat: "providers.elevenlabs.outputFormat",
  voiceRevision: "providers.elevenlabs.voiceRevision",
})) {
  test(`rejects old flat ${key} with its new location`, () => {
    const result = parseConfig({ ...valid, [key]: "old-value" });
    assert.ok(!result.ok);
    assert.match(result.problem, new RegExp(`${key}.*${location}`));
  });
}

for (const [name, input] of [
  ["zero", { ...valid, input: { maxSeconds: 0 } }],
  ["above maximum", { ...valid, input: { maxSeconds: 301 } }],
  ["fractional", { ...valid, input: { maxSeconds: 1.5 } }],
  ["malformed language", { ...valid, input: { language: "vi_VN" } }],
  ["unknown sendWhenBusy value", { ...valid, input: { sendWhenBusy: "now" } }],
  ["numeric sendWhenBusy", { ...valid, input: { sendWhenBusy: 1 } }],
  ["empty transcribe shortcut", { ...valid, input: { transcribeShortcut: " " } }],
  ["equal shortcuts", { ...valid, input: { shortcut: "alt+x", transcribeShortcut: "alt+x" } }],
  ["equal shortcuts differing in case", { ...valid, input: { shortcut: "Alt+X", transcribeShortcut: "alt+x" } }],
  ["a shortcut equal to the other's default", { ...valid, input: { shortcut: "alt+shift+t" } }],
  ["five send keys", { ...valid, input: { shortcut: ["alt+a", "alt+b", "alt+c", "alt+d", "alt+e"] } }],
  ["five transcribe keys", { ...valid, input: { transcribeShortcut: ["alt+a", "alt+b", "alt+c", "alt+d", "alt+e"] } }],
  ["an empty send list", { ...valid, input: { shortcut: [] } }],
  ["an empty transcribe list", { ...valid, input: { transcribeShortcut: [] } }],
  ["a blank key in a list", { ...valid, input: { shortcut: ["alt+t", " "] } }],
  ["a non-string key in a list", { ...valid, input: { shortcut: ["alt+t", 5] } }],
  ["a key repeated within a list", { ...valid, input: { shortcut: ["alt+y", "alt+y"] } }],
  ["a key repeated within a list, differing in case", { ...valid, input: { transcribeShortcut: ["alt+shift+y", "ALT+SHIFT+Y"] } }],
  ["a key repeated across the lists", { ...valid, input: { shortcut: ["alt+t", "alt+y"], transcribeShortcut: ["alt+shift+t", "alt+y"] } }],
  ["a key repeated across the lists, differing in case", { ...valid, input: { shortcut: ["alt+t", "Alt+Y"], transcribeShortcut: ["alt+shift+t", "alt+y"] } }],
  ["a non-boolean stopOnPhrase", { ...valid, input: { stopOnPhrase: "yes" } }],
  ["a numeric stopOnPhrase", { ...valid, input: { stopOnPhrase: 1 } }],
  ["stopPhrases that is not a list", { ...valid, input: { stopPhrases: "let's go" } }],
  ["an empty stopPhrases list", { ...valid, input: { stopPhrases: [] } }],
  ["more than 10 stopPhrases", { ...valid, input: { stopPhrases: Array.from({ length: 11 }, (_, i) => `phrase ${i}`) } }],
  ["an empty stop phrase", { ...valid, input: { stopPhrases: [""] } }],
  ["a blank stop phrase", { ...valid, input: { stopPhrases: ["ok", "   "] } }],
  ["a stop phrase over 40 characters", { ...valid, input: { stopPhrases: ["x".repeat(41)] } }],
  ["a non-string stop phrase", { ...valid, input: { stopPhrases: [5] } }],
  ["a non-boolean holdSpace", { ...valid, input: { holdSpace: "yes" } }],
  ["a numeric holdSpace", { ...valid, input: { holdSpace: 1 } }],
  ["a liveIdleMinutes of 0", { ...valid, input: { liveIdleMinutes: 0 } }],
  ["a liveIdleMinutes of 61", { ...valid, input: { liveIdleMinutes: 61 } }],
  ["a non-integer liveIdleMinutes", { ...valid, input: { liveIdleMinutes: 2.5 } }],
  ["a string liveIdleMinutes", { ...valid, input: { liveIdleMinutes: "5" } }],
  ["a non-boolean liveListenWhileSpeaking", { ...valid, input: { liveListenWhileSpeaking: "yes" } }],
  ["a numeric liveListenWhileSpeaking", { ...valid, input: { liveListenWhileSpeaking: 1 } }],
  ["liveStopPhrases that is not a list", { ...valid, input: { liveStopPhrases: "stop" } }],
  ["more than 10 liveStopPhrases", { ...valid, input: { liveStopPhrases: Array.from({ length: 11 }, (_, i) => `phrase ${i}`) } }],
  ["an empty live stop phrase", { ...valid, input: { liveStopPhrases: [""] } }],
  ["a live stop phrase over 40 characters", { ...valid, input: { liveStopPhrases: ["x".repeat(41)] } }],
  ["a live stop phrase with no letter or digit", { ...valid, input: { liveStopPhrases: ["stop", "..."] } }],
  ["a non-string live stop phrase", { ...valid, input: { liveStopPhrases: [5] } }],
  ["a command key equal to a send key", { ...valid, input: { commandShortcut: "alt+t" } }],
  ["a skill key equal to the command default", { ...valid, input: { skillShortcut: "alt+m" } }],
  ["a send key equal to the skill default", { ...valid, input: { shortcut: "alt+i" } }],
  ["command and skill keys equal, differing in case", { ...valid, input: { commandShortcut: "alt+x", skillShortcut: "ALT+X" } }],
  ["a key repeated within the command list", { ...valid, input: { commandShortcut: ["alt+y", "alt+y"] } }],
  ["five command keys", { ...valid, input: { commandShortcut: ["alt+a", "alt+b", "alt+c", "alt+d", "alt+e"] } }],
  ["an empty skill list", { ...valid, input: { skillShortcut: [] } }],
  ["commandAliases that is a list", { ...valid, input: { commandAliases: ["model"] } }],
  ["more than 50 aliases", { ...valid, input: { commandAliases: aliasesOf(51) } }],
  ["an empty alias phrase", { ...valid, input: { commandAliases: { "": "/model" } } }],
  ["a blank alias phrase", { ...valid, input: { commandAliases: { "   ": "/model" } } }],
  ["an alias phrase over 40 characters", { ...valid, input: { commandAliases: { ["a".repeat(41)]: "/model" } } }],
  ["an alias phrase with no letter or digit", { ...valid, input: { commandAliases: { "?! -": "/model" } } }],
  ["an alias phrase of nine words", { ...valid, input: { commandAliases: { "a b c d e f g h i": "/model" } } }],
  ["two alias phrases with one collapsed form", { ...valid, input: { commandAliases: { "op sx": "/a", "Op-SX!": "/b" } } }],
  ["an alias target without a slash", { ...valid, input: { commandAliases: { model: "model" } } }],
  ["an alias target of one character", { ...valid, input: { commandAliases: { model: "/" } } }],
  ["an alias target over 200 characters", { ...valid, input: { commandAliases: { model: `/${"a".repeat(200)}` } } }],
  ["an alias target on two lines", { ...valid, input: { commandAliases: { model: "/model\nsecond" } } }],
  ["a non-string alias target", { ...valid, input: { commandAliases: { model: 5 } } }],
] as const) {
  test(`rejects ${name} input setting`, () => {
    const result = parseConfig(input);
    assert.ok(!result.ok);
    assert.match(result.problem, /input\.(maxSeconds|language|sendWhenBusy|transcribeShortcut|shortcut|stopOnPhrase|stopPhrases|commandShortcut|skillShortcut|commandAliases|holdSpace|liveIdleMinutes|liveListenWhileSpeaking|liveStopPhrases)/);
  });
}

for (const [name, input, send, transcribe] of [
  ["strings", { shortcut: "alt+y", transcribeShortcut: "alt+shift+y" }, ["alt+y"], ["alt+shift+y"]],
  ["lists", { shortcut: ["alt+t", "alt+y"], transcribeShortcut: ["alt+shift+t", "alt+shift+y"] }, ["alt+t", "alt+y"], ["alt+shift+t", "alt+shift+y"]],
  ["four keys each", { shortcut: ["alt+a", "alt+b", "alt+c", "alt+d"], transcribeShortcut: ["alt+e", "alt+f", "alt+g", "alt+h"] }, ["alt+a", "alt+b", "alt+c", "alt+d"], ["alt+e", "alt+f", "alt+g", "alt+h"]],
  ["one list and one default", { shortcut: ["alt+t", "alt+y"] }, ["alt+t", "alt+y"], ["alt+shift+t"]],
] as const)
  test(`the shortcut settings accept ${name} and are read as lists`, () => {
    const result = parseConfig({ ...valid, input });
    assert.ok(result.ok);
    assert.deepEqual(result.config.input.shortcut, send);
    assert.deepEqual(result.config.input.transcribeShortcut, transcribe);
  });

test("a repeated shortcut key is a configuration error that names the key", () => {
  const result = parseConfig({ ...valid, input: { shortcut: ["alt+t", "alt+y"], transcribeShortcut: ["alt+shift+t", "ALT+Y"] } });
  assert.ok(!result.ok);
  assert.match(result.problem, /input\.shortcut, input\.transcribeShortcut, input\.commandShortcut and input\.skillShortcut must be different keys; "ALT\+Y" is repeated/);
});

test("the command and skill keys, aliases and holdSpace default to alt+m, alt+i, none and off", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  assert.deepEqual(result.config.input.commandShortcut, ["alt+m"]);
  assert.deepEqual(result.config.input.skillShortcut, ["alt+i"]);
  assert.deepEqual(result.config.input.commandAliases, []);
  assert.equal(result.config.input.holdSpace, false);
});

test("the live settings default to 5 minutes and off", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  assert.equal(result.config.input.liveIdleMinutes, 5);
  assert.equal(result.config.input.liveListenWhileSpeaking, false);
});

test("liveStopPhrases defaults to the Vietnamese and English pair, separate from stopPhrases", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  assert.deepEqual(result.config.input.liveStopPhrases, ["Dừng cuộc hội thoại", "Stop the conversation"]);
  assert.deepEqual(result.config.input.stopPhrases, ["let's go"]);
});

for (const [name, phrases, expected] of [
  ["an empty list, which turns the feature off", [], []],
  ["ten phrases", Array.from({ length: 10 }, (_, i) => `phrase ${i}`), Array.from({ length: 10 }, (_, i) => `phrase ${i}`)],
  ["phrases trimmed and at 1 and 40 characters", ["  x ", `${"y".repeat(39)}1`], ["x", `${"y".repeat(39)}1`]],
] as const)
  test(`liveStopPhrases accepts ${name}`, () => {
    const result = parseConfig({ ...valid, input: { liveStopPhrases: phrases } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.input.liveStopPhrases, expected);
  });

test("an unknown input key is still rejected beside the live settings", () => {
  const result = parseConfig({ ...valid, input: { liveIdleMinutes: 5, liveIdle: 5 } });
  assert.ok(!result.ok);
  assert.match(result.problem, /input contains unknown key\(s\): liveIdle$/);
});

for (const minutes of [1, 60])
  test(`liveIdleMinutes accepts the bound ${minutes} and liveListenWhileSpeaking accepts true`, () => {
    const result = parseConfig({ ...valid, input: { liveIdleMinutes: minutes, liveListenWhileSpeaking: true } });
    assert.ok(result.ok);
    assert.equal(result.config.input.liveIdleMinutes, minutes);
    assert.equal(result.config.input.liveListenWhileSpeaking, true);
  });

test("the command and skill keys, aliases and holdSpace are read, with phrases trimmed and at the limits", () => {
  const limit = { ["x".repeat(40)]: "/a", " a b c d e f g h ": `/${"y".repeat(199)}`, "Mô hình": "/model", ...aliasesOf(47) };
  const result = parseConfig({
    ...valid,
    input: { commandShortcut: ["alt+j", "alt+k"], skillShortcut: "alt+l", holdSpace: true, commandAliases: limit },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.config.input.commandShortcut, ["alt+j", "alt+k"]);
  assert.deepEqual(result.config.input.skillShortcut, ["alt+l"]);
  assert.equal(result.config.input.holdSpace, true);
  assert.equal(result.config.input.commandAliases.length, 50);
  assert.deepEqual(result.config.input.commandAliases.slice(0, 4), [
    { phrase: "x".repeat(40), target: "/a" },
    { phrase: "a b c d e f g h", target: `/${"y".repeat(199)}` },
    { phrase: "Mô hình", target: "/model" },
    { phrase: "phrase 0", target: "/target0" },
  ]);
});

test("an alias error names the setting and never echoes the phrase or the target", () => {
  const result = parseConfig({ ...valid, input: { commandAliases: { "secret phrase": "no-slash-secret" } } });
  assert.ok(!result.ok);
  assert.match(result.problem, /input\.commandAliases/);
  assert.doesNotMatch(result.problem, /secret/);
});

test("the stop phrase settings are read, with phrases trimmed and at most 10 of 1 to 40 characters", () => {
  const result = parseConfig({
    ...valid,
    input: { stopOnPhrase: true, stopPhrases: ["  send it  ", "x", "y".repeat(40), ...Array(7).fill("again")] },
  });
  assert.ok(result.ok);
  assert.equal(result.config.input.stopOnPhrase, true);
  assert.deepEqual(result.config.input.stopPhrases.slice(0, 3), ["send it", "x", "y".repeat(40)]);
  assert.equal(result.config.input.stopPhrases.length, 10);
  const listed = parseConfig({ ...valid, input: { stopPhrases: ["ship it"] } });
  assert.ok(listed.ok, "a phrase list is valid while the feature is off");
  assert.equal(listed.config.input.stopOnPhrase, false);
});

test("the status view shows whether the stop phrase is on and which phrases count", () => {
  for (const [input, expected] of [
    [undefined, /^stop phrase: off; phrases: "let's go"$/m],
    [{ stopOnPhrase: true, stopPhrases: ["let's go", "send it"] }, /^stop phrase: on \(audio streams to ElevenLabs while recording\); phrases: "let's go", "send it"$/m],
  ] as const) {
    const result = parseConfig({ ...valid, input });
    assert.ok(result.ok);
    assert.match(describeConfig(result.config, true).join("\n"), expected);
  }
});

test("a session locale is marked in the status view", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  assert.match(describeConfig(result.config, true).join("\n"), /^locale: vi$/m);
  assert.match(
    describeConfig(result.config, true, { speechLocale: "en" }).join("\n"),
    /^locale: en \(session override\)$/m,
  );
});

test("canonicalLocale canonicalizes valid tags and rejects malformed ones", () => {
  assert.equal(canonicalLocale("VI-vn"), "vi-VN");
  assert.equal(canonicalLocale("not_a_tag"), undefined);
  assert.equal(canonicalLocale(""), undefined);
});

test("the status view shows only the voice suffix and whether a key exists", () => {
  const result = parseConfig(valid);
  assert.ok(result.ok);
  const text = describeConfig(result.config, true).join("\n");
  assert.match(text, /voice: \.\.\.7890/);
  assert.doesNotMatch(text, /AbCdEf1234567890/);
  assert.match(text, /ELEVENLABS_API_KEY: present/);
  assert.match(
    describeConfig(result.config, false).join("\n"),
    /ELEVENLABS_API_KEY: missing/,
  );
});
