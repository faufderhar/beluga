import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MergeCounter, attachSupport, basesOf, loadSupportFile, mergedByGit, supportOf } from '../src/core/merge-counter.js';
import { Store, initialState } from '../src/core/store.js';
import { type SupportRecord, answerAsk, dueAsk, mergeKey, supportView } from '../src/core/support-store.js';
import type { WorktreeEvent } from '../src/core/workspace-controller.js';
import type { PullRequest } from '../src/core/work-store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { parseArgs } from '../src/ipc/api.js';
import type { Session } from '../src/core/session.js';

/** Merged work made in Beluga, counted once per branch, and the star and coffee asks it brings. */

const ROOT = '/code/app';

const worktree = (id: string, branch: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: ROOT, name: id, path: `/wt/${id}`, kind: 'worktree', branch, base: 'origin/main', createdAt: 1000, external: false, ...more });

function storeWith(workspaces: Workspace[]): Store {
  const store = new Store(initialState('test', 'ask'));
  const project: Project = { id: 'p1', name: 'app', root: ROOT, base: 'origin/main', workspaces };
  store.dispatch({ type: 'projects', projects: [project] });
  return store;
}

/** A stand-in for the workspace controller: its events, sent by hand. */
function fakeController() {
  const worktree = new Set<(e: WorktreeEvent) => void>();
  const going = new Set<(ws: Workspace) => void>();
  return {
    onWorktree: (l: (e: WorktreeEvent) => void) => (worktree.add(l), () => void worktree.delete(l)),
    onWorktreeGoing: (l: (ws: Workspace) => void) => (going.add(l), () => void going.delete(l)),
    merged: (id: string) => worktree.forEach((l) => l({ kind: 'merged', id })),
    going: (ws: Workspace) => going.forEach((l) => l(ws)),
  };
}

const pr = (state: PullRequest['state']): PullRequest => ({ number: 7, url: 'https://github.com/x/y/pull/7', state, title: 'Work', draft: false, checks: 'passing' });
const tick = () => new Promise((r) => setTimeout(r, 0));
const record = (merges: number, more: Partial<SupportRecord> = {}): SupportRecord => ({ counted: Array.from({ length: merges }, (_, i) => mergeKey(ROOT, `b${i}`)), ...more });

describe('the asks (support-store)', () => {
  it('asks for a star at the third merge, and only until it is answered', () => {
    expect(dueAsk(record(0))).toBeUndefined();
    expect(dueAsk(record(1))).toBeUndefined();
    expect(dueAsk(record(2))).toBeUndefined();
    expect(dueAsk(record(3))).toBe('star');
    for (const answer of ['yes', 'later', 'never'] as const) {
      const answered = answerAsk(record(3), 'star', answer, 0);
      expect(dueAsk({ ...answered, counted: record(40).counted })).toBeUndefined();
    }
    // A star never answered (several merges at once, the window closed) is still due.
    expect(dueAsk(record(6))).toBe('star');
  });

  it('never asks for money', () => {
    for (let merges = 0; merges <= 30; merges++) {
      const starred = answerAsk(record(Math.min(merges, 3)), 'star', 'yes', 0);
      expect(dueAsk({ ...starred, counted: record(merges).counted })).toBeUndefined();
    }
    expect(() => parseArgs('support.answer', ['coffee', 'yes'])).toThrow();
  });

  it('screens see the count, the ask due and what was shown', () => {
    expect(supportView(record(1))).toEqual({ merges: 1, starShown: false });
    expect(supportView(record(3))).toEqual({ merges: 3, due: 'star', starShown: false });
    expect(supportView(answerAsk(record(3), 'star', 'yes', 0))).toEqual({ merges: 3, starShown: true });
  });
});

describe('MergeCounter', () => {
  it('counts a branch merged here once, and only worktrees Beluga made', async () => {
    const store = storeWith([
      worktree('w1', 'feat/a'),
      worktree('w2', 'feat/b', { external: true }),
      { ...worktree('m', 'main'), kind: 'main' },
      worktree('w3', 'feat/a', { id: 'w3' }),
    ]);
    const controller = fakeController();
    const counter = new MergeCounter({ store, file: null, controller });
    controller.merged('w1');
    controller.merged('w1');
    controller.merged('w2');
    controller.merged('m');
    // Another worktree on the same branch is the same work.
    controller.merged('w3');
    controller.merged('gone');
    expect(counter.merges).toBe(1);
    expect(store.getState().support).toEqual({ merges: 1, starShown: false });
    counter.stop();
  });

  it('counts a pull request merged on GitHub, once, and not an open or closed one', async () => {
    const store = storeWith([worktree('w1', 'feat/a'), worktree('w2', 'feat/b')]);
    const counter = new MergeCounter({ store, file: null });
    store.dispatch({ type: 'pr', id: 'w1', pr: pr('OPEN') });
    store.dispatch({ type: 'pr', id: 'w2', pr: pr('CLOSED') });
    await tick();
    expect(counter.merges).toBe(0);
    store.dispatch({ type: 'pr', id: 'w1', pr: pr('MERGED') });
    store.dispatch({ type: 'pr', id: 'w1', pr: pr('MERGED') });
    await tick();
    expect(counter.merges).toBe(1);
    counter.stop();
  });

  it('keeps what it counted and what you answered in support.json', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-support-')), 'support.json');
    const store = storeWith([worktree('w1', 'feat/a'), worktree('w2', 'feat/b')]);
    const controller = fakeController();
    const counter = new MergeCounter({ store, file, controller, now: () => 42 });
    controller.merged('w1');
    counter.answer('star', 'yes');
    counter.stop();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ counted: [mergeKey(ROOT, 'feat/a')], star: { merges: 1, answer: 'yes', times: 1, at: 42 } });
    // Beluga again: the same branch doesn't count twice, a new one does, and the star stays answered.
    const again = new MergeCounter({ store, file, controller });
    controller.merged('w1');
    controller.merged('w2');
    expect(again.merges).toBe(2);
    expect(store.getState().support).toEqual({ merges: 2, starShown: true });
    expect(loadSupportFile(file).counted).toHaveLength(2);
    again.stop();
  });

  it('the sweep counts merged pull requests the workbench saw and what git says is merged, archived worktrees too', async () => {
    const store = storeWith([worktree('w1', 'feat/a'), worktree('w2', 'feat/b', { archived: true }), worktree('w3', 'feat/c'), worktree('w4', 'feat/d', { external: true })]);
    store.dispatch({ type: 'pr', id: 'w1', pr: pr('MERGED') });
    const asked: string[] = [];
    const counter = new MergeCounter({
      store,
      file: null,
      mergedByGit: async (_root, branch) => {
        asked.push(branch);
        return branch === 'feat/b' || branch === 'feat/d';
      },
    });
    // Merged before Beluga was listening: the sweep finds it.
    await tick();
    expect(counter.merges).toBe(0);
    expect(await counter.sweep()).toBe(2);
    expect(counter.merges).toBe(2);
    // Counted ones aren't asked about again; another tool's worktree never is.
    asked.length = 0;
    expect(await counter.sweep()).toBe(0);
    expect(asked).toEqual(['feat/c']);
    counter.stop();
  });

  it('asks git about a worktree as it goes (deleting it deletes its branch)', async () => {
    const store = storeWith([worktree('w1', 'feat/a')]);
    const controller = fakeController();
    const counter = new MergeCounter({ store, file: null, controller, mergedByGit: async () => true });
    controller.going(worktree('w1', 'feat/a'));
    await tick();
    expect(counter.merges).toBe(1);
    counter.stop();
  });

  it('brings the star ask with the third merge, then never again', async () => {
    const branches = ['a', 'b', 'c', 'd'];
    const store = storeWith(branches.map((b) => worktree(b, `feat/${b}`)));
    const controller = fakeController();
    const counter = new MergeCounter({ store, file: null, controller });
    controller.merged('a');
    controller.merged('b');
    expect(store.getState().support).toEqual({ merges: 2, starShown: false });
    controller.merged('c');
    expect(store.getState().support).toEqual({ merges: 3, due: 'star', starShown: false });
    counter.answer('star', 'later');
    controller.merged('d');
    expect(store.getState().support).toEqual({ merges: 4, starShown: true });
    counter.stop();
  });

  it('loads an old support.json that still has a coffee answer, and drops it', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-support-')), 'support.json');
    const answered = { merges: 5, answer: 'later', times: 1, at: 1 };
    writeFileSync(file, JSON.stringify({ counted: record(5).counted, star: { ...answered, merges: 1, answer: 'yes' }, coffee: answered }));
    const loaded = loadSupportFile(file);
    expect(loaded).toEqual({ counted: record(5).counted, star: { ...answered, merges: 1, answer: 'yes' } });
    expect(dueAsk({ ...loaded, counted: record(10).counted })).toBeUndefined();
  });

  it('support.answer goes to the session’s counter', async () => {
    const store = storeWith([worktree('w1', 'feat/a')]);
    const session = {} as Session;
    const counter = new MergeCounter({ store, file: null, seed: record(3) });
    attachSupport(session, counter);
    expect(supportOf(session)).toBe(counter);
    await HANDLERS['support.answer'](session, ...parseArgs('support.answer', ['star', 'yes']));
    expect(store.getState().support.starShown).toBe(true);
    expect(() => parseArgs('support.answer', ['star', 'maybe'])).toThrow();
    counter.stop();
  });
});

describe('mergedByGit', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

  function repo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-merged-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    return dir;
  }

  it('says merged for a branch whose own commits are in main (a merge or a fast-forward)', async () => {
    const dir = repo();
    git(dir, 'switch', '-q', '-c', 'feat/merged');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'work');
    git(dir, 'switch', '-q', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'meanwhile');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'feat/merged');
    git(dir, 'switch', '-q', '-c', 'feat/ff');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'more');
    git(dir, 'switch', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feat/ff');
    expect(await mergedByGit(dir, 'feat/merged', ['main'])).toBe(true);
    expect(await mergedByGit(dir, 'feat/ff', ['origin/main', 'main'])).toBe(true);
  });

  it('says not merged for work not in main, a branch nobody committed on, and a branch that is gone', async () => {
    const dir = repo();
    git(dir, 'branch', 'feat/empty');
    git(dir, 'switch', '-q', '-c', 'feat/open');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'work');
    git(dir, 'switch', '-q', 'main');
    // main moves on: the untouched branch is behind it, which isn't merged work.
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'later');
    expect(await mergedByGit(dir, 'feat/open', ['main'])).toBe(false);
    expect(await mergedByGit(dir, 'feat/empty', ['main'])).toBe(false);
    expect(await mergedByGit(dir, 'feat/nothing', ['main'])).toBe(false);
  });

  it('looks in origin’s default branch, the local one and where the worktree started', () => {
    const ws = worktree('w1', 'feat/a', { base: 'origin/main' });
    const project = { id: 'p1', name: 'app', root: ROOT, base: 'origin/main', workspaces: [], sync: { branch: 'main', upstream: 'origin/main', local: true, ahead: 0, behind: 0, onDefault: true } } as unknown as Project;
    expect(basesOf(ws, project)).toEqual(['origin/main', 'main']);
    expect(basesOf({ ...ws, base: 'HEAD' }, undefined)).toEqual([]);
  });
});
