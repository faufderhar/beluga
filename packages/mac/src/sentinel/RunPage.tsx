import { useEffect, useRef, useState } from 'react';
import { DEFAULT_KEEP_CHATS, KEEP_CHATS_INFO, type RunDetail, type RunSummary, type Step, type StepRun, STEP_INFO } from '@beluga/core/sentinel/model.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { LiveDot } from '../plans/marks.js';
import { TaskChip, WorktreeChip } from '../tasks/TaskRef.js';
import { useSwipeBack } from '../tasks/use-swipe-back.js';
import { SwipeBackEdge } from '../tasks/SwipeBackEdge.js';
import { RunPill } from './marks.js';
import { STEP_ICON, chatPlaceOf, durationText, headlineOf, isRunning, runLine } from './sentinel-model.js';
import { useClock } from '../lib/window-active.js';
import { useSentinelActions, useSentinelState } from './use-sentinel.js';
import v from '../views/views.module.css';
import t from '../tasks/tasks.module.css';
import s from './sentinel.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { chordLabel, primaryKey } from '../lib/shortcuts-model.js';
import { ASSISTANT_TITLE } from '@beluga/shared/assistant.js';
import { revealLabel } from '../lib/os-words.js';

/**
 * One run: its headline, who started it and how long it took, each step with how it went (its
 * output folded, the error in words, its chat a click away), the report as the chat draws it,
 * and what it left (a pull request, a worktree, tasks). A run waiting for you has Merge and Not
 * Now at the top; a running one has Stop under ⋯. Read with sentinel.runGet, again as it changes.
 */
export function RunPage({ runId }: { runId: string }) {
  const state = useSentinelState();
  const summary = state.runs.find((r) => r.id === runId);
  const a = useSentinelActions();
  const [detail, setDetail] = useState<RunDetail>();
  const [error, setError] = useState<string>();
  // The run's summary in the state: when it changes (a step ends, it finishes), its outputs are read again.
  const stamp = summary ? `${summary.state}|${summary.endedAt ?? ''}|${summary.headline}|${summary.steps.map((x) => x.state).join()}` : '';
  useEffect(() => {
    let alive = true;
    a.api
      .runGet(runId)
      .then((d) => alive && (setDetail(d), setError(undefined)))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message.replace(/^Error: /, '') : String(err)));
    return () => {
      alive = false;
    };
  }, [runId, stamp, a]);
  if (!state.enabled) return <Empty icon="sentinel" title="Sentinel needs the Beluga app" />;
  if (error && !detail) return <Empty icon="sentinel" title="This run isn’t here anymore" detail={error} />;
  if (!detail) return <Empty icon="sentinel" title="Reading the run…" />;
  return <Run detail={detail} summary={summary} />;
}

function Run({ detail, summary }: { detail: RunDetail; summary: RunSummary | undefined }) {
  const wrap = useRef<HTMLDivElement>(null);
  const a = useSentinelActions();
  const actions = useActions();
  const state = useSentinelState();
  const now = useClock(true, 5_000);
  // The state is newer than what was read (a step just ended): its states and headline win.
  const run = summary ? { ...detail.run, ...summary, trigger: detail.run.trigger, steps: detail.run.steps.map((st, i) => ({ ...st, ...summary.steps[i] })) } : detail.run;
  const sentinel = state.items.find((x) => x.id === run.sentinelId);
  const name = sentinel?.name ?? detail.sentinel?.name;
  const back = (): void => (sentinel ? a.open(sentinel.id) : a.openList());
  const swipe = useSwipeBack(wrap, back);
  // Put away as its sentinel keeps chats (BLG-566): the report and outputs stay, the chat doesn't.
  const chat = run.putAway ? undefined : (run.channel ?? run.steps.find((x) => x.channel)?.channel);
  const keptNote = run.chatDeleted ? 'You deleted its chat. The report and outputs stay here.' : run.putAway ? `Its chat was put away: ${sentinel ? `${sentinel.name} ${KEEP_CHATS_INFO[sentinel.keepChats ?? DEFAULT_KEEP_CHATS].keeps}` : 'its sentinel keeps fewer chats'}. The report and outputs stay here.` : undefined;
  const waiting = run.state === 'needs-you';
  const ended = run.state !== 'queued' && run.state !== 'running' && !waiting;
  // Its own chats (a project or Your Mac chat), not its worktree's: what Delete Chat deletes.
  const ownChat = !run.chatDeleted && !run.putAway && [run.channel, ...run.steps.map((x) => x.channel)].some((c) => c && c !== (run.worktreeId ? `ws:${run.worktreeId}` : undefined));
  const why = run.steps.find((x) => x.why && x.state === 'running')?.why;
  const more: ActionItem[] = [
    ...(isRunning(run.state) ? [{ label: 'Stop', icon: 'stop' as const, danger: true, onSelect: () => void a.act(() => a.api.stop(run.id), 'Stopped') }] : []),
    ...(chat && chatPlaceOf(chat) ? [{ label: 'Open Chat', icon: 'chat' as const, keys: chordLabel('Cmd+Enter'), onSelect: () => a.openChannel(chat) }] : []),
    ...(sentinel ? [{ label: `Open ${sentinel.name}`, icon: 'sentinel' as const, onSelect: () => a.open(sentinel.id) }] : []),
    // Its folder: trigger.json, each step's output, report.md, its documents (BLG-578).
    { label: revealLabel(), icon: 'folder' as const, separate: true, onSelect: () => void a.act(() => a.api.dataReveal(run.sentinelId, run.id)) },
    // What it left, deleted as you ask (BLG-577); a run still going is stopped first.
    ...(ended && ownChat ? [{ label: 'Delete Chat…', icon: 'trash' as const, danger: true, separate: true, onSelect: () => a.deleteRun(run, 'chat') }] : []),
    ...(ended ? [{ label: 'Delete Run…', icon: 'trash' as const, danger: true, ...(ownChat ? {} : { separate: true }), onSelect: () => a.deleteRun(run, 'run', back) }] : []),
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !primaryKey(e) || e.key !== 'Enter' || !chat || !chatPlaceOf(chat)) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      a.openChannel(chat);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat, a]);
  return (
    <div ref={wrap} className={t.pageWrap}>
      <SwipeBackEdge progress={swipe} />
      <div className={t.page}>
        <div className={t.pageMain} data-run-page={run.id}>
          <nav className={t.crumbs} aria-label="Where this run is">
            <IconButton size="small" icon="back" label="Back" keys={shortcutKeys('page-back')} className={t.crumbBack} onClick={back} />
            <button type="button" className={t.crumb} onClick={() => a.openList()}>
              Sentinel
            </button>
            <Icon name="chevronRight" size={10} />
            {sentinel ? (
              <button type="button" className={t.crumb} onClick={() => a.open(sentinel.id)}>
                {sentinel.name}
              </button>
            ) : (
              <span className={t.crumbPlain}>{name ?? 'A sentinel'}</span>
            )}
            <span className={t.grow} />
            <RunPill state={run.state} />
            {more.length ? (
              <ActionsDropdown items={more}>
                <IconButton size="small" icon="more" label="More for this run" />
              </ActionsDropdown>
            ) : null}
          </nav>
          <h1 className={s.title}>{headlineOf(run)}</h1>
          <p className={s.line}>{runLine(run, name, state, now)}</p>
          {waiting ? (
            <div className={s.decide} role="status" data-testid="sentinel-decide">
              <Icon name="merge" size={15} />
              <span className={s.bannerText}>
                <strong>{run.pr ? `Pull request #${run.pr.number} waits for you.` : 'This run waits for you.'}</strong> {why ?? 'Merge it, or leave it open for now.'}
              </span>
              <Button size="small" variant="quiet" onClick={() => void a.act(() => a.api.decide(run.id, 'skip'), run.pr ? `#${run.pr.number} stays open` : 'Not now')}>
                Not Now
              </Button>
              <Button size="small" variant="merge" icon="merge" onClick={() => void a.act(() => a.api.decide(run.id, 'merge'), run.pr ? `Merged #${run.pr.number}` : 'Merged')}>
                Merge
              </Button>
            </div>
          ) : null}
          {run.state === 'failed' && run.why ? (
            <div className={s.banner} data-tone="error" role="status">
              <Icon name="alert" size={14} />
              <span className={s.bannerText}>{run.why.split('\n')[0]}</span>
            </div>
          ) : null}

          <section className={s.card} aria-label="Steps">
            <header className={s.cardHead}>
              <h3 className={s.cardTitle}>Steps</h3>
            </header>
            <div className={s.timeline} role="list">
              {run.steps.map((st, i) => (
                <TimelineStep key={st.id} run={st} step={sentinel?.steps.find((x) => x.id === st.id)} index={i} now={now} worktree={run.worktreeId} gone={st.channel !== undefined && st.channel !== (run.worktreeId ? `ws:${run.worktreeId}` : undefined) ? keptNote : undefined} open={(c) => a.openChannel(c)} />
              ))}
            </div>
          </section>

          {detail.report ? (
            <section className={s.card} aria-label="Report">
              <header className={s.cardHead}>
                <h3 className={s.cardTitle}>Report</h3>
              </header>
              <div className={cx(s.report, 'selectable')}>
                <Markdown text={detail.report} tasks />
              </div>
            </section>
          ) : null}

          {run.pr || run.worktreeId || run.tasks.length ? (
            <section className={s.card} aria-label="What it left">
              <header className={s.cardHead}>
                <h3 className={s.cardTitle}>What it left</h3>
              </header>
              <div className={s.proof}>
                {run.pr ? (
                  <Button size="small" icon="pr" onClick={() => actions.openLink({ kind: 'url', url: run.pr!.url })}>
                    Pull request #{run.pr.number}
                  </Button>
                ) : null}
                {run.worktreeId ? <WorktreeChip id={run.worktreeId} /> : null}
                {run.tasks.map((k) => (
                  <TaskChip key={k} taskKey={k} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TimelineStep({ run, step, index, now, worktree, gone, open }: { run: StepRun; step: Step | undefined; index: number; now: number; worktree?: string | undefined; gone?: string | undefined; open: (channel: string) => void }) {
  const [shown, setShown] = useState(false);
  // Claude's session, watched right here: open while it works (and when it needs you), folded after.
  const live = run.state === 'running';
  const [watching, setWatching] = useState<boolean>();
  const watch = watching ?? live;
  const took = run.startedAt !== undefined ? durationText((run.endedAt ?? now) - run.startedAt) : '';
  const kind = step?.kind;
  return (
    <div className={s.tStep} role="listitem" data-state={run.state}>
      <span className={s.tMark} data-state={run.state} aria-label={run.state}>
        {run.state === 'running' ? <LiveDot /> : <Icon name={run.state === 'done' ? 'check' : run.state === 'failed' ? 'x' : run.state === 'skipped' ? 'minus' : kind ? STEP_ICON[kind] : 'clock'} size={12} />}
      </span>
      <div className={s.tBody}>
        <div className={s.tTop}>
          <span className={s.tName}>{step?.name ?? `Step ${index + 1}`}</span>
          {kind ? <span className={s.tTook}>{STEP_INFO[kind].label}</span> : null}
          {took ? <span className={s.tTook}>· {took}{run.state === 'running' ? ' so far' : ''}</span> : null}
          <span className={t.grow} />
          {run.channel && chatPlaceOf(run.channel) && kind !== 'claude' && !gone ? (
            <Button size="small" variant="quiet" icon="chat" onClick={() => open(run.channel!)}>
              Open Chat
            </Button>
          ) : null}
        </div>
        {run.channel && kind === 'claude' && gone ? <span className={s.tNote}>{gone}</span> : null}
        {run.channel && kind === 'claude' && !gone ? (
          <>
            <button type="button" className={s.disclosure} aria-expanded={watch} onClick={() => setWatching(!watch)}>
              <Icon name={watch ? 'chevronDown' : 'chevronRight'} size={10} />
              {watch ? 'Hide the agent’s session' : live ? 'Watch the agent work' : 'The agent’s session'}
            </button>
            {watch ? <Session channel={run.channel} live={live} where={step?.kind === 'claude' ? step.where : undefined} worktree={worktree} open={() => open(run.channel!)} /> : null}
          </>
        ) : null}
        {run.why ? <span className={run.state === 'failed' ? s.tWhy : s.tNote}>{run.why}</span> : run.state === 'waiting' ? <span className={s.tNote}>Waiting for the steps before it</span> : null}
        {run.output ? (
          <>
            <button type="button" className={s.disclosure} aria-expanded={shown} onClick={() => setShown(!shown)}>
              <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={10} />
              {shown ? 'Hide output' : 'Show output'}
            </button>
            {shown ? <pre className={cx(s.output, 'selectable')}>{run.output}</pre> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}


/**
 * A Claude step's session, as the chat draws it, inside the run (BLG-330): what Claude reads, runs
 * and says, live, and what it asks you (answered here). Read-only: the conversation itself, a click
 * away, is where you write to it. A step in a worktree names it.
 */
function Session({ channel, live, where, worktree, open }: { channel: string; live: boolean; where: 'project' | 'worktree' | 'mac' | undefined; worktree: string | undefined; open: () => void }) {
  return (
    <div className={s.session} data-run-session={channel} data-live={live || undefined}>
      <div className={s.sessionBar}>
        {live ? <LiveDot /> : <Icon name="claude" size={12} />}
        <span className={s.sessionWhere}>{where === 'worktree' ? 'In its own worktree' : where === 'mac' ? `On ${ASSISTANT_TITLE}` : 'In the project, reading only'}</span>
        {where === 'worktree' && worktree ? <WorktreeChip id={worktree} /> : null}
        <span className={t.grow} />
        {chatPlaceOf(channel) ? (
          <Button size="small" variant="quiet" icon="chat" onClick={open}>
            Open the Chat
          </Button>
        ) : null}
      </div>
      <div className={cx(v.chat, s.sessionLog)}>
        <ChatLog channel={channel} empty={<div className={s.sessionEmpty}>{live ? 'The agent is starting…' : 'This session has nothing to show'}</div>} />
        <Attention channel={channel} />
      </div>
    </div>
  );
}
