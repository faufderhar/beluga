import { useMemo } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { EMPTY_STATS, type StatRange, dailySeries } from '@beluga/shared/stats.js';
import { Icon } from '../../components/Icon.js';
import { Segmented, cx } from '../../components/ui.js';
import { Calendar } from './Calendar.js';
import { Highlights, Hours } from './HoursCard.js';
import { Card, Chapter } from './parts.js';
import { Share } from './ShareCard.js';
import { type GroupBy, type Metric, type MetricDef, METRICS, asideOf, calendar, change, groupRows, metricOf, rangeTotals } from './stats-model.js';
import { TrendChart, type TrendMode } from './TrendChart.js';
import { trendOf } from './trend-model.js';
import { type GotStats, usePicked } from './use-stats.js';
import s from './stats.module.css';

const RANGES: ReadonlyArray<{ value: StatRange; label: string; hint: string }> = [
  { value: 'week', label: 'Week', hint: 'The last 7 days' },
  { value: 'month', label: 'Month', hint: 'The last 30 days' },
  { value: 'year', label: 'Year', hint: 'The last 52 weeks' },
  { value: 'all', label: 'All Time', hint: 'Since Beluga started counting' },
];
const GROUPS: ReadonlyArray<{ value: GroupBy; label: string; icon: 'folder' | 'bot' }> = [
  { value: 'project', label: 'Projects', icon: 'folder' },
  { value: 'agent', label: 'Agents', icon: 'bot' },
];
const MODES: ReadonlyArray<{ value: TrendMode; label: string; hint: string }> = [
  { value: 'stacked', label: 'Stacked', hint: 'How much, each one on top of the other' },
  { value: 'share', label: 'Share', hint: 'Who did what part of each step' },
];
const BEFORE: Record<StatRange, string> = { week: 'the week before', month: 'the month before', year: 'the year before', all: '' };
const STEP: Record<StatRange, string> = { week: 'a day', month: 'a day', year: 'a week', all: 'a month' };

/** One number on the strip: pressing it shows it in the calendar and the ranking. */
function StatCell({
  m,
  totals,
  before,
  on,
  onPick,
  range,
  noGitHub,
}: {
  noGitHub: boolean;
  m: MetricDef;
  totals: ReturnType<typeof rangeTotals>['now'];
  before?: ReturnType<typeof rangeTotals>['now'];
  on: boolean;
  onPick: () => void;
  range: StatRange;
}) {
  const value = m.value(totals);
  const delta = before ? change(value, m.value(before)) : undefined;
  return (
    <button type="button" role="tab" aria-selected={on} className={cx(s.cell, on && s.cellOn)} style={{ '--m': m.color } as React.CSSProperties} onClick={onPick}>
      <span className={s.cellLabel}>
        <Icon name={m.icon} size={13} />
        {m.label}
      </span>
      <span className={s.cellValue}>{m.format(value)}</span>
      <span className={s.cellAside}>
        <span className={s.cellAsideText}>{asideOf(m, totals, noGitHub)}</span>
        {delta ? (
          <span className={cx(s.delta, delta.up ? s.deltaUp : s.deltaDown)} title={`Against ${BEFORE[range]}`}>
            {delta.text}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Your stats: what you and your agents did, as a strip of numbers for the range you pick (each
 * pressable: it's what the charts show), that number over time by project or agent, the last year
 * as a calendar, each one's share, when you work, and a few highlights. The daemon counts
 * (core/stats/); this only draws what it sent.
 */
export function StatsSection({ state, got }: { state: AppState; got: GotStats }) {
  const { stats, at: now, failed } = got;
  // Projects change with every git status: the charts only care about their roots, names and order.
  const projectsKey = state.projects.map((p) => `${p.id}\t${p.root}\t${p.name}`).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projects = useMemo(() => state.projects, [projectsKey]);
  const [range, setRange] = usePicked<StatRange>('beluga.stats.range', 'month', ['week', 'month', 'year', 'all']);
  const [by, setBy] = usePicked<GroupBy>('beluga.stats.by', 'project', ['project', 'agent']);
  const [mode, setMode] = usePicked<TrendMode>('beluga.stats.mode', 'stacked', ['stacked', 'share']);
  const [metric, setMetric] = usePicked<Metric>(
    'beluga.stats.metric',
    'agentMs',
    METRICS.map((m) => m.id),
  );
  const m = metricOf(metric);
  const data = stats ?? EMPTY_STATS;
  const totals = useMemo(() => rangeTotals(data, range, now), [data, range, now]);
  const trend = useMemo(() => trendOf(data, projects, by, m, range, now), [data, projects, by, m, range, now]);
  const weeks = useMemo(() => {
    const series = dailySeries(data, m.daily, now, 371);
    const removed = m.id === 'lines' ? dailySeries(data, 'linesRemoved', now, 371) : undefined;
    return calendar(removed ? series.map((d, i) => ({ key: d.key, value: d.value + removed[i]!.value })) : series, now);
  }, [data, m, now]);
  const rows = useMemo(() => groupRows(data, projects, by, m, range, now), [data, projects, by, m, range, now]);
  const since = data.since ? new Date(data.since).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : undefined;
  const byWord = by === 'agent' ? 'agent' : 'project';
  // Pull requests come from GitHub: without its CLI, say so instead of an empty chart.
  const why = m.github && data.noGitHub ? 'Pull requests are counted with the GitHub CLI (gh). Sign in to it and they show up here.' : undefined;
  return (
    <section className={s.section} aria-label="Your stats">
      <Chapter
        title="What you did"
        sub={failed ? 'Couldn’t get your stats from Beluga' : data.backfilling ? 'Counting what came before…' : since ? `Counted since ${since}. Press a number to see it below.` : 'Counting from today. Press a number to see it below.'}
        aside={
          <>
            <Segmented size="small" label="Group by" value={by} options={GROUPS} onChange={setBy} />
            <Segmented size="small" label="Range" value={range} options={RANGES} onChange={setRange} />
          </>
        }
      >
        <div className={s.stripFit}>
          <div className={s.strip} role="tablist" aria-label="What to show">
            {METRICS.map((x) => (
              <StatCell key={x.id} m={x} totals={totals.now} {...(totals.before ? { before: totals.before } : {})} on={x.id === metric} onPick={() => setMetric(x.id)} range={range} noGitHub={Boolean(data.noGitHub)} />
            ))}
          </div>
        </div>
        <Card
          label={`${m.label} over time`}
          title={
            <span className={s.cardTitle}>
              <Icon name="chartArea" size={14} /> {m.label} by {byWord}, {STEP[range]} at a time
            </span>
          }
          aside={<Segmented size="small" label="Chart" value={mode} options={MODES} onChange={setMode} />}
        >
          <TrendChart key={by} trend={trend} m={m} mode={mode} animate={`${range}|${metric}|${mode}`} {...(why ? { why } : {})} />
        </Card>
      </Chapter>
      <Chapter title="Your rhythm" sub={`Streaks, your year and your week, and who did what part of the ${m.label.toLowerCase()}.`}>
        <Highlights stats={data} now={now} rows={rows} by={by} />
        <Card
          title={
            <span className={s.cardTitle}>
              <Icon name="calendar" size={14} /> {m.label} every day, the last year
            </span>
          }
        >
          <Calendar weeks={weeks} m={m} {...(why ? { why } : {})} />
        </Card>
        <div className={s.pairFit}>
          <div className={cx(s.pair, s.pairEven)}>
            <Card title={`Share by ${byWord}`}>
              <Share rows={rows} m={m} by={by} {...(why ? { why } : {})} />
            </Card>
            <Card title="When you work">
              <Hours hours={data.hours} />
            </Card>
          </div>
        </div>
      </Chapter>
    </section>
  );
}
