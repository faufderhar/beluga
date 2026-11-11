import { useEffect } from 'react';
import type { PresenceState } from '@beluga/net/mesh/views.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inApp } from '../lib/boot.js';
import { IDLE_AWAY_MS, findInvitation, idleStep, presenceFor, rememberIdleAway, selfLine, wasIdleAway } from './net-model.js';
import { openNet } from './net-sheets.js';
import { t } from '../i18n/index.js';

/**
 * Friends and groups in the app shell: the File menu's Add a Friend… / New Group…, your status
 * in the menu-bar menu, beluga://add and beluga://join links, and Away when you're idle.
 */

const STATUS: Record<string, PresenceState> = { 'status-online': 'online', 'status-away': 'away', 'status-dnd': 'dnd', 'status-offline': 'offline' };

/** A menu item about friends or your status; false if it's someone else's. */
export function runNetworkMenuItem(id: string, client: SocketClient): boolean {
  // While the network is off, these sheets open as a Turn On sheet first (see NetworkSheets).
  if (id === 'add-friend') return openNet({ kind: 'add_friend' }), true;
  if (id === 'new-group') return openNet({ kind: 'new_group' }), true;
  if (id === 'status-set') return openNet({ kind: 'status' }), true;
  const note = client.store.getState().network.self?.presence.note;
  const set = (state: PresenceState, duration?: 'hour' | 'tomorrow'): true => {
    rememberIdleAway(false);
    void client.api.network['presence.set'](presenceFor(state, { ...(note ? { note } : {}), ...(duration ? { duration } : {}) }));
    return true;
  };
  if (STATUS[id]) return set(STATUS[id]!);
  if (id === 'status-dnd-hour') return set('dnd', 'hour');
  if (id === 'status-dnd-tomorrow') return set('dnd', 'tomorrow');
  return false;
}

/** A beluga:// link that adds a friend or joins a group: open the sheet ready to accept it. True if it was one. */
export function openNetworkLink(url: string): boolean {
  const found = findInvitation(url);
  if (!found || !/^(?:beluga|klaud):\/\/(add|join)\/?[#?]/.test(url)) return false;
  openNet(found.group ? { kind: 'join_group', accept: found.text } : { kind: 'add_friend', accept: found.text });
  return true;
}

/** Keep the menu-bar menu's status items in step (gone while the network is off). */
export function useTrayPresence(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    const update = (): void => {
      const self = client.store.getState().network.self;
      const presence = self ? { state: self.presence.state, line: t(selfLine(self.presence)) } : null;
      const key = JSON.stringify(presence);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_presence', { presence })).catch(() => undefined);
    };
    update();
    return client.store.subscribe(update);
  }, [client]);
}

const CHECK_MS = 30_000;
const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'focus'] as const;

/** How long since you last used the Mac (the system's idle time in the app; this window's input in a browser). */
async function idleMs(lastInput: number): Promise<number> {
  if (inApp()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const secs = await invoke<number | null>('system_idle_seconds');
      if (typeof secs === 'number') return secs * 1000;
    } catch {
      // Fall back to this window's input.
    }
  }
  return Date.now() - lastInput;
}

/**
 * Away when you haven't used the Mac for a while (only if you chose Online), back to Online
 * when you return (only if it was this that made you Away). Which Away it was is kept in
 * storage, not memory: the core keeps your status across reloads, so this must too.
 */
export function useIdleAway(client: SocketClient, threshold = IDLE_AWAY_MS): void {
  useEffect(() => {
    let lastInput = Date.now();
    let checking = false;
    const check = async (): Promise<void> => {
      const self = client.store.getState().network.self;
      if (!self || checking) return;
      const { state, note } = self.presence;
      // You chose Do Not Disturb or Appear Offline since: it's yours again.
      if (state === 'dnd' || state === 'offline') rememberIdleAway(false);
      checking = true;
      try {
        const step = idleStep({ presence: self.presence, idleMs: await idleMs(lastInput), autoAway: wasIdleAway(), threshold });
        if (!step) return;
        // Marked before sending: if the answer is lost, a stale mark on Online is harmless,
        // but a missing one on Away would leave you Away for good.
        if (step === 'away') rememberIdleAway(true);
        await client.api.network['presence.set']({ state: step, ...(note ? { note } : {}) });
        if (step === 'online') rememberIdleAway(false);
      } catch {
        // The core wasn't reachable (waking from sleep, reconnecting): the next check tries again.
      } finally {
        checking = false;
      }
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    const active = (): void => {
      lastInput = Date.now();
      // Coming back: say so soon, not at the next check.
      if (wasIdleAway() && !pending) pending = setTimeout(() => ((pending = undefined), void check()), 300);
    };
    const shown = (): void => {
      if (document.visibilityState === 'visible') active();
    };
    for (const e of ACTIVITY) window.addEventListener(e, active, { passive: true });
    document.addEventListener('visibilitychange', shown);
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      for (const e of ACTIVITY) window.removeEventListener(e, active);
      document.removeEventListener('visibilitychange', shown);
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [client, threshold]);
}
