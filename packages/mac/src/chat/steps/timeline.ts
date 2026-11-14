import type { Remark, SubAgent } from '../../../../../src/core/store.js';
import type { StepSummary } from '../../../../../src/shared/steps.js';
import { keepSameById, keepSameLists } from '../../lib/stable.js';

/** One row of a card's steps: a step, a sub-agent (background work) where it started, or what Claude said on the way. */
export type Entry =
  | { readonly kind: 'step'; readonly id: string; readonly step: StepSummary }
  | { readonly kind: 'sub'; readonly id: string; readonly sub: SubAgent }
  | { readonly kind: 'remark'; readonly id: string; readonly remark: Remark };

/** Still going: never folded away, so what's happening stays in sight. */
export const isLive = (e: Entry): boolean => (e.kind === 'sub' ? e.sub.status === 'running' : e.kind === 'step' ? e.step.status === 'running' : false);

/** Failed: never folded away either, so an error always shows. */
const isFailed = (e: Entry): boolean => e.kind === 'step' && e.step.status === 'error';

/**
 * The steps with each sub-agent in the place it started: where its launching call is (launchedAt,
 * your own Claude's records), else when it started; and what Claude said between its steps
 * (remarks), when it said it. Steps without real times (one-line steps of a friend's Claude) all
 * read as the card's start, so sub-agents and remarks go after them; so do sub-agents kept before
 * they had a start.
 */
export function timelineOf(rows: readonly StepSummary[], subs: readonly SubAgent[], launchedAt: (id: string) => number | undefined, remarks: readonly Remark[] = []): Entry[] {
  const placed = [
    ...subs.map((sub) => ({ entry: subEntry(sub), at: launchedAt(sub.id) ?? sub.startedAt ?? Infinity })),
    ...remarks.map((remark) => ({ entry: { kind: 'remark', id: `remark:${remark.ts}`, remark } as const, at: remark.ts })),
  ].sort((a, b) => a.at - b.at);
  const out: Entry[] = [];
  let next = 0;
  for (const step of rows) {
    while (next < placed.length && placed[next]!.at < step.startedAt) out.push(placed[next++]!.entry);
    out.push({ kind: 'step', id: step.id, step });
  }
  while (next < placed.length) out.push(placed[next++]!.entry);
  return out;
}

const subEntry = (sub: SubAgent): Entry => ({ kind: 'sub', id: `sub:${sub.id}`, sub });

/** How many of these rows are work (steps, sub-agents): what "N steps" counts, not what was said on the way. */
export const workIn = (entries: readonly Entry[]): number => entries.filter((e) => e.kind !== 'remark').length;

/**
 * Which finished rows fold into "N steps · 12s": all but the last `keep` of them, once that's
 * more than one row (folding a single row hides nothing). Live and failed rows always stay shown, in place.
 *
 * What Claude said on the way (remarks) never counts toward `keep`. While it works (`working`),
 * the newest thing it said stays shown in its place, so you can follow along; the ones before it
 * fold with the steps. Once the turn is done, they all fold: only its answer stands out.
 */
export function foldOf(entries: readonly Entry[], keep: number, working = false): { older: Entry[]; shown: Entry[] } {
  const remarks = entries.filter((e) => e.kind === 'remark');
  const latest = working ? remarks.at(-1) : undefined;
  const done = entries.filter((e) => e.kind !== 'remark' && !isLive(e) && !isFailed(e));
  const work = done.length <= keep + 1 ? [] : done.slice(0, done.length - keep);
  // While it works, earlier remarks fold only once some steps do (a short turn shows all it said).
  const said = working ? (work.length ? remarks.filter((e) => e !== latest) : []) : remarks;
  const older = new Set<Entry>([...work, ...said]);
  if (!older.size) return { older: [], shown: [...entries] };
  return { older: entries.filter((e) => older.has(e)), shown: entries.filter((e) => !older.has(e)) };
}

/**
 * Each sub-agent's own steps (your own Claude's records), a list kept the same object while its
 * steps are, so the sub-agent's row (memo) isn't drawn again for another step's news (KLD-72).
 */
export function ownStepsOf(prev: ReadonlyMap<string, readonly StepSummary[]> | undefined, rich: readonly StepSummary[] | undefined, subs: readonly SubAgent[]): ReadonlyMap<string, readonly StepSummary[]> {
  const next = new Map<string, readonly StepSummary[]>(subs.map((sub) => [sub.id, []]));
  for (const step of rich ?? []) if (step.parent && next.has(step.parent)) (next.get(step.parent) as StepSummary[]).push(step);
  // A fresh page of records is all new objects: the steps that read the same stay put.
  for (const [id, list] of next) next.set(id, keepSameById(prev?.get(id) ?? [], list));
  return keepSameLists(prev, next);
}

/**
 * What a sub-agent's row shows besides the sub-agent: plain values, so the row (memo) draws again
 * only when they change. Only an open row with a running step of its own follows the clock.
 */
export function subRowView(sub: SubAgent, own: readonly StepSummary[], isOpen: (id: string) => boolean, live: boolean, now: number): { open: boolean; opened: string; now: number } {
  const open = isOpen(`sub:${sub.id}`);
  return {
    open,
    opened: own.filter((x) => isOpen(x.id)).map((x) => x.id).join(' '),
    now: open && live && own.some((x) => x.status === 'running') ? now : 0,
  };
}

/**
 * Rows that change sides of the fold together (the answer landing lets more rows show; several
 * sub-agents finishing at once): more than one moves as one, without each sliding (KLD-72).
 */
export function movedTogether(before: readonly string[], after: readonly string[]): boolean {
  const was = new Set(before);
  const now = new Set(after);
  let moved = 0;
  for (const id of was) if (!now.has(id)) moved++;
  for (const id of now) if (!was.has(id)) moved++;
  return moved > 1;
}
