import type { AppState } from '@beluga/core/store.js';
import { RUNTIME_NAMES } from '@beluga/shared/agent-label.js';
import { type StatRange, type StatsSnapshot, type TotalKey, type Totals, dayStart, previousRange, rangeStart, shiftDay, statDay, totalsBy, totalsOf } from '@beluga/shared/stats.js';
import type { IconName } from '../../components/Icon.js';
import { compact, formatCost, slotOf } from './usage-model.js';

/** The numbers on the stats strip: each picks what the calendar and the ranking show. */
export type Metric = 'agentMs' | 'prompts' | 'pasted' | 'dictationMs' | 'worktrees' | 'prsMerged' | 'lines' | 'tokens';

export interface MetricDef {
  readonly id: Metric;
  readonly label: string;
  readonly icon: IconName;
  /** A CSS colour (see stats.module.css: --m-*). */
  readonly color: string;
  /** The number itself, from what a range added up to. */
  readonly value: (t: Totals) => number;
  readonly format: (n: number) => string;
  /** A small line under the number: what it amounts to, or what goes with it. */
  readonly aside: (t: Totals) => string;
  /** What the small line says when there's nothing (unset: aside): never a row of zeros that means nothing. */
  readonly empty?: (t: Totals) => string | undefined;
  /** Counted from GitHub's pull requests: nothing without the GitHub CLI. */
  readonly github?: true;
  /** Short, for a chart's axis (unset: format). */
  readonly axis?: (n: number) => string;
  /** What a day's number is in the calendar (the strip's own figure, for the PR metrics too). */
  readonly daily: TotalKey;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "45 min", "3 h 20 min", "112 h". */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return ms > 0 ? '<1 min' : '0 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return h >= 20 || !rest ? `${h.toLocaleString()} h` : `${h} h ${rest} min`;
}

/** "45m", "12 h": a duration short enough for an axis. */
const hours = (ms: number): string => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)} h`);

/** One significant figure past the point, when it helps ("1.5", "12"). */
const about = (n: number): string => (n >= 10 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

/** A printed page holds about this many characters; a novel about this many. */
const PAGE = 1800;
const NOVEL = 450_000;
/** People speak about 130 words a minute. */
const WORDS_PER_MIN = 130;
const WORKDAY_MS = 8 * 3_600_000;

export const METRICS: readonly MetricDef[] = [
  {
    id: 'agentMs',
    label: 'Agent time',
    icon: 'clock',
    color: 'var(--m-time)',
    value: (t) => t.agentMs,
    format: duration,
    axis: hours,
    aside: (t) => (t.agentMs >= WORKDAY_MS / 2 ? `≈ ${about(t.agentMs / WORKDAY_MS)} workdays · ${plural(t.runs, 'run')}` : plural(t.runs, 'run')),
    empty: () => 'No runs in this stretch',
    daily: 'agentMs',
  },
  {
    id: 'prompts',
    label: 'Prompts',
    icon: 'send',
    color: 'var(--m-prompts)',
    value: (t) => t.prompts,
    format: (n) => n.toLocaleString(),
    aside: (t) => `${compact(t.chars)} characters${t.prompts ? ` · ${Math.round(t.chars / t.prompts)} a prompt` : ''}`,
    empty: () => 'None sent in this stretch',
    daily: 'prompts',
  },
  {
    id: 'pasted',
    label: 'Pasted',
    icon: 'clip',
    color: 'var(--m-pasted)',
    value: (t) => t.pasted,
    format: compact,
    aside: (t) => (t.pasted >= NOVEL / 2 ? `≈ ${about(t.pasted / NOVEL)} novels` : `≈ ${plural(Math.max(1, Math.round(t.pasted / PAGE)), 'page')} of text`),
    empty: () => 'Nothing pasted in this stretch',
    daily: 'pasted',
  },
  {
    id: 'dictationMs',
    label: 'Dictated',
    icon: 'mic',
    color: 'var(--m-voice)',
    value: (t) => t.dictationMs,
    format: duration,
    axis: hours,
    aside: (t) => `≈ ${compact(Math.round((t.dictationMs / 60_000) * WORDS_PER_MIN))} words spoken`,
    empty: () => 'Not used yet: the mic',
    daily: 'dictationMs',
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    icon: 'branch',
    color: 'var(--m-worktrees)',
    value: (t) => t.worktrees,
    format: (n) => n.toLocaleString(),
    aside: (t) => `${t.archived.toLocaleString()} archived · ${plural(t.chats, 'chat')}`,
    daily: 'worktrees',
  },
  {
    id: 'prsMerged',
    label: 'PRs merged',
    icon: 'merge',
    color: 'var(--m-prs)',
    value: (t) => t.prsMerged,
    format: (n) => n.toLocaleString(),
    aside: (t) => `${t.prsOpened.toLocaleString()} opened`,
    empty: (t) => (t.prsOpened ? undefined : 'None from Beluga’s worktrees yet'),
    github: true,
    daily: 'prsMerged',
  },
  {
    id: 'lines',
    label: 'Lines shipped',
    icon: 'diff',
    color: 'var(--m-lines)',
    value: (t) => t.linesAdded + t.linesRemoved,
    format: compact,
    aside: (t) => `+${compact(t.linesAdded)} −${compact(t.linesRemoved)} in merged PRs`,
    empty: () => 'Counted from merged PRs',
    github: true,
    daily: 'linesAdded',
  },
  {
    id: 'tokens',
    label: 'Tokens',
    icon: 'spark',
    color: 'var(--m-tokens)',
    value: (t) => t.tokens,
    format: compact,
    aside: (t) => (t.cost ? `${formatCost(t.cost)} estimated` : 'No cost counted'),
    empty: () => 'None in this stretch',
    daily: 'tokens',
  },
];

/** The small line under a number: what it amounts to, or (nothing yet) why, and how to get some. */
export function asideOf(m: MetricDef, t: Totals, noGitHub: boolean): string {
  if (m.value(t) > 0) return m.aside(t);
  if (m.github && noGitHub) return 'Needs the GitHub CLI (gh)';
  return m.empty?.(t) ?? m.aside(t);
}

export const metricOf = (id: Metric): MetricDef => METRICS.find((m) => m.id === id) ?? METRICS[0]!;

/** Change against the same stretch of time before: "+18%", "−4%"; nothing to compare: undefined. */
export function change(now: number, before: number): { text: string; up: boolean } | undefined {
  if (before <= 0 || now <= 0) return undefined;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return undefined;
  return { text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, up: pct > 0 };
}

/** What a range adds up to, and the stretch before it (for the change). */
export function rangeTotals(stats: StatsSnapshot, range: StatRange, now: number): { now: Totals; before?: Totals } {
  const prev = previousRange(range, now);
  return { now: totalsOf(stats, rangeStart(range, now)), ...(prev ? { before: totalsOf(stats, prev.from, prev.to) } : {}) };
}

export type GroupBy = 'project' | 'agent';

export interface GroupRow {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly value: number;
  readonly totals: Totals;
  /** The project's id, to draw its icon (projects only). */
  readonly projectId?: string;
}

const AGENT_COLOR: Readonly<Record<string, string>> = { claude: 'var(--claude)', codex: 'var(--a-codex)', opencode: 'var(--a-opencode)', copilot: 'var(--a-copilot)', grok: 'var(--a-grok)', local: 'var(--a-local)' };

/** A project's (or agent's) name, colour and icon, from its key (a root, or a runtime). */
export function groupOf(key: string, by: GroupBy, projects: AppState['projects']): { name: string; color: string; projectId?: string } {
  if (by === 'agent') return { name: key ? (RUNTIME_NAMES[key] ?? key) : 'Not in a run', color: AGENT_COLOR[key] ?? 'var(--series-other)' };
  const p = key ? projects.find((x) => x.root === key) : undefined;
  const name = p?.name ?? (key ? (key.split('/').filter(Boolean).at(-1) ?? key) : 'Chats and elsewhere');
  return { name, color: `var(--series-${p ? slotOf(projects, p) : key ? 'other' : 'chats'})`, ...(p ? { projectId: p.id } : {}) };
}

/** Each project's (or agent's) number for a metric over a range, biggest first, with its name and colour. */
export function groupRows(stats: StatsSnapshot, projects: AppState['projects'], by: GroupBy, metric: MetricDef, range: StatRange, now: number): GroupRow[] {
  const rows: GroupRow[] = [];
  for (const [key, totals] of totalsBy(stats, by, rangeStart(range, now))) {
    const value = metric.value(totals);
    if (value > 0) rows.push({ key, value, totals, ...groupOf(key, by, projects) });
  }
  return rows.sort((a, b) => b.value - a.value);
}

/** A day of the calendar. */
export interface CalendarDay {
  readonly key: string;
  readonly value: number;
  /** 0 (nothing) to 4 (the busiest days). */
  readonly level: 0 | 1 | 2 | 3 | 4;
  /** After today: drawn empty. */
  readonly future?: boolean;
}

/**
 * The last year as weeks (columns, Sunday first), ending with this week: each day's number and how
 * strong to colour it, in quarters of the busiest day (most days aren't, so it's not too pale).
 */
export function calendar(series: ReadonlyArray<{ key: string; value: number }>, now: number, weeks = 53): CalendarDay[][] {
  const byKey = new Map(series.map((d) => [d.key, d.value]));
  const today = statDay(now);
  const lastSunday = shiftDay(today, -new Date(dayStart(today)).getDay());
  const first = shiftDay(lastSunday, -7 * (weeks - 1));
  const values = [...byKey.values()].filter((v) => v > 0).sort((a, b) => a - b);
  // The 90th percentile is "full": one huge day doesn't wash the rest out.
  const top = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.9))]! : 1;
  const level = (v: number): CalendarDay['level'] => (v <= 0 ? 0 : v >= top ? 4 : (Math.max(1, Math.ceil((v / top) * 4)) as 1 | 2 | 3 | 4));
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const key = shiftDay(first, w * 7 + d);
      const value = byKey.get(key) ?? 0;
      return { key, value, level: level(value), ...(key > today ? { future: true } : {}) };
    }),
  );
}

/** The busiest weekday × hour: "Fridays" and "10 AM". */
export function favouriteHour(hours: readonly number[]): { day: string; time: string } | undefined {
  let best = -1;
  let at = 0;
  hours.forEach((n, i) => {
    if (n > best) [best, at] = [n, i];
  });
  if (best <= 0) return undefined;
  return { day: `${new Date(2026, 0, 4 + Math.floor(at / 24)).toLocaleDateString([], { weekday: 'long' })}s`, time: new Date(2026, 0, 4, at % 24).toLocaleTimeString([], { hour: 'numeric' }) };
}
