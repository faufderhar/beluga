import { afterEach, describe, expect, it, vi } from 'vitest';
import { brief, setup, until } from './sentinel-fakes.js';

/** Limits (docs/sentinel.md §1, "Limits"): time, runs per day, pausing after failures, one run at a time, Run at Once, the clock. */

const ask = (prompt = 'go') => ({ kind: 'claude' as const, where: 'project' as const, prompt });
const failing = async () => ({ exitCode: 2, output: 'boom', truncated: false, timedOut: false, ms: 5 });

afterEach(() => void vi.useRealTimers());

describe('the time limit', () => {
  it('cancels a Claude step still going, and the run fails as timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = setup();
    const made = s.sentinels.create({ name: 'Slow', projectId: 'api', limits: { minutes: 10 }, steps: [ask()] });
    const run = s.sentinels.start(made.id, 'you');
    await vi.advanceTimersByTimeAsync(10);
    expect(s.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.cancelled).toEqual([[s.asked[0]!.requestId, 'Stopped by Beluga: the sentinel’s time limit']]);
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'timed out', headline: 'Timed out after 10 min' });
  });
});

describe('stopping a run', () => {
  it('cancels its Claude and ends as stopped', async () => {
    const s = setup();
    const run = s.sentinels.start(s.sentinels.create(brief).id, 'you');
    await until(() => s.asked.length === 1);
    expect(s.sentinels.stop(run.id)).toBe(true);
    await until(() => s.sentinels.runGet(run.id).run.state === 'stopped');
    expect(s.cancelled[0]![1]).toMatch(/^Stopped by you/);
    expect(s.sentinels.runGet(run.id).run.headline).toBe('Stopped by you');
    expect(s.sentinels.stop('run_nope')).toBe(false);
  });
});

describe('one run at a time', () => {
  it('a run asked for while one goes waits, once; it starts when the first ends', async () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    const first = s.sentinels.start(made.id, 'you');
    const second = s.sentinels.start(made.id, 'you');
    const third = s.sentinels.start(made.id, 'you');
    expect(second.state).toBe('queued');
    expect(third.id).toBe(second.id);
    await until(() => s.asked.length === 1);
    s.asked[0]!.answer('First');
    await until(() => s.asked.length === 2);
    expect(s.sentinels.runGet(first.id).run.state).toBe('done');
    expect(s.sentinels.runGet(second.id).run.state).toBe('running');
    s.asked[1]!.answer('Second');
    await until(() => s.sentinels.runGet(second.id).run.state === 'done');
    expect(s.sentinels.runsOf(made.id).map((r) => r.headline)).toEqual(['Second', 'First']);
  });

  it('a waiting run can be stopped before it starts', async () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    s.sentinels.start(made.id, 'you');
    const second = s.sentinels.start(made.id, 'you');
    expect(s.sentinels.stop(second.id)).toBe(true);
    expect(s.sentinels.runGet(second.id).run).toMatchObject({ state: 'stopped', headline: 'Stopped by you before it started' });
  });
});

describe('Run at Once', () => {
  it('at most that many Claude steps run together across sentinels', async () => {
    const s = setup();
    s.sentinels.setRunAtOnce(1);
    expect(s.store.getState().sentinel.runAtOnce).toBe(1);
    const a = s.sentinels.create({ name: 'A', projectId: 'api', steps: [ask('a')] });
    const b = s.sentinels.create({ name: 'B', projectId: 'api', steps: [ask('b')] });
    s.sentinels.start(a.id, 'you');
    const rb = s.sentinels.start(b.id, 'you');
    await until(() => s.asked.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.asked).toHaveLength(1);
    expect(s.sentinels.runGet(rb.id).run.state).toBe('running');
    s.asked[0]!.answer('A done');
    await until(() => s.asked.length === 2);
    expect(s.asked[1]!.prompt).toBe('b');
  });
});

describe('runs per day', () => {
  it('over it, a run is skipped with a line in its history; Run Now still runs', async () => {
    const s = setup({ shell: async () => ({ exitCode: 0, output: 'fine', truncated: false, timedOut: false, ms: 5 }) });
    const made = s.sentinels.create({ name: 'Once', limits: { perDay: 1 }, steps: [{ kind: 'script', command: 'true', cwd: 'home', timeoutSec: 5 }] });
    s.sentinels.pause(made.id, false);
    const first = s.sentinels.start(made.id, 'schedule');
    await until(() => s.sentinels.runGet(first.id).run.state === 'done');
    const second = s.sentinels.start(made.id, 'schedule');
    expect(second).toMatchObject({ state: 'skipped', headline: 'Skipped: it ran 1 time today already' });
    const yours = s.sentinels.start(made.id, 'you');
    expect(yours.state).toBe('running');
  });
});

describe('pausing after failures', () => {
  it('three failures in a row pause it, with why and a notification', async () => {
    const s = setup({ shell: failing });
    const made = s.sentinels.create({ name: 'Nightly', projectId: 'api', steps: [{ kind: 'script', command: 'npm test', cwd: 'project', timeoutSec: 5 }] });
    s.sentinels.pause(made.id, false);
    for (let i = 0; i < 3; i++) {
      const run = s.sentinels.start(made.id, 'schedule');
      await until(() => s.sentinels.runGet(run.id).run.state === 'failed');
      await until(() => s.sentinels.need(made.id).failures === i + 1);
    }
    const now = s.sentinels.need(made.id);
    expect(now).toMatchObject({ paused: true, pausedWhy: 'Paused after 3 failures in a row', failures: 3 });
    expect(s.notices.at(-1)).toMatchObject({ kind: 'problems', tag: 'sentinel', title: 'Nightly is paused after 3 failures' });
    expect(s.notices.filter((n) => n.title === 'Nightly failed')).toHaveLength(2);
    expect(() => s.sentinels.start(made.id, 'schedule')).toThrow('is paused');
    // Resume: on again, from zero.
    expect(s.sentinels.pause(made.id, false)).toMatchObject({ paused: false, failures: 0 });
    expect(s.sentinels.need(made.id).pausedWhy).toBeUndefined();
  });

  it('a run that works sets the count back', async () => {
    let fail = true;
    const s = setup({ shell: async () => ({ exitCode: fail ? 1 : 0, output: '', truncated: false, timedOut: false, ms: 5 }) });
    const made = s.sentinels.create({ name: 'Flaky', steps: [{ kind: 'script', command: 'x', cwd: 'home', timeoutSec: 5 }] });
    const r1 = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.need(made.id).failures === 1);
    void r1;
    fail = false;
    s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.need(made.id).failures === 0);
  });
});

describe('paused sentinels', () => {
  it('start paused; only you can run one', () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    expect(made.paused).toBe(true);
    expect(() => s.sentinels.start(made.id, 'claude')).toThrow('“Morning brief” is paused: turn it on first');
    expect(s.sentinels.start(made.id, 'you').state).toBe('running');
  });
});

describe('the clock', () => {
  it('starts a schedule when it’s due, once; a long sleep is caught up once', async () => {
    let now = new Date(2026, 9, 26, 6, 0).getTime();
    const s = setup({ now: () => now, reply: () => 'Brief' });
    const made = s.sentinels.create(brief);
    s.sentinels.pause(made.id, false);
    expect(s.store.getState().sentinel.nextAt[made.id]).toBe(new Date(2026, 9, 26, 7, 0).getTime());
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(0);
    now = new Date(2026, 9, 26, 7, 0, 10).getTime();
    s.sentinels.tick();
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(1);
    expect(s.sentinels.runsOf(made.id)[0]).toMatchObject({ by: 'schedule', trigger: { kind: 'schedule', summary: 'Every day at 7:00' } });
    await until(() => s.sentinels.runsOf(made.id)[0]!.state === 'done');
    expect(s.store.getState().sentinel.nextAt[made.id]).toBe(new Date(2026, 9, 27, 7, 0).getTime());
    // The Mac sleeps three days.
    now = new Date(2026, 9, 29, 12, 0).getTime();
    s.sentinels.tick();
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(2);
    expect(s.sentinels.runsOf(made.id)[0]!.trigger.summary).toBe('Every day at 7:00 (caught up: the Mac was asleep or Beluga was closed)');
  });

  it('a schedule that skips missed slots says so in its history', () => {
    let now = new Date(2026, 9, 26, 6, 0).getTime();
    const s = setup({ now: () => now });
    const made = s.sentinels.create({ ...brief, trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' } });
    s.sentinels.pause(made.id, false);
    now = new Date(2026, 9, 27, 9, 0).getTime();
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id).map((r) => [r.state, r.headline])).toEqual([['skipped', 'Skipped: the Mac was asleep or Beluga was closed']]);
    expect(s.asked).toEqual([]);
  });

  it('every 15 minutes: on the clock, and a night asleep is caught up once', async () => {
    let now = new Date(2026, 9, 26, 9, 7).getTime();
    const s = setup({ now: () => now, reply: () => 'Stars' });
    const made = s.sentinels.create({ ...brief, trigger: { kind: 'schedule', every: 'minutes', minutes: 15, at: '07:00', missed: 'catch-up' } });
    s.sentinels.pause(made.id, false);
    expect(s.store.getState().sentinel.nextAt[made.id]).toBe(new Date(2026, 9, 26, 9, 15).getTime());
    now = new Date(2026, 9, 26, 9, 15, 10).getTime();
    s.sentinels.tick();
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(1);
    expect(s.sentinels.runsOf(made.id)[0]!.trigger.summary).toBe('Every 15 minutes');
    await until(() => s.sentinels.runsOf(made.id)[0]!.state === 'done');
    expect(s.store.getState().sentinel.nextAt[made.id]).toBe(new Date(2026, 9, 26, 9, 30).getTime());
    // Asleep all night: dozens of slots passed, one run.
    now = new Date(2026, 9, 27, 7, 40).getTime();
    s.sentinels.tick();
    s.sentinels.tick();
    expect(s.sentinels.runsOf(made.id)).toHaveLength(2);
    expect(s.sentinels.runsOf(made.id)[0]!.trigger.summary).toBe('Every 15 minutes (caught up: the Mac was asleep or Beluga was closed)');
    await until(() => s.sentinels.runsOf(made.id)[0]!.state === 'done');
    expect(s.store.getState().sentinel.nextAt[made.id]).toBe(new Date(2026, 9, 27, 7, 45).getTime());
  });

  it('every few minutes keeps to its runs per day', async () => {
    let now = new Date(2026, 9, 26, 9, 0, 10).getTime();
    const s = setup({ now: () => now, reply: () => 'Stars' });
    const made = s.sentinels.create({ ...brief, limits: { minutes: 10, perDay: 2 }, trigger: { kind: 'schedule', every: 'minutes', minutes: 5, at: '00:00', missed: 'catch-up' } });
    s.sentinels.pause(made.id, false);
    for (let i = 1; i <= 3; i++) {
      now = new Date(2026, 9, 26, 9, 5 * i, 10).getTime();
      s.sentinels.tick();
      await until(() => s.sentinels.runsOf(made.id).length === i && s.sentinels.runsOf(made.id)[0]!.state !== 'running');
    }
    expect(s.sentinels.runsOf(made.id).map((r) => r.state)).toEqual(['skipped', 'done', 'done']);
    expect(s.sentinels.runsOf(made.id)[0]!.headline).toBe('Skipped: it ran 2 times today already');
  });

  it('paused and by-hand sentinels never start on their own', () => {
    let now = new Date(2026, 9, 26, 6, 0).getTime();
    const s = setup({ now: () => now });
    s.sentinels.create(brief);
    const manual = s.sentinels.create({ name: 'Hand', trigger: { kind: 'manual' } });
    s.sentinels.pause(manual.id, false);
    now += 3 * 24 * 3600_000;
    s.sentinels.tick();
    expect(s.store.getState().sentinel.runs).toEqual([]);
  });
});
