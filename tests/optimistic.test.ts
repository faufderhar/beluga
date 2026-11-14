import { describe, expect, it } from 'vitest';
import { nothingAhead, pendingWorktree, withAhead } from '../src/core/optimistic.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/${id}`, kind: 'worktree', createdAt: 0, projectId: 'p', external: false, ...over });
const project = (id: string, ...workspaces: Workspace[]): Project => ({ id, name: id, root: `/${id}`, base: 'origin/main', workspaces: [ws(`${id}-main`, { kind: 'main', projectId: id }), ...workspaces.map((w) => ({ ...w, projectId: id }))] });

/** What the sidebar shows ahead of the disk: archive, delete and new worktrees take effect at once. */
describe('the projects ahead of the disk', () => {
  it('nothing going on: the same projects', () => {
    const list = [project('p', ws('a'))];
    expect(withAhead(list, nothingAhead())).toEqual(list);
    expect(withAhead(list, nothingAhead())[0]).toBe(list[0]);
  });

  it('a worktree being archived shows archived; one being deleted is gone; the rest are untouched', () => {
    const ahead = nothingAhead();
    ahead.leaving.set('a', 'archive');
    ahead.leaving.set('b', 'delete');
    const other = project('q', ws('c'));
    const [p, q] = withAhead([project('p', ws('a'), ws('b'), ws('keep')), other], ahead);
    expect(p!.workspaces.map((w) => [w.id, Boolean(w.archived)])).toEqual([
      ['p-main', false],
      ['a', true],
      ['keep', false],
    ]);
    expect(q).toBe(other);
  });

  it('a project being deleted leaves the list', () => {
    const ahead = nothingAhead();
    ahead.projects.add('p');
    expect(withAhead([project('p', ws('a')), project('q')], ahead).map((p) => p.id)).toEqual(['q']);
  });

  it('a worktree being made shows under its project, pending, until the real one (same id) takes its place', () => {
    const ahead = nothingAhead();
    const p = project('p');
    const row = pendingWorktree({ id: 'wt-new', project: p, name: 'quick', now: 5 });
    expect(row).toMatchObject({ id: 'wt-new', projectId: 'p', projectRoot: '/p', name: 'quick', kind: 'worktree', base: 'origin/main', pending: true, external: false });
    ahead.making.set(row.id, row);
    expect(withAhead([p], ahead)[0]!.workspaces).toContain(row);
    // Made: only the real one, never both.
    const made = withAhead([project('p', ws('wt-new', { name: 'quick' }))], ahead)[0]!.workspaces.filter((w) => w.id === 'wt-new');
    expect(made).toHaveLength(1);
    expect(made[0]!.pending).toBeUndefined();
    // On a branch you picked.
    expect(pendingWorktree({ id: 'x', project: p, name: 'y', base: 'origin/feature' }).base).toBe('origin/feature');
  });

  it('a worktree being made shows where the real one will be: first of the worktrees, never jumping when it’s made', () => {
    const ahead = nothingAhead();
    const p = project('p', ws('older', { createdAt: 1 }), ws('a-chat', { kind: 'chat', createdAt: 2 }), ws('gone', { archived: true, createdAt: 3 }));
    const fork = pendingWorktree({ id: 'wt-fork', project: p, name: 'older-2', forkedFrom: 'older', now: 10 });
    expect(fork.forkedFrom).toBe('older');
    ahead.making.set(fork.id, fork);
    expect(withAhead([p], ahead)[0]!.workspaces.map((w) => w.id)).toEqual(['p-main', 'wt-fork', 'older', 'a-chat', 'gone']);
  });
});
