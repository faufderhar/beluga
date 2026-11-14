import { describe, expect, it } from 'vitest';
import { phoneMay } from '../src/companion/coverage.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { convTurns, convView } from '../src/companion/views.js';
import { queueIn } from '../src/ui/compose.js';
import { chatMentionsAsTitles } from '../src/shared/chat-ref.js';
import { COMPANION_PROTO, ConvView, NeedsYou, SINCE, TurnView, viewSchema } from '../src/companion/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import type { ChatOrigin } from '../src/protocol.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const ORIGIN: ChatOrigin = { ref: `${ME}/ws:src`, title: 'Fix the login', agent: { runtime: 'codex', label: 'Codex' }, chainId: 'c1', hop: 2, messageId: 'm1' };

function storeWith() {
  const base = initialState('room', 'auto');
  const store = new Store({ ...base, selfId: ME });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'm1', requester: ME, event: 'started', text: '', ts: 1000, channel: 'ws:tgt', fromChat: { origin: ORIGIN, text: 'Please check **this**' } });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'm1', requester: ME, event: 'done', text: 'It works', ts: 2000, channel: 'ws:tgt' });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r2', requester: ME, event: 'done', text: 'Plain', ts: 3000, channel: 'ws:tgt' });
  return store;
}

describe('a message from another chat on the phone', () => {
  it('is an additive minor', () => {
    expect(SINCE.chatOrigin).toBeLessThanOrEqual(COMPANION_PROTO.minor);
    expect(COMPANION_PROTO.major).toBe(1);
  });

  it('the log keeps the origin and the words on the card', () => {
    const item = storeWith().getState().log.find((l) => l.type === 'agent' && l.requestId === 'm1');
    expect(item).toMatchObject({ origin: { chainId: 'c1', hop: 2 }, prompt: 'Please check **this**', status: 'done', text: 'It works' });
  });

  it('shows on the agent’s turn with its source, and never as your message', () => {
    const { turns } = convTurns(storeWith().getState(), { macName: 'Mac' } as never, 'ws:tgt');
    const turn = turns[0]!;
    expect(turn.who).toBe('claude');
    expect(turn.origin).toMatchObject({ ref: ORIGIN.ref, title: 'Fix the login', agent: 'Codex' });
    expect(turn.origin!.prose.text).toContain('Please check');
    expect(TurnView.safeParse(turn).success).toBe(true);
    expect(turns.filter((t) => t.who === 'you')).toEqual([]);
    expect(turns[1]!.origin).toBeUndefined();
  });

  it('an older phone reads the turn without the field', () => {
    const { turns } = convTurns(storeWith().getState(), { macName: 'Mac' } as never, 'ws:tgt');
    const { origin: _origin, ...older } = turns[0]!;
    expect(TurnView.safeParse(older).success).toBe(true);
  });
});

describe('a chain at a limit on the phone', () => {
  it('reaches it as a decision with Continue and Stop, and the answer goes through host.answerApproval', () => {
    const store = storeWith();
    store.dispatch({ type: 'approval_add', approval: { id: 'q1', kind: 'chain', title: 'Agents sent 4 messages between these chats.', detail: 'x', channel: 'ws:src', askedAt: 1, timeoutMs: 60_000, once: true } });
    const need = waitingNeeds(store.getState()).find((n) => n.id === 'approval:q1')!;
    expect(need).toMatchObject({ kind: 'decision', title: 'Agents sent 4 messages between these chats.' });
    expect(need.actions).toEqual([
      { label: 'Continue', tone: 'main', method: 'host.answerApproval', args: ['yes', 'q1'] },
      { label: 'Stop', tone: 'danger', method: 'host.answerApproval', args: ['no', 'q1'] },
    ]);
    expect(phoneMay('host.answerApproval')).toBe(true);
  });
});

describe('a queued message from another chat', () => {
  function queued() {
    const store = new Store({ ...initialState('room', 'auto'), selfId: ME });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'busy', requester: ME, event: 'started', text: '', ts: 1, channel: 'ws:tgt' });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'from-chat', requester: ME, event: 'queued', text: 'Please check', ts: 2, channel: 'ws:tgt', fromChat: { origin: ORIGIN, text: 'Please check' } });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'mine', requester: ME, event: 'queued', text: 'My words', ts: 3, channel: 'ws:tgt' });
    return store.getState();
  }

  it('the Mac’s queue carries the origin, and your own row has the same fields as before', () => {
    const [from, mine] = queueIn(queued(), 'ws:tgt', ME);
    expect(from).toMatchObject({ requestId: 'from-chat', prompt: 'Please check', origin: { ref: ORIGIN.ref, title: 'Fix the login' } });
    expect(mine).toEqual({ requestId: 'mine', prompt: 'My words', by: expect.any(String), claude: expect.any(String), yours: true });
  });

  it('the phone’s queue row is drawn from the origin, and your own row has the same fields as before', () => {
    const queue = convView(queued(), { macName: 'Mac', refs: { output: () => undefined } } as never, 'conv:ws:tgt' as never).queue!;
    expect(queue).toEqual([
      { id: 'from-chat', text: 'Please check', origin: { ref: ORIGIN.ref, title: 'Fix the login', agent: 'Codex' } },
      { id: 'mine', text: 'My words' },
    ]);
    expect(SINCE.queuedOrigin).toBeLessThanOrEqual(COMPANION_PROTO.minor);
  });

  it('an older phone reads a row without the field', () => {
    expect(ConvView.shape.queue.safeParse([{ id: 'a', text: 'b' }]).success).toBe(true);
  });
});

describe('what the phone keeps after it parses a view (BLG-289)', () => {
  const ctx = { macName: 'Mac', refs: { output: () => undefined } } as never;

  it('the conv view keeps the queue row’s origin', () => {
    const parsed = viewSchema('conv:ws:tgt' as never).parse(convView(storeWithQueue().getState(), ctx, 'conv:ws:tgt' as never)) as ConvView;
    expect(parsed.queue).toEqual([
      { id: 'from-chat', text: 'Please check', origin: { ref: ORIGIN.ref, title: 'Fix the login', agent: 'Codex' } },
      { id: 'mine', text: 'My words' },
    ]);
  });

  it('the conv view keeps the turn’s origin', () => {
    const parsed = viewSchema('conv:ws:tgt' as never).parse(convView(storeWith().getState(), ctx, 'conv:ws:tgt' as never)) as ConvView;
    expect(parsed.turns[0]!.origin).toMatchObject({ ref: ORIGIN.ref, title: 'Fix the login', agent: 'Codex', prose: { text: expect.stringContaining('Please check') } });
  });

  it('the chain decision keeps its kind and its Continue and Stop', () => {
    const store = storeWith();
    store.dispatch({ type: 'approval_add', approval: { id: 'q1', kind: 'chain', title: 'Agents sent 4 messages between these chats.', detail: 'x', channel: 'ws:src', askedAt: 1, timeoutMs: 60_000, once: true } });
    const need = NeedsYou.parse(waitingNeeds(store.getState()).find((n) => n.id === 'approval:q1'));
    expect(need).toMatchObject({ kind: 'decision', title: 'Agents sent 4 messages between these chats.' });
    expect(need.actions.map((a) => [a.label, a.method, a.args])).toEqual([
      ['Continue', 'host.answerApproval', ['yes', 'q1']],
      ['Stop', 'host.answerApproval', ['no', 'q1']],
    ]);
  });
});

/** A busy chat with a message from another chat and one of yours waiting. */
function storeWithQueue() {
  const store = new Store({ ...initialState('room', 'auto'), selfId: ME });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'busy', requester: ME, event: 'started', text: '', ts: 1, channel: 'ws:tgt' });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'from-chat', requester: ME, event: 'queued', text: 'Please check', ts: 2, channel: 'ws:tgt', fromChat: { origin: ORIGIN, text: 'Please check' } });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'mine', requester: ME, event: 'queued', text: 'My words', ts: 3, channel: 'ws:tgt' });
  return store;
}

describe('chat chips on the phone', () => {
  const ctx = { macName: 'Mac', refs: { output: () => undefined } } as never;
  const conv = (): ConvView => {
    const base = initialState('room', 'auto');
    const store = new Store({ ...base, selfId: ME });
    return viewSchema('conv:ws:tgt' as never).parse(convView(store.getState(), ctx, 'conv:ws:tgt' as never)) as ConvView;
  };

  it('the conversation says the Mac has chat links', () => {
    expect(conv().chatLinks).toBe(true);
  });
});
