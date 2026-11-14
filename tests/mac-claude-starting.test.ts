import { describe, expect, it } from 'vitest';
import { lastMineIn, startingShows, type Starting } from '../packages/mac/src/chat/starting-model.js';

// BLG-949: you press Return in a worktree; "Claude is starting…" must come after your message.
const sent: Starting = { channel: 'ws:a', cardsBefore: 2, lastMineBefore: 'm1', at: 0 };
const now = { channel: 'ws:a', cards: 2, lastMine: 'm1', landing: 0 };

describe('"Claude is starting…" after your message', () => {
  it('waits while your message is still on its way from the daemon', () => {
    expect(startingShows(sent, now)).toBe(false);
  });

  it('waits while your message is flying into the chat', () => {
    expect(startingShows(sent, { ...now, lastMine: 'm2', landing: 1 })).toBe(false);
  });

  it('shows once your message has landed', () => {
    expect(startingShows(sent, { ...now, lastMine: 'm2' })).toBe(true);
  });

  it('shows for your first message in a conversation', () => {
    expect(startingShows({ ...sent, lastMineBefore: undefined }, { ...now, lastMine: 'm1' })).toBe(true);
  });

  it("goes when Claude's card appears", () => {
    expect(startingShows(sent, { ...now, lastMine: 'm2', cards: 3 })).toBe(false);
  });

  it('is only for the conversation you sent it in', () => {
    expect(startingShows(sent, { ...now, channel: 'ws:b', lastMine: 'm2' })).toBe(false);
    expect(startingShows(undefined, { ...now, lastMine: 'm2' })).toBe(false);
  });
});

describe('lastMineIn', () => {
  it("finds your newest message, not a friend's or Claude's card", () => {
    const items = [
      { type: 'chat', id: 'a', from: 'me' },
      { type: 'chat', id: 'b', from: 'bob' },
      { type: 'agent', id: 'c', from: 'me' },
    ];
    expect(lastMineIn(items, 'me')).toBe('a');
    expect(lastMineIn([], 'me')).toBeUndefined();
  });
});
