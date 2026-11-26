import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommitAppend } from '../src/agent/prompt.js';
import { branchState, pushMainStep } from '../src/core/branch-state.js';
import { Lander, landingWords, rebasePrompt, turnsEnded } from '../src/core/land-on-base.js';
import type { LogItem, Store } from '../src/core/store.js';
import { type LandResult, changedFiles, landOnto } from '../src/workspaces/land.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Project, ProjectSync, Workspace } from '../src/workspaces/types.js';

/** Straight to main (BLG-973): a worktree's work lands on its base in the main folder, as a straight line. */

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function commit(dir: string, file: string, text: string, message = `change ${file}`): void {
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', message);
}

/** A main checkout on main and a worktree on its own branch, made from it. */
function repo(): { main: string; tree: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-land-'));
  const main = path.join(base, 'app');
  mkdirSync(main);
  sh(main, 'init', '-q', '-b', 'main');
  sh(main, 'config', 'user.email', 't@t');
  sh(main, 'config', 'user.name', 'Tess');
  commit(main, 'a.txt', 'one\ntwo\nthree\n', 'init');
  const tree = path.join(base, 'tree');
  sh(main, 'worktree', 'add', '-q', '-b', 'beluga/fix', tree, 'main');
  return { main, tree };
}

const read = (dir: string, file: string): string => readFileSync(path.join(dir, file), 'utf8');
const merges = (dir: string): string => sh(dir, 'rev-list', '--merges', '--count', 'main');

describe('landOnto', () => {
  it('fast-forwards the main folder to the worktree’s commits: no merge commit', async () => {
    const { main, tree } = repo();
    commit(tree, 'b.txt', 'new\n');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: true, landed: 1 });
    expect(read(main, 'b.txt')).toBe('new\n');
    expect(sh(main, 'rev-parse', 'main')).toBe(sh(tree, 'rev-parse', 'HEAD'));
    expect(merges(main)).toBe('0');
  });

  it('nothing new: nothing lands', async () => {
    const { main, tree } = repo();
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: true, landed: 0 });
  });

  it('main moved on meanwhile: the branch is rebased onto it, and main stays a straight line', async () => {
    const { main, tree } = repo();
    commit(main, 'c.txt', 'theirs\n');
    commit(tree, 'b.txt', 'mine\n');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: true, landed: 1 });
    expect([read(main, 'b.txt'), read(main, 'c.txt')]).toEqual(['mine\n', 'theirs\n']);
    expect(merges(main)).toBe('0');
    expect(sh(main, 'rev-list', '--count', 'main')).toBe('3');
  });

  it('a conflict with what landed meanwhile leaves both as they were', async () => {
    const { main, tree } = repo();
    commit(main, 'a.txt', 'one\nTWO\nthree\n');
    commit(tree, 'a.txt', 'one\n2\nthree\n');
    const before = sh(tree, 'rev-parse', 'HEAD');
    const mainBefore = sh(main, 'rev-parse', 'HEAD');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: false, reason: 'conflict', files: ['a.txt'] });
    expect(sh(tree, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(tree, 'status', '--porcelain')).toBe('');
    expect(sh(main, 'rev-parse', 'HEAD')).toBe(mainBefore);
  });

  it('your own changes in the main folder are never touched: the same file stops it, another one doesn’t', async () => {
    const { main, tree } = repo();
    commit(tree, 'a.txt', 'one\n2\nthree\n');
    writeFileSync(path.join(main, 'a.txt'), 'mine, unsaved\n');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: false, reason: 'dirty', files: ['a.txt'] });
    expect(read(main, 'a.txt')).toBe('mine, unsaved\n');
    // Your edit is elsewhere: it lands, and your edit stays.
    sh(main, 'checkout', '--', 'a.txt');
    writeFileSync(path.join(main, 'notes.txt'), 'scratch\n');
    expect((await landOnto(main, tree, 'beluga/fix', 'main')).ok).toBe(true);
    expect([read(main, 'a.txt'), read(main, 'notes.txt')]).toEqual(['one\n2\nthree\n', 'scratch\n']);
  });

  it('a new file the work adds, already there untracked in the main folder, stops it', async () => {
    const { main, tree } = repo();
    commit(tree, 'b.txt', 'theirs\n');
    writeFileSync(path.join(main, 'b.txt'), 'mine\n');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toEqual({ ok: false, reason: 'dirty', files: ['b.txt'] });
  });

  it('the main folder on another branch: says so', async () => {
    const { main, tree } = repo();
    commit(tree, 'b.txt', 'x\n');
    sh(main, 'checkout', '-q', '-b', 'other');
    expect(await landOnto(main, tree, 'beluga/fix', 'main')).toMatchObject({ ok: false, reason: 'wrong_branch', current: 'other', expected: 'main' });
  });

  it('reads renames from git status -z', () => {
    expect(changedFiles(' M a.txt\0R  new.txt\0old.txt\0?? b.txt\0')).toEqual(['a.txt', 'new.txt', 'old.txt', 'b.txt']);
  });
});

describe('a Straight to main worktree', () => {
  async function project() {
    const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-land-mgr-'));
    const dir = path.join(base, 'code', 'app');
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 't@t');
    sh(dir, 'config', 'user.name', 'Tess');
    commit(dir, 'a.txt', 'one\n', 'init');
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const manager = new WorkspaceManager(store);
    await manager.refresh();
    return { dir, manager, id: manager.list.find((p) => p.root)!.id };
  }

  it('commits what’s left and lands it; its status then counts against the main folder’s branch', async () => {
    const { dir, manager, id } = await project();
    const ws = await manager.createWorktree(id, 'fix typo', 'main', { landOnBase: true });
    expect(ws.landOnBase).toBe(true);
    writeFileSync(path.join(ws.path, 'a.txt'), 'One\n');
    expect(await manager.land(ws.id, 'Fix typo')).toEqual({ ok: true, landed: 1 });
    expect(read(dir, 'a.txt')).toBe('One\n');
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('Fix typo');
    expect(manager.find(ws.id)?.status).toMatchObject({ changed: 0, ahead: 0 });
  });

  it('can be turned on and off later, and only for worktrees', async () => {
    const { manager, id } = await project();
    const ws = await manager.createWorktree(id, 'later', 'main');
    expect(ws.landOnBase).toBeUndefined();
    manager.setLandOnBase(ws.id, true);
    expect(manager.find(ws.id)?.landOnBase).toBe(true);
    manager.setLandOnBase(ws.id, false);
    expect(manager.find(ws.id)?.landOnBase).toBeUndefined();
    const main = manager.list.find((p) => p.id === id)!.workspaces.find((w) => w.kind === 'main')!;
    expect(() => manager.setLandOnBase(main.id, true)).toThrow(/Only worktrees/);
  });
});

describe('when a turn ends', () => {
  const card = (over: Partial<Extract<LogItem, { type: 'agent' }>>): LogItem => ({ id: 'r1', type: 'agent', owner: 'me', requestId: 'q1', requester: 'me', status: 'started', text: '', ts: 0, channel: 'ws:w1', subagents: [], ...over }) as LogItem;

  it('a run of yours that finished well, with nothing else running there', () => {
    expect(turnsEnded([card({})], [card({ status: 'done' })], 'me')).toEqual(['ws:w1']);
  });

  it('not one that failed or was stopped, a friend’s, a chat outside worktrees, or with more waiting', () => {
    expect(turnsEnded([card({})], [card({ status: 'error' })], 'me')).toEqual([]);
    expect(turnsEnded([card({ owner: 'friend' })], [card({ owner: 'friend', status: 'done' })], 'me')).toEqual([]);
    expect(turnsEnded([card({ channel: 'room' })], [card({ channel: 'room', status: 'done' })], 'me')).toEqual([]);
    const queued = card({ id: 'r2', requestId: 'q2', status: 'queued' });
    expect(turnsEnded([card({}), queued], [card({ status: 'done' }), queued], 'me')).toEqual([]);
  });

  it('a card that was done already says nothing again', () => {
    const done = card({ status: 'done' });
    expect(turnsEnded([done], [done, card({ id: 'x', type: 'agent', status: 'done' })], 'me')).toEqual([]);
  });

  it('says what happened in plain words', () => {
    expect(landingWords({ ok: true, landed: 2 }, 'main')?.text).toBe('Committed to main in the main folder · not pushed yet');
    expect(landingWords({ ok: true, landed: 0 }, 'main')).toBeUndefined();
    expect(landingWords({ ok: false, reason: 'dirty', files: ['a.ts'] }, 'main')?.text).toContain('your own changes in the main folder in a.ts');
    expect(landingWords({ ok: false, reason: 'wrong_branch', files: [], current: 'dev', expected: 'main' }, 'main')?.text).toContain('the main folder is on dev');
    expect(rebasePrompt('main', ['a.ts'])).toContain('git rebase main');
  });
});

describe('where it stands', () => {
  const ws = (over: Partial<Workspace> = {}): Workspace => ({ id: 'w1', projectRoot: '/r', projectId: 'p1', name: 'w', path: '/r/w', kind: 'worktree', createdAt: 0, branch: 'beluga/fix', base: 'origin/main', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over });
  const at = (w: Workspace, pr?: 'OPEN') => {
    const project: Project = { id: 'p1', name: 'app', root: '/r', base: 'origin/main', workspaces: [w] };
    return branchState({ projects: [project], gh: true, prs: pr ? { [w.id]: { number: 3, url: 'u', state: pr, title: 't', draft: false, checks: 'passing' } } : {}, conflicts: {} }, w)!;
  };

  it('work waiting lands on main, with Land Now first and Keep on Its Branch', () => {
    const b = at(ws({ landOnBase: true, status: { changed: 2, ahead: 1, behind: 0 } }));
    expect([b.label, b.tone]).toEqual(['Lands on main', 'info']);
    expect(b.detail).toContain('2 changes and 1 commit land on main');
    expect(b.steps.map((s) => s.id)).toEqual(['land', 'land_off']);
  });

  it('everything landed: On main, and archive or keep it on its branch', () => {
    const b = at(ws({ landOnBase: true }));
    expect([b.label, b.tone]).toEqual(['On main', 'ok']);
    expect(b.steps.map((s) => s.id)).toEqual(['archive', 'land_off']);
  });

  describe('main with commits origin doesn’t have', () => {
    const sync = (over: Partial<ProjectSync> = {}): ProjectSync => ({ branch: 'main', upstream: 'origin/main', remote: 'origin', local: true, ahead: 3, behind: 0, current: 'main', onDefault: true, dirty: 0, ...over });
    const pushing = (w: Workspace, s?: ProjectSync) => {
      const project: Project = { id: 'p1', name: 'app', root: '/r', base: 'origin/main', workspaces: [w], ...(s ? { sync: s } : {}) };
      return branchState({ projects: [project], gh: true, prs: {}, conflicts: {} }, w)!;
    };

    it('everything landed: Push main to origin leads, with how many', () => {
      const b = pushing(ws({ landOnBase: true }), sync());
      expect([b.label, b.tone]).toEqual(['3 commits not pushed', 'info']);
      expect(b.steps.map((s) => s.id)).toEqual(['push_main', 'archive', 'land_off']);
      expect(b.steps[0]?.label).toBe('Push main to origin');
      expect(b.detail).toContain('aren’t on origin/main yet');
    });

    it('work still waiting: Land Now leads, and the push is in its menu', () => {
      const b = pushing(ws({ landOnBase: true, status: { changed: 1, ahead: 0, behind: 0 } }), sync({ ahead: 1 }));
      expect(b.steps.map((s) => s.id)).toEqual(['land', 'push_main', 'land_off']);
    });

    it('no push without a remote, nothing ahead, or another branch than the one tracked', () => {
      expect(pushing(ws({ landOnBase: true }), sync({ ahead: 0 })).label).toBe('On main');
      expect(pushing(ws({ landOnBase: true }), sync({ upstream: undefined })).label).toBe('On main');
      expect(pushing(ws({ landOnBase: true, base: 'dev' }), sync()).steps.map((s) => s.id)).not.toContain('push_main');
    });

    it('a worktree on its own branch never offers it', () => {
      expect(pushing(ws({ status: { changed: 0, ahead: 1, behind: 0 } }), sync()).steps.map((s) => s.id)).not.toContain('push_main');
    });

    it('names the remote it goes to', () => {
      expect(pushMainStep(sync({ remote: 'upstream', upstream: 'upstream/main' }), 'main')?.step.label).toBe('Push main to upstream');
    });
  });

  it('an open PR is how it ships, landing or not', () => {
    expect(at(ws({ landOnBase: true, status: { changed: 0, ahead: 1, behind: 0 } }), 'OPEN').steps.map((s) => s.id)).not.toContain('land');
  });

  it('any other worktree with work can go Straight to main, last in its menu', () => {
    expect(at(ws({ status: { changed: 0, ahead: 1, behind: 0 } })).steps.at(-1)?.id).toBe('land_on');
    expect(at(ws({ status: { changed: 1, ahead: 0, behind: 0 } })).steps.at(-1)?.id).toBe('land_on');
    expect(at(ws()).steps).toEqual([]);
  });
});

describe('its agent', () => {
  it('is told its work lands on main, and not to push or open a PR', () => {
    const text = buildCommitAppend(undefined, 'main');
    expect(text).toContain('goes straight to main');
    expect(text).toContain('Never push, merge, rebase or open');
    expect(buildCommitAppend()).toContain('not on a pull request yet');
  });
});

describe('the lander', () => {
  type Card = Extract<LogItem, { type: 'agent' }>;
  const card = (status: Card['status'], id = 'r1'): LogItem => ({ id, type: 'agent', owner: 'me', requestId: id, requester: 'me', status, text: '', ts: 0, channel: 'ws:w1', subagents: [] }) as unknown as LogItem;
  const worktree = { id: 'w1', kind: 'worktree', branch: 'beluga/fix', landOnBase: true } as Workspace;

  function setup(results: LandResult[], ws: Workspace = worktree) {
    let state = { log: [card('started')] as LogItem[], selfId: 'me' };
    const listeners: Array<() => void> = [];
    const said: string[] = [];
    const asked: string[] = [];
    const lands: string[] = [];
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => (listeners.push(l), () => undefined),
      dispatch: (a: { type: string; text?: string }) => void (a.type === 'system' && said.push(a.text ?? '')),
    } as unknown as Store;
    new Lander({
      store,
      find: () => ws,
      land: async (id) => (lands.push(id), results.shift() ?? { ok: true, landed: 0 }),
      target: () => 'main',
      hasPr: () => false,
      toast: () => undefined,
      askClaude: (prompt) => void asked.push(prompt),
      ensureLoaded: () => undefined,
      landed: () => undefined,
    });
    const step = async (log: LogItem[]): Promise<void> => {
      state = { ...state, log };
      for (const l of listeners) l();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { step, said, asked, lands };
  }

  it('lands when the turn ends, with a merged line in the chat', async () => {
    const t = setup([{ ok: true, landed: 1 }]);
    await t.step([card('done')]);
    expect(t.lands).toEqual(['w1']);
    expect(t.said).toEqual(['Above this line was merged into main.']);
  });

  it('a conflict asks the agent to rebase once; a second in a row stops with a line in the chat', async () => {
    const conflict: LandResult = { ok: false, reason: 'conflict', files: ['a.ts'] };
    const t = setup([conflict, conflict]);
    await t.step([card('done')]);
    expect(t.asked).toHaveLength(1);
    await t.step([card('done'), card('started', 'r2')]);
    await t.step([card('done'), card('done', 'r2')]);
    expect(t.asked).toHaveLength(1);
    expect(t.said.at(-1)).toContain('Didn’t land on main');
  });

  it('a worktree that isn’t Straight to main is left alone', async () => {
    const t = setup([], { ...worktree, landOnBase: undefined });
    await t.step([card('done')]);
    expect(t.lands).toEqual([]);
  });
});
