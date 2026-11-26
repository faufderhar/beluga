import { conflictedFiles, git, isAncestor, tryGit } from './git.js';

/**
 * "Straight to main": a worktree whose work lands on its base in the main folder as soon as its
 * agent's turn ends, with no pull request. Landing keeps main a straight line: the branch is
 * rebased onto the base when the base moved on, then the main folder fast-forwards to it.
 * Nothing is pushed.
 */
export type LandResult =
  /** `landed`: the commits that are on the base now (0: there was nothing to land). */
  | { readonly ok: true; readonly landed: number }
  /** `dirty`: the main folder's own changes are in files the work changes (or would be overwritten by it). */
  | { readonly ok: false; readonly reason: 'dirty' | 'conflict'; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: 'wrong_branch'; readonly files: readonly string[]; readonly current: string; readonly expected: string };

/** No editor ever opens: a rebase that would ask for one takes its default message. */
const QUIET = { GIT_EDITOR: 'true' } as const;

const lines = (out: string): string[] => out.split('\0').filter(Boolean);

/** Files with changes (tracked or new) in a checkout, from `git status -z`. */
export function changedFiles(porcelainZ: string): string[] {
  const entries = lines(porcelainZ);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    out.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') {
      const from = entries[i + 1];
      if (from) out.push(from);
      i++;
    }
  }
  return out;
}

/**
 * Land `branch` (checked out in `worktreeDir`, everything committed) on `target` in the main checkout
 * at `mainDir`, which must be on `target` (undefined: whatever it's on). A conflict with what's on
 * `target` now leaves the branch as it was; so does main having changes of its own in the same files.
 */
export async function landOnto(mainDir: string, worktreeDir: string, branch: string, target?: string): Promise<LandResult> {
  const current = (await tryGit(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? 'HEAD';
  if (target && current !== target) return { ok: false, reason: 'wrong_branch', files: [], current, expected: target };
  const onto = target ?? (await git(mainDir, ['rev-parse', 'HEAD'])).trim();
  const ahead = Number((await git(worktreeDir, ['rev-list', '--count', `${onto}..HEAD`])).trim()) || 0;
  if (!ahead) return { ok: true, landed: 0 };
  if (!(await isAncestor(worktreeDir, onto, 'HEAD'))) {
    try {
      await git(worktreeDir, ['rebase', onto], 120_000, QUIET);
    } catch (err) {
      const files = await conflictedFiles(worktreeDir);
      await tryGit(worktreeDir, ['rebase', '--abort']);
      // Not a conflict (a hook said no, no git identity): git's own reason.
      if (!files.length) throw err;
      return { ok: false, reason: 'conflict', files };
    }
  }
  // Your own changes in the main folder stay yours: landing never touches a file you're editing there.
  const touched = new Set(lines(await git(mainDir, ['diff', '--name-only', '-z', onto, branch])));
  const mine = changedFiles(await git(mainDir, ['status', '--porcelain', '-z', '--untracked-files=all']));
  const overlap = [...new Set(mine.filter((f) => touched.has(f)))];
  if (overlap.length) return { ok: false, reason: 'dirty', files: overlap };
  await git(mainDir, ['merge', '--ff-only', '--no-edit', branch]);
  return { ok: true, landed: ahead };
}
