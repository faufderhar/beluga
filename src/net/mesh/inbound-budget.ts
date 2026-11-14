/**
 * What other people's Macs send can't take this one over (BLG-942). A friend's Beluga with a bug
 * (a loop between Macs, say) decides how much work it sends here, and every frame is handled on
 * the daemon's one thread, the same thread that answers your clicks and runs your agents.
 *
 * So each person has a share of that thread's time: their frames are handled as they come while
 * they cost little, and once someone's have used their share, the rest wait in a queue of their
 * own, in order, handled a slice at a time between everything else. Everyone together has a share
 * too, so many busy friends at once still leave the rest of the time to you. A queue past its cap
 * stops taking more (frames that matter come again: their sender resends what wasn't acknowledged).
 *
 * The shares are token buckets of milliseconds: they fill at a steady rate up to a burst, and
 * handling a frame takes what it cost.
 */

export interface BudgetOptions {
  /** Of every second, how many milliseconds one person's frames may take. */
  readonly perPersonMs?: number;
  /** Of every second, how many milliseconds everyone's together may take. */
  readonly allMs?: number;
  /** How much may be taken at once (a burst after quiet: a catch-up snapshot). */
  readonly burstMs?: number;
  /** Frames one person may have waiting; past it, theirs are let go. */
  readonly maxWaiting?: number;
  /** One slice of waiting frames, before the thread is handed back. */
  readonly sliceMs?: number;
  readonly now?: () => number;
  /** Run `fn` later: after what's waiting on the thread (0), or in `ms`. */
  readonly later?: (fn: () => void, ms: number) => void;
  /** Someone's frames started waiting, or were let go (for the black box). */
  readonly onBusy?: (peerId: string, waiting: number, dropped: number) => void;
  /** A frame's handling threw (it was handled from the queue, so nobody else would hear). */
  readonly onError?: (err: unknown) => void;
}

interface Bucket {
  tokens: number;
  at: number;
}

const DEFAULTS = { perPersonMs: 200, allMs: 400, burstMs: 400, maxWaiting: 5000, sliceMs: 8 };

export class InboundBudget {
  private readonly o: Required<Omit<BudgetOptions, 'onBusy' | 'onError'>> & Pick<BudgetOptions, 'onBusy' | 'onError'>;
  private readonly people = new Map<string, Bucket>();
  private readonly all: Bucket;
  private readonly waiting = new Map<string, Array<() => void>>();
  private scheduled = false;
  private stopped = false;
  /** Who was last served from the queues (they take turns). */
  private turn = 0;

  constructor(opts: BudgetOptions = {}) {
    const now = opts.now ?? (() => performance.now());
    const later = opts.later ?? ((fn: () => void, ms: number) => void (ms > 0 ? setTimeout(fn, ms).unref?.() : setImmediate(fn)));
    this.o = { ...DEFAULTS, ...opts, now, later };
    this.all = { tokens: this.o.burstMs, at: now() };
  }

  /** Handle a frame from `peerId`: now, if their share allows and nothing of theirs waits; else in turn. */
  take(peerId: string, handle: () => void): void {
    if (this.stopped) return;
    const queue = this.waiting.get(peerId);
    if (!queue && this.allowed(peerId)) {
      this.run(peerId, handle);
      return;
    }
    const list = queue ?? [];
    if (!queue) this.waiting.set(peerId, list);
    if (list.length >= this.o.maxWaiting) {
      this.o.onBusy?.(peerId, list.length, 1);
      return;
    }
    list.push(handle);
    if (list.length === 1) this.o.onBusy?.(peerId, 1, 0);
    this.schedule(0);
  }

  /**
   * Handle a frame now, ahead of whatever of theirs waits: for small frames that can't wait (a call
   * ringing, its setup), which have their own flood guard. What it costs still comes off their share.
   */
  urgent(peerId: string, handle: () => void): void {
    if (this.stopped) return;
    this.run(peerId, handle);
  }

  /** How many of someone's frames wait. */
  waitingFor(peerId: string): number {
    return this.waiting.get(peerId)?.length ?? 0;
  }

  /** Nothing more is handled (the mesh is closing). */
  stop(): void {
    this.stopped = true;
    this.waiting.clear();
  }

  private bucket(peerId: string): Bucket {
    let b = this.people.get(peerId);
    if (!b) this.people.set(peerId, (b = { tokens: this.o.burstMs, at: this.o.now() }));
    return b;
  }

  private fill(b: Bucket, perSecond: number): number {
    const now = this.o.now();
    b.tokens = Math.min(this.o.burstMs, b.tokens + ((now - b.at) * perSecond) / 1000);
    b.at = now;
    return b.tokens;
  }

  private allowed(peerId: string): boolean {
    return this.fill(this.bucket(peerId), this.o.perPersonMs) > 0 && this.fill(this.all, this.o.allMs) > 0;
  }

  private run(peerId: string, handle: () => void): void {
    const start = this.o.now();
    try {
      handle();
    } finally {
      const cost = this.o.now() - start;
      this.bucket(peerId).tokens -= cost;
      this.all.tokens -= cost;
    }
  }

  private schedule(ms: number): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    this.o.later(() => {
      this.scheduled = false;
      this.drain();
    }, ms);
  }

  /** One slice: waiting frames, taking turns among people whose share allows, then the thread is handed back. */
  private drain(): void {
    if (this.stopped) return;
    const start = this.o.now();
    while (this.waiting.size && this.o.now() - start < this.o.sliceMs) {
      const ready = [...this.waiting.keys()].filter((p) => this.allowed(p));
      if (!ready.length) break;
      const peerId = ready[this.turn++ % ready.length]!;
      const list = this.waiting.get(peerId)!;
      const handle = list.shift()!;
      if (!list.length) this.waiting.delete(peerId);
      try {
        this.run(peerId, handle);
      } catch (err) {
        this.o.onError?.(err);
      }
    }
    if (!this.waiting.size) return;
    // Someone's share is spent: when it has filled a little again (about 5 ms of their time); else go on right after what's waiting.
    const spent = ![...this.waiting.keys()].some((p) => this.allowed(p));
    this.schedule(spent ? Math.ceil((5 * 1000) / Math.min(this.o.perPersonMs, this.o.allMs)) : 0);
  }
}
