import { describe, expect, it } from 'vitest';
import { SentinelDraftSchema } from '../src/core/sentinel/schema.js';
import type { ChatSchedule } from '../src/core/sentinel/model.js';
import { canSchedule, isoLocal, nextWholeHour, onceAhead, onceIn, presetHint, presetLabel, presetRepeats, presetTrigger, scheduleCommand, scheduleDraft, scheduleMark, scheduleName, schedulePresets, scheduleSpent, whenWords } from '../packages/mac/src/chat/schedule-model.js';

/** The /schedule sheet's model (BLG-400): 'in N hours', the name, and the sentinel it makes. */

const NOW = new Date(2026, 10, 12, 14, 30, 15).getTime();
const REF = 'me-me-me-me-me-me-me-me-me-me-me0/ws:w1';

describe('onceIn', () => {
  it('is a once trigger at now + N hours, up to the next minute, with the local offset', () => {
    const t = onceIn(5, NOW);
    expect(t.kind).toBe('once');
    expect(new Date(t.at).getTime()).toBe(new Date(2026, 10, 12, 19, 31).getTime());
    expect(t.at).toMatch(/^2026-11-12T19:31:00[+-]\d\d:\d\d$/);
  });

  it('a fraction of an hour works too', () => {
    expect(new Date(onceIn(0.5, NOW).at).getTime()).toBe(new Date(2026, 10, 12, 15, 1).getTime());
  });

  it('a tiny N is still at least a minute ahead, never in the past', () => {
    const at = new Date(onceIn(0.001, NOW).at).getTime();
    expect(at).toBeGreaterThanOrEqual(NOW + 60_000);
    expect(at).toBe(new Date(2026, 10, 12, 14, 32).getTime());
  });
});

describe('a Once moment', () => {
  it('starts at the next whole local hour', () => {
    expect(nextWholeHour(NOW)).toBe(new Date(2026, 10, 12, 15, 0).getTime());
    expect(nextWholeHour(new Date(2026, 10, 12, 14, 0).getTime())).toBe(new Date(2026, 10, 12, 15, 0).getTime());
  });

  it('can be scheduled only while it is ahead', () => {
    expect(onceAhead({ kind: 'once', at: isoLocal(NOW + 60_000), missed: 'catch-up' }, NOW)).toBe(true);
    expect(onceAhead({ kind: 'once', at: isoLocal(NOW - 60_000), missed: 'catch-up' }, NOW)).toBe(false);
    expect(onceAhead({ kind: 'once', at: 'not a date', missed: 'catch-up' }, NOW)).toBe(false);
  });
});

describe('isoLocal', () => {
  it('writes a local moment with its offset, which parses back to the same time', () => {
    const at = new Date(2026, 0, 3, 7, 5).getTime();
    expect(new Date(isoLocal(at)).getTime()).toBe(at);
    expect(isoLocal(at)).toMatch(/^2026-01-03T07:05:00[+-]\d\d:\d\d$/);
  });
});

describe('scheduleName', () => {
  it('is the prompt’s first line, cut short', () => {
    expect(scheduleName('Send the status\nand more')).toBe('Send the status');
    expect(scheduleName('x'.repeat(80))).toBe(`${'x'.repeat(47)}…`);
    expect(scheduleName('   ')).toBe('Chat schedule');
  });
});

describe('scheduleDraft', () => {
  it('makes a sentinel with that trigger and one chat step to this chat, in its project', () => {
    const trigger = { kind: 'schedule' as const, every: 'day' as const, at: '09:00', missed: 'skip' as const };
    const draft = scheduleDraft({ trigger, prompt: 'Send XYZ', ref: REF, projectId: 'api' });
    expect(draft).toEqual({ name: 'Send XYZ', icon: 'calendar', projectId: 'api', trigger, steps: [{ kind: 'chat', name: 'Wake this chat', to: REF, text: 'Send XYZ' }] });
    expect(SentinelDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('a Your Mac chat has no project', () => {
    const draft = scheduleDraft({ trigger: onceIn(1, NOW), prompt: 'Hi', ref: REF });
    expect(draft).not.toHaveProperty('projectId');
    expect(SentinelDraftSchema.safeParse(draft).success).toBe(true);
  });
});

describe('/schedule', () => {
  it('takes the prompt after the command', () => {
    expect(scheduleCommand('/schedule')).toBe('');
    expect(scheduleCommand('/schedule  Send XYZ\nplease ')).toBe('Send XYZ\nplease');
    expect(scheduleCommand('/schedules')).toBeUndefined();
    expect(scheduleCommand('schedule this')).toBeUndefined();
  });

  it('works in your worktree, project and Your Mac chats only', () => {
    expect(canSchedule('ws:w1', false)).toBe(true);
    expect(canSchedule('mac:assistant', false)).toBe(true);
    expect(canSchedule('mac:assistant:abc1', false)).toBe(true);
    expect(canSchedule('ws:w1', true)).toBe(false);
    expect(canSchedule('room', false)).toBe(false);
    expect(canSchedule('dm:bob', false)).toBe(false);
  });

  it('not in a chat Beluga made for itself (a sentinel run’s Your Mac chat)', () => {
    const chats = [
      { id: 'abc1', auto: true as const },
      { id: 'mine1' },
    ];
    expect(canSchedule('mac:assistant:abc1', false, chats)).toBe(false);
    expect(canSchedule('mac:assistant:mine1', false, chats)).toBe(true);
    expect(canSchedule('mac:assistant', false, chats)).toBe(true);
  });
});

describe('a one-time schedule that already ran', () => {
  const row = (over: Partial<ChatSchedule>): ChatSchedule => ({ id: 's', name: 'S', icon: 'calendar', trigger: { kind: 'once', at: isoLocal(NOW), missed: 'catch-up' }, paused: false, prompt: 'Hi', running: false, ...over });
  const daily = { kind: 'schedule' as const, every: 'day' as const, at: '09:00', missed: 'skip' as const };

  it('is spent: a once trigger, on, with no next time and no run going', () => {
    expect(scheduleSpent(row({}))).toBe(true);
    expect(scheduleSpent(row({ nextAt: NOW + 1 }))).toBe(false);
    expect(scheduleSpent(row({ running: true }))).toBe(false);
    expect(scheduleSpent(row({ paused: true }))).toBe(false);
    expect(scheduleSpent(row({ trigger: daily }))).toBe(false);
  });

  it('the sidebar’s clock reads it as off', () => {
    expect(scheduleMark([])).toBeUndefined();
    expect(scheduleMark([row({})])).toEqual({ count: 1, paused: true });
    expect(scheduleMark([row({}), row({ id: 't', trigger: daily, nextAt: NOW + 1 })])).toEqual({ count: 2, paused: false });
    expect(scheduleMark([row({}), row({ id: 't', paused: true })])).toEqual({ count: 2, paused: true });
  });
});

/** The message box's Schedule mode (BLG-1023): its When presets, worked out from now (Thu 12 Nov, 14:30). */
describe('schedule presets', () => {
  const at = (t: { kind: string; at: string }) => new Date(t.at).getTime();

  it('offers This evening only before 5 PM', () => {
    expect(schedulePresets(NOW)).toContain('evening');
    expect(schedulePresets(new Date(2026, 10, 12, 17, 5).getTime())).not.toContain('evening');
  });

  it('once: in an hour, this evening at 18:00, tomorrow at 9:00, each a moment that runs if the Mac slept', () => {
    expect(at(presetTrigger('in-1h', NOW))).toBe(new Date(2026, 10, 12, 15, 31).getTime());
    expect(at(presetTrigger('evening', NOW))).toBe(new Date(2026, 10, 12, 18, 0).getTime());
    expect(presetTrigger('tomorrow', NOW)).toMatchObject({ kind: 'once', missed: 'catch-up' });
    expect(at(presetTrigger('tomorrow', NOW))).toBe(new Date(2026, 10, 13, 9, 0).getTime());
  });

  it('repeating: every morning, every weekday, every week on today', () => {
    expect(presetTrigger('daily', NOW)).toEqual({ kind: 'schedule', every: 'day', at: '09:00', missed: 'catch-up' });
    expect(presetTrigger('weekdays', NOW)).toMatchObject({ every: 'week', days: [1, 2, 3, 4, 5] });
    expect(presetTrigger('weekly', NOW)).toMatchObject({ every: 'week', days: [4] });
    expect(presetLabel('weekly', NOW)).toBe('Every Thursday');
    expect(['in-1h', 'tomorrow', 'daily', 'weekly'].map((p) => presetRepeats(p as never))).toEqual([false, false, true, true]);
  });

  it('says when in words, for the banner and the toast', () => {
    expect(whenWords(presetTrigger('in-1h', NOW), NOW)).toBe('today at 15:31');
    expect(whenWords(presetTrigger('tomorrow', NOW), NOW)).toBe('tomorrow at 9:00');
    expect(whenWords(presetTrigger('daily', NOW), NOW)).toBe('every day at 9:00');
    expect(whenWords(presetTrigger('weekdays', NOW), NOW)).toBe('every weekday at 9:00');
    expect(whenWords({ kind: 'once', at: isoLocal(new Date(2026, 10, 20, 9, 0).getTime()), missed: 'catch-up' }, NOW)).toMatch(/^on Fri 20 Nov at 9:00$/);
  });

  it('each preset makes a sentinel the daemon takes', () => {
    for (const p of schedulePresets(NOW)) {
      expect(SentinelDraftSchema.safeParse(scheduleDraft({ trigger: presetTrigger(p, NOW), prompt: 'Send XYZ', ref: REF })).success).toBe(true);
      expect(presetHint(p, NOW)).toMatch(/\d:\d\d$/);
    }
  });
});
