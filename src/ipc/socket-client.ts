import { ClientStore, type DomainSource } from '../client/client-store.js';
import type { Intent } from '../core/intents.js';
import { type Action, type DomainState, reduceDomain } from '../core/store.js';
import type { PtyExit } from '../terminal/pty-host.js';
import type { PtyLink } from '../terminal/emulator.js';
import type { Args, Method } from './api.js';
import { type ApiProxy, type ClientKind, type BelugaClient, type HelloKind, type PhoneMirror, type PhoneMirrorStatus, type PhoneTouchData, type PhoneVideoPiece, apiProxy, toastsFailure } from './client.js';
import type { Result } from './handlers.js';
import { type Cap, type ClientFrame, type DaemonFrame, IPC_VERSION, encodeFrame, parseDaemonFrame } from './protocol.js';

/** The parts of the standard WebSocket we use (the browser's, or Node's global one). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** What this screen can do when the daemon asks (its clipboard, its notifications…). */
export type Capabilities = Partial<Record<Cap, (...args: never[]) => unknown>>;

export interface SocketClientOptions {
  readonly url: string;
  readonly token: string;
  readonly kind: HelloKind;
  readonly version: string;
  readonly launchDir?: string;
  readonly caps?: Capabilities;
  /** Make the socket (default: the global WebSocket). */
  readonly connect?: (url: string) => SocketLike;
  /** Give up waiting for the daemon's welcome after this long. */
  readonly timeoutMs?: number;
}

const OPEN = 1;

/** The daemon's shared state, kept in step by replaying its actions. */
class Replica implements DomainSource {
  private readonly listeners = new Set<() => void>();

  constructor(
    private state: DomainState,
    public seq: number,
  ) {}

  getState = (): DomainState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Apply the next action; false when one was missed (ask for a fresh snapshot). */
  apply(seq: number, action: Action): boolean {
    if (seq <= this.seq) return true;
    if (seq !== this.seq + 1) return false;
    this.seq = seq;
    const next = reduceDomain(this.state, action);
    if (next !== this.state) this.set(next);
    return true;
  }

  reset(state: DomainState, seq: number): void {
    this.seq = seq;
    this.set(state);
  }

  private set(next: DomainState): void {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}

/** One terminal as this screen sees it: bytes in, keys out, and how it ended. */
class SocketTerm implements PtyLink {
  running = true;
  exited: PtyExit | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exit: PtyExit) => void>();
  private buffered: string[] = [];

  constructor(
    private readonly key: string,
    private readonly sendFrame: (frame: ClientFrame) => void,
    private readonly forget: () => void,
  ) {}

  write(data: string, reply?: boolean): void {
    this.sendFrame({ t: 'term_input', term: this.key, data, ...(reply ? { reply: true } : {}) });
  }

  resize(cols: number, rows: number): void {
    this.sendFrame({ t: 'term_resize', term: this.key, cols, rows });
  }

  onData(listener: (data: string) => void): () => void {
    // What arrived before anyone listened (the backlog) goes to the first listener.
    if (this.buffered.length) {
      listener(this.buffered.join(''));
      this.buffered = [];
    }
    this.dataListeners.add(listener);
    return () => void this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => void this.exitListeners.delete(listener);
  }

  close(): void {
    this.sendFrame({ t: 'term_detach', term: this.key });
    this.forget();
  }

  data(data: string): void {
    if (!this.dataListeners.size) this.buffered.push(data);
    for (const l of [...this.dataListeners]) l(data);
  }

  status(running: boolean, exited?: PtyExit): void {
    this.running = running;
    if (!exited || this.exited) return;
    this.exited = exited;
    for (const l of [...this.exitListeners]) l(exited);
  }
}

/** One phone's live screen as this screen sees it (BLG-173): frames in, keys out via the API. */
class SocketPhoneMirror implements PhoneMirror {
  private readonly frameListeners = new Set<(f: PhoneFrameData) => void>();
  private readonly statusListeners = new Set<(s: PhoneMirrorStatus) => void>();
  private readonly videoListeners = new Set<(p: PhoneVideoPiece) => void>();
  private readonly touchListeners = new Set<(t: PhoneTouchData) => void>();

  constructor(
    private readonly device: string,
    private readonly sendFrame: (frame: ClientFrame) => void,
    private readonly forget: () => void,
  ) {}

  onFrame(listener: (f: PhoneFrameData) => void): () => void {
    this.frameListeners.add(listener);
    return () => void this.frameListeners.delete(listener);
  }
  onVideo(listener: (p: PhoneVideoPiece) => void): () => void {
    this.videoListeners.add(listener);
    return () => void this.videoListeners.delete(listener);
  }
  onTouch(listener: (t: PhoneTouchData) => void): () => void {
    this.touchListeners.add(listener);
    return () => void this.touchListeners.delete(listener);
  }
  onStatus(listener: (s: PhoneMirrorStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }
  close(): void {
    this.sendFrame({ t: 'phone_unwatch', device: this.device });
    this.forget();
  }
  frame(f: PhoneFrameData): void {
    for (const l of [...this.frameListeners]) l(f);
  }
  video(p: PhoneVideoPiece): void {
    for (const l of [...this.videoListeners]) l(p);
  }
  touch(t: PhoneTouchData): void {
    for (const l of [...this.touchListeners]) l(t);
  }
  status(s: PhoneMirrorStatus): void {
    for (const l of [...this.statusListeners]) l(s);
  }
}

type PhoneFrameData = { b64: string; mime: string; w: number; h: number };

/**
 * A screen attached to the beluga daemon over its local WebSocket (the Mac app).
 * Browser-safe.
 */
export class SocketClient implements BelugaClient {
  readonly store: ClientStore;
  readonly api: ApiProxy;
  readonly kind: ClientKind;
  readonly launchDir: string;
  /** How many screens are attached (this one included). */
  clients = 1;
  private nextId = 0;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly intentListeners = new Set<(intent: Intent) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly terms = new Map<string, SocketTerm>();
  private readonly phones = new Map<string, SocketPhoneMirror>();
  private closed = false;
  // A snapshot was asked for and hasn't come yet.
  private resyncing = false;
  /** Pings waiting for their pong, oldest first. */
  private readonly pongs: Array<() => void> = [];

  private constructor(
    private readonly socket: SocketLike,
    private readonly replica: Replica,
    readonly id: string,
    readonly daemonVersion: string,
    private readonly opts: SocketClientOptions,
  ) {
    this.kind = opts.kind;
    this.launchDir = opts.launchDir ?? '';
    this.store = new ClientStore(replica, (a) => this.send({ t: 'attention', attention: { shown: [...a.shown], visible: [...a.visible], files: a.files, front: a.front } }));
    this.api = apiProxy((method, args) => this.invoke(method, args));
  }

  /** Connect, say hello, and wait for the daemon's welcome. */
  static connect(opts: SocketClientOptions): Promise<SocketClient> {
    const make = opts.connect ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url));
    const socket = make(opts.url);
    return new Promise((resolve, reject) => {
      let client: SocketClient | undefined;
      const early: string[] = [];
      const timer = setTimeout(() => {
        reject(new Error('The beluga daemon did not answer'));
        socket.close();
      }, opts.timeoutMs ?? 10_000);
      socket.onopen = () => {
        const hello: ClientFrame = { t: 'hello', token: opts.token, ipc: IPC_VERSION, kind: opts.kind, version: opts.version, caps: Object.keys(opts.caps ?? {}) as Cap[], ...(opts.launchDir ? { launchDir: opts.launchDir } : {}) };
        socket.send(encodeFrame(hello));
      };
      socket.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (client) return client.receive(text);
        const frame = parseDaemonFrame(text);
        if (frame.t === 'bye') {
          clearTimeout(timer);
          return reject(new Error(frame.reason));
        }
        if (frame.t !== 'welcome') return void early.push(text);
        clearTimeout(timer);
        client = new SocketClient(socket, new Replica(frame.snapshot, frame.seq), frame.clientId, frame.version, opts);
        client.clients = frame.clients;
        for (const e of early) client.receive(e);
        resolve(client);
      };
      socket.onclose = (ev) => {
        clearTimeout(timer);
        if (!client) return reject(new Error(ev.reason || 'Could not reach the beluga daemon'));
        client.ended(ev.reason || 'The beluga daemon went away');
      };
      socket.onerror = () => undefined;
    });
  }

  /**
   * One round trip to the daemon (for a computer's screen, through the door to the computer and
   * back, BLG-792) → its ms. Never settles while the link is down; the caller times it out.
   */
  ping(): Promise<number> {
    const sent = Date.now();
    // Pings lost to a link that dropped are let go, a few at most kept waiting.
    if (this.pongs.length >= 8) this.pongs.shift();
    return new Promise((resolve) => {
      this.pongs.push(() => resolve(Date.now() - sent));
      this.send({ t: 'ping' });
    });
  }

  call<M extends Method>(method: M, ...args: Args<M>): Promise<Result<M>> {
    return this.invoke(method, args) as Promise<Result<M>>;
  }

  private invoke(method: Method, args: readonly unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Not connected to Beluga'));
    const id = String(++this.nextId);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Left-out trailing arguments stay left out (JSON would turn them into null).
      const list = [...args];
      while (list.length && list[list.length - 1] === undefined) list.pop();
      this.send({ t: 'call', id, method, args: list });
    });
    if (toastsFailure(method)) promise.catch((err: unknown) => this.store.dispatch({ type: 'toast', text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), level: 'error' }));
    return promise;
  }

  onIntent(listener: (intent: Intent) => void): () => void {
    this.intentListeners.add(listener);
    return () => void this.intentListeners.delete(listener);
  }

  /** Called once when the connection ends (daemon quit, or close()). */
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => void this.closeListeners.delete(listener);
  }

  attachTerminal(key: string): PtyLink {
    this.terms.get(key)?.close();
    const term = new SocketTerm(key, (f) => this.send(f), () => {
      if (this.terms.get(key) === term) this.terms.delete(key);
    });
    this.terms.set(key, term);
    this.send({ t: 'term_attach', term: key });
    return term;
  }

  watchPhone(device: string, opts: { fps?: number; max?: number; video?: boolean } = {}): PhoneMirror {
    this.phones.get(device)?.close();
    const mirror = new SocketPhoneMirror(device, (f) => this.send(f), () => {
      if (this.phones.get(device) === mirror) this.phones.delete(device);
    });
    this.phones.set(device, mirror);
    this.send({ t: 'phone_watch', device, ...(opts.fps ? { fps: opts.fps } : {}), ...(opts.max ? { max: opts.max } : {}), ...(opts.video ? { video: true } : {}) });
    return mirror;
  }

  close(): void {
    if (this.closed) return;
    this.socket.close(1000, 'bye');
    this.ended('closed');
  }

  private send(frame: ClientFrame): void {
    if (!this.closed && this.socket.readyState === OPEN) this.socket.send(encodeFrame(frame));
  }

  private receive(text: string): void {
    const frame = parseDaemonFrame(text);
    switch (frame.t) {
      case 'action':
        // Ask once: actions keep coming until the snapshot arrives, each also out of step.
        if (!this.replica.apply(frame.seq, frame.action) && !this.resyncing) {
          this.resyncing = true;
          this.send({ t: 'resync' });
        }
        return;
      case 'snapshot':
        this.replica.reset(frame.snapshot, frame.seq);
        this.resyncing = false;
        return;
      case 'result': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.value);
        else p.reject(new Error(frame.error ?? 'failed'));
        return;
      }
      case 'intent':
        this.store.applyIntent(frame.intent);
        for (const l of [...this.intentListeners]) l(frame.intent);
        return;
      case 'cap_call':
        void this.runCap(frame.id, frame.cap, frame.args);
        return;
      case 'term_data':
        this.terms.get(frame.term)?.data(frame.data);
        return;
      case 'term_status':
        this.terms.get(frame.term)?.status(frame.running, frame.exited);
        return;
      case 'phone_frame':
        this.phones.get(frame.device)?.frame({ b64: frame.b64, mime: frame.mime, w: frame.w, h: frame.h });
        return;
      case 'phone_video':
        this.phones.get(frame.device)?.video({ b64: frame.b64, key: frame.key, ts: frame.ts, w: frame.w, h: frame.h, sw: frame.sw, sh: frame.sh });
        return;
      case 'phone_touch':
        this.phones.get(frame.device)?.touch(frame.touch);
        return;
      case 'phone_mirror':
        this.phones.get(frame.device)?.status({ on: frame.on, ...(frame.route ? { route: frame.route } : {}), ...(frame.error ? { error: frame.error } : {}), ...(frame.video ? { video: frame.video } : {}), ...(frame.note ? { note: frame.note } : {}) });
        return;
      case 'clients':
        this.clients = frame.count;
        return;
      case 'bye':
        this.ended(frame.reason);
        return;
      case 'pong':
        this.pongs.shift()?.();
        return;
      case 'welcome':
        return;
    }
  }

  private async runCap(id: string, cap: Cap, args: readonly unknown[]): Promise<void> {
    const fn = this.opts.caps?.[cap] as ((...a: unknown[]) => unknown) | undefined;
    try {
      if (!fn) throw new Error(`This screen can't ${cap}`);
      const value = await fn(...args);
      this.send({ t: 'cap_result', id, ok: true, ...(value === undefined ? {} : { value }) });
    } catch (err) {
      this.send({ t: 'cap_result', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private ended(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    for (const t of this.terms.values()) t.status(false, { code: null });
    this.terms.clear();
    for (const l of [...this.closeListeners]) l(reason);
    this.store.close();
  }
}
