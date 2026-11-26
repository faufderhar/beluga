/**
 * A screen's own copy of a terminal: a headless xterm fed with the program's raw bytes,
 * exposed as Beluga `Line[]` snapshots. The program itself runs in the daemon (pty-host.ts);
 * a PtyLink carries bytes both ways, so this works in the same process or over a socket.
 */
import path from 'node:path';
import xtermHeadless, { type IBufferCell, type IDisposable, type Terminal as XTerminal } from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import type { Line } from '../shared/text.js';
import { encodeKey, type InkKeyLike } from './keys.js';
import { buildColorTable } from './palette.js';
import { defaultShell } from './pty.js';
import { type OpenOptions, type PtyExit, PtyProcess } from './pty-host.js';
import { LineRenderer } from './render.js';

// Both packages are CommonJS; Node's ESM loader only exposes `default`.
const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;

export const SCROLLBACK_LINES = 2000;
/** Minimum gap between change notifications (~30fps). */
export const CHANGE_THROTTLE_MS = 33;

/** The program's end of a terminal, as a screen sees it. */
export interface PtyLink {
  /** Send input. `reply`: an answer the emulator gives to the program's own query (cursor position…). */
  write(data: string, reply?: boolean): void;
  resize(cols: number, rows: number): void;
  /** The program's output: what it wrote lately first, then as it comes. */
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: PtyExit) => void): () => void;
  readonly running: boolean;
  readonly exited?: PtyExit;
  /** Stop listening (the program keeps running). */
  close?(): void;
  /** The screen drew this many more characters of the output (flow control, BLG-963; see flow.ts). */
  ack?(chars: number): void;
}

export interface AttachOptions {
  /** This screen acks what it draws (`ack`), and the program waits while it's far behind. */
  readonly flow?: boolean;
}

export type TerminalExit = PtyExit;

export interface EmulatorOptions {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
  /** 16 `#rrggbb` colors for ANSI 0-15. */
  readonly palette?: readonly string[];
  /** Initial title, until the program sets one (OSC 0/2). */
  readonly title?: string;
}

export interface TerminalSnapshot {
  /** One entry per viewport row (`rows` long). Lines are right-trimmed. */
  readonly lines: readonly Line[];
  /** Cursor cell in viewport coordinates; absent when hidden, exited or scrolled off. */
  readonly cursor?: { readonly x: number; readonly y: number };
  readonly title: string;
  readonly exited?: TerminalExit;
  /** How many lines can be scrolled back right now (max useful `scrollBack`). */
  readonly scrollback: number;
  /** The program is on the alternate screen (vim, htop, less...): no scrollback there. */
  readonly altScreen: boolean;
}

const clampSize = (n: number): number => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

export class TerminalEmulator {
  readonly id: string;

  private readonly term: XTerminal;
  private readonly renderer: LineRenderer;
  private readonly cell: IBufferCell;
  private readonly listeners = new Set<() => void>();
  private readonly disposables: IDisposable[] = [];
  private readonly unlink: Array<() => void> = [];
  private cols: number;
  private rows: number;
  private titleText: string;
  private cursorHidden = false;
  private version = 0;
  private cache: { version: number; back: number; exited: PtyExit | undefined; snap: TerminalSnapshot } | undefined;
  private lastNotify = 0;
  private notifyTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly link: PtyLink, opts: EmulatorOptions) {
    this.id = opts.id;
    this.cols = clampSize(opts.cols);
    this.rows = clampSize(opts.rows);
    this.titleText = opts.title ?? '';
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.renderer = new LineRenderer(buildColorTable(opts.palette));
    this.cell = this.term.buffer.active.getNullCell();
    this.watchTerminal();
    this.unlink.push(
      link.onData((d) => {
        if (!this.disposed) this.term.write(d);
      }),
      link.onExit(() => this.changed()),
    );
  }

  get running(): boolean {
    return this.link.running;
  }

  get title(): string {
    return this.titleText;
  }

  get exited(): TerminalExit | undefined {
    return this.link.exited;
  }

  /** DECCKM state, for `encodeKey`. */
  get applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  private watchTerminal(): void {
    const parser = this.term.parser;
    // DECTCEM (CSI ? 25 h/l): xterm's public API doesn't expose cursor visibility.
    const trackCursor = (visible: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.cursorHidden = !visible;
      return false; // let xterm handle the mode too
    };
    this.disposables.push(
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackCursor(true)),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackCursor(false)),
      parser.registerEscHandler({ final: 'c' }, () => {
        this.cursorHidden = false; // RIS (full reset)
        return false;
      }),
      this.term.onWriteParsed(() => this.changed()),
      this.term.onTitleChange((t) => {
        this.titleText = t;
        this.changed();
      }),
      // Answers to queries (cursor position, device attributes) go back to the program.
      this.term.onData((d) => this.link.write(d, true)),
    );
  }

  /** Raw input bytes (keyboard). Ignored once the program has exited. */
  write(data: string): void {
    if (data && this.link.running) this.link.write(data);
  }

  /** Fallback for Ink's parsed keys; see `encodeKey`. */
  writeKey(input: string, key: InkKeyLike): void {
    this.write(encodeKey(input, key, { applicationCursor: this.applicationCursor }));
  }

  /** Paste text, bracketed if the program asked for it (CSI ? 2004 h). */
  paste(text: string): void {
    const body = text.replace(/\r?\n/g, '\r');
    if (!this.term.modes.bracketedPasteMode) return this.write(body);
    // Strip any embedded end marker so pasted text can't break out of the bracket.
    this.write(`\x1b[200~${body.replaceAll('\x1b[201~', '')}\x1b[201~`);
  }

  /** Type a command line and press Enter. */
  run(command: string): void {
    this.write(`${command}\r`);
  }

  resize(cols: number, rows: number): void {
    const c = clampSize(cols);
    const r = clampSize(rows);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    this.term.resize(c, r);
    this.link.resize(c, r);
    this.changed();
  }

  /**
   * The viewport, `scrollBack` lines up from the live screen (clamped to the
   * available scrollback). Cached until the screen changes.
   */
  snapshot(scrollBack = 0): TerminalSnapshot {
    const buf = this.term.buffer.active;
    const back = Math.max(0, Math.min(Math.floor(scrollBack) || 0, buf.baseY));
    if (this.cache && this.cache.version === this.version && this.cache.back === back && this.cache.exited === this.link.exited) return this.cache.snap;
    const top = buf.baseY - back;
    const lines: Line[] = [];
    for (let y = 0; y < this.rows; y++) lines.push(this.renderer.render(buf.getLine(top + y), this.cols, this.cell));
    const cy = buf.cursorY + back;
    const exited = this.link.exited;
    const showCursor = !this.cursorHidden && !exited && cy < this.rows;
    const snap: TerminalSnapshot = {
      lines,
      ...(showCursor ? { cursor: { x: Math.min(buf.cursorX, this.cols - 1), y: cy } } : {}),
      title: this.titleText,
      ...(exited ? { exited } : {}),
      scrollback: buf.baseY,
      altScreen: buf.type === 'alternate',
    };
    this.cache = { version: this.version, back, exited, snap };
    return snap;
  }

  /** Subscribe to screen changes (throttled to ~30fps). Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.version++;
    if (this.disposed || this.notifyTimer) return;
    const wait = this.lastNotify + CHANGE_THROTTLE_MS - Date.now();
    if (wait <= 0) return this.notify();
    this.notifyTimer = setTimeout(() => this.notify(), wait);
    this.notifyTimer.unref?.();
  }

  private notify(): void {
    this.notifyTimer = undefined;
    this.lastNotify = Date.now();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A broken listener must not stop the others (or the PTY pump).
      }
    }
  }

  /** Stop showing it and free the emulator (the program keeps running). Unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unlink.splice(0)) off();
    this.link.close?.();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.listeners.clear();
    for (const d of this.disposables) d.dispose();
    this.term.dispose();
  }
}

/** A link to a program in this same process (an in-process core, e.g. tests). */
export function localLink(pty: PtyProcess): PtyLink {
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    onData: (listener) => {
      const backlog = pty.replay();
      if (backlog) listener(backlog);
      return pty.onData(listener);
    },
    onExit: (listener) => pty.onExit(listener),
    get running() {
      return pty.running;
    },
    get exited() {
      return pty.exited;
    },
  };
}

export interface TerminalOptions extends OpenOptions {
  readonly id: string;
  /** 16 `#rrggbb` colors for ANSI 0-15. */
  readonly palette?: readonly string[];
}

/** A program in a PTY with an emulator showing it, in one object (for tests and simple uses). */
export class TerminalSession extends TerminalEmulator {
  readonly pty: PtyProcess;

  constructor(opts: TerminalOptions) {
    const pty = new PtyProcess(opts);
    super(localLink(pty), { id: opts.id, cols: opts.cols, rows: opts.rows, title: opts.title ?? path.basename(opts.shell ?? defaultShell()), ...(opts.palette ? { palette: opts.palette } : {}) });
    this.pty = pty;
  }

  get cwd(): string {
    return this.pty.cwd;
  }

  get shell(): string {
    return this.pty.shell;
  }

  /** Hang up the program (SIGHUP). The screen stays readable. */
  kill(): void {
    this.pty.kill();
  }

  override dispose(): void {
    super.dispose();
    this.pty.dispose();
  }
}
