import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockBackend } from '../src/agent/mock.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { asActingAgent } from '../src/core/acting-agent.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach, waitFor } from './helpers.js';

/**
 * BLG-932, end to end: what you send from a screen runs with Claude in Chrome as usual; the same
 * words sent by Beluga itself, or by an external agent through the same screen action, ask you first.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-chrome-session-'));
  const files = new WorkspaceStore(home);
  files.saveConfig({ roots: [], projects: [], hidden: [] });
  const manager = new WorkspaceManager(files);
  const store = new Store(initialState('demo'));
  const runs: AgentRunInput[] = [];
  const session = new Session({
    client: new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } }),
    store,
    shares: new ShareService([]),
    workspaces: manager,
    agentCwd: home,
    createAgent: (bridge) => ({
      ...createMockBackend(bridge, 0),
      run: async (input: AgentRunInput) => (runs.push(input), 'ok'),
    }),
  });
  const client = attach(session);
  cleanups.push(async () => {
    client.close();
    await session.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const controller = session.workspaces!;
  await controller.refresh();
  const chat = (await controller.newChat('chats', 'Pull requests', undefined, { quiet: true }))!;
  const channel = `ws:${chat.id}`;
  const next = async (send: () => unknown): Promise<AgentRunInput> => {
    const before = runs.length;
    send();
    await waitFor(() => runs.length > before);
    return runs.at(-1)!;
  };
  return { session, channel, next };
}

it('a message you send from a screen uses Chrome as usual', async () => {
  const { session, channel, next } = await setup();
  const run = await next(() => HANDLERS['session.submit'](session, 'look at my pull requests', { channel }));
  expect(run.chrome).toEqual({});
});

it('one Beluga sends on its own asks you first', async () => {
  const { session, channel, next } = await setup();
  const run = await next(() => session.askOwnClaude('look at my pull requests', channel));
  expect(run.chrome?.ask).toBeTypeOf('function');
});

it('an external agent sending through the same action is never taken for you', async () => {
  const { session, channel } = await setup();
  const marked = vi.spyOn(session.host, 'markYours');
  asActingAgent({ id: 'ext-1', name: 'Codex CLI' }, () => HANDLERS['session.submit'](session, 'look at my pull requests', { channel }));
  expect(marked).not.toHaveBeenCalled();
  HANDLERS['session.submit'](session, 'and my issues', { channel });
  expect(marked).toHaveBeenCalledTimes(1);
});
