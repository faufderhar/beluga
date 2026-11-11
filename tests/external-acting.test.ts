import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { asActingAgent } from '../src/core/acting-agent.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { type TrustLevel, externalRequester } from '../src/core/trust.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor } from './helpers.js';

/** A real session: what a tool's call starts through your agent's own paths runs as that agent. */

const AGENT = { id: 'a1b2c3d4e5f6', name: 'GrokBot' };
const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-acting-')));
  process.env.BELUGA_HOME = path.join(base, 'beluga-home');
  hub = await startHub({ keys });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
  process.env.BELUGA_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

async function started(level: TrustLevel = 'trusted') {
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const workspaces = new WorkspaceManager(wsStore);
  await workspaces.refresh();
  const runs: AgentRunInput[] = [];
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces,
    hasGh: async () => false,
    findPr: async () => undefined,
    saveSettings: () => undefined,
    copy: async () => undefined,
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        runs.push(input);
        return 'ok';
      },
    }),
  });
  const levels = { current: level as TrustLevel };
  session.host.setExternalAgents((requester) => (requester === externalRequester(AGENT.id) ? { name: AGENT.name, level: levels.current } : undefined));
  session.start();
  sessions.push(session);
  await waitFor(() => store.getState().self, 4000);
  const project = workspaces.list.find((p) => p.root)!;
  const ws = (await session.workspaces!.newWorktree(project.id, 'work', { quiet: true }))!;
  return { session, store, workspaces, runs, levels, ws, channel: `ws:${ws.id}` };
}

describe('your agent, started by a tool call', () => {
  it('with no agent acting, a turn is yours: your secrets gate and your tools', async () => {
    const { session, runs, channel } = await started();
    session.askOwnClaude('hello', channel);
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeDefined();
  });

  it('under an agent at trusted, the same call is its run: no secrets gate, labelled in the chat', async () => {
    const { session, store, runs, channel } = await started('trusted');
    asActingAgent(AGENT, () => session.askOwnClaude('do this', channel));
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeUndefined();
    expect(runs[0]!.requesterName).toBe(AGENT.name);
    expect(store.getState().log.find((l) => l.type === 'chat' && l.channel === channel && l.text === 'do this')).toMatchObject({ via: { id: AGENT.id, name: AGENT.name, creationSource: 'mcp' } });
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.status === 'done'), 4000);
    expect(store.getState().log.find((l) => l.type === 'agent' && l.channel === channel)).toMatchObject({ requesterName: AGENT.name });
  });

  it('it stays under the agent across awaits and timers, as a tool that works in the background does', async () => {
    const { session, runs, channel } = await started('trusted');
    await asActingAgent(AGENT, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      session.askOwnClaude('later', channel);
    });
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeUndefined();
  });

  it('a revoked agent starts nothing', async () => {
    const { session, store, runs, levels, channel } = await started('trusted');
    levels.current = 'blocked';
    asActingAgent(AGENT, () => session.askOwnClaude('do this', channel));
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.status === 'denied'), 4000);
    expect(runs).toHaveLength(0);
  });

  it("what a plan asks later in an agent's worktree stays that agent's, and ends with its grant", async () => {
    const { session, store, workspaces, runs, levels, ws, channel } = await started('trusted');
    workspaces.setStartedBy(ws.id, AGENT);
    session.askForPlan('next task', channel, false);
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeUndefined();
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.status === 'done'), 4000);
    levels.current = 'blocked';
    session.askForPlan('next task', channel, false);
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.status === 'denied'), 4000);
    expect(runs).toHaveLength(1);
  });

  it('a plan in a worktree of yours is yours', async () => {
    const { session, runs, channel } = await started('trusted');
    session.askForPlan('next task', channel, false);
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeDefined();
  });

  it('an answer from a friend to a task an agent sent goes on at its level', async () => {
    const { session, runs, channel } = await started('trusted');
    asActingAgent(AGENT, () => session.runFor(session.selfId, channel, '[beluga] Mia replied'));
    await waitFor(() => runs.length === 1, 4000);
    expect(runs[0]!.canUseSecret).toBeUndefined();
  });

  it('a restart names the agent on what a friend sees', async () => {
    const { session, store, channel } = await started('trusted');
    session.host.runExternal(externalRequester(AGENT.id), channel, 'first', { mode: 'auto' });
    session.host.runExternal(externalRequester(AGENT.id), channel, 'again', { mode: 'restart' });
    await waitFor(() => store.getState().log.filter((l) => l.type === 'agent' && l.channel === channel).length >= 1, 4000);
    for (const item of store.getState().log.filter((l) => l.type === 'agent' && l.channel === channel)) expect(item).toMatchObject({ requesterName: AGENT.name });
  });
});
