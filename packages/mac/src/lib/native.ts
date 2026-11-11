import { sumCounts } from '@beluga/machines/attention.js';
import { onRemoteAttention, remoteAttention } from '../machines/remote-attention.js';
import { untag } from '@beluga/machines/attention.js';
import { machineClientOf } from '../machines/pane-clients.js';
import { onMachine, pageOfChannel } from '../machines/pane-model.js';
import { useEffect } from 'react';
import { inApp } from './boot.js';
import type { Actions } from './actions.js';
import type { UiStore } from './beluga.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { setPrefs, getPrefs, subscribePrefs, zoom } from './prefs.js';
import { FOCUS_SIDEBAR_SEARCH } from '../layout/sidebar-search-model.js';
import { byMenu, showPanelTab, togglePanel, toggleTerminal } from './panel.js';
import { navBack, navForward } from './nav.js';
import { PANEL_LABELS, PANEL_TABS, type PanelTab } from './panel-model.js';
import { dockCount, workingCount } from '../layout/attention-model.js';
import { NOTIFICATION_TAP, macNoticeTarget, openNoticeTarget } from './notices.js';
import { COMMAND_IDS, type CommandId, commandState, runCommand } from './commands.js';
import { openNetworkLink, runNetworkMenuItem } from '../network/net-native.js';
import { runRequestMenuItem } from '../gateway/request-native.js';
import { SHOW_WELCOME } from '../onboarding/onboarding-model.js';
import { pastePlain } from '../chat/paste-paths.js';
import type { PlaceKind } from './go.js';
import { throttle } from './throttle.js';
import { fromMenu } from './shortcuts.js';
import { windowActive } from './window-active.js';
import { newChatProject } from './project-home.js';
import { type MenuBarCounts, SPOUT_EVERY_MS, spoutStep, trayTitle } from '../menubar/menubar-look.js';
import { shownState } from '../network/net-model.js';
import { SHOW_TILE, boardLinkOf } from './widget-links.js';
import { t } from '../i18n/index.js';

const isCommand = (id: string): id is CommandId => (COMMAND_IDS as readonly string[]).includes(id);

const GO: Record<string, PlaceKind> = {
  'go-tasks': 'tasks',
  'go-files': 'files',
  'go-overview': 'overview',
  'go-search': 'search',
  'go-usage': 'usage',
  'go-terminal': 'terminal',
  find: 'search',
};

/** What a menu bar item does (the same as its button or command in the window). */
export function runMenuItem(id: string, client: SocketClient, ui: UiStore, actions: Actions): void {
  const state = client.store.getState();
  const project = state.view.kind === 'workspace' ? state.projects.find((p) => p.workspaces.some((w) => w.id === (state.view as { id: string }).id)) : state.projects.find((p) => p.root);
  if (GO[id]) return actions.run({ type: 'view', view: { kind: GO[id]! } });
  // Go › Issues: the GitHub issues of the project you're in.
  if (id === 'go-issues') return actions.run({ type: 'view', view: { kind: 'issues' } });
  // Go › Actions: its GitHub Actions.
  if (id === 'go-actions') return actions.run({ type: 'view', view: { kind: 'actions' } });
  // Go › Sentinel: every watcher.
  if (id === 'go-sentinel') return actions.run({ type: 'view', view: { kind: 'sentinel' } });
  if (id === 'go-dashboard') return actions.run({ type: 'view', view: { kind: 'dashboard' } });
  // Friends, groups and your status (Add a Friend…, the menu bar's status items).
  if (runNetworkMenuItem(id, client)) return;
  // A friend's request in the menu-bar menu: Approve / Always / Decline / Review….
  if (runRequestMenuItem(id, client)) return;
  if (isCommand(id)) return runCommand({ client, ui, actions }, id);
  switch (id) {
    case 'settings':
      return ui.patch({ settings: 'general' });
    case 'palette':
      return ui.patch({ palette: true });
    case 'paste-plain':
      return void pastePlain();
    case 'help-keys':
      return ui.patch({ settings: 'keyboard' });
    case 'help-welcome':
    case 'onboarding':
      return void document.dispatchEvent(new CustomEvent(SHOW_WELCOME));
    case 'new-chat':
      return actions.run({ type: 'new_chat', projectId: newChatProject(state) });
    case 'new-worktree':
      if (project?.root) actions.run({ type: 'new_worktree', projectId: project.id });
      else {
        // A worktree needs a project: offer to add one, the way Add Project does.
        client.store.dispatch({ type: 'toast', text: 'A worktree needs a project: add one first', level: 'warn' });
        actions.run({ type: 'add_project' });
      }
      return;
    case 'add-project':
      return actions.run({ type: 'add_project' });
    case 'share-folder':
      return ui.openMenu({ kind: 'share_folder', launchDir: state.home, mine: state.myShares });
    case 'invite':
      return void document.dispatchEvent(new CustomEvent('beluga:invite'));
    case 'inbox':
      return ui.patch({ notices: true });
    case 'toggle-sidebar':
      return setPrefs({ sidebar: !getPrefs().sidebar });
    case 'nav-back':
      return void navBack();
    case 'nav-forward':
      return void navForward();
    case 'sidebar-search':
      // A hidden sidebar comes back first: the field is there a moment later.
      setPrefs({ sidebar: true });
      return void setTimeout(() => document.dispatchEvent(new CustomEvent(FOCUS_SIDEBAR_SEARCH)), 40);
    case 'toggle-dock':
      // ⌘J: the terminal, where you keep it (the drawer under the chat or the right panel).
      return byMenu('terminal', () => {
        const why = toggleTerminal(state);
        if (why) client.store.dispatch({ type: 'toast', text: why, level: 'info' });
      });
    case 'toggle-inspector':
      return byMenu('panel', () => togglePanel(state.view));
    case 'panel-changes':
    case 'panel-files':
    case 'panel-terminal':
    case 'panel-info':
    case 'panel-history':
    case 'panel-scratch':
    case 'panel-background':
    case 'panel-phone': {
      const tab = id.slice('panel-'.length) as PanelTab;
      if (!PANEL_TABS.includes(tab)) return;
      return byMenu(`panel-${tab}`, () => {
        if (!showPanelTab(state, tab)) client.store.dispatch({ type: 'toast', text: `No ${PANEL_LABELS[tab]} here`, level: 'info' });
      });
    }
    case 'appearance-system':
    case 'appearance-light':
    case 'appearance-dark':
      return setPrefs({ appearance: id.slice('appearance-'.length) as 'system' | 'light' | 'dark' });
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      zoom(id.slice('zoom-'.length) as 'in' | 'out' | 'reset');
      return;
    case 'help-log':
      return void client.api.local.openFolder(`${state.home}/.beluga/logs`);
  }
}

/**
 * A beluga:// link that joins a friend's room: "beluga://join/<invite>", or an invite itself
 * ("beluga://<host key>…#secret", what Invite copies), so clicking the link a friend sent works.
 */
export function inviteOf(url: string): string | undefined {
  const m = /^(?:beluga|klaud):\/\/join\/(.+)$/.exec(url);
  if (m) return decodeURIComponent(m[1]!);
  return /^(?:beluga|klaud):\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/?(\?relay=[^\s#]+)?#[\w-]{16,256}$/.test(url) ? url : undefined;
}

/** Listen to the menu bar and to beluga:// links (only in the app). */
export function useNative(client: SocketClient, ui: UiStore, actions: Actions, onInvite: (invite: string) => void): void {
  useEffect(() => {
    if (!inApp()) return;
    let off: Array<() => void> = [];
    let alive = true;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      // The same key press can reach the window too (lib/shortcuts.ts): it runs once.
      const a = await listen<string>('menu', (e) => fromMenu(e.payload, () => runMenuItem(e.payload, client, ui, actions)));
      // The same link can come both ways (live and from the launch buffer): handle it once.
      const handled = new Set<string>();
      let lastBoard: { url: string; at: number } | undefined;
      const open = (url: string): void => {
        // A widget's link, clicked as often as you like (the same one twice in a second is one click).
        const board = boardLinkOf(url);
        if (board) {
          if (lastBoard?.url === url && Date.now() - lastBoard.at < 1000) return;
          lastBoard = { url, at: Date.now() };
          actions.run({ type: 'view', view: board.board ? { kind: 'dashboard', id: board.board } : { kind: 'sentinel' } });
          if (board.tile) setTimeout(() => document.dispatchEvent(new CustomEvent(SHOW_TILE, { detail: board.tile })), 300);
          return;
        }
        if (handled.has(url)) return;
        // beluga://add… and beluga://join#…: a friend's or a group's invitation (the Beluga network).
        if (openNetworkLink(url)) return void handled.add(url);
        const invite = inviteOf(url);
        if (!invite) return;
        handled.add(url);
        onInvite(invite);
      };
      const b = await listen<string>('deep-link', (e) => open(e.payload));
      if (alive) off = [a, b];
      else [a, b].forEach((f) => f());
      // A link that launched the app arrived before anyone was listening.
      const { invoke } = await import('@tauri-apps/api/core');
      if (alive) for (const url of await invoke<string[]>('take_pending_links')) open(url);
    });
    return () => {
      alive = false;
      off.forEach((f) => f());
    };
  }, [client]);
}

/** Leave this room and join a friend's (the daemon starts again in their room). */
export async function joinRoom(invite: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('restart_daemon', { args: ['join', invite] });
}

/**
 * Keep the Dock icon's badge and the menu-bar icon in step with what's new for you: the
 * sidebar's Unread conversations (one each), plus other unread notifications and anything
 * still waiting on you (see dockCount).
 *
 * The store changes many times a second while Claudes stream, and counting is a walk over every
 * conversation: at most once a second in front, once every 5 s behind other windows (KLD-48),
 * nothing counted when the state hasn't changed, and nothing sent when the counts haven't.
 */
export const TRAY_GAP_MS = 1000;
export const TRAY_GAP_AWAY_MS = 5000;

/** Everything the menu-bar number can count (Settings › Menu Bar picks one). */
export function menuBarCounts(st: ReturnType<SocketClient['store']['getState']>): MenuBarCounts {
  return {
    new: dockCount(st),
    waiting: st.approvals.length + st.questions.length + st.knocks.length,
    working: workingCount(st),
    room: st.peers.filter((p) => p.peerId !== st.selfId).length,
    friends: st.network.friends.filter((f) => shownState(f) !== 'offline').length,
  };
}

const invokeTray = (cmd: string, args: Record<string, unknown>): void => {
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd, args)).catch(() => undefined);
};

/** Spout once in the real menu bar now (Settings' "Try It"). */
export function playTraySpout(): void {
  if (inApp()) invokeTray('play_tray_spout', {});
}

export function useTrayStatus(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    let seen: unknown;
    let seenLook: unknown;
    let seenThere: unknown;
    let working: number | undefined;
    let repeating = false;
    const update = (): void => {
      const st = client.store.getState();
      const prefs = getPrefs();
      const there = remoteAttention();
      if (st === seen && prefs.menuBar === seenLook && there === seenThere) return;
      seen = st;
      seenLook = prefs.menuBar;
      seenThere = there;
      // Every computer's added (BLG-790): one Dock badge and one menu bar for all of them.
      const here = menuBarCounts(st);
      const counts = { ...here, ...sumCounts(here, there.map((r) => r.counts)) };
      const look = prefs.menuBar;
      // The whale spouts: once as a Claude finishes, or on and off while one works.
      const step = spoutStep(prefs.reduceMotion ? 'off' : look.spout, working, counts.working);
      working = counts.working;
      if (step === 'once') invokeTray('play_tray_spout', {});
      const repeat = step === 'repeat';
      if (repeat !== repeating) {
        repeating = repeat;
        invokeTray('play_tray_spout', { everyMs: repeat ? SPOUT_EVERY_MS : 0 });
      }
      const title = trayTitle(look, counts);
      const key = `${counts.waiting}:${counts.working}:${counts.new}:${title}`;
      if (key === last) return;
      last = key;
      invokeTray('set_tray_status', { waiting: counts.waiting, working: counts.working, unread: counts.new, title });
    };
    const tick = throttle(update, () => (windowActive() ? TRAY_GAP_MS : TRAY_GAP_AWAY_MS));
    tick.request();
    const off = client.store.subscribe(tick.request);
    const offPrefs = subscribePrefs(tick.request);
    const offThere = onRemoteAttention(tick.request);
    return () => {
      offThere();
      off();
      offPrefs();
      tick.stop();
    };
  }, [client]);
}

/**
 * Hand the menu bar the spout's frames, drawn here from the same drawing Settings previews, each
 * time its look changes (none while it's off, or Reduce Motion is on).
 */
export function useTraySpout(): void {
  useEffect(() => {
    if (!inApp()) return;
    let key = '';
    let alive = true;
    const send = (): void => {
      const { menuBar, reduceMotion } = getPrefs();
      const off = reduceMotion || menuBar.spout === 'off';
      const next = off ? 'off' : `${menuBar.splash}:${menuBar.speed}`;
      if (next === key) return;
      key = next;
      if (off) return invokeTray('set_tray_spout', { frames: [], frameMs: 33 });
      void import('../menubar/raster.js')
        .then(({ spoutPngs }) => spoutPngs(menuBar))
        .then(({ frames, frameMs }) => {
          if (alive && key === next) invokeTray('set_tray_spout', { frames, frameMs });
        })
        .catch(() => undefined);
    };
    // Sliders move many times a second: draw once they rest.
    let timer: ReturnType<typeof setTimeout> | undefined;
    send();
    const offPrefs = subscribePrefs(() => {
      clearTimeout(timer);
      timer = setTimeout(send, 250);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      offPrefs();
    };
  }, []);
}

/**
 * Tell Beluga whether this window is in front: what it shows isn't announced while it is, and
 * "Only when Beluga isn't in front" waits until it isn't. Coming to the front refreshes PRs.
 */
export function useWindowFocus(client: SocketClient): void {
  useEffect(() => {
    let wasFocused = false;
    const set = (focused: boolean): void => {
      client.store.dispatch({ type: 'away', away: !focused });
      // Coming back to the window: PRs merged or checks finished while you were away show at once.
      if (focused && !wasFocused) void client.api.workbench.refreshPrs({ reason: 'focus' }).catch(() => undefined);
      wasFocused = focused;
    };
    if (inApp()) {
      let alive = true;
      let off: (() => void) | undefined;
      void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          const w = getCurrentWindow();
          const un = await w.onFocusChanged(({ payload }) => set(payload));
          if (!alive) return un();
          off = un;
          set(await w.isFocused());
        })
        .catch(() => undefined);
      return () => {
        alive = false;
        off?.();
      };
    }
    const update = (): void => set(document.visibilityState === 'visible' && document.hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [client]);
}

/**
 * Clicking a desktop notification brings the window forward (the app shell does that) and goes
 * where it's about; one about several places opens the notification centre instead.
 */
export function useNotificationTaps(client: SocketClient, ui: UiStore, actions: Actions): void {
  useEffect(() => {
    const go = (tagged: string | undefined): void => {
      // One of your computers' (BLG-790): read there, and opened there in the pane.
      const { machine, id: channel } = untag(tagged);
      if (machine) {
        void machineClientOf(machine)?.api.inbox.read(channel ? { channel } : {});
        const page = channel ? pageOfChannel(channel) : undefined;
        return page ? actions.run({ type: 'view', view: onMachine(machine, page) }) : ui.patch({ notices: true });
      }
      const target = macNoticeTarget(client.store.getState(), channel);
      if (!target || channel === undefined) return ui.patch({ notices: true });
      void client.api.inbox.read({ channel });
      openNoticeTarget(actions, target, (id) => client.store.dispatch({ type: 'view', view: { kind: 'conversation', id } }));
    };
    const onTap = (e: Event): void => go((e as CustomEvent<{ channel?: string } | undefined>).detail?.channel);
    document.addEventListener(NOTIFICATION_TAP, onTap);
    let alive = true;
    let off: (() => void) | undefined;
    if (inApp()) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const un = await listen<string | null>('notification-tap', (e) => go(e.payload ?? undefined));
          if (alive) off = un;
          else un();
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      off?.();
      document.removeEventListener(NOTIFICATION_TAP, onTap);
    };
  }, [client]);
}

/**
 * Keep the menu bar's Workspace and Conversation menus in step with the window: items that
 * can't run right now are greyed out (Merge with nothing to merge, Stop while Claude is idle),
 * Plan First shows its check, and Run reads Stop Running while the run script runs.
 */
export function useMenuState(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (): void => {
      timer = undefined;
      const state = client.store.getState();
      const enabled: Record<string, boolean> = {};
      const checked: Record<string, boolean> = {};
      const labels: Record<string, string> = {};
      for (const id of COMMAND_IDS) {
        const st = commandState(state, id);
        enabled[id] = st.enabled;
        if (st.checked !== undefined) checked[id] = st.checked;
        if (st.label) labels[id] = t(st.label);
      }
      const key = JSON.stringify([enabled, checked, labels]);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_menu_state', { enabled, checked, labels })).catch(() => undefined);
    };
    // The store changes many times a second while Claude streams; the menu needn't.
    const update = (): void => {
      timer ??= setTimeout(send, 150);
    };
    send();
    const off = client.store.subscribe(update);
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [client]);
}
