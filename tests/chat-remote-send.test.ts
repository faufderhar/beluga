import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentPlace, AgentRunInput, ChatTools } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { MAX_PAIR_MESSAGES } from '../src/core/chat-links/guard.js';
import { type DomainState, Store, initialState } from '../src/core/store.js';
import type { TrustLevel } from '../src/core/trust.js';
import { needsYou } from '../src/companion/needs-you.js';
import { AgentRequestBody, type BodyOf, type ChatOrigin } from '../src/protocol.js';
import { waitFor } from './helpers.js';

/**
 * BLG-151: an agent sends to a chat that another person shared with its user. Two computers, each
 * with its own AgentHost, joined by a pretend room: the sender's send goes to the owner, and the
 * owner's events come back the way session.ts takes them.
 */

const OWNER = 'owner-owner-owner-owner-owner-ow';
const SENDER = 'sender-sender-sender-sender-send';
const SOURCE = 'ws:src';
const SHARED = 'ws:shared1';
const VIEWED = 'ws:viewed';
const PRIVATE = 'ws:private';

const ws = (id: string, name: string) => ({ id, name, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 1000 });
const peer = (peerId: string, name: string) => ({ peerId, name, shares: [], agent: true });

function place(channel: string): AgentPlace | undefined {
  return channel.startsWith('ws:') ? ({ cwd: `/p/${channel}`, additionalDirectories: [], autoEdit: true, onSession: () => undefined } as AgentPlace) : undefined;
}

/** An agent that answers at once, and keeps what it was asked. */
function agent(prompts: Array<[string, string]>): AgentBackend {
  return {
    run: async (input: AgentRunInput) => {
      prompts.push([input.channel!, input.prompt]);
      return `done in ${input.channel}`;
    },
  };
}

function hostFor(store: Store, self: string, send: (body: { kind: string } & Record<string, unknown>, opts?: { to?: string }) => boolean, sharing: unknown, prompts: Array<[string, string]>) {
  return new AgentHost({
    store,
    selfId: () => self,
    send: send as never,
    agent: () => agent(prompts),
    shares: {} as never,
    sharing: sharing as never,
    people: { setTrust: () => undefined } as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, ensureLoaded: () => undefined, inChannel: () => undefined, agentIn: () => undefined, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
  });
}

function setup(opts: { trust?: TrustLevel; ownerOnline?: boolean } = {}) {
  const base = initialState('room', 'auto');
  const prefs = base.prefs;
  const owner = new Store({
    ...base,
    selfId: OWNER,
    self: peer(OWNER, 'Olga'),
    projectsLoaded: true,
    prefs,
    peers: [peer(OWNER, 'Olga'), peer(SENDER, 'Sam')],
    levels: { [SENDER]: opts.trust ?? 'trusted' },
    projects: [{ id: 'p1', name: 'App', root: '/p', workspaces: [ws('shared1', 'Shared work'), ws('viewed', 'Viewed work'), ws('private', 'Private work')] }],
    members: { shared1: { [SENDER]: 'contribute' }, viewed: { [SENDER]: 'view' } },
  } as unknown as DomainState);
  const sender = new Store({
    ...base,
    selfId: SENDER,
    self: peer(SENDER, 'Sam'),
    projectsLoaded: true,
    prefs,
    peers: opts.ownerOnline === false ? [peer(SENDER, 'Sam')] : [peer(SENDER, 'Sam'), peer(OWNER, 'Olga')],
    projects: [{ id: 'p1', name: 'Mine', root: '/m', workspaces: [ws('src', 'Source chat')] }],
    shared: [
      { owner: OWNER, id: 'shared1', name: 'Shared work', project: 'App', role: 'contribute', share: 's' },
      { owner: OWNER, id: 'viewed', name: 'Viewed work', project: 'App', role: 'view', share: 's' },
    ],
  } as unknown as DomainState);
  const ownerRuns: Array<[string, string]> = [];
  const toOwner: Array<BodyOf<'agent_request'>> = [];

  const ownerMembers = (): Record<string, Record<string, string>> => (owner.getState() as unknown as { members: Record<string, Record<string, string>> }).members;
  const ownerSharing = {
    sharedFor: () => undefined,
    recipients: (channel: string) => Object.keys(ownerMembers()[channel.slice(3)] ?? {}),
    canPost: (from: string, channel: string) => from === OWNER || ownerMembers()[channel.slice(3)]?.[from] === 'contribute',
    canSee: (from: string, channel: string) => from === OWNER || ownerMembers()[channel.slice(3)]?.[from] !== undefined,
    members: (id: string) => ownerMembers()[id] ?? {},
  };
  const senderSharing = {
    sharedFor: (channel: string) => sender.getState().shared.find((w) => `ws:${w.id}` === channel),
    recipients: () => [],
    canPost: () => true,
    canSee: () => true,
    members: () => ({}),
  };
  // What session.ts's onAgentEvent does with an event: one from the owner of a shared chat lands under its owner.
  const showOn = (store: Store, from: string, e: BodyOf<'agent_event'>): void => {
    store.dispatch({ type: 'agent_event', owner: from, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
  };
  const ownerHost: AgentHost = hostFor(
    owner,
    OWNER,
    (body, o) => {
      if (body.kind !== 'agent_event') return true;
      const e = body as unknown as BodyOf<'agent_event'>;
      if (o?.to === SENDER) setTimeout(() => showOn(sender, OWNER, e), 1);
      else if (o?.to === OWNER || !o?.to) showOn(owner, OWNER, e);
      return true;
    },
    ownerSharing,
    ownerRuns,
  );
  const senderHost: AgentHost = hostFor(
    sender,
    SENDER,
    (body, o) => {
      if (body.kind === 'agent_request' && o?.to === OWNER) {
        if (opts.ownerOnline === false) return false;
        const parsed = AgentRequestBody.parse(body);
        toOwner.push(parsed);
        setTimeout(() => void ownerHost.onAgentRequest(SENDER, parsed), 1);
        return true;
      }
      if (body.kind === 'agent_event') showOn(sender, SENDER, body as unknown as BodyOf<'agent_event'>);
      return true;
    },
    senderSharing,
    [],
  );
  const tools = (chainId = 'c1', hop = 0): Pick<ChatTools, 'send' | 'wait'> =>
    senderHost.chatSends.forRun({ channel: SOURCE, requester: SENDER, chain: () => ({ chainId, hop }), signal: new AbortController().signal });
  /** A message that reaches the owner as it would from the sender's computer, with what the sender claims. */
  const arrive = (requestId: string, channel: string, origin: Partial<ChatOrigin> = {}, from = SENDER): Promise<void> =>
    ownerHost.onAgentRequest(from, {
      kind: 'agent_request',
      requestId,
      prompt: 'please look',
      viaAgent: false,
      channel,
      urgent: false,
      plan: false,
      origin: { ref: `${SENDER}/${SOURCE}`, title: 'Source chat', agent: { runtime: 'claude', label: 'Claude' }, chainId: 'c1', hop: 1, messageId: requestId, ...origin },
    });
  const ownerCard = (requestId: string) => owner.getState().log.find((l) => l.type === 'agent' && l.requestId === requestId) as Extract<DomainState['log'][number], { type: 'agent' }> | undefined;
  const runsIn = (channel: string): string[] => ownerRuns.filter(([c]) => c === channel).map(([, p]) => p);
  const idOf = (receipt: string): string => (JSON.parse(receipt) as { message_id: string }).message_id;
  const waitFor_ = async (t: Pick<ChatTools, 'wait'>, receipt: string) => JSON.parse(await t.wait(idOf(receipt), 5)) as { state: string; answer?: string };
  return { owner, sender, ownerHost, senderHost, tools, arrive, ownerCard, runsIn, toOwner, wait: waitFor_ };
}

const SHARED_REF = `${OWNER}/${SHARED}`;

describe('an agent sends to a chat another person shared with its user', () => {
  it.each<TrustLevel>(['trusted', 'full'])('%s: the owner’s agent runs it at once, and the answer comes back', async (trust) => {
    const t = setup({ trust });
    const send = t.tools();
    const receipt = await send.send(SHARED_REF, 'please look', {});
    const answer = await t.wait(send, receipt);
    expect(answer).toMatchObject({ state: 'answered', answer: `done in ${SHARED}` });
    expect(t.runsIn(SHARED)[0]).toContain('please look');
    expect(t.owner.getState().approvals).toHaveLength(0);
    // The origin went with it: the owner's agent knows which chat it came from.
    expect(t.toOwner[0]?.origin).toMatchObject({ ref: `${SENDER}/${SOURCE}`, title: 'Source chat' });
  });

  it('ask: the owner sees an approval that says whose agent and which chat; Allow runs it', async () => {
    const t = setup({ trust: 'ask' });
    const send = t.tools();
    const receipt = await send.send(SHARED_REF, 'please look', {});
    await waitFor(() => t.owner.getState().approvals.length === 1);
    const approval = t.owner.getState().approvals[0]!;
    expect(approval.title).toContain("Sam's agent, from Source chat");
    expect(approval).toMatchObject({ kind: 'request', peer: SENDER, channel: SHARED });
    expect(t.runsIn(SHARED)).toEqual([]);
    // The sender sees that it waits for the owner.
    await waitFor(() => t.sender.getState().log.some((l) => l.type === 'agent' && l.status === 'awaiting_approval'));
    t.ownerHost.answerApproval('yes', approval.id);
    expect(await t.wait(send, receipt)).toMatchObject({ state: 'answered' });
  });

  it('ask: the approval reaches the phone through its approval view', async () => {
    const t = setup({ trust: 'ask' });
    await t.tools().send(SHARED_REF, 'please look', {});
    await waitFor(() => t.owner.getState().approvals.length === 1);
    const item = needsYou(t.owner.getState()).find((n) => n.id === `approval:${t.owner.getState().approvals[0]!.id}`);
    expect(item).toMatchObject({ kind: 'request' });
    expect(JSON.stringify(item)).toContain("Sam's agent, from Source chat");
  });

  it('ask: Decline refuses it, and the sender hears it failed', async () => {
    const t = setup({ trust: 'ask' });
    const send = t.tools();
    const receipt = await send.send(SHARED_REF, 'please look', {});
    await waitFor(() => t.owner.getState().approvals.length === 1);
    t.ownerHost.answerApproval('no', t.owner.getState().approvals[0]!.id);
    expect(await t.wait(send, receipt)).toMatchObject({ state: 'failed' });
    expect(t.runsIn(SHARED)).toEqual([]);
  });

  it('blocked: declined with no approval and no run', async () => {
    const t = setup({ trust: 'blocked' });
    const send = t.tools();
    const receipt = await send.send(SHARED_REF, 'please look', {});
    expect(await t.wait(send, receipt)).toMatchObject({ state: 'failed' });
    expect(t.owner.getState().approvals).toHaveLength(0);
    expect(t.runsIn(SHARED)).toEqual([]);
  });

  it('a viewer: the send is refused on the sender’s computer, and on the owner’s if it comes anyway', async () => {
    const t = setup({ trust: 'full' });
    await expect(t.tools().send(`${OWNER}/${VIEWED}`, 'hi', {})).rejects.toThrow(/^view_only:/);
    expect(t.toOwner).toHaveLength(0);
    await t.arrive('forged-view', VIEWED);
    expect(t.ownerCard('forged-view')).toMatchObject({ status: 'denied' });
    expect(t.ownerCard('forged-view')?.text).toMatch(/^view_only:/);
    expect(t.runsIn(VIEWED)).toEqual([]);
  });

  it('a chat that is not shared: not_found on both sides, also at full trust', async () => {
    const t = setup({ trust: 'full' });
    await expect(t.tools().send(`${OWNER}/${PRIVATE}`, 'hi', {})).rejects.toThrow(/^not_found:/);
    await t.arrive('forged-private', PRIVATE);
    await t.arrive('forged-none', 'ws:nothing');
    expect(t.runsIn(PRIVATE)).toEqual([]);
    expect(t.owner.getState().approvals).toHaveLength(0);
  });

  it('a chat that is not shared: the refusal goes back to the sender and says the same as for no chat', async () => {
    const sent: Array<{ body: BodyOf<'agent_event'>; to?: string }> = [];
    const t = setup({ trust: 'full' });
    const host = hostFor(t.owner, OWNER, (body, o) => (body.kind === 'agent_event' && sent.push({ body: body as unknown as BodyOf<'agent_event'>, ...(o?.to ? { to: o.to } : {}) }), true), { sharedFor: () => undefined, recipients: () => [], canPost: () => false, canSee: () => false, members: () => ({}) }, []);
    const arrive = (requestId: string, channel: string) =>
      host.onAgentRequest(SENDER, { kind: 'agent_request', requestId, prompt: 'x', viaAgent: false, channel, urgent: false, plan: false, origin: { ref: `${SENDER}/${SOURCE}`, title: 'S', agent: { runtime: 'claude', label: 'Claude' }, chainId: 'c', hop: 1, messageId: requestId } });
    await arrive('a', PRIVATE);
    await arrive('b', 'ws:nothing');
    const [a, b] = [sent.find((s) => s.body.requestId === 'a'), sent.find((s) => s.body.requestId === 'b')];
    expect(a).toMatchObject({ to: SENDER, body: { event: 'denied' } });
    expect(a?.body.text).toMatch(/^not_found:/);
    expect(b?.body.text).toBe(a?.body.text);
  });

  it('the owner is offline: refused with offline, and nothing waits to go', async () => {
    const t = setup({ ownerOnline: false });
    await expect(t.tools().send(SHARED_REF, 'hi', {})).rejects.toThrow(/^offline:/);
    expect(t.toOwner).toHaveLength(0);
  });
});

describe('the owner’s computer does not trust what the peer says about its chain', () => {
  it('a forged low hop: the owner counts from the higher hop it saw in that chain', async () => {
    const t = setup({ trust: 'full' });
    await t.arrive('h4', SHARED, { chainId: 'cx', hop: 4 });
    await waitFor(() => t.runsIn(SHARED).length === 1);
    await t.arrive('h0', SHARED, { chainId: 'cx', hop: 0 });
    await waitFor(() => t.ownerCard('h0')?.status === 'denied');
    expect(t.ownerCard('h0')?.text).toMatch(/^hop_limit:/);
    expect(t.runsIn(SHARED)).toHaveLength(1);
  });

  it('a hop over the limit is refused at once', async () => {
    const t = setup({ trust: 'full' });
    await t.arrive('h9', SHARED, { chainId: 'cy', hop: 9 });
    expect(t.ownerCard('h9')?.text).toMatch(/^hop_limit:/);
  });

  it('the pair limit counts on the owner side, per peer', async () => {
    const t = setup({ trust: 'full' });
    for (let i = 0; i < MAX_PAIR_MESSAGES; i++) await t.arrive(`p${i}`, SHARED, { chainId: `chain-${i}` });
    await t.arrive('over', SHARED, { chainId: 'chain-over' });
    expect(t.ownerCard('over')?.text).toMatch(/^pair_rate:/);
  });

  it('policy deny refuses a peer chat message, as it refuses a plain request', async () => {
    const t = setup({ trust: 'full' });
    t.owner.dispatch({ type: 'policy', policy: 'deny' });
    await t.arrive('deny1', SHARED);
    expect(t.ownerCard('deny1')).toMatchObject({ status: 'denied' });
    expect(t.runsIn(SHARED)).toEqual([]);
  });

  it('the pair limit counts per peer, whatever source chat the peer claims', async () => {
    const t = setup({ trust: 'full' });
    for (let i = 0; i < MAX_PAIR_MESSAGES; i++) await t.arrive(`q${i}`, SHARED, { chainId: `cq-${i}`, ref: `${SENDER}/ws:s${i}` });
    await t.arrive('q-over', SHARED, { chainId: 'cq-over', ref: `${SENDER}/ws:s-other` });
    expect(t.ownerCard('q-over')?.text).toMatch(/^pair_rate:/);
  });

  it('a send the owner declines uses none of the budget', async () => {
    const t = setup({ trust: 'ask' });
    for (let i = 0; i < MAX_PAIR_MESSAGES; i++) {
      void t.arrive(`d${i}`, SHARED, { chainId: `cd-${i}` });
      await waitFor(() => t.owner.getState().approvals.length === 1);
      t.ownerHost.answerApproval('no', t.owner.getState().approvals[0]!.id);
      await waitFor(() => t.owner.getState().approvals.length === 0);
    }
    void t.arrive('d-after', SHARED, { chainId: 'cd-after' });
    await waitFor(() => t.owner.getState().approvals.length === 1 || /pair_rate/.test(t.ownerCard('d-after')?.text ?? ''));
    expect(t.ownerCard('d-after')?.text ?? '').not.toMatch(/^pair_rate:/);
    expect(t.owner.getState().approvals).toHaveLength(1);
  });

  it('the approval names the source chat in one short line', async () => {
    const t = setup({ trust: 'ask' });
    void t.arrive('long', SHARED, { title: `${'very long title '.repeat(12)}END` });
    await waitFor(() => t.owner.getState().approvals.length === 1);
    const title = t.owner.getState().approvals[0]!.title;
    expect(title).not.toContain('END');
    expect(title).toContain('…');
  });

  it('an origin that claims another person’s chat is refused', async () => {
    const t = setup({ trust: 'full' });
    await t.arrive('liar', SHARED, { ref: `${OWNER}/${PRIVATE}` });
    expect(t.ownerCard('liar')).toMatchObject({ status: 'denied' });
    expect(t.runsIn(SHARED)).toEqual([]);
  });
});
