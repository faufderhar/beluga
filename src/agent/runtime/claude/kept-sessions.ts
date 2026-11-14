/**
 * Sessions kept open per key for a short time after their last use (BLG-391): an MCP App's
 * tools/call goes through Claude Code, and opening a session for each call takes seconds. A session
 * whose use failed, or that its user said to forget, is closed and never used again. Every session
 * still kept is closed when the process exits.
 */

interface Closable {
  close(): void;
}

interface Kept<S> {
  readonly session: S;
  users: number;
  closed: boolean;
  timer?: NodeJS.Timeout;
}

/** Every keeper with a session open now: closed when the process exits. */
const withSessions = new Set<KeptSessions<Closable>>();
let exitHooked = false;

export class KeptSessions<S extends Closable> {
  private readonly kept = new Map<string, Kept<S>>();

  constructor(private readonly idleMs: number) {}

  /** Use the session kept for `key` (opened now when there is none). `forget()` closes it once this use ends. */
  async use<T>(key: string, open: () => S, use: (session: S, forget: () => void) => Promise<T>): Promise<T> {
    const entry = this.entry(key, open);
    entry.users++;
    clearTimeout(entry.timer);
    let keep = true;
    try {
      return await use(entry.session, () => void (keep = false));
    } catch (err) {
      keep = false;
      throw err;
    } finally {
      entry.users--;
      if (!keep) this.drop(key, entry);
      else if (entry.users === 0 && this.kept.get(key) === entry) entry.timer = setTimeout(() => this.drop(key, entry), this.idleMs).unref();
    }
  }

  /** Close every session kept now. */
  closeAll(): void {
    for (const [key, entry] of [...this.kept]) this.drop(key, entry);
  }

  private entry(key: string, open: () => S): Kept<S> {
    const found = this.kept.get(key);
    if (found) return found;
    const entry: Kept<S> = { session: open(), users: 0, closed: false };
    this.kept.set(key, entry);
    withSessions.add(this);
    hookExit();
    return entry;
  }

  private drop(key: string, entry: Kept<S>): void {
    clearTimeout(entry.timer);
    if (this.kept.get(key) === entry) this.kept.delete(key);
    if (this.kept.size === 0) withSessions.delete(this);
    if (entry.closed) return;
    entry.closed = true;
    try {
      entry.session.close();
    } catch {
      // Closed already.
    }
  }
}

/** Close every session any keeper still has (the daemon is going away). */
export function closeAllKeptSessions(): void {
  for (const keeper of [...withSessions]) keeper.closeAll();
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', closeAllKeptSessions);
}
