import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonServer } from '../src/daemon/server.js';
import { SocketClient } from '../src/ipc/socket-client.js';
import { Store, initialState } from '../src/core/store.js';
import { FlowGate } from '../src/terminal/flow.js';
import { TerminalManager } from '../src/terminal/pty-host.js';
import { waitFor } from './helpers.js';

// BLG-963: a program that writes faster than the screen draws waits for it, so typing stays instant.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe('FlowGate', () => {
  const gate = (opts: { now?: () => number } = {}) => {
    const calls: string[] = [];
    const g = new FlowGate(() => calls.push('hold'), () => calls.push('release'), { high: 100, low: 20, staleMs: 1000, ...opts });
    return { g, calls };
  };

  it('holds the program once the screen is far behind, and lets go when it catches up', () => {
    const { g, calls } = gate();
    g.sent(100);
    expect(calls).toEqual([]);
    g.sent(1);
    expect(calls).toEqual(['hold']);
    g.sent(500);
    expect(calls).toEqual(['hold']);
    g.acked(500);
    expect(g.held).toBe(true);
    g.acked(81);
    expect(calls).toEqual(['hold', 'release']);
    expect(g.pending).toBe(20);
    g.dispose();
    expect(calls).toEqual(['hold', 'release']);
  });

  it('never holds for long when the screen stops answering, and holds again once it answers', () => {
    vi.useFakeTimers();
    let t = 0;
    const { g, calls } = gate({ now: () => t });
    t = 400;
    g.sent(200);
    expect(calls).toEqual(['hold']);
    t = 1000;
    vi.advanceTimersByTime(600);
    expect(calls).toEqual(['hold', 'release']);
    // Still silent: more output doesn't make the program wait for it.
    g.sent(10_000);
    expect(calls).toEqual(['hold', 'release']);
    // It answers (but is still far behind): the next output holds again.
    g.acked(10);
    g.sent(1);
    expect(calls).toEqual(['hold', 'release', 'hold']);
    g.dispose();
    expect(calls).toEqual(['hold', 'release', 'hold', 'release']);
  });

  it('keeps holding while the screen answers, however slowly', () => {
    vi.useFakeTimers();
    let t = 0;
    const { g, calls } = gate({ now: () => t });
    g.sent(10_000);
    for (let i = 0; i < 5; i++) {
      t += 900;
      vi.advanceTimersByTime(900);
      g.acked(1);
    }
    expect(calls).toEqual(['hold']);
    g.dispose();
  });
});

// The flood is /bin/sh running `yes`, which Windows doesn't have; the gate itself is tested above.
describe.skipIf(process.platform === 'win32')('a terminal streamed with flow control', () => {
  const setup = async () => {
    const store = new Store(initialState('room'));
    const token = 'a'.repeat(32);
    const session = { store, intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
    const terminals = new TerminalManager();
    cleanup.push(() => terminals.closeAll());
    const daemon = new DaemonServer({ session: session as never, token, version: '1.0.0', terminals });
    const port = await daemon.listen();
    cleanup.push(() => daemon.close());
    const screen = await SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind: 'test', version: '1.0.0' });
    cleanup.push(() => screen.close());
    // A program that writes as fast as it can, forever.
    const pty = terminals.open('flood', { cwd: process.cwd(), shell: '/bin/sh', args: ['-c', 'yes 0123456789abcdef'], cols: 80, rows: 24 });
    return { pty, screen };
  };

  /** Settled: nothing more arrives for a while (what was already read still goes out first). */
  const quiet = async (count: () => number): Promise<number> => {
    const until = Date.now() + 10_000;
    for (let last = -1; Date.now() < until; ) {
      if (count() === last) return last;
      last = count();
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('output never stopped');
  };

  it('pauses the program while the screen hasn’t drawn, and goes on as it acks', async () => {
    const { pty, screen } = await setup();
    const link = screen.attachTerminal('flood', { flow: true });
    let got = 0;
    link.onData((d) => void (got += d.length));
    await waitFor(() => pty.waiting, 10_000);
    const stopped = await quiet(() => got);
    // Held near the line: not megabytes queued for a screen that can't keep up.
    expect(stopped).toBeLessThan(2 * 1024 * 1024);
    expect(pty.waiting).toBe(true);
    expect(stopped).toBeGreaterThan(256 * 1024);

    // The screen draws it all: the program goes on.
    link.ack?.(stopped);
    await waitFor(() => got > stopped + 1024, 10_000);
    await waitFor(() => pty.waiting, 10_000);

    // Leaving lets the program go on, whatever it owed.
    link.close?.();
    await waitFor(() => !pty.waiting, 10_000);
  });

  it('never makes the program wait for a screen that didn’t ask for flow control', async () => {
    const { pty, screen } = await setup();
    const link = screen.attachTerminal('flood');
    let got = 0;
    link.onData((d) => void (got += d.length));
    await waitFor(() => got > 1024 * 1024, 15_000);
    expect(pty.waiting).toBe(false);
  });
});
