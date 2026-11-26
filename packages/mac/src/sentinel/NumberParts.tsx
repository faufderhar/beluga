import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type View, readView } from '@beluga/shared/view-spec.js';
import type { MetricSeries } from '@beluga/core/sentinel/model.js';
import type { TileColumn } from '@beluga/core/sentinel/dashboard-model.js';
import { Icon } from '../components/Icon.js';
import { Spark } from '../components/views/Stats.js';
import { type DrawCell, DataTable } from '../components/views/Table.js';
import { useViewData } from '../components/views/use-view-data.js';
import { Segmented, cx } from '../components/ui.js';
import type { Compare } from '@beluga/core/sentinel/metrics.js';
import { COMPARE_CHOICES, type NumberWords, chartViewOf, drawnColumns, seriesViewOf, tableViewOf } from './numbers-model.js';
import { typedCells } from './TypedCell.js';
import v from '../components/views/views.module.css';
import n from './numbers.module.css';

/**
 * The pieces numbers are drawn with, on a sentinel's page and on the Dashboard: a number as the
 * chat's stat tile (its value, its change in the good or bad tone, a sparkline), a chart over time
 * (the chat's line view; a point opens its run), rows as the chat's table, and the compare switch.
 */

const Chart = lazy(() => import('../components/views/Chart.js'));

export function CompareSwitch({ value, onChange, label = 'Compare with' }: { value: Compare; onChange: (c: Compare) => void; label?: string }) {
  return <Segmented<Compare> size="small" label={label} value={value} onChange={onChange} options={COMPARE_CHOICES} />;
}

/** A number as a stat tile. `note`: a quiet word in its corner ("paused", "vs last week" when pinned). */
export function NumberTile({ w, note, selected, onClick, className, spark = true, lead, label, children }: { w: NumberWords; note?: string; selected?: boolean; onClick?: () => void; className?: string; spark?: boolean; lead?: React.ReactNode; label?: React.ReactNode; children?: React.ReactNode }) {
  const good = w.tone === 'good' ? true : w.tone === 'bad' ? false : undefined;
  const up = w.change?.startsWith('+');
  const body = (
    <>
      <div className={v.tileLabel}>
        {lead}
        {label ?? <span className={n.tileLabelText}>{w.label}</span>}
        {note ? <span className={n.note}>{note}</span> : null}
        {children}
      </div>
      <div className={v.tileMain}>
        <div className={v.tileValue} data-value="" style={{ '--chars': w.value.length + (w.unit?.length ?? 0) } as React.CSSProperties}>
          {w.value}
          {w.unit ? <span className={v.tileUnit}>{w.unit}</span> : null}
        </div>
        {spark && w.trend.length > 1 ? <Spark values={w.trend} good={good} /> : null}
      </div>
      <div className={cx(v.tileFoot, n.foot)}>
        {w.change ? (
          <span className={cx(v.delta, n.delta)} data-good={good === undefined ? undefined : String(good)} data-tone={w.tone}>
            <Icon name={w.change === 'no change' ? 'minus' : 'up'} size={10} className={up || w.change === 'no change' ? undefined : v.down} />
            {w.change}
          </span>
        ) : null}
        <span className={cx(v.tileHint, n.vs)}>{w.vs}</span>
      </div>
    </>
  );
  if (!onClick) return <div className={cx(v.tile, n.tile, className)}>{body}</div>;
  return (
    <button type="button" className={cx(v.tile, n.tile, n.tileButton, className)} aria-pressed={selected} onClick={onClick} data-selected={selected || undefined}>
      {body}
    </button>
  );
}

/** Some metrics over time, as the chat's chart; a click on a point hears its run. */
export function MetricChart({ series, kind = 'line', height = 220, onRun }: { series: readonly MetricSeries[]; kind?: 'line' | 'area' | 'bar'; height?: number; onRun?: (runId: string) => void }) {
  const view = useMemo(() => {
    const r = readView(chartViewOf(series, kind, height));
    return r.ok ? r.view : undefined;
  }, [series, kind, height]);
  if (!view) return null;
  return <ChartBody view={view} kind={kind} {...(onRun ? { onRun } : {})} />;
}

function ChartBody({ view, kind, onRun }: { view: View; kind: 'line' | 'area' | 'bar'; onRun?: (runId: string) => void }) {
  const data = useViewData(view, { local: true, visible: true, limit: 500 });
  return (
    <div className={n.chart}>
      <Suspense fallback={<div className={v.chartWait} style={{ height: view.height ?? 220 }} />}>
        <Chart view={view} data={data} kind={kind} full={false} fit {...(onRun ? { onPoint: (row: Readonly<Record<string, unknown>>) => typeof row.runId === 'string' && onRun(row.runId) } : {})} />
      </Suspense>
    </div>
  );
}

/** A series metric's latest array, as the chat's chart (each point's label along the bottom). */
export function SeriesChart({ metric, kind = 'bar', height = 220 }: { metric: MetricSeries; kind?: 'line' | 'area' | 'bar'; height?: number }) {
  const view = useMemo(() => {
    const r = readView(seriesViewOf(metric, kind, height));
    return r.ok ? r.view : undefined;
  }, [metric, kind, height]);
  if (!view) return null;
  return <ChartBody view={view} kind={kind} />;
}

/**
 * A rows metric (or a list from a step's output) as the chat's table, a page at a time: its columns
 * as its sentinel typed them (documents open, progress is a bar…), in a tile's own order and words.
 */
export function RowsTable({ metric, pageSize = 8, columns }: { metric: Pick<MetricSeries, 'rows' | 'columns'> & Partial<Pick<MetricSeries, 'sentinelId' | 'name' | 'columnTypes'>>; pageSize?: number; columns?: readonly TileColumn[] }) {
  const view = useMemo(() => {
    const r = readView(tableViewOf(metric, pageSize, columns));
    return r.ok ? r.view : undefined;
  }, [metric, pageSize, columns]);
  const cell = useMemo(() => (metric.sentinelId && metric.name ? typedCells({ sentinelId: metric.sentinelId, name: metric.name, rows: metric.rows }, drawnColumns(metric)) : undefined), [metric]);
  if (!view) return null;
  return <TableBody view={view} {...(cell ? { cell } : {})} />;
}

function TableBody({ view, cell }: { view: View; cell?: DrawCell }) {
  const data = useViewData(view, { local: true, visible: true });
  return (
    <div className={n.table}>
      <DataTable view={view} data={data} full={false} {...(cell ? { cell } : {})} />
    </div>
  );
}

/**
 * A chart that takes whatever room is left under it (a board tile grown tall or wide): it measures
 * its box and draws to fit, and draws nothing when there's too little room for a chart to read.
 * `onFit` hears whether it drew, so the tile can drop its sparkline then.
 */
export function FillChart({ series, kind = 'area', onRun, onFit, min = 64 }: { series: readonly MetricSeries[]; kind?: 'line' | 'area' | 'bar'; onRun?: (runId: string) => void; onFit?: (fits: boolean) => void; min?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setHeight(Math.floor(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fits = height >= min && series.some((m) => m.points.length > 1);
  // The chart engine draws 120 px and up (with its axes); less room than that gets a clean area of the points.
  const small = height < 138;
  useEffect(() => onFit?.(fits), [fits, onFit]);
  // Steps of 8 px: a drag across the grid redraws the chart a few times, not on every pixel.
  const drawn = Math.max(min - 18, Math.floor((height - 18) / 8) * 8);
  return (
    <div ref={box} className={n.fill} data-fits={fits || undefined}>
      {/* Laid over its box, so the chart never makes the tile taller than its row. */}
      {fits ? (
        <div className={n.fillIn}>{small ? <AreaFill values={series[0]!.points.map((p) => p.value)} /> : <MetricChart series={series} kind={kind} height={drawn} {...(onRun ? { onRun } : {})} />}</div>
      ) : null}
    </div>
  );
}

/** A number's points as a soft area that stretches to its box (no axes: for a tile with a little room). */
function AreaFill({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - ((v - lo) / span) * 86 - 7}`);
  return (
    <svg className={n.areaFill} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,100 ${pts.join(' ')} 100,100`} className={n.areaFillArea} />
      <polyline points={pts.join(' ')} className={n.areaFillLine} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
