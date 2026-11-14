import type { ChatCategory } from '../../../../src/core/triage/model.js';

export interface ChatSelection {
  readonly anchor?: string;
  readonly ids: readonly string[];
}

export interface ChatRow {
  readonly id: string;
  readonly folded?: boolean;
}

export interface BatchChat {
  readonly id: string;
  readonly name: string;
}

export interface ChatBatchResult {
  readonly succeeded: readonly string[];
  readonly failed: ReadonlyArray<BatchChat & { readonly reason: string }>;
}

export const emptyChatSelection: ChatSelection = { ids: [] };

/** Actions that apply independently to many chats. Each asks once for the whole batch. */
export const chatBulkActions = [
  { id: 'archive', label: 'Archive', done: 'Archived', icon: 'archive', message: 'Archive these chats. Their conversations stay available in Archived.' },
  { id: 'delete', label: 'Delete', done: 'Deleted', icon: 'x', message: 'Permanently delete these chats and their conversations. You cannot undo this action.' },
] as const;

/** A picked chat's place in the categories, and why Settle refuses it (a hand is up). */
export interface PickedTriage {
  readonly channel: string;
  readonly category: ChatCategory;
  readonly refusal?: string;
}

/** The channels each triage action of the picked chats goes to: an empty list hides the action. */
export interface BulkTriage {
  readonly later: readonly string[];
  readonly showAgain: readonly string[];
  readonly settle: readonly string[];
  readonly unsettle: readonly string[];
}

/** One chat's triage menu, for many: each action goes to the chats it applies to. With the categories off, only Remind Me Later and Show Again Now. */
export function bulkTriage(picked: readonly PickedTriage[], categories: boolean): BulkTriage {
  const where = (test: (p: PickedTriage) => boolean): string[] => picked.filter(test).map((p) => p.channel);
  return {
    later: where((p) => p.category !== 'snoozed'),
    showAgain: where((p) => p.category === 'snoozed'),
    settle: categories ? where((p) => p.category !== 'settled' && !p.refusal) : [],
    unsettle: categories ? where((p) => p.category === 'settled') : [],
  };
}

/** "1 chat", "3 chats"; `word` "Chat" for menu titles. */
export const chatCount = (n: number, word = 'chat'): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const selectionOf = (anchor: string | undefined, ids: readonly string[]): ChatSelection => (anchor === undefined ? { ids } : { anchor, ids });

/** Only shift-click starts a selection. The anchor stays at the last plain click. */
export function clickChat(selection: ChatSelection, visible: readonly string[], id: string, shift: boolean): ChatSelection {
  const end = visible.indexOf(id);
  if (end < 0) return emptyChatSelection;
  // The same empty list each time, so a plain click doesn't draw every row again.
  if (!shift) return { anchor: id, ids: emptyChatSelection.ids };
  const start = selection.anchor === undefined ? -1 : visible.indexOf(selection.anchor);
  if (start < 0) return { anchor: id, ids: [id] };
  return { anchor: selection.anchor, ids: visible.slice(Math.min(start, end), Math.max(start, end) + 1) };
}

/** A click elsewhere or Escape: no chats selected, but the next Shift+click still starts from the last clicked chat. */
export function clearChatSelection(selection: ChatSelection): ChatSelection {
  return selection.ids.length ? selectionOf(selection.anchor, emptyChatSelection.ids) : selection;
}

export interface RowBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

export interface ChatJoin {
  readonly up: boolean;
  readonly down: boolean;
}

/** Selected rows that touch on screen read as one box: which sides of each row the box goes on past. */
export function chatJoins(selected: readonly RowBox[]): ReadonlyMap<string, ChatJoin> {
  const touches = (above: RowBox, below: RowBox): boolean => above !== below && Math.abs(above.bottom - below.top) <= 1;
  return new Map(selected.map((box) => [box.id, { up: selected.some((other) => touches(other, box)), down: selected.some((other) => touches(box, other)) }]));
}

/** The row's `data-chat-join`: "up", "down", "up down", or nothing. */
export const joinValue = (join: ChatJoin | undefined): string => [join?.up && 'up', join?.down && 'down'].filter(Boolean).join(' ');

/** The chats in screen order. One drawn twice (its category, and Projects for the one you're in) counts where it first shows. */
export function visibleChatIds(rows: readonly ChatRow[]): string[] {
  return [...new Set(rows.filter((row) => !row.folded).map((row) => row.id))];
}

export function retainVisibleChats(selection: ChatSelection, visible: readonly string[]): ChatSelection {
  const ids = selection.ids.filter((id) => visible.includes(id));
  const anchor = selection.anchor !== undefined && visible.includes(selection.anchor) ? selection.anchor : undefined;
  if (ids.length === selection.ids.length && anchor === selection.anchor) return selection;
  return selectionOf(anchor, ids);
}

/** Attempt every chat, including after a rejection or an unsuccessful API result. */
export async function runChatBatch<T extends BatchChat>(chats: readonly T[], apply: (chat: T) => Promise<boolean>): Promise<ChatBatchResult> {
  const succeeded: string[] = [];
  const failed: Array<BatchChat & { readonly reason: string }> = [];
  for (const chat of chats) {
    try {
      if (await apply(chat)) succeeded.push(chat.id);
      else failed.push({ id: chat.id, name: chat.name, reason: 'The action did not complete.' });
    } catch (error) {
      failed.push({ id: chat.id, name: chat.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
}

export interface ChatSelectionState {
  readonly selection: ChatSelection;
  readonly busy: boolean;
}

export interface ChatSelectionStore {
  readonly get: () => ChatSelectionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly click: (visible: readonly string[], id: string, shift: boolean) => void;
  readonly clear: () => void;
  readonly retain: (visible: readonly string[]) => void;
  /** → how it went; undefined when another batch is still running. */
  readonly run: <T extends BatchChat>(chats: readonly T[], apply: (chat: T) => Promise<boolean>) => Promise<ChatBatchResult | undefined>;
}

/** The sidebar's selection and its batch, outside React. */
export function chatSelectionStore(): ChatSelectionStore {
  let state: ChatSelectionState = { selection: emptyChatSelection, busy: false };
  const listeners = new Set<() => void>();
  const set = (next: ChatSelectionState): void => {
    if (next.selection === state.selection && next.busy === state.busy) return;
    state = next;
    for (const listener of listeners) listener();
  };
  // While a batch runs, its chats stay the selection: only the anchor follows clicks, for the next range.
  const edit = (next: ChatSelection): void => {
    const current = state.selection;
    if (!state.busy) set({ ...state, selection: next });
    else if (next.anchor !== current.anchor) set({ ...state, selection: selectionOf(next.anchor, current.ids) });
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    click: (visible, id, shift) => edit(clickChat(state.selection, visible, id, shift)),
    clear: () => edit(clearChatSelection(state.selection)),
    retain: (visible) => set({ ...state, selection: retainVisibleChats(state.selection, visible) }),
    run: async (chats, apply) => {
      if (state.busy) return undefined;
      set({ ...state, busy: true });
      let failed: readonly string[] = state.selection.ids;
      try {
        const result = await runChatBatch(chats, apply);
        failed = result.failed.map((chat) => chat.id);
        return result;
      } finally {
        // The chats that failed stay selected, to look at or try again.
        set({ busy: false, selection: selectionOf(state.selection.anchor, failed) });
      }
    },
  };
}
