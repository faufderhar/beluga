import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, tryGit } from './git.js';

/**
 * How a worktree was when you sent each message (BLG-385), so editing one can put its files back
 * the way they were then, or fork from there. A snapshot is a commit kept under a hidden ref: its
 * parent is HEAD and its tree every file git doesn't ignore, staged or not. Making one touches
 * nothing: not the branch, not the index, not a file.
 */

const PROMPTS = 'refs/beluga/prompts';
const BEFORE = 'refs/beluga/before-edit';
/** Who made a snapshot commit (git asks, and the machine may have no name set). */
const WHO = { GIT_AUTHOR_NAME: 'Beluga', GIT_AUTHOR_EMAIL: 'beluga@localhost', GIT_COMMITTER_NAME: 'Beluga', GIT_COMMITTER_EMAIL: 'beluga@localhost' };

const safe = (part: string): string => part.replace(/[^\w-]/g, '').slice(0, 80);

/** The ref a workspace's message keeps its snapshot under. */
export const promptRef = (wsId: string, promptId: string): string => `${PROMPTS}/${safe(wsId)}/${safe(promptId)}`;

/** Where a fork's copy of the uncommitted work is kept while the fork is made (gone once it is). */
export const forkRef = (wsId: string): string => `refs/beluga/fork/${safe(wsId)}`;

/** Keep how the worktree in `dir` is now under `ref`. Resolves the snapshot's commit. */
export async function snapshot(dir: string, ref: string, message = 'Beluga: before a message'): Promise<string> {
  const head = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).trim();
  // A throwaway index, started from the real one so unchanged files aren't read again.
  const index = path.join(os.tmpdir(), `beluga-snap-${randomUUID()}`);
  const real = (await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))?.trim();
  const env = { GIT_INDEX_FILE: index };
  try {
    if (!real || !(await copyFile(real, index).then(() => true, () => false))) await git(dir, ['read-tree', head], 60_000, env);
    await git(dir, ['add', '-A', '--', '.'], 120_000, env);
    const tree = (await git(dir, ['write-tree'], 60_000, env)).trim();
    const commit = (await git(dir, ['commit-tree', tree, '-p', head, '-m', message], 60_000, WHO)).trim();
    await git(dir, ['update-ref', ref, commit]);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

/** The commit a ref keeps, when it's there. */
export async function snapshotAt(dir: string, ref: string): Promise<string | undefined> {
  return (await tryGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() || undefined;
}

/** The commit a snapshot was taken on (its parent). */
export async function snapshotBase(dir: string, commit: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--verify', `${commit}^`])).trim();
}

/**
 * Lay a snapshot's files over the worktree in `dir`, whose HEAD is already the snapshot's base:
 * the files become the snapshot's, the index stays HEAD's (what was uncommitted is uncommitted again).
 */
export async function applySnapshot(dir: string, commit: string): Promise<void> {
  await git(dir, ['read-tree', '-u', '--reset', commit], 120_000);
  await git(dir, ['reset', '-q'], 60_000);
}

/**
 * Put the worktree in `dir` back the way the snapshot has it: the branch goes back to where it was
 * (commits made since are undone), files made since go (ignored ones stay: dependencies, Scratch),
 * and every file is as it was. How it was just before is kept first, under a ref of its own.
 * Resolves that ref.
 */
export async function restoreSnapshot(dir: string, wsId: string, commit: string): Promise<string> {
  const before = `${BEFORE}/${safe(wsId)}/${Date.now()}`;
  await snapshot(dir, before, 'Beluga: before going back to an earlier message');
  await git(dir, ['reset', '-q', '--hard', await snapshotBase(dir, commit)], 120_000);
  await git(dir, ['clean', '-fdq'], 120_000);
  await applySnapshot(dir, commit);
  return before;
}

/** Forget a workspace's snapshots (it was deleted). */
export async function dropSnapshots(dir: string, wsId: string): Promise<void> {
  const refs = (await tryGit(dir, ['for-each-ref', '--format=%(refname)', `${PROMPTS}/${safe(wsId)}/`, `${BEFORE}/${safe(wsId)}/`]))?.split('\n').filter(Boolean) ?? [];
  for (const ref of refs) await tryGit(dir, ['update-ref', '-d', ref]);
}
