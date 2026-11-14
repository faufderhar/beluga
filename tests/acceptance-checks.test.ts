import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { criteria, criterionLine, tally, tallyWords, unexplained } from '../src/core/board/criteria.js';
import type { Issue } from '../src/core/board/model.js';
import { BoardWork } from '../src/core/board/work.js';
import { taskPageView, tasksView } from '../src/companion/views.js';
import { TaskPageView } from '../src/companion/protocol.js';
import { briefOf } from '../src/core/plans/apply.js';
import type { MilestoneView, PlanView, TaskView } from '../src/core/plans/progress.js';
import { checkPrompt, criteriaNeedCheck, deferredItems } from '../src/core/plans/prompt.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { checklist, toggleCheck } from '../packages/mac/src/tasks/tasks-model.js';

/** A task's acceptance criteria count: met or explained before review, and the milestone check sees them. */

const ws = (id: string, projectId: string, name: string): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('w1', 'api', 'add-auth')])] });
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const work = new BoardWork({ store, board, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const issue = board.create({ projectId: 'api', title: 'Auth', status: 'in_progress', brief: { acceptance: '- [x] Routes use it\n- [ ] The network e2e passes\n- [ ] Expired sessions rejected' } }, work.me());
  board.linkWorktree(issue.key, 'w1', { branch: 'klaud/add-auth', name: 'add-auth' }, work.me());
  const tools = work.forRun('ws:w1', 'p-me')!.tools!;
  return { board, tools, work, store, key: issue.key };
}

const pr = (over: Record<string, unknown> = {}) => ({ number: 7, url: 'https://x/7', state: 'OPEN' as const, title: 'T', draft: false, checks: 'pending' as const, ...over });

describe('criteria: ticked, explained, or open', () => {
  it('reads a reason on the criterion’s own line', () => {
    const text = '- [x] One\n- [ ] Two — deferred: suites run at the end of the plan\n- [ ] Three -- not done: needs a key\n* [ ] Four (deferred: later)\nnote\n- [ ] Five';
    expect(criteria(text)).toEqual([
      { text: 'One', state: 'done' },
      { text: 'Two', state: 'deferred', reason: 'suites run at the end of the plan' },
      { text: 'Three', state: 'not_done', reason: 'needs a key' },
      { text: 'Four', state: 'deferred', reason: 'later' },
      { text: 'Five', state: 'open' },
    ]);
    expect(tally(text)).toEqual({ done: 1, deferred: 2, notDone: 1, open: 1, total: 5 });
    expect(unexplained(text).map((c) => c.text)).toEqual(['Five']);
    expect(tallyWords(tally(text))).toBe('1/5 · 2 deferred · 1 not done');
    expect(tallyWords(tally('- [x] a\n- [ ] b'))).toBe('1/2');
    expect(criterionLine(criteria(text)[1]!)).toBe('- [ ] Two — deferred: suites run at the end of the plan');
  });

  it('on the Mac: counted with their states, and ticking one drops its reason', () => {
    const text = '- [x] One\n- [ ] Two — deferred: at the end';
    expect(checklist(text)).toMatchObject({ done: 1, deferred: 1, total: 2 });
    expect(toggleCheck(text, 1)).toBe('- [x] One\n- [x] Two');
    expect(toggleCheck(text, 0)).toBe('- [ ] One\n- [ ] Two — deferred: at the end');
  });

  it('a plan re-applying its tasks keeps ticks and reasons', () => {
    const task = { id: 't', title: 'T', acceptance: ['One', 'Two', 'Three'], blockedBy: [] } as unknown as Parameters<typeof briefOf>[0];
    expect(briefOf(task, '- [x] One\n- [ ] Two — deferred: at the end').acceptance).toBe('- [x] One\n- [ ] Two — deferred: at the end\n- [ ] Three');
  });
});

describe('a task goes to review only with every criterion met or explained', () => {
  it('task_update to in_review is refused while one is neither, and its Claude is told which', () => {
    const { board, tools, key } = setup();
    expect(() => tools.update(undefined, { status: 'in_review' })).toThrow(/can't go to review yet: 2 criteria[\s\S]*- The network e2e passes\n- Expired sessions rejected/);
    expect(board.need(key)).toMatchObject({ status: 'in_progress', needsChecks: true });
    // Other changes still work.
    expect(tools.update(undefined, { priority: 'high' })).toContain('priority high');
  });

  it('allowed once each is ticked or given a reason', () => {
    const { board, tools, key } = setup();
    tools.editBrief(undefined, 'acceptance', '- [x] Routes use it\n- [ ] The network e2e passes — deferred: suites run at the end of the plan\n- [ ] Expired sessions rejected');
    expect(() => tools.update(undefined, { status: 'in_review' })).toThrow(/this criterion is neither ticked nor explained:\n- Expired sessions rejected/);
    tools.editBrief(undefined, 'acceptance', '- [x] Routes use it\n- [ ] The network e2e passes — deferred: suites run at the end of the plan\n- [x] Expired sessions rejected');
    expect(board.need(key).needsChecks).toBeUndefined();
    expect(tools.update(undefined, { status: 'in_review' })).toContain('in_review');
    expect(board.need(key).status).toBe('in_review');
  });

  it('a task with no criteria, or all ticked, goes as before', () => {
    const { board, tools, key } = setup();
    tools.editBrief(undefined, 'acceptance', '');
    tools.update(undefined, { status: 'in_review' });
    expect(board.need(key).status).toBe('in_review');
  });

  it('the pull request opening holds it too, and moves it once the criteria are settled', () => {
    const { board, tools, key } = setup();
    board.prChanged('w1', pr());
    const held = board.need(key);
    expect(held).toMatchObject({ status: 'in_progress', needsChecks: true, pr: { number: 7 } });
    expect(held.activity.at(-1)?.text).toBe('kept this out of In Review: 2 criteria are neither ticked nor explained (“The network e2e passes”; “Expired sessions rejected”)');
    // Seen again: nothing new.
    const seen = held.activity.length;
    board.prChanged('w1', pr({ checks: 'passing' }));
    expect(board.need(key).activity.filter((a) => a.text.startsWith('kept this out'))).toHaveLength(1);
    expect(board.need(key).activity.length).toBeGreaterThanOrEqual(seen);
    // One explained, one ticked: In Review by itself.
    tools.editBrief(undefined, 'acceptance', '- [x] Routes use it\n- [ ] The network e2e passes — deferred: at the end\n- [x] Expired sessions rejected');
    const moved = board.need(key);
    expect(moved.status).toBe('in_review');
    expect(moved.needsChecks).toBeUndefined();
    expect(moved.activity.at(-1)?.text).toBe('every criterion is ticked or explained: moved this from In Progress to In Review');
  });

  it('a pull request with every criterion settled moves it as before', () => {
    const { board, tools, key } = setup();
    tools.editBrief(undefined, 'acceptance', '- [x] Routes use it\n- [x] The network e2e passes\n- [ ] Expired sessions rejected — not done: split off as KLD-9');
    board.prChanged('w1', pr());
    expect(board.need(key)).toMatchObject({ status: 'in_review' });
    expect(board.need(key).needsChecks).toBeUndefined();
  });

  it('a person moving it clears the hold', () => {
    const { board, tools, key } = setup();
    expect(() => tools.update(undefined, { status: 'in_review' })).toThrow();
    board.update(key, { status: 'in_review' }, { kind: 'person', id: 'p-me', name: 'Kay' } as never);
    expect(board.need(key).needsChecks).toBeUndefined();
  });
});

const SETTLED = '- [x] Routes use it\n- [ ] The network e2e passes — deferred: at the end\n- [x] Expired sessions rejected';
const OPEN_LINE = '“The network e2e passes”; “Expired sessions rejected”';
const person = { kind: 'person', id: 'p-me', name: 'Kay' } as never;

describe('a merge moves it to Done only with every criterion met or explained (BLG-952)', () => {
  it('its pull request merging with criteria open leaves it In Review, held, and says which', () => {
    const { board, key } = setup();
    board.prChanged('w1', pr());
    board.prChanged('w1', pr({ state: 'MERGED' }));
    const held = board.need(key);
    expect(held).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true, pr: { state: 'MERGED' } });
    expect(held.closedAt).toBeUndefined();
    expect(held.activity.map((a) => a.text).slice(-2)).toEqual([
      'pull request #7 was merged',
      `kept this out of Done: 2 criteria are neither ticked nor explained (${OPEN_LINE}): moved this from In Progress to In Review`,
    ]);
  });

  it('settling the last open criterion afterwards finishes it: Done', () => {
    const { board, tools, key } = setup();
    board.prChanged('w1', pr({ state: 'MERGED' }));
    tools.editBrief(undefined, 'acceptance', '- [x] Routes use it\n- [x] The network e2e passes\n- [ ] Expired sessions rejected');
    expect(board.need(key)).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true });
    tools.editBrief(undefined, 'acceptance', SETTLED);
    const done = board.need(key);
    expect(done.status).toBe('done');
    expect(done.needsChecks).toBeUndefined();
    expect(done.mergedHeld).toBeUndefined();
    expect(done.activity.at(-1)?.text).toBe('every criterion is ticked or explained and its work is merged: moved this from In Review to Done');
  });

  it('already In Review when it merges: it stays there, held', () => {
    const { board, key } = setup();
    board.update(key, { status: 'in_review' }, person);
    board.prChanged('w1', pr({ state: 'MERGED' }));
    const held = board.need(key);
    expect(held).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true });
    expect(held.activity.at(-1)?.text).toBe(`kept this out of Done: 2 criteria are neither ticked nor explained (${OPEN_LINE})`);
  });

  it('every criterion ticked or explained, or none at all: Done, as before', () => {
    const { board, tools, key } = setup();
    tools.editBrief(undefined, 'acceptance', SETTLED);
    board.prChanged('w1', pr({ state: 'MERGED' }));
    expect(board.need(key)).toMatchObject({ status: 'done' });
    expect(board.need(key).needsChecks).toBeUndefined();
    expect(board.need(key).activity.at(-1)?.text).toBe('moved this from In Progress to Done');

    const bare = setup();
    bare.tools.editBrief(undefined, 'acceptance', '');
    bare.board.prChanged('w1', pr({ state: 'MERGED' }));
    expect(bare.board.need(bare.key).status).toBe('done');
  });

  it('a merged pull request found later (the worktree gone) follows the same rule', () => {
    const { board, tools, key } = setup();
    const held = board.branchShipped(key, pr({ state: 'MERGED' }));
    expect(held).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true });
    expect(held.activity.at(-1)?.text).toContain('kept this out of Done: 2 criteria');
    tools.editBrief(undefined, 'acceptance', SETTLED);
    expect(board.need(key).status).toBe('done');
  });

  it('a worktree merged into main here follows the same rule', () => {
    const { board, tools, key } = setup();
    board.worktreeMerged('w1');
    const held = board.need(key);
    expect(held).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true });
    expect(held.activity.map((a) => a.text).slice(-2)).toEqual([
      'its worktree was merged into main',
      `kept this out of Done: 2 criteria are neither ticked nor explained (${OPEN_LINE}): moved this from In Progress to In Review`,
    ]);
    tools.editBrief(undefined, 'acceptance', SETTLED);
    expect(board.need(key).status).toBe('done');

    const ok = setup();
    ok.tools.editBrief(undefined, 'acceptance', SETTLED);
    ok.board.worktreeMerged('w1');
    expect(ok.board.need(ok.key).status).toBe('done');
  });

  it('marking it Done by hand still works, by a person or by its Claude', () => {
    const { board, key } = setup();
    board.prChanged('w1', pr({ state: 'MERGED' }));
    const done = board.update(key, { status: 'done' }, person);
    expect(done.status).toBe('done');
    expect(done.needsChecks).toBeUndefined();
    expect(done.mergedHeld).toBeUndefined();

    const viaClaude = setup();
    viaClaude.board.prChanged('w1', pr({ state: 'MERGED' }));
    expect(viaClaude.tools.update(undefined, { status: 'done' })).toContain('done');
    expect(viaClaude.board.need(viaClaude.key).status).toBe('done');
  });

  it('an epic doesn’t roll up to Done through a sub-task held this way', () => {
    const { board, tools, key } = setup();
    const epic = board.create({ projectId: 'api', title: 'Sign-in', status: 'in_progress' }, person);
    const other = board.create({ projectId: 'api', title: 'Copy', status: 'in_progress', parent: epic.key }, person);
    board.update(key, { parent: epic.key }, person);
    board.update(other.key, { status: 'done' }, person);
    board.prChanged('w1', pr({ state: 'MERGED' }));
    expect(board.need(key).status).toBe('in_review');
    expect(board.need(epic.key).status).toBe('in_review');
    // Settled: the sub-task is Done, and the epic with it.
    tools.editBrief(undefined, 'acceptance', SETTLED);
    expect(board.need(key).status).toBe('done');
    expect(board.need(epic.key).status).toBe('done');
  });

  it('a sub-task going Done with its parent’s merge is held the same way', () => {
    const { board, key } = setup();
    const kid = board.create({ projectId: 'api', title: 'Moved along by hand', status: 'in_progress', parent: key, brief: { acceptance: '- [ ] Retries on 429' } }, person);
    const easy = board.create({ projectId: 'api', title: 'Also by hand', status: 'in_progress', parent: key }, person);
    board.editBrief(key, 'acceptance', SETTLED, person);
    board.prChanged('w1', pr({ state: 'MERGED' }));
    expect(board.need(key).status).toBe('done');
    expect(board.need(easy.key).status).toBe('done');
    expect(board.need(kid.key)).toMatchObject({ status: 'in_review', needsChecks: true, mergedHeld: true });
    expect(board.need(kid.key).activity.at(-1)?.text).toBe('kept this out of Done: a criterion is neither ticked nor explained (“Retries on 429”): moved this from In Progress to In Review');
  });

  it('Continue After Merge takes a held task back to In Progress: its next pull request ships it', () => {
    const { board, key } = setup();
    board.prChanged('w1', pr({ state: 'MERGED' }));
    board.continuedAfterMerge('w1', 7);
    const back = board.need(key);
    expect(back.status).toBe('in_progress');
    expect(back.mergedHeld).toBeUndefined();
    expect(back.pr).toBeUndefined();
  });

  it('the phone sees the hold the way the Mac shows it', () => {
    const { board, store, key } = setup();
    const id = board.need(key).id;
    expect(taskPageView(store.getState(), id)!.needsChecks).toBeUndefined();
    board.prChanged('w1', pr());
    const opened = taskPageView(store.getState(), id)!;
    expect(opened.needsChecks).toEqual({ open: 2 });
    board.prChanged('w1', pr({ state: 'MERGED' }));
    const merged = taskPageView(store.getState(), id)!;
    expect(merged.needsChecks).toEqual({ open: 2, merged: true });
    expect(TaskPageView.parse(merged).needsChecks).toEqual({ open: 2, merged: true });
    const listed = tasksView(store.getState()).projects.flatMap((p) => p.groups.flatMap((g) => g.tasks)).find((t) => t.key === key);
    expect(listed?.needsChecks).toEqual({ open: 2, merged: true });
    // Marked Done by hand: no longer held, on the phone either.
    board.update(key, { status: 'done' }, person);
    expect(taskPageView(store.getState(), id)!.needsChecks).toBeUndefined();
  });
});

// A plan view by hand: only what checkPrompt reads.
const issue = (key: string, acceptance: string, more: Partial<Issue> = {}): Issue => ({ key, brief: { acceptance }, ...more }) as unknown as Issue;
const task = (id: string, title: string, acceptance: string[], i?: Issue, state: TaskView['state'] = 'review'): TaskView => ({ task: { id, title, acceptance, blockedBy: [] }, milestoneId: '', state, waitsOn: [], ...(i ? { issue: i } : {}) }) as unknown as TaskView;
const milestone = (index: number, title: string, criteria: string[], tasks: TaskView[]): MilestoneView => ({ milestone: { id: `m${index}`, title, criteria, tasks: [] }, index, state: 'checking', tasks, finished: tasks.length, total: tasks.length, autonomy: 'autopilot', run: {}, dependsOn: [] }) as unknown as MilestoneView;
const view = (milestones: MilestoneView[]): PlanView => ({ plan: { testsAt: 'end' }, milestones, open: [], ready: [], active: [], done: 0, total: 0 }) as unknown as PlanView;

function plan() {
  const m1 = milestone(0, 'Network', ['Reconnects within 5 s'], [
    task('net', 'Connection errors', ['Errors say why', 'The network e2e passes', 'Banner goes away'], issue('KLD-52', '- [x] Errors say why\n- [ ] The network e2e passes — deferred: suites run at the end of the plan\n- [ ] Banner goes away', { pr: { number: 12, state: 'OPEN' }, branch: 'klaud/kld-52' } as Partial<Issue>)),
    task('copy', 'Copy pass', ['Words reviewed'], issue('KLD-53', '- [ ] Words reviewed — not done: mia is away')),
    task('later', 'Not started', ['Has a test']),
  ]);
  const m2 = milestone(1, 'Wrap up', [], [task('suite', 'Full suite', ['Everything passes'], issue('KLD-60', '- [x] Everything passes'))]);
  return { m1, m2, v: view([m1, m2]) };
}

describe('the milestone check sees each task’s criteria', () => {
  it('checkPrompt lists them with ticks and reasons, and fails on unexplained gaps', () => {
    const { m1, v } = plan();
    expect(checkPrompt(v, m1)).toMatchSnapshot();
  });

  it('the final check lists every deferred item and requires each to be settled', () => {
    const { m2, v } = plan();
    expect(deferredItems(v).map((d) => `${d.task.issue?.key}: ${d.criterion.text}`)).toEqual(['KLD-52: The network e2e passes']);
    const text = checkPrompt(v, m2);
    expect(text).toContain('This is the plan\'s final check: every criterion deferred along the way must be settled now');
    expect(text).toContain('- KLD-52: The network e2e passes (deferred: suites run at the end of the plan)');
    expect(text).toContain('Don\'t pass while one is still deferred.');
    expect(text).not.toContain('checked again at the end of the plan');
    expect(text).toMatchSnapshot();
  });

  it('a milestone with no pass criteria is still checked when a criterion is open, or deferred ones wait for the end', () => {
    const { m1, m2, v } = plan();
    expect(criteriaNeedCheck(v, m1)).toBe(true);
    expect(criteriaNeedCheck(v, m2)).toBe(true);
    const settled = view([milestone(0, 'A', [], [task('a', 'A', ['x'], issue('K-1', '- [x] x'))])]);
    expect(criteriaNeedCheck(settled, settled.milestones[0]!)).toBe(false);
    // Middle milestone, nothing open, a deferred one: that waits for the end.
    const mid = view([milestone(0, 'A', [], [task('a', 'A', ['x'], issue('K-1', '- [ ] x — deferred: later'))]), milestone(1, 'B', [], [])]);
    expect(criteriaNeedCheck(mid, mid.milestones[0]!)).toBe(false);
    expect(criteriaNeedCheck(mid, mid.milestones[1]!)).toBe(true);
  });
});
