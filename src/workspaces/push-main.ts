import { conflictedFiles, git, tryGit } from './git.js';
import { changedFiles } from './land.js';
import { pushWhy } from './pr.js';
import { type FetchFailure, type Operation, classifyFetchError, defaultBranch, fetchRemote } from './sync.js';

/**
 * Push main: what Straight to main landed in the main folder goes to origin when you say so. The
 * latest origin is fetched first; when someone pushed there meanwhile, main's own commits are
 * rebased on top (main stays a straight line, as landing keeps it), never touching a file you're
 * editing there. Then a plain push: never forced, so nothing on origin is ever lost.
 */
export type PushMainOutcome =
  /** `commits`: how many went to origin; `rebased`: they went on top of this many new ones there. */
  | { readonly kind: 'pushed'; readonly branch: string; readonly upstream: string; readonly commits: number; readonly rebased: number }
  /** main has nothing origin doesn't. */
  | { readonly kind: 'nothing'; readonly branch: string; readonly upstream: string }
  | { readonly kind: 'no_upstream'; readonly branch: string }
  /** A merge or rebase stopped halfway in the main folder. */
  | { readonly kind: 'busy'; readonly operation: Operation }
  /** origin moved on, and the main folder isn't on main, so its commits can't be put on top here. */
  | { readonly kind: 'elsewhere'; readonly branch: string; readonly current: string }
  /** origin moved on in files you have changes in, in the main folder. */
  | { readonly kind: 'dirty'; readonly branch: string; readonly upstream: string; readonly files: readonly string[] }
  /** origin moved on in the same lines as main's own commits: nothing changed. */
  | { readonly kind: 'conflict'; readonly branch: string; readonly upstream: string; readonly files: readonly string[] }
  /** origin said no (a protected branch, a hook, someone pushing at the same moment): its reason. */
  | { readonly kind: 'rejected'; readonly branch: string; readonly upstream: string; readonly message: string; readonly protected?: true }
  | ({ readonly kind: 'fetch_failed' } & FetchFailure)
  | { readonly kind: 'failed'; readonly message: string };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const some = (files: readonly string[]): string => files.slice(0, 3).join(', ') + (files.length > 3 ? '…' : '');

/** How a push went, in a line (a toast on the Mac, the phone's answer). */
export function pushWords(out: PushMainOutcome): { readonly text: string; readonly level: 'success' | 'info' | 'warn' | 'error'; readonly ok: boolean } {
  switch (out.kind) {
    case 'pushed':
      return { text: `Pushed ${plural(out.commits, 'commit')} to ${out.upstream}${out.rebased ? `, on top of ${plural(out.rebased, 'new commit')} there` : ''}`, level: 'success', ok: true };
    case 'nothing':
      return { text: `${out.branch} has nothing ${out.upstream} doesn’t: nothing to push`, level: 'info', ok: true };
    case 'no_upstream':
      return { text: `${out.branch} doesn’t track a remote branch, so there’s nowhere to push it`, level: 'info', ok: false };
    case 'busy':
      return { text: `A ${out.operation} is stopped halfway in the main folder: finish it, then push`, level: 'warn', ok: false };
    case 'elsewhere':
      return { text: `Didn’t push: there’s something new on origin, and the main folder is on ${out.current}. Switch it to ${out.branch}, then push`, level: 'warn', ok: false };
    case 'dirty':
      return { text: `Didn’t push: ${out.upstream} changed files you’re editing in the main folder (${some(out.files)}). Commit or stash them, then push`, level: 'warn', ok: false };
    case 'conflict':
      return { text: `Didn’t push: ${out.upstream} changed the same lines as your commits (${some(out.files)})`, level: 'warn', ok: false };
    case 'rejected':
      return { text: out.protected ? `${out.upstream} is protected, so it only takes pull requests` : `${out.upstream} didn’t take the push: ${out.message}`, level: 'error', ok: false };
    case 'fetch_failed':
      return { text: out.message, level: out.reason === 'auth' ? 'warn' : 'error', ok: false };
    case 'failed':
      return { text: `Couldn’t push: ${out.message}`, level: 'error', ok: false };
  }
}

const QUIET = { GIT_EDITOR: 'true' } as const;
/** GitHub's (and GitLab's) words for a branch that only takes pull requests. */
const PROTECTED = /protected branch|GH006|GH013|not allowed to push code to protected/i;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const AUTH_OR_NETWORK = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|could not resolve host|couldn't connect|network is unreachable|could not read from remote repository/i;

/**
 * Push the project's default branch (`base`: "origin/main") to its remote. Origin's new commits
 * come first: main's own go on top of them, in the main folder (which must be on main for that).
 */
export async function pushDefault(repo: string, base: string): Promise<PushMainOutcome> {
  let line = await defaultBranch(repo, base);
  if (!line.upstream || !line.remote || !line.local) return { kind: 'no_upstream', branch: line.branch };
  if (line.operation) return { kind: 'busy', operation: line.operation };
  const fetched = await fetchRemote(repo, line.remote);
  if (!fetched.ok) return { kind: 'fetch_failed', reason: fetched.reason, message: fetched.message, detail: fetched.detail };
  line = await defaultBranch(repo, base);
  const { branch, remote } = line;
  const upstream = line.upstream!;
  if (!line.ahead) return { kind: 'nothing', branch, upstream };
  const commits = line.ahead;
  const rebased = line.behind;
  if (rebased) {
    if (!line.onDefault) return { kind: 'elsewhere', branch, current: line.current ?? 'a detached HEAD' };
    const onTop = await rebaseOnto(repo, upstream);
    if (onTop) return { ...onTop, branch, upstream };
  }
  try {
    await git(repo, ['-c', 'credential.interactive=never', 'push', remote!, `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
  } catch (err) {
    const raw = errText(err);
    if (AUTH_OR_NETWORK.test(raw)) {
      const failure = classifyFetchError(raw, remote);
      return { kind: 'fetch_failed', ...failure, message: failure.message.replace(/git fetch/g, 'git push').replace(/fetch from/g, 'push to') };
    }
    const why = /non-fast-forward|fetch first/.test(raw) ? `${upstream} changed just now: push again` : pushWhy(raw);
    return { kind: 'rejected', branch, upstream, message: why, ...(PROTECTED.test(raw) ? { protected: true as const } : {}) };
  }
  return { kind: 'pushed', branch, upstream, commits, rebased };
}

/**
 * Put main's own commits on top of `upstream`, in the main folder (on main). Your changes there are
 * set aside for the rebase and put back, unless origin's new commits touch the same files: then
 * nothing moves. A conflict between main's commits and origin's undoes the rebase.
 */
async function rebaseOnto(repo: string, upstream: string): Promise<{ readonly kind: 'dirty' | 'conflict'; readonly files: readonly string[] } | undefined> {
  const theirs = new Set((await git(repo, ['diff', '--name-only', '-z', `HEAD...${upstream}`])).split('\0').filter(Boolean));
  const mine = changedFiles(await git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']));
  const overlap = [...new Set(mine.filter((f) => theirs.has(f)))];
  if (overlap.length) return { kind: 'dirty', files: overlap };
  try {
    await git(repo, ['rebase', '--autostash', upstream], 120_000, QUIET);
    return undefined;
  } catch (err) {
    const files = await conflictedFiles(repo);
    await tryGit(repo, ['rebase', '--abort']);
    if (!files.length) throw err;
    return { kind: 'conflict', files };
  }
}
