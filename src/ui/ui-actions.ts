import type { MutableRefObject } from 'react';
import type { BelugaClient } from '../ipc/client.js';
import { globalShellId, globalShellNumber, isGlobalShell, runId, setupId } from '../shared/terminal-keys.js';
import { runCollabUiAction } from './collab-actions.js';
import type { UiState } from './keymap.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import { type UiAction, findWorkspace, toggleProject } from './workspace-models.js';

/** What clicking things (and pressing Enter on them) needs from the app. */
export interface UiActionContext {
  readonly client: BelugaClient;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly uiRef: MutableRefObject<UiState>;
  readonly toggle: (key: string) => void;
  readonly typeInto: (buffer: string) => void;
  readonly menuCtx: () => MenuContext;
  readonly runMenu: (menu: MenuKind, index: number) => void;
  /** Open a link from the chat (each screen opens files, folders and URLs its own way). */
  readonly openLink: (link: Extract<UiAction, { type: 'open_link' }>['link']) => void;
  /** Attach the image on the clipboard to the message being written. */
  readonly pasteImage: () => void;
}

/** Do what a clicked button, row or card means. */
export function runUiActionWith(c: UiActionContext, action: UiAction): void {
  const { client, patchUi, uiRef, toggle, typeInto, runMenu } = c;
  const { api, store } = client;
  if (runCollabUiAction(c.menuCtx(), action)) return;
  switch (action.type) {
    case 'open_ws': {
      // Shown at once, not after the daemon's answer (behind whatever else it's sending while Claudes stream).
      const req = findWorkspace(store.getDomain().projects, action.id) ? store.openAhead(action.id, action.tab ?? 'chat') : undefined;
      void api.workspaces.open(action.id, action.tab ?? 'chat', req ? { req } : undefined);
      // Opening a view puts you inside it: the file list, the diff, the terminal, or the chat.
      patchUi(action.tab === 'review' ? { focus: 'main', entered: true } : action.tab === 'files' ? { focus: 'files', entered: true } : action.tab === 'terminal' ? { focus: 'terminal', terminalScroll: 0 } : { focus: 'chat', entered: false });
      return;
    }
    case 'open_link':
      c.openLink(action.link);
      return;
    case 'paste_image':
      c.pasteImage();
      return;
    case 'inbox':
      patchUi({ menu: { menu: { kind: 'inbox' }, selected: 0 } });
      return;
    case 'model_menu':
      patchUi({ menu: { menu: { kind: 'model', ...(action.channel === 'room' ? {} : { channel: action.channel }) }, selected: 0 } });
      return;
    case 'templates_menu':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return;
    case 'template': {
      const t = store.getState().templates.find((x) => x.id === action.id);
      if (t) runMenu({ kind: 'templates' }, store.getState().templates.indexOf(t));
      return;
    }
    case 'trust':
      void api.people.setTrust(action.peerId, action.level);
      return;
    case 'trust_later':
      void api.people.dismissPrompt(action.peerId);
      return;
    case 'search_hit': {
      const hit = store.getState().search.hits[action.index];
      store.dispatch({ type: 'search_cursor', cursor: action.index });
      void api.workbench.openHit(action.index);
      // The box shows that chat's own unsent words (the Mac's Composer keeps each chat's).
      patchUi({ focus: 'chat', ...(hit ? { chatJump: { channel: hit.channel, ...(hit.id ? { id: hit.id } : {}), ts: hit.ts, at: Date.now() } } : {}) });
      return;
    }
    case 'ws_more':
      patchUi({ menu: { menu: { kind: 'ws_more', id: action.id, actions: action.actions }, selected: 0 } });
      return;
    case 'term_tab':
      patchUi({ termKey: action.key, terminalScroll: 0, focus: 'terminal' });
      return;
    case 'term_new': {
      // The Terminal tab starts it (in the current project's folder) once it's selected.
      const next = Math.max(0, ...Object.keys(store.getState().terminals).filter(isGlobalShell).map(globalShellNumber)) + 1;
      patchUi({ termKey: globalShellId(next), terminalScroll: 0, focus: 'terminal' });
      return;
    }
    case 'toggle_project': {
      const latest = store.getState();
      const project = latest.projects.find((p) => p.id === action.id);
      if (project) patchUi({ collapsed: toggleProject(latest, project, uiRef.current.collapsed) });
      return;
    }
    case 'toggle_group':
      toggle(`group:${action.name}`);
      return;
    case 'toggle_archive':
      toggle(`archive:${action.projectId}`);
      return;
    case 'toggle_fold':
      toggle(action.key);
      return;
    case 'agents_menu':
      patchUi({ menu: { menu: { kind: 'agents', projectId: action.projectId }, selected: 0 } });
      return;
    case 'project_menu':
      patchUi({ menu: { menu: { kind: 'project', id: action.id }, selected: 0 } });
      return;
    case 'archived_menu':
      patchUi({ menu: { menu: { kind: 'archived', id: action.id }, selected: 0 } });
      return;
    case 'none':
      return;
    case 'new_worktree': {
      // Like a new chat: describe the task, and a small model names the worktree from it.
      const latest = store.getState();
      const back = latest.view.kind === 'draft' || latest.view.kind === 'draft_worktree' ? latest.view.back : latest.view;
      store.dispatch({ type: 'view', view: { kind: 'draft_worktree', projectId: action.projectId, back } });
      // Its box starts empty, or with what you left unsent there (never another chat's words).
      patchUi({ focus: 'chat' });
      return;
    }
    case 'new_chat': {
      // An empty chat opens right away; it's only created when you send the first message.
      const latest = store.getState();
      const back = latest.view.kind === 'draft' ? latest.view.back : latest.view;
      // The Mac app has no launch folder (''): its chats get their own scratch folder.
      const dir = action.projectId === 'chats' && client.launchDir ? client.launchDir : undefined;
      store.dispatch({ type: 'view', view: { kind: 'draft', projectId: action.projectId, dir, back } });
      patchUi({ focus: 'chat' });
      return;
    }
    case 'add_project':
      typeInto('/project add ~/');
      return;
    case 'view':
      store.dispatch({ type: 'view', view: action.view });
      if (action.view.kind === 'files') {
        store.dispatch({ type: 'browser_cursor', delta: -10_000 });
        patchUi({ focus: 'files', entered: true });
      } else if (action.view.kind === 'terminal') patchUi({ focus: 'terminal', terminalScroll: 0 });
      else patchUi({ focus: action.view.kind === 'overview' ? 'main' : 'chat', entered: action.view.kind === 'overview' });
      return;
    case 'close_tab':
      store.dispatch({ type: 'close_tab', id: action.id });
      return;
    case 'review_file':
      if (store.getState().view.kind === 'shared') void api.diff.select(action.index);
      else void api.workspaces.selectFile(action.index);
      patchUi({ focus: 'main' });
      return;
    case 'ws': {
      const ws = findWorkspace(store.getState().projects, action.id);
      if (!ws) return;
      const w = api.workspaces;
      switch (action.action) {
        case 'merge':
          void w.merge(ws.id);
          return;
        case 'commit':
          void w.commit(ws.id);
          return;
        case 'fork':
          void w.open(ws.id);
          typeInto(`/fork ${ws.name}-2`);
          return;
        case 'finder':
          void w.openInFinder(ws.id);
          return;
        case 'archive':
        case 'delete':
          void w.prepareRemoval(ws.id);
          patchUi({ menu: { menu: { kind: 'confirm', action: action.action, id: ws.id }, selected: 0 } });
          return;
        case 'restore':
          void w.restore(ws.id);
          return;
        case 'review_claude':
          void w.askClaudeToReview(ws.id);
          return;
        case 'merge_claude':
          void w.askClaudeToMerge(ws.id);
          return;
        case 'compact':
          void w.compact(ws.id);
          return;
        case 'pr':
          patchUi({ menu: { menu: { kind: 'pr', id: ws.id }, selected: 0 } });
          void api.workbench.refreshPrs(ws.id);
          return;
        case 'run':
          void api.workbench.run(ws.id);
          void w.open(ws.id, 'terminal');
          patchUi({ termKey: runId(ws.id), terminalScroll: 0, focus: 'terminal' });
          return;
        case 'stop_run':
          void api.workbench.stopRun(ws.id);
          return;
        case 'setup':
          void api.workbench.runSetup(ws.id);
          void w.open(ws.id, 'terminal');
          patchUi({ termKey: setupId(ws.id), terminalScroll: 0 });
          return;
      }
    }
  }
  
}
