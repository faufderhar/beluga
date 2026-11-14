import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import type { PlanGit } from '../src/core/plans/plan-git.js';
import { Plans } from '../src/core/plans/plans.js';
import { taskOrder } from '../src/core/plans/progress.js';
import { PlansWork, type PlansWorkDeps } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-7: one Claude per milestone (one worktree doing its tasks in order); BLG-16: Pass Anyway is instant. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take card payments safely.',
  milestones: [
    {
      id: 'safe',
      title: 'Safe payments',
      goal: 'Nobody pays twice.',
      criteria: ['401 without a session', 'A replayed webhook charges once'],
      tasks: [
        { id: 'receipts', title: 'Receipts once', blockedBy: ['retries'], touches: ['src/email'] },
        { id: 'auth', title: 'Auth on payment routes', goal: 'Only signed-in users pay.', context: 'Routes live in src/routes/pay.ts.', acceptance: ['401 without session'], touches: ['src/auth'] },
        { id: 'retries', title: 'Idempotent webhooks', acceptance: '- [ ] each event once\n- [ ] backoff', touches: ['src/webhooks'] },
      ],
    },
    { id: 'admin', title: 'Admin page', criteria: ['drawn'], dependsOn: [], tasks: [{ id: 'page', title: 'Admin page', touches: ['src/admin'] }] },
    { id: 'refunds', title: 'Refunds', criteria: ['A refund works end to end'], dependsOn: ['safe'], tasks: [{ id: 'keys', title: 'Live keys', assignee: 'me' }, { id: 'refund-api', title: 'Refund endpoint', blockedBy: ['keys'] }, { id: 'refund-ui', title: 'Refund button' }] },
  ],
};

function setup(opts: { workers?: 'milestone' | 'task'; git?: PlanGit; delayMs?: number; forYou?: PlansWorkDeps['forYou']; cancel?: PlansWorkDeps['cancel'] } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const asked: Array<{ prompt: string; channel: string; id: string }> = [];
  const made: Array<{ name: string; base?: string; quiet?: boolean }> = [];
  let n = 0;
  const add = (w: Workspace): void => {
    store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  };
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string, o: { base?: string; quiet?: boolean } = {}) => {
      made.push({ name, ...o });
      const w = ws(`w${++n}`, projectId, name);
      add(w);
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const ask = (prompt: string, channel: string): string => {
    const id = `ask-${asked.length + 1}`;
    asked.push({ prompt, channel, id });
    return id;
  };
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void ask(prompt, channel) });
  const plans = new Plans({ store, dir: null });
  const work = new PlansWork({
    store,
    plans,
    board: boardWork,
    controller,
    git: opts.git ?? null,
    askClaude: (prompt, channel) => ask(prompt, channel),
    intend: () => undefined,
    delayMs: opts.delayMs ?? 0,
    ...(opts.workers ? { workers: opts.workers } : {}),
    ...(opts.forYou ? { forYou: opts.forYou } : {}),
    ...(opts.cancel ? { cancel: opts.cancel } : {}),
  });
  const claude = boardWork.myClaude();
  const me = boardWork.me();
  const run = (channel: string, status: 'started' | 'done', id = `r-${Math.random()}`): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId: id, requester: 'p-me', event: status, text: '', ts: Date.now(), channel });
  const issue = (title: string) => store.getState().board.issues.find((i) => i.title === title)!;
  return { store, board, boardWork, plans, work, asked, made, claude, me, run, issue };
}

async function running(opts: Parameters<typeof setup>[0] & { autonomy?: 'step' | 'gated' | 'autopilot'; maxParallel?: number; body?: BodyInput } = {}) {
  const t = setup(opts);
  const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: opts.autonomy ?? 'gated' }, t.claude);
  t.plans.setMaxParallel(plan.id, opts.maxParallel ?? 3, t.me);
  t.work.forRun('ws:main', 'p-me')!.tools!.write(opts.body ?? BODY);
  t.work.approve(plan.id);
  await tick(10);
  // As the pilot sees it (who's working right now, from the log).
  const view = () => t.work.pilot.view(t.plans.need(plan.id));
  const agent = (m: string) => t.plans.need(plan.id).runs[m]?.agent;
  const toAgent = (m: string) => t.asked.filter((a) => a.channel === `ws:${agent(m)?.worktree}`);
  /** The milestone's Claude, as its own runs see the task tools. */
  const tools = (m: string) => t.boardWork.forRun(`ws:${agent(m)!.worktree}`, 'p-me')!;
  return { ...t, plan, view, agent, toAgent, tools };
}

describe('one Claude per milestone (BLG-7)', () => {
  it('an open milestone gets one worktree and one Claude, with every task of it linked in the order they build on each other', async () => {
    const t = await running();
    // Two independent milestones open side by side, each with its own Claude; Refunds waits on Safe payments.
    expect(t.made).toHaveLength(2);
    expect(t.made.every((m) => m.quiet)).toBe(true);
    const safe = t.agent('safe')!;
    expect(safe.tasks).toEqual(['auth', 'retries', 'receipts']);
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) expect(t.issue(title).worktrees).toEqual([safe.worktree]);
    // The first ready one is under way; the others are queued for the same Claude.
    expect(t.issue('Auth on payment routes').status).toBe('in_progress');
    expect(t.issue('Idempotent webhooks').status).toBe('todo');
    const m = t.view().milestones[0]!;
    expect(m.agent?.worktree).toBe(safe.worktree);
    expect(m.tasks.find((x) => x.task.id === 'retries')).toMatchObject({ state: 'ready', queued: true, worktree: safe.worktree });
    expect(m.tasks.find((x) => x.task.id === 'receipts')).toMatchObject({ state: 'blocked' });
    expect(taskOrder(m).map((x) => x.task.id)).toEqual(['auth', 'retries', 'receipts']);
    expect(t.agent('refunds')).toBeUndefined();
    expect(t.issue('Refund endpoint').status).toBe('backlog');
  });

  it('its brief is lean: plan and milestone goals, criteria, the tasks in order with their briefs and files, and how to go fast', async () => {
    const t = await running();
    const [first] = t.toAgent('safe');
    expect(t.toAgent('safe')).toHaveLength(1);
    const p = first!.prompt;
    const keys = ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once'].map((x) => t.issue(x).key);
    expect(p).toContain('You are the one agent doing milestone 1 “Safe payments” of the plan “Payments”');
    expect(p).toContain('Plan goal: Take card payments safely.');
    expect(p).toContain('Milestone goal: Nobody pays twice.');
    expect(p).toContain('- A replayed webhook charges once');
    expect(p.indexOf(`1. ${keys[0]}`)).toBeLessThan(p.indexOf(`2. ${keys[1]}`));
    expect(p.indexOf(`2. ${keys[1]}`)).toBeLessThan(p.indexOf(`3. ${keys[2]}`));
    expect(p).toContain(`after ${keys[1]}`);
    expect(p).toContain('Goal: Only signed-in users pay.');
    expect(p).toContain('Context: Routes live in src/routes/pay.ts.');
    expect(p).toContain('Files: src/webhooks');
    expect(p).toContain('- [ ] each event once');
    expect(p).toMatch(/don't survey the codebase/);
    expect(p).toContain('one commit per task');
    expect(p).toContain('status in_progress');
    expect(p).toContain('status in_review');
    expect(p).toContain('No pull requests');
    // What only the user can do is asked with a card; nothing promises Beluga asks for a request written out.
    expect(p).toContain('ask them with AskUserQuestion');
    expect(p).not.toContain('Beluga asks them');
    // The other milestone's Claude works beside it.
    expect(p).toContain('“Admin page”: src/admin');
  });

  it('the plan’s limit counts milestones at work', async () => {
    const t = await running({ maxParallel: 1 });
    expect(t.made).toHaveLength(1);
    expect(t.agent('admin')).toBeUndefined();
  });

  it('task statuses still move one by one: its Claude moves each along with the task tools, in its own worktree', async () => {
    const t = await running();
    const w = `ws:${t.agent('safe')!.worktree}`;
    const run = t.tools('safe');
    // The run's own instructions are the milestone's; the task tools point at the task it's on.
    expect(run.brief).toContain('<beluga_milestone>');
    expect(run.brief).toContain('you are its one agent');
    expect(run.tools!.current).toBe(t.issue('Auth on payment routes').key);
    t.run(w, 'started', 'm-1');
    expect(t.view().milestones[0]!.tasks.find((x) => x.task.id === 'auth')!.state).toBe('running');
    run.tools!.editBrief(t.issue('Auth on payment routes').key, 'acceptance', '- [x] 401 without session');
    run.tools!.update(t.issue('Auth on payment routes').key, { status: 'in_review' });
    run.tools!.update(t.issue('Idempotent webhooks').key, { status: 'in_progress' });
    const tasks = t.view().milestones[0]!.tasks;
    expect(tasks.find((x) => x.task.id === 'auth')!.state).toBe('review');
    expect(tasks.find((x) => x.task.id === 'retries')!.state).toBe('running');
    expect(tasks.find((x) => x.task.id === 'receipts')!.state).toBe('blocked');
    // Proof goes on the task it's for.
    run.tools!.attachProof(t.issue('Auth on payment routes').key, { title: 'auth test', url: 'https://ci/1' } as never);
    expect(t.issue('Auth on payment routes').proof?.map((x) => x.title) ?? []).toContain('auth test');
    // No new worktree for the next task.
    await tick(10);
    expect(t.made).toHaveLength(2);
  });

  it('its turn ending with tasks left: it’s sent on once; stopping again with the same tasks left, it’s yours', async () => {
    const t = await running();
    const w = `ws:${t.agent('safe')!.worktree}`;
    const run = t.tools('safe');
    t.run(w, 'started', 'm-1');
    run.tools!.editBrief(t.issue('Auth on payment routes').key, 'acceptance', '- [x] 401 without session');
    run.tools!.update(t.issue('Auth on payment routes').key, { status: 'in_review' });
    t.run(w, 'done', 'm-1');
    await tick(10);
    const sent = t.toAgent('safe');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.prompt).toContain('Go on with the next one');
    expect(sent[1]!.prompt).toContain(`1. ${t.issue('Idempotent webhooks').key}`);
    // Its run for that comes and goes without beginning it.
    t.run(w, 'started', 'm-2');
    await tick(10);
    t.run(w, 'done', 'm-2');
    await tick(10);
    expect(t.toAgent('safe')).toHaveLength(2);
    expect(t.plans.need(t.plan.id).activity.filter((a) => a.kind === 'problem').map((a) => a.text)).toEqual([expect.stringContaining('the agent doing “Safe payments” stopped again')]);
  });

  it('tasks for you are never its: they wait for you, the hook hears of them once, and its brief says to skip them', async () => {
    const told: string[][] = [];
    const t = await running({ forYou: (_plan, tasks) => void told.push(tasks.map((x) => x.task.id)) });
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.pass(t.plan.id, 'safe');
    await tick(10);
    await tick(10);
    expect(told).toEqual([['keys']]);
    const refunds = t.agent('refunds')!;
    // “Refund endpoint” waits on your task; “Refund button” doesn't, so the Claude starts with it.
    expect(refunds.tasks).toEqual(['refund-ui', 'refund-api']);
    expect(t.issue('Live keys').worktrees).toEqual([]);
    expect(t.issue('Live keys').status).toBe('todo');
    expect(t.issue('Refund button').status).toBe('in_progress');
    const p = t.toAgent('refunds')[0]!.prompt;
    expect(p).toContain(`For the user, not you (skip them`);
    expect(p).toContain(`${t.issue('Live keys').key} “Live keys”`);
    expect(t.plans.need(t.plan.id).activity.map((a) => a.text)).toContain(`${t.issue('Live keys').key} “Live keys” waits for you: only you can do it, so its milestone’s agent leaves it to you`);
    await tick(10);
    expect(told).toHaveLength(1);
  });

  it('fix tasks added after a failed check go to the same Claude, and it’s told about them', async () => {
    const t = await running({ autonomy: 'autopilot' });
    const w = `ws:${t.agent('safe')!.worktree}`;
    t.run(w, 'started', 'm-1');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    t.run(w, 'done', 'm-1');
    await tick(10);
    await tick(10);
    const head = t.work.forRun('ws:main', 'p-me')!.tools!;
    head.gate('safe', 'fail', 'replay sends two receipts');
    head.update([{ op: 'add_task', milestone: 'safe', task: { id: 'fix', title: 'Fix double receipts' } }]);
    await tick(10);
    expect(t.issue('Fix double receipts').worktrees).toEqual([t.agent('safe')!.worktree]);
    expect(t.agent('safe')!.tasks).toContain('fix');
    expect(t.toAgent('safe').at(-1)!.prompt).toContain('More tasks for “Safe payments”');
    expect(t.made).toHaveLength(2);
  });

  it('step by step: nothing starts by itself; Start gives that one task to the milestone’s Claude (started for it the first time)', async () => {
    const t = await running({ autonomy: 'step' });
    expect(t.made).toHaveLength(0);
    expect(await t.work.startTask(t.plan.id, 'auth')).toMatch(/^Started one agent for “Safe payments” \([A-Z]+-\d+\)/);
    expect(t.agent('safe')!.tasks).toEqual(['auth']);
    expect(t.toAgent('safe')[0]!.prompt).toContain('do only the task(s) you were given');
    expect(t.issue('Idempotent webhooks').worktrees).toEqual([]);
    await tick(10);
    expect(await t.work.startTask(t.plan.id, 'retries')).toContain('to the agent doing “Safe payments”');
    expect(t.made).toHaveLength(1);
    expect(t.issue('Idempotent webhooks').worktrees).toEqual([t.agent('safe')!.worktree]);
    expect(t.toAgent('safe').at(-1)!.prompt).toContain(`The user started ${t.issue('Idempotent webhooks').key}`);
  });

  it('a task already under way in a worktree of its own stays there: the milestone’s Claude gets the rest', async () => {
    const t = setup();
    const old = t.board.create({ projectId: 'api', title: 'Old auth', status: 'in_progress' }, t.me);
    t.board.linkWorktree(old.id, 'old-ws', { branch: 'klaud/old' }, t.me);
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write({ title: 'P', goal: '', milestones: [{ id: 'm', title: 'M', tasks: [{ title: 'Old auth', issue: old.key } as never, { id: 'b', title: 'B' }] }] });
    t.work.approve(plan.id);
    await tick(10);
    expect(t.board.need(old.id).worktrees).toEqual(['old-ws']);
    expect(t.plans.need(plan.id).runs.m?.agent?.tasks).toEqual(['b']);
  });

  it('workers: task keeps the older way, a worktree per task', async () => {
    const t = await running({ workers: 'task' });
    expect(t.made.length).toBeGreaterThan(2);
    expect(t.agent('safe')).toBeUndefined();
  });
});

describe('Pass Anyway is instant (BLG-16)', () => {
  function fakeGit(retire: () => Promise<void> = async () => undefined) {
    const merged: Array<readonly string[]> = [];
    const git: PlanGit = {
      ensureBranch: async () => ({ made: true }),
      mergeInto: async (_p, into, branches) => (merged.push(branches), { ok: true, branch: into }),
      inMain: async () => false,
      retire,
      findPr: async () => undefined,
      openPr: async () => {
        throw new Error('no');
      },
      push: async () => undefined,
      mainRef: async () => 'origin/main',
      mergePr: async () => undefined,
      mergeLocal: async () => ({ ok: true }),
    };
    return { git, merged };
  }

  /** Every task of “Safe payments” in review, and the head Claude checking it (its run under way). */
  async function checking(opts: Parameters<typeof setup>[0] = {}) {
    const t = await running(opts);
    // (The pilot looks only when told to here, when its next look is far away.)
    for (let n = 0; n < 100 && !t.agent('safe'); n++) {
      t.work.pilot.tick();
      await tick(5);
    }
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(t.issue(title).id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.pilot.tick();
    // (Asking a check is a moment's work: its own conversation first; this fake makes none, so the head checks.)
    await tick(5);
    const check = t.asked.find((a) => a.channel === 'ws:main' && a.prompt.includes('Check its pass criteria'))!;
    expect(check).toBeDefined();
    t.run('ws:main', 'started', check.id);
    expect(t.view().milestones[0]!.state).toBe('checking');
    return { ...t, check };
  }

  it('applies at once: the check under way is stopped, the merge starts without waiting for the next look, a late verdict is ignored', async () => {
    const cancelled: string[] = [];
    const g = fakeGit();
    const t = await checking({ git: g.git, cancel: (id) => void cancelled.push(id), delayMs: 60_000 });
    const plan = t.work.pass(t.plan.id, 'safe');
    // Said at once, before anything slow.
    expect(plan.merging?.safe).toBeDefined();
    expect(t.view().milestones[0]!.state).toBe('merging');
    expect(cancelled).toEqual([t.check.id]);
    // The merge runs now (not a tick from now: the next look is a minute away here).
    await tick(5);
    expect(g.merged).toHaveLength(1);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    expect(t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'fail', 'too late')).toContain('already passed');
    expect(t.plans.need(t.plan.id).runs.safe?.check).toBeUndefined();
  });

  it('a check that already came back (failed) isn’t stopped: there’s nothing running', async () => {
    const cancelled: string[] = [];
    const t = await checking({ cancel: (id) => void cancelled.push(id) });
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'fail', 'one criterion open');
    t.run('ws:main', 'done', t.check.id);
    t.work.pass(t.plan.id, 'safe');
    expect(cancelled).toEqual([]);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
  });

  it('clearing away a passed milestone’s worktree doesn’t hold up the next merge', async () => {
    const g = fakeGit(() => new Promise<void>(() => undefined));
    const t = await checking({ git: g.git });
    t.work.pass(t.plan.id, 'safe');
    for (let n = 0; n < 100 && !t.plans.need(t.plan.id).runs.safe?.passedAt; n++) await tick(5);
    // The other milestone finishes and passes while the first one's archive still hangs.
    for (let n = 0; n < 100 && !t.agent('admin'); n++) await tick(5);
    t.board.update(t.issue('Admin page').id, { status: 'in_review' }, t.claude);
    await tick(10);
    t.work.pass(t.plan.id, 'admin');
    for (let n = 0; n < 100 && !t.plans.need(t.plan.id).runs.admin?.passedAt; n++) await tick(5);
    expect(g.merged).toHaveLength(2);
    expect(t.plans.need(t.plan.id).runs.admin?.passedAt).toBeDefined();
  });
});
