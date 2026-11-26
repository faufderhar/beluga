/**
 * Flow control between a terminal program and one screen drawing it (BLG-963).
 *
 * A program can write far faster than a screen can draw (a build log, `cat` of a big file, a
 * full-screen program redrawing). Without a limit every byte piles up in the screen, and what
 * you type (and its echo, and Ctrl+C's effect) waits behind megabytes still to be drawn. So the
 * screen tells the daemon how much it has drawn, and while it is far behind the program waits
 * (its PTY is paused, the way a real terminal makes a program wait) until the screen catches up.
 *
 * A screen that stops answering (asleep, hung, a hidden window) never holds the program for
 * long: after FLOW_STALE_MS without an answer it lets go, and holds again only once it answers.
 */

/** Characters a screen may be behind before the program waits for it. */
export const FLOW_HIGH = 256 * 1024;
/** …and how far it must catch up before the program goes on. */
export const FLOW_LOW = 32 * 1024;
/** A screen that hasn't answered for this long stops holding the program. */
export const FLOW_STALE_MS = 3000;

export interface FlowGateOptions {
  readonly high?: number;
  readonly low?: number;
  readonly staleMs?: number;
  readonly now?: () => number;
}

/** One screen's place in one program's output: holds the program while the screen is far behind. */
export class FlowGate {
  private behind = 0;
  private holding = false;
  private lastAnswer: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly high: number;
  private readonly low: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly hold: () => void,
    private readonly release: () => void,
    opts: FlowGateOptions = {},
  ) {
    this.high = opts.high ?? FLOW_HIGH;
    this.low = opts.low ?? FLOW_LOW;
    this.staleMs = opts.staleMs ?? FLOW_STALE_MS;
    this.now = opts.now ?? Date.now;
    this.lastAnswer = this.now();
  }

  /** Whether the program is waiting for this screen now. */
  get held(): boolean {
    return this.holding;
  }

  /** How many characters the screen has been sent and not yet drawn. */
  get pending(): number {
    return this.behind;
  }

  /** `n` characters went to the screen. */
  sent(n: number): void {
    this.behind += n;
    if (this.holding || this.behind <= this.high || this.stale()) return;
    this.holding = true;
    this.hold();
    this.watch();
  }

  /** The screen drew `n` more characters. */
  acked(n: number): void {
    this.behind = Math.max(0, this.behind - n);
    this.lastAnswer = this.now();
    if (this.holding && this.behind <= this.low) this.letGo();
  }

  /** The screen left: the program never waits for it again. */
  dispose(): void {
    if (this.holding) this.letGo();
  }

  private stale(): boolean {
    return this.now() - this.lastAnswer >= this.staleMs;
  }

  private letGo(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.holding = false;
    this.release();
  }

  /** While holding, let go once the screen has gone quiet for too long. */
  private watch(): void {
    clearTimeout(this.timer);
    const left = Math.max(0, this.staleMs - (this.now() - this.lastAnswer));
    this.timer = setTimeout(() => {
      if (!this.holding) return;
      if (this.stale()) this.letGo();
      else this.watch();
    }, left);
    this.timer.unref?.();
  }
}
