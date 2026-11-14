import { describe, expect, it, vi } from 'vitest';
import { bulkTriage, chatCount, chatJoins, chatSelectionStore, joinValue, clearChatSelection, clickChat, emptyChatSelection, retainVisibleChats, runChatBatch, visibleChatIds } from '../packages/mac/src/layout/chat-selection.js';

describe('sidebar chat selection', () => {
  it('selects downward in visible sidebar order', () => {
    const order = ['a', 'b', 'c', 'd'];
    const clicked = clickChat(emptyChatSelection, order, 'b', false);
    expect(clicked.ids).toEqual([]);
    expect(clickChat(clicked, order, 'd', true).ids).toEqual(['b', 'c', 'd']);
  });

  it('selects upward and keeps the anchor when the range changes', () => {
    const order = ['a', 'b', 'c', 'd'];
    const clicked = clickChat(emptyChatSelection, order, 'd', false);
    const range = clickChat(clicked, order, 'b', true);
    expect(range.ids).toEqual(['b', 'c', 'd']);
    expect(clickChat(range, order, 'c', true).ids).toEqual(['c', 'd']);
  });

  it('clears on a plain click and starts a new anchor', () => {
    const range = { anchor: 'a', ids: ['a', 'b', 'c'] };
    expect(clickChat(range, ['a', 'b', 'c'], 'b', false)).toEqual({ anchor: 'b', ids: [] });
    expect(emptyChatSelection).toEqual({ ids: [] });
  });

  it('a click elsewhere clears the chats but keeps the anchor for the next Shift+click', () => {
    const order = ['a', 'b', 'c', 'd'];
    const range = clickChat(clickChat(emptyChatSelection, order, 'a', false), order, 'b', true);
    const cleared = clearChatSelection(range);
    expect(cleared).toEqual({ anchor: 'a', ids: [] });
    expect(clickChat(cleared, order, 'd', true).ids).toEqual(['a', 'b', 'c', 'd']);
    // Nothing selected: the same selection, so the rows don't draw again.
    expect(clearChatSelection(cleared)).toBe(cleared);
    expect(clickChat(cleared, order, 'c', false).ids).toBe(emptyChatSelection.ids);
  });

  it('counts one chat and many chats', () => {
    expect(chatCount(1)).toBe('1 chat');
    expect(chatCount(3)).toBe('3 chats');
    expect(chatCount(1, 'Chat')).toBe('1 Chat');
    expect(chatCount(0, 'Chat')).toBe('0 Chats');
  });

  it('excludes chats in folded projects and groups in both directions', () => {
    const order = visibleChatIds([
      { id: 'a' },
      { id: 'folded-project', folded: true },
      { id: 'b' },
      { id: 'folded-group', folded: true },
      { id: 'c' },
    ]);
    expect(clickChat({ anchor: 'a', ids: [] }, order, 'c', true).ids).toEqual(['a', 'b', 'c']);
    expect(clickChat({ anchor: 'c', ids: [] }, order, 'a', true).ids).toEqual(['a', 'b', 'c']);
    expect(clickChat({ anchor: 'a', ids: [] }, order, 'folded-project', true)).toEqual(emptyChatSelection);
  });

  it('counts a chat drawn twice once, where it first shows (its category, then Projects)', () => {
    const order = visibleChatIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'b' }]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(clickChat({ anchor: 'a', ids: [] }, order, 'c', true).ids).toEqual(['a', 'b', 'c']);
  });

  it('removes folded or deleted chats from an existing selection and its anchor', () => {
    expect(retainVisibleChats({ anchor: 'a', ids: ['a', 'b', 'c'] }, ['b', 'c'])).toEqual({ ids: ['b', 'c'] });
    expect(clickChat({ anchor: 'gone', ids: [] }, ['a', 'b'], 'b', true)).toEqual({ anchor: 'b', ids: ['b'] });
    expect(clickChat(emptyChatSelection, ['a', 'b'], 'a', true)).toEqual({ anchor: 'a', ids: ['a'] });
  });
});

describe('bulk chat actions', () => {
  it('continues after rejected and unsuccessful actions and names every failure', async () => {
    const called: string[] = [];
    const chats = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `Chat ${id}` }));
    const result = await runChatBatch(chats, async (chat) => {
      called.push(chat.id);
      if (chat.id === 'b') throw new Error('Permission denied');
      return chat.id !== 'c';
    });
    expect(called).toEqual(['a', 'b', 'c', 'd']);
    expect(result.succeeded).toEqual(['a', 'd']);
    expect(result.failed).toEqual([
      { id: 'b', name: 'Chat b', reason: 'Permission denied' },
      { id: 'c', name: 'Chat c', reason: 'The action did not complete.' },
    ]);
  });
});

describe('the sidebar selection during a batch', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  const chats = (ids: readonly string[]) => ids.map((id) => ({ id, name: `Chat ${id}` }));

  it('keeps the batch selected while it runs, follows the anchor, and leaves the failed chats selected', async () => {
    const store = chatSelectionStore();
    store.click(order, 'a', false);
    store.click(order, 'c', true);
    expect(store.get().selection.ids).toEqual(['a', 'b', 'c']);

    const answers = new Map<string, (ok: boolean) => void>();
    const running = store.run(chats(store.get().selection.ids), (chat) => new Promise<boolean>((resolve) => answers.set(chat.id, resolve)));
    expect(store.get().busy).toBe(true);

    // A new range, a click elsewhere and Escape all wait: the batch's chats stay the selection.
    store.click(order, 'e', false);
    store.click(order, 'f', true);
    store.clear();
    expect(store.get().selection).toEqual({ anchor: 'e', ids: ['a', 'b', 'c'] });
    // A second batch can't start over the first.
    expect(await store.run(chats(['d']), async () => true)).toBeUndefined();

    // One chat at a time: each answers once the batch has reached it.
    const answer = async (id: string, ok: boolean): Promise<void> => {
      await vi.waitFor(() => expect(answers.has(id)).toBe(true));
      answers.get(id)!(ok);
    };
    await answer('a', true);
    await answer('b', false);
    expect(store.get().busy).toBe(true);
    await answer('c', true);
    const result = await running;

    expect(result?.failed.map((chat) => chat.id)).toEqual(['b']);
    expect(store.get()).toEqual({ busy: false, selection: { anchor: 'e', ids: ['b'] } });
    // After it, the anchor the user clicked during the batch starts the next range.
    store.click(order, 'f', true);
    expect(store.get().selection.ids).toEqual(['e', 'f']);
  });

  it('tells listeners only when something changed', () => {
    const store = chatSelectionStore();
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.clear();
    store.retain(order);
    expect(calls).toBe(0);
    store.click(order, 'a', false);
    store.click(order, 'b', true);
    expect(calls).toBe(2);
    store.retain(['b']);
    expect(store.get().selection).toEqual({ ids: ['b'] });
    stop();
    store.clear();
    expect(calls).toBe(3);
  });
});

describe('selected rows as one box', () => {
  it('joins rows that touch on screen and leaves a row with a gap above it on its own', () => {
    const joins = chatJoins([
      { id: 'a', top: 0, bottom: 28 },
      { id: 'b', top: 28, bottom: 56 },
      { id: 'c', top: 56, bottom: 84 },
      // A worktree row sits between c and d.
      { id: 'd', top: 112, bottom: 140 },
    ]);
    expect(['a', 'b', 'c', 'd'].map((id) => joinValue(joins.get(id)))).toEqual(['down', 'up down', 'up', '']);
  });

  it('ignores sub-pixel rounding and the order rows come in', () => {
    const joins = chatJoins([
      { id: 'low', top: 28.5, bottom: 56.5 },
      { id: 'high', top: 0, bottom: 28 },
    ]);
    expect(joinValue(joins.get('high'))).toBe('down');
    expect(joinValue(joins.get('low'))).toBe('up');
    expect(joinValue(undefined)).toBe('');
  });

  describe('bulk triage of picked chats', () => {
    const picked = [
      { channel: 'ws:inbox', category: 'active' as const },
      { channel: 'ws:busy', category: 'working' as const },
      { channel: 'ws:asks', category: 'active' as const, refusal: 'It waits on you' },
      { channel: 'ws:later', category: 'snoozed' as const },
      { channel: 'ws:done', category: 'settled' as const },
    ];

    it('sends each action only to the chats it applies to', () => {
      expect(bulkTriage(picked, true)).toEqual({
        later: ['ws:inbox', 'ws:busy', 'ws:asks', 'ws:done'],
        showAgain: ['ws:later'],
        settle: ['ws:inbox', 'ws:busy', 'ws:later'],
        unsettle: ['ws:done'],
      });
    });

    it('offers only Remind Me Later and Show Again Now with the categories off', () => {
      expect(bulkTriage(picked, false)).toEqual({ later: ['ws:inbox', 'ws:busy', 'ws:asks', 'ws:done'], showAgain: ['ws:later'], settle: [], unsettle: [] });
    });
  });
});
