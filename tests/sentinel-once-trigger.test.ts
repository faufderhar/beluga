import { describe, expect, it } from 'vitest';
import { createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import { LATE_MS, dueNow, nextRunAt } from '../src/core/sentinel/clock.js';
import { type OnceTrigger, scheduleSentence } from '../src/core/sentinel/model.js';
import { SentinelDraftSchema } from '../src/core/sentinel/schema.js';
import { ToolDraftSchema } from '../src/core/sentinel/tool-draft.js';
import { setup } from './sentinel-fakes.js';

/** A one-time trigger ('in 5 hours'): it runs once at its moment, then has no next time. */

const AT = '2026-11-12T14:00:00+01:00';
const at = Date.parse(AT);
const once = (missed: OnceTrigger['missed'] = 'catch-up'): OnceTrigger => ({ kind: 'once', at: AT, missed });
const notify = { kind: 'notify' as const, name: 'Tell me', phone: false };
type Handler = (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe('the clock, for a one-time trigger', () => {
  it('runs at its moment before it ran, and never after', () => {
    const turnedOn = at - 5 * 3600_000;
    expect(nextRunAt(once(), turnedOn, turnedOn)).toBe(at);
    expect(dueNow(once(), turnedOn, at - 1000)).toEqual({ kind: 'wait', at });
    expect(dueNow(once(), turnedOn, at + 1000)).toEqual({ kind: 'run', slot: at, late: false, missed: 1 });
    expect(nextRunAt(once(), at, at + 1000)).toBeUndefined();
    expect(dueNow(once(), at, at + 3600_000)).toEqual({ kind: 'wait' });
  });

  it('turned on after its moment: no next time', () => {
    expect(nextRunAt(once(), at + 1000, at + 1000)).toBeUndefined();
  });

  it('missed while the Mac slept: catch-up runs it when the Mac is back', () => {
    expect(dueNow(once('catch-up'), at - 3600_000, at + LATE_MS + 60_000)).toEqual({ kind: 'run', slot: at, late: true, missed: 1 });
  });

  it('missed while the Mac slept: skip runs nothing', () => {
    expect(dueNow(once('skip'), at - 3600_000, at + LATE_MS + 60_000)).toEqual({ kind: 'skip', slot: at, missed: 1 });
  });
});

describe('a sentinel with a one-time trigger', () => {
  it('runs once on the tick, then stays with no next time', () => {
    let now = at - 3600_000;
    const s = setup({ now: () => now });
    const made = s.sentinels.create({ name: 'Later', trigger: once(), steps: [notify] });
    s.sentinels.pause(made.id, false);
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(0);
    now = at + 1000;
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(1);
    now = at + 3600_000;
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(1);
    expect(s.sentinels.get(made.id)).toBeDefined();
    expect(s.sentinels.state().nextAt[made.id]).toBeUndefined();
  });

  it('a missed one set to skip runs nothing and stays', () => {
    let now = at - 3600_000;
    const s = setup({ now: () => now });
    const made = s.sentinels.create({ name: 'Later', trigger: once('skip'), steps: [notify] });
    s.sentinels.pause(made.id, false);
    now = at + LATE_MS + 60_000;
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id).filter((r) => r.state !== 'skipped')).toHaveLength(0);
    expect(s.sentinels.get(made.id)).toBeDefined();
  });
});

describe('a moment in the past', () => {
  it('is refused at create and at update', () => {
    const s = setup({ now: () => at + 1000 });
    expect(() => s.sentinels.create({ name: 'Late', trigger: once(), steps: [notify] })).toThrow(/That moment has passed/);
    const made = s.sentinels.create({ name: 'Manual', steps: [notify] });
    expect(() => s.sentinels.update(made.id, { trigger: once() })).toThrow(/That moment has passed/);
  });

  it('is refused by sentinel_create', async () => {
    const s = setup({ now: () => at + 1000 });
    const defs = createSentinelToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.tools);
    const res = await (defs.find((d) => d.name === 'sentinel_create')!.handler as Handler)({ name: 'Late', trigger: { kind: 'once', at: AT, missed: 'skip' }, steps: [notify] }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/That moment has passed/);
  });

  it('the schemas take an ISO time with its offset, and nothing else', () => {
    expect(ToolDraftSchema.safeParse({ name: 'X', trigger: { kind: 'once', at: AT, missed: 'skip' }, steps: [notify] }).success).toBe(true);
    expect(ToolDraftSchema.safeParse({ name: 'X', trigger: { kind: 'once', at: 'tomorrow', missed: 'skip' }, steps: [notify] }).success).toBe(false);
    expect(SentinelDraftSchema.parse({ name: 'X', trigger: { kind: 'once', at: AT } }).trigger).toEqual(once());
  });
});

describe('turning on and changing a one-time trigger', () => {
  it('turning one on after its moment is refused (it would never run)', () => {
    let now = at - 3600_000;
    const s = setup({ now: () => now });
    const made = s.sentinels.create({ name: 'Later', trigger: once(), steps: [notify] });
    now = at + 1000;
    expect(() => s.sentinels.pause(made.id, false)).toThrow(/That moment has passed/);
    expect(s.sentinels.get(made.id)!.paused).toBe(true);
  });

  it('after it ran, a change of `missed` alone is taken', () => {
    let now = at - 3600_000;
    const s = setup({ now: () => now });
    const made = s.sentinels.create({ name: 'Later', trigger: once(), steps: [notify] });
    now = at + 1000;
    expect(s.sentinels.update(made.id, { trigger: once('skip') }).trigger).toEqual(once('skip'));
    expect(() => s.sentinels.update(made.id, { trigger: { kind: 'once', at: '2026-11-12T13:00:00+01:00', missed: 'skip' } })).toThrow(/That moment has passed/);
  });
});

describe('the sentence', () => {
  it('reads like "Once, Thu 12 Nov 14:00" in local time', () => {
    const local = new Date(2026, 10, 12, 14, 0).toISOString();
    expect(scheduleSentence({ kind: 'once', at: local, missed: 'skip' })).toBe('Once, Thu 12 Nov 14:00');
  });
});
