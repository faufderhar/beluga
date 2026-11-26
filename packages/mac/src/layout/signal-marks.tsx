import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import { Badge, Dot, cx } from '../components/ui.js';
import type { Need, Signal, Tally } from './attention-model.js';
import m from './signal.module.css';

/**
 * How the sidebar draws what a conversation waits on: when it needs you, the row glows amber with
 * a light sweeping across it and a lit edge on its left (a red ! for conflicts and failing
 * checks); a count in your accent when there's news; Claude's soft pulse while it works. See
 * attention-model.ts for which one wins.
 */

const PROBLEMS: ReadonlySet<Need> = new Set(['conflict', 'checks']);

const isProblem = (need: Need | undefined): boolean => need !== undefined && PROBLEMS.has(need);

/** The row's own look: bold while it has news, faintly tinted while it needs you (never while you're in it). */
export function signalClass(signal: Signal, selected: boolean): string | undefined {
  if (selected || signal.level !== 'needs') return undefined;
  return isProblem(signal.need) ? m.problemRow : m.needsRow;
}

/** The name, bold while there's something new in it. */
export const nameClass = (signal: Signal): string | undefined => (signal.unread > 0 ? m.unreadName : undefined);

function NeedMark({ need }: { need: Need | undefined }) {
  if (isProblem(need)) {
    return (
      <span className={cx(m.mark, m.markProblem)} data-signal="needs" aria-hidden="true">
        <Icon name="alert" size={12} />
      </span>
    );
  }
  // A lit edge on the row's left, not one more icon among the dots and counts.
  return <span className={m.edge} data-signal="needs" aria-hidden="true" />;
}

/**
 * A dot in the same 14px slot as every other mark, so a row's git dot and Claude's pulse line up
 * at the right edge whichever one a row shows.
 */
export function DotMark({ tone, live, signal }: { tone: Parameters<typeof Dot>[0]['tone']; live?: boolean; signal?: string }) {
  return (
    <span className={m.mark} data-signal={signal}>
      <Dot tone={tone} live={live} />
    </span>
  );
}

/** Put off till later (Remind Me Later, BLG-748): a quiet clock in the same slot, nothing asking for you. */
export function LaterMark() {
  return (
    <span className={cx(m.mark, m.later)} data-signal="later" aria-hidden="true">
      <Icon name="clock" size={11} />
    </span>
  );
}

/** A sentinel sends into this chat on a schedule (BLG-401): a quiet clock beside its other marks. `count`: how many; `paused`: all of them are off. */
export function ScheduledMark({ count, paused }: { count: number; paused: boolean }) {
  const words = `${count === 1 ? 'A schedule sends' : `${count} schedules send`} into this chat${paused ? ' (off)' : ''}`;
  return (
    <span className={cx(m.mark, m.later, paused && m.scheduledOff)} data-scheduled={paused ? 'off' : 'on'} title={words} aria-label={words} role="img">
      <Icon name="clock" size={11} />
    </span>
  );
}

/**
 * A conversation's mark. `fallback`: what an idle row shows instead (its git state, say). `working`:
 * whose loader it shows at work (a worktree's own, teal and orbiting; Claude's otherwise).
 */
export function SignalMark({ signal, fallback = null, working = 'claude' }: { signal: Signal; fallback?: ReactNode; working?: 'claude' | 'worktree' }) {
  switch (signal.level) {
    case 'needs':
      return <NeedMark need={signal.need} />;
    case 'unread':
      return (
        <span className={m.count} data-signal="unread">
          <Badge count={signal.unread} urgent />
        </span>
      );
    case 'working':
      return <DotMark tone={working} live signal="working" />;
    default:
      return <>{fallback}</>;
  }
}

/**
 * What a project or folder adds up to: a lit edge if anything inside needs you, and how many
 * conversations have news (in your accent while it's folded, quiet while you can see them).
 */
export function TallyMark({ tally, folded, fallback = null }: { tally: Tally; folded: boolean; fallback?: ReactNode }) {
  if (!tally.needs && !tally.unread) return <>{fallback}</>;
  return (
    <span className={m.tally} data-tally={`${tally.needs}:${tally.unread}`}>
      {tally.needs ? <NeedMark need={undefined} /> : null}
      {tally.unread ? <Badge count={tally.unread} urgent={folded} /> : null}
    </span>
  );
}
