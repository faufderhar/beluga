import { Linking, Platform } from 'react-native';
import { phoneControl, type AdbPorts } from '../modules/phone-control';
import type { PhoneControl as PhoneControlState, PhoneOp } from '../../../src/companion/protocol';
import { kv } from './kv';

/**
 * Your Mac using this phone (docs/companion.md, "Your phone, from your Mac", BLG-150). Off by
 * default; the user turns it on with one switch ("Let your Mac use this phone"), which also turns
 * on Stay connected so the Mac can reach the phone in the background. The Mac decides how freely to
 * act (Off · Ask · Use · Full) on its side; the phone only says what it *allows at all* and how it
 * can be reached. Android only.
 */

export const phoneControlAvailable = (): boolean => Platform.OS === 'android' && phoneControl.available;
/** The phone's own switch: the user has allowed their Mac to use this phone. */
export const phoneAllowed = (): boolean => phoneControlAvailable() && kv.get<boolean>('control-allowed') === true;
export const setPhoneAllowed = (on: boolean): void => kv.set('control-allowed', on);

let adbPorts: AdbPorts = {};
let discovering = false;

/** Start/stop watching for this phone's own Wireless-debugging port over mDNS. */
export function watchAdb(on: boolean, onChange: () => void): () => void {
  if (!phoneControlAvailable()) return () => {};
  const off = phoneControl.onAdbPorts((p) => {
    adbPorts = p;
    onChange();
  });
  if (on && !discovering) {
    discovering = true;
    phoneControl.startAdbDiscovery();
  } else if (!on && discovering) {
    discovering = false;
    phoneControl.stopAdbDiscovery();
  }
  return off;
}

/** This phone's own Wi-Fi IPv4 address (for the Mac's adb on the same network), or undefined. */
function wifiIp(): string | undefined {
  // The worklet knows the network; the app asks the OS. Left to the native module's device info,
  // which includes it when on Wi-Fi; undefined otherwise (the tunnel still works from anywhere).
  const info = phoneControl.deviceInfo();
  const ip = info && typeof info.wifiIp === 'string' ? info.wifiIp : undefined;
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined;
}

/** What this phone lets its Mac do and how it can be reached, for the `control` frame. */
export function controlState(): PhoneControlState {
  const info = phoneControl.deviceInfo() ?? {};
  const device = {
    model: String(info.model ?? 'Android'),
    manufacturer: String(info.manufacturer ?? ''),
    android: String(info.android ?? ''),
    sdk: Number(info.sdk ?? 0),
    w: Number(info.w ?? 1080),
    h: Number(info.h ?? 2400),
  };
  const ip = wifiIp();
  return {
    allowed: phoneAllowed(),
    accessibility: phoneControl.accessibilityEnabled(),
    screenshots: phoneControl.canScreenshot(),
    video: phoneControl.canMirror(),
    adb: { on: adbPorts.port !== undefined, ...(adbPorts.port ? { port: adbPorts.port } : {}), ...(adbPorts.pairing ? { pairing: adbPorts.pairing } : {}) },
    ...(ip ? { wifi: { ip } } : {}),
    device,
  };
}

/** Run one op the Mac asked for (a `req`), returning its result (throws with a message on failure). */
export async function runOp(op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
  if (!phoneAllowed()) throw new Error('This phone hasn’t allowed its Mac to use it');
  // Video (`mirror`) is Android's screen capture, asked of the user on the phone; a proof (`proof`) and a
  // settings screen for the person (`open {settings}`) don't act on the screen: no Accessibility needed.
  const free = op === 'info' || op === 'apps' || op === 'mirror' || op === 'proof' || (op === 'open' && typeof args.settings === 'string');
  if (!free && !phoneControl.accessibilityEnabled()) throw new Error(phoneControl.addonInstalled() ? 'Turn on Accessibility for Beluga Link on the phone' : 'Install Beluga Link on the phone and turn on its Accessibility');
  return phoneControl.perform(op, args);
}

/** The "Your Mac is using this phone" notification while a run is acting (with Stop). */
export function controlNote(on: boolean, text = 'Your Mac is using this phone'): void {
  if (!phoneControlAvailable()) return;
  if (on) phoneControl.startControlNote(text);
  else phoneControl.stopControlNote();
}

/** The screen's video to the Mac (1.18): each piece as a `vid` frame, and its end as `vid_end`. */
export function watchMirror(send: (f: { t: 'vid'; seq: number; b64: string; key?: boolean; ts: number; w: number; h: number; sw: number; sh: number } | { t: 'vid_end'; reason?: string }) => void): () => void {
  if (!phoneControlAvailable()) return () => {};
  const offPiece = phoneControl.onMirror((p) => send({ t: 'vid', seq: p.seq, b64: p.b64, ...(p.key ? { key: true } : {}), ts: p.ts, w: p.w, h: p.h, sw: p.sw, sh: p.sh }));
  const offEnd = phoneControl.onMirrorEnd((reason) => send({ t: 'vid_end', ...(reason ? { reason: reason.slice(0, 300) } : {}) }));
  return () => {
    offPiece();
    offEnd();
  };
}
export const mirrorAck = (seq: number): void => phoneControl.mirrorAck(seq);

export const accessibilityOn = (): boolean => phoneControlAvailable() && phoneControl.accessibilityEnabled();
export const openAccessibilitySettings = (): void => phoneControl.openAccessibilitySettings();
/** Beluga Link, the small add-on app with the Accessibility service (BLG-377), is installed. */
export const addonInstalled = (): boolean => phoneControlAvailable() && phoneControl.addonInstalled();
/** Open Beluga Link (it goes to Accessibility), or where to download it. */
export const openAddon = (): void => phoneControl.openAddon();
/** Beluga Link's APK on the latest release (each release carries it under this name, BLG-390). */
export const LINK_APK_URL = 'https://github.com/beluga-labs/beluga/releases/latest/download/Beluga-Link.apk';
export const downloadLink = (): void => void Linking.openURL(LINK_APK_URL);
export const onAccessibilityChange = (fn: () => void): (() => void) => (phoneControlAvailable() ? phoneControl.onAccessibilityChange(fn) : () => {});
/** The Stop button on the phone's notification: cut control at once. */
export const onControlStop = (fn: () => void): (() => void) => (phoneControlAvailable() ? phoneControl.onStop(fn) : () => {});
