import { isKnownAction } from '../core/known-actions.js';
import { type Action, type DomainState, initialState, reduceDomain } from '../core/store.js';

/**
 * Another computer's state, read by a screen of another version (BLG-790's bell, a paired
 * computer's pane: machines/pane-clients.ts). Every daemon sends its snapshot and actions as its
 * own version has them, and nothing checks the two versions match (IPC_VERSION never changes). So
 * an older daemon leaves out what it doesn't have, and a newer one sends actions this screen can't
 * replay. These keep the screen's copy whole and in step, whichever versions meet. Browser-safe.
 */

let defaults: Record<string, unknown> | undefined;
const empty = (): Record<string, unknown> => (defaults ??= initialState('') as unknown as Record<string, unknown>);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `value` with what `fallback` has and it left out (undefined), one level down; itself when nothing was. */
function fillIn(value: Record<string, unknown>, fallback: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [k, d] of Object.entries(fallback)) {
    if (d === undefined || value[k] !== undefined) continue;
    (out ??= { ...value })[k] = d;
  }
  return out ?? value;
}

/**
 * `state` with every part this version's state has: a part a daemon of another version left out
 * takes its empty default, and so does a field missing inside one (a slice from an older daemon,
 * whole in its snapshot or in an action that replaces it). What it sent is kept as sent; a state
 * that lacks nothing is returned as it is. `keys`: only these parts (the ones an action changed).
 */
export function withDefaults(state: DomainState, keys?: readonly string[]): DomainState {
  const base = empty();
  const sent = state as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const k of keys ?? Object.keys(base)) {
    const d = base[k];
    if (d === undefined) continue;
    const v = sent[k];
    const filled = v === undefined ? d : isRecord(v) && isRecord(d) ? fillIn(v, d) : v;
    if (filled !== v) (out ??= { ...sent })[k] = filled;
  }
  return (out ?? state) as DomainState;
}

/**
 * One action of another daemon's, replayed onto `state`:
 * - `ok`: applied, and the state is whole (see withDefaults);
 * - `unknown`: a newer Beluga's action this reducer doesn't know: skipped, so the state may now be
 *   behind; take a fresh snapshot soon;
 * - `failed`: the reducer threw on it (its shape changed between versions): nothing applied; take
 *   a fresh snapshot now.
 */
export function replay(state: DomainState, action: Action): { readonly state: DomainState; readonly outcome: 'ok' | 'unknown' | 'failed' } {
  if (!isKnownAction((action as { type?: unknown }).type as string)) return { state, outcome: 'unknown' };
  let next: DomainState;
  try {
    next = reduceDomain(state, action);
  } catch {
    return { state, outcome: 'failed' };
  }
  if (next === state) return { state, outcome: 'ok' };
  const was = state as unknown as Record<string, unknown>;
  const now = next as unknown as Record<string, unknown>;
  const changed = Object.keys(now).filter((k) => now[k] !== was[k]);
  return { state: withDefaults(next, changed), outcome: 'ok' };
}
