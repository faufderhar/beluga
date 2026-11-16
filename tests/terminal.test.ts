import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE,
  TerminalManager,
  TerminalSession,
  buildColorTable,
  childEnv,
  defaultShell,
  encodeKey,
  isLeaveChord,
  isLeaveKey,
  overlayCursor,
  type TerminalOptions,
} from '../src/terminal/index.js';
import { lineWidth, type Line } from '../src/ui/text.js';
import { waitFor } from './helpers.js';
import { posixSh } from '../src/terminal/pty.js';
import { BACKLOG_BYTES, PtyProcess } from '../src/terminal/pty-host.js';

/** sh, or Git Bash on Windows (ConPTY then carries it). */
const SH = posixSh() ?? '/bin/sh';

const open: TerminalSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.dispose();
});

function sh(script: string, extra: Partial<TerminalOptions> = {}): TerminalSession {
  const s = new TerminalSession({ id: 't', cwd: process.cwd(), cols: 40, rows: 8, shell: SH, args: ['-c', script], ...extra });
  open.push(s);
  return s;
}

/** An interactive /bin/sh with a fixed prompt. */
function interactive(extra: Partial<TerminalOptions> = {}): TerminalSession {
  return sh('', { args: [], env: { PS1: '$ ', ENV: '' }, ...extra });
}

const text = (line: Line | undefined): string => (line ?? []).map((s) => s.text).join('');
const screen = (s: TerminalSession, back = 0): string[] => s.snapshot(back).lines.map(text);
const waitText = (s: TerminalSession, needle: string, timeout = 5000) =>
  waitFor(() => screen(s).some((l) => l.includes(needle)), timeout);
const waitExit = (s: TerminalSession) => waitFor(() => s.exited, 5000);

describe('TerminalSession output', () => {
  it('shows program output and reports the exit code', async () => {
    const s = sh('printf "hello world"; exit 7');
    const exit = await waitExit(s);
    await waitText(s, 'hello world');
    expect(exit).toEqual({ code: 7 });
    expect(s.running).toBe(false);
    expect(s.snapshot().exited).toEqual({ code: 7 });
    expect(s.snapshot().cursor).toBeUndefined();
  });

  it('maps 16-color SGR through the palette and default colors to undefined', async () => {
    const palette = [...DEFAULT_PALETTE];
    palette[1] = '#aa0000';
    const s = sh(String.raw`printf '\033[31mred\033[0m plain \033[1;4;7mB\033[0m'; sleep 2`, { palette });
    await waitText(s, 'red plain B');
    const line = s.snapshot().lines[0] ?? [];
    // Each word by its run: Windows' console repaints the line and may carry a colour onto the space after a word (BLG-728).
    const run = (word: string) => {
      const found = line.find((x) => x.text.trim() === word);
      return found && { ...found, text: found.text.trim() };
    };
    expect(run('red')).toEqual({ text: 'red', color: '#aa0000' });
    expect(run('plain')).toEqual({ text: 'plain' });
    expect(run('B')).toEqual({ text: 'B', bold: true, underline: true, inverse: true });
  });

  it('maps truecolor and 256-color to hex', async () => {
    const s = sh(String.raw`printf '\033[38;2;1;2;3mX\033[48;5;196mY\033[0m\033[38;5;244mZ'; sleep 2`);
    await waitText(s, 'XYZ');
    const line = s.snapshot().lines[0] ?? [];
    expect(line[0]).toEqual({ text: 'X', color: '#010203' });
    expect(line[1]).toEqual({ text: 'Y', color: '#010203', bg: '#ff0000' });
    expect(line[2]).toEqual({ text: 'Z', color: '#808080' });
  });

  it('keeps wide characters one cell wide in the line model', async () => {
    const s = sh('printf "中文x🙂y"; sleep 2');
    await waitText(s, 'y');
    const line = s.snapshot().lines[0] ?? [];
    expect(text(line)).toBe('中文x🙂y');
    expect(lineWidth(line)).toBe(8);
  });

  it('exposes the cursor and hides it on DECTCEM', async () => {
    const s = sh(String.raw`printf 'ab\ncd'; sleep 0.3; printf '\033[?25l'; sleep 3`);
    await waitText(s, 'cd');
    expect(s.snapshot().cursor).toEqual({ x: 2, y: 1 });
    await waitFor(() => !s.snapshot().cursor, 3000);
  });

  it('exposes the OSC window title', async () => {
    const s = sh(String.raw`printf '\033]0;my title\007'; sleep 2`, { title: 'initial' });
    expect(s.title).toBe('initial');
    await waitFor(() => s.snapshot().title === 'my title');
  });

  it('scrolls back into history', async () => {
    const s = sh('seq 1 50', { rows: 10 });
    await waitExit(s);
    await waitText(s, '50');
    const snap = s.snapshot();
    expect(snap.scrollback).toBeGreaterThan(30);
    expect(snap.altScreen).toBe(false);
    const top = s.snapshot(10_000); // clamped
    expect(text(top.lines[0])).toBe('1');
    expect(top.lines).toHaveLength(10);
  });

  it('caches snapshots until something changes', async () => {
    const s = sh('printf x; sleep 2');
    await waitText(s, 'x');
    expect(s.snapshot()).toBe(s.snapshot());
    const before = s.snapshot();
    s.resize(30, 5);
    expect(s.snapshot()).not.toBe(before);
  });

  it('reports a spawn failure as an exit', async () => {
    const s = sh('true', { shell: '/definitely/not/a/shell' });
    const exit = await waitExit(s);
    expect(exit.code === null || exit.code !== 0).toBe(true);
  });
});

describe('TerminalSession input', () => {
  it('run() types a command and presses Enter', async () => {
    const s = interactive();
    s.run('echo $((6*7))');
    await waitText(s, '42');
    s.run('exit 3');
    expect(await waitExit(s)).toEqual({ code: 3 });
  });

  it('resize() reaches the program', async () => {
    const s = interactive({ cols: 40, rows: 8 });
    s.resize(50, 12);
    expect(s.size).toEqual({ cols: 50, rows: 12 });
    s.run('stty size');
    await waitText(s, '12 50');
    expect(s.snapshot().lines).toHaveLength(12);
  });

  it('paste() sends plain text with newlines as Enter', async () => {
    const s = interactive();
    s.paste('echo pasted-$((1+1))\n');
    await waitText(s, 'pasted-2');
  });

  // Windows' ConPTY keeps a program's "bracketed paste on" (ESC[?2004h) to itself, so it never reaches us there.
  it.skipIf(process.platform === 'win32')('paste() brackets the text when the program enables bracketed paste', async () => {
    const s = sh(String.raw`printf '\033[?2004h'; exec cat -v`);
    await waitFor(() => s.applicationCursor === false && s.running);
    await new Promise((r) => setTimeout(r, 200));
    s.paste('hi\n');
    await waitText(s, '^[[200~hi');
  });

  it('writeKey() encodes Ink keys', async () => {
    const s = interactive();
    // Typed once the shell is up (a busy CI machine starts it slowly; keys sent before can be lost).
    await waitText(s, '$');
    s.writeKey('e', {});
    s.writeKey('c', {});
    s.writeKey('h', {});
    s.writeKey('o', {});
    for (const ch of ' ok') s.writeKey(ch, {});
    s.writeKey('', { return: true });
    await waitFor(() => screen(s).some((l) => l.trim() === 'ok'), 5000);
  });

  it('notifies listeners, throttled, and supports unsubscribe', async () => {
    const s = sh('for i in 1 2 3 4 5; do echo $i; sleep 0.05; done; sleep 2');
    let calls = 0;
    const off = s.onChange(() => calls++);
    await waitText(s, '5');
    await waitFor(() => calls > 0);
    off();
    const seen = calls;
    s.resize(20, 4);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(seen);
  });

  it('kill() ends the program', async () => {
    const s = sh('sleep 30');
    await waitFor(() => s.running);
    s.kill();
    const exit = await waitExit(s);
    expect(exit.code === null || typeof exit.code === 'number').toBe(true);
    expect(s.running).toBe(false);
  });
});

describe('TerminalManager', () => {
  it('opens, reuses, lists and closes sessions', async () => {
    const m = new TerminalManager();
    const opts = { cwd: process.cwd(), cols: 20, rows: 5, shell: '/bin/sh', args: ['-c', 'sleep 30'] };
    const a = m.open('a', opts);
    expect(m.open('a', { ...opts, cols: 30 })).toBe(a);
    expect(a.size.cols).toBe(30);
    const b = m.open('b', opts);
    expect(m.get('b')).toBe(b);
    expect(m.list().map((s) => s.id)).toEqual(['a', 'b']);
    expect(m.close('a')).toBe(true);
    expect(m.close('a')).toBe(false);
    expect(m.get('a')).toBeUndefined();
    m.closeAll();
    expect(m.list()).toEqual([]);
  });
});

describe('encodeKey', () => {
  const cases: [string, string, Parameters<typeof encodeKey>[1], string][] = [
    ['plain text', 'a', {}, 'a'],
    ['multi-char input', 'hello', {}, 'hello'],
    ['enter', '', { return: true }, '\r'],
    ['meta+enter', '', { return: true, meta: true }, '\x1b\r'],
    ['backspace', '', { backspace: true }, '\x7f'],
    ['ctrl+backspace', '', { backspace: true, ctrl: true }, '\b'],
    ['meta+backspace', '', { backspace: true, meta: true }, '\x1b\x7f'],
    ['delete', '', { delete: true }, '\x1b[3~'],
    ['tab', '', { tab: true }, '\t'],
    ['shift+tab', '', { tab: true, shift: true }, '\x1b[Z'],
    ['escape', '', { escape: true }, '\x1b'],
    ['up', '', { upArrow: true }, '\x1b[A'],
    ['down', '', { downArrow: true }, '\x1b[B'],
    ['right', '', { rightArrow: true }, '\x1b[C'],
    ['left', '', { leftArrow: true }, '\x1b[D'],
    ['ctrl+left', '', { leftArrow: true, ctrl: true }, '\x1b[1;5D'],
    ['shift+up', '', { upArrow: true, shift: true }, '\x1b[1;2A'],
    ['meta+right', '', { rightArrow: true, meta: true }, '\x1b[1;3C'],
    ['home', '', { home: true }, '\x1b[H'],
    ['end', '', { end: true }, '\x1b[F'],
    ['page up', '', { pageUp: true }, '\x1b[5~'],
    ['page down', '', { pageDown: true }, '\x1b[6~'],
    ['shift+page down', '', { pageDown: true, shift: true }, '\x1b[6;2~'],
    ['ctrl+c', 'c', { ctrl: true }, '\x03'],
    ['ctrl+a', 'a', { ctrl: true }, '\x01'],
    ['ctrl+z', 'z', { ctrl: true }, '\x1a'],
    ['ctrl+space', ' ', { ctrl: true }, '\x00'],
    ['ctrl+[', '[', { ctrl: true }, '\x1b'],
    ['ctrl+_', '_', { ctrl: true }, '\x1f'],
    ['meta+b', 'b', { meta: true }, '\x1bb'],
    ['meta+ctrl+a', 'a', { meta: true, ctrl: true }, '\x1b\x01'],
  ];
  it.each(cases)('%s', (_name, input, key, expected) => {
    expect(encodeKey(input, key)).toBe(expected);
  });

  it('uses SS3 for cursor keys in application cursor mode', () => {
    expect(encodeKey('', { upArrow: true }, { applicationCursor: true })).toBe('\x1bOA');
    expect(encodeKey('', { home: true }, { applicationCursor: true })).toBe('\x1bOH');
    expect(encodeKey('', { upArrow: true, ctrl: true }, { applicationCursor: true })).toBe('\x1b[1;5A');
  });

  it('tracks application cursor mode from the program', async () => {
    const s = sh(String.raw`printf '\033[?1h'; sleep 2`);
    await waitFor(() => s.applicationCursor);
  });

  it('detects the leave chord', () => {
    expect(isLeaveChord('\x1d')).toBe(true);
    expect(isLeaveChord('\x1b[93;5u')).toBe(true);
    expect(isLeaveChord(']')).toBe(false);
    expect(isLeaveKey(']', { ctrl: true })).toBe(true);
    expect(isLeaveKey(']', {})).toBe(false);
  });
});

describe('helpers', () => {
  it('overlayCursor inverts the cell under the cursor', () => {
    expect(overlayCursor([{ text: 'abc', color: '#ffffff' }], 1)).toEqual([
      { text: 'a', color: '#ffffff' },
      { text: 'b', color: '#ffffff', inverse: true },
      { text: 'c', color: '#ffffff' },
    ]);
    expect(overlayCursor([{ text: 'ab' }], 4)).toEqual([{ text: 'ab' }, { text: '  ' }, { text: ' ', inverse: true }]);
    expect(overlayCursor([{ text: '中x' }], 2)).toEqual([{ text: '中' }, { text: 'x', inverse: true }]);
    expect(overlayCursor([], 0)).toEqual([{ text: ' ', inverse: true }]);
  });

  it('buildColorTable covers 256 colors and validates the palette', () => {
    const table = buildColorTable(['#ABCDEF', 'nope']);
    expect(table).toHaveLength(256);
    expect(table[0]).toBe('#abcdef');
    expect(table[1]).toBe(DEFAULT_PALETTE[1]);
    expect(table[16]).toBe('#000000');
    expect(table[231]).toBe('#ffffff');
    expect(table[232]).toBe('#080808');
    expect(table[255]).toBe('#eeeeee');
  });

  it('childEnv sets TERM/COLORTERM and drops outer-terminal variables', () => {
    const env = childEnv({ FOO: 'bar' }, { PATH: '/bin', COLUMNS: '80', CLAUDECODE: '1', TERM: 'screen', UNDEF: undefined });
    expect(env).toEqual({ PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'beluga', FOO: 'bar' });
  });

  // Not on Windows: Windows picks PowerShell (tests/platform-shells.test.ts).
  it.skipIf(process.platform === 'win32')('defaultShell prefers $SHELL when it exists', () => {
    expect(defaultShell({ SHELL: '/bin/sh' })).toBe('/bin/sh');
    expect(defaultShell({ SHELL: '/nope/zsh' })).not.toBe('/nope/zsh');
  });
});

describe('PtyProcess backlog cap', () => {
  it('caps a single oversized chunk to BACKLOG_BYTES without splitting a surrogate pair, while streaming the whole chunk live', () => {
    const p = new PtyProcess({ id: 'cap', cwd: process.cwd(), cols: 80, rows: 24, shell: SH, args: ['-c', 'true'] });
    try {
      const live: string[] = [];
      p.onData((d) => live.push(d));
      const emit = (d: string) => (p as unknown as { emit: (s: string) => void }).emit(d);
      const huge = 'a'.repeat(BACKLOG_BYTES * 2);
      emit(huge);
      expect(live.at(-1)?.length).toBe(BACKLOG_BYTES * 2);
      expect(p.backlog().length).toBe(BACKLOG_BYTES);

      // Put a surrogate pair ('🙂' = 2 UTF-16 code units) straddling the -BACKLOG_BYTES cut.
      const straddling = `xxxx🙂${'b'.repeat(BACKLOG_BYTES - 1)}`;
      emit(straddling);
      const tail = p.backlog();
      expect(tail.length).toBe(BACKLOG_BYTES - 1);
      expect(/^[\uDC00-\uDFFF]/.test(tail)).toBe(false);
    } finally {
      p.dispose();
    }
  });
});
