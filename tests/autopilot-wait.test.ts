import { describe, expect, it, vi } from 'vitest';
import { autopilotWaitMs } from '../src/core/autopilot/wait.js';
import type { Plan, PlanBody } from '../src/core/plans/model.js';
import { QuestionBroker } from '../src/core/questions.js';
import { Store, initialState } from '../src/core/store.js';
import { AUTOPILOT_WAIT_DEFAULT, autopilotWaitMinutes, autopilotWaitWords } from '../src/shared/autopilot-wait.js';
import { PrefsPatch } from '../src/ipc/api.js';
import { Settings } from '../src/shared/settings-schema.js';

/** BLG-998: only work on Autopilot carries on without your answer, after the wait you chose; the rest waits for you. */

const MIN = 60_000;
const body = (autonomy?: 'step' | 'gated' | 'autopilot'): PlanBody => ({ title: 'T', goal: 'G', milestones: [{ id: 'm1', title: 'M1', tasks: [], ...(autonomy ? { autonomy } : {}) }], decisions: [] }) as unknown as PlanBody;
const plan = (patch: Partial<Plan> = {}): Plan =>
  ({ id: 'p', projectId: 'x', home: 'ws:home', status: 'active', draftRev: 1, autonomy: 'autopilot', maxParallel: 2, testsAt: 'milestone', paused: false, body: body(), runs: { m1: { agent: { worktree: 'w1', at: 0, tasks: [] }, checker: 'chk' } }, review: { rev: 1, at: 0, state: 'done', findings: [], chat: 'rev' }, activity: [], createdAt: 0, updatedAt: 0, ...patch }) as Plan;
const state = (plans: Plan[], autopilotWait = AUTOPILOT_WAIT_DEFAULT, autopilot: Record<string, boolean> = {}) =>
  ({ plans: { enabled: true, plans, style: '' }, board: { enabled: true, issues: [{ id: 'i1', plan: { id: 'p', milestone: 'm1', task: 't' }, worktrees: ['tw'] }], projects: {}, autoTasks: false }, autopilot, prefs: { autopilotWait } }) as never;
const CHANNELS = ['ws:home', 'ws:w1', 'ws:chk', 'ws:rev', 'ws:tw'];

describe('which conversations give up on you', () => {
  it('a plan on Autopilot: its own conversation, review, milestone worktrees, checkers and tasks, after the chosen wait', () => {
    for (const c of CHANNELS) expect(autopilotWaitMs(state([plan()]), c)).toBe(5 * MIN);
    for (const c of CHANNELS) expect(autopilotWaitMs(state([plan()], 30), c)).toBe(30 * MIN);
  });

  it('Step by Step and Check-ins wait for you', () => {
    for (const autonomy of ['step', 'gated'] as const) for (const c of CHANNELS) expect(autopilotWaitMs(state([plan({ autonomy })]), c)).toBeUndefined();
  });

  it('a milestone keeps its own autonomy; the plan’s conversation follows the plan', () => {
    const checkIns = state([plan({ autonomy: 'autopilot', body: body('gated') })]);
    for (const c of ['ws:w1', 'ws:chk', 'ws:tw']) expect(autopilotWaitMs(checkIns, c)).toBeUndefined();
    expect(autopilotWaitMs(checkIns, 'ws:home')).toBe(5 * MIN);
    const autopilotMilestone = state([plan({ autonomy: 'gated', body: body('autopilot') })]);
    for (const c of ['ws:w1', 'ws:chk', 'ws:tw']) expect(autopilotWaitMs(autopilotMilestone, c)).toBe(5 * MIN);
    expect(autopilotWaitMs(autopilotMilestone, 'ws:home')).toBeUndefined();
  });

  it('never a chat outside a plan, Full Autopilot (its stand-in answers), a finished plan, or with “Until you answer”', () => {
    expect(autopilotWaitMs(state([plan()]), 'ws:other')).toBeUndefined();
    expect(autopilotWaitMs(state([plan({ fullAuto: true })]), 'ws:home')).toBeUndefined();
    expect(autopilotWaitMs(state([], 5, { 'ws:chat': true }), 'ws:chat')).toBeUndefined();
    expect(autopilotWaitMs(state([plan({ status: 'done' })]), 'ws:home')).toBeUndefined();
    for (const c of CHANNELS) expect(autopilotWaitMs(state([plan()], 0), c)).toBeUndefined();
  });
});

describe('the broker', () => {
  it('skips your own question after the wait it is given, and keeps one without a wait', async () => {
    vi.useFakeTimers();
    try {
      const store = new Store(initialState('r'));
      const toasts: string[] = [];
      const broker = new QuestionBroker({ store, selfId: () => 'me', send: () => true, timeoutMs: () => 60 * MIN, ownWaitMs: (c) => (c === 'ws:auto' ? 15 * MIN : undefined), toast: (t) => void toasts.push(t) });
      let auto: unknown;
      let step: unknown;
      void broker.ask('me', 'r1', 'ws:auto', { kind: 'plan', plan: 'do it' }).then((a) => (auto = a));
      void broker.ask('me', 'r2', 'ws:step', { kind: 'plan', plan: 'do it' }).then((a) => (step = a));
      await vi.advanceTimersByTimeAsync(15 * MIN - 1);
      expect(auto).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(auto).toEqual({ kind: 'skip' });
      expect(toasts).toEqual(["Autopilot: your agent's plan went unanswered for 15 minutes, so it carried on without it"]);
      await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
      expect(step).toBeUndefined();
      expect(store.getState().questions.map((q) => q.channel)).toEqual(['ws:step']);
      broker.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the setting', () => {
  it('reads saved values safely, defaulting to 5 minutes', () => {
    expect(Settings.parse({}).autopilotWait).toBe(AUTOPILOT_WAIT_DEFAULT);
    expect(Settings.parse({ autopilotWait: 0 }).autopilotWait).toBe(0);
    expect(Settings.parse({ autopilotWait: 30 }).autopilotWait).toBe(30);
    for (const bad of [-1, 1.5, 100_000, 'often', null]) expect(Settings.parse({ autopilotWait: bad }).autopilotWait).toBe(AUTOPILOT_WAIT_DEFAULT);
    expect(autopilotWaitMinutes(undefined)).toBe(AUTOPILOT_WAIT_DEFAULT);
  });

  it('takes whole minutes up to a day from the screens', () => {
    for (const ok of [0, 1, 5, 240, 1440]) expect(PrefsPatch.safeParse({ autopilotWait: ok }).success).toBe(true);
    for (const bad of [-1, 1441, 7.5]) expect(PrefsPatch.safeParse({ autopilotWait: bad }).success).toBe(false);
  });

  it('says each choice in words', () => {
    expect([0, 1, 5, 60, 240].map(autopilotWaitWords)).toEqual(['Until you answer', '1 minute', '5 minutes', '1 hour', '4 hours']);
  });
});
