import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { selectSessionAnswer } from "../session.ts";
import { VALID_CONFIG, answer, createHarness } from "./harness.ts";
import {
  TRANSLATION_CONFIG,
  translatedMessage,
  translationFixture,
} from "./translation-fixture.ts";

for (const mode of ["", "original"])
  test(`${mode || "localized"} selects the resumed compacted session before a new prompt`, async (t) => {
    const h = await createHarness({
      config: { ...VALID_CONFIG, translation: TRANSLATION_CONFIG },
    });
    t.after(() => h.cleanup());
    const sessionDir = join(h.dir, "sessions");
    const saved = SessionManager.create(h.dir, sessionDir);
    const userId = saved.appendMessage(answer("Abandoned answer.")[0] as never);
    saved.appendMessage(answer("Abandoned answer.")[1] as never);
    saved.branch(userId);
    saved.appendMessage(answer("Active branch answer.")[1] as never);
    saved.appendCompaction("Summary must not be spoken.", null, 100);

    // SessionManager writes synchronously and has no close method. Reopen only this test-owned file.
    const resumed = SessionManager.open(saved.getSessionFile()!, sessionDir);
    assert.equal(resumed.getSessionId(), saved.getSessionId());
    assert.equal(
      resumed
        .buildSessionProjection()
        .messages.some((message) => message.role === "user"),
      false,
    );
    assert.deepEqual(selectSessionAnswer(resumed, h.dir), {
      ok: true,
      text: "Active branch answer.",
    });
    const translation = translationFixture();
    translation.setResult(async () =>
      translatedMessage("Translated active answer."),
    );
    await h.run(mode, {
      sessionManager: resumed,
      registry: translation.registry,
    });
    await h.until(() => h.children.length === 1);
    assert.equal(
      JSON.parse(h.fetchCalls[0].init.body as string).text,
      mode ? "Active branch answer." : "Translated active answer.",
    );
    assert.equal(translation.calls.length, mode ? 0 : 1);
    if (!mode) {
      assert.match(
        JSON.stringify(translation.calls[0].context),
        /Active branch answer\./,
      );
      assert.doesNotMatch(
        JSON.stringify(translation.calls[0].context),
        /Abandoned answer|Summary must/,
      );
    }
    h.children[0].finish(0);
    await h.controller.whenIdle();

    resumed.branch(userId);
    await h.run(mode, {
      sessionManager: resumed,
      registry: translation.registry,
    });
    assert.match(h.notices.at(-1)!.message, /no assistant answer/);

    const failed = SessionManager.create(h.dir, sessionDir);
    for (const message of answer("Older success in another session."))
      failed.appendMessage(message as never);
    failed.appendMessage({
      role: "user",
      content: "Latest unanswered question",
      timestamp: 3,
    });
    failed.appendMessage({
      ...answer("Partial aborted answer.")[1],
      stopReason: "aborted",
    } as never);
    failed.appendCompaction("Summary claims success.", null, 100);
    const resumedFailure = SessionManager.open(
      failed.getSessionFile()!,
      sessionDir,
    );
    assert.notEqual(resumedFailure.getSessionId(), resumed.getSessionId());
    h.events.get("session_before_switch")!();
    await h.run(mode, {
      sessionManager: resumedFailure,
      registry: translation.registry,
    });
    assert.match(h.notices.at(-1)!.message, /not completed normally/);
    await h.run("replay", { sessionManager: resumedFailure });
    assert.match(h.notices.at(-1)!.message, /Nothing to replay/);
    assert.equal(
      h.fetchCalls.length,
      1,
      "no older/current-other-session answer synthesis",
    );
    assert.equal(h.children.length, 1);
    assert.equal(translation.calls.length, mode ? 0 : 1);
  });

test("resume's cwd override cannot substitute the saved project's identity", async (t) => {
  const h = await createHarness();
  t.after(() => h.cleanup());
  const sessionDir = join(h.dir, "sessions");
  const foreign = SessionManager.create(
    join(h.dir, "foreign-project"),
    sessionDir,
  );
  for (const message of answer("Foreign project answer."))
    foreign.appendMessage(message as never);
  foreign.appendCompaction("Foreign summary.", null, 100);
  const resumed = SessionManager.open(
    foreign.getSessionFile()!,
    sessionDir,
    h.dir,
  );
  assert.equal(resumed.getCwd(), h.dir);
  assert.notEqual(resumed.getHeader()!.cwd, h.dir);
  for (const mode of ["", "original"]) {
    await h.run(mode, { sessionManager: resumed });
    assert.match(h.notices.at(-1)!.message, /project.*does not match/);
  }
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.spawnCalls.length, 0);
});
