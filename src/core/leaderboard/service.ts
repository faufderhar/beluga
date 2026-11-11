import { readJson, writeJson } from '../../net/mesh/files.js';
import type { BoardDays } from '../../shared/leaderboard.js';
import { boardFrame, parseBoardFrame } from './protocol.js';

/**
 * The leaderboard's swap (BLG-904): being friends means sharing your three numbers a day with each
 * other. Your Mac sends its days to each friend when their link comes up and again whenever they
 * changed (checked every few minutes), and keeps what each friend sent in `file` (normally
 * ~/.beluga/leaderboard.json), so they still show while that friend is away.
 */

/** What the swap needs from the network: friends' links only. */
export interface BoardLinks {
  /** Friends linked right now. */
  linked(): string[];
  send(peerId: string, payload: unknown): boolean;
  /** A `stats` frame from a friend. */
  onFrame(fn: (from: string, payload: unknown) => void): () => void;
  /** A friend's link came up. */
  onLink(fn: (peerId: string) => void): () => void;
}

export interface LeaderboardDeps {
  readonly links: BoardLinks;
  /** Your days now (undefined while there's nothing counted yet: nothing is sent). */
  readonly mine: () => BoardDays | undefined;
  /** Where friends' numbers are kept; null: memory only (tests, the demo). */
  readonly file: string | null;
  /** How often to look whether your numbers changed. */
  readonly everyMs?: number;
  readonly now?: () => number;
  /** Something came from a friend (screens may ask again). */
  readonly onChange?: () => void;
}

export interface TheirBoard {
  readonly at: number;
  readonly days: BoardDays;
}

const EVERY_MS = 5 * 60_000;
const PEER = /^[\w-]{32}$/;

function load(file: string | null): Map<string, TheirBoard> {
  const raw = file ? readJson(file) : undefined;
  const out = new Map<string, TheirBoard>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [peerId, v] of Object.entries(raw as Record<string, unknown>)) {
    const got = PEER.test(peerId) ? parseBoardFrame({ v: 1, ...(v as object) }) : undefined;
    if (got) out.set(peerId, got);
  }
  return out;
}

export class Leaderboard {
  private readonly theirs: Map<string, TheirBoard>;
  /** What was last sent to each friend on their current link (so an unchanged board isn't sent again). */
  private readonly sent = new Map<string, string>();
  private readonly offs: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: LeaderboardDeps) {
    this.theirs = load(deps.file);
  }

  start(): void {
    const { links } = this.deps;
    this.offs.push(
      links.onFrame((from, payload) => this.receive(from, payload)),
      links.onLink((peerId) => {
        this.sent.delete(peerId);
        this.sendTo(peerId);
      }),
    );
    this.sendAll();
    this.timer = setInterval(() => this.sendAll(), this.deps.everyMs ?? EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** What a friend sent last, if anything. */
  of(peerId: string): TheirBoard | undefined {
    return this.theirs.get(peerId);
  }

  /** Send your days to every friend linked now whose copy is out of date. */
  sendAll(): void {
    for (const peerId of this.deps.links.linked()) this.sendTo(peerId);
  }

  private sendTo(peerId: string): void {
    const days = this.deps.mine();
    if (!days) return;
    const key = JSON.stringify(days);
    if (this.sent.get(peerId) === key) return;
    if (this.deps.links.send(peerId, boardFrame(days, this.now()))) this.sent.set(peerId, key);
  }

  /** A friend's numbers came: keep them if they fit (and aren't older than what's here). */
  receive(from: string, payload: unknown): boolean {
    const got = parseBoardFrame(payload);
    if (!got || !PEER.test(from)) return false;
    const before = this.theirs.get(from);
    if (before && before.at > got.at) return false;
    this.theirs.set(from, got);
    this.save();
    this.deps.onChange?.();
    return true;
  }

  /** Forget friends who aren't any more. */
  keepOnly(friends: ReadonlySet<string>): void {
    let dropped = false;
    for (const peerId of [...this.theirs.keys()]) {
      if (friends.has(peerId)) continue;
      this.theirs.delete(peerId);
      dropped = true;
    }
    if (dropped) this.save();
  }

  private save(): void {
    if (!this.deps.file) return;
    try {
      writeJson(this.deps.file, Object.fromEntries(this.theirs));
    } catch (err) {
      console.warn(`[leaderboard] couldn't save friends' numbers: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
