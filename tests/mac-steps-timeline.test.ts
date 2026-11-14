import { describe, expect, it } from 'vitest';
import type { SubAgent } from '../src/core/store.js';
import type { StepSummary } from '../src/shared/steps.js';
import { foldOf, movedTogether, ownStepsOf, subRowView, timelineOf, workIn } from '../packages/mac/src/chat/steps/timeline.js';
import { sameFields } from '../packages/mac/src/lib/stable.js';

/** A card's steps with sub-agents and background work where they started, and which rows fold (KLD-51). */

const step = (id: string, startedAt: number, status: StepSummary['status'] = 'done'): StepSummary => ({ id, kind: 'tool', title: id, status, startedAt });
const sub = (id: string, startedAt: number | undefined, status: SubAgent['status'] = 'done'): SubAgent => ({ id, title: id, steps: [], status, kind: 'background', ...(startedAt === undefined ? {} : { startedAt }) });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('timelineOf', () => {
  const rows = [step('a', 10), step('b', 20), step('c', 30)];

  it('puts a sub-agent where its launching call was', () => {
    expect(ids(timelineOf(rows, [sub('task', 99)], (id) => (id === 'task' ? 15 : undefined)))).toEqual(['a', 'sub:task', 'b', 'c']);
  });

  it('else where it started, in start order', () => {
    expect(ids(timelineOf(rows, [sub('late', 25), sub('early', 12)], () => undefined))).toEqual(['a', 'sub:early', 'b', 'sub:late', 'c']);
  });

  it('after the steps when it has no start (kept before it had one, or a friend’s one-line steps)', () => {
    expect(ids(timelineOf(rows, [sub('old', undefined)], () => undefined))).toEqual(['a', 'b', 'c', 'sub:old']);
    expect(ids(timelineOf([], [sub('only', 5)], () => undefined))).toEqual(['sub:only']);
  });
});

describe('remarks in the timeline', () => {
  const rows = [step('a', 10), step('b', 20), step('c', 30)];

  it('puts what Claude said between the steps it came between', () => {
    expect(ids(timelineOf(rows, [], () => undefined, [{ text: 'first', ts: 5 }, { text: 'then', ts: 22 }]))).toEqual(['remark:5', 'a', 'b', 'remark:22', 'c']);
  });

  it('among sub-agents by time, and after a friend’s one-line steps (they have no times)', () => {
    expect(ids(timelineOf(rows, [sub('late', 25)], () => undefined, [{ text: 'x', ts: 24 }]))).toEqual(['a', 'b', 'remark:24', 'sub:late', 'c']);
    const lines = [step('line-0', 1), step('line-1', 1)];
    expect(ids(timelineOf(lines, [], () => undefined, [{ text: 'x', ts: 4 }]))).toEqual(['line-0', 'line-1', 'remark:4']);
  });

  it('never counts as a step, and folds with the steps around it', () => {
    const t = timelineOf([step('a', 1), step('b', 3), step('c', 5), step('d', 7)], [], () => undefined, [{ text: 'x', ts: 2 }]);
    const { older } = foldOf(t, 2);
    expect(ids(older)).toEqual(['a', 'remark:2', 'b']);
    expect(workIn(older)).toBe(2);
  });

  it('never takes one of the kept rows: the last few steps stay shown', () => {
    const t = timelineOf([step('a', 1), step('b', 3), step('c', 5), step('d', 7)], [], () => undefined, [{ text: 'x', ts: 6 }]);
    expect(ids(foldOf(t, 2, true).shown)).toEqual(['c', 'remark:6', 'd']);
  });
});

describe('what Claude said, while it works and once done', () => {
  const rows = [step('a', 1), step('b', 3), step('c', 5), step('d', 7), step('e', 9)];
  const said = [{ text: 'looking', ts: 2 }, { text: 'found it', ts: 4 }];

  it('keeps the newest thing it said in sight while it works, however many steps came after it', () => {
    const { older, shown } = foldOf(timelineOf(rows, [], () => undefined, said), 2, true);
    expect(ids(older)).toEqual(['a', 'remark:2', 'b', 'c']);
    expect(ids(shown)).toEqual(['remark:4', 'd', 'e']);
  });

  it('a newer remark pops in and the one before goes into the fold', () => {
    const later = [...said, { text: 'now the tests', ts: 8 }];
    const { older, shown } = foldOf(timelineOf(rows, [], () => undefined, later), 2, true);
    expect(ids(older)).toContain('remark:4');
    expect(ids(shown)).toEqual(['d', 'remark:8', 'e']);
  });

  it('shows all it said on a short turn while it works (nothing folds yet)', () => {
    const t = timelineOf([step('a', 1), step('b', 3)], [], () => undefined, said);
    expect(foldOf(t, 2, true).older).toEqual([]);
  });

  it('folds everything it said once the turn is done, even when its steps stay shown', () => {
    const many = foldOf(timelineOf(rows, [], () => undefined, said), 3);
    expect(ids(many.older)).toEqual(['a', 'remark:2', 'b', 'remark:4']);
    expect(ids(many.shown)).toEqual(['c', 'd', 'e']);
    const short = foldOf(timelineOf([step('a', 1), step('b', 3)], [], () => undefined, said), 3);
    expect(ids(short.older)).toEqual(['remark:2', 'remark:4']);
    expect(workIn(short.older)).toBe(0);
    expect(ids(short.shown)).toEqual(['a', 'b']);
  });
});

describe('foldOf', () => {
  it('never folds a failed step away', () => {
    const steps = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ kind: 'step' as const, id, step: { id, status: i === 1 ? 'error' : 'done' } as never }));
    const { older, shown } = foldOf(steps, 1);
    expect(older.map((e) => e.id)).toEqual(['a', 'c', 'd']);
    expect(shown.map((e) => e.id)).toEqual(['b', 'e']);
  });

  it('folds all but the last few finished rows, never just one', () => {
    const t = timelineOf([step('a', 1), step('b', 2), step('c', 3)], [], () => undefined);
    expect(foldOf(t, 2).older).toEqual([]);
    const more = timelineOf([step('a', 1), step('b', 2), step('c', 3), step('d', 4)], [], () => undefined);
    const { older, shown } = foldOf(more, 2);
    expect(ids(older)).toEqual(['a', 'b']);
    expect(ids(shown)).toEqual(['c', 'd']);
  });

  it('keeps a running sub-agent shown in its place, and folds a finished one with the steps', () => {
    const t = timelineOf([step('a', 1), step('b', 3), step('c', 5), step('d', 7), step('e', 9)], [sub('bg', 2, 'running'), sub('done', 4)], () => undefined);
    const { older, shown } = foldOf(t, 2);
    expect(ids(older)).toEqual(['a', 'b', 'sub:done', 'c']);
    expect(ids(shown)).toEqual(['sub:bg', 'd', 'e']);
  });
});

describe('a sub-agent row on clock ticks (KLD-72)', () => {
  const toggle = (): void => undefined;
  const load = async (): Promise<undefined> => undefined;
  const subs = [sub('bg', 5, 'running'), sub('agent', 6, 'running')];
  const steps = (status: StepSummary['status']): StepSummary[] => [step('a', 1), { ...step('own1', 7, status), parent: 'agent' }];

  /** How often a memo'd SubAgentRow draws over `ticks` seconds: each time a prop isn't the same (React.memo's own check). */
  function renders(rich: () => StepSummary[], isOpen: (id: string) => boolean, ticks = 30): Record<string, number> {
    let own: ReturnType<typeof ownStepsOf> | undefined;
    const last = new Map<string, Record<string, unknown>>();
    const count: Record<string, number> = {};
    for (let t = 0; t < ticks; t++) {
      // Each tick the card draws again: the daemon's records come back as new objects.
      own = ownStepsOf(own, rich().map((x) => ({ ...x })), subs);
      for (const x of subs) {
        const mine = own.get(x.id)!;
        const props = { sub: x, own: mine, detail: 'full', toggle, load, live: true, ...subRowView(x, mine, isOpen, true, 1000 * t) };
        const was = last.get(x.id);
        if (!was || !sameFields(was, props)) count[x.id] = (count[x.id] ?? 0) + 1;
        last.set(x.id, props);
      }
    }
    return count;
  }

  it('draws once over 30 ticks when nothing changed, running or not, open or closed', () => {
    expect(renders(() => steps('done'), () => false)).toEqual({ bg: 1, agent: 1 });
    expect(renders(() => steps('running'), () => false)).toEqual({ bg: 1, agent: 1 });
    // Open, with its own steps finished: nothing on it moves.
    expect(renders(() => steps('done'), (id) => id === 'sub:agent')).toEqual({ bg: 1, agent: 1 });
  });

  it('follows the clock only while it is open on a running step of its own', () => {
    expect(renders(() => steps('running'), (id) => id === 'sub:agent')).toEqual({ bg: 1, agent: 30 });
  });

  it('draws again when one of its own steps changes, and only that row', () => {
    let t = 0;
    const r = renders(() => (t++ < 10 ? steps('running') : steps('done')), () => false);
    expect(r).toEqual({ bg: 1, agent: 2 });
  });

  it('opening one of its own steps draws it again', () => {
    const own = ownStepsOf(undefined, steps('done'), subs).get('agent')!;
    expect(subRowView(subs[1]!, own, (id) => id === 'own1', true, 0)).toEqual({ open: false, opened: 'own1', now: 0 });
  });
});

describe('movedTogether', () => {
  it('one row folding slides; several at once move as one', () => {
    expect(movedTogether(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(movedTogether(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(true);
    // The answer lands: more rows show again.
    expect(movedTogether(['a', 'b', 'c'], ['a'])).toBe(true);
    expect(movedTogether(['a'], ['a'])).toBe(false);
  });
});
