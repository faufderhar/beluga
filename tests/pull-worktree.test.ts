import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import { pullOfBranch } from '../src/workspaces/github.js';
import { WorkspaceManager, pullName } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { screenOver } from './helpers.js';

/**
 * A pull request in a worktree (BLG-633), against real repositories: a bare origin with a
 * teammate's branch on it and a fork's pull ref (refs/pull/<n>/head, as GitHub keeps it), and the
 * project's main folder. Its own branch tracks origin's (a push updates it); a fork's gets pr-<n>.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string;
let repo: string;
let mate: string;
let store: Store;
let toasts: string[];
let mgr: WorkspaceManager;
let ctl: WorkspaceController;

function mateCommits(branch: string, file: string, text: string): string {
  git(mate, 'switch', '-q', '-C', branch, 'origin/main');
  writeFileSync(path.join(mate, file), text);
  git(mate, 'add', '.');
  git(mate, 'commit', '-q', '-m', `${branch}: ${file}`);
  return git(mate, 'rev-parse', 'HEAD').trim();
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-pull-')));
  const origin = path.join(base, 'app.git');
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), 'app\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  mate = path.join(base, 'mate');
  execFileSync('git', ['clone', '-q', origin, mate]);
  mateCommits('fix/email', 'email.ts', 'decode\n');
  git(mate, 'push', '-q', 'origin', 'fix/email');
  mateCommits('their-fork-branch', 'fork.ts', 'from a fork\n');
  git(mate, 'push', '-q', 'origin', 'their-fork-branch:refs/pull/7/head');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room'));
  toasts = [];
  mgr = new WorkspaceManager(wsStore);
  ctl = new WorkspaceController({ manager: mgr, store, shares: new ShareService([]), selfId: () => 'me', toast: (t) => void toasts.push(t), intend: screenOver(store).intend, askClaude: () => undefined });
  await ctl.refresh();
});

const pid = () => mgr.list.find((p) => p.root)!.id;
const said = (id: string) => store.getState().log.filter((l) => l.channel === `ws:${id}` && l.type === 'system').map((l) => (l.type === 'system' ? l.text : ''));

describe('a pull request in a worktree, shown at once (BLG-942)', () => {
  const pending = (id: string) => store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id);

  it('its row is there under the id the screen chose before GitHub has said which branch it is on', async () => {
    let answer!: (pull: { number: number; branch: string; title: string; base: string }) => void;
    const asked = new Promise<{ number: number; branch: string; title: string; base: string }>((r) => (answer = r));
    const job = ctl.openPull(pid(), 12, () => asked, { id: 'wt-0123456789ab' });
    await new Promise((r) => setTimeout(r, 0));
    expect(pending('wt-0123456789ab')).toMatchObject({ pending: true, name: 'pr-12' });
    answer({ number: 12, branch: 'fix/email', title: 'Decode emails', base: 'main' });
    const ws = await job;
    expect(ws!.id).toBe('wt-0123456789ab');
    expect(pending(ws!.id)?.pending).toBeUndefined();
  });

  it('GitHub failing takes its row away again, and says why', async () => {
    const job = ctl.openPull(pid(), 12, () => Promise.reject(new Error('gh is not signed in')), { id: 'wt-0123456789ac' });
    await expect(job).rejects.toThrow('gh is not signed in');
    expect(pending('wt-0123456789ac')).toBeUndefined();
  });

  it('the worktree already on its branch opens, once GitHub says which that is', async () => {
    const first = await ctl.openPull(pid(), 12, { number: 12, branch: 'fix/email' });
    const again = await ctl.openPull(pid(), 12, async () => ({ number: 12, branch: 'fix/email' }), { id: 'wt-0123456789ad' });
    expect(again!.id).toBe(first!.id);
    expect(pending('wt-0123456789ad')).toBeUndefined();
  });

  it('an id that is taken is not used', async () => {
    const first = await ctl.openPull(pid(), 12, { number: 12, branch: 'fix/email' }, { id: 'wt-0123456789ae' });
    expect(first!.id).toBe('wt-0123456789ae');
    // Another asking for the same id (a screen's mistake) gets one of its own: never the same worktree twice.
    const other = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', fork: true }, { id: 'wt-0123456789ae' });
    expect(other!.id).not.toBe('wt-0123456789ae');
    expect(other!.id).toMatch(/^wt-[0-9a-f-]{12}$/);
  });
});

describe('a pull request in a worktree', () => {
  it('checks out its own branch, tracking origin’s, compared with the branch it merges into', async () => {
    const ws = await ctl.openPull(pid(), 12, { number: 12, branch: 'fix/email', title: 'Decode emails', base: 'main' });
    expect(ws).toMatchObject({ kind: 'worktree', branch: 'fix/email', base: 'origin/main', name: 'pr-12-decode-emails' });
    expect(readFileSync(path.join(ws!.path, 'email.ts'), 'utf8')).toBe('decode\n');
    // A push there goes to the pull request's branch.
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/fix/email');
    expect(said(ws!.id).join(' ')).toMatch(/#12 “Decode emails”, checked out on fix\/email\. Pushing here updates the pull request/);
    expect(toasts.at(-1)).toMatch(/#12 is checked out/);
  });

  it('opens the worktree already on its branch instead of making another, and a double click makes one', async () => {
    const pull = { number: 12, branch: 'fix/email', title: 'Decode emails' };
    const [a, b] = await Promise.all([ctl.openPull(pid(), pull.number, pull), ctl.openPull(pid(), pull.number, pull)]);
    expect(a!.id).toBe(b!.id);
    const again = await ctl.openPull(pid(), pull.number, pull);
    expect(again!.id).toBe(a!.id);
    expect(mgr.list.find((p) => p.root)!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(1);
  });

  it('uses a local branch of that name as it is, caught up with origin when it can be', async () => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-q', 'fix/email', 'main');
    const ws = await ctl.openPull(pid(), 12, { number: 12, branch: 'fix/email' });
    expect(git(ws!.path, 'rev-parse', 'HEAD').trim()).toBe(git(repo, 'rev-parse', 'origin/fix/email').trim());
  });

  it('says where its branch is when it is checked out outside Beluga', async () => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'switch', '-q', '-c', 'fix/email', '--track', 'origin/fix/email');
    expect(await ctl.openPull(pid(), 12, { number: 12, branch: 'fix/email' })).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/Couldn't open #12 in a worktree: fix\/email is already checked out in/);
  });

  it('gets a fork’s from GitHub’s pull ref, on its branch’s name, and git pull keeps it current', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', title: 'From a fork', fork: true });
    expect(ws).toMatchObject({ branch: 'their-fork-branch', name: 'pr-7-from-a-fork' });
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('from a fork\n');
    expect(git(repo, 'config', 'branch.their-fork-branch.merge').trim()).toBe('refs/pull/7/head');
    // So its PR is looked up by number: gh finds no fork's PR by the branch's name alone.
    expect(pullOfBranch(ws!.path, ws!.branch!)).toBe(7);
    // The fork pushes again: git pull brings it.
    writeFileSync(path.join(mate, 'fork.ts'), 'more\n');
    git(mate, 'commit', '-q', '-am', 'more');
    git(mate, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    git(ws!.path, 'pull', '-q', '--ff-only');
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('more\n');
    expect(said(ws!.id).join(' ')).toMatch(/from a fork, so pushing here doesn’t change it/);
    // Opening it again finds that worktree.
    expect((await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', fork: true }))!.id).toBe(ws!.id);
  });

  it('a fork’s commits are on GitHub, so deleting it loses none of them; yours on top it warns about (BLG-746)', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', title: 'From a fork', fork: true });
    expect(await mgr.deletePlan(ws!.id)).toBeUndefined();
    await mgr.refresh();
    expect(mgr.find(ws!.id)?.status).toMatchObject({ ahead: 1 });
    expect(mgr.find(ws!.id)?.status?.unpushed).toBeUndefined();
    writeFileSync(path.join(ws!.path, 'mine.ts'), 'mine\n');
    git(ws!.path, 'add', '.');
    git(ws!.path, 'commit', '-q', '-m', 'mine');
    expect(await mgr.deletePlan(ws!.id)).toMatchObject({ unpushed: 1, subjects: ['mine'] });
    await mgr.remove(ws!.id);
    expect(git(repo, 'for-each-ref', 'refs/beluga/pulls').trim()).toBe('');
  });

  it('git pull keeps a fork’s kept head current, so the pull request’s new commits never read as not on it', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', fork: true });
    expect(git(repo, 'config', '--get-all', 'remote.origin.fetch')).toContain('+refs/pull/7/head:refs/beluga/pulls/7');
    writeFileSync(path.join(mate, 'fork.ts'), 'more\n');
    git(mate, 'commit', '-q', '-am', 'more');
    git(mate, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    git(ws!.path, 'pull', '-q', '--ff-only');
    expect(git(repo, 'rev-parse', 'refs/beluga/pulls/7').trim()).toBe(git(ws!.path, 'rev-parse', 'HEAD').trim());
    await mgr.refresh();
    expect(mgr.find(ws!.id)?.status).toMatchObject({ ahead: 2 });
    expect(mgr.find(ws!.id)?.status?.unpushed).toBeUndefined();
    // Gone with its branch: no fetch keeps bringing a pull request nothing here follows.
    await mgr.remove(ws!.id);
    expect(git(repo, 'config', '--get-all', 'remote.origin.fetch')).not.toContain('refs/pull/7/head');
  });

  it('a fork’s worktree made before it followed its head gets it on the next refresh', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', fork: true });
    git(repo, 'config', '--unset', 'remote.origin.fetch', '^\\+refs/pull/7/head:');
    // As a daemon started after it was made finds it.
    const fresh = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await fresh.refresh();
    expect(git(repo, 'config', '--get-all', 'remote.origin.fetch').trim().split('\n')).toEqual(['+refs/heads/*:refs/remotes/origin/*', '+refs/pull/7/head:refs/beluga/pulls/7']);
    // Once only, however often it's read.
    await fresh.refresh();
    expect(git(repo, 'config', '--get-all', 'remote.origin.fetch').trim().split('\n')).toHaveLength(2);
    expect(ws).toBeTruthy();
  });

  it('a fork’s that can’t be pushed to becomes a branch of your own, with every commit kept (BLG-948)', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', title: 'From a fork', fork: true });
    writeFileSync(path.join(ws!.path, 'mine.ts'), 'mine\n');
    git(ws!.path, 'add', '.');
    git(ws!.path, 'commit', '-q', '-m', 'mine');
    const head = git(ws!.path, 'rev-parse', 'HEAD').trim();
    expect(await mgr.leavePull(ws!.id)).toBe('beluga/pr-7-from-a-fork');
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('beluga/pr-7-from-a-fork');
    expect(git(ws!.path, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(pullOfBranch(ws!.path, 'beluga/pr-7-from-a-fork')).toBeUndefined();
    expect(git(repo, 'config', '--get-all', 'remote.origin.fetch')).not.toContain('refs/pull/7/head');
    expect(mgr.find(ws!.id)?.branch).toBe('beluga/pr-7-from-a-fork');
    // The fork's commit and yours: nothing on origin has them yet.
    expect(mgr.find(ws!.id)?.status?.unpushed).toBe(2);
    // Already yours: asked again, it stays as it is.
    expect(await mgr.leavePull(ws!.id)).toBe('beluga/pr-7-from-a-fork');
  });

  it('a fork’s worktree made before its head was kept fetches it before warning', async () => {
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'their-fork-branch', fork: true });
    git(repo, 'update-ref', '-d', 'refs/beluga/pulls/7');
    expect(await mgr.deletePlan(ws!.id)).toBeUndefined();
    expect(git(repo, 'rev-parse', 'refs/beluga/pulls/7').trim()).toBe(git(repo, 'rev-parse', 'their-fork-branch').trim());
  });

  it('puts a fork’s on pr-<n> when its branch’s name is taken here', async () => {
    git(repo, 'branch', '-q', 'patch-1');
    const ws = await ctl.openPull(pid(), 7, { number: 7, branch: 'patch-1', fork: true });
    expect(ws).toMatchObject({ branch: 'pr-7', name: 'pr-7' });
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('from a fork\n');
  });

  it('names it pr-<n> and the first whole words of its title', () => {
    expect(pullName({ number: 51, title: 'Decode emails safely in the user lookup' })).toBe('pr-51-decode-emails-safely');
    expect(pullName({ number: 3 })).toBe('pr-3');
  });

  it('says so when its branch is gone from origin, and leaves nothing behind', async () => {
    expect(await ctl.openPull(pid(), 9, { number: 9, branch: 'deleted/branch' })).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/deleted\/branch isn’t on origin/);
    expect(mgr.list.find((p) => p.root)!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(0);
  });
});
