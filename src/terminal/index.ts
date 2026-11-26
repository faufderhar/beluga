/**
 * Embedded terminal engine. The program runs in a PTY in the core (pty-host.ts); each screen
 * keeps its own headless xterm (emulator.ts) fed with the raw bytes, exposed as `Line[]`.
 *
 *   const pty = manager.open('ws-1', { cwd, cols, rows });          // the core
 *   const term = new TerminalEmulator(localLink(pty), { id, cols, rows }); // a screen
 *   const off = term.onChange(() => rerender());
 *   const { lines, cursor } = term.snapshot(scrollOffset);
 */
export { TerminalEmulator, TerminalSession, SCROLLBACK_LINES, CHANGE_THROTTLE_MS, localLink } from './emulator.js';
export type { TerminalOptions, TerminalSnapshot, TerminalExit, PtyLink, EmulatorOptions } from './emulator.js';
export { TerminalManager, PtyProcess, BACKLOG_BYTES, type OpenOptions, type PtyExit, type PtyOptions } from './pty-host.js';
export { encodeKey, isLeaveChord, isLeaveKey, type InkKeyLike, type EncodeOptions } from './keys.js';
export { overlayCursor } from './render.js';
export { DEFAULT_PALETTE, buildColorTable } from './palette.js';
export { defaultShell, childEnv } from './pty.js';
export { listShells, scriptShell } from './shells.js';
export { installedMonoFonts, watchFontDirs } from './fonts.js';
