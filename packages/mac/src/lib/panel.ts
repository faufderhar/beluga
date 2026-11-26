import { useEffect, useSyncExternalStore } from 'react';
import type { AppState, View } from '@beluga/core/store.js';

/** What the panel needs to know about the window: what's on screen and the projects. */
export type PanelState = Pick<AppState, 'view' | 'projects'>;
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { DEFAULT_LAYOUT, type DockTab, MAIN, PANES_DEFAULT, type PanelTab, panelFits, panelKey, panelTabsFor, rememberShown, shownIn, slotOf, terminalUnderChat, viewsOf } from './panel-model.js';
import { type UiPrefs, getPrefs, setPrefs } from './prefs.js';

/**
 * The right panel and the terminal drawer, as the window uses them: which tabs show, showing a
 * tab from anywhere (Run shows the terminal, a file link shows Files), ⌘J, and the focus view
 * (a diff or a file across the whole center for a while, Esc goes back to the chat).
 *
 * The panel is a dock (layout/RightPanel.tsx, Dockview), and so is the center: the chat is a tab
 * there, and a tab dragged out of the panel can sit beside it. How their groups are arranged is
 * Dockview's to keep. What's decided here is which tab each group shows: the one you showed last
 * in this place (`panelShown`). The docks read that, and tell this file what's in them (`setDock`).
 */

/** The two docks: the center's (the chat and what you put beside it) and the right panel's. */
export type DockPlace = 'center' | 'panel';

export type FocusKind = 'diff' | 'file' | 'terminal' | 'pr';

interface Runtime {
  /** The center shows this instead of the chat (for this workspace only). */
  readonly focus?: { readonly kind: FocusKind; readonly wsId: string };
  /** When the keyboard was last asked to go to the terminal (⌘J): the terminal that shows takes it. */
  readonly termFocus: number;
  /** What the terminal's group showed before ⌘J brought the terminal up (⌘J again goes back), and where. */
  readonly before?: { readonly key: string; readonly tab: DockTab; readonly closed: boolean; readonly bottomClosed: boolean };
  /**
   * The panel was open when a file or a diff took the center: it steps aside for the focus view
   * and comes back with Esc. Showing or hiding it yourself meanwhile forgets this (your choice stays).
   */
  readonly panelBack?: boolean;
  /** An Android phone is paired: the panel has its Phone tab (BLG-186). */
  readonly phone?: boolean;
  /** Both docks' groups (each one's tabs, in order; the chat is 'main'), while they're on screen. */
  readonly groups: ReadonlyArray<readonly DockTab[]>;
  /** The center's groups among them (those show whether the panel is open or not). */
  readonly central: ReadonlyArray<readonly DockTab[]>;
  /** The panel's tabs in groups under another one (the terminal's dock): those fold to just their tabs. */
  readonly docked: readonly PanelTab[];
  /** Counts up each time the dock is asked to start over (Reset Panel Layout). */
  readonly reset: number;
}

let runtime: Runtime = { termFocus: 0, groups: [], central: [], docked: [], reset: 0 };
/** What each dock last said is in it. */
const docks: Record<DockPlace, ReadonlyArray<readonly DockTab[]>> = { center: [], panel: [] };
const listeners = new Set<() => void>();
const patch = (next: Partial<Runtime>): void => {
  runtime = { ...runtime, ...next };
  for (const l of [...listeners]) l();
};

export function usePanelRuntime<T>(pick: (r: Runtime) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pick(runtime),
  );
}

const workspaceOf = (state: PanelState): Workspace | undefined => (state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined);

/** The folder the Files tab (and a file opened in full) is about: the workspace on screen, or on a project's page its main folder. */
export function filesWsOf(state: PanelState): string | undefined {
  const { view } = state;
  if (view.kind === 'workspace') return view.id;
  if (view.kind === 'project') return state.projects.find((p) => p.id === view.id)?.workspaces.find((w) => w.kind === 'main' && !w.archived)?.id;
  return undefined;
}

/** Uncommitted files or commits ahead of its base. */
export const hasChanges = (ws: Workspace | undefined): boolean => (ws?.status?.changed ?? 0) + (ws?.status?.ahead ?? 0) > 0;

export const tabsOf = (state: PanelState): PanelTab[] => panelTabsFor(state.view, workspaceOf(state)?.kind, runtime.phone).filter((t) => t !== 'scratch' || getPrefs().scratchTab);

/** Whether a phone is paired, so the panel offers its Phone tab (set from the shared state as it changes). */
export const setPhoneTab = (on: boolean): void => {
  if (Boolean(runtime.phone) !== on) patch({ phone: on });
};

const sameGroups = (a: ReadonlyArray<readonly DockTab[]>, b: ReadonlyArray<readonly DockTab[]>): boolean => a.length === b.length && a.every((g, i) => g.join() === b[i]!.join());

/** A dock says what's in it (its groups changed, it went away): which tabs share a group, and which of the panel's groups fold. */
export function setDock(place: DockPlace, groups: ReadonlyArray<readonly DockTab[]>, docked: readonly PanelTab[] = []): void {
  docks[place] = groups;
  const all = [...docks.center, ...docks.panel];
  const nextDocked = place === 'panel' ? docked : runtime.docked;
  if (sameGroups(runtime.groups, all) && sameGroups(runtime.central, docks.center) && runtime.docked.join() === nextDocked.join()) return;
  patch({ groups: all, central: docks.center, docked: nextDocked });
}

/** This tab is beside the chat (in the center's dock), not in the panel. */
export const inCenter = (tab: DockTab): boolean => runtime.central.some((g) => g.includes(slotOf(tab)));

/** The tabs you showed last in this place, oldest first. */
export const recentTabs = (view: View, prefs: UiPrefs = getPrefs()): readonly DockTab[] => prefs.panelShown[panelKey(view)] ?? [];

/** The tab a group shows here (or would, while the panel is hidden): see shownIn. */
export function groupTab(state: PanelState, group: readonly PanelTab[], prefs?: UiPrefs): PanelTab | undefined;
export function groupTab(state: PanelState, group: readonly DockTab[], prefs?: UiPrefs): DockTab | undefined;
export function groupTab(state: PanelState, group: readonly DockTab[], prefs: UiPrefs = getPrefs()): DockTab | undefined {
  return shownIn(group, recentTabs(state.view, prefs), tabsOf(state), hasChanges(workspaceOf(state)));
}

/** The dock's group this tab is in, while its dock is on screen. */
const groupOf = (tab: DockTab): readonly DockTab[] | undefined => runtime.groups.find((g) => g.includes(slotOf(tab)));

/** Folded: the panel's groups under the top one are just their tabs. */
const isFolded = (tab: DockTab, prefs: UiPrefs): boolean => !prefs.bottomOpen && runtime.docked.includes(slotOf(tab) as PanelTab);

/** This tab is on screen right now. */
export function tabShowing(state: PanelState, tab: PanelTab, prefs: UiPrefs = getPrefs()): boolean {
  const group = groupOf(tab);
  if (!group) return false;
  if (inCenter(tab)) {
    // Beside the chat it shows whether the panel is open or not. The terminal with a group to itself there is put away with ⌘J.
    if (tab === 'terminal' && group.length === 1 && !prefs.drawer) return false;
  } else if (!panelFits(state.view) || !prefs.inspector || isFolded(tab, prefs)) return false;
  return groupTab(state, group, prefs) === tab;
}

/** What showing this tab changes: it's the latest in this place, and its group unfolds. */
const shows = (view: View, tab: DockTab, prefs: UiPrefs): Partial<UiPrefs> => ({
  panelShown: rememberShown(prefs.panelShown, panelKey(view), tab),
  ...(runtime.docked.includes(slotOf(tab) as PanelTab) && !prefs.bottomOpen ? { bottomOpen: true } : {}),
});

/** Pick a tab (remembered for this workspace). */
export function setPanelTab(view: View, tab: DockTab): void {
  patch({ before: undefined });
  setPrefs(shows(view, tab, getPrefs()));
}

/** You showed or hid the panel yourself: during a focus view, that's what stays after it. */
const panelChosen = (): void => {
  if (runtime.focus && runtime.panelBack !== undefined) patch({ panelBack: undefined });
};

/** Show the panel on this tab (unfolding its group). False when the view has no such tab. */
export function showPanelTab(state: PanelState, tab: PanelTab): boolean {
  if (!tabsOf(state).includes(tab)) return false;
  patch({ before: undefined });
  // Beside the chat, it's already on screen: the panel stays as it is.
  if (inCenter(tab)) return setPrefs(shows(state.view, tab, getPrefs())), true;
  panelChosen();
  setPrefs({ inspector: true, ...shows(state.view, tab, getPrefs()) });
  return true;
}

/** Fold or unfold the groups under the top one (the terminal's dock). */
export const setDockOpen = (open: boolean): void => setPrefs({ bottomOpen: open });

/** You picked a tab in the dock yourself: ⌘J no longer has something to go back to. */
export const tabPicked = (): void => {
  if (runtime.before) patch({ before: undefined });
};

/** Back to how the docks start, everywhere: the chat alone in the center; in the panel, what Claude made on top and what runs below. */
export function resetPanelLayout(): void {
  // The terminal too: back in the panel, wherever you had dragged it.
  setPrefs({ dockLayouts: {}, centerTabs: {}, termIn: 'panel', panelLayout: DEFAULT_LAYOUT, paneSplit: PANES_DEFAULT, bottomOpen: true });
  patch({ reset: runtime.reset + 1 });
}

/** A changed file the Changes tab should open when it next shows (asked from the Files tab). */
let changeAsk: { readonly wsId: string; readonly path: string; readonly at: number } | undefined;
/** Asked a moment ago, or not at all (a later visit to Changes opens on its own). */
const ASK_MS = 2000;

/** Show a file's changes: the Changes tab, with that file's diff open. */
export function showChange(state: PanelState, path: string): boolean {
  if (state.view.kind !== 'workspace') return false;
  changeAsk = { wsId: state.view.id, path, at: Date.now() };
  if (showPanelTab(state, 'changes')) return true;
  changeAsk = undefined;
  return false;
}

/** The file to open (for this workspace's Changes tab). Read it while rendering, then forget it. */
export const peekChangeAsk = (wsId: string): string | undefined => (changeAsk?.wsId === wsId && Date.now() - changeAsk.at < ASK_MS ? changeAsk.path : undefined);
export const forgetChangeAsk = (): void => void (changeAsk = undefined);

/** The event a plan's page listens for: ⌥⌘0 there shows and hides its chat (its right side). */
export const PLAN_CHAT_TOGGLE = 'beluga:plan-chat';

export const togglePanel = (view: View): void => {
  if (view.kind === 'plan') return void document.dispatchEvent(new CustomEvent(PLAN_CHAT_TOGGLE));
  if (!panelFits(view)) return;
  panelChosen();
  setPrefs({ inspector: !getPrefs().inspector });
};

/** The terminal is on screen: under the chat, or as the panel's tab. */
export function terminalShowing(state: PanelState, prefs: UiPrefs = getPrefs()): boolean {
  return tabShowing(state, 'terminal', prefs);
}

/** The terminal's place here is under the chat (see terminalUnderChat). */
const underChat = (state: PanelState, prefs: UiPrefs): boolean => terminalUnderChat(prefs.termIn, tabsOf(state), state.view);

/** Put the keyboard in the terminal that's showing. */
export const focusTerminal = (): void => patch({ termFocus: Date.now() });

/**
 * Show the terminal where you keep it (Settings › Terminal: under the chat or in the panel). Run
 * uses it too, without taking the keyboard from the message box.
 */
export function revealTerminal(state: PanelState, focus: boolean): boolean {
  const prefs = getPrefs();
  if (underChat(state, prefs)) {
    if (!tabShowing(state, 'terminal', prefs)) {
      const group = groupOf('terminal');
      const tab = (group && groupTab(state, group, prefs)) ?? 'terminal';
      setPrefs({ drawer: true, panelShown: rememberShown(prefs.panelShown, panelKey(state.view), 'terminal') });
      patch({ before: { key: panelKey(state.view), tab, closed: false, bottomClosed: false } });
    }
  } else if (tabsOf(state).includes('terminal')) {
    if (!tabShowing(state, 'terminal', prefs)) {
      // What its group shows now (not known while the panel is hidden: then ⌘J again just hides it).
      const group = groupOf('terminal');
      const tab = (group && groupTab(state, group, prefs)) ?? 'terminal';
      const central = inCenter('terminal');
      const before = { key: panelKey(state.view), tab, closed: !central && !prefs.inspector, bottomClosed: !prefs.bottomOpen };
      if (!central) panelChosen();
      setPrefs({ ...(central ? {} : { inspector: true }), panelShown: rememberShown(prefs.panelShown, panelKey(state.view), 'terminal'), ...(prefs.bottomOpen || central ? {} : { bottomOpen: true }) });
      patch({ before });
    }
  } else return false;
  if (focus) focusTerminal();
  return true;
}

/** Put the terminal away: close the drawer, or give the panel back what it showed before. */
export function hideTerminal(state: PanelState): void {
  const prefs = getPrefs();
  const key = panelKey(state.view);
  if (!tabShowing(state, 'terminal', prefs)) return;
  // The panel goes back to what it showed before ⌘J (here, not in another workspace).
  const before = runtime.before?.key === key ? runtime.before : undefined;
  patch({ before: undefined });
  const group = groupOf('terminal') ?? [];
  // Under or beside the chat: with a group to itself it's put away; sharing one, back to what the
  // group showed (the chat, if that's what it shares it with). The keyboard goes to the message box.
  if (inCenter('terminal')) {
    if (group.length === 1) {
      setPrefs({ drawer: false });
      setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 60);
      return;
    }
    const to = before && slotOf(before.tab) !== 'terminal' && group.includes(slotOf(before.tab)) ? before.tab : (group.find((t) => t !== 'terminal') ?? undefined);
    if (to) setPrefs({ panelShown: rememberShown(prefs.panelShown, key, to === MAIN ? MAIN : (viewsOf(to, tabsOf(state))[0] ?? to)) });
    // (Once the chat is back on screen: hidden behind the terminal's tab it can't take the keyboard.)
    setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 60);
    return;
  }
  // The tab ⌘J took the terminal's group from, if it's still beside it.
  const back = before && slotOf(before.tab) !== 'terminal' && group.includes(slotOf(before.tab)) ? before.tab : undefined;
  const showBack = back ? { panelShown: rememberShown(prefs.panelShown, key, back) } : {};
  const foldBack = before?.bottomClosed ? { bottomOpen: false } : {};
  // The panel was hidden before ⌘J: hidden again.
  if (before?.closed) return setPrefs({ inspector: false, ...showBack, ...foldBack });
  if (back) return setPrefs({ ...showBack, ...foldBack });
  // Under the rest: its dock folds to its tabs.
  if (runtime.docked.includes('terminal')) return setPrefs({ bottomOpen: false });
  // Beside other tabs: the next one shows. Alone in its group: the panel hides.
  const other = group.find((t) => t !== 'terminal');
  const next = other ? (viewsOf(other, tabsOf(state))[0] ?? other) : undefined;
  setPrefs(next ? { panelShown: rememberShown(prefs.panelShown, key, next) } : { inspector: false });
}

/** The keyboard is in a terminal. */
const typingInTerminal = (): boolean => Boolean(document.activeElement?.closest('.xterm'));

/**
 * ⌘J: show the terminal and type in it; already showing, just type in it; already typing in it,
 * put it away. Returns why not, when it can't.
 */
export function toggleTerminal(state: PanelState): string | undefined {
  const prefs = getPrefs();
  if (terminalShowing(state, prefs)) {
    if (typingInTerminal()) hideTerminal(state);
    else focusTerminal();
    return undefined;
  }
  if (state.view.kind === 'shared') return 'A shared workspace’s terminal is its owner’s';
  if (state.view.kind === 'terminal') return undefined;
  return revealTerminal(state, true) ? undefined : 'No terminal here';
}

/** Move the terminal to the other place (and keep it there for ⌘J): its tab goes to that dock, and shows. */
export function moveTerminal(state: PanelState, to: 'drawer' | 'panel'): void {
  const prefs = getPrefs();
  patch({ before: undefined });
  setPrefs({ termIn: to, drawer: true, ...(to === 'panel' ? { inspector: true, bottomOpen: true } : {}), panelShown: rememberShown(prefs.panelShown, panelKey(state.view), 'terminal') });
}

/**
 * A diff, a file or the terminal across the center. The panel steps aside meanwhile (it would
 * only show a smaller copy of the same thing) and comes back when you go back to the chat.
 */
export function openFocus(kind: FocusKind, wsId: string): void {
  const open = getPrefs().inspector;
  // Already focused (another file, the diff after the file): keep what the panel was before all of it.
  const panelBack = runtime.focus && runtime.panelBack !== undefined ? runtime.panelBack : open;
  patch({ focus: { kind, wsId }, panelBack });
  if (open) setPrefs({ inspector: false });
}

export function closeFocus(): void {
  if (!runtime.focus) return;
  const back = runtime.panelBack;
  patch({ focus: undefined, panelBack: undefined });
  if (back && !getPrefs().inspector) setPrefs({ inspector: true });
}

/** Whether you have the panel open: while a file or a diff takes the center, what it comes back to. */
export const panelChosenOpen = (prefs: UiPrefs = getPrefs()): boolean => (runtime.focus && runtime.panelBack !== undefined ? runtime.panelBack : prefs.inspector);

export const focusFor = (wsId: string | undefined): FocusKind | undefined => (wsId && runtime.focus?.wsId === wsId ? runtime.focus.kind : undefined);

// A key press can reach both the window and the menu bar (its item has the same key), in either
// order: a toggle must run once. Whichever comes second within a moment is the echo.
const ran = new Map<string, { readonly by: 'key' | 'menu'; readonly at: number }>();
const ECHO_MS = 300;

function dedupe(by: 'key' | 'menu', id: string, run: () => void): void {
  const last = ran.get(id);
  const now = Date.now();
  if (last && last.by !== by && now - last.at < ECHO_MS) return;
  ran.set(id, { by, at: now });
  run();
}

export const byKey = (id: string, run: () => void): void => dedupe('key', id, run);
export const byMenu = (id: string, run: () => void): void => dedupe('menu', id, run);

/**
 * A workspace's Files, Diff and Terminal used to replace the chat. Whatever still asks for them
 * (Run, /review, a notification, "Open File" in a diff) now shows that tab in the panel (or the
 * terminal where you keep it), and the center stays on the conversation.
 */
export function useWorkspaceTabBridge(client: SocketClient): void {
  useEffect(() => {
    const check = (): void => {
      const state = client.store.getState();
      const view = state.view;
      if (view.kind !== 'workspace' || view.tab === 'chat') return;
      const chat: View = { ...view, tab: 'chat' };
      if (view.tab === 'review') showPanelTab({ ...state, view: chat }, 'changes');
      else if (view.tab === 'files') showPanelTab({ ...state, view: chat }, 'files');
      else revealTerminal({ ...state, view: chat }, false);
      client.store.dispatch({ type: 'view', view: chat });
    };
    check();
    return client.store.subscribe(check);
  }, [client]);
  // Somewhere else: the focus view was for the workspace you left.
  useEffect(
    () =>
      client.store.subscribe(() => {
        if (runtime.focus && filesWsOf(client.store.getState()) !== runtime.focus.wsId) closeFocus();
      }),
    [client],
  );
}
