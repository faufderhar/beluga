import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchState } from '../src/core/branch-state.js';
import type { PullRequest } from '../src/core/work-store.js';
import { status } from '../src/workspaces/git.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const ws = (over: Partial<Workspace> = {}): Workspace => ({ id: 'w1', projectRoot: '/r', projectId: 'p1', name: 'w', path: '/r/w', kind: 'worktree', createdAt: 0, branch: 'feat/x', base: 'main', external: false, status: { changed: 0, ahead: 2, behind: 0 }, ...over });
const project = (w: Workspace, sync?: Project['sync']): Project => ({ id: 'p1', name: 'app', root: '/r', base: 'main', workspaces: [w], ...(sync ? { sync } : {}) });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 12, url: 'u', state: 'OPEN', title: 't', draft: false, checks: 'passing', ...over });
const at = (w: Workspace, p?: PullRequest, extra: { gh?: boolean; conflicts?: string[] } = {}) =>
  branchState({ projects: [project(w)], gh: extra.gh ?? true, prs: p ? { [w.id]: p } : {}, conflicts: extra.conflicts ? { [w.id]: extra.conflicts } : {} }, w);

describe('branchState', () => {
  it('a merged PR is purple Merged, with Archive first and Continue After Merge next', () => {
    const b = at(ws(), pr({ state: 'MERGED' }))!;
    expect([b.kind, b.label, b.tone]).toEqual(['merged', 'Merged', 'merged']);
    expect(b.steps.map((s) => s.id)).toEqual(['archive', 'continue_after_merge', 'delete']);
  });

  it('work merged outside Beluga reads as Merged too', () => {
    expect(at(ws({ status: { changed: 0, ahead: 3, behind: 1, landed: true } }))?.kind).toBe('merged');
  });

  it('after Continue After Merge, the done PR’s commits in the base are nothing new, not Merged again', () => {
    const w = ws({ prDone: 12, status: { changed: 0, ahead: 3, behind: 0, landed: true } });
    const b = at(w)!;
    expect([b.kind, b.label]).toEqual(['clean', 'No changes']);
    expect(b.detail).toContain('PR #12');
    // New work since shows as such.
    expect(at(ws({ prDone: 12, status: { changed: 2, ahead: 3, behind: 0, landed: true } }))?.kind).toBe('uncommitted');
    expect(at(ws({ prDone: 12, status: { changed: 0, ahead: 4, behind: 0 } }))?.kind).toBe('unshipped');
  });

  it('an open PR GitHub can merge is Ready to merge, merged in one click', () => {
    const b = at(ws(), pr())!;
    expect([b.kind, b.tone, b.steps[0]?.id]).toEqual(['ready', 'ok', 'merge_pr']);
    expect(b.steps[0]?.claude).toBeUndefined();
  });

  it('conflicts lead with Claude resolving them', () => {
    const b = at(ws(), pr({ conflicts: true }))!;
    expect([b.kind, b.tone, b.steps[0]?.id, b.steps[0]?.claude]).toEqual(['conflicts', 'error', 'resolve_pr', true]);
  });

  it('a local merge that stopped on conflicts comes first of all', () => {
    expect(at(ws(), pr(), { conflicts: ['a.ts'] })?.steps[0]?.id).toBe('merge_claude');
  });

  it('failing checks, behind the base, a draft, running checks', () => {
    expect(at(ws(), pr({ checks: 'failing' }))?.steps[0]?.id).toBe('fix_checks');
    expect(at(ws(), pr({ mergeState: 'behind' }))?.steps[0]?.id).toBe('update_branch');
    expect(at(ws(), pr({ draft: true }))?.steps[0]?.id).toBe('mark_ready');
    expect(at(ws(), pr({ checks: 'pending' }))?.steps.map((s) => s.id).slice(0, 2)).toEqual(['merge_auto', 'merge_admin']);
  });

  it('no PR: on GitHub Create PR opens one straight away (Claude’s ways under it); without GitHub it merges here', () => {
    const b = at(ws())!;
    expect(b.steps.map((s) => s.id)).toEqual(['pr', 'pr_claude', 'pr_custom', 'pr_draft', 'merge_base', 'land_on']);
    expect([b.steps[0]?.label, b.steps[0]?.claude]).toEqual(['Create PR', undefined]);
    expect(at(ws({ status: { changed: 2, ahead: 0, behind: 0 } }))?.steps.map((s) => s.id)).toEqual(['pr', 'pr_claude', 'pr_custom', 'pr_draft', 'merge_base', 'commit', 'land_on']);
    const local = at(ws(), undefined, { gh: false })!;
    expect([local.label, local.steps[0]?.id]).toEqual(['Ready to merge', 'merge']);
  });

  it('nothing for the main folder or an archived worktree', () => {
    expect(at(ws({ kind: 'main' }))).toBeUndefined();
    expect(at(ws({ archived: true }))).toBeUndefined();
  });
});

describe('a fork (BLG-727)', () => {
  const fork = { host: 'github.com', owner: 'rstagi', repo: 'app', url: 'https://github.com/rstagi/app', branch: 'trunk', forkBranch: 'main' };
  const inFork = (w: Workspace, p?: PullRequest) => branchState({ projects: [{ ...project(w), fork }], gh: true, prs: p ? { [w.id]: p } : {}, conflicts: {} }, w);

  it('offers Create PR on the original among Create PR’s other ways, and only in a fork', () => {
    const step = inFork(ws())!.steps.find((x) => x.id === 'pr_original');
    expect(step).toMatchObject({ label: 'Create PR on rstagi/app' });
    expect(step?.hint).toContain('into rstagi/app’s trunk');
    expect(at(ws())!.steps.some((x) => x.id === 'pr_original')).toBe(false);
  });

  it('a PR on the original waits on its maintainers: Open PR first, merging only in the menu', () => {
    const b = inFork(ws(), pr({ url: 'https://github.com/rstagi/app/pull/301', number: 301 }))!;
    expect([b.kind, b.label, b.tone]).toEqual(['review', 'On rstagi/app', 'wait']);
    expect(b.steps.map((x) => x.id)).toEqual(['open_pr', 'merge_pr']);
    // The fork's own PR is as before.
    expect(inFork(ws(), pr({ url: 'https://github.com/kay/app/pull/4', number: 4 }))?.kind).toBe('ready');
    // Failing checks still lead with fixing them.
    expect(inFork(ws(), pr({ url: 'https://github.com/rstagi/app/pull/301', checks: 'failing' }))?.kind).toBe('checks_failing');
  });

  it('once merged on the original, says Sync Fork brings it home', () => {
    expect(inFork(ws(), pr({ url: 'https://github.com/rstagi/app/pull/301', number: 301, state: 'MERGED' }))?.detail).toBe('PR #301 merged into rstagi/app on GitHub: Sync Fork on the project’s home brings it into your fork’s main');
  });
});

describe('status notices work merged outside Beluga', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  const setup = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-landed-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    git('checkout', '-qb', 'feat');
    writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git('add', '.');
    git('commit', '-qm', 'two');
    writeFileSync(path.join(dir, 'b.txt'), 'three\n');
    git('commit', '-qam', 'three');
  };

  it('not yet merged: ahead, not landed', async () => {
    setup();
    const st = await status(dir, 'main');
    expect([st.ahead, st.landed]).toEqual([2, undefined]);
  });

  it('squash-merged into the base: landed', async () => {
    setup();
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feat');
    git('commit', '-qm', 'squashed');
    git('checkout', '-q', 'feat');
    const st = await status(dir, 'main');
    expect([st.ahead, st.landed]).toEqual([2, true]);
  });
});
