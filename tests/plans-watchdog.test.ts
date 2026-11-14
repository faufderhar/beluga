import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { planView, liveFrom } from '../src/core/plans/progress.js';
import { COMMAND_LIMIT_MS, REPEAT_MS, STALL_MS, STEER_UNREAD_MS, assess, pulseOf, pulseWords, saidLast, stepWords, waitingWords, waitsNote } from '../src/core/plans/watchdog.js';
import { NOTE_MAX } from '../src/core/plans/model.js';
import { progressCount } from '../src/shared/progress-count.js';
import { READS_AFTER_STEP } from '../src/shared/claude-notices.js';
import { needsYou } from '../src/companion/needs-you.js';
import { headline, nextWords } from '../packages/mac/src/plans/plans-model.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** The watchdog: a plan task whose Claude stopped without finishing is woken once, then it asks you. */

const MIN = 60_000;
const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [{ id: 'safe', title: 'Safe payments', criteria: ['works'], tasks: [{ id: 'auth', title: 'Auth on payment routes', acceptance: ['401 without session', 'tests pass'] }] }],
};

async function running(opts: { waited?: readonly string[]; promoteOk?: boolean; rescueMs?: number } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)])] });
  let n = 0;
  const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => (listeners.push(l), () => undefined),
    newWorktree: async (projectId: string, name: string) => {
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
  } as unknown as WorkspaceController;
  const asked: Array<{ prompt: string; channel: string }> = [];
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void asked.push({ prompt, channel }) });
  const plans = new Plans({ store, dir: null });
  let now = Date.now();
  let alive = false;
  const tookOver: string[] = [];
  const promoted: string[] = [];
  const work = new PlansWork({
    store,
    plans,
    board: boardWork,
    controller,
    git: null,
    // Each ask is a request (its id is how a steered message is followed).
    askClaude: (prompt, channel) => `q${asked.push({ prompt, channel })}`,
    promote: (requestId) => (promoted.push(requestId), opts.promoteOk ?? true),
    intend: () => undefined,
    alive: () => alive,
    takeOver: async (channel) => (tookOver.push(channel), opts.waited ?? []),
    now: () => now,
    delayMs: 0,
    // The watchdog alone here; the plan's rescue has its own tests below.
    rescueMs: opts.rescueMs ?? Number.POSITIVE_INFINITY,
  });
  const claude = boardWork.myClaude();
  const plan = plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'gated' }, claude);
  work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
  work.approve(plan.id);
  await tick(5);
  const issue = () => store.getState().board.issues.find((i) => i.title === 'Auth on payment routes')!;
  const channel = `ws:${issue().worktrees.at(-1)}`;
  let seq = 0;
  /** An event of a run of Claude's in the task's worktree, at the test's clock. */
  const event = (requestId: string, kind: 'queued' | 'started' | 'tool' | 'text' | 'progress' | 'done' | 'error', text = ''): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId, requester: 'p-me', event: kind, text, ts: now, channel });
  const newRun = (): string => `r${++seq}`;
  /** Let time pass, then let the pilot look. */
  const later = async (ms: number): Promise<void> => {
    now += ms;
    work.pilot.tick();
    await tick(2);
  };
  const wakes = () => asked.filter((a) => a.channel === channel && a.prompt.startsWith('You stopped before handing off'));
  const view = () => planView(plans.need(plan.id), store.getState().board, liveFrom(store.getState()));
  const task = () => view().milestones[0]!.tasks[0]!;
  /** The head Claude's plan_message_task. */
  const message = (text: string, mode?: 'queue' | 'steer'): string => work.forRun('ws:main', 'p-me')!.tools!.message('auth', text, mode);
  return { store, plans, work, plan, issue, channel, event, newRun, later, wakes, view, task, asked, tookOver, promoted, message, setAlive: (a: boolean) => (alive = a), board, claude };
}

describe('a stalled task is woken once, then it asks you', () => {
  it('a turn that ends without In Review: one wake, with where it was; told in the plan feed and header', async () => {
    const t = await running();
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Edit src/auth.ts');
    t.event(r, 'text', 'Auth middleware is in; tests next.');
    t.event(r, 'done', 'Auth middleware is in; tests next.');
    expect(t.task().pulse).toMatchObject({ kind: 'stopped', reason: 'it ended its turn without handing off' });
    await t.later(1000);
    expect(t.wakes()).toHaveLength(1);
    const prompt = t.wakes()[0]!.prompt;
    expect(prompt).toContain(`${t.issue().key} “Auth on payment routes” (it ended its turn without handing off)`);
    expect(prompt).toContain('Your last step: Edit src/auth.ts');
    expect(prompt).toContain('tests next');
    expect(prompt).toContain('“401 without session”');
    expect(prompt).toContain('task_update with status in_review');
    // Waiting on you is asked with a card, never written out with the turn ended (that only loops).
    expect(prompt).toContain('AskUserQuestion');
    expect(prompt).not.toContain('Beluga asks them');
    const plan = t.plans.need(t.plan.id);
    expect(plan.activity.at(-1)?.text).toMatch(new RegExp(`${t.issue().key} stopped, woke it at \\d\\d:\\d\\d`));
    // The wake's run hasn't started yet: never woken twice.
    await t.later(MIN);
    expect(t.wakes()).toHaveLength(1);
    // Working again: the header's one line says what happened.
    const r2 = t.newRun();
    t.event(r2, 'started');
    t.event(r2, 'tool', 'Bash npm test');
    const next = t.view().next;
    expect(next.kind).toBe('working');
    expect(next.kind === 'working' && next.note).toMatch(/stopped, woke it at/);
  });

  it('its Claude Code process gone mid-turn: woken', async () => {
    const t = await running();
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Read src/auth.ts');
    t.setAlive(true);
    await t.later(MIN);
    expect(t.wakes()).toHaveLength(0);
    // The log still says it's working, but the runner has no run there.
    t.setAlive(false);
    await t.later(1000);
    expect(t.wakes()).toHaveLength(1);
    expect(t.wakes()[0]!.prompt).toContain('its Claude Code process ended mid-turn');
    expect(t.tookOver).toEqual([t.channel]);
  });

  it('a second stall within 30 minutes: Needs you, with the reason and Resume', async () => {
    const t = await running();
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'done', 'Partway.');
    await t.later(1000);
    expect(t.wakes()).toHaveLength(1);
    // The wake runs, and stops short again.
    await t.later(MIN);
    const r2 = t.newRun();
    t.event(r2, 'started');
    t.event(r2, 'done', 'Still partway.');
    await t.later(5 * MIN);
    expect(t.wakes()).toHaveLength(1);
    const v = t.view();
    expect(t.task().state).toBe('stalled');
    expect(t.task().watch).toMatchObject({ needsYou: true, reason: 'it ended its turn without handing off' });
    expect(v.next.kind).toBe('stalled');
    expect(pulseWords(t.task().pulse!, Date.now())).toMatchObject({ label: 'Needs you' });
    expect(t.plans.need(t.plan.id).activity.at(-1)?.text).toContain('stopped again: it ended its turn without handing off');
    // What it said last is kept and shown: often what it waits on you for.
    expect(t.task().watch?.said).toBe('Still partway.');
    expect(t.plans.need(t.plan.id).activity.at(-1)?.text).toContain('It waits for you: do what it asks (or answer in its chat), then Resume it. It said: “Still partway.”');
    expect(v.next.kind === 'stalled' && v.next.tasks[0]?.watch?.said).toBe('Still partway.');
    // The Mac's button still says what it does (Resume); what it said is beside it, and in the plan's sentence.
    expect(nextWords(v.next)).toEqual({ title: `Resume ${t.issue().key}`, detail: 'It says: “Still partway.”' });
    expect(headline(v)).toEqual({ who: 'you', text: `Resume ${t.issue().key} once you’ve done what it asks: “Still partway.”` });
    expect(needsYou(t.store.getState()).find((n) => n.id.includes(':stalled:'))).toMatchObject({
      title: '“Auth on payment routes” needs you',
      detail: 'It says: “Still partway.” Do what it asks, then Resume it.',
      actions: [{ label: 'Resume', method: 'plans.resumeTask' }],
    });
    // It stays yours: nothing wakes it behind your back.
    await t.later(REPEAT_MS);
    expect(t.wakes()).toHaveLength(1);
    // Resume: woken now, and no longer waiting for you.
    expect(t.work.resumeTask(t.plan.id, 'auth')).toContain('Resumed');
    await tick(2);
    expect(t.wakes()).toHaveLength(2);
    expect(t.task().state).toBe('idle');
    expect(t.task().watch?.needsYou).toBeUndefined();
  });

  it('a stall long after the last wake is woken again (not Needs you)', async () => {
    const t = await running();
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'done');
    await t.later(1000);
    await t.later(MIN);
    const r2 = t.newRun();
    t.event(r2, 'started');
    t.event(r2, 'tool', 'Bash npm test');
    await t.later(REPEAT_MS + MIN);
    t.event(r2, 'done');
    await t.later(1000);
    expect(t.wakes()).toHaveLength(2);
    expect(t.task().state).toBe('idle');
  });

  it('a long command is no false alarm; 20 minutes with no new step outside one is a stall', async () => {
    const t = await running();
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npm run test:e2e');
    await t.later(40 * MIN);
    expect(t.wakes()).toHaveLength(0);
    expect(t.task().pulse).toMatchObject({ kind: 'command', step: 'Running npm run test:e2e' });
    expect(pulseWords(t.task().pulse!, t.task().pulse!.kind === 'command' ? (t.task().pulse as { since: number }).since + 12 * MIN : 0)).toMatchObject({ label: 'Running a long command', sub: 'Running npm run test:e2e · 12m' });
    // The command finished and Claude moved on to a quick step, then nothing for 20 minutes.
    t.event(r, 'tool', 'Read src/auth.ts');
    await t.later(STALL_MS - MIN);
    expect(t.wakes()).toHaveLength(0);
    await t.later(2 * MIN);
    expect(t.wakes()).toHaveLength(1);
    expect(t.wakes()[0]!.prompt).toContain('no new step for 21m');
  });

  it('the wake carries the messages that waited behind the stalled run', async () => {
    const t = await running({ waited: ['A message from the head of the plan “Payments”:\n\nUse the shared session helper.'] });
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'done');
    await t.later(1000);
    expect(t.wakes()[0]!.prompt).toContain('Messages that waited for you while you were stopped');
    expect(t.wakes()[0]!.prompt).toContain('Use the shared session helper.');
  });

  it('In Review, asking you, stopped by you, or you talking with it: nobody is woken', async () => {
    const t = await running();
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'error', 'Stopped by owner');
    await t.later(1000);
    expect(t.wakes()).toHaveLength(0);
    expect(t.task().pulse).toMatchObject({ kind: 'stopped', reason: 'you stopped it' });
    // You write in its chat and it answers: that's you talking with it.
    t.store.dispatch({ type: 'chat', id: 'm1', from: 'p-me', text: 'why this way?', ts: Date.now(), byAgent: false, channel: t.channel } as never);
    const r2 = t.newRun();
    t.event(r2, 'started');
    t.event(r2, 'done', 'Because…');
    await t.later(1000);
    expect(t.wakes()).toHaveLength(0);
    // Finished: the watch goes.
    t.board.update(t.issue().id, { status: 'in_review' }, t.claude);
    await t.later(1000);
    expect(t.plans.need(t.plan.id).watch).toBeUndefined();
  });
});

describe('assess: what counts as a stall', () => {
  const now = 10 * 60 * MIN;
  const run = (over: Partial<Parameters<typeof assess>[0]['run'] & object>) => ({ requestId: 'r', status: 'started', ts: now - 60 * MIN, lastAt: now - MIN, text: '', ...over });
  it('working recently, asking, or queued: no stall', () => {
    expect(assess({ run: run({}), asking: false, alive: true, now }).stall).toBeUndefined();
    expect(assess({ run: run({ status: 'done' }), asking: true, now }).stall).toBeUndefined();
    expect(assess({ run: run({ status: 'queued' }), asking: false, alive: false, now }).stall).toBeUndefined();
  });
  it('a hung command stalls after its own, longer limit', () => {
    const cmd = run({ step: 'Bash sleep 99999', stepAt: now - COMMAND_LIMIT_MS, lastAt: now - COMMAND_LIMIT_MS });
    expect(assess({ run: cmd, asking: false, alive: true, now })).toMatchObject({ woken: true });
    expect(assess({ run: { ...cmd, stepAt: now - 30 * MIN, lastAt: now - 30 * MIN }, asking: false, alive: true, now }).stall).toBeUndefined();
  });
  it('turn over but the process still there (background work): no stall', () => {
    expect(assess({ run: run({ status: 'done' }), asking: false, alive: true, now }).stall).toBeUndefined();
  });
  it('a pulse never says working when no turn runs', () => {
    expect(pulseOf(run({ status: 'done' }), false, undefined).kind).toBe('stopped');
    expect(pulseOf(run({ status: 'error', text: 'Agent stopped: error during execution' }), false, undefined)).toMatchObject({ kind: 'stopped', reason: 'its run failed: Agent stopped: error during execution' });
    expect(pulseOf(undefined, false, undefined).kind).toBe('stopped');
  });
});

describe('the head Claude steers a task, and its card shows what it does now', () => {
  /** The head Claude's message reaches the task's conversation as a request (q1, q2, …). */
  const sent = (t: Awaited<ReturnType<typeof running>>) => t.asked.map((a, i) => ({ ...a, id: `q${i + 1}` })).filter((a) => a.channel === t.channel && a.prompt.includes('from the head of the plan'));

  it('steer: in at once through Steer Now (interrupting a long command), and said to be urgent', async () => {
    const t = await running();
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npx playwright test');
    expect(t.message('Stop: the e2e suite runs at Ship, not here.', 'steer')).toMatch(/^Steered into .+: its agent gets it now/);
    const [m] = sent(t);
    expect(m!.prompt).toMatch(/^An urgent message from the head of the plan/);
    // It lands in the queue behind the long command: Klaud steers it in at once.
    t.event(m!.id, 'queued', m!.prompt);
    await t.later(0);
    expect(t.promoted).toEqual([m!.id]);
    // Read (its own turn started and Claude acted on it): nothing more happens.
    t.event(m!.id, 'started');
    t.event(m!.id, 'tool', 'Read src/auth.ts');
    await t.later(STEER_UNREAD_MS + MIN);
    expect(t.promoted).toEqual([m!.id]);
    expect(t.tookOver).toEqual([]);
  });

  it('queue (the default): it waits for the turn to end, shown on the card with Steer Now', async () => {
    const t = await running();
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npx playwright test');
    expect(t.message('FYI: KLD-9 renamed the session helper.')).toMatch(/^Queued for the agent working on/);
    const [m] = sent(t);
    expect(m!.prompt).toMatch(/^A message from the head of the plan/);
    t.event(m!.id, 'queued', m!.prompt);
    await t.later(STEER_UNREAD_MS + MIN);
    expect(t.promoted).toEqual([]);
    // The card: one message waiting, Steer Now sends it; the run behind it still shows its step.
    expect(t.task().waiting).toEqual([{ requestId: m!.id, prompt: m!.prompt, queued: true }]);
    expect(waitingWords(t.task().waiting!)).toEqual({ text: '1 message waiting', steer: m!.id });
    expect(t.task().pulse).toMatchObject({ kind: 'command', step: 'Running npx playwright test' });
  });

  it('a steered message unread after 2 minutes: interrupted again, then sent again through Steer Now (never a take-over); each said in the plan feed', async () => {
    const t = await running();
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npx playwright test');
    t.message('Stop the e2e run.', 'steer');
    const [m] = sent(t);
    t.event(m!.id, 'queued', m!.prompt);
    await t.later(0);
    expect(t.promoted).toEqual([m!.id]);
    // The steer didn't land (still queued): 2 minutes on, it's steered again.
    await t.later(STEER_UNREAD_MS);
    expect(t.promoted).toEqual([m!.id, m!.id]);
    const feed = () => t.plans.need(t.plan.id).activity.map((a) => a.text);
    expect(feed().at(-1)).toMatch(/hadn't read the plan head's message in 2m: interrupted it again/);
    // Taken into the running turn but never read: a fresh turn with it.
    t.event(m!.id, 'text', READS_AFTER_STEP);
    expect(t.task().waiting).toEqual([{ requestId: m!.id, prompt: m!.prompt, queued: false }]);
    expect(waitingWords(t.task().waiting!).steer).toBeUndefined();
    await t.later(STEER_UNREAD_MS);
    await tick(2);
    // Sent again and steered the agent host's one way (planSteer interrupts the long command): the run isn't taken over.
    expect(t.tookOver).toEqual([]);
    expect(feed().at(-1)).toMatch(/steered it in again/);
    const again = t.asked.filter((a) => a.channel === t.channel).at(-1)!;
    expect(again.prompt).toMatch(/^An urgent message from the head of the plan waited/);
    expect(again.prompt).toContain('Stop the e2e run.');
    const [, m2] = sent(t);
    expect(m2!.prompt).toBe(again.prompt);
    t.event(m2!.id, 'queued', m2!.prompt);
    await t.later(0);
    expect(t.promoted).toEqual([m!.id, m!.id, m2!.id]);
  });

  it('a dead run with the head Claude\'s message waiting behind it is woken, the message going with the wake', async () => {
    const t = await running({ waited: ['A message from the head of the plan “Payments”:\n\nUse the shared session helper.'] });
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Read src/auth.ts');
    t.message('Use the shared session helper.');
    const [m] = sent(t);
    t.event(m!.id, 'queued', m!.prompt);
    // The run behind the message died: the message no longer hides it.
    t.setAlive(false);
    await t.later(1000);
    expect(t.wakes()).toHaveLength(1);
    expect(t.tookOver).toEqual([t.channel]);
    expect(t.wakes()[0]!.prompt).toContain('Use the shared session helper.');
  });

  it('the card shows the step live: "Running npx playwright test · 137/215 · 12m"', async () => {
    const t = await running();
    t.setAlive(true);
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npx playwright test');
    t.event(r, 'progress', '137/215');
    const pulse = t.task().pulse!;
    expect(pulse).toMatchObject({ kind: 'command', step: 'Running npx playwright test', progress: '137/215' });
    expect(pulseWords(pulse, (pulse as { since: number }).since + 12 * MIN).sub).toBe('Running npx playwright test · 137/215 · 12m');
    // The next step starts without the old count.
    t.event(r, 'tool', 'Edit src/auth.ts');
    expect(t.task().pulse).not.toHaveProperty('progress');
  });
});

describe('a long command in words', () => {
  it('counts from test runners, never from a date', () => {
    expect(progressCount('  ✓  136 [chromium] › a.spec.ts\n  ✓  [137/215] [chromium] › b.spec.ts')).toBe('137/215');
    expect(progressCount('12/40 tests done')).toBe('12/40');
    expect(progressCount(' Tests  137 passed (215)')).toBe('137/215');
    expect(progressCount('Released on 10/22 at noon')).toBeUndefined();
    expect(progressCount('[300/215]')).toBeUndefined();
  });
  it('a command, and a step watching one, by name', () => {
    expect(stepWords('Bash npx playwright test')).toBe('Running npx playwright test');
    expect(stepWords('BashOutput', 'Bash npx playwright test')).toBe('Watching npx playwright test');
    expect(stepWords('Read src/auth.ts')).toBe('Read src/auth.ts');
  });
});

describe('a plan never stalls quietly: Beluga moves it along, a step further each time, then tells you (BLG-473)', () => {
  const quiet = 3 * MIN;

  it('a task that keeps stopping: woken, started over, the head Claude decides, then it’s yours with what was tried', async () => {
    const t = await running({ rescueMs: quiet });
    // It stops twice: the watchdog wakes it once, then it would wait for you.
    for (const text of ['Partway.', 'Still partway.']) {
      const r = t.newRun();
      t.event(r, 'started');
      t.event(r, 'done', text);
      await t.later(MIN);
    }
    expect(t.view().next.kind).toBe('stalled');
    const rescues = () => t.plans.need(t.plan.id).activity.filter((a) => a.text.includes(' went quiet: '));
    // Quiet for the spell: woken again.
    await t.later(quiet);
    expect(rescues().at(-1)?.text).toContain(`woke ${t.issue().key}`);
    // Still nothing: what was left of its turn is stopped, and it's started again.
    await t.later(quiet);
    expect(rescues().at(-1)?.text).toContain('started it again');
    expect(t.tookOver).toContain(t.channel);
    // Still nothing: the plan's Claude decides.
    await t.later(quiet);
    expect(t.asked.filter((a) => a.channel === 'ws:main').at(-1)?.prompt).toContain('The plan has gone quiet');
    // Still nothing: it's yours, and the plan says what was tried. Nothing more after that.
    await t.later(quiet);
    const rescue = t.plans.need(t.plan.id).rescue!.safe!;
    expect(rescue).toMatchObject({ yours: true, tries: 3 });
    expect(t.plans.need(t.plan.id).activity.at(-1)?.text).toMatch(/^Stuck on .*Beluga tried: woke .*; stopped what was left/);
    const asks = t.asked.length;
    await t.later(30 * MIN);
    expect(t.asked.length).toBe(asks);
    // It moves (the task comes back for review): the ladder starts over.
    t.board.update(t.issue().id, { status: 'in_review' }, t.claude);
    await t.later(MIN);
    expect(t.plans.need(t.plan.id).rescue).toBeUndefined();
  });

  it('never while something of it runs, nor while it waits on you', async () => {
    const t = await running({ rescueMs: quiet });
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Bash npm test');
    // A long command: busy, never rescued.
    for (let i = 0; i < 5; i++) await t.later(quiet);
    expect(t.plans.need(t.plan.id).activity.some((a) => a.text.includes(' went quiet: '))).toBe(false);
  });
});

describe('what a task that waits for you said', () => {
  it('is its words in one line, without code', () => {
    expect(saidLast(undefined)).toBeUndefined();
    expect(saidLast({ text: '  \n ' })).toBeUndefined();
    const said = saidLast({ text: 'I need **one** thing:\n\n```sh\nexport DB_PASSWORD=hunter2\n```\nput it in `.env`, then tell me.' });
    expect(said).toBe('I need one thing: (code) put it in .env, then tell me.');
    expect(saidLast({ text: 'word '.repeat(200) })!.length).toBeLessThanOrEqual(300);
  });

  it('fits the feed with what to do kept, however long it is', () => {
    const line = 'KLD-12 stopped again: it ended its turn without handing off. It waits for you';
    expect(waitsNote(line, 'Put the .env on the server.')).toBe(`${line}: do what it asks (or answer in its chat), then Resume it. It said: “Put the .env on the server.”`);
    const long = waitsNote(line, 'x'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(long).toContain('then Resume it. It said: “xxx');
    expect(long.endsWith('…”')).toBe(true);
  });
});
