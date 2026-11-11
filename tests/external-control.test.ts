import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput, FollowUp, Steer } from '../src/agent/types.js';
import { AgentHost, type ExternalInterrupt } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import { decideTool } from '../src/agent/policy.js';
import { externalRequester } from '../src/core/trust.js';
import { grantLookup } from '../src/external/adapters/runs.js';
import { sessionControl } from '../src/external/adapters/session-control.js';
import { controlTools } from '../src/external/adapters/tools/control.js';
import { chatInScope, readTools } from '../src/external/adapters/tools/read.js';
import { sessionReads } from '../src/external/adapters/session-reads.js';
import { STANDALONE_CHATS } from '../src/external/domain/grant.js';
import { attachExternal } from '../src/external/registry.js';
import { EXTERNAL_HANDLERS } from '../src/ipc/external-handlers.js';
import { CHATS_PROJECT, WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { decide } from '../src/external/domain/decide.js';
import { CHAT_TOOLS, type ChatTool, TOOL_ACCESS } from '../src/external/domain/tools.js';
import type { ChatControl, RunSnapshot } from '../src/external/ports/chat-control.js';
import type { ChatRead, ChatRef } from '../src/external/ports/chat-read.js';
import { ExternalService } from '../src/external/service.js';
import type { Session } from '../src/core/session.js';
import type { BodyOf } from '../src/protocol.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const EXT = 'ext:abc123abc123';
const CHANNEL = 'ws:w1';

function hostFixture(opts: { runFrom?: string; level?: 'ask' | 'trusted' | 'full'; cwd?: string } = {}) {
  const steered: FollowUp[] = [];
  const prompts: string[] = [];
  const inputs: AgentRunInput[] = [];
  let finish: () => void = () => undefined;
  const agent: AgentBackend = {
    run: (input: AgentRunInput) => {
      prompts.push(input.prompt);
      inputs.push(input);
      if (input.prompt !== 'slow') return Promise.resolve('done');
      return new Promise<string>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')));
        const steer: Steer = (f: FollowUp) => {
          steered.push(f);
          return true;
        };
        input.onSteer?.(steer);
        finish = () => resolve('slow done');
      });
    },
  };
  const store = new Store(initialState('room', 'ask'));
  const send = (body: { kind: string } & Record<string, unknown>): boolean => {
    if (body.kind !== 'agent_event') return true;
    const e = body as unknown as BodyOf<'agent_event'>;
    store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
    return true;
  };
  const h = new AgentHost({
    store,
    selfId: () => ME,
    send: send as never,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    workspaces: { place: () => ({ cwd: opts.cwd ?? '/tmp/p', additionalDirectories: [], autoEdit: !opts.cwd, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  });
  h.setExternalAgents((r) => (r === EXT ? { name: 'GrokBot', level: opts.level ?? 'trusted' } : undefined));
  const busy = async (): Promise<void> => {
    if (opts.runFrom === ME) await h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'mine', prompt: 'slow', viaAgent: false, channel: CHANNEL, urgent: false, plan: false });
    else h.runExternal(EXT, CHANNEL, 'slow');
    await waitFor(() => prompts.length === 1);
  };
  const statusOf = (id: string) => (store.getState().log.find((l) => l.type === 'agent' && l.requestId === id) as { status: string; text: string } | undefined);
  return { h, store, steered, prompts, inputs, busy, statusOf, finish: () => finish() };
}

describe('an agent\'s own place', () => {
  it('names the agent, with or without a run', () => {
    expect(hostFixture().h.viaIn(EXT)).toEqual({ id: 'abc123abc123', name: 'GrokBot', creationSource: 'mcp' });
    expect(hostFixture().h.viaIn(CHANNEL)).toBeUndefined();
  });
});

describe('send modes and their delivery', () => {
  it('auto on an idle chat: started', async () => {
    const f = hostFixture();
    expect(f.h.runExternal(EXT, CHANNEL, 'hello', { mode: 'auto' })).toBe('started');
    await waitFor(() => f.prompts.includes('hello'));
  });

  it('auto on a busy chat: queued', async () => {
    const f = hostFixture();
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'next', { mode: 'auto', requestId: 'r2' })).toBe('queued');
    expect(f.statusOf('r2')?.status).toBe('queued');
  });

  it('queue on a busy chat: queued, and it runs after the run ends', async () => {
    const f = hostFixture();
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'next', { mode: 'queue' })).toBe('queued');
    f.finish();
    await waitFor(() => f.prompts.includes('next'));
  });

  it('queue on an idle chat: started', () => {
    expect(hostFixture().h.runExternal(EXT, CHANNEL, 'hello', { mode: 'queue' })).toBe('started');
  });

  it('steer into its own run: steered, with no new run', async () => {
    const f = hostFixture();
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'turn left', { mode: 'steer' })).toBe('steered');
    expect(f.steered.map((s) => s.prompt)).toEqual(['turn left']);
    expect(f.prompts).toEqual(['slow']);
  });

  it('steer into your run does not join it: queued', async () => {
    const f = hostFixture({ runFrom: ME });
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'turn left', { mode: 'steer' })).toBe('queued');
    expect(f.steered).toEqual([]);
  });

  it('restart: restarted, the run stops and the message goes first', async () => {
    const f = hostFixture();
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'instead', { mode: 'restart' })).toBe('restarted');
    await waitFor(() => f.prompts.includes('instead'));
  });

  it('with no live grant: denied', () => {
    expect(hostFixture().h.runExternal('ext:gone', CHANNEL, 'hello')).toBe('denied');
  });

  it('restart on your run: not_interruptible, and your run goes on', async () => {
    const f = hostFixture({ runFrom: ME });
    await f.busy();
    expect(f.h.runExternal(EXT, CHANNEL, 'instead', { mode: 'restart' })).toBe('not_interruptible');
    expect(f.statusOf('mine')?.status).not.toBe('error');
    expect(f.h.runningIn(CHANNEL)).toBe(true);
    expect(f.prompts).toEqual(['slow']);
  });

  it('interrupt stops its own run and leaves what you queued; idle says no_active_run', async () => {
    const f = hostFixture();
    expect(f.h.interruptExternal(EXT, CHANNEL)).toBe('no_active_run');
    await f.busy();
    await f.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'later', prompt: 'later', viaAgent: false, channel: CHANNEL, urgent: false, plan: false });
    expect(f.h.interruptExternal(EXT, CHANNEL)).toBe('stopped');
    await waitFor(() => f.prompts.includes('later'));
  });

  it('interrupt on your run takes only its own queued item, and your run goes on', async () => {
    const f = hostFixture({ runFrom: ME });
    await f.busy();
    await f.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'later', prompt: 'later', viaAgent: false, channel: CHANNEL, urgent: false, plan: false });
    f.h.runExternal(EXT, CHANNEL, 'its own', { mode: 'queue', requestId: 'r9' });
    expect(f.statusOf('r9')?.status).toBe('queued');
    expect(f.h.interruptExternal(EXT, CHANNEL)).toBe('not_yours');
    expect(f.statusOf('r9')).toMatchObject({ status: 'error', text: 'Taken out of the queue' });
    expect(f.statusOf('later')?.status).toBe('queued');
    expect(f.statusOf('mine')?.status).not.toBe('error');
    expect(f.h.runningIn(CHANNEL)).toBe(true);
  });
});

const chat = (over: Partial<ChatRef> & Pick<ChatRef, 'id'>): ChatRef => ({ kind: 'project', title: over.id, projectId: 'p1', projectName: 'api', status: 'idle', createdBy: 'you', creationSource: 'beluga', ...over });
const CHATS = [chat({ id: 'c1' }), chat({ id: 'mine' }), chat({ id: 'old', status: 'archived' }), chat({ id: 'c3', projectId: 'p2' }), chat({ id: 'dm:bob', kind: 'dm', projectId: undefined } as ChatRef)];
const reads: ChatRead = { projects: () => [{ id: 'p1', name: 'api' }, { id: 'p2', name: 'web' }], chats: () => CHATS, history: () => [], steps: () => undefined, needs: () => [], runtimes: async () => [] };

describe('the tools', () => {
  let dir: string;
  let service: ExternalService;
  let client: Client | undefined;
  let grantId = '';
  let snapshot: RunSnapshot;
  let cards: Array<{ title: string; once: boolean }>;
  let answer: 'yes' | 'no' | 'always';
  const control = {
    launch: vi.fn(async () => ({ chatId: 'new', runId: 'r1', delivery: 'started' as const })),
    send: vi.fn(async () => ({ runId: 'r1', delivery: 'queued' as const })),
    run: vi.fn(() => snapshot),
    interrupt: vi.fn((): ExternalInterrupt => 'no_active_run'),
    rename: vi.fn(async () => undefined),
    startedBy: vi.fn((id: string) => (id === 'mine' ? grantId : undefined)),
    questions: vi.fn((): ReturnType<ChatControl['questions']> => [{ id: 'q1', chatId: 'mine', runId: 'r1', questions: [{ question: 'Which?', header: 'Pick', options: ['a'], multiSelect: false }] }]),
    answerQuestion: vi.fn(() => true),
  } satisfies ChatControl;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-control-'));
    vi.clearAllMocks();
    snapshot = { status: 'running', runId: 'r1', hasPendingQuestion: false };
    cards = [];
    answer = 'yes';
    service = new ExternalService({ configFile: path.join(dir, 'c.json'), grantFile: path.join(dir, 'g.json'), auditFile: path.join(dir, 'a.jsonl'), port: 0, tools: [...readTools(reads), ...controlTools(reads, control, { waitPollMs: 5 })], ask: async (title, _d, once) => { cards.push({ title, once }); return answer; } });
    await service.setEnabled(true);
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = async (level: 'ask' | 'trusted' = 'trusted'): Promise<Client> => {
    const { token, grant } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], expiresAt: Date.now() + 60_000 });
    grantId = grant.id;
    client = new Client({ name: 'control-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text);
  };

  it('offers every registered tool', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CHAT_TOOLS].sort());
  });

  it('a retry with the same clientRequestId creates no new work', async () => {
    const c = await connect();
    const first = await call(c, 'beluga_chat_send', { chat: 'mine', message: 'hi', clientRequestId: 'k1' });
    const again = await call(c, 'beluga_chat_send', { chat: 'mine', message: 'hi', clientRequestId: 'k1' });
    expect(again).toEqual(first);
    expect(control.send).toHaveBeenCalledTimes(1);
    await call(c, 'beluga_chat_send', { chat: 'mine', message: 'hi', clientRequestId: 'k2' });
    expect(control.send).toHaveBeenCalledTimes(2);
    await call(c, 'beluga_chat_launch', { project: 'api', message: 'go', clientRequestId: 'k1' });
    await call(c, 'beluga_chat_launch', { project: 'api', message: 'go', clientRequestId: 'k1' });
    expect(control.launch).toHaveBeenCalledTimes(1);
  });

  it('a failed launch may be tried again with the same id', async () => {
    const c = await connect();
    control.launch.mockRejectedValueOnce(new Error('no'));
    expect((await call(c, 'beluga_chat_launch', { project: 'api', message: 'go', clientRequestId: 'k1' })).error).toBe('invalid_request');
    expect((await call(c, 'beluga_chat_launch', { project: 'api', message: 'go', clientRequestId: 'k1' })).chatId).toBe('new');
  });

  it('launch stays in the grant, and a launch is an acknowledgement', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_launch', { project: 'web', message: 'go' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_launch', { project: 'api', message: 'go', workspaceStrategy: 'existing_worktree', chat: 'c3' })).error).toBe('not_found');
    expect(await call(c, 'beluga_chat_launch', { project: 'api', message: 'go' })).toEqual({ chatId: 'new', runId: 'r1', delivery: 'started' });
    expect(control.launch.mock.calls.at(-1)).toMatchObject([{ strategy: 'worktree', by: { name: 'GrokBot' } }]);
  });

  it('a wait timeout leaves the run going', async () => {
    const c = await connect();
    const out = await call(c, 'beluga_chat_wait', { chat: 'mine', timeoutMs: 20 });
    expect(out).toMatchObject({ status: 'running', terminal: false, timedOut: true, runId: 'r1' });
    expect(control.interrupt).not.toHaveBeenCalled();
  });

  it('wait ends on a final status', async () => {
    const c = await connect();
    snapshot = { status: 'completed', runId: 'r1', hasPendingQuestion: false, text: 'all done' };
    expect(await call(c, 'beluga_chat_wait', { chat: 'mine' })).toMatchObject({ status: 'completed', terminal: true, timedOut: false, text: { untrusted: true, text: 'all done' } });
  });

  it('wait ends on a pending approval, which grants nothing', async () => {
    const c = await connect();
    snapshot = { status: 'running', runId: 'r1', hasPendingQuestion: false, pendingApproval: { id: 'a1', kind: 'tool', runId: 'r1' } };
    const out = await call(c, 'beluga_chat_wait', { chat: 'mine' });
    expect(out).toMatchObject({ terminal: false, timedOut: false, pendingApproval: { id: 'a1', kind: 'tool', runId: 'r1', grantsAuthority: false } });
    // The id answers nothing: a question tool knows only questions, and no tool takes an approval.
    expect((await call(c, 'beluga_question_answer', { action: 'respond', question: 'a1', answers: { x: 'yes' } })).error).toBe('not_found');
    expect(control.answerQuestion).not.toHaveBeenCalled();
  });

  it('wait ends on a pending question', async () => {
    const c = await connect();
    snapshot = { status: 'running', runId: 'r1', hasPendingQuestion: true };
    expect(await call(c, 'beluga_chat_wait', { chat: 'mine' })).toMatchObject({ hasPendingQuestion: true, timedOut: false });
  });

  it('interrupt says no_active_run when idle and is never final', async () => {
    const c = await connect();
    expect(await call(c, 'beluga_chat_interrupt', { chat: 'mine' })).toEqual({ status: 'no_active_run', terminal: false });
    control.interrupt.mockReturnValueOnce('stopped');
    expect(await call(c, 'beluga_chat_interrupt', { chat: 'mine' })).toEqual({ status: 'interrupt_requested', terminal: false });
    control.interrupt.mockReturnValueOnce('not_yours');
    expect((await call(c, 'beluga_chat_interrupt', { chat: 'mine' })).error).toBe('not_interruptible');
  });

  it('an ask-level agent cannot act on a chat it did not start without a card, even after Always', async () => {
    const c = await connect('ask');
    answer = 'always';
    await call(c, 'beluga_chat_send', { chat: 'mine', message: 'hi', mode: 'steer' });
    expect(cards).toEqual([{ title: 'GrokBot wants to use beluga_chat_send', once: false }]);
    await call(c, 'beluga_chat_send', { chat: 'mine', message: 'again', mode: 'steer' });
    expect(cards).toHaveLength(1);
    await call(c, 'beluga_chat_send', { chat: 'c1', message: 'hi', mode: 'steer' });
    expect(cards).toHaveLength(2);
    expect(cards[1]!.once).toBe(true);
    answer = 'no';
    expect((await call(c, 'beluga_chat_send', { chat: 'c1', message: 'hi', mode: 'steer' })).error).toBe('declined');
    expect(cards).toHaveLength(3);
    expect(control.send).toHaveBeenCalledTimes(3);
    expect((await call(c, 'beluga_chat_interrupt', { chat: 'c1' })).error).toBe('declined');
  });

  it('a trusted agent acts on a chat in its projects with no card', async () => {
    const c = await connect('trusted');
    await call(c, 'beluga_chat_send', { chat: 'c1', message: 'hi' });
    expect(cards).toEqual([]);
    expect(control.send).toHaveBeenCalledTimes(1);
  });

  it('refuses chats it cannot work in', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_send', { chat: 'dm:bob', message: 'hi' })).error).toBe('not_sendable');
    expect((await call(c, 'beluga_chat_send', { chat: 'old', message: 'hi' })).error).toBe('not_sendable');
    expect((await call(c, 'beluga_chat_send', { chat: 'c3', message: 'hi' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_send', { chat: 'nope', message: 'hi' })).error).toBe('not_found');
  });

  it('update renames', async () => {
    const c = await connect();
    await call(c, 'beluga_chat_update', { chat: 'mine', name: 'New name' });
    expect(control.rename).toHaveBeenCalledWith('mine', 'New name');
  });

  it('questions: list, read and respond, for this agent only', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_question_answer', { action: 'list' })).questions[0]).toMatchObject({ id: 'q1', questions: [{ question: { untrusted: true, text: 'Which?' } }] });
    expect((await call(c, 'beluga_question_answer', { action: 'read', question: 'q1' })).question.id).toBe('q1');
    expect(await call(c, 'beluga_question_answer', { action: 'respond', question: 'q1', answers: { 'Which?': 'a' } })).toEqual({ answered: true, terminal: false });
    expect(control.answerQuestion).toHaveBeenCalledWith(grantId, 'q1', { 'Which?': 'a' });
  });
});

describe('approvals stay a person\'s, through every tool', () => {
  let dir: string;
  let client: Client | undefined;
  let service: ExternalService | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await service?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A real host with your run and card in c1, and the agent's run and card in mine. */
  async function fixture() {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-cards-only-'));
    const store = new Store({ ...initialState('room', 'ask'), prefs: { ...initialState('room', 'ask').prefs, selfApproval: 'ask' } });
    const inputs = new Map<string, AgentRunInput>();
    const aborted: string[] = [];
    const agent: AgentBackend = { run: (input) => new Promise((_ok, no) => {
      inputs.set(input.channel!, input);
      input.signal.addEventListener('abort', () => { aborted.push(input.channel!); no(new Error('aborted')); });
    }) };
    const send = (body: { kind: string } & Record<string, unknown>): boolean => {
      if (body.kind !== 'agent_event') return true;
      const e = body as unknown as BodyOf<'agent_event'>;
      store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
      return true;
    };
    const questions = { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: vi.fn(), cancelChannel: vi.fn() };
    const host = new AgentHost({
      store, selfId: () => ME, send: send as never, agent: () => agent, shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never, people: {} as never, questions: questions as never,
      workspaces: { place: () => ({ cwd: '/tmp/p', additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
      toast: () => undefined, system: () => undefined, approvalTimeoutMs: () => 60_000, refreshUsage: async () => undefined,
    });
    const answers: Array<{ answer: string; id: string | undefined }> = [];
    const real = host.answerApproval.bind(host);
    vi.spyOn(host, 'answerApproval').mockImplementation((answer, id) => {
      answers.push({ answer, id });
      return real(answer, id);
    });
    const session = {
      store, host, toast: () => undefined, sendChat: vi.fn(), runsAgent: () => true, agentRef: { runtime: 'claude', label: 'Claude' },
      questions: { answer: vi.fn() },
      workspaces: { ensureLoaded: () => undefined, agentIn: () => undefined, renameChat: async () => undefined, refresh: async () => undefined, newChat: async () => ({ id: 'n' }), startWorktree: async () => ({ id: 'n' }), manager: { find: () => undefined, setStartedBy: () => undefined, setModel: () => undefined, setAgent: () => undefined } },
    } as unknown as Session;
    service = new ExternalService({ configFile: path.join(dir, 'c.json'), grantFile: path.join(dir, 'g.json'), auditFile: path.join(dir, 'a.jsonl'), port: 0, tools: [...readTools(reads), ...controlTools(reads, sessionControl(session))] });
    host.setExternalAgents(grantLookup(service.grants, Date.now));
    await service.setEnabled(true);
    const { grant, token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: ['p1'], expiresAt: Date.now() + 60_000 });
    client = new Client({ name: 'cards-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text);

    await host.onAgentRequest(ME, { kind: 'agent_request', requestId: 'yours', prompt: 'slow', viaAgent: false, channel: 'ws:c1', urgent: false, plan: false });
    await call('beluga_chat_send', { chat: 'mine', message: 'slow' });
    await waitFor(() => inputs.size === 2);
    void inputs.get('ws:c1')!.canUseTool('Bash', { command: 'yours' });
    void inputs.get('ws:mine')!.canUseTool('Bash', { command: 'its' });
    await waitFor(() => store.getState().approvals.length === 2);
    return { store, host, call, answers, aborted, questions, grantId: grant.id };
  }

  const EVERY_TOOL = (chat: string): ReadonlyArray<readonly [string, Record<string, unknown>]> => [
    ['beluga_capabilities', {}],
    ['beluga_project_list', {}],
    ['beluga_needs_list', {}],
    ['beluga_chat_list', {}],
    ['beluga_chat_read', { chat }],
    ['beluga_chat_search', { query: 'x' }],
    ['beluga_chat_wait', { chat, timeoutMs: 0 }],
    ['beluga_chat_launch', { project: 'api', message: 'go', workspaceStrategy: 'root' }],
    ['beluga_chat_launch', { message: 'go' }],
    ['beluga_chat_send', { chat, message: 'hi', mode: 'queue' }],
    ['beluga_chat_send', { chat, message: 'hi', mode: 'steer' }],
    ['beluga_chat_send', { chat, message: 'hi', mode: 'restart' }],
    ['beluga_chat_interrupt', { chat }],
    ['beluga_chat_update', { chat, name: 'New' }],
    ['beluga_question_answer', { action: 'list' }],
    ['beluga_question_answer', { action: 'respond', question: 'nope', answers: { a: 'b' } }],
  ];

  it('no tool says yes, and none touches a card of a run the agent did not start', async () => {
    const f = await fixture();
    const yours = f.store.getState().approvals.find((a) => a.channel === 'ws:c1');
    expect(yours).toBeTruthy();
    for (const [name, args] of EVERY_TOOL('c1')) await f.call(name, args);
    expect(f.answers).toEqual([]);
    expect(f.aborted).toEqual([]);
    expect(f.questions.cancelChannel).not.toHaveBeenCalled();
    expect(f.host.runningIn('ws:c1')).toBe(true);
    expect(f.store.getState().approvals.map((a) => a.id)).toContain(yours!.id);
  });

  it('interrupt and restart on your run return not_interruptible, with your card and run in place', async () => {
    const f = await fixture();
    const before = f.store.getState().approvals.map((a) => a.id);
    expect((await f.call('beluga_chat_interrupt', { chat: 'c1' })).error).toBe('not_interruptible');
    expect((await f.call('beluga_chat_send', { chat: 'c1', message: 'instead', mode: 'restart' })).error).toBe('not_interruptible');
    expect(f.store.getState().approvals.map((a) => a.id)).toEqual(before);
    expect(f.host.runningIn('ws:c1')).toBe(true);
  });

  it('interrupting its own run declines the run-step card, and its call card waits until you stop it', async () => {
    const f = await fixture();
    const ext = externalRequester(f.grantId);
    const call = f.host.ask('tool', 'GrokBot wants to use beluga_chat_update', 'On chat:mine', ext, 'ws:mine', { asker: 'GrokBot', call: true });
    await waitFor(() => f.store.getState().approvals.length === 3);
    const step = f.store.getState().approvals.find((a) => a.channel === 'ws:mine' && a.title.includes('Bash'));
    expect(await f.call('beluga_chat_interrupt', { chat: 'mine' })).toEqual({ status: 'interrupt_requested', terminal: false });
    expect(f.answers).toEqual([{ answer: 'no', id: step!.id }]);
    expect(f.store.getState().approvals.map((a) => a.title)).toContain('GrokBot wants to use beluga_chat_update');
    expect(f.host.stopExternal(ext)).toBe(true);
    await expect(call).resolves.toBe('no');
    expect(f.store.getState().approvals.filter((a) => a.peer === ext)).toEqual([]);
  });

  it('a call card leaves the private set once answered: a later run card is declined as usual', async () => {
    const f = await fixture();
    const ext = externalRequester(f.grantId);
    const call = f.host.ask('tool', 'A call', 'd', ext, 'ws:mine', { asker: 'GrokBot', call: true });
    await waitFor(() => f.store.getState().approvals.length === 3);
    f.host.answerApproval('yes', f.store.getState().approvals.find((a) => a.title === 'A call')!.id);
    await expect(call).resolves.toBe('yes');
    expect((f.host as unknown as { callCards: Set<string> }).callCards.size).toBe(0);
  });

  it('each no comes with a stop of its own run, and only its own cards go', async () => {
    const f = await fixture();
    const own = f.store.getState().approvals.find((a) => a.channel === 'ws:mine');
    expect(own).toBeTruthy();
    expect(await f.call('beluga_chat_interrupt', { chat: 'mine' })).toEqual({ status: 'interrupt_requested', terminal: false });
    expect(f.answers).toEqual([{ answer: 'no', id: own!.id }]);
    await waitFor(() => f.aborted.includes('ws:mine'));
    expect(f.aborted).toEqual(['ws:mine']);
    expect(f.host.runningIn('ws:c1')).toBe(true);
  });
});

describe('approvals stay a person\'s', () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : [p];
  });

  it('no external source names host.answerApproval or the approvals API', () => {
    const files = sources('src/external');
    expect(files.length).toBeGreaterThan(10);
    for (const f of files.filter((x) => !x.endsWith('coverage.ts'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/answerApproval|host\.answer/);
  });

  it('no tool reaches it: every port method over a session, with a trap on it', async () => {
    const trap = vi.fn();
    const store = new Store(initialState('room', 'ask'));
    const session = {
      store,
      toast: () => undefined,
      host: { answerApproval: trap, runExternal: () => 'started', interruptExternal: () => 'no_active_run', runningIn: () => false, externalLevel: () => 'trusted' },
      questions: { answer: vi.fn() },
      workspaces: { ensureLoaded: () => undefined, agentIn: () => undefined, renameChat: async () => undefined, refresh: async () => undefined, newChat: async () => ({ id: 'n' }), startWorktree: async () => ({ id: 'n' }), manager: { find: () => undefined, setStartedBy: () => undefined, setModel: () => undefined, setAgent: () => undefined } },
      sendChat: () => undefined,
      runsAgent: () => true, agentRef: { runtime: 'claude', label: 'Claude' },
    } as unknown as Session;
    const port = sessionControl(session);
    const by = { id: 'g', name: 'GrokBot' };
    await port.launch({ by, projectId: 'p', message: 'm', strategy: 'root' });
    await port.send({ by, chatId: 'c', message: 'm', mode: 'auto' });
    port.run('c');
    port.interrupt(by, 'c');
    await port.rename('c', 'n');
    port.startedBy('c');
    port.questions('g');
    port.answerQuestion('g', 'q', { a: 'b' });
    expect(trap).not.toHaveBeenCalled();
  });

  it('a snapshot points at the approval and gives the run', () => {
    const store = new Store(initialState('room', 'ask'));
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: EXT, event: 'started', text: '', ts: 1, channel: 'ws:c' });
    store.dispatch({ type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 't', detail: 'd', channel: 'ws:c' } });
    const port = sessionControl({ store } as unknown as Session);
    expect(port.run('c')).toEqual({ runId: 'r1', status: 'running', hasPendingQuestion: false, pendingApproval: { id: 'a1', kind: 'tool', runId: 'r1' } });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: EXT, event: 'error', text: 'Interrupted by GrokBot', ts: 2, channel: 'ws:c' });
    expect(port.run('c')).toMatchObject({ status: 'interrupted', hasPendingQuestion: false });
    expect(port.run('c').pendingApproval).toBeUndefined();
  });
});

describe('a sidebar chat, with no project', () => {
  let dir: string;
  let service: ExternalService;
  let clients: Client[];
  let cards: string[];
  let answer: 'yes' | 'no';
  let manager: WorkspaceManager;
  let toasts: string[];
  let newChat: ReturnType<typeof vi.fn>;
  let posted: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-standalone-'));
    cards = [];
    clients = [];
    toasts = [];
    answer = 'yes';
    manager = new WorkspaceManager(new WorkspaceStore(path.join(dir, 'home')));
    await manager.refresh();
    const store = new Store(initialState('room', 'ask'));
    const state = () => ({ ...store.getState(), projects: manager.list });
    newChat = vi.fn((project: string, title: string, inDir?: string) => manager.createChat(project, title, inDir));
    posted = vi.fn();
    const session = {
      store: { getState: state }, toast: (t: string) => void toasts.push(t), sendChat: posted, runsAgent: () => true, agentRef: { runtime: 'claude', label: 'Claude' },
      host: { externalLevel: () => 'trusted', runExternal: () => 'started', runningIn: () => false, mayRestartExternal: () => true, interruptExternal: () => 'no_active_run' },
      questions: { answer: vi.fn() },
      workspaces: { ensureLoaded: () => undefined, agentIn: () => undefined, renameChat: async () => undefined, refresh: async () => undefined, newChat, startWorktree: vi.fn(), manager },
    } as unknown as Session;
    const reads = sessionReads({ state: state as never, loadHistory: () => [], stepsFor: () => ({ steps: [], missing: true }) as never, runtimes: async () => [] });
    service = new ExternalService({ configFile: path.join(dir, 'c.json'), grantFile: path.join(dir, 'g.json'), auditFile: path.join(dir, 'a.jsonl'), port: 0, tools: [...readTools(reads), ...controlTools(reads, sessionControl(session))], ask: async (title) => { cards.push(title); return answer; } });
    await service.setEnabled(true);
  });
  afterEach(async () => {
    for (const c of clients) await c.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = async (level: 'blocked' | 'ask' | 'trusted' | 'full' = 'trusted', projects: 'all' | readonly string[] = []) => {
    const { token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects, expiresAt: Date.now() + 60_000 });
    const client = new Client({ name: 'standalone-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (name: string, args: Record<string, unknown> = {}): Promise<any> => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text);
  };
  const auditLast = () => JSON.parse(readFileSync(path.join(dir, 'a.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { target: string; result: string };

  it('names the same pseudo-project as the sidebar', () => {
    expect(STANDALONE_CHATS).toBe(CHATS_PROJECT);
  });

  it('makes a chat in a folder of its own, started by the agent, with no project on the grant', async () => {
    const call = await connect();
    const one = await call('beluga_chat_launch', { message: 'look at this' });
    const two = await call('beluga_chat_launch', { message: 'and this' });
    const made = manager.find(one.chatId)!;
    expect(made.projectId).toBe(CHATS_PROJECT);
    expect(made.kind).toBe('chat');
    expect(made.startedByAgent).toMatchObject({ name: 'GrokBot' });
    expect(path.basename(made.path)).toBe(one.chatId);
    expect(path.basename(path.dirname(made.path))).toBe('chats');
    expect(statSync(made.path).isDirectory()).toBe(true);
    expect(manager.find(two.chatId)!.path).not.toBe(made.path);
    expect(auditLast()).toMatchObject({ target: `chat:${two.chatId}`, result: 'ok' });
    expect(toasts).toEqual(['GrokBot started a chat']);
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it.each(['worktree', 'existing_worktree'])('%s with no project is invalid_request, and makes nothing', async (workspaceStrategy) => {
    const call = await connect();
    expect((await call('beluga_chat_launch', { message: 'go', workspaceStrategy })).error).toBe('invalid_request');
    expect(newChat).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('takes no folder from an argument', async () => {
    const call = await connect();
    const elsewhere = path.join(dir, 'elsewhere');
    const out = await call('beluga_chat_launch', { message: 'go', workspaceStrategy: 'root', inDir: elsewhere, cwd: elsewhere, path: elsewhere, dir: elsewhere });
    expect(newChat.mock.calls).toEqual([[CHATS_PROJECT, 'go', undefined, { quiet: true }]]);
    expect(manager.find(out.chatId)!.path).not.toContain('elsewhere');
    const launch = (await clients[0]!.listTools()).tools.find((t) => t.name === 'beluga_chat_launch')!;
    expect(launch.inputSchema.required).toEqual(['message']);
    expect(Object.keys(launch.inputSchema.properties!).filter((k) => /dir|path|cwd|folder/i.test(k))).toEqual([]);
  });

  it('reaches its own chat; yours only once the grant names chats', async () => {
    const yours = await manager.createChat(CHATS_PROJECT, 'private');
    const call = await connect();
    const { chatId } = await call('beluga_chat_launch', { message: 'go' });
    expect((await call('beluga_chat_read', { chat: chatId })).chat.id).toBe(chatId);
    expect((await call('beluga_chat_read', { chat: chatId })).chat.startedById).toBeUndefined();
    expect((await call('beluga_chat_send', { chat: chatId, message: 'more' })).delivery).toBe('started');
    expect((await call('beluga_chat_read', { chat: yours.id })).error).toBe('project_denied');
    expect((await call('beluga_chat_send', { chat: yours.id, message: 'hi' })).error).toBe('project_denied');
    const listed = (await call('beluga_chat_list', { project: STANDALONE_CHATS })).chats.map((c: { id: string }) => c.id);
    expect(listed).toEqual([chatId]);
    expect((await call('beluga_capabilities')).standaloneChats).toBe('started_by_this_agent');

    const other = await connect('trusted');
    expect((await other('beluga_chat_read', { chat: chatId })).error).toBe('project_denied');

    const named = await connect('trusted', [STANDALONE_CHATS]);
    expect((await named('beluga_chat_read', { chat: yours.id })).chat.id).toBe(yours.id);
    expect((await named('beluga_capabilities')).standaloneChats).toBe('all');
  });

  it('a pairing code names chats only by that word, and a project with that name is not taken for it', () => {
    const session = { store: { getState: () => ({ projects: [{ id: CHATS_PROJECT, name: 'Chats', root: '' }, { id: 'p9', name: 'web', root: '/r/web' }] }) } } as unknown as Session;
    attachExternal(session, service);
    const pairing = vi.spyOn(service, 'pairingCode');
    EXTERNAL_HANDLERS['external.pairingCode'](session, { level: 'ask', projects: [STANDALONE_CHATS, 'web'] });
    expect(pairing.mock.calls[0]![0].projects).toEqual([STANDALONE_CHATS, 'p9']);
    expect(() => EXTERNAL_HANDLERS['external.pairingCode'](session, { level: 'ask', projects: ['Chats'] })).toThrow('No project called Chats');
    const clash = { store: { getState: () => ({ projects: [{ id: 'p8', name: STANDALONE_CHATS, root: '/r/chats' }] }) } } as unknown as Session;
    attachExternal(clash, service);
    expect(() => EXTERNAL_HANDLERS['external.pairingCode'](clash, { level: 'ask', projects: [STANDALONE_CHATS] })).toThrow('A project is called chats');
    expect(EXTERNAL_HANDLERS['external.pairingCode'](clash, { level: 'ask', projects: ['p8'] })).toBeTruthy();
  });

  it('with no restriction a code reaches what you reach; a list restricts, and empty reaches nothing', () => {
    const session = { store: { getState: () => ({ projects: [{ id: 'p9', name: 'web', root: '/r/web' }] }) } } as unknown as Session;
    attachExternal(session, service);
    const pairing = vi.spyOn(service, 'pairingCode');
    EXTERNAL_HANDLERS['external.pairingCode'](session, {});
    expect(pairing.mock.calls.at(-1)![0]).toEqual({ level: 'full', projects: 'all', chats: { dms: true, groups: true } });
    EXTERNAL_HANDLERS['external.pairingCode'](session, { level: 'ask', projects: ['web'], chats: { dms: false, groups: false } });
    expect(pairing.mock.calls.at(-1)![0]).toEqual({ level: 'ask', projects: ['p9'], chats: { dms: false, groups: false } });
    EXTERNAL_HANDLERS['external.pairingCode'](session, { projects: [] });
    expect(pairing.mock.calls.at(-1)![0].projects).toEqual([]);
  });

  it('a grant for all reaches a project added after it, and your chats; a stored empty list reaches nothing', async () => {
    const all = service.grants.create({ name: 'a', clientId: 'c', redirectHost: 'h', route: 'local', level: 'full', projects: 'all', expiresAt: Date.now() + 60_000 }).grant;
    const none = service.grants.create({ name: 'b', clientId: 'c', redirectHost: 'h', route: 'local', level: 'full', projects: [], expiresAt: Date.now() + 60_000 }).grant;
    const later = chat({ id: 'later', projectId: 'added-later' });
    const yours = chat({ id: 'yours', projectId: CHATS_PROJECT });
    expect(chatInScope(later, all)).toBe(true);
    expect(chatInScope(yours, all)).toBe(true);
    expect(chatInScope(later, none)).toBe(false);
    expect(chatInScope(yours, none)).toBe(false);
    expect(service.grants.list().find((g) => g.id === all.id)!.projects).toBe('all');
    const call = await connect('full', 'all');
    expect((await call('beluga_capabilities')).allProjects).toBe(true);
    expect((await call('beluga_capabilities')).standaloneChats).toBe('all');
  });

  it('a remote code with no level is at trusted; at full with no choice it is refused', () => {
    const session = { store: { getState: () => ({ projects: [] }) } } as unknown as Session;
    attachExternal(session, service);
    const pairing = vi.spyOn(service, 'pairingCode');
    EXTERNAL_HANDLERS['external.pairingCode'](session, { remote: true });
    expect(pairing.mock.results.at(-1)!.type).toBe('return');
    expect(pairing.mock.calls.at(-1)![0]).toMatchObject({ level: 'trusted', remote: true, projects: 'all' });
    expect(() => EXTERNAL_HANDLERS['external.pairingCode'](session, { remote: true, level: 'full' })).toThrow('explicit choice');
    EXTERNAL_HANDLERS['external.pairingCode'](session, { remote: true, level: 'full', allowRemoteFull: true });
    expect(pairing.mock.calls.at(-1)![0]).toMatchObject({ level: 'full', allowRemoteFull: true });
    EXTERNAL_HANDLERS['external.pairingCode'](session, {});
    expect(pairing.mock.calls.at(-1)![0].level).toBe('full');
  });

  it.each(['blocked', 'ask', 'trusted', 'full'] as const)('at level %s launch follows launch_or_send', async (level) => {
    const call = await connect(level);
    const rule = decide({ operation: TOOL_ACCESS.beluga_chat_launch, level, inScope: true });
    answer = 'no';
    const refused = await call('beluga_chat_launch', { message: 'go' });
    if (rule.outcome === 'deny') expect(refused.error).toBe(rule.denial);
    if (rule.outcome === 'ask') expect(refused.error).toBe('declined');
    expect(cards).toHaveLength(rule.outcome === 'ask' ? 1 : 0);
    expect(newChat).toHaveBeenCalledTimes(rule.outcome === 'allow' ? 1 : 0);
    if (rule.outcome !== 'ask') return;
    answer = 'yes';
    expect((await call('beluga_chat_launch', { message: 'go' })).chatId).toBeTruthy();
    expect(newChat).toHaveBeenCalledTimes(1);
  });

  it.each([['ask', 'ask'], ['trusted', 'ask'], ['full', 'allow']] as const)('a run at level %s reads outside its folder: %s', async (level, outside) => {
    const made = await manager.createChat(CHATS_PROJECT, 'its own');
    const f = hostFixture({ level, cwd: made.path });
    f.h.runExternal(EXT, `ws:${made.id}`, 'slow');
    await waitFor(() => f.inputs.length === 1);
    const input = f.inputs[0]!;
    expect(input.place).toMatchObject({ cwd: made.path, additionalDirectories: [] });
    const policy = { cwd: made.path, roots: [made.path], autoEdit: false, scope: input.scope, dotenv: false, askOnly: false };
    expect(decideTool('Read', { file_path: path.join(made.path, 'a.txt') }, policy)).toBe('allow');
    expect(decideTool('Read', { file_path: path.join(dir, 'secretless.txt') }, policy)).toBe(outside);
    if (outside === 'allow') return;
    // The step waits for you: nothing outside its folder is read on its own.
    void input.canUseTool('Read', { file_path: path.join(dir, 'secretless.txt') });
    await waitFor(() => f.store.getState().approvals.length === 1);
  });
});

describe('a late yes', () => {
  /** Every tool, with its arguments: a new name in CHAT_TOOLS doesn't compile until it is here. */
  const CALLS: Readonly<Record<ChatTool, ReadonlyArray<Record<string, unknown>>>> = {
    beluga_capabilities: [{}],
    beluga_project_list: [{}],
    beluga_needs_list: [{}],
    beluga_chat_list: [{}],
    beluga_chat_read: [{ chat: 'c1' }],
    beluga_chat_search: [{ query: 'plantedword' }],
    beluga_chat_wait: [{ chat: 'c1', timeoutMs: 0 }],
    beluga_chat_launch: [
      { project: 'api', message: 'go', workspaceStrategy: 'root' },
      { project: 'api', message: 'go', workspaceStrategy: 'worktree' },
      { project: 'api', message: 'go', workspaceStrategy: 'existing_worktree', chat: 'c1' },
      { message: 'go' },
    ],
    beluga_chat_send: [{ chat: 'c1', message: 'hi' }],
    beluga_chat_update: [{ chat: 'c1', name: 'New' }],
    // In a chat it didn't start it has a card; in its own, at level ask, none: callTool reads the grant all the same.
    beluga_chat_interrupt: [{ chat: 'c1' }, { chat: 'mine' }],
    beluga_question_answer: [{ action: 'respond', question: 'q1', answers: { Which: 'a' } }],
  };
  const TOOLS = CHAT_TOOLS.flatMap((name) => CALLS[name].map((args) => [name, args] as const));
  /** Whether this call shows a card at level ask: the decision table says so, or a chat it didn't start does. */
  const asks = (name: ChatTool, args: Record<string, unknown>): boolean => decide({ operation: TOOL_ACCESS[name], level: 'ask', inScope: true }).outcome !== 'allow' || args.chat === 'c1';
  const CHAT_DATA = 'plantedword in a chat';

  it('covers each of the 12 tools, and the ones the table says ask', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...CHAT_TOOLS].sort());
    expect(CHAT_TOOLS).toHaveLength(12);
    expect(CHAT_TOOLS.filter((name) => !asks(name, {}))).toEqual(['beluga_chat_interrupt']);
  });

  let dir: string;
  let client: Client | undefined;
  let service: ExternalService | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await service?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A real host, service, tools and MCP client, with an agent's run in c1 and a question from it, and a card held open. */
  async function fixture() {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-late-'));
    const store = new Store(initialState('room', 'ask'));
    const aborted = vi.fn();
    let running = false;
    const agent: AgentBackend = { run: (input) => new Promise((_ok, no) => {
      running = true;
      input.signal.addEventListener('abort', () => { aborted(); no(new Error('aborted')); });
    }) };
    const send = (body: { kind: string } & Record<string, unknown>): boolean => {
      if (body.kind !== 'agent_event') return true;
      const e = body as unknown as BodyOf<'agent_event'>;
      store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
      return true;
    };
    const host = new AgentHost({
      store, selfId: () => ME, send: send as never, agent: () => agent, shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never, people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      workspaces: { place: () => ({ cwd: '/tmp/p', additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
      toast: () => undefined, system: () => undefined, approvalTimeoutMs: () => 60_000, refreshUsage: async () => undefined,
    });
    let grantId = (): string => '';
    const made = { sendChat: vi.fn(), newChat: vi.fn(async () => ({ id: 'n' })), startWorktree: vi.fn(async () => ({ id: 'n' })), renameChat: vi.fn(async () => undefined), answer: vi.fn() };
    const session = {
      store, host, toast: () => undefined, sendChat: made.sendChat, runsAgent: () => true, agentRef: { runtime: 'claude', label: 'Claude' },
      questions: { answer: made.answer },
      workspaces: { ensureLoaded: () => undefined, agentIn: () => undefined, renameChat: made.renameChat, refresh: async () => undefined, newChat: made.newChat, startWorktree: made.startWorktree, manager: { find: (id: string) => (id === 'mine' ? { startedByAgent: { id: grantId() } } : undefined), setStartedBy: () => undefined, setModel: () => undefined, setAgent: () => undefined } },
    } as unknown as Session;
    const clock = { now: Date.now() };
    let held: ((a: 'yes') => void) | undefined;
    let hold = false;
    let cards = 0;
    /** Runs once, when a tool first looks at what exists: after the call came in, with no card to wait on. */
    let inCall: (() => void) | undefined;
    const planted: ChatRead = {
      ...reads,
      chats: () => {
        inCall?.();
        inCall = undefined;
        return reads.chats().map((c) => ({ ...c, title: `${CHAT_DATA} ${c.id}` }));
      },
      history: () => [{ id: 'm1', role: 'person', author: 'kay', text: CHAT_DATA, ts: 1 }],
      needs: () => [{ id: 'n1', kind: 'approval', title: CHAT_DATA, chatId: 'c1' }],
    };
    service = new ExternalService({
      configFile: path.join(dir, 'c.json'), grantFile: path.join(dir, 'g.json'), auditFile: path.join(dir, 'a.jsonl'), port: 0, now: () => clock.now,
      tools: [...readTools(planted), ...controlTools(planted, sessionControl(session))],
      ask: () => {
        cards++;
        return hold ? new Promise((resolve) => (held = resolve)) : Promise.resolve('yes');
      },
    });
    host.setExternalAgents(grantLookup(service.grants, () => clock.now));
    await service.setEnabled(true);
    const { grant, token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'ask', projects: ['p1'], expiresAt: clock.now + 60_000 });
    grantId = () => grant.id;
    client = new Client({ name: 'late-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text);
    const { runId } = await call('beluga_chat_send', { chat: 'c1', message: 'first' });
    await waitFor(() => running);
    store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: runId, owner: ME, channel: 'ws:c1', question: { kind: 'question', questions: [{ question: 'Which', header: '', options: [], multiSelect: false }] }, picked: {} } });
    for (const m of Object.values(made)) m.mockClear();
    const late = async (name: ChatTool, args: Record<string, unknown>, end: () => void) => {
      cards = 0;
      if (!asks(name, args)) {
        inCall = end;
        const out = await call(name, args);
        expect(cards).toBe(0);
        return out;
      }
      hold = true;
      const out = call(name, args);
      await waitFor(() => Boolean(held));
      end();
      held!('yes');
      held = undefined;
      hold = false;
      const done = await out;
      expect(cards).toBe(1);
      return done;
    };
    const auditLines = () => readFileSync(path.join(dir, 'a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; result: string; decidedBy: string });
    return { service, grant, clock, made, aborted, late, call, auditLines };
  }

  const ENDS: ReadonlyArray<readonly [string, (f: Awaited<ReturnType<typeof fixture>>) => void]> = [
    ['revoked', (f) => void f.service.grants.revoke(f.grant.id)],
    ['expired', (f) => void (f.clock.now += 120_000)],
    ['blocked', (f) => void vi.spyOn(f.service.grants, 'list').mockReturnValue([{ ...f.grant, level: 'blocked' }])],
  ];

  describe.each(ENDS)('on a grant %s while it waits', (_how, end) => {
    it.each(TOOLS)('%s %j does not run, gives no data, and the refusal is in the audit file', async (name, args) => {
      const f = await fixture();
      const out = await f.late(name, args, () => end(f));
      expect(out).toMatchObject({ error: 'grant_gone' });
      expect(Object.keys(out).sort()).toEqual(['error', 'message']);
      expect(JSON.stringify(out)).not.toContain('plantedword');
      for (const m of Object.values(f.made)) expect(m).not.toHaveBeenCalled();
      expect(f.aborted).not.toHaveBeenCalled();
      expect(f.auditLines().at(-1)).toMatchObject({ tool: name, result: 'grant_gone', decidedBy: asks(name, args) ? 'person' : 'rule' });
      expect(f.service.activity({ limit: 1 })[0]?.kind).toBe('refused');
    });
  });

  it.each(TOOLS)('on a live grant %s %j runs', async (name, args) => {
    const f = await fixture();
    const out = await f.late(name, args, () => undefined);
    expect(out.error).toBeUndefined();
    // So the check above means something: these do hand out what was planted.
    if (['beluga_chat_read', 'beluga_chat_search', 'beluga_chat_list', 'beluga_needs_list'].includes(name)) expect(JSON.stringify(out)).toContain('plantedword');
    expect(f.auditLines().at(-1)).toMatchObject({ tool: name, result: 'ok' });
    const ran = { beluga_chat_send: f.made.sendChat, beluga_chat_update: f.made.renameChat, beluga_question_answer: f.made.answer }[name as string];
    if (ran) await waitFor(() => ran.mock.calls.length > 0);
    if (name === 'beluga_chat_interrupt' && args.chat === 'c1') await waitFor(() => f.aborted.mock.calls.length > 0);
    if (name === 'beluga_chat_launch') expect(f.made.newChat.mock.calls.length + f.made.startWorktree.mock.calls.length).toBe(args.workspaceStrategy === 'existing_worktree' ? 0 : 1);
    if (name === 'beluga_chat_launch') expect(f.made.sendChat).toHaveBeenCalledTimes(1);
  });

  it('a call with no card still makes and posts nothing once the grant has ended', async () => {
    const store = new Store(initialState('room', 'ask'));
    const sendChat = vi.fn();
    const newChat = vi.fn();
    const port = sessionControl({ store, sendChat, toast: () => undefined, runsAgent: () => true, agentRef: { runtime: 'claude', label: 'Claude' }, host: { externalLevel: () => 'blocked' }, workspaces: { newChat, ensureLoaded: () => undefined } } as unknown as Session);
    const by = { id: 'g', name: 'GrokBot' };
    await expect(port.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).rejects.toMatchObject({ denial: 'grant_gone' });
    await expect(port.launch({ by, projectId: 'p', message: 'm', strategy: 'root' })).rejects.toMatchObject({ denial: 'grant_gone' });
    expect(sendChat).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
  });
});
