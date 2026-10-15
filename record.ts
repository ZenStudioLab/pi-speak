/*
 * The recorder argument lists and the stop-with-SIGINT approach are adapted from privateer-speak
 * v0.8.0 (src/record.ts), which is distributed under the MIT License:
 *
 * Copyright (c) 2026 Patrick (zahnno)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  childEnvironment,
  resolveExecutable,
  sanitize,
  type SpawnFn,
} from "./audio.ts";
import type { Env } from "./config.ts";

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const LEVEL_STEPS = 8;
const WAV_HEADER_BYTES = 44;
const MAX_STDERR_CHARS = 2000;
const KILL_GRACE_MS = 2000;

/** Tried in this order; each writes 16 kHz mono signed 16-bit PCM to stdout. */
export const RECORDER_ARGS = {
  rec: ["-q", "-t", "raw", "-r", "16000", "-c", "1", "-e", "signed", "-b", "16", "-"],
  arecord: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"],
  ffmpeg: [
    "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default",
    "-ar", "16000", "-ac", "1", "-f", "s16le", "-",
  ],
} as const;
export const RECORDER_TOOLS = Object.keys(RECORDER_ARGS) as (keyof typeof RECORDER_ARGS)[];

export type RecorderExit =
  /** The controller asked for the stop, or the byte cap did; the audio is kept. A streaming recorder keeps none, so `pcm` is empty. */
  | { kind: "stopped"; pcm: Buffer; capped: boolean }
  /** The recorder ended on its own, or a requested stop left no audio. */
  | { kind: "failed"; detail: string };

export interface RecorderHandle {
  /** Asks only this recorder to end (SIGINT, then SIGKILL); a later exit is never a failure. */
  stop(): void;
  done: Promise<RecorderExit>;
}

export type StartRecorderResult =
  | { ok: true; handle: RecorderHandle }
  | { ok: false; tried: readonly string[] };

/** The first available recording tool, found without running anything. */
export async function findRecorder(
  env: Env,
): Promise<{ tool: keyof typeof RECORDER_ARGS; path: string } | undefined> {
  for (const tool of RECORDER_TOOLS) {
    const path = await resolveExecutable(tool, env);
    if (path) return { tool, path };
  }
  return undefined;
}

/** Loudness of one chunk of 16-bit PCM as 0 (silent) to `LEVEL_STEPS`. */
export function inputLevel(chunk: Uint8Array): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples) / 32768;
  return Math.min(LEVEL_STEPS, Math.round(Math.sqrt(rms) * LEVEL_STEPS));
}

/** Wraps raw 16 kHz mono 16-bit PCM in a WAV header, in memory. */
export function wavFromPcm(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

/** Where the audio goes: kept in memory up to `maxSeconds` (push-to-talk), or only streamed to the callbacks with no cap (`retain: false`, live mode). */
export type RecorderRetention = { retain?: true; maxSeconds: number } | { retain: false };

/**
 * Starts the first available recorder without a shell and without either provider key in its
 * environment. By default audio stays in memory and stops growing at `maxSeconds`, which also
 * stops the recorder. With `retain: false` chunks go only to `onLevel` and `onChunk`, nothing is
 * buffered, and nothing stops the recorder but `stop()` or the recorder itself.
 */
export async function startRecorder(options: RecorderRetention & {
  env: Env;
  spawnFn?: SpawnFn;
  /** Called with the level of each chunk. */
  onLevel?: (level: number) => void;
  /** Called with each chunk, such as to stream it while recording. */
  onChunk?: (chunk: Buffer) => void;
  /** Called once when the length cap stops the recorder, before the recorder has exited. */
  onCapped?: () => void;
  /** How long a recorder may ignore SIGINT before it is killed outright. */
  killGraceMs?: number;
}): Promise<StartRecorderResult> {
  const found = await findRecorder(options.env);
  if (!found) return { ok: false, tried: RECORDER_TOOLS };
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const child = spawnFn(found.path, [...RECORDER_ARGS[found.tool]], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnvironment(options.env),
  });
  /** Undefined for a streaming recorder (`retain: false`), which keeps no audio and has no cap. */
  const capBytes = options.retain === false ? undefined : options.maxSeconds * BYTES_PER_SECOND;
  const chunks: Buffer[] = [];
  let total = 0;
  let capped = false;
  let stopRequested = false;
  let exited = false;
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS)
      stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - stderr.length);
  });

  const done = new Promise<RecorderExit>((resolve) => {
    const settle = (why: string) => {
      if (exited) return;
      exited = true;
      if (!stopRequested) {
        const extra = sanitize(stderr);
        return resolve({
          kind: "failed",
          detail: extra ? `${found.tool} ${why}: ${extra}` : `${found.tool} ${why}`,
        });
      }
      if (capBytes !== undefined && total === 0)
        return resolve({ kind: "failed", detail: `${found.tool} recorded no audio` });
      resolve({ kind: "stopped", pcm: Buffer.concat(chunks), capped });
    };
    child.once("error", (error: Error) => settle(`could not run: ${sanitize(error.message)}`));
    // `close`, not `exit`: audio the recorder wrote before it stopped may still be in the pipe.
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
      settle(`exited on its own (${signal ? `signal ${signal}` : `exit code ${code}`})`),
    );
  });

  const stop = () => {
    if (stopRequested || exited) return;
    stopRequested = true;
    child.kill("SIGINT");
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.killGraceMs ?? KILL_GRACE_MS,
    );
    timer.unref();
    void done.then(() => clearTimeout(timer));
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (capBytes === undefined) {
      options.onLevel?.(inputLevel(chunk));
      options.onChunk?.(chunk);
      return;
    }
    const room = capBytes - total;
    if (room <= 0) return;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks.push(kept);
    total += kept.length;
    options.onLevel?.(inputLevel(kept));
    options.onChunk?.(kept);
    if (total >= capBytes && !stopRequested) {
      capped = true;
      stop();
      options.onCapped?.();
    }
  });

  return { ok: true, handle: { stop, done } };
}
