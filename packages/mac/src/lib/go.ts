import type { AppState } from '@beluga/core/store.js';
import { type TopTab, topTabs } from '@beluga/ui/workspace-models.js';
import { shortcutKeys } from './shortcuts.js';

/**
 * The Mac app's places: Overview and Tasks (the sidebar's top), then Search, Usage, Terminal and
 * Shared files (the toolbar, the sidebar's top icons, the right panel). ⌘1…7, the Go menu, ⌃Tab
 * and the palette follow this order; each keeps its key even when it's absent. The room's chat is
 * no place of its own (BLG-871): it's a channel in the sidebar while someone else is in the room,
 * so ⌘3 is free.
 */

export type PlaceKind = Exclude<TopTab['kind'], 'room'> | 'tasks';

export interface Place extends Omit<TopTab, 'kind'> {
  readonly kind: PlaceKind;
  /** Its ⌘ key (1…7). */
  readonly key: number;
}

/** Each place with its ⌘ key. */
const KEYS: Readonly<Record<PlaceKind, number>> = { overview: 1, tasks: 2, search: 4, usage: 5, terminal: 6, files: 7 };

export const GO_ORDER: readonly PlaceKind[] = ['overview', 'tasks', 'search', 'usage', 'terminal', 'files'];

/** A hint ending with the place's key (yours: Settings › Keyboard). */
function withKeys(hint: string, kind: PlaceKind): string {
  const keys = shortcutKeys(`go-${kind}`);
  return keys ? `${hint} · ${keys}` : hint;
}

/** The places there are now, in order, each hint ending with its key. */
export function macTabs(state: AppState): Place[] {
  const tabs = topTabs(state);
  return GO_ORDER.flatMap((kind): Place[] => {
    const key = KEYS[kind];
    if (kind === 'tasks') return state.board.enabled ? [{ kind, key, label: 'Tasks', short: 'Tasks', hint: withKeys('Plan and track the work', kind), badge: 0 }] : [];
    const t = tabs.find((x) => x.kind === kind);
    return t ? [{ ...t, kind, key, hint: withKeys(t.hint.replace(/ · (⌥|Alt\+)\d$/, ''), kind) }] : [];
  });
}

/** The place ⌃Tab (+1) or ⌃⇧Tab (-1) goes to; from elsewhere, the first or last one. */
export function stepPlace(state: AppState, delta: 1 | -1): PlaceKind {
  const order = macTabs(state).map((p) => p.kind);
  const here = state.view.kind === 'task' ? 'tasks' : state.view.kind;
  const at = order.indexOf(here as PlaceKind);
  if (at < 0) return delta > 0 ? order[0]! : order[order.length - 1]!;
  return order[(at + delta + order.length) % order.length]!;
}
