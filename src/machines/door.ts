import type { WebSocket } from 'ws';
import { COMPUTER_CAPS, type ClientFrame, type DaemonFrame, IPC_VERSION, encodeFrame, parseClientFrame, parseDaemonFrame, webUrl } from '../ipc/protocol.js';
import type { MessageSocket } from '../net/transport.js';
import type { TextRange } from '../shared/text-range.js';
import type { StateCache } from './cache.js';
import { FRESH_MS, type FileCache, type RangeAsk, rangeAsk } from './files.js';
import type { Machines } from './machines.js';

/**
 * The app's door to your computers (BLG-775): a screen of this app opens
 * ws://127.0.0.1:<port>/machine/<id> with this daemon's own token (checked by the daemon server,
 * and never sent on), and from then on speaks the normal app protocol, piped frame by frame over
 * an end-to-end encrypted link to that computer (direct or through its relay). Only those frames
 * cross: the app's UI is always its own build, nothing is served from the computer.
 *
 * When the link drops, the screen stays open: the door dials again with backoff, says hello again,
 * hands the screen the fresh state as a snapshot and re-attaches its terminals and attention, so it
 * catches up by itself. Calls made while it's down are answered at once with why. A computer that
 * forgot this app, or speaks another protocol, closes the screen with its reason.
 *
 * What the computer may ask of this app's screen is only COMPUTER_CAPS (BLG-776): the screen's
 * hello offers no more, and a cap_call beyond them, or openExternal of anything but an http(s)
 * page, is answered no here without reaching the screen.
 */

/** What the app's hello says on the link instead of its token (the computer never reads it there). */
export const LINK_TOKEN = 'over-your-device-link';
const BACKOFF_MS = [300, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Close codes that end a screen rather than reconnect: forgotten, another protocol, wrong token, gone from the book. */
const FINAL = new Set([4003, 4004, 4010, 4404]);

type ScreenFrame = NonNullable<ReturnType<typeof parseClientFrame>>;
type Hello = Extract<ScreenFrame, { t: 'hello' }>;
type CallFrame = Extract<ScreenFrame, { t: 'call' }>;

/** Calls that make a worktree on the computer → its id (BLG-800: the .env ask follows). */
const MAKES_WORKTREE = new Set(['workspaces.startWorktree', 'workspaces.newWorktree', 'workspaces.continueInWorktree', 'workspaces.fork', 'workspaces.moveLand']);
/** The app daemon's own calls on a link carry this id prefix; their answers never reach the screen. */
const OWN_CALL = 'door:';
const OWN_CALL_MS = 30_000;

export interface DoorOptions {
  /** Waits between tries after the link drops (tests make them short). */
  readonly backoffMs?: readonly number[];
  readonly log?: (line: string) => void;
  /** A screen made a worktree on computer `machineId` (BLG-800). */
  readonly onWorktree?: (machineId: string, workspaceId: string) => void;
  /** The computers' files your screens read, kept on this Mac (files.ts, BLG-791). */
  readonly files?: FileCache;
  /** Each computer's last state, so a screen draws at once and catches up (cache.ts, BLG-792). */
  readonly states?: StateCache;
  readonly now?: () => number;
}

export class MachineDoor {
  private readonly screens = new Set<MachineScreen>();

  constructor(
    private readonly machines: Machines,
    private readonly opts: DoorOptions = {},
  ) {}

  /** A screen for computer `id` said hello with this daemon's token. */
  open(id: string, ws: WebSocket, hello: Hello): void {
    const record = this.machines.book.get(id);
    if (!record || !this.machines.drives(record)) return ws.close(4404, 'That computer isn’t one of yours here');
    const screen = new MachineScreen(this.machines, id, ws, hello, this.opts, () => this.screens.delete(screen));
    this.screens.add(screen);
    screen.fromCache();
    screen.connect();
  }

  /**
   * A call of this app's own on computer `id`, over the link a screen of yours has open to it (the
   * frames are end-to-end encrypted like the screen's). None open: it fails with why.
   */
  call(id: string, method: string, args: readonly unknown[]): Promise<unknown> {
    const screen = [...this.screens].find((s) => s.machineId === id && s.live);
    if (!screen) return Promise.reject(new Error(`${this.machines.book.get(id)?.name ?? 'That computer'} isn’t connected right now`));
    return screen.call(method, args);
  }

  /** The computers a screen of this app drives right now (link up). */
  live(): string[] {
    return [...new Set([...this.screens].filter((s) => s.live).map((s) => s.machineId))];
  }

  /** Screens open on computers right now (tests, and how many links run). */
  get size(): number {
    return this.screens.size;
  }

  closeAll(reason: string): void {
    for (const s of [...this.screens]) s.end(1001, reason);
  }
}

class MachineScreen {
  private link?: MessageSocket;
  private attempt = 0;
  private closed = false;
  private welcomed = false;
  private timer?: NodeJS.Timeout;
  /** What to say again after a reconnect: the terminals it shows, where its attention is. */
  /** Terminals the screen shows → whether it asked for flow control (BLG-963), to attach again the same way. */
  private readonly terms = new Map<string, boolean>();
  private attention?: string;
  /** Calls sent and not yet answered (failed at once when the link drops), with their method. */
  private readonly inflight = new Map<string, string>();
  /** files.readRange calls sent, by id: what to keep their answer as. */
  private readonly ranges = new Map<string, RangeAsk>();
  /** This app's own calls (call()), by id. */
  private readonly own = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ownSeq = 0;

  constructor(
    private readonly machines: Machines,
    readonly machineId: string,
    private readonly ws: WebSocket,
    private readonly hello: Hello,
    private readonly opts: DoorOptions,
    private readonly gone: () => void,
  ) {
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) this.fromScreen(raw.toString());
    });
    ws.once('close', () => this.end());
    ws.on('error', () => undefined);
  }

  /**
   * Its last state kept here, if any, as the screen's welcome now: it draws at once (after this
   * Mac's Beluga restarted too, or with the computer offline), and the computer's own welcome comes
   * as a fresh snapshot once the link is up.
   */
  fromCache(): void {
    const kept = this.opts.states?.get(this.machineId);
    if (!kept || this.welcomed) return;
    this.welcomed = true;
    this.toScreen(encodeFrame({ t: 'welcome', clientId: `kept:${this.machineId}`, version: kept.version, ipc: IPC_VERSION, snapshot: kept.snapshot, seq: kept.seq, clients: 1 }));
  }

  private get name(): string {
    return this.machines.book.get(this.machineId)?.name ?? 'That computer';
  }

  connect(): void {
    if (this.closed) return;
    const record = this.machines.book.get(this.machineId);
    if (!record || !this.machines.drives(record)) return this.end(4010, `${this.name} is no longer one of your computers`);
    this.machines.openLink(record).then(
      (socket) => {
        if (this.closed) return socket.close(1000);
        this.link = socket;
        socket.on('message', (text) => this.fromComputer(text));
        socket.once('close', (code) => this.dropped(socket, code));
        const hello: ClientFrame = { ...this.hello, token: LINK_TOKEN, caps: this.hello.caps.filter((c) => COMPUTER_CAPS.includes(c)) };
        socket.send(encodeFrame(hello));
      },
      (err: unknown) => {
        this.opts.log?.(`machines: couldn't reach ${this.name}: ${err instanceof Error ? err.message : String(err)}`);
        this.retry();
      },
    );
  }

  private fromComputer(text: string): void {
    let frame: DaemonFrame;
    try {
      frame = parseDaemonFrame(text);
    } catch {
      return;
    }
    if (frame.t === 'welcome' || frame.t === 'snapshot') this.opts.states?.reset(this.machineId, frame.snapshot, frame.seq, frame.t === 'welcome' ? frame.version : undefined);
    else if (frame.t === 'action') this.opts.states?.apply(this.machineId, frame.seq, frame.action);
    if (frame.t === 'welcome') {
      this.attempt = 0;
      if (!this.welcomed) {
        this.welcomed = true;
        return this.toScreen(text);
      }
      // Back after a drop: the state as it is now, then what it showed.
      this.toScreen(encodeFrame({ t: 'snapshot', snapshot: frame.snapshot, seq: frame.seq }));
      for (const [term, flow] of this.terms) this.link?.send(encodeFrame({ t: 'term_attach', term, ...(flow ? { flow } : {}) }));
      if (this.attention) this.link?.send(this.attention);
      return;
    }
    if (frame.t === 'result') {
      const own = this.own.get(frame.id);
      if (own) {
        this.own.delete(frame.id);
        clearTimeout(own.timer);
        if (frame.ok) own.resolve(frame.value);
        else own.reject(new Error(frame.error ?? 'It failed'));
        return;
      }
      const method = this.inflight.get(frame.id);
      this.inflight.delete(frame.id);
      const range = this.ranges.get(frame.id);
      this.ranges.delete(frame.id);
      if (range && frame.ok && frame.value) this.opts.files?.put(this.machineId, range, frame.value as TextRange);
      if (frame.ok && method && MAKES_WORKTREE.has(method) && typeof frame.value === 'string') this.opts.onWorktree?.(this.machineId, frame.value);
    }
    if (frame.t === 'cap_call' && !(COMPUTER_CAPS.includes(frame.cap) && (frame.cap !== 'openExternal' || webUrl(frame.args[0])))) {
      const error = frame.cap === 'openExternal' ? 'Your app opens only web pages (http or https) for a computer' : `Your app doesn’t ${frame.cap} for a computer`;
      this.link?.send(encodeFrame({ t: 'cap_result', id: frame.id, ok: false, error }));
      return;
    }
    this.toScreen(text);
  }

  private fromScreen(text: string): void {
    const frame = parseClientFrame(text);
    if (!frame || frame.t === 'hello') return;
    if (frame.t === 'call' && frame.method === 'files.readRange' && this.opts.files) {
      void this.readRange(frame, text, this.opts.files);
      return;
    }
    this.pass(frame, text);
  }

  /**
   * A piece of a file (BLG-791): one fetched moments ago answers a `cache` read here, without the
   * round trip, and any kept one answers while the computer can't be reached (marked stale). Else it
   * goes on, and what comes back is kept.
   */
  private async readRange(frame: CallFrame, text: string, files: FileCache): Promise<void> {
    const ask = rangeAsk(frame.args);
    if (ask && !frame.id.startsWith(OWN_CALL)) {
      const hit = await files.get(this.machineId, ask.key).catch(() => undefined);
      const live = this.live;
      const now = this.opts.now?.() ?? Date.now();
      if (hit && (!live || (ask.cache && now - hit.at <= FRESH_MS))) {
        this.toScreen(encodeFrame({ t: 'result', id: frame.id, ok: true, value: live ? hit.value : { ...hit.value, stale: true } }));
        return;
      }
      if (live) this.ranges.set(frame.id, ask);
    }
    this.pass(frame, text);
  }

  private pass(frame: ScreenFrame, text: string): void {
    if (frame.t === 'term_attach') this.terms.set(frame.term, frame.flow === true);
    if (frame.t === 'term_detach') this.terms.delete(frame.term);
    if (frame.t === 'attention') this.attention = text;
    const link = this.link;
    if (!link?.isOpen || !this.welcomed) {
      if (frame.t === 'call') this.toScreen(encodeFrame({ t: 'result', id: frame.id, ok: false, error: `${this.name} can’t be reached right now; Beluga keeps trying` }));
      return;
    }
    if (frame.t === 'call') {
      // A screen's id can't pass for one of this app's own.
      if (frame.id.startsWith(OWN_CALL)) return this.toScreen(encodeFrame({ t: 'result', id: frame.id, ok: false, error: 'That call id is taken' }));
      this.inflight.set(frame.id, frame.method);
    }
    link.send(text);
  }

  /** The link is up and the computer said welcome. */
  get live(): boolean {
    return Boolean(this.link?.isOpen && this.welcomed);
  }

  /** One call of this app's own over the link; its answer stays here. */
  call(method: string, args: readonly unknown[]): Promise<unknown> {
    const link = this.link;
    if (!link?.isOpen || !this.welcomed) return Promise.reject(new Error(`${this.name} can’t be reached right now`));
    const id = `${OWN_CALL}${++this.ownSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        reject(new Error(`${this.name} didn’t answer in time`));
      }, OWN_CALL_MS);
      timer.unref();
      this.own.set(id, { resolve, reject, timer });
      link.send(encodeFrame({ t: 'call', id, method, args: [...args] }));
    });
  }

  private failOwn(error: string): void {
    for (const [id, own] of this.own) {
      clearTimeout(own.timer);
      own.reject(new Error(error));
      this.own.delete(id);
    }
  }

  private dropped(socket: MessageSocket, code: number): void {
    if (this.link !== socket) return;
    this.link = undefined;
    this.ranges.clear();
    for (const id of this.inflight.keys()) this.toScreen(encodeFrame({ t: 'result', id, ok: false, error: `The link to ${this.name} dropped before it answered; try again` }));
    this.inflight.clear();
    this.failOwn(`The link to ${this.name} dropped before it answered`);
    if (this.closed) return;
    if (FINAL.has(code)) return this.end(code, code === 4010 ? `${this.name} forgot this app, or this app forgot it` : code === 4004 ? `${this.name} speaks another version of Beluga` : `${this.name} turned this app away`);
    this.retry();
  }

  private retry(): void {
    if (this.closed) return;
    const wait = this.opts.backoffMs ?? BACKOFF_MS;
    const ms = wait[Math.min(this.attempt, wait.length - 1)]!;
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
    this.timer.unref();
  }

  private toScreen(text: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(text);
  }

  /** The screen closed (or must): the link goes too. */
  end(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.failOwn(`${this.name} closed`);
    this.link?.close(1000);
    this.link = undefined;
    if (code !== undefined && this.ws.readyState === this.ws.OPEN) this.ws.close(code, reason?.slice(0, 120));
    this.gone();
  }
}

