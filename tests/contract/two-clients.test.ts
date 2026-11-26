import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend } from '../../src/agent/types.js';
import { currentClient } from '../../src/core/client-context.js';
import { Session } from '../../src/core/session.js';
import { ShareService } from '../../src/core/shares.js';
import { Store, initialState } from '../../src/core/store.js';
import { DaemonServer } from '../../src/daemon/server.js';
import { SocketClient, type Capabilities } from '../../src/ipc/socket-client.js';
import { deriveKeys, generateSecret } from '../../src/net/crypto.js';
import { startHub, type Hub } from '../../src/net/hub.js';
import { PeerClient } from '../../src/net/peer-client.js';
import { waitFor } from '../helpers.js';

/** Two screens on one klaud at once: the terminal UI and the Mac app, say. */

let hub: Hub | undefined;
let server: DaemonServer | undefined;
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await server?.close();
  server = undefined;
  await hub?.close();
  hub = undefined;
});

async function setup(terminals?: ConstructorParameters<typeof DaemonServer>[0]['terminals']) {
  const keys = deriveKeys(generateSecret());
  hub = await startHub({ keys });
  const store = new Store(initialState('test', 'ask'));
  const token = generateSecret();
  let srv!: DaemonServer;
  const session = new Session({
    client: new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false }),
    store,
    shares: new ShareService([]),
    agentCwd: process.cwd(),
    // Wired like the daemon: what only a screen can do goes to the screen that asked.
    copy: async (text) => void (await srv.callCap('copyText', [text], currentClient())),
    desktopNotify: (n) => srv.notify([n]),
    zoom: async (dir) => (await srv.callCap('zoom', [dir], currentClient())) as { ok: boolean; message: string },
    createAgent: (): AgentBackend => ({ run: async (input) => `echo: ${input.prompt}` }),
  });
  session.start();
  closers.push(() => session.stop());
  srv = new DaemonServer({ session, token, version: 'test', ...(terminals ? { terminals } : {}) });
  server = srv;
  const port = await srv.listen();
  await waitFor(() => store.getState().self, 4000);
  const screen = async (kind: 'test' | 'mac', caps: Capabilities = {}) => {
    const c = await SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind, version: 'test', caps });
    closers.push(() => c.close());
    return c;
  };
  return { session, store, screen };
}

describe('two screens at once', () => {
  it("a terminal's answers come from one screen, and from another once that one leaves", async () => {
    const written: string[] = [];
    const pty = { backlog: () => '', running: true, exited: undefined, onData: () => () => undefined, onExit: () => () => undefined, write: (d: string) => void written.push(d), resize: () => undefined };
    const { screen } = await setup({ get: (key: string) => (key === 'shell:1' ? pty : undefined) } as never);
    const tui = await screen('test');
    const mac = await screen('mac');
    const a = tui.attachTerminal('shell:1');
    await new Promise((r) => setTimeout(r, 50));
    const b = mac.attachTerminal('shell:1');
    await new Promise((r) => setTimeout(r, 50));
    // Both emulators answer the program's query; only the first screen's answer goes through.
    a.write('A', true);
    b.write('B', true);
    await waitFor(() => written.includes('A'));
    await new Promise((r) => setTimeout(r, 50));
    expect(written).toEqual(['A']);
    tui.close();
    await waitFor(() => mac.clients === 1);
    b.write('B2', true);
    await waitFor(() => written.includes('B2'));
  });

  it('the first answer to an approval wins; the other gets false', async () => {
    const { session, screen } = await setup();
    const tui = await screen('test');
    const mac = await screen('mac');
    const answer = session.ask('tool', 'Run npm test?', 'npm test');
    const approval = await waitFor(() => tui.store.getState().approvals[0]);
    await waitFor(() => mac.store.getState().approvals[0]);
    expect(approval).toMatchObject({ askedAt: expect.any(Number), timeoutMs: expect.any(Number) });
    const [a, b] = await Promise.all([mac.api.host.answerApproval('yes', approval.id), tui.api.host.answerApproval('no', approval.id)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await answer).toBe(a ? 'yes' : 'no');
    await waitFor(() => tui.store.getState().approvals.length === 0 && mac.store.getState().approvals.length === 0);
  });

  it("each screen goes where its own commands say; the other stays put", async () => {
    const { screen } = await setup();
    const tui = await screen('test');
    const mac = await screen('mac');
    await mac.api.session.submit('/overview', { channel: 'room' });
    await waitFor(() => mac.store.getState().view.kind === 'overview');
    await tui.api.session.submit('/usage', { channel: 'room' });
    await waitFor(() => tui.store.getState().view.kind === 'usage');
    expect(mac.store.getState().view.kind).toBe('overview');
    await tui.api.session.submit('/policy nope', { channel: 'room' });
    await waitFor(() => tui.store.getState().toast !== undefined);
    expect(mac.store.getState().toast).toBeUndefined();
  });

  it('what happens without anyone asking reaches every screen', async () => {
    const { session, screen } = await setup();
    const tui = await screen('test');
    const mac = await screen('mac');
    session.toast('bob joined');
    await waitFor(() => tui.store.getState().toast?.text === 'bob joined' && mac.store.getState().toast?.text === 'bob joined');
  });

  it("copies on the asking screen, and notifies on the Mac app when it's attached", async () => {
    const { session, screen } = await setup();
    const copiedTui: string[] = [];
    const copiedMac: string[] = [];
    const notifiedTui: string[] = [];
    const notifiedMac: string[] = [];
    const tui = await screen('test', { copyText: (t: string) => void copiedTui.push(t), notify: (n: { title: string }) => void notifiedTui.push(n.title) });
    await screen('mac', { copyText: (t: string) => void copiedMac.push(t), notify: (n: { title: string }) => void notifiedMac.push(n.title) });
    await tui.api.session.copyText('from the terminal', 'Copied');
    expect(copiedTui).toEqual(['from the terminal']);
    expect(copiedMac).toEqual([]);
    await waitFor(() => tui.store.getState().toast?.text === 'Copied');
    session.notifier.notify({ kind: 'done', title: 'Claude finished', body: 'ok' });
    await waitFor(() => notifiedMac.length === 1, 4000);
    expect(notifiedTui).toEqual([]);
  });

  it('a conversation is unread until some screen shows it; any screen showing it clears it', async () => {
    const { session, store, screen } = await setup();
    const tui = await screen('test');
    const mac = await screen('mac');
    store.dispatch({ type: 'chat', id: 'm1', from: 'bob', text: 'one', ts: 1, byAgent: false, channel: 'ws:w9' });
    await waitFor(() => tui.store.getState().unread['ws:w9'] === 1 && mac.store.getState().unread['ws:w9'] === 1);
    mac.store.dispatch({ type: 'view', view: { kind: 'shared', owner: 'b', id: 'w9', tab: 'chat' } });
    await waitFor(() => tui.store.getState().unread['ws:w9'] === undefined);
    mac.close();
    await waitFor(() => store.getState().attention.shown.length === 1); // only the terminal's room now
    store.dispatch({ type: 'chat', id: 'm2', from: 'bob', text: 'two', ts: 2, byAgent: false, channel: 'ws:w9' });
    await waitFor(() => tui.store.getState().unread['ws:w9'] === 1);
  });

  it('a second screen sees images in the viewer, pixels and all', async () => {
    const { store, screen } = await setup();
    const tui = await screen('test');
    const at = { owner: 'me', share: 's', path: 'a.png' };
    store.dispatch({ type: 'viewer_open', at });
    store.dispatch({ type: 'viewer_image', at, image: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) } });
    const image = await waitFor(() => tui.store.getState().viewer?.image);
    expect([...image.data]).toEqual([255, 0, 0, 255]);
    const late = await screen('mac');
    expect([...(late.store.getState().viewer?.image?.data ?? [])]).toEqual([255, 0, 0, 255]);
  });
});
