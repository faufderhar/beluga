import type { BelugaClient } from '../ipc/client.js';
import type { Policy } from '../core/store.js';
import { THEMES } from '../shared/settings-schema.js';
import type { UiState } from './keymap.js';
import { type MenuKind, menuSpec } from './menus.js';
import { applyTheme } from './theme.js';
import { type UiAction, findWorkspace } from './workspace-models.js';
import { runCollabOption } from './collab-actions.js';
import { runWorkOption } from './work-actions.js';
import { runInviteOption } from './invite-actions.js';

export const POLICY_BY_OPTION: Record<string, Policy> = { 'share-ask': 'ask', 'share-auto': 'auto', 'share-deny': 'deny' };
export const POLICY_INDEX: Record<Policy, number> = { ask: 0, auto: 1, deny: 2 };

/** What a menu needs from the app to act. */
export interface MenuContext {
  readonly client: BelugaClient;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly typeInto: (buffer: string) => void;
  readonly askForName: (kind: 'worktree' | 'chat' | 'group', projectId: string) => void;
  readonly openFolder: (dir: string) => void;
  readonly runUiAction: (action: UiAction) => void;
  readonly write: (data: string) => void;
}

/** Run the option picked in a menu (by click, Enter or its number). */
export function runMenu(ctx: MenuContext, menu: MenuKind, index: number): void {
  const { client, patchUi, typeInto, askForName, openFolder, runUiAction } = ctx;
  const { api } = client;
  const latest = client.store.getState();
  const option = menuSpec(latest, menu)?.options[index];
  if (!option) return;
  if (runInviteOption(ctx, menu, option.id, index)) return;
  if (runCollabOption(ctx, menu, option.id)) return;
  if (runWorkOption(ctx, menu, option.id, index)) return;
  const peer = menu.kind === 'person' ? latest.peers[menu.index] : undefined;
  const policy = POLICY_BY_OPTION[option.id];
  if (policy) {
    void api.session.setClaudeSharing(policy);
    const msg = { ask: "You'll approve each request for your agent", auto: 'Everyone in the room can use your agent', deny: 'Your agent is private' };
    client.store.dispatch({ type: 'toast', text: msg[policy], level: 'success' });
    return;
  }
  const reopen = (): void => patchUi({ menu: { menu, selected: index } });
  const confirmId = menu.kind === 'confirm' ? menu.id : undefined;
  // What the dialog's question about threads said. With none, the calls stay as they were.
  const children = menu.kind === 'confirm' ? menu.children : undefined;
  const archive = (id: string, force?: boolean) => (children ? api.workspaces.archive(id, force ?? false, { children }) : force === undefined ? api.workspaces.archive(id) : api.workspaces.archive(id, force));
  const remove = (id: string) => (children ? api.workspaces.remove(id, { children }) : api.workspaces.remove(id));
  const project = menu.kind === 'project' ? latest.projects.find((p) => p.id === menu.id) : undefined;
  const archived = menu.kind === 'archived' ? findWorkspace(latest.projects, menu.id) : undefined;
  if (option.id.startsWith('p-group:') && project) {
    void api.workspaces.setGroup(project.id, option.id.slice('p-group:'.length));
    return;
  }
  switch (option.id) {
    case 'p-worktree':
      if (project) runUiAction({ type: 'new_worktree', projectId: project.id });
      return;
    case 'p-chat':
      if (project) runUiAction({ type: 'new_chat', projectId: project.id });
      return;
    case 'p-finder':
      if (project) openFolder(project.root);
      return;
    case 'p-newgroup':
      if (project) askForName('group', project.id);
      return;
    case 'p-ungroup':
      if (project) void api.workspaces.setGroup(project.id, undefined);
      return;
    case 'p-hide':
      if (project) void api.workspaces.hideProject(project.id);
      return;
    case 'p-agents':
      if (project) patchUi({ menu: { menu: { kind: 'agents', projectId: project.id }, selected: 0 } });
      return;
    case 'agents-clean':
      if (menu.kind === 'agents') void api.workspaces.cleanAgentWorktrees(menu.projectId);
      return;
    case 'a-restore':
      if (archived) void api.workspaces.restore(archived.id);
      return;
    case 'a-open':
      if (archived) void api.workspaces.open(archived.id);
      return;
    case 'a-finder':
      if (archived) openFolder(archived.projectRoot || archived.path);
      return;
    case 'a-delete':
      if (archived) patchUi({ menu: { menu: { kind: 'confirm', action: 'delete', id: archived.id }, selected: 0 } });
      return;
    case 'confirm-archive':
    case 'confirm-archive-force':
      if (confirmId) void archive(confirmId, option.id === 'confirm-archive-force');
      return;
    case 'confirm-commit-archive':
      if (confirmId) void api.workspaces.commit(confirmId).then(() => void archive(confirmId));
      return;
    case 'confirm-delete':
      if (confirmId) void remove(confirmId);
      return;
    case 'confirm-archive-env':
    case 'confirm-delete-env':
    case 'confirm-archive-env-all':
    case 'confirm-delete-env-all':
      if (confirmId) {
        // -all: keys removed in the worktree go from the main folder's file too.
        void api.workspaces.applyEnvBack(confirmId, option.id.endsWith('-all')).then(() => void (option.id.startsWith('confirm-archive') ? archive(confirmId, true) : remove(confirmId)));
      }
      return;
    case 'set-name':
      typeInto('/name ');
      return;
    case 'set-theme': {
      const next = THEMES[(THEMES.indexOf(latest.prefs.theme) + 1) % THEMES.length] ?? 'calm';
      applyTheme(next);
      void api.session.setPrefs({ theme: next });
      reopen();
      return;
    }
    case 'size-in':
    case 'size-out':
    case 'size-reset':
      void api.session.zoom(option.id === 'size-in' ? 'in' : option.id === 'size-out' ? 'out' : 'reset');
      reopen();
      return;
    case 'settings':
      patchUi({ menu: { menu: { kind: 'settings' }, selected: 0 } });
      return;
    case 'close':
      return;
    case 'ask':
      typeInto(`@claude:${peer?.name ?? ''} `);
      return;
    case 'person-run':
      if (peer) {
        patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind: 'peer_run', projectId: '', peerId: peer.peerId } });
        client.store.dispatch({ type: 'toast', text: `Type the command to run on ${peer.name}'s computer, then Enter` });
      }
      return;
    case 'ask-self':
      typeInto('@claude ');
      return;
    case 'follow':
    case 'unfollow':
      void api.session.follow(option.id === 'follow' ? peer?.name : undefined);
      return;
    case 'browse': {
      const share = peer?.shares[0];
      if (peer && share) void api.files.browseTo({ owner: peer.peerId, share: share.name, path: '' });
      client.store.dispatch({ type: 'view', view: { kind: 'files' } });
      patchUi({ focus: 'files' });
      return;
    }
    case 'set-self-approval':
      void api.session.setPrefs({ selfApproval: latest.prefs.selfApproval === 'ask' ? 'never' : 'ask' });
      reopen();
      return;
    case 'invite':
      void api.session.copyInvite();
      return;
    case 'sharing':
      patchUi({ menu: { menu: { kind: 'settings', section: 'people' }, selected: 0 } });
      return;
  }}
