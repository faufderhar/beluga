import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { type InviteRoute, namesLine, newChannelLine } from '@beluga/shared/invite-route.js';
import { openNet } from '../network/net-sheets.js';
import { inviteFor } from './invite-model.js';
import type { UiStore } from './beluga.js';
import { shareWithFriend } from './share-with-friend.js';

/**
 * `/invite` typed in any of the Mac's message boxes (BLG-203): on its own, Add a Friend; with
 * friends named, they're added to what's on screen (src/shared/invite-route.ts says what that is).
 */

const say = (client: SocketClient, text: string, level: 'success' | 'info' | 'warn' | 'error'): void => client.store.dispatch({ type: 'toast', text, level });
const failed = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Something went wrong: /, '');

/** Do what a route says. */
export async function runInvite(client: SocketClient, ui: UiStore, route: InviteRoute): Promise<void> {
  switch (route.kind) {
    case 'add_friend':
      return openNet({ kind: 'add_friend' });
    case 'error':
      return say(client, route.text, 'warn');
    case 'new_channel':
      // Offered, not done: the New Channel sheet with them ticked, ready to name.
      openNet({ kind: 'new_group', with: route.with.map((f) => f.peerId) });
      return say(client, `${newChannelLine(route.with)}: name it and press Create`, 'info');
    case 'add_members': {
      const added: string[] = [];
      for (const f of route.friends) {
        try {
          await client.api.network['groups.addMember'](route.groupId, f.peerId);
          added.push(f.name);
        } catch (err) {
          say(client, `Couldn’t add ${f.name}: ${failed(err)}`, 'error');
        }
      }
      if (added.length) say(client, `Added ${namesLine(added)} to ${route.group}`, 'success');
      return;
    }
    case 'share': {
      const how: string[] = [];
      for (const f of route.friends) {
        try {
          const done = await shareWithFriend(client, ui, { peerId: f.peerId, name: f.name, ...(route.projectId ? { projectId: route.projectId } : {}), ...(route.workspaceId ? { workspaceId: route.workspaceId } : { whole: true }), role: 'contribute' });
          if (done === 'sheet') return;
          how.push(f.name);
        } catch (err) {
          say(client, `Couldn’t share ${route.where} with ${f.name}: ${failed(err)}`, 'error');
        }
      }
      if (how.length) say(client, `Shared ${route.where} with ${namesLine(how)}`, 'success');
      return;
    }
  }
}

/** The message box's words, if they're /invite: done here (true), not sent. */
export function handleInvite(client: SocketClient, ui: UiStore, text: string): boolean {
  const route = inviteFor(text, client.store.getState());
  if (!route) return false;
  void runInvite(client, ui, route);
  return true;
}
