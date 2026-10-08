import { spawn as nodeSpawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { API_KEY_ENV, DEEPGRAM_API_KEY_ENV, type Env } from "./config.ts";

const MAX_STDERR_CHARS = 2000;
const KILL_GRACE_MS = 2000;

export type PlayerExit =
  | { kind: "finished" }
  | { kind: "stopped" }
  | { kind: "failed"; detail: string };

export interface PlayerHandle {
  /** Asks only this player to end; a later exit is reported as `stopped`, never as a failure. */
  stop(): void;
  done: Promise<PlayerExit>;
}

export type SpawnFn = typeof nodeSpawn;

const isExecutable = (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Finds an executable file by absolute path or on PATH, without running anything. */
export async function resolveExecutable(
  command: string,
  env: Env,
): Promise<string | undefined> {
  const candidates = command.includes("/")
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));
  for (const candidate of candidates)
    if (await isExecutable(candidate)) return candidate;
  return undefined;
}

/** Substitutes the audio path for the single `{file}` element; the path stays one argument. */
export function playerArgs(
  template: readonly string[],
  file: string,
): string[] {
  return template.map((arg) => (arg === "{file}" ? file : arg));
}

/** Child processes inherit audio settings but never receive either provider key. */
export function childEnvironment(env: Env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean[API_KEY_ENV];
  delete clean[DEEPGRAM_API_KEY_ENV];
  return clean;
}

// eslint-disable-next-line no-control-regex
const NOT_PRINTABLE = /[\u0000-\u001f\u007f-\u009f]+/g;

const sanitize = (text: string): string =>
  text.replace(NOT_PRINTABLE, " ").trim().slice(0, 200);

export function startPlayer(options: {
  command: string;
  args: readonly string[];
  file: string;
  env: Env;
  spawnFn?: SpawnFn;
  /** How long a player may ignore SIGTERM before it is killed outright. */
  killGraceMs?: number;
}): PlayerHandle {
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const child = spawnFn(
    options.command,
    playerArgs(options.args, options.file),
    {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: childEnvironment(options.env),
    },
  );
  let stopped = false;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS)
      stderr += chunk
        .toString("utf8")
        .slice(0, MAX_STDERR_CHARS - stderr.length);
  });

  const done = new Promise<PlayerExit>((resolve) => {
    child.once("error", (error: Error) =>
      resolve(
        stopped
          ? { kind: "stopped" }
          : { kind: "failed", detail: sanitize(error.message) },
      ),
    );
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (stopped) return resolve({ kind: "stopped" });
      if (code === 0) return resolve({ kind: "finished" });
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      const extra = sanitize(stderr);
      resolve({ kind: "failed", detail: extra ? `${why}: ${extra}` : why });
    });
  });

  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        options.killGraceMs ?? KILL_GRACE_MS,
      );
      timer.unref();
      void done.then(() => clearTimeout(timer));
    },
  };
}
