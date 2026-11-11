import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { MenuKind } from '@beluga/ui/menus.js';
import type { UiAction } from '@beluga/ui/workspace-models.js';
import type { SettingsPane, UiStore } from './beluga.js';
import { inApp } from './boot.js';
import { pickFolders } from './projects.js';
import { openSheet } from './sheets.js';

/**
 * Where the Mac app answers what the shared action runners ask by typing. They put
 * a /command into the message box ("/fork add-auth-2", "/template save ") or make the box ask
 * for a name; here each of those opens the sheet, alert or settings pane that does it.
 */
export interface RouteContext {
  readonly client: SocketClient;
  readonly ui: UiStore;
  readonly run: (action: UiAction) => void;
}

/**
 * Menu options that take something away: an alert asks first. (Removing a person and leaving
 * the room ask in the person popover itself.)
 */
export function asksFirst(id: string): boolean {
  return id === 'p-hide' || id === 'sh-leave';
}

/** Open a pane of the Settings window (and put the cursor in the name field for "Your name"). */
export function openSettings(ui: UiStore, pane: SettingsPane, focus?: string): void {
  ui.patch({ menu: undefined, settings: pane });
  if (focus) setTimeout(() => document.getElementById(focus)?.focus(), 80);
}

const viewedWorkspace = (client: SocketClient): string | undefined => {
  const view = client.store.getState().view;
  return view.kind === 'workspace' ? view.id : undefined;
};

const viewedProject = (client: SocketClient): string | undefined => {
  const state = client.store.getState();
  const view = state.view;
  if (view.kind === 'draft' || view.kind === 'draft_worktree') return view.projectId;
  const wsId = viewedWorkspace(client);
  return wsId ? state.projects.find((p) => p.workspaces.some((w) => w.id === wsId))?.id : undefined;
};

/** Share a folder: the Open panel picks it, then who sees it. */
export function shareAFolder({ client, ui }: RouteContext): void {
  if (!inApp()) return ui.openMenu({ kind: 'share_folder', launchDir: client.launchDir, mine: client.store.getState().myShares });
  void pickFolders('Share a folder').then((picked) => {
    if (picked?.[0]) ui.openMenu({ kind: 'share_who', dir: picked[0] });
  });
}

/** A /command the shared code wanted typed: do it the Mac way. False: it's chat text after all. */
export function routeTyped(ctx: RouteContext, text: string): boolean {
  const { client, ui, run } = ctx;
  if (!text.startsWith('/')) return false;
  const [cmd = '', ...rest] = text.slice(1).split(' ');
  const wsId = viewedWorkspace(client);
  const projectId = viewedProject(client);
  switch (cmd) {
    case 'project':
      if ((rest[0] === 'setup' || rest[0] === 'run') && projectId) ui.openMenu({ kind: 'scripts', projectId });
      else ui.patch({ addProject: rest[0] === 'new' || rest[0] === 'clone' ? rest[0] : true });
      return true;
    case 'fork':
      if (wsId) openSheet({ kind: 'fork', wsId });
      return true;
    case 'name':
      openSettings(ui, 'general', 'settings-name');
      return true;
    case 'template':
      if (rest[0] === 'save') openSheet({ kind: 'template' });
      else ui.openMenu({ kind: 'templates' });
      return true;
    case 'pr':
      if (wsId) ui.openMenu({ kind: 'pr', id: wsId });
      return true;
    case 'env':
      openSettings(ui, 'environment');
      return true;
    case 'shell':
      openSettings(ui, 'terminal');
      return true;
    case 'share':
      shareAFolder(ctx);
      return true;
    case 'new':
      if (projectId) run({ type: 'new_worktree', projectId });
      return true;
    case 'chat':
      run({ type: 'new_chat', projectId: projectId ?? 'chats' });
      return true;
    case 'handoff':
      if (wsId) ui.openMenu({ kind: 'handoff', id: wsId });
      return true;
    case 'run':
      openSheet({ kind: 'peer_run' });
      return true;
    default:
      return false;
  }
}

/** A menu option the shared runner answers by typing: open its sheet instead. True: handled. */
export function routeOption(ctx: RouteContext, menu: MenuKind, id: string): boolean {
  const { client, ui } = ctx;
  const state = client.store.getState();
  if (id.startsWith('rws:') && menu.kind === 'remote_ws') {
    openSheet({ kind: 'remote', peerId: menu.peerId, project: id.slice(4) });
    return true;
  }
  if (id.startsWith('env:')) {
    openSettings(ui, 'environment');
    return true;
  }
  switch (id) {
    case 'person-run': {
      const peer = menu.kind === 'person' ? state.peers[menu.index] : undefined;
      if (peer) openSheet({ kind: 'peer_run', peerId: peer.peerId });
      return Boolean(peer);
    }
    case 'set-name':
      openSettings(ui, 'general', 'settings-name');
      return true;
    case 'tpl-save':
      openSheet({ kind: 'template' });
      return true;
    case 'pr-create-note':
      if (menu.kind === 'pr') ui.openMenu(menu);
      return true;
    case 's-setup':
    case 's-run':
      if (menu.kind === 'scripts') ui.openMenu(menu);
      return true;
    case 'env-add':
      openSettings(ui, 'environment');
      return true;
    case 'sh-other':
    case 'sh-args':
      openSettings(ui, 'terminal');
      return true;
    case 'sf-type':
      shareAFolder(ctx);
      return true;
    default:
      return false;
  }
}
