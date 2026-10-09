import { formatKeys, type Shortcuts } from "./config.ts";
import type { Recording } from "./talk-state.ts";

const LEVEL_BARS = "▁▂▃▄▅▆▇█";

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The status line of a recording: its stop keys of every mode, and which of them send. */
export function statusLine(rec: Recording, keys: Shortcuts, now: number): string {
  const release = rec.hold ? "release Space to send · " : "";
  if (rec.phase === "recording") {
    const bar = LEVEL_BARS[rec.level - 1] ?? "·";
    return `● Recording ${formatElapsed(now - rec.startedAt)} ${bar} — ${release}${formatKeys(keys.send)} stop and send · ${formatKeys(keys.transcribe)} stop, transcribe only · ${formatKeys(keys.command)} stop, command · ${formatKeys(keys.skill)} stop, skill · Esc discard`;
  }
  if (rec.phase === "held")
    return `Recording limit reached (${rec.maxSeconds} s), not sent — ${release}${formatKeys(keys.send)} send · ${formatKeys(keys.transcribe)} transcribe only · ${formatKeys(keys.command)} command · ${formatKeys(keys.skill)} skill · Esc discard`;
  return "Transcribing…";
}
