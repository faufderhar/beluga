import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { PHONE } from '../src/companion/coverage.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { AgentHost } from '../src/core/agent-host.js';
import { attachGateway } from '../src/core/gateway/registry.js';
import type { Gateway } from '../src/core/gateway/gateway.js';
import type { Session } from '../src/core/session.js';
import { Store, initialState } from '../src/core/store.js';
import { externalRequester } from '../src/core/trust.js';
import { grantLookup } from '../src/external/adapters/runs.js';
import { stopAgentWork } from '../src/external/adapters/stop.js';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { EXTERNAL_ACCESS } from '../src/external/coverage.js';
import { launchExternal } from '../src/external/launch.js';
import { attachExternal, needExternal } from '../src/external/registry.js';
import { ExternalService } from '../src/external/service.js';
import { EXTERNAL_HANDLERS } from '../src/ipc/external-handlers.js';
import type { BodyOf } from '../src/protocol.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const CHANNEL = 'ws:w1';
const KILL_LIMIT_MS = 5_000;

const pingTool = (name: 'beluga_chat_read' | 'beluga_chat_send' | 'beluga_chat_interrupt', inScope = true): ExternalToolDef => ({ name, description: '', inputSchema: { x: z.string().optional() }, resolve: () => ({ target: 'chat:c1', inScope }), run: () => ({ ok: true }) });

function fixture(opts: { wedged?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'external-stop-'));
  const store = new Store(initialState('room', 'ask'));
  const inputs: AgentRunInput[] = [];
  const killed = vi.fn();
  const agent: AgentBackend = {
    run: (input) =>
      new Promise<string>((_resolve, reject) => {
        inputs.push(input);
        input.onProcess?.({ pid: 1, alive: () => true, kill: async () => killed() });
        input.signal.addEventListener('abort', () => (opts.wedged ? undefined : reject(new Error('aborted'))));
      }),
  };
  const send = (body: { kind: string } & Record<string, unknown>): boolean => {
    if (body.kind !== 'agent_event') return true;
    const e = body as unknown as BodyOf<'agent_event'>;
    store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel, ...(e.via ? { via: e.via } : {}) });
    return true;
  };
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: send as never,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: vi.fn() } as never,
    workspaces: { place: () => ({ cwd: '/tmp/p', additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  });
  const session = { host, store } as unknown as Session;
  const asks: Array<{ title: string; agent?: string }> = [];
  const service = new ExternalService({
    configFile: path.join(dir, 'c.json'),
    grantFile: path.join(dir, 'g.json'),
    auditFile: path.join(dir, 'a.jsonl'),
    port: 0,
    stopWork: (id) => stopAgentWork(session, id),
    tools: [pingTool('beluga_chat_read'), pingTool('beluga_chat_send'), pingTool('beluga_chat_interrupt', false)],
    ask: async (title, _detail, _once, name) => {
      asks.push({ title, ...(name ? { agent: name.agent } : {}) });
      return answer.value;
    },
  });
  const answer: { value: 'yes' | 'no' } = { value: 'yes' };
  attachExternal(session, service);
  host.setExternalAgents(grantLookup(service.grants, Date.now));
  const grant = (level: 'ask' | 'trusted' = 'trusted') => service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], expiresAt: Date.now() + 60_000 });
  const status = () => store.getState().log.find((l) => l.type === 'agent' && l.channel === CHANNEL) as { status: string; text: string; requesterName: string } | undefined;
  const started = async (id: string): Promise<AgentRunInput> => {
    host.runExternal(externalRequester(id), CHANNEL, 'work');
    await waitFor(() => inputs.length > 0);
    return inputs[0]!;
  };
  return { dir, store, host, session, service, grant, status, started, killed, asks, answer };
}

describe('stopping an external agent', () => {
  let f: ReturnType<typeof fixture>;
  let client: Client | undefined;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await f.service.stop();
    rmSync(f.dir, { recursive: true, force: true });
  });
  const connect = async (token: string): Promise<Client> => {
    await f.service.setEnabled(true);
    client = new Client({ name: 'stop-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(f.service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };

  it('revoke aborts its run and denies its waiting approvals', async () => {
    const { grant } = f.grant();
    const input = await f.started(grant.id);
    const bash = input.canUseTool('Bash', { command: 'ls' });
    await waitFor(() => f.store.getState().approvals.length === 1);
    expect(f.service.revoke(grant.id)).toBe(true);
    await expect(bash).resolves.toBe(false);
    expect(f.store.getState().approvals).toEqual([]);
    await waitFor(() => f.status()?.status === 'error');
    expect(f.status()?.text).toBe('Stopped by you');
    expect(f.status()?.requesterName).toBe('GrokBot');
    expect(f.service.grants.list()).toEqual([]);
  });

  it('a run that will not end is killed inside the 5-second limit', async () => {
    await f.service.stop();
    rmSync(f.dir, { recursive: true, force: true });
    f = fixture({ wedged: true });
    const { grant } = f.grant();
    await f.started(grant.id);
    const at = Date.now();
    f.service.revoke(grant.id);
    await waitFor(() => f.status()?.status === 'error', KILL_LIMIT_MS + 1000);
    expect(f.killed).toHaveBeenCalled();
    expect(Date.now() - at).toBeLessThanOrEqual(KILL_LIMIT_MS + 500);
  }, 10_000);

  it('revoke while a call is in flight fails the next step', async () => {
    const { grant } = f.grant();
    const input = await f.started(grant.id);
    const inFlight = input.canUseTool('Bash', { command: 'first' });
    await waitFor(() => f.store.getState().approvals.length === 1);
    f.service.revoke(grant.id);
    await expect(inFlight).resolves.toBe(false);
    expect(input.vetTool?.('Read', {})).toEqual(expect.any(String));
    await expect(input.canUseTool('Bash', { command: 'next' })).resolves.toBe(false);
    expect(f.host.runExternal(externalRequester(grant.id), CHANNEL, 'more')).toBe('denied');
  });

  describe('with two agents and you on one chat', () => {
    /** A's run step and call card, B's call card and your card, all about the chat A runs in. */
    const cards = async () => {
      const a = f.grant().grant;
      const b = f.grant().grant;
      const input = await f.started(a.id);
      const extA = externalRequester(a.id);
      const extB = externalRequester(b.id);
      const step = input.canUseTool('Bash', { command: 'run step' });
      const call = f.host.ask('tool', 'A asks', 'a call', extA, CHANNEL, { asker: 'GrokBot' });
      const other = f.host.ask('tool', 'B asks', 'a call', extB, CHANNEL, { asker: 'Other' });
      const yours = f.host.ask('tool', 'You', 'yours', undefined, CHANNEL);
      await waitFor(() => f.store.getState().approvals.length === 4);
      expect(f.store.getState().approvals.filter((c) => c.peer === extA)).toHaveLength(2);
      return { a, step, call, other, yours };
    };
    const left = () => f.store.getState().approvals.map((c) => c.title);

    it("stopping A answers A's run card and call card, and B's card waits and can get a yes", async () => {
      const { a, step, call, other } = await cards();
      expect(f.service.stopAgent(a.id)).toBe(true);
      await expect(step).resolves.toBe(false);
      await expect(call).resolves.toBe('no');
      expect(left()).toEqual(['B asks', 'You']);
      const id = f.store.getState().approvals[0]!.id;
      expect(f.host.answerApproval('yes', id)).toBe(true);
      await expect(other).resolves.toBe('yes');
    });

    it('your own card about that chat still waits after stopping A', async () => {
      const { a, yours } = await cards();
      f.service.stopAgent(a.id);
      await waitFor(() => f.status()?.status === 'error');
      expect(left()).toContain('You');
      const id = f.store.getState().approvals.find((c) => c.title === 'You')!.id;
      f.host.answerApproval('yes', id);
      await expect(yours).resolves.toBe('yes');
      for (const c of f.store.getState().approvals) f.host.answerApproval('no', c.id);
    });

    it('revoking A leaves the same cards', async () => {
      const { a, other } = await cards();
      f.service.revoke(a.id);
      expect(left()).toEqual(['B asks', 'You']);
      for (const c of f.store.getState().approvals) f.host.answerApproval('no', c.id);
      await expect(other).resolves.toBe('no');
    });
  });

  it('stop keeps the grant and ends its queue, and leaves your work alone', async () => {
    const { grant } = f.grant();
    await f.host.onAgentRequest(ME, { kind: 'agent_request', requestId: 'mine', prompt: 'mine', viaAgent: false, channel: 'ws:other', urgent: false, plan: false });
    await f.started(grant.id);
    f.host.runExternal(externalRequester(grant.id), CHANNEL, 'next', { requestId: 'queued' });
    expect(f.service.stopAgent(grant.id)).toBe(true);
    await waitFor(() => f.status()?.status === 'error');
    expect(f.service.grants.list().map((g) => g.id)).toEqual([grant.id]);
    expect(f.store.getState().log.find((l) => l.type === 'agent' && l.requestId === 'queued')).toMatchObject({ status: 'error', text: expect.stringContaining('out of the queue') });
    expect(f.host.runningIn('ws:other')).toBe(true);
    expect(f.service.stopAgent(grant.id)).toBe(false);
  });

  it('stop cancels the friend tasks it sent, and only those', async () => {
    const { grant } = f.grant();
    const cancel = vi.fn();
    attachGateway(f.session, { cancel } as unknown as Gateway);
    const state = f.store.getState();
    const tasks = [{ id: 't_mine', direction: 'sent', viaId: grant.id, state: 'sent' }, { id: 't_other', direction: 'sent', state: 'sent' }, { id: 't_done', direction: 'sent', viaId: grant.id, state: 'done' }];
    vi.spyOn(f.store, 'getState').mockReturnValue({ ...state, gateway: { ...state.gateway, tasks } } as never);
    expect(stopAgentWork(f.session, grant.id)).toBe(true);
    expect(cancel.mock.calls).toEqual([['t_mine']]);
  });

  it('stop from the phone ends a run on the Mac', async () => {
    const { grant } = f.grant();
    await f.started(grant.id);
    for (const method of ['external.agents', 'external.stopAgent', 'external.stopAll', 'external.revoke', 'external.activity'] as const) {
      expect(PHONE[method], method).toBe('phone');
      expect(EXTERNAL_ACCESS[method], method).toHaveProperty('refused');
    }
    expect(EXTERNAL_HANDLERS['external.stopAgent'](f.session, grant.id)).toBe(true);
    await waitFor(() => f.status()?.status === 'error');
  });

  it('stop all reaches every agent', async () => {
    const one = f.grant().grant;
    f.grant();
    await f.started(one.id);
    expect(f.service.stopAll()).toBe(1);
    await waitFor(() => f.status()?.status === 'error');
  });

  it('a card waiting on a person names the agent in NeedsYou', async () => {
    const { grant } = f.grant();
    const input = await f.started(grant.id);
    void input.canUseTool('Bash', { command: 'ls' });
    await waitFor(() => f.store.getState().approvals.length === 1);
    expect(waitingNeeds(f.store.getState())[0]).toMatchObject({ from: 'GrokBot', title: 'GrokBot, your external agent, wants to use Bash' });
    f.service.stopAgent(grant.id);
  });

  it('activity shows allowed, asked and refused calls with who decided', async () => {
    const { grant, token } = f.grant('ask');
    const c = await connect(token);
    await c.callTool({ name: 'beluga_chat_interrupt', arguments: {} }); // outside its projects: refused by rule
    await c.callTool({ name: 'beluga_chat_send', arguments: {} }); // asked, yes
    f.answer.value = 'no';
    await c.callTool({ name: 'beluga_chat_read', arguments: {} }); // asked, no
    const trusted = f.grant('trusted');
    await client?.close();
    const t = await connect(trusted.token);
    await t.callTool({ name: 'beluga_chat_read', arguments: {} }); // allowed by rule
    const all = f.service.activity();
    expect(all.map((r) => [r.tool, r.kind, r.decidedBy])).toEqual([
      ['beluga_chat_read', 'allowed', 'rule'],
      ['beluga_chat_read', 'refused', 'person'],
      ['beluga_chat_send', 'asked', 'person'],
      ['beluga_chat_interrupt', 'refused', 'rule'],
    ]);
    expect(f.service.activity({ agent: grant.id }).map((r) => r.agentId)).toEqual([grant.id, grant.id, grant.id]);
    expect(f.service.activity({ kind: 'refused' })).toHaveLength(2);
    expect(f.asks[0]).toEqual({ title: 'GrokBot wants to use beluga_chat_send', agent: 'GrokBot' });
  });

  it('pause refuses every agent and keeps the grants; it survives a restart of the listener', async () => {
    const { token } = f.grant();
    const c = await connect(token);
    await expect(c.callTool({ name: 'beluga_chat_read', arguments: {} })).resolves.toBeTruthy();
    expect(f.service.setPaused(true).paused).toBe(true);
    await expect(c.callTool({ name: 'beluga_chat_read', arguments: {} })).rejects.toThrow();
    expect(f.service.grants.list()).toHaveLength(1);
    expect(f.service.setPaused(false).paused).toBeUndefined();
    await client?.close();
    const again = await connect(token);
    await expect(again.callTool({ name: 'beluga_chat_read', arguments: {} })).resolves.toBeTruthy();
  });
});

describe('tool-call cards, through the real launch wiring', () => {
  const WS = { id: 'w1', kind: 'worktree', name: 'w1', path: '/tmp/p/w1', branch: 'b' };
  let dir: string;
  let stop: () => Promise<void>;
  const clients: Client[] = [];

  async function wiring() {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-cards-'));
    vi.stubEnv('BELUGA_HOME', dir);
    vi.stubEnv('BELUGA_EXTERNAL_PORT', '0');
    const store = new Store({ ...initialState('room', 'ask'), projects: [{ id: 'p1', name: 'api', root: '/tmp/p', workspaces: [WS] }] } as never);
    const setTrust = vi.fn();
    const runs: AgentRunInput[] = [];
    const host = new AgentHost({
      store, selfId: () => ME, send: (() => true) as never, agent: () => ({ run: (input) => new Promise((_ok, no) => { runs.push(input); input.signal.addEventListener('abort', () => no(new Error('aborted'))); }) }), shares: {} as never,
      workspaces: { place: () => ({ cwd: '/tmp/p', additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never, people: { setTrust } as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined, system: () => undefined, approvalTimeoutMs: () => 60_000, refreshUsage: async () => undefined,
    });
    const session = { store, host, toast: () => undefined, sendChat: vi.fn(), questions: {}, workspaces: { ensureLoaded: () => undefined, manager: { find: () => undefined, loadHistory: () => [] } } } as unknown as Session;
    stop = launchExternal({ session });
    const service = needExternal(session);
    await service.setEnabled(true);
    const connect = async (name: string) => {
      const { grant, token } = service.grants.create({ name, clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'ask', projects: ['p1'], expiresAt: Date.now() + 60_000 });
      const client = new Client({ name: 'cards-test', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      // A call still open when its client closes is not what these tests are about.
      const tool = (name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> => {
        const called = client.callTool({ name, arguments: args }) as never as Promise<{ content: Array<{ text: string }> }>;
        called.catch(() => undefined);
        return called;
      };
      const send = () => tool('beluga_chat_interrupt', { chat: 'w1' });
      const list = () => tool('beluga_project_list', {});
      const chats = (offset: number) => tool('beluga_chat_list', { offset });
      return { grant, send, list, chats };
    };
    const cards = () => store.getState().approvals;
    return { store, host, service, connect, cards, setTrust, runs };
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    await stop?.();
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a card names its agent as peer and holds up the chat it is about', async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    void a.send();
    await waitFor(() => w.cards().length === 1);
    expect(w.cards()[0]).toMatchObject({ peer: externalRequester(a.grant.id), channel: 'ws:w1', asker: 'GrokBot', kind: 'tool' });
    void a.list();
    await waitFor(() => w.cards().length === 2);
    expect(w.cards()[1]).toMatchObject({ peer: externalRequester(a.grant.id), asker: 'GrokBot' });
    // No chat to hold up: it waits in the agent's own place, not in the group chat, and opens no chat on the phone.
    expect(w.cards()[1]?.channel).toBe(externalRequester(a.grant.id));
    expect(waitingNeeds(w.store.getState()).find((n) => n.id === `approval:${w.cards()[1]?.id}`)?.topic).toBeUndefined();
    expect(waitingNeeds(w.store.getState()).every((n) => n.from === 'GrokBot')).toBe(true);
    w.service.stopAgent(a.grant.id);
  });

  it('no card of the agent waits after revoke', async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    const b = await w.connect('Other');
    const called = a.send();
    void a.list();
    void b.list();
    await waitFor(() => w.cards().length === 3);
    w.service.revoke(a.grant.id);
    expect(w.cards().map((c) => c.asker)).toEqual(['Other']);
    expect(JSON.parse((await called).content[0]!.text).error).toBe('grant_gone');
    w.service.stopAgent(b.grant.id);
  });

  it('a card from a real tool call is no card of the run: its own interrupt leaves it, stopAgent ends it', async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    const ext = externalRequester(a.grant.id);
    w.host.runExternal(ext, 'ws:w1', 'work');
    await waitFor(() => w.runs.length === 1);
    const step = w.runs[0]!.canUseTool('Bash', { command: 'ls' });
    const called = a.send();
    await waitFor(() => w.cards().length === 2);
    expect(w.host.interruptExternal(ext, 'ws:w1')).toBe('stopped');
    await expect(step).resolves.toBe(false);
    expect(w.cards().map((c) => c.title)).toEqual(['GrokBot wants to use beluga_chat_interrupt']);
    w.service.stopAgent(a.grant.id);
    expect(w.cards()).toEqual([]);
    expect(JSON.parse((await called).content[0]!.text).error).toBe('declined');
  });

  it('no card of the agent waits after stopAgent, and its grant stays', async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    void a.send();
    void a.list();
    await waitFor(() => w.cards().length === 2);
    w.service.stopAgent(a.grant.id);
    expect(w.cards()).toEqual([]);
    expect(w.service.grants.list()).toHaveLength(1);
  });

  it("the agent's 4th waiting card gets the cap's no, and another agent's card still shows", async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    const b = await w.connect('Other');
    for (let i = 0; i < 3; i++) void a.chats(i);
    await waitFor(() => w.cards().length === 3);
    expect(JSON.parse((await a.chats(3)).content[0]!.text).error).toBe('declined');
    expect(w.cards()).toHaveLength(3);
    void b.list();
    await waitFor(() => w.cards().length === 4);
    expect(w.cards()[3]?.asker).toBe('Other');
    w.service.stopAll();
  });

  it('the same call twice shares one card', async () => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    void a.list();
    await waitFor(() => w.cards().length === 1);
    void a.list();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.cards()).toHaveLength(1);
    w.service.stopAll();
  });

  it.each(['yes', 'always', 'no'] as const)('an answer %s on such a card writes no trust entry', async (answer) => {
    const w = await wiring();
    const a = await w.connect('GrokBot');
    const before = w.store.getState().levels;
    const called = a.list();
    await waitFor(() => w.cards().length === 1);
    w.host.answerApproval(answer);
    await called;
    expect(w.setTrust).not.toHaveBeenCalled();
    expect(w.store.getState().levels).toEqual(before);
  });
});

describe('a held yes after a stop, and a card a retry replaces', () => {
  let dir: string;
  let service: ExternalService | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await service?.stop();
    service = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = async (name: ExternalToolDef['name'], level: 'ask' | 'trusted' = 'trusted') => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-held-'));
    const ran = vi.fn(() => ({ ok: true }));
    const cards: Array<{ answer: (a: 'yes' | 'no') => void; aborted: () => boolean; detail: string }> = [];
    const tool: ExternalToolDef = { name, description: '', inputSchema: { x: z.string().optional() }, resolve: () => ({ target: 'chat:c1', inScope: true }), run: ran };
    service = new ExternalService({
      configFile: path.join(dir, 'c.json'),
      grantFile: path.join(dir, 'g.json'),
      auditFile: path.join(dir, 'a.jsonl'),
      port: 0,
      cardWaitMs: 40,
      tools: [tool],
      ask: (_title, detail, _once, _card, signal) =>
        new Promise((resolve) => {
          cards.push({ answer: resolve, aborted: () => signal?.aborted === true, detail });
        }),
    });
    await service.setEnabled(true);
    const { grant, token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], expiresAt: Date.now() + 60_000 });
    client = new Client({ name: 'held-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (args: Record<string, unknown> = {}): Promise<string> => JSON.stringify((await client!.callTool({ name, arguments: args })).content);
    return { grant, call, ran, cards, service };
  };

  it.each([['a read', 'beluga_chat_read', 'ask'], ['a delete', 'sentinel_remove', 'trusted'], ['an archive', 'archive_worktree', 'trusted'], ['a merge', 'merge_worktree', 'trusted']] as const)('%s: a yes, then Stop, then the same call runs nothing, and it asks again', async (_label, name, level) => {
    const f = await fixture(name, level);
    expect(await f.call()).toContain('waiting_for_owner');
    f.cards[0]!.answer('yes');
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.service.stopAgent(f.grant.id);
    expect(await f.call()).toContain('waiting_for_owner');
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.cards).toHaveLength(2);
    // The same with no Stop, so the test can tell the two apart.
    f.cards[1]!.answer('yes');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.call();
    expect(f.ran).toHaveBeenCalledTimes(1);
  });

  it('Stop all drops them too', async () => {
    const f = await fixture('sentinel_remove');
    await f.call();
    f.cards[0]!.answer('yes');
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.service.stopAll();
    await f.call();
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.cards).toHaveLength(2);
  });

  it('a call still waiting when Stop comes gets no, whatever comes after', async () => {
    const f = await fixture('sentinel_remove');
    await f.call();
    const second = f.call();
    f.service.stopAgent(f.grant.id);
    f.cards[0]!.answer('yes');
    expect(await second).toMatch(/waiting_for_owner|declined/);
    expect(f.ran).not.toHaveBeenCalled();
  });

  it('a retry with other arguments leaves one card: the old one answers no, and its yes runs nothing', async () => {
    const f = await fixture('sentinel_remove');
    expect(await f.call({ x: 'one' })).toContain('waiting_for_owner');
    expect(await f.call({ x: 'two' })).toContain('waiting_for_owner');
    expect(f.cards).toHaveLength(2);
    expect(f.cards[0]!.aborted()).toBe(true);
    expect(f.cards[1]!.aborted()).toBe(false);
    f.cards[1]!.answer('yes');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await f.call({ x: 'one' })).toContain('waiting_for_owner');
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.cards).toHaveLength(3);
  });

  it('the same arguments keep the one card', async () => {
    const f = await fixture('sentinel_remove');
    await f.call({ x: 'one' });
    await f.call({ x: 'one' });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]!.aborted()).toBe(false);
  });

  it('another tool or target keeps its own card', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-held-'));
    const cards: Array<() => boolean> = [];
    service = new ExternalService({
      configFile: path.join(dir, 'c.json'),
      grantFile: path.join(dir, 'g.json'),
      auditFile: path.join(dir, 'a.jsonl'),
      port: 0,
      cardWaitMs: 40,
      tools: [{ name: 'sentinel_remove', description: '', inputSchema: { x: z.string() }, resolve: (a) => ({ target: `sentinel:${String(a.x)}`, inScope: true }), run: () => ({ ok: true }) }],
      ask: (_t, _d, _o, _c, signal) => new Promise(() => void cards.push(() => signal?.aborted === true)),
    });
    await service.setEnabled(true);
    const { token } = service.grants.create({ name: 'A', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: ['p1'], expiresAt: Date.now() + 60_000 });
    client = new Client({ name: 'held-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    await client.callTool({ name: 'sentinel_remove', arguments: { x: 'a' } });
    await client.callTool({ name: 'sentinel_remove', arguments: { x: 'b' } });
    expect(cards.map((aborted) => aborted())).toEqual([false, false]);
  });
});

describe('a card closed on the host', () => {
  it('its signal answers the waiting card no, and leaves the store', async () => {
    const f = fixture();
    const controller = new AbortController();
    const answer = f.host.ask('tool', 'A call', 'd', externalRequester('a1'), 'room', { call: true, signal: controller.signal });
    expect(f.store.getState().approvals).toHaveLength(1);
    controller.abort();
    await expect(answer).resolves.toBe('no');
    expect(f.store.getState().approvals).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});
