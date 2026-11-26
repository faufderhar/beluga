import type { View } from '../../../../src/core/store.js';
import { isSentinelView } from '../sentinel/sentinel-model.js';

/**
 * The right panel, as plain data: which tabs a view has, which ones it opens on, how its dock
 * starts, how wide it may get, and how older window preferences carry over. No DOM here, so it's
 * tested on its own.
 */

export type PanelTab = 'changes' | 'files' | 'terminal' | 'info' | 'history' | 'scratch' | 'background' | 'phone';

/** Every tab in its fixed place: ⌥⌘1 is always Changes, ⌥⌘4 always Info, ⌥⌘5 History, ⌥⌘6 Scratch, ⌥⌘7 Background, ⌥⌘8 Phone. */
export const PANEL_TABS: readonly PanelTab[] = ['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background', 'phone'];

export const PANEL_LABELS: Record<PanelTab, string> = { changes: 'Changes', files: 'Files', terminal: 'Terminal', info: 'Info', history: 'History', scratch: 'Scratch', background: 'Background', phone: 'Phone' };

/**
 * The panel is a dock (Dockview): its tabs sit in groups you arrange by dragging, side by side or
 * one above the other. They start as two groups: what Claude made on top (Changes, Files, Scratch,
 * Info) and what runs below (Terminal, Background). History is Changes' second view, not a tab of its own.
 */
export interface PanelLayout {
  readonly top: readonly PanelTab[];
  readonly bottom: readonly PanelTab[];
}

/** The tabs with a place of their own (every one of them is in exactly one group). */
export const SLOTS: readonly PanelTab[] = ['changes', 'files', 'scratch', 'info', 'terminal', 'background', 'phone'];
export const DEFAULT_LAYOUT: PanelLayout = { top: ['changes', 'files', 'scratch', 'info', 'phone'], bottom: ['terminal', 'background'] };

/**
 * What a dock's group can show: one of the panel's tabs, or the center's own content ('main': the
 * conversation, or whatever page is open), which a tab dragged beside the chat can share a group with.
 */
export type DockTab = PanelTab | 'main';
export const MAIN: DockTab = 'main';

/** The tab a view lives in: History is inside Changes. */
export function slotOf(tab: PanelTab): PanelTab;
export function slotOf(tab: DockTab): DockTab;
export function slotOf(tab: DockTab): DockTab {
  return tab === 'history' ? 'changes' : tab;
}

/** A saved start layout (the two panes from before the dock) made whole: each tab once, unknown ones dropped, missing ones back where they start. */
export function normalizeLayout(raw: unknown): PanelLayout {
  const read = (v: unknown): PanelTab[] => (Array.isArray(v) ? v.filter((t): t is PanelTab => SLOTS.includes(t as PanelTab)) : []);
  const r = (raw ?? {}) as { top?: unknown; bottom?: unknown };
  const top = [...new Set(read(r.top))];
  const bottom = [...new Set(read(r.bottom))].filter((t) => !top.includes(t));
  for (const slot of SLOTS) {
    if (top.includes(slot) || bottom.includes(slot)) continue;
    (DEFAULT_LAYOUT.bottom.includes(slot) ? bottom : top).push(slot);
  }
  return { top, bottom };
}

/** The dock's tabs for what's on screen, in their fixed order (a project's home has History in Changes' place). */
export const slotsFor = (available: readonly PanelTab[]): PanelTab[] => SLOTS.filter((slot) => available.some((t) => slotOf(t) === slot));

/** Views with the same tabs share one arrangement (a worktree's, a chat's, a project's page…). */
export const layoutKey = (available: readonly PanelTab[]): string => slotsFor(available).join('+');

/**
 * How the dock starts for these tabs: the top group and the one below it, in the order of `start`
 * (the two panes you had before the dock carry over). With nothing on top, what runs is the only group.
 */
export function startGroups(slots: readonly PanelTab[], start: PanelLayout = DEFAULT_LAYOUT): { top: PanelTab[]; bottom: PanelTab[] } {
  const top = start.top.filter((t) => slots.includes(t));
  const bottom = start.bottom.filter((t) => slots.includes(t));
  return top.length ? { top, bottom } : { top: bottom, bottom: [] };
}

/**
 * Where a tab that isn't in the dock yet goes (a phone was paired, Scratch turned on): the group
 * holding the most tabs it starts beside, or -1 when there isn't one (it gets a group of its own).
 */
export function homeGroup(slot: PanelTab, groups: ReadonlyArray<readonly PanelTab[]>, start: PanelLayout = DEFAULT_LAYOUT): number {
  const beside = start.bottom.includes(slot) ? start.bottom : start.top;
  let best = -1;
  let most = 0;
  groups.forEach((g, i) => {
    const n = g.filter((t) => beside.includes(t)).length;
    if (n > most) [best, most] = [i, n];
  });
  return best;
}

/** The views a tab switches between at its top (Changes · History), or just itself. */
export function viewsOf(tab: PanelTab, available: readonly PanelTab[]): PanelTab[];
export function viewsOf(tab: DockTab, available: readonly PanelTab[]): DockTab[];
export function viewsOf(tab: DockTab, available: readonly PanelTab[]): DockTab[] {
  return slotOf(tab) === 'changes' ? (['changes', 'history'] as const).filter((t) => available.includes(t)) : [tab];
}

/**
 * The tabs you moved beside the chat (into the center's dock), for each set of tabs: the rest are
 * in the right panel's dock. Only tabs this view has count.
 */
export type CenterTabs = Readonly<Record<string, readonly PanelTab[]>>;
export const centerSlots = (map: CenterTabs, key: string, slots: readonly PanelTab[]): PanelTab[] => slots.filter((t) => (map[key] ?? []).includes(t));

/** Move a tab beside the chat, or back to the panel (for this set of tabs). */
export function placeInCenter(map: CenterTabs, key: string, slot: PanelTab, inCenter: boolean): Record<string, readonly PanelTab[]> {
  const rest = (map[key] ?? []).filter((t) => t !== slot);
  const next = inCenter ? [...rest, slot] : rest;
  const others = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries(next.length ? [...others.slice(Math.max(0, others.length - REMEMBERED_LAYOUTS + 1)), [key, next]] : others);
}

/** Where the center's arrangement for a set of tabs is kept, beside the panel's (see rememberLayout). */
export const centerKey = (key: string): string => `center:${key}`;

/** How many workspaces' last tabs are remembered (the oldest are forgotten). */
export const REMEMBERED_TABS = 100;
/** How many of a place's last tabs are remembered (one shows per group; there are never more groups than tabs). */
export const SHOWN_MAX = 8;

/**
 * The tabs you last showed in each place, oldest first: per workspace ('ws:<id>') and one list for
 * everything else ('app'). Showing a tab puts it last; the oldest places are forgotten.
 */
export type ShownTabs = Readonly<Record<string, readonly DockTab[]>>;

export function rememberShown(map: ShownTabs, key: string, tab: DockTab): Record<string, readonly DockTab[]> {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  // Changes and History are one tab: the view you picked last is the one remembered.
  const list = [...(map[key] ?? []).filter((t) => slotOf(t) !== slotOf(tab)), tab].slice(-SHOWN_MAX);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - REMEMBERED_TABS + 1)), [key, list]]);
}

/**
 * The tab a group shows: the one of its tabs you showed last here, else Changes when there are
 * changes, else Info, else its first. `group` is the group's tabs; `available` what the view has.
 */
export function shownIn(group: readonly PanelTab[], recent: readonly DockTab[], available: readonly PanelTab[], hasChanges: boolean): PanelTab | undefined;
export function shownIn(group: readonly DockTab[], recent: readonly DockTab[], available: readonly PanelTab[], hasChanges: boolean): DockTab | undefined;
export function shownIn(group: readonly DockTab[], recent: readonly DockTab[], available: readonly PanelTab[], hasChanges: boolean): DockTab | undefined {
  const views = group.flatMap((t) => viewsOf(t, available));
  for (let i = recent.length - 1; i >= 0; i--) if (views.includes(recent[i]!)) return recent[i];
  // Beside the chat, the chat shows until you pick a tab.
  if (views.includes(MAIN)) return MAIN;
  if (hasChanges && views.includes('changes')) return 'changes';
  return views.includes('info') ? 'info' : views[0];
}

/** How many arrangements are kept (the panel's and the center's, per set of tabs; the oldest are forgotten). */
export const REMEMBERED_LAYOUTS = 24;

/** Keep an arrangement for a set of tabs (Dockview's own saved layout, as it gives it). */
export function rememberLayout(map: Readonly<Record<string, unknown>>, key: string, layout: unknown): Record<string, unknown> {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - REMEMBERED_LAYOUTS + 1)), [key, layout]]);
}

/** A saved arrangement can be shown: it's Dockview's shape and holds only tabs the panel knows. */
export function usableLayout(layout: unknown): boolean {
  const l = layout as { grid?: { root?: unknown }; panels?: unknown } | null | undefined;
  if (!l || typeof l !== 'object' || !l.grid || typeof l.grid !== 'object' || !l.grid.root || !l.panels || typeof l.panels !== 'object') return false;
  const ids = Object.keys(l.panels);
  return ids.length > 0 && ids.every((id) => id === MAIN || SLOTS.includes(id as PanelTab));
}

export const PANEL_MIN = 320;
export const PANEL_DEFAULT = 384;
/** The panel never takes more than this share of the window. */
export const PANEL_MAX_SHARE = 0.6;

/** The sidebar is as wide as you drag it, within these (Settings › Appearance has the same range). */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 360;
export const SIDEBAR_DEFAULT = 248;

/** How much of the panel's height the top group takes, to start with. */
export const PANES_DEFAULT = 0.58;
/** A group under another one is a dock: folded (⌘J, its chevron) it's just its strip of tabs (this tall, where it can't be measured). */
export const DOCK_HEAD = 36;

export const SPLIT_MIN = 0.18;
export const SPLIT_MAX = 0.75;
export const SPLIT_DEFAULT = 0.4;

/**
 * In those tabs, with this much room the preview goes beside the list instead of under it (a tab
 * dragged beside the chat, a wide panel): room for a list and a readable file.
 */
export const SPLIT_SIDE_WIDTH = 560;
export const splitsSideways = (width: number): boolean => width >= SPLIT_SIDE_WIDTH;
/** Side by side, the list's share of the width. */
export const SIDE_MIN = 0.22;
export const SIDE_MAX = 0.6;
export const SIDE_DEFAULT = 0.34;

export const DRAWER_MIN = 0.18;
export const DRAWER_MAX = 0.75;
export const DRAWER_DEFAULT = 0.36;

/** Where the terminal is kept: under the chat ('drawer', the name from when it was a drawer there) or in the right panel. */
export type TerminalPlace = 'drawer' | 'panel';

/** What kind of workspace (a chat has no git, so no Changes). */
type WsKind = 'chat' | 'main' | 'worktree' | string;

/**
 * The panel's tabs for what's on screen, in their fixed order. With a phone paired (`phone`), its
 * live mirror is a tab beside Your Mac's chat (BLG-186), where Ask Claude on the Phone page takes
 * you. Not beside a project's chats: nothing there is about the phone.
 */
export function panelTabsFor(view: View, wsKind?: WsKind, phone = false): PanelTab[] {
  const tabs = tabsOfView(view, wsKind);
  return phone && tabs.length && view.kind === 'assistant' ? [...tabs, 'phone'] : tabs;
}

function tabsOfView(view: View, wsKind?: WsKind): PanelTab[] {
  // Scratch: what Claude saves to the workspace's .beluga/scratch/ while it works, live.
  // Background: the commands Claude and its agents run there in the background (dev servers, tests), live.
  if (view.kind === 'workspace') return wsKind === 'chat' ? ['files', 'terminal', 'info', 'scratch', 'background'] : PANEL_TABS.filter((t) => t !== 'phone');
  // A project's home (and its History page): its main folder's Files, and the project's history too.
  if (view.kind === 'project') return ['files', 'terminal', 'info', 'history'];
  // A plan's page is the plan and its chat, side by side; the Tasks board, a task's page and the plans have the whole window.
  if (!panelFits(view)) return [];
  // A shared workspace's shell is its owner's (its Scratch you see, read over the link); the Terminal view is already all shells.
  if (view.kind === 'shared') return ['info', 'scratch'];
  if (view.kind === 'terminal') return ['info'];
  // Your Mac's chat: its scratch folder too, which all its chats share (BLG-704).
  if (view.kind === 'assistant') return ['terminal', 'info', 'scratch'];
  return ['terminal', 'info'];
}

/**
 * The right panel shows beside this view: not on a plan's page (its right side is its chat), nor
 * on the Tasks board, a task's page, the plans, Usage or Sentinel's pages: nothing in it is about them, so they get the whole window.
 */
const WHOLE_WINDOW: ReadonlySet<View['kind']> = new Set(['plan', 'plans', 'tasks', 'task', 'gh_issue', 'gh_run', 'usage']);
export const panelFits = (view: View): boolean => !WHOLE_WINDOW.has(view.kind) && !isSentinelView(view.kind);

/** Where a view's last tabs are remembered: per workspace, one for everything else. */
export const panelKey = (view: View): string => (view.kind === 'workspace' ? `ws:${view.id}` : 'app');

/**
 * The room the center (the conversation and its toolbar) always keeps beside the panel: its name
 * gives way to … first, down to this, and then the panel stops growing instead of covering it.
 */
export const CENTER_MIN = 480;
/** The least the center is ever squeezed to, in a window too small for all three (the frame's own floor). */
export const CENTER_FLOOR = 360;

/**
 * The panel's width for a window this wide: at least PANEL_MIN, at most PANEL_MAX_SHARE of it,
 * and never so wide that the center (beside a sidebar `sidebarWidth` wide) gets under CENTER_MIN.
 */
export function clampPanelWidth(width: number, windowWidth: number, sidebarWidth = 0): number {
  const max = Math.max(PANEL_MIN, Math.min(Math.floor(windowWidth * PANEL_MAX_SHARE), windowWidth - sidebarWidth - CENTER_MIN));
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

export const clampShare = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/** A terminal under the chat works under any conversation or page, but not over the Terminal view or a friend's workspace. */
export const drawerFits = (view: View): boolean => view.kind !== 'terminal' && view.kind !== 'shared';

/**
 * The terminal is under the chat (a tab in the center's dock: what the bottom drawer was), not in
 * the panel: because that's where you keep it (Settings › Terminal, or you dragged it there), or
 * because this view's panel has no Terminal tab (the Tasks board, a plan's page), where ⌘J still opens one.
 */
export const terminalUnderChat = (termIn: TerminalPlace, available: readonly PanelTab[], view: View): boolean => (termIn === 'drawer' || !available.includes('terminal')) && drawerFits(view);

/** The ⌥⌘ digit for a tab (1–8). */
export const panelDigit = (tab: PanelTab): number => PANEL_TABS.indexOf(tab) + 1;

/**
 * Preferences saved by earlier versions, brought up to date. The terminal used to dock beside
 * the chat (`dock: 'right'`) or under it (`'bottom'`): beside becomes the right panel's Terminal
 * tab, under becomes the bottom drawer (kept open, at the same height). And the panel's two panes
 * became a dock: see shownFromTabs.
 */
export function migratePrefs(raw: Record<string, unknown>): Record<string, unknown> {
  return shownFromTabs(terminalFromDock(raw));
}

function terminalFromDock(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('dock' in raw) && !('dockSize' in raw)) return raw;
  const { dock, dockSize, ...rest } = raw;
  const next: Record<string, unknown> = { ...rest };
  if (dock === 'right') next.termIn ??= 'panel';
  if (dock === 'bottom') {
    next.termIn ??= 'drawer';
    next.drawer ??= true;
  }
  if (typeof dockSize === 'number' && next.drawerSize === undefined) next.drawerSize = clampShare(dockSize, DRAWER_MIN, DRAWER_MAX);
  return next;
}

/**
 * Before the dock, each of the panel's two panes remembered one tab per place (`panelTabs`:
 * 'ws:<id>' for the top pane, 'ws:<id>|bottom' for the bottom one). Now a place remembers the
 * tabs you showed last, whichever groups they're in (`panelShown`): the same tabs show after the update.
 */
function shownFromTabs(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('panelTabs' in raw)) return raw;
  const { panelTabs, ...rest } = raw;
  if (rest.panelShown !== undefined || !panelTabs || typeof panelTabs !== 'object') return rest;
  let shown: ShownTabs = {};
  for (const [k, tab] of Object.entries(panelTabs as Record<string, unknown>)) {
    if (PANEL_TABS.includes(tab as PanelTab)) shown = rememberShown(shown, k.replace(/\|bottom$/, ''), tab as PanelTab);
  }
  return { ...rest, panelShown: shown };
}
