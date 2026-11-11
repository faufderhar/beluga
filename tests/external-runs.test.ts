import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_TRUST_TABLE, approvalFor, codexConfinement, originOf } from '../src/agent/runtime/codex/sandbox.js';
import { gateTool } from '../src/agent/tool-gate.js';
import { OWNER_DECLINED } from '../src/agent/tool-gate.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState, reduce } from '../src/core/store.js';
import { type TrustLevel, requesterTrust } from '../src/core/trust.js';
import { grantLookup } from '../src/external/adapters/runs.js';
import { sessionControl } from '../src/external/adapters/session-control.js';
import { readTools } from '../src/external/adapters/tools/read.js';
import type { ChatRead } from '../src/external/ports/chat-read.js';
import type { Session } from '../src/core/session.js';
import type { Grant } from '../src/external/domain/grant.js';
import type { BodyOf } from '../src/protocol.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const EXT = 'ext:abc123abc123';
const CWD = '/tmp/project';
const policy = (input: AgentRunInput) => ({ cwd: CWD, roots: [CWD], autoEdit: true, scope: input.scope, dotenv: Boolean(input.canUseSecret) });

/** An agent's run held open until the test ends it, with what the host gave it. */
function fixture(level: TrustLevel | undefined, opts: { selfApproval?: 'ask' | 'never' } = {}) {
  const store = new Store({ ...initialState('room', 'ask'), prefs: { ...initialState('room', 'ask').prefs, selfApproval: opts.selfApproval ?? 'never' } });
  const inputs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    run: (input) =>
      new Promise<string>((resolve, reject) => {
        inputs.push(input);
        input.signal.addEventListener('abort', () => reject(new Error('aborted')));
        if (input.prompt === 'quick') resolve('done');
      }),
  };
  const send = (body: { kind: string } & Record<string, unknown>): boolean => {
    if (body.kind !== 'agent_event') return true;
    const e = body as unknown as BodyOf<'agent_event'>;
    store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel, ...(e.via ? { via: e.via } : {}) });
    return true;
  };
  const owned = { phone: vi.fn(), board: vi.fn(), sentinel: vi.fn(), plans: vi.fn(), envFor: vi.fn(() => ({ TOKEN: 'mine' })) };
  const h = new AgentHost({
    store,
    selfId: () => ME,
    send: send as never,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => false } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    workspaces: { place: () => ({ cwd: CWD, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, agentIn: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    ...owned,
  });
  const grant = { current: level === undefined ? undefined : { name: 'GrokBot', level } };
  h.setExternalAgents((r) => (r === EXT ? grant.current : undefined));
  const started = async (): Promise<AgentRunInput> => {
    h.runExternal(EXT, 'ws:w1', 'work');
    await waitFor(() => inputs.length > 0);
    return inputs[0]!;
  };
  const card = (): string | undefined => store.getState().approvals[0]?.title;
  const status = () => store.getState().log.find((l) => l.type === 'agent' && l.channel === 'ws:w1') as { status: string; text: string } | undefined;
  return { h, store, inputs, grant, started, card, status, owned };
}

describe('a run an external agent starts', () => {
  it('counts among its running channels until it stops', async () => {
    const f = fixture('trusted');
    expect(f.h.externalRunChannels(EXT)).toEqual([]);
    await f.started();
    expect(f.h.externalRunChannels(EXT)).toEqual(['ws:w1']);
    expect(f.h.externalRunChannels('ext:other')).toEqual([]);
    f.h.stopExternal(EXT);
    expect(f.h.externalRunChannels(EXT)).toEqual([]);
  });

  it('at full it is your own run: your scope, secret rule, variables and tools, with the agent named beside it', async () => {
    const f = fixture('full');
    const input = await f.started();
    expect(input.asOwner).toBe(true);
    expect(input.scope).toBe('full');
    expect(input.canUseSecret).toEqual(expect.any(Function));
    expect(input.ownerMcp).toBe(true);
    expect(input.env?.TOKEN).toBe('mine');
    expect(input.viaAgent).toBe(false);
    for (const own of Object.values(f.owned)) expect(own).toHaveBeenCalled();
    expect(f.status()).toMatchObject({ requester: ME, requesterName: 'GrokBot' });
    expect(f.h.viaIn('ws:w1')).toMatchObject({ name: 'GrokBot' });
  });

  it('at full your own rules decide a step: selfApproval, and a card when you ask for cards', async () => {
    const never = fixture('full');
    const input = await never.started();
    await expect(input.canUseTool('Bash', { command: 'ls' })).resolves.toBe(true);
    expect(never.card()).toBeUndefined();
    const ask = fixture('full', { selfApproval: 'ask' });
    const asked = (await ask.started()).canUseTool('Bash', { command: 'ls' });
    await waitFor(() => Boolean(ask.card()));
    expect(ask.store.getState().approvals[0]?.peer).toBe(EXT);
    ask.h.answerApproval('no');
    await expect(asked).resolves.toBe(false);
  });

  it.each(['ask', 'trusted'] as const)('below full, at %s, it keeps what only you hand out', async (level) => {
    const input = await fixture(level).started();
    expect(input.scope).toBe('folder');
    expect(input.canUseSecret).toBeUndefined();
    expect(input.ownerMcp).toBeUndefined();
    expect(input.env?.TOKEN).toBeUndefined();
    expect(input.askBeforeCommands).toBe(true);
  });

  it.each(['ask', 'trusted'] as const)('cannot read a .env file at level %s', async (level) => {
    const input = await fixture(level).started();
    for (const [tool, args] of [['Read', { file_path: `${CWD}/.env` }], ['Bash', { command: 'cat .env' }], ['Edit', { file_path: `${CWD}/.env.local` }]] as const) {
      await expect(gateTool(tool, args, input, policy(input))).resolves.toEqual(expect.any(String));
    }
  });

  it('at full a .env file follows your rule: it asks you, and the card can be stopped with the agent', async () => {
    const f = fixture('full');
    const input = await f.started();
    const read = gateTool('Read', { file_path: `${CWD}/.env` }, input, policy(input));
    await waitFor(() => Boolean(f.card()));
    expect(f.store.getState().approvals[0]).toMatchObject({ kind: 'secret', peer: EXT });
    expect(f.h.stopExternal(EXT)).toBe(true);
    await expect(read).resolves.toEqual(expect.any(String));
  });

  it('a level lowered during a run counts at the next step', async () => {
    const f = fixture('full');
    const input = await f.started();
    expect(input.asksFirst?.('Read')).toBe(false);
    f.grant.current = { name: 'GrokBot', level: 'ask' };
    expect(input.asksFirst?.('Read')).toBe(true);
    const read = gateTool('Read', { file_path: `${CWD}/a.ts` }, input, policy(input));
    await waitFor(() => Boolean(f.card()));
    f.h.answerApproval('no');
    await expect(read).resolves.toBe(OWNER_DECLINED);
  });

  it('asks for Bash at trusted, naming the agent; at full it runs', async () => {
    const trusted = fixture('trusted');
    const input = await trusted.started();
    const denied = gateTool('Bash', { command: 'ls' }, input, policy(input));
    await waitFor(() => Boolean(trusted.card()));
    expect(trusted.card()).toBe('GrokBot, your external agent, wants to use Bash');
    trusted.h.answerApproval('no');
    await expect(denied).resolves.toBe(OWNER_DECLINED);

    const full = await fixture('full').started();
    await expect(gateTool('Bash', { command: 'ls' }, full, policy(full))).resolves.toBeUndefined();
    expect(full.scope).toBe('full');
  });

  it('shows a card for each tool at ask, for tools that reach people at trusted', async () => {
    const ask = fixture('ask');
    const input = await ask.started();
    expect(input.scope).toBe('folder');
    const read = gateTool('Read', { file_path: `${CWD}/a.ts` }, input, policy(input));
    await waitFor(() => Boolean(ask.card()));
    expect(ask.card()).toBe('GrokBot, your external agent, wants to use Read');
    ask.h.answerApproval('yes');
    await expect(read).resolves.toBeUndefined();

    const trusted = fixture('trusted');
    const inside = await trusted.started();
    await expect(gateTool('Read', { file_path: `${CWD}/a.ts` }, inside, policy(inside))).resolves.toBeUndefined();
    expect(inside.asksFirst?.('mcp__beluga__send_chat')).toBe(true);
    expect(inside.asksFirst?.('mcp__beluga_board__task_update')).toBe(true);
    expect(inside.asksFirst?.('Read')).toBe(false);
  });

  it('a change to a file that runs code asks once, with no Always, below full', async () => {
    const f = fixture('trusted');
    const input = await f.started();
    const write = input.canUseTool('Write', { file_path: `${CWD}/package.json` });
    await waitFor(() => Boolean(f.card()));
    expect(f.card()).toContain('GrokBot, your external agent, wants to change package.json');
    expect(f.store.getState().approvals[0]?.once).toBe(true);
    f.h.answerApproval('no');
    await expect(write).resolves.toBe(false);
  });

  it('a yes after the grant was revoked does not run', async () => {
    const f = fixture('trusted');
    const input = await f.started();
    const bash = input.canUseTool('Bash', { command: 'rm -rf build' });
    await waitFor(() => Boolean(f.card()));
    f.grant.current = undefined;
    f.h.answerApproval('yes');
    await expect(bash).resolves.toBe(false);
    expect(input.vetTool?.('Read', {})).toEqual(expect.any(String));
    await expect(input.canUseTool('Bash', { command: 'ls' })).resolves.toBe(false);
    expect(f.card()).toBeUndefined();
  });

  it('at full it reaches a friend with ask_agent and run_on_peer, as you do', async () => {
    const input = await fixture('full').started();
    for (const tool of ['mcp__beluga__ask_agent', 'mcp__beluga__run_on_peer']) {
      expect(input.vetTool?.(tool, {}), tool).toBeUndefined();
      await expect(gateTool(tool, { name: 'bob', prompt: 'hi', command: 'ls' }, input, policy(input)), tool).resolves.toBeUndefined();
    }
  });

  it.each(['ask', 'trusted'] as const)('at %s ask_agent and run_on_peer each show a card', async (level) => {
    for (const tool of ['mcp__beluga__ask_agent', 'mcp__beluga__run_on_peer']) {
      const f = fixture(level);
      const input = await f.started();
      expect(input.vetTool?.(tool, {}), tool).toBeUndefined();
      const step = gateTool(tool, { name: 'bob', prompt: 'hi', command: 'ls' }, input, policy(input));
      await waitFor(() => Boolean(f.card()));
      expect(f.card()).toContain(tool);
      f.h.answerApproval('no');
      await expect(step, tool).resolves.toBe(OWNER_DECLINED);
    }
  });

  it('starts nothing without a live grant', async () => {
    const f = fixture(undefined);
    f.h.runExternal(EXT, 'ws:w1', 'work');
    await waitFor(() => f.status()?.status === 'denied');
    expect(f.inputs).toHaveLength(0);
  });

  it('comes only through runExternal: an ext: id on the wire is dropped', async () => {
    const f = fixture('full');
    await f.h.onAgentRequest(EXT, { kind: 'agent_request', requestId: 'r1', prompt: 'work', viaAgent: false, channel: 'ws:w1', urgent: false, plan: false });
    expect(f.inputs).toHaveLength(0);
    expect(f.status()).toBeUndefined();
  });

  it('is no person: the people book does not change its level', () => {
    const state = reduce(reduce(initialState('room', 'deny'), { type: 'trust_level', peerId: EXT, level: 'full' }), { type: 'trust_level', peerId: 'someone', level: 'blocked' });
    expect(requesterTrust(state, EXT, () => ({ name: 'GrokBot', level: 'ask' }))).toEqual({ level: 'ask', reach: 'folder' });
    expect(requesterTrust(state, EXT)).toEqual({ level: 'blocked', reach: 'folder' });
  });

  it('Stop ends its run and queue, and another agent\'s run and yours go on', async () => {
    const f = fixture('full');
    const OTHER = 'ext:other000other0';
    f.h.setExternalAgents((r) => (r === EXT || r === OTHER ? { name: r === EXT ? 'GrokBot' : 'OtherBot', level: 'full' } : undefined));
    f.h.runExternal(EXT, 'ws:w1', 'work');
    f.h.runExternal(OTHER, 'ws:w2', 'work');
    await f.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'mine', prompt: 'work', viaAgent: false, channel: 'ws:w3', urgent: false, plan: false });
    await waitFor(() => f.inputs.length === 3);
    const on = (channel: string) => f.inputs.find((input) => input.channel === channel);
    const [its, others, yours] = [on('ws:w1'), on('ws:w2'), on('ws:w3')];
    f.h.runExternal(EXT, 'ws:w1', 'next', { requestId: 'queued-by-it', mode: 'queue' });
    f.h.runExternal(OTHER, 'ws:w1', 'theirs', { requestId: 'queued-by-other', mode: 'queue' });
    expect(f.h.interruptExternal(OTHER, 'ws:w3')).toBe('not_yours');
    expect(f.h.runExternal(OTHER, 'ws:w3', 'instead', { mode: 'restart' })).toBe('not_interruptible');
    expect(f.h.viaIn('ws:w1')).toMatchObject({ name: 'GrokBot' });
    expect(f.h.viaIn('ws:w3')).toBeUndefined();

    expect(f.h.stopExternal(EXT)).toBe(true);
    expect(its!.signal.aborted).toBe(true);
    expect(others!.signal.aborted).toBe(false);
    expect(yours!.signal.aborted).toBe(false);
    const statusOf = (id: string) => (f.store.getState().log.find((l) => l.type === 'agent' && l.requestId === id) as { status: string } | undefined)?.status;
    expect(statusOf('queued-by-it')).toBe('error');
    expect(statusOf('queued-by-other')).toBe('queued');
  });

  it('no friend limit stops it: no turn or time limit, and asks and declines do not end it', async () => {
    const f = fixture('trusted');
    const input = await f.started();
    expect(input.maxTurns).toBeUndefined();
    for (let i = 0; i < 12; i++) {
      const asked = input.canUseTool('Bash', { command: `step ${i}` });
      await waitFor(() => f.store.getState().approvals.length === 1);
      f.h.answerApproval(i % 3 === 0 ? 'yes' : 'no');
      await asked;
    }
    expect(f.status()?.status).not.toBe('error');
    expect(f.h.runningIn('ws:w1')).toBe(true);
    // The queue has your own limit.
    for (let i = 0; i < 10; i++) expect(f.h.runExternal(EXT, 'ws:w1', `more ${i}`)).toBe('queued');
    expect(f.h.runExternal(EXT, 'ws:w1', 'too many')).toBe('denied');
  });

  it('on Codex at full it gets your own row, with the network on', async () => {
    const at = { cwd: CWD, folders: [], writable: [CWD], home: '/Users/me', yourServers: ['mine'] };
    const full = await fixture('full').started();
    const built = codexConfinement(originOf(full), full.scope, at);
    expect(originOf(full)).toBe('own');
    expect(built.row).toMatchObject({ origin: 'own', home: 'read', network: true, yourTools: true });
    expect(approvalFor(built.row, { askBeforeCommands: Boolean(full.askBeforeCommands) })).toBe('on-request');
    expect(built.config['mcp_servers.mine.enabled']).toBeUndefined();
    expect(built.config['shell_environment_policy.inherit']).toBeUndefined();
    expect(CODEX_TRUST_TABLE.map((r) => r.origin)).not.toContain('external');
  });

  // Not on Windows: POSIX paths in the fixtures.
  it.skipIf(process.platform === 'win32')('on Codex at trusted the sandbox holds: home denied, a .env outside is out of reach, your tools off, core environment', async () => {
    const work = '/Users/me/work/project';
    const trusted = await fixture('trusted').started();
    expect(originOf(trusted)).toBe('agent');
    const built = codexConfinement(originOf(trusted), trusted.scope, { cwd: work, folders: [], writable: [work], home: '/Users/me', belugaHome: '/Users/me/.beluga', yourServers: ['mine'] });
    expect(built.row).toMatchObject({ origin: 'agent', home: 'denied', network: true, yourTools: false });
    const profile = built.config['permissions.beluga'] as { filesystem: Record<string, string>; network: { enabled: boolean } };
    expect(profile.network.enabled).toBe(true);
    expect(profile.filesystem['/Users/me']).toBe(process.platform === 'linux' ? undefined : 'deny');
    expect(profile.filesystem['/Users/me/.beluga']).toBe('deny');
    // Linux starts with system-tool reads; neither baseline opens other home folders.
    expect(Object.entries(profile.filesystem).filter(([, how]) => how !== 'deny').map(([p]) => p).sort()).toEqual(process.platform === 'linux' ? [':minimal', '/Users/me/.gitconfig', work].sort() : ['/Users/me/.gitconfig', work]);
    expect(profile.filesystem[`${work}/**/.env*`]).toBe('deny');
    expect(built.config['mcp_servers.mine.enabled']).toBe(false);
    expect(built.config['features.plugins']).toBe(false);
    expect(built.config['shell_environment_policy.inherit']).toBe('core');
    expect(approvalFor(built.row, { askBeforeCommands: Boolean(trusted.askBeforeCommands) })).toBe('untrusted');
  });

  it('a level changed during a run counts on Codex at the next run', async () => {
    const f = fixture('trusted');
    const input = await f.started();
    f.grant.current = { name: 'GrokBot', level: 'full' };
    expect(originOf(input)).toBe('agent');
    expect(originOf({ asOwner: true, scope: 'full', viaAgent: false })).toBe('own');
  });

  it('a friend still gets the rows it had, config and all', () => {
    expect(originOf({ vetTool: () => undefined, viaAgent: false })).toBe('friend');
    expect(originOf({ viaAgent: true })).toBe('friend');
    expect(CODEX_TRUST_TABLE.filter((r) => r.origin === 'friend')).toEqual([
      { origin: 'friend', trust: 'Ask me each time, Trusted', scope: 'folder', sandbox: ':workspace', home: 'denied', network: false, approval: 'never', yourTools: false },
      { origin: 'friend', trust: 'Full trust', scope: 'full', sandbox: ':workspace', home: 'read', network: false, approval: 'never', yourTools: false },
    ]);
    const at = { cwd: '/Users/me/p', folders: [], writable: ['/Users/me/p'], home: '/Users/me', belugaHome: '/Users/me/.beluga' };
    const folder = codexConfinement('friend', 'folder', at);
    const full = codexConfinement('friend', 'full', at);
    expect((folder.config['permissions.beluga'] as { filesystem: Record<string, string> }).filesystem['/Users/me']).toBe(process.platform === 'linux' ? undefined : 'deny');
    expect((full.config['permissions.beluga'] as { filesystem: Record<string, string> }).filesystem['/Users/me']).toBeUndefined();
    expect(approvalFor(full.row, { askBeforeCommands: true })).toBe('never');
    expect(folder.approval).toBe('never');
  });
});

describe('grantLookup', () => {
  const grant = (over: Partial<Grant>): Grant => ({ id: 'abc123abc123', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level: 'trusted', projects: [], chats: { dms: false, groups: false }, createdAt: 0, expiresAt: 100, lastSeen: 0, ...over });
  const lookup = (g: Grant, at = 50) => grantLookup({ list: () => [g] }, () => at)(EXT);

  it('finds a live grant only', () => {
    expect(lookup(grant({}))).toEqual({ name: 'GrokBot', level: 'trusted' });
    expect(lookup(grant({}), 100)).toBeUndefined();
    expect(lookup(grant({ id: 'other' }))).toBeUndefined();
    expect(grantLookup({ list: () => [grant({})] }, () => 0)('abc123abc123')).toBeUndefined();
  });

  it('refuses a level the route cannot hold', () => {
    expect(lookup(grant({ route: 'remote', level: 'full' }))?.level).toBe('blocked');
  });
});

describe('level ask needs a runtime that asks before each step', () => {
  const by = { id: 'g', name: 'GrokBot' };
  const CODEX = { runtime: 'codex', label: 'Codex' };
  const port = (level: TrustLevel, chatAgent: { runtime: string; label: string } | undefined = CODEX, own = CODEX) => {
    const sendChat = vi.fn();
    const newChat = vi.fn(async () => ({ id: 'n' }));
    const startWorktree = vi.fn(async () => ({ id: 'n' }));
    const session = {
      store: new Store(initialState('room', 'ask')),
      agentRef: own,
      sendChat,
      toast: () => undefined,
      runsAgent: () => true,
      host: { externalLevel: () => level, runExternal: () => 'started', runningIn: () => false, mayRestartExternal: () => true },
      workspaces: { ensureLoaded: () => undefined, agentIn: () => chatAgent, newChat, startWorktree, refresh: async () => undefined, manager: { setStartedBy: () => undefined, setAgent: () => undefined, setModel: () => undefined } },
    } as unknown as Session;
    return { control: sessionControl(session), sendChat, newChat, startWorktree };
  };

  it('refuses launch and send on Codex at ask, and posts and makes nothing', async () => {
    const p = port('ask');
    await expect(p.control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).rejects.toMatchObject({ denial: 'level_denied', message: expect.stringContaining('Use a Claude agent or raise') });
    await expect(p.control.launch({ by, projectId: 'p', message: 'm', strategy: 'worktree' })).rejects.toMatchObject({ denial: 'level_denied' });
    await expect(p.control.launch({ by, projectId: 'p', message: 'm', strategy: 'root', runtime: 'codex' })).rejects.toMatchObject({ denial: 'level_denied' });
    await expect(p.control.launch({ by, projectId: 'p', message: 'm', strategy: 'existing_worktree', chatId: 'c' })).rejects.toMatchObject({ denial: 'level_denied' });
    expect(p.sendChat).not.toHaveBeenCalled();
    expect(p.newChat).not.toHaveBeenCalled();
    expect(p.startWorktree).not.toHaveBeenCalled();
  });

  it.each(['trusted', 'full'] as const)('the same calls run at %s', async (level) => {
    const p = port(level);
    await expect(p.control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).resolves.toMatchObject({ delivery: 'started' });
    await expect(p.control.launch({ by, projectId: 'p', message: 'm', strategy: 'root', runtime: 'codex' })).resolves.toMatchObject({ chatId: 'n' });
    expect(p.sendChat).toHaveBeenCalledTimes(2);
  });

  it('Claude runs at ask, and a level lowered after a launch counts at the next send', async () => {
    const claude = { runtime: 'claude', label: 'Claude' };
    await expect(port('ask', claude, claude).control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).resolves.toMatchObject({ delivery: 'started' });
    let level: TrustLevel = 'trusted';
    const host = { externalLevel: () => level, runExternal: () => 'started', runningIn: () => false, mayRestartExternal: () => true };
    const control = sessionControl({ agentRef: CODEX, sendChat: vi.fn(), host, workspaces: { ensureLoaded: () => undefined, agentIn: () => CODEX } } as unknown as Session);
    await expect(control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).resolves.toBeTruthy();
    level = 'ask';
    await expect(control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).rejects.toMatchObject({ denial: 'level_denied' });
  });

  it('beluga_capabilities marks Codex as unavailable at ask', async () => {
    const reads = { projects: () => [], runtimes: async () => [{ id: 'claude', ready: true, asksEachStep: true, models: [] }, { id: 'codex', ready: true, asksEachStep: false, models: [] }] } as unknown as ChatRead;
    const caps = readTools(reads).find((t) => t.name === 'beluga_capabilities')!;
    const grant = (level: Grant['level']): Grant => ({ id: 'g', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: [], chats: { dms: false, groups: false }, createdAt: 0, expiresAt: 1, lastSeen: 0 });
    const at = (await caps.run({}, grant('ask'))) as { runtimes: Array<{ id: string; available: boolean; why?: string }> };
    expect(at.runtimes.find((r) => r.id === 'claude')).toMatchObject({ available: true });
    expect(at.runtimes.find((r) => r.id === 'codex')).toMatchObject({ available: false, why: expect.stringContaining('Claude') });
    const above = (await caps.run({}, grant('trusted'))) as { runtimes: Array<{ id: string; available: boolean }> };
    expect(above.runtimes.every((r) => r.available)).toBe(true);
  });
});
