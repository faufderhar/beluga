/// <reference path="../net/mesh/modules.d.ts" />
import { createHash, hkdfSync } from 'node:crypto';
import { agentName } from '../shared/agent-label.js';
import type { AgentRef } from '../protocol.js';
import type DHT from 'hyperdht';
import type { BootstrapNode, KeyPair, NoiseSocket, Server } from 'hyperdht';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { attachmentsDir, chipText, importImageFitting, registerAttachment } from '../core/attachments.js';
import type { DomainState } from '../core/store.js';
import type { CallOutcome } from '../daemon/dispatch.js';
import type { Identity } from '../net/crypto.js';
import { readJson, writeJson } from '../net/mesh/files.js';
import { type MessageSocket, fromStream } from '../net/transport.js';
import { phoneMay } from './coverage.js';
import { type DeviceBook, type DeviceRecord, deviceId } from './devices.js';
import { type DocumentBytes, FileServer, RefTable, type Thumbnailer } from './files.js';
import { ProjectIcons, type SmallIcon } from './icons.js';
import type { MergeBook } from './merge.js';
import { DevicePairing, type PairingInfo } from './pair.js';
import { Uploads } from './uploads.js';
import { type MacVoice, sharedVoice } from '../core/voice.js';
import type { VoiceModelId } from '../shared/voice-models.js';
import type { TerminalManager } from '../terminal/pty-host.js';
import { TermRelay, isWorkspaceTerminal, keysOf, nextShellKey, terminalView, workspaceOf } from './terminals.js';
import { findByName, listFolder, readPage } from './worktree-files.js';
import { Reach, type RelayTunnel } from './reach.js';
import { Awake } from './awake.js';
import { computersKey, namedPhones, setPhoneRecord } from '../machines/phones.js';
import { detectNotices } from '../core/notify.js';
import { pathNote } from './diagnose.js';
import {
  COMPANION_PROTO,
  type CompanionSlice,
  type DeviceCert,
  type DataListView,
  type DialAttempt,
  type LinkPath,
  KEEPALIVE_AWAY_MS,
  KEEPALIVE_MS,
  type MacFrame,
  MAX_COMPANION_FRAME,
  type MergeView,
  type NeedsYou,
  type PhoneComputer,
  type PhoneControl as PhoneControlState,
  type PhoneFrame,
  type PhoneOp,
  SINCE,
  type TerminalView,
  type TerminalsView,
  type Topic,
  TUN_PIECE,
  VIEW_COALESCE_MS,
  VIEW_TURNS,
  parsePhoneFrame,
} from './protocol.js';
import { runFileMime } from '../core/sentinel/columns.js';
import type { SentinelData } from '../core/sentinel/sentinels.js';
import { type MirrorStatus, PhoneControl, type PhoneLinkHandle, type PhoneTouch, type TunnelEnd, type TunnelSide, type VideoPiece, phoneErrorText } from './phone-control.js';
import { type Macro, PhoneMacros } from './phone-macros.js';
import { type SystemPort, realSystem } from '../core/gateway/device.js';
import { chatTopic } from './needs-you.js';
import { type Delivery, NO_PUSH, type Nudge, type Pusher, atMac, deliver, newMessages } from './push.js';
import { type ConvOutput, type ViewContext, channelOf, chatMessages, convTopic, convTurns, needsYou, phoneChannel, sentinelDone, viewOf } from './views.js';

/**
 * Your Mac's side of the phone link (docs/companion.md, "The link"). Its own DHT node listens at
 * the companion address (derived from your identity, 'companion-v1': stable, and separate from
 * the network's address so it works whether the network is on or not). The firewall lets in only
 * the link keys of phones you paired and haven't removed; the Noise handshake pins both ends.
 *
 * Per phone: hello (an incompatible version is closed with 4002), the topics on its screen (each
 * sent as a whole view when its hash changes, at most every VIEW_COALESCE_MS), calls through the
 * allowlist (coverage.ts) to the same API handlers screens use, files by ref (files.ts), and a
 * nudge in place of a push while it's linked.
 *
 * No DHT node runs unless a phone is paired or a pairing is open: people without a phone pay nothing.
 */

/** Close codes on the link (the phone shows why). */
export const COMPANION_CLOSE = { hello: 4001, version: 4002, removed: 4010, quiet: 4008 } as const;
/** The oldest phone protocol this Mac answers (a major behind, for one release, once there is one). */
export const COMPANION_MIN = { major: COMPANION_PROTO.major, minor: 0 } as const;
/** What a phone may send in one frame (a photo it attaches, in base64, plus room). */
const MAX_IN_BYTES = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_TOPICS = 16;
/** While something that needs you is held (you were at the Mac), how often to look whether you stepped away. */
const HELD_CHECK_MS = 30_000;

export interface CompanionHostOptions {
  readonly identity: Identity;
  /** Where this install's companion address is pinned once your identity can move (BLG-796, pinCompanionSeed). */
  readonly seedFile?: string;
  /** Why a phone can't be paired here now (your identity is on your Always On, BLG-796), or undefined. */
  readonly cannotPair?: () => string | undefined;
  readonly store: { getState(): DomainState; subscribe(listener: () => void): () => void; dispatch(action: { type: 'companion'; companion: CompanionSlice['companion'] }): void };
  readonly devices: DeviceBook;
  /** An API call, as a screen's goes (daemon/dispatch.ts); `clientId` is the phone's. */
  readonly call: (clientId: string, method: string, args: readonly unknown[]) => Promise<CallOutcome>;
  readonly macName: () => string;
  readonly version: string;
  readonly thumbsDir: string;
  /** Where photos and files from the phone land (~/.beluga/attachments/phone). */
  readonly uploadsDir?: string;
  /** Where the models that write down the phone's speech go (~/.beluga/voice), or the voice itself (tests). */
  readonly voice?: MacVoice;
  readonly thumbnail?: Thumbnailer;
  /** A kept table's documents, streamed by ref (Sentinel's documentBytes, BLG-386). */
  readonly documents?: DocumentBytes;
  /** Outputs on disk per conversation (sub-agents', the scratch folder's), newest first. */
  readonly outputs?: (channel: string) => readonly ConvOutput[];
  /** MCP Apps: a Claude card's step lines whose tool has an app (views.ts ViewContext.appSteps). */
  readonly appSteps?: (channel: string, itemId: string) => ReadonlySet<string>;
  /** A phone looks at these conversations: keep their outputs fresh. */
  readonly watching?: (channels: readonly string[], linked: boolean) => void;
  readonly pusher?: Pusher;
  /** How long since the Mac was last used (ms), when known. */
  readonly idleMs?: () => Promise<number | undefined>;
  /** Tests: a local testnet instead of the public DHT. */
  readonly dht?: { readonly bootstrap?: readonly BootstrapNode[]; readonly host?: string; /** Tests: turn away every direct connection (as a network with client isolation does). */ readonly refuseDirect?: boolean };
  /** The relay's tunnel (reach.ts): 'cloudflared' (the daemon's), a function (tests), or 'off' (the default). */
  readonly relay?: RelayTunnel;
  /** Keeps the Mac awake while a phone is paired and Settings says so (awake.ts); tests pass their own. */
  readonly awake?: Awake;
  readonly coalesceMs?: number;
  readonly pairTtlMs?: number;
  readonly log?: (line: string) => void;
  /** Tests: deterministic refs. */
  readonly refs?: RefTable;
  /** Projects' small icons for the phone (default: made with sips next to the thumbnails). */
  readonly icons?: ProjectIcons;
  /** The daemon's terminal programs: a worktree's terminals, shared with the phone (BLG-42). */
  readonly terminals?: TerminalManager;
  /** Tests: how long terminal output is coalesced. */
  readonly termCoalesceMs?: number;
  /** Running adb and reading the device, for driving the phone (BLG-150); tests pass a fake. */
  readonly system?: SystemPort;
  /** Tests: adb's path straight away, and a fake home for finding it. */
  readonly adbPath?: string;
  readonly home?: string;
  /** Where saved phone flows live (BLG-175); default ~/.beluga/phone-macros.json via launch. */
  readonly macrosFile?: string;
  /** Your other devices (BLG-774, src/machines): apps and computers of your set come in here too. */
  readonly machines?: MachinesPort;
  /**
   * This install runs your friends network (BLG-850): no Always On, or it's this one. A Mac that
   * only shows your Always On's network doesn't also tell a phone that links there what comes in.
   */
  readonly tellsFriends?: () => boolean;
}

/** What the host asks of your device set (src/machines/machines.ts). */
export interface MachinesPort {
  /** An app or computer of yours with this link key (hex), never a phone. */
  admit(linkHex: string): DeviceCert | undefined;
  /** Keep the node running (a computer pairing, a join, devices to keep in step). */
  wanted(): boolean;
  /** A computer pairing's temporary keys (they get a relay record too). */
  keyPairs(): readonly KeyPair[];
  accept(stream: NoiseSocket, cert: DeviceCert, overRelay: boolean): void;
  /** A phone of your set with this link key, paired on another device of yours (BLG-809): it comes in as a phone. */
  phone?(linkHex: string): DeviceCert | undefined;
  /** The phones of your set (the relay record names them too). */
  phones?(): readonly DeviceCert[];
  /** Your computers as phones dial them (the `computers` frame), and when they change. */
  forPhones?(runtime?: string): PhoneComputer[];
  onComputers?(listener: () => void): () => void;
  /** Where to push to a phone of your set paired elsewhere (BLG-850). */
  keepPush?(id: string, push: NonNullable<DeviceRecord['push']>): void;
  pushOf?(id: string): DeviceRecord['push'];
}

const companionSeed = (identity: Identity): Buffer => {
  const d = identity.privateKey.export({ format: 'jwk' }).d;
  if (!d) throw new Error('Identity key has no private part');
  return Buffer.from(hkdfSync('sha256', Buffer.from(d, 'base64url'), Buffer.from('beluga-companion'), Buffer.from('companion-v1'), 32));
};

const pinnedSeed = (file: string | undefined): Buffer | undefined => {
  const raw = file ? readJson(file) : undefined;
  const hex = raw && typeof raw === 'object' && 'seed' in raw && typeof raw.seed === 'string' && /^[0-9a-f]{64}$/.test(raw.seed) ? raw.seed : undefined;
  return hex ? Buffer.from(hex, 'hex') : undefined;
};

/**
 * The companion address's key pair: HKDF of your identity's seed, 'companion-v1', or the seed pinned
 * in `seedFile` once your identity moved (BLG-796): the address belongs to the install, so phones and
 * computers reach it as before, and your Always On keeps its own.
 */
export async function companionKeyPair(identity: Identity, seedFile?: string): Promise<KeyPair> {
  const DHTClass = (await import('hyperdht')).default;
  return DHTClass.keyPair(pinnedSeed(seedFile) ?? companionSeed(identity));
}

/** Pin this install's companion address as `identity` makes it now (once: an address already pinned stays). */
export function pinCompanionSeed(file: string, identity: Identity): void {
  if (pinnedSeed(file)) return;
  writeJson(file, { seed: companionSeed(identity).toString('hex') });
}

interface TopicState {
  rev: number;
  hash?: string;
  sentAt: number;
  timer?: NodeJS.Timeout;
}

/** One linked phone. */
class PhoneLink implements PhoneLinkHandle {
  readonly clientId: string;
  hello?: Extract<PhoneFrame, { t: 'hello' }>;
  topics = new Map<Topic, TopicState>();
  inFront = true;
  heard = Date.now();
  /** It came through the relay (an older app doesn't say how it came). */
  overRelay = false;
  /** The terminals on its screen (BLG-42). */
  readonly terms: TermRelay;
  /** What this phone last said it lets the Mac do (BLG-150, the `control` frame). */
  control?: PhoneControlState;
  /** The Wireless-debugging pairing code it last sent, for `adb pair`. */
  adbCode?: { code: string; at: number };
  /** The computers list it was last told (computersKey), so it hears it again only when it changes. */
  computersSent?: string;
  private reqId = 0;
  private readonly reqs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private tunId = 0;
  private readonly tuns = new Map<number, TunnelSide>();
  /** 1.18: who takes the screen's video now (the Mac's mirror); without one, pieces go unanswered and the phone stops. */
  private videoTaker?: { readonly piece: (p: VideoPiece) => void; readonly end: (reason?: string) => void };
  private readonly beat: NodeJS.Timeout;
  private readonly helloTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly device: DeviceRecord,
    readonly socket: MessageSocket,
    private readonly host: CompanionHost,
  ) {
    this.clientId = `phone:${deviceId(device.cert)}`;
    this.terms = host.termRelay(this);
    socket.on('message', (text) => {
      this.heard = Date.now();
      try {
        this.onFrame(text);
      } catch (err) {
        host.logLine(`phone frame failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    socket.on('ping', () => (this.heard = Date.now()));
    socket.on('pong', () => (this.heard = Date.now()));
    socket.on('error', () => undefined);
    socket.on('close', () => this.finish());
    this.helloTimer = setTimeout(() => this.close(COMPANION_CLOSE.hello, 'no hello'), HELLO_TIMEOUT_MS);
    this.helloTimer.unref();
    // The phone pings every KEEPALIVE_MS (KEEPALIVE_AWAY_MS while away, BLG-128); three missed and
    // it's gone (a phone that slept without a bye).
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > (this.inFront ? KEEPALIVE_MS : KEEPALIVE_AWAY_MS) * 3) socket.terminate();
    }, KEEPALIVE_MS);
    this.beat.unref();
  }

  get deviceId(): string {
    return deviceId(this.device.cert);
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.isOpen;
  }

  send(frame: MacFrame): void {
    if (this.isOpen) this.socket.send(JSON.stringify(frame));
  }

  close(code: number, reason: string): void {
    this.send({ t: 'bye', reason });
    this.socket.close(code, reason);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearInterval(this.beat);
    for (const t of this.topics.values()) clearTimeout(t.timer);
    for (const r of this.reqs.values()) {
      clearTimeout(r.timer);
      r.reject(new Error('The phone link closed'));
    }
    this.reqs.clear();
    for (const t of this.tuns.values()) t.onClose('link closed');
    this.tuns.clear();
    this.terms.closeAll();
    this.host.unlinked(this);
  }

  /** Does this phone speak the control protocol (1.16+)? Older apps never get a `req` or `tun_open`. */
  get supportsControl(): boolean {
    const v = this.hello?.v;
    return Boolean(v && (v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE.control)));
  }

  // ---- PhoneControl's handle on this phone (src/companion/phone-control.ts)

  /** Does this phone stream its screen as video (1.18, and its app says it can)? */
  get video(): boolean {
    const v = this.hello?.v;
    const speaks = Boolean(v && (v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE.video)));
    return speaks && this.control?.video === true;
  }

  /** Can this phone prove it's the one at a Wireless-debugging address (1.19)? */
  get proofs(): boolean {
    const v = this.hello?.v;
    return Boolean(v && (v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE.proof)));
  }

  /** Take the screen's video until the returned stop(); the last taker wins. */
  watchVideo(onPiece: (p: VideoPiece) => void, onEnd: (reason?: string) => void): () => void {
    const taker = { piece: onPiece, end: onEnd };
    this.videoTaker = taker;
    return () => {
      if (this.videoTaker === taker) this.videoTaker = undefined;
    };
  }

  /** Ask the phone to do something through its Accessibility service (`req` → `reply`). */
  request(op: PhoneOp, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    if (!this.supportsControl) return Promise.reject(new Error('Update the Beluga app on your phone to use it from the Mac'));
    if (!this.control?.allowed) return Promise.reject(new Error('This phone hasn’t allowed its Mac to use it'));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.reqs.delete(id)) reject(new Error('The phone didn’t answer in time'));
      }, timeoutMs);
      timer.unref();
      this.reqs.set(id, { resolve, reject, timer });
      this.send({ t: 'req', id, op, args });
    });
  }

  /** A byte tunnel to the phone's debugging port (or pairing port); the worklet dials its own adbd. */
  openTunnel(to: 'adb' | 'adb-pair', side: TunnelSide): TunnelEnd {
    const id = ++this.tunId;
    this.tuns.set(id, side);
    this.send({ t: 'tun_open', id, to });
    return {
      send: (bytes) => {
        for (let off = 0; off < bytes.length; off += TUN_PIECE) this.send({ t: 'tun_data', id, b64: bytes.subarray(off, off + TUN_PIECE).toString('base64') });
      },
      ack: (n) => this.send({ t: 'tun_ack', id, n: Math.min(n, 512 * 1024) }),
      close: (error) => {
        if (this.tuns.delete(id)) this.send({ t: 'tun_close', id, ...(error ? { error: error.slice(0, 300) } : {}) });
      },
    };
  }

  private onFrame(text: string): void {
    const frame = parsePhoneFrame(text);
    if (!frame) return;
    if (!this.hello) {
      if (frame.t !== 'hello') return;
      clearTimeout(this.helloTimer);
      // Too new for this Mac, or older than it still answers: say so rather than misbehave.
      if (frame.v.major > COMPANION_PROTO.major) return this.close(COMPANION_CLOSE.version, 'Update Beluga on your Mac');
      if (frame.v.major < COMPANION_MIN.major) return this.close(COMPANION_CLOSE.version, 'Update the Beluga app');
      this.hello = frame;
      const state = this.host.state();
      const relay = this.host.relayUrl();
      this.send({ t: 'welcome', v: { ...COMPANION_PROTO }, min: { ...COMPANION_MIN }, mac: this.host.macInfo(), me: { name: (state.self?.name ?? state.network.self?.name ?? 'me').slice(0, 64), peerId: state.selfId || 'me' }, ...(relay ? { relay } : {}) });
      this.host.helloed(this, frame.app, frame.via);
      this.subscribe(frame.topics);
      this.host.tellComputers(this);
      return;
    }
    switch (frame.t) {
      case 'hello':
        return;
      case 'sub':
        return this.subscribe(frame.topics);
      case 'call':
        return void this.host.phoneCall(this, frame.method, frame.args).then((r) => this.send({ t: 'result', id: frame.id, ...r, ...(r.ok ? {} : { error: r.error.slice(0, 2000) }) }));
      case 'get':
        return void this.host.files
          .piece(frame.ref, frame.variant, frame.off)
          .then((p) => this.send({ t: 'chunk', id: frame.id, ...p }))
          .catch((err: unknown) => this.send({ t: 'result', id: frame.id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }));
      case 'put':
        return void this.host.uploads
          .piece(this.deviceId, frame)
          .then((value) => this.send({ t: 'result', id: frame.id, ok: true, value }))
          .catch((err: unknown) => this.send({ t: 'result', id: frame.id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }));
      case 'push':
        return this.host.setPush(this, { platform: frame.platform, token: frame.token, relayKey: frame.relayKey });
      case 'focus':
        this.inFront = frame.on;
        // Nothing streams to a phone in the background: its terminal screen attaches again when it's back.
        if (!frame.on) this.terms.closeAll();
        return;
      case 'term_attach':
        return this.terms.attach(frame.term);
      case 'term_detach':
        return this.terms.detach(frame.term);
      case 'term_input':
        return this.terms.input(frame.term, frame.data);
      case 'control':
        this.control = frame.state;
        return this.host.onControl(this);
      case 'adb_code':
        this.adbCode = { code: frame.code, at: Date.now() };
        return this.host.onControl(this);
      case 'reply': {
        const r = this.reqs.get(frame.id);
        if (!r) return;
        this.reqs.delete(frame.id);
        clearTimeout(r.timer);
        if (frame.ok) r.resolve(frame.value);
        else r.reject(new Error(frame.error ? phoneErrorText(frame.error) : 'The phone couldn’t do that'));
        return;
      }
      case 'vid': {
        const taker = this.videoTaker;
        if (!taker) return;
        // Answer each piece: the phone paces itself by these (and stops when they stop coming).
        this.send({ t: 'vid_ack', seq: frame.seq });
        taker.piece({ seq: frame.seq, b64: frame.b64, key: frame.key === true, ts: frame.ts, w: frame.w, h: frame.h, sw: frame.sw, sh: frame.sh });
        return;
      }
      case 'vid_end':
        return this.videoTaker?.end(frame.reason);
      case 'tun_ok':
        return this.tuns.get(frame.id)?.onOpen();
      case 'tun_data': {
        const side = this.tuns.get(frame.id);
        if (!side) return;
        const bytes = Buffer.from(frame.b64, 'base64');
        side.onData(bytes);
        // Tell the phone it may send that much more (the socket's own backpressure gates our reads).
        this.send({ t: 'tun_ack', id: frame.id, n: Math.min(bytes.length || 1, 512 * 1024) });
        return;
      }
      case 'tun_ack':
        return this.tuns.get(frame.id)?.onAck(frame.n);
      case 'tun_close': {
        const side = this.tuns.get(frame.id);
        if (!side) return;
        this.tuns.delete(frame.id);
        side.onClose(frame.error);
        return;
      }
      case 'bye':
        this.socket.close(1000, 'bye');
        return;
    }
  }

  /** The topics on the phone's screen now: new ones are sent at once, gone ones forgotten. */
  subscribe(topics: readonly Topic[]): void {
    const wanted = new Set(topics.slice(0, MAX_TOPICS));
    for (const [t, st] of this.topics) {
      if (wanted.has(t)) continue;
      clearTimeout(st.timer);
      this.topics.delete(t);
    }
    for (const t of wanted) if (!this.topics.has(t)) this.topics.set(t, { rev: 0, sentAt: 0 });
    this.host.watched();
    for (const t of wanted) this.schedule(t);
  }

  /** Send a topic's view soon: at once if it's been quiet, else when its coalescing window ends. */
  schedule(topic: Topic): void {
    const st = this.topics.get(topic);
    if (!st || st.timer || !this.hello) return;
    const wait = Math.max(0, st.sentAt + this.host.coalesceMs - Date.now());
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (this.topics.get(topic) === st) this.sendView(topic, st);
    }, wait);
    st.timer.unref();
  }

  private sendView(topic: Topic, st: TopicState): void {
    const data = this.host.render(topic);
    if (data === undefined) return;
    const json = JSON.stringify(data);
    const hash = createHash('sha256').update(json).digest('base64');
    st.sentAt = Date.now();
    if (hash === st.hash) return;
    st.hash = hash;
    st.rev += 1;
    this.send({ t: 'view', topic, rev: st.rev, data });
  }
}

export class CompanionHost {
  readonly files: FileServer;
  readonly uploads: Uploads;
  readonly voice: MacVoice;
  readonly coalesceMs: number;
  readonly icons: ProjectIcons;
  private readonly refs: RefTable;
  private readonly pairing: DevicePairing;
  private readonly links = new Set<PhoneLink>();
  private node?: DHT;
  private server?: Server;
  private starting?: Promise<DHT>;
  /** The starting node, once it's up (before its server listens). */
  private nodeUp?: Promise<DHT>;
  private keyPair?: KeyPair;
  private offs: Array<() => void> = [];
  private stopped = false;
  private ctx: ViewContext;
  /** What needs you (by id) and which runs the phone started, to tell it when something new happens. */
  private seenNeeds?: Set<string>;
  private phoneRuns = new Map<string, boolean>();
  private changeTimer?: NodeJS.Timeout;
  readonly reach: Reach;
  /** Driving the phone from the Mac (BLG-150): routes, adb, and the agent's tools. */
  readonly control: PhoneControl;
  private readonly awake: Awake;
  /** The state at the last notice: what finished since is told to phones away from the app (BLG-128). */
  private lastState?: DomainState;
  /** Messages sent before this aren't news (a history that arrives at once). */
  private readonly noticeSince = Date.now();

  constructor(private readonly opts: CompanionHostOptions) {
    this.awake = opts.awake ?? new Awake(opts.log ? { log: opts.log } : {});
    this.reach = new Reach({
      tunnel: opts.relay ?? 'off',
      ...(opts.log ? { log: opts.log } : {}),
      // The relay's URL goes in the pairing link (its QR redraws) and in each welcome.
      onChange: () => this.publish(),
      // The companion key's record names the phones still paired (a removed one learns it's removed).
      // A computer names the phones of your set too: they reach it by themselves (BLG-809).
      phones: (key) => (this.keyPair && key.equals(this.keyPair.publicKey) ? namedPhones(opts.devices.all().map((r) => r.cert), opts.machines?.phones?.() ?? []) : undefined),
    });
    this.coalesceMs = opts.coalesceMs ?? VIEW_COALESCE_MS;
    this.refs = opts.refs ?? new RefTable();
    this.uploads = new Uploads(opts.uploadsDir ?? path.join(attachmentsDir(), 'phone'));
    this.voice = opts.voice ?? sharedVoice();
    this.files = new FileServer({ refs: this.refs, thumbsDir: opts.thumbsDir, ...(opts.thumbnail ? { thumbnail: opts.thumbnail } : {}), ...(opts.documents ? { documents: opts.documents } : {}) });
    this.icons = opts.icons ?? new ProjectIcons({ dir: path.join(path.dirname(opts.thumbsDir), 'icons'), root: (id) => this.state().projects.find((p) => p.id === id)?.root, changed: () => this.refreshViews() });
    this.ctx = { refs: this.refs, mac: { name: opts.macName(), version: opts.version }, ...(opts.outputs ? { outputs: opts.outputs } : {}), ...(opts.appSteps ? { appSteps: opts.appSteps } : {}), icons: (id) => this.icons.sumFor(id), merges: (id) => this.mergeState.get(id) };
    this.control = new PhoneControl({
      sys: opts.system ?? realSystem,
      devices: opts.devices,
      link: (id) => this.linkFor(id),
      onChange: () => this.publish(),
      ...(opts.macrosFile ? { macros: new PhoneMacros(opts.macrosFile) } : {}),
      ...(opts.adbPath ? { adbPath: opts.adbPath } : {}),
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    this.pairing = new DevicePairing({
      // A pairing listens as soon as the node is up: not after the companion's own server or the relay.
      node: () => this.readyNode(),
      identity: opts.identity,
      devices: opts.devices,
      address: () => this.address(),
      macName: () => opts.macName(),
      onChange: () => {
        this.publish();
        void this.sync();
      },
      ...(opts.pairTtlMs ? { ttlMs: opts.pairTtlMs } : {}),
      relay: this.reach.server,
      relayUrl: () => this.reach.relayUrl(),
      ...(opts.dht?.refuseDirect ? { refuseDirect: true } : {}),
      log: (line) => this.opts.log?.(line),
    });
  }

  /** The relay's URL now, if its tunnel is up. */
  relayUrl(): string | undefined {
    return this.reach.relayUrl();
  }

  /** Start following the state and the paired phones (a DHT node only runs when there's a phone or a pairing). */
  async start(): Promise<void> {
    this.keyPair = await companionKeyPair(this.opts.identity, this.opts.seedFile);
    this.offs.push(
      this.opts.store.subscribe(() => {
        this.keepAwake();
        this.changed();
      }),
      this.opts.devices.onChange(() => {
        this.publish();
        this.keepAwake();
        void this.sync();
      }),
      // A computer joined, went, moved or was renamed: linked phones hear where your computers are now.
      this.opts.machines?.onComputers?.(() => {
        for (const link of this.links) this.tellComputers(link);
      }) ?? (() => undefined),
    );
    this.publish();
    this.keepAwake();
    // What waits for you now is the baseline: phones hear about what comes after.
    await this.notice();
    await this.sync();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    void this.voice.close();
    clearTimeout(this.changeTimer);
    clearInterval(this.heldTimer);
    this.awake.release();
    this.control.stop();
    await this.pairing.cancel('Beluga on your Mac is shutting down');
    for (const link of [...this.links]) link.close(COMPANION_CLOSE.quiet, 'Beluga on your Mac is shutting down');
    await this.shutdownNode();
  }

  /** Hold the Mac awake (or let it sleep) as Settings › Phone says, while a phone is paired. */
  private keepAwake(): void {
    if (this.stopped) return;
    this.awake.set(this.state().prefs.keepAwake ?? 'off', this.opts.devices.size > 0);
  }

  /** The companion address (hex): where paired phones dial. */
  address(): string {
    if (!this.keyPair) throw new Error('The companion host has not started');
    return this.keyPair.publicKey.toString('hex');
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  state(): DomainState {
    return this.opts.store.getState();
  }

  macInfo(): { name: string; version: string } {
    return { name: this.opts.macName().slice(0, 100), version: this.opts.version.slice(0, 40) };
  }

  logLine(line: string): void {
    this.opts.log?.(`companion: ${line}`);
  }

  // ---- the API (companion-handlers.ts)

  pairStart(): Promise<PairingInfo> {
    const why = this.opts.cannotPair?.();
    return why ? Promise.reject(new Error(why)) : this.pairing.start();
  }

  /** Pair the phone on the USB cable (BLG-190): a pairing opens here and on the phone, the four pictures as ever. */
  async pairOverCable(): Promise<string> {
    const info = await this.pairStart();
    await this.control.openPairingOnCable(info.link);
    return 'The phone opened the pairing: check its four pictures match the ones here, then Pair.';
  }
  /** Open Developer options (or About phone) on a linked phone, for turning on USB debugging. */
  showPhoneSettings(deviceId: string, which: 'developer' | 'about'): Promise<void> {
    return this.control.showSettings(deviceId, which);
  }
  /** Look for a phone on this Mac's USB (the daemon's). */
  watchCable(): void {
    this.control.watchCable();
  }

  pairApprove(): { id: string } {
    return { id: this.pairing.approve() };
  }

  async pairCancel(): Promise<void> {
    await this.pairing.cancel();
  }

  /** Remove a phone: its certificate goes, its link drops now, and its key is refused from then on. */
  removeDevice(id: string, reason = 'This phone was removed on your Mac'): boolean {
    const gone = this.opts.devices.remove(id);
    for (const link of [...this.links]) if (link.deviceId === id) link.close(COMPANION_CLOSE.removed, reason);
    this.control.forget(id);
    return Boolean(gone);
  }

  /** Turns of a conversation (or messages of a chat) before one the phone has. */
  older(topic: string, before: string, limit?: number): unknown {
    const state = this.state();
    if (topic.startsWith('conv:')) return convTurns(state, this.ctx, topic.slice(5), { before, ...(limit ? { limit } : { limit: VIEW_TURNS }) });
    if (topic.startsWith('chat:')) return chatMessages(state, this.ctx, topic.slice(5), { before, ...(limit ? { limit } : {}) });
    throw new Error('Nothing older there');
  }

  /** Merges started from the phone, per worktree (merge.ts): their conversations' views show where each stands. */
  readonly merges: MergeBook = {
    get: (id) => this.mergeState.get(id),
    set: (id, m) => {
      if (m) this.mergeState.set(id, m);
      else this.mergeState.delete(id);
      this.refreshViews();
    },
  };
  private readonly mergeState = new Map<string, MergeView>();

  /** A project's small icon by the checksum a view handed out (companion.icon). */
  icon(sum: string): SmallIcon {
    const icon = this.icons.get(sum);
    if (!icon) throw new Error('That icon is no longer offered');
    return icon;
  }

  // ---- asking from the phone (companion-api.ts)

  /** The phone a call comes from (`phone:<device id>`), if it's one that's paired. */
  private deviceOf(caller: string): string | undefined {
    const id = caller.startsWith('phone:') ? caller.slice(6) : undefined;
    return id && this.phoneRecord(id) ? id : undefined;
  }

  private async must(caller: string, method: string, args: readonly unknown[]): Promise<unknown> {
    const out = await this.opts.call(caller, method, args);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  /**
   * The files a phone attached: pictures as chips (as pasted images are), numbered from 1 in this
   * message (`images`: theirs for the whole session, in that order), other files named by their path here.
   */
  private async attach(caller: string, refs: readonly string[] | undefined): Promise<{ chips: string[]; images: number[]; paths: string[] }> {
    if (!refs?.length) return { chips: [], images: [], paths: [] };
    const device = this.deviceOf(caller);
    if (!device) throw new Error('Only the phone that sent a file can attach it');
    const ups = await this.uploads.resolve(device, refs);
    const chips: string[] = [];
    const images: number[] = [];
    const paths: string[] = [];
    for (const up of ups) {
      if (up.image) {
        // Where pasted images go, made smaller when they're too big for Claude (a phone photo often is).
        const file = await importImageFitting(up.path);
        const { size } = await stat(file);
        images.push(registerAttachment(file, size).n);
        chips.push(chipText(images.length));
      } else paths.push(up.path);
    }
    return { chips, images, paths };
  }

  /**
   * Ask your Mac: a new chat in a project (as New Chat there), a new worktree there with its photos
   * (1.12), or a message in a conversation you can write in → its topic.
   */
  async ask(caller: string, a: { target: { project: string; worktree?: true | undefined; plan?: boolean | undefined; agent?: AgentRef | undefined } | { topic: string }; text: string; files?: readonly string[] | undefined }): Promise<{ topic: string }> {
    if ('project' in a.target && a.target.worktree) return this.startWorktree(caller, a.target.project, a.text, a.files, a.target.plan, a.target.agent);
    let channel: string;
    if ('project' in a.target) {
      const title = a.text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'From my phone';
      const id = await this.must(caller, 'workspaces.newChat', [a.target.project, title]);
      if (typeof id !== 'string') throw new Error('Couldn’t start a chat in that project');
      channel = `ws:${id}`;
    } else {
      // An older phone's Your Mac (`conv:mac:assistant`) is the chat open on the Mac once the first is deleted.
      channel = phoneChannel(this.state(), a.target.topic.slice('conv:'.length));
      const conv = viewOf(this.state(), this.ctx, a.target.topic as Topic) as { canSend?: boolean } | undefined;
      if (!conv?.canSend) throw new Error('You can’t write in that conversation');
    }
    const text = await this.withFiles(caller, a.text, a.files, channel);
    await this.must(caller, 'session.submit', [text, { channel }]);
    this.phoneRuns.set(channel, false);
    const topic = convTopic(channel);
    if (!topic) throw new Error('That conversation can’t be shown on the phone');
    return { topic };
  }

  /** A new worktree with Claude on your words and the photos with them, as the Mac's project home starts one; `agent` (BLG-506): who works it. */
  private async startWorktree(caller: string, project: string, words: string, files: readonly string[] | undefined, plan: boolean | undefined, agent?: AgentRef): Promise<{ topic: string }> {
    // Its channel doesn't exist yet; any but the room's links the photos the same way.
    const text = await this.withFiles(caller, words, files, 'ws:new');
    const id = await this.must(caller, 'workspaces.startWorktree', [project, text, { quiet: true, ...(plan ? { plan: true } : {}), ...(agent ? { agent } : {}) }]);
    if (typeof id !== 'string') throw new Error('Your Mac couldn’t make the worktree');
    const channel = `ws:${id}`;
    this.phoneRuns.set(channel, false);
    return { topic: convTopic(channel) ?? `conv:${channel}` };
  }

  /** Your words with the phone's files: pictures linked as pasted images are, other files by their path here. */
  private async withFiles(caller: string, words: string, files: readonly string[] | undefined, channel: string): Promise<string> {
    const { chips, images, paths } = await this.attach(caller, files);
    const text = [words.trim(), chips.join(' '), paths.length ? `Files from my phone:\n${paths.map((p) => `- ${p}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    return chips.length ? String(await this.must(caller, 'attachments.expand', [text, channel, images, images.map((_, i) => i + 1)])) : text;
  }

  /** What you said on the phone, written down here (BLG-140): only the phone that sent the audio, which then goes. */
  async transcribe(caller: string, a: { audio: string; model: VoiceModelId; language: string; prompt?: string | undefined }): Promise<{ text: string; language?: string; ms: number }> {
    const device = this.deviceOf(caller);
    if (!device) throw new Error('Only the phone that sent the recording can have it written down');
    const [up] = await this.uploads.resolve(device, [a.audio]);
    if (!up || !/^audio\/(wav|x-wav|wave)$/.test(up.mime)) throw new Error('That isn’t a recording');
    return this.voice.transcribe(up.path, { model: a.model, language: a.language, prompt: a.prompt });
  }

  /** Write in a friends' chat, with files from the phone (taken in as chat files are on the Mac). */
  async post(caller: string, a: { conversation: string; text: string; files?: readonly string[] | undefined; ask?: 'all' | readonly string[] | undefined }): Promise<unknown> {
    const { all } = a.files?.length ? await this.attachFiles(caller, a.files) : { all: [] as string[] };
    const files = all.length ? await this.must(caller, 'network.files.add', [all]) : undefined;
    return this.must(caller, 'network.post', [a.conversation, { text: a.text, ...(files ? { files } : {}), ...(a.ask ? { ask: a.ask } : {}) }]);
  }

  private async attachFiles(caller: string, refs: readonly string[]): Promise<{ all: string[] }> {
    const device = this.deviceOf(caller);
    if (!device) throw new Error('Only the phone that sent a file can attach it');
    return { all: (await this.uploads.resolve(device, refs)).map((u) => u.path) };
  }

  /** Ask a friend's Claude yourself, as from their card on the Mac (their approval and trust rules apply) → its conversation. */
  async askPerson(caller: string, a: { peerId: string; text: string; needs?: readonly string[] | undefined; project?: string | undefined }): Promise<{ topic: string; task: string }> {
    const task = (await this.must(caller, 'gateway.ask', [a.peerId, a.text, { ...(a.needs?.length ? { needs: a.needs } : {}), ...(a.project ? { project: a.project } : {}) }])) as { id?: unknown };
    if (typeof task?.id !== 'string') throw new Error('That didn’t reach them');
    return { topic: `conv:task:${task.id}`, task: task.id };
  }

  /** The calling phone signs out: its certificate goes (never another phone's), then its link closes. */
  signOut(caller: string): { signedOut: true } {
    const id = this.deviceOf(caller);
    if (!id) throw new Error('Only a phone can sign itself out; remove phones on the Mac');
    // After the answer has gone out.
    const t = setTimeout(() => {
      this.removeDevice(id, 'Signed out');
      void this.uploads.drop(id);
    }, 200);
    t.unref();
    return { signedOut: true };
  }

  // ---- a worktree's files, read-only, and its terminals, shared with the Mac (BLG-42)

  /** A folder of a worktree (its conversation's topic), through the file gate (worktree-files.ts). */
  filesList(topic: string, rel: string): Promise<unknown> {
    return listFolder(workspaceOf(this.state(), topic).path, rel, this.refs);
  }

  filesFind(topic: string, query: string): Promise<unknown> {
    return findByName(workspaceOf(this.state(), topic).path, query);
  }

  filesRead(topic: string, rel: string, off = 0): Promise<unknown> {
    return readPage(workspaceOf(this.state(), topic).path, rel, off);
  }

  /** A worktree's terminals: its shell, setup and run, and shells started in its folder. */
  terminalsOf(topic: string): TerminalsView {
    const state = this.state();
    const ws = workspaceOf(state, topic);
    return { terminals: keysOf(state, this.opts.terminals, ws).slice(0, 40).map((k) => terminalView(state, this.opts.terminals, k)) };
  }

  /**
   * Open a worktree's terminal from the phone: one of its own (`key`), its shell (started as the
   * Mac's dock starts it, at the Mac's size), or a new shell in its folder (`fresh`). The phone
   * then attaches with `term_attach`. Started through the same API calls as the Mac's.
   */
  async termOpen(caller: string, topic: string, opts: { key?: string | undefined; fresh?: boolean | undefined } = {}): Promise<TerminalView> {
    const state = this.state();
    const ws = workspaceOf(state, topic);
    const who = this.deviceName(caller);
    if (opts.key) {
      if (!keysOf(state, this.opts.terminals, ws).includes(opts.key)) throw new Error('That terminal isn’t one of this worktree’s');
      const pty = this.opts.terminals?.get(opts.key);
      // An ended shell starts again, as clicking it on the Mac does.
      if (!pty?.running) await this.must(caller, 'terminals.restart', [opts.key]);
      return terminalView(this.state(), this.opts.terminals, opts.key);
    }
    let key: string;
    if (opts.fresh) {
      key = nextShellKey(state);
      await this.must(caller, 'terminals.global', [key, ws.path]);
    } else {
      const got = await this.must(caller, 'terminals.shell', [ws.id]);
      if (typeof got !== 'string') throw new Error('Couldn’t start a shell there');
      key = got;
    }
    this.logLine(`${who} started the terminal ${key} in ${ws.id}`);
    return terminalView(this.state(), this.opts.terminals, key);
  }

  /** End a worktree's terminal session, for every screen (the phone asks first). */
  async termClose(caller: string, key: string): Promise<{ closed: boolean }> {
    if (!isWorkspaceTerminal(this.state(), this.opts.terminals, key)) throw new Error('That terminal isn’t one of your worktrees’');
    this.logLine(`${this.deviceName(caller)} closed the terminal ${key}`);
    await this.must(caller, 'terminals.close', [key]);
    return { closed: true };
  }

  private deviceName(caller: string): string {
    const id = this.deviceOf(caller);
    const name = id ? this.phoneRecord(id)?.cert.name : undefined;
    return name ? `the phone “${name}”` : 'a phone';
  }

  /** A linked phone's terminals (its attachments, coalesced output and keys). */
  termRelay(link: PhoneLink): TermRelay {
    return new TermRelay({
      terminals: () => this.opts.terminals,
      allowed: (key) => isWorkspaceTerminal(this.state(), this.opts.terminals, key),
      send: (frame) => link.send(frame),
      log: (line) => this.logLine(line),
      who: `the phone “${link.device.cert.name}”`,
      ...(this.opts.termCoalesceMs !== undefined ? { coalesceMs: this.opts.termCoalesceMs } : {}),
    });
  }

  // ---- links

  /** A call from a phone: only what the allowlist says it may, then exactly as a screen's call. */
  async phoneCall(link: PhoneLink, method: string, args: readonly unknown[]): Promise<CallOutcome> {
    if (!phoneMay(method)) return { ok: false, error: `${method} is only on your Mac` };
    // A conversation asked from the phone: tell it when its answer is done.
    if (method === 'session.submit') {
      const channel = (args[1] as { channel?: unknown } | null | undefined)?.channel;
      this.phoneRuns.set(typeof channel === 'string' ? channel : 'room', false);
    }
    const out = await this.opts.call(link.clientId, method, args);
    // What a sentinel keeps (BLG-392): each run's file and each metric's history (as CSV) as a ref the phone streams.
    if (method === 'sentinel.dataList' && out.ok) return { ok: true, value: this.withDataRefs(String(args[0]), out.value as SentinelData) };
    if ((method === 'workspaces.startChat' || method === 'workspaces.startWorktree') && out.ok && typeof out.value === 'string') this.phoneRuns.set(`ws:${out.value}`, false);
    // A plan asked from the phone: its head Claude's draft is done (to approve) when its first run ends.
    const home = method === 'plans.create' && out.ok ? (out.value as { home?: unknown } | null)?.home : undefined;
    if (typeof home === 'string') this.phoneRuns.set(home, false);
    return out;
  }

  private withDataRefs(sentinelId: string, data: SentinelData): DataListView {
    return {
      metrics: data.metrics.map((m) => ({ ...m, ref: this.refs.docRef({ history: m.name, sentinelId }) })),
      runs: data.runs.map((r) => ({ ...r, files: r.files.map((f) => ({ ...f, ref: this.refs.docRef({ run: r.runId, name: f.name }), mime: runFileMime(f.name) })) })),
      keepsDays: data.keepsDays,
    };
  }

  render(topic: Topic): unknown {
    const state = this.state();
    let data = viewOf(state, this.ctx, topic);
    // A view must fit in a frame: a long conversation sends fewer turns (the rest: companion.older).
    let size = data === undefined ? 0 : Buffer.byteLength(JSON.stringify(data));
    while (size > MAX_COMPANION_FRAME - 4096 && data && typeof data === 'object' && 'turns' in data) {
      const conv = data as { turns: unknown[]; more: boolean };
      if (conv.turns.length <= 1) return undefined;
      data = { ...conv, turns: conv.turns.slice(Math.ceil(conv.turns.length / 2)), more: true };
      size = Buffer.byteLength(JSON.stringify(data));
    }
    if (size > MAX_COMPANION_FRAME - 4096) {
      this.logLine(`the ${topic} view is too big for the link`);
      return undefined;
    }
    return data;
  }

  /** Tell a phone where your computers are (BLG-809), when it can hear it and the list changed since. */
  tellComputers(link: PhoneLink): void {
    const list = this.opts.machines?.forPhones?.(this.state().prefs.defaultAgent?.runtime ?? 'claude');
    const v = link.hello?.v;
    if (!list || !v || !link.isOpen || (v.major === COMPANION_PROTO.major && v.minor < SINCE.computers)) return;
    const key = computersKey(list);
    if (key === link.computersSent) return;
    link.computersSent = key;
    link.send({ t: 'computers', list });
  }

  helloed(link: PhoneLink, app: string, via?: { path: LinkPath; tried: readonly DialAttempt[] }): void {
    // How it came, in words for Settings › Phone (kept with the device until its next link).
    const path = via?.path ?? (link.overRelay ? 'relay' : undefined);
    const note = path ? pathNote(path, via?.tried ?? []) : undefined;
    this.opts.devices.update(link.deviceId, { lastSeen: Date.now(), app: app.slice(0, 40), ...(path ? { path } : {}), ...(note ? { note } : {}) });
    this.publish();
  }

  /** The open link for a phone (its handle for PhoneControl), if any. */
  linkFor(deviceId: string): PhoneLink | undefined {
    return [...this.links].find((l) => l.deviceId === deviceId && l.isOpen && l.supportsControl);
  }

  /** A phone said what it allows (or sent a pairing code): recompute routes and tell the screens. */
  onControl(link: PhoneLink): void {
    this.control.touched(link.deviceId);
    this.publish();
  }

  unlinked(link: PhoneLink): void {
    this.links.delete(link);
    if (this.opts.devices.get(link.deviceId)) this.opts.devices.update(link.deviceId, { lastSeen: Date.now() });
    this.control.touched(link.deviceId);
    this.publish();
    this.watched();
  }

  setPush(link: PhoneLink, push: NonNullable<DeviceRecord['push']>): void {
    if (this.opts.devices.get(link.deviceId)) return this.opts.devices.update(link.deviceId, { push });
    // A phone of your set paired elsewhere: kept by your device set here (your Always On pushes to it).
    this.opts.machines?.keepPush?.(link.deviceId, push);
  }

  /** The conversations phones have open (their outputs are kept fresh). */
  watched(): void {
    const channels = new Set<string>();
    for (const link of this.links) for (const t of link.topics.keys()) {
      const ch = channelOf(t);
      if (ch) channels.add(ch);
    }
    this.opts.watching?.([...channels], [...this.links].some((l) => l.isOpen));
  }

  /** The phone a Noise key belongs to: paired here, or a phone of your set paired elsewhere (BLG-809). */
  private phoneByLink(linkHex: string): DeviceRecord | undefined {
    const here = this.opts.devices.byLink(linkHex);
    if (here || this.stopped) return here;
    const cert = this.opts.machines?.phone?.(linkHex);
    return cert ? setPhoneRecord(cert) : undefined;
  }

  /** A phone by id: paired here, or one of your set. */
  private phoneRecord(id: string): DeviceRecord | undefined {
    const here = this.opts.devices.get(id);
    if (here) return here;
    const cert = this.opts.machines?.phones?.().find((c) => deviceId(c) === id);
    return cert ? setPhoneRecord(cert) : undefined;
  }

  private accept(stream: NoiseSocket, overRelay = false): void {
    const linkHex = stream.remotePublicKey.toString('hex');
    const device = this.phoneByLink(linkHex);
    // An app or computer of yours (BLG-774): its own door, never a phone's.
    const mine = !device && !this.stopped ? this.opts.machines?.admit(linkHex) : undefined;
    if (mine) return this.opts.machines!.accept(stream, mine, overRelay);
    const socket = fromStream(stream, { maxBytes: MAX_IN_BYTES, open: true });
    socket.on('error', () => undefined);
    if (!device || this.stopped) return socket.terminate();
    const link = new PhoneLink(device, socket, this);
    link.overRelay = overRelay;
    this.links.add(link);
    this.publish();
    // The first phone here (one of your set, on a computer): what waits now is the baseline it hears after.
    if (!this.seenNeeds) void this.notice();
  }

  // ---- the state, views and nudges

  /** Something views show changed outside the shared state (outputs on disk): send what's due. */
  refreshViews(): void {
    this.changed();
  }

  /** The shared state changed: views on phones' screens are due (coalesced), and maybe a nudge. */
  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.stopped) return;
      for (const link of this.links) for (const t of link.topics.keys()) link.schedule(t);
      void this.notice();
    }, Math.min(100, this.coalesceMs));
    this.changeTimer.unref();
  }

  /** New things to tell phones about: something that needs you, or a run asked from the phone that finished. */
  private async notice(): Promise<void> {
    if (!this.phonesToTell().length) {
      this.seenNeeds = undefined;
      this.lastState = undefined;
      return;
    }
    const state = this.state();
    const prev = this.lastState;
    this.lastState = state;
    const items = needsYou(state);
    // What was already waiting when the first phone was paired (or Beluga started) isn't news.
    const seen = this.seenNeeds;
    const fresh = seen ? items.filter((n) => !seen.has(n.id)) : [];
    this.seenNeeds = new Set(items.map((n) => n.id));
    const nudges: Nudge[] = fresh.map((n: NeedsYou) => {
      const nudge: Nudge = { kind: 'needsYou', title: n.title.slice(0, 200), body: (n.detail ?? n.from ?? '').slice(0, 1000), ...(n.topic ? { topic: n.topic } : {}), priority: 'high', ...(n.id.startsWith('join:') ? { friends: true } : {}) };
      this.needOf.set(nudge, n.id);
      return nudge;
    });
    for (const [channel, wasRunning] of [...this.phoneRuns]) {
      const last = [...state.log].reverse().find((l) => l.channel === channel && l.type === 'agent');
      const running = last?.type === 'agent' && !['done', 'error', 'denied', 'interrupted', 'answered'].includes(last.status);
      if (running) this.phoneRuns.set(channel, true);
      else if (wasRunning && last?.type === 'agent') {
        this.phoneRuns.delete(channel);
        const topic = convTopic(channel);
        nudges.push({ kind: 'done', title: `${agentName(last.agent)} ${last.status === 'done' || last.status === 'answered' ? 'answered' : 'stopped'}`, body: last.text.replace(/```[\s\S]*?(```|$)/g, '(code)').slice(0, 300), ...(topic ? { topic } : {}), priority: 'normal', collapse: `done:${channel}` });
      }
    }
    // Every other run that finished (the Mac's own "Claude finished" notices): only for a phone that
    // stays connected in the background (BLG-128), since one in front sees it already.
    if (prev && prev !== state) {
      const told = new Set(nudges.flatMap((n) => (n.collapse?.startsWith('done:') ? [n.collapse] : [])));
      // A sentinel's run that ended, where it notifies the phone (docs/sentinel.md §4): one nudge per
      // sentinel (collapsed), and its Claude step's chat isn't told again as a run that finished.
      for (const d of sentinelDone(prev, state)) {
        nudges.push({ kind: 'done', title: d.title, body: d.body, ...(d.topic ? { topic: d.topic } : {}), priority: 'normal', collapse: d.topic ?? `sentinel:${d.run}` });
        if (d.channel) told.add(`done:${d.channel}`);
      }
      for (const e of detectNotices(prev, state)) {
        if ((e.kind !== 'done' && e.kind !== 'problems') || e.tag === 'test' || !e.channel || told.has(`done:${e.channel}`)) continue;
        const topic = convTopic(e.channel);
        nudges.push({ kind: 'done', title: e.title.slice(0, 200), body: e.body.replace(/```[\s\S]*?(```|$)/g, '(code)').slice(0, 300), ...(topic ? { topic } : {}), priority: 'normal', collapse: `done:${e.channel}`, away: true });
      }
    }
    // A friend's new message (BLG-850), on its chat.
    if (prev && prev.network !== state.network) nudges.push(...newMessages(prev.network, state.network, this.noticeSince, chatTopic));
    if (!nudges.length) return;
    // Asked once: are you at the Mac (used it in the last five minutes)?
    const idle = await this.opts.idleMs?.().catch(() => undefined);
    await this.tell(nudges, state, idle);
  }

  /**
   * Tell each phone: in the app if it's open, else (only once you've been away from the Mac five
   * minutes) a nudge to a linked phone or a push to one that isn't. What needs you while you're at
   * the Mac is held, and told once you step away if it's still waiting (BLG-360).
   */
  private async tell(nudges: readonly Nudge[], state: DomainState, idle: number | undefined): Promise<void> {
    for (const record of this.phonesToTell()) {
      const id = deviceId(record.cert);
      const linked = [...this.links].filter((l) => l.deviceId === id && l.hello);
      const onScreen = new Set<string>(linked.flatMap((l) => [...l.topics.keys()]));
      const inFront = linked.some((l) => l.inFront);
      const leaves = this.leavesFriends(linked);
      for (const nudge of nudges) {
        if (nudge.away && (!linked.length || inFront)) continue;
        if (nudge.friends && leaves) continue;
        const how: Delivery = deliver(nudge, { linked: linked.length > 0, onScreen, inFront, macFront: state.attention.front, canPush: Boolean(record.push), ...(idle !== undefined ? { macIdleMs: idle } : {}) });
        if (how === 'nudge') for (const l of linked) l.send({ t: 'nudge', kind: nudge.kind, title: nudge.title, body: nudge.body, ...(nudge.topic ? { topic: nudge.topic } : {}) });
        else if (how === 'push' && record.push) await (this.opts.pusher ?? NO_PUSH).push({ deviceId: id, ...record.push, box: record.cert.box }, nudge).catch((err: unknown) => this.logLine(`push failed: ${String(err)}`));
        else if (how === 'held') this.hold(nudge);
      }
    }
  }

  /** The phones told what's new: those paired here, and those of your set linked here now or that left a push token here (BLG-809, BLG-850). */
  private phonesToTell(): DeviceRecord[] {
    const here = this.opts.devices.all();
    const linked = new Set([...this.links].filter((l) => l.isOpen).map((l) => l.device.cert.device));
    const others = (this.opts.machines?.phones?.() ?? []).filter((c) => !here.some((r) => r.cert.device === c.device)).flatMap((c) => {
      const record = setPhoneRecord(c);
      const push = this.opts.machines?.pushOf?.(deviceId(c));
      return record && (push || linked.has(c.device)) ? [{ ...record, ...(push ? { push } : {}) }] : [];
    });
    return [...here, ...others];
  }

  /**
   * A friends nudge isn't this install's to tell `linked` (BLG-850): your Always On runs your
   * network, and this phone hears it there (one that links to your computers, or one this would
   * push to). An older phone linked here still hears it from here.
   */
  private leavesFriends(linked: readonly PhoneLink[]): boolean {
    if (this.opts.tellsFriends?.() ?? true) return false;
    const reachesComputers = (l: PhoneLink): boolean => Boolean(l.hello && (l.hello.v.major > COMPANION_PROTO.major || l.hello.v.minor >= SINCE.computers));
    return !linked.length || linked.some(reachesComputers);
  }

  /** Needs-you nudges held while you're at the Mac, by the item they're about. */
  private held = new Map<string, Nudge>();
  private heldTimer?: NodeJS.Timeout;
  /** Which item a needs-you nudge is about (held ones are told only if it's still waiting). */
  private needOf = new WeakMap<Nudge, string>();

  private hold(nudge: Nudge): void {
    const need = this.needOf.get(nudge);
    if (nudge.kind !== 'needsYou' || !need) return;
    this.held.set(need, nudge);
    if (this.heldTimer) return;
    this.heldTimer = setInterval(() => void this.release(), HELD_CHECK_MS);
    this.heldTimer.unref();
  }

  /** Away from the Mac now: tell the phones what's still waiting from what was held. */
  private async release(): Promise<void> {
    const done = (): void => {
      clearInterval(this.heldTimer);
      this.heldTimer = undefined;
    };
    if (this.stopped || !this.held.size) return done();
    const state = this.state();
    const idle = await this.opts.idleMs?.().catch(() => undefined);
    if (atMac({ macFront: state.attention.front, ...(idle !== undefined ? { macIdleMs: idle } : {}) })) return;
    const live = new Set(needsYou(state).map((n) => n.id));
    const still = [...this.held].filter(([need]) => live.has(need)).map(([, n]) => n);
    this.held.clear();
    done();
    if (still.length) await this.tell(still, state, idle);
  }

  /** The shared state's `companion` slice: the phones (who's linked, last seen) and the pairing. */
  private publish(): void {
    if (this.stopped) return;
    const linked = new Set([...this.links].filter((l) => l.isOpen).map((l) => l.deviceId));
    const pairing = this.pairing.info();
    // Each phone carries how Claude can use it now (BLG-150); the adb line is for Settings › Phone.
    const devices = this.opts.devices.views(linked).map((d) => ({ ...d, control: this.control.controlView(d.id) }));
    this.opts.store.dispatch({ type: 'companion', companion: { devices, relay: this.reach.state(), ...(pairing ? { pairing } : {}), adb: this.control.adbView() } });
  }

  /** Set how freely Claude may use a phone, and pair the Mac's adb with it (the Mac's Settings › Phone). */
  setPhoneUse(deviceId: string, use: import('./protocol.js').PhoneUse): void {
    this.control.setUse(deviceId, use);
  }
  pairPhoneAdb(deviceId: string): Promise<string> {
    return this.control.pairAdb(deviceId);
  }
  /** A phone's Wireless debugging on (over its cable) or off (Settings › Phone › Over Wi‑Fi). */
  phoneWifiDebugging(deviceId: string, on: boolean): Promise<string> {
    return this.control.setWifiDebugging(deviceId, on);
  }
  /** Beluga Link installed and turned on over adb (Settings › Phone › Beluga Link, BLG-391). */
  setUpPhoneLink(deviceId: string): Promise<string> {
    return this.control.setUpLink(deviceId);
  }
  /** One phone action from the Mac UI (the mirror's tap/type, a button). */
  phoneAction(deviceId: string, op: PhoneOp, args: Record<string, unknown>): Promise<unknown> {
    return this.control.action(deviceId, op, args);
  }
  /** Saved phone flows (BLG-175), for the Mac UI. */
  listPhoneMacros(): readonly Macro[] {
    return this.control.listMacros();
  }
  runPhoneMacro(name: string): Promise<string> {
    return this.control.runNamedMacro(name);
  }
  deletePhoneMacro(name: string): { deleted: boolean } {
    return { deleted: this.control.deleteMacro(name) };
  }
  /** Stream a phone's screen to a screen that's watching (the Mac app's mirror). */
  mirrorPhone(
    deviceId: string,
    opts: { fps?: number; max?: number; video?: boolean },
    onFrame: (f: { b64: string; mime: string; w: number; h: number }) => void,
    onStatus: (s: MirrorStatus) => void,
    onVideo?: (p: VideoPiece) => void,
    onTouch?: (t: PhoneTouch) => void,
  ): () => void {
    return this.control.startMirror(deviceId, opts, onFrame, onStatus, onVideo, onTouch);
  }

  // ---- the DHT node

  /** Run the node and the server while there's a phone or a pairing; stop them when there's neither. */
  private async sync(): Promise<void> {
    if (this.stopped) return;
    const wanted = this.wanted();
    if (wanted) {
      await this.ensureNode().catch((err: unknown) => this.logLine(`could not start: ${String(err)}`));
      // A pairing that just opened gets its relay record too.
      void this.reach.publish();
    } else if (this.node) {
      // The last phone went: say so on the DHT once more (phones: none), so it hears it's removed.
      await this.reach.publish().catch(() => undefined);
      // That put can take seconds on the real DHT: a pairing opened meanwhile (`beluga pair` again,
      // BLG-674) listens on this node, which must then stay.
      if (this.stopped || this.wanted()) return;
      await this.shutdownNode();
    }
  }

  private wanted(): boolean {
    return this.opts.devices.size > 0 || this.pairing.isOpen || Boolean(this.opts.machines?.wanted());
  }

  /** Your device set changed (a computer pairing opened, a computer joined): run or stop the node, publish again. */
  machinesChanged(): void {
    this.publish();
    void this.sync();
  }

  /** The DHT node as soon as it's up (BLG-774: computer pairings listen and dial on it too). */
  dhtNode(): Promise<DHT> {
    return this.readyNode();
  }

  /** The DHT node as soon as it's up, while the companion's own server and the relay still start. */
  private readyNode(): Promise<DHT> {
    // A node shutting down is no node to listen on: the next one, once it's gone.
    if (this.stopping) return this.stopping.then(() => this.readyNode());
    if (this.node && this.server) return Promise.resolve(this.node);
    this.ensureNode().catch(() => undefined);
    return this.nodeUp!;
  }

  private ensureNode(): Promise<DHT> {
    if (this.stopping) return this.stopping.then(() => this.ensureNode());
    if (this.node && this.server) return Promise.resolve(this.node);
    if (this.starting) return this.starting;
    let up!: (node: DHT) => void;
    let failed!: (err: unknown) => void;
    this.nodeUp = new Promise<DHT>((resolve, reject) => ((up = resolve), (failed = reject)));
    this.nodeUp.catch(() => undefined);
    this.starting = (async () => {
      const DHTClass = (await import('hyperdht')).default;
      const keyPair = this.keyPair ?? (await companionKeyPair(this.opts.identity, this.opts.seedFile));
      this.keyPair = keyPair;
      const node = new DHTClass({ ...(this.opts.dht?.bootstrap ? { bootstrap: this.opts.dht.bootstrap } : {}), ...(this.opts.dht?.host ? { host: this.opts.dht.host } : {}) });
      await node.ready();
      // Kept from here, so stopping destroys it even if what follows fails.
      this.node = node;
      up(node);
      // Only phones you paired (and haven't removed) get through; `true` turns a connection away.
      // and the apps and computers of your set (BLG-774), each by its role: a phone never passes as one.
      // and the phones of your set, paired on another device of yours (BLG-809), as phones.
      const firewall = (remote: Buffer): boolean => !this.phoneByLink(remote.toString('hex')) && !this.opts.machines?.admit(remote.toString('hex'));
      const server = node.createServer({ firewall: this.opts.dht?.refuseDirect ? () => true : firewall }, (stream: NoiseSocket) => this.accept(stream));
      await server.listen(keyPair);
      // The same, through the relay: the companion key answers there behind the same firewall.
      this.reach.server.add({ keyPair, firewall, accept: (stream) => this.accept(stream, true) });
      await this.reach.start().catch((err: unknown) => this.logLine(`no relay: ${String(err)}`));
      this.reach.publishOn(node, () => [keyPair, ...this.pairing.keyPairs(), ...(this.opts.machines?.keyPairs() ?? [])]);
      this.server = server;
      return node;
    })()
      .catch((err: unknown) => {
        failed(err);
        throw err;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /** A shutdown under way: starting a node waits for it (two at once would share the relay). */
  private stopping?: Promise<void>;

  private shutdownNode(): Promise<void> {
    this.stopping ??= (async () => {
      await this.starting?.catch(() => undefined);
      const { node, server } = this;
      this.node = undefined;
      this.server = undefined;
      await this.reach.stop().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await node?.destroy().catch(() => undefined);
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
