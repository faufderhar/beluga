import { describe, expect, it, vi } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { type BodyInput, PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, milestoneDeps, planForHome } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { overlaps, planView, tidyOffer, waves } from '../src/core/plans/progress.js';
import { PlansWork, type PlansWorkDeps } from '../src/core/plans/work.js';
import type { CombineResult } from '../src/workspaces/git.js';
import type { PlanGit } from '../src/core/plans/plan-git.js';
import type { PlanPr } from '../src/core/plans/model.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { planOf } from '../src/core/plans/owner.js';
import { needsYou } from '../src/companion/needs-you.js';
import { PLAN_TOOL_NAMES, createPlanToolDefs, milestoneInput, toOps } from '../src/agent/plan-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { PlanBodySchema } from '../src/core/team/protocol.js';
import { PlanOpSchema } from '../src/ipc/plans-api.js';
import { createMockBackend } from '../src/agent/mock.js';

/** Plans: drafts that stay off the board, approving onto it, and the scheduler running them. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(opts: { sendOn?: PlansWorkDeps['sendOn']; combine?: PlansWorkDeps['combine']; git?: PlanGit; titlePlan?: (goal: string) => Promise<string | undefined>; workers?: 'milestone' | 'task'; forYou?: PlansWorkDeps['forYou']; cancel?: PlansWorkDeps['cancel']; rescueMs?: number; now?: () => number } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const asked: Array<{ prompt: string; channel: string; echo: boolean; chain?: { chainId: string; hop: number } }> = [];
  const made: Array<{ name: string; base?: string; quiet?: boolean }> = [];
  const archived: string[] = [];
  let n = 0;
  const add = (w: Workspace): void => {
    store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  };
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string, opts: { base?: string; quiet?: boolean } = {}) => {
      made.push({ name, ...opts });
      const w = ws(`w${++n}`, projectId, name);
      add(w);
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
    newChat: async (projectId: string, title: string) => {
      const w = ws(`c${++n}`, projectId, title, 'chat', { askOnly: true } as Partial<Workspace>);
      add(w);
      return w;
    },
    renameChat: async (id: string, name: string) => {
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) })) });
    },
    archive: async (id: string) => {
      archived.push(id);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, archived: true } : w)) })) });
      return true;
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void asked.push({ prompt, channel, echo: true }) });
  const plans = new Plans({ store, dir: null });
  const intents: unknown[] = [];
  const work = new PlansWork({ store, plans, board: boardWork, controller, askClaude: (prompt, channel, echo, chain) => `ask-${asked.push({ prompt, channel, echo, ...(chain ? { chain } : {}) })}`, intend: (i) => void intents.push(i), delayMs: 0, ...(opts.sendOn ? { sendOn: opts.sendOn } : {}), ...(opts.combine ? { combine: opts.combine } : {}), ...(opts.git ? { git: opts.git } : {}), ...(opts.titlePlan ? { titlePlan: opts.titlePlan } : {}), ...(opts.workers ? { workers: opts.workers } : {}), ...(opts.forYou ? { forYou: opts.forYou } : {}), ...(opts.cancel ? { cancel: opts.cancel } : {}), ...(opts.rescueMs !== undefined ? { rescueMs: opts.rescueMs } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const claude = boardWork.myClaude();
  const me = boardWork.me();
  /** Claude in a worktree finishes its run, or works. */
  const run = (channel: string, status: 'started' | 'done', id = `r-${Math.random()}`): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId: id, requester: 'p-me', event: status, text: '', ts: Date.now(), channel });
  return { store, board, boardWork, plans, work, asked, made, archived, intents, claude, me, run, add, controller };
}

describe('a new plan’s name (KLD-28)', () => {
  const chatName = (t: ReturnType<typeof setup>, home: string): string | undefined => t.store.getState().projects.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === home)?.name;
  const goal = 'A couple of things that we should improve because they look unfinished while Claude drafts the plan';

  it('is never your message: "New plan", then the quick model’s name, in the sidebar too', async () => {
    let name!: (title: string | undefined) => void;
    const t = setup({ titlePlan: () => new Promise((r) => (name = r)) });
    const plan = await t.work.create({ projectId: 'api', goal });
    expect(plan.draft!.title).toBe('New plan');
    expect(plan.draft!.goal).toBe(goal);
    expect(chatName(t, plan.home)).toBe('New plan');
    name('Calmer plan drafting screen');
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('Calmer plan drafting screen');
    expect(chatName(t, plan.home)).toBe('Calmer plan drafting screen');
  });

  it('Claude’s plan_write names it after that, and a late quick name doesn’t win', async () => {
    let name!: (title: string | undefined) => void;
    const t = setup({ titlePlan: () => new Promise((r) => (name = r)) });
    const plan = await t.work.create({ projectId: 'api', goal });
    t.work.forRun(plan.home, 'p-me')!.tools!.write(BODY);
    expect(t.plans.need(plan.id).draft!.title).toBe('Payments');
    expect(chatName(t, plan.home)).toBe('Payments');
    name('Too late');
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('Payments');
  });

  it('the mock agent’s quick call writes a short title, not your first words (KLD-36)', async () => {
    const agent = createMockBackend({} as never, 0);
    const t = setup({ titlePlan: (g) => agent.titlePlan!(g) });
    const plan = await t.work.create({ projectId: 'api', goal });
    await tick(5);
    const title = t.plans.need(plan.id).draft!.title;
    expect(title).toBe('Improve unfinished drafts');
    expect(title.split(' ').length).toBeLessThanOrEqual(6);
    expect(goal.toLowerCase().startsWith(title.toLowerCase())).toBe(false);
    expect(chatName(t, plan.home)).toBe(title);
  });

  it('stays "New plan" when the model can’t name it', async () => {
    const t = setup({ titlePlan: async () => undefined });
    const plan = await t.work.create({ projectId: 'api', goal });
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('New plan');
  });
});

describe('the demo plan’s own conversation (KLD-53)', () => {
  it('is saved, not loaded: as after a restart, it shows once the plan page loads it', async () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
    const saved = new Map<string, readonly unknown[]>();
    const controller = {
      onWorktree: () => () => undefined,
      newChat: async (projectId: string, title: string) => ws('c1', projectId, title, 'chat'),
      manager: { saveHistory: (id: string, items: readonly unknown[]) => void saved.set(id, items) },
    } as unknown as WorkspaceController;
    const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
    const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
    const work = new PlansWork({ store, plans: new Plans({ store, dir: null }), board: boardWork, controller, git: null, askClaude: () => undefined, intend: () => undefined, delayMs: 0 });
    const home = await work.homeFor('api', 'Card checkout', (channel) => [{ id: 'a', type: 'chat', channel, from: 'p-me', name: 'Kay', text: 'Plan it', ts: 1, byAgent: false }]);
    expect(home).toBe('ws:c1');
    expect(saved.get('c1')).toEqual([expect.objectContaining({ channel: 'ws:c1', text: 'Plan it' })]);
    expect(store.getState().log.filter((l) => l.channel === home)).toEqual([]);
  });
});

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [
    {
      id: 'safe',
      title: 'Safe payments',
      criteria: ['401 without a session', 'A replayed webhook charges once'],
      tasks: [
        { id: 'auth', title: 'Auth on payment routes', goal: 'Only signed-in users pay.', acceptance: ['401 without session'], touches: ['src/auth'], estimate: 3 },
        { id: 'retries', title: 'Idempotent webhooks', acceptance: '- [ ] each event once\n- [ ] backoff', touches: ['src/webhooks'], estimate: 5 },
        { id: 'receipts', title: 'Receipts once', blockedBy: ['retries'], touches: ['src/email'] },
      ],
    },
    { id: 'refunds', title: 'Refunds', criteria: ['A refund works end to end'], tasks: [{ id: 'refund-api', title: 'Refund endpoint', blockedBy: ['auth', 'retries'] }, { id: 'keys', title: 'Live keys', assignee: 'me' }] },
  ],
};

describe('writing a plan', () => {
  it('reads input kindly: ids from titles, checklists as lines', () => {
    const body = normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'First step', criteria: '- [ ] works', tasks: [{ title: 'Do The Thing', acceptance: '- [ ] a\n- [x] b' }, { title: 'Do the other thing' }] }] });
    expect(body.milestones[0]!.id).toBe('first-step');
    expect(body.milestones[0]!.criteria).toEqual(['works']);
    expect(body.milestones[0]!.tasks.map((t) => t.id)).toEqual(['do-the-thing', 'do-the-other-thing']);
    // Two tasks whose titles make one id are refused, never renamed "-2" (BLG-772).
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ title: 'Do The Thing' }, { title: 'Do the thing' }] }] })).toThrow(/already a task "do-the-thing": “Do The Thing”/);
    expect(body.milestones[0]!.tasks[0]!.acceptance).toEqual(['a', 'b']);
  });

  it('refuses loops, unknown blockers and blockers in a later milestone', () => {
    const loop = { title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', blockedBy: ['b'] }, { id: 'b', title: 'B', blockedBy: ['a'] }] }] };
    expect(() => normalizeBody(loop)).toThrow(/loop: a → b → a|loop/);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', blockedBy: ['zz'] }] }] })).toThrow(PlanError);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M1', tasks: [{ id: 'a', title: 'A', blockedBy: ['b'] }] }, { title: 'M2', tasks: [{ id: 'b', title: 'B' }] }] })).toThrow(/later milestone/);
  });

  it('ops change it step by step; removing a task drops it from blockers; moving takes sub-tasks along', () => {
    let body = normalizeBody(BODY);
    body = applyOps(body, [
      { op: 'add_task', milestone: 'safe', task: { id: 'sub', title: 'Sub', parent: 'auth' } },
      { op: 'remove_task', id: 'retries' },
      { op: 'update_task', id: 'auth', patch: { title: 'Auth everywhere' } },
    ]);
    const tasks = body.milestones.flatMap((m) => m.tasks);
    expect(tasks.find((t) => t.id === 'receipts')!.blockedBy).toEqual([]);
    expect(tasks.find((t) => t.id === 'refund-api')!.blockedBy).toEqual(['auth']);
    expect(tasks.find((t) => t.id === 'auth')!.title).toBe('Auth everywhere');
    body = applyOps(body, [{ op: 'move_task', id: 'auth', milestone: 'refunds', before: 'refund-api' }]);
    expect(body.milestones[1]!.tasks.map((t) => t.id)).toEqual(['auth', 'sub', 'refund-api', 'keys']);
  });

  it('has no limit on milestones, or on how many earlier ones a milestone builds on', () => {
    const milestones = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, title: `Step ${i}`, tasks: [{ id: `t${i}`, title: `Task ${i}` }] }));
    const last = { ...milestones[19]!, dependsOn: milestones.slice(0, 15).map((m) => m.id) };
    const body = normalizeBody({ title: 'Big', goal: '', milestones: [...milestones.slice(0, 19), last] });
    expect(body.milestones).toHaveLength(20);
    expect(body.milestones[19]!.dependsOn).toHaveLength(15);
    expect(PlanBodySchema.safeParse(body).success).toBe(true);
    expect(PlanOpSchema.safeParse({ op: 'update_milestone', id: 'm19', dependsOn: last.dependsOn }).success).toBe(true);
  });

  it('has no limit on tasks, in the plan or in one milestone', () => {
    const tasks = (m: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${m}-t${i}`, title: `Task ${m}.${i}` }));
    const body = normalizeBody({ title: 'Big', goal: '', milestones: [{ id: 'm0', title: 'Wide', tasks: tasks(0, 50) }, { id: 'm1', title: 'Wider', tasks: tasks(1, 50) }] });
    expect(body.milestones.flatMap((m) => m.tasks)).toHaveLength(100);
    expect(PlanBodySchema.safeParse({ ...body, milestones: [{ ...body.milestones[0]!, tasks: [...body.milestones[0]!.tasks, ...body.milestones[1]!.tasks] }] }).success).toBe(true);
    expect(PlanOpSchema.safeParse({ op: 'add_milestone', milestone: { title: 'Wide', tasks: tasks(2, 50).map(({ title }) => ({ title })) } }).success).toBe(true);
  });

  it('waves are what can run side by side', () => {
    const body = normalizeBody(BODY);
    expect(waves(body.milestones[0]!).map((w) => w.map((t) => t.id))).toEqual([['auth', 'retries'], ['receipts']]);
  });
});

describe('a plan on the board: the plan, its milestones as epics, their tasks under them (BLG-471)', () => {
  const approved = () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    const get = (id: string) => t.board.need(id);
    const byTitle = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    return { ...t, plan, get, byTitle, epics: () => t.plans.need(plan.id).epics! };
  };

  it('approving makes an epic for the plan and one per milestone under it, with each milestone’s tasks under that', () => {
    const t = approved();
    const e = t.epics();
    expect(t.get(e.plan)).toMatchObject({ title: 'Payments', origin: 'plan', status: 'todo' });
    expect(t.get(e.plan).plan).toBeUndefined();
    expect(t.get(e.milestones.safe!)).toMatchObject({ title: 'Safe payments', parent: e.plan, status: 'todo' });
    // A milestone that waits on another starts in the Backlog, like its tasks.
    expect(t.get(e.milestones.refunds!)).toMatchObject({ title: 'Refunds', parent: e.plan, status: 'backlog' });
    expect(t.get(e.milestones.refunds!).brief.context).toContain('A refund works end to end');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) expect(t.byTitle(title).parent).toBe(e.milestones.safe);
    for (const title of ['Refund endpoint', 'Live keys']) expect(t.byTitle(title).parent).toBe(e.milestones.refunds);
  });

  it('changing the plan keeps it true: a renamed milestone, a moved task, a sub-task under its own parent, a milestone taken out', () => {
    const t = approved();
    const e = t.epics();
    t.work.edit(t.plan.id, [
      { op: 'update_milestone', id: 'safe', title: 'Safe payments, everywhere' },
      { op: 'move_task', id: 'receipts', milestone: 'refunds' },
      { op: 'add_task', milestone: 'safe', task: { id: 'sub', title: 'Sub', parent: 'auth' } },
    ]);
    expect(t.get(e.milestones.safe!).title).toBe('Safe payments, everywhere');
    expect(t.byTitle('Receipts once').parent).toBe(e.milestones.refunds);
    expect(t.byTitle('Sub').parent).toBe(t.byTitle('Auth on payment routes').id);
    // The same epics: nothing made twice.
    expect(t.epics()).toEqual(e);
    t.work.edit(t.plan.id, [{ op: 'remove_milestone', id: 'refunds' }]);
    expect(t.get(e.milestones.refunds!).status).toBe('canceled');
    expect(t.epics().milestones.refunds).toBeUndefined();
  });

  it('the epics follow their tasks: under way, merged into the plan, done', () => {
    const t = approved();
    const e = t.epics();
    t.board.update(t.byTitle('Auth on payment routes').id, { status: 'in_progress' }, t.claude);
    expect(t.get(e.milestones.safe!).status).toBe('in_progress');
    expect(t.get(e.plan).status).toBe('in_progress');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(t.byTitle(title).id, { status: 'in_plan' }, t.claude);
    expect(t.get(e.milestones.safe!).status).toBe('in_plan');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(t.byTitle(title).id, { status: 'done' }, t.claude);
    expect(t.get(e.milestones.safe!).status).toBe('done');
  });

  it('a plan from before epics gets them once; deleting the plan cancels them and lets its tasks out', async () => {
    const t = approved();
    const e = t.epics();
    // As if it was approved before epics existed.
    for (const id of [...Object.values(e.milestones), e.plan]) t.board.remove(id);
    t.plans.setEpics(t.plan.id, { plan: 'gone', milestones: {} });
    const fresh = new PlansWork({ store: t.store, plans: t.plans, board: t.boardWork, askClaude: () => undefined, intend: () => undefined, delayMs: 0, git: null });
    await tick(5);
    const again = t.plans.need(t.plan.id).epics!;
    expect(again.plan).not.toBe('gone');
    expect(t.byTitle('Refund endpoint').parent).toBe(again.milestones.refunds);
    fresh.remove(t.plan.id);
    expect(t.get(again.plan).status).toBe('canceled');
    expect(t.byTitle('Refund endpoint').parent).toBeUndefined();
    fresh.stop();
  });
});

describe('a draft stays off the board until approved', () => {
  it('Claude writes the draft; the board has nothing; Approve puts it all there', () => {
    const { store, plans, work, claude } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    const tools = work.forRun('ws:main', 'p-me')!.tools!;
    expect(tools.write(BODY)).toContain('nothing is on the board until then');
    expect(store.getState().board.issues).toHaveLength(0);
    work.approve(plan.id);
    const issues = store.getState().board.issues;
    // Its 5 tasks, and its shape: an epic for the plan, one for each of its 2 milestones.
    expect(issues.filter((i) => i.plan)).toHaveLength(5);
    expect(issues).toHaveLength(8);
    const byTitle = (t: string) => issues.find((i) => i.title === t)!;
    // The milestone being worked on is Ready (todo); later ones wait in the Backlog.
    expect(byTitle('Auth on payment routes')).toMatchObject({ status: 'todo', origin: 'plan', estimate: 3, plan: { id: plan.id, milestone: 'safe', task: 'auth' } });
    // Claude's plan tasks are no one's (a task is for a person, BLG-278); yours are yours.
    expect(byTitle('Auth on payment routes').assignee).toBeUndefined();
    expect(byTitle('Refund endpoint').status).toBe('backlog');
    expect(byTitle('Live keys').assignee).toMatchObject({ kind: 'person', id: 'p-me' });
    expect(byTitle('Receipts once').blockedBy).toEqual([byTitle('Idempotent webhooks').id]);
    expect(byTitle('Idempotent webhooks').brief.acceptance).toBe('- [ ] each event once\n- [ ] backoff');
    expect(plans.need(plan.id)).toMatchObject({ status: 'active' });
    expect(plans.need(plan.id).draft).toBeUndefined();
  });

  it('throwing a never-approved draft away removes the plan, and the board never knew', () => {
    const { store, plans, work, claude } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    work.discard(plan.id);
    expect(store.getState().plans.plans).toHaveLength(0);
    expect(store.getState().board.issues).toHaveLength(0);
  });

  it('changes to an approved plan are proposed; applying them adds, rewrites (ticks kept) and cancels', () => {
    const { store, board, plans, work, claude, me } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    const tools = work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    work.approve(plan.id);
    const retries = store.getState().board.issues.find((i) => i.title === 'Idempotent webhooks')!;
    board.editBrief(retries.id, 'acceptance', '- [x] each event once\n- [ ] backoff', me);
    expect(tools.update([{ op: 'add_task', milestone: 'safe', task: { id: 'alerts', title: 'Alerts' } }, { op: 'remove_task', id: 'keys' }, { op: 'update_task', id: 'retries', patch: { acceptance: ['each event once', 'backoff', 'a replay test'] } }])).toContain('the user reviews the changes');
    expect(store.getState().board.issues.some((i) => i.title === 'Alerts')).toBe(false);
    const d = diffBodies(plans.need(plan.id).body, plans.need(plan.id).draft);
    expect(d).toMatchObject({ added: ['alerts'], removed: ['keys'], changed: ['retries'] });
    work.approve(plan.id);
    const after = store.getState().board.issues;
    expect(after.find((i) => i.title === 'Alerts')?.status).toBe('todo');
    expect(after.find((i) => i.title === 'Live keys')).toMatchObject({ status: 'canceled' });
    expect(after.find((i) => i.title === 'Live keys')!.plan).toBeUndefined();
    expect(board.need(retries.id).brief.acceptance).toBe('- [x] each event once\n- [ ] backoff\n- [ ] a replay test');
  });

  it('existing board tasks can be adopted by key', () => {
    const { store, board, plans, work, claude, me } = setup();
    const old = board.create({ projectId: 'api', title: 'Old task', status: 'in_progress' }, me);
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    work.forRun('ws:main', 'p-me')!.tools!.write({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ title: 'Old task', issue: old.key } as never, { title: 'New' }] }] });
    work.approve(plan.id);
    expect(store.getState().board.issues.filter((i) => i.plan)).toHaveLength(2);
    expect(board.need(old.id).plan?.id).toBe(plan.id);
    expect(board.need(old.id).status).toBe('in_progress');
  });
});

describe('running a plan', () => {
  async function running(autonomy: 'step' | 'gated' | 'autopilot' = 'gated', maxParallel = 3, workers: 'milestone' | 'task' = 'milestone') {
    const t = setup({ workers });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy }, t.claude);
    t.plans.setMaxParallel(plan.id, maxParallel, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    return { ...t, plan };
  }
  const issue = (t: Awaited<ReturnType<typeof running>>, title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;

  it('gated: one Claude for the milestone, started by itself, quietly; it gets every task, the first In Progress', async () => {
    const t = await running('gated');
    expect(t.made.map((m) => m.quiet)).toEqual([true]);
    const w = issue(t, 'Auth on payment routes').worktrees.at(-1);
    expect(issue(t, 'Auth on payment routes').status).toBe('in_progress');
    expect(issue(t, 'Idempotent webhooks')).toMatchObject({ status: 'todo', worktrees: [w] });
    expect(issue(t, 'Receipts once')).toMatchObject({ status: 'todo', worktrees: [w] });
    expect(t.plans.need(t.plan.id).runs.safe?.agent).toMatchObject({ worktree: w, tasks: ['auth', 'retries', 'receipts'] });
    // “Live keys” is the user's: never handed to a Claude.
    expect(issue(t, 'Live keys').worktrees).toEqual([]);
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.milestones[0]!.tasks.find((x) => x.task.id === 'receipts')).toMatchObject({ state: 'blocked', why: 'Waits on “Idempotent webhooks”' });
  });

  it('respects the plan’s limit', async () => {
    const t = await running('gated', 1);
    expect(t.made).toHaveLength(1);
  });

  it('step by step: nothing starts; you start a task', async () => {
    const t = await running('step');
    expect(t.made).toHaveLength(0);
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.next.kind).toBe('start');
    expect(await t.work.startTask(t.plan.id, 'auth')).toContain('Started');
    await expect(t.work.startTask(t.plan.id, 'receipts')).rejects.toThrow(/can’t start: Waits on/);
  });

  it('a worktree per task (workers: task): what’s ready starts by itself, never a blocked task', async () => {
    const t = await running('gated', 3, 'task');
    expect(t.made.map((m) => m.quiet)).toEqual([true, true]);
    expect(issue(t, 'Auth on payment routes').status).toBe('in_progress');
    expect(issue(t, 'Idempotent webhooks').status).toBe('in_progress');
    expect(issue(t, 'Receipts once').status).toBe('todo');
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).milestones[0]!.tasks.find((x) => x.task.id === 'receipts')).toMatchObject({ state: 'blocked' });
  });

  it('a task in review lets what builds on it start from its branch (workers: task)', async () => {
    const t = await running('gated', 3, 'task');
    const retries = issue(t, 'Idempotent webhooks');
    t.board.update(retries.id, { status: 'in_review' }, t.claude);
    await tick(5);
    expect(t.made.at(-1)).toMatchObject({ base: retries.branch, quiet: true });
    expect(issue(t, 'Receipts once').status).toBe('in_progress');
  });

  it('finished tasks: a checker of its own checks the criteria; gated waits for you; passing opens the next milestone', async () => {
    const t = await running('gated');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(issue(t, title).id, { status: 'done' }, t.me);
    await tick(5);
    t.board.update(issue(t, 'Receipts once').id, { status: 'in_review' }, t.claude);
    await tick(5);
    // Not the head Claude's conversation: one made for this milestone's check, folded into the plan.
    const checker = t.plans.need(t.plan.id).runs.safe?.checker;
    expect(checker).toBeDefined();
    expect(t.asked.some((a) => a.channel === 'ws:main' && a.prompt.includes('Check its pass criteria'))).toBe(false);
    const check = t.asked.find((a) => a.channel === `ws:${checker}` && a.prompt.includes('Check its pass criteria'));
    expect(check?.echo).toBe(false);
    expect(check?.prompt).toContain('401 without a session');
    expect(check?.prompt).toContain('You are the checker of milestone');
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).current?.state).toBe('checking');
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).next.kind).toBe('checking');
    // The checker reads the plan and records its verdict: nothing else.
    const run = t.work.forRun(`ws:${checker}`, 'p-me')!;
    expect(run.checker).toBe(true);
    expect(run.tools!.only).toEqual(['plan_get', 'plan_gate']);
    expect(createPlanToolDefs(run.tools!).map((d) => d.name)).toEqual(['plan_get', 'plan_gate']);
    expect(() => run.tools!.update([], 'no')).toThrow(/only plan_get and plan_gate/);
    expect(() => run.tools!.gate('refunds', 'pass', 'x')).toThrow(/only/);
    run.tools!.gate('safe', 'pass', '1 ✓ 2 ✓');
    await tick(5);
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.current?.milestone.id).toBe('safe');
    expect(v.next.kind).toBe('pass');
    t.work.pass(t.plan.id, 'safe');
    await tick(5);
    // Its checker is done: archived.
    expect(t.archived).toEqual([checker]);
    expect(issue(t, 'Refund endpoint').status).toBe('in_progress');
    // "Live keys" is yours: it waits for you.
    expect(issue(t, 'Live keys').status).toBe('todo');
  });

  it('the head Claude’s conversation stays free: a failed check reaches it with the notes, to add the fix tasks', async () => {
    const t = await running('autopilot');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'in_review' }, t.claude);
    await tick(5);
    const checker = t.plans.need(t.plan.id).runs.safe!.checker!;
    expect(t.store.getState().log.some((l) => l.channel === 'ws:main' && l.type === 'system' && /a Claude of its own is checking/.test(l.text))).toBe(true);
    // Folded into the plan, like its home and its worktrees.
    expect(planOf(t.store.getState(), checker)?.id).toBe(t.plan.id);
    const said = t.work.forRun(`ws:${checker}`, 'p-me')!.tools!.gate('safe', 'fail', '2. ✗ Retries aren’t idempotent. Fix: key webhook writes by event id.');
    expect(said).toMatch(/adds the fix tasks/);
    const head = t.asked.filter((a) => a.channel === 'ws:main').at(-1)!;
    expect(head.prompt).toContain('The checker of milestone “Safe payments” failed it');
    expect(head.prompt).toContain('key webhook writes by event id');
    expect(head.prompt).toMatch(/Don't stop to ask the user/);
  });

  it('a check that ends without a verdict is asked once more, then left to you (Autopilot never waits silently)', async () => {
    const t = await running('autopilot');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'in_review' }, t.claude);
    await tick(5);
    const channel = `ws:${t.plans.need(t.plan.id).runs.safe!.checker!}`;
    const first = t.asked.findIndex((a) => a.channel === channel);
    t.run(channel, 'started', `ask-${first + 1}`);
    t.run(channel, 'done', `ask-${first + 1}`);
    await tick(5);
    const nudge = t.asked.findIndex((a) => a.channel === channel && a.prompt.includes('ended without a verdict'));
    expect(nudge).toBeGreaterThan(first);
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).current?.state).toBe('checking');
    t.run(channel, 'started', `ask-${nudge + 1}`);
    t.run(channel, 'done', `ask-${nudge + 1}`);
    await tick(5);
    // Not asked a third time: the plan says so.
    expect(t.asked.filter((a) => a.channel === channel && a.prompt.includes('ended without a verdict'))).toHaveLength(1);
    expect(t.plans.need(t.plan.id).activity.at(-1)?.text).toMatch(/ended twice without a verdict/);
  });

  it.each(['step', 'gated', 'autopilot'] as const)('%s: while the head Claude checks, the plan waits on Claude; it’s yours to pass only once the check is back (KLD-22)', async (autonomy) => {
    const t = await running(autonomy);
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'in_review' }, t.claude);
    await tick(5);
    await tick(5);
    const view = () => planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(view().next).toMatchObject({ kind: 'checking', milestone: { milestone: { id: 'safe' } } });
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', '1 ✓ 2 ✓');
    await tick(5);
    if (autonomy === 'autopilot') expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    else expect(view().next).toMatchObject({ kind: 'pass', milestone: { milestone: { id: 'safe' } } });
  });

  it('the pilot writes what happened: started, finished, checked, passed, the mode changed (KLD-22)', async () => {
    const t = await running('gated');
    t.board.update(issue(t, 'Idempotent webhooks').id, { status: 'in_review' }, t.claude);
    await tick(5);
    t.work.setAutonomy(t.plan.id, 'autopilot');
    const kinds = t.plans.need(t.plan.id).activity.map((e) => `${e.kind}: ${e.text}`);
    expect(kinds.filter((k) => k.startsWith('started:'))).toEqual([expect.stringMatching(/^started: started one agent for “Safe payments” \([A-Z]+-\d+, [A-Z]+-\d+, [A-Z]+-\d+\) in a new worktree$/)]);
    expect(kinds).toContainEqual(expect.stringMatching(/^finished: finished [A-Z]+-\d+ “Idempotent webhooks”$/));
    expect(kinds.at(-1)).toBe('autonomy: switched the plan to Autopilot');
  });

  it('autopilot: a pass that fails for a real reason is said in the plan’s activity, once (still working: not)', async () => {
    const t = await running('autopilot');
    const pass = vi.spyOn(t.work.pilot, 'pass').mockImplementation(() => {
      throw new Error('the plan file couldn’t be written');
    });
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'done' }, t.me);
    await tick(5);
    await tick(5);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', 'all good');
    await tick(5);
    await tick(5);
    expect(pass).toHaveBeenCalled();
    const problems = () => t.plans.need(t.plan.id).activity.filter((a) => a.kind === 'problem' && a.text.includes('couldn’t pass the milestone on Autopilot'));
    expect(problems()).toHaveLength(1);
    expect(problems()[0]!.text).toContain('the plan file couldn’t be written');
    pass.mockRestore();
  });

  it('autopilot: a passing check moves on by itself; a failing one stops there', async () => {
    const t = await running('autopilot');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'done' }, t.me);
    await tick(5);
    await tick(5);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.gate('safe', 'fail', 'replay sends two receipts');
    await tick(5);
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).next.kind).toBe('failed');
    // The milestone's Claude did its turn.
    const w = t.plans.need(t.plan.id).runs.safe!.agent!.worktree;
    t.run(`ws:${w}`, 'started', 'm-1');
    t.run(`ws:${w}`, 'done', 'm-1');
    // Claude adds a fix task: on autopilot it applies at once, and goes to the milestone's Claude.
    expect(tools.update([{ op: 'add_task', milestone: 'safe', task: { id: 'fix', title: 'Fix double receipts' } }])).toContain('Applied at once');
    await tick(5);
    expect(issue(t, 'Fix double receipts').worktrees).toEqual([w]);
    expect(t.made).toHaveLength(1);
    const sent = t.asked.filter((a) => a.channel === `ws:${w}`).at(-1)!;
    expect(sent.prompt).toContain('More tasks for “Safe payments”');
    expect(sent.prompt).toContain(`${issue(t, 'Fix double receipts').key} “Fix double receipts”`);
    t.board.update(issue(t, 'Fix double receipts').id, { status: 'done' }, t.me);
    await tick(5);
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(2);
    tools.gate('safe', 'pass', 'all good');
    await tick(5);
    await tick(5);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    expect(issue(t, 'Refund endpoint').status).toBe('in_progress');
  });

  it('a task’s worktree knows the plan, its milestone and what runs beside it (workers: task)', async () => {
    const t = await running('gated', 3, 'task');
    const auth = issue(t, 'Auth on payment routes');
    const brief = t.boardWork.forRun(`ws:${auth.worktrees.at(-1)}`, 'p-me')!.brief!;
    expect(brief).toContain('part of the plan “Payments”, milestone 1 “Safe payments”');
    expect(brief).toContain('“Idempotent webhooks” (touches src/webhooks)');
    expect(brief).toContain('status in_review');
  });

  it('paused: nothing starts', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.plans.setPaused(plan.id, true, t.me);
    t.work.approve(plan.id);
    await tick(5);
    expect(t.made).toHaveLength(0);
    expect(planView(t.plans.need(plan.id), t.store.getState().board).next.kind).toBe('resume');
  });

  it('warns about parallel tasks touching the same files', () => {
    const body = normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', touches: ['src/api'] }, { id: 'b', title: 'B', touches: ['src/api/x.ts'] }] }] });
    const fake = { active: body.milestones[0]!.tasks.map((task) => ({ task })) } as never;
    expect(overlaps(fake)).toHaveLength(1);
  });
});

describe('making a plan', () => {
  it('New Plan opens a conversation in the main folder, goes to the plan’s page, and asks Claude', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Add refunds to the admin' });
    expect(plan.home).toMatch(/^ws:c\d+$/);
    expect(t.intents).toEqual([{ type: 'navigate', view: { kind: 'plan', id: plan.id } }]);
    expect(t.asked).toEqual([{ prompt: 'Add refunds to the admin', channel: plan.home, echo: true }]);
    expect(t.work.forRun(plan.home, 'p-me')!.brief).toContain('a new plan, a draft only you and the user see');
  });

  it('or plans in the conversation you’re in; a friend’s run gets no plan', () => {
    const t = setup();
    const plan = t.work.here('ws:main');
    expect(planForHome(t.store.getState().plans, 'ws:main')?.id).toBe(plan.id);
    expect(t.work.here('ws:main').id).toBe(plan.id);
    expect(t.work.forRun('ws:main', 'p-bob')).toBeUndefined();
  });

  it('your planning style goes into Claude’s instructions', () => {
    const t = setup();
    t.work.setStyle('Always end with a docs milestone.');
    t.work.here('ws:main');
    expect(t.work.forRun('ws:main', 'p-me')!.brief).toContain('Always end with a docs milestone.');
  });

  it('the plan tools are all allowed, under their own server', () => {
    const t = setup();
    t.work.here('ws:main');
    const defs = createPlanToolDefs(t.work.forRun('ws:main', 'p-me')!.tools!);
    // plan_review is the draft's reviewer's alone (BLG-772).
    expect(defs.map((d) => `mcp__beluga_plan__${d.name}`)).toEqual(PLAN_TOOL_NAMES.filter((n) => !n.endsWith('plan_review')));
    for (const name of PLAN_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/tmp', roots: [], autoEdit: false, askOnly: true })).toBe('allow');
  });
});

describe('review fixes', () => {
  it('re-approving keeps what was changed on the board: briefs, canceled tasks', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    const auth = t.store.getState().board.issues.find((i) => i.title === 'Auth on payment routes')!;
    const retries = t.store.getState().board.issues.find((i) => i.title === 'Idempotent webhooks')!;
    t.board.editBrief(auth.id, 'goal', 'Rewritten on the board.', t.me);
    t.board.update(retries.id, { status: 'canceled' }, t.me);
    tools.update([{ op: 'add_task', milestone: 'refunds', task: { id: 'docs', title: 'Docs' } }]);
    t.work.approve(plan.id);
    expect(t.board.need(auth.id).brief.goal).toBe('Rewritten on the board.');
    expect(t.board.need(retries.id).status).toBe('canceled');
  });

  it('an approval that fails partway keeps what it made: trying again makes nothing twice', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    const relate = t.board.relate.bind(t.board);
    let fail = true;
    t.board.relate = ((...a: Parameters<typeof relate>) => {
      if (fail) throw new Error('disk full');
      return relate(...a);
    }) as typeof relate;
    expect(() => t.work.approve(plan.id)).toThrow('disk full');
    const made = t.store.getState().board.issues.length;
    expect(made).toBe(5);
    fail = false;
    t.work.approve(plan.id);
    expect(t.store.getState().board.issues.filter((i) => i.plan)).toHaveLength(5);
    // And its epics once: the plan's and its 2 milestones'.
    expect(t.store.getState().board.issues).toHaveLength(8);
  });

  it('Claude can’t start tasks on a step-by-step or paused plan; you can', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    await expect(tools.start('auth')).rejects.toThrow(/step by step/);
    expect(await t.work.startTask(plan.id, 'auth')).toContain('Started');
  });

  it('a task that failed to start doesn’t hold up the others', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.plans.setMaxParallel(plan.id, 1, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    let first = true;
    const start = t.boardWork.start.bind(t.boardWork);
    t.boardWork.start = (async (...a: Parameters<typeof start>) => {
      if (first) {
        first = false;
        throw new Error('no disk');
      }
      return start(...a);
    }) as typeof start;
    t.work.approve(plan.id);
    await tick(10);
    await tick(10);
    expect(t.store.getState().board.issues.filter((i) => i.plan && i.status === 'in_progress')).toHaveLength(1);
  });

  it('the last milestone passing asks for the recap; a check can be asked again', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write({ title: 'Small', goal: '', milestones: [{ id: 'only', title: 'Only', criteria: ['works'], tasks: [{ id: 'x', title: 'X' }] }] });
    t.work.approve(plan.id);
    await tick(5);
    t.board.update(t.store.getState().board.issues[0]!.id, { status: 'done' }, t.me);
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(1);
    t.work.recheck(plan.id, 'only');
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(2);
    t.work.pass(plan.id, 'only');
    expect(t.plans.need(plan.id).status).toBe('done');
    expect(t.asked.at(-1)?.prompt).toContain('Write a short recap');
  });

  it('a message to a task’s Claude is labelled as the plan’s, not yours', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    tools.message('auth', 'Use signed cookies');
    const sent = t.asked.at(-1)!;
    expect(sent.echo).toBe(false);
    expect(sent.prompt).toContain('not the user');
  });

  it('a message to a task’s Claude carries the chain of the plan’s run, one hop on', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    t.work.forRun('ws:main', 'p-me', () => ({ chainId: 'c-7', hop: 3 }))!.tools!.message('auth', 'Use signed cookies');
    expect(t.asked.at(-1)!.chain).toEqual({ chainId: 'c-7', hop: 4 });
  });

  it('a message to a task’s Claude that the chat-links guard refuses is not sent, and the plan’s agent reads why', async () => {
    const t = setup({ sendOn: () => ({ refused: 'hop_limit: too many agents in a row passed this on. Stop sending and end your turn.' }) });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    const before = t.asked.length;
    const tools = t.work.forRun('ws:main', 'p-me', () => ({ chainId: 'c-7', hop: 4 }))!.tools!;
    expect(() => tools.message('auth', 'Use signed cookies', 'steer')).toThrow(/^Not sent to [A-Z]+-\d+: hop_limit: too many agents in a row/);
    expect(t.asked.length).toBe(before);
  });

  it('a message to a task’s Claude goes on in the chain the chat-links guard gives it', async () => {
    const seen: unknown[] = [];
    const t = setup({ sendOn: (chain) => (seen.push(chain), { chain: { chainId: chain.chainId, hop: 9 } }) });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    t.work.forRun('ws:main', 'p-me', () => ({ chainId: 'c-7', hop: 3 }))!.tools!.message('auth', 'Use signed cookies');
    expect(seen).toEqual([{ chainId: 'c-7', hop: 3 }]);
    expect(t.asked.at(-1)!.chain).toEqual({ chainId: 'c-7', hop: 9 });
  });
});

describe('milestones run side by side unless one builds on another', () => {
  /** Two milestones that share nothing, and one that builds on the first. */
  const SIDE: BodyInput = {
    title: 'Polish',
    goal: '',
    milestones: [
      { id: 'channels', title: 'Channels', criteria: ['@ works'], tasks: [{ id: 'mentions', title: 'Mentions' }] },
      { id: 'pilot', title: 'Parallel milestones', criteria: ['both open'], tasks: [{ id: 'runner', title: 'Runner' }] },
      { id: 'header', title: 'Plan header', criteria: ['drawn'], dependsOn: ['pilot'], tasks: [{ id: 'canvas', title: 'Canvas' }] },
    ],
  };

  async function running(body: BodyInput, autonomy: 'step' | 'gated' | 'autopilot' = 'gated', maxParallel = 3) {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy }, t.claude);
    t.plans.setMaxParallel(plan.id, maxParallel, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(body);
    t.work.approve(plan.id);
    await tick(5);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    return { ...t, plan, issue, view };
  }

  it('infers dependencies from blocked_by into other milestones; none without such links', () => {
    const body = normalizeBody(BODY);
    expect(milestoneDeps(body, body.milestones[1]!)).toEqual(['safe']);
    expect(milestoneDeps(body, body.milestones[0]!)).toEqual([]);
    const side = normalizeBody(SIDE);
    expect(side.milestones.map((m) => milestoneDeps(side, m))).toEqual([[], [], ['pilot']]);
    // Said outright, it wins over what blockers would say ([]: alongside from the start).
    const said = normalizeBody({ ...BODY, milestones: [BODY.milestones[0]!, { ...BODY.milestones[1]!, dependsOn: [] }] });
    expect(milestoneDeps(said, said.milestones[1]!)).toEqual([]);
  });

  it('refuses depends_on a later or unknown milestone', () => {
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B' }] })).toThrow(/comes after it/);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ id: 'a', title: 'A', dependsOn: ['zz'] }] })).toThrow(/isn't in the plan/);
  });

  it('two independent milestones both open and start; a dependent one waits in the Backlog', async () => {
    const t = await running(SIDE);
    expect(t.view().open.map((m) => m.milestone.id)).toEqual(['channels', 'pilot']);
    expect(t.issue('Mentions').status).toBe('in_progress');
    expect(t.issue('Runner').status).toBe('in_progress');
    expect(t.issue('Canvas').status).toBe('backlog');
    expect(t.view().milestones[2]).toMatchObject({ state: 'later', dependsOn: ['pilot'] });
    expect(t.view().milestones[2]!.tasks[0]).toMatchObject({ state: 'later', why: 'Starts after “Parallel milestones”' });
  });

  it('each milestone has its own check and pass; passing one opens what waited on it', async () => {
    const t = await running(SIDE);
    t.board.update(t.issue('Runner').id, { status: 'in_review' }, t.claude);
    await tick(5);
    const checks = t.asked.filter((a) => a.prompt.includes('Check its pass criteria'));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.prompt).toContain('Parallel milestones');
    expect(t.view().milestones.map((m) => m.state)).toEqual(['running', 'checking', 'later']);
    // While the head Claude checks, the plan waits on Claude, not on you.
    expect(t.view().next).toMatchObject({ kind: 'checking', milestone: { milestone: { id: 'pilot' } } });
    t.work.pass(t.plan.id, 'pilot');
    await tick(5);
    expect(t.view().open.map((m) => m.milestone.id)).toEqual(['channels', 'header']);
    expect(t.issue('Canvas').status).toBe('in_progress');
    expect(t.plans.need(t.plan.id).status).toBe('active');
  });

  it('the limit on tasks at once is the whole plan’s', async () => {
    const t = await running(SIDE, 'gated', 1);
    expect(t.made).toHaveLength(1);
  });

  it('autopilot passes an independent milestone on its own check while the other still runs', async () => {
    const t = await running(SIDE, 'autopilot');
    t.board.update(t.issue('Mentions').id, { status: 'done' }, t.me);
    await tick(5);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('channels', 'pass', '@ ✓');
    await tick(5);
    expect(t.plans.need(t.plan.id).runs.channels?.passedAt).toBeDefined();
    expect(t.view().milestones.map((m) => m.state)).toEqual(['passed', 'running', 'later']);
  });

  it('step by step applies per milestone: Claude starts nothing there, but the other milestone runs', async () => {
    const t = await running({ ...SIDE, milestones: [{ ...SIDE.milestones[0]!, autonomy: 'step' }, ...SIDE.milestones.slice(1)] });
    expect(t.issue('Mentions').status).toBe('todo');
    expect(t.issue('Runner').status).toBe('in_progress');
    expect(t.view().next).toMatchObject({ kind: 'start', tasks: [{ task: { id: 'mentions' } }] });
    await expect(t.work.forRun('ws:main', 'p-me')!.tools!.start('mentions')).rejects.toThrow(/step by step/);
  });

  it('plan_write / plan_update take depends_on; plan_get says what runs alongside and after what', async () => {
    const write = milestoneInput({ id: 'b', title: 'B', criteria: [], depends_on: ['a'], tasks: [{ title: 'T', blocked_by: ['x'] }] });
    expect(write).toMatchObject({ dependsOn: ['a'], tasks: [{ title: 'T', blockedBy: ['x'] }] });
    expect(toOps([{ op: 'update_milestone', id: 'b', depends_on: [] }])).toEqual([{ op: 'update_milestone', id: 'b', dependsOn: [] }]);
    expect(toOps([{ op: 'add_milestone', milestone: { title: 'C', depends_on: ['b'] } }])[0]).toMatchObject({ op: 'add_milestone', milestone: { title: 'C', dependsOn: ['b'] } });
    const t = await running(SIDE);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.update(toOps([{ op: 'update_milestone', id: 'header', depends_on: [] }]));
    expect(t.plans.need(t.plan.id).draft!.milestones[2]!.dependsOn).toEqual([]);
    const got = tools.get();
    expect(got).toContain('Depends on no other milestone; runs alongside channels “Channels”, pilot “Parallel milestones”');
    t.work.discard(t.plan.id);
    expect(tools.get()).toContain('Runs after pilot “Parallel milestones”; runs alongside channels “Channels”.');
  });
});

describe('a task that builds on several unfinished tasks starts from their combined work', () => {
  /** Three tasks side by side; one builds on two of them, one on all three. */
  const STACK: BodyInput = {
    title: 'Stack',
    goal: '',
    milestones: [
      {
        id: 'm',
        title: 'Everything',
        criteria: ['works'],
        tasks: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'two', title: 'Two', blockedBy: ['a', 'b'] },
          { id: 'three', title: 'Three', blockedBy: ['a', 'b', 'c'] },
        ],
      },
    ],
  };

  async function running(combine: (key: string, branches: readonly string[]) => CombineResult) {
    const calls: Array<{ key: string; branches: readonly string[] }> = [];
    const t = setup({
      workers: 'task',
      combine: async (_p, key, branches) => {
        calls.push({ key, branches });
        return combine(key, branches);
      },
    });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'gated' }, t.claude);
    t.plans.setMaxParallel(plan.id, 5, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(STACK);
    t.work.approve(plan.id);
    await tick(5);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    const task = (id: string) => view().milestones[0]!.tasks.find((x) => x.task.id === id)!;
    const review = async (...titles: string[]) => {
      for (const title of titles) t.board.update(issue(title).id, { status: 'in_review' }, t.claude);
      await tick(10);
    };
    return { ...t, plan, issue, view, task, review, calls };
  }
  const ok = (key: string): CombineResult => ({ ok: true, branch: `klaud/${key.toLowerCase()}-base` });

  it('2 and 3 unmerged dependencies: each starts from a combined base, never “merge one first”', async () => {
    const t = await running(ok);
    await t.review('A', 'B');
    const [a, b, c] = ['A', 'B', 'C'].map((x) => t.issue(x));
    expect(t.calls[0]).toEqual({ key: t.issue('Two').key, branches: [a!.branch, b!.branch] });
    expect(t.made.at(-1)).toMatchObject({ base: `klaud/${t.issue('Two').key.toLowerCase()}-base`, quiet: true });
    expect(t.issue('Two').status).toBe('in_progress');
    await t.review('C');
    expect(t.calls[1]).toEqual({ key: t.issue('Three').key, branches: [a!.branch, b!.branch, c!.branch] });
    expect(t.made.at(-1)).toMatchObject({ base: `klaud/${t.issue('Three').key.toLowerCase()}-base` });
    expect(t.plans.need(t.plan.id).combining).toBeUndefined();
    expect(JSON.stringify(t.view())).not.toMatch(/merge one first/);
    expect(t.plans.need(t.plan.id).activity.map((e) => e.text).join('\n')).toContain(`combining ${a!.key} and ${b!.key} for ${t.issue('Two').key}`);
  });

  it('contained branches: the combine says one branch is enough, and that one is the start', async () => {
    const t = await running((_key, branches) => ({ ok: true, branch: branches[1]! }));
    await t.review('A', 'B');
    expect(t.made.at(-1)).toMatchObject({ base: t.issue('B').branch });
  });

  it('while combining, the task shows “Combining KLD-x and KLD-y …” and counts as under way', async () => {
    let release: (r: CombineResult) => void = () => undefined;
    const t = setup({ workers: 'task', combine: () => new Promise<CombineResult>((r) => (release = r)) });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'gated' }, t.claude);
    t.plans.setMaxParallel(plan.id, 5, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(STACK);
    t.work.approve(plan.id);
    await tick(5);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    for (const title of ['A', 'B']) t.board.update(issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    const two = planView(t.plans.need(plan.id), t.store.getState().board).milestones[0]!.tasks.find((x) => x.task.id === 'two')!;
    expect(two).toMatchObject({ state: 'running', step: `Combining ${issue('A').key} and ${issue('B').key} …` });
    release({ ok: true, branch: 'klaud/x-base' });
    await tick(10);
    expect(t.made.at(-1)).toMatchObject({ base: 'klaud/x-base' });
  });

  it('a conflict goes to the head Claude as a fix-up there; after its run it’s tried again and starts', async () => {
    let fixed = false;
    const t = await running((key) => (fixed ? ok(key) : { ok: false, branch: `klaud/${key.toLowerCase()}-base`, dir: '/tmp/.bases/p/two-base', merging: 'klaud/b', files: ['shared.txt'] }));
    const before = t.made.length;
    await t.review('A', 'B');
    expect(t.made).toHaveLength(before);
    expect(t.task('two')).toMatchObject({ state: 'running', step: `Combining ${t.issue('A').key} and ${t.issue('B').key}: the agent is fixing a conflict in shared.txt` });
    const fixup = t.asked.filter((a) => a.channel === 'ws:main' && a.prompt.includes('/tmp/.bases/p/two-base'));
    expect(fixup).toHaveLength(1);
    expect(fixup[0]!.prompt).toContain('shared.txt');
    expect(fixup[0]!.echo).toBe(false);
    // Nothing tries again while its run hasn't come and gone.
    await tick(10);
    expect(t.calls).toHaveLength(1);
    t.run('ws:main', 'started', 'fix-1');
    await tick(10);
    expect(t.calls).toHaveLength(1);
    fixed = true;
    t.run('ws:main', 'done', 'fix-1');
    await tick(10);
    expect(t.calls).toHaveLength(2);
    expect(t.made.at(-1)).toMatchObject({ base: `klaud/${t.issue('Two').key.toLowerCase()}-base` });
    expect(t.issue('Two').status).toBe('in_progress');
    expect(t.plans.need(t.plan.id).combining).toBeUndefined();
  });

  it('a conflict Claude can’t fix waits for you, saying where; Start (or fixing it) carries on', async () => {
    let fixed = false;
    const t = await running((key) => (fixed ? ok(key) : { ok: false, branch: 'b', dir: '/tmp/.bases/p/two-base', merging: 'klaud/b', files: ['shared.txt'] }));
    await t.review('A', 'B');
    for (const id of ['f1', 'f2']) {
      t.run('ws:main', 'started', id);
      await tick(10);
      t.run('ws:main', 'done', id);
      await tick(10);
    }
    expect(t.asked.filter((a) => a.prompt.includes('/tmp/.bases/p/two-base'))).toHaveLength(2);
    expect(t.task('two')).toMatchObject({ state: 'blocked' });
    expect(t.task('two').why).toBe(`Combining ${t.issue('A').key} and ${t.issue('B').key}: fix the conflict in shared.txt (in /tmp/.bases/p/two-base): it starts once no markers are left`);
    expect(t.view().active.map((x) => x.task.id)).not.toContain('two');
    fixed = true;
    expect(await t.work.startTask(t.plan.id, 'two')).toContain('Started');
    expect(t.issue('Two').status).toBe('in_progress');
  });
});

describe('the plan’s branch: tasks start from it, milestones merge into it, one PR at the end', () => {
  /** A fake of git and GitHub: what was asked, and what it answers. */
  function fakeGit() {
    const log = { pushed: [] as string[], ensured: [] as string[], merged: [] as Array<{ into: string; branches: readonly string[] }>, retired: [] as Array<{ ws: string; branch?: string }> };
    const existing = new Set<string>();
    const inMain = new Set<string>();
    let pr: PlanPr | undefined;
    let conflict: ((branches: readonly string[]) => CombineResult | undefined) | undefined;
    let mergeError: string | undefined;
    const git: PlanGit = {
      ensureBranch: async (_p, b) => {
        log.ensured.push(b);
        const made = !existing.has(b);
        existing.add(b);
        return { made };
      },
      mergeInto: async (_p, into, branches) => {
        log.merged.push({ into, branches });
        return conflict?.(branches) ?? { ok: true, branch: into };
      },
      inMain: async (_p, b) => inMain.has(b),
      retire: async (_p, ws, branch) => void log.retired.push({ ws: ws ?? '', ...(branch ? { branch } : {}) }),
      findPr: async () => pr,
      openPr: async (_p, _branch, title) => (pr = { number: 7, url: 'https://github.com/bob/api/pull/7', state: 'OPEN', title, draft: false, checks: 'pending' }),
      push: async (_p, b) => void log.pushed.push(b),
      mainRef: async () => 'origin/main',
      mergePr: async (_p, _n, opts) => {
        if (mergeError) throw new Error(mergeError);
        pr = opts?.auto ? { ...pr!, autoMerge: true } : { ...pr!, state: 'MERGED' };
      },
      mergeLocal: async () => ({ ok: true }),
    };
    return { git, log, existing, inMain, setPr: (p: PlanPr | undefined) => (pr = p), setConflict: (c: typeof conflict) => (conflict = c), failMerge: (why: string | undefined) => (mergeError = why) };
  }

  async function running(autonomy: 'gated' | 'autopilot' = 'gated', body: BodyInput = BODY) {
    const g = fakeGit();
    const t = setup({ git: g.git });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(body);
    t.work.approve(plan.id);
    // Its branch is made, then the milestone's Claude starts from it.
    for (let n = 0; n < 100 && t.made.length < 1; n++) await tick(5);
    await tick(10);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    /** Every task of the first milestone finished, and it passed. */
    const passSafe = async () => {
      for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(issue(title).id, { status: 'in_review' }, t.claude);
      await tick(10);
      t.board.update(issue('Receipts once').id, { status: 'in_review' }, t.claude);
      await tick(10);
      t.work.pass(plan.id, 'safe');
      await settle();
    };
    /** Until nothing is merging any more (or a conflict waits). */
    const settle = async () => {
      await tick(10);
      for (let n = 0; n < 100 && Object.values(t.plans.need(plan.id).merging ?? {}).some((m) => !m.conflict); n++) await tick(5);
      await tick(10);
    };
    return { ...t, ...g, plan, issue, view, passSafe, settle };
  }

  it('approval makes plan/<slug> from main, stored on the plan; every task starts from it', async () => {
    const t = await running();
    expect(t.log.ensured).toEqual(['plan/payments']);
    expect(t.plans.need(t.plan.id).branch).toBe('plan/payments');
    expect(t.plans.need(t.plan.id).activity.map((e) => e.text)).toContain('made the plan’s branch plan/payments from main');
    expect(t.made.map((m) => m.base)).toEqual(['plan/payments']);
  });

  it('a plan/<name> its text names (kept by hand before) is adopted, not made again', async () => {
    const g = fakeGit();
    g.existing.add('plan/klaud-polish-round');
    const t = setup({ git: g.git });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write({ ...BODY, title: 'Klaud polish round: menus, board, plans' });
    t.work.approve(plan.id);
    await tick(10);
    expect(g.log.ensured).toEqual(['plan/klaud-polish-round']);
    expect(t.plans.need(plan.id).activity.map((e) => e.text)).toContain('collects the plan’s work on plan/klaud-polish-round');
  });

  it('passing a milestone merges its task branches into the plan branch: tasks Merged into Plan, worktrees removed, no PR', async () => {
    const t = await running();
    await t.passSafe();
    const keys = ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once'].map((x) => t.issue(x));
    // One Claude, one branch: merged once, its worktree retired once.
    expect(new Set(keys.map((i) => i.branch)).size).toBe(1);
    expect(t.log.merged).toEqual([{ into: 'plan/payments', branches: [keys[0]!.branch] }]);
    for (const i of keys) {
      const now = t.issue(i.title);
      expect(now.status).toBe('in_plan');
      expect(now.activity.map((a) => a.text)).toContain('merged into plan/payments: “Safe payments” passed');
    }
    expect(t.log.retired).toEqual([{ ws: keys[0]!.worktrees.at(-1), branch: keys[0]!.branch }]);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    expect(t.plans.need(t.plan.id).pr).toBeUndefined();
    expect(t.view().milestones[0]!.tasks.map((x) => x.state)).toEqual(['planned', 'planned', 'planned']);
  });

  it('a milestone with a task still being worked on isn’t merged: the pass says why, and nothing is retired', async () => {
    const t = await running();
    for (const title of ['Idempotent webhooks', 'Receipts once']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    // “Auth on payment routes” has started (its worktree is there) but isn't finished.
    const open = t.issue('Auth on payment routes');
    expect(open).toMatchObject({ status: 'in_progress', worktrees: [expect.any(String)] });
    expect(() => t.work.pass(t.plan.id, 'safe')).toThrow(`“Safe payments” can’t be merged yet: ${open.key} is`);
    await t.settle();
    expect(t.log.merged).toEqual([]);
    expect(t.log.retired).toEqual([]);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeUndefined();
    // Finished: now it merges, and only In Review tasks are retired.
    t.board.update(open.id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.pass(t.plan.id, 'safe');
    await t.settle();
    expect(t.log.retired).toHaveLength(1);
  });

  it('tidy up answered No: nothing is merged or cleared away, and it isn’t offered again', async () => {
    const g = fakeGit();
    g.existing.add('plan/payments');
    const t = setup({ git: g.git });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once'].forEach((title, n) => {
      t.board.linkWorktree(issue(title).id, `old${n}`, { branch: `klaud/old-${n}` }, t.claude);
      t.board.update(issue(title).id, { status: 'in_review' }, t.claude);
    });
    t.plans.pass(plan.id, 'safe', t.me);
    for (let n = 0; n < 100 && !t.plans.need(plan.id).branch; n++) await tick(5);
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    expect(tidyOffer(view())).toHaveLength(3);
    t.work.tidyUp(plan.id, false);
    await tick(20);
    expect(tidyOffer(view())).toEqual([]);
    expect(g.log.merged).toEqual([]);
    expect(g.log.retired).toEqual([]);
    expect(issue('Idempotent webhooks').status).toBe('in_review');
  });

  it('a task of the next milestone starts from the plan branch as it is now (the passed work merged in)', async () => {
    const t = await running();
    await t.passSafe();
    expect(t.issue('Refund endpoint').status).toBe('in_progress');
    expect(t.made.at(-1)).toMatchObject({ base: 'plan/payments' });
    expect(t.view().milestones[1]!.tasks.find((x) => x.task.id === 'refund-api')?.base).toBeUndefined();
  });

  it('a conflict goes to the head Claude as a fix-up; the plan says so and the milestone stays open until it’s merged', async () => {
    const t = await running();
    let fixed = false;
    t.setConflict((branches) => (fixed ? undefined : { ok: false, branch: 'plan/payments', dir: '/tmp/.bases/p/plan-payments', merging: branches[0]!, files: ['src/webhooks.ts'] }));
    await t.passSafe();
    // The milestone's one branch (all its tasks') is named.
    const key = t.issue('Idempotent webhooks').branch;
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeUndefined();
    expect(t.view().next).toMatchObject({ kind: 'merging', text: `Fixing a merge conflict in ${key}` });
    expect(t.view().milestones[0]!.state).toBe('merging');
    expect(t.issue('Auth on payment routes').status).toBe('in_review');
    const fixup = t.asked.filter((a) => a.channel === 'ws:main' && a.prompt.includes('/tmp/.bases/p/plan-payments'));
    expect(fixup).toHaveLength(1);
    expect(fixup[0]!.prompt).toContain('src/webhooks.ts');
    expect(t.issue('Refund endpoint').status).not.toBe('in_progress');
    // Tried again once the head Claude's run came and went.
    t.run('ws:main', 'started', 'fix-1');
    await tick(10);
    expect(t.log.merged).toHaveLength(1);
    fixed = true;
    t.run('ws:main', 'done', 'fix-1');
    await t.settle();
    expect(t.log.merged).toHaveLength(2);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    expect(t.plans.need(t.plan.id).merging).toBeUndefined();
    expect(t.issue('Idempotent webhooks').status).toBe('in_plan');
  });

  it('on autopilot a passing check merges and moves on by itself', async () => {
    const t = await running('autopilot');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.board.update(t.issue('Receipts once').id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', 'ok');
    await t.settle();
    expect(t.log.merged).toHaveLength(1);
    expect(t.issue('Receipts once').status).toBe('in_plan');
  });

  it('the last milestone passing offers Open PR; the PR merging moves every Merged into Plan task to Done at once', async () => {
    const t = await running();
    await t.passSafe();
    t.board.update(t.issue('Refund endpoint').id, { status: 'in_review' }, t.claude);
    t.board.update(t.issue('Live keys').id, { status: 'canceled' }, t.me);
    await tick(10);
    t.work.pass(t.plan.id, 'refunds');
    await t.settle();
    expect(t.plans.need(t.plan.id).status).toBe('done');
    expect(t.view().next).toMatchObject({ kind: 'ship', branch: 'plan/payments' });
    await t.work.openPr(t.plan.id);
    expect(t.view().next).toMatchObject({ kind: 'ship', pr: { number: 7, state: 'OPEN' } });
    expect(t.issue('Refund endpoint').status).toBe('in_plan');
    t.setPr({ ...t.plans.need(t.plan.id).pr!, state: 'MERGED' });
    await t.work.pilot.pollPrs();
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once', 'Refund endpoint']) {
      expect(t.issue(title).status).toBe('done');
      expect(t.issue(title).activity.map((a) => a.text)).toContain('merged into main via #7');
    }
    expect(t.issue('Live keys').status).toBe('canceled');
    expect(t.plans.need(t.plan.id).shipped).toMatchObject({ how: 'pr', number: 7 });
    expect(t.view().next.kind).toBe('done');
  });

  it('a milestone whose merge fails (not a conflict) keeps why on it until it’s passed again', async () => {
    const t = await running();
    t.setConflict(() => {
      throw new Error('fatal: plan/payments is checked out with uncommitted changes\nmore');
    });
    await t.passSafe();
    const run = () => t.plans.need(t.plan.id).runs['safe'];
    expect(run()?.passedAt).toBeUndefined();
    expect(run()?.mergeFailed?.reason).toBe('fatal: plan/payments is checked out with uncommitted changes');
    t.setConflict(undefined);
    t.work.pass(t.plan.id, 'safe');
    expect(run()?.mergeFailed).toBeUndefined();
    await t.settle();
    expect(run()?.passedAt).toBeDefined();
  });

  it('on autopilot a failed merge (not a conflict) waits for Pass Again instead of passing it over and over', async () => {
    const t = await running('autopilot');
    let tries = 0;
    t.setConflict(() => {
      tries++;
      throw new Error('merge: beluga/kld-9 - not something we can merge');
    });
    for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.board.update(t.issue('Receipts once').id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', 'ok');
    await t.settle();
    await tick(50);
    const run = () => t.plans.need(t.plan.id).runs['safe'];
    expect(tries).toBe(1);
    expect(run()?.mergeFailed?.reason).toBe('merge: beluga/kld-9 - not something we can merge');
    expect(t.plans.need(t.plan.id).merging?.['safe']).toBeUndefined();
    t.setConflict(undefined);
    t.work.pass(t.plan.id, 'safe');
    await t.settle();
    expect(run()?.passedAt).toBeDefined();
  });

  /** On Autopilot: the first milestone finished, checked and passed by Autopilot, and its merge failed. */
  async function failedOnAutopilot() {
    const t = await running('autopilot');
    let tries = 0;
    t.setConflict(() => {
      tries++;
      throw new Error('fatal: plan/payments is checked out with uncommitted changes');
    });
    for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.board.update(t.issue('Receipts once').id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', 'ok');
    await t.settle();
    await tick(50);
    return { ...t, tries: () => tries, run: () => t.plans.need(t.plan.id).runs['safe'] };
  }

  it('on autopilot a failed merge is yours to pass again: the plan says so, and Needs You (the phone too) asks', async () => {
    const t = await failedOnAutopilot();
    expect(t.run()?.mergeFailed).toBeDefined();
    expect(t.view().next).toMatchObject({ kind: 'pass', milestone: { milestone: { id: 'safe' } } });
    const card = needsYou(t.store.getState()).find((n) => n.id === `plan:${t.plan.id}:pass:safe`);
    expect(card?.title).toBe('“Safe payments” couldn’t merge: pass it again?');
    expect(card?.detail).toBe('fatal: plan/payments is checked out with uncommitted changes');
    expect(card?.actions.map((a) => a.method)).toEqual(['plans.pass', 'plans.recheck']);
  });

  it('on autopilot a new round (Check Again) forgets the failed merge, and a passing check passes it again', async () => {
    const t = await failedOnAutopilot();
    expect(t.tries()).toBe(1);
    t.setConflict(undefined);
    t.work.recheck(t.plan.id, 'safe');
    expect(t.run()?.mergeFailed).toBeUndefined();
    expect(t.run()?.passedAt).toBeUndefined();
    await tick(20);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', 'ok again');
    await t.settle();
    await tick(50);
    expect(t.run()?.passedAt).toBeDefined();
    expect(t.log.merged.length).toBe(2);
  });

  it('Merge on GitHub pushes the branch first, asks GitHub again, and says GitHub’s no in plain words', async () => {
    const t = await running();
    await t.passSafe();
    await t.work.openPr(t.plan.id);
    t.log.pushed.length = 0;
    // GitHub says no: the reason in words, nothing shipped.
    t.failMerge('GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)');
    await expect(t.work.mergePr(t.plan.id)).rejects.toThrow(/approving review/);
    expect(t.log.pushed).toEqual(['plan/payments']);
    expect(t.plans.need(t.plan.id).shipped).toBeUndefined();
    // Merge When Checks Pass: queued, shown as auto-merge on.
    t.failMerge(undefined);
    await t.work.mergePr(t.plan.id, { auto: true });
    expect(t.plans.need(t.plan.id).pr).toMatchObject({ state: 'OPEN', autoMerge: true });
    expect(t.plans.need(t.plan.id).shipped).toBeUndefined();
    // Merged on GitHub meanwhile: the click finds it merged, and the plan ships.
    t.setPr({ ...t.plans.need(t.plan.id).pr!, state: 'MERGED' });
    await t.work.mergePr(t.plan.id);
    expect(t.plans.need(t.plan.id).shipped).toMatchObject({ how: 'pr', number: 7 });
  });

  it('a PR that conflicts with main: Resolve Conflicts merges main into the plan’s branch, a conflict goes to the plan’s Claude, then it’s pushed', async () => {
    const t = await running();
    await t.passSafe();
    await t.work.openPr(t.plan.id);
    let fixed = false;
    t.setConflict((branches) => (fixed || branches[0] !== 'origin/main' ? undefined : { ok: false, branch: 'plan/payments', dir: '/tmp/.bases/p/plan-payments', merging: 'origin/main', files: ['src/pay.ts'] }));
    t.log.pushed.length = 0;
    await t.work.bringInMain(t.plan.id);
    expect(t.plans.need(t.plan.id).mainMerge).toMatchObject({ main: 'origin/main', conflict: { files: ['src/pay.ts'] } });
    expect(t.asked.at(-1)?.prompt).toContain('merging origin/main into the plan\'s branch plan/payments');
    expect(t.log.pushed).toEqual([]);
    fixed = true;
    await t.work.bringInMain(t.plan.id);
    expect(t.plans.need(t.plan.id).mainMerge).toBeUndefined();
    expect(t.log.pushed).toEqual(['plan/payments']);
    expect(t.plans.need(t.plan.id).activity.map((e) => e.text)).toContain('merged origin/main into plan/payments');
  });

  it('a PR closed on GitHub is said at once on Merge, not merged', async () => {
    const t = await running();
    await t.passSafe();
    await t.work.openPr(t.plan.id);
    t.setPr({ ...t.plans.need(t.plan.id).pr!, state: 'CLOSED' });
    await expect(t.work.mergePr(t.plan.id)).rejects.toThrow(/closed on GitHub/);
    expect(t.plans.need(t.plan.id).pr?.state).toBe('CLOSED');
  });

  it('a PR closed without merging leaves its tasks Merged into Plan and says so on the plan', async () => {
    const t = await running();
    await t.passSafe();
    t.setPr({ number: 9, url: 'https://github.com/bob/api/pull/9', state: 'OPEN', title: 'Payments', draft: false, checks: 'none' });
    await t.work.pilot.pollPrs();
    t.setPr({ number: 9, url: 'https://github.com/bob/api/pull/9', state: 'CLOSED', title: 'Payments', draft: false, checks: 'none' });
    await t.work.pilot.pollPrs();
    expect(t.issue('Auth on payment routes').status).toBe('in_plan');
    expect(t.plans.need(t.plan.id).shipped).toBeUndefined();
    expect(t.plans.need(t.plan.id).activity.map((e) => e.text)).toContain('pull request #9 was closed without merging: its tasks stay merged into the plan');
  });

  it('a tick looks only at a PR that’s due (a conflict seen just now waits its beat); looking now sees it solved', async () => {
    const t = await running();
    await t.passSafe();
    await t.work.openPr(t.plan.id);
    const open = t.plans.need(t.plan.id).pr!;
    t.setPr({ ...open, conflicts: true });
    await t.work.pilot.pollPrs('tick');
    expect(t.plans.need(t.plan.id).pr?.conflicts).toBe(true);
    t.setPr({ ...open, conflicts: false });
    await t.work.pilot.pollPrs('tick');
    await t.work.pilot.pollPrs('focus');
    expect(t.plans.need(t.plan.id).pr?.conflicts).toBe(true);
    await t.work.pilot.pollPrs();
    expect(t.plans.need(t.plan.id).pr?.conflicts).toBeUndefined();
  });

  it('Merge into main locally: every Merged into Plan task is Done', async () => {
    const t = await running();
    await t.passSafe();
    await t.work.mergeLocal(t.plan.id);
    expect(t.issue('Auth on payment routes').status).toBe('done');
    expect(t.issue('Auth on payment routes').activity.map((a) => a.text)).toContain('merged into main here, with the plan');
    expect(t.plans.need(t.plan.id).shipped).toMatchObject({ how: 'local' });
  });

  it('a plan adopting a branch offers to tidy up, and only on Yes: a passed milestone still in review is merged (not passed again); tasks in main go to Done', async () => {
    const g = fakeGit();
    // Made by hand, before Klaud had plan branches.
    g.existing.add('plan/payments');
    const t = setup({ git: g.git });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    // What the plan looked like before (synchronously, before the pilot's first look).
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once'].forEach((title, n) => {
      t.board.linkWorktree(issue(title).id, `old${n}`, { branch: `klaud/old-${n}` }, t.claude);
      t.board.update(issue(title).id, { status: 'in_review' }, t.claude);
    });
    g.inMain.add('klaud/old-0');
    t.plans.pass(plan.id, 'safe', t.me);
    const passes = t.plans.need(plan.id).activity.filter((e) => e.kind === 'passed').length;
    for (let n = 0; n < 100 && !t.plans.need(plan.id).branch; n++) await tick(5);
    await tick(20);
    // Never by itself (nor after a restart): offered, with the list, until you say Yes.
    expect(g.log.merged).toEqual([]);
    expect(g.log.retired).toEqual([]);
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    expect(tidyOffer(view()).map((x) => x.issue!.title)).toEqual(['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']);
    t.work.tidyUp(plan.id, true);
    for (let n = 0; n < 100 && t.plans.need(plan.id).merging && Object.keys(t.plans.need(plan.id).merging!).length; n++) await tick(5);
    await tick(10);
    expect(tidyOffer(view())).toEqual([]);
    expect(g.log.ensured).toEqual(['plan/payments']);
    expect(g.log.merged).toEqual([{ into: 'plan/payments', branches: ['klaud/old-1', 'klaud/old-2'] }]);
    expect(issue('Auth on payment routes').status).toBe('done');
    expect(issue('Idempotent webhooks').status).toBe('in_plan');
    expect(issue('Receipts once').status).toBe('in_plan');
    expect(t.plans.need(plan.id).caughtUp).toBe(true);
    expect(t.plans.need(plan.id).activity.filter((e) => e.kind === 'passed' && e.text.startsWith('passed')).length).toBe(passes);
    // Once: nothing is merged again.
    t.work.pilot.schedule();
    await tick(20);
    expect(g.log.merged).toHaveLength(1);
  });

  it('Merged into Plan is a column of its own between In Review and Done; its worktree going away asks nothing', async () => {
    const t = await running();
    await t.passSafe();
    const i = t.issue('Auth on payment routes');
    t.board.worktreeGone(i.worktrees.at(-1)!, true, 'archived');
    expect(t.issue(i.title).worktreeGone).toBeUndefined();
    const { ISSUE_STATUSES, STATUS_INFO } = await import('../src/core/board/model.js');
    expect(ISSUE_STATUSES.slice(3, 6)).toEqual(['in_review', 'in_plan', 'done']);
    expect(STATUS_INFO.in_plan.label).toBe('Merged into Plan');
  });
});

describe('soak: a long plan on Autopilot reaches the end by itself, with Claudes that misbehave (BLG-473)', () => {
  // Five milestones, two side by side at the start, each with two or three tasks.
  const LONG: BodyInput = {
    title: 'Long run',
    goal: 'Ship it all',
    milestones: [
      { id: 'a', title: 'A', criteria: ['A works'], dependsOn: [], tasks: [{ id: 'a1', title: 'A one' }, { id: 'a2', title: 'A two', blockedBy: ['a1'] }] },
      { id: 'b', title: 'B', criteria: ['B works'], dependsOn: [], tasks: [{ id: 'b1', title: 'B one' }, { id: 'b2', title: 'B two' }] },
      { id: 'c', title: 'C', criteria: ['C works'], dependsOn: ['a'], tasks: [{ id: 'c1', title: 'C one' }, { id: 'c2', title: 'C two' }, { id: 'c3', title: 'C three', blockedBy: ['c1'] }] },
      { id: 'd', title: 'D', criteria: ['D works'], dependsOn: ['b', 'c'], tasks: [{ id: 'd1', title: 'D one' }, { id: 'd2', title: 'D two' }] },
      { id: 'e', title: 'E', criteria: ['E works'], dependsOn: ['d'], tasks: [{ id: 'e1', title: 'E one' }, { id: 'e2', title: 'E two' }] },
    ],
  } as BodyInput;

  it('Claudes that stop after one task or never answer, checks without a verdict, and a restart: it still gets there, never left to you', async () => {
    // A minute passes between looks; a milestone quiet for three is moved along.
    let clock = 1_000_000;
    const t = setup({ rescueMs: 3 * 60_000, now: () => clock });
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(LONG);
    let work = t.work;
    work.approve(plan.id);
    await tick(5);

    const sentTo = new Map<string, number>();
    // C's Claude never answers; D's checker never records a verdict.
    const deaf = new Set(['c']);
    const deafChecker = new Set(['d']);
    const checksOf = new Map<string, number>();
    let seen = 0;
    /** The fake Claudes answer what Beluga asked since they last looked, badly the first time. */
    const answer = (): void => {
      for (; seen < t.asked.length; seen++) {
        const { prompt, channel } = t.asked[seen]!;
        const now = t.plans.need(plan.id);
        const milestoneOf = Object.entries(now.runs).find(([, r]) => r?.agent && `ws:${r.agent.worktree}` === channel)?.[0];
        const checking = Object.entries(now.runs).find(([, r]) => r?.checker && `ws:${r.checker}` === channel)?.[0];
        const finish = (id: string, all: boolean): void => {
          const tasks = now.body!.milestones.find((m) => m.id === id)!.tasks.map((x) => t.board.need(x.issueId!)).filter((i) => i.status !== 'in_review' && i.status !== 'done' && i.status !== 'canceled');
          for (const i of all ? tasks : tasks.slice(0, 1)) t.board.update(i.id, { status: 'in_review' }, t.claude);
        };
        if (milestoneOf && deaf.has(milestoneOf)) {
          // This milestone's Claude never answers.
        } else if (milestoneOf) {
          // A milestone's Claude: the first time it does one task and stops; after that, all of them.
          const n = (sentTo.get(milestoneOf) ?? 0) + 1;
          sentTo.set(milestoneOf, n);
          finish(milestoneOf, n > 1);
        } else if (checking) {
          // A checker: its first turn ends without a verdict; the next one passes it.
          const n = (checksOf.get(checking) ?? 0) + 1;
          checksOf.set(checking, n);
          if (n > 1 && !deafChecker.has(checking)) work.forRun(channel, 'p-me')!.tools!.gate(checking, 'pass', 'Checked: works.');
        } else if (channel === 'ws:main' && prompt.includes('The plan has gone quiet')) {
          // The head Claude, asked to decide: it does what's stuck itself (the work, or the check).
          const about = prompt.split('\n')[0]!;
          for (const m of now.body!.milestones) {
            if (!about.includes(`“${m.title}”`)) continue;
            if (about.includes('the check of')) work.forRun('ws:main', 'p-me')!.tools!.gate(m.id, 'pass', 'Checked it myself.');
            else finish(m.id, true);
          }
        }
      }
    };

    for (let i = 0; i < 600 && t.plans.need(plan.id).status !== 'done'; i++) {
      answer();
      // A restart partway: everything Beluga kept in memory is gone, the plan and the board stay.
      if (i === 40) {
        work.stop();
        work = new PlansWork({ store: t.store, plans: t.plans, board: t.boardWork, controller: t.controller, askClaude: (prompt, channel, echo) => `ask-${t.asked.push({ prompt, channel, echo })}`, intend: () => undefined, delayMs: 0, rescueMs: 3 * 60_000, now: () => clock });
      }
      clock += 60_000;
      work.pilot.tick();
      await tick(3);
    }
    work.stop();
    const done = t.plans.need(plan.id);
    expect(done.status).toBe('done');
    expect(Object.values(done.runs).every((r) => r?.passedAt)).toBe(true);
    // It had to be moved along, and was never left to you.
    expect(done.activity.some((a) => a.text.includes(' went quiet: '))).toBe(true);
    expect(done.activity.some((a) => a.text.startsWith('Stuck on'))).toBe(false);
    expect(Object.values(done.rescue ?? {}).some((r) => r.yours)).toBe(false);
    // Every rung was needed somewhere: sent on, woken, started over, asked again, a fresh checker, the head Claude.
    const said = done.activity.map((a) => a.text).join('\n');
    for (const rung of ['sent the Claude doing', 'woke BOB-', 'started it again', 'asked for the check of', 'to a fresh checker', 'asked the plan’s Claude to decide']) expect(said).toContain(rung);
    // Its epics followed it: every milestone's is In Review (merged into the plan with no branch here, then done once shipped).
    for (const id of Object.values(done.epics!.milestones)) expect(['in_review', 'in_plan', 'done']).toContain(t.board.need(id).status);
  });
});
