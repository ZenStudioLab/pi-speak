/** The most characters one spoken part of an answer may have before it is split further (D17). */
const PART_MAX_CHARS = 1000;
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Joins `pieces` in order, with a space, into parts of at most `PART_MAX_CHARS`; a piece longer than that stays whole. */
function pack(pieces: string[]): string[] {
  const parts: string[] = [];
  for (const piece of pieces) {
    const last = parts.length - 1;
    if (last >= 0 && parts[last]!.length + 1 + piece.length <= PART_MAX_CHARS) parts[last] += ` ${piece}`;
    else parts.push(piece);
  }
  return parts;
}

/** A paragraph longer than the limit: its sentences packed together, and a sentence still longer split at spaces. */
function splitLongParagraph(paragraph: string): string[] {
  const units: string[] = [];
  for (const { segment } of sentences.segment(paragraph)) {
    const sentence = segment.trim();
    if (sentence === "") continue;
    if (sentence.length <= PART_MAX_CHARS) units.push(sentence);
    else units.push(...pack(sentence.split(" ").filter((word) => word !== "")));
  }
  return pack(units);
}

/**
 * Splits a cleaned answer into the parts that are queued and spoken one by one (D17): one part per paragraph,
 * and a paragraph over 1,000 characters split at sentence ends, or at spaces when a single sentence is longer.
 * Text is never changed, only cut and trimmed, and no part is empty.
 */
export function splitReply(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .flatMap((paragraph) => (paragraph.length <= PART_MAX_CHARS ? [paragraph] : splitLongParagraph(paragraph)));
}
