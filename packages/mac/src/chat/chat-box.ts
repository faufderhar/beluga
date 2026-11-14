import { addressableChats, resolveChat } from '../../../../src/core/chat-links/resolve.js';
import type { DomainState } from '../../../../src/core/store.js';
import { chatMention, chatMentionsIn, parseChatRef } from '../../../../src/shared/chat-ref.js';
import { boxLabel, plainWorktrees, worktreeNamesOf } from './worktree-box.js';

/**
 * A chat's mention in the message box, written short as a worktree's link is (worktree-box.ts):
 * "[@\u2007Title]", its title in brackets after an @ and a figure space. The chip is drawn over the
 * room those characters take, so the box shows the title only, never the ref. Out it goes as
 * "@Title (chat: <ref>)" again, so the agent still gets the ref. The box keeps which chat each title
 * is; a box from before a restart finds it by its title. Pure, but for the memory of what was put.
 */

const GAP = '\u2007';

/** "[@\u2007Title]": not a worktree's ("[\u2007name]") or an image's ("[1\u2007name]"). */
const CHAT_BOX = /\[@\u2007([^\]\n\u2007]{1,80})\]/g;

/** The chat a short mention's title is, as its ref; undefined when it names none. */
export type ChatRefOf = (label: string) => string | undefined;

/** A short mention in the words: where it is, and the chat it is. */
export interface BoxedChat {
  readonly start: number;
  readonly end: number;
  readonly ref: string;
  readonly label: string;
}

/** A chat's title as the box writes it. */
export const chatBox = (title: string): string => `[@${GAP}${boxLabel(title)}]`;

/** Words with each chat mention written short; `put` learns which chat each title is. */
export function toChatBox(text: string, put: (label: string, ref: string) => void): string {
  let out = '';
  let at = 0;
  for (const c of chatMentionsIn(text)) {
    const label = boxLabel(c.title);
    if (!label) continue;
    put(label, c.ref);
    out += text.slice(at, c.start) + chatBox(label);
    at = c.end;
  }
  return out + text.slice(at);
}

export function boxedChats(text: string, refOf: ChatRefOf): BoxedChat[] {
  if (!text.includes(GAP)) return [];
  return [...text.matchAll(CHAT_BOX)].flatMap((m) => {
    const ref = refOf(m[1]!);
    return ref ? [{ start: m.index, end: m.index + m[0].length, ref, label: m[1]! }] : [];
  });
}

/** The words as they go out: every short mention back to "@Title (chat: <ref>)". */
export function plainChats(text: string, refOf: ChatRefOf): string {
  let out = '';
  let at = 0;
  for (const c of boxedChats(text, refOf)) {
    const ref = parseChatRef(c.ref);
    const words = ref && chatMention(c.label, ref);
    if (!words) continue;
    out += text.slice(at, c.start) + words;
    at = c.end;
  }
  return out + text.slice(at);
}

/** The chat last written under a title in a box, for two with the same title. */
const lastPut = new Map<string, string>();

/** Words for the box: each chat mention written short, remembered. */
export const boxChats = (text: string): string => (text.includes('(chat: ') ? toChatBox(text, (label, ref) => lastPut.set(label, ref)) : text);

/** Which chat a title in the box is: the one last put there under it, else one with that title now. */
export function chatRefOf(state: DomainState): ChatRefOf {
  return (label) => {
    const last = lastPut.get(label);
    if (last) return last;
    for (const c of addressableChats(state)) {
      const title = resolveChat(state, { owner: c.owner, channel: c.channel }).title;
      if (title && boxLabel(title) === label) return c.ref;
    }
    return undefined;
  };
}

/** The words of a box as they go out: worktrees' and chats' short forms whole again. */
export const plainWords = (text: string, state: DomainState): string => plainChats(plainWorktrees(text, worktreeNamesOf(state.projects)), chatRefOf(state));
