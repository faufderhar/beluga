import type { Capabilities } from '@beluga/ipc/socket-client.js';
import { SocketClient } from '@beluga/ipc/socket-client.js';
import { brandNotice, isTestNotice } from './brand.js';
import type { SoundChoice } from '@beluga/shared/notify-sound.js';
import { MESSAGE_BANNER, NOTIFICATION_TAP } from './notices.js';
import { REQUEST_NOTIFICATION, notificationActions } from '../gateway/request-actions.js';
import { version } from '../../src-tauri/tauri.conf.json';
import { machineSocketUrl } from '../machines/pane-model.js';
import { t } from '../i18n/index.js';

/** Running inside the Tauri shell (otherwise: a browser, while developing). */
export const inApp = (): boolean => '__TAURI_INTERNALS__' in globalThis;

export interface Endpoint {
  readonly url: string;
  readonly token: string;
}

let served = false;
/**
 * This page came from the daemon's web port (`beluga web`): a browser, maybe on another computer.
 * Its stand-ins for the app's native bits (docs/web.md): a folder picker over the server's
 * folders, uploads for what you drop or pick, downloads for what you save or show.
 */
export const webServed = (): boolean => served;
/** The app's folder picker, or the browser's stand-in for it. */
export const canPickFolders = (): boolean => inApp() || served;

/** What a browser's hello carries where the token goes: the web port lets it in by its session, never a token. */
export const WEB_HELLO_TOKEN = 'browser-session-cookie';

/** The socket of the page's own origin (the daemon's web port, src/daemon/web.ts). */
export const webSocketUrl = (loc: Pick<Location, 'protocol' | 'host'>): string => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;

/**
 * Where the daemon is: the app's own sidecar (asked through Tauri), the daemon's web port that
 * served this page (`beluga web`: same origin, its session cookie), or the dev server's bridge.
 */
export async function endpoint(): Promise<Endpoint> {
  if (inApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Endpoint>('daemon_endpoint');
  }
  const res = await fetch('/__beluga/endpoint', { cache: 'no-store' });
  const body = (await res.json()) as Partial<Endpoint> & { error?: string; web?: boolean; signedOut?: boolean };
  // This browser was revoked (or never let in): the page itself becomes the Ask for a link page.
  if (res.status === 401 && body.signedOut) {
    location.reload();
    throw new Error('This browser is signed out of Beluga');
  }
  if (!res.ok || body.error) throw new Error(body.error ?? 'Beluga is not running');
  if (body.web) {
    served = true;
    document.documentElement.dataset.web = 'true';
    return { url: webSocketUrl(location), token: WEB_HELLO_TOKEN };
  }
  if (!body.url || !body.token) throw new Error('Beluga is not running');
  return { url: body.url, token: body.token };
}

/** What only this window can do for Beluga: its clipboard, notifications, links and text size. */
export function capabilities(setZoom: (dir: 'in' | 'out' | 'reset') => { ok: boolean; message: string }): Capabilities {
  return {
    copyText: async (text: string) => {
      if (inApp()) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
      } else await navigator.clipboard.writeText(text);
    },
    // Clicking one comes back as a tap (the app shell's "notification-tap" event, or NOTIFICATION_TAP here).
    notify: async (raw: { title: string; body: string; sound: boolean; tone?: SoundChoice; volume?: number; channel?: string; approval?: string; task?: string; popup?: boolean; banner?: boolean }) => {
      const n = brandNotice(raw);
      // A friend's message while you're in Beluga: a banner in the window (network/MessageBanner.tsx), and its ding.
      if (raw.banner) {
        document.dispatchEvent(new CustomEvent(MESSAGE_BANNER, { detail: { title: n.title, body: n.body, channel: n.channel } }));
        const { playSound } = await import('./sounds/player.js');
        const { DEFAULT_SOUND, DEFAULT_VOLUME, NO_SOUND } = await import('@beluga/shared/notify-sound.js');
        void playSound(n.tone ?? (n.sound ? DEFAULT_SOUND : NO_SOUND), n.volume ?? DEFAULT_VOLUME).catch(() => undefined);
        return;
      }
      // The test's sound is the window's own, so you hear it whatever macOS does with the banner.
      const test = isTestNotice(n);
      const { notificationSound, playTestSound } = await import('./sounds/native.js');
      if (test) playTestSound(n);
      // A friend's request, or (with on-screen popups on) only what Claude needs from you: the
      // floating pop-up shows it (gateway/popup-bridge.ts) instead of a banner, so only its sound here.
      if (inApp() && ((n.approval && n.task) || raw.popup)) {
        const { playSound } = await import('./sounds/player.js');
        const { DEFAULT_SOUND, DEFAULT_VOLUME, NO_SOUND } = await import('@beluga/shared/notify-sound.js');
        void playSound(n.tone ?? (n.sound ? DEFAULT_SOUND : NO_SOUND), n.volume ?? DEFAULT_VOLUME).catch(() => undefined);
        return;
      }
      if (inApp()) {
        // No permission check here: the plugin answers "granted" on every Mac whatever System
        // Settings says. Settings › Notifications asks macOS itself (lib/sounds/access.ts).
        const { sendNotification } = await import('@tauri-apps/plugin-notification');
        // A real sound name ("default" isn't one on macOS: it was silent). See lib/sounds/native.ts.
        const { sound, fallback }: { sound?: string; fallback?: () => void } = test ? {} : await notificationSound(n);
        // An approval on its own gets Approve / Decline (and Always for a friend's request) on the notification.
        sendNotification({ title: t(n.title), body: t(n.body), ...(sound ? { sound } : {}), ...notificationActions(n), extra: { ...(n.channel ? { channel: n.channel } : {}), ...(n.approval ? { approval: n.approval } : {}), ...(n.task ? { task: n.task } : {}) } });
        fallback?.();
        return;
      }
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') return;
      const shown = new Notification(n.title, { body: n.body, silent: test || !n.sound });
      shown.onclick = () => {
        window.focus();
        if (n.approval) document.dispatchEvent(new CustomEvent(REQUEST_NOTIFICATION, { detail: { action: 'review', approval: n.approval, task: n.task } }));
        else document.dispatchEvent(new CustomEvent(NOTIFICATION_TAP, { detail: { channel: n.channel } }));
      };
    },
    openExternal: async (target: string) => {
      if (inApp()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(target);
      } else window.open(target, '_blank', 'noopener');
    },
    zoom: (dir: 'in' | 'out' | 'reset') => setZoom(dir),
    // "Open on your Mac" from the phone: the window comes back (unminimized, shown, focused); where to go comes as a navigate intent.
    raise: async () => {
      if (inApp()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('focus_window');
      } else window.focus();
    },
  };
}

/** This app's version: tauri.conf.json's, the one the updater compares with new releases. */
export const APP_VERSION: string = version;

/** Attach to Beluga. */
export async function connect(caps: Capabilities): Promise<SocketClient> {
  const { url, token } = await endpoint();
  const client = await SocketClient.connect({ url, token, kind: 'mac', version: APP_VERSION, caps });
  // The window opens on Overview (a screen starts on the room, which is no place of its own here: BLG-871).
  client.store.dispatch({ type: 'view', view: { kind: 'overview' } });
  return client;
}

/**
 * What a computer may ask of this window (BLG-776 COMPUTER_CAPS, less): copy, open a page, read a
 * pasted image, and notify through this Mac's one bell (BLG-790: machines/pane-clients.ts wraps it).
 */
const MACHINE_CAPS = ['copyText', 'openExternal', 'readClipboardImage', 'notify'] as const;

/**
 * Attach to one of your computers (BLG-784): this Mac's daemon pipes the screen there over
 * /machine/<id>, with this daemon's own token (never sent on). Not from a browser on the web port.
 */
export async function connectMachine(id: string, caps: Capabilities): Promise<SocketClient> {
  const { url, token } = await endpoint();
  if (webServed()) throw new Error('Your computers open in the Beluga app');
  const allowed: Capabilities = Object.fromEntries(MACHINE_CAPS.flatMap((k) => (caps[k] ? [[k, caps[k]]] : [])));
  return SocketClient.connect({ url: machineSocketUrl(url, id), token, kind: 'mac', version: APP_VERSION, caps: allowed, timeoutMs: 20_000 });
}
