import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HARMLESS_REDIRECT, isReadOnlyCommand, segments, words } from './read-only.js';

/**
 * "Let Claude handle it" for updating a project's main folder: one run that may, beyond reading,
 * only sync git (fetch, pull, merge, rebase --continue/--abort, stash, resolving conflicted files,
 * and committing the resolution). Never push, never discard: everything else in the main folder
 * stays blocked, as in any questions-only run (see policy.ts).
 */

export interface SyncScope {
  /** What this run brings up to date: the default branch, its upstream ("origin/main") and remote. */
  readonly branch?: string;
  readonly upstream?: string;
  /** A merge or rebase is stopped halfway in the main folder (only then may Claude commit). */
  readonly midOperation?: () => boolean;
  /** This file (absolute path) has unresolved conflicts: Claude may edit it. */
  readonly conflicted?: (absPath: string) => boolean;
}

/** Environment settings that only keep git from opening an editor or prompting. */
const ENV_OK = /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR)=(true|:)$|^GIT_MERGE_AUTOEDIT=no$|^GIT_TERMINAL_PROMPT=0$/;

/**
 * Shell syntax a sync command never needs, refused outright (escapes, expansions, globs, braces,
 * history, redirection is checked separately): what the checker can't see, the shell can't do.
 */
const UNSAFE_SYNTAX = /[\\$`{}()*?[\]~!<>]/;

const QUIET = ['-q', '--quiet', '-v', '--verbose', '--progress', '--no-progress'];
// No --prune: with a refspec it deletes local branches and tags.
const FETCH_FLAGS = new Set([...QUIET, '--no-recurse-submodules', '--dry-run', '--no-tags']);
const PULL_FLAGS = new Set([...QUIET, '--ff-only', '--ff', '--no-ff', '--rebase', '-r', '--no-rebase', '--rebase=true', '--rebase=false', '--rebase=merges', '--autostash', '--no-autostash', '--no-edit', '--stat', '--no-stat', '-n', '--no-tags', '--no-recurse-submodules']);
const MERGE_FLAGS = new Set([...QUIET, '--ff-only', '--ff', '--no-ff', '--no-edit', '--continue', '--abort', '--stat', '--no-stat', '--log', '--no-log', '--no-commit', '--autostash']);
const STASH_PUSH_FLAGS = new Set(['-u', '--include-untracked', '-q', '--quiet', '--keep-index', '-k']);
const ADD_FLAGS = new Set(['-A', '--all', '-u', '--update', '-v', '--verbose', '--']);
const COMMIT_FLAGS = new Set(['--no-edit', '-q', '--quiet']);

/** A branch name ("main", "feature/x"): no paths, URLs, refspecs or ranges. */
const BRANCH = /^[\w-]+(\.[\w-]+)*(\/[\w-]+(\.[\w-]+)*)*$/;
const STASH_SHA = /^[0-9a-f]{7,40}$/i;

/** Flags from an allowed set, plus `-m <message>` / `--message=…` where messages are allowed. */
function flagsOk(args: readonly string[], allowed: ReadonlySet<string>, opts: { message?: boolean } = {}): { ok: boolean; positional: string[] } {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (opts.message && (a === '-m' || a === '--message')) {
      i++;
      continue;
    }
    if (opts.message && a.startsWith('--message=')) continue;
    if (a.startsWith('-')) {
      if (!allowed.has(a)) return { ok: false, positional };
      continue;
    }
    positional.push(a);
  }
  return { ok: true, positional };
}

/** The remote this run syncs with ("origin" from "origin/main"). */
const remoteOf = (scope: SyncScope): string => scope.upstream?.split('/')[0] || 'origin';

/** `fetch`/`pull` positionals: the run's remote, then branch names. */
const remoteAndBranches = (positional: readonly string[], scope: SyncScope): boolean => (positional.length === 0 || positional[0] === remoteOf(scope)) && positional.slice(1).every((b) => BRANCH.test(b));

/** What a merge may bring in: the upstream (or FETCH_HEAD after a fetch), or the branch on the remote. */
const mergeable = (ref: string, scope: SyncScope): boolean => ref === 'FETCH_HEAD' || ref === scope.upstream || (BRANCH.test(ref) && ref.startsWith(`${remoteOf(scope)}/`));

/** Paths after a literal `--`, every one of them a file with conflicts right now. */
function conflictedPaths(rest: readonly string[], scope: SyncScope): boolean {
  const at = rest.indexOf('--');
  if (at < 0) return false;
  const paths = rest.slice(at + 1);
  return paths.length > 0 && paths.every((p) => !p.startsWith('-') && Boolean(scope.conflicted?.(p)));
}

function syncGit(args: readonly string[], scope: SyncScope): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    if (['--no-pager', '-P', '--no-optional-locks'].includes(args[i]!)) i++;
    // -C (another folder) and -c (settings that run programs) are never part of syncing main.
    else return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  switch (sub) {
    case 'fetch': {
      const f = flagsOk(rest, FETCH_FLAGS);
      return f.ok && f.positional.length <= 2 && remoteAndBranches(f.positional, scope);
    }
    case 'pull': {
      const f = flagsOk(rest, PULL_FLAGS);
      return f.ok && f.positional.length <= 2 && remoteAndBranches(f.positional, scope);
    }
    case 'merge': {
      const f = flagsOk(rest, MERGE_FLAGS, { message: true });
      const goingOn = rest.includes('--continue') || rest.includes('--abort');
      return f.ok && (goingOn ? f.positional.length === 0 : f.positional.length === 1 && mergeable(f.positional[0]!, scope));
    }
    case 'rebase':
      // Going on or backing out of a rebase that's stopped; never --skip (it drops a commit).
      return rest.length === 1 && (rest[0] === '--continue' || rest[0] === '--abort');
    case 'stash': {
      const [what = 'push', ...more] = rest;
      // Back by its own hash only: the stash list is shared with other worktrees and sessions.
      if (what === 'pop' || what === 'apply') return more.length === 1 && STASH_SHA.test(more[0]!);
      if (what === 'push' || what === 'save' || what.startsWith('-')) {
        const f = flagsOk(what.startsWith('-') ? rest : more, STASH_PUSH_FLAGS, { message: true });
        return f.ok && (what === 'save' ? f.positional.length <= 1 : f.positional.length === 0);
      }
      // list and show are reads (read-only.ts checks their flags); drop, clear, branch… are not allowed.
      return false;
    }
    case 'checkout':
    case 'restore': {
      // Only taking one side of a conflict (or re-creating its markers), for conflicted files after `--`.
      const at = rest.indexOf('--');
      const flags = at < 0 ? rest : rest.slice(0, at);
      if (flags.some((a) => !a.startsWith('-'))) return false;
      const side = flags.some((a) => ['--ours', '--theirs', '-m', '--merge'].includes(a));
      const staged = sub === 'restore' && flags.length === 1 && (flags[0] === '--staged' || flags[0] === '-S');
      const known = flags.every((a) => ['--ours', '--theirs', '-m', '--merge', '-q', '--quiet', ...(sub === 'restore' ? ['--staged', '-S'] : [])].includes(a));
      return known && (side || staged) && conflictedPaths(rest, scope);
    }
    case 'add': {
      const f = flagsOk(rest, ADD_FLAGS);
      return f.ok && (f.positional.length > 0 || rest.some((a) => a === '-A' || a === '--all' || a === '-u' || a === '--update'));
    }
    case 'commit': {
      // Only to conclude a merge or rebase (never to commit your own changes for you).
      if (!scope.midOperation?.()) return false;
      const f = flagsOk(rest, COMMIT_FLAGS, { message: true });
      return f.ok && f.positional.length === 0;
    }
    default:
      return false;
  }
}

function syncSegment(segment: string, scope: SyncScope): boolean {
  const all = words(segment);
  const start = all.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (start < 0) return false;
  if (!all.slice(0, start).every((w) => ENV_OK.test(w))) return false;
  const [program, ...args] = all.slice(start);
  return program === 'git' && syncGit(args, scope);
}

/** Commit messages may say anything: their text is set aside before the syntax check. */
const withoutMessages = (command: string): string => command.replace(/(\s(?:-m|--message)(?:=|\s+))("[^"\\$`]*"|'[^']*')/g, '$1MSG');

/**
 * True when `command` only syncs git in the main folder (or reads): fetch, pull, merge, rebase
 * --continue/--abort, stash, taking a side of a conflict, add, and a commit concluding a merge.
 */
export function isSyncMainCommand(command: string, scope: SyncScope = {}): boolean {
  const text = withoutMessages(command.trim());
  if (!text) return false;
  if (UNSAFE_SYNTAX.test(text.replace(HARMLESS_REDIRECT, ''))) return false;
  const cleaned = text.replace(HARMLESS_REDIRECT, '');
  const parts = segments(cleaned);
  if (!parts?.length) return false;
  const writes = parts.filter((p) => !isReadOnlyCommand(p));
  // Changing folders before a git command could sync some other repository.
  if (writes.length && parts.some((p) => /^\s*(cd|pushd)\b/.test(p))) return false;
  return writes.every((p) => syncSegment(p, scope));
}

/** Where Claude may write in a sync run: files that have conflict markers right now (for ctx.syncMain). */
export function syncProbes(cwd: string, target: { branch: string; upstream: string }): SyncScope {
  const gitDir = path.join(cwd, '.git');
  return {
    branch: target.branch,
    upstream: target.upstream,
    midOperation: () => ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) => existsSync(path.join(gitDir, f))),
    conflicted: (absPath) => {
      try {
        // -z: a name git would quote (non-ASCII, core.quotepath) comes as it is.
        const out = execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=U'], { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
        return out
          .split('\0')
          .filter(Boolean)
          .some((f) => path.resolve(cwd, f) === path.resolve(cwd, absPath));
      } catch {
        return false;
      }
    },
  };
}

/** Why a sync run can't do it, and what to do instead. */
export const SYNC_MAIN_REASON =
  'Beluga blocked this: this run may only bring main up to date (git fetch, pull, merge, rebase --continue/--abort, stash, ' +
  'checkout --ours/--theirs or restore for conflicted files, editing files with conflict markers, add, and a commit that concludes a merge). ' +
  'Never push, and never discard anything (no reset --hard, checkout -- <file>, clean, stash drop/clear, rebase --skip). ' +
  "If that's what it would take, stop and explain the situation so the user can decide.";

/** The task Claude gets when you click "Let Claude Handle It". */
export function syncMainPrompt(ctx: { branch: string; upstream: string; situation: string; dirty?: readonly string[] }): string {
  const dirty = ctx.dirty?.length ? `\nUncommitted changes in the main folder (keep them): ${ctx.dirty.slice(0, 30).join(', ')}${ctx.dirty.length > 30 ? ` and ${ctx.dirty.length - 30} more` : ''}.` : '';
  return [
    `Bring main up to date with ${ctx.upstream}: the main folder should end up on ${ctx.branch} with everything from ${ctx.upstream}.`,
    `What Beluga found: ${ctx.situation}${dirty}`,
    '',
    '1. Look first: git status, git log --oneline --graph -15 ' + `${ctx.branch} ${ctx.upstream}` + ', git stash list.',
    `2. Keep my local work: uncommitted changes (stash them if they're in the way and put them back after, by the stash's hash) and any local commits on ${ctx.branch} (merge or rebase them onto ${ctx.upstream}; prefer a merge if they may have been shared).`,
    '3. Resolve conflicts carefully, keeping both sides’ intent; ask me with a question if a conflict needs a decision only I can make.',
    '4. Never push. Never discard anything (no reset --hard, clean, checkout -- <file>, stash drop).',
    '5. Finish with a short explanation: what you did, what (if anything) conflicted and how you resolved it, and where main stands now (git status, git log --oneline -5).',
  ].join('\n');
}

/**
 * The task Claude gets when "Let Claude Handle It" opens a worktree: main's trouble that doesn't
 * live in the main folder's own files (a fetch that fails, diverged or rewritten history). There it
 * may do what it takes, as in any worktree, but the main folder stays yours.
 */
export function syncWorktreePrompt(ctx: { branch: string; upstream: string; situation: string; mainFolder: string; onDefault: boolean; fromLocal: boolean; dirty?: readonly string[] }): string {
  const remote = ctx.upstream.split('/')[0] || 'origin';
  const dirty = ctx.dirty?.length ? `\nUncommitted changes in the main folder (they're mine; leave them be): ${ctx.dirty.slice(0, 30).join(', ')}${ctx.dirty.length > 30 ? ` and ${ctx.dirty.length - 30} more` : ''}.` : '';
  const finish = ctx.onDefault
    ? `${ctx.branch} is checked out in the main folder, so don't move it yourself: get this worktree's branch to hold ${ctx.branch} with everything from ${ctx.upstream}, and I'll take it from there (Update ${ctx.branch} if ${ctx.branch} only needs to fast-forward, or Merge into ${ctx.branch} in Beluga).`
    : `${ctx.branch} isn't checked out in the main folder, so once it's right you may move it (git branch -f ${ctx.branch} <commit>), after keeping its old tip on a branch of its own.`;
  return [
    `Bring ${ctx.branch} up to date with ${ctx.upstream}. Updating it from Beluga didn't work, so you're in a worktree of your own for this (branch from ${ctx.fromLocal ? `my local ${ctx.branch}, with its own commits` : ctx.upstream}). The main folder is ${ctx.mainFolder}.`,
    `What Beluga found: ${ctx.situation}${dirty}`,
    '',
    `1. Look first: git status, git fetch ${remote}, git log --oneline --graph -15 ${ctx.branch} ${ctx.upstream}, git stash list.`,
    `2. If fetching fails, find out why (git remote -v, ssh -T, gh auth status, the credential helper, the network) and fix what you can on this Mac. Never ask for, type or store a password or token: if it needs me to sign in, tell me exactly what to run.`,
    `3. Keep my work: any commits on ${ctx.branch} that aren't on ${ctx.upstream} (merge ${ctx.upstream} into this branch, resolving conflicts carefully and keeping both sides' intent; prefer a merge if they may have been shared). If the histories don't share a base (a rewritten ${ctx.upstream}), check whether ${ctx.branch} has work of its own before choosing, and keep its old history on a branch.`,
    `4. ${finish}`,
    `5. Never push. Never discard anything (no reset --hard, clean, branch -D, stash drop), and don't change files or git state in the main folder. Ask me with a question if a decision is mine to make.`,
    `6. Finish with a short explanation: what was wrong, what you did, where ${ctx.branch} stands now, and the one step left for me, if any.`,
  ].join('\n');
}

/**
 * The task Claude gets when Sync fork stopped on conflicts (BLG-726): in a worktree from the fork's
 * default branch, merge the original's in, resolve, and open a pull request into the fork, so the
 * fork's branch only moves when that PR merges.
 */
export function syncForkPrompt(ctx: { original: string; originalUrl: string; originalBranch: string; forkBranch: string; situation?: string }): string {
  return [
    `Bring ${ctx.original}'s ${ctx.originalBranch} into my fork's ${ctx.forkBranch}. GitHub's Sync fork stopped because they conflict, so you're in a worktree of your own for this (branched from origin/${ctx.forkBranch}).`,
    ...(ctx.situation?.trim() ? [`What GitHub said: ${ctx.situation.trim()}`] : []),
    '',
    `1. Fetch the original without adding a remote: git fetch ${ctx.originalUrl}.git ${ctx.originalBranch} (it lands in FETCH_HEAD).`,
    "2. git merge FETCH_HEAD (a merge, never a rebase). For each conflicted file, read both sides and the commits behind them and keep both intents: my fork's own changes and the original's. Remove every conflict marker.",
    '3. Run the typecheck and the tests that cover what conflicted, fix what the merge broke, and commit the merge.',
    `4. Push this branch to origin and open a pull request into ${ctx.forkBranch} on my fork (gh pr create --base ${ctx.forkBranch}, titled "Sync with ${ctx.original}"). Never push to ${ctx.forkBranch} itself, and never to ${ctx.original}.`,
    '5. Say in a few lines which files conflicted and how you resolved each, and give the pull request URL.',
  ].join('\n');
}

/** Told to Claude at the start of a sync run (instead of the questions-only note). */
export function buildSyncMainAppend(project: string, branch: string, upstream: string): string {
  const remote = upstream.split('/')[0] || 'origin';
  return [
    '',
    `IMPORTANT: You're in the main folder of ${project}, and this run's job is to bring ${branch} up to date with ${upstream}.`,
    'Beyond reading, you may ONLY sync git here, in these forms (Beluga blocks everything else, and any shell syntax like $VAR, \\, ~, *, {}, ()):',
    `- git fetch ${remote} [branch]; git pull [--ff-only | --rebase | --no-rebase] [${remote} ${branch}]`,
    `- git merge [--no-edit | -m "message"] ${upstream} (or FETCH_HEAD); git merge --continue / --abort; git rebase --continue / --abort`,
    '- git stash push -u -m "message"; then find its hash with git stash list --format="%H %gs" and put it back with git stash apply <hash> (or pop <hash>)',
    '- git checkout --ours|--theirs -- <conflicted files>, git restore --staged -- <conflicted files>; edit files that have conflict markers',
    '- git add <files>; git commit --no-edit (or -m "message") only to conclude a merge or rebase. Set GIT_EDITOR=true for --continue.',
    'Never push. Never discard anything (reset --hard, clean, checkout -- <file>, stash drop/clear, rebase --skip): if that seems needed, stop and explain.',
    "Keep the user's uncommitted changes and local commits.",
  ].join('\n');
}
