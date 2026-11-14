import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { branchState, failedRunIds, prBlocker, runningRunIds } from '../src/core/branch-state.js';
import { Store, initialState } from '../src/core/store.js';
import type { PrCheck, PullRequest } from '../src/core/work-store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { Workbench } from '../src/core/workbench.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/**
 * What an open PR needs next, said plainly (BLG-753): Push when this worktree has commits the PR
 * doesn't (GitHub's checks and conflicts are for an older commit), Resolve Conflicts (never a bare
 * "Resolve"), Checks running while they run, and Re-run Failed Checks beside Fix Checks.
 */

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }> }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], opts: { cwd?: string }, cb: ExecCb) => {
    exec.calls.push({ cmd, args, cwd: opts.cwd });
    queueMicrotask(() => cb(null, '', ''));
  },
}));
const { cancelRun, parsePr, rerunFailed } = await import('../src/workspaces/pr.js');

const ws = (over: Partial<Workspace> = {}): Workspace => ({ id: 'w1', projectRoot: '/r', projectId: 'p1', name: 'w', path: '/r/w', kind: 'worktree', createdAt: 0, branch: 'feat/x', base: 'main', external: false, status: { changed: 0, ahead: 2, behind: 0 }, ...over });
const project = (w: Workspace): Project => ({ id: 'p1', name: 'app', root: '/r', base: 'main', workspaces: [w] });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 366, url: 'https://github.com/o/r/pull/366', state: 'OPEN', title: 't', draft: false, checks: 'passing', ...over });
const at = (w: Workspace, p?: PullRequest) => branchState({ projects: [project(w)], gh: true, prs: p ? { [w.id]: p } : {}, conflicts: {} }, w)!;
const run = (name: string, state: PrCheck['state'], conclusion?: string, id = 1): PrCheck => ({ name, state, ...(conclusion ? { conclusion } : {}), url: `https://github.com/o/r/actions/runs/${id}/job/${name.length}` });
/** Pushed: no commits that are on no remote. */
const pushed = ws();
/** Two fixes committed here, not pushed yet. */
const fixedHere = ws({ status: { changed: 0, ahead: 4, behind: 0, unpushed: 2 } });

describe('an open PR’s blocker', () => {
  it('commits here the PR doesn’t have come first, before what GitHub says about an older commit', () => {
    expect(prBlocker(pr({ conflicts: true, checks: 'failing' }), fixedHere)).toBe('push');
    expect(prBlocker(pr({ conflicts: true, checks: 'failing' }), pushed)).toBe('resolve_pr');
    expect(prBlocker(pr({ checks: 'failing', checkRuns: [run('test', 'completed', 'failure'), run('e2e', 'in_progress')] }), pushed)).toBe('checks_running');
    expect(prBlocker(pr({ checks: 'failing', checkRuns: [run('test', 'completed', 'failure')] }), pushed)).toBe('fix_checks');
    expect(prBlocker(pr({ checks: 'pending' }), pushed)).toBeUndefined();
    expect(prBlocker(pr({ state: 'MERGED' }), fixedHere)).toBeUndefined();
    expect(prBlocker(undefined, fixedHere)).toBeUndefined();
  });
});

describe('branchState: the PR’s next step in plain words', () => {
  it('not pushed: a calm state that says GitHub’s view is old, with Push first and no stale Resolve or Fix', () => {
    const b = at(fixedHere, pr({ conflicts: true, checks: 'failing' }));
    expect([b.kind, b.label, b.tone]).toEqual(['not_pushed', '2 commits not on PR', 'info']);
    expect(b.detail).toBe('2 commits here aren’t on PR #366 yet: merging it now would leave them out, and what GitHub says it conflicts with main is for an older commit');
    expect(b.steps.map((s) => s.id)).toEqual(['push', 'merge_auto', 'open_pr']);
    expect(b.steps[0]).toMatchObject({ label: 'Push 2 Commits to PR #366' });
    expect(b.steps[0]?.claude).toBeUndefined();
    expect(b.pr).toEqual({ number: 366, state: 'OPEN' });
  });

  it('someone’s fork’s PR its author doesn’t let maintainers edit: Open Your Own PR, never a Push that can’t land (BLG-948)', () => {
    const b = at(fixedHere, pr({ fork: { owner: 'rstagi', repo: 'app', branch: 'feat/share', canPush: false } }));
    expect([b.kind, b.label]).toEqual(['not_pushed', '2 commits not on PR']);
    expect(b.detail).toBe('2 commits here aren’t on PR #366, and rstagi’s fork doesn’t let maintainers push to it');
    expect(b.steps.map((s) => s.id)).toEqual(['pr_own', 'open_pr']);
    expect(b.steps[0]).toMatchObject({ label: 'Open Your Own PR' });
    expect(b.steps[0]?.hint).toBe('A new pull request into main with PR #366’s commits and your 2 commits, on a branch of its own');
  });

  it('one that does: Push goes to the fork, and your own PR is the other way', () => {
    const b = at(fixedHere, pr({ fork: { owner: 'rstagi', repo: 'app', branch: 'feat/share', canPush: true } }));
    expect(b.steps.map((s) => s.id)).toEqual(['push', 'pr_own', 'open_pr']);
    expect(b.steps[0]?.hint).toContain('Pushes to feat/share on rstagi’s fork');
  });

  it('not pushed after failing checks says so, in the singular for one commit, and keeps Commit for what’s left', () => {
    const one = ws({ status: { changed: 3, ahead: 1, behind: 0, unpushed: 1 } });
    const b = at(one, pr({ checks: 'failing' }));
    expect(b.detail).toContain('1 commit here isn’t on PR #366 yet: merging it now would leave it out, and what GitHub says its checks failed is for an older commit');
    expect(b.steps.map((s) => s.id)).toEqual(['push', 'merge_auto', 'commit', 'open_pr']);
    expect(b.steps[0]?.label).toBe('Push 1 Commit to PR #366');
    expect(b.steps[0]?.hint).toContain('the 3 uncommitted changes stay here');
  });

  it('conflicts say what they’re with, and the step says what it resolves', () => {
    const b = at(pushed, pr({ conflicts: true }));
    expect([b.kind, b.label, b.tone]).toEqual(['conflicts', 'Conflicts with main', 'error']);
    expect(b.steps[0]).toMatchObject({ id: 'resolve_pr', label: 'Resolve Conflicts…', claude: true });
    expect(b.detail).toContain('conflicts with main');
  });

  it('gh’s word on a fork’s PR says whose fork, its branch there, and whether maintainers may push (BLG-948)', () => {
    const raw = { number: 488, url: 'u', state: 'OPEN', headRefName: 'feat/share', isCrossRepository: true, maintainerCanModify: false, headRepository: { name: 'beluga' }, headRepositoryOwner: { login: 'rstagi' } };
    expect(parsePr(JSON.stringify(raw))?.fork).toEqual({ owner: 'rstagi', repo: 'beluga', branch: 'feat/share', canPush: false });
    expect(parsePr(JSON.stringify({ ...raw, maintainerCanModify: true }))?.fork?.canPush).toBe(true);
    // Its own repository's PR, or one gh wasn't asked about: no fork.
    expect(parsePr(JSON.stringify({ ...raw, isCrossRepository: false }))).not.toHaveProperty('fork');
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN' }))).not.toHaveProperty('fork');
  });

  it('GitHub still working out mergeability (UNKNOWN) is never a conflict', () => {
    const unknown = parsePr(JSON.stringify({ number: 366, url: 'u', state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))!;
    expect(unknown).not.toHaveProperty('conflicts');
    expect(at(pushed, unknown).kind).not.toBe('conflicts');
    expect(at(pushed, unknown).steps.map((s) => s.id)).not.toContain('resolve_pr');
  });

  it('checks still running, one failed already: calm Checks running, Fix Checks only under the chevron', () => {
    const b = at(pushed, pr({ checks: 'failing', checkRuns: [run('test', 'completed', 'failure'), run('e2e', 'in_progress'), run('lint', 'queued')] }));
    expect([b.kind, b.label, b.tone]).toEqual(['checks_running', 'Checks running', 'wait']);
    expect(b.detail).toBe('PR #366’s checks are running: 2 checks still going, 1 failed so far');
    expect(b.steps.map((s) => s.id)).toEqual(['open_pr', 'fix_checks', 'merge_admin']);
  });

  it('checks that failed with nothing running: Fix Checks first, Re-run Failed Checks next', () => {
    const b = at(pushed, pr({ checks: 'failing', checkRuns: [run('test', 'completed', 'failure', 9), run('e2e', 'completed', 'success', 9)] }));
    expect([b.kind, b.tone]).toEqual(['checks_failing', 'error']);
    expect(b.detail).toBe('PR #366’s checks failed on its latest commit (test)');
    expect(b.steps.map((s) => s.id)).toEqual(['fix_checks', 'rerun_checks', 'open_pr', 'merge_admin']);
    expect(b.steps[0]).toMatchObject({ label: 'Fix Checks…', claude: true });
    expect(b.steps[1]).toMatchObject({ label: 'Re-run Failed Checks' });
    expect(b.steps[1]?.claude).toBeUndefined();
  });

  it('no Re-run when no failed check is a GitHub Actions run (a commit status from another service)', () => {
    const status: PrCheck = { name: 'ci/circle', state: 'completed', conclusion: 'failure', url: 'https://circleci.com/gh/o/r/1' };
    expect(at(pushed, pr({ checks: 'failing', checkRuns: [status] })).steps.map((s) => s.id)).toEqual(['fix_checks', 'open_pr', 'merge_admin']);
  });

  it('a local merge that stopped on conflicts says what it resolves too', () => {
    const b = branchState({ projects: [project(pushed)], gh: true, prs: {}, conflicts: { w1: ['a.ts'] } }, pushed)!;
    expect(b.steps[0]).toMatchObject({ id: 'merge_claude', label: 'Resolve Conflicts…' });
  });
});

describe('failedRunIds / rerunFailed', () => {
  it('the Actions runs behind the failed checks, each once; not the passing or running ones', () => {
    const checks = [run('a', 'completed', 'failure', 11), run('b', 'completed', 'timed_out', 11), run('c', 'completed', 'cancelled', 12), run('d', 'completed', 'success', 13), run('e', 'in_progress', undefined, 14)];
    expect(failedRunIds({ checkRuns: checks })).toEqual([11, 12]);
    expect(failedRunIds({})).toEqual([]);
  });

  it('runs gh run rerun --failed in the worktree', async () => {
    exec.calls.length = 0;
    await rerunFailed('/code/auth', 11);
    expect(exec.calls).toEqual([{ cmd: 'gh', args: ['run', 'rerun', '11', '--failed'], cwd: '/code/auth' }]);
  });
});

describe('runningRunIds / cancelRun', () => {
  it('the Actions runs behind the queued and running checks, each once; not finished ones or commit statuses', () => {
    const status: PrCheck = { name: 'vercel', state: 'in_progress', url: 'https://vercel.com/o/r/deploy' };
    const checks = [run('a', 'in_progress', undefined, 21), run('b', 'queued', undefined, 21), run('c', 'queued', undefined, 22), run('d', 'completed', 'success', 23), run('e', 'completed', 'failure', 24), status];
    expect(runningRunIds({ checkRuns: checks })).toEqual([21, 22]);
    expect(runningRunIds({})).toEqual([]);
  });

  it('runs gh run cancel in the worktree', async () => {
    exec.calls.length = 0;
    await cancelRun('/code/auth', 21);
    expect(exec.calls).toEqual([{ cmd: 'gh', args: ['run', 'cancel', '21'], cwd: '/code/auth' }]);
  });
});

/** A Workbench with one worktree whose PR lives in a stubbed GitHub. */
function bench(start: PullRequest, opts: { pushFails?: Error; dir?: string } = {}) {
  const store = new Store(initialState('t', 'ask'));
  const w: Record<string, unknown> = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'klaud/auth', path: opts.dir ?? '/code/auth', projectId: 'p1', status: { changed: 0, ahead: 2, behind: 0, unpushed: 2 } };
  const manager = {
    list: [{ id: 'p1', workspaces: [w] }],
    find: (id: string) => (id === w.id ? w : undefined),
    leavePull: async () => {
      w.branch = 'beluga/auth';
      return 'beluga/auth';
    },
  };
  const opened: Array<{ base: string; head: string; title: string; body: string }> = [];
  let github = start;
  const pushes: string[] = [];
  const forkPushes: string[] = [];
  const reruns: number[] = [];
  const toasts: Array<{ text: string; level?: string }> = [];
  let refreshed = 0;
  const wb = new Workbench({
    store,
    controller: { manager, refresh: async () => void refreshed++ } as unknown as WorkspaceController,
    notify: () => undefined,
    toast: (text, level) => void toasts.push({ text, level }),
    intend: () => undefined,
    askClaude: () => undefined,
    setPrefs: () => undefined,
    hasGh: async () => true,
    findPr: async () => github,
    remoteRef: () => undefined,
    pushToFork: async (_dir, fork, pull) => void forkPushes.push(`${fork.owner}/${fork.repo}:${fork.branch}#${pull}`),
    pushForPr: async (_dir, head) => {
      if (opts.pushFails) throw opts.pushFails;
      pushes.push(head);
      github = { ...github, checks: 'pending', checkRuns: [] };
      return 'pushed';
    },
    rerunFailed: async (_dir, id) => void reruns.push(id),
    createPr: async (_dir, made) => {
      opened.push({ base: made.base, head: made.head, title: made.title, body: made.body });
      return pr({ number: 77, title: made.title });
    },
  });
  store.dispatch({ type: 'gh', ok: true });
  store.dispatch({ type: 'pr', id: 'auth', pr: start });
  return { wb, store, opened, pushes, forkPushes, reruns, toasts, setGithub: (p: PullRequest) => void (github = p), refreshed: () => refreshed, pr: () => store.getState().prs.auth };
}

describe('Workbench.pushPr / rerunChecks', () => {
  it('Push pushes the branch, looks at the worktree and the PR again, and says the checks run again', async () => {
    const b = bench(pr({ number: 42, checks: 'failing' }));
    expect(await b.wb.pushPr('auth')).toEqual({ ok: true, message: 'Pushed klaud/auth: PR #42’s checks run again' });
    expect(b.pushes).toEqual(['klaud/auth']);
    expect(b.refreshed()).toBe(1);
    expect(b.pr()?.checks).toBe('pending');
    expect(b.toasts.at(-1)).toEqual({ text: 'Pushed klaud/auth: PR #42’s checks run again', level: 'success' });
  });

  it('a fork’s PR checked out here (BLG-756) isn’t pushed to origin: its branch lives on the fork', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-pull-'));
    try {
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'config'), '[branch "klaud/auth"]\n\tremote = origin\n\tmerge = refs/pull/9/head\n');
      const b = bench(pr({ number: 9, checks: 'failing' }), { dir });
      const out = await b.wb.pushPr('auth');
      expect(out.ok).toBe(false);
      expect(out.message).toBe('PR #9’s fork doesn’t let maintainers push to PR #9. Open Your Own PR puts your commits on a new pull request, with #9’s');
      expect(b.pushes).toEqual([]);
      expect(b.forkPushes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const forkDir = (n: number): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-pull-'));
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.git', 'config'), `[branch "klaud/auth"]\n\tremote = origin\n\tmerge = refs/pull/${n}/head\n`);
    return dir;
  };

  it('Open Your Own PR makes the branch yours and opens a PR that says what it builds on (BLG-948)', async () => {
    const dir = forkDir(488);
    try {
      const b = bench(pr({ number: 488, title: 'Share a plain chat', fork: { owner: 'rstagi', repo: 'app', branch: 'feat/share', canPush: false } }), { dir });
      const out = await b.wb.quickPr('auth', { own: true });
      expect(out).toEqual({ ok: true, message: 'Opened PR #77: Share a plain chat' });
      expect(b.opened).toHaveLength(1);
      expect(b.opened[0]).toMatchObject({ head: 'beluga/auth', title: 'Share a plain chat' });
      expect(b.opened[0]!.body.split('\n')[0]).toBe('Builds on #488 from rstagi’s fork, which doesn’t take pushes from maintainers.');
      expect(b.pr()?.number).toBe(77);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fork that lets maintainers edit its PR gets the push on its own branch (BLG-948)', async () => {
    const dir = forkDir(9);
    try {
      const b = bench(pr({ number: 9, fork: { owner: 'rstagi', repo: 'app', branch: 'feat/share', canPush: true } }), { dir });
      expect(await b.wb.pushPr('auth')).toEqual({ ok: true, message: 'Pushed to rstagi’s fork: PR #9’s checks run again' });
      expect(b.forkPushes).toEqual(['rstagi/app:feat/share#9']);
      expect(b.pushes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one that doesn’t pushes nothing and points at Open Your Own PR, with what GitHub says now kept', async () => {
    const dir = forkDir(9);
    try {
      // Saved before forks were told apart: GitHub is asked again, and its answer shows the right step.
      const b = bench(pr({ number: 9 }), { dir });
      b.setGithub(pr({ number: 9, fork: { owner: 'rstagi', repo: 'app', branch: 'feat/share', canPush: false } }));
      const out = await b.wb.pushPr('auth');
      expect(out).toEqual({ ok: false, message: 'rstagi’s fork doesn’t let maintainers push to PR #9. Open Your Own PR puts your commits on a new pull request, with #9’s' });
      expect(b.toasts.at(-1)?.level).toBe('info');
      expect(b.forkPushes).toEqual([]);
      expect(b.pr()?.fork?.canPush).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a push git refuses says why, and nothing else changes', async () => {
    const b = bench(pr({ number: 42, checks: 'failing' }), { pushFails: new Error('! [rejected] klaud/auth -> klaud/auth (fetch first)') });
    const out = await b.wb.pushPr('auth');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/^Couldn’t push klaud\/auth: /);
    expect(b.pr()?.checks).toBe('failing');
  });

  it('Re-run runs each failed Actions run once, then looks at the PR again', async () => {
    const b = bench(pr({ number: 42, checks: 'failing', checkRuns: [run('test', 'completed', 'failure', 77), run('e2e', 'completed', 'failure', 77), run('lint', 'completed', 'failure', 78)] }));
    expect(await b.wb.rerunChecks('auth')).toEqual({ ok: true, message: 'PR #42’s failed checks are running again' });
    expect(b.reruns).toEqual([77, 78]);
  });

  it('Re-run with nothing it can start again says so instead', async () => {
    const b = bench(pr({ number: 42, checks: 'failing', checkRuns: [{ name: 'ci/circle', state: 'completed', conclusion: 'failure' }] }));
    const out = await b.wb.rerunChecks('auth');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('open the PR to re-run them');
    expect(b.reruns).toEqual([]);
  });
});
