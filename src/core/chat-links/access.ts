import { isAddressableChannel, parseChatRef } from '../../shared/chat-ref.js';
import type { WsRole } from '../../protocol.js';
import type { DomainState } from '../store.js';
import { type ResolvedChat, resolveChat } from './resolve.js';

/**
 * Who may read or send to a chat, for an agent's run. The one place that decides it: pure, no I/O.
 * Trust is no input: full trust lets a friend run commands on this computer, and that stays
 * as it is, but it gives no way to a chat through these rules.
 */

export type ChatAction = 'read' | 'send';

/**
 * Why a run may not. `not_found` is the answer for a chat that is not shared with you and for a
 * chat that does not exist: the answer must not tell the two apart.
 */
export type ChatRefusal = 'requester_refused' | 'not_addressable' | 'not_found' | 'view_only';

export type ChatAccess =
  | {
      readonly allow: true;
      /** 'local': this computer holds the chat. 'mirror': only what the local copy of a shared chat already has. */
      readonly source: 'local' | 'mirror';
      /** A send into a shared chat: the owner's own trust check decides next, on the owner's computer. */
      readonly ownerDecides?: true;
    }
  | { readonly allow: false; readonly code: ChatRefusal };

export interface ChatAccessInput {
  /** This computer's peer id. */
  readonly self: string;
  /** Who asked for the run. This is the person, never the agent that does the work. */
  readonly requester: string;
  readonly channel: string;
  /** 'unknown': someone else's chat that is not shared with you. */
  readonly ownership: ResolvedChat['ownership'];
  readonly exists: boolean;
  /** Your role in a shared chat. */
  readonly role?: WsRole;
  readonly action: ChatAction;
}

export function chatAccess(input: ChatAccessInput): ChatAccess {
  // First, so that a run from someone else learns nothing about which chats exist.
  if (input.requester !== input.self) return { allow: false, code: 'requester_refused' };
  if (!isAddressableChannel(input.channel)) return { allow: false, code: 'not_addressable' };
  if (input.ownership === 'unknown' || !input.exists) return { allow: false, code: 'not_found' };
  if (input.ownership === 'own') return { allow: true, source: 'local' };
  if (input.action === 'read') return { allow: true, source: 'mirror' };
  return input.role === 'contribute' ? { allow: true, source: 'mirror', ownerDecides: true } : { allow: false, code: 'view_only' };
}

/**
 * A send from another person's agent, decided on this computer, the owner's. `role` is theirs in the
 * chat (unset: not shared with them). Trust is no input here either: it decides after these rules,
 * and it never opens a chat that is not shared.
 */
export function peerSendAccess(input: { readonly channel: string; readonly exists: boolean; readonly role?: WsRole }): { readonly allow: true } | { readonly allow: false; readonly code: 'not_found' | 'view_only' } {
  if (!isAddressableChannel(input.channel) || !input.exists || !input.role) return { allow: false, code: 'not_found' };
  return input.role === 'contribute' ? { allow: true } : { allow: false, code: 'view_only' };
}

/** The same for a ref as text, with the facts from the state. Text that is no ref has no address. */
export function chatAccessOf(state: DomainState, ask: { readonly requester: string; readonly ref: string; readonly action: ChatAction }): ChatAccess {
  const ref = parseChatRef(ask.ref);
  const base = { self: state.selfId, requester: ask.requester, action: ask.action };
  if (!ref) return chatAccess({ ...base, channel: '', ownership: 'unknown', exists: false });
  const chat = resolveChat(state, ref);
  const role = chat.ownership === 'shared' ? state.shared.find((w) => w.owner === ref.owner && `ws:${w.id}` === ref.channel)?.role : undefined;
  return chatAccess({ ...base, channel: ref.channel, ownership: chat.ownership, exists: chat.state !== 'removed' && chat.state !== 'loading', ...(role ? { role } : {}) });
}
