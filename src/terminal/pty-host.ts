/**
 * The daemon side of a terminal: a program running in a PTY, with the last bytes it wrote
 * kept so a screen that attaches later (or a second one) can draw what's there. Screens keep
 * their own emulator (see emulator.ts) fed with the raw bytes.
 */
import path from 'node:path';
import { takesLoginFlag } from '../shared/shells.js';
import { childEnv, defaultShell, spawnPty, type IPty } from './pty.js';

/** Bytes kept for screens that attach later. */
export const BACKLOG_BYTES = 256 * 1024;

export interface PtyOptions {
  readonly id: string;
  readonly cwd: string;
  /** Program to run. Default: `$SHELL`, else /bin/zsh, else /bin/sh. */
  readonly shell?: string;
  /** Arguments. Default: `['-l']` (login shell; a PTY makes it interactive), none for PowerShell and cmd. */
  readonly args?: readonly string[];
  /** Extra environment, applied over ours (TERM/COLORTERM are set already). */
  readonly env?: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  /** Title until the program sets one. Default: the shell's name. */
  readonly title?: string;
}

export interface PtyExit {
  /** Exit code, or null when killed by a signal / the spawn failed. */
  readonly code: number | null;
  readonly signal?: number;
}

const clampSize = (n: number): number => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

/** One program in a PTY. */
export class PtyProcess {
  readonly id: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  private pty: IPty | undefined;
  private cols: number;
  private rows: number;
  private exitInfo: PtyExit | undefined;
  private chunks: string[] = [];
  private kept = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exit: PtyExit) => void>();
  private readonly resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
  private disposed = false;
  private lastOut = Date.now();

  constructor(opts: PtyOptions) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.cols = clampSize(opts.cols);
    this.rows = clampSize(opts.rows);
    this.shell = opts.shell ?? defaultShell();
    this.title = opts.title ?? path.basename(this.shell);
    this.start(opts);
  }

  get running(): boolean {
    return this.pty !== undefined;
  }

  get exited(): PtyExit | undefined {
    return this.exitInfo;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** The program's process id while it runs. */
  get pid(): number | undefined {
    return this.pty?.pid;
  }

  /** When it last wrote anything (or started). */
  get lastOutputAt(): number {
    return this.lastOut;
  }

  /** How many are following its output now (screens showing it). */
  get watchers(): number {
    return this.dataListeners.size;
  }

  private start(opts: PtyOptions): void {
    try {
      const pty = spawnPty({ file: this.shell, args: opts.args ?? (takesLoginFlag(this.shell) ? ['-l'] : []), cwd: opts.cwd, env: childEnv(opts.env), cols: this.cols, rows: this.rows });
      this.pty = pty;
      pty.onData((d) => this.emit(d));
      pty.onExit(({ exitCode, signal }) => this.finish(signal ? { code: null, signal } : { code: exitCode }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(`\x1b[31mCould not start ${this.shell}: ${message}\x1b[0m\r\n`);
      this.finish({ code: null });
    }
  }

  private emit(data: string): void {
    if (this.disposed) return;
    this.lastOut = Date.now();
    let slice = data.length > BACKLOG_BYTES ? data.slice(-BACKLOG_BYTES) : data;
    // Never start a sliced chunk in the middle of a surrogate pair.
    if (slice.length < data.length && /^[\uDC00-\uDFFF]/.test(slice)) slice = slice.slice(1);
    this.chunks.push(slice);
    this.kept += slice.length;
    while (this.kept > BACKLOG_BYTES && this.chunks.length > 1) this.kept -= this.chunks.shift()!.length;
    for (const l of [...this.dataListeners]) l(data);
  }

  private finish(exit: PtyExit): void {
    this.pty = undefined;
    this.exitInfo = exit;
    for (const l of [...this.exitListeners]) l(exit);
  }

  /** What it wrote lately (up to BACKLOG_BYTES), for a screen attaching now. */
  backlog(): string {
    return this.chunks.join('');
  }

  /** Input bytes (keyboard). Ignored once the program has exited. */
  write(data: string): void {
    if (data) this.pty?.write(data);
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
    try {
      this.pty?.resize(c, r);
    } catch {
      // The process may have exited between the check and the call.
    }
    for (const l of [...this.resizeListeners]) l({ cols: c, rows: r });
  }

  /** Called with its new size whenever a screen resizes it (the phone draws the Mac's grid). */
  onResize(listener: (size: { cols: number; rows: number }) => void): () => void {
    this.resizeListeners.add(listener);
    return () => void this.resizeListeners.delete(listener);
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => void this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => void this.exitListeners.delete(listener);
  }

  /** Hang up the program (SIGHUP). */
  kill(): void {
    try {
      this.pty?.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kill the program and forget it. */
  dispose(): void {
    if (this.disposed) return;
    this.kill();
    this.disposed = true;
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.resizeListeners.clear();
    this.chunks = [];
  }
}

export type OpenOptions = Omit<PtyOptions, 'id'>;

/** Keeps terminal programs alive by id (e.g. one shell per workspace). */
export class TerminalManager {
  private readonly sessions = new Map<string, PtyProcess>();
  private readonly openListeners = new Set<(pty: PtyProcess) => void>();

  /**
   * Get the program for `id`, starting it if needed. An existing one is returned as is
   * (resized to the given size), even if it exited; `close` it first to start fresh.
   */
  open(id: string, opts: OpenOptions): PtyProcess {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.resize(opts.cols, opts.rows);
      return existing;
    }
    const pty = new PtyProcess({ ...opts, id });
    this.sessions.set(id, pty);
    for (const l of [...this.openListeners]) l(pty);
    return pty;
  }

  get(id: string): PtyProcess | undefined {
    return this.sessions.get(id);
  }

  list(): PtyProcess[] {
    return [...this.sessions.values()];
  }

  /** Called with every program started from now on. */
  onOpen(listener: (pty: PtyProcess) => void): () => void {
    this.openListeners.add(listener);
    return () => void this.openListeners.delete(listener);
  }

  /** Kill and forget a program. Returns false when there was none. */
  close(id: string): boolean {
    const pty = this.sessions.get(id);
    if (!pty) return false;
    this.sessions.delete(id);
    pty.dispose();
    return true;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
