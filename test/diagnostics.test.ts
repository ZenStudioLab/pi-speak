import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { API_KEY, VALID_CONFIG, answer, createHarness } from "./harness.ts";
import {
  TRANSLATION_CONFIG,
  translatedMessage,
  translationFixture,
} from "./translation-fixture.ts";

const config = {
  ...VALID_CONFIG,
  translation: { ...TRANSLATION_CONFIG, thinking: "medium" },
};
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
  const ctx = {
    registry: f.registry,
    messages: answer("private source sentence"),
  };
  return { h, f, ctx };
}

for (const [stopReason, code, label] of [
  ["length", "truncated", /truncated \(token limit\)/],
  ["error", "provider-error", /provider reported an error/],
  ["aborted", "provider-aborted", /provider reported an aborted result/],
] as const) {
  test(`${code} produces one correlated metadata entry, one failure and no TTS`, async () => {
    const { h, f, ctx } = await setup();
    f.setResult(async () => ({
      ...translatedMessage(""),
      stopReason,
      errorMessage: `Authorization: hidden-translation-key ${API_KEY}`,
      content: [
        {
          type: "thinking",
          thinking: "private reasoning",
          thinkingSignature: "private signature",
        },
        { type: "text", text: "private translated sentence" },
      ],
    }));
    await h.run("", ctx);
    await h.controller.whenIdle();
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0].message, label);
    assert.match(h.notices[0].message, /Nothing was sent to ElevenLabs/);
    assert.equal(h.entries.length, 1);
    const { customType, data } = h.entries[0];
    assert.equal(customType, "speak-translation-failure");
    assert.match(h.notices[0].message, new RegExp(data.diagnosticId));
    assert.deepEqual(
      Object.keys(data).sort(),
      [
        "version",
        "code",
        "stage",
        "timestamp",
        "elapsedMs",
        "provider",
        "model",
        "locale",
        "thinking",
        "inferenceStarted",
        "billingUncertain",
        "maxTokens",
        "stopReason",
        "blocks",
        "diagnosticId",
      ].sort(),
    );
    assert.equal(data.version, 1);
    assert.equal(data.code, code);
    assert.equal(data.stage, "validation");
    assert.equal(data.stopReason, stopReason);
    assert.equal(data.locale, "vi");
    assert.equal(data.thinking, "medium");
    assert.equal(data.provider, TRANSLATION_CONFIG.provider);
    assert.equal(data.model, TRANSLATION_CONFIG.model);
    assert.equal(data.inferenceStarted, true);
    assert.equal(data.billingUncertain, true);
    assert.deepEqual(data.blocks, { text: 1, thinking: 1, tool: 0, other: 0 });
    assert.ok(
      Number.isFinite(data.timestamp) && Number.isFinite(data.elapsedMs),
    );
    assert.ok(JSON.stringify(data).length < 2048);
    assert.doesNotMatch(
      JSON.stringify(h.entries) + h.messages(),
      /private|hidden-translation-key|Authorization|test-secret-key/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.children.length, 0);
    assert.equal(h.aborts, 0);
    // A later explicit failure is a distinct record, not an automatic retry.
    await h.run("", ctx);
    await h.controller.whenIdle();
    assert.equal(h.entries.length, 2);
    assert.notEqual(h.entries[1].data.diagnosticId, data.diagnosticId);
    assert.equal(f.calls.length, 2);
  });
}

test("unknown exception does not guess a cause or persist arbitrary error properties", async () => {
  const { h, f, ctx } = await setup();
  f.setResult(async () => {
    throw Object.assign(
      new Error("HTTP 401 offline Authorization: private payload"),
      {
        status: 401,
        body: "private provider payload",
        source: "private source sentence",
      },
    );
  });
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.code, "unknown");
  assert.equal(h.entries[0].data.stage, "request");
  assert.equal(h.entries[0].data.blocks, undefined);
  assert.match(h.messages(), /cause unknown/);
  // The random diagnostic ID and the clock values can contain "401" by chance, so they are not matched.
  const stable =
    h.messages().replace(/\[diagnostic [0-9a-f-]+\]/g, "") +
    JSON.stringify(h.entries, (key, value) =>
      ["diagnosticId", "timestamp", "elapsedMs"].includes(key) ? undefined : value,
    );
  assert.doesNotMatch(stable, /401|offline|Authorization|private|payload|source/);
  assert.equal(h.fetchCalls.length, 0);
});

test("failed persistence preserves the original failure once without claiming a saved reference", async () => {
  const { h, f, ctx } = await setup({ config, entryFailure: true });
  f.setResult(async () => ({ ...translatedMessage(""), stopReason: "length" }));
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.equal(h.notices.length, 1);
  assert.match(h.messages(), /truncated/);
  assert.doesNotMatch(h.messages(), /diagnostic|persistence unavailable/);
  assert.equal(h.entries.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(h.fetchCalls.length, 0);
});

test("native session persistence saves the routed failure without changing model context", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "speak-diagnostic-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = SessionManager.create(dir, dir);
  session.appendMessage({
    role: "user",
    content: "host question",
    timestamp: 1,
  });
  session.appendMessage(translatedMessage("host answer"));
  const before = session.buildSessionProjection().messages;
  const { h, f, ctx } = await setup({
    config,
    entrySink: (customType, data) => {
      session.appendCustomEntry(customType, data);
    },
  });
  f.setResult(async () => ({ ...translatedMessage(""), stopReason: "error" }));
  await h.run("", ctx);
  await h.controller.whenIdle();
  const file = session.getSessionFile()!;
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const stored = JSON.parse(lines.at(-1)!);
  assert.equal(stored.type, "custom");
  assert.equal(stored.customType, "speak-translation-failure");
  assert.deepEqual(stored.data, h.entries[0].data);
  assert.deepEqual(session.buildSessionProjection().messages, before);
  assert.deepEqual(
    SessionManager.open(file).buildSessionProjection().messages,
    before,
  );
  assert.equal(h.aborts, 0);
});

test("missing translation setup records setup evidence without inference or billing uncertainty", async () => {
  const { h, f, ctx } = await setup({ config: VALID_CONFIG });
  await h.run("", ctx);
  await h.controller.whenIdle();
  assert.equal(h.entries.length, 1);
  const data = h.entries[0].data;
  assert.equal(data.code, "setup");
  assert.equal(data.stage, "setup");
  assert.equal(data.inferenceStarted, false);
  assert.equal(data.billingUncertain, false);
  assert.equal(data.blocks, undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.match(h.messages(), /speak original/);
});
