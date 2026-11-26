import { type OnceTrigger, type ScheduleTrigger, type Trigger, scheduleMinutes } from './model.js';

/**
 * When a schedule runs (docs/sentinel.md §4, "Clock"): pure, in the Mac's local time (or `tz`,
 * an IANA zone, which the tests use to be the same anywhere). A slot that doesn't exist (the hour
 * the clocks skip in spring) runs at the moment after the gap; one that happens twice (autumn)
 * runs the first time only.
 */

const DAY = 24 * 60 * 60 * 1000;
/** How far ahead (or back) a slot is looked for: a monthly schedule's is never further. */
const MAX_DAYS = 400;
/** A slot this late is a missed one (the Mac slept, Beluga was closed); the tick runs every 30 s. */
export const LATE_MS = 5 * 60 * 1000;
/** How far a day's wall clock can move against the real one (the biggest daylight-saving change is an hour). */
const SHIFT_MIN = 60;

interface Wall {
  readonly y: number;
  /** 0–11. */
  readonly m: number;
  readonly d: number;
  readonly h: number;
  readonly min: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(tz, f);
  }
  return f;
}

/** The wall clock at `ms`, here or in `tz`. */
function wallOf(ms: number, tz?: string): Wall {
  if (!tz) {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day), h: Number(parts.hour) % 24, min: Number(parts.minute) };
}

/** How far `tz` is ahead of UTC at `ms`. */
function offsetAt(ms: number, tz: string): number {
  const w = wallOf(ms, tz);
  const asUtc = Date.UTC(w.y, w.m, w.d, w.h, w.min);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/** The moment a wall-clock time happens (the first time, or just after a gap). */
function atWall(y: number, m: number, d: number, h: number, min: number, tz?: string): number {
  if (!tz) return new Date(y, m, d, h, min, 0, 0).getTime();
  const guess = Date.UTC(y, m, d, h, min);
  const candidates = [...new Set([guess - offsetAt(guess - 12 * 3600_000, tz), guess - offsetAt(guess + 12 * 3600_000, tz)])];
  const exact = candidates.filter((t) => {
    const w = wallOf(t, tz);
    return w.y === y && w.m === m && w.d === d && w.h === h && w.min === min;
  });
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

const addDays = (y: number, m: number, d: number, n: number): { y: number; m: number; d: number } => {
  const t = new Date(Date.UTC(y, m, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
};
const weekday = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m, d)).getUTCDay();
const epochDay = (y: number, m: number, d: number): number => Math.round(Date.UTC(y, m, d) / DAY);

function parseAt(at: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  const h = m ? Math.min(23, Number(m[1])) : 0;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return [h, min];
}

/** The wall-clock times a schedule runs on one day, earliest first. */
function slotsOn(t: ScheduleTrigger, y: number, m: number, d: number): Array<readonly [number, number]> {
  const [h, min] = parseAt(t.at);
  switch (t.every) {
    case 'day':
      return [[h, min]];
    case 'other-day':
      // Every second day counted from 1 January 1970, so it never drifts with when it last ran.
      return epochDay(y, m, d) % 2 === 0 ? [[h, min]] : [];
    case 'week':
      return (t.days?.length ? t.days : [1]).includes(weekday(y, m, d)) ? [[h, min]] : [];
    case 'month':
      return d === (t.day ?? 1) ? [[h, min]] : [];
    case 'hours': {
      const n = t.hours ?? 1;
      const out: Array<readonly [number, number]> = [];
      for (let x = 0; x < 24; x++) if ((((x - h) % n) + n) % n === 0) out.push([x, min]);
      return out;
    }
    case 'minutes': {
      // On the clock, whatever `at` says: every 15 is :00, :15, :30 and :45 of every hour.
      const n = scheduleMinutes(t);
      const out: Array<readonly [number, number]> = [];
      for (let x = 0; x < 24; x++) for (let k = 0; k < 60; k += n) out.push([x, k]);
      return out;
    }
  }
}

/** Minutes since midnight on the wall clock. */
const wallMinutes = (w: Wall): number => w.h * 60 + w.min;

/**
 * The next time a schedule runs after `after` (its last slot that ran, or when it was turned on);
 * without it, the next after `now`. Not a schedule: undefined. A result at or before `now` is due.
 */
export function nextRunAt(trigger: Trigger, after: number | undefined, now: number, tz?: string): number | undefined {
  // One time: its moment, until a slot at or after it ran (or it was turned on after it).
  if (trigger.kind === 'once') return onceAt(trigger.at, after ?? now - 1);
  if (trigger.kind !== 'schedule') return undefined;
  const from = after ?? now;
  const start = wallOf(from, tz);
  // A schedule with hundreds of slots a day: on the first day, those well before `from` are passed over.
  const earliest = wallMinutes(start) - SHIFT_MIN;
  for (let i = 0; i < MAX_DAYS; i++) {
    const day = addDays(start.y, start.m, start.d, i);
    for (const [h, min] of slotsOn(trigger, day.y, day.m, day.d)) {
      if (i === 0 && h * 60 + min < earliest) continue;
      const t = atWall(day.y, day.m, day.d, h, min, tz);
      if (t > from) return t;
    }
  }
  return undefined;
}

/** The latest slot at or before `now`. */
export function lastSlotAt(trigger: Trigger, now: number, tz?: string): number | undefined {
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at);
    return at <= now ? at : undefined;
  }
  if (trigger.kind !== 'schedule') return undefined;
  const start = wallOf(now, tz);
  const latest = wallMinutes(start) + SHIFT_MIN;
  for (let i = 0; i < MAX_DAYS; i++) {
    const day = addDays(start.y, start.m, start.d, -i);
    const slots = slotsOn(trigger, day.y, day.m, day.d);
    for (let k = slots.length - 1; k >= 0; k--) {
      if (i === 0 && slots[k]![0] * 60 + slots[k]![1] > latest) continue;
      const t = atWall(day.y, day.m, day.d, slots[k]![0], slots[k]![1], tz);
      if (t <= now) return t;
    }
  }
  return undefined;
}

export type Due =
  /** Nothing yet (`at`: when). */
  | { readonly kind: 'wait'; readonly at?: number }
  /** Run now, once, for `slot` (the latest that passed); `late`: it was missed and is caught up; `missed`: slots that passed since the last run. */
  | { readonly kind: 'run'; readonly slot: number; readonly late: boolean; readonly missed: number }
  /** Missed while the Mac slept and the schedule says skip: nothing runs, the next comes after `slot`. */
  | { readonly kind: 'skip'; readonly slot: number; readonly missed: number };

/**
 * What a schedule should do now, given its last slot. However many slots passed while the Mac
 * was asleep or Beluga closed, it runs at most once (catch-up) or not at all (skip); a slot that
 * only just passed always runs.
 */
export function dueNow(trigger: Trigger, last: number | undefined, now: number, opts: { readonly lateMs?: number; readonly tz?: string } = {}): Due {
  if (trigger.kind !== 'schedule' && trigger.kind !== 'once') return { kind: 'wait' };
  const next = nextRunAt(trigger, last, now, opts.tz);
  if (next === undefined) return { kind: 'wait' };
  if (next > now) return { kind: 'wait', at: next };
  const slot = lastSlotAt(trigger, now, opts.tz) ?? next;
  const late = now - slot > (opts.lateMs ?? lateMsOf(trigger));
  const missed = countSlots(trigger, next, slot, opts.tz);
  if (late && trigger.missed === 'skip') return { kind: 'skip', slot, missed };
  return { kind: 'run', slot, late, missed };
}

const COUNT_MAX = 1000;

/** Never less than two ticks (30 s each): a slot the clock simply reached on its next look isn't a missed one. */
const LATE_FLOOR_MS = 60_000;

/** When a slot counts as missed: LATE_MS, or half the gap for a schedule every few minutes (never under LATE_FLOOR_MS). */
function lateMsOf(t: ScheduleTrigger | OnceTrigger): number {
  if (t.kind === 'once') return LATE_MS;
  return t.every === 'minutes' ? Math.min(LATE_MS, Math.max(LATE_FLOOR_MS, (scheduleMinutes(t) * 60_000) / 2)) : LATE_MS;
}

/** How many slots from `first` to `last`, both counted (capped: it's only said in words). */
function countSlots(trigger: Trigger, first: number, last: number, tz?: string): number {
  // Every few minutes: counted, not walked (a week asleep is two thousand slots).
  if (trigger.kind === 'schedule' && trigger.every === 'minutes') return Math.min(COUNT_MAX, Math.floor((last - first) / (scheduleMinutes(trigger) * 60_000)) + 1);
  if (trigger.kind === 'once') return 1;
  let n = 0;
  for (let t: number | undefined = first; t !== undefined && t <= last && n < COUNT_MAX; t = nextRunAt(trigger, t, t, tz)) n++;
  return n;
}

/** A one-time trigger's moment when it's still to come after `after`; undefined once it ran (or for a moment that can't be read). */
function onceAt(at: string, after: number): number | undefined {
  const t = Date.parse(at);
  return Number.isNaN(t) || t <= after ? undefined : t;
}
