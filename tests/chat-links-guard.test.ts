import { describe, expect, it } from 'vitest';
import { type GuardAsk, type GuardState, MAX_CHAIN_MESSAGES, MAX_HOPS, MAX_PAIR_MESSAGES, MAX_QUEUED_PER_TARGET, MAX_TARGET_MESSAGES, NO_SENDS, PAIR_WINDOW_MS, TARGET_WINDOW_MS, checkSend, checkSentOn, renewChain } from '../src/core/chat-links/guard.js';

const T0 = 1_000_000;
let ids = 0;

function ask(extra: Partial<GuardAsk> = {}): GuardAsk {
  ids++;
  return { requestId: `q${ids}`, messageId: `m${ids}`, source: 'a', target: 'b', chainId: 'c1', hop: 0, queued: 0, now: T0, ...extra };
}

/** Each send goes through, on its own chain and source unless the ask says otherwise. */
function sends(state: GuardState, count: number, extra: (i: number) => Partial<GuardAsk>): GuardState {
  let at = state;
  for (let i = 0; i < count; i++) {
    const { state: next, decision } = checkSend(at, ask(extra(i)));
    expect(decision.allow).toBe(true);
    at = next;
  }
  return at;
}

describe('checkSend', () => {
  it('allows a send and gives the message the next hop', () => {
    expect(checkSend(NO_SENDS, ask({ messageId: 'm', hop: 2 })).decision).toEqual({ allow: true, messageId: 'm', hop: 3, repeat: false });
  });

  it('refuses a send to the same chat', () => {
    expect(checkSend(NO_SENDS, ask({ target: 'a' })).decision).toEqual({ allow: false, code: 'self' });
  });

  it('a ping-pong between two chats stops at hop 4', () => {
    let state = NO_SENDS;
    let hop = 0;
    const route = [['a', 'b'], ['b', 'a']] as const;
    for (let i = 0; i < MAX_HOPS; i++) {
      const [source, target] = route[i % 2]!;
      const out = checkSend(state, ask({ source, target, hop }));
      expect(out.decision).toMatchObject({ allow: true, hop: i + 1 });
      state = out.state;
      hop = i + 1;
    }
    expect(hop).toBe(4);
    expect(checkSend(state, ask({ source: 'b', target: 'a', hop })).decision).toEqual({ allow: false, code: 'hop_limit' });
  });

  it('counts the messages of a chain, whatever their hop', () => {
    const state = sends(NO_SENDS, MAX_CHAIN_MESSAGES, (i) => ({ source: `s${i}`, target: `t${i}` }));
    expect(checkSend(state, ask({ source: 'x', target: 'y' })).decision).toEqual({ allow: false, code: 'chain_limit' });
    expect(checkSend(state, ask({ source: 'x', target: 'y', chainId: 'c2' })).decision.allow).toBe(true);
  });

  it('limits a pair in one direction, and says when to retry', () => {
    const state = sends(NO_SENDS, MAX_PAIR_MESSAGES, (i) => ({ chainId: `c${i}`, now: T0 + i }));
    expect(checkSend(state, ask({ chainId: 'n', now: T0 + 10 })).decision).toEqual({ allow: false, code: 'pair_rate', retryAt: T0 + PAIR_WINDOW_MS });
    expect(checkSend(state, ask({ chainId: 'n', source: 'b', target: 'a', now: T0 + 10 })).decision.allow).toBe(true);
    expect(checkSend(state, ask({ chainId: 'n', now: T0 + PAIR_WINDOW_MS })).decision.allow).toBe(true);
  });

  it('limits a target from all sources, and says when to retry', () => {
    const state = sends(NO_SENDS, MAX_TARGET_MESSAGES, (i) => ({ chainId: `c${i}`, source: `s${i}`, now: T0 + i }));
    expect(checkSend(state, ask({ chainId: 'n', source: 'x', now: T0 + 100 })).decision).toEqual({ allow: false, code: 'target_rate', retryAt: T0 + TARGET_WINDOW_MS });
    expect(checkSend(state, ask({ chainId: 'n', source: 'x', now: T0 + TARGET_WINDOW_MS })).decision.allow).toBe(true);
  });

  it('refuses when the queue of the target is full', () => {
    expect(checkSend(NO_SENDS, ask({ queued: MAX_QUEUED_PER_TARGET })).decision).toEqual({ allow: false, code: 'queue_full' });
    expect(checkSend(NO_SENDS, ask({ queued: MAX_QUEUED_PER_TARGET - 1 })).decision.allow).toBe(true);
  });

  it('a refusal counts nothing', () => {
    const { state } = checkSend(NO_SENDS, ask({ target: 'a' }));
    expect(state).toEqual(NO_SENDS);
  });
});

describe('idempotency', () => {
  it('the same request id returns the same receipt and counts one time', () => {
    const first = checkSend(NO_SENDS, ask({ requestId: 'same', messageId: 'm1' }));
    const again = checkSend(first.state, ask({ requestId: 'same', messageId: 'm2' }));
    expect(again.decision).toEqual({ allow: true, messageId: 'm1', hop: 1, repeat: true });
    expect(again.state.sent).toHaveLength(1);
    expect(again.state.chains.c1!.messages).toBe(1);
  });

  it('a repeat gets its receipt even at the limit', () => {
    let state = checkSend(NO_SENDS, ask({ requestId: 'same', messageId: 'm1' })).state;
    state = sends(state, MAX_PAIR_MESSAGES - 1, () => ({}));
    expect(checkSend(state, ask()).decision).toMatchObject({ allow: false, code: 'pair_rate' });
    expect(checkSend(state, ask({ requestId: 'same' })).decision).toMatchObject({ allow: true, messageId: 'm1', repeat: true });
  });

  it('the id belongs to its source chat', () => {
    const first = checkSend(NO_SENDS, ask({ requestId: 'same', messageId: 'm1' }));
    expect(checkSend(first.state, ask({ requestId: 'same', messageId: 'm2', source: 'z' })).decision).toMatchObject({ messageId: 'm2', repeat: false });
  });

  it('a refused request can try again with its id', () => {
    const state = sends(NO_SENDS, MAX_PAIR_MESSAGES, () => ({}));
    expect(checkSend(state, ask({ requestId: 'same' })).decision.allow).toBe(false);
    expect(checkSend(state, ask({ requestId: 'same', now: T0 + PAIR_WINDOW_MS })).decision.allow).toBe(true);
  });
});

describe('the reset of a chain', () => {
  it('a new chain has a new budget', () => {
    const state = sends(NO_SENDS, MAX_CHAIN_MESSAGES, (i) => ({ source: `s${i}`, target: `t${i}` }));
    expect(checkSend(state, ask({ source: 'x', target: 'y', chainId: 'next', hop: 0 })).decision).toMatchObject({ allow: true, hop: 1 });
  });

  it('Continue gives the same chain new hops and a new count', () => {
    let state = sends(NO_SENDS, MAX_HOPS, (i) => ({ source: `s${i}`, target: `t${i}`, hop: i }));
    expect(checkSend(state, ask({ source: 'x', target: 'y', hop: MAX_HOPS })).decision).toMatchObject({ code: 'hop_limit' });
    state = renewChain(state, 'c1', MAX_HOPS, T0);
    expect(checkSend(state, ask({ source: 'x', target: 'y', hop: MAX_HOPS })).decision).toMatchObject({ allow: true, hop: MAX_HOPS + 1 });
    state = sends(state, MAX_HOPS, (i) => ({ source: `p${i}`, target: `q${i}`, hop: MAX_HOPS + i }));
    expect(checkSend(state, ask({ source: 'x', target: 'y', hop: 2 * MAX_HOPS })).decision).toMatchObject({ code: 'hop_limit' });
  });

  it('Continue takes the sends of the chain out of the rate windows, and only those', () => {
    let state = sends(NO_SENDS, 2, () => ({}));
    state = sends(state, 1, () => ({ chainId: 'other' }));
    expect(checkSend(state, ask()).decision).toMatchObject({ code: 'pair_rate' });
    state = renewChain(state, 'c1', 1, T0);
    expect(state.sent.map((s) => s.chainId)).toEqual(['other']);
    expect(checkSend(state, ask()).decision.allow).toBe(true);
  });
});

describe('a message your agent sends on outside the chat tools (a plan’s message to a task)', () => {
  it('goes one hop on, and stops at the hop limit', () => {
    expect(checkSentOn(NO_SENDS, { chainId: 'c1', hop: MAX_HOPS - 1, now: T0 }).decision).toEqual({ allow: true, hop: MAX_HOPS });
    expect(checkSentOn(NO_SENDS, { chainId: 'c1', hop: MAX_HOPS, now: T0 }).decision).toEqual({ allow: false, code: 'hop_limit' });
  });

  it('counts in the budget of its chain, and not in any rate window', () => {
    let state = NO_SENDS;
    for (let i = 0; i < MAX_CHAIN_MESSAGES; i++) {
      const out = checkSentOn(state, { chainId: 'c1', hop: 0, now: T0 });
      expect(out.decision.allow).toBe(true);
      state = out.state;
    }
    expect(state.sent).toEqual([]);
    expect(checkSentOn(state, { chainId: 'c1', hop: 0, now: T0 }).decision).toEqual({ allow: false, code: 'chain_limit' });
    expect(checkSend(state, ask({ source: 'x', target: 'y' })).decision).toEqual({ allow: false, code: 'chain_limit' });
  });
});
