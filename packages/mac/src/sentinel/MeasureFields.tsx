import { useState } from 'react';
import type { Source } from '@beluga/shared/view-spec.js';
import { type Better, type MeasureFrom, type MeasureStep, type MetricSpec, type MetricUnit, ROWS_KEPT } from '@beluga/core/sentinel/model.js';
import { metricName } from '@beluga/core/sentinel/metrics.js';
import { TextInput } from '../components/FormSheet.js';
import { CodeEditor } from '../components/markdown/CodeEditor.js';
import { Select } from '../components/Select.js';
import { Button, IconButton } from '../components/ui.js';
import { useDraft } from './use-draft.js';
import s from './sentinel.module.css';

/**
 * Keep the numbers (docs/sentinel.md §10): what it reads (the step before, a source, or what
 * Claude keeps), and each number it keeps: its label, where it is (a JSON path or a column), its
 * unit, and which way is good. A unit of Rows keeps a table instead.
 */

const FROM: ReadonlyArray<{ readonly value: MeasureFrom; readonly label: string; readonly description: string }> = [
  { value: 'previous', label: 'The step before', description: 'A number, JSON, CSV or “name: value” lines' },
  { value: 'source', label: 'A source', description: 'A database query, a command or a request, run here as you' },
  { value: 'claude', label: 'What the agent keeps', description: 'The agent step before calls sentinel_measure for each one' },
];

type UnitChoice = MetricUnit | 'rows' | 'series' | 'output';
const UNITS: ReadonlyArray<{ readonly value: UnitChoice; readonly label: string }> = [
  { value: 'count', label: 'A count' },
  { value: 'currency:USD', label: 'Dollars' },
  { value: 'currency:EUR', label: 'Euros' },
  { value: 'currency:GBP', label: 'Pounds' },
  { value: 'percent', label: 'A percent' },
  { value: 'ms', label: 'Milliseconds' },
  { value: 'bytes', label: 'Bytes' },
  { value: 'plain', label: 'A plain number' },
  { value: 'rows', label: 'Rows (a table)' },
  { value: 'series', label: 'A series (a whole array)' },
  { value: 'output', label: 'The output itself' },
];
const BETTER: ReadonlyArray<{ readonly value: Better; readonly label: string; readonly description: string }> = [
  { value: 'up', label: 'Up is good', description: 'A rise shows green' },
  { value: 'down', label: 'Down is good', description: 'A drop shows green: failed payments, load time' },
  { value: 'none', label: 'Neither', description: 'Changes show grey' },
];
const SOURCE_KINDS: ReadonlyArray<{ readonly value: Source['kind']; readonly label: string }> = [
  { value: 'postgres', label: 'Postgres query' },
  { value: 'sqlite', label: 'SQLite query' },
  { value: 'command', label: 'A command' },
  { value: 'http', label: 'A web request' },
  { value: 'file', label: 'A file' },
];
const KEEP = [20, 50, 100, ROWS_KEPT] as const;

const unitOf = (m: MetricSpec): UnitChoice => (m.kind === 'rows' || m.kind === 'series' || m.kind === 'output' ? m.kind : (m.unit ?? 'count'));

function newSource(kind: Source['kind']): Source {
  switch (kind) {
    case 'postgres':
      return { kind, env: 'DATABASE_URL', query: 'select count(*) as count from customers' };
    case 'sqlite':
      return { kind, path: 'data.db', query: 'select count(*) as count from customers' };
    case 'command':
      return { kind, command: 'echo 42', format: 'auto' };
    case 'http':
      return { kind, url: 'https://api.example.com/stats', method: 'GET', format: 'auto' };
    default:
      return { kind: 'file', path: 'stats.json', format: 'auto' };
  }
}

export function MeasureFields({ step, change }: { step: MeasureStep; change: (patch: Partial<MeasureStep>) => void }) {
  const from = FROM.find((f) => f.value === step.from);
  const setMetric = (i: number, patch: Partial<MetricSpec>): void => change({ metrics: step.metrics.map((m, n) => (n === i ? clean({ ...m, ...patch }) : m)) });
  const rows = step.metrics.some((m) => m.kind === 'rows');
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Reads</span>
        <Select label="What it reads" size="small" value={step.from} options={FROM} onChange={(f) => change(f === 'source' ? { from: f, source: step.source ?? newSource('postgres') } : { from: f })} />
      </div>
      {from ? <p className={s.hint}>{from.description}.</p> : null}
      {step.from === 'source' && step.source ? <SourceFields source={step.source} change={(source) => change({ source })} /> : null}
      <div className={s.field}>
        <span className={s.fieldLabel}>Numbers it keeps</span>
        {step.metrics.length ? (
          <div className={s.headers} role="list" aria-label="Numbers it keeps">
            {step.metrics.map((m, i) => (
              <MetricRow key={`${m.name}-${i}`} m={m} index={i} from={step.from} change={(patch) => setMetric(i, patch)} remove={() => change({ metrics: step.metrics.filter((_, n) => n !== i) })} />
            ))}
          </div>
        ) : (
          <p className={s.hint}>{step.from === 'claude' ? 'Every number the agent keeps, as it names them.' : 'Every top-level number it finds, by its name.'} Add one to name, label and format it.</p>
        )}
        <div>
          <Button
            size="small"
            icon="plus"
            onClick={() => {
              const taken = new Set(step.metrics.map((m) => m.name));
              let name = 'value';
              for (let n = 2; taken.has(name); n++) name = `value-${n}`;
              change({ metrics: [...step.metrics, { name, label: '', unit: 'count', better: 'up' }] });
            }}
          >
            Add a Number
          </Button>
        </div>
        <span className={s.help}>{step.from === 'claude' ? 'Its name is what the agent passes to sentinel_measure.' : 'Where: a JSON path ($.items[0].statistics.subscriberCount, rows[0].count) or a column; empty: its name.'}</span>
      </div>
      {rows ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>Rows kept</span>
          <Select label="Rows kept each run" size="small" value={String(step.keep ?? ROWS_KEPT)} options={KEEP.map((k) => ({ value: String(k), label: `${k} rows` }))} onChange={(v) => change({ keep: Number(v) })} />
        </div>
      ) : null}
    </>
  );
}

/** A spec without its empty fields (the daemon checks names; labels and paths are optional). */
function clean(m: MetricSpec): MetricSpec {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== '')) as unknown as MetricSpec;
}

function MetricRow({ m, index, from, change, remove }: { m: MetricSpec; index: number; from: MeasureFrom; change: (patch: Partial<MetricSpec>) => void; remove: () => void }) {
  // Only one just added (still “value”, “value-2”…) is named by its label: another's name is its file, its tiles' link and maybe where it's read.
  const [named, setNamed] = useState(Boolean(m.label) || !/^value(-\d+)?$/.test(m.name));
  const label = useDraft(m.label ?? '', (v) => {
    if (v === (m.label ?? '')) return;
    // A new number takes its name from its label, until it's kept once (the name is its file).
    change({ label: v, ...(!named && v.trim() ? { name: metricName(v) } : {}) });
    if (v.trim()) setNamed(true);
  });
  const pick = useDraft(m.pick ?? '', (v) => v !== (m.pick ?? '') && change({ pick: v }));
  const name = useDraft(m.name, (v) => {
    const next = metricName(v);
    if (next !== m.name) change({ name: next });
  });
  const unit = unitOf(m);
  return (
    <div className={s.metricRow} role="listitem" data-metric={m.name}>
      <TextInput value={label.text} onChange={label.change} onBlur={label.flush} placeholder="Label, like Subscribers" aria-label={`Number ${index + 1}’s label`} />
      {from === 'claude' ? (
        <TextInput value={name.text} onChange={name.change} onBlur={name.flush} mono placeholder="name" aria-label={`Number ${index + 1}’s name`} />
      ) : (
        <TextInput value={pick.text} onChange={pick.change} onBlur={pick.flush} mono placeholder={m.name} aria-label={`Where number ${index + 1} is`} />
      )}
      <Select<UnitChoice>
        label={`Number ${index + 1}’s unit`}
        size="small"
        value={unit}
        options={UNITS.some((u) => u.value === unit) ? UNITS : [...UNITS, { value: unit, label: unit }]}
        onChange={(u) => change(u === 'rows' || u === 'output' ? { kind: u, unit: undefined, better: 'none' } : u === 'series' ? { kind: 'series', unit: undefined } : { kind: undefined, unit: u })}
      />
      {m.kind === 'rows' || m.kind === 'output' ? <span /> : <Select<Better> label={`Which way number ${index + 1} is good`} size="small" value={m.better ?? 'up'} options={BETTER} onChange={(better) => change({ better })} />}
      <IconButton size="small" icon="x" label={`Remove ${m.label || m.name}`} onClick={remove} />
    </div>
  );
}

function SourceFields({ source, change }: { source: Source; change: (s: Source) => void }) {
  const text = source.kind === 'postgres' || source.kind === 'sqlite' ? source.query : source.kind === 'command' ? source.command : source.kind === 'http' ? source.url : source.path;
  const main = useDraft(text, (v) => {
    if (v === text || !v.trim()) return;
    change(source.kind === 'postgres' || source.kind === 'sqlite' ? { ...source, query: v } : source.kind === 'command' ? { ...source, command: v } : source.kind === 'http' ? { ...source, url: v } : { ...source, path: v });
  });
  const second = source.kind === 'postgres' ? (source.env ?? '') : source.kind === 'sqlite' ? source.path : undefined;
  const other = useDraft(second ?? '', (v) => {
    if (second === undefined || v === second || !v.trim()) return;
    change(source.kind === 'postgres' ? { ...source, env: v.trim().replace(/^\$/, '') } : source.kind === 'sqlite' ? { ...source, path: v.trim() } : source);
  });
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Source</span>
        <Select<Source['kind']> label="Source" size="small" value={source.kind} options={SOURCE_KINDS.some((k) => k.value === source.kind) ? SOURCE_KINDS : [...SOURCE_KINDS, { value: source.kind, label: source.kind }]} onChange={(k) => k !== source.kind && change(newSource(k))} />
      </div>
      {second !== undefined ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>{source.kind === 'postgres' ? 'Connection in' : 'Database file'}</span>
          <TextInput value={other.text} onChange={other.change} onBlur={other.flush} mono placeholder={source.kind === 'postgres' ? 'DATABASE_URL' : 'data.db'} aria-label={source.kind === 'postgres' ? 'The variable with the connection string' : 'The database file'} />
        </div>
      ) : null}
      <div className={s.field}>
        <span className={s.fieldLabel}>{source.kind === 'postgres' || source.kind === 'sqlite' ? 'Query' : source.kind === 'command' ? 'Command' : source.kind === 'http' ? 'Address' : 'Path'}</span>
        {source.kind === 'postgres' || source.kind === 'sqlite' ? (
          <CodeEditor value={main.text} onChange={main.change} onBlur={main.flush} lang="sql" minRows={4} aria-label="Query" />
        ) : source.kind === 'command' ? (
          <CodeEditor value={main.text} onChange={main.change} onBlur={main.flush} lang="bash" single aria-label="Source" />
        ) : (
          <TextInput value={main.text} onChange={main.change} onBlur={main.flush} mono aria-label="Source" />
        )}
        <span className={s.help}>{source.kind === 'postgres' ? 'The connection string stays in Settings › Environment or the project’s .env, never here; ' : ''}Run as you, with your environment, each run. A query that returns rows keeps them too.</span>
      </div>
    </>
  );
}
