import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pushDefault, pushWords } from '../src/workspaces/push-main.js';

/**
 * Push main (BLG-985): what Straight to main committed to main in the main folder goes to origin
 * when you say so. Real repositories: a bare origin, the main folder, and a teammate who pushes.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let origin: string;
let repo: string;
let mate: string;

function commit(dir: string, file: string, text: string): void {
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', `change ${file}`);
}

function matePushes(file: string, text: string): void {
  git(mate, 'pull', '-q', '--ff-only');
  commit(mate, file, text);
  git(mate, 'push', '-q', 'origin', 'main');
}

const onOrigin = (file: string): string => git(origin, 'show', `main:${file}`);

beforeEach(() => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-push-')));
  origin = path.join(base, 'app.git');
  repo = path.join(base, 'app');
  mkdirSync(repo);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  // The repo's own identity: pushDefault's rebase commits, and a CI runner has none of its own.
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  commit(repo, 'a.txt', 'one\n');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  mate = path.join(base, 'mate');
  execFileSync('git', ['clone', '-q', origin, mate]);
});

describe('push main', () => {
  it('sends main’s own commits to origin', async () => {
    commit(repo, 'a.txt', 'two\n');
    commit(repo, 'b.txt', 'new\n');
    const out = await pushDefault(repo, 'origin/main');
    expect(out).toMatchObject({ kind: 'pushed', commits: 2, rebased: 0 });
    expect(onOrigin('b.txt')).toBe('new');
    expect(pushWords(out).text).toBe('Pushed 2 commits to origin/main');
  });

  it('has nothing to do when origin has it all', async () => {
    expect(await pushDefault(repo, 'origin/main')).toMatchObject({ kind: 'nothing' });
  });

  it('goes on top of a teammate’s new commits, keeping main a straight line', async () => {
    matePushes('m.txt', 'mate\n');
    commit(repo, 'b.txt', 'mine\n');
    const out = await pushDefault(repo, 'origin/main');
    expect(out).toMatchObject({ kind: 'pushed', commits: 1, rebased: 1 });
    expect(onOrigin('m.txt')).toBe('mate');
    expect(onOrigin('b.txt')).toBe('mine');
    // No merge commit: each commit has one parent.
    expect(git(origin, 'rev-list', '--min-parents=2', 'main')).toBe('');
    expect(pushWords(out).text).toContain('on top of 1 new commit there');
  });

  it('keeps your changes in the main folder, in files origin didn’t touch', async () => {
    matePushes('m.txt', 'mate\n');
    commit(repo, 'b.txt', 'mine\n');
    writeFileSync(path.join(repo, 'a.txt'), 'editing\n');
    expect(await pushDefault(repo, 'origin/main')).toMatchObject({ kind: 'pushed' });
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('editing\n');
  });

  it('touches nothing when origin changed a file you’re editing', async () => {
    matePushes('a.txt', 'mate\n');
    commit(repo, 'b.txt', 'mine\n');
    writeFileSync(path.join(repo, 'a.txt'), 'editing\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const out = await pushDefault(repo, 'origin/main');
    expect(out).toMatchObject({ kind: 'dirty', files: ['a.txt'] });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('editing\n');
  });

  it('undoes everything on a conflict with origin, and pushes nothing', async () => {
    matePushes('a.txt', 'mate\n');
    commit(repo, 'a.txt', 'mine\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const out = await pushDefault(repo, 'origin/main');
    expect(out).toMatchObject({ kind: 'conflict', files: ['a.txt'] });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(onOrigin('a.txt')).toBe('mate');
  });

  it('can’t put commits on top when the main folder is on another branch', async () => {
    matePushes('m.txt', 'mate\n');
    commit(repo, 'b.txt', 'mine\n');
    git(repo, 'switch', '-q', '-c', 'side');
    expect(await pushDefault(repo, 'origin/main')).toMatchObject({ kind: 'elsewhere', current: 'side' });
  });

  it('says why origin refused, never forcing', async () => {
    commit(repo, 'b.txt', 'mine\n');
    writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n', { mode: 0o755 });
    const out = await pushDefault(repo, 'origin/main');
    expect(out.kind).toBe('rejected');
    expect(pushWords(out).text).toBe('origin/main is protected, so it only takes pull requests');
  });

  it('has nowhere to go without a remote branch', async () => {
    git(repo, 'remote', 'remove', 'origin');
    expect(await pushDefault(repo, 'main')).toMatchObject({ kind: 'no_upstream' });
  });
});
