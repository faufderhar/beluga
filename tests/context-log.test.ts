import { describe, expect, it } from 'vitest';
import { type DomainState, initialState, reduce } from '../src/core/store.js';
import { compactText, parseContextEvent } from '../src/core/context-log.js';
import { breakdownRows, dividerText, isCompactItem, meterModel, usageLine, whenText } from '../packages/mac/src/chat/context-model.js';

const CH = 'ws:w1';
const ev = (event: 'context' | 'compact', data: object, ts = 1000, requestId = 'r1') =>
  ({ type: 'agent_event' as const, owner: 'me', requestId, requester: 'me', event, text: JSON.stringify(data), ts, channel: CH, itemId: requestId });
const dividers = (s: DomainState) => s.log.filter(isCompactItem);

describe('compaction in the chat', () => {
  it('shows "Compacting…" where it starts, then the result there, with the summary Claude kept', () => {
    let s = initialState('room');
    s = reduce(s, ev('context', { used: 172_000, window: 200_000 }));
    s = reduce(s, { type: 'system', text: 'something else happened', channel: CH, id: 'x', ts: 1500 });
    s = reduce(s, ev('context', { compacting: true, trigger: 'auto', used: 172_000, window: 200_000 }, 2000, 'compact-1'));
    expect(s.context[CH]).toMatchObject({ used: 172_000, compacting: true });
    expect(dividers(s)).toHaveLength(1);
    expect(dividers(s)[0]).toMatchObject({ compact: { state: 'running', trigger: 'auto' }, text: 'Compacting the conversation…' });
    // A message lands after it started; the divider stays where the compaction began.
    s = reduce(s, { type: 'system', text: 'later', channel: CH, id: 'y', ts: 2500 });
    s = reduce(s, ev('compact', { pre: 172_000, post: 21_000, trigger: 'auto', summary: '## Kept\n- the plan' }, 3000, 'compact-1'));
    const [d] = dividers(s);
    expect(d).toMatchObject({ ts: 2000, compact: { state: 'done', pre: 172_000, post: 21_000, trigger: 'auto', summary: '## Kept\n- the plan' }, text: 'Context compacted: 172k → 21k tokens (88% freed)' });
    expect(s.log.map((l) => l.id)).toEqual(['x', d!.id, 'y']);
    expect(s.context[CH]).toEqual({ used: 21_000, window: 200_000 });
    expect(s.compactions[CH]).toEqual({ pre: 172_000, post: 21_000, at: 3000 });
  });

  it('adds a summary that arrives after its compaction to that divider', () => {
    let s = initialState('room');
    s = reduce(s, ev('compact', { pre: 150_000, post: 18_000, key: 'b1' }, 1000));
    s = reduce(s, ev('compact', { pre: 120_000, post: 15_000, key: 'b2' }, 2000, 'r2'));
    s = reduce(s, ev('compact', { key: 'b1', summary: 'first summary' }, 3000));
    expect(dividers(s).map((d) => d.compact.summary)).toEqual(['first summary', undefined]);
    // Without a key: the newest one that has none yet.
    s = reduce(s, ev('compact', { summary: 'second summary' }, 4000));
    expect(dividers(s).map((d) => d.compact.summary)).toEqual(['first summary', 'second summary']);
    // The same compaction reported again doesn't add a second divider.
    s = reduce(s, ev('compact', { pre: 120_000, post: 15_000, key: 'b2' }, 5000, 'r3'));
    expect(dividers(s)).toHaveLength(2);
    // A summary for nothing known is ignored.
    expect(reduce(s, ev('compact', { key: 'nope', summary: 'x' }))).toBe(s);
  });

  it('says a compaction didn’t finish when it stops before Claude is done (nothing is lost)', () => {
    let s = initialState('room');
    s = reduce(s, ev('context', { compacting: true }, 1000, 'compact-2'));
    expect(s.context[CH]).toMatchObject({ used: 0, compacting: true });
    s = reduce(s, ev('context', { compacting: false, used: 160_000, window: 200_000 }, 2000, 'compact-2'));
    expect(dividers(s)[0]).toMatchObject({ level: 'warn', compact: { state: 'failed' } });
    expect(s.context[CH]).toEqual({ used: 160_000, window: 200_000 });
    expect(compactText({ state: 'failed' })).toMatch(/unchanged/);
  });

  it('keeps the breakdown and model with the numbers until new numbers come', () => {
    let s = initialState('room');
    s = reduce(s, ev('context', { used: 90_000, window: 1_000_000, model: 'opus[1m]', breakdown: { conversation: 50_000, tools: 30_000, system: 10_000 } }));
    s = reduce(s, ev('context', { used: 95_000 }));
    expect(s.context[CH]).toEqual({ used: 95_000, window: 1_000_000, model: 'opus[1m]' });
  });

  it('keeps a cache split with the window, and drops it when a new fill doesn’t bring one', () => {
    let s = initialState('room');
    s = reduce(s, ev('context', { used: 13_200, window: 256_000, cacheRead: 9_000, cacheWrite: 400 }));
    expect(s.context[CH]).toEqual({ used: 13_200, window: 256_000, cacheRead: 9_000, cacheWrite: 400 });
    s = reduce(s, ev('context', { compacting: true }));
    expect(s.context[CH]).toMatchObject({ used: 13_200, compacting: true, cacheRead: 9_000, cacheWrite: 400 });
    s = reduce(s, ev('context', { used: 14_000, window: 256_000 }));
    expect(s.context[CH]).toEqual({ used: 14_000, window: 256_000 });
  });

  it('reads peers’ JSON defensively', () => {
    expect(parseContextEvent('not json')).toBeUndefined();
    expect(parseContextEvent('7')).toBeUndefined();
    expect(parseContextEvent(JSON.stringify({ used: -5, window: 'big', trigger: 'sometimes', summary: '  ', breakdown: { conversation: 1 }, key: 3 }))).toEqual({});
    expect(parseContextEvent(JSON.stringify({ summary: 'x'.repeat(50_000) }))!.summary).toHaveLength(40_000);
  });
});

describe('the Mac meter model', () => {
  it('has nothing to show until the context is known, then the numbers, the tone and the last compaction', () => {
    let s = initialState('room');
    expect(meterModel(s, CH)).toBeUndefined();
    s = reduce(s, ev('compact', { pre: 150_000, post: 18_000 }, Date.UTC(2026, 9, 19, 14, 14)));
    s = reduce(s, ev('context', { used: 150_000, window: 200_000 }));
    const m = meterModel(s, CH)!;
    expect(m).toMatchObject({ pct: 75, tone: 'warn', compacting: false, busy: false });
    expect(m.last?.compact.pre).toBe(150_000);
    expect(usageLine(m.info!)).toBe('75% of 200k · 150k tokens');
  });

  it('knows when Claude is working there (Compact Now waits for its turn)', () => {
    let s = initialState('room');
    s = reduce(s, ev('context', { used: 10_000, window: 200_000 }));
    s = reduce(s, { type: 'agent_event', owner: 'me', requestId: 'run', requester: 'me', event: 'started', text: '', ts: 5, channel: CH });
    expect(meterModel(s, CH)?.busy).toBe(true);
  });

  it('words the divider: compacted, auto-compacted, running, unfinished', () => {
    const now = Date.UTC(2026, 9, 19, 15, 0);
    const at = now - 30 * 60_000;
    const item = (compact: object) => ({ id: 'd', type: 'system' as const, channel: CH, text: '', ts: at, level: 'info' as const, compact: compact as never });
    expect(dividerText(item({ state: 'done', pre: 152_000, post: 21_000, trigger: 'manual' }), false, now)).toBe(`Context compacted · 152k → 21k tokens · ${whenText(at, now)}`);
    expect(dividerText(item({ state: 'done', pre: 152_000, post: 21_000, trigger: 'auto' }), false, now)).toMatch(/^Auto-compacted · 152k → 21k/);
    expect(dividerText(item({ state: 'running', trigger: 'auto' }), false, now)).toBe('Context nearly full · compacting…');
    expect(dividerText(item({ state: 'running' }), false, now)).toBe('Compacting…');
    expect(dividerText(item({ state: 'running' }), true, now)).toMatch(/^Compaction didn’t finish/);
    expect(whenText(now - 3 * 86_400_000, now)).toMatch(/,/);
  });

  it('turns the breakdown into rows with their share of the window', () => {
    expect(breakdownRows({ used: 100_000, window: 200_000, breakdown: { conversation: 50_000, tools: 40_000, system: 10_000 } })).toEqual([
      { key: 'conversation', label: 'Conversation', tokens: 50_000, share: 0.25 },
      { key: 'tools', label: 'Tool results', tokens: 40_000, share: 0.2 },
      { key: 'system', label: 'System & files', tokens: 10_000, share: 0.05 },
    ]);
    expect(breakdownRows({ used: 1, window: 200_000 })).toEqual([]);
  });
});
