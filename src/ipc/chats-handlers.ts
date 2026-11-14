import { resolveChatWhenKnown } from '../core/chat-links/resolve.js';
import { chatSnapshot, refOf } from '../core/chat-links/transcript.js';
import { parseChatRef } from '../shared/chat-ref.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `chats.*` method does (see chats-api.ts). */

type ChatsMethod = Extract<Method, `chats.${string}`>;
type ChatsHandlers = { readonly [M in ChatsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const CHATS_HANDLERS = {
  'chats.resolve': async (s, text) => (await resolveChatWhenKnown(s.store, text)) ?? null,
  'chats.snapshot': (s, text) => {
    // Its saved history first: the copy has what the chat has, not only what is on screen.
    const channel = parseChatRef(refOf(text))?.channel;
    if (channel?.startsWith('ws:')) s.workspaces?.ensureLoaded(channel.slice(3));
    return chatSnapshot(s.store.getState(), text) ?? null;
  },
} satisfies ChatsHandlers;
