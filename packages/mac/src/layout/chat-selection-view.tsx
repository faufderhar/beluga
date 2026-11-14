import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { triageFacts } from '@beluga/core/triage/facts.js';
import { categoryOf, settleRefusal, triageKey } from '@beluga/core/triage/model.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { type ActionItem } from '../components/SpecMenu.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { type PickedTriage, bulkTriage, chatBulkActions, chatCount, chatJoins, chatSelectionStore, joinValue, retainVisibleChats, visibleChatIds } from './chat-selection.js';
import { laterTimes } from './row-triage-actions.js';
import { toolbarActions } from './toolbar-actions.js';
import s from './Sidebar.module.css';

interface SidebarSelection {
  readonly ids: readonly string[];
  readonly busy: boolean;
  readonly click: (id: string, shift: boolean) => boolean;
  readonly items: () => readonly ActionItem[];
  readonly clear: () => void;
}

/** The picked chats' Regenerate Titles, in its messages: "Regenerate titles failed for…", "Regenerated titles of 3 chats." */
const REGENERATE = { label: 'Regenerate titles', done: 'Regenerated titles of' } as const;

/** The picked chats' triage actions, in their messages: "Settle failed for…", "Settled 3 chats." */
const TRIAGE = {
  later: { label: 'Remind Me Later', done: 'Will remind you about' },
  showAgain: { label: 'Show Again Now', done: 'Brought back' },
  settle: { label: 'Settle', done: 'Settled' },
  unsettle: { label: 'Un-settle', done: 'Un-settled' },
} as const;

const SelectionContext = createContext<SidebarSelection | undefined>(undefined);

/** One selection for project chats and chats without a project. It stays in this window. */
export function SidebarChatSelection({ children }: { children: ReactNode }) {
  const { client } = useBeluga();
  const root = useRef<HTMLDivElement>(null);
  const [store] = useState(chatSelectionStore);
  const { selection, busy } = useSyncExternalStore(store.subscribe, store.get);
  // Read the rendered rows so plan task chats and custom project ordering use the same order as the screen.
  const visible = useCallback((): string[] => visibleChatIds(Array.from(root.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? [], (row) => ({
    id: row.dataset.chatId!,
    folded: Boolean(row.closest('[data-chats-folded="true"]')),
  }))), []);
  // Selected rows that touch on screen become one box (Sidebar.module.css): each row says which sides go on.
  // Set on the rows themselves, so joining doesn't draw every row again.
  const join = useCallback((): void => {
    const rows = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? []);
    const chosen = new Set(store.get().selection.ids);
    // By the row, not the chat: the chat you're in can show twice (its category, and Projects).
    const joins = chatJoins(rows.flatMap((row, at) => {
      if (!chosen.has(row.dataset.chatId!)) return [];
      const box = row.getBoundingClientRect();
      return [{ id: String(at), top: box.top, bottom: box.bottom }];
    }));
    for (const [at, row] of rows.entries()) {
      const value = joinValue(joins.get(String(at)));
      if ((row.dataset.chatJoin ?? '') === value) continue;
      if (value) row.dataset.chatJoin = value;
      else delete row.dataset.chatJoin;
    }
  }, [store]);
  useLayoutEffect(join, [selection.ids, join]);
  useEffect(() => {
    const click = (event: MouseEvent): void => {
      const target = event.target;
      // Menu and alert clicks belong to the batch that opened them.
      if (target instanceof Element && target.closest('[role="menu"], [role="alertdialog"]')) return;
      if (!event.shiftKey) store.clear();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.clear();
    };
    const observer = new MutationObserver(() => {
      store.retain(visible());
      join();
    });
    if (root.current) observer.observe(root.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-id', 'data-chats-folded'] });
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [store, visible, join]);

  const items = useCallback((): readonly ActionItem[] => {
    const current = retainVisibleChats(store.get().selection, visible());
    const state = client.store.getState();
    const chats = current.ids.flatMap((id) => state.projects.flatMap((p) => p.workspaces).filter((w) => w.id === id && w.kind === 'chat' && !w.archived && !w.pending));
    const count = chats.length;
    // `targets`: the picked chats the action goes to (all of them, or those a triage action applies to).
    const run = async (what: { readonly label: string; readonly done: string }, apply: (chat: Workspace) => Promise<boolean>, targets: readonly Workspace[] = chats): Promise<void> => {
      const total = targets.length;
      const result = await store.run(targets, async (chat) => {
        // A chat can become a worktree while the confirmation is open.
        const latest = client.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === chat.id);
        if (!latest || latest.kind !== 'chat' || latest.archived || latest.pending) throw new Error('This chat is no longer available.');
        return apply(chat);
      });
      if (!result) return;
      store.retain(visible());
      if (result.failed.length) {
        const message = result.failed.map((chat) => `${chat.name}: ${chat.reason}`).join('\n');
        toast(client, `${what.label} failed for ${result.failed.length} of ${chatCount(total)}. ${message}`, 'error');
        openSheet({ kind: 'confirm', title: `${chatCount(result.failed.length)} failed`, message, confirm: 'OK', run: () => undefined });
      } else toast(client, `${what.done} ${chatCount(total)}.`, 'success');
    };
    const remove = async (action: (typeof chatBulkActions)[number], chat: Workspace): Promise<boolean> => {
      // Quiet: one message for the whole batch, not one per chat.
      if (action.id === 'archive') return await client.api.workspaces.archive(chat.id, false, { quiet: true }) === true;
      await client.api.workspaces.remove(chat.id, { quiet: true });
      // Remove returns no result, including when the daemon reports a failure. Check its published state.
      return !client.store.getState().projects.some((p) => p.workspaces.some((w) => w.id === chat.id));
    };
    // As on one chat's menu: nothing to confirm, a name is easy to change again.
    const regenerate: ActionItem = {
      label: `Regenerate ${chatCount(count, 'Title')}`,
      icon: 'refresh',
      disabled: store.get().busy || count === 0,
      onSelect: () => void run(REGENERATE, async (chat) => (await client.api.workspaces.regenerateTitle(chat.id), true)),
    };
    // The row's Remind Me Later, Show Again Now, Settle and Un-settle, each for the picked chats it applies to.
    const busy = store.get().busy;
    const triage = bulkTriage(chats.map((chat) => pickedTriage(state, chat)), state.prefs.chatCategories);
    const to = (channels: readonly string[]): Workspace[] => chats.filter((chat) => channels.includes(`ws:${chat.id}`));
    const triageItem = (label: (chats: string) => string, icon: ActionItem['icon'], channels: readonly string[], what: (typeof TRIAGE)[keyof typeof TRIAGE], call: (channel: string) => Promise<unknown>): ActionItem[] =>
      channels.length ? [{ label: label(chatCount(channels.length, 'Chat')), icon, disabled: busy, onSelect: () => void run(what, async (chat) => (await call(`ws:${chat.id}`), true), to(channels)) }] : [];
    const triageItems: ActionItem[] = [
      ...(triage.later.length
        ? [{ label: `Remind Me Later About ${chatCount(triage.later.length, 'Chat')}`, icon: 'clock' as const, disabled: busy, submenu: laterTimes((until) => void run(TRIAGE.later, async (chat) => (await client.api.triage.snooze(`ws:${chat.id}`, until), true), to(triage.later))), onSelect: () => undefined }]
        : []),
      ...triageItem((n) => `Show ${n} Again Now`, 'eye', triage.showAgain, TRIAGE.showAgain, (channel) => client.api.triage.wake(channel)),
      ...triageItem((n) => `Settle ${n}`, 'check', triage.settle, TRIAGE.settle, (channel) => client.api.triage.settle(channel)),
      ...triageItem((n) => `Un-settle ${n}`, 'inbox', triage.unsettle, TRIAGE.unsettle, (channel) => client.api.triage.unsettle(channel)),
    ].map((item, i) => (i === 0 ? { ...item, separate: true } : item));
    return [regenerate, ...triageItems, ...chatBulkActions.map((action) => ({
      label: `${action.label} ${chatCount(count, 'Chat')}…`,
      icon: action.icon,
      danger: true,
      disabled: store.get().busy || count === 0 || chats.some((chat: Workspace) => {
        const menu = toolbarActions(state, chat);
        return ![...(menu.primary ? [menu.primary] : []), ...menu.icons, ...menu.more.flat()].some((item) => item.action === action.id && !item.disabled);
      }),
      onSelect: () => openSheet({
        kind: 'confirm',
        title: `${action.label} ${chatCount(count)}?`,
        message: action.message,
        confirm: `${action.label} ${chatCount(count, 'Chat')}`,
        destructive: action.id === 'delete',
        run: () => void run(action, (chat) => remove(action, chat)),
      }),
    }))];
  }, [client, store, visible]);

  const click = useCallback((id: string, shift: boolean): boolean => {
    const order = visible();
    if (!order.includes(id)) return false;
    store.click(order, id, shift);
    return shift;
  }, [store, visible]);

  // Every chat row reads this: a new value only when what they show changes (KLD-48).
  const value = useMemo<SidebarSelection>(() => ({ ids: selection.ids, busy, clear: store.clear, items, click }), [selection.ids, busy, store, items, click]);
  return (
    <SelectionContext.Provider value={value}>
      <div ref={root} style={{ display: 'contents' }}>{children}</div>
    </SelectionContext.Provider>
  );
}

/** A picked chat's category, and why Settle refuses it, as its own menu reads them. */
function pickedTriage(state: AppState, chat: Workspace): PickedTriage {
  const channel = `ws:${chat.id}`;
  const key = triageKey(state, channel) ?? channel;
  const record = state.triage[key];
  const facts = triageFacts(state, key);
  const refusal = settleRefusal(record, facts, 'you');
  return { channel, category: categoryOf(record, facts), ...(refusal ? { refusal } : {}) };
}

export const useChatSelection = (): SidebarSelection | undefined => useContext(SelectionContext);

export function ChatSelectionCount() {
  const selection = useChatSelection();
  const count = selection?.ids.length ?? 0;
  // The last count stays while the bar folds away.
  const [shown, setShown] = useState(count);
  if (count && count !== shown) setShown(count);
  if (!selection) return null;
  return (
    <div className={s.chatSelection} data-open={count > 0} role="status" aria-live="polite" aria-hidden={!count}>
      <div className={s.chatSelectionFold}>
        <div className={s.chatSelectionBar}>
          <span>{chatCount(shown)} selected{selection.busy ? ' · Working…' : ''}</span>
          <button type="button" onClick={selection.clear} disabled={selection.busy || !count} tabIndex={count ? 0 : -1} aria-label="Clear chat selection">Clear</button>
        </div>
      </div>
    </div>
  );
}
