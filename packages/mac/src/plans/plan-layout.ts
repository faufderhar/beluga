/**
 * How a plan's page is laid out, as plain data: canvas or list, whether each plan's chat is open,
 * and how wide the chat is (saved in localStorage); and the plan graph's geometry, below. No DOM
 * here, so it's tested on its own.
 */

export type Display = 'graph' | 'outline';

export interface PlanLayout {
  readonly display: Display;
  /** Each plan's chat that you closed (open is the default, so only the closed ones are kept). */
  readonly closed: readonly string[];
  /** The chat column's width, in pixels (one for every plan). */
  readonly chatWidth: number;
}

export const PLAN_LAYOUT_KEY = 'beluga.plan.v1';
export const CHAT_MIN = 300;
export const CHAT_DEFAULT = 380;
/** The chat never takes more than this share of the plan's width: the map stays the bigger part. */
export const CHAT_MAX_SHARE = 0.5;
/** How many closed chats are remembered (the oldest are forgotten). */
const REMEMBERED = 200;

export const DEFAULT_PLAN_LAYOUT: PlanLayout = { display: 'graph', closed: [], chatWidth: CHAT_DEFAULT };

/** A saved layout made whole (older versions kept one `chat` flag for every plan: closed then means closed nowhere yet). */
export function readPlanLayout(raw: unknown): PlanLayout {
  const r = (raw ?? {}) as { display?: unknown; closed?: unknown; chatWidth?: unknown };
  return {
    display: r.display === 'outline' ? 'outline' : 'graph',
    closed: Array.isArray(r.closed) ? r.closed.filter((x): x is string => typeof x === 'string').slice(-REMEMBERED) : [],
    chatWidth: typeof r.chatWidth === 'number' && Number.isFinite(r.chatWidth) ? Math.max(CHAT_MIN, Math.round(r.chatWidth)) : CHAT_DEFAULT,
  };
}

export const chatOpen = (layout: PlanLayout, planId: string): boolean => !layout.closed.includes(planId);

/** Open or close one plan's chat. */
export function setChatOpen(layout: PlanLayout, planId: string, open: boolean): PlanLayout {
  const rest = layout.closed.filter((x) => x !== planId);
  return { ...layout, closed: open ? rest : [...rest, planId].slice(-REMEMBERED) };
}

/** The chat's width beside a plan area this wide: at least CHAT_MIN, at most CHAT_MAX_SHARE of it. */
export function clampChatWidth(width: number, areaWidth: number): number {
  const max = Math.max(CHAT_MIN, Math.floor(areaWidth * CHAT_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(CHAT_MIN, Number.isFinite(width) ? width : CHAT_DEFAULT)));
}

// ---------------------------------------------------------------- the plan graph's sizes and lines

/*
 * The plan canvas's geometry (PlanCanvas.tsx), as plain numbers: how big a task card is (a finished one
 * is a slim row), how big a milestone box is (its tasks, then its gate: a bar across its foot listing
 * its criteria), how small a folded milestone gets, where milestones sit in rows, and how a line runs
 * from one milestone's gate down into the top of the next. ELK only lays out the tasks inside a box.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Box extends Point, Size {}

/** A task card: its head, a two-line title and its state line (.task in plans.module.css). */
export const TASK_CARD: Size = { width: 252, height: 100 };
/** A finished task: one slim row, its tick, key and title (.taskCompact in PlanCanvas.module.css). */
export const TASK_COMPACT: Size = { width: 252, height: 40 };
/** The task states drawn as a slim row: their work is behind them. */
export const COMPACT_STATES: ReadonlySet<string> = new Set(['done', 'planned', 'canceled']);

export const taskSize = (state: string): Size => (COMPACT_STATES.has(state) ? TASK_COMPACT : TASK_CARD);

/** A milestone box: its head, its tasks with room around them, its gate inset at its foot. */
export const MILESTONE = { head: 62, side: 20, minWidth: 340, gateGap: 16, inset: 10, badge: 20 } as const;
/** The gate bar: a head row, then a row per criterion (up to two lines of ~6.2px characters each). */
export const GATE = { head: 34, line: 16, row: 5, foot: 12, padX: 14, bullet: 22, char: 6.2 } as const;
/** A folded milestone: one summary row, as wide as its title needs (beside `chrome`: its tick, counts, chip and chevron) within these. */
export const FOLDED = { height: 56, minWidth: 340, maxWidth: 520, chrome: 330 } as const;
/** Room between milestones side by side, between rows of them (their lines run there), and around the plan. */
export const PLAN_GAPS = { side: 56, row: 88, pad: 24 } as const;

/** How tall a gate bar this wide is: from its criteria's words (the shape), never from their state. */
export function gateHeight(criteria: readonly string[], width: number): number {
  const chars = Math.max(12, Math.floor((width - 2 * GATE.padX - GATE.bullet) / GATE.char));
  const lines = criteria.length ? criteria.reduce((n, c) => n + Math.min(2, Math.max(1, Math.ceil(c.length / chars))), 0) : 1;
  const rows = Math.max(1, criteria.length);
  return Math.round(GATE.head + lines * GATE.line + (rows - 1) * GATE.row + GATE.foot);
}

/** A milestone box laid out: its size, its gate's place in it, and how far its tasks shift across (to centre them). */
export interface MilestoneFrame extends Size {
  readonly folded: boolean;
  /** Relative to the box; a folded milestone's gate is its summary row (the whole box). */
  readonly gate: Box;
  readonly shiftX: number;
}

/**
 * A milestone's box from its tasks' layout (`inner`: ELK's size for them, its head's room included)
 * and its criteria. Open: at least MILESTONE.minWidth wide, the gate a bar across its foot. Folded:
 * one summary row, wide enough for its `title`. `height` stretches an open box, its gate staying
 * at the foot.
 */
export function milestoneFrame(inner: Size, criteria: readonly string[], folded: boolean, height?: number, title = ''): MilestoneFrame {
  if (folded) {
    // Room for its title (13.5px, ~7.4px a character) beside its tick, counts, criteria chip and chevron.
    const wanted = FOLDED.chrome + title.length * 7.4;
    const width = Math.round(Math.max(FOLDED.minWidth, Math.min(FOLDED.maxWidth, Math.max(inner.width, wanted))));
    return { folded, width, height: FOLDED.height, gate: { x: 0, y: 0, width, height: FOLDED.height }, shiftX: 0 };
  }
  const width = Math.max(MILESTONE.minWidth, Math.round(inner.width));
  const gateWidth = width - 2 * MILESTONE.inset;
  const gateH = gateHeight(criteria, gateWidth);
  const natural = Math.max(MILESTONE.head, Math.round(inner.height)) + MILESTONE.gateGap + gateH + MILESTONE.inset;
  const tall = Math.max(natural, Math.round(height ?? 0));
  return { folded, width, height: tall, gate: { x: MILESTONE.inset, y: tall - MILESTONE.inset - gateH, width: gateWidth, height: gateH }, shiftX: Math.max(0, Math.round((width - inner.width) / 2)) };
}

/**
 * Where a milestone's lines meet it: they come in at the top, in the middle (onto its lock badge,
 * which straddles its top edge), and leave from the middle of its gate's foot (through the gate,
 * never from a corner).
 */
export function milestoneAnchors(box: Box, gate?: Box): { readonly in: Point; readonly out: Point } {
  const g = gate ?? { x: 0, y: 0, width: box.width, height: box.height };
  return { in: { x: box.x + box.width / 2, y: box.y - MILESTONE.badge / 2 }, out: { x: box.x + g.x + g.width / 2, y: box.y + g.y + g.height } };
}

/**
 * Lefts for boxes this wide, in this order, each as near as it can be to where it wants to sit
 * (`want`) without overlapping the one before (PLAN_GAPS.side apart): boxes that would collide
 * share the shift between them, so a group wanting the same spot centres on it.
 */
function spread(widths: readonly number[], want: readonly number[]): number[] {
  const offs: number[] = [];
  let o = 0;
  for (const w of widths) {
    offs.push(o);
    o += w + PLAN_GAPS.side;
  }
  // Each box's wish less its place in the row: those must not go down, so pool the ones that would.
  const blocks: { n: number; sum: number }[] = [];
  for (let i = 0; i < want.length; i++) {
    blocks.push({ n: 1, sum: want[i]! - offs[i]! });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.n) {
      const last = blocks.pop()!;
      const prev = blocks[blocks.length - 1]!;
      prev.n += last.n;
      prev.sum += last.sum;
    }
  }
  return blocks.flatMap((b) => Array.from({ length: b.n }, () => b.sum / b.n)).map((q, i) => q + offs[i]!);
}

/**
 * Milestones in their rows (milestoneRows), like a tree: each under the middle of the milestones it
 * waits on (else where a row centred on the widest puts it), side by side with the rest of its row,
 * and only as low as it has to be: just below what it waits on and what sits above it. So a finished
 * milestone folding to one row pulls up what hangs off it, and a tall one beside it pushes down only
 * what's under it. A row whose milestones all wait on ones above sits in the order of those (so lines
 * cross as little as they can).
 */
export function placeMilestones(rows: ReadonlyArray<readonly string[]>, sizes: ReadonlyMap<string, Size>, parents: ReadonlyMap<string, readonly string[]> = new Map()): Map<string, Box> {
  const sizeOf = (id: string): Size => sizes.get(id) ?? { width: 0, height: 0 };
  const widthOf = (row: readonly string[]): number => row.reduce((w, id) => w + sizeOf(id).width, 0) + Math.max(0, row.length - 1) * PLAN_GAPS.side;
  const widest = Math.max(0, ...rows.map(widthOf));
  const out = new Map<string, Box>();
  for (const raw of rows) {
    const above = (id: string): Box[] => (parents.get(id) ?? []).map((p) => out.get(p)).filter((b): b is Box => !!b);
    const centre = (id: string): number | undefined => {
      const at = above(id);
      return at.length ? at.reduce((s, b) => s + b.x + b.width / 2, 0) / at.length : undefined;
    };
    const row = raw.every((id) => centre(id) !== undefined)
      ? raw
          .map((id, i) => ({ id, i, c: centre(id)! }))
          .sort((a, b) => a.c - b.c || a.i - b.i)
          .map((x) => x.id)
      : raw;
    let x = PLAN_GAPS.pad + (widest - widthOf(row)) / 2;
    const want = row.map((id) => {
      const w = sizeOf(id).width;
      const c = centre(id);
      const at = c === undefined ? x : c - w / 2;
      x += w + PLAN_GAPS.side;
      return at;
    });
    const lefts = spread(row.map((id) => sizeOf(id).width), want);
    const placed = [...out.values()];
    row.forEach((id, i) => {
      const s = sizeOf(id);
      const left = Math.round(lefts[i]!);
      const over = placed.filter((b) => b.x < left + s.width + PLAN_GAPS.side / 2 && b.x + b.width > left - PLAN_GAPS.side / 2);
      const y = Math.max(PLAN_GAPS.pad, ...[...over, ...above(id)].map((b) => b.y + b.height + PLAN_GAPS.row));
      out.set(id, { x: left, y, width: s.width, height: s.height });
    });
  }
  // Pulled under their parents, rows can reach past the left edge: the plan starts at the pad again.
  const shift = PLAN_GAPS.pad - Math.min(PLAN_GAPS.pad, ...[...out.values()].map((b) => b.x));
  if (shift) for (const [id, b] of out) out.set(id, { ...b, x: b.x + shift });
  return out;
}

const crosses = (b: Box, x: number, y0: number, y1: number, margin: number): boolean => x > b.x - margin && x < b.x + b.width + margin && Math.max(y0, y1) > b.y && Math.min(y0, y1) < b.y + b.height;
const crossesAcross = (b: Box, y: number, x0: number, x1: number): boolean => y > b.y && y < b.y + b.height && Math.max(x0, x1) > b.x && Math.min(x0, x1) < b.x + b.width;

/** Corners in a line that don't turn (or that repeat a point) dropped. */
function tidy(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const before = out[out.length - 2];
    if (before && last && ((Math.abs(before.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(before.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * The line from a milestone's gate (`from`, its out anchor) down into the top of one that waits on it
 * (`to`, its in anchor): straight down to `exitY` (the gap below its row), across, down to `enterY`
 * (the gap above the next one's row), across, and down into it. Across rows in between, it runs down
 * the nearest gap clear of the milestones there (`obstacles`). Every corner a right angle (rounded
 * when drawn), so it reads like a tree, top to bottom.
 */
export function milestoneRoute(from: Point, to: Point, exitY: number, enterY: number, obstacles: readonly Box[] = []): Point[] {
  if (enterY - exitY < 1) return tidy([from, { x: from.x, y: enterY }, { x: to.x, y: enterY }, to]);
  const margin = PLAN_GAPS.side / 4;
  // Its lane down clear of the milestones in between, and its runs across (below its own and above the next) too.
  const clear = (x: number): boolean => !obstacles.some((b) => crosses(b, x, exitY, enterY, margin) || crossesAcross(b, exitY, from.x, x) || crossesAcross(b, enterY, x, to.x));
  const mid = (from.x + to.x) / 2;
  const candidates = [to.x, from.x, ...obstacles.flatMap((b) => [b.x - PLAN_GAPS.side / 2, b.x + b.width + PLAN_GAPS.side / 2])].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  const lane = candidates.find(clear) ?? Math.min(from.x, to.x, ...obstacles.map((b) => b.x)) - PLAN_GAPS.side / 2;
  return tidy([from, { x: from.x, y: exitY }, { x: lane, y: exitY }, { x: lane, y: enterY }, { x: to.x, y: enterY }, to]);
}

/**
 * A line into a milestone that waits on several, cut where they all meet: at `y` (the run across above
 * its lock) straight over its end. The line stops there; the stem goes on from there into the lock. A
 * line whose lane runs straight down onto the lock has one long last stretch (its corners tidied away),
 * so it's cut at that height, never at its top.
 */
export function joinAt(points: readonly Point[], y: number): { readonly line: Point[]; readonly stem: readonly [Point, Point] } | undefined {
  const end = points[points.length - 1];
  if (points.length < 2 || !end) return undefined;
  // Never on the lock itself: a stem stays long enough for its arrowhead.
  const knot = { x: end.x, y: Math.min(y, end.y - 12) };
  return { line: tidy([...points.slice(0, -1), knot]), stem: [knot, end] };
}

/** A small open arrowhead at a line's end, pointing the way its last stretch runs (an SVG path). */
export function arrowHead(points: readonly Point[], size = 5): string {
  const tip = points[points.length - 1];
  const prev = [...points].reverse().find((p) => tip && Math.hypot(p.x - tip.x, p.y - tip.y) > 0.5);
  if (!tip || !prev) return '';
  const len = Math.hypot(tip.x - prev.x, tip.y - prev.y);
  const ux = (tip.x - prev.x) / len;
  const uy = (tip.y - prev.y) / len;
  const r = (n: number): number => Math.round(n * 100) / 100;
  const back = { x: tip.x - ux * size * 1.25, y: tip.y - uy * size * 1.25 };
  return `M${r(back.x - uy * size)},${r(back.y + ux * size)} L${r(tip.x)},${r(tip.y)} L${r(back.x + uy * size)},${r(back.y - ux * size)}`;
}

/** Where along a milestone's line its label sits: halfway down its first straight stretch (just below the gate). */
export function labelAt(points: readonly Point[]): Point | undefined {
  const [a, b] = points;
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined;
}

// ---- gliding: lines move with the cards

/** How long a re-laid plan glides (the cards' transform in PlanCanvas.module.css: the same ms, the same curve). */
export const GLIDE_MS = 520;

/** The canvas's ease-out, `cubic-bezier(0.22, 1, 0.36, 1)` (--ease-out in tokens.css): how far along a glide is at `t` (0 to 1). */
export function easeOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const at = (a: number, b: number, s: number): number => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  // The curve's x runs one way only: halve towards the s whose x is t, then read its y.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}

const along = (a: Point, b: Point): 'h' | 'v' | 'o' => (Math.abs(a.y - b.y) < 0.5 ? 'h' : Math.abs(a.x - b.x) < 0.5 ? 'v' : 'o');

/**
 * Whether a line can glide from one shape to the other point by point: as many corners, each stretch
 * running the same way (across or down), so it stays square all the way. Otherwise it fades instead.
 */
export function glidable(from: readonly Point[], to: readonly Point[]): boolean {
  if (from.length !== to.length || from.length < 2) return false;
  for (let i = 1; i < to.length; i++) if (along(from[i - 1]!, from[i]!) !== along(to[i - 1]!, to[i]!)) return false;
  return true;
}

/** A line `k` of the way (0 to 1) from one shape to the other (they're glidable). */
export function between(from: readonly Point[], to: readonly Point[], k: number): Point[] {
  return to.map((p, i) => {
    const a = from[i] ?? p;
    return { x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k };
  });
}

// ---- folding

/** Which milestones you folded or opened yourself, by plan, then milestone (kept for the session). */
export type Folds = Readonly<Record<string, Readonly<Record<string, boolean>>>>;
export const FOLDS_KEY = 'beluga.plan.folds.v1';

/** A milestone is folded when you folded it; else when it's passed (passed ones fold themselves). */
export const isFolded = (folds: Folds, planId: string, milestoneId: string, passed: boolean): boolean => folds[planId]?.[milestoneId] ?? passed;

export const withFold = (folds: Folds, planId: string, milestoneId: string, folded: boolean): Folds => ({ ...folds, [planId]: { ...folds[planId], [milestoneId]: folded } });

/** Saved folds made whole (anything that isn't a yes or no is forgotten). */
export function readFolds(raw: unknown): Folds {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Record<string, boolean>> = {};
  for (const [plan, ms] of Object.entries(raw as Record<string, unknown>)) {
    if (!ms || typeof ms !== 'object') continue;
    const kept = Object.entries(ms as Record<string, unknown>).filter((e): e is [string, boolean] => typeof e[1] === 'boolean');
    if (kept.length) out[plan] = Object.fromEntries(kept);
  }
  return out;
}
