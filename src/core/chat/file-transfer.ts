import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Bucket } from '../../net/mesh/link.js';
import type { FileFrame } from '../../net/mesh/mesh.js';
import { FILE_PIECE } from '../../net/mesh/wire.js';
import { THIS_COMPUTER } from '../../shared/assistant.js';

/**
 * Chat files travel Mac to Mac over the same end-to-end links as messages, pulled by the
 * receiver a piece at a time with several pieces in flight (so a fast link is used fully and a
 * slow one isn't flooded). Any Mac that has the file can give it, but only to people in a
 * conversation it was shared in. The receiver checks the SHA-256 before keeping anything; if
 * one Mac stops answering, the rest comes from another that has it.
 */

/** Pieces asked for at once. */
export const WINDOW = 12;
/** How long one piece may take before it's asked for again, and how often before moving on. */
export const PIECE_TIMEOUT_MS = 15_000;
const PIECE_TRIES = 2;
/** How long to wait before asking a busy Mac again. */
const BUSY_WAIT_MS = 400;

export interface FileLinks {
  readonly send: (peerId: string, frame: FileFrame) => boolean;
  readonly isLinked: (peerId: string) => boolean;
}

/** Pieces one person may be reading from you at once, and bytes a second they may take (in a burst). */
const SERVE_PARALLEL = 48;
const SERVE_RATE = 48 * 1024 * 1024;
const SERVE_BURST = 96 * 1024 * 1024;

/** The giving side: answers `f_get` for files that are here, to people who may have them. */
export class FileServer {
  private readonly busy = new Map<string, number>();
  private readonly budget = new Map<string, Bucket>();

  constructor(
    private readonly links: FileLinks,
    private readonly pathOf: (sha: string) => string | undefined,
    /** May `peerId` have this file (it was shared in a conversation you're both in)? */
    private readonly mayHave: (peerId: string, sha: string) => boolean,
  ) {}

  async onGet(from: string, msg: Extract<FileFrame, { t: 'f_get' }>): Promise<void> {
    const fail = (e: string): void => void this.links.send(from, { t: 'f_err', rid: msg.rid, off: msg.off, e });
    const file = this.pathOf(msg.sha);
    // Not here, or not theirs to have: the same answer, so nothing is learned.
    if (!file || !this.mayHave(from, msg.sha)) return fail('not here');
    // Asking for more than a few pulls' worth at once, or faster than a link carries: slow down.
    const bucket = this.budget.get(from) ?? new Bucket(SERVE_RATE, SERVE_BURST);
    this.budget.set(from, bucket);
    const reading = this.busy.get(from) ?? 0;
    if (reading >= SERVE_PARALLEL || !bucket.take(msg.len)) return fail('busy');
    this.busy.set(from, reading + 1);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, 'r');
      const buf = Buffer.alloc(Math.min(msg.len, FILE_PIECE));
      const { bytesRead } = await handle.read(buf, 0, buf.length, msg.off);
      this.links.send(from, { t: 'f_data', rid: msg.rid, off: msg.off, d: buf.subarray(0, bytesRead).toString('base64') });
    } catch {
      fail('could not be read');
    } finally {
      await handle?.close();
      const left = (this.busy.get(from) ?? 1) - 1;
      if (left > 0) this.busy.set(from, left);
      else this.busy.delete(from);
    }
  }
}

export interface Want {
  readonly sha: string;
  readonly size: number;
  /** Who may have it, best first (the one who shared it, then the others in the conversation). */
  readonly sources: readonly string[];
}

export interface PullEvents {
  readonly progress: (received: number) => void;
  /** Nobody who has it is online now (it carries on when one of them is). */
  readonly waiting: (waiting: boolean) => void;
}

interface Inflight {
  readonly timer: NodeJS.Timeout;
  readonly tries: number;
}

/** One file being pulled: pieces in flight from one source at a time, on to the next if it fails. */
export class Pull {
  readonly rid = randomBytes(9).toString('base64url');
  private handle: fs.FileHandle | undefined;
  /** The next piece never asked for. */
  private next = 0;
  /** Pieces to ask for again (their source failed). */
  private retry: number[] = [];
  private received = 0;
  private readonly inflight = new Map<number, Inflight>();
  private sourceAt = -1;
  /** Sources that said no or went quiet (asked again only when they come back online). */
  private readonly failed = new Set<string>();
  private settle!: (error?: string) => void;
  private finished = false;
  /** Settles when the file came whole (undefined) or why it didn't. */
  readonly done: Promise<string | undefined>;

  constructor(
    private readonly links: FileLinks,
    readonly want: Want,
    private readonly part: string,
    private readonly events: PullEvents,
    private readonly timeoutMs = PIECE_TIMEOUT_MS,
  ) {
    this.done = new Promise((resolve) => {
      this.settle = (error) => {
        if (this.finished) return;
        this.finished = true;
        for (const f of this.inflight.values()) clearTimeout(f.timer);
        this.inflight.clear();
        const handle = this.handle;
        this.handle = undefined;
        void (handle ? handle.close() : Promise.resolve()).catch(() => undefined).then(() => resolve(error));
      };
    });
  }

  /** The source asked now. */
  get source(): string | undefined {
    return this.want.sources[this.sourceAt];
  }

  async start(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.part), { recursive: true, mode: 0o700 });
      const handle = await fs.open(this.part, 'w', 0o600);
      // Cancelled while it was opening: nothing more to do.
      if (this.finished) return void (await handle.close());
      this.handle = handle;
    } catch {
      this.settle(`it could not be saved on ${THIS_COMPUTER}`);
      return;
    }
    if (this.want.size === 0) return this.settle();
    if (!this.want.sources.length) return this.settle('nobody has it');
    this.nextSource();
  }

  cancel(reason = 'cancelled'): void {
    this.settle(reason);
  }

  onData(from: string, msg: Extract<FileFrame, { t: 'f_data' }>): void {
    const wait = this.inflight.get(msg.off);
    if (this.finished || from !== this.source || !wait) return;
    const bytes = Buffer.from(msg.d, 'base64');
    if (bytes.length !== Math.min(FILE_PIECE, this.want.size - msg.off)) return this.nextSource();
    clearTimeout(wait.timer);
    this.inflight.delete(msg.off);
    const handle = this.handle;
    if (!handle) return;
    handle.write(bytes, 0, bytes.length, msg.off).then(
      () => {
        if (this.finished) return;
        this.received += bytes.length;
        this.events.progress(this.received);
        if (this.received >= this.want.size) this.settle();
        else this.pump();
      },
      () => this.settle(`it could not be saved on ${THIS_COMPUTER}`),
    );
  }

  onError(from: string, msg: Extract<FileFrame, { t: 'f_err' }>): void {
    const wait = this.inflight.get(msg.off);
    if (this.finished || from !== this.source || !wait) return;
    if (msg.e !== 'busy') return this.nextSource();
    // They're serving a lot right now: ask for that piece again in a moment.
    clearTimeout(wait.timer);
    const timer = setTimeout(() => {
      if (this.finished || this.inflight.get(msg.off)?.timer !== timer) return;
      this.inflight.delete(msg.off);
      if (!this.ask(msg.off, wait.tries)) {
        this.retry.unshift(msg.off);
        this.nextSource();
      }
    }, BUSY_WAIT_MS);
    timer.unref?.();
    this.inflight.set(msg.off, { timer, tries: wait.tries });
  }

  /** Someone came online: if nobody could be asked before, ask now (them too, if they failed before: they're back). */
  linked(peerId: string): void {
    if (!this.finished && this.source === undefined && this.want.sources.includes(peerId)) {
      this.failed.delete(peerId);
      this.sourceAt = -1;
      this.nextSource();
    }
  }

  /** Move on to the next source that's online; what was in flight is asked for again there. */
  private nextSource(): void {
    for (const [off, f] of this.inflight) {
      clearTimeout(f.timer);
      this.retry.push(off);
    }
    this.inflight.clear();
    this.retry.sort((a, b) => a - b);
    const was = this.source;
    if (was) this.failed.add(was);
    do this.sourceAt += 1;
    while (this.sourceAt < this.want.sources.length && (this.failed.has(this.want.sources[this.sourceAt]!) || !this.links.isLinked(this.want.sources[this.sourceAt]!)));
    if (this.source === undefined) {
      this.events.waiting(true);
      return;
    }
    this.events.waiting(false);
    this.pump();
  }

  private pump(): void {
    while (!this.finished && this.source !== undefined && this.inflight.size < WINDOW) {
      let off = this.retry.shift();
      if (off === undefined && this.next < this.want.size) {
        off = this.next;
        this.next += FILE_PIECE;
      }
      if (off === undefined) return;
      if (!this.ask(off, 0)) {
        this.retry.unshift(off);
        return this.nextSource();
      }
    }
  }

  /** Ask the current source for one piece; false when they can't be reached. */
  private ask(off: number, tries: number): boolean {
    const source = this.source;
    const len = Math.min(FILE_PIECE, this.want.size - off);
    if (!source || !this.links.send(source, { t: 'f_get', rid: this.rid, sha: this.want.sha, off, len })) return false;
    const timer = setTimeout(() => {
      if (this.finished || this.inflight.get(off)?.timer !== timer) return;
      // Asked enough times: this source is stuck (the piece stays in flight, so it's asked of the next one).
      if (tries + 1 >= PIECE_TRIES) return this.nextSource();
      this.inflight.delete(off);
      if (!this.ask(off, tries + 1)) {
        this.retry.unshift(off);
        this.nextSource();
      }
    }, this.timeoutMs);
    timer.unref?.();
    this.inflight.set(off, { timer, tries });
    return true;
  }
}
