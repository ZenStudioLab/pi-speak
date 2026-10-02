/** Bump when cleanup behavior changes so cached clips from older rules are not reused. */
export const NORMALIZER_VERSION = 1;

export const TABLE_NOTICE = "A table is available in the text response.";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const stripTerminalControls = (value: string): string =>
  value.replace(ANSI, "").replace(CONTROL, "");

/**
 * Explicit `/speak text` wording: terminal escape sequences and control characters are
 * removed and whitespace runs (including newlines and tabs) collapse to one space.
 * Markdown and everything else is left exactly as supplied.
 */
export function normalizeExplicitText(raw: string): string {
  return stripTerminalControls(raw).replace(/\s+/g, " ").trim();
}

// A backtick fence's info string cannot contain backticks, so ```inline``` on one line is inline code, not a fence.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const INDENTED = /^(?: {4}|\t)/;
const TABLE_ROW = /^\s*\|.*\|?\s*$|^\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*$/;

/** Removes fenced code and, conservatively, indented code blocks. */
function stripCodeBlocks(lines: string[]): string[] {
  const kept: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let indentedCode = false;
  let lastProseWasList = false;
  let previousBlank = true;

  for (const line of lines) {
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length && line.trim() === close[1])
        fence = undefined;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      previousBlank = false;
      continue;
    }
    const blank = line.trim() === "";
    if (indentedCode) {
      if (INDENTED.test(line) || blank) continue;
      indentedCode = false;
    }
    if (INDENTED.test(line) && previousBlank && !lastProseWasList) {
      indentedCode = true;
      continue;
    }
    if (!blank && !INDENTED.test(line)) lastProseWasList = LIST_ITEM.test(line);
    previousBlank = blank;
    kept.push(line);
  }
  return kept;
}

/** Replaces each run of table rows with one notice; the table is never interpreted. */
function replaceTables(lines: string[]): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.trim() !== "" && TABLE_ROW.test(line) && line.includes("|")) {
      if (!inTable) out.push(TABLE_NOTICE);
      inTable = true;
      continue;
    }
    inTable = false;
    out.push(line);
  }
  return out;
}

function stripInlineMarkup(text: string): string {
  const inline: string[] = [];
  const hold = (_match: string, code: string) => `\u0000${inline.push(code) - 1}\u0000`;
  return text
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, _t, code: string) => hold(m, code.trim()))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, "")
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*|__(\S(?:[\s\S]*?\S)?)__/g, (_m, a, b) => a ?? b)
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?=[^\w]|$)/g, "$1$2")
    .replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_m, index) => inline[Number(index)]);
}

/**
 * Deterministic answer cleanup for speech. Removes code, images, HTML, link destinations
 * and bare URLs; keeps readable inline identifiers, numbers, negation, and qualifications.
 * Never summarizes. Returns an empty string when no speakable prose remains.
 */
export function prepareAnswerText(markdown: string): string {
  const lines = replaceTables(stripCodeBlocks(stripTerminalControls(markdown).split(/\r?\n/)));
  const cleaned = lines
    .map((line) =>
      stripInlineMarkup(
        line
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s*>+\s?/, "")
          .replace(/^\s*(?:[-*+])\s+/, "")
          .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, ""),
      ).replace(/[ \t]+$/g, ""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
}

export type LengthCheck = { ok: true } | { ok: false; length: number; limit: number };

/** Counts Unicode code points. Text longer than the limit is refused, never truncated. */
export function checkLength(text: string, limit: number): LengthCheck {
  const length = [...text].length;
  return length <= limit ? { ok: true } : { ok: false, length, limit };
}
