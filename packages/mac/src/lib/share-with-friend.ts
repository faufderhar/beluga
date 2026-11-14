import { METHODS } from '@beluga/ipc/api.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inviteChoice } from '@beluga/ui/invite-menus.js';
import type { UiStore } from './beluga.js';

/**
 * Sharing a project or a worktree with a friend (BLG-203's `/invite @ata` in a project). It goes
 * over your friends' network links with nobody hosting (`sharing.shareWithFriend`, BLG-204): it
 * shows in their Projects. A Beluga daemon from before that (an older one still running) doesn't
 * have it: then a friend who is in your room gets the worktree through the room as before, and
 * otherwise the room's share sheet opens with a note.
 */

export interface ShareWithFriend {
  readonly peerId: string;
  readonly name: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly role: 'view' | 'contribute';
  /** The whole project, even for a friend who has only some of its worktrees. */
  readonly whole?: boolean;
}

/** Whether this Beluga can share with friends over the network. */
export const canShareWithFriends = (): boolean => (METHODS as readonly string[]).includes('sharing.shareWithFriend');

/** → how it went: shared over the network, through the room, or the sheet opened for you to finish. */
export async function shareWithFriend(client: SocketClient, ui: UiStore, req: ShareWithFriend): Promise<'network' | 'room' | 'sheet'> {
  const { name: _name, ...wire } = req;
  if (canShareWithFriends()) {
    await client.api.sharing.shareWithFriend(wire);
    return 'network';
  }
  const state = client.store.getState();
  const inRoom = state.peers.some((p) => p.peerId === req.peerId && !p.guest);
  if (req.workspaceId && inRoom) {
    await client.api.sharing.invite(req.workspaceId, req.peerId, req.role);
    return 'room';
  }
  const note = `Sharing with friends who aren’t in your room isn’t in this Beluga yet. Invite ${req.name} here for now`;
  if (req.workspaceId) ui.openMenu({ kind: 'ws_share', id: req.workspaceId });
  else ui.openMenu({ kind: 'invite_link', ...inviteChoice(req.projectId) });
  client.store.dispatch({ type: 'toast', text: note, level: 'info' });
  return 'sheet';
}
