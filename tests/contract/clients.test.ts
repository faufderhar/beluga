import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend } from '../../src/agent/types.js';
import { Session } from '../../src/core/session.js';
import { ShareService } from '../../src/core/shares.js';
import { Store, initialState } from '../../src/core/store.js';
import { DaemonServer } from '../../src/daemon/server.js';
import type { BelugaClient } from '../../src/ipc/client.js';
import { InProcessClient } from '../../src/ipc/in-process.js';
import { SocketClient } from '../../src/ipc/socket-client.js';
import { deriveKeys, generateSecret } from '../../src/net/crypto.js';
import { startHub, type Hub } from '../../src/net/hub.js';
import { PeerClient } from '../../src/net/peer-client.js';
import { TerminalEmulator, TerminalManager } from '../../src/terminal/index.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { WorkspaceStore } from '../../src/workspaces/store.js';
import { waitFor } from '../helpers.js';
import { posixSh } from '../../src/terminal/pty.js';

/**
 * The same behavior, whichever way a screen is attached: in the core's own process (the terminal
 * UI alone) or over the daemon's socket (several screens, the Mac app).
 */

interface Core {
  readonly session: Session;
  readonly store: Store;
  readonly terminals: TerminalManager;
  readonly asked: string[];
}

let hub: Hub | undefined;
let server: DaemonServer | undefined;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await server?.close();
  server = undefined;
  await hub?.close();
  hub = undefined;
});

async function core(): Promise<Core> {
  const keys = deriveKeys(generateSecret());
  hub = await startHub({ keys });
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-contract-')));
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [], hidden: [] });
  // A plain shell keeps terminal tests light (a login shell would load your whole profile).
  const store = new Store(initialState('test', 'ask', { shell: posixSh() ?? '/bin/sh' }));
  const terminals = new TerminalManager();
  const asked: string[] = [];
  const session = new Session({
    client: new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false }),
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces: new WorkspaceManager(wsStore),
    terminals,
    launchDir: base,
    copy: async () => undefined,
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        asked.push(input.prompt);
        return `echo: ${input.prompt}`;
      },
    }),
  });
  session.start();
  cleanups.push(() => session.stop(), () => terminals.closeAll());
  await waitFor(() => store.getState().self, 4000);
  return { session, store, terminals, asked };
}

const MODES = {
  inprocess: async (c: Core): Promise<BelugaClient> => {
    const client = new InProcessClient(c.session, { kind: 'test' });
    cleanups.push(() => client.close());
    return client;
  },
  socket: async (c: Core): Promise<BelugaClient> => {
    const token = generateSecret();
    server ??= new DaemonServer({ session: c.session, token, version: 'test', terminals: c.terminals });
    const port = await server.listen();
    const client = await SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind: 'test', version: 'test' });
    cleanups.push(() => client.close());
    return client;
  },
} as const;

describe.each(Object.keys(MODES) as Array<keyof typeof MODES>)('a screen attached %s', (mode) => {
  const attach = MODES[mode];

  it('sees the shared state and what it says reaches Claude', async () => {
    const c = await core();
    const client = await attach(c);
    expect(client.store.getState().selfId).toBe(c.session.selfId);
    await client.api.session.submit('hello there', { channel: 'room' });
    await waitFor(() => client.store.getState().log.some((l) => l.type === 'agent' && l.status === 'done' && l.text === 'echo: hello there'), 4000);
    expect(c.asked).toEqual(['hello there']);
  });

  it('goes where its own commands say, and shows their messages', async () => {
    const c = await core();
    const client = await attach(c);
    await client.api.session.submit('/overview', { channel: 'room' });
    await waitFor(() => client.store.getState().view.kind === 'overview');
    await client.api.session.submit('/policy nonsense', { channel: 'room' });
    await waitFor(() => client.store.getState().toast?.text.includes('Policy is'));
    await client.api.session.submit('/help', { channel: 'room' });
    await waitFor(() => client.store.getState().overlay === 'help');
  });

  it('answers approvals by id', async () => {
    const c = await core();
    const client = await attach(c);
    const answer = c.session.ask('request', 'May I?', 'details');
    const approval = await waitFor(() => client.store.getState().approvals[0]);
    expect(await client.api.host.answerApproval('yes', approval.id)).toBe(true);
    expect(await answer).toBe('yes');
    await waitFor(() => client.store.getState().approvals.length === 0);
    expect(await client.api.host.answerApproval('no', approval.id)).toBe(false);
  });

  it('counts unread messages only where no screen looks, and clears them when it opens the conversation', async () => {
    const c = await core();
    const client = await attach(c);
    c.store.dispatch({ type: 'chat', id: 'x1', from: 'bob', text: 'in a workspace', ts: 1, byAgent: false, channel: 'ws:w1' });
    await waitFor(() => client.store.getState().unread['ws:w1'] === 1);
    client.store.dispatch({ type: 'view', view: { kind: 'shared', owner: 'b', id: 'w1', tab: 'chat' } });
    await waitFor(() => client.store.getState().unread['ws:w1'] === undefined);
    c.store.dispatch({ type: 'chat', id: 'x2', from: 'bob', text: 'seen', ts: 2, byAgent: false, channel: 'ws:w1' });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.store.getState().unread['ws:w1']).toBeUndefined();
  });

  it('runs a terminal in the core and draws it with its own emulator', async () => {
    const c = await core();
    const client = await attach(c);
    const key = 'shell:1';
    expect(await client.api.terminals.global(key, os.tmpdir(), { cols: 60, rows: 10 })).toBe(key);
    await waitFor(() => key in client.store.getState().terminals);
    const emu = new TerminalEmulator(client.attachTerminal(key), { id: key, cols: 60, rows: 10 });
    cleanups.push(() => emu.dispose());
    await waitFor(() => emu.running, 4000);
    emu.write('echo contract-$((20+22))\r');
    const text = (): string => emu.snapshot().lines.map((l) => l.map((s) => s.text).join('')).join('\n');
    await waitFor(() => text().includes('contract-42'), 6000);
    await client.api.terminals.close(key);
    await waitFor(() => !(key in client.store.getState().terminals));
  });

  it('takes left-out optional arguments, also in the middle', async () => {
    const c = await core();
    const client = await attach(c);
    const untyped = client.call.bind(client) as unknown as (method: string, ...args: unknown[]) => Promise<unknown>;
    await expect(untyped('workspaces.setGroup', 'nope', undefined)).resolves.toBeUndefined();
    await expect(untyped('session.shareFolder', '/definitely/not/here', undefined, ['x'])).resolves.toBeUndefined();
  });

  it('takes pasted images and turns their chips into links', async () => {
    const c = await core();
    const client = await attach(c);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa65f8c0000000049454e44ae426082', 'hex').toString('base64');
    const added = await client.api.attachments.add('png', png);
    expect(added.chip).toMatch(/^\[image \d+\]$/);
    const text = await client.api.attachments.expand(`look ${added.chip}`, 'ws:x');
    expect(text).toMatch(/look \[📎 image \d+ \(png, .*\)\]\(klaud-attachment:.*\.png\)/);
    expect(await client.api.attachments.expand('/help [image 1]', 'room')).toBe('/help [image 1]');
  });

  it('reports failures to the caller', async () => {
    const c = await core();
    const client = await attach(c);
    const untyped = client.call.bind(client) as unknown as (method: string, ...args: unknown[]) => Promise<unknown>;
    await expect(untyped('session.rename', 42)).rejects.toThrow(/Bad arguments/);
    await expect(untyped('nope.nothing')).rejects.toThrow();
  });
});
