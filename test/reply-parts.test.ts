import assert from "node:assert/strict";
import { test } from "node:test";
import { splitReply } from "../reply-parts.ts";

const sentence = (i: number) => `Sentence number ${i} is here and keeps going a little.`;

test("each paragraph is one part, in order, and a line break inside a paragraph stays inside its part", () => {
  const parts = splitReply("First paragraph.\n\nSecond one,\nover two lines.\n\nThird.");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "First paragraph.");
  assert.equal(parts[1], "Second one,\nover two lines.");
  assert.equal(parts[2], "Third.");
});

test("a paragraph over 1,000 characters is split at sentence ends into parts of at most 1,000 characters", () => {
  const sentences = Array.from({ length: 30 }, (_, i) => sentence(i));
  const parts = splitReply(sentences.join(" "));
  assert.equal(parts.length, 2, "sentences are packed, not one part each");
  for (const part of parts) {
    assert.ok(part.length <= 1000, `part of ${part.length} characters`);
    assert.ok(part.endsWith("."), "each part ends where a sentence ends");
  }
  assert.equal(parts.join(" "), sentences.join(" "), "nothing is lost or reordered");
});

test("a sentence over 1,000 characters is split at spaces, whole words only", () => {
  const words = Array.from({ length: 700 }, (_, i) => `w${i}`);
  const parts = splitReply(`${words.join(" ")}.`);
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  for (const part of parts) {
    assert.ok(part.length <= 1000, `part of ${part.length} characters`);
    assert.equal(part, part.trim());
  }
  assert.equal(parts.join(" "), `${words.join(" ")}.`);
});

test("a long sentence among short ones does not swallow its neighbours' boundaries", () => {
  const long = `${Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ")}.`;
  const text = `${sentence(1)} ${long} ${sentence(2)} ${Array.from({ length: 20 }, (_, i) => sentence(i + 3)).join(" ")}`;
  const parts = splitReply(text);
  for (const part of parts) assert.ok(part.length <= 1000);
  assert.equal(parts.join(" "), text);
});

for (const [name, text] of [
  ["an empty text", ""],
  ["only blank lines", "\n\n  \n\n\n"],
] as const)
  test(`${name} gives no parts`, () => {
    assert.equal(splitReply(text).length, 0);
  });

test("blank paragraphs and edge whitespace never make an empty or padded part", () => {
  const parts = splitReply("\n\n  First.  \n\n\n\n \n\nSecond.\n\n");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "First.");
  assert.equal(parts[1], "Second.");
});
