import { FIRST_CHAT, assistantChatOf, assistantChatTitle } from '../../shared/assistant.js';
import { type ChatRef, formatChatRef, parseChatRef } from '../../shared/chat-ref.js';
import { FIRST_SENTINEL_CHAT, sentinelChatOf, sentinelChatTitle } from '../sentinel/model.js';
import { type DomainState, type View, busyChannels } from '../store.js';

/**
 * What a chat's address (shared/chat-ref.ts) is now. It reads the records, not what the sidebar
 * lists, so an archived or a settled chat is still found, with its current title.
 */

export interface ResolvedChat {
  readonly ref: ChatRef;
  /** Its current title. Unset when it's gone, or not yours to read. */
  readonly title?: string;
  readonly kind: 'worktree' | 'chat' | 'assistant' | 'sentinel';
  /**
   * 'removed' also for a chat you can't see: nothing here to open. `ownership` tells the two apart.
   * 'loading': a workspace of yours not found before the first scan of the projects is done.
   */
  readonly state: 'idle' | 'working' | 'archived' | 'removed' | 'loading';
  /** 'unknown': someone else's chat that isn't shared with you. */
  readonly ownership: 'own' | 'shared' | 'unknown';
  /** Where to go to open it. Unset when there is nowhere to go. */
  readonly view?: View;
}

type Found = Pick<ResolvedChat, 'title' | 'kind' | 'view'> & { readonly archived?: boolean; readonly channel?: string };

const WS = 'ws:';
const FIRST_SCAN_WAIT_MS = 60_000;

export function resolveChat(state: DomainState, ref: ChatRef): ResolvedChat {
  const ownership = ownershipOf(state, ref);
  if (ownership === 'unknown') return { ref, kind: kindOf(ref.channel), state: 'removed', ownership };
  const found = ownership === 'shared' ? sharedChat(state, ref) : ownChat(state, ref.channel);
  if (!found) return { ref, kind: kindOf(ref.channel), state: ownership === 'own' && ref.channel.startsWith(WS) && !state.projectsLoaded ? 'loading' : 'removed', ownership };
  const { archived, channel, ...chat } = found;
  return { ref, ...chat, state: archived ? 'archived' : busyChannels(state.log).has(channel ?? ref.channel) ? 'working' : 'idle', ownership };
}

/**
 * chats.resolve: the same for a ref as text. Answers nothing for a malformed ref, so its chip
 * stays plain text and its link does nothing.
 */
export function resolveChatText(state: DomainState, text: string): ResolvedChat | undefined {
  const ref = parseChatRef(text);
  return ref && resolveChat(state, ref);
}

/**
 * chats.resolve: the answer once it's known. A link can start the app, and the daemon with it, so
 * the first scan of the projects may still run. Past `waitMs`, it answers that it's still loading.
 */
export function resolveChatWhenKnown(store: { getState(): DomainState; subscribe(listener: () => void): () => void }, text: string, waitMs = FIRST_SCAN_WAIT_MS): Promise<ResolvedChat | undefined> {
  const answer = (): ResolvedChat | undefined => resolveChatText(store.getState(), text);
  if (answer()?.state !== 'loading') return Promise.resolve(answer());
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stop();
      resolve(answer());
    };
    const timer = setTimeout(finish, waitMs);
    const stop = store.subscribe(() => {
      if (answer()?.state !== 'loading') finish();
    });
  });
}

/** Every chat here that has an address: your own (not a main folder) and the ones shared with you. */
export function addressableChats(state: DomainState): Array<{ ref: string; owner: string; channel: string; createdAt?: number }> {
  const all: Array<{ owner: string; channel: string; createdAt?: number }> = [
    ...state.projects.flatMap((p) => p.workspaces.filter((w) => w.kind !== 'main').map((w) => ({ owner: state.selfId, channel: `${WS}${w.id}`, createdAt: w.createdAt }))),
    ...state.assistant.chats.map((c) => ({ owner: state.selfId, channel: c.channel })),
    ...(state.sentinel.chats?.chats ?? []).map((c) => ({ owner: state.selfId, channel: c.channel })),
    ...state.shared.map((w) => ({ owner: w.owner, channel: `${WS}${w.id}` })),
  ];
  return all.flatMap((c) => {
    const ref = formatChatRef(c);
    return ref ? [{ ...c, ref }] : [];
  });
}

/** What "@" offers to name in the chat `here`: your chats and the shared ones, not `here` itself and none that's gone or archived. */
export function chatsToMention(state: DomainState, here: string): Array<{ readonly title: string; readonly ref: string; readonly kind: ResolvedChat['kind']; readonly ownership: ResolvedChat['ownership'] }> {
  return addressableChats(state).flatMap((c) => {
    if (c.owner === state.selfId && c.channel === here) return [];
    const chat = resolveChat(state, { owner: c.owner, channel: c.channel });
    if (!chat.title || chat.state === 'archived' || chat.state === 'removed') return [];
    return [{ title: chat.title, ref: c.ref, kind: chat.kind, ownership: chat.ownership }];
  });
}

function ownershipOf(state: DomainState, ref: ChatRef): ResolvedChat['ownership'] {
  if (ref.owner === state.selfId) return 'own';
  return sharedChat(state, ref) ? 'shared' : 'unknown';
}

function sharedChat(state: DomainState, ref: ChatRef): Found | undefined {
  if (!ref.channel.startsWith(WS)) return undefined;
  const id = ref.channel.slice(WS.length);
  const w = state.shared.find((s) => s.owner === ref.owner && s.id === id);
  return w && { title: w.name, kind: 'worktree', view: { kind: 'shared', owner: w.owner, id: w.id, tab: 'chat' } };
}

function ownChat(state: DomainState, channel: string): Found | undefined {
  if (channel.startsWith(WS)) return ownWorkspace(state, channel.slice(WS.length));
  const assistant = assistantChatOf(channel);
  if (assistant) {
    const { chats } = state.assistant;
    if (!chats.some((c) => c.channel === channel) && (chats.length || assistant !== FIRST_CHAT)) return undefined;
    return { title: assistantChatTitle(channel, state.log, 60), kind: 'assistant', view: { kind: 'assistant', chat: assistant } };
  }
  const sentinel = sentinelChatOf(channel);
  if (sentinel) {
    const chats = state.sentinel.chats?.chats ?? [];
    if (!chats.some((c) => c.channel === channel) && (chats.length || sentinel !== FIRST_SENTINEL_CHAT)) return undefined;
    return { title: sentinelChatTitle(channel, state.log, 60), kind: 'sentinel', view: { kind: 'sentinel_chat', chat: sentinel } };
  }
  return undefined;
}

function ownWorkspace(state: DomainState, id: string): Found | undefined {
  for (const project of state.projects) {
    const w = project.workspaces.find((x) => x.id === id);
    if (!w) continue;
    // A main checkout is no conversation of its own: its chat if it moved to one, or the project's home.
    if (w.kind === 'main') return (w.movedTo && ownWorkspace(state, w.movedTo)) || { title: w.name, kind: 'chat', view: { kind: 'project', id: project.id } };
    return { title: w.name, kind: w.kind === 'chat' ? 'chat' : 'worktree', view: { kind: 'workspace', id: w.id, tab: 'chat' }, channel: `${WS}${w.id}`, ...(w.archived ? { archived: true } : {}) };
  }
  return undefined;
}

const kindOf = (channel: string): ResolvedChat['kind'] => (assistantChatOf(channel) ? 'assistant' : sentinelChatOf(channel) ? 'sentinel' : 'worktree');
