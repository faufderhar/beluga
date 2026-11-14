import { describe, expect, it, vi } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import type { PrCheck, PullRequest } from '../src/core/work-store.js';
import type { NoticeEvent } from '../src/core/notify.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { NO_CHECKS_GRACE_MS, PUSHED_HEAD_WAIT_MS, Workbench } from '../src/core/workbench.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
import type { MergeOptions } from '../src/workspaces/pr.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../src/core/session.js';
import { branchStep } from '../src/companion/branch-steps.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ impl: undefined as undefined | ((cmd: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string }), calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }> }));

// gh stubbed at the process boundary: what `gh pr merge` is run with, and what it answers.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], opts: { cwd?: string }, cb: ExecCb) => {
    exec.calls.push({ cmd, args, cwd: opts.cwd });
    const r = exec.impl?.(cmd, args) ?? { err: new Error('not mocked') };
    queueMicrotask(() => cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''));
  },
}));

const { explainMergeError, mergePr, deleteRemoteBranch, parsePr, prFromCommits, titleOfBranch } = await import('../src/workspaces/pr.js');
const { planGitOf } = await import('../src/core/plans/plan-git.js');

const pr = (more: Partial<PullRequest> = {}): PullRequest => ({ number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', title: 'Add auth', draft: false, checks: 'passing', ...more });

describe('mergePr / deleteRemoteBranch (gh stubbed)', () => {
  it('runs gh pr merge with the number and the way to merge, in the worktree', async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    await mergePr('/code/auth', 42, { method: 'squash' });
    await mergePr('/code/auth', 42, { method: 'rebase', auto: true });
    // Pinned to a commit (the sentinel's merge gate): GitHub refuses if the head moved.
    await mergePr('/code/auth', 42, { method: 'squash', matchHead: 'abc123' });
    expect(exec.calls).toEqual([
      { cmd: 'gh', args: ['pr', 'merge', '42', '--squash'], cwd: '/code/auth' },
      { cmd: 'gh', args: ['pr', 'merge', '42', '--rebase', '--auto'], cwd: '/code/auth' },
      { cmd: 'gh', args: ['pr', 'merge', '42', '--squash', '--match-head-commit', 'abc123'], cwd: '/code/auth' },
    ]);
  });

  it("a plan's pull request merges through the same mergePr, as a merge commit", async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    const controller = { manager: { repoProject: () => ({ root: '/code/app' }) } } as unknown as WorkspaceController;
    await planGitOf(controller).mergePr('app', 7);
    expect(exec.calls.filter((c) => c.args[0] === 'pr')).toEqual([{ cmd: 'gh', args: ['pr', 'merge', '7', '--merge'], cwd: '/code/app' }]);
  });

  it("throws gh's own words", async () => {
    exec.impl = () => ({ err: new Error('exit 1'), stderr: 'X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.\n' });
    await expect(mergePr('/code/auth', 42, { method: 'merge' })).rejects.toThrow(/cannot be cleanly created/);
  });

  it('deletes the branch on GitHub with git push, never gh --delete-branch', async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    await deleteRemoteBranch('/code/auth', 'klaud/auth');
    expect(exec.calls).toEqual([{ cmd: 'git', args: ['push', 'origin', '--delete', 'klaud/auth'], cwd: '/code/auth' }]);
  });
});

describe('explainMergeError', () => {
  // What gh prints when GitHub says no.
  const cases: Array<[string, string, RegExp]> = [
    ['X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.', 'conflicts', /conflicts with the base/],
    ['GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)', 'reviews', /approving review/],
    ['GraphQL: Changes requested by a reviewer (mergePullRequest)', 'reviews', /approving review/],
    ['GraphQL: Required status check "test" is expected. (mergePullRequest)', 'checks', /checks haven’t passed/],
    ['X Pull request #42 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.', 'blocked', /rules don’t allow/],
    ['GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)', 'auto_off', /Allow auto-merge/],
    ['GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)', 'method', /Squash merging isn’t allowed/],
    ['GraphQL: Pull Request is still a draft (mergePullRequest)', 'draft', /draft/],
    ['X Pull request #42 was already merged', 'closed', /isn’t open/],
    ['HTTP 403: Resource not accessible by integration', 'permission', /can’t merge/],
    ['error connecting to api.github.com\ncheck your internet connection', 'other', /error connecting to api\.github\.com$/],
  ];
  it.each(cases)('%s → %s', (text, reason, message) => {
    const out = explainMergeError(text, 'squash');
    expect(out.reason).toBe(reason);
    expect(out.message).toMatch(message);
  });
});

describe('parsePr: merge fields', () => {
  it('reads conflicts and auto-merge on open PRs only', () => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN', mergeable: 'CONFLICTING', autoMergeRequest: { mergeMethod: 'SQUASH' } }))).toMatchObject({ conflicts: true, autoMerge: true });
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE', autoMergeRequest: null }))).not.toHaveProperty('conflicts');
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'MERGED', mergeable: 'CONFLICTING', autoMergeRequest: {} }))).not.toHaveProperty('autoMerge');
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN', headRefOid: 'abc123' }))).toMatchObject({ head: 'abc123' });
  });
});

/** A Workbench with one worktree whose PR lives in a stubbed GitHub: merging changes what gh pr view says next. */
function bench(start: PullRequest | undefined, answer: (opts: MergeOptions) => PullRequest | Error, unpushed = 0, pushFails?: Error, at = '/code/auth') {
  const store = new Store(initialState('t', 'ask'));
  const ws: Record<string, unknown> = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'klaud/auth', path: at, projectId: 'p1', status: { changed: 0, ahead: 2, behind: 0 } };
  // Whether the PR's head holds HEAD's commits (pr.ts headCarries): unknown unless a test says.
  let carries: { head?: string; carries?: boolean } = {};
  const manager = { list: [{ id: 'p1', workspaces: [ws] }], find: (id: string) => (id === ws.id ? ws : undefined), setMergeWait: (_id: string, wait: unknown) => void (ws.mergeWhenReady = wait) };
  let clock = 1_000_000;
  let github = start;
  const merges: Array<{ dir: string; number: number; opts: MergeOptions }> = [];
  const deleted: string[] = [];
  const toasts: Array<{ text: string; level?: string }> = [];
  const notices: NoticeEvent[] = [];
  const views: string[] = [];
  const pushes: string[] = [];
  const cancels: number[] = [];
  const wb = new Workbench({
    store,
    controller: { manager, refresh: async () => undefined } as unknown as WorkspaceController,
    now: () => clock,
    notify: (e) => void notices.push(e),
    toast: (text, level) => void toasts.push({ text, level }),
    intend: () => undefined,
    askClaude: () => undefined,
    setPrefs: () => undefined,
    hasGh: async () => true,
    findPr: async (_dir, branch) => (views.push(branch), github),
    remoteRef: () => undefined,
    unpushedCommits: async () => unpushed,
    headCarries: async () => carries,
    pushForPr: async (_dir, head) => {
      if (pushFails) throw pushFails;
      pushes.push(head);
      unpushed = 0;
      return 'pushed';
    },
    mergePr: async (dir, number, opts) => {
      merges.push({ dir, number, opts });
      const next = answer(opts);
      if (next instanceof Error) throw next;
      github = next;
    },
    deleteRemoteBranch: async (_dir, branch) => void deleted.push(branch),
    cancelRun: async (_dir, run) => {
      // A run that finished meanwhile: gh says it can't be cancelled.
      if (run === 99) throw new Error('Cannot cancel a workflow run that is completed');
      cancels.push(run);
    },
  });
  store.dispatch({ type: 'gh', ok: true });
  if (start) store.dispatch({ type: 'pr', id: 'auth', pr: start });
  const github$ = (next: PullRequest | undefined): void => void (github = next);
  const later = (ms: number): void => void (clock += ms);
  const here = (next: typeof carries): void => void (carries = next);
  return { wb, store, ws, merges, pushes, cancels, deleted, toasts, notices, views, github: github$, later, here, pr: () => store.getState().prs.auth };
}

describe('Workbench.mergePr', () => {
  it('merges with gh and shows Merged at once, without a second "was merged" notice', async () => {
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    const out = await b.wb.mergePr('auth', { method: 'squash' });
    expect(out).toEqual({ ok: true, result: 'merged', message: 'Merged PR #42' });
    expect(b.merges).toEqual([{ dir: '/code/auth', number: 42, opts: { method: 'squash' } }]);
    expect(b.views).toEqual(['klaud/auth']);
    expect(b.pr()?.state).toBe('MERGED');
    expect(b.notices).toEqual([]);
    expect(b.toasts.at(-1)).toEqual({ text: 'Merged PR #42', level: 'success' });
  });

  it('Merge Now, Skipping Checks stops the checks still running once merged, and only then', async () => {
    const check = (state: PrCheck['state'], id: number, conclusion?: string): PrCheck => ({ name: `job-${id}`, state, ...(conclusion ? { conclusion } : {}), url: `https://github.com/o/r/actions/runs/${id}/job/1` });
    const running = pr({ checks: 'pending', checkRuns: [check('in_progress', 7), check('queued', 8), check('completed', 6, 'success'), check('in_progress', 99)] });
    // One started between Beluga's look and the merge: GitHub shows it after.
    const b = bench(running, () => pr({ state: 'MERGED', checkRuns: [check('in_progress', 7), check('queued', 9)] }));
    const out = await b.wb.mergePr('auth', { method: 'squash', admin: true });
    expect(out).toEqual({ ok: true, result: 'merged', message: 'Merged PR #42, and stopped its 3 running checks' });
    expect(b.cancels.sort()).toEqual([7, 8, 9]);
    // A plain merge, or a refused skip, leaves them running.
    const plain = bench(running, () => pr({ state: 'MERGED' }));
    await plain.wb.mergePr('auth', { method: 'squash' });
    const refused = bench(running, () => new Error('HTTP 403: Resource not accessible by integration'));
    await refused.wb.mergePr('auth', { method: 'squash', admin: true });
    expect([...plain.cancels, ...refused.cancels]).toEqual([]);
  });

  it('deletes the branch on GitHub only once merged', async () => {
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    await b.wb.mergePr('auth', { method: 'merge', deleteBranch: true });
    expect(b.deleted).toEqual(['klaud/auth']);
    const q = bench(pr({ checks: 'pending' }), () => pr({ state: 'MERGED' }));
    await q.wb.mergePr('auth', { method: 'merge', auto: true, deleteBranch: true });
    expect(q.deleted).toEqual([]);
  });

  it('Merge When Ready waits for the checks itself (never gh --auto), and merges once they pass', async () => {
    const b = bench(pr({ checks: 'pending' }), () => pr({ state: 'MERGED' }));
    const out = await b.wb.mergePr('auth', { method: 'squash', auto: true });
    expect(out).toEqual({ ok: true, result: 'queued', message: 'PR #42 merges once its checks pass' });
    await flush();
    expect(b.merges).toEqual([]);
    expect(b.ws.mergeWhenReady).toMatchObject({ number: 42, method: 'squash' });
    b.github(pr({ checks: 'passing' }));
    await b.wb.refreshPrs('auth');
    await flush();
    expect(b.merges.map((m) => m.opts)).toEqual([{ method: 'squash' }]);
    expect(b.ws.mergeWhenReady).toBeUndefined();
    expect(b.notices.map((n) => n.title)).toContain('PR #42 merged: its checks passed');
  });

  it('Merge When Ready stops, and says so, when a check fails or it conflicts', async () => {
    for (const bad of [pr({ checks: 'failing' }), pr({ conflicts: true })]) {
      const b = bench(pr({ checks: 'pending' }), () => pr({ state: 'MERGED' }));
      await b.wb.mergePr('auth', { method: 'squash', auto: true });
      b.github(bad);
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.merges).toEqual([]);
      expect(b.ws.mergeWhenReady).toBeUndefined();
      expect(b.notices.at(-1)).toMatchObject({ kind: 'problems', title: expect.stringMatching(/not merging it/) });
    }
  });

  it('with no checks yet, Merge When Ready gives them a moment to show up first', async () => {
    const b = bench(pr({ checks: 'none' }), () => pr({ state: 'MERGED' }));
    await b.wb.mergePr('auth', { method: 'merge', auto: true });
    await flush();
    expect(b.merges).toEqual([]);
    b.later(NO_CHECKS_GRACE_MS);
    await b.wb.refreshPrs('auth');
    await flush();
    expect(b.merges).toHaveLength(1);
  });

  it('Cancel Auto-Merge stops the wait', async () => {
    const b = bench(pr({ checks: 'pending' }), () => pr({ state: 'MERGED' }));
    await b.wb.mergePr('auth', { method: 'squash', auto: true });
    expect(await b.wb.cancelMergeWhenReady('auth')).toMatchObject({ ok: true });
    b.github(pr({ checks: 'passing' }));
    await b.wb.refreshPrs('auth');
    await flush();
    expect(b.merges).toEqual([]);
  });

  it('says why GitHub refused (a review is required), and looks at the PR again', async () => {
    const b = bench(pr({ review: 'REVIEW_REQUIRED' }), () => new Error('GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)'));
    const out = await b.wb.mergePr('auth', { method: 'squash' });
    expect(out).toMatchObject({ ok: false, reason: 'reviews' });
    expect(b.toasts.at(-1)?.level).toBe('error');
    expect(b.views).toEqual(['klaud/auth']);
    expect(b.pr()?.state).toBe('OPEN');
  });

  it('says when it conflicts', async () => {
    const b = bench(pr(), () => new Error('X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.'));
    expect(await b.wb.mergePr('auth', { method: 'rebase' })).toMatchObject({ ok: false, reason: 'conflicts' });
  });

  it('pushes commits that aren’t on GitHub yet before merging, so the merge has them', async () => {
    const b = bench(pr(), () => pr({ state: 'MERGED' }), 5);
    expect(await b.wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: true, result: 'merged' });
    expect(b.pushes).toEqual(['klaud/auth']);
    expect(b.merges).toHaveLength(1);
    expect(b.toasts.some((t) => /^Pushing 5 commits to klaud\/auth before merging PR #42/.test(t.text))).toBe(true);
    const auto = bench(pr({ checks: 'pending' }), () => pr({ state: 'MERGED' }), 1);
    auto.here({ head: 'fff6666', carries: false });
    expect(await auto.wb.mergePr('auth', { method: 'squash', auto: true })).toMatchObject({ ok: true, result: 'queued' });
    expect(auto.pushes).toEqual(['klaud/auth']);
    // Push and Merge When Ready: it waits for the commit it pushed, not GitHub's view of an older one.
    expect(auto.ws.mergeWhenReady).toMatchObject({ number: 42, head: 'fff6666' });
  });

  it('won’t merge when that push fails: the commits would be left out', async () => {
    for (const auto of [false, true]) {
      const b = bench(pr(), () => pr({ state: 'MERGED' }), 2, new Error('GitHub has commits on klaud/auth that this worktree doesn’t: bring them in first (git pull), or check who pushed there'));
      const out = await b.wb.mergePr('auth', { method: 'squash', ...(auto ? { auto } : {}) });
      expect(out).toMatchObject({ ok: false, reason: 'unpushed', message: expect.stringMatching(/^Couldn’t push 2 commits in auth, so PR #42 isn’t merged .*: GitHub has commits on klaud\/auth/) });
      expect(b.merges).toEqual([]);
      expect(b.ws.mergeWhenReady).toBeUndefined();
      expect(b.toasts.at(-1)?.level).toBe('error');
    }
  });

  describe('BLG-840: never a merge without the work it should carry', () => {
    it('merges only the head that has every commit here (--match-head-commit)', async () => {
      const b = bench(pr({ head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.here({ head: 'aaa1111', carries: true });
      expect(await b.wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: true, result: 'merged' });
      expect(b.pushes).toEqual([]);
      expect(b.merges.map((m) => m.opts)).toEqual([{ method: 'squash', matchHead: 'aaa1111' }]);
    });

    it('pushes when the PR’s head lacks commits here, even if origin/<branch> looks current, then merges what it pushed', async () => {
      const b = bench(pr({ head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.ws.status = { changed: 0, ahead: 11, behind: 0, unpushed: 3 };
      b.here({ head: 'bbb2222', carries: false });
      expect(await b.wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: true, result: 'merged' });
      expect(b.pushes).toEqual(['klaud/auth']);
      // Counted as the chip counts them: main merged in here isn't three more commits.
      expect(b.toasts.some((t) => t.text === 'Pushing 3 commits to klaud/auth before merging PR #42…')).toBe(true);
      expect(b.merges.map((m) => m.opts)).toEqual([{ method: 'squash', matchHead: 'bbb2222' }]);
    });

    it('a caller’s own head (a sentinel’s checked commit) wins', async () => {
      const b = bench(pr({ head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.here({ head: 'aaa1111', carries: true });
      await b.wb.mergePr('auth', { method: 'squash', matchHead: 'ccc3333' });
      expect(b.merges.map((m) => m.opts.matchHead)).toEqual(['ccc3333']);
    });

    it('Merge When Ready that has to push first waits for the new commits’ checks, then merges them', async () => {
      const b = bench(pr({ checks: 'pending', head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.here({ head: 'aaa1111', carries: true });
      await b.wb.mergePr('auth', { method: 'squash', auto: true });
      // The agent commits twice more here while the checks run; then the old commit's checks pass.
      b.ws.status = { changed: 0, ahead: 4, behind: 0, unpushed: 2 };
      b.here({ head: 'ddd4444', carries: false });
      b.later(1000);
      b.github(pr({ checks: 'passing', head: 'aaa1111' }));
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.pushes).toEqual(['klaud/auth']);
      expect(b.merges).toEqual([]);
      expect(b.ws.mergeWhenReady).toMatchObject({ number: 42, method: 'squash', since: 1_001_000, head: 'ddd4444' });
      expect(b.toasts.at(-1)).toEqual({ text: 'Pushed 2 commits to PR #42: it merges once their checks pass', level: 'success' });
      expect(b.notices.filter((n) => /merged|didn’t merge/.test(n.title))).toEqual([]);
      // GitHub hasn't caught up with the push: an older commit's failed checks don't stop the wait.
      b.ws.status = { changed: 0, ahead: 4, behind: 0 };
      b.github(pr({ checks: 'failing', head: 'aaa1111' }));
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.ws.mergeWhenReady).toMatchObject({ head: 'ddd4444' });
      expect(b.notices.filter((n) => /not merging/.test(n.title))).toEqual([]);
      // Now it has: the new head's checks pass.
      b.here({ head: 'ddd4444', carries: true });
      b.github(pr({ checks: 'passing', head: 'ddd4444' }));
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.merges.map((m) => m.opts)).toEqual([{ method: 'squash', matchHead: 'ddd4444' }]);
      expect(b.notices.map((n) => n.title)).toContain('PR #42 merged: its checks passed');
    });

    it('a pushed commit GitHub never shows stops the wait, and says so, instead of waiting forever', async () => {
      const b = bench(pr({ checks: 'pending', head: 'aaa1111' }), () => pr({ state: 'MERGED' }), 1);
      b.here({ head: 'bbb2222', carries: false });
      await b.wb.mergePr('auth', { method: 'squash', auto: true });
      expect(b.ws.mergeWhenReady).toMatchObject({ head: 'bbb2222' });
      b.github(pr({ checks: 'passing', head: 'aaa1111' }));
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.ws.mergeWhenReady).toBeDefined();
      b.later(PUSHED_HEAD_WAIT_MS);
      await b.wb.refreshPrs('auth');
      await flush();
      expect(b.merges).toEqual([]);
      expect(b.ws.mergeWhenReady).toBeUndefined();
      expect(b.notices.at(-1)).toMatchObject({ kind: 'problems', title: 'PR #42 still doesn’t have the commits pushed for it: not merging it' });
    });

    it('overlapping looks at a waiting PR merge it once, with no “didn’t merge” on top', async () => {
      const b = bench(pr({ checks: 'pending', head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.here({ head: 'aaa1111', carries: true });
      await b.wb.mergePr('auth', { method: 'squash', auto: true });
      b.github(pr({ checks: 'passing', head: 'aaa1111' }));
      await Promise.all([b.wb.refreshPrs('auth'), b.wb.refreshPrs('auth'), b.wb.refreshPrs('auth')]);
      await flush();
      expect(b.merges).toHaveLength(1);
      expect(b.notices.filter((n) => /didn’t merge/.test(n.title))).toEqual([]);
    });

    it('won’t merge someone’s fork PR that lacks commits here: it can’t push there, and says so', async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-forkpr-'));
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'config'), '[branch "klaud/auth"]\n\tmerge = refs/pull/7/head\n');
      const b = bench(pr({ head: 'aaa1111' }), () => pr({ state: 'MERGED' }), 1, undefined, dir);
      const out = await b.wb.mergePr('auth', { method: 'squash' });
      expect(out).toMatchObject({ ok: false, reason: 'unpushed', message: 'PR #42 is from someone’s fork, and merging it now would leave 1 commit here out. Open Your Own PR puts it on a new one, with #42’s' });
      expect(b.pushes).toEqual([]);
      expect(b.merges).toEqual([]);
    });

    it('the phone’s Merge goes through the same guard: pushed first, then that head merged', async () => {
      const b = bench(pr({ head: 'aaa1111' }), () => pr({ state: 'MERGED' }));
      b.ws.status = { changed: 0, ahead: 3, behind: 0, unpushed: 1 };
      b.here({ head: 'eee5555', carries: false });
      const phone = { store: b.store, workspaces: { manager: { find: (id: string) => (id === 'auth' ? b.ws : undefined) } }, workbench: b.wb } as unknown as Session;
      expect(await branchStep(phone, 'conv:ws:auth', 'merge_pr')).toEqual({ ok: true, message: 'Merged PR #42' });
      expect(b.pushes).toEqual(['klaud/auth']);
      expect(b.merges.map((m) => m.opts)).toEqual([{ method: 'squash', matchHead: 'eee5555' }]);
    });

    it('GitHub refusing because the head moved says so plainly', () => {
      expect(explainMergeError('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)')).toEqual({ reason: 'other', message: 'The pull request changed on GitHub since Beluga looked (a new push), so nothing merged. Look at it again, then merge.' });
    });
  });

  it('does nothing without an open PR, or while one merge is under way', async () => {
    expect(await bench(undefined, () => pr()).wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: false, reason: 'no_pr' });
    const merged = bench(pr({ state: 'MERGED' }), () => pr());
    expect(await merged.wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: false, reason: 'closed', message: 'PR #42 is already merged' });
    expect(merged.merges).toEqual([]);
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    const [first, second] = await Promise.all([b.wb.mergePr('auth', { method: 'squash' }), b.wb.mergePr('auth', { method: 'squash' })]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'busy' });
    expect(b.merges).toHaveLength(1);
  });
});

describe('Create PR without Claude', () => {
  it('titles a pull request from its commits', () => {
    expect(titleOfBranch('beluga/fix-login_redirect')).toBe('Fix login redirect');
    expect(prFromCommits('beluga/x', ['Add session auth'])).toEqual({ title: 'Add session auth', body: '' });
    expect(prFromCommits('beluga/add-auth', ['Second', 'First'])).toEqual({ title: 'Add auth', body: '- First\n- Second' });
  });

  it('pushes and opens it straight away, then shows it', async () => {
    const store = new Store(initialState('t', 'ask'));
    const ws = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'beluga/add-auth', base: 'origin/main', path: '/code/auth', projectId: 'p1', status: { changed: 0, ahead: 1, behind: 0 } };
    const manager = { list: [{ id: 'p1', workspaces: [ws] }], find: (id: string) => (id === ws.id ? ws : undefined), commitAll: vi.fn() };
    const made: unknown[] = [];
    exec.impl = (cmd, args) => (cmd === 'git' && args[0] === 'log' ? { stdout: 'Add session auth\n' } : { err: new Error('not mocked') });
    const wb = new Workbench({
      store,
      controller: { manager, refresh: async () => undefined, open: () => undefined } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => {
        throw new Error('Create PR never asks Claude');
      },
      setPrefs: () => undefined,
      remoteRef: () => undefined,
      createPr: async (_dir, p) => (made.push(p), pr({ number: 9, title: p.title })),
    });
    store.dispatch({ type: 'gh', ok: true });
    expect(await wb.quickPr('auth', { draft: true })).toMatchObject({ ok: true, message: 'Opened PR #9 as a draft: Add session auth' });
    expect(made).toEqual([{ base: 'main', head: 'beluga/add-auth', title: 'Add session auth', body: '', draft: true }]);
    expect(manager.commitAll).not.toHaveBeenCalled();
    expect(store.getState().prs.auth?.number).toBe(9);
  });

  it('opens it on the fork’s original, into the original’s default branch, when asked', async () => {
    const store = new Store(initialState('t', 'ask'));
    const ws = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'beluga/add-auth', base: 'origin/main', path: '/code/auth', projectId: 'p1', status: { changed: 0, ahead: 1, behind: 0 } };
    const fork = { host: 'github.com', owner: 'rstagi', repo: 'app', url: 'https://github.com/rstagi/app', branch: 'trunk', forkBranch: 'main' };
    const made: unknown[] = [];
    const toasts: string[] = [];
    exec.impl = (cmd, args) => (cmd === 'git' && args[0] === 'log' ? { stdout: 'Add session auth\n' } : { err: new Error('not mocked') });
    const wb = (projects: unknown[]) =>
      new Workbench({
        store,
        controller: { manager: { list: projects, find: (id: string) => (id === ws.id ? ws : undefined), commitAll: vi.fn() }, refresh: async () => undefined, open: () => undefined } as unknown as WorkspaceController,
        notify: () => undefined,
        toast: (text) => void toasts.push(text),
        intend: () => undefined,
        askClaude: () => undefined,
        setPrefs: () => undefined,
        remoteRef: () => undefined,
        createPr: async (_dir, p) => (made.push(p), pr({ number: 301, title: p.title, url: 'https://github.com/rstagi/app/pull/301' })),
      });
    store.dispatch({ type: 'gh', ok: true });
    expect(await wb([{ id: 'p1', workspaces: [ws], fork }]).quickPr('auth', { original: true })).toMatchObject({ ok: true, message: 'Opened PR #301 on rstagi/app: Add session auth' });
    expect(made).toEqual([{ base: 'trunk', head: 'beluga/add-auth', title: 'Add session auth', body: '', to: fork }]);
    // Not a fork: nothing is opened anywhere.
    expect(await wb([{ id: 'p1', workspaces: [ws] }]).quickPr('auth', { original: true })).toMatchObject({ ok: false });
    expect(made).toHaveLength(1);
  });
});
