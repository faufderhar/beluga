import { useEffect, useSyncExternalStore } from 'react';
import type { AppState, View } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Actions } from './actions.js';
import { useApp } from './beluga.js';
import { EMPTY_HISTORY, type NavHistory, type PanelSnapshot, canGoBack, canGoForward, goBack, goForward, prune, replaceCurrent, updateCurrent, visit } from './nav-history.js';
import { pageAlive, restorePatch } from './nav-pages.js';
import { panelChosenOpen, recentTabs } from './panel.js';
import { getPrefs, setPrefs, subscribePrefs } from './prefs.js';
import { paneOf, sameView } from '../machines/pane-model.js';
import { machineClientOf } from '../machines/pane-clients.js';

/**
 * Back and forward in this window (lib/nav-history.ts is the history itself): every page you go
 * to, however you got there (the sidebar, a link, ⌘1…, a notification), is a step; Back and
 * Forward go between them and put back what was open on the page (the sidebar, the panel and its
 * tabs, the terminal drawer). History lives for the window's session.
 */

interface Bound {
  readonly client: SocketClient;
  /** Show a view the way the window does (focus and the rest), not by a bare dispatch. */
  readonly go: (view: View) => void;
}

let history: NavHistory = EMPTY_HISTORY;
let bound: Bound | undefined;
/** Back or Forward is showing its page: the view changing is theirs, not a new step. */
let restoring = false;
const listeners = new Set<() => void>();

function setHistory(next: NavHistory): void {
  if (next === history) return;
  history = next;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * What the panel reads for the page on screen: this Mac's state, or on a computer's page (BLG-784)
 * that computer's, once its screen shows the page.
 */
function panelStateOf(state: AppState): AppState {
  const { machine, view } = paneOf(state.view);
  const there = machine ? machineClientOf(machine)?.store.getState() : undefined;
  return there && sameView(there.view, view) ? there : state;
}

/** What's open on the page on screen now. */
function snapshotOf(local: AppState): PanelSnapshot {
  const state = panelStateOf(local);
  const prefs = getPrefs();
  const shown = recentTabs(state.view, prefs);
  return {
    sidebar: prefs.sidebar,
    inspector: panelChosenOpen(prefs),
    bottomOpen: prefs.bottomOpen,
    drawer: prefs.drawer,
    ...(shown.length ? { shown } : {}),
  };
}

const aliveIn = (state: AppState) => (view: View): boolean => pageAlive(state, view);

/** A dialog (a sheet, the welcome) is open: it has the keys and the mouse to itself. */
export const dialogOpen = (): boolean => document.querySelector('[role="dialog"]') !== null;

/** Go back (-1) or forward (1): the page and its panels. False when there's nowhere to go. */
function step(dir: -1 | 1): boolean {
  if (!bound || restoring) return false;
  const { client, go } = bound;
  const state = client.store.getState();
  const alive = aliveIn(state);
  const before = history;
  const move = (dir < 0 ? goBack : goForward)(prune(history, alive), alive, snapshotOf(state));
  setHistory(move.history);
  const to = move.to;
  if (!to) return false;
  restoring = true;
  try {
    go(to.view);
    // A computer's page is drawn a moment later (machines/MachinePane.tsx): its panels are of the page itself.
    const shown = client.store.getState().view;
    const patch = restorePatch(getPrefs(), shown.kind === 'machine' ? shown.view : shown, to.panels);
    if (Object.keys(patch).length) setPrefs(patch);
  } catch (err) {
    console.error('beluga: going back or forward failed', err);
    // Nothing moved: the history stays as it was.
    if (client.store.getState().view === state.view) {
      setHistory(before);
      return false;
    }
  } finally {
    restoring = false;
  }
  // As the window shows it (a chat that moved shows where it went).
  setHistory(replaceCurrent(history, { view: client.store.getState().view, panels: to.panels }));
  return true;
}

export const navBack = (): boolean => step(-1);
export const navForward = (): boolean => step(1);

/** Whether Back and Forward have somewhere to go (for their buttons): redrawn when the history or a page's being there changes. */
export function useNavAbility(): { readonly back: boolean; readonly forward: boolean } {
  const h = useSyncExternalStore(subscribe, () => history);
  const back = useApp((st) => canGoBack(h, aliveIn(st)));
  const forward = useApp((st) => canGoForward(h, aliveIn(st)));
  return { back, forward };
}

/** The mouse's own back and forward buttons. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/** Mounted once (App): every page you go to is kept, and the mouse's back and forward buttons work. */
export function useNavHistory(client: SocketClient, actions: Actions): void {
  useEffect(() => {
    bound = { client, go: (view) => actions.run({ type: 'view', view }) };
    let seen = client.store.getState().view;
    setHistory(visit(history, { view: seen, panels: snapshotOf(client.store.getState()) }));
    const offStore = client.store.subscribe(() => {
      const state = client.store.getState();
      if (state.view === seen) return;
      seen = state.view;
      if (!restoring) setHistory(visit(history, { view: state.view, panels: snapshotOf(state) }));
    });
    // The panels you change on a page are kept with it. A moment later: a step that shows a tab
    // and then goes somewhere (a file link) has the tab for the page it went to, not the one it left.
    let queued = false;
    const offPrefs = subscribePrefs(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!restoring) setHistory(updateCurrent(history, snapshotOf(client.store.getState())));
      });
    });
    const onMouse = (e: MouseEvent): void => {
      if ((e.button !== MOUSE_BACK && e.button !== MOUSE_FORWARD) || dialogOpen()) return;
      e.preventDefault();
      if (e.button === MOUSE_BACK) navBack();
      else navForward();
    };
    window.addEventListener('mouseup', onMouse);
    return () => {
      offStore();
      offPrefs();
      window.removeEventListener('mouseup', onMouse);
      bound = undefined;
    };
  }, [client, actions]);
}
