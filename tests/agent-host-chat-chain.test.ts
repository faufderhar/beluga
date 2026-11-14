import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput, ChatChain, FollowUp, LiveStatus, Steer } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import { AgentRequestBody, type BodyOf, type ChatOrigin } from '../src/protocol.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const FRIEND = 'friend';

const origin = (chainId: string, hop: number): ChatOrigin => ({ ref: `${ME}/ws:wt-a`, title: 'Source', agent: { runtime: 'codex', label: 'Codex' }, chainId, hop, messageId: `m-${hop}` });

/** A pretend agent. "slow" stays open until finished, and can take steers and follow-ups. */
function backend() {
  const chains: Array<() => ChatChain> = [];
  const steered: FollowUp[] = [];
  const followed: FollowUp[] = [];
  const live: { status: LiveStatus; finish?: () => void; followUps: boolean } = { status: { lastEventAt: Date.now(), between: false }, followUps: false };
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      chains.push(() => input.chatTools!.chain());
      if (!input.prompt.includes('slow')) return 'done';
      return new Promise<string>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')));
        const steer: Steer = Object.assign(
          (f: FollowUp) => {
            steered.push(f);
            return true;
          },
          {
            status: () => live.status,
            interrupt: async (f: FollowUp) => {
              f.onStart?.();
              return true;
            },
          },
        );
        input.onSteer?.(steer);
        if (live.followUps)
          input.onFollowUps?.((f: FollowUp) => {
            followed.push(f);
            return true;
          });
        live.finish = () => {
          input.onSteer?.(undefined);
          resolve('slow done');
        };
      });
    },
  };
  return { agent, chains, steered, followed, live };
}

/** A chat of yours: the room's runs have no chat tools, so the chain is read here. */
const CHAT = 'ws:chat1';

function host(agent: AgentBackend) {
  const state = initialState('room', 'auto');
  const store = new Store(state);
  const h = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place: (channel: string) => (channel === CHAT ? { cwd: '/p/chat1', additionalDirectories: [], autoEdit: true, onSession: () => undefined } : undefined), ensureLoaded: () => undefined, inChannel: () => undefined, agentIn: () => undefined, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
  });
  const ask = (requestId: string, prompt: string, extra: Partial<BodyOf<'agent_request'>> = {}, from = ME): Promise<void> =>
    h.onAgentRequest(from, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel: CHAT, urgent: false, plan: false, ...extra });
  return { h, ask };
}

describe('the chain of a run', () => {
  it('a message from the user starts a new chain at hop 0', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'one');
    await waitFor(() => b.chains.length === 1);
    await t.ask('r2', 'two');
    await waitFor(() => b.chains.length === 2);
    await t.h.idle(CHAT);
    const [first, second] = [b.chains[0]!(), b.chains[1]!()];
    expect(first.hop).toBe(0);
    expect(second.hop).toBe(0);
    expect(first.chainId).toBeTruthy();
    expect(second.chainId).not.toBe(first.chainId);
  });

  it('your own message that carries a chain (a plan’s message to a task) keeps that chain', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'one', { chain: { chainId: 'c-plan', hop: 4 } });
    await waitFor(() => b.chains.length === 1);
    await t.h.idle(CHAT);
    expect(b.chains[0]!()).toEqual({ chainId: 'c-plan', hop: 4 });
  });

  it('a message with an origin sets the chain of its run', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'one', { origin: origin('c1', 2) });
    await waitFor(() => b.chains.length === 1);
    await t.h.idle(CHAT);
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 2 });
  });

  it('a queued message with an origin sets the chain when its run starts, and the run before keeps its own', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.finish));
    await t.ask('r2', 'next', { origin: origin('c1', 3) });
    expect(b.chains[0]!().hop).toBe(0);
    b.live.finish!();
    await waitFor(() => b.chains.length === 2);
    await t.h.idle(CHAT);
    expect(b.chains[1]!()).toMatchObject({ chainId: 'c1', hop: 3 });
    expect(b.chains[0]!().chainId).not.toBe('c1');
  });

  it('a steer sets the hop to the higher value and keeps the chain of the run', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 1) });
    await waitFor(() => Boolean(b.live.finish));
    await t.ask('r2', 'higher', { urgent: true, origin: origin('c2', 3) });
    expect(b.steered).toHaveLength(1);
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 3 });
    await t.ask('r3', 'lower', { urgent: true, origin: origin('c3', 2) });
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 3 });
    await t.ask('r4', 'from you', { urgent: true });
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 3 });
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('a steered message your agent sent on (a plan’s message to a task) raises the hop and keeps the chain of the run', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 1) });
    await waitFor(() => Boolean(b.live.finish));
    await t.ask('r2', 'from the plan', { urgent: true, chain: { chainId: 'c-plan', hop: 5 } });
    expect(b.steered).toHaveLength(1);
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 5 });
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('a steer that interrupts a long step sets the hop too', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 1) });
    await waitFor(() => Boolean(b.live.finish));
    b.live.status = { tool: { label: 'npm test', since: Date.now() - 180_000 }, lastEventAt: Date.now(), between: false };
    await t.ask('r2', 'higher', { urgent: true, origin: origin('c2', 3) });
    expect(b.chains).toHaveLength(1);
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c1', hop: 3 });
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('a turn that a background task starts keeps the chain of its lane', async () => {
    const b = backend();
    b.live.followUps = true;
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 2) });
    await waitFor(() => Boolean(b.live.finish));
    // The agent answered and waits. A background task reports back: the same run takes a turn, with no new message.
    b.live.status = { lastEventAt: Date.now(), between: true };
    const before = b.chains[0]!();
    b.live.status = { lastEventAt: Date.now(), between: false, tool: { label: 'Read a.ts', since: Date.now() } };
    expect(b.chains[0]!()).toEqual(before);
    expect(before).toMatchObject({ chainId: 'c1', hop: 2 });
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('a follow-up between turns is a turn of its own: from the user a new chain, with an origin its chain', async () => {
    const b = backend();
    b.live.followUps = true;
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 2) });
    await waitFor(() => Boolean(b.live.finish));
    b.live.status = { lastEventAt: Date.now(), between: true };
    await t.ask('r2', 'from you');
    expect(b.followed).toHaveLength(1);
    expect(b.chains[0]!().hop).toBe(0);
    expect(b.chains[0]!().chainId).not.toBe('c1');
    await t.ask('r3', 'from a chat', { origin: origin('c9', 4) });
    expect(b.chains[0]!()).toMatchObject({ chainId: 'c9', hop: 4 });
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('a follow-up from another chain never lowers the hop of the open run', async () => {
    const b = backend();
    b.live.followUps = true;
    const t = host(b.agent);
    await t.ask('r1', 'slow', { origin: origin('c1', 4) });
    await waitFor(() => Boolean(b.live.finish));
    b.live.status = { lastEventAt: Date.now(), between: true };
    await t.ask('r2', 'from a chat', { origin: origin('c9', 1) });
    expect(b.followed).toHaveLength(1);
    expect(b.chains[0]!().hop).toBe(4);
    b.live.finish!();
    await t.h.idle(CHAT);
  });

  it('an origin from a friend never sets a chain unchecked: a chat not shared with them gets no run (tests/chat-remote-send.test.ts)', async () => {
    const t = host(backend().agent);
    const seen: Array<BodyOf<'agent_request'>> = [];
    (t.h as unknown as { enqueue: (from: string, body: BodyOf<'agent_request'>) => void }).enqueue = (_from, body) => void seen.push(body);
    await t.ask('r1', 'hi', { channel: 'ws:x', origin: origin('c1', 2) }, FRIEND);
    expect(seen).toHaveLength(0);
    await t.ask('r2', 'hi', { channel: 'ws:x', origin: origin('c1', 2) });
    expect(seen[0]!.origin).toMatchObject({ chainId: 'c1' });
  });
});

describe('agent_request on the wire', () => {
  const base = { kind: 'agent_request', requestId: 'r1', prompt: 'hi', channel: CHAT };

  it('an old peer without the field still works', () => {
    expect(AgentRequestBody.parse(base).origin).toBeUndefined();
  });

  it('keeps a good origin and drops a malformed one alone', () => {
    expect(AgentRequestBody.parse({ ...base, origin: origin('c1', 1) }).origin).toMatchObject({ chainId: 'c1', hop: 1 });
    const bad = AgentRequestBody.parse({ ...base, origin: { chainId: 'c1', hop: -1 } });
    expect(bad.origin).toBeUndefined();
    expect(bad.prompt).toBe('hi');
  });
});
