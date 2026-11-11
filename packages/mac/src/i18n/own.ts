import { keepAsWritten } from './index.js';

/**
 * Names people gave things are never translated: a task called "Read", a project called "Main",
 * a sentinel, a plan, a milestone, a friend. They show in hundreds of places (cards, rows, crumbs,
 * labels), so instead of marking each, the window keeps a list of them from its state and the
 * catalog leaves those words as they are, alone or inside a sentence ("More for Read").
 */

type Loose = Record<string, unknown> | undefined;
const list = (v: unknown): Loose[] => (Array.isArray(v) ? (v as Loose[]) : []);
const LONGEST = 120;

/**
 * What people named, field by field (not every "name" in the state: Beluga's own presets and
 * built-in steps have names too, and those are the app's words).
 */
function namesOf(state: Loose): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length <= LONGEST && /[A-Za-z]/.test(v)) out.add(v.replace(/\s+/g, ' ').trim());
  };
  for (const p of list(state?.projects)) {
    // Beluga's own project for chats ("Chats", no folder) is named by the app, not by you.
    if (p?.root !== '') add(p?.name);
    for (const w of list(p?.workspaces)) add(w?.name);
  }
  for (const g of list(state?.projectGroups)) add(g?.name);
  for (const i of list((state?.board as Loose)?.issues)) add(i?.title);
  for (const plan of list((state?.plans as Loose)?.plans)) {
    const body = plan?.body as Loose;
    add(body?.title);
    for (const m of list(body?.milestones)) {
      add(m?.title);
      for (const t of list(m?.tasks)) add(t?.title);
    }
  }
  const sentinel = state?.sentinel as Loose;
  for (const item of list(sentinel?.items)) add(item?.name);
  for (const d of list(sentinel?.dashboards)) {
    add(d?.name);
    for (const tile of list(d?.tiles)) add(tile?.title);
  }
  for (const p of [state?.self as Loose, ...list(state?.peers)]) add(p?.name);
  const network = state?.network as Loose;
  for (const f of [...list(network?.friends), ...list(network?.groups)]) add(f?.name);
  return out;
}

/**
 * The parts of the state that hold what people named. The network slice changes with every message
 * that comes in, so only its friends and groups are compared, not the whole slice.
 */
const SLICES = ['projects', 'projectGroups', 'board', 'plans', 'sentinel', 'peers', 'self'] as const;

function partsOf(state: Record<string, unknown>): unknown[] {
  const network = state.network as Loose;
  return [...SLICES.map((k) => state[k]), network?.friends, network?.groups];
}

function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

interface Store {
  getState(): object;
  subscribe(listener: () => void): () => void;
}

/** Keep the catalog's list of names in step with the state. Returns the unsubscribe. */
export function followOwnWords(store: Store): () => void {
  let last: unknown[] | null = null;
  let words: ReadonlySet<string> | null = null;
  // Right away, not later: this listener runs before React draws what changed.
  const update = (): void => {
    const state = store.getState() as Record<string, unknown>;
    const parts = partsOf(state);
    if (last && parts.every((p, i) => p === last![i])) return;
    last = parts;
    const next = namesOf(state);
    // The same names (a slice redrawn, nothing renamed): keep the catalog's cache.
    if (words && sameWords(words, next)) return;
    words = next;
    keepAsWritten(next);
  };
  update();
  return store.subscribe(update);
}
