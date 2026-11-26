import { useMemo } from 'react';
import type { Location } from '@beluga/core/store.js';
import type { LinkTarget } from '@beluga/shared/link-target.js';
import { ATTACHMENT_SHARE } from '@beluga/core/attachment-share.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import type { UiState } from '@beluga/ui/keymap.js';
import { type MenuKind, menuSpec } from '@beluga/ui/menus.js';
import { type MenuContext, runMenu as runSharedMenu } from '@beluga/ui/menu-actions.js';
import { submitTyped } from '@beluga/ui/submit.js';
import { sendsToTerminal } from './convo-mode.js';
import { getPrefs } from './prefs.js';
import { type UiActionContext, runUiActionWith } from '@beluga/ui/ui-actions.js';
import type { UiAction } from '@beluga/ui/workspace-models.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { type UiStore, useBeluga } from './beluga.js';
import { openExternal } from './system.js';
import { chordLabel } from './shortcuts-model.js';
import { asksFirst, routeOption, routeTyped } from './native-routes.js';
import { newGroupFor } from './group-edit.js';
import { openSheet } from './sheets.js';
import { askBeforeWork, asksBeforeWork } from './work-confirm.js';
import { mergeNeedsWarning } from './plan-merge.js';
import { isPlanAction, runPlanAction } from './plan-task.js';
import { openFolderThere } from './remote-open.js';
import { folderRoute } from './folder-route.js';
import { openFolderInFinder } from './files.js';
import { filesWsOf, showPanelTab } from './panel.js';

export interface Actions {
  /** Do what a clicked row, button or card means (the shared actions, some done this window's way). */
  run(action: UiAction): void;
  /**
   * Pick an option of a menu (by its index in the menu's spec). Options that remove something
   * ask first with an alert, unless `confirmed` (the caller already asked).
   */
  pick(menu: MenuKind, index: number, confirmed?: boolean): void;
  /** Send what's in the composer. */
  submit(text: string, urgent?: boolean): void;
  /** Put text in the composer and focus it (a /command opens its sheet instead). */
  typeInto(text: string): void;
  /** Open a link from the chat. */
  openLink(link: LinkTarget): void;
}

/** Wire the shared action runners to this window. */
export function makeActions(client: SocketClient, ui: UiStore): Actions {
  const patchUi = (patch: Partial<UiState>): void => ui.patch(patch);
  const route = { client, ui, run: (a: UiAction) => actions.run(a) };
  const typeInto = (buffer: string): void => {
    // The shared actions type a /command for you to finish; this window opens its sheet. The message
    // box is only for messages: a /command nobody routed is a bug, never a prefilled box.
    if (buffer.startsWith('/')) {
      if (!routeTyped(route, buffer) && import.meta.env.DEV) console.error(`beluga: typeInto(${JSON.stringify(buffer)}) has no Mac sheet; refused. Route it in lib/native-routes.ts.`, new Error().stack);
      return;
    }
    ui.patch({ focus: 'chat', buffer, cursor: buffer.length, suggestHidden: false, selected: 0 });
    document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
  };
  const openLink = (link: LinkTarget): void => {
    const go = (at: Location, dir: boolean): void => {
      const view = client.store.getState().view;
      if (dir) {
        if (view.kind === 'workspace' || view.kind === 'shared') {
          actions.run(view.kind === 'workspace' ? { type: 'open_ws', id: view.id, tab: 'files' } : { type: 'open_shared', owner: view.owner, id: view.id, tab: 'files' });
          setTimeout(() => void client.api.files.browseTo(at), 40);
        } else {
          client.store.dispatch({ type: 'view', view: { kind: 'files' } });
          void client.api.files.browseTo(at);
        }
        return;
      }
      // A worktree shows only its own files, and a room none: anything else opens in Files.
      const ownWorktree = view.kind === 'workspace' && at.owner === client.store.getState().selfId && at.share === shareNameOf(view.id);
      if (view.kind !== 'files' && view.kind !== 'shared' && !ownWorktree) client.store.dispatch({ type: 'view', view: { kind: 'files' } });
      void client.api.files.open(at);
    };
    // A folder on this Mac: its worktree's Files, Files for a folder you share, else Finder (BLG-958).
    const openLocalFolder = (at: Location, path: string): void => {
      const state = client.store.getState();
      const route = folderRoute(state, at);
      if (route.kind === 'finder') {
        void openFolderInFinder(client, path);
        return;
      }
      if (route.kind === 'files') {
        client.store.dispatch({ type: 'view', view: { kind: 'files' } });
        void client.api.files.browseTo(at);
        return;
      }
      // The worktree or project on screen keeps its page and shows the folder in its panel.
      if (filesWsOf(state) !== route.wsId || !showPanelTab(state, 'files')) actions.run({ type: 'open_ws', id: route.wsId, tab: 'files' });
      setTimeout(() => void client.api.files.browseTo(at), 40);
    };
    switch (link.kind) {
      case 'url':
        void openExternal(link.url);
        return;
      case 'local':
        void client.api.session.localLocation(link.path, link.dir).then((at) => (link.dir ? openLocalFolder(at, link.path) : go(at, false)));
        return;
      case 'peer':
        go({ owner: link.owner, share: link.share, path: link.path }, !link.path || !/\.[^/]+$/.test(link.path));
        return;
      case 'attachment':
        go({ owner: link.owner, share: ATTACHMENT_SHARE, path: link.file }, false);
        return;
      case 'href':
        return;
    }
  };
  const menuCtx: MenuContext = {
    client,
    patchUi,
    typeInto,
    // The shared actions ask for a name in the message box. Here: a new group gets its row in the
    // sidebar with the name field ready (like New Folder); worktrees and chats start as drafts.
    askForName: (kind, projectId) => {
      if (kind === 'group') newGroupFor(projectId);
      else actions.run(kind === 'worktree' ? { type: 'new_worktree', projectId } : { type: 'new_chat', projectId });
    },
    // On a computer's page: over Remote-SSH, else its path copied (BLG-852).
    openFolder: (dir) => void openFolderThere(client, dir),
    runUiAction: (a) => actions.run(a),
    write: () => undefined,
  };
  const uiCtx: UiActionContext = {
    client,
    patchUi,
    uiRef: {
      get current() {
        return ui.get();
      },
      set current(_v) {
        // read-only here: the shared code patches through patchUi.
      },
    },
    toggle: (key) => {
      const collapsed = ui.get().collapsed;
      patchUi({ collapsed: collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key] });
    },
    typeInto,
    menuCtx: () => menuCtx,
    runMenu: (m, i) => actions.pick(m, i),
    openLink,
    pasteImage: () => client.store.dispatch({ type: 'toast', text: `Paste an image with ${chordLabel('Cmd+V')} in the message box` }),
  };
  const actions: Actions = {
    run: (action) => {
      // Things a window does its own way (the shared actions type a command for them).
      if (action.type === 'add_project') return ui.patch({ addProject: true });
      if (action.type === 'ws' && action.action === 'fork') return openSheet({ kind: 'fork', wsId: action.id });
      // A plan's task: merging it locally warns first (Merge Anyway), however it was asked for.
      if (action.type === 'ws' && isPlanAction(action.action)) return runPlanAction(client.store.getState(), action.id, action.action, actions.run);
      // Solve Conflict finishes a local merge too, so it warns the same way.
      if (action.type === 'ws' && (action.action === 'merge' || action.action === 'merge_claude') && mergeNeedsWarning(client.store.getState(), action.id)) return runPlanAction(client.store.getState(), action.id, 'merge_anyway', actions.run, action.action);
      // Starting Claude or changing git says what it will do first, however it was asked for.
      if (action.type === 'ws' && asksBeforeWork(action.action)) return askBeforeWork(action.id, action.action);
      runUiActionWith(uiCtx, action);
    },
    pick: (menu, index, confirmed = false) => {
      const id = menuSpec(client.store.getState(), menu)?.options[index]?.id;
      ui.patch({ menu: undefined });
      if (id && !confirmed && asksFirst(id)) return openSheet({ kind: 'confirm_option', menu, index, id });
      if (id && routeOption(route, menu, id)) return;
      runSharedMenu(menuCtx, menu, index);
    },
    submit: (text, urgent) => submitTyped({ client, ui: () => ui.get(), patchUi, runUiAction: (a) => actions.run(a), toTerminal: (channel) => sendsToTerminal(client.store.getState(), getPrefs(), channel) }, text, urgent),
    typeInto,
    openLink,
  };
  return actions;
}

export function useActions(): Actions {
  const { client, ui } = useBeluga();
  return useMemo(() => makeActions(client, ui), [client, ui]);
}
