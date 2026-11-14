import { type ReactNode, useState } from 'react';
import { Tip } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { useClock } from '../../lib/window-active.js';
import { type InlineElement, readInline, relative } from './inline-model.js';
import { parseColor, toHex, toHsl, toneOf } from './format.js';
import { ChatChip, PlanChip, TaskChip, WorktreeChip } from '../../tasks/TaskRef.js';
import { SentinelChip } from '../../sentinel/marks.js';
import { CallNotesChip } from '../../call/NotesBox.js';
import v from './inline.module.css';

/**
 * An inline code span that stands for something (inline-model.ts), drawn as it: a color as its
 * swatch, a status as a badge, keys as key caps, a progress bar, a change, a sparkline, a time
 * that says how long ago, a board task you can open. Anything else is the code it was.
 */
export function InlineCode({ text, fallback }: { text: string; fallback: ReactNode }) {
  const el = readInline(text);
  return el ? <InlineView el={el} raw={text} fallback={fallback} /> : <>{fallback}</>;
}

function InlineView({ el, raw, fallback }: { el: InlineElement; raw: string; fallback?: ReactNode }) {
  switch (el.kind) {
    case 'color':
      return <ColorChip value={el.value} />;
    case 'colors':
      return (
        <span className={v.strip} aria-label={`Colors: ${el.values.join(', ')}`}>
          {el.values.map((c, i) => (
            <Tip key={i} label={c}>
              <button type="button" className={v.stripCell} style={{ background: c }} onClick={() => void copyText(c)} aria-label={`Copy ${c}`} />
            </Tip>
          ))}
        </span>
      );
    case 'badge':
      return (
        <span className={v.badge} data-tone={toneOf(el.text)}>
          {el.text}
        </span>
      );
    case 'kbd':
      return (
        <span className={v.keys}>
          {el.keys.map((k, i) => (
            <kbd key={i} className={v.kbd}>
              {k}
            </kbd>
          ))}
        </span>
      );
    case 'progress':
      return (
        <span className={v.progress} role="progressbar" aria-valuenow={Math.round(el.ratio * 100)} aria-valuemin={0} aria-valuemax={100} data-done={el.ratio >= 1 ? 'true' : undefined}>
          <span className={v.track}>
            <span className={v.fill} style={{ width: `${el.ratio * 100}%` }} />
          </span>
          <span className={v.progressLabel}>{el.label}</span>
        </span>
      );
    case 'delta':
      return (
        <span className={v.delta} data-good={el.good === undefined ? undefined : String(el.good)}>
          {el.dir > 0 ? '↑' : el.dir < 0 ? '↓' : '→'} {el.text.replace(/^[+-]/, '')}
        </span>
      );
    case 'spark':
      return <Spark values={el.values} label={raw} />;
    case 'time':
      return <Time at={el.at} dateOnly={el.dateOnly} />;
    case 'task':
      return <TaskChip taskKey={el.key} />;
    case 'worktree':
      return <WorktreeChip id={el.id} />;
    case 'plan':
      return <PlanChip id={el.id} />;
    case 'sentinel':
      return <SentinelChip id={el.id} />;
    case 'call':
      return <CallNotesChip id={el.id} />;
    case 'chat':
      return <ChatChip target={el.ref} raw={raw} fallback={fallback} />;
  }
}

function ColorChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const rgb = parseColor(value);
  const label = rgb ? `${toHex(rgb)} · ${toHsl(rgb)}` : value;
  return (
    <Tip label={copied ? 'Copied' : `${label} · click to copy`}>
      <button
        type="button"
        className={v.color}
        onClick={() =>
          void copyText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        <span className={v.swatch} style={{ background: value }} />
        <code>{value}</code>
      </button>
    </Tip>
  );
}

function Spark({ values, label }: { values: readonly number[]; label: string }) {
  const w = 56;
  const h = 14;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((y, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1.5 - ((y - min) / span) * (h - 3)).toFixed(1)}`);
  const up = values.at(-1)! >= values[0]!;
  return (
    <Tip label={values.join(', ')}>
      <svg className={v.spark} data-up={String(up)} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <polyline points={pts.join(' ')} />
        <circle cx={w} cy={pts.at(-1)!.split(',')[1]} r={1.8} />
      </svg>
    </Tip>
  );
}

function Time({ at, dateOnly }: { at: number; dateOnly: boolean }) {
  const now = useClock(true, 30_000);
  const d = new Date(at);
  const full = dateOnly ? d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <Tip label={full}>
      <time className={v.time} dateTime={d.toISOString()}>
        {dateOnly ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' }) : relative(at, now)}
      </time>
    </Tip>
  );
}
