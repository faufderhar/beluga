import { describe, expect, it } from 'vitest';
import { render } from '../src/core/sentinel/render.js';
import { NO_SENTINEL, type RunSummary, type Sentinel, accessAllows, firstLine, frequentAgentNote, reduceSentinel, scheduleSentence, sentinelOwnerOf, slugOf, stepRefusal, stepSentence } from '../src/core/sentinel/model.js';

/** Templates, the sentences every screen shows, and the state slice. */

const ctx = {
  trigger: { kind: 'schedule', summary: 'Every day at 7:00', payload: { n: 1 } },
  previous: 'the last output',
  steps: { 'Read what changed': 'three commits', Tests: 'all green' },
  project: { name: 'bob-api', path: '/code/bob-api' },
  date: 'Mon 26 Oct 2026',
  sentinel: 'Morning brief',
  tasks: 'BOB-1 · Todo · Fix login',
  worktrees: 'bob-api/add-auth',
  plans: 'Payments launch · active',
};

describe('render', () => {
  it('fills every template', () => {
    expect(render('{{sentinel}} on {{date}} for {{project}} ({{project.path}}): {{trigger}}', ctx)).toBe('Morning brief on Mon 26 Oct 2026 for bob-api (/code/bob-api): Every day at 7:00');
    expect(render('{{trigger.json}}', ctx)).toBe('{\n  "n": 1\n}');
    expect(render('before: {{ previous }}', ctx)).toBe('before: the last output');
    expect(render('{{steps.Read what changed}} / {{steps.tests}}', ctx)).toBe('three commits / all green');
    expect(render('{{tasks}}\n{{worktrees}}\n{{plans}}', ctx)).toBe('BOB-1 · Todo · Fix login\nbob-api/add-auth\nPayments launch · active');
  });

  it('leaves unknown ones as written', () => {
    expect(render('{{query}} and {{steps.Nope}} and {{ unknown.thing }}', ctx)).toBe('{{query}} and {{steps.Nope}} and {{ unknown.thing }}');
  });

  it('on Your Mac, and with nothing before', () => {
    const mac = { trigger: { kind: 'manual', summary: 'You pressed Run' }, date: 'today', sentinel: 'Disk' };
    expect(render('{{project}} {{project.path}} [{{previous}}] {{trigger.json}}', mac)).toBe('Your Mac ~ [] {\n  "kind": "manual",\n  "summary": "You pressed Run"\n}');
  });
});

describe('sentences', () => {
  it('says when a sentinel runs', () => {
    const s = (patch: object) => scheduleSentence({ kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up', ...patch } as never);
    expect(s({})).toBe('Every day at 7:00');
    expect(s({ every: 'other-day', at: '09:00' })).toBe('Every other day at 9:00');
    expect(s({ every: 'week', days: [3, 1] })).toBe('Every week on Mon, Wed at 7:00');
    expect(s({ every: 'week', days: [0, 5] })).toBe('Every week on Fri, Sun at 7:00');
    expect(s({ every: 'week', days: [1, 2, 3, 4, 5] })).toBe('Every weekday at 7:00');
    expect(s({ every: 'month', day: 1, at: '09:00' })).toBe('Every month on the 1st at 9:00');
    expect(s({ every: 'month', day: 22, at: '17:30' })).toBe('Every month on the 22nd at 17:30');
    expect(s({ every: 'hours', hours: 3 })).toBe('Every 3 hours');
    expect(s({ every: 'hours', hours: 1 })).toBe('Every hour');
    expect(s({ every: 'minutes', minutes: 15 })).toBe('Every 15 minutes');
    expect(s({ every: 'minutes', minutes: 5 })).toBe('Every 5 minutes');
    expect(s({ every: 'minutes' })).toBe('Every 30 minutes');
    expect(s({ every: 'minutes', minutes: 1 })).toBe('Every minute');
    expect(scheduleSentence({ kind: 'manual' })).toBe('Only when you press Run');
    expect(scheduleSentence({ kind: 'after', sentinelId: 'sn_1', on: 'failure' }, () => 'Nightly tests')).toBe('After “Nightly tests” fails');
    expect(scheduleSentence({ kind: 'github', what: 'workflow-failed' })).toBe('When a workflow fails on GitHub');
    expect(scheduleSentence({ kind: 'uptime', url: 'https://example.com/health', minutes: 5 })).toBe('When example.com stops answering (checked every 5 minutes), and when it’s back');
  });

  it('says what a step does', () => {
    expect(stepSentence({ id: 'a', name: 'Brief', kind: 'claude', where: 'project', prompt: 'Write my brief\nmore' })).toBe('Agent in the project: “Write my brief”');
    expect(stepSentence({ id: 'b', name: 'Tests', kind: 'script', command: 'npm test', cwd: 'project', timeoutSec: 120 })).toBe('Runs `npm test` in the project');
    expect(stepSentence({ id: 'c', name: 'Tell me', kind: 'notify', phone: true })).toBe('Tells you on the Mac and the phone');
  });

  it('first lines and slugs', () => {
    expect(firstLine('## 4 tasks created, **1 PR** opened\n\nmore')).toBe('4 tasks created, 1 PR opened');
    expect(slugOf('Morning brief!')).toBe('morning-brief');
  });
});

describe('access', () => {
  it('Look reads; Work changes code in a worktree; Ship merges', () => {
    expect(accessAllows('look', 'claude', 'project')).toBe(true);
    expect(accessAllows('look', 'claude', 'worktree')).toBe(false);
    expect(accessAllows('work', 'pr')).toBe(true);
    expect(accessAllows('work', 'merge')).toBe(false);
    expect(accessAllows('ship', 'merge')).toBe(true);
    expect(stepRefusal('look', 'merge')).toBe('Needs Ship access');
    expect(stepRefusal('ship', 'merge')).toBeUndefined();
  });
});

describe('the state slice', () => {
  const item: Sentinel = { id: 'sn_1', name: 'Brief', icon: 'eye', trigger: { kind: 'manual' }, steps: [{ id: 'st_1', name: 'Ask', kind: 'claude', where: 'project', prompt: 'hi' }], access: 'look', limits: { minutes: 30, pauseAfter: 3 }, notify: 'mac', paused: false, failures: 0, createdAt: 1, updatedAt: 1 };
  const run = (id: string, state: RunSummary['state'], extra: Partial<RunSummary> = {}): RunSummary => ({ id, sentinelId: 'sn_1', by: 'you', trigger: { kind: 'manual', summary: 'You pressed Run' }, state, startedAt: 1, headline: '', steps: [{ id: 'st_1', state: state === 'running' ? 'running' : 'done' }], tasks: [], ...extra });

  it('puts, runs (live while going), keeps the last 30, removes', () => {
    let s = reduceSentinel({ sentinel: { ...NO_SENTINEL, enabled: true } }, { type: 'sentinel_put', item, nextAt: 99 });
    expect(s.sentinel.nextAt).toEqual({ sn_1: 99 });
    s = reduceSentinel(s, { type: 'sentinel_put', item: { ...item, paused: true } });
    expect(s.sentinel.nextAt).toEqual({});
    s = reduceSentinel(s, { type: 'sentinel_run', run: run('r1', 'running') });
    expect(s.sentinel.live).toEqual({ r1: { stepId: 'st_1', state: 'running' } });
    s = reduceSentinel(s, { type: 'sentinel_run', run: run('r1', 'done') });
    expect(s.sentinel.live).toEqual({});
    for (let i = 2; i <= 40; i++) s = reduceSentinel(s, { type: 'sentinel_run', run: run(`r${i}`, 'done') });
    expect(s.sentinel.runs).toHaveLength(30);
    expect(s.sentinel.runs[0]!.id).toBe('r11');
    s = reduceSentinel(s, { type: 'sentinel_remove', id: 'sn_1' });
    expect(s.sentinel.items).toEqual([]);
    expect(s.sentinel.runs).toEqual([]);
  });

  it('a worktree a run made belongs to its sentinel', () => {
    const state = { ...NO_SENTINEL, items: [item], runs: [run('r1', 'done', { worktreeId: 'w9', channel: 'ws:w9' })] };
    expect(sentinelOwnerOf(state, 'w9')?.id).toBe('sn_1');
    expect(sentinelOwnerOf(state, 'w1')).toBeUndefined();
  });
});

describe('a schedule every few minutes with an agent step', () => {
  const ask = { id: 's1', name: 'Ask', kind: 'claude', where: 'project', prompt: 'go' } as never;
  const keep = { id: 's2', name: 'Keep', kind: 'measure' } as never;
  const at = (minutes: number, perDay?: number, steps = [ask]) => frequentAgentNote({ trigger: { kind: 'schedule', every: 'minutes', minutes: minutes as 5, at: '00:00', missed: 'skip' }, steps, limits: { minutes: 10, pauseAfter: 3, ...(perDay ? { perDay } : {}) } });

  it('says how many times a day it asks the agent', () => {
    expect(at(15)).toMatch(/^Its agent step runs up to 96 times a day, which uses your plan’s limits quickly/);
    expect(at(30)).toMatch(/up to 48 times a day/);
    expect(at(1)).toMatch(/up to 1440 times a day/);
    expect(at(5, 100)).toMatch(/up to 100 times a day \(its runs-per-day limit\)/);
  });

  it('says nothing when runs per day keeps it light, without an agent step, or on a slower schedule', () => {
    expect(at(15, 12)).toBeUndefined();
    expect(at(5, undefined, [keep])).toBeUndefined();
    expect(frequentAgentNote({ trigger: { kind: 'schedule', every: 'hours', hours: 1, at: '00:00', missed: 'skip' }, steps: [ask], limits: { minutes: 10, pauseAfter: 3 } })).toBeUndefined();
  });
});
