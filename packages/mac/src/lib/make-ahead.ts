import { slugify } from '@beluga/agent/namer.js';
import { pendingWorktree } from '@beluga/core/optimistic.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';

/**
 * A new worktree shows the moment you ask for it (BLG-942): its row under its project and its
 * "Making…" page, here, before Beluga's daemon has even heard of it, with the id it will have.
 * The daemon is asked to make it with that id; its own picture of it then takes over, under the
 * same id, so nothing jumps. Asking failed: `drop` takes the row and the page away again (the
 * caller says why). However busy the daemon is, the click is answered at once.
 */
export interface MadeAhead {
  /** The id it's being made under (sent to the daemon with the ask). */
  readonly id: string;
  /** Asking failed: it goes from the sidebar and its page closes. */
  readonly drop: () => void;
}

/** What you asked each worktree being made here, until the daemon shows it on its page (by id). */
const asked = new Map<string, string>();

/** What you asked a worktree being made, while only this screen knows it (its "Making…" page says it). */
export const askedAhead = (id: string): string | undefined => asked.get(id);

/** A worktree id as the daemon makes them (wt- and 12 of a UUID's characters). */
export const newWorktreeId = (): string => `wt-${crypto.randomUUID().slice(0, 12)}`;

/**
 * Show a worktree of `projectId` as being made, at once. `name`: what its row says until it's made
 * (the daemon's name for it, or the first words of what you asked). Undefined when the project
 * isn't one this screen can show (the daemon's answer shows it then, as before).
 */
export function makeAhead(client: SocketClient, projectId: string, name: string, opts: { readonly base?: string; readonly asked?: string } = {}): MadeAhead | undefined {
  const project = client.store.getState().projects.find((p) => p.id === projectId && p.root);
  if (!project) return undefined;
  const id = newWorktreeId();
  if (opts.asked?.trim()) asked.set(id, opts.asked.trim());
  const shown = client.store.makeAhead(pendingWorktree({ id, project, name: slugify(name) || 'worktree', ...(opts.base ? { base: opts.base } : {}) }));
  return {
    id,
    drop: () => {
      asked.delete(id);
      shown.drop();
    },
  };
}
