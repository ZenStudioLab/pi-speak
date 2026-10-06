import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
  utimes,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_MS = 60 * 60 * 1000;
const CLIP_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** Everything that changes the audio. The API key is deliberately absent. */
export interface CacheKeyInput {
  text: string;
  provider: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  voiceRevision: number;
  normalizerVersion: number;
  speechLocale?: string;
}

/**
 * SHA-256 of canonical JSON (fixed key order). This version sends no voice settings, so that
 * field is fixed to null; a future per-voice option must put the sent values there.
 */
export function cacheKey(input: CacheKeyInput): string {
  const canonical = JSON.stringify([
    ["text", input.text],
    ["provider", input.provider],
    ["voiceId", input.voiceId],
    ["modelId", input.modelId],
    ["outputFormat", input.outputFormat],
    ["voiceSettings", null],
    ["normalizerVersion", input.normalizerVersion],
    ["voiceRevision", input.voiceRevision],
    ["speechLocale", input.speechLocale ?? "original"],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Clip extension from an ElevenLabs-style format name such as `mp3_44100_128`. */
export function clipExtension(outputFormat: string): string {
  const codec = outputFormat.split("_")[0] ?? "";
  return /^[a-z0-9]{1,8}$/.test(codec) ? codec : "bin";
}

export interface CacheOptions {
  root: string;
  maxBytes: number;
  ttlDays: number;
  now?: () => number;
  /** Effective uid; defaults to the process uid. Used to verify the directory belongs to the user. */
  uid?: number;
}

export class CacheError extends Error {}

interface Clip {
  path: string;
  size: number;
  mtimeMs: number;
}

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/** Private per-user audio cache. Entry names are hashes, so no source text is stored. */
export class AudioCache {
  private readonly options: CacheOptions;
  private readonly now: () => number;
  private readonly uid: number | undefined;

  constructor(options: CacheOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.uid =
      options.uid ??
      (typeof process.getuid === "function" ? process.getuid() : undefined);
  }

  get root(): string {
    return this.options.root;
  }

  pathFor(key: string, extension: string): string {
    return join(this.options.root, `${key}.${extension}`);
  }

  /** Creates the directory with owner-only access, refusing symlinks and foreign owners. */
  async ensureDir(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.root);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new CacheError("cache path is not a plain directory");
    if (this.uid !== undefined && info.uid !== this.uid)
      throw new CacheError("cache directory is owned by another user");
    if ((info.mode & 0o077) !== 0) await chmod(this.options.root, 0o700);
  }

  /** Returns the clip path when a valid regular, nonempty, non-symlink file exists; touches it on use. */
  async get(key: string, extension: string): Promise<string | undefined> {
    const path = this.pathFor(key, extension);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
      return undefined;
    const when = new Date(this.now());
    await utimes(path, when, when);
    return path;
  }

  /** Writes through a unique private temporary file and renames it into place. */
  async put(
    key: string,
    extension: string,
    bytes: Uint8Array,
  ): Promise<string> {
    await this.ensureDir();
    const path = this.pathFor(key, extension);
    const temp = join(
      this.options.root,
      `${key}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await unlinkIfPresent(temp);
      throw error;
    }
    return path;
  }

  private async listClips(): Promise<{ clips: Clip[]; staleTemps: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.options.root);
    } catch (error) {
      if (isEnoent(error)) return { clips: [], staleTemps: [] };
      throw error;
    }
    const clips: Clip[] = [];
    const staleTemps: string[] = [];
    for (const name of names) {
      const path = join(this.options.root, name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      // Symlinks and non-regular entries are never read, followed, counted, or deleted.
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (name.endsWith(".tmp")) {
        if (this.now() - info.mtimeMs > STALE_TEMP_MS) staleTemps.push(path);
      } else if (CLIP_NAME.test(name)) {
        clips.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    return { clips, staleTemps };
  }

  /** Count and total size of cached clips, for status output (not usage accounting). */
  async stats(): Promise<{ files: number; bytes: number }> {
    const { clips } = await this.listClips();
    return {
      files: clips.length,
      bytes: clips.reduce((sum, clip) => sum + clip.size, 0),
    };
  }

  /** Removes expired clips, then oldest clips until under the size cap. Never removes `protectedPath`. */
  async evict(protectedPath?: string): Promise<string[]> {
    const { clips, staleTemps } = await this.listClips();
    const removed: string[] = [];
    const remove = async (path: string) => {
      await unlinkIfPresent(path);
      removed.push(path);
    };
    for (const path of staleTemps) await remove(path);

    const cutoff = this.now() - this.options.ttlDays * DAY_MS;
    let remaining: Clip[] = [];
    for (const clip of clips) {
      if (clip.path !== protectedPath && clip.mtimeMs < cutoff)
        await remove(clip.path);
      else remaining.push(clip);
    }
    let total = remaining.reduce((sum, clip) => sum + clip.size, 0);
    remaining = remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const clip of remaining) {
      if (total <= this.options.maxBytes) break;
      if (clip.path === protectedPath) continue;
      await remove(clip.path);
      total -= clip.size;
    }
    return removed;
  }
}
