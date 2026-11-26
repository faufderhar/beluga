import { describe, expect, it } from 'vitest';
import { createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import type { SentinelWake } from '../src/core/sentinel/runner.js';
import { setup } from './sentinel-fakes.js';

/** sentinel_create from a chat: a chat step's `to: "this chat"` is the calling chat (BLG-398). */

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
type Handler = (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const wake: SentinelWake = { refusal: () => undefined, deliver: async () => 'm1', wait: async () => ({ state: 'answered', answer: 'ok' }) };
const draft = (to = 'this chat') => ({ name: 'Daily nudge', trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' }, steps: [{ kind: 'chat', name: 'Wake', to, text: 'Send the status' }] });

function toolsIn(channel: string) {
  const s = setup({ selfId: () => ME, wake });
  const defs = createSentinelToolDefs(s.sentinels.forRun(channel, ME)!.tools);
  const call = (name: string, args: unknown) => (defs.find((d) => d.name === name)!.handler as Handler)(args, {});
  return { s, call };
}

describe('to: "this chat"', () => {
  it('sentinel_create stores the calling chat’s ref, and the sentinel is paused', async () => {
    const { s, call } = toolsIn('ws:w1');
    const res = await call('sentinel_create', draft());
    expect(res.isError).toBeFalsy();
    const made = s.sentinels.list().find((x) => x.name === 'Daily nudge')!;
    expect(made.steps[0]).toMatchObject({ kind: 'chat', to: `${ME}/ws:w1`, text: 'Send the status' });
    expect(made.paused).toBe(true);
  });

  it('sentinel_update takes it too', async () => {
    const { s, call } = toolsIn('ws:w2');
    await call('sentinel_create', draft(`${ME}/ws:w1`));
    const made = s.sentinels.list().find((x) => x.name === 'Daily nudge')!;
    const res = await call('sentinel_update', { id: made.id, steps: [{ kind: 'chat', name: 'Wake', to: 'This chat', text: 'Again' }] });
    expect(res.isError).toBeFalsy();
    expect(s.sentinels.get(made.id)!.steps[0]).toMatchObject({ to: `${ME}/ws:w2`, text: 'Again' });
  });

  it('a call from a chat that has no ref is refused, with a clear message', async () => {
    const { s, call } = toolsIn('room');
    const res = await call('sentinel_create', draft());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/"this chat" target needs a chat that has a ref/);
    expect(s.sentinels.list().some((x) => x.name === 'Daily nudge')).toBe(false);
  });

  it('another chat’s ref stays as given', async () => {
    const { s, call } = toolsIn('ws:w1');
    await call('sentinel_create', draft(`${ME}/ws:w9`));
    expect(s.sentinels.list().find((x) => x.name === 'Daily nudge')!.steps[0]).toMatchObject({ to: `${ME}/ws:w9` });
  });
});
