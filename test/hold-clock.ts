import type { HoldClock } from "../hold-space.ts";

/** Time, timers and deferral under the test's control; `stall` lets time pass without running deferred work. */
export class FakeClock implements HoldClock {
  time = 1_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private deferred: (() => void)[] = [];
  private nextId = 0;
  now(): number {
    return this.time;
  }
  setTimer(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return () => void this.timers.delete(id);
  }
  defer(fn: () => void): void {
    this.deferred.push(fn);
  }
  /** Moves time forward, firing due timers in order and then the work they deferred. */
  advance(ms: number): void {
    this.run(ms, true);
  }
  /** Moves time forward and fires due timers, but leaves their deferred work waiting, as a busy event loop does. */
  stall(ms: number): void {
    this.run(ms, false);
  }
  flush(): void {
    while (this.deferred.length > 0) this.deferred.shift()!();
  }
  get pending(): number {
    return this.timers.size + this.deferred.length;
  }
  private run(ms: number, flush: boolean): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
      if (flush) this.flush();
    }
    this.time = end;
  }
}
