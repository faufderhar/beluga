import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { belugaEnv } from '../core/beluga-env.js';
import * as g from './git.js';

/**
 * Facts about a worktree Beluga didn't make (from Conductor, Claude Code, a script): when it
 * was made, its last commit, whether everything on it is already merged, and whether it's
 * safe to tidy away. Removing one keeps its branch, so nothing committed is ever lost.
 */

export interface WorktreeFacts {
  /** The folder is gone but git still lists it. */
  readonly missing: boolean;
  readonly branch?: string;
  readonly detached: boolean;
  /** When the worktree was added (its folder in .git/worktrees was born). */
  readonly createdAt?: number;
  readonly lastCommit?: { readonly at: number; readonly subject: string };
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
  /** Everything on it is already in its base branch. */
  readonly merged: boolean;
  /** Its branch tracked a remote branch that's been deleted (usually: the pull request merged). */
  readonly upstreamGone: boolean;
}

export type StaleReason = 'missing' | 'gone' | 'merged';

/** Why a worktree can go without losing anything, or undefined when it has work of its own. */
export function staleReason(f: Pick<WorktreeFacts, 'missing' | 'changed' | 'merged' | 'upstreamGone'>): StaleReason | undefined {
  if (f.missing) return 'missing';
  if (f.changed > 0) return undefined;
  if (f.upstreamGone) return 'gone';
  if (f.merged) return 'merged';
  return undefined;
}

export function staleText(reason: StaleReason, base: string): string {
  switch (reason) {
    case 'missing':
      return 'Its folder is already gone; git still lists it';
    case 'gone':
      return 'Its remote branch was deleted (the pull request was likely merged)';
    case 'merged':
      return `Everything on it is already in ${base}`;
  }
}

const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => g.git(cwd, args, 15_000).then((s) => s, () => undefined);

/** When a worktree was added (its admin folder in .git/worktrees, else its own folder, was born). */
export async function bornAt(dir: string): Promise<number | undefined> {
  // The worktree's own folder inside the repo's .git/worktrees is made by `git worktree add`.
  const admin = (await tryGit(dir, ['rev-parse', '--absolute-git-dir']))?.trim();
  for (const p of [admin, dir]) {
    if (!p) continue;
    const st = await stat(p).catch(() => undefined);
    const t = st ? (st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs) : undefined;
    if (t) return Math.round(t);
  }
  return undefined;
}

/** The worktree's admin folder in the repo's .git/worktrees, from its `.git` file (no git process). */
async function adminDir(dir: string): Promise<string | undefined> {
  const text = await readFile(path.join(dir, '.git'), 'utf8').catch(() => undefined);
  const at = text ? /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() : undefined;
  return at ? path.resolve(dir, at) : undefined;
}

/**
 * When something last happened in a worktree, as git sees it: a commit or checkout (its HEAD
 * log), staging (its index), or switching branches (HEAD). Cheap: a few `stat`s, no git process.
 */
export async function touchedAt(dir: string): Promise<number | undefined> {
  const admin = await adminDir(dir);
  const files = admin ? [path.join(admin, 'logs', 'HEAD'), path.join(admin, 'index'), path.join(admin, 'HEAD')] : [path.join(dir, '.git')];
  const times = await Promise.all(files.map((f) => stat(f).then((st) => st.mtimeMs, () => 0)));
  const latest = Math.max(0, ...times);
  return latest > 0 ? Math.round(latest) : undefined;
}

/** Look at one worktree (read-only git calls, without taking the index lock). */
export async function worktreeFacts(ws: { readonly path: string; readonly branch?: string }, base: string): Promise<WorktreeFacts> {
  if (!existsSync(ws.path)) return { missing: true, ...(ws.branch ? { branch: ws.branch } : {}), detached: !ws.branch, changed: 0, ahead: 0, behind: 0, merged: false, upstreamGone: false };
  const [status, last, merged, branch, createdAt] = await Promise.all([
    g.status(ws.path, base).catch(() => ({ changed: 0, ahead: 0, behind: 0 })),
    tryGit(ws.path, ['log', '-1', '--format=%ct%x09%s']),
    g.git(ws.path, ['merge-base', '--is-ancestor', 'HEAD', base], 15_000).then(() => true, () => false),
    tryGit(ws.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s?.trim() || undefined),
    bornAt(ws.path),
  ]);
  const track = branch ? (await tryGit(ws.path, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`]))?.trim() : undefined;
  const [at, ...subject] = (last ?? '').trim().split('\t');
  return {
    missing: false,
    ...(branch ? { branch } : {}),
    detached: !branch,
    ...(createdAt ? { createdAt } : {}),
    ...(at && Number(at) ? { lastCommit: { at: Number(at) * 1000, subject: subject.join('\t') } } : {}),
    changed: status.changed,
    ahead: status.ahead,
    behind: status.behind,
    merged,
    upstreamGone: track === '[gone]',
  };
}

/** Folders set aside by removeWorktreeKeepingBranch, still being deleted. */
const deleting = new Set<Promise<void>>();

/** Resolves once every folder set aside so far is deleted (or given up on). */
export const deletesSettled = (): Promise<void> => Promise.all([...deleting]).then(() => undefined);

const run = (cmd: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile(cmd, [...args], (err) => (err ? reject(err) : resolve())));

/**
 * Delete a folder nobody uses any more, at the lowest disk priority (macOS's background QoS,
 * else nice): a worktree's node_modules can be hundreds of thousands of files, and deleting
 * them at full speed stalls the whole Mac. Read-only files (some package caches) are made
 * writable for a second try; whatever still can't go is left where it was set aside.
 *
 * BELUGA_DELETE_PRIORITY=normal deletes at normal priority instead: the tests set it, as with a
 * whole suite keeping every core and the disk busy, macOS holds a background delete of even a
 * few files back for tens of seconds, and a test waiting on it (deletesSettled) runs out of time.
 */
function deleteInBackground(dir: string): void {
  const low = belugaEnv('DELETE_PRIORITY') !== 'normal';
  const rmrf = (): Promise<void> =>
    (process.platform === 'win32'
      ? Promise.reject(new Error('no rm'))
      : !low
        ? run('rm', ['-rf', dir])
        : process.platform === 'darwin'
          ? run('/usr/sbin/taskpolicy', ['-b', '/bin/rm', '-rf', dir])
          : run('nice', ['-n', '19', 'rm', '-rf', dir])
    ).catch(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const job: Promise<void> = rmrf()
    .catch(() => (process.platform === 'win32' ? run('attrib', ['-R', `${dir}\\*`, '/S', '/D']) : run('chmod', ['-R', 'u+w', dir])).then(rmrf))
    .catch(() => undefined)
    .finally(() => deleting.delete(job));
  deleting.add(job);
}

const SET_ASIDE = /^\..+\.removing-\d+$/;
const asideOf = (dir: string): string => path.join(path.dirname(dir), `.${path.basename(dir)}.removing-${Date.now()}`);

/** Windows refuses a folder rename for a moment while it's held (Defender or the indexer reading files just made). */
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_WAITS_MS = [50, 100, 200, 400, 800];

/** Rename a folder; on Windows, held a moment, tried again a few times (as graceful-fs does) before giving up. */
export async function renameFolder(from: string, to: string, { platform = process.platform, move = rename }: { platform?: NodeJS.Platform; move?: typeof rename } = {}): Promise<void> {
  for (const wait of platform === 'win32' ? RENAME_WAITS_MS : []) {
    try {
      return await move(from, to);
    } catch (err) {
      if (!HELD.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  await move(from, to);
}

/** Delete a folder that isn't a worktree (any more) without waiting: set aside, then deleted in the background. */
export async function deleteFolderInBackground(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const aside = asideOf(dir);
  await renameFolder(dir, aside);
  deleteInBackground(aside);
}

/**
 * Finish what an earlier background delete couldn't (something still wrote in it, or Beluga quit
 * first): the set-aside folders in these folders. Each folder looked in once per run.
 */
const swept = new Set<string>();
export async function sweepSetAside(parents: Iterable<string>): Promise<void> {
  for (const parent of parents) {
    if (swept.has(parent)) continue;
    swept.add(parent);
    const names = await readdir(parent).catch(() => [] as string[]);
    for (const name of names) if (SET_ASIDE.test(name)) deleteInBackground(path.join(parent, name));
  }
}

/** Git would remove it as is: nothing uncommitted or untracked, no submodules, not locked. */
async function cleanEnough(dir: string): Promise<boolean> {
  const admin = await adminDir(dir);
  if (!admin || existsSync(path.join(admin, 'locked')) || existsSync(path.join(dir, '.gitmodules'))) return false;
  const status = await tryGit(dir, ['status', '--porcelain', '--ignore-submodules=none']);
  return status !== undefined && !status.trim();
}

/**
 * Remove a worktree's folder and git's record of it; its branch stays. Refuses when it has
 * uncommitted changes unless `force` (you confirmed losing them).
 *
 * Quick whatever its size: the folder is renamed aside (instant on the same disk), git forgets
 * it, and the files are deleted in the background. Letting `git worktree remove` delete a big
 * folder took minutes, slowed the Mac down, and its time limit could stop it halfway ("Directory
 * not empty").
 */
export async function removeWorktreeKeepingBranch(repo: string, dir: string, force: boolean): Promise<void> {
  if (!existsSync(dir)) {
    // Folder already gone: newer git removes the record directly; older git only prunes.
    await g.removeWorktree(repo, dir).catch(() => g.git(repo, ['worktree', 'prune']));
    return;
  }
  // Git's own checks still decide what may go without `force`: it refuses with its own message.
  if (!force && !(await cleanEnough(dir))) return g.removeWorktree(repo, dir, false);
  const aside = asideOf(dir);
  try {
    await renameFolder(dir, aside);
  } catch {
    return g.removeWorktree(repo, dir, force); // something holds it: the slow way
  }
  try {
    await g.removeWorktree(repo, dir, true);
  } catch (err) {
    await rename(aside, dir).catch(() => undefined); // git still lists it: put it back
    throw err;
  }
  deleteInBackground(aside);
}
