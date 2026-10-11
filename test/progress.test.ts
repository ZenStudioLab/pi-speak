import assert from "node:assert/strict";
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

const open: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.cleanup();
});
async function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(options);
  open.push(h);
  return h;
}
const labels = (h: Awaited<ReturnType<typeof createHarness>>) =>
  h.widgets.map(({ key, content }) => {
    assert.equal(key, "speak-progress");
    return content?.[0];
  });

// Protects the idle command's distinct widget, not the streaming Working surface.
test("Deepgram progress names the selected provider during synthesis", async () => {
  const h = await setup({
    config: {
      ...VALID_CONFIG,
      provider: "deepgram",
      locale: "en",
      providers: {
        elevenlabs: VALID_CONFIG.providers.elevenlabs,
        deepgram: { voice: "aura-2-thalia-en", sttModel: "nova-3" },
      },
    },
    deepgramKey: "deepgram-test-key",
  });
  await h.run("text Hello");
  await h.until(() => h.children.length === 1);
  assert.ok(labels(h).includes("Speech: Deepgram..."));
  h.children[0].finish(0);
  await h.controller.whenIdle();
});

test("idle localized speech shows each actual phase and clears on completion", async () => {
  const h = await setup({
    config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG },
  });
  const f = translationFixture();
  let releaseTranslation!: () => void;
  f.setResult(
    () =>
      new Promise((resolve) => {
        releaseTranslation = () => resolve(translatedMessage("Xin chào"));
      }),
  );
  let releaseAudio!: () => void;
  h.setFetch(
    () =>
      new Promise((resolve) => {
        releaseAudio = () => resolve(audioResponse());
      }),
  );
  assert.deepEqual(h.widgets, [], "loading creates no progress line");
  await h.run("", {
    registry: f.registry,
    messages: answer("Hello"),
    idle: true,
  });
  assert.equal(labels(h)[0], "Speech: Preparing...");
  await h.until(() => f.calls.length === 1);
  assert.equal(labels(h).at(-1), "Speech: Translating...");
  releaseTranslation();
  await h.until(() => h.fetchCalls.length === 1);
  assert.equal(labels(h).at(-1), "Speech: ElevenLabs...");
  releaseAudio();
  await h.until(() => h.children.length === 1);
  assert.equal(labels(h).at(-1), "Speech: Playing...");
  h.children[0].finish(0);
  await h.controller.whenIdle();
  assert.deepEqual(labels(h), [
    "Speech: Preparing...",
    "Speech: Translating...",
    "Speech: ElevenLabs...",
    "Speech: Playing...",
    undefined,
  ]);

  h.widgets.length = 0;
  await h.run("", { registry: f.registry, messages: answer("Hello") });
  await h.until(() => h.children.length === 2);
  h.children[1].finish(0);
  await h.controller.whenIdle();
  assert.deepEqual(labels(h), [
    "Speech: Preparing...",
    "Speech: Playing...",
    undefined,
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 1);
});

for (const mode of ["text Hello", "original"]) {
  test(`${mode}: bypass skips translation and replay skips synthesis`, async () => {
    const h = await setup();
    await h.run(mode, { messages: answer("Hello") });
    await h.until(() => h.children.length === 1);
    h.children[0].finish(0);
    await h.controller.whenIdle();
    assert.deepEqual(labels(h), [
      "Speech: Preparing...",
      "Speech: ElevenLabs...",
      "Speech: Playing...",
      undefined,
    ]);
    h.widgets.length = 0;
    await h.run("replay");
    await h.until(() => h.children.length === 2);
    h.children[1].finish(0);
    await h.controller.whenIdle();
    assert.deepEqual(labels(h), [
      "Speech: Preparing...",
      "Speech: Playing...",
      undefined,
    ]);
    assert.equal(h.fetchCalls.length, 1);
  });
}

for (const failure of [
  "preflight",
  "translation",
  "provider",
  "player",
] as const) {
  test(`${failure} failure clears the progress line`, async () => {
    const h = await setup(failure === "preflight" ? { config: null } : {});
    if (failure === "provider")
      h.setFetch(async () => new Response("{}", { status: 500 }));
    await h.run(failure === "translation" ? "" : "text Hello", {
      messages: answer("Hello"),
    });
    if (failure === "player") {
      await h.until(() => h.children.length === 1);
      h.children[0].finish(3);
    }
    await h.controller.whenIdle();
    assert.ok(h.notices.length > 0);
    assert.equal(labels(h).at(-1), undefined);
  });
}

for (const event of [
  "stop",
  "session_shutdown",
  "session_before_switch",
  "session_before_fork",
  "session_tree",
]) {
  test(`${event} clears immediately and late translation cannot disturb replacement`, async () => {
    const h = await setup({
      config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG },
    });
    const f = translationFixture();
    let release!: () => void;
    f.setResult(
      () =>
        new Promise((resolve) => {
          release = () => resolve(translatedMessage("Xin chào"));
        }),
    );
    await h.run("", { registry: f.registry, messages: answer("Hello") });
    await h.until(() => f.calls.length === 1);
    const oldTask = h.controller.whenIdle();
    const beforeDuplicate = h.widgets.length;
    await h.run("text Duplicate");
    assert.equal(
      h.widgets.length,
      beforeDuplicate,
      "duplicate does not replace progress",
    );
    if (event === "stop") await h.run("stop");
    else h.events.get(event)!();
    assert.equal(labels(h).at(-1), undefined);
    await h.run("text New job");
    await h.until(() => h.children.length === 1);
    const beforeLate = h.widgets.length;
    release();
    await oldTask;
    assert.equal(h.widgets.length, beforeLate);
    assert.equal(labels(h).at(-1), "Speech: Playing...");
    await h.run("stop");
    await h.controller.whenIdle();
    assert.equal(labels(h).at(-1), undefined);
    assert.equal(h.aborts, 0);
  });
}

test("widget rendering errors cannot block speech or stop", async () => {
  const h = await setup({ widgetFailure: true });
  await h.run("text Hello");
  await h.until(() => h.children.length === 1);
  await h.run("stop");
  await h.controller.whenIdle();
  assert.ok(h.children[0].signals.includes("SIGTERM"));
  assert.doesNotMatch(h.messages(), /failed/i);
  assert.equal(h.statuses.at(-1), undefined);
});
