import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropGitEnv, gitLocalEnvNames, repoDamage, repoSnapshot } from '../scripts/test-repo-guard.mjs';

/**
 * BLG-867: a worktree made in another worktree's scratch folder lost its uncommitted work while the
 * root suite ran in it. The suite now runs without git's own variables (a run started from inside git
 * sent every fixture's git to the repository around it), and fails when the worktree it ran in is gone.
 */

let base: string;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repo, a worktree of it, and a worktree made in that worktree's scratch folder (as on 2026-11-09). → the nested one */
function nestedWorktree(): { repo: string; outer: string; nested: string } {
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  const outer = path.join(base, 'workspaces', 'outer');
  git(repo, 'worktree', 'add', '-q', '-b', 'outer', outer);
  const nested = path.join(outer, '.beluga', 'scratch', 'pm');
  git(outer, 'worktree', 'add', '-q', '-b', 'pm', nested);
  writeFileSync(path.join(nested, 'work.txt'), 'not committed yet\n');
  return { repo, outer, nested };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-repo-guard-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the suite leaves the repository it runs in alone', () => {
  it('runs without git’s own variables, whatever started it', () => {
    expect(gitLocalEnvNames()).toEqual(expect.arrayContaining(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']));
    // This very worker: the guard dropped them before any worker started.
    expect(gitLocalEnvNames().filter((name) => process.env[name] !== undefined)).toEqual([]);
    // And it runs first, so nothing before it ran with them.
    expect(readFileSync('vitest.config.ts', 'utf8')).toMatch(/globalSetup: \['scripts\/test-repo-guard\.mjs'/);
  });

  it('drops what `git rebase -x` hands the suite, so a fixture’s git stays in the fixture', () => {
    const { repo, nested } = nestedWorktree();
    const env: Record<string, string | undefined> = { ...process.env, GIT_DIR: git(nested, 'rev-parse', '--absolute-git-dir'), GIT_PREFIX: '' };
    // With GIT_DIR inherited, a fixture's `git init` lands in the nested worktree's repository.
    const fixture = path.join(base, 'fixture');
    mkdirSync(fixture);
    expect(dropGitEnv(env).sort()).toEqual(['GIT_DIR', 'GIT_PREFIX']);
    execFileSync('git', ['init', '-q', '--bare'], { cwd: fixture, env });
    expect(git(repo, 'config', '--bool', 'core.bare')).toBe('false');
    expect(git(fixture, 'config', '--bool', 'core.bare')).toBe('true');
  });

  it('says nothing when the worktree it ran in is as it was', () => {
    const { nested } = nestedWorktree();
    const before = repoSnapshot(nested);
    expect(before).toMatchObject({ top: nested, bare: false });
    expect(repoDamage(before)).toEqual([]);
    expect(repoDamage(repoSnapshot(base))).toEqual([]); // outside git: nothing to watch
  });

  it('fails the run when the worktree it ran in was removed, folder and git record both', () => {
    const { outer, nested } = nestedWorktree();
    const before = repoSnapshot(nested)!;
    git(outer, 'worktree', 'remove', '--force', nested);
    const problems = repoDamage(before);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(`the worktree it ran in is gone: ${nested}`);
    expect(problems[1]).toContain('its git folder is gone');
  });

  it('fails the run when its repository was made bare', () => {
    const { repo, nested } = nestedWorktree();
    const before = repoSnapshot(nested)!;
    git(repo, 'config', 'core.bare', 'true');
    expect(repoDamage(before)).toEqual([`its repository was made bare: ${nested}`]);
  });
});
