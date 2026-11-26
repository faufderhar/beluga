import { describe, expect, it } from 'vitest';
import { attachSentinel } from '../src/core/sentinel/registry.js';
import { SENTINEL_HANDLERS } from '../src/ipc/sentinel-handlers.js';
import { setup } from './sentinel-fakes.js';

/** A chat's schedules (BLG-399): the sentinels whose chat step wakes that chat, for its Info panel. */

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const daily = { kind: 'schedule' as const, every: 'day' as const, at: '09:00', missed: 'skip' as const };
const wake = (to: string, text = 'Send the status') => ({ kind: 'chat' as const, name: 'Wake', to, text });

function withSchedules() {
  const s = setup({ selfId: () => ME, wake: { refusal: () => undefined, deliver: async () => 'm1', wait: async () => ({ state: 'answered', answer: 'ok' }) } });
  const mine = s.sentinels.create({ name: 'Morning status', trigger: daily, steps: [wake(`${ME}/ws:w1`, 'Send XYZ')] });
  s.sentinels.create({ name: 'Other chat', trigger: daily, steps: [wake(`${ME}/ws:w2`)] });
  s.sentinels.create({ name: 'Someone else’s w1', trigger: daily, steps: [wake('someone-elses-id-000/ws:w1')] });
  s.sentinels.create({ name: 'A message', trigger: daily, steps: [{ kind: 'message', to: 'dm:bob', text: 'hi' }] });
  return { s, mine };
}

describe('sentinels.forChat', () => {
  it('returns only the sentinels whose chat step targets that channel', () => {
    const { s, mine } = withSchedules();
    const found = s.sentinels.forChat('ws:w1');
    expect(found.map((x) => x.id)).toEqual([mine.id]);
    expect(found[0]).toMatchObject({ name: 'Morning status', paused: true, trigger: daily, prompt: 'Send XYZ', running: false });
  });

  it('takes the chat’s ref as well as its channel', () => {
    const { s, mine } = withSchedules();
    expect(s.sentinels.forChat(`${ME}/ws:w1`).map((x) => x.id)).toEqual([mine.id]);
  });

  it('a chat no sentinel wakes has none', () => {
    const { s } = withSchedules();
    expect(s.sentinels.forChat('ws:w9')).toEqual([]);
    expect(s.sentinels.forChat('mac:assistant')).toEqual([]);
  });

  it('a schedule that is on says when it runs next', () => {
    const { s, mine } = withSchedules();
    s.sentinels.pause(mine.id, false);
    const [row] = s.sentinels.forChat('ws:w1');
    expect(row!.paused).toBe(false);
    expect(row!.nextAt).toBeGreaterThan(Date.now());
  });

  it('is the API method sentinel.forChat', () => {
    const { s, mine } = withSchedules();
    const session = {};
    attachSentinel(session, s.sentinels);
    expect((SENTINEL_HANDLERS['sentinel.forChat'](session as never, 'ws:w1') as { id: string }[]).map((x) => x.id)).toEqual([mine.id]);
  });
});
