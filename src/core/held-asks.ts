/**
 * Messages you write in a worktree while it's still being made (its page shows at once, see
 * optimistic.ts): drawn in its conversation right away, and asked of its agent once git has made
 * the folder. If it can't be made, they're dropped and you're told.
 */
export interface HeldAsk {
  /** The worktree is made: ask its agent. */
  readonly go: () => void;
  /** It couldn't be made (or another one opened instead): what was written isn't asked. */
  readonly drop: () => void;
}

/** Called with what to run later: after whatever the code that made the worktree does next. */
export type Later = (run: () => void) => void;

/**
 * Held asks by worktree id. Released a turn later (`later`, setImmediate by default), so whatever
 * started the worktree with a first message of its own (a new worktree's task, a board task's
 * brief) asks it first, and these follow in the order you wrote them.
 */
export class HeldAsks {
  private readonly held = new Map<string, HeldAsk[]>();

  constructor(private readonly later: Later = (run) => void setImmediate(run)) {}

  hold(id: string, ask: HeldAsk): void {
    this.held.set(id, [...(this.held.get(id) ?? []), ask]);
  }

  /** How many are waiting for worktree `id`. */
  count(id: string): number {
    return this.held.get(id)?.length ?? 0;
  }

  /** Worktree `id` is done being made: `made` asks them, else they're dropped. */
  release(id: string, made: boolean): void {
    const asks = this.held.get(id);
    if (!asks) return;
    this.held.delete(id);
    this.later(() => {
      for (const ask of asks) {
        try {
          if (made) ask.go();
          else ask.drop();
        } catch {
          // One that fails leaves the others to go.
        }
      }
    });
  }
}
