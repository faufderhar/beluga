import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CompanionClient, pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { FolderView, type MacFrame, TerminalView, TerminalsView } from '../src/companion/protocol.js';
import { attachCompanion } from '../src/companion/registry.js';
import { runAsClient } from '../src/core/client-context.js';
import { Store, initialState } from '../src/core/store.js';
import { DaemonServer } from '../src/daemon/server.js';
import { type Method, parseArgs } from '../src/ipc/api.js';
import { COMPANION_HANDLERS } from '../src/ipc/companion-handlers.js';
import { SocketClient } from '../src/ipc/socket-client.js';
import { generateIdentity } from '../src/net/crypto.js';
import { globalShellId, isGlobalShell } from '../src/shared/terminal-keys.js';
import { type PtyProcess, TerminalManager } from '../src/terminal/pty-host.js';
import { waitFor } from './helpers.js';
import { posixSh } from '../src/terminal/pty.js';

/**
 * A worktree's terminal on the phone (BLG-42), over the real companion link on a local testnet:
 * the phone opens the worktree's shell, streams it and types into it, and it's the very session
 * the Mac's screen (attached to the daemon over its socket) sees: same output, either can type.
 */

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** An interactive sh (Git Bash on Windows) with a fixed prompt, so output is predictable. */
const SHELL = { shell: posixSh() ?? '/bin/sh', args: ['-i'], env: { PS1: '$ ', ENV: '' } };

async function setup() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-companion-term-')));
  const wt = path.join(dir, 'wt');
  mkdirSync(path.join(wt, 'src'), { recursive: true });
  writeFileSync(path.join(wt, 'src', 'app.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(wt, '.env'), 'TOKEN=sekrit\n');
  const identity = generateIdentity();
  const store = new Store(initialState('test room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'landing', root: dir, base: 'main', workspaces: [{ id: 'w1', projectRoot: dir, projectId: 'p1', name: 'auth', path: wt, kind: 'worktree', branch: 'beluga/auth', createdAt: 1, external: false }] }] as never });
  const terminals = new TerminalManager();
  // Every shell started, closed ones too: closing forgets a shell before it has exited.
  const started: PtyProcess[] = [];
  terminals.onOpen((p) => started.push(p));
  const macCalls: string[] = [];
  // The daemon's terminals API, as handlers.ts runs it through the workbench (a shell per worktree, at the Mac's size).
  const open = (key: string, cwd: string) => {
    const pty = terminals.open(key, { cwd, cols: 100, rows: 30, ...SHELL });
    store.dispatch({ type: 'terminal', id: key, title: pty.title });
    return pty.id;
  };
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const logs: string[] = [];
  const session = {};
  const host = new CompanionHost({
    identity,
    store,
    devices,
    terminals,
    termCoalesceMs: 20,
    call: async (client, method, args) => {
      macCalls.push(method);
      try {
        if (method.startsWith('companion.')) {
          const handler = COMPANION_HANDLERS[method as keyof typeof COMPANION_HANDLERS] as (s: object, ...a: unknown[]) => unknown;
          const parsed = parseArgs(method as Method, args) as unknown[];
          return { ok: true, value: await runAsClient(client, () => handler(session, ...parsed)) };
        }
        if (method === 'terminals.shell') return { ok: true, value: open(String(args[0]), wt) };
        if (method === 'terminals.global') return { ok: true, value: open(String(args[0]), String(args[1])) };
        if (method === 'terminals.close') {
          terminals.close(String(args[0]));
          store.dispatch({ type: 'terminal', id: String(args[0]) });
          return { ok: true };
        }
        return { ok: false, error: `unexpected ${method}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    macName: () => 'Kayra’s Mac',
    version: '0.15.0',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
    log: (line) => logs.push(line),
  });
  attachCompanion(session, host);
  cleanup.push(async () => {
    await host.stop();
    // The shells end first, and are all waited for, the ones the test closed too (closing forgets
    // them at once): Windows holds a shell's folder until it has really exited, and a moment after
    // (BLG-728). One closed already is never killed again: a second kill of a disposed pty can crash
    // the worker there.
    const live = new Set(terminals.list());
    for (const p of started) if (live.has(p) && !p.exited) p.kill();
    await waitFor(() => started.every((p) => p.exited), 10_000).catch(() => undefined);
    terminals.closeAll();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      // A temp folder Windows still holds (a closed shell still exiting) is left for it to clear, never a failed test.
      if (process.platform !== 'win32') throw err;
    }
  });
  await host.start();

  // Pair a phone and link it.
  const info = await host.pairStart();
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const keys = deviceKeys(newSeed());
  const paired = pairDevice(node, info.link, { keys, name: 'Pixel 9', platform: 'android', app: '1.0.0' }, { timeoutMs: 20_000 });
  await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
  host.pairApprove();
  const result = await paired;
  const phone = new CompanionClient({ node, address: result.address, link: keys.link, app: '1.0.0', platform: 'android' });
  cleanup.push(() => phone.close());
  await phone.connect();

  // The Mac app: a screen attached to the daemon over its local socket, as the terminal dock is.
  const token = 'a'.repeat(32);
  const fakeSession = { store, intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
  const daemon = new DaemonServer({ session: fakeSession as never, token, version: '0.15.0', terminals });
  const port = await daemon.listen();
  cleanup.push(() => daemon.close());
  const macApp = await SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind: 'test', version: '0.15.0' });
  cleanup.push(() => macApp.close());
  return { host, store, terminals, phone, macApp, wt, logs, macCalls };
}

const outputOf = (frames: MacFrame[], term: string): string =>
  frames
    .filter((f): f is Extract<MacFrame, { t: 'term_data' }> => f.t === 'term_data' && f.term === term)
    .map((f) => f.data)
    .join('');

describe('the phone’s terminal page', () => {
  it('is self-contained (xterm.js inline, nothing fetched) and its scripts parse', async () => {
    // The app's own file (not type-checked here: it's the app's, with the app's settings).
    const page = '../packages/companion/lib/terminal/page.ts';
    const { terminalPage } = (await import(page)) as { terminalPage: (o: { scheme: 'light' | 'dark'; cols: number; rows: number }) => string };
    const html = terminalPage({ scheme: 'dark', cols: 80, rows: 24 });
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import/i);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(scripts[1]).toContain('"cols":80');
    // Its font is inline too (BLG-108): JetBrains Mono, regular and bold, no ligatures.
    expect(html).toMatch(/@font-face\{font-family:'JetBrains Mono';font-style:normal;font-weight:400;[^}]*src:url\(data:font\/woff2;base64,/);
    expect(html).toContain('font-weight:700');
    expect(html).toContain('font-variant-ligatures:none');
    expect(scripts[1]).toContain('"size":13');
    // Box drawing, blocks and braille lined up by the WebGL renderer (bundled, with a DOM fallback).
    expect(scripts[0]).toContain('window.WebglAddon={WebglAddon:');
    expect(scripts[1]).toContain('new w.WebglAddon.WebglAddon()');
    expect(terminalPage({ scheme: 'light', cols: 80, rows: 24, font: 'fit' } as never)).toContain('"size":"fit"');
  });
});

describe('the phone terminal’s text size (BLG-108)', () => {
  type Zoom = typeof import('../packages/companion/lib/terminal/zoom.js');
  const load = async () => (await import('../packages/companion/lib/terminal/zoom.ts' as string)) as Zoom;

  it('keeps a pinch or A−/A+ between 8 and 24 px, to the half pixel', async () => {
    const { clampFont, stepFont, FONT_MIN, FONT_MAX } = await load();
    expect([FONT_MIN, FONT_MAX]).toEqual([8, 24]);
    expect(clampFont(3)).toBe(8);
    expect(clampFont(99)).toBe(24);
    expect(clampFont(13.3)).toBe(13.5);
    expect(clampFont(Number.NaN)).toBe(13);
    expect(stepFont(13, 1)).toBe(14);
    expect(stepFont(12.5, -1)).toBe(12);
    expect(stepFont(8, -1)).toBe(8);
    expect(stepFont(24, 1)).toBe(24);
    // From a tiny fitted size, A+ goes to the smallest readable one.
    expect(stepFont(4.5, 1)).toBe(8);
  });

  it('reads what was kept safely: a size, fit, or the readable default', async () => {
    const { readFont } = await load();
    expect(readFont(16)).toBe(16);
    expect(readFont(40)).toBe(24);
    expect(readFont('fit')).toBe('fit');
    expect(readFont(undefined)).toBe(13);
    expect(readFont('big')).toBe(13);
  });

  it('fits the Mac’s columns to the width, never past the largest size or below a floor', async () => {
    const { fitFont, PAD } = await load();
    // 80 columns of JetBrains Mono (0.6 em) in a 390 px phone: about 7.9 px.
    const s = fitFont(390, 80, 0.6);
    expect(s).toBeCloseTo(7.75, 2);
    expect(80 * 0.6 * s).toBeLessThanOrEqual(390 - PAD * 2);
    expect(fitFont(390, 20, 0.6)).toBe(24);
    expect(fitFont(390, 400, 0.6)).toBe(4);
    expect(fitFont(390, 80, 0)).toBe(s);
  });
});

describe('a worktree’s terminal on the phone, shared with the Mac', () => {
  it('opens the worktree’s shell, streams it, and both screens see and type into the same session', async () => {
    const { phone, macApp, terminals, logs } = await setup();
    const frames: MacFrame[] = [];
    phone.on('term', (f) => frames.push(f));

    // Nothing yet; opening starts the worktree's shell, as the Mac's dock does, at the Mac's size.
    expect(TerminalsView.parse(await phone.call('companion.terminals', ['conv:ws:w1']))).toEqual({ terminals: [] });
    const opened = TerminalView.parse(await phone.call('companion.termOpen', ['conv:ws:w1']));
    expect(opened).toMatchObject({ key: 'w1', label: 'Shell', running: true, cols: 100, rows: 30 });
    expect(TerminalsView.parse(await phone.call('companion.terminals', ['conv:ws:w1'])).terminals.map((t) => t.key)).toEqual(['w1']);

    // The Mac's screen attaches to the same session.
    const mac = macApp.attachTerminal('w1');
    let macSaw = '';
    mac.onData((d) => (macSaw += d));

    phone.termAttach('w1');
    const status = await waitFor(() => frames.find((f) => f.t === 'term_status' && f.term === 'w1'), 5_000);
    expect(status).toMatchObject({ running: true, cols: 100, rows: 30 });
    // The screen so far comes first, from a clean start. Not waiting for the prompt: Windows' console
    // can hold a new shell's first output back, and what's typed now waits for the shell anyway.
    await waitFor(() => frames.find((f) => f.t === 'term_data' && f.term === 'w1'), 5_000);
    expect(frames.find((f) => f.t === 'term_data')).toMatchObject({ reset: true });

    // The phone types: the Mac sees the command's output too.
    phone.termInput('w1', 'echo from-the-$((40+2))-phone\r');
    // The run's first shell: Git Bash on a busy Windows runner can take a while to start.
    await waitFor(() => outputOf(frames, 'w1').includes('from-the-42-phone'), 30_000);
    await waitFor(() => macSaw.includes('from-the-42-phone'), 10_000);

    // The Mac types: the phone sees it.
    mac.write('echo mac-$((6*7))-typed\r');
    await waitFor(() => outputOf(frames, 'w1').includes('mac-42-typed'), 10_000);

    // The Mac resizes it (the Mac's size is the session's): the phone is told, and fits that grid.
    mac.resize(90, 24);
    await waitFor(() => frames.find((f) => f.t === 'term_status' && f.cols === 90 && f.rows === 24), 5_000);
    expect(terminals.get('w1')?.size).toEqual({ cols: 90, rows: 24 });

    // Output is coalesced: many small writes reach the phone in far fewer frames.
    const before = frames.length;
    phone.termInput('w1', 'i=0; while [ $i -lt 300 ]; do echo line$i; i=$((i+1)); done\r');
    await waitFor(() => outputOf(frames, 'w1').includes('line299'), 10_000);
    expect(frames.length - before).toBeLessThan(60);

    // Detached, nothing more streams to the phone; the session goes on for the Mac.
    phone.termDetach('w1');
    await new Promise((r) => setTimeout(r, 100));
    const shown = frames.length;
    mac.write('echo after-detach\r');
    await waitFor(() => macSaw.includes('after-detach'), 10_000);
    await new Promise((r) => setTimeout(r, 150));
    expect(frames.length).toBe(shown);

    // Attaching again draws what's on screen from a clean start (its recent output).
    phone.termAttach('w1');
    await waitFor(() => frames.slice(shown).some((f) => f.t === 'term_data' && f.reset && f.data.includes('after-detach')), 5_000);

    // Logged: who attached, how much they typed (never what).
    expect(logs.some((l) => /the phone “Pixel 9” opened the terminal w1/.test(l))).toBe(true);
    expect(logs.some((l) => /left the terminal w1 \(typed \d+ characters\)/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toContain('from-the');
  }, 60_000);

  it('opens a new shell in the worktree, closes it for everyone, and refuses terminals that aren’t a worktree’s', async () => {
    const { phone, store, terminals, wt } = await setup();
    const frames: MacFrame[] = [];
    phone.on('term', (f) => frames.push(f));
    const fresh = TerminalView.parse(await phone.call('companion.termOpen', ['conv:ws:w1', { fresh: true }]));
    expect(isGlobalShell(fresh.key)).toBe(true);
    expect(fresh.label).toMatch(/^Shell \d+$/);
    expect(realpathSync(terminals.get(fresh.key)!.cwd)).toBe(wt);
    expect(TerminalsView.parse(await phone.call('companion.terminals', ['conv:ws:w1'])).terminals.map((t) => t.key)).toEqual([fresh.key]);

    // A shell of the Mac's elsewhere (not in a worktree) is none of the phone's business.
    const elsewhere = globalShellId(9);
    terminals.open(elsewhere, { cwd: os.tmpdir(), cols: 80, rows: 24, ...SHELL });
    store.dispatch({ type: 'terminal', id: elsewhere, title: 'sh' });
    phone.termAttach(elsewhere);
    await waitFor(() => frames.find((f) => f.t === 'term_status' && f.term === elsewhere), 5_000);
    expect(frames.find((f) => f.t === 'term_status' && f.term === elsewhere)).toMatchObject({ gone: true, running: false });
    expect(frames.some((f) => f.t === 'term_data' && f.term === elsewhere)).toBe(false);
    await expect(phone.call('companion.termClose', [elsewhere])).rejects.toThrow(/isn’t one of your worktrees/);
    await expect(phone.call('companion.termOpen', ['conv:ws:w1', { key: elsewhere }])).rejects.toThrow(/isn’t one of this worktree’s/);
    await expect(phone.call('companion.terminals', ['conv:ws:nope'])).rejects.toThrow(/isn’t on your Mac/);
    // The Mac's own terminal methods stay the Mac's.
    await expect(phone.call('terminals.shell', ['w1'])).rejects.toThrow(/only on your Mac/);

    await expect(phone.call('companion.termClose', [fresh.key])).resolves.toEqual({ closed: true });
    expect(terminals.get(fresh.key)).toBeUndefined();
    expect(fresh.key in store.getState().terminals).toBe(false);
  }, 60_000);

  it('browses and reads the worktree’s files over the link, read-only, never its secrets', async () => {
    const { phone } = await setup();
    const top = FolderView.parse(await phone.call('companion.files.list', ['conv:ws:w1', '']));
    expect(top.entries.map((e) => e.name)).toEqual(['src']);
    await expect(phone.call('companion.files.read', ['conv:ws:w1', 'src/app.ts'])).resolves.toMatchObject({ text: 'export const x = 1;\n', lang: 'ts', eof: true });
    await expect(phone.call('companion.files.read', ['conv:ws:w1', '.env'])).rejects.toThrow(/secret/);
    await expect(phone.call('companion.files.list', ['conv:ws:w1', '../'])).rejects.toThrow(/inside the worktree/);
    await expect(phone.call('companion.files.find', ['conv:ws:w1', 'app'])).resolves.toEqual({ hits: [{ path: 'src/app.ts', dir: false }] });
    // Writing isn't there at all.
    await expect(phone.call('files.save', ['w1', 'src/app.ts', 'x'])).rejects.toThrow(/only on your Mac/);
  }, 60_000);
});
