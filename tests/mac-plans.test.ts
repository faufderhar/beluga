import { describe, expect, it } from 'vitest';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { planView } from '../src/core/plans/progress.js';
import { NO_BOARD } from '../src/core/board/model.js';
import { barColumns, branchFlow, changeMarks, changeWords, feedOf, gateId, graphShape, groupId, headline, milestoneRows, modeChange, nextWords, planStatus, plansOf, prWords, shipAction, taskHeadline, taskNodeId } from '../packages/mac/src/plans/plans-model.js';
import type { PlanPr } from '../src/core/plans/model.js';
import type { PlanEvent } from '../src/core/plans/model.js';
import type { PlanView } from '../src/core/plans/progress.js';
import { columnAt, edgeSpeed, isDrag, landingIndex, leanFor, neighbours, withGap } from '../packages/mac/src/tasks/board-drag.js';
import { nextMode } from '../packages/mac/src/chat/compose-mode.js';

/** The Plans screens' pure parts, the board's drag, and the composer's modes. */

const body = normalizeBody({
  title: 'P',
  goal: 'g',
  milestones: [
    { id: 'one', title: 'One', criteria: ['works'], tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', blockedBy: ['a'] }, { id: 'c', title: 'C' }] },
    { id: 'two', title: 'Two', tasks: [{ id: 'd', title: 'D', blockedBy: ['b'] }, { id: 'e', title: 'E', blockedBy: ['d'] }] },
  ],
});
const plan = (over: Partial<Plan> = {}): Plan => ({ id: 'p', projectId: 'x', home: 'ws:h', status: 'draft', draft: body, draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 0, updatedAt: 0, ...over });

describe('the plan graph’s shape', () => {
  it('lines: blockers, the last tasks to the gate, the gate to the next milestone', () => {
    const shape = graphShape(plan());
    const ids = shape.edges.map((e) => `${e.kind}:${e.from}>${e.to}`);
    expect(ids).toContain(`blocks:${taskNodeId('a')}>${taskNodeId('b')}`);
    expect(ids).toContain(`finish:${taskNodeId('b')}>${gateId('one')}`);
    expect(ids).toContain(`finish:${taskNodeId('c')}>${gateId('one')}`);
    expect(ids).not.toContain(`finish:${taskNodeId('a')}>${gateId('one')}`);
    expect(ids).toContain(`next:${gateId('one')}>${groupId('two')}`);
    // Across milestones: drawn as a blocker (shown when picked).
    expect(ids).toContain(`blocks:${taskNodeId('b')}>${taskNodeId('d')}`);
  });

  it('a gate leads only to the milestones that wait on it (side by side ones get no line)', () => {
    const three = normalizeBody({ ...body, milestones: [...body.milestones, { id: 'three', title: 'Three', tasks: [{ id: 'f', title: 'F' }] }, { id: 'four', title: 'Four', dependsOn: ['one'], tasks: [{ id: 'g', title: 'G' }] }] });
    const next = graphShape(plan({ draft: three })).edges.filter((e) => e.kind === 'next').map((e) => `${e.from}>${e.to}`);
    expect(next).toEqual([`${gateId('one')}>${groupId('two')}`, `${gateId('one')}>${groupId('four')}`]);
  });

  it('one that waits on several gets lines only from the nearest (no line past a milestone in between)', () => {
    const fan = normalizeBody({
      ...body,
      milestones: [
        { id: 'a', title: 'A', dependsOn: [], tasks: [{ id: 'ta', title: 'TA' }] },
        { id: 'b', title: 'B', dependsOn: [], tasks: [{ id: 'tb', title: 'TB' }] },
        { id: 'c', title: 'C', dependsOn: [], tasks: [{ id: 'tc', title: 'TC' }] },
        { id: 'left', title: 'Leftovers', dependsOn: ['a', 'b'], tasks: [{ id: 'tl', title: 'TL' }] },
        { id: 'end', title: 'End', dependsOn: ['a', 'b', 'c', 'left'], tasks: [{ id: 'te', title: 'TE' }] },
      ],
    });
    const next = graphShape(plan({ draft: fan })).edges.filter((e) => e.kind === 'next').map((e) => `${e.from}>${e.to}`);
    expect(next).toEqual([`${gateId('a')}>${groupId('left')}`, `${gateId('b')}>${groupId('left')}`, `${gateId('c')}>${groupId('end')}`, `${gateId('left')}>${groupId('end')}`]);
  });

  it('its criteria are part of its shape (they size the criteria node)', () => {
    const a = graphShape(plan());
    const more = normalizeBody({ ...body, milestones: [{ ...body.milestones[0]!, criteria: ['works', 'and is fast'] }, body.milestones[1]!] });
    expect(graphShape(plan({ draft: more })).key).not.toBe(a.key);
  });

  it('its key changes with the shape only (status moving on never re-lays it out)', () => {
    const a = graphShape(plan());
    expect(graphShape(plan({ draft: { ...body, title: 'Renamed' } })).key).toBe(a.key);
    expect(graphShape(plan({ draft: normalizeBody({ ...body, milestones: [...body.milestones, { title: 'Three', tasks: [] }] }) })).key).not.toBe(a.key);
  });
});

describe('words for a plan', () => {
  it('a draft waits for approval', () => {
    const v = planView(plan(), NO_BOARD);
    expect(planStatus(v)).toEqual({ label: 'Draft', tone: 'muted' });
    expect(nextWords(v.next).title).toBe('Approve Plan');
  });

  it('proposed changes are marked per task and counted', () => {
    const approved = normalizeBody(body);
    const next = normalizeBody({ ...body, milestones: [{ ...body.milestones[0]!, tasks: [...body.milestones[0]!.tasks, { id: 'f', title: 'F', acceptance: [], blockedBy: [] }] }, body.milestones[1]!] });
    const p = plan({ status: 'active', body: approved, draft: next });
    expect([...changeMarks(p)]).toEqual([['f', 'added']]);
    expect(changeWords(p)).toBe('1 new');
    expect(planStatus(planView(p, NO_BOARD)).label).toBe('Changes proposed');
  });

  it('a project’s plans: running, then drafts, then done', () => {
    const list = plansOf({ enabled: true, style: '', plans: [plan({ id: 'd', status: 'done', updatedAt: 9 }), plan({ id: 'r', status: 'draft', updatedAt: 5 }), plan({ id: 'a', status: 'active', updatedAt: 1 }), plan({ id: 'o', projectId: 'other' })] }, 'x');
    expect(list.map((p) => p.id)).toEqual(['a', 'r', 'd']);
  });
});

describe('the plan’s one sentence, its bar and its feed (KLD-22)', () => {
  const claude = { kind: 'claude', owner: 'p-me', ownerName: 'Kay' } as const;
  const single = normalizeBody({ title: 'P', goal: 'g', milestones: [{ id: 'api', title: 'API', criteria: ['a', 'b', 'c', 'd'], tasks: [{ id: 'a', title: 'A' }] }, { id: 'ui', title: 'UI', dependsOn: [], tasks: [{ id: 'u', title: 'U' }] }, { id: 'ship', title: 'Ship', dependsOn: ['api', 'ui'], tasks: [{ id: 's', title: 'S' }] }] });
  // Tasks with no board task count as finished: API's tasks are all done.
  const active = (over: Partial<Plan> = {}): Plan => plan({ status: 'active', body: single, draft: undefined, ...over });

  it.each(['step', 'gated', 'autopilot'] as const)('%s: while Claude checks it says so, never “Waiting for you”', (autonomy) => {
    const v = planView(active({ autonomy, runs: { api: { checkAsked: 1 }, ui: { passedAt: 1 } } }), NO_BOARD);
    expect(v.next.kind).toBe('checking');
    expect(planStatus(v).label).not.toBe('Waiting for you');
    expect(headline(v)).toEqual({ who: 'claude', text: 'The agent is checking “API”' });
  });

  it('once the check is back, it’s yours to pass, saying what Claude checked', () => {
    const v = planView(active({ runs: { api: { checkAsked: 1, check: { at: 2, by: claude, verdict: 'pass', notes: '' } }, ui: { passedAt: 1 } } }), NO_BOARD);
    expect(headline(v)).toEqual({ who: 'you', text: 'Pass “API” — The agent checked all 4 criteria' });
  });

  it('tasks at work across milestones; a merge conflict, when the plan carries one', () => {
    const v = planView(active(), NO_BOARD);
    const running = (id: string, milestoneId: string) => ({ task: { id, title: id }, milestoneId, state: 'running', waitsOn: [], forYou: false });
    const working = { ...v, active: [running('a', 'api'), running('b', 'api'), running('u', 'ui')], next: { kind: 'working', tasks: [] } } as unknown as PlanView;
    expect(headline(working)).toEqual({ who: 'claude', text: '3 tasks running in 2 milestones' });
    const merging = active({ runs: { api: { passedAt: 1 } }, ...({ branch: 'plan/x', merging: { api: { at: 1, by: claude, conflict: { at: 1, dir: '/tmp', merging: 'klaud/kld-9', key: 'KLD-9', files: ['a.ts'] } } } } as object) });
    expect(headline(planView(merging, NO_BOARD))).toEqual({ who: 'claude', text: 'Fixing a merge conflict in KLD-9' });
  });

  it('from a task’s worktree: done, and what the milestone waits on', () => {
    const v = planView(active({ runs: { api: { checkAsked: 1 } } }), NO_BOARD);
    const asReview = { ...v, milestones: v.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => ({ ...t, state: 'review' as const })) })) };
    expect(taskHeadline(asReview, 'a')).toEqual({ who: 'claude', text: 'Done. The agent is checking “API”; Beluga merges this into the plan' });
  });

  it('switching to Autopilot says what changes from now on, and what happens at once', () => {
    const v = planView(active({ autonomy: 'gated', runs: { api: { checkAsked: 1, check: { at: 2, by: claude, verdict: 'pass', notes: '' } }, ui: { passedAt: 1 } }, ...({ branch: 'plan/x' } as object) }), NO_BOARD);
    expect(modeChange(v, 'autopilot')).toEqual({ title: 'Switch to Autopilot', from: 'From now on the agent passes milestones itself and merges them into plan/x. It stops only if a check fails.', now: '“API” passes now.' });
    expect(modeChange(v, 'step').from).toMatch(/^From now on nothing starts by itself/);
  });

  it('switching off Step by Step says nothing starts until you press Start', () => {
    const v = planView(active({ autonomy: 'step' }), NO_BOARD);
    expect(modeChange(v, 'autopilot').now).toBe('Nothing starts until you press Start.');
    expect(modeChange(v, 'gated').now).toBe('Nothing starts until you press Start.');
  });

  it('parallel milestones share a row (and a column of the bar)', () => {
    expect(milestoneRows(single)).toEqual([['api', 'ui'], ['ship']]);
    expect(barColumns(planView(active(), NO_BOARD)).map((c) => c.map((b) => b.id))).toEqual([['api', 'ui'], ['ship']]);
    expect(graphShape(active({ draft: single })).rows).toEqual([['api', 'ui'], ['ship']]);
  });

  it('the feed: newest first, the same thing in a row folded into one line', () => {
    const klaud = { kind: 'beluga' } as const;
    const e = (id: string, at: number, kind: PlanEvent['kind'], text: string, by: PlanEvent['by'] = klaud): PlanEvent => ({ id, at, by, kind, text });
    const feed = feedOf([
      e('1', 1, 'started', 'started KLD-1 “A”'),
      e('2', 2, 'started', 'started KLD-2 “B”'),
      e('3', 3, 'drafted', 'wrote the plan'),
      e('4', 4, 'gate', '“API”: every task is finished, Claude is checking its pass criteria'),
      e('5', 5, 'checked', 'checked “API”: all good', claude),
      e('6', 6, 'passed', 'merged KLD-1, KLD-2 into plan/x'),
      e('7', 7, 'problem', 'couldn’t start KLD-3'),
      e('8', 8, 'problem', 'couldn’t start KLD-3'),
      e('9', 9, 'autonomy', 'switched the plan to Autopilot'),
    ]);
    expect(feed.map((f) => [f.kind, f.text, f.count])).toEqual([
      ['mode', 'switched the plan to Autopilot', 1],
      ['problem', 'couldn’t start KLD-3', 2],
      ['merged', 'merged KLD-1, KLD-2 into plan/x', 1],
      ['checked', 'checked “API”: all good', 1],
      ['checking', '“API”: every task is finished, Claude is checking its pass criteria', 1],
      ['started', 'started 2 tasks: KLD-1, KLD-2', 2],
    ]);
  });
});

describe('the board’s drag', () => {
  const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0 });
  it('lands above the first card whose middle is below the pointer', () => {
    const cards = [box(0, 60), box(70, 130), box(140, 200)];
    expect(landingIndex(10, cards)).toBe(0);
    expect(landingIndex(40, cards)).toBe(1);
    expect(landingIndex(500, cards)).toBe(3);
    expect(landingIndex(5, [])).toBe(0);
  });

  it('the column under the pointer, or the nearest', () => {
    const cols = [
      { key: 'todo', box: { top: 0, bottom: 1, left: 0, right: 100 } },
      { key: 'done', box: { top: 0, bottom: 1, left: 120, right: 220 } },
    ];
    expect(columnAt(50, cols)).toBe('todo');
    expect(columnAt(110, cols)).toBe('todo');
    expect(columnAt(400, cols)).toBe('done');
  });

  it('a gap where it would land, the lifted card out; its neighbours there', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(withGap(items, 'a', 1)).toEqual([{ id: 'b' }, 'gap', { id: 'c' }]);
    expect(neighbours(items, 'a', 1)).toEqual({ before: 'b', after: 'c' });
    expect(neighbours(items, 'c', 0)).toEqual({ after: 'a' });
  });

  it('leans a little with speed; scrolls near edges; tells a drag from a click', () => {
    expect(leanFor(0)).toBe(0);
    expect(leanFor(10_000)).toBe(6);
    expect(leanFor(-10_000)).toBe(-6);
    expect(edgeSpeed(500, 0, 1000)).toBe(0);
    expect(edgeSpeed(5, 0, 1000)).toBeLessThan(0);
    expect(edgeSpeed(995, 0, 1000)).toBeGreaterThan(0);
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(4, 3)).toBe(true);
  });
});

describe('the composer’s modes', () => {
  it('⇧⇥ switches acting and planning first (Plan with Tasks is never a keystroke away)', () => {
    expect(nextMode('act')).toBe('plan');
    expect(nextMode('plan')).toBe('act');
    expect(nextMode('tasks')).toBe('act');
  });
});

describe('shipping the plan: its pull request, conflicts with main, and where the work goes', () => {
  const pr = (over: Partial<PlanPr> = {}): PlanPr => ({ number: 7, url: 'https://github.com/x/y/pull/7', state: 'OPEN', title: 'P', draft: false, checks: 'passing', ...over });
  const active = (over: Partial<Plan> = {}): Plan => plan({ status: 'active', body, draft: undefined, branch: 'plan/p', ...over });

  it('the last step follows the PR: open it, bring main in when it conflicts, wait on Claude, merge now or once checks pass', () => {
    expect(shipAction(active(), undefined)).toEqual({ kind: 'open', again: false });
    expect(shipAction(active(), pr({ state: 'CLOSED' }))).toEqual({ kind: 'open', again: true });
    expect(shipAction(active(), pr({ conflicts: true }))).toEqual({ kind: 'resolve' });
    expect(shipAction(active({ mainMerge: { at: 1, main: 'origin/main' } }), pr({ conflicts: true }))).toEqual({ kind: 'catching_up', main: 'origin/main' });
    expect(shipAction(active({ mainMerge: { at: 1, main: 'origin/main', conflict: { at: 1, dir: '/d', files: ['a.ts'] } } }), pr())).toEqual({ kind: 'fixing', files: ['a.ts'] });
    expect(shipAction(active({ mainMerge: { at: 1, main: 'origin/main', conflict: { at: 1, dir: '/d', files: ['a.ts'], stuck: true } } }), pr()).kind).toBe('stuck');
    expect(shipAction(active(), pr({ draft: true })).kind).toBe('draft');
    expect(shipAction(active(), pr({ checks: 'pending' })).kind).toBe('wait');
    expect(shipAction(active(), pr({ review: 'REVIEW_REQUIRED' })).kind).toBe('wait');
    expect(shipAction(active(), pr({ checks: 'pending', autoMerge: true })).kind).toBe('queued');
    expect(shipAction(active(), pr()).kind).toBe('merge');
    expect(shipAction(active(), pr({ state: 'MERGED' })).kind).toBe('merged');
  });

  it('the PR in a few words: what stands in its way', () => {
    expect(prWords(pr({ checks: 'pending', review: 'REVIEW_REQUIRED' }))).toBe('checks running · needs a review');
    expect(prWords(pr({ conflicts: true, checks: 'failing' }))).toBe('conflicts with main · checks failing');
    expect(prWords(pr({ checks: 'none' }))).toBe('ready to merge');
    expect(prWords(pr({ state: 'MERGED' }))).toBe('merged into main');
  });

  it('where the work goes: main, the PR, the branch, then each milestone merged, merging or stuck', () => {
    const p = active({
      runs: { one: { passedAt: 1 } },
      merging: { two: { at: 2, by: { kind: 'beluga' }, conflict: { at: 2, dir: '/d', merging: 'beluga/kld-9', key: 'KLD-9', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], stuck: true } } },
      pr: pr({ checks: 'pending' }),
    });
    const flow = branchFlow(planView(p, NO_BOARD));
    expect(flow.map((s) => [s.kind, s.label, s.state])).toEqual([
      ['main', 'main', 'waiting'],
      ['pr', 'Pull request #7', 'active'],
      ['branch', 'plan/p', 'active'],
      ['milestone', 'One', 'done'],
      ['milestone', 'Two', 'problem'],
    ]);
    expect(flow[4]!.detail).toBe('merging into plan/p: KLD-9 conflicts in src/a.ts, src/b.ts and 1 more — needs you');
  });

  it('a milestone whose merge failed says why, in the headline and the flow', () => {
    const p = active({ runs: { one: { mergeFailed: { at: 1, reason: 'plan/p is checked out with uncommitted changes' } } } });
    const v = planView(p, NO_BOARD);
    expect(branchFlow(v).find((s) => s.id === 'one')).toMatchObject({ state: 'problem', detail: 'couldn’t merge: plan/p is checked out with uncommitted changes' });
  });

  it('the feed shows the branch being made and the PR opening', () => {
    const ev = (kind: PlanEvent['kind'], text: string, at: number): PlanEvent => ({ id: `e${at}`, at, by: { kind: 'beluga' }, kind, text });
    const items = feedOf([ev('note', 'made the plan’s branch plan/p from main', 1), ev('note', 'opened pull request #7: plan/p → main', 2), ev('note', 'paused by you', 3)]);
    expect(items.map((i) => i.kind)).toEqual(['pr', 'branch']);
  });
});
