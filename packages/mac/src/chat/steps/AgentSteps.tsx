import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogItem, Remark, SubAgent } from '@beluga/core/store.js';
import type { TaskView } from '@beluga/core/gateway/model.js';
import { isFinal } from '@beluga/core/gateway/model.js';
import type { StepRecord, StepSummary } from '@beluga/shared/steps.js';
import { humanizeLine } from '@beluga/shared/step-titles.js';
import { formatDuration } from '@beluga/shared/text.js';
import { DONE_STEPS, HIDDEN_STEPS } from '@beluga/ui/format.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, Button, Dot, cx } from '../../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { usePrefs } from '../../lib/prefs.js';
import { useDisclosure } from './step-memory.js';
import { type Entry, foldOf, movedTogether, ownStepsOf, subRowView, timelineOf, workIn } from './timeline.js';
import { usePresence } from '../../layout/panel/ResizeHandle.js';
import { Shimmer, StepRow, usePersonId } from './StepRow.js';
import { Markdown } from '../Markdown.js';
import { useAgentSteps } from './use-steps.js';
import { type TurnPart, inHead } from '../live-tail.js';
import { useActions } from '../../lib/actions.js';
import { useClock } from '../../lib/window-active.js';
import { countRender } from '../../lib/render-count.js';
import { keepSameById, sameDeep, sameItems } from '../../lib/stable.js';
import { agentOfToolUse, allSubAgents } from '../../claude-code/subagents-model.js';
import { openSubAgent } from '../../layout/SubAgents.js';
import { waitState, waitTone, waitedLabel, waitingFor } from './waiting.js';
import c from '../chat.module.css';
import s from './steps.module.css';

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** Tools that start a sub-agent: their step is the sub-agent's row. */
const LAUNCH = new Set(['Task', 'Agent']);
/** Finished steps shown below the "3 steps · 12s" line (the rest fold into it). */
const RECENT_LIVE = 2;
/** How long folding a finished card's steps takes (twice --dur, see .fold). */
const FOLD_MS = 380;
/** The fold's words when all it holds is what Claude said on the way (no steps of its own). */
const SAID_LABEL = 'What it said on the way';

const NO_TASKS: readonly TaskView[] = [];
const NO_STEPS: readonly StepSummary[] = [];
const NO_SUBS: readonly SubAgent[] = [];
const NO_REMARKS: readonly Remark[] = [];

/** The clock for a step's row: only a running step's time moves, so only its row is drawn again as the clock ticks. */
const clockFor = (step: StepSummary, live: boolean, now: number): number => (live && step.status === 'running' ? now : 0);

/** A one-line step (someone else's Claude, or a card from before details were kept) as a row. */
function lineStep(line: string, i: number, at: number, live: boolean): StepSummary {
  const h = humanizeLine(line);
  return { id: `line-${i}`, kind: 'tool', title: line, label: h.done, doing: h.doing, status: live ? 'running' : 'done', startedAt: at, ...(h.person ? { person: h.person } : {}), ...(h.task ? { task: h.task } : {}), ...(h.wait ? { wait: true } : {}) };
}

/** A record kept before steps had words (or from an older Beluga): its words from its line. */
function withWords(step: StepSummary): StepSummary {
  if (step.label || step.kind !== 'tool') return step;
  const h = humanizeLine(step.title);
  return { ...step, label: h.done, doing: h.doing, ...(h.person ? { person: h.person } : {}), ...(h.task ? { task: h.task } : {}), ...(h.wait ? { wait: true } : {}) };
}

/** "3 steps · 12s": how long a stretch of steps took, when their times are known. */
function spanOf(steps: readonly StepSummary[]): string | undefined {
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last || first.id.startsWith('line-')) return undefined;
  const end = last.endedAt ?? (last.durationMs !== undefined ? last.startedAt + last.durationMs : undefined);
  return end !== undefined && end > first.startedAt ? formatDuration(end - first.startedAt) : undefined;
}

/**
 * What Claude did on a card, and what it's doing now. While it works: the step it's on as the
 * prominent live line (or a waiting row with the friend it waits on), the last finished steps
 * above it, and older ones folded into "5 steps · 12s"; the card's working line says the rest.
 * A turn split by what you said meanwhile (`part`, see live-tail.ts) draws only its side's steps. Every step is said in words ("Ran npm test", "Asked bob's Claude: …"), never
 * a tool's name or an id; your own Claude's steps open to show what ran and what came back.
 */
export const AgentSteps = memo(function AgentSteps({ item, running, part, subs: which }: { item: AgentItem; running: boolean; part?: TurnPart | undefined; subs?: 'running' | 'settled' | undefined }) {
  const selfId = useApp((st) => st.selfId);
  const detail = useApp((st) => st.prefs.subagents);
  const mine = item.owner === selfId;
  const change = `${item.status}:${item.steps.length}:${item.steps.at(-1) ?? ''}:${item.subagents.map((x) => `${x.steps.length}${x.status}`).join(',')}`;
  const { steps: rich } = useAgentSteps(item.channel, item.id, running, change, mine);
  const now = useClock(running);
  const open = useDisclosure(`${item.channel}/${item.id}`);
  const [earlier, setEarlier] = useState(false);
  const api = useApi();
  // The sub-agents, each the same object while it reads the same (a fresh copy of the card
  // shouldn't draw its sub-agents' rows again).
  const subsBefore = useRef<readonly SubAgent[]>([]);
  const subagents = useMemo(() => {
    const old = new Map(subsBefore.current.map((x) => [x.id, x]));
    const next = item.subagents.map((x) => (sameDeep(old.get(x.id), x) ? old.get(x.id)! : x));
    return (subsBefore.current = sameItems(subsBefore.current, next) ? subsBefore.current : next);
  }, [item.subagents]);
  const subIds = useMemo(() => new Set(subagents.map((x) => x.id)), [subagents]);
  const richOnes = Boolean(rich?.length);
  // The main thread's steps: your own Claude's records, else its one-line steps in words.
  // A step that reads as it did stays the same object, so its row isn't drawn again (KLD-48).
  const before = useRef<readonly StepSummary[]>([]);
  const rows = useMemo<StepSummary[]>(() => {
    const lines = item.steps.filter((x) => !HIDDEN_STEPS.test(x));
    const next = rich?.length
      ? rich.filter((x) => !x.parent && !(x.tool && LAUNCH.has(x.tool) && subIds.has(x.id)) && !HIDDEN_STEPS.test(x.title)).map(withWords)
      : lines.map((line, i) => lineStep(line, i, item.ts, running && i === lines.length - 1));
    // A live part (what a taken-over turn left running) draws no steps of its own, only its running work.
    const mine = part?.side === 'live' ? [] : part ? next.filter((x) => inHead(x, part.cut) === (part.side === 'head')) : next;
    return (before.current = keepSameById(before.current, mine));
  }, [rich, subIds, item.steps, item.ts, running, part?.side, part?.cut]);
  const working = running && !item.text;
  // Only the tasks this card's steps wait on: another task changing doesn't draw this card again.
  const asked = rows.flatMap((x) => (x.task ? [x.task] : [])).join(' ');
  const tasks = useApp((st) => (asked ? st.gateway.tasks.filter((t) => asked.split(' ').includes(t.id)) : NO_TASKS), sameItems);
  // The same functions every render and every second, so a step's row (memo) only draws again when it changes.
  const disclosure = useRef(open);
  disclosure.current = open;
  const toggle = useCallback((id: string) => disclosure.current.toggle(id), []);
  const load = useCallback((id: string) => api.agent.step(item.channel, item.id, id), [api, item.channel, item.id]);

  // The step Claude is on: the last one, while it runs.
  const lastRow = rows.at(-1);
  const current = working && lastRow?.status === 'running' ? lastRow : undefined;
  const finished = useMemo(() => (current ? rows.slice(0, -1) : rows), [current, rows]);
  // Sub-agents and background work sit where they started (KLD-51); hidden, they're one line at the end.
  // A split turn's sub-agents and background work are its tail's (what's still going stays in sight at the bottom).
  // A taken-over turn's running work is drawn in its live part, at the very bottom (BLG-54); the rest stays where it started.
  const kept = useMemo(() => (which ? subagents.filter((x) => (x.status === 'running') === (which === 'running')) : subagents), [subagents, which]);
  const placedSubs = detail === 'hidden' || part?.side === 'head' ? NO_SUBS : kept;
  // What it said on the way, among the steps it came between (a split turn's: the side it was said on).
  const remarks = useMemo(() => {
    const all = item.remarks ?? NO_REMARKS;
    return part?.side === 'live' ? NO_REMARKS : part ? all.filter((x) => (x.ts < part.cut) === (part.side === 'head')) : all;
  }, [item.remarks, part?.side, part?.cut]);
  const timeline = useMemo(() => timelineOf(finished, placedSubs, (id) => rich?.find((x) => x.id === id)?.startedAt, remarks), [finished, placedSubs, rich, remarks]);
  const ownBefore = useRef<ReadonlyMap<string, readonly StepSummary[]>>(undefined);
  const own = useMemo(() => (ownBefore.current = ownStepsOf(ownBefore.current, rich, subagents)), [rich, subagents]);
  const keep = running ? RECENT_LIVE : DONE_STEPS;
  // While it works, the newest thing it said stays in sight; once done, all it said folds away.
  const split = useMemo(() => foldOf(timeline, keep, running), [timeline, keep, running]);
  // Several rows changing sides of the fold at once (the answer landing, sub-agents finishing
  // together) move as one: they don't each slide (KLD-72).
  const folded = useRef<{ ids: readonly string[]; together: boolean }>({ ids: [], together: false });
  const olderIds = split.older.map((e) => e.id);
  if (!sameItems(folded.current.ids, olderIds)) folded.current = { ids: olderIds, together: movedTogether(folded.current.ids, olderIds) };
  const together = folded.current.together;
  const folds = split.older.length > 0 && !open.all;
  const older = folds && !earlier ? split.older : [];
  const shown = folds && !earlier ? split.shown : timeline;
  const still = useStill();
  const taskOf = (step: StepSummary): TaskView | undefined => (step.task ? tasks.find((t) => t.id === step.task) : undefined);

  const row = (step: StepSummary, isCurrent: boolean) => {
    const task = step.wait ? taskOf(step) : undefined;
    if (isCurrent && step.wait) return <WaitingRow step={step} task={task} now={now} />;
    return (
      <StepRow
        step={step}
        person={task?.peerName}
        open={open.isOpen(step.id)}
        onToggle={toggle}
        load={load}
        live={running}
        now={clockFor(step, running, now)}
        openable={richOnes}
        current={isCurrent}
        {...(step.wait && waitedLabel(task) ? { words: waitedLabel(task) } : {})}
      />
    );
  };
  const entry = (e: Entry) => {
    if (e.kind === 'step') return row(e.step, false);
    if (e.kind === 'remark') return <RemarkRow text={e.remark.text} mine={mine} now={running && e.id === latestSaid} />;
    const mineToo = (richOnes && own.get(e.sub.id)) || NO_STEPS;
    return <SubAgentRow sub={e.sub} own={mineToo} detail={detail} toggle={toggle} load={load} live={running} {...subRowView(e.sub, mineToo, open.isOpen, running, now)} />;
  };
  const latestSaid = remarks.length ? `remark:${remarks.at(-1)!.ts}` : undefined;
  const olderSteps = older.flatMap((e) => (e.kind === 'step' ? [e.step] : []));
  const olderWork = workIn(older);
  const span = olderSteps.length === olderWork ? spanOf(olderSteps) : undefined;

  return (
    <>
      <div className={s.list} role="list" aria-label="The agent's steps">
        {/* One keyed list with the step Claude is on: when it finishes it stays the same row (no
            remount, so nothing blinks or restarts) and only changes how it reads. A row leaving the
            last few closes up into the fold above it, whose count ticks up (KLD-51). */}
        <AnimatePresence initial={false} custom={still || together}>
          {folds ? (
            <Slot key="fold" still={still}>
              <div className={s.bar}>
                {earlier ? (
                  <button type="button" className={s.fold} onClick={() => setEarlier(false)} aria-expanded="true" aria-label={`Hide ${split.older.length} earlier steps`}>
                    <span className={cx(s.chev, s.chevOpen)}>
                      <Icon name="chevronRight" size={9} />
                    </span>
                    Hide earlier steps
                  </button>
                ) : (
                  <button type="button" className={s.fold} onClick={() => setEarlier(true)} aria-expanded="false" aria-label={olderWork ? `Show ${olderWork} earlier steps` : SAID_LABEL} data-folded-count={olderWork}>
                    <span className={s.chev}>
                      <Icon name="chevronRight" size={9} />
                    </span>
                    {olderWork ? (
                      <>
                        <span className={s.foldIcon}>
                          <Icon name="check" size={11} />
                        </span>
                        <span className={s.count}>
                          <span key={olderWork} className={s.countNow}>
                            {olderWork}
                          </span>
                        </span>
                        {olderWork === 1 ? 'step' : 'steps'}
                        {span ? ` · ${span}` : ''}
                      </>
                    ) : (
                      SAID_LABEL
                    )}
                  </button>
                )}
              </div>
            </Slot>
          ) : null}
          {shown.map((e) => (
            <Slot key={e.id} still={still || together} id={e.id}>
              {entry(e)}
            </Slot>
          ))}
          {current ? (
            <Slot key={current.id} still={still} id={current.id}>
              {row(current, true)}
            </Slot>
          ) : null}
        </AnimatePresence>
        {detail === 'hidden' && item.subagents.length && part?.side !== 'head' ? (
          <div className={c.step}>
            <Icon name="claude" size={11} />
            {item.subagents.length} sub-agent{item.subagents.length === 1 ? '' : 's'}
          </div>
        ) : null}
      </div>
    </>
  );
});

/**
 * Something Claude said between its steps ("Found it, now the tests"): quiet, like the steps
 * around it, so only its answer (the words after its last step) reads as the answer. The newest
 * one, while Claude works (`now`), reads a little stronger: it's what Claude is up to.
 */
const RemarkRow = memo(function RemarkRow({ text, mine, now }: { text: string; mine: boolean; now: boolean }) {
  return (
    <div className={cx(s.remark, now && s.remarkNow)} data-remark={now ? 'now' : ''}>
      <Markdown text={text} paths={mine} localImages={mine} />
    </div>
  );
});

/** How long a row takes to close into the fold, or open out of it. */
const SLIDE = { duration: 0.3, ease: [0.32, 0.72, 0, 1] } as const;

/** Leaving: how is up to the list (AnimatePresence's custom), as it is when the row goes, not when it was last drawn. */
const LEAVE = { gone: (still: boolean) => ({ height: 0, opacity: 0, overflow: 'hidden', transition: still ? { duration: 0 } : SLIDE }) };

/**
 * A row of the steps that opens (height, then in) as it arrives and closes (out, and the height)
 * as it leaves for the fold. With reduced motion it's just there, or gone; so are rows that move
 * together (see movedTogether).
 */
function Slot({ still, id, children }: { still: boolean; id?: string; children: ReactNode }) {
  const t = still ? { duration: 0 } : SLIDE;
  return (
    <motion.div
      className={s.slot}
      data-slot={id}
      variants={LEAVE}
      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
      exit="gone"
      transition={t}
    >
      {children}
    </motion.div>
  );
}

/** Reduced motion, from the Mac's setting or Settings › Appearance › Reduce motion. */
function useStill(): boolean {
  const os = useReducedMotion() ?? false;
  const reduce = usePrefs().reduceMotion;
  return os || reduce;
}

/**
 * A finished answer's steps, in the card's hover actions (next to Copy). Folded away once Claude
 * answers (Settings › Chat), it shows them again; kept showing, it opens or closes every step.
 */
export function StepsToggle({ item }: { item: AgentItem }) {
  const prefs = usePrefs();
  const open = useDisclosure(`${item.channel}/${item.id}`);
  if (prefs.doneSteps === 'fold') {
    return (
      <Button size="small" variant="quiet" icon={open.shown ? 'chevronUp' : 'chevronDown'} onClick={() => open.setShown(!open.shown)}>
        {open.shown ? 'Hide Steps' : 'Show Steps'}
      </Button>
    );
  }
  return (
    <Button size="small" variant="quiet" icon={open.any ? 'chevronUp' : 'chevronDown'} onClick={() => open.setAllOpen(!open.any)}>
      {open.any ? 'Collapse all' : 'Expand all'}
    </Button>
  );
}

/**
 * Steps that fold away: once Claude has answered, they close (the height and then nothing, so the
 * answer moves up under the name) and leave the chat; Show Steps opens them the same way back.
 */
export function StepsFold({ folded, children }: { folded: boolean; children: ReactNode }) {
  const presence = usePresence(!folded, FOLD_MS);
  const was = useRef(folded);
  const [opening, setOpening] = useState(false);
  useLayoutEffect(() => {
    if (was.current && !folded) setOpening(true);
    if (folded) setOpening(false);
    was.current = folded;
  }, [folded]);
  if (!presence.mounted) return null;
  return (
    <div
      className={s.folding}
      data-folded={folded ? 'true' : undefined}
      data-opening={opening ? 'true' : undefined}
      // Folding away, it's on its way out: not something to tab into.
      inert={folded}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setOpening(false);
      }}
    >
      <div className={s.foldingInner}>{children}</div>
    </div>
  );
}

/** Claude waits on a friend's Claude (or Mac): who, where their side is, for how long; Cancel. */
function WaitingRow({ step, task, now }: { step: StepSummary; task: TaskView | undefined; now: number }) {
  const { client } = useBeluga();
  const api = useApi();
  const person = task?.peerName ?? step.person;
  const personId = usePersonId(person);
  const tone = waitTone(task);
  const since = task?.createdAt ?? step.startedAt;
  return (
    <div className={cx(s.waitRow, s[`wait_${tone}`])} data-current="true" data-waiting={task?.state ?? 'unknown'} role="status">
      <span className={s.waitAvatar}>{person ? <Avatar name={person} id={personId} size={22} /> : <Icon name="clock" size={14} />}</span>
      <span className={s.waitText}>
        <span className={s.waitTitle}>{waitingFor(task)}</span>
        <span className={s.waitState}>{task ? waitState(task) : 'Their answer comes back here'}</span>
      </span>
      <span className={s.waitEnd}>
        <span className={s.time}>{formatDuration(Math.max(0, now - since))}</span>
        {task && !isFinal(task.state) ? (
          <button type="button" className={s.waitCancel} onClick={() => void api.gateway.cancel(task.id).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'))}>
            Cancel
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Follow one of this conversation's sub-agents on its own page (live: thinking, tools, its worktree). */
function WatchAgent({ id }: { id: string }) {
  const { client } = useBeluga();
  const actions = useActions();
  const sessions = useApp((st) => st.claudeCode.sessions);
  // The chat knows a sub-agent by the call that started it (or, in the background, by its agent id).
  const sub = useMemo(() => agentOfToolUse(sessions, id) ?? allSubAgents(sessions).find((x) => x.agent.id === id), [sessions, id]);
  if (!sub) return null;
  return (
    // A span (it sits inside the sub-agent's own toggle button).
    <span
      role="button"
      tabIndex={0}
      className={s.watch}
      aria-label={`Watch ${sub.agent.description} live`}
      onClick={(e) => (e.stopPropagation(), openSubAgent(client, actions, sub))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        openSubAgent(client, actions, sub);
      }}
    >
      <Icon name="eye" size={11} />
      Watch
    </span>
  );
}

interface SubAgentRowProps {
  sub: SubAgent;
  own: readonly StepSummary[];
  detail: string;
  toggle: (id: string) => void;
  load: (id: string) => Promise<StepRecord | undefined>;
  live: boolean;
  /** Its row is open. */
  open: boolean;
  /** Which of its own steps are open (their ids, space-separated). */
  opened: string;
  /** The clock, or 0 when nothing on the row moves with it (see subRowView). */
  now: number;
}

/**
 * A sub-agent or background work, in the place it started: a live dot while it runs; your own
 * Claude's open to their steps. Drawn again only when what it shows changes, not every second (KLD-72).
 */
const SubAgentRow = memo(function SubAgentRow({ sub, own, detail, toggle, load, live, open: isOpen, opened, now }: SubAgentRowProps) {
  countRender(`sub:${sub.id}`);
  const key = `sub:${sub.id}`;
  const running = sub.status === 'running';
  const canOpen = own.length > 0;
  const head = (
    <>
      {canOpen ? (
        <span className={cx(s.chev, isOpen && s.chevOpen)}>
          <Icon name="chevronRight" size={9} />
        </span>
      ) : null}
      {running ? <Dot tone={sub.kind === 'background' ? 'claude' : 'subagent'} live /> : <Icon name={sub.status === 'failed' ? 'x' : 'check'} size={11} className={sub.status === 'failed' ? c.subFailed : c.subDone} />}
      <span className={c.subTitle}>{sub.kind === 'background' ? `Background · ${sub.title}` : sub.title}</span>
      {sub.steps.length ? <span className={c.time}>{sub.steps.length} steps</span> : null}
      <WatchAgent id={sub.id} />
    </>
  );
  return (
    <div className={cx(c.sub, s.sub)} data-subagent={sub.id} data-running={running || undefined}>
      {canOpen ? (
        <button type="button" className={cx(c.subHead, s.subHead)} aria-expanded={isOpen} onClick={() => toggle(key)}>
          {head}
        </button>
      ) : (
        <div className={c.subHead}>{head}</div>
      )}
      {isOpen ? (
        <div className={s.subBody}>
          {own.map((step) => (
            <StepRow key={step.id} step={step} open={opened.split(' ').includes(step.id)} onToggle={toggle} load={load} live={live} now={clockFor(step, live, now)} />
          ))}
        </div>
      ) : running && detail === 'full' && sub.steps.length ? (
        <div className={cx(c.step, c.subStep, s.subNow)}>
          <Shimmer>{humanizeLine(sub.steps.at(-1)!).doing}</Shimmer>
        </div>
      ) : null}
    </div>
  );
});
