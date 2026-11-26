import { describe, expect, it } from 'vitest';
import { MAX_PAIR_MESSAGES, MAX_QUEUED_PER_TARGET } from '../src/core/chat-links/guard.js';
import { chatMessageAsker, chatMessagePrompt } from '../src/core/chat-links/message-prompt.js';
import { ChatSendService, type ChatSendDeps, type Delivered } from '../src/core/chat-links/service.js';
import { type DomainState, Store, initialState } from '../src/core/store.js';
import type { BodyOf } from '../src/protocol.js';
import { wakeRefusal } from '../src/core/sentinel/wake.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const FRIEND = 'friend-friend-friend-friend-frie';
const SENTINEL = { id: 'snt-1', name: 'Morning nudge' };

const ws = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `chat ${id}`, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 1000, ...extra });

function setup(opts: { state?: Record<string, unknown>; deliver?: (body: BodyOf<'agent_request'>) => Delivered | undefined; queued?: number; driving?: string } = {}) {
  const base = initialState('room', 'auto');
  const store = new Store({
    ...base,
    selfId: ME,
    projectsLoaded: true,
    prefs: { ...base.prefs, chatLinks: true },
    projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('main1', { kind: 'main' }), ws('tgt'), ws('gone', { archived: true })] }],
    shared: [{ owner: FRIEND, id: 'theirs', name: 'Their work', project: 'x', role: 'contribute', share: 's' }],
    ...opts.state,
  } as unknown as DomainState);
  const delivered: Array<BodyOf<'agent_request'>> = [];
  let now = 1_000_000;
  const deps: ChatSendDeps = {
    store,
    selfId: () => ME,
    queuedFromChats: () => opts.queued ?? 0,
    deliver: async (body) => {
      delivered.push(body);
      return opts.deliver ? opts.deliver(body) : { delivery: 'started' };
    },
    deliverTo: () => true,
    permissionRank: () => 0,
    agentIn: () => ({ runtime: 'claude', label: 'Claude' }),
    terminalDriving: (channel) => channel === opts.driving,
    load: () => undefined,
    system: () => undefined,
    askChain: async () => true,
    cancelChain: () => undefined,
    now: () => now,
  };
  const service = new ChatSendService(deps);
  const deliver = (channel: string, run = `run-${now}`) => service.deliverFromSentinel({ sentinel: SENTINEL, run, step: 'st-1', channel, text: 'Check the build' });
  return { service, store, delivered, deliver, tick: (ms: number) => void (now += ms) };
}

describe('ChatSendService.deliverFromSentinel', () => {
  it('delivers the prompt into your own chat, with the sentinel as its origin', async () => {
    const { delivered, deliver } = setup();
    const receipt = await deliver(`${ME}/ws:tgt`);
    expect(receipt).toMatchObject({ channel: 'ws:tgt', delivery: 'started' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ channel: 'ws:tgt', prompt: 'Check the build', requestId: receipt.messageId, origin: { title: 'Morning nudge', hop: 1, sentinel: { ...SENTINEL, run: 'run-1000000' }, agent: { runtime: 'beluga', label: 'Sentinel' } } });
  });

  it('takes a bare channel of yours too', async () => {
    const { deliver } = setup();
    await expect(deliver('ws:tgt')).resolves.toMatchObject({ channel: 'ws:tgt' });
  });

  it('delivers once per run', async () => {
    const { delivered, deliver } = setup();
    const first = await deliver('ws:tgt', 'run-a');
    const again = await deliver('ws:tgt', 'run-a');
    expect(again.messageId).toBe(first.messageId);
    expect(delivered).toHaveLength(1);
  });

  it.each([
    ['an archived chat', 'ws:gone', 'chat_archived'],
    ['a chat that does not exist', 'ws:nope', 'not_found'],
    ['a main checkout', 'ws:main1', 'not_found'],
    ['a ref that names no chat', 'nobody/ws:tgt', 'not_addressable'],
  ])('refuses %s', async (_, channel, code) => {
    const { delivered, deliver } = setup();
    await expect(deliver(channel)).rejects.toThrow(new RegExp(`^${code}:`));
    expect(delivered).toHaveLength(0);
  });

  it('refuses while the projects load', async () => {
    const { deliver } = setup({ state: { projectsLoaded: false, projects: [] } });
    await expect(deliver('ws:tgt')).rejects.toThrow(/^chat_loading:/);
  });

  it('refuses a chat another person shared with you', async () => {
    const { delivered, deliver } = setup({ state: { peers: [{ peerId: FRIEND, name: 'Friend' }] } });
    await expect(deliver(`${FRIEND}/ws:theirs`)).rejects.toThrow(/^not_yours:/);
    expect(delivered).toHaveLength(0);
  });

  it('refuses a main checkout that moved to a chat shared with a contributor (the chat it lands in is checked)', async () => {
    const { delivered, deliver } = setup({ state: { projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('main1', { kind: 'main', movedTo: 'tgt' }), ws('tgt')] }], members: { tgt: { [FRIEND]: 'contribute' } } } });
    expect(wakeRefusal({ ...initialState('room'), selfId: ME, projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('main1', { kind: 'main', movedTo: 'tgt' }), ws('tgt')] }], members: { tgt: { [FRIEND]: 'contribute' } } } as unknown as DomainState, `${ME}/ws:main1`)).toMatch(/shared with a contributor/);
    await expect(deliver(`${ME}/ws:main1`)).rejects.toThrow(/^shared_contributor:/);
    expect(delivered).toHaveLength(0);
  });

  it('refuses a chat its terminal drives', async () => {
    const { deliver } = setup({ driving: 'ws:tgt' });
    await expect(deliver('ws:tgt')).rejects.toThrow(/^terminal_driving:/);
  });

  it('refuses when the chat does not take it, and keeps nothing', async () => {
    const { deliver } = setup({ deliver: () => undefined });
    await expect(deliver('ws:tgt', 'run-x')).rejects.toThrow(/^not_delivered:/);
  });

  it('refuses when too many messages wait at the chat', async () => {
    const { deliver } = setup({ queued: MAX_QUEUED_PER_TARGET });
    await expect(deliver('ws:tgt')).rejects.toThrow(/^queue_full:/);
  });

  it('refuses past the limits of the guard, and asks nothing', async () => {
    const { delivered, deliver, tick } = setup();
    for (let i = 0; i < MAX_PAIR_MESSAGES; i++) {
      await deliver('ws:tgt', `run-${i}`);
      tick(1000);
    }
    await expect(deliver('ws:tgt', 'run-more')).rejects.toThrow(/^pair_rate:.*Try again after/);
    expect(delivered).toHaveLength(MAX_PAIR_MESSAGES);
  });
});

describe('ChatSendService.outcome', () => {
  it('waits for the turn the prompt started, and gives its answer', async () => {
    const { service, store, deliver } = setup();
    const { messageId } = await deliver('ws:tgt', 'run-w');
    const event = (e: 'started' | 'done', text: string) => store.dispatch({ type: 'agent_event', owner: ME, requestId: messageId, requester: ME, event: e, text, ts: Date.now(), channel: 'ws:tgt' });
    event('started', '');
    const waiting = service.outcome(messageId, 5000, new AbortController().signal);
    setTimeout(() => event('done', 'All green.'), 5);
    await expect(waiting).resolves.toEqual({ state: 'answered', answer: 'All green.' });
  });

  it('says how far it got when the time is up', async () => {
    const { service, deliver } = setup();
    const { messageId } = await deliver('ws:tgt', 'run-t');
    await expect(service.outcome(messageId, 10, new AbortController().signal)).resolves.toEqual({ state: 'working' });
  });
});

describe('the prompt a sentinel sends', () => {
  const origin = { ref: `${ME}/sentinel:snt-1`, title: 'Morning nudge', agent: { runtime: 'beluga', label: 'Sentinel' }, chainId: 'c', hop: 1, messageId: 'm', sentinel: SENTINEL } as const;

  it("is your user's, with Beluga's line first", () => {
    const prompt = chatMessagePrompt(origin, '/review the $deploy');
    expect(prompt.split('\n')[0]).toBe("[Beluga: your user's sentinel “Morning nudge” sends this prompt on its schedule. Your user set it up.]");
    expect(prompt).toContain('/review the $​deploy');
    expect(chatMessageAsker(origin)).toBe("your user's sentinel Morning nudge, on its schedule");
  });
});
