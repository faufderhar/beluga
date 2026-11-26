import type { AppState, Location } from '../../../../src/core/store.js';
import { shareNameOf } from '../../../../src/shared/share-names.js';

/**
 * Where a folder of this Mac, linked in the chat, opens (BLG-958):
 * - `worktree`: in that worktree's (or project's) Files, the tree of its own folder;
 * - `files`: in Files, among the folders you share with the room;
 * - `finder`: in Finder. Nothing in Beluga draws a folder outside your projects and shares (the
 *   private `local-…` share the daemon makes for it has no Files of its own), so Files would be empty.
 */
export type FolderRoute = { readonly kind: 'worktree'; readonly wsId: string } | { readonly kind: 'files' } | { readonly kind: 'finder' };

type RouteState = Pick<AppState, 'selfId' | 'projects' | 'myShares'>;

/** Where `at` (what session.localLocation made of the folder) opens. */
export function folderRoute(state: RouteState, at: Location): FolderRoute {
  if (at.owner !== state.selfId) return { kind: 'files' };
  for (const p of state.projects) {
    const ws = p.workspaces.find((w) => shareNameOf(w.id) === at.share);
    if (ws) return { kind: 'worktree', wsId: ws.id };
  }
  const share = state.myShares.find((s) => s.name === at.share);
  return share && !share.private ? { kind: 'files' } : { kind: 'finder' };
}
