import { describe, expect, it } from 'vitest';
import { type ChatTriage, type TriageEvent, type TriageFacts, SETTLE_WORKING_MESSAGE, applyTriage, categoryOf, handRaisedOf, settleRefusal } from '../src/core/triage/model.js';
import { DEFAULT_PREFS, Store, initialState, prefsFrom, reduceDomain } from '../src/core/store.js';
import { Settings } from '../src/shared/settings-schema.js';
import { PrefsPatch } from '../src/ipc/api.js';

const AT = 1_000;
const idle: TriageFacts = { handRaised: false, working: false };
const busy: TriageFacts = { handRaised: false, working: true };
const hand: TriageFacts = { handRaised: true, working: false };

const snoozed: ChatTriage = { snoozed: { at: 500, until: 5_000, seen: [] } };
const settled: ChatTriage = { settled: { at: 500, why: 'you' } };
const snooze: TriageEvent = { kind: 'snooze', at: AT, until: AT + 60_000, seen: [] };

const after = (record: ChatTriage | undefined, event: TriageEvent, facts: TriageFacts = idle) => categoryOf(applyTriage(record, event), facts);

describe('categoryOf', () => {
  it('a raised hand wins over everything', () => {
    expect(categoryOf({ ...snoozed, ...settled }, { handRaised: true, working: true })).toBe('active');
  });
  it('a snooze wins over a settle and over work', () => {
    expect(categoryOf({ ...snoozed, ...settled }, busy)).toBe('snoozed');
  });
  it('a settle wins over work', () => {
    expect(categoryOf(settled, busy)).toBe('settled');
  });
  it('a running turn with no record is working', () => {
    expect(categoryOf(undefined, busy)).toBe('working');
  });
  it('otherwise active', () => {
    expect(categoryOf(undefined, idle)).toBe('active');
    expect(categoryOf({ lastAt: 1 }, idle)).toBe('active');
  });
});

describe('the transition table', () => {
  it('Active, turn starts: Working', () => {
    expect(after(undefined, { kind: 'turn_start', at: AT }, busy)).toBe('working');
  });

  it('Working, turn ends, stops or fails: Active', () => {
    expect(after(undefined, { kind: 'turn_end', at: AT }, idle)).toBe('active');
  });

  it('Working, a hand is raised: Active', () => {
    expect(after(undefined, { kind: 'hand_raised', at: AT }, { handRaised: true, working: true })).toBe('active');
  });

  it('Active, you snooze: Snoozed', () => {
    expect(after(undefined, snooze, idle)).toBe('snoozed');
  });

  it('Working, you snooze: Snoozed, and the agent keeps working', () => {
    expect(after(undefined, snooze, busy)).toBe('snoozed');
  });

  it('Active, you settle: Settled', () => {
    expect(settleRefusal(undefined, idle, 'you')).toBeUndefined();
    expect(applyTriage(undefined, { kind: 'settle', at: AT, why: 'you' }).settled).toEqual({ at: AT, why: 'you' });
    expect(after(undefined, { kind: 'settle', at: AT, why: 'you' })).toBe('settled');
  });

  it('Active, PR merges: Settled with its number', () => {
    const next = applyTriage(undefined, { kind: 'settle', at: AT, why: 'pr_merged', pr: 7 });
    expect(next.settled).toEqual({ at: AT, why: 'pr_merged', pr: 7 });
    expect(next.settledPr).toBe(7);
    expect(categoryOf(next, idle)).toBe('settled');
  });

  it('Active, merge into main here: Settled', () => {
    expect(applyTriage(undefined, { kind: 'settle', at: AT, why: 'merged_here' }).settled?.why).toBe('merged_here');
  });

  it('Active, idle N days: Settled', () => {
    expect(applyTriage({ lastAt: 1 }, { kind: 'settle', at: AT, why: 'idle' }).settled?.why).toBe('idle');
  });

  it('Working, you settle: not allowed', () => {
    expect(settleRefusal(undefined, busy, 'you')).toBe(SETTLE_WORKING_MESSAGE);
  });

  it('Working, PR merges: waits, then Settled when the turn ends', () => {
    expect(settleRefusal(undefined, busy, 'pr_merged')).toBe(SETTLE_WORKING_MESSAGE);
    expect(settleRefusal(undefined, idle, 'pr_merged')).toBeUndefined();
  });

  it('Snoozed, time passes: Active with backAt', () => {
    const next = applyTriage(snoozed, { kind: 'wake', at: AT });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBe(AT);
    expect(categoryOf(next, idle)).toBe('active');
  });

  it('Snoozed, Wake while a turn runs: Working with backAt', () => {
    const next = applyTriage(snoozed, { kind: 'wake', at: AT });
    expect(next.backAt).toBe(AT);
    expect(categoryOf(next, busy)).toBe('working');
  });

  it('Snoozed, hand raised: Active with backAt', () => {
    const next = applyTriage(snoozed, { kind: 'hand_raised', at: AT });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBe(AT);
    expect(categoryOf(next, idle)).toBe('active');
  });

  it('Snoozed, your message: Active or Working, no backAt', () => {
    const next = applyTriage(snoozed, { kind: 'own_message', at: AT });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBeUndefined();
    expect(categoryOf(next, idle)).toBe('active');
    expect(categoryOf(next, busy)).toBe('working');
  });

  it('Snoozed, your answer: Active or Working, no backAt', () => {
    const next = applyTriage(snoozed, { kind: 'answer', at: AT });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBeUndefined();
    expect(categoryOf(next, busy)).toBe('working');
  });

  it('Snoozed, @mention of you: Active with backAt', () => {
    const next = applyTriage(snoozed, { kind: 'mention', at: AT });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBe(AT);
    expect(categoryOf(next, idle)).toBe('active');
  });

  it.each<[string, TriageEvent]>([
    ['agent text', { kind: 'agent_text', at: AT }],
    ['turn ends', { kind: 'turn_end', at: AT }],
    ['a person writes without a mention', { kind: 'person_message', at: AT }],
  ])('Snoozed, %s: stays Snoozed', (_what, event) => {
    expect(after(snoozed, event)).toBe('snoozed');
    expect(applyTriage(snoozed, event).backAt).toBeUndefined();
  });

  it('Snoozed, you settle: Settled, also while a turn runs', () => {
    expect(settleRefusal(snoozed, busy, 'you')).toBeUndefined();
    const next = applyTriage({ ...snoozed, backAt: 1 }, { kind: 'settle', at: AT, why: 'you' });
    expect(next.snoozed).toBeUndefined();
    expect(next.backAt).toBeUndefined();
    expect(categoryOf(next, busy)).toBe('settled');
  });

  it('Snoozed, PR merges: Settled', () => {
    const next = applyTriage(snoozed, { kind: 'settle', at: AT, why: 'pr_merged', pr: 7 });
    expect(next.snoozed).toBeUndefined();
    expect(categoryOf(next, idle)).toBe('settled');
  });

  it('Settled, you un-settle: Active, holdIdle set', () => {
    const next = applyTriage({ ...settled, settledPr: 7 }, { kind: 'unsettle' });
    expect(next.settled).toBeUndefined();
    expect(next.holdIdle).toBe(true);
    expect(next.settledPr).toBe(7);
    expect(categoryOf(next, idle)).toBe('active');
  });

  it('Settled, your message: Working', () => {
    expect(after(settled, { kind: 'own_message', at: AT }, busy)).toBe('working');
  });

  it('Settled, any turn starts: Working', () => {
    expect(after(settled, { kind: 'turn_start', at: AT }, busy)).toBe('working');
  });

  it('Settled, another person writes: Active', () => {
    expect(after(settled, { kind: 'person_message', at: AT })).toBe('active');
  });

  it('Settled, hand raised: Active, and the settle does not come back', () => {
    const next = applyTriage(settled, { kind: 'hand_raised', at: AT });
    expect(next.settled).toBeUndefined();
    expect(next.backAt).toBeUndefined();
    expect(categoryOf(next, idle)).toBe('active');
  });

  it('Settled, system notice: stays Settled, no activity', () => {
    expect(applyTriage(settled, { kind: 'system' })).toBe(settled);
  });

  it('Settled, you snooze: Snoozed', () => {
    const next = applyTriage(settled, snooze);
    expect(next.settled).toBeUndefined();
    expect(categoryOf(next, idle)).toBe('snoozed');
  });
});

describe('activity', () => {
  it.each<TriageEvent>([
    { kind: 'own_message', at: AT },
    { kind: 'answer', at: AT },
    { kind: 'mention', at: AT },
    { kind: 'person_message', at: AT },
    { kind: 'hand_raised', at: AT },
    { kind: 'turn_start', at: AT },
    { kind: 'turn_end', at: AT },
    { kind: 'agent_text', at: AT },
  ])('$kind stores lastAt and clears holdIdle', (event) => {
    const next = applyTriage({ holdIdle: true, lastAt: 1 }, event);
    expect(next.lastAt).toBe(AT);
    expect(next.holdIdle).toBeUndefined();
  });

  it('wake and un-settle on a chat in another state change nothing', () => {
    const record: ChatTriage = { lastAt: 1 };
    expect(applyTriage(record, { kind: 'wake', at: AT })).toBe(record);
    expect(applyTriage(record, { kind: 'unsettle' })).toBe(record);
  });

  it('keeps autoSettle through every change', () => {
    const record: ChatTriage = { autoSettle: false };
    expect(applyTriage(record, snooze).autoSettle).toBe(false);
    expect(applyTriage(record, { kind: 'settle', at: AT, why: 'you' }).autoSettle).toBe(false);
  });
});

describe('handRaisedOf', () => {
  const open = (...openIds: string[]) => ({ openIds, planStuck: false });

  it('any open approval or question raises a hand without a snooze', () => {
    expect(handRaisedOf(undefined, open('q1'))).toBe(true);
    expect(handRaisedOf(settled, open('q1'))).toBe(true);
    expect(handRaisedOf(undefined, open())).toBe(false);
  });

  it('a question open at snooze time does not end the snooze; a new question does', () => {
    const record: ChatTriage = { snoozed: { at: 500, until: 5_000, seen: ['q1'] } };
    expect(handRaisedOf(record, open('q1'))).toBe(false);
    expect(categoryOf(record, { handRaised: handRaisedOf(record, open('q1')), working: false })).toBe('snoozed');
    expect(handRaisedOf(record, open('q1', 'q2'))).toBe(true);
    expect(categoryOf(record, { handRaised: handRaisedOf(record, open('q1', 'q2')), working: false })).toBe('active');
  });

  it('a failed run older than the snooze does not end it; a newer one does', () => {
    expect(handRaisedOf(snoozed, { ...open(), failedAt: 400 })).toBe(false);
    expect(handRaisedOf(snoozed, { ...open(), failedAt: 500 })).toBe(false);
    expect(handRaisedOf(snoozed, { ...open(), failedAt: 600 })).toBe(true);
  });

  it('a failed run raises no hand without a snooze', () => {
    expect(handRaisedOf(undefined, { ...open(), failedAt: 600 })).toBe(false);
    expect(handRaisedOf(settled, { ...open(), failedAt: 600 })).toBe(false);
  });

  it('a stuck plan raises a hand, also through a snooze', () => {
    expect(handRaisedOf(snoozed, { openIds: [], planStuck: true })).toBe(true);
  });
});

describe('settings', () => {
  it('settings without the new keys load with the defaults', () => {
    const s = Settings.parse({ theme: 'light' });
    expect(s.chatCategories).toBe(false);
    expect(s.settleOnMerge).toBe(true);
    expect(s.settleIdleDays).toBe(3);
    expect(DEFAULT_PREFS).toMatchObject({ chatCategories: false, settleOnMerge: true, settleIdleDays: 3 });
  });

  it('an invalid value falls back and other settings stay', () => {
    const s = Settings.parse({ theme: 'light', chatLimit: 50, chatCategories: 'yes', settleOnMerge: 3, settleIdleDays: -1 });
    expect(s).toMatchObject({ theme: 'light', chatLimit: 50, chatCategories: false, settleOnMerge: true, settleIdleDays: 3 });
  });

  it('saved values reach the prefs, and 0 idle days means never', () => {
    const p = prefsFrom(Settings.parse({ chatCategories: true, settleOnMerge: false, settleIdleDays: 0 }));
    expect(p).toMatchObject({ chatCategories: true, settleOnMerge: false, settleIdleDays: 0 });
  });

  it('session.setPrefs accepts the keys and refuses bad values', () => {
    expect(PrefsPatch.parse({ chatCategories: true, settleOnMerge: false, settleIdleDays: 7 })).toEqual({ chatCategories: true, settleOnMerge: false, settleIdleDays: 7 });
    expect(() => PrefsPatch.parse({ settleIdleDays: -1 })).toThrow();
  });

  it('archiveSettledDays: 14 by default, any whole number of days, 0 means never', () => {
    expect(Settings.parse({}).archiveSettledDays).toBe(14);
    expect(DEFAULT_PREFS.archiveSettledDays).toBe(14);
    expect(Settings.parse({ archiveSettledDays: -3 }).archiveSettledDays).toBe(14);
    expect(prefsFrom(Settings.parse({ archiveSettledDays: 45 })).archiveSettledDays).toBe(45);
    expect(PrefsPatch.parse({ archiveSettledDays: 0 })).toEqual({ archiveSettledDays: 0 });
    expect(() => PrefsPatch.parse({ archiveSettledDays: 1.5 })).toThrow();
    expect(() => PrefsPatch.parse({ archiveSettledDays: -1 })).toThrow();
  });
});

describe('the store', () => {
  const state = () => initialState('room');

  it('starts with no records', () => {
    expect(state().triage).toEqual({});
  });

  it('triage_set writes and removes one record', () => {
    const one = reduceDomain(state(), { type: 'triage_set', channel: 'ws:a', record: settled });
    expect(one.triage).toEqual({ 'ws:a': settled });
    const two = reduceDomain(one, { type: 'triage_set', channel: 'ws:b', record: snoozed });
    expect(Object.keys(two.triage)).toEqual(['ws:a', 'ws:b']);
    expect(reduceDomain(two, { type: 'triage_set', channel: 'ws:a' }).triage).toEqual({ 'ws:b': snoozed });
  });

  it('removing a record that is not there changes nothing', () => {
    const s = new Store(state());
    const seen: unknown[] = [];
    s.onAction((a) => seen.push(a));
    s.dispatch({ type: 'triage_set', channel: 'ws:a' });
    expect(seen).toEqual([]);
  });

  it('read clears the unread count of the named channels only', () => {
    const before = { ...state(), unread: { 'ws:a': 2, 'ws:b': 1 } };
    const next = reduceDomain(before, { type: 'triage_set', channel: 'ws:a', record: settled, read: ['ws:a'] });
    expect(next.unread).toEqual({ 'ws:b': 1 });
  });
});

describe('a snapshot from a daemon before triage', () => {
  it('still takes an attention change', () => {
    const { triage: _none, ...older } = initialState('room', 'ask');
    const next = reduceDomain(older as ReturnType<typeof initialState>, { type: 'attention', attention: { ...older.attention, shown: ['ws:w1'] } });
    expect(next.attention.shown).toEqual(['ws:w1']);
  });
});
