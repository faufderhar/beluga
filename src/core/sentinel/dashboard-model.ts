import type { Compare } from './metrics.js';
import type { MetricSeries, OutputFormat, SentinelState, StepOutput, StepKind } from './model.js';
import { knownOr } from '../../shared/known-or.js';

/**
 * Sentinel's dashboard (docs/sentinel.md §10): your own selection of tiles from any sentinel, in a
 * grid of six columns. The types, and the pure part every screen shares: what a tile draws from,
 * whether its sentinel is paused, a draft or gone, what a step's output is (Markdown, JSON, text),
 * the first dashboard made for you, where a dragged tile lands, and a dashboard as Markdown. Tiles
 * name a sentinel and a metric or a step, never a source: no secrets in a tile. Browser-safe.
 */

/** number · series (over time, or a kept array) · table · output (a step's export) · text · divider. */
export const TILE_KINDS = ['number', 'series', 'table', 'output', 'text', 'divider'] as const;
export type TileKind = (typeof TILE_KINDS)[number];
/** What a series tile was called before BLG-246 (read as `series`). */
export const LEGACY_TILE_KINDS: Readonly<Record<string, TileKind>> = { chart: 'series' };
export const CHART_TILE_KINDS = ['line', 'area', 'bar'] as const;
export type ChartTileKind = (typeof CHART_TILE_KINDS)[number];
export const TILE_WIDTHS = [1, 2, 3, 4, 6] as const;
export type TileWidth = (typeof TILE_WIDTHS)[number];
/** Normal, or tall (twice the room: a long report, a big chart). */
export const TILE_HEIGHTS = [1, 2] as const;
export type TileHeight = (typeof TILE_HEIGHTS)[number];
export const GRID_COLUMNS = 6;

/** A tile dragged by its corner to span `columns` (fractional) lands on the nearest width there is. */
export function snapWidth(columns: number): TileWidth {
  const c = Math.min(GRID_COLUMNS, Math.max(1, columns));
  return TILE_WIDTHS.reduce<TileWidth>((best, w) => (Math.abs(w - c) < Math.abs(best - c) ? w : best), 1);
}
/** How an output tile shows what the step said: as it reads (`auto`), Markdown, a JSON tree, a table, or plain text. */
export const OUTPUT_SHOWS = ['auto', 'markdown', 'tree', 'table', 'text'] as const;
export type OutputShow = (typeof OUTPUT_SHOWS)[number];
/** The steps an output tile can show: what Claude, a service or a script said. */
export const OUTPUT_STEP_KINDS: ReadonlySet<StepKind> = new Set(['claude', 'http', 'script']);

/** A sentinel's step, by their ids (an output tile's). */
export interface StepRef {
  readonly sentinelId: string;
  readonly stepId: string;
}

/** A sentinel's metric, by their ids. */
export interface MetricRef {
  readonly sentinelId: string;
  readonly metric: string;
}

export interface Tile {
  readonly id: string;
  readonly kind: TileKind;
  /** Columns of the six (a divider spans them all). */
  readonly width: TileWidth;
  /** Tall: twice the room. */
  readonly height?: TileHeight;
  /** Where it was put on the grid (0-based column and row; both or neither): none, it flows in order. */
  readonly col?: number;
  readonly row?: number;
  /** Its own title (a divider's words; the metric's label when none). */
  readonly title?: string;
  /** A number's, table's or output's metric; a series tile's kept array (a `series` metric). */
  readonly metric?: MetricRef;
  /** A series tile's metrics over time (one or several). */
  readonly metrics?: readonly MetricRef[];
  readonly chart?: ChartTileKind;
  /** An output tile's step: its latest output. */
  readonly step?: StepRef;
  /** How an output tile shows it. */
  readonly show?: OutputShow;
  /** A text tile's sentinel: its last run's headline, or its report. */
  readonly sentinelId?: string;
  readonly text?: 'headline' | 'report';
  /** Its own compare, pinned (none: the dashboard's). */
  readonly compare?: Compare;
  /** A table's columns as it shows them (BLG-347): in this order first, renamed or hidden; the rest after, as they come. */
  readonly columns?: readonly TileColumn[];
}

/** A table tile's own say over a column: its heading, or hidden from the grid (a row still shows it when opened). */
export interface TileColumn {
  readonly key: string;
  readonly label?: string;
  readonly hidden?: boolean;
}

/**
 * A table's columns as a tile shows them: those it names first, in its order (renamed, hidden ones
 * marked), then the rest as they come. Columns it names that the rows don't have are left out.
 */
export function tileColumns(present: readonly string[], own: readonly TileColumn[] | undefined): Array<{ readonly key: string; readonly label?: string; readonly hidden?: boolean }> {
  if (!own?.length) return present.map((key) => ({ key }));
  const has = new Set(present);
  const named = own.filter((c) => has.has(c.key));
  const seen = new Set(named.map((c) => c.key));
  return [...named.map((c) => ({ key: c.key, ...(c.label?.trim() ? { label: c.label.trim() } : {}), ...(c.hidden ? { hidden: true } : {}) })), ...present.filter((k) => !seen.has(k)).map((key) => ({ key }))];
}

export interface Dashboard {
  readonly id: string;
  readonly name: string;
  /** What every tile compares with, unless it pins its own. */
  readonly compare: Compare;
  readonly tiles: readonly Tile[];
  /** Made for you when the first number arrived (it changes like any other). */
  readonly auto?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const MAX_DASHBOARDS = 30;
export const MAX_TILES = 60;

/** The width a new tile of a kind gets. */
export const DEFAULT_WIDTH: Readonly<Record<TileKind, TileWidth>> = { number: 1, series: 3, table: 3, output: 3, text: 2, divider: 6 };

export const TILE_INFO: Readonly<Record<TileKind, { readonly label: string; readonly hint: string }>> = knownOr({
  number: { label: 'A number', hint: 'Its value and its change against the last one, with a sparkline' },
  series: { label: 'A series', hint: 'Numbers over time, or an array a sentinel kept, as lines, areas or bars' },
  table: { label: 'A table', hint: 'The rows a sentinel kept last' },
  output: { label: 'An output', hint: 'A step’s latest export: what the agent wrote, or a service’s answer' },
  text: { label: 'Text', hint: 'A sentinel’s last headline or report' },
  divider: { label: 'A divider', hint: 'A title across the grid' },
}, (v) => ({ label: v, hint: '' }));

export const WIDTH_WORDS: Readonly<Record<TileWidth, string>> = { 1: 'Narrow (1 of 6)', 2: 'Small (2 of 6)', 3: 'Half (3 of 6)', 4: 'Wide (4 of 6)', 6: 'Full width' };

/** The sentinels a tile draws from. */
export function tileSentinels(t: Tile): string[] {
  const ids = [...(t.metric ? [t.metric.sentinelId] : []), ...(t.metrics ?? []).map((m) => m.sentinelId), ...(t.sentinelId ? [t.sentinelId] : []), ...(t.step ? [t.step.sentinelId] : [])];
  return [...new Set(ids)];
}

/** The metrics a tile reads (a series tile's over time, or the one it names). */
export const tileRefs = (t: Pick<Tile, 'kind' | 'metric' | 'metrics'>): readonly MetricRef[] => (t.kind === 'series' && t.metrics?.length ? t.metrics : t.metric ? [t.metric] : []);

/** Every step an output tile names, across dashboards (the daemon keeps their latest outputs). */
export function outputSteps(dashboards: readonly Pick<Dashboard, 'tiles'>[]): StepRef[] {
  const seen = new Map<string, StepRef>();
  for (const d of dashboards) for (const t of d.tiles) if (t.kind === 'output' && t.step) seen.set(`${t.step.sentinelId}/${t.step.stepId}`, t.step);
  return [...seen.values()];
}

/** The sentinels a dashboard draws from, in the order its tiles first name them (Refresh runs them so). */
export function dashboardSentinels(d: Pick<Dashboard, 'tiles'>): string[] {
  return [...new Set(d.tiles.flatMap(tileSentinels))];
}

export type TileState = 'ok' | 'paused' | 'draft' | 'gone' | 'waiting';

/**
 * Whether a tile can draw: its sentinel gone (deleted), a draft (made, never turned on and never
 * run: Add a Tile by description makes one), or paused (said quietly); or what it shows isn't kept
 * yet (waiting for its first run). A divider is always fine.
 */
export function tileState(
  t: Tile,
  sentinels: ReadonlyArray<{ readonly id: string; readonly paused: boolean; readonly steps?: ReadonlyArray<{ readonly id: string }> }>,
  has: (ref: MetricRef) => boolean,
  ran: (sentinelId: string) => boolean = () => true,
  hasOutput: (ref: StepRef) => boolean = () => true,
): TileState {
  if (t.kind === 'divider') return 'ok';
  const ids = tileSentinels(t);
  if (!ids.length) return 'gone';
  const items = ids.map((id) => sentinels.find((s) => s.id === id));
  if (items.every((s) => !s)) return 'gone';
  // An output tile whose step was taken out of its sentinel.
  const stepOf = t.step ? items[0] : undefined;
  if (t.step && stepOf?.steps && !stepOf.steps.some((st) => st.id === t.step!.stepId)) return 'gone';
  if (items.every((s) => !s || s.paused)) return items.some((s) => s && !ran(s.id)) ? 'draft' : 'paused';
  const refs = tileRefs(t);
  if (refs.length && !refs.some(has)) return 'waiting';
  if (t.kind === 'output' && t.step && !hasOutput(t.step)) return 'waiting';
  return 'ok';
}

/** The quiet words a tile says when it can't draw. */
export const TILE_STATE_WORDS: Readonly<Record<Exclude<TileState, 'ok'>, string>> = { paused: 'paused', draft: 'draft: turn it on', gone: 'gone', waiting: 'waiting for its first run' };

// ---------------------------------------------------------------- outputs (a step's export)

/** What a step's output is: a Claude step writes Markdown, a service answers JSON (or text), a script prints text or JSON. */
export function outputFormat(text: string, kind?: StepKind): OutputFormat {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      // Not JSON after all.
    }
  }
  return kind === 'claude' ? 'markdown' : kind === 'http' || kind === 'script' ? 'text' : /(^|\n)(#{1,4} |[-*] |\d+\. )|\*\*|`/.test(t) ? 'markdown' : 'text';
}

/** JSON that reads as a table: a list of objects (or an object holding one, like `{ "data": [...] }`). */
export function outputRows(value: unknown): Array<Record<string, unknown>> | undefined {
  const isRows = (v: unknown): v is Array<Record<string, unknown>> => Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (isRows(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = Object.values(value as Record<string, unknown>).find(isRows);
    if (inner) return inner;
  }
  return undefined;
}

/** How an output tile draws it: what it was asked to (`show`), else what it reads as. */
export function outputLook(o: { readonly text: string; readonly format: OutputFormat }, show: OutputShow = 'auto'): 'markdown' | 'tree' | 'table' | 'text' {
  let parsed: unknown;
  const json = o.format === 'json' || show === 'tree' || show === 'table';
  if (json) {
    try {
      parsed = JSON.parse(o.text);
    } catch {
      parsed = undefined;
    }
  }
  if (show === 'table') return parsed !== undefined && outputRows(parsed) ? 'table' : parsed !== undefined ? 'tree' : 'text';
  if (show === 'tree') return parsed !== undefined ? 'tree' : 'text';
  if (show === 'markdown' || show === 'text') return show;
  // A list of objects reads as a table; anything else as a tree (Show as › Table finds a list inside one).
  if (o.format === 'json') return parsed !== undefined && Array.isArray(parsed) && outputRows(parsed) ? 'table' : parsed !== undefined ? 'tree' : 'text';
  return o.format === 'markdown' ? 'markdown' : 'text';
}

/** What an output tile shows: the step's latest output (from the state), or an output metric's. */
export function tileOutput(s: Pick<SentinelState, 'metrics' | 'outputs'>, t: Tile): (StepOutput & { readonly from: 'step' | 'metric' }) | undefined {
  if (t.kind !== 'output') return undefined;
  if (t.step) {
    const o = s.outputs?.[t.step.sentinelId]?.[t.step.stepId];
    return o ? { ...o, from: 'step' } : undefined;
  }
  const m = metricOf(s, t.metric);
  if (!m?.output) return undefined;
  return { text: m.output.text, format: m.output.format, runId: m.rowsRunId ?? m.points.at(-1)?.runId ?? '', at: m.rowsAt ?? m.points.at(-1)?.at ?? 0, from: 'metric' };
}

/** A tile's tiles moved: `id` to `index` (in the list without it). */
export function moveTile<T extends { readonly id: string }>(tiles: readonly T[], id: string, index: number): T[] {
  const t = tiles.find((x) => x.id === id);
  if (!t) return [...tiles];
  const rest = tiles.filter((x) => x.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, t);
  return rest;
}

// ---------------------------------------------------------------- places on the grid

/** Where a tile sits on the six columns: its first column and row (0-based) and what it spans. */
export interface TilePlace {
  readonly col: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
}

const spanOf = (t: Pick<Tile, 'kind' | 'width' | 'height'>): { readonly w: number; readonly h: number } => (t.kind === 'divider' ? { w: GRID_COLUMNS, h: 1 } : { w: t.width, h: t.height ?? 1 });
const clampCol = (col: number, w: number): number => Math.max(0, Math.min(Math.round(col), GRID_COLUMNS - w));

/** The grid's taken cells. */
class Cells {
  private readonly taken = new Set<string>();
  fits(col: number, row: number, w: number, h: number): boolean {
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (this.taken.has(`${c}:${r}`)) return false;
    return true;
  }
  take(p: TilePlace): void {
    for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) this.taken.add(`${c}:${r}`);
  }
  /** At that column, the first row from `row` down where it fits. */
  below(col: number, row: number, w: number, h: number): number {
    let r = Math.max(0, row);
    while (!this.fits(col, r, w, h)) r++;
    return r;
  }
  /** The free spot nearest (col, row) it fits in (the same row first, then the rows around it, below before above). */
  nearest(col: number, row: number, w: number, h: number): { col: number; row: number } {
    let best: { col: number; row: number; d: number } | undefined;
    for (let r = Math.max(0, row - 6); r <= row + 12 || !best; r++) {
      for (let c = 0; c + w <= GRID_COLUMNS; c++) {
        if (!this.fits(c, r, w, h)) continue;
        const d = Math.abs(r - row) * 5 + (r < row ? 1 : 0) + Math.abs(c - col);
        if (!best || d < best.d) best = { col: c, row: r, d };
      }
    }
    return { col: best.col, row: best.row };
  }
  /** The first spot it fits in, reading from `row` on (left to right, then down). */
  first(row: number, w: number, h: number): { col: number; row: number } {
    for (let r = Math.max(0, row); ; r++) for (let c = 0; c + w <= GRID_COLUMNS; c++) if (this.fits(c, r, w, h)) return { col: c, row: r };
  }
}

/**
 * Each tile's place, like icons on a phone's home screen: tiles put somewhere keep their spot,
 * empty rows and holes included (one saved on top of another goes below it); the rest flow into
 * the first free spot after the tile before them. A board nobody placed (or
 * `flow`, one project's part of it) packs in order, gaps filled, as it always did.
 */
export function layoutTiles(tiles: readonly Pick<Tile, 'id' | 'kind' | 'width' | 'height' | 'col' | 'row'>[], flow = false): Map<string, TilePlace> {
  const placed = !flow && tiles.some((t) => t.row !== undefined);
  const cells = new Cells();
  const out = new Map<string, TilePlace>();
  if (placed) {
    for (const t of tiles) {
      if (t.row === undefined) continue;
      const { w, h } = spanOf(t);
      const col = clampCol(t.col ?? 0, w);
      const p = { col, row: cells.below(col, t.row, w, h), w, h };
      cells.take(p);
      out.set(t.id, p);
    }
  }
  let prev: TilePlace | undefined;
  for (const t of tiles) {
    const has = out.get(t.id);
    if (has) {
      prev = has;
      continue;
    }
    const { w, h } = spanOf(t);
    const spot = cells.first(placed ? (prev?.row ?? 0) : 0, w, h);
    const p = { ...spot, w, h };
    cells.take(p);
    out.set(t.id, p);
    prev = p;
  }
  return out;
}

/**
 * Dragged to a spot (a column and a row), like an icon on a phone's home screen: it lands there,
 * a tile it lands on moves to the nearest free spot, and every other tile stays where it is
 * (now written down), in reading order.
 */
export function placeTile<T extends Pick<Tile, 'id' | 'kind' | 'width' | 'height' | 'col' | 'row'>>(tiles: readonly T[], id: string, col: number, row: number): T[] {
  const t = tiles.find((x) => x.id === id);
  if (!t) return [...tiles];
  const was = layoutTiles(tiles);
  const cells = new Cells();
  const { w, h } = spanOf(t);
  const mine = { col: clampCol(col, w), row: Math.max(0, Math.round(row)), w, h };
  cells.take(mine);
  const at = new Map<string, TilePlace>([[id, mine]]);
  const others = tiles.filter((x) => x.id !== id).sort((a, b) => readingOrder(was.get(a.id)!, was.get(b.id)!));
  const bumped: T[] = [];
  for (const o of others) {
    const p = was.get(o.id)!;
    if (!cells.fits(p.col, p.row, p.w, p.h)) {
      bumped.push(o);
      continue;
    }
    cells.take(p);
    at.set(o.id, p);
  }
  for (const o of bumped) {
    const p = was.get(o.id)!;
    const q = { ...p, ...cells.nearest(p.col, p.row, p.w, p.h) };
    cells.take(q);
    at.set(o.id, q);
  }
  return [...tiles].sort((a, b) => readingOrder(at.get(a.id)!, at.get(b.id)!)).map((x) => ({ ...x, col: at.get(x.id)!.col, row: at.get(x.id)!.row }));
}

const readingOrder = (a: Pick<TilePlace, 'col' | 'row'>, b: Pick<TilePlace, 'col' | 'row'>): number => a.row - b.row || a.col - b.col;

/** The tiles in the order they read on the board (top to bottom, left to right). */
export function inReadingOrder<T extends Pick<Tile, 'id' | 'kind' | 'width' | 'height' | 'col' | 'row'>>(tiles: readonly T[]): T[] {
  const places = layoutTiles(tiles);
  return [...tiles].sort((a, b) => readingOrder(places.get(a.id)!, places.get(b.id)!));
}

/** The board's grid on screen: its box, the gap, and each row's height as laid out. */
export interface GridBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly gap: number;
  readonly rows: readonly number[];
}

/** A normal row's height (numbers.module.css .cell min-height), for a row below the last. */
export const ROW_HEIGHT = 116;

/**
 * The spot a tile `w` columns wide, held with its top-left corner at (left, top), would land on:
 * the nearest column, and the row its first row's middle is over (rows past the last laid out are
 * a normal row each, up to `maxRow`).
 */
export function gridSpot(left: number, top: number, g: GridBox, w: number, maxRow = g.rows.length): { readonly col: number; readonly row: number } {
  const step = (g.width + g.gap) / GRID_COLUMNS;
  const col = clampCol((left - g.left) / step, Math.min(w, GRID_COLUMNS));
  const probe = top + Math.min(ROW_HEIGHT, g.rows[0] ?? ROW_HEIGHT) / 2;
  let y = g.top;
  for (let i = 0; i < g.rows.length; i++) {
    if (probe < y + g.rows[i]! + g.gap / 2) return { col, row: i };
    y += g.rows[i]! + g.gap;
  }
  const past = Math.max(0, Math.floor((probe - y + g.gap / 2) / (ROW_HEIGHT + g.gap)));
  return { col, row: Math.max(0, Math.min(g.rows.length + past, maxRow)) };
}

/** Metrics a dashboard can be made from: the sentinels' metrics in the state, in order. */
export interface MetricInfo {
  readonly sentinelId: string;
  readonly name: string;
  readonly kind: MetricSeries['kind'];
}

/** The first dashboard's tiles: every number as a tile, then every table, the charts after (each sentinel's numbers together). */
export function autoTiles(metrics: readonly MetricInfo[], id: () => string): Tile[] {
  const numbers = metrics.filter((m) => m.kind === 'number');
  const tables = metrics.filter((m) => m.kind === 'rows');
  const bySentinel = [...new Set(numbers.map((m) => m.sentinelId))];
  return [
    ...numbers.map((m): Tile => ({ id: id(), kind: 'number', width: 1, metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...bySentinel.slice(0, 4).map((sid): Tile => ({ id: id(), kind: 'series', width: 3, chart: 'line', metrics: numbers.filter((m) => m.sentinelId === sid).slice(0, 4).map((m) => ({ sentinelId: sid, metric: m.name })) })),
    ...metrics.filter((m) => m.kind === 'series').map((m): Tile => ({ id: id(), kind: 'series', width: 3, chart: 'bar', metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...tables.map((m): Tile => ({ id: id(), kind: 'table', width: 3, metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...metrics.filter((m) => m.kind === 'output').map((m): Tile => ({ id: id(), kind: 'output', width: 3, metric: { sentinelId: m.sentinelId, metric: m.name } })),
  ].slice(0, MAX_TILES);
}

/** What a dashboard says as Markdown (Copy as Markdown): each tile's words, numbers as a table. */
export function dashboardMarkdown(d: Dashboard, words: (t: Tile) => { readonly title: string; readonly value?: string; readonly change?: string; readonly text?: string }): string {
  const out: string[] = [`# ${d.name}`, ''];
  let table: string[] = [];
  const flush = (): void => {
    if (!table.length) return;
    out.push('| Number | Now | Change |', '|---|---|---|', ...table, '');
    table = [];
  };
  for (const t of d.tiles) {
    const w = words(t);
    if (t.kind === 'number') {
      table.push(`| ${cellText(w.title)} | ${cellText(w.value ?? '—')} | ${cellText(w.change ?? '')} |`);
      continue;
    }
    flush();
    if (t.kind === 'divider') out.push(`## ${w.title}`, '');
    else out.push(`**${w.title}**${w.value ? ` · ${w.value}` : ''}`, ...(w.text ? ['', w.text] : []), '');
  }
  flush();
  return `${out.join('\n').trim()}\n`;
}

const cellText = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------------------------------------------------------------- what a tile draws (every screen)

/** A metric of the state, by its ref. */
export const metricOf = (s: Pick<SentinelState, 'metrics'>, ref: MetricRef | undefined): MetricSeries | undefined => (ref ? s.metrics?.[ref.sentinelId]?.[ref.metric] : undefined);

/** The metrics a tile draws, as far as they're kept. */
export function tileMetrics(s: Pick<SentinelState, 'metrics'>, t: Tile): MetricSeries[] {
  return tileRefs(t).flatMap((r) => metricOf(s, r) ?? []);
}

/** What a tile is called: its own title, its metric's label (a series' labels), its step's or sentinel's name. */
export function tileTitle(s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): string {
  if (t.title) return t.title;
  if (t.kind === 'divider') return '';
  if (t.kind === 'text') return s.items.find((i) => i.id === t.sentinelId)?.name ?? 'A sentinel';
  if (t.kind === 'output' && t.step) {
    const sn = s.items.find((i) => i.id === t.step!.sentinelId);
    const st = sn?.steps.find((x) => x.id === t.step!.stepId);
    return st ? `${st.name}` : (sn?.name ?? 'A step');
  }
  const ms = tileMetrics(s, t);
  if (ms.length) return ms.map((m) => m.label).join(' and ');
  const ref = t.metric ?? t.metrics?.[0];
  return ref ? ref.metric : TILE_INFO[t.kind].label;
}

/** What a tile compares with: its own pinned compare, else the dashboard's. */
export const tileCompare = (d: Pick<Dashboard, 'compare'>, t: Tile): Compare => t.compare ?? d.compare;

/** A tile's state from the state slice. */
export const tileStateIn = (s: Pick<SentinelState, 'metrics' | 'items'> & Partial<Pick<SentinelState, 'runs' | 'outputs'>>, t: Tile): TileState =>
  tileState(
    t,
    s.items,
    (r) => Boolean(metricOf(s, r)),
    // It ran: a run in the state, or something it kept (the state keeps a sentinel's last 30 runs only).
    (id) => !s.runs || s.runs.some((r) => r.sentinelId === id) || Boolean(s.metrics?.[id]),
    (r) => !s.outputs || Boolean(s.outputs[r.sentinelId]?.[r.stepId]),
  );

/** The sentinel a tile draws from (its metric's, its first metric's, its step's, or its own); none for a divider. */
export const tileSentinelOf = (tile: Pick<Tile, 'metric' | 'metrics' | 'sentinelId' | 'step'>): string | undefined => tile.metric?.sentinelId ?? tile.metrics?.[0]?.sentinelId ?? tile.sentinelId ?? tile.step?.sentinelId;
