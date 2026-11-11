import type { View } from '../../../../src/core/store.js';
import { groupChatOpen } from './group-chat.js';
import type { PanelSnapshot } from './nav-history.js';
import { type PanelTab, drawerFits, paneKey, panelFits, rememberTab } from './panel-model.js';

/**
 * What Back and Forward need to know about pages, as plain data: whether a page is still there
 * (a worktree archived, a task or a project deleted: it's skipped), and the window preferences
 * that put a page's panels back as you left them.
 */

/** The parts of the shared state that say whether a page is still there. */
export interface AliveState {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly workspaces: ReadonlyArray<{ readonly id: string; readonly archived?: boolean }> }>;
  readonly board: { readonly enabled: boolean; readonly issues: ReadonlyArray<{ readonly id: string }> };
  readonly plans: { readonly plans: ReadonlyArray<{ readonly id: string }> };
  readonly sentinel: { readonly items: ReadonlyArray<{ readonly id: string }> };
  /** Who's in the room, you included: its group chat is a page only while someone else is (BLG-871). */
  readonly peers: ReadonlyArray<unknown>;
}

/** Sentinel's "Your Mac" (sentinel-model's MAC_SCOPE): a scope, not a project. */
const MAC_SCOPE = 'mac';

/** The project a view is of, if it names one. */
function projectOf(view: View): string | undefined {
  switch (view.kind) {
    case 'tasks':
    case 'issues':
    case 'actions':
    case 'plans':
    case 'worktrees':
      return view.projectId;
    case 'sentinel':
      return view.projectId === MAC_SCOPE ? undefined : view.projectId;
    case 'gh_issue':
    case 'gh_run':
    case 'draft':
    case 'draft_worktree':
      return view.projectId;
    default:
      return undefined;
  }
}

/** The page is still there to go back to. Places (Overview, Search, a list…) always are. */
export function pageAlive(state: AliveState, view: View): boolean {
  const project = projectOf(view);
  if (project !== undefined && !state.projects.some((p) => p.id === project)) return false;
  switch (view.kind) {
    case 'workspace':
      return state.projects.some((p) => p.workspaces.some((w) => w.id === view.id && !w.archived));
    case 'project':
      return state.projects.some((p) => p.id === view.id);
    case 'task':
      return state.board.enabled && state.board.issues.some((i) => i.id === view.id);
    case 'plan':
      return state.plans.plans.some((p) => p.id === view.id);
    case 'sentinel_page':
      return state.sentinel.items.some((s) => s.id === view.id);
    case 'room':
      return groupChatOpen(state);
    default:
      return true;
  }
}

/** The window preferences a page's panels are kept in (lib/prefs.ts). */
export interface PanelPrefs {
  readonly sidebar: boolean;
  readonly inspector: boolean;
  readonly bottomOpen: boolean;
  readonly drawer: boolean;
  readonly panelTabs: Readonly<Record<string, PanelTab>>;
}

/**
 * What to change in the preferences so `view` shows `panels` again: only what differs, and only
 * what the page has (a page with the whole window keeps the panel as it is for the others).
 */
export function restorePatch(prefs: PanelPrefs, view: View, panels: PanelSnapshot): Partial<PanelPrefs> {
  const fits = panelFits(view);
  let tabs = prefs.panelTabs;
  if (fits && panels.topTab && tabs[paneKey(view, 'top')] !== panels.topTab) tabs = rememberTab(tabs, paneKey(view, 'top'), panels.topTab);
  if (fits && panels.bottomTab && tabs[paneKey(view, 'bottom')] !== panels.bottomTab) tabs = rememberTab(tabs, paneKey(view, 'bottom'), panels.bottomTab);
  return {
    ...(panels.sidebar !== prefs.sidebar ? { sidebar: panels.sidebar } : {}),
    ...(fits && panels.inspector !== prefs.inspector ? { inspector: panels.inspector } : {}),
    ...(fits && panels.bottomOpen !== prefs.bottomOpen ? { bottomOpen: panels.bottomOpen } : {}),
    ...(drawerFits(view) && panels.drawer !== prefs.drawer ? { drawer: panels.drawer } : {}),
    ...(tabs !== prefs.panelTabs ? { panelTabs: tabs } : {}),
  };
}
