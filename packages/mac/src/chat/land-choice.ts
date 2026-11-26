/**
 * Straight to main, per project (BLG-973): what you picked last in the new-worktree box's "Then",
 * so a project you only make small changes in starts that way next time. Only the projects you
 * turned it on for are kept (in localStorage); off is the default.
 */
const KEY = 'beluga.landOnBase';
/** Bounded: the most recent projects it's on for. */
const MAX = 100;

function read(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether new worktrees in this project go straight to main (your last pick there). */
export const landChoice = (projectId: string): boolean => read().includes(projectId);

export function rememberLand(projectId: string, on: boolean): void {
  const rest = read().filter((id) => id !== projectId);
  const next = on ? [projectId, ...rest].slice(0, MAX) : rest;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept: the box still shows what you picked for this one.
  }
}
