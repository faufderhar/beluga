import { describe, expect, it } from 'vitest';
import type { Plan, PlansState } from '../src/core/plans/model.js';
import { isPlanHome } from '../src/core/plans/model.js';
import { Store, initialState } from '../src/core/store.js';
import {
  CHAT_DEFAULT,
  CHAT_MIN,
  DEFAULT_PLAN_LAYOUT,
  FOLDED,
  MILESTONE,
  PLAN_GAPS,
  TASK_CARD,
  TASK_COMPACT,
  arrowHead,
  between,
  chatOpen,
  clampChatWidth,
  easeOut,
  gateHeight,
  glidable,
  isFolded,
  joinAt,
  labelAt,
  milestoneAnchors,
  milestoneFrame,
  milestoneRoute,
  placeMilestones,
  readFolds,
  readPlanLayout,
  setChatOpen,
  taskSize,
  withFold,
} from '../packages/mac/src/plans/plan-layout.js';

describe('the plan graph’s geometry', () => {
  it('draws a finished task as a slim row, the rest as full cards', () => {
    expect(taskSize('done')).toEqual(TASK_COMPACT);
    expect(taskSize('planned')).toEqual(TASK_COMPACT);
    expect(taskSize('canceled')).toEqual(TASK_COMPACT);
    for (const s of ['ready', 'running', 'review', 'blocked', 'asking']) expect(taskSize(s)).toEqual(TASK_CARD);
    expect(TASK_COMPACT.width).toBe(TASK_CARD.width);
    expect(TASK_COMPACT.height).toBeLessThan(TASK_CARD.height / 2);
  });

  it('puts a milestone’s gate across its foot, sized by its criteria, and stretches the box from above it', () => {
    const inner = { width: 600, height: 180 };
    const f = milestoneFrame(inner, ['One', 'Two'], false);
    expect(f.width).toBe(600);
    expect(f.gate).toEqual({ x: MILESTONE.inset, y: f.height - MILESTONE.inset - f.gate.height, width: 600 - 2 * MILESTONE.inset, height: gateHeight(['One', 'Two'], 580) });
    expect(f.gate.y).toBe(180 + MILESTONE.gateGap);
    // A longer criterion wraps (two lines at most), a narrower gate wraps sooner.
    expect(gateHeight(['x'.repeat(200)], 580)).toBe(gateHeight(['a', 'b'], 580) - 5);
    expect(gateHeight(['x'.repeat(70)], 300)).toBeGreaterThan(gateHeight(['x'.repeat(70)], 600));
    // Stretched to its row's tallest: the gate stays at the foot.
    const tall = milestoneFrame(inner, ['One', 'Two'], false, f.height + 100);
    expect(tall.height).toBe(f.height + 100);
    expect(tall.gate.y).toBe(f.gate.y + 100);
    // A narrow milestone is still MILESTONE.minWidth wide, its tasks centred in it.
    const narrow = milestoneFrame({ width: 292, height: 170 }, [], false);
    expect(narrow.width).toBe(MILESTONE.minWidth);
    expect(narrow.shiftX).toBe((MILESTONE.minWidth - 292) / 2);
  });

  it('folds a milestone into one summary row, whatever its tasks and criteria', () => {
    const f = milestoneFrame({ width: 900, height: 400 }, ['a', 'b', 'c'], true, 700);
    expect(f).toMatchObject({ folded: true, width: FOLDED.maxWidth, height: FOLDED.height, shiftX: 0 });
    expect(f.gate).toEqual({ x: 0, y: 0, width: FOLDED.maxWidth, height: FOLDED.height });
    expect(milestoneFrame({ width: 100, height: 400 }, [], true).width).toBe(FOLDED.minWidth);
    expect(milestoneFrame({ width: 400, height: 400 }, [], true).width).toBe(400);
    // Wide enough for its title beside its counts (a long one ends in an ellipsis past FOLDED.maxWidth).
    expect(milestoneFrame({ width: 292, height: 170 }, [], true, undefined, 'Test-mode foundations').width).toBe(Math.round(FOLDED.chrome + 21 * 7.4));
    expect(milestoneFrame({ width: 292, height: 170 }, [], true, undefined, 'x'.repeat(80)).width).toBe(FOLDED.maxWidth);
  });

  it('wires milestones from the middle of the gate’s foot to the top middle of the next, never a corner', () => {
    const box = { x: 100, y: 50, width: 400, height: 300 };
    const gate = { x: 10, y: 200, width: 380, height: 90 };
    const a = milestoneAnchors(box, gate);
    expect(a.out).toEqual({ x: 300, y: 340 });
    expect(a.in).toEqual({ x: 300, y: 50 - MILESTONE.badge / 2 });
    // Folded (no gate of its own): from the middle of the box's foot.
    expect(milestoneAnchors(box).out).toEqual({ x: 300, y: 350 });
  });

  it('runs a milestone’s line down, across the gap, and down again (straight when they line up)', () => {
    expect(milestoneRoute({ x: 300, y: 340 }, { x: 300, y: 430 }, 384, 384)).toEqual([
      { x: 300, y: 340 },
      { x: 300, y: 430 },
    ]);
    expect(milestoneRoute({ x: 300, y: 340 }, { x: 700, y: 430 }, 384, 384)).toEqual([
      { x: 300, y: 340 },
      { x: 300, y: 384 },
      { x: 700, y: 384 },
      { x: 700, y: 430 },
    ]);
    // Past a row in between: down a gap clear of the milestones there.
    const between = { x: 200, y: 450, width: 300, height: 200 };
    const route = milestoneRoute({ x: 300, y: 400 }, { x: 350, y: 800 }, 425, 750, [between]);
    expect(route[0]).toEqual({ x: 300, y: 400 });
    expect(route[route.length - 1]).toEqual({ x: 350, y: 800 });
    const lane = route.find((pt, i) => i > 0 && pt.y === 750)!.x;
    expect(lane < between.x || lane > between.x + between.width).toBe(true);
    for (let i = 1; i < route.length; i++) expect(route[i]!.x === route[i - 1]!.x || route[i]!.y === route[i - 1]!.y).toBe(true);
  });

  it('cuts every line into a milestone waiting on several where they meet, above its lock', () => {
    // Its lane runs straight down onto the lock: one long last stretch, still cut just above the lock.
    const lane = milestoneRoute({ x: 1133, y: 85 }, { x: 751, y: 743 }, 145, 703);
    expect(lane).toEqual([
      { x: 1133, y: 85 },
      { x: 1133, y: 145 },
      { x: 751, y: 145 },
      { x: 751, y: 743 },
    ]);
    expect(joinAt(lane, 703)).toEqual({
      line: [
        { x: 1133, y: 85 },
        { x: 1133, y: 145 },
        { x: 751, y: 145 },
        { x: 751, y: 703 },
      ],
      stem: [
        { x: 751, y: 703 },
        { x: 751, y: 743 },
      ],
    });
    // Coming in across the run above it: cut where it turns down.
    const across = milestoneRoute({ x: 368, y: 641 }, { x: 751, y: 743 }, 703, 703);
    expect(joinAt(across, 703)?.line).toEqual([
      { x: 368, y: 641 },
      { x: 368, y: 703 },
      { x: 751, y: 703 },
    ]);
    // Never on the lock itself.
    expect(joinAt(across, 740)?.stem[0]).toEqual({ x: 751, y: 731 });
  });

  it('places rows top to bottom, centred, a row under the milestones it waits on', () => {
    const sizes = new Map([
      ['a', { width: 400, height: 300 }],
      ['b', { width: 400, height: 200 }],
      ['c', { width: 300, height: 100 }],
      ['d', { width: 300, height: 100 }],
    ]);
    const at = placeMilestones([['a', 'b'], ['c', 'd']], sizes, new Map([['c', ['b']], ['d', ['a']]]));
    expect(at.get('a')).toEqual({ x: PLAN_GAPS.pad, y: PLAN_GAPS.pad, width: 400, height: 300 });
    expect(at.get('b')!.x).toBe(PLAN_GAPS.pad + 400 + PLAN_GAPS.side);
    // Each only as low as what it waits on: c under b (200 tall), d under a (300 tall).
    expect(at.get('c')!.y).toBe(PLAN_GAPS.pad + 200 + PLAN_GAPS.row);
    expect(at.get('d')!.y).toBe(PLAN_GAPS.pad + 300 + PLAN_GAPS.row);
    // d waits on a (left), c on b (right): d goes first, each under its own.
    expect(at.get('d')!.x).toBeLessThan(at.get('c')!.x);
    expect(at.get('d')!.x + 150).toBe(at.get('a')!.x + 200);
  });

  it('pulls up what hangs off finished milestones, and keeps what sits under a tall one below it', () => {
    // Two folded milestones and a tall open one in a row; one waits on the folded pair, one on the tall one.
    const sizes = new Map([
      ['done1', { width: 340, height: 56 }],
      ['done2', { width: 340, height: 56 }],
      ['open', { width: 700, height: 360 }],
      ['next', { width: 340, height: 56 }],
      ['after', { width: 340, height: 56 }],
    ]);
    const at = placeMilestones([['done1', 'done2', 'open'], ['next', 'after']], sizes, new Map([['next', ['done1', 'done2']], ['after', ['open']]]));
    expect(at.get('next')!.y).toBe(PLAN_GAPS.pad + 56 + PLAN_GAPS.row);
    expect(at.get('after')!.y).toBe(PLAN_GAPS.pad + 360 + PLAN_GAPS.row);
    // Never overlapping, and centred under what each waits on.
    const boxes = [...at.values()];
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    const mid = (id: string): number => at.get(id)!.x + at.get(id)!.width / 2;
    expect(mid('next')).toBe((mid('done1') + mid('done2')) / 2);
    expect(mid('after')).toBe(mid('open'));
    // Milestones wanting the same spot share it, side by side.
    const shared = placeMilestones([['top'], ['l', 'r']], new Map([['top', { width: 400, height: 50 }], ['l', { width: 300, height: 50 }], ['r', { width: 300, height: 50 }]]), new Map([['l', ['top']], ['r', ['top']]]));
    expect((shared.get('l')!.x + shared.get('r')!.x + 300) / 2).toBe(shared.get('top')!.x + 200);
    expect(shared.get('r')!.x - shared.get('l')!.x).toBe(300 + PLAN_GAPS.side);
    expect(Math.min(...[...shared.values()].map((b) => b.x))).toBe(PLAN_GAPS.pad);
  });

  it('never runs a line across a milestone in its way', () => {
    const tall = { x: 400, y: 0, width: 300, height: 400 };
    const route = milestoneRoute({ x: 100, y: 100 }, { x: 800, y: 600 }, 150, 550, [tall]);
    for (let i = 1; i < route.length; i++) {
      const [p, q] = [route[i - 1]!, route[i]!];
      const hits = Math.max(p.x, q.x) > tall.x && Math.min(p.x, q.x) < tall.x + tall.width && Math.max(p.y, q.y) > tall.y && Math.min(p.y, q.y) < tall.y + tall.height;
      expect(hits).toBe(false);
    }
  });

  it('ends a line in a small arrowhead pointing its way, and labels it just below the gate', () => {
    expect(arrowHead([{ x: 0, y: 0 }, { x: 0, y: 100 }], 4)).toBe('M-4,95 L0,100 L4,95');
    expect(arrowHead([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }], 4)).toBe('M95,4 L100,0 L95,-4');
    expect(arrowHead([{ x: 1, y: 1 }])).toBe('');
    expect(labelAt([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 90, y: 40 }])).toEqual({ x: 0, y: 20 });
  });

  it('glides a line with the cards: on their curve, square all the way, or not at all when its shape changes', () => {
    // The canvas's ease-out: from 0 to 1, always on its way, well ahead of linear early on.
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(0.25)).toBeGreaterThan(0.6);
    const steps = Array.from({ length: 21 }, (_, i) => easeOut(i / 20));
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    // A gate's line as its milestone opens: same corners, each stretch the same way, so it glides.
    const folded = [{ x: 100, y: 56 }, { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 140 }];
    const open = [{ x: 120, y: 400 }, { x: 120, y: 444 }, { x: 300, y: 444 }, { x: 300, y: 484 }];
    expect(glidable(folded, open)).toBe(true);
    const half = between(folded, open, 0.5);
    expect(half).toEqual([{ x: 110, y: 228 }, { x: 110, y: 272 }, { x: 300, y: 272 }, { x: 300, y: 312 }]);
    expect(half[1]!.x).toBe(half[0]!.x);
    expect(half[2]!.y).toBe(half[1]!.y);
    expect(between(folded, open, 1)).toEqual(open);
    // More corners, or a stretch turning from down to across: it can't stay square, so it doesn't glide.
    expect(glidable(folded, [{ x: 100, y: 56 }, { x: 100, y: 140 }])).toBe(false);
    expect(glidable([{ x: 0, y: 0 }, { x: 0, y: 50 }], [{ x: 0, y: 0 }, { x: 50, y: 0 }])).toBe(false);
    expect(glidable([], [])).toBe(false);
  });

  it('folds passed milestones by itself, and keeps your choice for each plan', () => {
    expect(isFolded({}, 'p', 'm', true)).toBe(true);
    expect(isFolded({}, 'p', 'm', false)).toBe(false);
    const opened = withFold({}, 'p', 'm', false);
    expect(isFolded(opened, 'p', 'm', true)).toBe(false);
    expect(isFolded(opened, 'q', 'm', true)).toBe(true);
    expect(isFolded(withFold(opened, 'p', 'n', true), 'p', 'm', true)).toBe(false);
    expect(readFolds({ p: { m: false, n: 'yes' }, q: 3, r: {} })).toEqual({ p: { m: false } });
    expect(readFolds(null)).toEqual({});
  });
});

describe('plan page layout', () => {
  it('reads older and broken saves as the defaults', () => {
    expect(readPlanLayout(undefined)).toEqual(DEFAULT_PLAN_LAYOUT);
    expect(readPlanLayout({ display: 'outline', chat: false })).toEqual({ ...DEFAULT_PLAN_LAYOUT, display: 'outline' });
    expect(readPlanLayout({ closed: ['a', 3, 'b'], chatWidth: 'wide' })).toEqual({ ...DEFAULT_PLAN_LAYOUT, closed: ['a', 'b'] });
    expect(readPlanLayout({ chatWidth: 120 }).chatWidth).toBe(CHAT_MIN);
  });

  it('remembers each plan’s chat on its own', () => {
    const one = setChatOpen(DEFAULT_PLAN_LAYOUT, 'p1', false);
    expect(chatOpen(one, 'p1')).toBe(false);
    expect(chatOpen(one, 'p2')).toBe(true);
    expect(setChatOpen(one, 'p1', false).closed).toEqual(['p1']);
    expect(chatOpen(setChatOpen(one, 'p1', true), 'p1')).toBe(true);
  });

  it('keeps the chat between its minimum and half the plan’s width', () => {
    expect(clampChatWidth(CHAT_DEFAULT, 1400)).toBe(CHAT_DEFAULT);
    expect(clampChatWidth(100, 1400)).toBe(CHAT_MIN);
    expect(clampChatWidth(1000, 1400)).toBe(700);
    // A narrow window: never below the minimum.
    expect(clampChatWidth(500, 400)).toBe(CHAT_MIN);
    expect(clampChatWidth(Number.NaN, 1400)).toBe(CHAT_DEFAULT);
  });
});

describe('a plan’s own conversation', () => {
  const plans = (...list: Array<Pick<Plan, 'home' | 'status'>>): PlansState => ({ enabled: true, style: '', plans: list as unknown as Plan[] });
  it('is a live plan’s home, not a finished one’s', () => {
    expect(isPlanHome(plans({ home: 'ws:a', status: 'draft' }), 'ws:a')).toBe(true);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'active' }), 'ws:a')).toBe(true);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'done' }), 'ws:a')).toBe(false);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'active' }), 'ws:b')).toBe(false);
  });

  it('is never left in plan mode, even when it had it on before (KLD-66)', () => {
    const store = new Store(initialState('room'));
    // Older state: plan mode switched on in two conversations, before either was a plan's home.
    store.dispatch({ type: 'plan_mode', channel: 'ws:a', on: true });
    store.dispatch({ type: 'plan_mode', channel: 'ws:b', on: true });
    // Plans load (a restart) with ws:a as a live plan's home: its plan mode goes, ws:b keeps it.
    store.dispatch({ type: 'plans_init', state: plans({ home: 'ws:a', status: 'active' }) });
    expect(store.getState().planMode).toEqual({ 'ws:b': true });
    // ws:b becomes a plan's home: off too.
    store.dispatch({ type: 'plan_put', plan: { id: 'p2', home: 'ws:b', status: 'draft' } as unknown as Plan });
    expect(store.getState().planMode).toEqual({});
  });
});
