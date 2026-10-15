import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { VALID_CONFIG, answer, createHarness } from "./harness.ts";
import {
  TRANSLATION_CONFIG,
  translatedMessage,
  translationFixture,
} from "./translation-fixture.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const open: Harness[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.cleanup();
});
async function harness(
  options?: Parameters<typeof createHarness>[0],
): Promise<Harness> {
  const h = await createHarness(options);
  open.push(h);
  return h;
}
const quiet = (h: Harness) => {
  assert.equal(h.fetchCalls.length, 0, "no provider request");
  assert.equal(h.spawnCalls.length, 0, "no player started");
};

for (const mode of ["", "original"])
  for (const retention of ["assistant-only", "none"])
    test(`${mode || "localized"} routing speaks original transcript after ${retention} compaction`, async () => {
      const h = await harness({
        config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG },
      });
      const session = SessionManager.inMemory(h.dir);
      const ids = answer("Original answer.").map((message) =>
        session.appendMessage(message as never),
      );
      session.appendCompaction(
        "Summary text must not be spoken.",
        retention === "none" ? null : ids[1],
        100,
      );
      const translation = translationFixture();
      translation.setResult(async () =>
        translatedMessage("Translated original answer."),
      );
      await h.run(mode, {
        sessionManager: session,
        registry: translation.registry,
      });
      assert.deepEqual(
        h.notices,
        [],
        "compaction must not cause a no-turn refusal",
      );
      await h.until(() => h.children.length === 1);
      assert.equal(
        JSON.parse(h.fetchCalls[0].init.body as string).text,
        mode ? "Original answer." : "Translated original answer.",
      );
      assert.equal(translation.calls.length, mode ? 0 : 1);
      if (!mode) {
        assert.match(
          JSON.stringify(translation.calls[0].context),
          /Original answer\./,
        );
        assert.doesNotMatch(
          JSON.stringify(translation.calls[0].context),
          /Summary text|question/,
        );
      }
      h.children[0].finish(0);
      await h.controller.whenIdle();
      assert.deepEqual(h.notices, []);
    });

for (const mode of ["", "original"])
  test(`${mode || "localized"} routing refuses hidden failed turns, missing project and foreign project without calls`, async () => {
    const h = await harness({
      config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG },
    });
    const translation = translationFixture();
    for (const stopReason of [
      "aborted",
      "error",
      "length",
      "toolUse",
      "unanswered",
    ]) {
      const session = SessionManager.inMemory(h.dir);
      for (const message of answer("Older success."))
        session.appendMessage(message as never);
      session.appendMessage({
        role: "user",
        content: "Latest question",
        timestamp: 3,
      });
      if (stopReason !== "unanswered")
        session.appendMessage({
          ...answer("Partial answer.")[1],
          stopReason,
        } as never);
      session.appendCompaction("Summary claims success.", null, 100);
      await h.run(mode, {
        sessionManager: session,
        registry: translation.registry,
      });
      assert.match(
        h.notices.at(-1)!.message,
        stopReason === "unanswered"
          ? /no assistant answer/
          : /not completed normally/,
      );
    }
    const foreign = SessionManager.inMemory(join(h.dir, "other-project"));
    for (const message of answer("Foreign answer."))
      foreign.appendMessage(message as never);
    await h.run(mode, {
      sessionManager: foreign,
      registry: translation.registry,
    });
    assert.match(h.notices.at(-1)!.message, /project.*does not match/);
    await h.run(mode, {
      sessionManager: {
        getHeader: () => null,
        getBranch: () => {
          throw new Error("must not read history");
        },
      },
      registry: translation.registry,
    });
    assert.match(h.notices.at(-1)!.message, /project.*unavailable/);
    quiet(h);
    assert.equal(translation.calls.length, 0);
    assert.equal(
      translation.lookups.length,
      0,
      "refused before translation setup",
    );
  });

test("an unknown subcommand and an empty text command show the combined help and do nothing else", async () => {
  const h = await harness();
  await h.run("help");
  const help = h.notices[0]!.message;
  for (const args of [
    "frobnicate",
    "textual",
    "text",
    "text   \n\t ",
    "text \u001b[0m",
    "in",
    "in ja original",
    "locale en ja",
    "provider deepgram extra",
  ])
    await h.run(args);
  assert.equal(h.notices.length, 10);
  assert.ok(h.notices.every((notice) => notice.message === help));
  quiet(h);
});

test("/speak help and /talk help, and their ? short form, show the same text with every form, every key, Escape, and the locale", async () => {
  const h = await harness({
    config: { ...VALID_CONFIG, locale: "ja" },
    shortcuts: { send: ["alt+t", "alt+y"], transcribe: ["ctrl+alt+t", "ctrl+alt+y"], command: ["ctrl+alt+c"], skill: ["ctrl+alt+s", "ctrl+alt+k"] },
  });
  for (const word of ["help", "?"]) {
    await h.run(word);
    await h.runTalk(word);
  }
  const [speakHelp, ...others] = h.notices.map((notice) => notice.message);
  assert.equal(others.length, 3);
  for (const other of others) assert.equal(other, speakHelp);
  for (const form of [
    "/speak ", "/speak original", "/speak in <tag>", "/speak text <text>", "/speak stop",
    "/speak replay", "/speak status", "/speak quota", "/speak provider [elevenlabs|deepgram|reset]",
    "/speak locale [<tag>|reset]", "/speak help | ?", "/talk ", "/talk send", "/talk command", "/talk skill",
    "/talk live", "/talk provider [deepgram|elevenlabs|reset]", "/talk help | ?",
  ])
    assert.ok(speakHelp!.includes(form), form);
  assert.match(speakHelp!, /alt\+t \/ alt\+y sends: .*same as \/talk send/);
  assert.match(speakHelp!, /ctrl\+alt\+t \/ ctrl\+alt\+y transcribes only: .*same as \/talk\)/);
  assert.match(speakHelp!, /ctrl\+alt\+c command: .*same as \/talk command/);
  assert.match(speakHelp!, /ctrl\+alt\+s \/ ctrl\+alt\+k skill: .*same as \/talk skill/);
  assert.match(speakHelp!, /result goes into the editor and nothing runs until you press Enter/);
  assert.match(speakHelp!, /your draft follows them as part of the arguments/);
  assert.match(speakHelp!, /interactive commands, such as \/model, need an alias in input\.commandAliases and an empty editor/);
  assert.doesNotMatch(speakHelp!, /input\.holdSpace/);
  assert.match(speakHelp!, /Escape: while a recording is starting it cancels .* recording or held .* discards/);
  assert.match(speakHelp!, /Speech locale: ja \(configured\)/);
  assert.doesNotMatch(speakHelp!, /default vi/);
  quiet(h);
});

test("help names Space and the discard rule only when hold Space is on at load", async () => {
  const on = await harness({ shortcuts: { holdSpace: true } });
  await on.run("help");
  assert.match(on.notices.at(-1)!.message, /Space \(input\.holdSpace\): hold Space to record and let go to send.* Typing another key during a hold discards the recording/);
  const off = await harness({ config: { ...VALID_CONFIG, input: { holdSpace: true } } });
  await off.run("help");
  assert.doesNotMatch(off.notices.at(-1)!.message, /holdSpace/, "the setting is read at load, so an edited file changes nothing");
});

test("help works in every run mode and shows the session locale over the configured one", async () => {
  const h = await harness();
  await h.run("locale en-us");
  for (const mode of ["rpc", "json", "print"])
    for (const word of ["help", "?"]) {
      await h.run(word, { mode });
      assert.match(h.notices.at(-1)!.message, /Speech locale: en-US \(session override\)/);
      await h.runTalk(word, { mode });
      assert.match(h.notices.at(-1)!.message, /Speech locale: en-US \(session override\)/);
    }
  quiet(h);
});

test("help names the shortcuts registered at load, not a file edited since", async () => {
  const h = await harness({
    config: { ...VALID_CONFIG, input: { shortcut: "ctrl+alt+m", transcribeShortcut: "ctrl+alt+n" } },
  });
  await h.run("help");
  const text = h.notices.at(-1)!.message;
  assert.match(text, /alt\+t sends:/);
  assert.match(text, /alt\+shift\+t transcribes only:/);
  assert.doesNotMatch(text, /ctrl\+alt/);
  assert.doesNotMatch(text, /configuration has an error/);
  quiet(h);
});

for (const [name, config] of [
  ["a shortcut conflict", { ...VALID_CONFIG, locale: "ja", input: { shortcut: "alt+x", transcribeShortcut: "alt+x" } }],
  ["no configuration file", null],
] as const)
  test(`help with ${name} still shows the registered keys, says the configuration has an error, and makes no request`, async () => {
    const h = await harness({ config, shortcuts: { send: ["ctrl+alt+m"], transcribe: ["ctrl+alt+n"] } });
    await h.run("help");
    const text = h.notices.at(-1)!.message;
    assert.match(text, /ctrl\+alt\+m sends:/);
    assert.match(text, /ctrl\+alt\+n transcribes only:/);
    assert.match(text, /The configuration has an error \(.+\); the shortcuts shown are the ones registered at load\./);
    assert.match(text, /Speech locale: unknown/);
    quiet(h);
  });

test("summary and cache-clear are unavailable in this version and change nothing", async () => {
  const h = await harness();
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  const before = await h.cacheFiles();
  h.notices.length = 0;
  for (const name of ["summary", "cache-clear", "Summary"]) await h.run(name);
  assert.deepEqual(
    h.notices.map((notice) => notice.message),
    [
      "/speak summary is not available in this version.",
      "/speak cache-clear is not available in this version.",
      "/speak summary is not available in this version.",
    ],
  );
  assert.deepEqual(await h.cacheFiles(), before);
  assert.equal(
    h.fetchCalls.length,
    1,
    "only the earlier explicit text request",
  );
});

test("outside the interactive terminal nothing is spoken, while stop and status still answer", async () => {
  const h = await harness();
  for (const args of ["", "original", "text hi", "replay"])
    await h.run(args, { mode: "rpc", messages: answer("hi") });
  assert.equal(h.notices.length, 4);
  assert.ok(
    h.notices.every((notice) => /interactive terminal/.test(notice.message)),
  );
  await h.run("stop", { mode: "rpc" });
  await h.run("status", { mode: "print" });
  assert.match(h.notices.at(-1)!.message, /job: idle/);
  quiet(h);
});

test("a busy agent and an unusable latest answer are reported without any request", async () => {
  const h = await harness();
  await h.run("", { idle: false, messages: answer("hi") });
  await h.run("", { pending: true, messages: answer("hi") });
  await h.run("", { messages: [] });
  await h.run("", { messages: [{ role: "user", content: "q", timestamp: 1 }] });
  await h.run("", {
    messages: [
      ...answer("old"),
      { role: "user", content: "q2", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "aborted",
        timestamp: 4,
      },
    ],
  });
  await h.run("", { messages: answer("```js\nconst x = 1;\n```") });
  const messages = h.notices.map((notice) => notice.message);
  assert.match(messages[0], /still working/);
  assert.match(messages[1], /still working/);
  assert.match(messages[2], /no conversation turn/);
  assert.match(messages[3], /no assistant answer/);
  assert.match(messages[4], /not completed normally/);
  assert.match(messages[5], /nothing speakable/);
  quiet(h);
});

test("the original answer is cleaned and spoken, with shell-looking text sent as plain data", async () => {
  const h = await harness();
  await h.run("original", {
    messages: answer(
      "The build did **not** pass:\n\n```sh\nnpm test\n```\n\nSee [the log](https://x.example/log).",
    ),
  });
  await h.until(() => h.children.length === 1);
  assert.deepEqual(JSON.parse(h.fetchCalls[0].init.body as string), {
    text: "The build did not pass:\n\nSee the log.",
    model_id: "eleven_flash_v2_5",
  });
  h.children[0].finish(0);
  await h.controller.whenIdle();

  await h.run('text $(touch /tmp/x); echo "hi" | cat');
  await h.until(() => h.children.length === 2);
  assert.equal(
    JSON.parse(h.fetchCalls[1].init.body as string).text,
    '$(touch /tmp/x); echo "hi" | cat',
  );
  assert.equal(h.spawnCalls[1].options.shell, false);
  assert.equal(h.spawnCalls[1].command, "fakeplayer");
});

const preflightFailures: [
  string,
  Parameters<typeof createHarness>[0],
  string,
  RegExp,
][] = [
  [
    "no configuration file",
    { config: null },
    "text hello",
    /not configured: no configuration file/,
  ],
  [
    "the placeholder voice",
    { config: { ...VALID_CONFIG, providers: { elevenlabs: { ...VALID_CONFIG.providers.elevenlabs, voiceId: "SET_YOUR_AUTHORIZED_VOICE_ID" } } } },
    "text hello",
    /placeholder/,
  ],
  [
    "a missing model",
    { config: { providers: { elevenlabs: { voiceId: "AbCdEf1234567890" } }, player: VALID_CONFIG.player } },
    "text hello",
    /providers\.elevenlabs\.voiceId and providers\.elevenlabs\.modelId/,
  ],
  [
    "text over the limit",
    {},
    `text ${"a".repeat(10001)}`,
    /10001 characters and the elevenlabs limit is 10000/,
  ],
  [
    "a missing player",
    {
      config: {
        ...VALID_CONFIG,
        player: { command: "no-such-player", args: ["{file}"] },
      },
    },
    "text hello",
    /"no-such-player" was not found/,
  ],
  [
    "a missing API key",
    { apiKey: null },
    "text hello",
    /ELEVENLABS_API_KEY is not set/,
  ],
];
for (const [name, options, args, message] of preflightFailures)
  test(`preflight stops before any request: ${name}`, async () => {
    const h = await harness(options);
    await h.run(args);
    await h.controller.whenIdle();
    assert.match(h.messages(), message);
    quiet(h);
    await h.run("status");
    assert.match(
      h.notices.at(-1)!.message,
      /job: idle/,
      "the failed job released its claim",
    );
  });

test("exactly 10000 characters is accepted with no confirmation step", async () => {
  const h = await harness();
  const text = "a".repeat(10000);
  await h.run("text " + text);
  await h.until(() => h.children.length === 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.deepEqual(h.notices, []);
});

test("a cache hit needs neither the API key nor a request, but a new text does need the key", async () => {
  const h = await harness();
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  h.children[0].finish(0);
  await h.controller.whenIdle();

  delete h.env.ELEVENLABS_API_KEY;
  await h.run("text hello");
  await h.until(() => h.children.length === 2);
  assert.equal(h.fetchCalls.length, 1, "served from the cache");
  assert.equal(h.spawnCalls.length, 2);
  assert.deepEqual(h.notices, []);
  h.children[1].finish(0);
  await h.controller.whenIdle();

  await h.run("text something new");
  await h.controller.whenIdle();
  assert.match(h.messages(), /ELEVENLABS_API_KEY is not set/);
  assert.equal(h.fetchCalls.length, 1);
});

test("speech provider override reports, resets, and makes no request", async () => {
  const h = await harness({
    config: { ...VALID_CONFIG, provider: "elevenlabs" },
  });
  await h.run("provider deepgram");
  assert.match(h.messages(), /speech provider: deepgram \(session override\)/);
  await h.run("provider");
  assert.match(h.messages(), /speech provider: deepgram \(session override\)/);
  await h.run("provider reset");
  assert.match(h.messages(), /speech provider: elevenlabs$/);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spawnCalls.length, 0);
});

test("session navigation cleanup preserves both provider overrides until explicit reset", async () => {
  const h = await harness({ config: { ...VALID_CONFIG, input: { provider: "deepgram" } } });
  await h.run("provider deepgram");
  await h.runTalk("provider elevenlabs");

  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_tree",
    "session_shutdown",
  ]) {
    h.events.get(event)!();
    await h.run("provider");
    assert.match(h.notices.at(-1)!.message, /speech provider: deepgram \(session override\)/);
    await h.runTalk("provider");
    assert.match(h.notices.at(-1)!.message, /input provider: elevenlabs \(session override\)/);
  }

  await h.run("provider reset");
  await h.runTalk("provider reset");
  await h.run("provider");
  assert.match(h.notices.at(-1)!.message, /speech provider: elevenlabs$/);
  await h.runTalk("provider");
  assert.match(h.notices.at(-1)!.message, /input provider: deepgram$/);
  quiet(h);
});

test("unknown provider names show usage and preserve the override", async () => {
  const h = await harness();
  await h.run("provider deepgram");
  await h.run("provider openai");
  assert.match(h.notices.at(-1)!.message, /^Speak and voice input/);
  await h.run("provider");
  assert.match(h.notices.at(-1)!.message, /deepgram \(session override\)/);
  await h.runTalk("provider whisper");
  assert.match(h.notices.at(-1)!.message, /^Speak and voice input/);
  await h.runTalk("provider");
  assert.match(h.notices.at(-1)!.message, /input provider: deepgram/);
  assert.equal(h.fetchCalls.length, 0);
});

test("status reports both key presences and marks the speech override without values", async () => {
  const h = await harness({
    deepgramKey: "deepgram-secret-value",
    config: {
      ...VALID_CONFIG,
      providers: {
        elevenlabs: VALID_CONFIG.providers.elevenlabs,
        deepgram: { voice: "aura-2-thalia-en" },
      },
      input: { provider: "deepgram", language: "VI-vn" },
    },
  });
  await h.run("provider deepgram");
  await h.run("status");
  const text = h.notices.at(-1)!.message;
  assert.match(text, /speech provider: deepgram \(session override\)/);
  assert.match(text, /input provider: deepgram/);
  assert.match(text, /input language: vi-VN/);
  assert.match(text, /ELEVENLABS_API_KEY: present/);
  assert.match(text, /DEEPGRAM_API_KEY: present/);
  assert.match(text, /model: Aura voice model/);
  assert.match(text, /input model: nova-3/);
  assert.doesNotMatch(text, /aura-2-thalia-en/);
  assert.doesNotMatch(text, /^model:.*nova-3$/m);
  assert.doesNotMatch(text, /test-secret-key|deepgram-secret-value/);
  assert.equal(h.fetchCalls.length, 0);
});

for (const [name, input, status, help] of [
  ["off by default", undefined, /^stop phrase: off; phrases: "let's go"$/m, /^Stop phrase: off \("let's go"\)$/m],
  [
    "on with custom phrases",
    { stopOnPhrase: true, stopPhrases: ["send it", "ship it"] },
    /^stop phrase: on \(audio streams to ElevenLabs while recording\); phrases: "send it", "ship it"$/m,
    /^Stop phrase: on \("send it", "ship it"\)$/m,
  ],
] as const)
  test(`status and help show the stop phrase ${name}, with no request`, async () => {
    const h = await harness({ config: { ...VALID_CONFIG, input } });
    await h.run("status");
    assert.match(h.notices.at(-1)!.message, status);
    await h.run("help");
    assert.match(h.notices.at(-1)!.message, help);
    assert.match(h.notices.at(-1)!.message, /Escape sends nothing but cannot recall audio already sent/);
    quiet(h);
  });

test("help says the stop phrase state is unknown when the configuration cannot be read", async () => {
  const h = await harness({ config: null });
  await h.run("help");
  assert.match(h.notices.at(-1)!.message, /^Stop phrase: unknown$/m);
  quiet(h);
});

test("the session locale is reported, set canonically, reset, and survives session cleanup, with no request", async () => {
  const h = await harness({ config: { ...VALID_CONFIG, locale: "vi" } });
  await h.run("locale");
  assert.equal(h.notices.at(-1)!.message, "speech locale: vi");
  await h.run("locale EN-us");
  assert.equal(h.notices.at(-1)!.message, "speech locale: en-US (session override)");
  for (const event of ["session_before_switch", "session_before_fork", "session_tree", "session_shutdown"]) {
    h.events.get(event)!();
    await h.run("locale");
    assert.equal(h.notices.at(-1)!.message, "speech locale: en-US (session override)");
  }
  await h.run("status");
  assert.match(h.notices.at(-1)!.message, /^locale: en-US \(session override\)$/m);
  await h.run("locale reset");
  assert.equal(h.notices.at(-1)!.message, "speech locale: vi");
  await h.run("status");
  assert.match(h.notices.at(-1)!.message, /^locale: vi$/m);
  quiet(h);
});

test("a malformed session locale changes nothing and names the tag", async () => {
  const h = await harness();
  await h.run("locale ja");
  await h.run("locale not_a_tag");
  assert.match(h.notices.at(-1)!.message, /"not_a_tag" is not a valid BCP-47 language tag/);
  await h.run("locale");
  assert.equal(h.notices.at(-1)!.message, "speech locale: ja (session override)");
  quiet(h);
});

test("/speak in with a malformed tag names it and makes no translation or speech request", async () => {
  const h = await harness({ config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG } });
  const translation = translationFixture();
  await h.run("in not_a_tag", { messages: answer("Hello"), registry: translation.registry });
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!.message, /"not_a_tag" is not a valid BCP-47 language tag/);
  assert.equal(translation.lookups.length, 0);
  assert.equal(translation.calls.length, 0);
  await h.run("locale");
  assert.equal(h.notices.at(-1)!.message, "speech locale: vi");
  quiet(h);
});

test("the session locale is kept when the configuration cannot be read, and the error is reported otherwise", async () => {
  const h = await harness({ config: null });
  await h.run("locale");
  assert.match(h.notices.at(-1)!.message, /^not configured: no configuration file/);
  await h.run("locale en");
  assert.equal(h.notices.at(-1)!.message, "speech locale: en (session override)");
});

test("help describes /talk live: ElevenLabs in both directions, what is sent, the idle limit, and what is refused meanwhile", async () => {
  const h = await harness();
  await h.run("help");
  const help = h.notices.at(-1)!.message;
  assert.match(help, /^\/talk live +start live mode, or end it:/m);
  assert.match(help, /uses ElevenLabs for listening and for speaking, whatever input\.provider and the speech provider say/);
  assert.match(help, /everything the microphone hears streams to ElevenLabs/);
  assert.match(help, /after input\.liveIdleMinutes \(default 5\) minutes of agent idleness/);
  assert.match(help, /Push-to-talk keys, Space holds, and the \/speak forms that speak are refused/);
  quiet(h);
});

for (const [name, input, idle, listen] of [
  ["the defaults", undefined, "5 minutes", "off"],
  ["configured values", { liveIdleMinutes: 12, liveListenWhileSpeaking: true }, "12 minutes", "on"],
] as const)
  test(`status shows live mode off and the effective live settings: ${name}`, async () => {
    const h = await harness({ config: { ...VALID_CONFIG, input } });
    await h.run("status");
    const text = h.notices.at(-1)!.message;
    assert.match(text, /^live mode: off$/m);
    assert.ok(text.includes(`live idle limit: ${idle}`));
    assert.ok(text.includes(`live listen while speaking: ${listen}`));
    quiet(h);
  });

test("status reads the job phase when the report is written, not when the command started", async () => {
  const h = await harness();
  h.setFetch(
    (call) =>
      new Promise<Response>((_, reject) =>
        call.init.signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
      ),
  );
  await h.run("text hello");
  await h.until(() => h.fetchCalls.length === 1);
  const reported = h.run("status");
  h.controller.stop({ notify: () => undefined });
  await reported;
  assert.match(h.notices.at(-1)!.message, /^job: idle$/m);
});
