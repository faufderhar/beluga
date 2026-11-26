/**
 * Which groups in the sidebar are folded, kept across launches (in localStorage, for this
 * computer). The window's `collapsed` list holds many folds; only its `group:<name>` entries
 * are kept here, the rest are for this run of the window as before.
 */

const KEY = 'beluga.groupFolds.v1';
const PREFIX = 'group:';
/** More folded groups than anyone has: what's saved stays small whatever is in it. */
const MAX = 200;

/** A group as the folds see it: its name and what's inside (to tell a rename from a new group). */
export interface FoldGroup {
  readonly name: string;
  readonly projects: readonly string[];
}

export const groupFoldKey = (name: string): string => `${PREFIX}${name}`;

/** The saved value read back: the folded groups' names (nothing, for anything that isn't a list of names). */
export function readGroupFolds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const names = value.filter((n): n is string => typeof n === 'string' && n.length > 0);
    return [...new Set(names)].slice(0, MAX);
  } catch {
    return [];
  }
}

/** The names of the folded groups in `collapsed`, in its order. */
export function foldedGroups(collapsed: readonly string[]): string[] {
  return [...new Set(collapsed.filter((k) => k.startsWith(PREFIX) && k.length > PREFIX.length).map((k) => k.slice(PREFIX.length)))];
}

/** What to save: the folded groups that still exist. */
export function foldsToSave(collapsed: readonly string[], groups: readonly FoldGroup[]): string[] {
  const names = new Set(groups.map((g) => g.name));
  return foldedGroups(collapsed).filter((n) => names.has(n)).slice(0, MAX);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `from` was renamed `to` between two lists of groups: one name went, one came, with the same projects. */
export function renamedGroup(before: readonly FoldGroup[], after: readonly FoldGroup[]): { readonly from: string; readonly to: string } | undefined {
  const gone = before.filter((g) => !after.some((a) => a.name === g.name));
  const came = after.filter((g) => !before.some((b) => b.name === g.name));
  if (gone.length !== 1 || came.length !== 1 || !sameList(gone[0]!.projects, came[0]!.projects)) return undefined;
  return { from: gone[0]!.name, to: came[0]!.name };
}

/**
 * `collapsed` after the groups changed: a renamed group keeps its fold under its new name, and
 * a group that's gone loses its entry (a new group of that name starts open). Everything that
 * isn't a group's fold is left as it is. The same list back when nothing changes.
 */
export function settleGroupFolds(collapsed: readonly string[], before: readonly FoldGroup[], after: readonly FoldGroup[]): readonly string[] {
  const renamed = renamedGroup(before, after);
  const names = new Set(after.map((g) => g.name));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const key of collapsed) {
    const group = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined;
    const to = group === undefined ? key : group === renamed?.from ? groupFoldKey(renamed.to) : names.has(group) ? key : undefined;
    if (to === undefined || seen.has(to)) continue;
    seen.add(to);
    next.push(to);
  }
  return sameList(next, collapsed) ? collapsed : next;
}

let written: string | undefined;

/** The `collapsed` entries to start the window with: the groups that were folded last time. */
export function loadGroupFolds(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    written = raw ?? undefined;
    return readGroupFolds(raw).map(groupFoldKey);
  } catch {
    return [];
  }
}

/** Keep the folded groups' names (written only when they changed). */
export function saveGroupFolds(names: readonly string[]): void {
  const text = JSON.stringify(names);
  if (text === written) return;
  try {
    localStorage.setItem(KEY, text);
    written = text;
  } catch {
    // No storage (or full): kept for this window.
  }
}
