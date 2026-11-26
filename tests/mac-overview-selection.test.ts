import { describe, expect, it } from 'vitest';
import type { Project, Workspace } from '../src/workspaces/types.js';
import type { OverviewItem } from '../packages/mac/src/views/overview/overview-model.js';
import {
  NO_PICK,
  deleteWords,
  keepShown,
  needsUnpushedCheck,
  pickAll,
  pickable,
  pickedWords,
  rangePick,
  togglePick,
  unpushedLosses,
} from '../packages/mac/src/views/overview/overview-selection.js';

/** Picking several Overview rows and deleting them at once (packages/mac/src/views/overview/overview-selection.ts). */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const project: Project = { id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces: [] };
const item = (over: Partial<Workspace>, extra: Partial<OverviewItem> = {}): OverviewItem => {
  const w = ws(over);
  return { ws: w, project, archived: w.archived === true, needs: false, ready: false, when: 1, rank: 4, ...extra };
};

const order = ['a', 'b', 'c', 'd', 'e'];
const all = new Set(order);

describe('Mac Overview selection: picking rows', () => {
  it('⌘-click adds a row, and takes it away again', () => {
    const one = togglePick(NO_PICK, order, all, 'c');
    expect(one).toEqual({ anchor: 'c', ids: ['c'] });
    const two = togglePick(one, order, all, 'a');
    expect(two.ids).toEqual(['a', 'c']);
    expect(togglePick(two, order, all, 'c')).toEqual({ anchor: 'c', ids: ['a'] });
  });

  it('Shift-click picks every row from the last one clicked, keeping what was picked', () => {
    const start = togglePick(NO_PICK, order, all, 'b');
    expect(rangePick(start, order, all, 'd')).toEqual({ anchor: 'b', ids: ['b', 'c', 'd'] });
    // Upwards too.
    expect(rangePick(togglePick(NO_PICK, order, all, 'd'), order, all, 'a').ids).toEqual(['a', 'b', 'c', 'd']);
    // A ⌘-picked row elsewhere stays.
    const mixed = togglePick(togglePick(NO_PICK, order, all, 'e'), order, all, 'a');
    expect(rangePick(mixed, order, all, 'b').ids).toEqual(['a', 'b', 'e']);
  });

  it('Shift-click with nothing clicked yet starts from the focused row, else picks just that one', () => {
    expect(rangePick(NO_PICK, order, all, 'c', 'a').ids).toEqual(['a', 'b', 'c']);
    expect(rangePick(NO_PICK, order, all, 'c')).toEqual({ anchor: 'c', ids: ['c'] });
  });

  it('never picks a row that cannot be deleted, even inside a range', () => {
    const can = new Set(['a', 'b', 'd', 'e']);
    expect(rangePick(togglePick(NO_PICK, order, can, 'a'), order, can, 'e').ids).toEqual(['a', 'b', 'd', 'e']);
    expect(togglePick(NO_PICK, order, can, 'c')).toEqual({ anchor: 'c', ids: [] });
    expect(pickAll(order, can).ids).toEqual(['a', 'b', 'd', 'e']);
  });

  it('ignores a row that is not in the list', () => {
    expect(togglePick(NO_PICK, order, all, 'zz')).toBe(NO_PICK);
    expect(rangePick(NO_PICK, order, all, 'zz')).toBe(NO_PICK);
  });

  it('drops rows that left the list, and keeps the same pick when nothing left', () => {
    const pick = { anchor: 'b', ids: ['a', 'b', 'c'] };
    expect(keepShown(pick, order)).toBe(pick);
    expect(keepShown(pick, ['a', 'c'])).toEqual({ ids: ['a', 'c'] });
  });
});

describe('Mac Overview selection: what can be deleted', () => {
  it('worktrees and chats of Beluga’s, live or archived; not plans, ones being made, or another tool’s worktrees', () => {
    expect(pickable(item({}))).toBe(true);
    expect(pickable(item({ archived: true }))).toBe(true);
    expect(pickable(item({ kind: 'chat', branch: undefined }))).toBe(true);
    expect(pickable(item({ external: true }))).toBe(false);
    expect(pickable(item({ pending: true }))).toBe(false);
    expect(pickable(item({}, { plan: { plan: {} as never, title: 'Plan', unread: 0, tip: '' } }))).toBe(false);
  });

  it('checks only worktrees with a branch of Beluga’s for unpushed commits', () => {
    expect(needsUnpushedCheck(item({}))).toBe(true);
    expect(needsUnpushedCheck(item({ archived: true }))).toBe(true);
    expect(needsUnpushedCheck(item({ kind: 'chat', branch: undefined }))).toBe(false);
    expect(needsUnpushedCheck(item({ branch: undefined }))).toBe(false);
  });
});

describe('Mac Overview selection: the confirmation’s words', () => {
  it('names what is picked, by kind', () => {
    expect(pickedWords([item({ id: 'a' })])).toBe('1 worktree');
    expect(pickedWords([item({ id: 'a', kind: 'chat' }), item({ id: 'b', kind: 'chat' })])).toBe('2 chats');
    expect(pickedWords([item({ id: 'a' }), item({ id: 'b', kind: 'chat' }), item({ id: 'c', kind: 'chat' })])).toBe('1 worktree and 2 chats');
  });

  it('says what goes: folders, archives, branches and conversations', () => {
    expect(deleteWords([item({ kind: 'chat', branch: undefined })])).toBe('This deletes the conversation and removes it from Beluga.');
    expect(deleteWords([item({ id: 'a' }), item({ id: 'b' })])).toBe('This deletes 2 worktree folders (with any uncommitted work), 2 branches and their conversations.');
    expect(deleteWords([item({ id: 'a', archived: true, archive: { keptBytes: 10, freedBytes: 0, remake: [] } as never })])).toBe('This deletes an archive of kept work, its branch and the conversation.');
  });

  it('lists the worktrees whose commits were never pushed', () => {
    const items = [item({ id: 'a', name: 'add-auth' }), item({ id: 'b', name: 'webhooks' }), item({ id: 'c', name: 'docs' })];
    const plans = new Map([
      ['a', { branch: 'klaud/add-auth', into: 'main', unpushed: 2, subjects: ['one', 'two'] }],
      ['b', null],
      ['c', { branch: 'klaud/docs', into: 'main', unpushed: 0, subjects: [] }],
    ]);
    expect(unpushedLosses(items, plans).map((l) => [l.name, l.plan.unpushed])).toEqual([['add-auth', 2]]);
  });
});
