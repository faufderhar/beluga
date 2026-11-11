import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { HTTPS_BROKEN } from '../shared/git-trouble.js';
import { GitError, conflictedFiles, git, tryGit } from './git.js';
import { forgetSshRoute, rememberSshRoute, routedOverSsh, sshArgsFor } from './ssh-routes.js';

/**
 * Keeping a project's main folder up to date with its remote: fetching (never asking for a
 * password: git fails instead, and we say why), fast-forwarding the default branch, and setting
 * uncommitted changes aside and back (by the stash's own hash: the stash list is shared with
 * every worktree, so "the top entry" may be someone else's). Never pushes, never discards.
 */

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `https_broken`: git's https helper itself fails on this computer (a library mismatch), whatever the login. */
export type FetchProblem = 'auth' | 'offline' | 'no_remote' | 'https_broken' | 'other';

export interface FetchFailure {
  readonly reason: FetchProblem;
  /** One sentence for the screen. */
  readonly message: string;
  /** git's own words. */
  readonly detail: string;
}

const AUTH = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|returned error: 40[13]|access denied|invalid username or password|repository not found|support for password authentication was removed|could not read from remote repository/i;
const OFFLINE = /could not resolve host|couldn't connect|failed to connect|network is unreachable|operation timed out|connection (refused|timed out|reset)|no route to host|temporary failure in name resolution/i;

/** What a failed fetch means, in words (auth and network trouble get their own advice). */
export function classifyFetchError(raw: string, remote = 'origin'): FetchFailure {
  const detail = raw.trim().split('\n').filter(Boolean).slice(-3).join('\n');
  if (HTTPS_BROKEN.test(raw))
    return {
      reason: 'https_broken',
      message: `git can’t use https on this computer (its https helper fails, usually mismatched libraries). Give ${remote} an SSH address with a key this computer has, or let your agent look into it.`,
      detail,
    };
  // "Could not read from remote repository" comes with both: the network reason wins.
  if (OFFLINE.test(raw)) return { reason: 'offline', message: `Couldn’t reach ${remote}. Check your connection and try again.`, detail };
  if (AUTH.test(raw))
    return {
      reason: 'auth',
      message: `${remote} wants you to sign in, and Beluga never asks for passwords. Run “git fetch” once in Terminal (or check your SSH key or credential helper), then try again.`,
      detail,
    };
  if (/no such remote|does not appear to be a git repository|not a valid remote/i.test(raw)) return { reason: 'no_remote', message: `There’s no remote called ${remote} to fetch from.`, detail };
  return { reason: 'other', message: `Couldn’t fetch from ${remote}: ${detail.split('\n').at(-1) ?? 'git failed'}`, detail };
}

export type FetchResult = { readonly ok: true; readonly remoteDefault?: string } | ({ readonly ok: false } & FetchFailure);

/** One `git fetch`, never prompting → git's words when it failed. */
async function fetchOnce(repo: string, remote: string, extra: readonly string[] = []): Promise<string | undefined> {
  try {
    await git(repo, [...extra, '-c', 'credential.interactive=never', 'fetch', '--prune', '--no-recurse-submodules', remote], 90_000);
    return undefined;
  } catch (err) {
    return errText(err);
  }
}

/**
 * Fetch, and when an https remote on GitHub, GitLab or Bitbucket fails (git can't sign in, its
 * https helper is broken, anything but no network), try once more over SSH: someone who only uses
 * SSH keys gets their fetch, no question asked, and from then on every command that reaches that
 * remote goes over SSH too (ssh-routes.ts). → why it failed, or undefined when it worked.
 */
async function fetchWithFallback(repo: string, remote: string): Promise<FetchFailure | undefined> {
  const url = (await tryGit(repo, ['remote', 'get-url', remote]))?.trim();
  let raw = await fetchOnce(repo, remote);
  if (raw === undefined) return undefined;
  // Routed over SSH, and SSH stopped working: https again, as configured.
  if (url && routedOverSsh(url)) {
    forgetSshRoute(url);
    raw = await fetchOnce(repo, remote);
    if (raw === undefined) return undefined;
  }
  const failure = classifyFetchError(raw, remote);
  const ssh = sshArgsFor(url);
  if (!url || !ssh || failure.reason === 'offline' || failure.reason === 'no_remote') return failure;
  if ((await fetchOnce(repo, remote, ssh)) !== undefined) return failure;
  rememberSshRoute(url, failure.reason === 'https_broken');
  return undefined;
}

/**
 * `git fetch --prune <remote>`, never prompting (over SSH when https can't and SSH can). Also learns
 * the remote's default branch when origin/HEAD isn't set.
 */
export async function fetchRemote(repo: string, remote = 'origin'): Promise<FetchResult> {
  const failed = await fetchWithFallback(repo, remote);
  if (failed) return { ok: false, ...failed };
  if (await tryGit(repo, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])) return { ok: true };
  const symref = await tryGit(repo, ['ls-remote', '--symref', remote, 'HEAD']);
  const remoteDefault = symref ? parseSymref(symref) : undefined;
  return remoteDefault ? { ok: true, remoteDefault } : { ok: true };
}

/** "ref: refs/heads/main\tHEAD" (from `git ls-remote --symref origin HEAD`) → "main". */
export function parseSymref(out: string): string | undefined {
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1];
}

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** Where a checkout's git folders are (its own, and the one shared by every worktree). */
async function gitDirs(dir: string): Promise<{ gitDir?: string; common?: string }> {
  const [gitDir, common] = ((await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])) ?? '').trim().split('\n');
  return { ...(gitDir ? { gitDir } : {}), ...(common ? { common } : {}) };
}

const operationAt = (gitDir: string | undefined): Operation | undefined => {
  if (!gitDir) return undefined;
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'revert';
  return undefined;
};

const fetchedAtIn = (common: string | undefined): number | undefined => {
  if (!common) return undefined;
  try {
    return statSync(path.join(common, 'FETCH_HEAD')).mtimeMs;
  } catch {
    return undefined;
  }
};

/** A merge, rebase, cherry-pick or revert stopped halfway in this checkout (conflicts to resolve). */
export async function operationIn(dir: string): Promise<Operation | undefined> {
  return operationAt((await gitDirs(dir)).gitDir);
}

/** When the repo last fetched (FETCH_HEAD's time), so "fetched 3 min ago" survives restarts. */
export async function lastFetched(repo: string): Promise<number | undefined> {
  return fetchedAtIn((await gitDirs(repo)).common);
}

/** The project's default branch (main or master) and how the main folder stands with it. */
export interface DefaultBranch {
  /** "main". */
  readonly branch: string;
  /** "origin/main" (unset: no remote to compare with). */
  readonly upstream?: string;
  readonly remote?: string;
  /** The branch exists locally. */
  readonly local: boolean;
  /** Commits on the local branch not on its upstream, and the other way round (as of the last fetch). */
  readonly ahead: number;
  readonly behind: number;
  /** What the main folder has checked out (unset: a detached HEAD). */
  readonly current?: string;
  /** The main folder is on the default branch. */
  readonly onDefault: boolean;
  /** Uncommitted files in the main folder. */
  readonly dirty: number;
  /** A merge or rebase stopped halfway in the main folder. */
  readonly operation?: Operation;
  readonly fetchedAt?: number;
}

/** Split a base like "origin/main" into its remote and branch (when the first part is a remote). */
export async function splitBase(repo: string, base: string): Promise<{ remote?: string; branch: string }> {
  const remotes = ((await tryGit(repo, ['remote'])) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const remote = remotes.find((r) => base.startsWith(`${r}/`));
  return remote ? { remote, branch: base.slice(remote.length + 1) } : { branch: base };
}

const counts = async (repo: string, left: string, right: string): Promise<{ ahead: number; behind: number }> => {
  const out = (await tryGit(repo, ['rev-list', '--left-right', '--count', `${left}...${right}`]))?.trim().split(/\s+/);
  return { ahead: Number(out?.[0] ?? 0) || 0, behind: Number(out?.[1] ?? 0) || 0 };
};

/**
 * Where the default branch stands: `base` is the project's default base ("origin/main"). `known`:
 * what the caller already read from `git status` (the checked-out branch, uncommitted files).
 */
export async function defaultBranch(repo: string, base: string, known?: { readonly current?: string; readonly dirty: number }): Promise<DefaultBranch> {
  const [currentRaw, split, dirs, dirty] = await Promise.all([
    known ? Promise.resolve(known.current) : tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s?.trim()),
    base === 'HEAD' ? Promise.resolve(undefined) : splitBase(repo, base),
    gitDirs(repo),
    known ? Promise.resolve(known.dirty) : tryGit(repo, ['--no-optional-locks', 'status', '--porcelain']).then((s) => (s ?? '').split('\n').filter(Boolean).length),
  ]);
  const current = currentRaw || undefined;
  const { branch, remote } = split ?? { branch: current ?? 'HEAD' };
  const upstream = remote ? base : undefined;
  const local = Boolean(await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));
  const { ahead, behind } = upstream && local ? await counts(repo, `refs/heads/${branch}`, upstream) : { ahead: 0, behind: 0 };
  const operation = operationAt(dirs.gitDir);
  const fetchedAt = fetchedAtIn(dirs.common);
  return {
    branch,
    ...(upstream ? { upstream } : {}),
    ...(remote ? { remote } : {}),
    local,
    ahead,
    behind,
    ...(current ? { current } : {}),
    onDefault: current === branch,
    dirty,
    ...(operation ? { operation } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

/** The main folder's uncommitted files (paths, as git status lists them). */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = (await tryGit(dir, ['--no-optional-locks', 'status', '--porcelain=v1', '-z'])) ?? '';
  const entries = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    files.push(e.slice(3));
    // A rename lists where it came from next: skip that.
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return files;
}

export type UpdateOutcome =
  | { readonly kind: 'updated'; readonly branch: string; readonly upstream: string; readonly commits: number }
  | { readonly kind: 'up_to_date'; readonly branch: string; readonly upstream: string; readonly ahead: number }
  /** Uncommitted changes the new commits touch: git won't fast-forward over them. */
  | { readonly kind: 'dirty'; readonly branch: string; readonly upstream: string; readonly behind: number; readonly files: readonly string[] }
  /** Local commits not on the remote, and new ones there: a merge or rebase is needed. */
  | { readonly kind: 'diverged'; readonly branch: string; readonly upstream: string; readonly ahead: number; readonly behind: number }
  | { readonly kind: 'busy'; readonly operation: Operation }
  | { readonly kind: 'no_upstream'; readonly branch: string }
  | ({ readonly kind: 'fetch_failed' } & FetchFailure)
  | { readonly kind: 'failed'; readonly message: string };

/** The files git lists (tab-indented) when local changes are in the way of a checkout or merge. */
export function filesInTheWay(message: string): string[] {
  return message
    .split('\n')
    .filter((l) => /^\t\S/.test(l))
    .map((l) => l.trim());
}

const IN_THE_WAY = /would be overwritten|untracked working tree files would be|commit your changes or stash them/i;

/**
 * Bring the default branch up to date with its upstream, fast-forward only: fetch, then (in the
 * main folder, when it's on that branch) `merge --ff-only`, else move the branch ref itself.
 * Anything that isn't a clean fast-forward comes back as an outcome to decide about.
 */
export async function updateDefault(repo: string, base: string, opts: { fetch?: boolean } = {}): Promise<UpdateOutcome> {
  let line = await defaultBranch(repo, base);
  if (!line.upstream || !line.remote) return { kind: 'no_upstream', branch: line.branch };
  if (line.operation) return { kind: 'busy', operation: line.operation };
  if (opts.fetch !== false) {
    const fetched = await fetchRemote(repo, line.remote);
    if (!fetched.ok) return { kind: 'fetch_failed', reason: fetched.reason, message: fetched.message, detail: fetched.detail };
    line = await defaultBranch(repo, base);
  }
  const { branch, upstream } = { branch: line.branch, upstream: line.upstream! };
  if (line.local && !line.behind) return { kind: 'up_to_date', branch, upstream, ahead: line.ahead };
  if (line.ahead) return { kind: 'diverged', branch, upstream, ahead: line.ahead, behind: line.behind };
  const commits = line.local ? line.behind : 0;
  try {
    if (line.onDefault) await git(repo, ['merge', '--ff-only', '--no-edit', upstream]);
    // Not checked out here: move the branch itself (a local fetch refuses anything but a fast-forward).
    else await git(repo, ['fetch', '.', `refs/remotes/${upstream}:refs/heads/${branch}`]);
  } catch (err) {
    const message = errText(err);
    if (IN_THE_WAY.test(message)) return { kind: 'dirty', branch, upstream, behind: line.behind, files: filesInTheWay(message) };
    return { kind: 'failed', message };
  }
  return { kind: 'updated', branch, upstream, commits };
}

// ------------------------------------------------------------------ stash

export interface Stashed {
  readonly sha: string;
  readonly message: string;
}

/** Stash everything uncommitted (untracked files too); undefined when there was nothing to stash. */
export async function stashPush(dir: string, label: string): Promise<Stashed | undefined> {
  const message = `beluga: ${label} (${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${randomUUID().slice(0, 6)})`;
  const before = (await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/stash']))?.trim();
  await git(dir, ['stash', 'push', '--include-untracked', '-m', message]);
  const after = (await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/stash']))?.trim();
  if (!after || after === before) return undefined;
  // Find ours by its message: another worktree may have stashed at the same moment.
  const list = (await tryGit(dir, ['stash', 'list', '--format=%H%x09%gs', '-n', '500'])) ?? '';
  const sha = list
    .split('\n')
    .map((l) => l.split('\t'))
    .find(([, subject]) => subject?.endsWith(message))?.[0];
  if (!sha) throw new GitError(`Your changes were stashed (“${message}”), but Beluga couldn’t find the entry again. They’re safe: see git stash list.`);
  return { sha, message };
}

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly conflicts: readonly string[]; readonly message: string };

/** Apply a stash (by hash) in `dir`. On conflicts the files keep their markers and the stash stays. */
export async function stashApply(dir: string, sha: string): Promise<ApplyResult> {
  try {
    await git(dir, ['stash', 'apply', sha]);
    return { ok: true };
  } catch (err) {
    const conflicts = await conflictedFiles(dir);
    return { ok: false, conflicts, message: errText(err) };
  }
}

/**
 * Drop a stash entry by hash (wherever it is in the shared list now). Another worktree may push
 * between finding the entry and dropping it: if what went wasn't ours, it's put straight back.
 */
export async function stashDrop(dir: string, sha: string): Promise<void> {
  const list = (await tryGit(dir, ['stash', 'list', '--format=%H%x09%gd%x09%gs'])) ?? '';
  const entry = list
    .split('\n')
    .map((l) => l.split('\t'))
    .find(([h]) => h === sha);
  if (!entry?.[1]) return;
  const out = await git(dir, ['stash', 'drop', entry[1]]);
  const dropped = /\(([0-9a-f]{7,40})\)/.exec(out)?.[1];
  if (dropped && !sha.startsWith(dropped)) {
    const full = (await tryGit(dir, ['rev-parse', '--verify', '--quiet', `${dropped}^{commit}`]))?.trim();
    if (full) await git(dir, ['stash', 'store', '-m', 'restored by Beluga', full]);
  }
}

export type StashUpdateOutcome = UpdateOutcome & {
  /** Your changes are back (false: they conflicted with the new commits; see `conflicts`). */
  readonly restored: boolean;
  readonly conflicts?: readonly string[];
  /** Kept when restoring conflicted, so nothing is lost. */
  readonly stash?: Stashed;
};

/** "Stash, update, and put them back": stash -u, fast-forward, apply. A conflicting apply keeps the stash. */
export async function stashAndUpdate(repo: string, base: string): Promise<StashUpdateOutcome> {
  const line = await defaultBranch(repo, base);
  if (line.operation) return { kind: 'busy', operation: line.operation, restored: true };
  const stash = await stashPush(repo, `before updating ${line.branch}`);
  const outcome = await updateDefault(repo, base);
  if (!stash) return { ...outcome, restored: true };
  const applied = await stashApply(repo, stash.sha);
  if (!applied.ok) return { ...outcome, restored: false, conflicts: applied.conflicts, stash };
  await stashDrop(repo, stash.sha);
  return { ...outcome, restored: true };
}

export type SwitchOutcome = { readonly kind: 'switched'; readonly branch: string } | { readonly kind: 'dirty'; readonly files: readonly string[] } | { readonly kind: 'failed'; readonly message: string };

/** Check the default branch out in the main folder (creating it from its upstream if it's only on the remote). */
export async function switchToDefault(repo: string, base: string): Promise<SwitchOutcome> {
  const line = await defaultBranch(repo, base);
  if (line.onDefault) return { kind: 'switched', branch: line.branch };
  // A detached HEAD whose commits no branch or tag holds would be left behind: move it to a worktree instead.
  if (!line.current && !(await tryGit(repo, ['for-each-ref', '--count=1', '--contains', 'HEAD', 'refs/heads', 'refs/remotes', 'refs/tags']))?.trim())
    return { kind: 'failed', message: 'The main folder is on commits no branch holds. Move them to a worktree instead, so nothing is left behind.' };
  try {
    if (line.local || !line.upstream) await git(repo, ['switch', line.branch]);
    else await git(repo, ['switch', '--create', line.branch, '--track', line.upstream]);
    return { kind: 'switched', branch: line.branch };
  } catch (err) {
    const message = errText(err);
    if (IN_THE_WAY.test(message)) return { kind: 'dirty', files: filesInTheWay(message) };
    return { kind: 'failed', message: err instanceof GitError ? message : `Couldn’t switch: ${message}` };
  }
}

/** Switch to the default branch carrying your uncommitted changes along (stash, switch, apply). */
export async function stashAndSwitch(repo: string, base: string): Promise<SwitchOutcome & { readonly restored: boolean; readonly conflicts?: readonly string[]; readonly stash?: Stashed }> {
  const line = await defaultBranch(repo, base);
  const stash = await stashPush(repo, `switching to ${line.branch}`);
  const switched = await switchToDefault(repo, base);
  if (!stash) return { ...switched, restored: true };
  const applied = await stashApply(repo, stash.sha);
  if (!applied.ok) return { ...switched, restored: false, conflicts: applied.conflicts, stash };
  await stashDrop(repo, stash.sha);
  return { ...switched, restored: true };
}
