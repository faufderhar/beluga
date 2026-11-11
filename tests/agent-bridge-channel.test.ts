import { describe, expect, it } from 'vitest';
import { createRoomBridge } from '../src/core/agent-bridge.js';
import type { Session } from '../src/core/session.js';

/** Two conversations run at once: each run's send_chat lands in its own, not the one that started last. */
describe('room bridge per conversation', () => {
  const fake = () => {
    const sent: Array<{ text: string; channel: string }> = [];
    const session = {
      host: { currentChannel: 'room', viaIn: () => undefined },
      sendChat: (text: string, _byAgent: boolean, channel: string) => sent.push({ text, channel }),
      store: { getState: () => ({ self: { name: 'Kayra' }, peers: [] }) },
    } as unknown as Session;
    return { session, sent };
  };

  it('posts to the run’s own conversation even after another run started', () => {
    const { session, sent } = fake();
    const bridge = createRoomBridge(session, () => '/tmp');
    const ocr = bridge.inChannel!('ws:ocr');
    session.host.currentChannel = 'ws:ocr';
    const phone = bridge.inChannel!('ws:phone');
    session.host.currentChannel = 'ws:phone';
    ocr.sendChat('I need an API key');
    phone.sendChat('fixing the phone');
    expect(sent).toEqual([
      { text: 'I need an API key', channel: 'ws:ocr' },
      { text: 'fixing the phone', channel: 'ws:phone' },
    ]);
  });

  it('falls back to the last run’s conversation when unbound', () => {
    const { session, sent } = fake();
    session.host.currentChannel = 'ws:a';
    createRoomBridge(session, () => '/tmp').sendChat('hi');
    expect(sent).toEqual([{ text: 'hi', channel: 'ws:a' }]);
  });
});
