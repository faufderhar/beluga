import { useEffect, useMemo, useState } from 'react';
import type { Compare } from '@beluga/core/sentinel/metrics.js';
import type { MetricSeries, Sentinel } from '@beluga/core/sentinel/model.js';
import { IconButton } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { ago } from '../tasks/tasks-model.js';
import { CompareSwitch, MetricChart, NumberTile, RowsTable } from './NumberParts.js';
import { metricsOf, numberWords } from './numbers-model.js';
import { useSentinelActions } from './use-sentinel.js';
import t from '../tasks/tasks.module.css';
import s from './sentinel.module.css';
import n from './numbers.module.css';

/**
 * A sentinel's Numbers (docs/sentinel.md §10), above its History when it keeps any: each number as
 * a stat tile (its change in the good or bad tone, a sparkline of the last 30), compared with the
 * previous run, yesterday, last week or last month for the whole card; a tile opens its chart over
 * time (the whole history, two years at most), whose points open their run; rows as a table.
 */
export function NumbersCard({ item }: { item: Sentinel }) {
  const all = useApp((st) => st.sentinel.metrics?.[item.id]);
  const [compare, setCompare] = useState<Compare>('previous');
  const [open, setOpen] = useState<string>();
  const { numbers, tables } = useMemo(() => metricsOf({ metrics: all ? { [item.id]: all } : {} }, item.id), [all, item.id]);
  if (!numbers.length && !tables.length) return null;
  const shown = numbers.find((m) => m.name === open);
  return (
    <section className={s.card} aria-label="Numbers" data-testid="sentinel-numbers">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>Numbers</h3>
        <span className={t.grow} />
        {numbers.length ? <CompareSwitch value={compare} onChange={setCompare} /> : null}
      </header>
      {numbers.length ? (
        <div className={n.tiles} role="list" aria-label="Numbers it keeps">
          {numbers.map((m) => (
            <div key={m.name} role="listitem" className={n.tileCell} data-metric={m.name}>
              <NumberTile w={numberWords(m, compare)} selected={open === m.name} onClick={() => setOpen(open === m.name ? undefined : m.name)} />
            </div>
          ))}
        </div>
      ) : null}
      {shown ? <OverTime item={item} metric={shown} close={() => setOpen(undefined)} /> : null}
      {tables.map((m) => (
        <div key={m.name} className={n.rows} data-metric={m.name}>
          <div className={n.rowsHead}>
            <span className={n.rowsTitle}>{m.label}</span>
            <span className={s.hint}>
              {m.rows?.length ?? 0} {m.rows?.length === 1 ? 'row' : 'rows'}
              {m.rowsAt ? ` · ${ago(m.rowsAt)}` : ''}
            </span>
          </div>
          <RowsTable metric={m} />
        </div>
      ))}
    </section>
  );
}

/** One number over time: its whole history from the files (the state's 90 points until it comes); a point opens its run. */
function OverTime({ item, metric, close }: { item: Sentinel; metric: MetricSeries; close: () => void }) {
  const a = useSentinelActions();
  const [whole, setWhole] = useState<MetricSeries>();
  const last = metric.points.at(-1)?.at;
  useEffect(() => {
    let alive = true;
    void a.act(() => a.api.metricRead(item.id, metric.name)).then((got) => {
      if (!alive || !got) return;
      const points = got.lines.flatMap((l) => (typeof l.value === 'number' ? [{ at: l.at, value: l.value, runId: l.runId }] : l.rows ? [{ at: l.at, value: l.rows.length, runId: l.runId }] : []));
      if (points.length) setWhole({ ...metric, points });
    });
    return () => {
      alive = false;
    };
    // Again when a new point comes.
  }, [a, item.id, metric.name, last]);
  const series = whole ?? metric;
  return (
    <div className={n.detail} data-testid="sentinel-number-chart">
      <div className={n.detailHead}>
        <span className={n.rowsTitle}>{metric.label} over time</span>
        <span className={s.hint}>
          {series.points.length} {series.points.length === 1 ? 'point' : 'points'} · a point opens its run
        </span>
        <span className={t.grow} />
        <IconButton size="small" icon="x" label="Close the chart" onClick={close} />
      </div>
      <MetricChart series={[series]} height={220} onRun={(runId) => a.openRun(runId)} />
    </div>
  );
}
