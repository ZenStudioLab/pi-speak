import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  VALID_CONFIG,
  answer,
  audioResponse,
  createHarness,
} from "./harness.ts";
import {
  TRANSLATION_CONFIG,
  translatedMessage,
  translationFixture,
} from "./translation-fixture.ts";

const config = { ...VALID_CONFIG, translation: TRANSLATION_CONFIG };
const open: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.cleanup();
});
async function setup(
  options: Parameters<typeof createHarness>[0] = { config },
) {
  const h = await createHarness(options);
  open.push(h);
  const f = translationFixture();
  const messages = answer(
    "The build did **not** pass on version 1.2.3.\n\n```sh\nnpm test\n```",
  );
  const ctx = { registry: f.registry, messages };
  return { h, f, ctx };
}

async function finish(h: Awaited<ReturnType<typeof createHarness>>) {
  h.children.at(-1)!.finish(0);
  await h.controller.whenIdle();
}

test("default vi is localized without touching the English answer; repeats and replay use both caches", async () => {
  const { h, f, ctx } = await setup();
  const original = JSON.stringify(ctx.messages);
  await h.run("", ctx);
  await h.until(() => h.children.length === 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].context.messages.length, 1);
  const source = f.calls[0].context.messages[0];
  assert.equal(JSON.stringify(source.content).includes("npm test"), false);
  assert.match(JSON.stringify(source.content), /did not pass/);
  assert.equal(
    JSON.parse(h.fetchCalls[0].init.body as string).text,
    "Bản dựng chưa vượt qua kiểm tra ở phiên bản 1.2.3.",
  );
  assert.equal(JSON.stringify(ctx.messages), original);
  assert.equal(h.aborts, 0);
  assert.ok(h.statuses.includes("speak: translating"));
  await finish(h);
  await h.run("", ctx);
  await h.until(() => h.children.length === 2);
  await finish(h);
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 1);
  await h.writeConfig({ ...config, locale: "en" });
  await h.run("replay", ctx);
  await h.until(() => h.children.length === 3);
  await finish(h);
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 1);
  await h.run("", ctx);
  await h.until(() => h.children.length === 4);
  await finish(h);
  assert.equal(f.calls.length, 2);
  assert.equal(
    h.fetchCalls.length,
    2,
    "locale discriminates identical translated text",
  );
  await h.writeConfig({
    ...config,
    locale: "en",
    translation: { ...TRANSLATION_CONFIG, model: "other" },
  });
  await h.run("", ctx);
  await h.until(() => h.children.length === 5);
  await finish(h);
  assert.equal(f.calls.length, 3);
  assert.equal(
    h.fetchCalls.length,
    2,
    "same final text/locale may reuse audio across translators",
  );
  assert.equal((await h.cacheFiles()).length, 2, "only audio files persisted");
});

test("configured medium reasoning never reaches ElevenLabs and changing thinking misses only translation", async () => {
  const configured = {
    ...config,
    translation: { ...TRANSLATION_CONFIG, thinking: "medium" },
  };
  const { h, f, ctx } = await setup({ config: configured });
  f.setResult(async () => ({
    ...translatedMessage("Xin chào"),
    content: [
      {
        type: "thinking",
        thinking: "hidden reasoning",
        thinkingSignature: "hidden signature",
      },
      { type: "text", text: "Xin chào" },
    ],
  }));
  await h.run("", ctx);
  await h.until(() => h.children.length === 1);
  assert.equal(f.calls[0].options.reasoning, "medium");
  assert.equal(
    JSON.parse(h.fetchCalls[0].init.body as string).text,
    "Xin chào",
  );
  assert.doesNotMatch(h.messages(), /hidden reasoning|hidden signature/);
  await finish(h);
  await h.run("status", ctx);
  assert.match(h.notices.at(-1)!.message, /thinking: medium/);
  await h.writeConfig({
    ...configured,
    translation: { ...TRANSLATION_CONFIG, thinking: "high" },
  });
  await h.run("", ctx);
  await h.until(() => h.children.length === 2);
  await finish(h);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.reasoning, "high");
  assert.equal(h.fetchCalls.length, 1, "identical final audio may be reused");
});

test("original and literal modes bypass unconfigured translation; bare speak reports setup missing", async () => {
  const { h, f, ctx } = await setup({ config: VALID_CONFIG });
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.match(h.messages(), /Translation is not configured/);
  assert.equal(f.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  await h.run("original", ctx);
  await h.until(() => h.children.length === 1);
  await finish(h);
  assert.equal(
    JSON.parse(h.fetchCalls[0].init.body as string).text,
    "The build did not pass on version 1.2.3.",
  );
  await h.run("text Hello", ctx);
  await h.until(() => h.children.length === 2);
  await finish(h);
  assert.equal(JSON.parse(h.fetchCalls[1].init.body as string).text, "Hello");
  assert.equal(f.calls.length, 0);
  await h.run("original", { ...ctx, idle: false });
  assert.match(h.notices.at(-1)!.message, /still working/);
  await h.run("status", ctx);
  assert.match(
    h.notices.at(-1)!.message,
    /locale: vi\ntranslation: not configured/,
  );
});

for (const [name, options] of [
  ["missing TTS key", { config, apiKey: null }],
  ["invalid locale", { config: { ...config, locale: "vi_VN" } }],
  [
    "missing player",
    {
      config: {
        ...config,
        player: { command: "not-installed", args: ["{file}"] },
      },
    },
  ],
] as const)
  test(`${name} prevents inference and TTS`, async () => {
    const { h, f, ctx } = await setup(options);
    await h.run("", ctx);
    await h.controller.whenIdle();
    assert.equal(f.calls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.spawnCalls.length, 0);
  });

test("oversized source is refused before translation and oversized result before TTS", async () => {
  const { h, f, ctx } = await setup();
  await h.run("", { ...ctx, messages: answer("a".repeat(10001)) });
  await h.controller.whenIdle();
  assert.equal(f.calls.length, 0);
  f.setResult(async () => translatedMessage("a".repeat(10001)));
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 0);
  assert.match(h.messages(), /Translation is 10001 characters/);
});

for (const action of [
  "stop",
  "session_tree",
  "session_before_switch",
  "session_before_fork",
  "session_shutdown",
]) {
  test(`${action} during translation ignores late results and frees job for original speech`, async () => {
    const { h, f, ctx } = await setup();
    let release!: () => void;
    f.setResult(
      () =>
        new Promise((resolve) => {
          release = () => resolve(translatedMessage("stale"));
        }),
    );
    await h.run("", ctx);
    await h.until(() => f.calls.length === 1);
    await h.run("status", ctx);
    assert.match(h.notices.at(-1)!.message, /job: translating/);
    await h.run("", ctx);
    assert.equal(f.calls.length, 1);
    assert.match(h.messages(), /already active/);
    if (action === "stop") await h.run("stop", ctx);
    else h.events.get(action)!();
    await h.controller.whenIdle();
    assert.ok(f.calls[0].options.signal!.aborted);
    await h.run("original", ctx);
    await h.until(() => h.children.length === 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.statuses.at(-1), "speak: playing");
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.aborts, 0);
    await finish(h);
    f.setResult(async () => translatedMessage("fresh"));
    await h.run("", ctx);
    await h.until(() => h.children.length === 2);
    await finish(h);
    assert.equal(f.calls.length, 2, "late result not cached");
    assert.equal(JSON.parse(h.fetchCalls[1].init.body as string).text, "fresh");
    assert.doesNotMatch(h.messages(), /Translation cancelled|Speech failed/);
    assert.equal(
      h.entries.length,
      0,
      "cancelled/late and successful jobs must not log failures",
    );
  });
}

test("session navigation clears valid translation memory but audio cache remains reusable", async () => {
  const { h, f, ctx } = await setup();
  await h.run("", ctx);
  await h.until(() => h.children.length === 1);
  await finish(h);
  h.events.get("session_tree")!();
  await h.run("replay", ctx);
  assert.match(h.notices.at(-1)!.message, /Nothing to replay/);
  await h.run("", ctx);
  await h.until(() => h.children.length === 2);
  await finish(h);
  assert.equal(f.calls.length, 2);
  assert.equal(h.fetchCalls.length, 1);
});

test("translation snapshots config; cached translation can survive TTS failure and respects lower limits", async () => {
  const { h, f, ctx } = await setup();
  let release!: () => void;
  f.setResult(
    () =>
      new Promise((resolve) => {
        release = () => resolve(translatedMessage("valid translation"));
      }),
  );
  await h.run("", ctx);
  await h.until(() => f.calls.length === 1);
  await h.writeConfig({ ...config, locale: "en" });
  h.setFetch(async () => new Response("error", { status: 500 }));
  release();
  await h.controller.whenIdle();
  assert.match(f.calls[0].context.systemPrompt!, /locale vi/);
  await h.writeConfig(config);
  h.setFetch(async () => audioResponse());
  await h.run("", ctx);
  await h.until(() => h.children.length === 1);
  await finish(h);
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 2);
  // Lower source remains within the new cap, but cached output must not bypass it.
  const shorter = answer("Hi");
  await h.run("", { ...ctx, messages: shorter });
  await h.until(() => f.calls.length === 2);
  release();
  await h.until(() => h.children.length === 2);
  await finish(h);
  await h.writeConfig({ ...config, hardLimitChars: 4 });
  await h.run("", { ...ctx, messages: shorter });
  await h.controller.whenIdle();
  assert.equal(f.calls.length, 2);
  assert.equal(h.fetchCalls.length, 2);
  assert.match(
    h.notices.at(-1)!.message,
    /Translation is 17 characters; limit 4/,
  );
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.code, "output-length");
  assert.equal(
    h.entries[0].data.inferenceStarted,
    false,
    "cached validation made no inference request",
  );
  assert.equal(h.entries[0].data.billingUncertain, false);
});

test("a one-command tag beats the session locale, which beats the configuration, and each has its own caches", async () => {
  const { h, f, ctx } = await setup();
  const path = join(h.dir, "config", "pi-speak", "config.json");
  const before = await readFile(path, "utf8");
  const speakAndFinish = async (args: string) => {
    const wanted = h.children.length + 1;
    await h.run(args, ctx);
    await h.until(() => h.children.length === wanted);
    await finish(h);
  };
  await h.run("locale en");
  await speakAndFinish("");
  assert.match(f.calls[0].context.systemPrompt!, /locale en/);
  assert.equal(h.fetchCalls.length, 1);
  await speakAndFinish("in ja");
  assert.match(f.calls[1].context.systemPrompt!, /locale ja/);
  assert.equal(h.fetchCalls.length, 2, "the audio key differs per locale");
  await speakAndFinish("");
  assert.equal(f.calls.length, 2, "the one-command tag did not change the session locale; its translation is cached");
  assert.equal(h.fetchCalls.length, 2, "and so is its audio");
  await h.run("locale reset");
  await speakAndFinish("");
  assert.match(f.calls[2].context.systemPrompt!, /locale vi/);
  assert.equal(await readFile(path, "utf8"), before);

  const restarted = await setup();
  await restarted.h.run("", restarted.ctx);
  await restarted.h.until(() => restarted.f.calls.length === 1);
  assert.match(restarted.f.calls[0].context.systemPrompt!, /locale vi/, "a restart returns to the configured locale");
});

test("the locale is fixed when the job starts, so a later change affects only the next job", async () => {
  const { h, f, ctx } = await setup();
  let release!: () => void;
  f.setResult(
    () =>
      new Promise((resolve) => {
        release = () => resolve(translatedMessage("valid translation"));
      }),
  );
  await h.run("locale en");
  await h.run("", ctx);
  await h.until(() => f.calls.length === 1);
  await h.run("locale ja");
  release();
  await h.until(() => h.children.length === 1);
  await finish(h);
  assert.match(f.calls[0].context.systemPrompt!, /locale en/);
  await h.run("locale en");
  await h.run("", ctx);
  await h.until(() => h.children.length === 2);
  await finish(h);
  assert.equal(h.fetchCalls.length, 1, "the first job stored its audio under en");
});
