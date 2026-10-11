import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  selectLatestAnswer,
  selectSessionAnswer,
} from "../session.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: unknown[], stopReason = "stop") => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: 2,
});
const text = (value: string) => ({ type: "text", text: value });

test("speaks only the ordered text blocks of the latest answer", () => {
  const result = selectLatestAnswer([
    user("question"),
    assistant([
      { type: "thinking", thinking: "private reasoning" },
      text("First part."),
      { type: "toolCall", id: "1", name: "bash", arguments: {} },
      text("Second part."),
    ]),
  ]);
  assert.deepEqual(result, { ok: true, text: "First part.\n\nSecond part." });
});

test("uses the final answer after tool calls, ignoring tool results and custom messages", () => {
  const result = selectLatestAnswer([
    user("run it"),
    assistant([text("I will run it.")], "toolUse"),
    { role: "toolResult", content: [text("tool output")] },
    assistant([text("Done: the build passed.")]),
    { role: "compactionSummary", summary: "ignored" },
  ]);
  assert.deepEqual(result, { ok: true, text: "Done: the build passed." });
});

const unusable: [string, unknown[], string][] = [
  ["an empty conversation", [], "no-turn"],
  ["assistant output with no user turn", [assistant([text("hi")])], "no-turn"],
  ["a user turn with no answer yet", [user("q")], "no-answer"],
  [
    "an aborted latest answer",
    [
      user("q1"),
      assistant([text("old answer")]),
      user("q2"),
      assistant([text("partial")], "aborted"),
    ],
    "not-final",
  ],
  [
    "an errored latest answer",
    [user("q"), assistant([text("partial")], "error")],
    "not-final",
  ],
  [
    "a truncated latest answer",
    [user("q"), assistant([text("cut off")], "length")],
    "not-final",
  ],
  [
    "a tool-call-only latest answer",
    [
      user("q"),
      assistant(
        [{ type: "toolCall", id: "1", name: "x", arguments: {} }],
        "toolUse",
      ),
    ],
    "not-final",
  ],
  [
    "a finished answer with no text",
    [user("q"), assistant([{ type: "thinking", thinking: "only thoughts" }])],
    "no-text",
  ],
  [
    "a new user turn that is still unanswered",
    [user("q1"), assistant([text("old answer")]), user("q2")],
    "no-answer",
  ],
];
for (const [name, messages, reason] of unusable)
  test(`reports ${reason} for ${name} and never falls back to an older turn`, () => {
    assert.deepEqual(selectLatestAnswer(messages), { ok: false, reason });
  });

test("only the active branch of a real Pi session is eligible", () => {
  const session = SessionManager.inMemory();
  const firstUser = session.appendMessage(user("question one") as never);
  session.appendMessage(
    assistant([text("Answer on the original branch.")]) as never,
  );
  session.branch(firstUser);
  session.appendMessage(
    assistant([text("Answer on the new branch.")]) as never,
  );

  assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
    ok: true,
    text: "Answer on the new branch.",
  });
  session.branch(firstUser);
  assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
    ok: false,
    reason: "no-answer",
  });
  session.resetLeaf();
  assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
    ok: false,
    reason: "no-turn",
  });
});

for (const retention of ["full-turn", "assistant-only", "none"] as const)
  test(`original answer survives real compaction retaining ${retention}`, () => {
    const session = SessionManager.inMemory();
    const userId = session.appendMessage(user("question") as never);
    const answerId = session.appendMessage(
      assistant([text("Original answer.")]) as never,
    );
    session.appendCompaction(
      "Summary is not an answer.",
      retention === "none"
        ? null
        : retention === "full-turn"
          ? userId
          : answerId,
      100,
    );
    if (retention !== "full-turn")
      assert.deepEqual(
        selectLatestAnswer(session.buildSessionProjection().messages),
        { ok: false, reason: "no-turn" },
      );
    assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
      ok: true,
      text: "Original answer.",
    });
  });

for (const stopReason of [
  "aborted",
  "error",
  "length",
  "toolUse",
  "pending",
  "deferred",
  "unanswered",
])
  test(`compaction-hidden latest ${stopReason} never falls back to old success`, () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old question") as never);
    session.appendMessage(assistant([text("Old success.")]) as never);
    session.appendMessage(user("latest question") as never);
    if (stopReason !== "unanswered")
      session.appendMessage(
        assistant(
          stopReason === "toolUse"
            ? [{ type: "toolCall", id: "1", name: "bash", arguments: {} }]
            : [text("Latest partial.")],
          stopReason,
        ) as never,
      );
    session.appendCompaction("Summary claims success.", null, 100);
    assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
      ok: false,
      reason: stopReason === "unanswered" ? "no-answer" : "not-final",
    });
  });

for (const replacement of [{ content: [text("Context replacement.")] }, null])
  test(`context ${replacement ? "replacement" : "omission"} cannot alter spoken transcript text`, () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("q") as never);
    const answerId = session.appendMessage(
      assistant([text("Original answer.")]) as never,
    );
    session.appendContextEdit(answerId, replacement as never);
    assert.notDeepEqual(
      selectLatestAnswer(session.buildSessionProjection().messages),
      { ok: true, text: "Original answer." },
    );
    assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
      ok: true,
      text: "Original answer.",
    });
  });

test("project identity is normalized and checked before reading transcript history", () => {
  const session = SessionManager.inMemory();
  session.appendMessage(user("q") as never);
  session.appendMessage(assistant([text("Original answer.")]) as never);
  assert.deepEqual(
    selectSessionAnswer(session, join(process.cwd(), "unused", "..")),
    { ok: true, text: "Original answer." },
  );
  assert.deepEqual(
    selectSessionAnswer(session, join(process.cwd(), "another-project")),
    { ok: false, reason: "project-mismatch" },
  );
  for (const header of [
    null,
    { ...session.getHeader()!, cwd: "" },
    { ...session.getHeader()!, cwd: "relative-project" },
  ])
    assert.deepEqual(
      selectSessionAnswer(
        {
          getHeader: () => header,
          getBranch: () => {
            throw new Error("history must not be read");
          },
        },
        process.cwd(),
      ),
      { ok: false, reason: "project-mismatch" },
    );
});

test("metadata, summaries and assistant-only history cannot create a user turn", () => {
  const session = SessionManager.inMemory();
  assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
    ok: false,
    reason: "no-turn",
  });
  session.appendMessage(assistant([text("No user turn.")]) as never);
  session.appendCustomMessageEntry("not-a-user", "Custom context", true);
  session.appendCustomEntry("diagnostic", { text: "Not an answer." });
  session.appendCompaction("Not a turn.", null, 100);
  assert.deepEqual(selectSessionAnswer(session, process.cwd()), {
    ok: false,
    reason: "no-turn",
  });
});
