import { describe, expect, it } from 'vitest';
import { phoneMay } from '../src/companion/coverage.js';
import { convView } from '../src/companion/views.js';
import { COMPANION_PROTO, ConvView, SINCE } from '../src/companion/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import type { Sentinel } from '../src/core/sentinel/model.js';
import { scheduleSpent, schedulesSummary } from '../packages/companion/lib/schedules.js';

/** A chat's schedules on the phone (BLG-401): its conversation lists them with Run now and pause; no create or edit. */

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const NEXT = new Date(2026, 10, 13, 9, 0).getTime();

const sentinel = (id: string, to: string, paused = false): Sentinel =>
  ({
    id,
    name: id === 's1' ? 'Morning status' : 'Other',
    icon: 'calendar',
    trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' },
    steps: [{ id: 'c', kind: 'chat', name: 'Wake', to, text: 'Send XYZ' }],
    access: 'look',
    limits: {},
    notify: 'mac',
    paused,
    failures: 0,
    createdAt: 1,
    updatedAt: 1,
  }) as never;

function storeWith(experiments: string[] = []) {
  const store = new Store({ ...initialState('room', 'auto'), selfId: ME });
  store.dispatch({ type: 'prefs', prefs: { experiments } });
  store.dispatch({ type: 'sentinel_put', item: sentinel('s1', `${ME}/ws:w1`), nextAt: NEXT });
  store.dispatch({ type: 'sentinel_put', item: sentinel('s2', `${ME}/ws:w2`, true) });
  return store;
}

const view = (store: Store, channel = 'ws:w1') => convView(store.getState(), { macName: 'Mac' } as never, `conv:${channel}` as never);

describe('a chat’s schedules on the phone', () => {
  it('is an additive minor', () => {
    expect(SINCE.chatSchedules).toBeLessThanOrEqual(COMPANION_PROTO.minor);
    expect(COMPANION_PROTO.major).toBe(1);
  });

  it('lists only the sentinels that wake this chat, with their sentence and next time', () => {
    const v = view(storeWith());
    expect(v.schedules).toEqual([{ id: 's1', name: 'Morning status', sentence: 'Every day at 9:00', nextAt: NEXT, paused: false, running: false }]);
    expect(ConvView.safeParse(v).success).toBe(true);
    expect(view(storeWith(), 'ws:w2').schedules).toEqual([{ id: 's2', name: 'Other', sentence: 'Every day at 9:00', paused: true, running: false }]);
  });

  it('none: the field is left out', () => {
    expect(view(storeWith(), 'ws:w9')).not.toHaveProperty('schedules');
  });

  it('an old Beluga’s off mark for the experiment hides nothing', () => {
    expect(view(storeWith(['-chat-schedules'])).schedules).toHaveLength(1);
  });

  it('a one-time schedule that already ran is done, and the summary doesn’t count it as on', () => {
    const row = { id: 's', name: 'S', sentence: 'Once, Thu 12 Nov 14:00', paused: false, running: false };
    expect(scheduleSpent(row)).toBe(true);
    expect(scheduleSpent({ ...row, nextAt: NEXT })).toBe(false);
    expect(scheduleSpent({ ...row, paused: true })).toBe(false);
    expect(scheduleSpent({ ...row, running: true })).toBe(false);
    const on = { ...row, id: 't', nextAt: NEXT };
    expect(schedulesSummary([on])).toBe('1 schedule');
    expect(schedulesSummary([row, on])).toBe('2 schedules · 1 on');
    expect(schedulesSummary([row])).toBe('1 schedule · 0 on');
    expect(schedulesSummary(undefined)).toBe('');
  });

  it('the phone may run and pause them, and never create or edit one', () => {
    expect(phoneMay('sentinel.run')).toBe(true);
    expect(phoneMay('sentinel.pause')).toBe(true);
    expect(phoneMay('sentinel.forChat')).toBe(true);
    expect(phoneMay('sentinel.create')).toBe(false);
    expect(phoneMay('sentinel.update')).toBe(false);
  });
});
