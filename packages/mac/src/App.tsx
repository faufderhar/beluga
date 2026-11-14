import type { SettingsSection } from '@beluga/ui/settings-menus.js';
import { useDictationSetup } from './lib/dictation.js';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { stepPlace } from './lib/go.js';
import { useRememberProject } from './tasks/use-tasks.js';
import { inviteChoice } from '@beluga/ui/invite-menus.js';
import { projectInView } from '@beluga/ui/invite-actions.js';
import { Icon } from './components/Icon.js';
import { MenuSheet } from './dialogs/MenuSheet.js';
import { Palette } from './dialogs/Palette.js';
import { Settings } from './dialogs/Settings.js';
import type { SettingsPane } from './lib/beluga.js';
import { Pane } from './machines/MachinePane.js';
import { useRemoteWork } from './machines/use-remote.js';
import { useRemoteAttentionWatch } from './machines/remote-attention.js';
import { Sidebar } from './layout/Sidebar.js';
import { useActions } from './lib/actions.js';
import { SHORTCUTS, TALK_ID, keyPlatform, shortcutFor } from './lib/shortcuts-model.js';
import { fromKey, getBindings, isRecording, isShortcut, useMenuKeys } from './lib/shortcuts.js';
import { dialogOpen, navBack, navForward, useNavHistory } from './lib/nav.js';
import { pageHasOwnBack } from './tasks/use-swipe-back.js';
import { useApp, useBeluga } from './lib/beluga.js';
import { setPowerSaving } from './lib/power.js';
import { usePrefs } from './lib/prefs.js';
import { joinRoom, runMenuItem, useMenuState, useNative, useNotificationTaps, useTrayStatus, useTraySpout, useWindowFocus } from './lib/native.js';
import { AddProjectSheet } from './dialogs/AddProjectSheet.js';
import { UndoToast } from './lib/undo-toast.js';
import { brandText } from './lib/brand.js';
import { NativeSheets } from './dialogs/native/WorkSheets.js';
import { JoinSheet } from './dialogs/JoinSheet.js';
import { NetworkSheets } from './network/NetworkSheets.js';
import { openNet } from './network/net-sheets.js';
import { MessageBanner } from './network/MessageBanner.js';
import { RequestSheet } from './gateway/RequestSheet.js';
import { useRequestNative } from './gateway/request-native.js';
import { EarningsSheet } from './dialogs/EarningsSheet.js';
import { SupportSheets } from './dialogs/SupportSheets.js';
import { TelemetrySheets } from './dialogs/TelemetrySheets.js';
import { useIdleAway, useTrayPresence } from './network/net-native.js';
import { useUpdateActivity } from './lib/updates.js';
import { useChunkCare } from './lib/lazy-view.js';
import { useState } from 'react';
import { Onboarding, useOnboarding } from './onboarding/Onboarding.js';
import { Lightbox } from './chat/ChatImages.js';
import { SelectionBar } from './components/SelectionBar.js';
import s from './layout/Shell.module.css';
import { CallLayer } from './call/CallLayer.js';

const TOAST_MS = 3500;

function Toasts() {
  const { client } = useBeluga();
  const toast = useApp((st) => st.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => client.store.dispatch({ type: 'toast_clear', id: toast.id }), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, client]);
  if (!toast) return null;
  const icon = toast.level === 'success' ? 'check' : toast.level === 'warn' || toast.level === 'error' ? 'alert' : 'spark';
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      <div key={toast.id} className={s.toast} style={{ color: toast.level === 'error' ? 'var(--error)' : toast.level === 'warn' ? 'var(--warn)' : undefined }}>
        <Icon name={icon} size={13} />
        <span className={s.toastText} style={{ color: 'var(--text)' }}>
          {brandText(toast.text)}
        </span>
      </div>
    </div>
  );
}

/** What the core asks to open (from a /command, or the first invite) shows as this window's own dialog. */
function useOverlays() {
  const { client, ui } = useBeluga();
  const overlay = useApp((st) => st.overlay);
  useEffect(() => {
    if (!overlay) return;
    // Read here, not watched: watching the whole state redrew the whole window on every streamed event (KLD-48).
    const state = client.store.getState();
    client.store.dispatch({ type: 'overlay', overlay: undefined });
    const channel = channelOf(state.view);
    const wsId = state.view.kind === 'workspace' ? state.view.id : undefined;
    switch (overlay) {
      case 'clear':
        return ui.openMenu({ kind: 'clear', channel, host: state.isHost });
      case 'model':
        return ui.openMenu({ kind: 'model', ...(channel === 'room' || channel === 'draft' ? {} : { channel }) });
      case 'inbox':
        return ui.patch({ notices: true });
      case 'templates':
        return ui.openMenu({ kind: 'templates' });
      case 'handoff':
        if (wsId) ui.openMenu({ kind: 'handoff', id: wsId });
        return;
      case 'welcome':
        return ui.openMenu({ kind: 'welcome' });
      case 'settings':
        return ui.patch({ settings: 'general' });
      case 'help':
        return ui.patch({ palette: true });
      case 'add_friend':
        return openNet({ kind: 'add_friend' });
    }
  }, [overlay]);
}

/** The shortcuts that work anywhere in the window (the menu bar shows the same keys). */
const APP_SHORTCUTS = SHORTCUTS.filter((d) => d.scope === 'app' && d.id !== TALK_ID).map((d) => d.id);
const APPROVAL_SHORTCUTS = ['approve-yes', 'approve-no', 'approve-always'];

/** A key pressed in a terminal that's still Beluga's, not the shell's. */
const inTerminalOurs = (e: KeyboardEvent): boolean => (keyPlatform() === 'mac' ? e.metaKey || (e.ctrlKey && e.key === 'Tab') : e.ctrlKey && (e.key === 'Tab' || (e.shiftKey && !/^[cv]$/i.test(e.key))));

/** Keys that work everywhere in the window: yours (Settings › Keyboard), as the menus show them. */
function useShortcuts() {
  const { client, ui } = useBeluga();
  const actions = useActions();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isRecording()) return;
      // In a terminal, keys without ⌘ are the shell's (⌥B types there, ⌃K kills the line); only ⌃Tab still moves places.
      // Off a Mac, Ctrl is both: Ctrl+C, Ctrl+K and the rest stay the shell's, Ctrl+Shift and Ctrl+Tab are ours.
      if ((e.target as Element | null)?.closest?.('.xterm') && !inTerminalOurs(e)) return;
      const state = client.store.getState();
      const bindings = getBindings();
      // A request waiting for you: ⌃Y, ⌃N, ⌃A (not while typing).
      const answer = state.approvals[0] && !typingIn(e.target) ? shortcutFor(bindings, e, APPROVAL_SHORTCUTS) : undefined;
      if (answer && state.approvals[0]) {
        e.preventDefault();
        // A .env file's "always" stays in its project when it has one.
        const always = state.approvals[0].kind === 'secret' && state.approvals[0].project ? 'project' : 'always';
        void client.api.host.answerApproval(answer === 'approve-yes' ? 'yes' : answer === 'approve-no' ? 'no' : always, state.approvals[0].id);
        return;
      }
      const id = shortcutFor(bindings, e, APP_SHORTCUTS);
      if (!id) return;
      if (id === 'nav-back' || id === 'nav-forward') {
        // A page with its own Back on the same key (a task's, back to its list) keeps it; a dialog keeps its keys.
        if ((id === 'nav-back' && pageHasOwnBack() && isShortcut('page-back', e)) || dialogOpen()) return;
        e.preventDefault();
        fromKey(id, () => void (id === 'nav-back' ? navBack() : navForward()));
        return;
      }
      e.preventDefault();
      fromKey(id, () => {
        if (id === 'place-next' || id === 'place-prev') actions.run({ type: 'view', view: { kind: stepPlace(state, id === 'place-next' ? 1 : -1) } });
        else runMenuItem(id, client, ui, actions);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    // Invite means add a friend (BLG-203): the Add a Friend sheet (link, code, QR).
    const invite = (): void => openNet({ kind: 'add_friend' });
    document.addEventListener('beluga:invite', invite);
    // The room's own Invite sheet (its links, set to the project you're looking at), from the room's menus.
    const inviteRoom = (): void => ui.openMenu({ kind: 'invite_link', ...inviteChoice(projectInView(client)) });
    document.addEventListener('beluga:invite-room', inviteRoom);
    const palette = (): void => ui.patch({ palette: true });
    document.addEventListener('beluga:palette', palette);
    return () => {
      document.removeEventListener('beluga:invite', invite);
      document.removeEventListener('beluga:invite-room', inviteRoom);
      document.removeEventListener('beluga:palette', palette);
    };
  }, []);
}

const PANE_OF: Record<SettingsSection, SettingsPane> = { claude: 'claude', notify: 'notifications', workspaces: 'workspaces', buttons: 'workspaces', people: 'people', display: 'appearance', terminal: 'terminal', env: 'environment' };

/** The shared code opens the settings menu (from a person's menu, onboarding…): here it's the Settings window. */
function useSettingsWindow() {
  const { ui } = useBeluga();
  useEffect(
    () =>
      ui.subscribe(() => {
        const m = ui.get().menu?.menu;
        if (m?.kind === 'settings') ui.patch({ menu: undefined, settings: m.section ? PANE_OF[m.section] : 'general' });
      }),
    [],
  );
}


/**
 * Typing where ^A, ^N and ^Y mean line editing (a terminal, a field, a box with text in it), so
 * they don't answer an approval. An empty message box still lets them through.
 */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement && !target.closest('.xterm')) return target.value !== '';
  return target.isContentEditable || target.closest('input, select, .xterm') !== null;
}

export function App() {
  const prefs = usePrefs();
  const { client, ui } = useBeluga();
  const actions = useActions();
  const [joining, setJoining] = useState<string>();
  const welcome = useOnboarding();
  useOverlays();
  useShortcuts();
  // Back and Forward between pages (⌘[ ⌘], the toolbar's arrows, the mouse's buttons).
  useNavHistory(client, actions);
  // A screen to each of your computers, for every list of their work (BLG-785).
  useRemoteWork(client, ui);
  // One bell for every computer (BLG-790): what waits on each, for the bell, Needs You and the Dock.
  useRemoteAttentionWatch(client);
  // Speaking instead of typing: the talk shortcut, ↩ and esc while listening (Settings › Voice).
  useDictationSetup(client);
  useRememberProject();
  useSettingsWindow();
  // The views fetched early, and any that don't load noted in the black box (#370).
  useChunkCare();
  useNative(client, ui, actions, setJoining);
  useTrayStatus(client);
  useTraySpout();
  // Low Power mode (BLG-621): the daemon says when it saves; the window follows.
  const saving = useApp((st) => st.powerSaving);
  useEffect(() => setPowerSaving(saving), [saving]);
  // Development builds only: e2e goes straight to a page no click reaches yet (a computer's task page, BLG-852).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __belugaGo?: (view: unknown) => void; __belugaState?: () => unknown };
    w.__belugaGo = (view) => actions.run({ type: 'view', view: view as never });
    w.__belugaState = () => client.store.getState();
  }, [actions, client]);
  useMenuState(client);
  useMenuKeys();
  useWindowFocus(client);
  useNotificationTaps(client, ui, actions);
  useTrayPresence(client);
  useIdleAway(client);
  useRequestNative(client);
  useUpdateActivity(client, actions);
  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
      {/* Behind the welcome the app can't be tabbed to or read out. */}
      <div className={s.app} inert={welcome.open} data-app-root>
        {prefs.sidebar ? <Sidebar /> : null}
        {/* This Mac's center and panel, or a page on one of your computers drawn with its client (BLG-784). */}
        <Pane />
      </div>
      <MenuSheet />
      <AddProjectSheet />
      <NativeSheets />
      <Palette />
      <Settings />
      <NetworkSheets />
      <RequestSheet />
      <EarningsSheet />
      {welcome.open ? null : <SupportSheets />}
      {welcome.open ? null : <TelemetrySheets />}
      {joining ? <JoinSheet invite={joining} onCancel={() => setJoining(undefined)} onJoin={() => void joinRoom(joining)} /> : null}
      {/* One per window, over whatever opened it (a chat, a sub-agent's activity, a graph). */}
      <Lightbox />
      {/* Select text you're reading: Copy, Quote, Ask, with no right-click (BLG-917). */}
      <SelectionBar />
      <Toasts />
      {/* Calls (BLG-706): this window's call engine, who rings you, the ringtone, the floating card. */}
      <CallLayer />
      <MessageBanner />
      <UndoToast />
      {welcome.open ? <Onboarding start={welcome.start} onClose={welcome.close} onArrive={welcome.arrive} /> : null}
    </Tooltip.Provider>
  );
}
