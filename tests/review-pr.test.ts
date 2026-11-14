import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import type { Actor } from '../src/core/board/model.js';
import { ReviewPr, reviewPrNote } from '../src/core/board/review-pr.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** Open a PR when the work is ready (BLG-927): a worktree's task reaching In Review opens its draft PR. */

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId: 'api', name, path: `/tmp/${name}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (workspaces: Workspace[]): Project => ({ id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces });
const me: Actor = { kind: 'beluga' };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(opts: { readonly on?: boolean; readonly workspaces?: Workspace[] } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project(opts.workspaces ?? [ws('w1', 'add-auth')])] });
  if (opts.on !== false) store.dispatch({ type: 'prefs', prefs: { prOnReview: true } });
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const opened: Array<[string, string]> = [];
  /** A task in progress in worktree `w` (as Start or task_define leave it). */
  const task = (w = 'w1', status: 'in_progress' | 'in_review' = 'in_progress') => {
    const t = board.create({ projectId: 'api', title: 'Add auth', status }, me);
    board.linkWorktree(t.id, w, { branch: 'beluga/add-auth', name: 'add-auth' }, me);
    return t;
  };
  const start = () => new ReviewPr({ store, issues: () => board.list(), openPr: (id, extra) => void opened.push([id, extra]) });
  return { store, board, opened, task, start };
}

describe('a task reaching In Review opens its draft pull request (BLG-927)', () => {
  it('asks the worktree’s agent once, for a draft, when the setting is on', async () => {
    const { board, opened, task, start } = setup();
    const t = task();
    start();
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened).toEqual([['w1', reviewPrNote(t)]]);
    expect(opened[0]![1]).toContain('--draft');
    // Back to In Progress and to review again: still the one ask for this worktree.
    board.update(t.id, { status: 'in_progress' }, me);
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened).toHaveLength(1);
  });

  it('is off by default: nothing opens', async () => {
    const { board, opened, task, start } = setup({ on: false });
    const t = task();
    start();
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened).toEqual([]);
  });

  it('only a move fires it: a task already in review that changes otherwise opens nothing', async () => {
    const { board, opened, task, start } = setup();
    const t = task('w1', 'in_review');
    start();
    board.update(t.id, { title: 'Add session auth' }, me);
    await tick();
    expect(opened).toEqual([]);
  });

  it('never when its worktree already has a pull request open, or one closed by hand', async () => {
    for (const state of ['OPEN', 'CLOSED'] as const) {
      const { store, board, opened, task, start } = setup();
      const t = task();
      start();
      store.dispatch({ type: 'pr', id: 'w1', pr: { number: 3, url: 'u', state, title: 't', draft: false, checks: 'passing' } });
      board.update(t.id, { status: 'in_review' }, me);
      await tick();
      expect(opened).toEqual([]);
    }
  });

  it('never for a task that has a pull request of its own already', async () => {
    const { board, opened, task, start } = setup();
    const t = task();
    start();
    board.prChanged('w1', { number: 4, url: 'u', state: 'OPEN', title: 't', draft: true, checks: 'none' });
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened).toEqual([]);
  });

  it('never without GitHub’s CLI, or for a worktree that is archived or isn’t here', async () => {
    const gh = setup();
    const t1 = gh.task();
    gh.start();
    gh.store.dispatch({ type: 'gh', ok: false });
    gh.board.update(t1.id, { status: 'in_review' }, me);

    const archived = setup({ workspaces: [ws('w1', 'add-auth', { archived: true } as Partial<Workspace>)] });
    const t2 = archived.task();
    archived.start();
    archived.board.update(t2.id, { status: 'in_review' }, me);

    const elsewhere = setup();
    const t3 = elsewhere.task('w9');
    elsewhere.start();
    elsewhere.board.update(t3.id, { status: 'in_review' }, me);
    await tick();
    expect([...gh.opened, ...archived.opened, ...elsewhere.opened]).toEqual([]);
  });

  it('a new pull request after the last one merged (Continue After Merge)', async () => {
    const { store, board, opened, task, start } = setup();
    const t = task();
    start();
    store.dispatch({ type: 'pr', id: 'w1', pr: { number: 3, url: 'u', state: 'MERGED', title: 't', draft: false, checks: 'passing' } });
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened.map(([id]) => id)).toEqual(['w1']);
  });

  it('stops listening once stopped', async () => {
    const { board, opened, task, start } = setup();
    const t = task();
    start().stop();
    board.update(t.id, { status: 'in_review' }, me);
    await tick();
    expect(opened).toEqual([]);
  });
});
