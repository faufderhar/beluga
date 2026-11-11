import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SystemPort } from '../core/gateway/device.js';
import type { PhoneTools } from '../agent/types.js';
import { phoneBrief } from '../agent/phone-tools.js';
import { Adb, adbCandidates, findAdb, parseDevices, parseUsbPhones, usbTree } from './phone-adb.js';
import { type DeviceBook, deviceId } from './devices.js';
import { type Macro, MacroStep, type PhoneMacros } from './phone-macros.js';
import { type VideoPiece, adbScreenVideo } from './phone-video.js';
import {
  type AdbView,
  type CableView,
  type MirrorView,
  type PhoneControl as PhoneControlState,
  ProofView,
  type PhoneControlView,
  type PhoneOp,
  type PhoneRoute,
  type PhoneUse,
  type ScreenView,
  TUN_WINDOW,
} from './protocol.js';

/**
 * Your Mac using your phone (BLG-150, docs/companion.md "Your phone, from your Mac"). This is the
 * brain: it knows, per paired phone, how it can be reached right now — USB, Wireless debugging on
 * the same Wi-Fi, Wireless debugging carried through the Beluga link, or the app's Accessibility
 * service — and runs each action by the best route it has. The agent's tools (agent/phone-tools.ts)
 * call these methods; nothing here talks to Claude.
 *
 * It never acts on a phone that hasn't said `allowed` (its own Settings switch), and never on
 * anything but the owner's own paired phone.
 */

/** A phone's link, as this controller uses it (the host's PhoneLink implements it). */
export interface PhoneLinkHandle {
  readonly deviceId: string;
  /** What the phone last said it allows and how it can be reached (its `control` frame). */
  readonly control?: PhoneControlState;
  /** The six-digit Wireless-debugging pairing code the phone last sent (and when), for `adb pair`. */
  readonly adbCode?: { readonly code: string; readonly at: number };
  /** Ask the phone to do something through its Accessibility service (`req` → `reply`). */
  request(op: PhoneOp, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Open a byte tunnel to the phone's debugging port (or pairing port) and pump bytes both ways. */
  openTunnel(to: 'adb' | 'adb-pair', side: TunnelSide): TunnelEnd;
  /** 1.18: the phone can stream its screen as video (`mirror`); false or missing on an older app. */
  readonly video?: boolean;
  /** 1.19: the phone can prove it's the one at a Wireless-debugging address (`proof`). */
  readonly proofs?: boolean;
  /** Take the screen's video (`vid`, each acked while taken) and hear when it ends (`vid_end`). */
  watchVideo?(onPiece: (p: VideoPiece) => void, onEnd: (reason?: string) => void): () => void;
}

export type { VideoPiece } from './phone-video.js';

/**
 * Something Claude just did on the phone, for the mirror to show where (BLG-186): a tap or a long
 * press at x, y, a swipe from x, y to x2, y2, or a key, typing, scrolling or opening (no place).
 * What was typed is never in it.
 */
export interface PhoneTouch {
  readonly op: 'tap' | 'long_press' | 'swipe' | 'type' | 'key' | 'scroll' | 'open';
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  /** A few words for the caption: the key ("back"), the direction, the app. */
  readonly what?: string;
}

/** How the mirror is doing: live by a route, with video asked for or flowing, or stopped with why. */
export interface MirrorStatus {
  readonly on: boolean;
  readonly route?: PhoneRoute;
  readonly error?: string;
  /** Live video: waiting for "Start now" on the phone, or flowing. */
  readonly video?: 'asking' | 'on';
  /** A word about the video (the phone said no, or stopped it). */
  readonly note?: string;
}

/** The Mac's end of a tunnel: what the socket wants done, with the phone. */
export interface TunnelSide {
  onData(bytes: Buffer): void;
  onClose(error?: string): void;
  /** The phone took `n` bytes: the Mac may send that much more (flow control). */
  onAck(n: number): void;
  onOpen(): void;
}
export interface TunnelEnd {
  send(bytes: Buffer): void;
  ack(n: number): void;
  close(error?: string): void;
}

export interface PhoneControlDeps {
  readonly sys: SystemPort;
  readonly devices: DeviceBook;
  /** The open link for a device, if any (host wires this to its PhoneLinks). */
  readonly link: (deviceId: string) => PhoneLinkHandle | undefined;
  /** View/state changed: re-publish the companion slice. */
  readonly onChange: () => void;
  /** Saved phone flows (BLG-175). */
  readonly macros?: PhoneMacros;
  readonly log?: (line: string) => void;
  /** Tests: adb's path straight away (skip discovery), and a fake home for candidates. */
  readonly adbPath?: string;
  readonly home?: string;
}

/** What a tool needs to act: which phone, by which route, and the adb for it when there is one. */
/** Beluga Link, the phone's add-on with the Accessibility service (BLG-377), and that service. */
export const LINK_PACKAGE = 'sh.ratel.beluga.control';
export const LINK_SERVICE = `${LINK_PACKAGE}/sh.ratel.beluga.addon.BelugaAccessibilityService`;
/** Each release carries Beluga Link under this name (BLG-391). */
export const LINK_APK_URL = 'https://github.com/beluga-labs/beluga/releases/latest/download/Beluga-Link.apk';

/** The app itself: Link only works signed with the same key (BLG-430). */
export const APP_PACKAGE = 'sh.ratel.beluga';

/** Who signed a package, from `dumpsys package <name>` ("signatures:[8f3c1a2b]"), or undefined when it doesn't say. */
export function signerOf(dumpsys: string): string | undefined {
  return /signatures:\[([0-9a-f, ]+)\]/i.exec(dumpsys)?.[1]?.trim() || undefined;
}

/**
 * Android's list of Accessibility services on, with Beluga Link's added: the others kept, and
 * Beluga's own from before 1.6.0 (its service lived in the app) dropped.
 */
export function withLinkService(current: string): string {
  const kept = current
    .split(':')
    .map((x) => x.trim())
    .filter((x) => x && x !== 'null' && !x.startsWith('sh.ratel.beluga/'));
  // Written back through the phone's shell: anything else on the list must stay exactly as it is.
  if (kept.some((x) => !/^[\w.$/]+$/.test(x))) throw new Error('The phone’s Accessibility list has a service Beluga can’t safely rewrite: turn on Beluga Link in Android › Accessibility instead.');
  return kept.includes(LINK_SERVICE) ? kept.join(':') : [...kept, LINK_SERVICE].join(':');
}

async function fetchLinkApk(to: string): Promise<void> {
  const res = await fetch(LINK_APK_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Couldn’t download Beluga Link (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > 50_000_000 || bytes.subarray(0, 2).toString() !== 'PK') throw new Error('The Beluga Link download wasn’t an Android app');
  await fs.writeFile(to, bytes);
}

interface Reach {
  readonly route: PhoneRoute;
  readonly adb?: Adb;
  readonly link?: PhoneLinkHandle;
}

const OP_NEEDS_ADB: ReadonlySet<string> = new Set(['shell', 'logcat']);

/** Android allows an Accessibility service one screenshot per 333 ms; the mirror asks a little slower. */
const SHOT_GAP_MS = 360;
/** How often a running mirror re-checks its route (a cable plugged in, debugging turned on). */
const ROUTE_RECHECK_MS = 5_000;
/** The mirror's live video: smooth over sharp (the longest side, and its bitrate). */
const VIDEO_MAX = 1280;
const VIDEO_FPS = 30;
const VIDEO_KBPS = 2500;
/** Over a USB cable, or straight over the same Wi-Fi, there's room for a sharper picture. */
const VIDEO_KBPS_USB = 6000;
const VIDEO_KBPS_WIFI = 4000;
/** The app's video this quiet (it sends even a still screen a few times a second) has stalled: pictures again. */
const VIDEO_STALL_MS = 2_000;
/** An action's route is reused this long (finding it runs adb). */
const REACH_KEEP_MS = 3_000;
/** How often the Mac looks for a phone on its USB (macOS's own list, read-only). */
const CABLE_SCAN_MS = 4_000;
/** A straight Wireless-debugging connection proves it's the phone again after this long. */
const PROOF_KEEP_MS = 60_000;
/** A Wi-Fi that kept devices apart is tried straight again after this long (or at once on another network). */
const DIRECT_RETRY_MS = 5 * 60_000;
/** Wireless debugging Beluga turned on goes off again after this long unused (it listens on the network meanwhile). */
const WIFI_IDLE_MS = 15 * 60_000;
/** Claude counts as using the phone this long after its last action (the Phone tab's dot). */
const BUSY_MS = 15_000;
/** The mirror's own taps and keys: the Accessibility service's gestures are instant, adb's `input` starts a program each time. */
const QUICK_OPS: ReadonlySet<PhoneOp> = new Set(['tap', 'long_press', 'swipe', 'type', 'key', 'scroll']);

/**
 * A phone's error as a sentence. The app's native side fails through Expo, which wraps the cause:
 * "Call to function 'PhoneControl.perform' has been rejected.\n→ Caused by: java.lang.IllegalStateException: No text field…"
 * (the arrow often arrives as "â"). Keep only the cause's own words.
 */
export function phoneErrorText(message: string): string {
  const cause = message.includes('Caused by:') ? message.slice(message.lastIndexOf('Caused by:') + 'Caused by:'.length) : message;
  // Drop the Java class names in front ("java.util.concurrent.ExecutionException: java.lang.IllegalStateException: ").
  const words = cause.trim().replace(/^(?:(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*:\s*)+/, '');
  return words || message.trim();
}

/** The phone refused a screenshot only because the last one was under 333 ms ago (Android's code 3). */
const tooSoon = (err: unknown): boolean => err instanceof Error && /\(code 3\)/.test(err.message);

/** How a `use` level answers a kind of action: looking is always fine; the rest follow the level. */
export function allowsWithoutAsking(use: PhoneUse, kind: 'look' | 'act' | 'shell'): boolean {
  if (kind === 'look') return use !== 'off';
  if (kind === 'act') return use === 'use' || use === 'full';
  return use === 'full';
}

export class PhoneControl {
  private adb?: { path: string; version: string };
  private adbSearched = false;
  private fetching = false;
  private adbError?: string;
  /** adb serials we connected (deviceId → serial), so we reconnect and reuse. */
  private serials = new Map<string, string>();
  /** Local tunnel listeners per device (deviceId → { server, port }) for adb over the link. */
  private tunnels = new Map<string, { server: net.Server; port: number }>();

  constructor(private readonly deps: PhoneControlDeps) {}

  private logLine(line: string): void {
    this.deps.log?.(`phone-control: ${line}`);
  }

  /** How this Mac's adb stands, and a phone on its cable, for Settings › Phone. */
  adbView(): AdbView {
    const cable = this.cable ? { cable: this.cable } : {};
    if (this.adb) return { path: this.adb.path, version: this.adb.version, ...cable };
    if (this.fetching) return { fetching: true, ...cable };
    if (this.adbError) return { error: this.adbError, ...cable };
    return cable;
  }

  // ---- a phone on the cable (BLG-190)

  private cable?: CableView;
  private cableTimer?: NodeJS.Timeout;
  /** Per adb serial: whether Beluga is on it and its name (asked once). */
  private readonly cableFacts = new Map<string, { beluga: boolean; name: string }>();

  /** Look for a phone on this Mac's USB every few seconds (the daemon's; not in tests). */
  watchCable(): void {
    this.cableTimer ??= unrefd(setInterval(() => void this.scanCable().catch(() => undefined), CABLE_SCAN_MS));
    void this.scanCable().catch(() => undefined);
  }

  /**
   * What's on the cable now. macOS lists the USB devices itself (read-only, no adb), so a phone
   * shows even with USB debugging off; adb is asked only once one is there.
   */
  async scanCable(): Promise<CableView | undefined> {
    const phone = await this.usbPhone();
    let next: CableView | undefined;
    let onCable: string | undefined;
    if (phone) {
      const adb = await this.ensureAdb();
      const rows = adb ? (await this.attached()).filter((d) => d.usb) : [];
      const row = rows.find((d) => d.serial === phone.serial) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!row) next = { state: 'no-debugging', name: phone.name };
      else if (row.state !== 'device') next = { state: 'unauthorized', name: phone.name };
      else {
        const facts = this.cableFacts.get(row.serial) ?? (await this.factsOf(new Adb(this.deps.sys, adb!.path, row.serial)));
        this.cableFacts.set(row.serial, facts);
        const paired = this.deps.devices.all().some((r) => r.cert.platform === 'android' && r.cert.name === facts.name);
        next = { state: 'ready', name: facts.name || phone.name, ...(facts.beluga && !paired ? { canPair: true } : {}) };
        onCable = facts.name;
      }
    }
    // Which paired phone is on the cable now, for its Settings › Phone (Set Up Beluga Link needs it).
    let moved = false;
    for (const r of this.deps.devices.all()) {
      if (r.cert.platform !== 'android') continue;
      const id = deviceId(r.cert);
      const usb = onCable !== undefined && r.cert.name === onCable;
      if ((this.lastUsb.get(id) ?? false) !== usb) {
        this.lastUsb.set(id, usb);
        moved = true;
      }
    }
    if (moved || JSON.stringify(next) !== JSON.stringify(this.cable)) {
      this.cable = next;
      this.deps.onChange();
    }
    return next;
  }

  /** The USB tree (names and ids only) when the full read last found no phone on it. */
  private emptyTree?: string;

  /**
   * The Android phone on this Mac's USB, if any. The full list (every device's properties, ~100 KB
   * even with nothing plugged in) is read only when the tree of devices isn't the very one that
   * had no phone last time (BLG-407): anything plugged in, out or re-connected changes the tree
   * (a new entry, a new id), so it's seen on the same tick as before.
   */
  private async usbPhone(): Promise<{ name: string; serial?: string } | undefined> {
    const tree = await this.deps.sys.exec('/usr/sbin/ioreg', ['-p', 'IOUSB', '-w0'], 5_000).then(
      (r) => (r.code === 0 && r.stdout.trim() ? usbTree(r.stdout) : undefined),
      () => undefined,
    );
    if (tree !== undefined && tree === this.emptyTree) return undefined;
    const io = await this.deps.sys.exec('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0'], 5_000).catch(() => undefined);
    const phone = parseUsbPhones(io?.stdout ?? '')[0];
    this.emptyTree = !phone && io?.code === 0 ? tree : undefined;
    return phone;
  }

  private async factsOf(adb: Adb): Promise<{ beluga: boolean; name: string }> {
    const res = await adb.shell('pm path sh.ratel.beluga; settings get global device_name', 8_000).catch(() => undefined);
    const lines = (res?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { beluga: lines.some((l) => l.startsWith('package:')), name: lines.filter((l) => !l.startsWith('package:')).at(-1) ?? '' };
  }

  /** Open a pairing on the phone on the cable (its Beluga shows "Pair with …?"; you still check the four pictures). */
  async openPairingOnCable(link: string): Promise<void> {
    if (!/^beluga:\/\/device#[\w-]+(\?r=[\w%.-]+)?$/.test(link)) throw new Error('Not a pairing link');
    const adb = await this.ensureAdb();
    const row = adb ? (await this.attached()).find((d) => d.usb && d.state === 'device') : undefined;
    if (!adb || !row) throw new Error('Plug the phone in, with USB debugging on and this Mac allowed.');
    const res = await new Adb(this.deps.sys, adb.path, row.serial).shell(`am start -a android.intent.action.VIEW -d '${link}' sh.ratel.beluga`, 10_000);
    if (res.code !== 0 || /Error|Exception/.test(res.stdout + res.stderr)) throw new Error('The phone didn’t open Beluga’s pairing: open Beluga on the phone and try again.');
  }

  /** Show the person one of the phone's settings screens (Developer options, About phone), through its Beluga. */
  async showSettings(deviceId: string, which: 'developer' | 'about'): Promise<void> {
    const link = this.deps.link(deviceId);
    if (!link?.proofs) throw new Error('Open Beluga on the phone (and update it) so the Mac can show you the setting.');
    await link.request('open', { settings: which }, 10_000);
  }

  /** Find adb once (lazily). Call before anything that may need it. */
  async ensureAdb(): Promise<{ path: string; version: string } | undefined> {
    if (this.adb) return this.adb;
    if (this.deps.adbPath) return (this.adb = { path: this.deps.adbPath, version: 'test' });
    if (this.adbSearched) return undefined;
    this.adbSearched = true;
    this.adb = await findAdb(this.deps.sys, this.deps.home);
    if (!this.adb) this.adbError = 'adb (Android platform-tools) isn’t installed on this Mac yet.';
    this.deps.onChange();
    return this.adb;
  }

  private howUsed(deviceId: string): PhoneUse {
    return this.deps.devices.get(deviceId)?.use ?? 'off';
  }

  /** How freely Claude may use the phone it would act on now (for the owner-approval gate). */
  useLevel(): PhoneUse {
    const id = this.targetDevice();
    return id ? this.howUsed(id) : 'off';
  }

  /** Set how freely Claude may use a phone (Settings › Phone). */
  setUse(deviceId: string, use: PhoneUse): void {
    this.deps.devices.update(deviceId, { use });
    this.deps.onChange();
  }

  /** adb's current list of attached serials. */
  private async attached(): Promise<Array<{ serial: string; state: string; usb: boolean }>> {
    const adb = await this.ensureAdb();
    if (!adb) return [];
    const res = await this.deps.sys.exec(adb.path, ['devices', '-l'], 8_000).catch(() => undefined);
    return res && res.code === 0 ? parseDevices(res.stdout) : [];
  }

  /**
   * Make sure the Mac's adb is connected to this phone's Wireless debugging and return its serial,
   * or undefined if it isn't reachable. Two ways, the first that works (BLG-189):
   *  - straight over the same Wi-Fi (fastest), to the address and port the paired phone itself
   *    gave over the link, and only once the device there proves it's that phone: it reads back a
   *    one-time code the phone was sent over the link. Nobody else on the network can pass for it
   *    (and a name announced over mDNS is never trusted). Many networks (dorms, campuses, cafés)
   *    keep devices apart: then it's `blocked` there, said in Settings › Phone, and tried again on
   *    another network or a while later;
   *  - through the link: a local tunnel the phone's own app carries, end-to-end encrypted to its
   *    keys, to its own debugging port. Works from anywhere.
   */
  private async adbSerial(deviceId: string, state: PhoneControlState | undefined): Promise<string | undefined> {
    const adb = await this.ensureAdb();
    if (!adb || !state?.adb.on) return undefined;
    const link = this.deps.link(deviceId);
    const known = this.serials.get(deviceId);
    if (known && (await this.attached()).some((d) => d.serial === known && d.state === 'device')) {
      // Through the link it's always the phone; straight, it proves itself again now and then (an address can change hands).
      if (known.startsWith('127.0.0.1') || Date.now() - (this.provenAt.get(known) ?? 0) < PROOF_KEEP_MS || (link && (await this.proves(link, adb.path, known)))) return known;
      await this.deps.sys.exec(adb.path, ['disconnect', known], 5_000).catch(() => undefined);
      this.serials.delete(deviceId);
    }
    if (state.wifi?.ip && state.adb.port && link?.proofs) {
      const ip = state.wifi.ip;
      const tried = this.direct.get(deviceId);
      if (!tried || tried.ip !== ip || tried.result === 'direct' || Date.now() - tried.at > DIRECT_RETRY_MS) {
        const target = `${ip}:${state.adb.port}`;
        const serial = await this.connect(adb.path, target, 5_000);
        const result = !serial ? 'blocked' : (await this.proves(link, adb.path, serial)) ? 'direct' : 'unproven';
        const changed = tried?.ip !== ip || tried.result !== result;
        this.direct.set(deviceId, { ip, result, at: Date.now() });
        if (changed) this.deps.onChange();
        if (result === 'direct') return this.remember(deviceId, serial!);
        if (serial) {
          this.logLine(`${target} didn’t prove it’s the phone: not used`);
          await this.deps.sys.exec(adb.path, ['disconnect', serial], 5_000).catch(() => undefined);
        }
      }
    }
    const port = await this.tunnelPort(deviceId);
    if (port) {
      const serial = await this.connect(adb.path, `127.0.0.1:${port}`);
      if (serial) return this.remember(deviceId, serial);
    }
    return undefined;
  }

  /** Per phone: the Wi-Fi the straight way was last tried on and what it found. */
  private readonly direct = new Map<string, { ip: string; result: 'direct' | 'blocked' | 'unproven'; at: number }>();
  /** When each straight connection last proved it's the phone. */
  private readonly provenAt = new Map<string, number>();

  /** The device at `serial` reads back a one-time code only the paired phone was sent (over the link). */
  private async proves(link: PhoneLinkHandle, adbPath: string, serial: string): Promise<boolean> {
    const nonce = randomBytes(16).toString('hex');
    const sent = ProofView.safeParse(await link.request('proof', { nonce }, 8_000).catch(() => undefined));
    if (!sent.success || !/^[\w./-]+$/.test(sent.data.path)) return false;
    const read = await this.deps.sys.exec(adbPath, ['-s', serial, 'shell', 'cat', sent.data.path], 8_000).catch(() => undefined);
    const ok = read?.code === 0 && read.stdout.trim() === nonce;
    if (ok) this.provenAt.set(serial, Date.now());
    return ok;
  }

  /**
   * Wireless debugging on or off, from the Mac (BLG-187, Settings › Phone). On needs the phone on a
   * cable: it's turned on there, the phone's app says its port over the link, and the Mac checks it
   * can reach it through the link, so Claude and the mirror carry on unplugged. Android asks "Allow
   * wireless debugging on this network?" on the phone. Turned on here, it goes off again after
   * WIFI_IDLE_MS unused. Off works over any route.
   */
  async setWifiDebugging(deviceId: string, on: boolean): Promise<string> {
    const r = await this.need(deviceId, 'act');
    if (!on) {
      if (!r.adb) return 'Wireless debugging is already off.';
      await this.wifiOff(deviceId, r.adb);
      return 'Wireless debugging is off.';
    }
    if (r.route !== 'usb' || !r.adb) throw new Error('Plug the phone in with a cable first: Wireless debugging is turned on over it.');
    const res = await r.adb.shell('settings put global adb_wifi_enabled 1', 8_000);
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || 'The phone didn’t turn on Wireless debugging.');
    this.wifiByUs.add(deviceId);
    this.lastUsed.set(deviceId, Date.now());
    // Android asks first ("Allow wireless debugging on this network?"); then the app finds its port.
    let asked = false;
    for (let i = 0; i < 45; i++) {
      await delay(1000);
      const setting = (await r.adb.shell('settings get global adb_wifi_enabled', 5_000).catch(() => undefined))?.stdout.trim();
      if (setting !== '1') {
        asked = true;
        continue;
      }
      const serial = await this.adbSerial(deviceId, this.deps.link(deviceId)?.control);
      if (serial) {
        this.reached.delete(deviceId);
        this.deps.onChange();
        const later = 'Unplug it whenever you like; Wireless debugging turns itself off after 15 minutes unused.';
        return serial.startsWith('127.0.0.1')
          ? this.direct.get(deviceId)?.result === 'blocked'
            ? `Ready, through Beluga: this Wi‑Fi keeps devices apart (dorms, campuses and cafés often do), so the Mac reaches the phone through Beluga’s encrypted link instead. A little slower; on another network it connects straight. ${later}`
            : `Ready, through Beluga’s encrypted link. ${later}`
          : `Ready, straight over this Wi‑Fi (the phone proved it’s yours). ${later}`;
      }
    }
    if (asked) throw new Error('The phone is asking “Allow wireless debugging on this network?”: unlock it and tap Allow, then try again.');
    if (!this.deps.link(deviceId)?.control?.adb.on) throw new Error('Wireless debugging is on, but the phone’s Beluga hasn’t said its port: open Beluga on the phone and try again.');
    throw new Error('Wireless debugging is on, but the Mac couldn’t reach it through the link yet. Try again in a moment.');
  }

  private async wifiOff(deviceId: string, adb: Adb): Promise<void> {
    await adb.shell('settings put global adb_wifi_enabled 0', 8_000).catch(() => undefined);
    this.wifiByUs.delete(deviceId);
    const serial = this.serials.get(deviceId);
    if (serial?.startsWith('127.0.0.1') && this.adb) {
      await this.deps.sys.exec(this.adb.path, ['disconnect', serial], 5_000).catch(() => undefined);
      this.serials.delete(deviceId);
    }
    this.reached.delete(deviceId);
    this.deps.onChange();
  }

  /** Wireless debugging Beluga turned on, and when each phone was last used: off again when idle. */
  private readonly wifiByUs = new Set<string>();
  private readonly lastUsed = new Map<string, number>();
  private readonly idleCheck = unrefd(setInterval(() => void this.offWhenIdle(), 60_000));

  private async offWhenIdle(): Promise<void> {
    for (const id of [...this.wifiByUs]) {
      if (Date.now() - (this.lastUsed.get(id) ?? 0) < WIFI_IDLE_MS) continue;
      const r = await this.reach(id).catch(() => undefined);
      if (r?.adb) {
        this.logLine(`turning Wireless debugging off on ${id} (unused for ${Math.round(WIFI_IDLE_MS / 60_000)} min)`);
        await this.wifiOff(id, r.adb);
      }
    }
  }

  /**
   * The phone's own switch said no ("Let your Mac use this phone" off, or Stop on its notification):
   * every route is refused, adb's too. Kept on its record, so it holds while the app isn't running.
   */
  private phoneSaidNo(deviceId: string): boolean {
    const said = this.deps.link(deviceId)?.control?.allowed;
    return said === undefined ? this.deps.devices.get(deviceId)?.stopped === true : !said;
  }

  private remember(deviceId: string, serial: string): string {
    this.serials.set(deviceId, serial);
    return serial;
  }

  private async connect(adbPath: string, target: string, timeoutMs = 10_000): Promise<string | undefined> {
    const res = await this.deps.sys.exec(adbPath, ['connect', target], timeoutMs).catch(() => undefined);
    if (res && /connected to|already connected/i.test(res.stdout)) return target;
    this.logLine(`adb connect ${target}: ${(res?.stdout || res?.stderr || 'no answer').trim().slice(0, 120)}`);
    return undefined;
  }

  /** A USB serial for this phone, if one is plugged in (matched by the phone's model, best effort). */
  private async usbSerial(state: PhoneControlState | undefined): Promise<string | undefined> {
    const usb = (await this.attached()).filter((d) => d.usb && d.state === 'device');
    if (!usb.length) return undefined;
    if (usb.length === 1) return usb[0]!.serial;
    // More than one: match by model (`ro.product.model`) when we know it.
    const adb = this.adb;
    if (adb && state) {
      for (const d of usb) {
        const got = await this.deps.sys.exec(adb.path, ['-s', d.serial, 'shell', 'getprop', 'ro.product.model'], 6_000).catch(() => undefined);
        if (got?.stdout.trim() === state.device.model) return d.serial;
      }
    }
    return usb[0]!.serial;
  }

  /** Where the phone can be reached now, best route first. */
  async reach(deviceId: string): Promise<Reach | undefined> {
    // The phone said Stop: nothing, by any route (adb included).
    if (this.phoneSaidNo(deviceId)) return undefined;
    const link = this.deps.link(deviceId);
    const state = link?.control;
    const adb = await this.ensureAdb();
    if (adb) {
      const usb = await this.usbSerial(state);
      if (usb) return { route: 'usb', adb: new Adb(this.deps.sys, adb.path, usb), ...(link ? { link } : {}) };
      const serial = await this.adbSerial(deviceId, state);
      if (serial) return { route: serial.startsWith('127.0.0.1') ? 'link' : 'wifi', adb: new Adb(this.deps.sys, adb.path, serial), ...(link ? { link } : {}) };
    }
    // No adb: the app's Accessibility service, if it's on and allowed.
    if (link?.control?.allowed && link.control.accessibility) return { route: 'accessibility', link };
    return undefined;
  }

  /** The routes available now, best first, for the view and the brief. */
  private routesOf(state: PhoneControlState | undefined, usb: boolean, wifi: boolean, tunnel: boolean): PhoneRoute[] {
    const routes: PhoneRoute[] = [];
    if (usb) routes.push('usb');
    if (wifi) routes.push('wifi');
    if (tunnel) routes.push('link');
    if (state?.allowed && state.accessibility) routes.push('accessibility');
    return routes;
  }

  /** One phone's control, for the Mac's screens (companion slice). */
  controlView(deviceId: string): PhoneControlView {
    const use = this.howUsed(deviceId);
    const link = this.deps.link(deviceId);
    const state = link?.control;
    const serial = this.serials.get(deviceId);
    const connected = Boolean(serial);
    const adbStage: PhoneControlView['adb'] = connected ? 'connected' : !state?.adb.on ? 'off' : state.adb.pairing ? 'unpaired' : 'ready';
    const usb = this.lastUsb.get(deviceId) ?? false;
    const straight = connected && !serial?.startsWith('127.0.0.1');
    const routes = this.phoneSaidNo(deviceId) ? [] : this.routesOf(state, usb, straight, (connected && !straight) || (state?.adb.on ?? false));
    const tried = state?.adb.on ? this.direct.get(deviceId) : undefined;
    return {
      use,
      ...(state ? { allowed: state.allowed, accessibility: state.accessibility, screenshots: state.screenshots } : {}),
      adb: adbStage,
      usb,
      routes: use === 'off' ? [] : routes,
      ...(serial ? { serial } : {}),
      ...(state?.device.model ? { model: state.device.model } : {}),
      ...(this.noteFor(state, routes, use, this.phoneSaidNo(deviceId)) ? { note: this.noteFor(state, routes, use, this.phoneSaidNo(deviceId))! } : {}),
      ...(this.busy(deviceId) ? { busy: true } : {}),
      ...(tried && tried.result !== 'unproven' ? { wifiPath: tried.result } : {}),
    };
  }
  private lastUsb = new Map<string, boolean>();

  private noteFor(state: PhoneControlState | undefined, routes: readonly PhoneRoute[], use: PhoneUse, stopped = false): string | undefined {
    if (use === 'off') return 'Off. Turn it on to let your agent act on this phone.';
    if (stopped && !state) return 'The phone said Stop: turn on “Let your Mac use this phone” in its Beluga.';
    if (!state) return 'Open the Beluga app on this phone so it can say what it allows.';
    if (!state.allowed) return 'Turn on “Let your Mac use this phone” in the phone’s Beluga.';
    if (routes.length) return undefined;
    if (!state.accessibility && !state.adb.on) return 'On the phone: install Beluga Link and turn on its Accessibility, or turn on Wireless debugging.';
    if (state.adb.on && state.adb.pairing) return 'Type the phone’s pairing code into Beluga’s notification to connect adb.';
    return 'Can’t reach the phone right now.';
  }

  // ---- the operations the tools use

  /** A screenshot: over adb when we have it (crisp PNG), else the Accessibility service (API 30+). */
  async screenshot(deviceId: string): Promise<{ image: Buffer; mime: 'image/png' | 'image/jpeg'; w: number; h: number }> {
    const r = await this.need(deviceId, 'look');
    if (r.adb) {
      const png = await r.adb.execOutBytes(['screencap', '-p'], 20_000);
      if (!png.length) throw new Error('The screenshot came back empty.');
      return { image: png, mime: 'image/png', w: 0, h: 0 };
    }
    const shot = (await r.link!.request('screenshot', {})) as { b64: string; mime: 'image/jpeg' | 'image/png'; w: number; h: number };
    return { image: Buffer.from(shot.b64, 'base64'), mime: shot.mime, w: shot.w, h: shot.h };
  }

  /** The screen as a labelled tree. Over the link it's the Accessibility tree; over adb, `uiautomator dump`. */
  async screen(deviceId: string): Promise<{ text: string; view?: ScreenView }> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control?.accessibility) {
      const view = (await r.link.request('screen', {})) as ScreenView;
      return { text: describeScreen(view), view };
    }
    if (r.adb) {
      const dump = await r.adb.shell('uiautomator dump /dev/tty 2>/dev/null; cat /sdcard/window_dump.xml 2>/dev/null', 20_000).catch(() => undefined);
      const xml = dump?.stdout?.includes('<hierarchy') ? dump.stdout : (await r.adb.shell('uiautomator dump && cat /sdcard/window_dump.xml', 20_000)).stdout;
      return { text: describeUiautomator(xml) };
    }
    throw new Error('Can’t read the screen on this phone right now.');
  }

  async tap(deviceId: string, a: { x: number; y: number; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'tap', a, (adb) => adb.shell(`input tap ${a.x} ${a.y}`));
  }
  async longPress(deviceId: string, a: { x: number; y: number; ms?: number }): Promise<void> {
    await this.act(deviceId, 'long_press', a, (adb) => adb.shell(`input swipe ${a.x} ${a.y} ${a.x} ${a.y} ${a.ms ?? 600}`));
  }
  async swipe(deviceId: string, a: { x1: number; y1: number; x2: number; y2: number; ms?: number }): Promise<void> {
    await this.act(deviceId, 'swipe', a, (adb) => adb.shell(`input swipe ${a.x1} ${a.y1} ${a.x2} ${a.y2} ${a.ms ?? 300}`));
  }
  async type(deviceId: string, a: { text: string; replace?: boolean; enter?: boolean; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'type', a, async (adb) => {
      if (a.replace) {
        // Select all and delete, then type (adb input has no "clear").
        await adb.shell('input keyevent KEYCODE_MOVE_END');
        await adb.shell('input keyevent --longpress $(printf "67 %.0s" {1..80})').catch(() => undefined);
      }
      const esc = a.text.replace(/(["\s$'`\\&|;<>()])/g, '\\$1');
      const res = await adb.shell(`input text "${esc}"`);
      if (a.enter) await adb.shell('input keyevent KEYCODE_ENTER');
      return res;
    });
  }
  async key(deviceId: string, key: string): Promise<void> {
    const code = ADB_KEYS[key];
    await this.act(deviceId, 'key', { key }, (adb) => (code ? adb.shell(`input keyevent ${code}`) : Promise.reject(new Error(`No adb key for ${key}`))));
  }
  async scroll(deviceId: string, a: { dir: 'up' | 'down' | 'left' | 'right'; node?: number; gen?: number }): Promise<void> {
    await this.act(deviceId, 'scroll', a, (adb) => adb.shell(scrollCommand(a.dir)));
  }
  async open(deviceId: string, a: { package?: string; url?: string }): Promise<string> {
    const r = await this.need(deviceId, 'act');
    if (r.adb) {
      const res = a.url ? await r.adb.shell(`am start -a android.intent.action.VIEW -d ${JSON.stringify(a.url)}`) : await r.adb.shell(`monkey -p ${a.package} -c android.intent.category.LAUNCHER 1`);
      if (res.code !== 0 && res.stderr.trim()) throw new Error(res.stderr.trim().slice(0, 200));
      return a.url ? `Opened ${a.url}` : `Opened ${a.package}`;
    }
    await r.link!.request('open', a);
    return a.url ? `Opened ${a.url}` : `Opened ${a.package}`;
  }
  async apps(deviceId: string): Promise<Array<{ pkg: string; label: string }>> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control) {
      const res = (await r.link.request('apps', {})) as { apps: Array<{ pkg: string; label: string }> };
      return res.apps;
    }
    const res = await r.adb!.shell('pm list packages -3');
    return res.stdout.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean).map((pkg) => ({ pkg, label: pkg }));
  }
  async info(deviceId: string): Promise<Record<string, unknown>> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control) return (await r.link.request('info', {})) as Record<string, unknown>;
    const model = (await r.adb!.shell('getprop ro.product.model')).stdout.trim();
    const android = (await r.adb!.shell('getprop ro.build.version.release')).stdout.trim();
    return { model, android };
  }

  /** A shell command on the phone (adb only). */
  async shell(deviceId: string, command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await this.need(deviceId, 'shell');
    if (!r.adb) throw new Error('A shell command needs Wireless debugging (Accessibility can’t run commands).');
    return r.adb.shell(command, timeoutMs);
  }
  /** Recent logs (adb only). */
  async logcat(deviceId: string, args: readonly string[] = ['-d', '-t', '400']): Promise<string> {
    const r = await this.need(deviceId, 'shell');
    if (!r.adb) throw new Error('Reading logs needs Wireless debugging.');
    const safe = args.filter((a) => /^[\w:*.,=\/-]+$/.test(a)).slice(0, 12);
    return (await r.adb.run(['logcat', ...safe], 20_000)).stdout;
  }

  /** Send a file from this Mac to the phone (adb push); returns the on-device path (BLG-176). */
  async push(deviceId: string, localPath: string, dest = '/sdcard/Download/'): Promise<string> {
    const r = await this.need(deviceId, 'act');
    if (!r.adb) throw new Error('Sending a file to the phone needs Wireless debugging.');
    const res = await r.adb.run(['push', localPath, dest], 120_000);
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || 'The push failed.');
    return dest.endsWith('/') ? dest + path.basename(localPath) : dest;
  }

  /** Get a file from the phone to a folder on this Mac (adb pull); returns the local path (BLG-176). */
  async pull(deviceId: string, remotePath: string, intoDir: string): Promise<string> {
    const r = await this.need(deviceId, 'look');
    if (!r.adb) throw new Error('Getting a file from the phone needs Wireless debugging.');
    await fs.mkdir(intoDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const local = path.join(intoDir, path.basename(remotePath) || 'file');
    const res = await r.adb.run(['pull', remotePath, local], 120_000);
    if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 200) || 'The pull failed.');
    return local;
  }

  /** The phone's current notifications (adb dumpsys, best-effort parse; BLG-176). */
  async notifications(deviceId: string): Promise<Array<{ app: string; title: string; text: string }>> {
    const r = await this.need(deviceId, 'look');
    if (!r.adb) throw new Error('Reading notifications needs Wireless debugging.');
    const out = await r.adb.shell('dumpsys notification --noredact', 15_000);
    return parseNotifications(out.stdout);
  }

  /** The adb serial for this phone's Bash, so `adb -s <serial>` and scrcpy work; or undefined. */
  async serialFor(deviceId: string): Promise<{ serial: string; adbPath: string } | undefined> {
    const r = await this.reach(deviceId);
    return r?.adb ? { serial: r.adb.serial, adbPath: r.adb.adbPath } : undefined;
  }

  /**
   * Environment for the owner's runs (BLG-174) so Claude's Bash can use adb and scrcpy against the
   * phone with no setup: adb on PATH, and ANDROID_SERIAL when this phone's serial is already known
   * (with one phone attached, adb needs no serial anyway). Synchronous and best-effort — it never
   * blocks a run; a `phone_status` or any phone tool first will have cached the serial.
   */
  runEnv(): Record<string, string> {
    // adb in Claude's Bash is a full shell on the phone: only at Full, and never after the phone said Stop.
    const target = this.targetDevice();
    if (!target || this.howUsed(target) !== 'full' || this.phoneSaidNo(target)) return {};
    const dir = this.adbDirSync();
    if (!dir) return {};
    const env: Record<string, string> = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
    const id = this.targetDevice();
    const serial = id ? this.serials.get(id) : undefined;
    if (serial) env.ANDROID_SERIAL = serial;
    return env;
  }

  /** adb's folder, found without the async probe (the cached one, or the first that exists on disk). */
  private adbDirSync(): string | undefined {
    if (this.adb) return path.dirname(this.adb.path);
    if (this.deps.adbPath) return path.dirname(this.deps.adbPath);
    const hit = adbCandidates(this.deps.home).find((p) => existsSync(p));
    return hit ? path.dirname(hit) : undefined;
  }

  /**
   * A live mirror of the phone's screen (BLG-173). With `video` (the screen can decode H.264) it
   * plays live video to `onVideo`: over adb, Android's own `screenrecord` (BLG-185, nothing to
   * allow on the phone); without adb, the app's screen capture and hardware encoder (1.18,
   * BLG-184; the user taps "Start now" once). Until video flows, or if it stops, it shows pictures
   * instead, at about `fps`, to `onFrame`: over adb a full-resolution `screencap` PNG; over the
   * Accessibility link a downscaled JPEG, at most one per SHOT_GAP_MS (Android refuses faster). One
   * picture is in flight at a time, so a slow phone just lowers the rate rather than piling up. The
   * route is found once and re-checked every few seconds, not per picture (finding it runs adb).
   * `onTouch` hears what Claude does on the phone meanwhile (BLG-186), to show it where it lands.
   */
  startMirror(
    deviceId: string,
    opts: { fps?: number; max?: number; video?: boolean },
    onFrame: (f: { b64: string; mime: string; w: number; h: number }) => void,
    onStatus: (s: MirrorStatus) => void,
    onVideo?: (p: VideoPiece) => void,
    onTouch?: (t: PhoneTouch) => void,
  ): () => void {
    let stopped = false;
    const fps = Math.min(opts.fps ?? 6, 30);
    const interval = 1000 / fps;
    const wantVideo = Boolean(opts.video && onVideo);
    let route: PhoneRoute | undefined;
    let video: MirrorStatus['video'];
    let note: string | undefined;
    const say = (on: boolean, error?: string): void => onStatus({ on, ...(route ? { route } : {}), ...(video ? { video } : {}), ...(note ? { note } : {}), ...(error ? { error } : {}) });
    const offTouch = onTouch ? this.onTouch(deviceId, onTouch) : undefined;

    // ---- live video
    let pieceAt = 0;
    const piece = (p: VideoPiece): void => {
      if (stopped) return;
      pieceAt = Date.now();
      if (video !== 'on') {
        video = 'on';
        note = undefined;
        say(true);
      }
      onVideo?.(p);
    };
    /** The video stopped (the phone said no, Stop, or adb's stream ended): pictures again, with a word why. */
    const ended = (reason?: string): void => {
      if (stopped) return;
      video = undefined;
      note = reason;
      say(true);
    };

    // Over adb: screenrecord, while it runs (a still screen sends nothing, and that's fine).
    let adbVideo: { stop(): void } | undefined;
    let adbTried = false;
    const startAdbVideo = async (adb: Adb, via: PhoneRoute): Promise<void> => {
      adbTried = true;
      const kbps = via === 'usb' ? VIDEO_KBPS_USB : via === 'wifi' ? VIDEO_KBPS_WIFI : VIDEO_KBPS;
      const v = await adbScreenVideo(adb, { max: VIDEO_MAX, kbps }, piece, (error) => {
        adbVideo = undefined;
        this.logLine(`mirror video over adb: ${error}`);
        // Not a word for the user: the app's video or pictures carry on.
        if (video === 'on') ended();
      }).catch((err: unknown) => {
        this.logLine(`mirror video over adb: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      if (stopped) v?.stop();
      else adbVideo = v;
    };

    // From the app: its screen capture (asks "Start now" the first time).
    let videoLink: PhoneLinkHandle | undefined;
    let unwatch: (() => void) | undefined;
    const startAppVideo = async (link: PhoneLinkHandle): Promise<void> => {
      if (!link.watchVideo) return;
      unwatch?.();
      videoLink = link;
      unwatch = link.watchVideo(piece, (reason) => ended(reason ? phoneErrorText(reason) : undefined));
      try {
        const res = (await link.request('mirror', { on: true, max: VIDEO_MAX, fps: VIDEO_FPS, kbps: VIDEO_KBPS }, 10_000)) as MirrorView;
        if (!stopped && res.state === 'asking' && video !== 'on') {
          video = 'asking';
          say(true);
        }
      } catch (err) {
        this.logLine(`mirror video: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    /** Ask the app for video from a link that can (again after the phone reconnects; never again after a no). */
    const armAppVideo = (): void => {
      const link = this.deps.link(deviceId);
      if (!wantVideo || !link?.video || link === videoLink || this.howUsed(deviceId) === 'off') return;
      void startAppVideo(link);
    };
    const flowing = (): boolean => video === 'on' && (adbVideo !== undefined || Date.now() - pieceAt < VIDEO_STALL_MS);

    // ---- pictures, until the video flows (and whenever it doesn't)
    const loop = async (): Promise<void> => {
      let r: Reach | undefined;
      let checkedAt = 0;
      while (!stopped) {
        this.lastUsed.set(deviceId, Date.now());
        if (flowing()) {
          await delay(250);
          continue;
        }
        const started = Date.now();
        try {
          if (!r || started - checkedAt > ROUTE_RECHECK_MS) {
            r = await this.reach(deviceId);
            checkedAt = started;
          }
          if (!r) throw new Error(this.noteFor(this.deps.link(deviceId)?.control, [], this.howUsed(deviceId)) ?? 'The phone isn’t reachable');
          if (r.route !== route) {
            // A new route (a cable plugged in or out): adb's video may work now, or not any more.
            route = r.route;
            adbVideo?.stop();
            adbVideo = undefined;
            adbTried = false;
            say(true);
          }
          // Video over adb first (nothing to allow), else from the app.
          if (wantVideo && r.adb && !adbTried) void startAdbVideo(r.adb, r.route);
          else if (!r.adb || (adbTried && !adbVideo)) armAppVideo();
          if (r.adb) {
            const png = await r.adb.execOutBytes(['screencap', '-p'], 8_000);
            if (png.length && !flowing()) {
              const dim = pngSize(png);
              onFrame({ b64: png.toString('base64'), mime: 'image/png', w: dim?.w ?? 0, h: dim?.h ?? 0 });
            }
          } else if (r.link) {
            const shot = (await r.link.request('screenshot', { max: opts.max ?? 900, quality: 55 }, 8_000)) as { b64: string; mime: 'image/jpeg' | 'image/png'; w: number; h: number };
            if (!flowing()) onFrame({ b64: shot.b64, mime: shot.mime, w: shot.w, h: shot.h });
          }
        } catch (err) {
          if (stopped) break;
          // Asked a moment too soon (the link's timing wobbles): not an error, just go again.
          if (tooSoon(err)) {
            await delay(SHOT_GAP_MS);
            continue;
          }
          // Find the route again, say "Live" again once pictures come back, and back off a little
          // first (the phone slept, the route dropped).
          r = undefined;
          route = undefined;
          if (!flowing()) say(false, err instanceof Error ? phoneErrorText(err.message) : String(err));
          await delay(1200);
          continue;
        }
        const wait = (r.adb ? interval : Math.max(interval, SHOT_GAP_MS)) - (Date.now() - started);
        if (wait > 0) await delay(wait);
      }
    };
    void loop();
    return () => {
      stopped = true;
      offTouch?.();
      adbVideo?.stop();
      unwatch?.();
      if (videoLink) void videoLink.request('mirror', { on: false }, 5_000).catch(() => undefined);
      onStatus({ on: false });
    };
  }

  // ---- what Claude does on the phone (BLG-186)

  private readonly touchers = new Map<string, Set<(t: PhoneTouch) => void>>();
  private readonly busyAt = new Map<string, number>();
  private readonly busyTimers = new Map<string, NodeJS.Timeout>();

  /** Hear what Claude does on this phone (the mirrors watching it) until the returned stop(). */
  onTouch(deviceId: string, fn: (t: PhoneTouch) => void): () => void {
    const set = this.touchers.get(deviceId) ?? new Set();
    set.add(fn);
    this.touchers.set(deviceId, set);
    return () => void set.delete(fn);
  }

  /** Claude is doing this on the phone now: the mirrors show it, and the phone counts as busy a while. */
  private claudeDid(deviceId: string, t: PhoneTouch): void {
    for (const fn of [...(this.touchers.get(deviceId) ?? [])]) fn(t);
    const was = this.busy(deviceId);
    this.busyAt.set(deviceId, Date.now());
    clearTimeout(this.busyTimers.get(deviceId));
    const timer = setTimeout(() => this.deps.onChange(), BUSY_MS + 50);
    timer.unref();
    this.busyTimers.set(deviceId, timer);
    if (!was) this.deps.onChange();
  }

  private busy(deviceId: string): boolean {
    return Date.now() - (this.busyAt.get(deviceId) ?? 0) < BUSY_MS;
  }

  /** Elements on screen now with where to tap them, for find-by-text (macros, BLG-175). */
  private async screenTargets(deviceId: string): Promise<Array<{ label: string; cx: number; cy: number }>> {
    const r = await this.need(deviceId, 'look');
    if (r.link?.control?.accessibility) {
      const view = (await r.link.request('screen', {})) as ScreenView;
      return view.nodes.flatMap((n) => {
        const label = [n.t, n.s, n.h, n.r].filter(Boolean).join(' ');
        const [l, t, rr, b] = n.b;
        return label ? [{ label, cx: Math.round((l + rr) / 2), cy: Math.round((t + b) / 2) }] : [];
      });
    }
    if (r.adb) {
      const dump = await r.adb.shell('uiautomator dump && cat /sdcard/window_dump.xml', 20_000);
      return targetsFromUiautomator(dump.stdout);
    }
    return [];
  }

  /** Where to tap the element that shows `text` (case-insensitive, contains), or undefined. */
  async findByText(deviceId: string, text: string): Promise<{ x: number; y: number } | undefined> {
    const want = text.trim().toLowerCase();
    const targets = await this.screenTargets(deviceId);
    const hit = targets.find((t) => t.label.toLowerCase() === want) ?? targets.find((t) => t.label.toLowerCase().includes(want));
    return hit ? { x: hit.cx, y: hit.cy } : undefined;
  }

  /**
   * Run a saved flow (BLG-175): each step in turn, with a short settle between them, re-finding
   * tap-by-text against the live screen. Returns a short transcript; throws on the first step that
   * can't be done (so a broken macro stops rather than wandering).
   */
  async runMacro(deviceId: string, steps: readonly MacroStep[], onStep?: (line: string) => void): Promise<string> {
    const log: string[] = [];
    const note = (line: string): void => {
      log.push(line);
      onStep?.(line);
    };
    for (const [i, step] of steps.entries()) {
      const at = `${i + 1}/${steps.length}`;
      switch (step.op) {
        case 'wait':
          await delay(step.ms);
          note(`${at} waited ${step.ms}ms`);
          break;
        case 'open':
          await this.open(deviceId, step);
          note(`${at} opened ${step.url ?? step.package}`);
          break;
        case 'tapText': {
          const spot = await this.findByText(deviceId, step.text);
          if (!spot) throw new Error(`Step ${at}: couldn’t find “${step.text}” on screen`);
          await this.tap(deviceId, spot);
          note(`${at} tapped “${step.text}”`);
          break;
        }
        case 'tap':
          await this.tap(deviceId, { x: step.x, y: step.y });
          note(`${at} tapped ${step.x},${step.y}`);
          break;
        case 'type':
          await this.type(deviceId, { text: step.text, ...(step.clear ? { replace: true } : {}), ...(step.enter ? { enter: true } : {}) });
          note(`${at} typed`);
          break;
        case 'key':
          await this.key(deviceId, step.key);
          note(`${at} pressed ${step.key}`);
          break;
        case 'swipe':
          await this.swipe(deviceId, step);
          note(`${at} swiped`);
          break;
        case 'scroll':
          await this.scroll(deviceId, { dir: step.dir });
          note(`${at} scrolled ${step.dir}`);
          break;
      }
      if (step.op !== 'wait') await delay(700);
    }
    return log.join('\n');
  }

  // ---- saved flows (BLG-175)

  listMacros(): readonly Macro[] {
    return this.deps.macros?.all() ?? [];
  }
  saveMacro(name: string, steps: readonly MacroStep[]): Macro {
    if (!this.deps.macros) throw new Error('Macros need the Beluga app');
    const id = this.targetDevice();
    const model = id ? this.deps.link(id)?.control?.device.model : undefined;
    const macro = this.deps.macros.save({ name, steps: [...steps], createdAt: Date.now(), ...(model ? { device: model } : {}) });
    this.deps.onChange();
    return macro;
  }
  deleteMacro(name: string): boolean {
    const gone = this.deps.macros?.remove(name) ?? false;
    if (gone) this.deps.onChange();
    return gone;
  }
  /** Run a saved macro on the phone Claude would act on now. */
  async runNamedMacro(name: string, onStep?: (line: string) => void): Promise<string> {
    const macro = this.deps.macros?.get(name);
    if (!macro) throw new Error(`There’s no macro called “${name}”`);
    const deviceId = this.targetDevice();
    if (!deviceId) throw new Error('No phone is set up to run it on');
    return this.runMacro(deviceId, macro.steps, onStep);
  }

  /** One action for the Mac UI (the mirror's tap/type/scroll, or a button), by op. */
  async action(deviceId: string, op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
    // A person poking at the mirror wants it to answer at once: the Accessibility service's gestures
    // are instant, where adb's `input` starts a program on the phone each time.
    const r = QUICK_OPS.has(op) ? await this.need(deviceId, 'act') : undefined;
    if (r?.link?.control?.accessibility) return this.viaLink(deviceId, r.link, op, args);
    switch (op) {
      case 'tap':
        return this.tap(deviceId, args as { x: number; y: number; node?: number });
      case 'long_press':
        return this.longPress(deviceId, args as { x: number; y: number; ms?: number });
      case 'swipe':
        return this.swipe(deviceId, args as { x1: number; y1: number; x2: number; y2: number; ms?: number });
      case 'type':
        return this.type(deviceId, args as { text: string; replace?: boolean; enter?: boolean });
      case 'key':
        return this.key(deviceId, String((args as { key: string }).key));
      case 'scroll':
        return this.scroll(deviceId, args as { dir: 'up' | 'down' | 'left' | 'right' });
      case 'open':
        return this.open(deviceId, args as { package?: string; url?: string });
      default:
        throw new Error(`Can’t do ${op} from here`);
    }
  }

  // ---- helpers

  /** The reach for an action of this kind, after the use level has allowed it (reused a few seconds: finding it runs adb). */
  private async need(deviceId: string, kind: 'look' | 'act' | 'shell'): Promise<Reach> {
    const use = this.howUsed(deviceId);
    if (use === 'off') throw new Error('This phone is off for your agent (turn it on in Settings › Phone).');
    if (this.phoneSaidNo(deviceId)) throw new Error('The phone said Stop: “Let your Mac use this phone” is off in its Beluga.');
    this.lastUsed.set(deviceId, Date.now());
    const kept = this.reached.get(deviceId);
    if (kept && Date.now() - kept.at < REACH_KEEP_MS && kept.r.link === this.deps.link(deviceId)) return kept.r;
    const r = await this.reach(deviceId);
    if (!r) throw new Error(this.noteFor(this.deps.link(deviceId)?.control, [], use) ?? 'Can’t reach this phone right now.');
    this.reached.set(deviceId, { r, at: Date.now() });
    return r;
  }
  private readonly reached = new Map<string, { r: Reach; at: number }>();

  /** An op through the Accessibility service; a failure forgets the kept route (it may have changed). */
  private async viaLink(deviceId: string, link: PhoneLinkHandle, op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await link.request(op, args);
    } catch (err) {
      this.reached.delete(deviceId);
      throw err;
    }
  }

  /** Do an acting op by the route we have: adb when present, else the Accessibility service. */
  private async act(deviceId: string, op: PhoneOp, args: Record<string, unknown>, viaAdb: (adb: Adb) => Promise<{ code: number; stderr: string } | void>): Promise<void> {
    const r = await this.need(deviceId, 'act');
    // A node of the last screen is only meaningful to the Accessibility service: prefer the link then.
    const preferLink = typeof args.node === 'number' && r.link?.control?.accessibility;
    if (r.adb && !preferLink && !OP_NEEDS_ADB.has(op)) {
      const res = await viaAdb(r.adb).catch((err: unknown) => {
        this.reached.delete(deviceId);
        throw err;
      });
      if (res && res.code !== 0 && res.stderr.trim()) {
        this.reached.delete(deviceId);
        throw new Error(res.stderr.trim().slice(0, 200));
      }
      return;
    }
    if (!r.link?.control?.accessibility) throw new Error('Can’t act on this phone right now.');
    await this.viaLink(deviceId, r.link, op, args);
  }

  /** The local adb-over-link tunnel's port for a phone (started on demand), or undefined. */
  private async tunnelPort(deviceId: string): Promise<number | undefined> {
    const existing = this.tunnels.get(deviceId);
    if (existing) return existing.port;
    const link = this.deps.link(deviceId);
    if (!link?.control?.adb.on) return undefined;
    const port = await this.startTunnel(deviceId).catch((err: unknown) => {
      this.logLine(`tunnel for ${deviceId}: ${String(err)}`);
      return undefined;
    });
    return port;
  }

  /**
   * A local TCP server on 127.0.0.1: every connection the Mac's adb makes opens a byte tunnel to the
   * phone's debugging port through the link (the phone's worklet dials its own adbd). adb's own TLS
   * stays end to end between adb and adbd; the link only carries the ciphertext.
   */
  private startTunnel(deviceId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const link = this.deps.link(deviceId);
        if (!link) return socket.destroy();
        let allowed = TUN_WINDOW;
        const end = link.openTunnel('adb', {
          onOpen: () => socket.resume(),
          onData: (bytes) => {
            if (!socket.write(bytes)) socket.pause();
          },
          onClose: (error) => socket.destroy(error ? new Error(error) : undefined),
          onAck: (n) => {
            allowed += n;
            if (allowed > 0) socket.resume();
          },
        });
        socket.on('data', (chunk: Buffer) => {
          end.send(chunk);
          allowed -= chunk.length;
          if (allowed <= 0) socket.pause();
        });
        socket.on('drain', () => socket.resume());
        socket.on('close', () => end.close());
        socket.on('error', () => end.close('socket error'));
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        if (!port) return reject(new Error('No local port for the adb tunnel'));
        this.tunnels.set(deviceId, { server, port });
        resolve(port);
      });
    });
  }

  /**
   * Beluga Link on the phone, from the Mac (BLG-391): the latest release's Beluga-Link.apk installed
   * over adb, which Play Protect doesn't block the way it blocks a downloaded Accessibility app, then
   * its Accessibility service turned on beside whatever else is on. Nothing to tap on the phone.
   */
  /** Link and the app on the phone are signed with the same key (false when adb doesn't say). */
  private async sameSigner(adb: { shell(cmd: string, ms: number): Promise<{ stdout: string }> }): Promise<boolean> {
    const [link, app] = await Promise.all([adb.shell(`dumpsys package ${LINK_PACKAGE}`, 10_000), adb.shell(`dumpsys package ${APP_PACKAGE}`, 10_000)]);
    const a = signerOf(link.stdout);
    return a !== undefined && a === signerOf(app.stdout);
  }

  async setUpLink(deviceId: string, download: (to: string) => Promise<void> = fetchLinkApk): Promise<string> {
    const cable = 'Connect the phone to this Mac with a cable first (or turn on Wireless debugging): Beluga Link is installed over it.';
    // Not reachable at all says to plug in, not to install Link (that's what this does).
    const r = await this.need(deviceId, 'act').catch((err: unknown) => {
      if (this.howUsed(deviceId) === 'off' || this.phoneSaidNo(deviceId)) throw err;
      throw new Error(cable);
    });
    if (!r.adb) throw new Error(cable);
    const listed = await r.adb.shell(`pm list packages --user 0 ${LINK_PACKAGE}`, 10_000);
    const installed = listed.stdout.split('\n').some((l) => l.trim() === `package:${LINK_PACKAGE}`);
    // Link and the app trust each other by their signing key. A Link signed with the old key (before
    // BLG-430) is installed but never connects, so it's replaced.
    const matches = installed && (await this.sameSigner(r.adb));
    if (!matches) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beluga-link-'));
      try {
        const apk = path.join(dir, 'Beluga-Link.apk');
        await download(apk);
        let res = await r.adb.run(['install', '-r', '--user', '0', apk], 180_000);
        if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(res.stdout + res.stderr)) {
          // Signed with the other key: Link keeps nothing worth saving, so it goes and comes back.
          await r.adb.shell(`pm uninstall --user 0 ${LINK_PACKAGE}`, 30_000);
          res = await r.adb.run(['install', '-r', '--user', '0', apk], 180_000);
        }
        if (!/Success/i.test(res.stdout)) throw new Error(`The phone didn’t install Beluga Link: ${(res.stderr.trim() || res.stdout.trim()).slice(0, 200) || 'no reason given'}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    const now = (await r.adb.shell('settings get secure enabled_accessibility_services', 8_000)).stdout.trim();
    const next = withLinkService(now);
    if (next !== now) {
      const put = await r.adb.shell(`settings put secure enabled_accessibility_services '${next}'`, 8_000);
      if (put.code !== 0) throw new Error(put.stderr.trim().slice(0, 200) || 'The phone didn’t turn on Beluga Link.');
      await r.adb.shell('settings put secure accessibility_enabled 1', 8_000);
    }
    this.reached.delete(deviceId);
    this.deps.onChange();
    return 'Beluga Link is installed and on: your agent can look at the phone and tap, type and open apps, cable or not.';
  }

  /** Pair the Mac's adb with the phone, using a code the phone sent (over the pairing-port tunnel). */
  async pairAdb(deviceId: string): Promise<string> {
    const adb = await this.ensureAdb();
    if (!adb) throw new Error('adb isn’t installed on this Mac.');
    const link = this.deps.link(deviceId);
    const code = link?.adbCode?.code;
    const pairPort = link?.control?.adb.pairing;
    if (!code || !pairPort) throw new Error('Open “Pair with code” on the phone and type the six digits into Beluga’s notification.');
    // A tunnel to the pairing port; adb pairs over it.
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const end = link!.openTunnel('adb-pair', {
          onOpen: () => socket.resume(),
          onData: (b) => void socket.write(b),
          onClose: (e) => socket.destroy(e ? new Error(e) : undefined),
          onAck: () => undefined,
        });
        socket.on('data', (c: Buffer) => end.send(c));
        socket.on('close', () => end.close());
        socket.on('error', () => end.close());
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
        setTimeout(() => server.close(), 30_000).unref();
      });
    });
    const res = await this.deps.sys.exec(adb.path, ['pair', `127.0.0.1:${port}`, code], 20_000);
    if (!/Successfully paired/i.test(res.stdout)) throw new Error(res.stdout.trim() || res.stderr.trim() || 'Pairing didn’t go through.');
    this.deps.onChange();
    return 'Paired. Connecting…';
  }

  /** A phone said new control, went away, or its code came: recompute and publish. */
  touched(deviceId: string, usb?: boolean): void {
    if (usb !== undefined) this.lastUsb.set(deviceId, usb);
    // The phone's own switch, kept: its Stop holds even while its app isn't running.
    const said = this.deps.link(deviceId)?.control?.allowed;
    if (said !== undefined && (this.deps.devices.get(deviceId)?.stopped === true) === said) this.deps.devices.update(deviceId, { stopped: !said });
    if (said === false) this.reached.delete(deviceId);
    this.deps.onChange();
  }

  /** Close everything for a phone that's gone or was removed. */
  forget(deviceId: string): void {
    const t = this.tunnels.get(deviceId);
    if (t) {
      t.server.close();
      this.tunnels.delete(deviceId);
    }
    this.serials.delete(deviceId);
    this.lastUsb.delete(deviceId);
    this.reached.delete(deviceId);
  }

  stop(): void {
    clearInterval(this.idleCheck);
    clearInterval(this.cableTimer);
    for (const { server } of this.tunnels.values()) server.close();
    this.tunnels.clear();
  }

  /** The phone Claude should act on: an Android one the owner turned on, a linked one first. */
  targetDevice(): string | undefined {
    const on = this.deps.devices
      .all()
      .filter((r) => r.cert.platform === 'android' && (r.use ?? 'off') !== 'off')
      .map((r) => r.cert.device.slice(0, 16));
    if (!on.length) return undefined;
    return on.find((id) => this.deps.link(id)) ?? on[0];
  }

  /** A line for the tools and the brief: which phone and how it's reached now. */
  summaryLine(deviceId: string): string {
    const v = this.controlView(deviceId);
    const name = this.deps.devices.get(deviceId)?.cert.name ?? 'your phone';
    const how = v.routes.length ? `reached by ${v.routes[0] === 'accessibility' ? 'the Accessibility service' : v.routes[0] === 'link' ? `Wireless debugging through Beluga’s link${v.wifiPath === 'blocked' ? ' (this Wi-Fi keeps devices apart)' : ''}` : v.routes[0] === 'wifi' ? 'Wireless debugging (straight over the same Wi-Fi)' : 'USB'}` : (v.note ?? 'not reachable right now');
    const shell = v.routes.some((x) => x === 'usb' || x === 'wifi' || x === 'link');
    return `${name} (${v.model ?? 'Android'}) — ${how}.${shell ? ' Shell, logs and installs work.' : ' Taps, typing and screenshots only (no shell/logs: turn on Wireless debugging for those).'}`;
  }

  /**
   * The agent's tools for the owner's own runs (server beluga_phone). Returns undefined when no
   * phone is turned on. `scratchDir` (absolute): where a screenshot is saved so it shows as an
   * output on both screens.
   */
  toolsFor(scratchDir?: string): { tools: PhoneTools; brief: string; deviceId: string; env: Record<string, string> } | undefined {
    const deviceId = this.targetDevice();
    if (!deviceId) return undefined;
    // Warm the route so the serial is cached for this run's Bash adb (fire-and-forget).
    void this.reach(deviceId).catch(() => undefined);
    const ctl = this;
    const ok = (text: string): string => text;
    const tools: PhoneTools = {
      status: async () => ctl.summaryLine(deviceId),
      screenshot: async () => {
        const shot = await ctl.screenshot(deviceId);
        let saved = '';
        if (scratchDir) {
          await fs.mkdir(scratchDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
          const name = `phone-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`;
          await fs.writeFile(path.join(scratchDir, name), shot.image).catch(() => undefined);
          saved = ` Saved as ${name}.`;
        }
        return { text: `Screenshot of the phone.${saved} Say in a line what it shows.`, image: { data: shot.image.toString('base64'), mimeType: shot.mime } };
      },
      screen: async () => (await ctl.screen(deviceId)).text,
      // Each action shows on the mirrors as it happens (BLG-186): where a tap lands, a swipe's path.
      tap: async (a) => (ctl.claudeDid(deviceId, { op: 'tap', x: a.x, y: a.y }), await ctl.tap(deviceId, a), ok(`Tapped ${a.node !== undefined ? `#${a.node}` : `${a.x},${a.y}`}.`)),
      swipe: async (a) => (ctl.claudeDid(deviceId, { op: 'swipe', x: a.x1, y: a.y1, x2: a.x2, y2: a.y2 }), await ctl.swipe(deviceId, a), ok('Swiped.')),
      type: async (a) => (ctl.claudeDid(deviceId, { op: 'type' }), await ctl.type(deviceId, a), ok(`Typed${a.enter ? ' and pressed enter' : ''}.`)),
      key: async (key) => (ctl.claudeDid(deviceId, { op: 'key', what: key }), await ctl.key(deviceId, key), ok(`Pressed ${key}.`)),
      scroll: async (a) => (ctl.claudeDid(deviceId, { op: 'scroll', what: a.dir }), await ctl.scroll(deviceId, a), ok(`Scrolled ${a.dir}.`)),
      open: async (a) => (ctl.claudeDid(deviceId, { op: 'open', what: a.package ?? 'a link' }), ctl.open(deviceId, a)),
      apps: async () => {
        const list = await ctl.apps(deviceId);
        return list.map((x) => `${x.label}${x.label === x.pkg ? '' : ` (${x.pkg})`}`).join('\n') || 'No apps listed.';
      },
      info: async () => {
        const i = await ctl.info(deviceId);
        return Object.entries(i).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
      },
      install: async (apkPath) => {
        const r = await ctl.need(deviceId, 'act');
        if (r.adb) {
          const res = await r.adb.run(['install', '-r', apkPath], 120_000);
          if (!/Success/i.test(res.stdout)) throw new Error(res.stderr.trim() || res.stdout.trim() || 'Install failed.');
          return 'Installed.';
        }
        throw new Error('Installing over the Accessibility service isn’t supported yet; turn on Wireless debugging.');
      },
      setUpLink: async () => ctl.setUpLink(deviceId),
      shell: async (command) => {
        const res = await ctl.shell(deviceId, command);
        return `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`.trim() || `(no output, exit ${res.code})`;
      },
      logcat: async (filter) => ctl.logcat(deviceId, filter ? filter.split(/\s+/) : undefined),
      push: async (localPath, dest) => `Sent to the phone at ${await ctl.push(deviceId, localPath, dest)}`,
      pull: async (remotePath) => {
        if (!scratchDir) throw new Error('No scratch folder to save into');
        const local = await ctl.pull(deviceId, remotePath, scratchDir);
        return `Saved from the phone as ${path.basename(local)} (an output), at ${local}. Show it in your answer: an image as ![name](${local}), any other file as a link to that path.`;
      },
      notifications: async () => {
        const list = await ctl.notifications(deviceId);
        return list.length ? list.map((n) => `• ${n.title || n.app}${n.text ? ` — ${n.text}` : ''}  [${n.app}]`).join('\n') : 'No notifications right now.';
      },
      macroSave: async (name, steps) => {
        const parsed = z.array(MacroStep).min(1).max(100).safeParse(steps);
        if (!parsed.success) throw new Error(`Those steps aren’t valid: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
        const m = ctl.saveMacro(name, parsed.data);
        return `Saved the macro “${m.name}” (${m.steps.length} steps). Run it later with phone_macro_run.`;
      },
      macroList: async () => {
        const list = ctl.listMacros();
        return list.length ? list.map((m) => `• ${m.name} — ${m.steps.length} steps`).join('\n') : 'No macros saved yet.';
      },
      macroRun: async (name) => ctl.runNamedMacro(name),
      macroDelete: async (name) => (ctl.deleteMacro(name) ? `Deleted “${name}”.` : `No macro called “${name}”.`),
    };
    return { tools, brief: phoneBrief(`- Now: ${this.summaryLine(deviceId)}`), deviceId, env: this.runEnv() };
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());
const unrefd = <T extends { unref(): unknown }>(timer: T): T => (timer.unref(), timer);

/** `dumpsys notification --noredact` → the active notifications (best-effort: pkg, title, text). */
export function parseNotifications(dump: string): Array<{ app: string; title: string; text: string }> {
  const out: Array<{ app: string; title: string; text: string }> = [];
  // Each record block starts with `NotificationRecord(... pkg=<pkg> ...)`; titles/texts are `android.title=String (...)`.
  const blocks = dump.split(/NotificationRecord\(/).slice(1);
  for (const block of blocks.slice(0, 60)) {
    const app = /pkg=([\w.]+)/.exec(block)?.[1];
    if (!app) continue;
    const title = /android\.title=String \(([^)]*)\)/.exec(block)?.[1] ?? /tickerText=([^\n]+)/.exec(block)?.[1];
    const text = /android\.text=String \(([^)]*)\)/.exec(block)?.[1] ?? /android\.text=CharSequence \(([^)]*)\)/.exec(block)?.[1];
    if (title || text) out.push({ app, title: (title ?? '').trim().slice(0, 200), text: (text ?? '').trim().slice(0, 500) });
  }
  return out;
}

/** A PNG's pixel size from its IHDR (bytes 16–23, big-endian); undefined if it isn't a PNG. */
function pngSize(png: Buffer): { w: number; h: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** Android key codes for the buttons a phone has (adb `input keyevent`). */
const ADB_KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  notifications: 'KEYCODE_NOTIFICATION',
  enter: 'KEYCODE_ENTER',
  lock: 'KEYCODE_POWER',
};

function scrollCommand(dir: 'up' | 'down' | 'left' | 'right'): string {
  // A swipe across the middle of a 1080×2400-ish screen; the phone clamps to its real size.
  const mid = { x: 540, y: 1200 };
  const d = 700;
  if (dir === 'up') return `input swipe ${mid.x} ${mid.y - d} ${mid.x} ${mid.y + d} 300`;
  if (dir === 'down') return `input swipe ${mid.x} ${mid.y + d} ${mid.x} ${mid.y - d} 300`;
  if (dir === 'left') return `input swipe ${mid.x - d} ${mid.y} ${mid.x + d} ${mid.y} 300`;
  return `input swipe ${mid.x + d} ${mid.y} ${mid.x - d} ${mid.y} 300`;
}

/** The Accessibility screen as lines Claude can read and act on (its node numbers are tappable). */
export function describeScreen(view: ScreenView): string {
  const lines = [`App: ${view.app} · ${view.w}×${view.h}${view.keyboard ? ' · keyboard up' : ''}`];
  for (const w of view.windows ?? []) lines.push(`Window: ${w.type}${w.title ? ` "${w.title}"` : ''} (${w.app})`);
  for (const n of view.nodes) {
    const flags = n.f ?? '';
    const says = n.t || n.s || n.h || '';
    const can = [flags.includes('c') && 'tap', flags.includes('e') && 'type', flags.includes('s') && 'scroll'].filter(Boolean).join(',');
    if (!says && !can) continue;
    const [l, t, r, b] = n.b;
    lines.push(`#${n.i} ${n.c}${says ? ` "${says.slice(0, 80)}"` : ''}${n.r ? ` [${n.r}]` : ''}${can ? ` (${can})` : ''} @${Math.round((l + r) / 2)},${Math.round((t + b) / 2)}`);
  }
  return lines.join('\n');
}

/** Tappable targets (label + centre) from `uiautomator dump` XML (for macros' find-by-text). */
export function targetsFromUiautomator(xml: string): Array<{ label: string; cx: number; cy: number }> {
  const out: Array<{ label: string; cx: number; cy: number }> = [];
  const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!bounds) continue;
    const label = [attr(tag, 'text'), attr(tag, 'content-desc'), attr(tag, 'resource-id')?.split('/').pop()].filter(Boolean).join(' ');
    if (!label) continue;
    out.push({ label, cx: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), cy: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2) });
  }
  return out;
}

/** `uiautomator dump` XML as the same kind of lines (used when adb is driving and the app isn't). */
export function describeUiautomator(xml: string): string {
  const nodes: string[] = [];
  let i = 0;
  const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    if (i >= 400) break;
    const tag = m[0];
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!bounds) continue;
    const text = attr(tag, 'text') ?? '';
    const desc = attr(tag, 'content-desc') ?? '';
    const clickable = attr(tag, 'clickable') === 'true';
    const says = text || desc;
    if (!says && !clickable) continue;
    const cls = (attr(tag, 'class') ?? '').split('.').pop();
    const rid = attr(tag, 'resource-id');
    const cx = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
    const cy = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
    nodes.push(`#${i++} ${cls}${says ? ` "${says.slice(0, 80)}"` : ''}${rid ? ` [${rid.split('/').pop()}]` : ''}${clickable ? ' (tap)' : ''} @${cx},${cy}`);
  }
  return nodes.length ? nodes.join('\n') : 'The screen has no labelled elements right now (try a screenshot).';
}
