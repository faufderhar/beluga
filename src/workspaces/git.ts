import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_DIR } from '../shared/scratch-dir.js';
import { limiter } from './limit.js';
import { withSshRoutes } from './ssh-routes.js';

export class GitError extends Error {}

/** Git must never ask for a password on Beluga's screen: fail instead, and say why. */
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };

/**
 * Run git in a directory; resolves stdout, rejects with git's own message. `env`: more of git's
 * environment (GIT_INDEX_FILE…). Commands that reach a remote go over SSH where https was found not
 * to work (ssh-routes.ts).
 */
export function git(cwd: string, args: readonly string[], timeoutMs = 60_000, env?: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...withSshRoutes(args)], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: env ? { ...GIT_ENV, ...env } : GIT_ENV }, (err, stdout, stderr) => {
      if (err) reject(new GitError((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s, () => undefined);

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
}

/**
 * A path as git prints it, the way this system writes paths: git for Windows says
 * C:/Users/you/app, which Windows (and every path Beluga keeps) writes C:\Users\you\app.
 */
export const fromGit = (p: string, platform: NodeJS.Platform = process.platform): string => (platform === 'win32' && p ? path.win32.normalize(p) : p);

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const fields = new Map(block.split('\n').map((l) => [l.split(' ')[0] ?? '', l.slice(l.indexOf(' ') + 1)] as const));
      const branch = fields.get('branch')?.replace(/^refs\/heads\//, '');
      return { path: fromGit(fields.get('worktree') ?? ''), head: fields.get('HEAD'), branch, detached: fields.has('detached'), bare: fields.has('bare') };
    })
    .filter((w) => w.path);
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain']));
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await tryGit(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

/** The main checkout of the repo `dir` belongs to (works from inside a worktree too). */
export async function mainCheckout(dir: string): Promise<string | undefined> {
  const common = (await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  const gitDir = common ? fromGit(common) : undefined;
  return gitDir && path.basename(gitDir) === '.git' ? path.dirname(gitDir) : undefined;
}

/** origin's default branch, e.g. "origin/main"; falls back to a local main/master. */
export async function defaultBase(repo: string): Promise<string> {
  const head = (await tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (head) return head;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await tryGit(repo, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return 'HEAD';
}

export async function hasRemote(repo: string): Promise<boolean> {
  return Boolean((await tryGit(repo, ['remote']))?.trim());
}

const MAX_BRANCHES = 200;

/**
 * Local and remote-tracking branches ("main", "origin/main", "origin/feature-x"), most recently
 * committed first, without symbolic refs like origin/HEAD. Capped at 200.
 */
export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, symref]) => name && !symref && !name.endsWith('/HEAD'))
    .map(([name]) => name!)
    .slice(0, MAX_BRANCHES);
}

/** Whether `ref` names a commit in `repo` (a branch, tag or hash). Never reads it as an option. */
export async function isCommit(repo: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) return false;
  return Boolean((await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim());
}

/** Create a worktree on a new branch from `base` (fetching origin first so it's the latest). */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (base.startsWith('origin/') && (await hasRemote(repo))) await tryGit(repo, ['fetch', 'origin', '--prune']);
  await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

export async function removeWorktree(repo: string, path: string, force = false): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}

/**
 * Where the head of a fork's pull request a branch follows is kept (BLG-746): GitHub has those
 * commits, though no remote-tracking branch shows them. Outside refs/remotes, so `fetch --prune`
 * never drops it.
 */
export const PULL_HEADS = 'refs/beluga/pulls';
export const pullHeadRef = (n: number): string => `${PULL_HEADS}/${n}`;

/** The pull request a branch follows by GitHub's pull ref (a fork's: refs/pull/<n>/head), and from which remote. */
async function followedPull(repo: string, branch: string): Promise<{ remote: string; number: number } | undefined> {
  const merge = (await tryGit(repo, ['config', '--get', `branch.${branch}.merge`]))?.trim();
  const n = /^refs\/pull\/(\d+)\/head$/.exec(merge ?? '')?.[1];
  if (!n) return undefined;
  const remote = (await tryGit(repo, ['config', '--get', `branch.${branch}.remote`]))?.trim() || 'origin';
  return { remote, number: Number(n) };
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  const pull = await followedPull(repo, branch);
  await git(repo, ['branch', '-D', branch]);
  if (pull) await tryGit(repo, ['update-ref', '-d', pullHeadRef(pull.number)]);
}

/**
 * Delete a branch only if its work is in `into` (`git branch -d`, never -D): `into` stands in as
 * its upstream for this one command, so git itself refuses a branch with commits not merged there.
 */
export async function deleteMergedBranch(repo: string, branch: string, into: string): Promise<void> {
  if (!branch || branch.startsWith('-') || !into || into.startsWith('-')) throw new Error(`Not a branch: ${branch}`);
  await git(repo, ['-c', `branch.${branch}.remote=.`, '-c', `branch.${branch}.merge=refs/heads/${into}`, 'branch', '-d', branch]);
}

export interface Status {
  readonly branch?: string;
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
  /** Without a base (the main checkout): the branch it tracks and how it compares, as of the last fetch. */
  readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number };
  /**
   * Its commits are already in the base (or what the base tracks, e.g. origin/main): merged
   * there by a pull request, squashed, or merged by hand outside Beluga.
   */
  readonly landed?: true;
  /** Commits on neither the base nor any remote (BLG-617): deleting the branch would lose them. Absent: none. */
  readonly unpushed?: number;
}

/** Whether a branch's work is in a base, by (HEAD, base) commit: the answer never changes for the same two. */
const landedCache = new Map<string, boolean>();

/**
 * Whether HEAD's work is already in `into`: HEAD is part of it, every file the branch changed
 * reads the same there (a squash merge), or merging it in would change nothing (squashed, and a
 * later commit on `into` edited some of those files again: BLG-831). Nothing checked out or moved.
 */
async function landedIn(dir: string, head: string, into: string): Promise<boolean> {
  const key = `${head}:${into}`;
  const known = landedCache.get(key);
  if (known !== undefined) return known;
  let landed = await git(dir, ['merge-base', '--is-ancestor', head, into], 15_000).then(() => true, () => false);
  if (!landed) {
    const files = (await tryGit(dir, ['diff', '--name-only', '--no-renames', `${into}...${head}`]))?.split('\n').filter(Boolean) ?? [];
    if (files.length && files.length <= 2000) landed = await git(dir, ['diff', '--quiet', '--no-renames', into, head, '--', ...files], 15_000).then(() => true, () => false);
    // A git without merge-tree --write-tree (before 2.38), or a merge that conflicts: not landed, as before.
    if (!landed && files.length) landed = (await contentIn(dir, head, into)) === true;
  }
  if (landedCache.size > 2000) landedCache.clear();
  landedCache.set(key, landed);
  return landed;
}

/** Whether a branch ahead of `base` has already landed in it, or in what it tracks. `tip`: the branch (HEAD: the checkout's). */
async function hasLanded(dir: string, base: string, tip = 'HEAD'): Promise<boolean> {
  const sha = (ref: string): Promise<string | undefined> => tryGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((s) => s?.trim() || undefined);
  const [head, ...intos] = await Promise.all([tip, base, `${base}@{upstream}`].map(sha));
  if (!head) return false;
  for (const into of new Set(intos)) if (into && (await landedIn(dir, head, into))) return true;
  return false;
}

/** What a remote already has: every remote-tracking branch, and the fork pull requests' heads kept here. */
const ON_A_REMOTE = ['--remotes', `--glob=${PULL_HEADS}/*`] as const;

/** Commits on `tip` that are on neither `base` nor any remote (nor in `also`): only this branch has them. */
async function countUnpushed(dir: string, tip: string, base: string, also: readonly string[] = []): Promise<number> {
  const out = await tryGit(dir, ['rev-list', '--count', tip, '--not', base, ...ON_A_REMOTE, ...also]);
  return Number(out?.trim() ?? 0) || 0;
}

/** The heads of this branch's merged pull requests that are commits here: GitHub keeps each (refs/pull/<n>/head), so what's in one is never lost. */
async function shippedHeads(repo: string, heads: readonly string[]): Promise<string[]> {
  const sound = [...new Set(heads)].filter((h) => /^[0-9a-f]{7,64}$/i.test(h));
  const here = await Promise.all(sound.map((h) => isCommit(repo, h)));
  return sound.filter((_, i) => here[i]);
}

/** What deleting a branch would lose: its commits on neither `base` nor a remote, newest first (subjects, at most 5). */
export interface Unpushed {
  readonly count: number;
  readonly subjects: readonly string[];
}

/**
 * The commits only `branch` has (BLG-617): not in `base` and not pushed anywhere. None when its work
 * already landed in `base` (a squash merge) or the branch is gone. `shipped`: head commits of its pull
 * requests that merged (BLG-831), so only commits made after one count. Nothing checked out or moved.
 */
export async function unpushedCommits(repo: string, branch: string, base: string, shipped: readonly string[] = []): Promise<Unpushed> {
  const tip = `refs/heads/${branch}`;
  if (!branch || branch.startsWith('-') || !(await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${tip}^{commit}`]))) return { count: 0, subjects: [] };
  const heads = await shippedHeads(repo, shipped);
  const count = await countUnpushed(repo, tip, base, heads);
  if (!count || (await hasLanded(repo, base, tip))) return { count: 0, subjects: [] };
  const log = await tryGit(repo, ['log', '--format=%s', '-n', '5', tip, '--not', base, ...ON_A_REMOTE, ...heads]);
  return { count, subjects: log?.split('\n').filter(Boolean) ?? [] };
}

/** A delete check's fetch waits at most this long: offline, it answers from what's here. */
export const CATCH_UP_MS = 8_000;

/**
 * Fetch what `unpushedCommits` compares a branch with (BLG-746): the remote branch `base` is or
 * tracks (a pull request merged on GitHub since the last fetch is in it now) and, for a branch
 * that follows a fork's pull request, that pull request's head. Best effort and bounded.
 */
export async function catchUpForDelete(repo: string, branch: string, base: string, timeoutMs = CATCH_UP_MS): Promise<void> {
  const remotes = (await tryGit(repo, ['remote']))?.split('\n').map((r) => r.trim()).filter(Boolean) ?? [];
  if (!remotes.length || base.startsWith('-')) return;
  const tracked = (await isCommit(repo, `refs/remotes/${base}`)) ? base : (await tryGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${base}@{upstream}`]))?.trim();
  const baseRemote = tracked && remotes.filter((r) => tracked.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  const specs = new Map<string, string[]>();
  const add = (remote: string, spec: string): void => void specs.set(remote, [...(specs.get(remote) ?? []), spec]);
  if (tracked && baseRemote) add(baseRemote, `+refs/heads/${tracked.slice(baseRemote.length + 1)}:refs/remotes/${tracked}`);
  const pull = await followedPull(repo, branch);
  if (pull && remotes.includes(pull.remote)) add(pull.remote, `+refs/pull/${pull.number}/head:${pullHeadRef(pull.number)}`);
  await Promise.all([...specs].map(([remote, refspecs]) => git(repo, ['fetch', '--quiet', '--no-tags', remote, ...refspecs], timeoutMs).catch(() => undefined)));
}

/** Status reads run a few at a time (each is one or two git processes): a refresh of many worktrees never forks dozens at once. */
export const statusSlots = limiter(4);

/** Uncommitted file count plus commits ahead/behind `base`. `shipped`: its merged pull requests' heads (see unpushedCommits). */
export function status(dir: string, base?: string, shipped: readonly string[] = []): Promise<Status> {
  return statusSlots(() => readStatus(dir, base, shipped));
}

/**
 * A worktree's commits against its base, by what git keeps its branches in (BLG-407): HEAD, every
 * ref and the files that say how refs and history read. The same mark means the same answer.
 */
interface RefsCounts {
  readonly mark: string;
  readonly at: number;
  readonly ahead: number;
  readonly behind: number;
  readonly landed: boolean;
  readonly unpushed: number;
}
const refsCounts = new Map<string, RefsCounts>();
/** Counted again at least this often, mark or not. */
export const REFS_RECOUNT_MS = 5 * 60_000;
/** A file changed this recently may change again without its time moving (a disk that keeps whole seconds): not trusted yet. */
const RACY_MS = 2_000;
/** More refs than this: just ask git each time. */
const MAX_MARKED = 5_000;

/** The git folders of a checkout: its own (HEAD) and the shared one (refs, config). */
async function gitDirsOf(dir: string): Promise<{ own: string; common: string } | undefined> {
  const dotGit = path.join(dir, '.git');
  const st = await stat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return { own: dotGit, common: dotGit };
  const line = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim();
  if (!line) return undefined;
  const own = path.resolve(dir, line);
  const common = (await readFile(path.join(own, 'commondir'), 'utf8').catch(() => undefined))?.trim();
  return { own, common: common ? path.resolve(own, common) : own };
}

/**
 * The mark of everything a `base...HEAD` count reads besides the commits themselves (which never
 * change): HEAD, every loose ref and the folders they sit in, packed-refs, config, shallow and
 * grafts. Undefined when it can't be trusted (refs kept elsewhere, too many, or one just changed).
 */
export async function refsMark(dir: string): Promise<string | undefined> {
  const dirs = await gitDirsOf(dir);
  if (!dirs) return undefined;
  const { own, common } = dirs;
  if (await stat(path.join(common, 'reftable')).then(() => true, () => false)) return undefined;
  const files = [path.join(own, 'HEAD'), path.join(own, 'config.worktree'), path.join(common, 'config'), path.join(common, 'packed-refs'), path.join(common, 'shallow'), path.join(common, 'info', 'grafts')];
  // Windows has no $HOME: git reads the global config from your profile folder there.
  const home = process.env.HOME || os.homedir();
  if (home) files.push(path.join(home, '.gitconfig'), path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'git', 'config'));
  const refDirs = [...new Set([path.join(common, 'refs'), path.join(own, 'refs')])];
  const walked: string[] = [];
  const walk = async (d: string): Promise<boolean> => {
    walked.push(d);
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (walked.length + files.length > MAX_MARKED) return false;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(await walk(p))) return false;
      } else files.push(p);
    }
    return true;
  };
  for (const d of refDirs) if (!(await walk(d))) return undefined;
  const now = Date.now();
  const parts = await Promise.all(
    [...walked, ...files].map(async (p) => {
      const s = await stat(p, { bigint: true }).catch(() => undefined);
      if (!s) return `${p}:-`;
      if (now - Number(s.mtimeMs) < RACY_MS || now - Number(s.ctimeMs) < RACY_MS) return undefined;
      return `${p}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    }),
  );
  if (parts.some((p) => p === undefined)) return undefined;
  return parts.join('\n');
}

/**
 * Commits ahead of and behind `base`, whether they landed there, and how many are pushed nowhere:
 * git asked only when its refs moved (or every few minutes), or a pull request of it merged since.
 */
async function countAgainst(dir: string, base: string, shipped: readonly string[]): Promise<{ ahead: number; behind: number; landed: boolean; unpushed: number }> {
  const key = `${dir}\0${base}\0${shipped.join(' ')}`;
  // Marked before git counts, so a ref that moves while it counts shows as a change next time.
  const mark = await refsMark(dir).catch(() => undefined);
  const known = refsCounts.get(key);
  if (mark && known && known.mark === mark && Date.now() - known.at < REFS_RECOUNT_MS) return known;
  const counts = (await tryGit(dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`]))?.trim().split(/\s+/);
  const behind = Number(counts?.[0] ?? 0) || 0;
  const ahead = Number(counts?.[1] ?? 0) || 0;
  const landed = ahead > 0 && (await hasLanded(dir, base));
  // What a merged pull request had is on GitHub for good (BLG-833): the Delete step's hint agrees with Delete's own check.
  const unpushed = ahead > 0 && !landed ? await countUnpushed(dir, 'HEAD', base, await shippedHeads(dir, shipped)) : 0;
  if (refsCounts.size > 2000) refsCounts.clear();
  if (mark) refsCounts.set(key, { mark, at: Date.now(), ahead, behind, landed, unpushed });
  else refsCounts.delete(key);
  return { ahead, behind, landed, unpushed };
}

async function readStatus(dir: string, base?: string, shipped: readonly string[] = []): Promise<Status> {
  // Never take the index lock just to look: a commit (yours or Claude's) may be running.
  // Always asked: files you edit, and new ones, change nothing git's refs or index would show.
  const out = await git(dir, ['--no-optional-locks', 'status', '--porcelain=v1', '-b']);
  const [head = '', ...files] = out.split('\n').filter(Boolean);
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1];
  if (base) {
    const { ahead, behind, landed, unpushed } = await countAgainst(dir, base, shipped);
    return { branch, changed: files.length, ahead, behind, ...(landed ? { landed: true as const } : {}), ...(unpushed ? { unpushed } : {}) };
  }
  // "## main...origin/main [ahead 1, behind 2]": how the checkout compares to what it tracks.
  const name = /^## [^.\s]+\.\.\.(\S+)/.exec(head)?.[1];
  const upstream = name ? { name, ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0) } : undefined;
  return { branch, changed: files.length, ahead: 0, behind: 0, ...(upstream ? { upstream } : {}) };
}

export interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly state: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
}

export interface Review {
  readonly base: string;
  readonly commits: readonly { readonly hash: string; readonly subject: string }[];
  readonly files: readonly ChangedFile[];
}

/** Everything that differs from `base`: commits plus committed, staged, unstaged and new files. */
export async function review(dir: string, base: string): Promise<Review> {
  const mergeBase = (await tryGit(dir, ['merge-base', base, 'HEAD']))?.trim() || base;
  const log = (await tryGit(dir, ['log', '--format=%h%x09%s', `${mergeBase}..HEAD`])) ?? '';
  const commits = log.split('\n').filter(Boolean).map((l) => ({ hash: l.split('\t')[0] ?? '', subject: l.split('\t').slice(1).join('\t') }));
  const numstat = (await tryGit(dir, ['diff', '--numstat', mergeBase])) ?? '';
  const names = (await tryGit(dir, ['diff', '--name-status', mergeBase])) ?? '';
  const states = new Map(
    names.split('\n').filter(Boolean).map((l) => {
      const [code = 'M', ...rest] = l.split('\t');
      const state: ChangedFile['state'] = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified';
      return [rest.at(-1) ?? '', state] as const;
    }),
  );
  const files: ChangedFile[] = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a = '0', r = '0', ...p] = l.split('\t');
      const path = p.join('\t').replace(/^.*\{.* => (.*)\}.*$/, '$1');
      return { path, added: Number(a) || 0, removed: Number(r) || 0, state: states.get(path) ?? 'modified' };
    });
  const untracked = ((await tryGit(dir, ['ls-files', '--others', '--exclude-standard'])) ?? '').split('\n').filter(Boolean);
  for (const path of untracked) files.push({ path, added: 0, removed: 0, state: 'untracked' });
  return { base: mergeBase, commits, files };
}

/** Unified diff for one file against the merge base (new files shown in full). */
export async function fileDiff(dir: string, base: string, path: string): Promise<string> {
  const mergeBase = (await tryGit(dir, ['merge-base', base, 'HEAD']))?.trim() || base;
  const diff = await git(dir, ['--literal-pathspecs', 'diff', mergeBase, '--', path]);
  if (diff.trim()) return diff;
  return (await tryGit(dir, ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', path])) ?? '';
}

/** Run git, retrying briefly while another git process holds the index lock. */
async function withLockRetry(cwd: string, args: readonly string[], tries = 6): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await git(cwd, args);
    } catch (err) {
      if (i >= tries - 1 || !(err instanceof GitError) || !/index\.lock/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

export async function commitAll(dir: string, message: string, opts: { readonly orAsBeluga?: boolean } = {}): Promise<boolean> {
  await withLockRetry(dir, ['add', '-A']);
  const staged = (await tryGit(dir, ['diff', '--cached', '--name-only']))?.trim();
  if (!staged) return false;
  // A commit Beluga makes for you (moving work to another computer) on a computer with no git
  // identity yet, like a fresh server: authored as Beluga rather than failing. Yours otherwise.
  const asBeluga = opts.orAsBeluga && !(await tryGit(dir, ['config', 'user.email']))?.trim() ? ['-c', 'user.name=Beluga', '-c', 'user.email=beluga@localhost'] : [];
  await withLockRetry(dir, [...asBeluga, 'commit', '-m', message]);
  return true;
}

export type MergeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'dirty' | 'conflict'; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: 'wrong_branch'; readonly files: readonly string[]; readonly current: string; readonly expected: string };

/** Merge `branch` into the main checkout, which must be on `target`. Aborts cleanly on conflicts. */
export async function mergeInto(mainDir: string, branch: string, target?: string): Promise<MergeResult> {
  if (target) {
    const current = (await tryGit(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? 'HEAD';
    if (current !== target) return { ok: false, reason: 'wrong_branch', files: [], current, expected: target };
  }
  // Untracked files don't stop a merge (git says so itself if the merge would overwrite one).
  const dirty = (await git(mainDir, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
  if (dirty.length) return { ok: false, reason: 'dirty', files: dirty.map((l) => l.slice(3)) };
  try {
    await git(mainDir, ['merge', '--no-ff', '--no-edit', branch]);
    return { ok: true };
  } catch (err) {
    const conflicts = await conflictedFiles(mainDir);
    await tryGit(mainDir, ['merge', '--abort']);
    // Not a conflict (missing branch, no git identity, a hook said no): show git's own reason.
    if (!conflicts.length) throw err;
    return { ok: false, reason: 'conflict', files: conflicts };
  }
}

/** The files a merge (or stash apply) left conflicted in `dir`. */
export const conflictedFiles = async (dir: string): Promise<string[]> => ((await tryGit(dir, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);

export const isAncestor = async (cwd: string, a: string, b: string): Promise<boolean> => (await tryGit(cwd, ['merge-base', '--is-ancestor', a, b])) !== undefined;

/**
 * The branches still needed to have them all: a branch already in another one of them (KLD-27 in
 * KLD-31) goes, and so does one already in `main`. Order is kept; of two equal ones the first stays.
 */
export async function neededBranches(repo: string, branches: readonly string[], main?: string): Promise<string[]> {
  const unique = [...new Set(branches)];
  const out: string[] = [];
  for (const [i, b] of unique.entries()) {
    if (main && (await isAncestor(repo, b, main))) continue;
    let inside = false;
    for (const [j, other] of unique.entries()) {
      if (i === j || !(await isAncestor(repo, b, other))) continue;
      // Equal branches contain each other: the first one counts.
      if (j > i && (await isAncestor(repo, other, b))) continue;
      inside = true;
      break;
    }
    if (!inside) out.push(b);
  }
  return out;
}

export type CombineResult =
  | { readonly ok: true; readonly branch: string }
  /** `merging` conflicted: the merge is left in `dir` to fix (conflict markers in `files`). */
  | { readonly ok: false; readonly branch: string; readonly dir: string; readonly merging: string; readonly files: readonly string[] };

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

/**
 * `branch`: the first of `branches` with the others merged in (--no-ff), made in the worktree `dir`
 * (removed again once it's made, unless `keep`: a checkout that was there before). An existing
 * `branch` gets them merged in. Safe to run again: what's already in is skipped, and a conflict
 * someone fixed since (no markers left) is committed and the rest merged.
 */
export async function combineBranches(repo: string, dir: string, branch: string, branches: readonly string[], opts: { readonly keep?: boolean } = {}): Promise<CombineResult> {
  if (!branches.length) throw new GitError('Nothing to combine');
  if (!existsSync(dir)) {
    await tryGit(repo, ['worktree', 'prune']);
    const exists = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, branches[0]!]);
  }
  // A merge left to fix: committed once no conflict markers are left.
  if (await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) {
    const files = await conflictedFiles(dir);
    const marked: string[] = [];
    for (const f of files) if (MARKER.test(await readFile(path.join(dir, f), 'utf8').catch(() => ''))) marked.push(f);
    if (marked.length) {
      const msg = await readFile(path.join((await git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim(), 'MERGE_MSG'), 'utf8').catch(() => '');
      return { ok: false, branch, dir, merging: /'([^']+)'/.exec(msg)?.[1] ?? 'a branch', files: marked };
    }
    if (files.length) await git(dir, ['add', '--', ...files]);
    await git(dir, ['commit', '--no-edit']);
  }
  for (const b of branches) {
    if (await isAncestor(dir, b, 'HEAD')) continue;
    try {
      await git(dir, ['merge', '--no-ff', '--no-edit', b]);
    } catch (err) {
      const files = await conflictedFiles(dir);
      // Not a conflict (no git identity, a hook said no): nothing is left half-merged.
      if (!files.length) {
        await tryGit(dir, ['merge', '--abort']);
        throw err;
      }
      return { ok: false, branch, dir, merging: b, files };
    }
  }
  if (!opts.keep) await tryGit(repo, ['worktree', 'remove', '--force', dir]);
  return { ok: true, branch };
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  return (await tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
}

/** Keep Beluga's per-workspace folder (.beluga/) out of git without touching the repo's .gitignore. */
export async function excludeProjectDir(dir: string): Promise<void> {
  const gitDir = (await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!gitDir) return;
  const { appendFile, readFile, mkdir } = await import('node:fs/promises');
  const file = `${gitDir}/info/exclude`;
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').includes(`${PROJECT_DIR}/`)) return;
  await mkdir(`${gitDir}/info`, { recursive: true });
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${PROJECT_DIR}/\n`);
}

/**
 * Whether everything on `head` is already in `base`, whichever way it got there (merged, squashed
 * or rebased): merging it into `base` changes nothing. Undefined when git can't tell (older than 2.38).
 */
export async function contentIn(dir: string, head: string, base: string): Promise<boolean | undefined> {
  const merged = (await tryGit(dir, ['merge-tree', '--write-tree', base, head]))?.split('\n')[0]?.trim();
  const tree = (await tryGit(dir, ['rev-parse', `${base}^{tree}`]))?.trim();
  return merged && tree ? merged === tree : undefined;
}

/** Move this worktree's branch to `to` (a clean worktree only: its files change to match). */
export async function resetTo(dir: string, to: string): Promise<void> {
  await withLockRetry(dir, ['reset', '--hard', to]);
}
