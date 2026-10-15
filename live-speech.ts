import type { HoldClock } from "./hold-space.ts";
import type { SpeakUi, SpeechController } from "./speech-job.ts";

/** How long the microphone stays muted after Pi's player exits: its last words are still in the output and recorder buffers (D6). */
export const MUTE_TAIL_MS = 500;

/**
 * The ordered queue of Pi's spoken updates in one live session (D7). Updates are spoken one at a time
 * through `SpeechController.speakLive`; a failed one has already been reported there, and the next one
 * still plays. The player hooks decide when the microphone is muted. Once `end` has run, nothing more is
 * started or reported.
 */
export class LiveSpeech {
  private readonly speech: Pick<SpeechController, "speakLive" | "stopOwnAudio">;
  private readonly ui: SpeakUi;
  private readonly clock: Pick<HoldClock, "now">;
  private readonly onChange: () => void;
  private readonly waiting: string[] = [];
  private draining = false;
  private playing = false;
  private mutedUntil = 0;
  private ended = false;

  constructor(
    speech: Pick<SpeechController, "speakLive" | "stopOwnAudio">,
    ui: SpeakUi,
    clock: Pick<HoldClock, "now">,
    /** Called when `busy` changes, so the status line can follow. */
    onChange: () => void,
  ) {
    this.speech = speech;
    this.ui = ui;
    this.clock = clock;
    this.onChange = onChange;
  }

  /** An update is being synthesized or played, or is waiting for its turn. */
  get busy(): boolean {
    return this.draining;
  }

  /** From the player's start until `MUTE_TAIL_MS` after it exits, microphone audio must be replaced by silence. */
  get muted(): boolean {
    return this.playing || this.clock.now() < this.mutedUntil;
  }

  enqueue(text: string): void {
    this.waiting.push(text);
    if (!this.draining) void this.drain();
  }

  /** Drops the updates that have not started, as `/speak stop` does. The one being spoken is left to the caller. */
  dropWaiting(): void {
    this.waiting.length = 0;
  }

  /** Stops the update being synthesized or played and drops the waiting ones; false when nothing was being spoken. */
  cutOff(): boolean {
    const wasBusy = this.draining;
    this.dropWaiting();
    if (wasBusy) void this.speech.stopOwnAudio();
    return wasBusy;
  }

  end(): void {
    this.ended = true;
    this.cutOff();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    this.onChange();
    try {
      for (let text = this.waiting.shift(); text !== undefined && !this.ended; text = this.waiting.shift())
        await this.speech.speakLive(text, {
          ui: this.ui,
          onPlayerStart: () => {
            this.playing = true;
          },
          onPlayerExit: () => {
            this.playing = false;
            this.mutedUntil = this.clock.now() + MUTE_TAIL_MS;
          },
        });
    } finally {
      this.draining = false;
      if (!this.ended) this.onChange();
    }
  }
}
