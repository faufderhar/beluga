import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Session } from '../core/session.js';
import { type Cap, type DaemonFrame, IPC_VERSION, encodeFrame, parseClientFrame } from '../ipc/protocol.js';
import type { PtyProcess, TerminalManager } from '../terminal/index.js';
import { ClientRegistry, type ConnectedClient } from './clients.js';
import { dispatchCall } from './dispatch.js';
import { companionOf } from '../companion/registry.js';
import type { MirrorStatus, PhoneTouch, VideoPiece } from '../companion/phone-control.js';
import type { MessageSocket } from '../net/transport.js';
import { MACHINE_REFUSED, machineRefuses } from '../machines/coverage.js';

export interface DaemonServerOptions {
  readonly session: Session;
  /** Shared secret every screen must present (from daemon.json). */
  readonly token: string;
  readonly version: string;
  /** 0: any free port. */
  readonly port?: number;
  /** Browser origins allowed to connect (the Mac app's webview); screens in Node send none. */
  readonly allowedOrigins?: readonly string[];
  /** Terminal programs (to stream their bytes). */
  readonly terminals?: TerminalManager;
  /** How long a screen has to say hello. */
  readonly helloTimeoutMs?: number;
  /** How long a capability call may take before it's given up. */
  readonly capTimeoutMs?: number;
  /** Where problems go (the daemon's log). */
  readonly log?: (line: string) => void;
}

/** Biggest frame: a pasted image (up to 3.7 MB, a third bigger in base64) plus room to spare. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Biggest frame before a screen has said who it is. */
const MAX_HELLO_BYTES = 64 * 1024;
/** Unsent bytes a screen may fall behind by before it's dropped (it reconnects and catches up). */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const byteLength = (raw: Buffer | ArrayBuffer | Buffer[]): number => (Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : raw.byteLength);

/** Who may manage external agents: the Mac app and the command line. A browser's screen may not, whatever else it may do. */
const EXTERNAL_MANAGERS: ReadonlySet<string> = new Set(['mac', 'cli', 'test']);
export const mayCall = (kind: string, method: string): boolean => !method.startsWith('external.') || EXTERNAL_MANAGERS.has(kind);
/** What only the Mac app and the command line may do: managing browsers' access (BLG-653). */
export const WEB_ADMIN: ReadonlySet<string> = new Set(['web.link', 'web.sessions.revoke', 'web.stop', 'web.public', 'web.tailscale']);

/** A computer's screen asked for one: who gets it (src/machines/door.ts). The hello's token was checked. */
export type MachineRoute = (id: string, ws: WebSocket, hello: Extract<ReturnType<typeof parseClientFrame>, { t: 'hello' }>) => void;

/** The default origins of the Mac app's webview. */
export const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] as const;

/**
 * The daemon's door: screens connect over a loopback WebSocket, prove they hold the token, get
 * the shared state and every action after it, and call the API. What the core asks screens to
 * do (intents) goes to the screen that caused it, else to all of them.
 */
export class DaemonServer {
  readonly clients = new ClientRegistry();
  private wss?: WebSocketServer;
  private seq = 0;
  private readonly offs: Array<() => void> = [];
  private readonly capCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** Per terminal: who may answer the program's queries (the screen that typed or resized last). */
  private readonly termOwner = new Map<string, string>();
  // Which screens show each terminal (an owner who leaves hands over to one of them).
  private readonly termViewers = new Map<string, Set<string>>();

  constructor(private readonly opts: DaemonServerOptions) {}

  /** The frame just encoded, and its text: one going to every screen is encoded once, not once per screen (BLG-407). */
  private lastFrame?: DaemonFrame;
  private lastText = '';

  private encoded(frame: DaemonFrame): string {
    if (frame === this.lastFrame) return this.lastText;
    const text = encodeFrame(frame);
    this.lastFrame = frame;
    this.lastText = text;
    // Kept only while this frame goes out to each screen (one synchronous loop), never for a later send.
    queueMicrotask(() => {
      if (this.lastFrame === frame) this.lastFrame = undefined;
    });
    return text;
  }

  private get session(): Session {
    return this.opts.session;
  }

  async listen(): Promise<number> {
    const allowed = new Set(this.opts.allowedOrigins ?? APP_ORIGINS);
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.opts.port ?? 0,
      maxPayload: MAX_FRAME_BYTES,
      verifyClient: ({ origin }: { origin?: string }) => !origin || allowed.has(origin),
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    // `/machine/<id>`: a screen of this app driving one of your computers (BLG-775); the rest is this daemon's.
    wss.on('connection', (ws, req: IncomingMessage) => {
      const machine = /^\/machine\/([0-9a-f]{16})\/?$/.exec(req.url ?? '');
      if (machine) this.acceptMachineScreen(ws, machine[1]!);
      else this.accept(ws);
    });
    this.offs.push(
      this.session.store.onAction((action) => {
        this.seq++;
        this.clients.send({ t: 'action', seq: this.seq, action });
      }),
      this.session.intents.subscribe((intent, target) => {
        // Caused by one screen: only it hears. Otherwise everyone does.
        // A message for a screen that has since closed still reaches the others; a move doesn't.
        if (target !== undefined && this.clients.get(target)) this.clients.send({ t: 'intent', intent }, target);
        else if (target === undefined || intent.type === 'toast') this.clients.send({ t: 'intent', intent });
      }),
      this.clients.onChange((count) => this.clients.send({ t: 'clients', count })),
    );
    return (wss.address() as AddressInfo).port;
  }

  async close(reason = 'Beluga is shutting down'): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    for (const c of this.capCalls.values()) {
      clearTimeout(c.timer);
      c.reject(new Error('Closed'));
    }
    this.capCalls.clear();
    this.clients.send({ t: 'bye', reason });
    const wss = this.wss;
    if (!wss) return;
    for (const ws of wss.clients) ws.close(1001, reason);
    this.wss = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  /**
   * Ask a screen to do what only it can (copy text, open a link…): the one whose request this is,
   * else the most recently active one that can.
   */
  callCap(cap: Cap, args: readonly unknown[], caller?: string): Promise<unknown> {
    const client = this.clients.pick(cap, caller);
    if (!client) return Promise.reject(new Error(`No screen can ${cap} right now`));
    return this.capOn(client, cap, args);
  }

  /** Show a desktop notification on one screen (the Mac app when it's there). */
  notify(args: readonly unknown[]): void {
    const client = this.clients.pickNotifier();
    if (client) void this.capOn(client, 'notify', args).catch(() => undefined);
  }

  private capOn(client: ConnectedClient, cap: Cap, args: readonly unknown[]): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.capCalls.delete(id);
        reject(new Error(`The screen didn't ${cap} in time`));
      }, this.opts.capTimeoutMs ?? 10_000);
      timer.unref?.();
      this.capCalls.set(id, { resolve, reject, timer });
      client.send({ t: 'cap_call', id, cap, args });
    });
  }

  /**
   * A browser's socket from the web port (daemon/web.ts), already let in by its session: it
   * goes through the same accept path, but its hello's token is never read.
   */
  adopt(ws: WebSocket): void {
    if (!this.wss) return ws.close(1013, 'Beluga is starting');
    this.accept(ws, 'web');
  }

  /**
   * Your app driving this computer (BLG-775): its link (already let in by its certificate, and its
   * first frame, the hello, already read) becomes a screen of kind `machine`. The hello's token is
   * never read: the app's own token never leaves the app.
   */
  adoptMachine(socket: MessageSocket, hello: string): void {
    if (!this.wss) return socket.close(1013, 'Beluga is starting');
    const ws = new LinkAsWs(socket);
    this.accept(ws as unknown as WebSocket, 'machine');
    ws.emit('message', Buffer.from(hello), false);
  }

  /**
   * A screen for one of your computers that is this daemon itself (the demo's, BLG-784): its hello
   * (token already checked) is heard again, and it's a screen of kind `machine` here.
   */
  serveAsMachine(ws: WebSocket, hello: Parameters<MachineRoute>[2]): void {
    if (!this.wss) return ws.close(1013, 'Beluga is starting');
    this.accept(ws, 'machine');
    ws.emit('message', Buffer.from(encodeFrame(hello)), false);
  }

  private machineRoute?: MachineRoute;

  /** Who serves `/machine/<id>` (the machines' door, once it's up). */
  routeMachines(route: MachineRoute): void {
    this.machineRoute = route;
  }

  /** A screen for one of your computers: it proves it holds this daemon's token, then the door pipes it there. */
  private acceptMachineScreen(ws: WebSocket, id: string): void {
    const timer = setTimeout(() => ws.close(4001, 'No hello'), this.opts.helloTimeoutMs ?? 5000);
    timer.unref?.();
    ws.once('message', (raw, isBinary) => {
      clearTimeout(timer);
      if (isBinary || byteLength(raw) > MAX_HELLO_BYTES) return ws.close(1009, 'Say hello first');
      const frame = parseClientFrame(raw.toString());
      if (frame?.t !== 'hello') return ws.close(4001, 'Say hello first');
      if (!this.tokenOk(frame.token)) return ws.close(4003, 'Wrong token');
      if (!this.machineRoute) return ws.close(4404, 'No computers here');
      this.machineRoute(id, ws, frame);
    });
    ws.on('error', () => undefined);
  }

  private accept(ws: WebSocket, preauthorized?: 'web' | 'machine'): void {
    let client: ConnectedClient | undefined;
    const attached = new Map<string, () => void>();
    const send = (frame: DaemonFrame): void => {
      if (ws.readyState !== ws.OPEN) return;
      // A screen that stopped reading (asleep, hung) would make Beluga hold everything for it.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.opts.log?.(`${client?.id ?? 'a screen'} fell too far behind; letting it go`);
        return ws.terminate();
      }
      ws.send(this.encoded(frame));
    };
    // Phone mirrors this screen is watching (BLG-173), by device id → stop().
    const mirrors = new Map<string, () => void>();
    const helloTimer = setTimeout(() => ws.close(4001, 'No hello'), this.opts.helloTimeoutMs ?? 5000);
    helloTimer.unref?.();
    const detachAll = (): void => {
      for (const off of attached.values()) off();
      attached.clear();
      for (const off of mirrors.values()) off();
      mirrors.clear();
    };

    ws.on('message', (raw, isBinary) => {
      // Closing (a revoked browser): nothing more it sends is heard, whether or not it answers the close.
      if (ws.readyState !== ws.OPEN) return;
      if (!client && (isBinary || byteLength(raw) > MAX_HELLO_BYTES)) return ws.close(1009, 'Say hello first');
      try {
        handle(raw.toString());
      } catch (err) {
        // One bad frame must not take Beluga (and everyone's screens) down.
        this.opts.log?.(`frame from ${client?.id ?? 'a new screen'} failed: ${errorText(err)}`);
      }
    });

    const handle = (text: string): void => {
      const frame = parseClientFrame(text);
      if (!frame) return;
      if (!client) {
        if (frame.t !== 'hello') return;
        clearTimeout(helloTimer);
        if (!preauthorized && !this.tokenOk(frame.token)) return ws.close(4003, 'Wrong token');
        if (frame.ipc !== IPC_VERSION) {
          send({ t: 'bye', reason: `This Beluga speaks version ${IPC_VERSION} of the protocol, the screen ${frame.ipc}. Update both to the same version.` });
          return ws.close(4004, 'IPC version mismatch');
        }
        // A browser from the web port is a web screen, and your app over a computer's link a machine
        // screen, whatever their hello says (neither may manage access).
        client = this.clients.add({ kind: preauthorized ?? frame.kind, version: frame.version, ...(frame.launchDir ? { launchDir: frame.launchDir } : {}), caps: frame.caps, send });
        send({ t: 'welcome', clientId: client.id, version: this.opts.version, ipc: IPC_VERSION, snapshot: this.session.store.getState(), seq: this.seq, clients: this.clients.size });
        return;
      }
      const me = client;
      switch (frame.t) {
        case 'hello':
          return;
        case 'ping':
          return send({ t: 'pong' });
        case 'resync':
          return send({ t: 'snapshot', snapshot: this.session.store.getState(), seq: this.seq });
        case 'attention':
          // The `beluga` command in a terminal shows no conversations: it doesn't count as looking.
          if (me.kind === 'cli') return;
          // Screens from before `front` existed: one showing something is in front.
          return this.session.attend(me.id, { ...frame.attention, front: frame.attention.front ?? frame.attention.visible.length > 0 });
        case 'call':
          this.clients.touch(me.id);
          return void this.call(me, frame.id, frame.method, frame.args).then(send);
        case 'cap_result': {
          const pending = this.capCalls.get(frame.id);
          if (!pending) return;
          this.capCalls.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.ok) pending.resolve(frame.value);
          else pending.reject(new Error(frame.error ?? 'failed'));
          return;
        }
        case 'term_attach': {
          attached.get(frame.term)?.();
          const pty = this.opts.terminals?.get(frame.term);
          if (!pty) return send({ t: 'term_status', term: frame.term, running: false, exited: { code: null } });
          if (!this.termOwner.has(frame.term)) this.termOwner.set(frame.term, me.id);
          this.termViewers.set(frame.term, new Set([...(this.termViewers.get(frame.term) ?? []), me.id]));
          attached.set(frame.term, this.stream(pty, frame.term, send));
          return;
        }
        case 'term_detach':
          attached.get(frame.term)?.();
          attached.delete(frame.term);
          this.leaveTerm(frame.term, me.id);
          return;
        case 'term_input': {
          const pty = this.opts.terminals?.get(frame.term);
          if (!pty) return;
          // Answers to the program's own queries come from one screen only, or it would get several.
          if (frame.reply) {
            if (this.termOwner.get(frame.term) === me.id) pty.write(frame.data);
            return;
          }
          this.termOwner.set(frame.term, me.id);
          pty.write(frame.data);
          return;
        }
        case 'term_resize': {
          // The last screen to resize wins (two screens of different sizes share one program).
          const pty = this.opts.terminals?.get(frame.term);
          if (!pty) return;
          this.termOwner.set(frame.term, me.id);
          pty.resize(frame.cols, frame.rows);
          return;
        }
        case 'phone_watch': {
          mirrors.get(frame.device)?.();
          const host = companionOf(this.session);
          if (!host) return send({ t: 'phone_mirror', device: frame.device, on: false, error: 'No phone support' });
          mirrors.set(
            frame.device,
            host.mirrorPhone(
              frame.device,
              { ...(frame.fps ? { fps: frame.fps } : {}), ...(frame.max ? { max: frame.max } : {}), ...(frame.video ? { video: true } : {}) },
              (f: { b64: string; mime: string; w: number; h: number }) => send({ t: 'phone_frame', device: frame.device, b64: f.b64, mime: f.mime, w: f.w, h: f.h }),
              (s: MirrorStatus) => send({ t: 'phone_mirror', device: frame.device, on: s.on, ...(s.route ? { route: s.route } : {}), ...(s.error ? { error: s.error } : {}), ...(s.video ? { video: s.video } : {}), ...(s.note ? { note: s.note } : {}) }),
              (p: VideoPiece) => send({ t: 'phone_video', device: frame.device, b64: p.b64, key: p.key, ts: p.ts, w: p.w, h: p.h, sw: p.sw, sh: p.sh }),
              (touch: PhoneTouch) => send({ t: 'phone_touch', device: frame.device, touch }),
            ),
          );
          return;
        }
        case 'phone_unwatch': {
          mirrors.get(frame.device)?.();
          mirrors.delete(frame.device);
          return;
        }
      }
    };

    ws.on('close', () => {
      clearTimeout(helloTimer);
      detachAll();
      if (!client) return;
      this.session.detach(client.id);
      this.clients.remove(client.id);
      for (const term of [...this.termViewers.keys()]) this.leaveTerm(term, client.id);
      for (const [term, owner] of this.termOwner) if (owner === client.id) this.termOwner.delete(term);
    });
    ws.on('error', () => undefined);
  }

  /** A program's output to one screen: what it wrote lately, then as it comes, then how it ended. */
  /** A screen stops showing a terminal: if it answered the program's queries, another screen does now. */
  private leaveTerm(term: string, clientId: string): void {
    const viewers = this.termViewers.get(term);
    if (!viewers?.has(clientId)) return;
    const rest = new Set([...viewers].filter((id) => id !== clientId));
    if (rest.size) this.termViewers.set(term, rest);
    else this.termViewers.delete(term);
    if (this.termOwner.get(term) !== clientId) return;
    const next = [...rest].at(-1);
    if (next) this.termOwner.set(term, next);
    else this.termOwner.delete(term);
  }

  private stream(pty: PtyProcess, term: string, send: (frame: DaemonFrame) => void): () => void {
    const backlog = pty.backlog();
    if (backlog) send({ t: 'term_data', term, data: backlog });
    send({ t: 'term_status', term, running: pty.running, ...(pty.exited ? { exited: pty.exited } : {}) });
    const offData = pty.onData((data) => send({ t: 'term_data', term, data }));
    const offExit = pty.onExit((exited) => send({ t: 'term_status', term, running: false, exited }));
    return () => {
      offData();
      offExit();
    };
  }

  private async call(client: ConnectedClient, id: string, method: string, raw: readonly unknown[]): Promise<DaemonFrame> {
    if (!mayCall(client.kind, method)) return { t: 'result', id, ok: false, error: 'External agents are managed from the Mac app or `beluga mcp` on the computer Beluga runs on' };
    // A browser's session can't mint, revoke or move browser sessions: a stolen cookie can't outlive its revoke.
    if (client.kind === 'web' && WEB_ADMIN.has(method)) return { t: 'result', id, ok: false, error: 'Browsers are let in and revoked from the Mac app or `beluga web` on the computer Beluga runs on' };
    // Your app driving this computer: what src/machines/coverage.ts refuses it (BLG-776).
    if (client.kind === 'machine' && machineRefuses(method)) return { t: 'result', id, ok: false, error: MACHINE_REFUSED };
    return { t: 'result', id, ...(await dispatchCall(this.session, client.id, method, raw)) };
  }

  private tokenOk(token: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * A computer's link (a framed Noise stream) as the parts of a `ws` WebSocket the door uses, so
 * your app's screens over it go through the very same accept path as local ones.
 */
class LinkAsWs extends EventEmitter {
  readonly OPEN = 1;
  readonly bufferedAmount = 0;

  constructor(private readonly socket: MessageSocket) {
    super();
    socket.on('message', (text) => void this.emit('message', Buffer.from(text), false));
    socket.once('close', (code) => void this.emit('close', code));
    socket.on('error', (err) => void this.emit('error', err));
  }

  get readyState(): number {
    return this.socket.isOpen ? 1 : 3;
  }

  send(text: string): void {
    this.socket.send(text);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }
}

