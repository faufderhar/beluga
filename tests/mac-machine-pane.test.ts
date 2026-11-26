import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Store, type View, initialState } from '../src/core/store.js';
import { DaemonServer } from '../src/daemon/server.js';
import { SocketClient } from '../src/ipc/socket-client.js';
import { isDemoMachine } from '../src/machines/demo.js';
import { MACHINE_REFUSED } from '../src/machines/coverage.js';
import { EMPTY_HISTORY, goBack, goForward, pageKey, recordable, samePage, visit } from '../packages/mac/src/lib/nav-history.js';
import {
  WINDOW_UI_KEYS,
  isMachineId,
  machineSocketUrl,
  onMachine,
  pageOfChannel,
  paneOf,
  paneViewFor,
  sameView,
  scopedKey,
  sourceTag,
  splitUiPatch,
  windowViewFor,
} from '../packages/mac/src/machines/pane-model.js';
import { TerminalManager } from '../src/terminal/pty-host.js';

/**
 * A pane draws with its computer's client (BLG-784): the window's view wraps a page on one of
 * your computers, the two are kept in step both ways, Back and Forward tell this Mac's pages from a
 * computer's, the window's memories are kept per computer, and the demo daemon serves its demo
 * computers' screens itself.
 */

const AWS = 'de30a1c0ffee0002';
const MINI = 'de30a1c0ffee0001';
const ws = (id: string, tab: 'chat' | 'files' = 'chat'): View => ({ kind: 'workspace', id, tab });
const panels = { sidebar: true, inspector: true, bottomOpen: false, drawer: false };

describe('a page on a computer', () => {
  it('wraps a page once, and says which computer it is on', () => {
    const page = onMachine(AWS, ws('w1'));
    expect(page).toEqual({ kind: 'machine', machine: AWS, view: ws('w1') });
    expect(onMachine(MINI, page)).toBe(page);
    expect(paneOf(page)).toEqual({ machine: AWS, view: ws('w1') });
    expect(paneOf(ws('w1'))).toEqual({ view: ws('w1') });
  });

  it('a conversation there is its worktree’s page; anything else is none', () => {
    expect(pageOfChannel('ws:abc')).toEqual(ws('abc'));
    expect(pageOfChannel('room')).toBeUndefined();
    expect(pageOfChannel('ws:')).toBeUndefined();
  });

  it('the window going to a computer’s page shows it there, once', () => {
    expect(paneViewFor(AWS, onMachine(AWS, ws('w2')), ws('w1'))).toEqual(ws('w2'));
    expect(paneViewFor(AWS, onMachine(AWS, ws('w1')), ws('w1'))).toBeUndefined();
    // Another computer's page, or this Mac's: not this pane's to show.
    expect(paneViewFor(AWS, onMachine(MINI, ws('w2')), ws('w1'))).toBeUndefined();
    expect(paneViewFor(AWS, ws('w2'), ws('w1'))).toBeUndefined();
  });

  it('the pane going somewhere there is the window’s next page, once', () => {
    expect(windowViewFor(AWS, onMachine(AWS, ws('w1')), ws('w1', 'files'))).toEqual(onMachine(AWS, ws('w1', 'files')));
    expect(windowViewFor(AWS, onMachine(AWS, ws('w1')), ws('w1'))).toBeUndefined();
    expect(sameView(ws('w1'), { ...ws('w1') })).toBe(true);
  });

  it('opens the computer’s screen at the daemon’s own address, and only for a computer id', () => {
    expect(machineSocketUrl('ws://127.0.0.1:4100', AWS)).toBe(`ws://127.0.0.1:4100/machine/${AWS}`);
    expect(machineSocketUrl('ws://127.0.0.1:4100/ws?x=1', AWS)).toBe(`ws://127.0.0.1:4100/machine/${AWS}`);
    expect(isMachineId(AWS)).toBe(true);
    expect(() => machineSocketUrl('ws://127.0.0.1:4100', '../daemon')).toThrow();
    expect(() => machineSocketUrl('ws://127.0.0.1:4100', 'DE30A1C0FFEE0002')).toThrow();
  });
});

describe('Back and Forward between this Mac and a computer', () => {
  it('a computer’s page is never the same page as this Mac’s, nor another computer’s', () => {
    expect(samePage(onMachine(AWS, ws('w1')), ws('w1'))).toBe(false);
    expect(samePage(onMachine(AWS, ws('w1')), onMachine(MINI, ws('w1')))).toBe(false);
    // A worktree is one page whatever tab, there as here.
    expect(samePage(onMachine(AWS, ws('w1')), onMachine(AWS, ws('w1', 'files')))).toBe(true);
    expect(pageKey(onMachine(AWS, ws('w1')))).toContain(AWS);
  });

  it('a new chat there isn’t a page to come back to, as here', () => {
    expect(recordable(onMachine(AWS, { kind: 'draft_worktree', projectId: 'p', back: { kind: 'room' } }))).toBe(false);
    expect(recordable(onMachine(AWS, ws('w1')))).toBe(true);
  });

  it('goes back and forth between this Mac’s page and the same worktree id on a computer', () => {
    const alive = (): boolean => true;
    let h = visit(EMPTY_HISTORY, { view: ws('w1'), panels });
    h = visit(h, { view: onMachine(AWS, ws('w1')), panels: { ...panels, shown: ['files'] } });
    expect(h.back).toHaveLength(1);
    const back = goBack(h, alive);
    expect(back.to?.view).toEqual(ws('w1'));
    const forward = goForward(back.history, alive);
    expect(forward.to?.view).toEqual(onMachine(AWS, ws('w1')));
    expect(forward.to?.panels.shown).toEqual(['files']);
  });
});

describe('the window’s memories, per computer', () => {
  it('this Mac’s keys stay as they were; a computer’s are its own', () => {
    expect(scopedKey(undefined, 'ws:w1')).toBe('ws:w1');
    expect(scopedKey(AWS, 'ws:w1')).toBe(`${AWS}/ws:w1`);
    expect(scopedKey(AWS, 'room')).not.toBe(scopedKey(MINI, 'room'));
  });

  it('a runtime cache tells two sources apart, and one source the same each time', () => {
    const a = {};
    const b = {};
    expect(sourceTag(a)).toBe(sourceTag(a));
    expect(sourceTag(a)).not.toBe(sourceTag(b));
  });

  it('a pane keeps the box and its menus, and leaves the palette, Settings and the bell to the window', () => {
    const split = splitUiPatch({ buffer: 'hi', cursor: 2, palette: true, notices: true, menu: { menu: { kind: 'workspace' }, selected: 0 } });
    expect(split.pane).toEqual({ buffer: 'hi', cursor: 2, menu: { menu: { kind: 'workspace' }, selected: 0 } });
    expect(split.window).toEqual({ palette: true, notices: true });
    // A Settings menu opens the window's Settings, wherever it was asked from.
    expect(splitUiPatch({ menu: { menu: { kind: 'settings' }, selected: 0 } }).window).toHaveProperty('menu');
    expect(WINDOW_UI_KEYS.has('buffer')).toBe(false);
  });
});

describe('the demo daemon serves its computers’ screens', () => {
  const TOKEN = 't'.repeat(32);
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  it('knows its two computers and nothing else', () => {
    expect(isDemoMachine(AWS)).toBe(true);
    expect(isDemoMachine(MINI)).toBe(true);
    expect(isDemoMachine('0123456789abcdef')).toBe(false);
  });

  it('a screen on /machine/<demo id> is a machine screen of the same daemon: its state, and what a computer refuses', async () => {
    const store = new Store(initialState('demo room'));
    const terminals = new TerminalManager();
    const session = { store, intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
    const server = new DaemonServer({ session: session as never, token: TOKEN, version: '0.9.0', terminals });
    server.routeMachines((id, socket, hello) => (isDemoMachine(id) ? server.serveAsMachine(socket, hello) : socket.close(4404, 'No computers here')));
    const port = await server.listen();
    cleanup.push(() => server.close());
    const client = await SocketClient.connect({ url: `ws://127.0.0.1:${port}/machine/${AWS}`, token: TOKEN, kind: 'test', version: '0.9.0', connect: (url) => new WebSocket(url) as never, timeoutMs: 10_000 });
    cleanup.push(() => client.close());
    expect(client.store.getState().room).toBe(store.getState().room);
    await expect(client.call('daemon.stop')).rejects.toThrow(MACHINE_REFUSED);
    await expect(SocketClient.connect({ url: `ws://127.0.0.1:${port}/machine/0123456789abcdef`, token: TOKEN, kind: 'test', version: '0.9.0', connect: (url) => new WebSocket(url) as never, timeoutMs: 5_000 })).rejects.toThrow();
  });
});
