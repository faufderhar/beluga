import type { View } from '../../../../src/core/store.js';
import type { DockTab } from './panel-model.js';

/**
 * Back and forward between pages, as plain data (like a browser's history): the pages behind you,
 * the one you're on, the ones ahead, and for each the panels it had (the sidebar, the right panel
 * and its tabs, the terminal drawer). Every step returns a new history; nothing is changed in
 * place. No DOM here, so it's tested on its own (tests/mac-nav-history.test.ts); lib/nav.ts wires
 * it to the window.
 */

/** What was open on a page: put back when you return to it. */
export interface PanelSnapshot {
  readonly sidebar: boolean;
  /** The right panel. */
  readonly inspector: boolean;
  /** The right panel's groups under the top one (the terminal's dock: Terminal, Background) are open. */
  readonly bottomOpen: boolean;
  /** The terminal under the chat is showing. */
  readonly drawer: boolean;
  /** The tabs the page's docks showed, oldest first (Changes, Files, Scratch, Info…; each group shows the latest of its own). */
  readonly shown?: readonly DockTab[];
}

export interface NavEntry {
  readonly view: View;
  readonly panels: PanelSnapshot;
}

export interface NavHistory {
  /** Oldest first: the last one is where Back goes. */
  readonly back: readonly NavEntry[];
  readonly current?: NavEntry;
  /** Nearest first: the first one is where Forward goes. */
  readonly forward: readonly NavEntry[];
}

/** Whether a page is still there to go to (its worktree, task or project wasn't deleted). */
export type Alive = (view: View) => boolean;

/** A step back or forward: the history after it, and the page it went to (none: it didn't move). */
export interface NavMove {
  readonly history: NavHistory;
  readonly to?: NavEntry;
}

/** Pages kept behind you (and ahead); the oldest go first. */
export const HISTORY_LIMIT = 50;

export const EMPTY_HISTORY: NavHistory = { back: [], forward: [] };

/**
 * Which page a view is: its kind and what it's of. A worktree is one page whatever tab was asked
 * for (the window always shows its chat, the tab goes to the panel); a draft's way back isn't part of it.
 */
export function pageKey(view: View): string {
  if (view.kind === 'workspace') return JSON.stringify(['workspace', view.id]);
  // A page on one of your computers (BLG-784) is that page there: never the same as this Mac's.
  if (view.kind === 'machine') return JSON.stringify(['machine', view.machine, pageKey(view.view)]);
  const params = Object.entries(view)
    .filter(([k, v]) => k !== 'kind' && k !== 'back' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([view.kind, ...params]);
}

export const samePage = (a: View, b: View): boolean => pageKey(a) === pageKey(b);

/** A new chat or worktree not started yet isn't a page to come back to. */
export const recordable = (view: View): boolean => (view.kind === 'machine' ? recordable(view.view) : view.kind !== 'draft' && view.kind !== 'draft_worktree');

const sameSnapshot = (a: PanelSnapshot, b: PanelSnapshot): boolean =>
  a.sidebar === b.sidebar && a.inspector === b.inspector && a.bottomOpen === b.bottomOpen && a.drawer === b.drawer && (a.shown ?? []).join() === (b.shown ?? []).join();

/** The newest `HISTORY_LIMIT` behind you. */
const capBack = (list: readonly NavEntry[]): readonly NavEntry[] => (list.length > HISTORY_LIMIT ? list.slice(list.length - HISTORY_LIMIT) : list);
/** The nearest `HISTORY_LIMIT` ahead. */
const capForward = (list: readonly NavEntry[]): readonly NavEntry[] => (list.length > HISTORY_LIMIT ? list.slice(0, HISTORY_LIMIT) : list);

/**
 * You went somewhere (not with Back or Forward). A new page puts the one you left on the back stack
 * (with its panels) and clears forward; the page you're already on just keeps its latest view and panels.
 */
export function visit(history: NavHistory, entry: NavEntry): NavHistory {
  const { current } = history;
  if (!current) return { ...history, current: entry };
  if (samePage(current.view, entry.view)) {
    if (current.view === entry.view && sameSnapshot(current.panels, entry.panels)) return history;
    return { ...history, current: entry };
  }
  return { back: recordable(current.view) ? capBack([...history.back, current]) : history.back, current: entry, forward: [] };
}

/** The page you're on has these panels now. */
export function updateCurrent(history: NavHistory, panels: PanelSnapshot): NavHistory {
  const { current } = history;
  if (!current || sameSnapshot(current.panels, panels)) return history;
  return { ...history, current: { ...current, panels } };
}

/** The page you're on is this (Back or Forward landed on it, as the window shows it). */
export function replaceCurrent(history: NavHistory, entry: NavEntry): NavHistory {
  return history.current === entry ? history : { ...history, current: entry };
}

/**
 * The first page in `list` (from its end for Back, its start for Forward) that's there and isn't
 * the one you're on, and what's left beyond it; the ones skipped on the way are dropped.
 */
function nextAlive(list: readonly NavEntry[], here: View | undefined, alive: Alive, fromEnd: boolean): { readonly to?: NavEntry; readonly rest: readonly NavEntry[] } {
  const order = fromEnd ? [...list].reverse() : [...list];
  const at = order.findIndex((e) => alive(e.view) && !(here && samePage(e.view, here)));
  if (at < 0) return { rest: [] };
  const rest = order.slice(at + 1);
  return { to: order[at], rest: fromEnd ? rest.reverse() : rest };
}

/**
 * Back: the page before (skipping, and forgetting, ones that are gone). `panels` is what the page
 * you're leaving has now, kept with it so Forward brings it back as you left it.
 */
export function goBack(history: NavHistory, alive: Alive, panels?: PanelSnapshot): NavMove {
  const saved = panels ? updateCurrent(history, panels) : history;
  const { to, rest } = nextAlive(saved.back, saved.current?.view, alive, true);
  if (!to) return { history: rest.length === saved.back.length ? saved : { ...saved, back: rest } };
  const forward = saved.current && recordable(saved.current.view) ? capForward([saved.current, ...saved.forward]) : saved.forward;
  return { history: { back: rest, current: to, forward }, to };
}

/** Forward: the page you came back from (the same way as Back). */
export function goForward(history: NavHistory, alive: Alive, panels?: PanelSnapshot): NavMove {
  const saved = panels ? updateCurrent(history, panels) : history;
  const { to, rest } = nextAlive(saved.forward, saved.current?.view, alive, false);
  if (!to) return { history: rest.length === saved.forward.length ? saved : { ...saved, forward: rest } };
  const back = saved.current && recordable(saved.current.view) ? capBack([...saved.back, saved.current]) : saved.back;
  return { history: { back, current: to, forward: rest }, to };
}

/** Pages gone dropped, and the repeats that leaves (the same page twice in a row, or the one you're on). */
function clean(list: readonly NavEntry[], here: View | undefined, alive: Alive, hereAtEnd: boolean): readonly NavEntry[] {
  const kept: NavEntry[] = [];
  for (const e of list) {
    if (!alive(e.view)) continue;
    const prev = kept[kept.length - 1];
    if (prev && samePage(prev.view, e.view)) continue;
    kept.push(e);
  }
  if (here) {
    // The entry beside where you are (the last one behind, the first one ahead) can't be that page.
    if (hereAtEnd) while (kept.length && samePage(kept[kept.length - 1]!.view, here)) kept.pop();
    else while (kept.length && samePage(kept[0]!.view, here)) kept.shift();
  }
  return kept;
}

const sameList = (a: readonly NavEntry[], b: readonly NavEntry[]): boolean => a.length === b.length && a.every((e, i) => e === b[i]);

/** Forget the pages that are gone (the same history when none are). */
export function prune(history: NavHistory, alive: Alive): NavHistory {
  const here = history.current?.view;
  const back = clean(history.back, here, alive, true);
  const forward = clean(history.forward, here, alive, false);
  if (sameList(back, history.back) && sameList(forward, history.forward)) return history;
  return { ...history, back, forward };
}

/** There's a page behind you to go back to. */
export const canGoBack = (history: NavHistory, alive: Alive): boolean => history.back.some((e) => alive(e.view) && !(history.current && samePage(e.view, history.current.view)));

/** There's a page ahead. */
export const canGoForward = (history: NavHistory, alive: Alive): boolean => history.forward.some((e) => alive(e.view) && !(history.current && samePage(e.view, history.current.view)));
