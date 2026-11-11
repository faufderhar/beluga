/**
 * The menu bar, for a browser (docs/web.md): a page has no menu bar, so a button at the top of
 * the sidebar holds what the Mac's menu bar holds (src-tauri/src/menu.rs), Settings first. Each
 * row is a menu-bar id, run by `runMenuItem` as the menu bar's own click is.
 *
 * Left out: what does nothing in a browser (Check for Updates, the Window menu, Quit, Open the
 * Log, which opens a folder on the server) and what the toolbar already shows for the screen in
 * front (the Conversation and Workspace menus).
 */
export interface AppMenuRow {
  /** The menu-bar id it runs; none for a submenu. */
  readonly id?: string;
  readonly label: string;
  /** Starts a new group (a line above it). */
  readonly separate?: boolean;
  readonly submenu?: readonly AppMenuRow[];
}

export type Appearance = 'system' | 'light' | 'dark';

const row = (id: string, label: string, separate?: boolean): AppMenuRow => (separate ? { id, label, separate } : { id, label });

const FILE: readonly AppMenuRow[] = [
  row('new-chat', 'New Chat'),
  row('new-worktree', 'New Worktree…'),
  row('add-project', 'Add Project…'),
  row('share-folder', 'Share a Folder…', true),
  row('invite', 'Invite…'),
  row('add-friend', 'Add a Friend…', true),
  row('new-group', 'New Channel…'),
  row('onboarding', 'Onboard Again…', true),
];

const APPEARANCE: readonly AppMenuRow[] = [row('appearance-system', 'Match the System'), row('appearance-light', 'Light'), row('appearance-dark', 'Dark')];

const VIEW: readonly AppMenuRow[] = [
  row('toggle-sidebar', 'Toggle Sidebar'),
  row('toggle-inspector', 'Toggle Panel'),
  row('toggle-dock', 'Toggle Terminal'),
  { label: 'Appearance', separate: true, submenu: APPEARANCE },
  row('zoom-in', 'Bigger Text'),
  row('zoom-out', 'Smaller Text'),
  row('zoom-reset', 'Actual Size'),
];

const GO: readonly AppMenuRow[] = [
  row('go-overview', 'Overview'),
  row('go-tasks', 'Tasks'),
  row('go-issues', 'Issues'),
  row('go-actions', 'Actions'),
  row('go-sentinel', 'Sentinel'),
  row('go-dashboard', 'Dashboard'),
  row('go-search', 'Search'),
  row('go-usage', 'Usage'),
  row('go-terminal', 'Terminal'),
  row('go-files', 'Shared Files'),
  row('ws-prev', 'Previous Workspace', true),
  row('ws-next', 'Next Workspace'),
  row('inbox', 'Inbox', true),
];

/** The whole menu: Settings and the two ways to find anything, then the menu bar's menus. */
export const APP_MENU: readonly AppMenuRow[] = [
  row('settings', 'Settings…'),
  row('help-keys', 'Keys and Commands'),
  row('palette', 'Everything You Can Do…'),
  { label: 'File', separate: true, submenu: FILE },
  { label: 'View', submenu: VIEW },
  { label: 'Go', submenu: GO },
  row('help-welcome', 'Welcome to Beluga', true),
];

/** Every id the menu runs (a test keeps them in step with the menu bar's). */
export const appMenuIds = (rows: readonly AppMenuRow[] = APP_MENU): string[] => rows.flatMap((r) => (r.submenu ? appMenuIds(r.submenu) : r.id ? [r.id] : []));

/** The appearance a row picks, if it's one of View › Appearance's (it shows a check when it's yours). */
export const appearanceOf = (id: string | undefined): Appearance | undefined => {
  const m = /^appearance-(system|light|dark)$/.exec(id ?? '');
  return m ? (m[1] as Appearance) : undefined;
};
