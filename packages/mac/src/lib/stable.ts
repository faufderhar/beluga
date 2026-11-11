/**
 * Keeping what a view is given the same object while what's in it is the same, so a memo'd
 * row isn't drawn again because a list around it was rebuilt (KLD-48: a streamed event in one
 * conversation rebuilds the whole log, but leaves the other conversations' items as they were).
 */

/** The same items, in the same order (each the same object). */
export function sameItems<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The same plain data (objects, arrays, primitives), a few levels deep: for a view's derived
 * model (what a sidebar row shows), so it's drawn again only when what it shows changes.
 * Anything deeper than `depth` (or a function that isn't the same one) counts as changed.
 */
export function sameDeep(a: unknown, b: unknown, depth = 6): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameDeep(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
}

/** The same keys holding the same values (one level deep). */
export function sameFields(a: object, b: object): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * `next`, with each item that reads the same as the one with its id in `prev` swapped for that
 * one (a fresh page of steps from the daemon is all new objects; the unchanged ones stay put).
 */
export function keepSameById<T extends { readonly id: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const old = new Map(prev.map((x) => [x.id, x]));
  return next.map((x) => {
    const was = old.get(x.id);
    return was && sameFields(was, x) ? was : x;
  });
}

/** Each list in `next` as it was in `prev` when its items didn't change (so the map's values keep their identity). */
export function keepSameLists<K, V>(prev: ReadonlyMap<K, readonly V[]> | undefined, next: ReadonlyMap<K, readonly V[]>): ReadonlyMap<K, readonly V[]> {
  if (!prev) return next;
  const out = new Map<K, readonly V[]>();
  for (const [k, list] of next) {
    const was = prev.get(k);
    out.set(k, was && sameItems(was, list) ? was : list);
  }
  return out;
}

/** What a store read returned last: for the state it read, and the pick that read it. */
export interface Snapshot<S, T> {
  readonly state: S;
  readonly pick: (state: S) => T;
  readonly value: T;
}

/**
 * A store read that holds still (BLG-905): the same value while the state and the pick are the
 * same ones, whatever `equal` says, and the last value when `equal` finds the new one the same.
 * React's useSyncExternalStore reads again and again, and redraws for good when two reads of an
 * unchanged store differ: a list deeper than `equal` could see to the bottom of (the bell's
 * "Waiting for you" with one of Claude's questions in it) froze the window grey.
 */
export function readSnapshot<S, T>(last: Snapshot<S, T> | undefined, state: S, pick: (state: S) => T, equal?: (a: T, b: T) => boolean): Snapshot<S, T> {
  if (last && last.state === state && last.pick === pick) return last;
  const next = pick(state);
  const value = last && equal?.(last.value, next) ? last.value : next;
  return { state, pick, value };
}
