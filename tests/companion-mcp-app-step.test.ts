import { describe, expect, it } from 'vitest';
import { convTurns } from '../src/companion/views.js';
import { Store, initialState } from '../src/core/store.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';

function storeWith() {
  const store = new Store({ ...initialState('room', 'auto'), selfId: ME });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: 1000, channel: 'ws:a' });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'tool', text: 'mcp__basic__get-time', ts: 1100, channel: 'ws:a' });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'tool', text: 'mcp__basic__plain', ts: 1200, channel: 'ws:a' });
  store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'done', text: 'Done', ts: 2000, channel: 'ws:a' });
  return store;
}

describe('a step with an MCP App on the phone', () => {
  it('says the app is on your Mac, and the other steps read as today', () => {
    const asked: string[] = [];
    const ctx = { macName: 'Mac', refs: { output: () => undefined }, appSteps: (channel: string, itemId: string) => (asked.push(`${channel}/${itemId}`), new Set(['mcp__basic__get-time'])) } as never;
    const turn = convTurns(storeWith().getState(), ctx, 'ws:a').turns.find((t) => t.who === 'claude')!;
    expect(turn.trail?.map((x) => x.text)).toEqual(['Get time app, on your Mac', 'Used plain']);
    expect(asked).toHaveLength(1);
  });

  it('reads as today without the step book', () => {
    const turn = convTurns(storeWith().getState(), { macName: 'Mac', refs: { output: () => undefined } } as never, 'ws:a').turns.find((t) => t.who === 'claude')!;
    expect(turn.trail?.map((x) => x.text)).toEqual(['Used get time', 'Used plain']);
  });
});

describe('a message an MCP App sent, on the phone', () => {
  it('reads "Sent by the <tool> app" and is not editable', () => {
    const store = new Store({ ...initialState('room', 'auto'), selfId: ME });
    store.dispatch({ type: 'chat', id: 'm1', from: ME, text: 'Set an alarm for 7:30', ts: 1000, byAgent: false, channel: 'ws:a', fromApp: 'show_clock' });
    const turn = convTurns(store.getState(), { macName: 'Mac', refs: { output: () => undefined } } as never, 'ws:a').turns.find((t) => t.who === 'you')!;
    expect(turn.via).toBe('the show_clock app');
    expect(turn.edit).toBeUndefined();
  });
});
