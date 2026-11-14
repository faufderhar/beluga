import { type ReactNode, memo, useRef } from 'react';
import type { StepRecord, StepSummary, ToolFamily } from '@beluga/shared/steps.js';
import { toolFamily } from '@beluga/shared/steps.js';
import { formatDuration } from '@beluga/shared/text.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { InlineCode } from '../../components/views/Inline.js';
import { Avatar, Dot, cx } from '../../components/ui.js';
import { useApp } from '../../lib/beluga.js';
import { useLive } from '../../lib/live-motion.js';
import { countRender } from '../../lib/render-count.js';
import { type ImageRead, imageReadOf } from './image-read.js';
import { StepDetail } from './StepDetail.js';
import { useStepDetail } from './use-steps.js';
import s from './steps.module.css';

/**
 * One step as a disclosure row: closed, the line the chat always showed (with an icon for its
 * tool, whether it worked, and how long it took); open, what it ran and what came back (see
 * StepDetail). Return or Space opens and closes it, like any button.
 */

const ICONS: Record<ToolFamily, IconName> = {
  bash: 'terminal',
  read: 'file',
  edit: 'pencil',
  search: 'search',
  web: 'globe',
  agent: 'claude',
  message: 'chat',
  mcp: 'grid',
  todo: 'outline',
  other: 'wand',
};

/** Beluga's own tools, by what they do. */
const BELUGA_ICONS: Readonly<Record<string, IconName>> = { who_can: 'people', list_peers: 'people', send_chat: 'chat', write_report: 'file', continue_in_worktree: 'branch', screenshot: 'image', device_info: 'info', wait_for: 'clock', check: 'clock', cancel: 'x' };

export const iconOf = (step: Pick<StepSummary, 'kind' | 'tool'>): IconName =>
  step.kind === 'thinking' ? 'bulb' : (BELUGA_ICONS[(step.tool ?? '').replace(/^mcp__(?:beluga|klaud)(_task)?__/, '')] ?? ICONS[toolFamily(step.tool)]);

const durationOf = (step: StepSummary, now: number, live: boolean): string | undefined => {
  if (step.durationMs !== undefined && step.status !== 'running') return step.durationMs < 1000 ? '<1s' : formatDuration(step.durationMs);
  if (step.status === 'running' && live) return formatDuration(Math.max(step.durationMs ?? 0, now - step.startedAt));
  return undefined;
};

/** Words with a light passing over them (the thing happening now), moved by the live clock (lib/live-motion.ts), not a CSS animation. */
export function Shimmer({ children }: { children: ReactNode }) {
  const words = useRef<HTMLSpanElement>(null);
  useLive(words, (t) => {
    // From 100% to -150% every 2.4s; still: the light rests off to the side.
    if (words.current) words.current.style.backgroundPosition = `${t === null ? 100 : 100 - ((t % 2400) / 2400) * 250}% 0`;
  });
  return (
    <span ref={words} className={s.shimmer}>
      {children}
    </span>
  );
}

/** Someone's peer id by name (for their avatar's colour), else the name. */
export function usePersonId(name: string | undefined): string {
  return useApp((st) => (name ? (st.peers.find((p) => p.name === name)?.peerId ?? st.network.friends.find((f) => f.name === name)?.peerId ?? name) : ''));
}

/** A step's words: as it reads done, or while it's the step Claude is on. */
export const wordsFor = (step: StepSummary, live: boolean): string => (live ? (step.doing ?? step.label ?? step.title) : (step.label ?? step.title));

/** A picture being read: "Read" and the file's name as a badge (its whole path is the row's tooltip). */
function ImageReadWords({ picture, current }: { picture: ImageRead; current: boolean }) {
  return (
    <>
      {current ? <Shimmer>{picture.verb}</Shimmer> : picture.verb}
      <span className={s.imageBadge}>
        <Icon name="image" size={10} />
        <span className={s.imageBadgeName}>{picture.name}</span>
      </span>
    </>
  );
}

/** A step's one line where only its words are known (a card's "Reading shots/home.png"): a picture read shows as its badge. */
export function StepWords({ words }: { words: string }) {
  const picture = imageReadOf({ kind: 'tool' }, words);
  return picture ? <ImageReadWords picture={picture} current={false} /> : <>{words}</>;
}

/** A step's words, with `chat:<ref>` in them drawn as the chat's chip (a message sent to another chat). */
function WithChatChip({ words, current }: { words: string; current: boolean }) {
  const hit = /^(.*?)(chat:\S+)(.*)$/.exec(words);
  if (!hit) return current ? <Shimmer>{words}</Shimmer> : <>{words}</>;
  return (
    <>
      {current ? <Shimmer>{hit[1]!}</Shimmer> : hit[1]}
      <InlineCode text={hit[2]!} fallback={hit[2]} />
      {hit[3]}
    </>
  );
}

export interface StepRowProps {
  readonly step: StepSummary;
  readonly open: boolean;
  /**
   * Opens or closes the step (given its id). Like `load`, the same function for every row and
   * every second, so a row is drawn again only when it changes (KLD-48).
   */
  readonly onToggle: (id: string) => void;
  /** Reads a step's details, by id (when it's opened). */
  readonly load: (id: string) => Promise<StepRecord | undefined>;
  /** The run is going on (a running step's clock ticks). */
  readonly live: boolean;
  /** The clock, for a running step's time (others needn't be given it: they don't redraw as it ticks). */
  readonly now: number;
  /** Who the step is with, when the step itself doesn't say (a wait on a friend's Claude). */
  readonly person?: string | undefined;
  /** Details exist to open (false: just the line). */
  readonly openable?: boolean;
  /** The step Claude is on now: prominent, in the present tense, softly shimmering. */
  readonly current?: boolean;
  /** Words to show instead of the step's own (a finished wait: "Heard back from bob's Claude"). */
  readonly words?: string;
}

export const StepRow = memo(function StepRow({ step: given, open, onToggle, load, live, now, openable = true, current = false, words, person }: StepRowProps) {
  countRender(`step:${given.id}`);
  const step = person && !given.person ? { ...given, person } : given;
  const thinking = step.kind === 'thinking';
  const personId = usePersonId(step.person);
  const canOpen = openable && !step.hidden;
  const running = step.status === 'running' && live;
  const { record, loading, gone } = useStepDetail(() => load(step.id), open && canOpen, `${step.status}:${step.durationMs ?? ''}:${step.endedAt ?? ''}`);
  const time = thinking ? undefined : durationOf(step, now, live);
  const shown = words ?? wordsFor(step, current);
  const picture = imageReadOf(step, shown);
  const head = (
    <>
      <span className={cx(s.chev, open && s.chevOpen, !canOpen && s.chevNone)}>
        <Icon name="chevronRight" size={9} />
      </span>
      <span className={cx(s.icon, thinking && s.iconThink, step.person && s.iconPerson)}>{step.person ? <Avatar name={step.person} id={personId} size={15} /> : <Icon name={iconOf(step)} size={12} />}</span>
      <span className={cx(s.title, thinking && s.titleThink)} title={step.label ?? step.title}>
        {picture ? <ImageReadWords picture={picture} current={current} /> : <WithChatChip words={shown} current={current} />}
      </span>
      <span className={s.end}>
        {time ? <span className={s.time}>{time}</span> : null}
        {thinking || current ? null : running ? <Dot tone="claude" live /> : step.status === 'error' ? <Icon name="x" size={11} className={s.bad} /> : step.status === 'done' ? <Icon name="check" size={11} className={s.good} /> : null}
      </span>
    </>
  );
  return (
    <div className={cx(s.row, open && s.rowOpen, step.status === 'error' && s.rowError, current && s.rowCurrent)} data-step={step.id} data-current={current || undefined} data-step-kind={thinking ? 'thinking' : toolFamily(step.tool)}>
      {canOpen ? (
        <button type="button" className={s.head} aria-expanded={open} onClick={() => onToggle(step.id)} title={open ? 'Hide details' : 'Show what ran and what came back'}>
          {head}
        </button>
      ) : (
        <div className={cx(s.head, s.headStatic)}>{head}</div>
      )}
      {open && canOpen ? (
        record ? (
          <StepDetail record={record} />
        ) : (
          <div className={cx(s.detail, s.quiet)}>{loading ? 'Loading…' : gone ? 'Beluga no longer has the details of this step.' : null}</div>
        )
      ) : null}
    </div>
  );
});
