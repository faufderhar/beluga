import { realpathSync } from 'node:fs';
import type { DomainState } from '../core/store.js';
import { githubId, globalShellId, globalShellNumber, isGlobalShell, runId, setupId, shellId, terminalLabel } from '../shared/terminal-keys.js';
import type { PtyProcess, TerminalManager } from '../terminal/pty-host.js';
import { TERM_COALESCE_MS, TERM_PIECE, type MacFrame, type TerminalView } from './protocol.js';

/**
 * A worktree's terminals on the phone (BLG-42): the very sessions the Mac's terminal dock shows,
 * not copies. The daemon runs one PTY per session (terminal/pty-host.ts); the Mac app attaches to
 * it over its local socket (`term_*` frames, daemon/server.ts), the phone over the companion link
 * (here). Both see the same output as it comes, and either can type.
 *
 * - **Size**: the session keeps the Mac's size. The phone never resizes it (that would reflow the
 *   Mac's screen under you); it's told the size (`term_status`, again when the Mac resizes) and
 *   draws that grid, fitted or zoomed.
 * - **Battery**: output is coalesced to one frame per TERM_COALESCE_MS (about 30 a second) and sent
 *   only while the phone's terminal screen is open (`term_attach` … `term_detach`).
 * - **Which**: only terminals of a worktree or chat folder you have (its shell, setup and run, and
 *   shells started in its folder); never anything else by key.
 * - **Logged**: who attached, and how much they typed (never what).
 */

type Ws = DomainState['projects'][number]['workspaces'][number];

/** The workspace a `conv:ws:<id>` topic is (a worktree or a chat folder of yours, not archived). */
export function workspaceOf(state: DomainState, topic: string): Ws {
  const id = topic.startsWith('conv:ws:') ? topic.slice('conv:ws:'.length) : '';
  const ws = id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  if (!ws || ws.archived || !ws.path || ws.pending) throw new Error('That worktree isn’t on your Mac any more');
  return ws;
}

const realOf = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** The terminal keys of a workspace: its shell, setup, run and GitHub step while they exist, and shells started in its folder. */
export function keysOf(state: DomainState, terminals: TerminalManager | undefined, ws: Ws): string[] {
  const own = [shellId(ws.id), setupId(ws.id), runId(ws.id), githubId(ws.id)].filter((k) => k in state.terminals);
  const dir = realOf(ws.path);
  const extra = (terminals?.list() ?? [])
    .filter((p) => isGlobalShell(p.id) && p.id in state.terminals && realOf(p.cwd) === dir)
    .map((p) => p.id)
    .sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  return [...own, ...extra];
}

/** Is `key` a terminal of any workspace you have (what a phone may attach to and type in)? */
export function isWorkspaceTerminal(state: DomainState, terminals: TerminalManager | undefined, key: string): boolean {
  for (const ws of state.projects.flatMap((p) => p.workspaces)) {
    if (ws.archived || !ws.path) continue;
    if (key === shellId(ws.id) || key === setupId(ws.id) || key === runId(ws.id) || key === githubId(ws.id)) return key in state.terminals;
  }
  if (!isGlobalShell(key) || !(key in state.terminals)) return false;
  const pty = terminals?.get(key);
  if (!pty) return false;
  const dir = realOf(pty.cwd);
  return state.projects.some((p) => p.workspaces.some((w) => !w.archived && w.path && realOf(w.path) === dir));
}

export function terminalView(state: DomainState, terminals: TerminalManager | undefined, key: string): TerminalView {
  const pty = terminals?.get(key);
  const size = pty?.size ?? { cols: 120, rows: 30 };
  const exit = state.termExits[key];
  return { key, label: terminalLabel(key, state.termNames).slice(0, 80), running: Boolean(pty?.running) && !(key in state.termExits), ...(key in state.termExits ? { exit: exit ?? null } : {}), cols: size.cols, rows: size.rows };
}

/** The next free Shell N (numbered after every open one, as the Mac's + does). */
export function nextShellKey(state: DomainState): string {
  const used = Object.keys(state.terminals).filter(isGlobalShell).map(globalShellNumber);
  return globalShellId(Math.max(0, ...used) + 1);
}

interface Attached {
  readonly pty: PtyProcess;
  readonly offs: Array<() => void>;
  buffered: string[];
  timer?: NodeJS.Timeout;
  typed: number;
}

/**
 * The terminals one linked phone has on screen: what each wrote lately, then its output coalesced
 * to about 30 frames a second, how it ended, its size when the Mac changes it; and the phone's keys
 * into the same session.
 */
export class TermRelay {
  private readonly attached = new Map<string, Attached>();

  constructor(
    private readonly deps: {
      readonly terminals: () => TerminalManager | undefined;
      readonly allowed: (key: string) => boolean;
      readonly send: (frame: MacFrame) => void;
      readonly log: (line: string) => void;
      readonly who: string;
      readonly coalesceMs?: number;
    },
  ) {}

  get size(): number {
    return this.attached.size;
  }

  attach(key: string): void {
    this.detach(key, true);
    const pty = this.deps.allowed(key) ? this.deps.terminals()?.get(key) : undefined;
    if (!pty) {
      this.deps.send({ t: 'term_status', term: key, running: false, exit: null, cols: 80, rows: 24, gone: true });
      return;
    }
    const a: Attached = { pty, offs: [], buffered: [], typed: 0 };
    this.attached.set(key, a);
    this.deps.log(`${this.deps.who} opened the terminal ${key} (shared with the Mac)`);
    this.status(key, pty);
    // What's on screen now: what it wrote lately, from a clean screen.
    const backlog = pty.replay();
    if (backlog) this.pieces(key, backlog, true);
    else this.deps.send({ t: 'term_data', term: key, data: '', reset: true });
    a.offs.push(
      pty.onData((d) => this.queue(key, a, d)),
      pty.onExit(() => {
        this.flush(key, a);
        this.status(key, pty);
      }),
      pty.onResize(() => this.status(key, pty)),
    );
  }

  /** Keys typed on the phone, into the session the Mac shows too. */
  input(key: string, data: string): void {
    const a = this.attached.get(key);
    if (!a || !this.deps.allowed(key)) return;
    a.typed += data.length;
    a.pty.write(data);
  }

  detach(key: string, quiet = false): void {
    const a = this.attached.get(key);
    if (!a) return;
    this.attached.delete(key);
    clearTimeout(a.timer);
    for (const off of a.offs) off();
    if (!quiet || a.typed) this.deps.log(`${this.deps.who} left the terminal ${key}${a.typed ? ` (typed ${a.typed} characters)` : ''}`);
  }

  closeAll(): void {
    for (const key of [...this.attached.keys()]) this.detach(key);
  }

  private status(key: string, pty: PtyProcess): void {
    const { cols, rows } = pty.size;
    this.deps.send({ t: 'term_status', term: key, running: pty.running, ...(pty.exited ? { exit: pty.exited.code } : {}), cols, rows });
  }

  private queue(key: string, a: Attached, data: string): void {
    a.buffered.push(data);
    if (a.timer) return;
    a.timer = setTimeout(() => this.flush(key, a), this.deps.coalesceMs ?? TERM_COALESCE_MS);
    a.timer.unref?.();
  }

  private flush(key: string, a: Attached): void {
    clearTimeout(a.timer);
    a.timer = undefined;
    if (this.attached.get(key) !== a || !a.buffered.length) return;
    const data = a.buffered.join('');
    a.buffered = [];
    this.pieces(key, data, false);
  }

  /** Output in pieces that fit a frame (escape sequences grow in JSON), the first one resetting the screen when asked. */
  private pieces(key: string, data: string, reset: boolean): void {
    const step = Math.floor(TERM_PIECE / 2);
    for (let at = 0; at < data.length; at += step) {
      let end = Math.min(data.length, at + step);
      // Never split a surrogate pair.
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
      this.deps.send({ t: 'term_data', term: key, data: data.slice(at, end), ...(reset && at === 0 ? { reset: true } : {}) });
      at = end - step;
    }
  }
}
