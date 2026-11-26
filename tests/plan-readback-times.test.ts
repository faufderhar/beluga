import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import type { Activity, BoardState, Issue } from '../src/core/board/model.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { type Live, NOBODY_LIVE, planView } from '../src/core/plans/progress.js';
import { describePlan } from '../src/core/plans/prompt.js';
import { agoWords, isoMinute, taskTimes, whenWords } from '../src/core/plans/times.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { PlanView } from '../src/companion/protocol.js';
import { planPageView } from '../src/companion/views.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { taskWords } from '../packages/mac/src/plans/plans-model.js';

/**
 * Reading a plan back says when things happened (plan_get, the Mac's cards, the phone): every
 * task, not only the ones at work, so a stuck task reads differently from one that just started,
 * and two read-backs can be put in order. All on a fixed clock.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 19, 12, 0);

describe('times in words', () => {
  it('absolute to the minute in UTC, and how long ago', () => {
    expect(isoMinute(Date.UTC(2026, 10, 19, 9, 5, 42))).toBe('2026-11-19T09:05Z');
    expect(agoWords(NOW - 20_000, NOW)).toBe('just now');
    expect(agoWords(NOW - 12 * MIN, NOW)).toBe('12 min ago');
    expect(agoWords(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(agoWords(NOW - 50 * HOUR, NOW)).toBe('2d ago');
    // Another computer's clock a little ahead: never "-1 min ago".
    expect(agoWords(NOW + 5 * MIN, NOW)).toBe('just now');
    expect(whenWords(NOW - 12 * MIN, NOW)).toBe('2026-11-19T11:48Z (12 min ago)');
    // A time that isn't one (an old record) reads as unknown instead of failing plan_get.
    expect(whenWords(Number.NaN, NOW)).toBe('unknown');
    expect(isoMinute(Number.NaN)).toBe('unknown');
  });
});

const body = normalizeBody({
  title: 'Serve it',
  goal: 'g',
  milestones: [
    { id: 'docs', title: 'Docs', criteria: ['works'], tasks: [{ id: 'readme', title: 'README' }, { id: 'guide', title: 'Guide' }, { id: 'vm', title: 'VM walk', blockedBy: ['readme', 'guide'] }] },
    { id: 'ship', title: 'Ship', criteria: ['out'], tasks: [{ id: 'tag', title: 'Tag it' }] },
  ],
});
const withIssues = (b: typeof body): typeof body => ({ ...b, milestones: b.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => ({ ...t, issueId: `i-${t.id}` })) })) });
const moved = (at: number, now: string): Activity => ({ id: `a${at}`, at, by: { kind: 'claude' } as Activity['by'], kind: 'status', text: `moved this to ${now}`, now });
const issue = (id: string, key: string, status: Issue['status'], times: { created: number; updated: number; moves?: Activity[]; closed?: number }, worktrees: string[] = []): Issue =>
  ({ id: `i-${id}`, key, title: id, status, worktrees, blockedBy: [], brief: {}, activity: times.moves ?? [], createdAt: times.created, updatedAt: times.updated, ...(times.closed ? { closedAt: times.closed } : {}) }) as unknown as Issue;
const board = (issues: Issue[]): BoardState => ({ enabled: true, issues, projects: {}, autoTasks: false });
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'p',
  projectId: 'x',
  home: 'ws:h',
  status: 'active',
  body: withIssues(body),
  draftRev: 1,
  autonomy: 'gated',
  maxParallel: 3,
  testsAt: 'milestone',
  paused: false,
  runs: { docs: { agent: { worktree: 'w1', at: NOW - 5 * HOUR, tasks: ['readme', 'guide', 'vm'] } } },
  activity: [],
  createdAt: NOW - 30 * HOUR,
  updatedAt: NOW - 10 * MIN,
  approvedAt: NOW - 6 * HOUR,
  ...over,
});

// README went to review two hours ago and has sat there since; Guide is being worked now; Tag it was done yesterday.
const issues = (): Issue[] => [
  issue('readme', 'BLG-1', 'in_review', { created: NOW - 6 * HOUR, updated: NOW - 2 * HOUR, moves: [moved(NOW - 5 * HOUR, 'In Progress'), moved(NOW - 2 * HOUR, 'In Review')] }, ['w1']),
  issue('guide', 'BLG-2', 'in_progress', { created: NOW - 6 * HOUR, updated: NOW - 90 * MIN, moves: [moved(NOW - 90 * MIN, 'In Progress')] }, ['w1']),
  issue('vm', 'BLG-3', 'todo', { created: NOW - 6 * HOUR, updated: NOW - 6 * HOUR }),
  issue('tag', 'BLG-4', 'done', { created: NOW - 6 * HOUR, updated: NOW - 26 * HOUR, moves: [moved(NOW - 26 * HOUR, 'Done')], closed: NOW - 26 * HOUR }),
];
// Guide's agent is on a step that began 3 minutes ago.
const working: Live = {
  busy: (c) => c === 'ws:w1',
  asking: () => false,
  run: (c) => (c === 'ws:w1' ? { requestId: 'r', status: 'started', ts: NOW - 90 * MIN, lastAt: NOW - MIN, step: 'Edit guide.md', stepAt: NOW - 3 * MIN, text: '' } : undefined),
};

describe('a task’s times', () => {
  it('since it reached its status (its last status change), its last change, and when it closed', () => {
    const [readme, , vm, tag] = issues();
    expect(taskTimes(readme!)).toEqual({ since: NOW - 2 * HOUR, updated: NOW - 2 * HOUR });
    // Never moved: since it was made.
    expect(taskTimes(vm!)).toEqual({ since: NOW - 6 * HOUR, updated: NOW - 6 * HOUR });
    expect(taskTimes(tag!)?.closed).toBe(NOW - 26 * HOUR);
    // Its agent's step now counts as its last change.
    expect(taskTimes(readme!, { kind: 'working', since: NOW - MIN })?.updated).toBe(NOW - MIN);
  });

  it('a task that keeps no time says none (an older record), instead of a wrong one', () => {
    expect(taskTimes({ id: 'x', activity: [] } as unknown as Issue)).toBeUndefined();
  });
});

describe('plan_get says when', () => {
  const text = (p: Plan = plan(), live: Live = working): string => describePlan(planView(p, board(issues()), live), NOW);

  it('when it was read, and the plan’s own times', () => {
    expect(text()).toContain('Read at 2026-11-19T12:00Z (times are UTC). Plan created 2026-11-18T06:00Z (30h ago) · approved 2026-11-19T06:00Z (6h ago) · updated 2026-11-19T11:50Z (10 min ago).');
  });

  it('every task on the board, not only those at work: since when, and its last change', () => {
    const lines = text().split('\n');
    const line = (id: string): string => lines.find((l) => l.startsWith(`- [${id}]`))!;
    // In review for two hours, untouched since: reads as waiting, not as just started.
    expect(line('readme')).toContain('in review · BLG-1 · since 2026-11-19T10:00Z (2h ago)');
    expect(line('readme')).not.toContain('updated');
    // At work: in progress since 90 minutes, its last change its agent's latest sign of life.
    expect(line('guide')).toContain('since 2026-11-19T10:30Z (1h ago) · updated 2026-11-19T11:59Z (1 min ago)');
    expect(line('vm')).toContain('since 2026-11-19T06:00Z (6h ago)');
    expect(line('tag')).toContain('done · BLG-4 · since 2026-11-18T10:00Z (26h ago)');
  });

  it('each milestone: when its agent started, its check, when it passed', () => {
    const checked = plan({ runs: { docs: { agent: { worktree: 'w1', at: NOW - 5 * HOUR, tasks: [] } }, ship: { check: { at: NOW - 25 * HOUR, by: { kind: 'claude' } as never, verdict: 'pass', notes: 'ok' }, passedAt: NOW - 24 * HOUR } } });
    const t = text(checked, NOBODY_LIVE);
    expect(t).toContain('Times: agent started 2026-11-19T07:00Z (5h ago)');
    expect(t).toContain('Times: checked 2026-11-18T11:00Z (25h ago) (pass) · passed 2026-11-18T12:00Z (24h ago)');
  });

  it('a draft not approved yet has no task times (nothing is on the board)', () => {
    const draft = plan({ status: 'draft', body: undefined, draft: body, approvedAt: undefined, runs: {} });
    const t = describePlan(planView(draft, board([]), NOBODY_LIVE), NOW);
    expect(t).toContain('Read at 2026-11-19T12:00Z');
    expect(t).not.toContain('since');
    expect(t).not.toContain('approved 2026');
  });
});

describe('the Mac’s task cards say when each last changed', () => {
  it('a task in review or done, not only a running one', () => {
    const v = planView(plan(), board(issues()), NOBODY_LIVE);
    const card = (id: string) => taskWords(v.milestones.flatMap((m) => m.tasks).find((t) => t.task.id === id)!, NOW);
    expect(card('readme').sub).toBe('Updated 2 h ago');
    expect(card('tag').sub).toBe('Updated Yesterday');
    // Blocked: what it waits on, then when it last changed.
    expect(card('vm').sub).toBe('Waits on “Guide” · Updated 6 h ago');
  });

  it('with no clock (now 0, a label only) it says no time, never a wrong "just now"', () => {
    const v = planView(plan(), board(issues()), NOBODY_LIVE);
    const readme = v.milestones[0]!.tasks.find((t) => t.task.id === 'readme')!;
    expect(taskWords(readme, 0).sub).toBeUndefined();
  });
});

describe('the phone’s plan says when each task last changed (1.59)', () => {
  const ws = (id: string, name: string): Workspace => ({ id, projectId: 'api', name, path: `/tmp/${name}`, kind: 'chat', projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
  const BODY: BodyInput = { title: 'Parser', goal: 'A faster parser.', milestones: [{ id: 'm1', title: 'Fast', criteria: ['fast'], tasks: [{ id: 'a', title: 'Lexer' }] }] };

  it('since and updatedAt on each task once it is on the board, and an older phone ignores them', () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [{ id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces: [ws('main', 'bob-api')] } as Project] });
    const controller = { onWorktree: () => () => undefined } as unknown as WorkspaceController;
    const b = new Board({ store, dir: null, projectName: () => 'bob-api' });
    const work = new BoardWork({ store, board: b, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
    const plans = new Plans({ store, dir: null });
    const plansWork = new PlansWork({ store, plans, board: work, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0 });
    const p = plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, work.myClaude());
    plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    // A draft: nothing on the board, no times.
    expect(PlanView.parse(planPageView(store.getState(), p.id)).milestones[0]!.tasks[0]!.updatedAt).toBeUndefined();
    plansWork.approve(p.id);
    const task = PlanView.parse(planPageView(store.getState(), p.id)).milestones[0]!.tasks[0]!;
    const made = store.getState().board.issues.find((i) => i.plan?.id === p.id)!;
    expect(task.since).toBe(taskTimes(made)!.since);
    expect(task.updatedAt).toBe(made.updatedAt);
    // Additive: a phone from before 1.59 parses the same view with the fields dropped.
    const older = PlanView.shape.milestones.element.shape.tasks.element.omit({ since: true, updatedAt: true }).strip();
    expect(older.parse(task)).not.toHaveProperty('updatedAt');
  });
});
