/**
 * Based on, per project (BLG-1034): the branch you last started a new worktree from there, so the
 * next one starts from it too. Only picks other than the project's default are kept (in
 * localStorage); picking the default again forgets it, so the box follows the project's default.
 */
const KEY = 'beluga.worktreeBase';
/** Bounded: the most recent projects with a pick. */
const MAX = 100;

type Picks = ReadonlyArray<readonly [string, string]>;

function read(): Picks {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string' && Boolean(x[1])) : [];
  } catch {
    return [];
  }
}

function write(next: Picks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept: the box still shows what you picked for this one.
  }
}

/** The branch new worktrees in this project start from, as you last picked it (unset: the project's default). */
export const baseChoice = (projectId: string): string | undefined => read().find(([id]) => id === projectId)?.[1];

/** Keeps the pick for next time; the project's default (`fallback`) forgets it. */
export function rememberBase(projectId: string, base: string, fallback: string | undefined): void {
  const rest = read().filter(([id]) => id !== projectId);
  write(base && base !== fallback ? [[projectId, base] as const, ...rest].slice(0, MAX) : rest);
}

/** The remembered pick while the project still has that branch (`branches` unset or empty: not known yet). */
export function liveBaseChoice(projectId: string, branches: readonly string[] | undefined): string | undefined {
  const kept = baseChoice(projectId);
  return !kept || !branches?.length || branches.includes(kept) ? kept : undefined;
}

/** Forgets a pick whose branch is gone, once the branches are known, so no worktree is made from it. */
export function pruneBaseChoice(projectId: string, branches: readonly string[]): void {
  const kept = baseChoice(projectId);
  if (kept && branches.length && !branches.includes(kept)) write(read().filter(([id]) => id !== projectId));
}
