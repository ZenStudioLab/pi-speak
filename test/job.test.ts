import assert from "node:assert/strict";
import { readFile as fsReadFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  API_KEY,
  VALID_CONFIG,
  answer,
  audioResponse,
  createHarness,
} from "./harness.ts";
import { TRANSLATION_CONFIG, translatedMessage, translationFixture } from "./translation-fixture.ts";

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
/** Starts speech and waits until the fake player has been launched. */
async function startPlaying(h: Harness, text = "hello") {
  const wanted = h.children.length + 1;
  const command = "text " + text;
  await h.run(command);
  await h.until(() => h.children.length === wanted);
  return h.children[wanted - 1];
}
const hasSigterm = (child: { signals: unknown[] }) =>
  child.signals.includes("SIGTERM");

test("speech makes one documented request, caches the clip, and plays it without the key or a shell", async () => {
  const h = await harness();
  const child = await startPlaying(h);
  assert.equal(h.fetchCalls.length, 1);
  const call = h.fetchCalls[0];
  assert.equal(
    call.url,
    "https://api.elevenlabs.io/v1/text-to-speech/AbCdEf1234567890?output_format=mp3_44100_128",
  );
  assert.equal(
    (call.init.headers as Record<string, string>)["xi-api-key"],
    API_KEY,
  );
  assert.equal(call.init.redirect, "manual");

  const files = await h.cacheFiles();
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.mp3$/);
  const spawn = h.spawnCalls[0];
  assert.equal(spawn.command, "fakeplayer");
  assert.equal(spawn.args[0], "--play");
  assert.equal(spawn.args[1], join(h.dir, "cache", "pi-speak", files[0]));
  assert.equal(spawn.options.shell, false);
  const env = spawn.options.env as Record<string, string>;
  assert.equal(env.ELEVENLABS_API_KEY, undefined);
  assert.equal(env.UNRELATED, "kept");

  child.finish(0);
  await h.controller.whenIdle();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.statuses.filter(Boolean), [
    "speak: preparing",
    "speak: generating",
    "speak: playing",
  ]);
  assert.equal(h.statuses.at(-1), undefined);

  await h.run("text hello");
  await h.until(() => h.children.length === 2);
  assert.equal(
    h.fetchCalls.length,
    1,
    "identical text is served from the cache",
  );
});

test("a second request while one is active is refused, even in the same instant", async () => {
  const h = await harness();
  await Promise.all([h.run("text first"), h.run("text second")]);
  await h.until(() => h.children.length === 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.match(h.messages(), /already active/);
  await h.run("text third");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(
    h.notices.filter((notice) => /already active/.test(notice.message)).length,
    2,
  );
});

test("stop during generation aborts the request, leaves nothing behind, and frees the job", async () => {
  const h = await harness();
  let aborted = false;
  h.setFetch(
    (call) =>
      new Promise((_resolve, reject) =>
        call.init.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      ),
  );
  await h.run("text hello");
  await h.until(() => h.fetchCalls.length === 1);
  await h.run("stop");
  await h.controller.whenIdle();
  assert.ok(aborted);
  assert.match(h.messages(), /Stopped\./);
  assert.doesNotMatch(h.messages(), /failed/i);
  assert.equal(h.spawnCalls.length, 0);
  assert.deepEqual(await h.cacheFiles(), []);
  assert.equal(h.aborts, 0, "the coding agent is never aborted");

  h.setFetch(async () => audioResponse());
  await startPlaying(h);
  assert.equal(h.fetchCalls.length, 2);
});

test("a response that arrives after stop never plays or caches", async () => {
  const h = await harness();
  let release!: () => void;
  h.setFetch(
    () => new Promise((resolve) => (release = () => resolve(audioResponse()))),
  );
  await h.run("text hello");
  await h.until(() => h.fetchCalls.length === 1);
  await h.run("stop");
  release();
  await h.controller.whenIdle();
  assert.equal(h.spawnCalls.length, 0);
  assert.deepEqual(await h.cacheFiles(), []);
  assert.doesNotMatch(h.messages(), /failed/i);
});

test("a late finish of a cancelled job cannot disturb the job that replaced it", async () => {
  const h = await harness();
  let release!: () => void;
  h.setFetch(
    () => new Promise((resolve) => (release = () => resolve(audioResponse()))),
  );
  await h.run("text one");
  await h.until(() => h.fetchCalls.length === 1);
  const staleRelease = release;
  await h.run("stop");
  h.setFetch(async () => audioResponse());
  await startPlaying(h, "two");
  staleRelease();
  await h.until(() => h.statuses.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.children.length, 1, "the stale job started no second player");
  assert.equal(
    h.statuses.at(-1),
    "speak: playing",
    "the stale job did not clear the newer job's status",
  );
  await h.run("status");
  assert.match(h.notices.at(-1)!.message, /job: playing/);
});

test("stop during playback ends only the player and is not reported as a failure", async () => {
  const h = await harness();
  const child = await startPlaying(h);
  await h.run("stop");
  await h.until(() => hasSigterm(child));
  await h.controller.whenIdle();
  assert.doesNotMatch(h.messages(), /Playback failed/);
  assert.match(h.messages(), /Stopped\./);
  await startPlaying(h, "again");
});

test("stop with nothing active says so", async () => {
  const h = await harness();
  await h.run("stop");
  assert.match(h.messages(), /Nothing is being generated or played/);
});

test("a failing player is reported with its exit code", async () => {
  const h = await harness();
  (await startPlaying(h)).finish(3);
  await h.controller.whenIdle();
  assert.match(h.messages(), /Playback failed: exit code 3/);
});

test("provider errors are sanitized, never retried, and leave no clip", async () => {
  const h = await harness();
  h.setFetch(
    async () =>
      new Response(JSON.stringify({ detail: { message: `bad ${API_KEY}` } }), {
        status: 401,
      }),
  );
  await h.run("text hello");
  await h.controller.whenIdle();
  assert.match(h.messages(), /rejected the API key/);
  assert.doesNotMatch(h.messages(), new RegExp(API_KEY));
  assert.equal(h.fetchCalls.length, 1);
  assert.deepEqual(await h.cacheFiles(), []);
  assert.equal(h.spawnCalls.length, 0);
});

const tokenKeys = {
  elevenlabs: "elevenlabs_token",
  deepgram: "deepgram_token",
} as const;
for (const provider of ["elevenlabs", "deepgram"] as const) {
  test(`${provider} structured failures redact token-shaped keys in notifications`, async () => {
    const h = await harness({
      config: provider === "deepgram"
        ? { ...deepgramSpeechConfig, provider: "deepgram", locale: "en" }
        : VALID_CONFIG,
      apiKey: tokenKeys.elevenlabs,
      deepgramKey: tokenKeys.deepgram,
    });
    h.setFetch(async () =>
      new Response(
        JSON.stringify({ detail: { status: tokenKeys[provider] } }),
        { status: 401 },
      ),
    );
    await h.run("text hello");
    await h.controller.whenIdle();
    assert.match(h.messages(), /rejected the API key/);
    for (const key of Object.values(tokenKeys))
      assert.doesNotMatch(h.messages(), new RegExp(key));
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.spawnCalls.length, 0);
  });
}

test("an unexpected failure inside a job is reported and releases the job", async () => {
  const h = await harness();
  h.env.XDG_CACHE_HOME = join(h.dir, "config", "pi-speak", "config.json");
  await h.run("text hello");
  await h.controller.whenIdle();
  assert.match(h.messages(), /Speech failed:/);
  assert.equal(h.fetchCalls.length, 0);
  await h.run("status");
  assert.match(
    h.notices.at(-1)!.message,
    /cache: .* \(unreadable\)/,
    "status still answers when the cache cannot be read",
  );
  h.env.XDG_CACHE_HOME = join(h.dir, "cache");
  await startPlaying(h);
});

test("replay plays the last clip without a request, and never regenerates a missing one", async () => {
  const h = await harness();
  await h.run("replay");
  assert.match(h.messages(), /Nothing to replay in this session/);

  (await startPlaying(h)).finish(0);
  await h.controller.whenIdle();
  await h.run("replay");
  await h.until(() => h.children.length === 2);
  assert.equal(h.fetchCalls.length, 1);
  h.children[1].finish(0);
  await h.controller.whenIdle();

  await rm(join(h.dir, "cache"), { recursive: true, force: true });
  await h.run("replay");
  await h.controller.whenIdle();
  assert.match(h.messages(), /no longer in the cache/);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.spawnCalls.length, 2);
  h.notices.length = 0;
  await h.run("replay");
  assert.match(h.messages(), /Nothing to replay in this session/);
});

for (const event of [
  "session_shutdown",
  "session_before_switch",
  "session_before_fork",
  "session_tree",
]) {
  test(`${event} stops playback and forgets the previous clip`, async () => {
    const h = await harness();
    const child = await startPlaying(h);
    h.events.get(event)!();
    await h.until(() => hasSigterm(child));
    await h.controller.whenIdle();
    assert.doesNotMatch(h.messages(), /failed/i);
    await h.run("replay");
    assert.match(h.messages(), /Nothing to replay in this session/);
    assert.equal(h.fetchCalls.length, 1);
  });
}

const deepgramSpeechConfig = {
  ...VALID_CONFIG,
  providers: {
    elevenlabs: VALID_CONFIG.providers.elevenlabs,
    deepgram: { voice: "aura-2-thalia-en", sttModel: "nova-3" },
  },
  translation: TRANSLATION_CONFIG,
};

for (const [label, voice] of [
  ["the shipped placeholder", "SET_YOUR_AUTHORIZED_VOICE_ID"],
  ["a voice without a language suffix", "aura-2-thalia"],
] as const) {
  for (const mode of ["text hello", "original", ""] as const) {
    test(`Deepgram refuses ${label} before ${mode || "localized"} speech work`, async () => {
      const h = await harness({
        config: {
          ...deepgramSpeechConfig,
          provider: "deepgram",
          locale: "en",
          providers: {
            ...deepgramSpeechConfig.providers,
            deepgram: { voice, sttModel: "nova-3" },
          },
        },
        deepgramKey: "deepgram-test-key",
      });
      const translation = translationFixture();
      await h.run(mode, {
        messages: answer("English source"),
        registry: translation.registry,
      });
      await h.controller.whenIdle();
      assert.match(h.messages(), /Deepgram speech is not configured/);
      assert.equal(translation.calls.length, 0);
      assert.equal(h.fetchCalls.length, 0);
      assert.equal(h.spawnCalls.length, 0);
      assert.deepEqual(await h.cacheFiles(), []);
    });
  }
}

for (const mode of ["text hello", ""] as const)
  test(`Deepgram selected without DEEPGRAM_API_KEY refuses ${mode || "localized"} speech with zero translation calls and zero fetches`, async () => {
    const h = await harness({
      config: { ...deepgramSpeechConfig, provider: "deepgram", locale: "en" },
    });
    const translation = translationFixture();
    await h.run(mode, {
      messages: answer("English source"),
      registry: translation.registry,
    });
    await h.controller.whenIdle();
    assert.match(h.messages(), /DEEPGRAM_API_KEY is not set/);
    assert.equal(translation.calls.length, 0);
    assert.equal(h.fetchCalls.length, 0, "the ElevenLabs key is not used instead");
    assert.equal(h.spawnCalls.length, 0);
  });

test("Deepgram selected by config refuses before translation, TTS, or cache writes", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "deepgram" },
    deepgramKey: "deepgram-test-key",
  });
  const translation = translationFixture();
  await h.run("", {
    messages: answer("Hello from the configured provider."),
    registry: translation.registry,
  });
  await h.controller.whenIdle();
  assert.match(h.messages(), /voice language en does not match locale vi/);
  assert.match(h.messages(), /Nothing was sent/);
  assert.equal(translation.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spawnCalls.length, 0);
  assert.deepEqual(await h.cacheFiles(), []);
});

test("a Deepgram speech override refuses before translation or TTS and affects no cache", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "elevenlabs" },
    deepgramKey: "deepgram-test-key",
  });
  const translation = translationFixture();
  await h.run("provider deepgram");
  await h.run("", {
    messages: answer("Hello from the session override."),
    registry: translation.registry,
  });
  await h.controller.whenIdle();
  assert.match(h.messages(), /voice language en does not match locale vi/);
  assert.equal(translation.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spawnCalls.length, 0);
  assert.deepEqual(await h.cacheFiles(), []);
});

test("a session or one-command locale is checked against a Deepgram voice before any translation", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "deepgram", locale: "en" },
    deepgramKey: "deepgram-test-key",
  });
  const translation = translationFixture();
  const ctx = { messages: answer("Hello from the session locale."), registry: translation.registry };
  await h.run("locale vi");
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.match(h.notices.at(-1)!.message, /voice language en does not match locale vi/);
  await h.run("locale reset");
  await h.run("in vi", ctx);
  await h.controller.whenIdle();
  assert.match(h.notices.at(-1)!.message, /voice language en does not match locale vi/);
  assert.equal(translation.lookups.length, 0, "refused before translation setup");
  assert.equal(translation.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spawnCalls.length, 0);
  assert.deepEqual(await h.cacheFiles(), []);
  await h.run("locale vi");
  await h.run("original", ctx);
  await h.until(() => h.children.length === 1);
  assert.equal(h.fetchCalls.length, 1, "original speech is not language-checked");
});

test("a provider override changed during config loading affects only the next speech invocation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const h = await harness({
    config: deepgramSpeechConfig,
    deepgramKey: "deepgram-test-key",
    readFile: async (path) => {
      reads++;
      await gate;
      return fsReadFile(path, "utf8");
    },
  });
  await h.run("text first invocation");
  await h.until(() => reads === 1);

  const override = h.run("provider deepgram");
  release();
  await override;
  await h.until(() => h.children.length === 1);
  assert.match(h.fetchCalls[0].url, /api\.elevenlabs\.io/);
  h.children[0].finish(0);
  await h.controller.whenIdle();

  await h.run("text next invocation");
  await h.until(() => h.children.length === 2);
  assert.match(h.fetchCalls[1].url, /api\.deepgram\.com/);
  h.children[1].finish(0);
  await h.controller.whenIdle();
  assert.equal(h.fetchCalls.length, 2);
});

test("Deepgram synthesis uses Aura MP3, its ceiling, and never calls ElevenLabs", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "deepgram", locale: "en" },
    apiKey: "elevenlabs-should-not-be-used",
    deepgramKey: "deepgram-test-key",
  });
  await h.run("text hello");
  await h.until(() => h.children.length === 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.match(h.fetchCalls[0].url, /^https:\/\/api\.deepgram\.com\/v1\/speak\?/);
  assert.equal(JSON.parse(h.fetchCalls[0].init.body as string).text, "hello");
  h.children[0].finish(0);
  await h.controller.whenIdle();
  await h.run("text " + "a".repeat(2001));
  await h.controller.whenIdle();
  assert.match(h.messages(), /deepgram limit is 2000/);
  assert.equal(h.fetchCalls.length, 1);
});

test("Deepgram original speech skips the Aura language check", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "deepgram", locale: "vi" },
    deepgramKey: "deepgram-test-key",
  });
  await h.run("original", { messages: answer("English source") });
  await h.until(() => h.children.length === 1);
  assert.equal(h.fetchCalls.length, 1);
  h.children[0].finish(0);
  await h.controller.whenIdle();
});

test("Deepgram translation failures name the provider and make no TTS request", async () => {
  const h = await harness({
    config: { ...deepgramSpeechConfig, provider: "deepgram", locale: "en" },
    deepgramKey: "deepgram-test-key",
  });
  const translation = translationFixture();
  translation.setResult(async () => ({
    ...translatedMessage(""),
    stopReason: "error",
    content: [],
  }));
  await h.run("", { messages: answer("source"), registry: translation.registry });
  await h.controller.whenIdle();
  assert.match(h.messages(), /Nothing was sent to Deepgram/);
  assert.equal(h.fetchCalls.length, 0);
});

test("an ElevenLabs clip is not reused when Deepgram is selected", async () => {
  const h = await harness({ deepgramKey: "deepgram-test-key" });
  await h.run("text same");
  await h.until(() => h.children.length === 1);
  h.children[0].finish(0);
  await h.controller.whenIdle();
  await h.writeConfig({ ...deepgramSpeechConfig, provider: "deepgram", locale: "en" });
  await h.run("text same");
  await h.until(() => h.children.length === 2);
  assert.equal(h.fetchCalls.length, 2);
  assert.match(h.fetchCalls[1].url, /api\.deepgram\.com/);
  h.children[1].finish(0);
  await h.controller.whenIdle();
});

test("replay remains available after selecting Deepgram and makes no provider request", async () => {
  const h = await harness({ deepgramKey: "deepgram-test-key" });
  await startPlaying(h, "replay me");
  h.children[0].finish(0);
  await h.controller.whenIdle();
  await h.run("provider deepgram");
  await h.run("replay");
  await h.until(() => h.children.length === 2);
  assert.equal(h.fetchCalls.length, 1);
  h.children[1].finish(0);
  await h.controller.whenIdle();
});

test("status shows redacted configuration, key presence, job state, and cache usage without a request", async () => {
  const h = await harness();
  const child = await startPlaying(h);
  await h.run("status");
  const during = h.notices.at(-1)!.message;
  assert.match(during, /job: playing/);
  child.finish(0);
  await h.controller.whenIdle();
  await h.run("status");
  const after = h.notices.at(-1)!.message;
  assert.match(after, /voice: \.\.\.7890/);
  assert.match(after, /ELEVENLABS_API_KEY: present/);
  assert.match(after, /job: idle/);
  assert.match(after, /\(1 clips, 4 bytes\)/);
  for (const text of [during, after]) {
    assert.doesNotMatch(text, new RegExp(API_KEY));
    assert.doesNotMatch(text, new RegExp(VALID_CONFIG.providers.elevenlabs.voiceId));
  }
  assert.equal(h.fetchCalls.length, 1);
});
