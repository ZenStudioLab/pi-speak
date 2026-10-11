import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TABLE_NOTICE,
  checkLength,
  normalizeExplicitText,
  prepareAnswerText,
} from "../text.ts";

const cleanups: [string, string, string][] = [
  [
    "a fenced code block",
    "Run this:\n\n```bash\nrm -rf build\n```\n\nThen retry.",
    "Run this:\n\nThen retry.",
  ],
  [
    "a longer tilde fence containing a shorter fence",
    "Before\n~~~~\n```\ninner\n```\n~~~~\nAfter",
    "Before\nAfter",
  ],
  [
    "triple backticks on one line are inline code, not a fence",
    "```npm test``` runs the suite.\n\nThen read the report.",
    "npm test runs the suite.\n\nThen read the report.",
  ],
  [
    "an unclosed fence runs to the end",
    "Keep this.\n\n```js\nconst x = 1;",
    "Keep this.",
  ],
  [
    "an indented code block after a paragraph",
    "Example:\n\n    npm install\n    npm test\n\nDone.",
    "Example:\n\nDone.",
  ],
  [
    "indented list continuation is not code",
    "- First item\n\n    still part of the first item\n- Second",
    "First item\n\n    still part of the first item\nSecond",
  ],
  ["images are dropped", "See ![diagram](http://x/y.png) here", "See  here"],
  [
    "link labels are kept and destinations omitted",
    "Read [the guide](https://example.com/guide) now",
    "Read the guide now",
  ],
  [
    "bare URLs are omitted",
    "Visit https://example.com/a?b=1 today",
    "Visit  today",
  ],
  [
    "HTML tags are removed",
    "Use <b>bold</b> and <br/> breaks",
    "Use bold and  breaks",
  ],
  [
    "inline code keeps readable identifiers and generics",
    "Call `Array<string>.map` first",
    "Call Array<string>.map first",
  ],
  [
    "emphasis markers are removed",
    "This is **very** _clear_ and ~~wrong~~",
    "This is very clear and wrong",
  ],
  [
    "snake_case and arithmetic are untouched",
    "Set max_retry_count to 2 * 3 * 4",
    "Set max_retry_count to 2 * 3 * 4",
  ],
  [
    "headings, quotes, and bullets lose their markers",
    "# Title\n> quoted line\n- item",
    "Title\nquoted line\nitem",
  ],
  [
    "a table becomes one notice",
    "Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone",
    `Results:\n\n${TABLE_NOTICE}\n\nDone`,
  ],
  [
    "shell prompt lines are dropped but dollar amounts stay",
    "Run it:\n$ yarn test\nThe fee is $5 total.",
    "Run it:\nThe fee is $5 total.",
  ],
  [
    "an unfenced diff is dropped through its hunk",
    "Changed:\ndiff --git a/x.ts b/x.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n\nThat fixes it.",
    "Changed:\n\nThat fixes it.",
  ],
  [
    "stack frames are dropped but an indented time is not a frame",
    "Error: boom\n    at run (/app/x.js:10:5)\n    at node:internal/main:1:2\nMeet\n  at 10:30:15",
    "Error: boom\nMeet\n  at 10:30:15",
  ],
  [
    "commit hashes go but plain words and numbers stay",
    "Commit 0a356ce1f2d3c4b5a6978899001122334455 landed; version 1234567 and the word effaced stay.",
    "Commit  landed; version 1234567 and the word effaced stay.",
  ],
  [
    "one-line JSON is dropped but a bracketed note stays",
    'Config:\n{"key": 1}\n[1] see the note',
    "Config:\n[1] see the note",
  ],
  [
    "meaning-sensitive details are preserved",
    "The test did not pass on version 1.2.3 on 2026-10-02, unless retried.",
    "The test did not pass on version 1.2.3 on 2026-10-02, unless retried.",
  ],
  [
    "Unicode text and emoji survive",
    "Kết quả: không thành công ✅ 日本語",
    "Kết quả: không thành công ✅ 日本語",
  ],
  [
    "terminal escape sequences are stripped",
    "\u001b[31mred\u001b[0m text\u001b]0;title\u0007",
    "red text",
  ],
];
for (const [name, input, expected] of cleanups)
  test(`answer cleanup: ${name}`, () => {
    assert.equal(prepareAnswerText(input), expected);
  });

test("an answer with nothing speakable becomes empty", () => {
  for (const input of [
    "```js\nconst x = 1\n```",
    "![only](a.png)",
    "---",
    "  \n  ",
  ])
    assert.equal(prepareAnswerText(input), "", JSON.stringify(input));
});

test("explicit text keeps its wording, only normalizing whitespace and controls", () => {
  assert.equal(normalizeExplicitText("Use **bold** here"), "Use **bold** here");
  assert.equal(
    normalizeExplicitText("  two\n\nlines\tand\u0000 \u001b[1mcodes\u001b[0m "),
    "two lines and codes",
  );
  assert.equal(
    normalizeExplicitText('$(touch /tmp/x); echo "hi" | cat'),
    '$(touch /tmp/x); echo "hi" | cat',
  );
  assert.equal(normalizeExplicitText(" \n\t "), "");
});

test("the length limit is inclusive, counts code points, and never truncates", () => {
  assert.deepEqual(checkLength("a".repeat(10000), 10000), { ok: true });
  assert.deepEqual(checkLength("a".repeat(10001), 10000), {
    ok: false,
    length: 10001,
    limit: 10000,
  });
  assert.deepEqual(checkLength("😀".repeat(10000), 10000), { ok: true });
});
