import type { ResolvedChat } from '@beluga/core/chat-links/resolve.js';
import type { AppState, View } from '@beluga/core/store.js';
import { type ChatRef, chatLink, chatLinkAnswer, formatChatRef } from '@beluga/shared/chat-ref.js';
import type { ActionItem } from '../components/SpecMenu.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { useActions } from './actions.js';
import { toast } from './beluga.js';
import { copyText } from './copy.js';

type Actions = Pick<ReturnType<typeof useActions>, 'run'>;

/** Goes to a chat by the view chats.resolve gave it, the way a click on its sidebar row does. */
export function openChatView(actions: Actions, view: View): void {
  if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: view.tab });
  else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: view.tab });
  else actions.run({ type: 'view', view });
}

/**
 * Opens a chat's link (a deep link, or one in a message): asks the daemon, as the window may have
 * just launched. An unknown or removed chat stays where you are, with a toast.
 */
export async function openChatLink(client: SocketClient, actions: Actions, ref: ChatRef): Promise<void> {
  const text = formatChatRef(ref);
  if (!text) return;
  const chat = (await client.api.chats.resolve(text).catch(() => null)) as ResolvedChat | null;
  const answer = chatLinkAnswer(chat);
  if (answer.say) toast(client, answer.say, 'info');
  if (answer.opens && chat?.view) openChatView(actions, chat.view);
}

/** "Copy Chat Link" for a row's menu (beside a worktree's own Copy Link, BLG-878, which copies its worktree: ref): none for a chat with no address. */
export function chatLinkItems(state: AppState, client: SocketClient, channel: string): ActionItem[] {
  const link = chatLink({ owner: state.selfId, channel });
  if (!link) return [];
  return [{ label: 'Copy Chat Link', icon: 'link', onSelect: () => void copyText(link).then(() => toast(client, 'Link copied', 'success')) }];
}
