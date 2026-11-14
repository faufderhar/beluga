import { randomBytes } from 'node:crypto';
import { JsonFile, readJson } from '../../net/mesh/files.js';
import { type ShareMsg, parseShareFrame } from './protocol.js';

/**
 * How sharing messages reach a friend: over your mesh link to them. What must arrive waits in an
 * outbox (`~/.beluga/share-outbox.json`, 7 days) until their Mac acknowledges it, sent again every
 * 20 s while they're linked and at once when they come back, so nothing said while they were
 * offline is lost. Live progress (a Claude's streamed steps) only goes to someone linked now.
 *
 * When the two of you are never online together (BLG-272): what nobody took for a while goes to
 * their mailbox (net/mesh/mailbox.ts), sealed to them, once; their acknowledgement comes back the
 * same way. Until it's acknowledged it stays here and still goes over the link when one comes up.
 */

/** What the courier needs from the mesh node. */
export interface ShareMesh {
  isLinked(peerId: string): boolean;
  /** Mail what still waits before this Mac leaves the network. */
  onLeaving?(fn: () => Promise<unknown>): () => void;
  sendShare(peerId: string, payload: unknown): boolean;
  /** Leave a frame in their mailbox (none: no mailbox). */
  mail?(peerId: string, t: 'share', payload: unknown): Promise<boolean>;
  /** How long a frame waits for a link before it's mailed (undefined: no mailbox). */
  readonly mailAfterMs?: number | undefined;
}

/** A frame as a courier sends it: a message with its id, or an acknowledgement. */
export type CourierFrame<M> = { readonly f: string; readonly m: M } | { readonly ack: string };

/** What a courier needs: who's linked, a way to hand a frame over, and how to read one. */
export interface CourierLink<M> {
  isLinked(peerId: string): boolean;
  send(peerId: string, payload: unknown): boolean;
  parse(raw: unknown): CourierFrame<M> | undefined;
  /** Leave a frame in their mailbox; true once it took it (BLG-272). */
  mail?(peerId: string, payload: unknown): Promise<boolean>;
  /** How long a frame waits for their link before it's mailed (undefined: no mailbox). */
  mailAfterMs?(): number | undefined;
}

interface Waiting<M> {
  readonly to: string;
  readonly frame: { readonly f: string; readonly m: M };
  readonly at: number;
  /** A newer message with the same key replaces this one (a project's latest state). */
  readonly key?: string;
  sentAt?: number;
  /** It's in their mailbox. */
  mailedAt?: number;
  /** Being posted to their mailbox now. */
  mailing?: boolean;
}

export const RESEND_MS = 20_000;
export const OUTBOX_DAYS = 7;
const MAX_WAITING = 2_000;
const SEEN_FRAMES = 1_000;
/**
 * The outbox is written at most this often: a busy team sends many frames a second, and a full
 * outbox is megabytes, so writing it for each one froze everything else the daemon does.
 */
export const SAVE_MS = 1_000;

const newId = (): string => randomBytes(12).toString('base64url');

/**
 * The courier for any kind of frame (sharing's, the team boards'): one outbox file per kind of
 * frame, the same rules.
 */
export class Courier<M> {
  private waiting: Waiting<M>[] = [];
  private readonly seen = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  /** The outbox file, written in the background a moment after a change (BLG-942). */
  private readonly outbox: JsonFile | undefined;

  constructor(
    private readonly link: CourierLink<M>,
    private readonly file: string | undefined,
    /** A message that waited was taken by their Mac. */
    private readonly onAcked: (to: string, msg: M) => void = () => undefined,
  ) {
    this.outbox = file ? new JsonFile(file, () => this.waiting.map(({ to, frame, at, key, mailedAt }) => ({ to, frame, at, ...(key ? { key } : {}), ...(mailedAt ? { mailedAt } : {}) })), SAVE_MS) : undefined;
    const saved = file ? readJson(file) : undefined;
    if (Array.isArray(saved)) {
      const cutoff = Date.now() - OUTBOX_DAYS * 86_400_000;
      this.waiting = saved.flatMap((w: Waiting<M>) => {
        const frame = link.parse(w?.frame);
        return frame && 'm' in frame && typeof w.to === 'string' && typeof w.at === 'number' && w.at > cutoff ? [{ to: w.to, frame, at: w.at, ...(w.key ? { key: w.key } : {}), ...(typeof w.mailedAt === 'number' ? { mailedAt: w.mailedAt } : {}) }] : [];
      });
    }
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), RESEND_MS);
    this.timer.unref();
  }

  /** Stops resending, and writes what waits now if a write was still to come. */
  stop(): void {
    clearInterval(this.timer);
    try {
      this.outbox?.flush();
    } catch {
      // Best effort: what waits is still in memory.
    }
  }

  /**
   * Send a message. `reliable`: it waits until acknowledged. `key`: replaces what waits with the
   * same key for that person. Returns whether it left now (or, unreliable, whether it went at all).
   */
  send(to: string, m: M, opts: { reliable: boolean; key?: string }): boolean {
    const frame = { f: newId(), m };
    const now = this.link.isLinked(to) && this.link.send(to, frame);
    if (!opts.reliable) return now;
    if (opts.key) this.waiting = this.waiting.filter((w) => !(w.to === to && w.key === opts.key));
    this.waiting.push({ to, frame, at: Date.now(), ...(opts.key ? { key: opts.key } : {}), ...(now ? { sentAt: Date.now() } : {}) });
    if (this.waiting.length > MAX_WAITING) this.waiting = this.waiting.slice(-MAX_WAITING);
    this.save();
    return now;
  }

  /** Is this message still waiting for that person's Mac? */
  pending(to: string, match: (m: M) => boolean): boolean {
    return this.waiting.some((w) => w.to === to && match(w.frame.m));
  }

  /** What still waits, and since when (and whether it's in their mailbox), for screens. */
  waitingFor(match: (m: M) => boolean): Array<{ readonly to: string; readonly since: number; readonly mailed: boolean; readonly m: M }> {
    return this.waiting.filter((w) => match(w.frame.m)).map((w) => ({ to: w.to, since: w.at, mailed: Boolean(w.mailedAt), m: w.frame.m }));
  }

  /** A frame from a friend: acks clear the outbox; a message is acknowledged and handed on once (with its frame id). */
  receive(from: string, raw: unknown): { readonly id: string; readonly m: M } | undefined {
    const frame = this.link.parse(raw);
    if (!frame) return undefined;
    if ('ack' in frame) {
      const i = this.waiting.findIndex((w) => w.to === from && w.frame.f === frame.ack);
      if (i >= 0) {
        const [done] = this.waiting.splice(i, 1);
        this.save();
        this.onAcked(from, done!.frame.m);
      }
      return undefined;
    }
    // Always acknowledged (the ack may be what got lost), handed on only once; by mail when it came by mail.
    if (!(this.link.isLinked(from) && this.link.send(from, { ack: frame.f }))) void this.link.mail?.(from, { ack: frame.f });
    const seen = this.seen.get(from) ?? new Set<string>();
    this.seen.set(from, seen);
    if (seen.has(frame.f)) return undefined;
    seen.add(frame.f);
    if (seen.size > SEEN_FRAMES) seen.delete(seen.values().next().value!);
    return { id: frame.f, m: frame.m };
  }

  /** Send what waits (for one person, or everyone linked); `force`: even what went moments ago. */
  flush(to?: string, force = false): void {
    const now = Date.now();
    const cutoff = now - OUTBOX_DAYS * 86_400_000;
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.at > cutoff);
    const mailAfter = this.link.mailAfterMs?.();
    for (const w of this.waiting) {
      if (to && w.to !== to) continue;
      if (this.link.isLinked(w.to)) {
        if (!force && w.sentAt && now - w.sentAt < RESEND_MS) continue;
        if (this.link.send(w.to, w.frame)) w.sentAt = now;
      } else if (mailAfter !== undefined && !w.mailedAt && !w.mailing && now - w.at >= mailAfter) void this.mailOne(w);
    }
    if (this.waiting.length !== before) this.save();
  }

  /** Leaving the network: everything not yet in someone's mailbox goes there now, whatever its age. */
  async mailAll(): Promise<void> {
    await Promise.all(this.waiting.filter((w) => !w.mailedAt).map((w) => this.mailOne(w)));
  }

  /** Post one waiting frame to their mailbox (once; tried again on a later flush if it didn't take). */
  private mailOne(w: Waiting<M>): Promise<void> {
    if (!this.link.mail || w.mailing) return Promise.resolve();
    w.mailing = true;
    return this.link
      .mail(w.to, w.frame)
      .then((ok) => {
        if (!ok || !this.waiting.includes(w)) return;
        w.mailedAt = Date.now();
        this.save();
        this.onMailed?.(w.to, w.frame.m);
      })
      .catch(() => undefined)
      .finally(() => {
        w.mailing = false;
      });
  }

  /** Something waiting went to their mailbox. */
  onMailed: ((to: string, msg: M) => void) | undefined;

  /** Forget what waits for someone (they're no longer a friend). */
  drop(to: string): void {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.to !== to);
    if (this.waiting.length !== before) this.save();
  }

  /** Written soon, in the background (once for every change in the meantime); stop() writes it at once. */
  private save(): void {
    this.outbox?.changed();
  }
}

/** Sharing's courier: `share` frames (protocol.ts), kept in share-outbox.json. */
export class ShareCourier extends Courier<ShareMsg> {
  constructor(mesh: ShareMesh, file: string | undefined, onAcked?: (to: string, msg: ShareMsg) => void) {
    super({ isLinked: (p) => mesh.isLinked(p), send: (p, payload) => mesh.sendShare(p, payload), parse: parseShareFrame, mail: (p, payload) => mesh.mail?.(p, 'share', payload) ?? Promise.resolve(false), mailAfterMs: () => mesh.mailAfterMs }, file, onAcked);
  }
}
