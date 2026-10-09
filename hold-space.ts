import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { HoldHandle, TalkContext } from "./talk-state.ts";

/** Pressed again within this long, a Space is a key repeat (the probed terminal repeats every 30 ms). */
const REPEAT_GAP_MS = 120;
/** A hold with no Space for this long has ended, on terminals that report no release. */
const QUIET_GAP_MS = 300;
const CELL_SIZE_REPLY = /^\x1b\[6;\d+;\d+t$/;
const PASTE_START = "\x1b[200~";

/** Time, timers and the wait for already queued input, replaceable so a test can stall the event loop. */
export interface HoldClock {
  now(): number;
  /** Runs `fn` after `ms`; the result cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Runs `fn` after input that is already waiting has been read. */
  defer(fn: () => void): void;
}

export const systemClock: HoldClock = {
  now: Date.now,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  defer: (fn) => {
    setImmediate(fn);
  },
};

/** The two entry points of the controller that a hold may use. */
export interface HoldTarget {
  startHold(ctx: TalkContext): HoldHandle | undefined;
  endHold(hold: HoldHandle, outcome: "send" | "discard"): void;
}

type InputClass =
  | "space" // a single space: a press or a key repeat
  | "release" // the release of Space
  | "ignored" // other keys' releases and the terminal's cell-size reply
  | "passthrough" // Escape and the push-to-talk keys, which act through their own handlers
  | "other"; // everything else, including text in any script and bracketed paste

/** A hold, from the Space that was recognized until it ends. */
interface SpentHold {
  /** Undefined for a busy hold: nothing was started, and Spaces keep typing. */
  handle: HoldHandle | undefined;
  lastSpaceAt: number;
  /** Set once other input has discarded the hold's recording. */
  discarded: boolean;
}

/**
 * Recognizes a held Space from the terminal's key repeat, starts and ends a recording through the
 * controller (D17, ADR-0008), and consumes the hold's Spaces. The spent state outlives session
 * changes, so repeats that keep arriving after a change neither start a recording nor type.
 */
export class HoldSpace {
  private readonly target: HoldTarget;
  private readonly keys: readonly string[];
  private readonly clock: HoldClock;
  private ctx: TalkContext | undefined;
  private listener = 0;
  /** Bumped by `reset`; the Space removal of an earlier session does nothing. */
  private session = 0;
  private spent: SpentHold | undefined;
  private cancelTimer: (() => void) | undefined;
  /** Identifies the current timer, so a late timer or deferral does nothing. */
  private armed = 0;
  private repeats = 0;
  private lastRunAt: number | undefined;
  /** The Spaces this listener passed to the editor since the last input that was not a Space. */
  private typed = 0;

  constructor(target: HoldTarget, pushToTalkKeys: readonly string[], clock: HoldClock = systemClock) {
    this.target = target;
    this.keys = pushToTalkKeys;
    this.clock = clock;
  }

  /** Subscribes one listener for this session; a listener of an earlier session does nothing from then on. */
  attach(ctx: TalkContext): void {
    if (ctx.mode !== "tui") return;
    const listener = ++this.listener;
    this.ctx = ctx;
    ctx.ui.onTerminalInput((data) => (listener === this.listener ? this.onInput(data) : undefined));
  }

  /** A session change: clears the timers and the run of Spaces. The spent hold stays, and so does the listener (tree navigation keeps the session). */
  reset(): void {
    this.clearTimer();
    this.session++;
    this.breakRun();
  }

  /** Shutdown: as `reset`, and the context is forgotten, so nothing can reach it afterwards. */
  detach(): void {
    this.reset();
    this.ctx = undefined;
  }

  private onInput(data: string): { consume: true } | undefined {
    const kind = this.classify(data);
    if (kind === "ignored") return undefined;
    const now = this.clock.now();
    // A hold whose timer a session change cleared ends at the first input after the quiet gap.
    if (this.spent && !this.cancelTimer && now - this.spent.lastSpaceAt > QUIET_GAP_MS) this.endSpent();
    if (kind === "space") return this.onSpace(now);
    if (kind === "release") {
      if (this.spent) this.endSpent();
      else this.breakRun();
      return undefined;
    }
    const spent = this.spent;
    if (kind === "other" && spent?.handle && !spent.discarded) {
      spent.discarded = true;
      this.target.endHold(spent.handle, "discard");
    }
    this.breakRun();
    return undefined;
  }

  private classify(data: string): InputClass {
    if (data.includes(PASTE_START)) return "other";
    if (CELL_SIZE_REPLY.test(data)) return "ignored";
    if (data === " ") return "space";
    if (isKeyRelease(data)) return matchesKey(data, "space") ? "release" : "ignored";
    if (matchesKey(data, "escape") || this.keys.some((key) => matchesKey(data, key as KeyId)))
      return "passthrough";
    return "other";
  }

  private onSpace(now: number): { consume: true } | undefined {
    const spent = this.spent;
    if (spent) {
      spent.lastSpaceAt = now;
      this.armTimer();
      return spent.handle ? { consume: true } : undefined;
    }
    const repeat = this.lastRunAt !== undefined && now - this.lastRunAt <= REPEAT_GAP_MS;
    this.repeats = repeat ? this.repeats + 1 : 0;
    this.lastRunAt = now;
    const ctx = this.ctx;
    if (this.repeats < 2 || !ctx) {
      this.typed++;
      return undefined;
    }
    const handle = this.target.startHold(ctx);
    this.spent = { handle, lastSpaceAt: now, discarded: false };
    this.armTimer();
    if (!handle) {
      this.typed++;
      return undefined;
    }
    const session = this.session;
    const counted = this.typed;
    handle.onRecorderRunning = () => {
      if (session === this.session) this.removeTyped(ctx, counted);
    };
    return { consume: true };
  }

  /** Removes the Spaces typed before the hold was recognized, if the text still ends with them. */
  private removeTyped(ctx: TalkContext, count: number): void {
    const text = ctx.ui.getEditorText();
    if (count > 0 && text.endsWith(" ".repeat(count))) ctx.ui.setEditorText(text.slice(0, -count));
  }

  /** Input other than a Space ends the run of repeats and of typed Spaces. */
  private breakRun(): void {
    this.repeats = 0;
    this.lastRunAt = undefined;
    this.typed = 0;
  }

  private endSpent(): void {
    const spent = this.spent;
    if (!spent) return;
    this.spent = undefined;
    this.clearTimer();
    this.breakRun();
    if (spent.handle && !spent.discarded) this.target.endHold(spent.handle, "send");
  }

  private armTimer(): void {
    this.cancelTimer?.();
    const token = ++this.armed;
    // The deferral lets Spaces that queued up during a stall arrive first; any of them re-arms the timer.
    this.cancelTimer = this.clock.setTimer(() => this.clock.defer(() => this.quietGap(token)), QUIET_GAP_MS);
  }

  private quietGap(token: number): void {
    if (token === this.armed) this.endSpent();
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.armed++;
  }
}
