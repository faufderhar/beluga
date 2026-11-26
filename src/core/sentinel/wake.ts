import { parseChatRef } from '../../shared/chat-ref.js';
import type { DomainState } from '../store.js';

/**
 * Who a sentinel may wake (BLG-397): only a chat that is yours alone. A woken turn runs with your
 * whole scope, so a chat you share with a contributor is refused: their words would steer it.
 */

/** Why a sentinel may not wake the chat `to` (a ref or a channel of yours), in words; undefined when it may. */
export function wakeRefusal(state: DomainState, to: string): string | undefined {
  const ref = to.includes('/') ? parseChatRef(to) : { owner: state.selfId, channel: to };
  if (!ref) return 'that is not a chat a ref can name';
  if (ref.owner !== state.selfId) return 'a sentinel wakes only your own chats, not one another person shared with you';
  // A main checkout that moved on to a chat delivers there (chat-links targetOf): that chat is checked too.
  const ws = /^ws:(.+)$/.exec(ref.channel)?.[1];
  const moved = ws ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === ws)?.movedTo : undefined;
  const roles = [ws, moved].flatMap((id) => (id ? Object.values(state.members[id] ?? {}) : []));
  return roles.includes('contribute') ? 'that chat is shared with a contributor, and a sentinel wakes only a chat that is yours alone' : undefined;
}

/** What an agent writes in a chat step's `to` for the chat it is in (sentinel_create, sentinel_update). */
export const THIS_CHAT = 'this chat';

/** Why `to: "this chat"` fails where no chat can take it. */
export const NO_THIS_CHAT = 'The "this chat" target needs a chat that has a ref. The room, a DM, a group, a draft and a sentinel run have no ref. Give the ref of one of the user’s chats ("<owner>/ws:<id>").';

/**
 * Steps whose chat step says `to: "this chat"`, with the ref of `here` (the calling chat) in its
 * place. Throws NO_THIS_CHAT when there is no calling chat, or it has no ref.
 */
export function withThisChat<S extends { readonly kind: string; readonly to?: string }>(steps: readonly S[], self: string, here: string | undefined): S[] {
  return steps.map((st) => {
    if (st.kind !== 'chat' || st.to?.trim().toLowerCase() !== THIS_CHAT) return st;
    const ref = here ? `${self}/${here}` : undefined;
    if (!ref || !parseChatRef(ref)) throw new Error(NO_THIS_CHAT);
    return { ...st, to: ref };
  });
}
