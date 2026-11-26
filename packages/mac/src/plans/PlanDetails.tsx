import { useEffect, useState } from 'react';
import { type Criterion, criteria } from '@beluga/core/board/criteria.js';
import { type Plan, shownBody, taskById } from '@beluga/core/plans/model.js';
import { staleTasks } from '@beluga/core/plans/coherence.js';
import { taskProof } from '@beluga/core/board/model.js';
import { FINISHED, type MilestoneView, type PlanView, type TaskView, taskOrder } from '@beluga/core/plans/progress.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { ProofItems } from '../tasks/TaskSections.js';
import { type FlowStep, MILESTONE_STATE, branchFlow, milestoneNowWords, taskWords } from './plans-model.js';
import { LiveDot, TaskChatMark, TaskStateIcon, TonePill } from './marks.js';
import { openDecision } from './plan-ask-model.js';
import { PlanFeed } from './PlanFeed.js';
import { useCardClock, useCheckerChat, useClock, usePlanActions } from './use-plans.js';
import { useStartWith } from '../components/agent-options.js';
import { SplitButton } from '../components/SplitButton.js';
import { useMyAgent } from '../lib/agent-words.js';
import type { AgentRef } from '@beluga/protocol.js';
import { WaitingLine } from './WaitingLine.js';
import p from './plans.module.css';
import { revealLabel } from '../lib/os-words.js';

/** The details pane shows what the plan did when this is picked. */
export const FEED = 'feed';
/** …and where its work goes (milestones into its branch, the branch into main) when this is. */
export const BRANCH = 'branch';
/** …and what the plan has decided (BLG-772) when this is. */
export const DECISIONS = 'decisions';

/**
 * What you picked on the plan: a task (its goal, criteria, what it waits on, where it runs), a
 * milestone (its agent at work, its tasks in order, its gate), or the plan's feed (what it did). Its head (what it is, its state, Close) stays put while the rest scrolls under it.
 */
export function PlanDetails({ view, picked, canStart, onPick, onClose }: { view: PlanView; picked: string; canStart: boolean; onPick: (id: string) => void; onClose: () => void }) {
  const feed = picked === FEED;
  const branch = picked === BRANCH;
  const decided = picked === DECISIONS;
  const gate = picked.startsWith('gate:') ? view.milestones.find((m) => `gate:${m.milestone.id}` === picked) : undefined;
  const task = gate || feed || branch || decided ? undefined : view.milestones.flatMap((m) => m.tasks).find((t) => t.task.id === picked);
  const [scrolled, setScrolled] = useState(false);
  const shown = Boolean(feed || branch || decided || gate || task);
  // Another pick starts at its top (the body is keyed by it).
  useEffect(() => setScrolled(false), [picked]);
  // Esc closes it, unless you're typing or a sheet is open (those take Esc first).
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : undefined;
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[role="dialog"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, onClose]);
  if (!shown) return null;
  return (
    <aside className={p.details} aria-label={feed ? 'What happened' : branch ? 'Where the work goes' : decided ? 'Decisions' : 'Details'}>
      <header className={p.detailsHead} data-scrolled={scrolled ? 'true' : 'false'}>
        <div className={p.detailsHeadText}>{feed ? <FeedHead /> : branch ? <BranchHead view={view} /> : decided ? <DecisionsHead /> : gate ? <GateHead m={gate} /> : <TaskHead t={task!} />}</div>
        <IconButton size="small" icon="x" label="Close" className={p.detailsClose} onClick={onClose} />
      </header>
      <div key={picked} className={p.detailsBody} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
        {feed ? <PlanFeed plan={view.plan} /> : branch ? <BranchFlow view={view} /> : decided ? <PlanDecisions plan={view.plan} onPick={onPick} /> : gate ? <GateDetails plan={view.plan} m={gate} onPick={onPick} /> : <TaskDetails view={view} t={task!} canStart={canStart} />}
      </div>
    </aside>
  );
}

function FeedHead() {
  return (
    <>
      <div className={p.detailsKind}>Plan</div>
      <h3 className={p.detailsTitle}>What happened</h3>
    </>
  );
}

function DecisionsHead() {
  return (
    <>
      <div className={p.detailsKind}>Plan</div>
      <h3 className={p.detailsTitle}>Decisions</h3>
      <p className={p.muted}>What the plan has decided along the way. A decision that replaced another is kept, crossed out.</p>
    </>
  );
}

/** The plan's decisions, newest first: each one in force, or replaced (and by which), with the tasks still written the old way. */
function PlanDecisions({ plan, onPick }: { plan: Plan; onPick: (id: string) => void }) {
  const body = shownBody(plan);
  const list = [...(body?.decisions ?? [])].reverse();
  if (!list.length) return <p className={p.muted}>No decisions recorded yet. Your agent records them here as you settle things in the conversation.</p>;
  return (
    <ol className={p.decisions}>
      {list.map((d) => {
        const stale = body ? staleTasks(body, d) : [];
        return (
          <li key={d.id} className={cx(p.decision, d.supersededBy && p.decisionOld)}>
            <span className={cx(p.decisionText, 'selectable')}>{d.text}</span>
            {d.supersededBy ? <span className={p.muted}>Replaced by “{body?.decisions?.find((x) => x.id === d.supersededBy)?.text ?? d.supersededBy}”</span> : null}
            {stale.length ? (
              <span className={p.decisionStale}>
                Still written the old way:{' '}
                {stale.map((id, i) => (
                  <button key={id} type="button" className={p.linkButton} onClick={() => onPick(id)}>
                    {i ? ', ' : ''}
                    {taskById(body, id)?.title ?? id}
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function BranchHead({ view }: { view: PlanView }) {
  return (
    <>
      <div className={p.detailsKind}>
        <Icon name="branch" size={12} />
        Plan
      </div>
      <h3 className={p.detailsTitle}>Where the work goes</h3>
      <p className={p.muted}>{view.plan.branch ? `Each milestone merges into ${view.plan.branch} when it passes; at the end, one pull request takes it into main.` : 'Without a branch of its own, each task’s work goes to main on its own.'}</p>
    </>
  );
}

const FLOW_ICON: Record<FlowStep['kind'], IconName> = { main: 'diamond', pr: 'pr', branch: 'branch', milestone: 'flag' };
const FLOW_STATE: Record<FlowStep['state'], string> = { done: 'Done', active: 'Now', waiting: 'Not yet', problem: 'Needs you', later: 'Later' };

/** main ← the pull request ← the plan's branch ← each milestone, with where each stands. */
function BranchFlow({ view }: { view: PlanView }) {
  const steps = branchFlow(view);
  return (
    <ol className={p.flow} aria-label="Where the work goes">
      {steps.map((s) => (
        <li key={s.id} className={p.flowStep} data-state={s.state} data-kind={s.kind}>
          <span className={p.flowMark} aria-hidden="true">
            <Icon name={s.state === 'done' ? 'check' : s.state === 'problem' ? 'alert' : FLOW_ICON[s.kind]} size={11} />
          </span>
          <span className={p.flowText}>
            <span className={p.flowLabel}>
              {s.kind === 'branch' || s.kind === 'main' ? <code>{s.label}</code> : s.label}
              <span className={p.flowState}>{FLOW_STATE[s.state]}</span>
            </span>
            <span className={p.flowDetail}>{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function TaskHead({ t }: { t: TaskView }) {
  // Its state in words, with what it's doing now (the step and its time, a stall, a usage limit).
  const now = useCardClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
  return (
    <>
      <div className={p.detailsKind}>
        <TaskStateIcon state={t.state} size={13} />
        {t.issue?.key ?? 'Task'}
        {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
      </div>
      <h3 className={p.detailsTitle}>{t.task.title}</h3>
      <div className={p.detailsRow}>
        <TonePill tone={info.tone} live={t.state === 'running'}>
          {info.label}
        </TonePill>
        {t.forYou ? <span className={p.muted}>For you</span> : null}
      </div>
      {info.sub && t.pulse ? <p className={p.detailsStep}>{t.pulse.kind === 'working' || t.pulse.kind === 'command' ? `Now: ${info.sub}` : info.sub}</p> : t.step && t.state === 'running' ? <p className={p.detailsStep}>Now: {t.step}</p> : null}
      {t.waiting?.length ? (
        <p className={p.detailsWaiting}>
          <WaitingLine waiting={t.waiting} each />
        </p>
      ) : null}
    </>
  );
}

function TaskDetails({ view, t, canStart }: { view: PlanView; t: TaskView; canStart: boolean }) {
  const { api, act, openTask, openWorktree } = usePlanActions();
  const all = view.milestones.flatMap((m) => m.tasks);
  // Its Claude stopped without finishing: one click wakes it with what it missed.
  const canResume = Boolean(t.worktree) && (t.state === 'idle' || t.state === 'stalled');
  // The board's checklist when it has one (ticked, or explained with its reason: deferred, not done), else the plan's.
  const onBoard = criteria(t.issue?.brief.acceptance);
  const checks: readonly Criterion[] = onBoard.length ? onBoard : t.task.acceptance.map((text) => ({ text, state: 'open' as const }));
  const startWith = useStartWith();
  const mine = useMyAgent();
  // Its own agent, else the plan's: who Start uses. The ▾ (BLG-506): another, this start only.
  const own = t.issue?.agent ?? view.plan.agent;
  const startIt = (agent?: AgentRef): void => void act(() => api.startTask(view.plan.id, t.task.id, agent));
  return (
    <>
      {t.why && (t.state === 'blocked' || t.state === 'later') ? <p className={p.muted}>{t.why}</p> : null}
      <div className={p.detailsActions}>
        {canStart && t.forYou ? (
          <Button size="small" variant="primary" icon="hand" onClick={() => openDecision()}>
            Decide…
          </Button>
        ) : canStart ? (
          <SplitButton label="Start with another agent" items={startWith(own, (a) => startIt(a ?? (own ? mine : undefined)))}>
            <Button size="small" variant="primary" icon="play" onClick={() => startIt()}>
              Start
            </Button>
          </SplitButton>
        ) : null}
        {canResume ? (
          <Button size="small" variant="primary" icon="play" onClick={() => void act(() => api.resumeTask(view.plan.id, t.task.id))}>
            Resume
          </Button>
        ) : null}
        {t.worktree ? (
          // Its chat, one click away (with its news); its Claude asking you: answering is this click.
          <Button size="small" icon={t.state === 'asking' ? 'chat' : 'branch'} variant={t.state === 'asking' ? 'primary' : 'plain'} onClick={() => openWorktree(t.worktree!)}>
            {t.state === 'asking' ? 'Answer' : canResume ? 'Open Chat' : 'Open Worktree'}
            <TaskChatMark worktree={t.worktree} />
          </Button>
        ) : null}
        {t.issue ? (
          <Button size="small" variant="quiet" onClick={() => openTask(t.issue!.id)}>
            Open Task
          </Button>
        ) : null}
      </div>
      {t.task.goal ? (
        <section className={p.detailsSection}>
          <h4>Goal</h4>
          <Markdown text={t.task.goal} />
        </section>
      ) : null}
      {checks.length ? (
        <section className={p.detailsSection} aria-label="Done when">
          <h4>Done when</h4>
          <ul className={p.checks}>
            {checks.map((c, i) => {
              const explained = c.state === 'deferred' || c.state === 'not_done';
              return (
                <li key={i} className={cx(c.state === 'done' && p.checkDone, explained && p.checkExplained)} data-state={c.state}>
                  <span className={p.checkBox} aria-hidden="true">
                    {explained ? <Icon name={c.state === 'deferred' ? 'clock' : 'minus'} size={9} /> : null}
                  </span>
                  <span>
                    {c.text}
                    {explained ? (
                      <span className={p.checkReason}>
                        {c.state === 'deferred' ? 'Deferred' : 'Not done'} · {c.reason}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {t.task.blockedBy.length ? (
        <section className={p.detailsSection}>
          <h4>Waits on</h4>
          <ul className={p.plainList}>
            {t.task.blockedBy.map((b) => {
              const other = all.find((x) => x.task.id === b);
              return (
                <li key={b}>
                  {other ? <TaskStateIcon state={other.state} size={12} /> : null}
                  {other?.task.title ?? b}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {t.task.touches?.length ? (
        <section className={p.detailsSection}>
          <h4>Changes</h4>
          <div className={p.touches}>
            {t.task.touches.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </div>
        </section>
      ) : null}
      {t.issue && taskProof(t.issue).length ? (
        <section className={p.detailsSection} aria-label="Proof">
          <h4>Proof</h4>
          <ProofItems issue={t.issue} readOnly />
        </section>
      ) : null}
      {t.task.context ? (
        <section className={p.detailsSection}>
          <h4>Context</h4>
          <Markdown text={t.task.context} />
        </section>
      ) : null}
    </>
  );
}

function GateHead({ m }: { m: MilestoneView }) {
  const info = MILESTONE_STATE[m.state];
  return (
    <>
      <div className={p.detailsKind}>Milestone {m.index + 1}</div>
      <h3 className={p.detailsTitle}>{m.milestone.title}</h3>
      <div className={p.detailsRow}>
        <TonePill tone={info.tone} live={m.state === 'checking' || m.state === 'running'}>
          {info.label}
        </TonePill>
        <span className={p.muted}>
          {m.finished}/{m.total} tasks finished
        </span>
      </div>
    </>
  );
}

function GateDetails({ plan, m, onPick }: { plan: Plan; m: MilestoneView; onPick: (id: string) => void }) {
  const { api, act, openWorktree } = usePlanActions();
  const check = m.run.check;
  const yours = plan.body && !plan.draft && (m.state === 'gate' || m.state === 'checking' || m.state === 'failed');
  // Its checker's conversation (folded into the plan, off the sidebar): watched live, or read once it said.
  const checker = useCheckerChat(m);
  const openChecker = checker ? (
    <Button size="small" icon="eye" variant={m.state === 'checking' ? 'plain' : 'quiet'} onClick={() => openWorktree(checker)}>
      {m.state === 'checking' ? 'Watch the Check' : 'Open the Check'}
      <TaskChatMark worktree={checker} />
    </Button>
  ) : null;
  const conflict = m.merging?.conflict;
  const failed = m.run.mergeFailed;
  return (
    <>
      {m.state === 'merging' ? (
        <section className={p.detailsSection} aria-label="Merging">
          <h4>{conflict ? (conflict.stuck ? 'Merge conflict: needs you' : 'Merge conflict: your agent is fixing it') : `Merging into ${plan.branch ?? 'the plan’s branch'}`}</h4>
          {conflict ? (
            <>
              <p className={p.muted}>
                Merging {conflict.key ?? conflict.merging} into {plan.branch}. {conflict.stuck ? 'Your agent couldn’t fix it: ask it again, or fix the files yourself in their folder (Beluga commits the merge once no conflict markers are left).' : 'The milestone passes once it’s fixed.'}
              </p>
              <ul className={p.plainList} aria-label="Conflicted files">
                {conflict.files.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              <div className={p.detailsActions}>
                {conflict.stuck ? (
                  <Button size="small" variant="primary" icon="claude" onClick={() => void act(() => api.retryConflicts(plan.id), 'Your agent is on the conflict again')}>
                    Ask Claude Again
                  </Button>
                ) : null}
                <Button size="small" icon="folder" onClick={() => void act(() => api.showConflict(plan.id))}>
                  {revealLabel()}
                </Button>
              </div>
            </>
          ) : (
            <p className={p.muted}>Its tasks’ work is going into the plan’s branch now; it passes once that’s in.</p>
          )}
        </section>
      ) : null}
      {failed && !m.run.passedAt && m.state !== 'merging' ? (
        <section className={p.detailsSection} aria-label="Couldn’t merge">
          <h4>Couldn’t merge into {plan.branch ?? 'the plan’s branch'}</h4>
          <p className={p.muted}>{failed.reason}</p>
          <p className={p.muted}>Fix that, then pass it again: nothing was merged.</p>
        </section>
      ) : null}
      {yours ? (
        <div className={p.detailsActions}>
          <Button size="small" variant="primary" icon="check" onClick={() => void act(() => api.pass(plan.id, m.milestone.id))}>
            {m.state === 'failed' || m.state === 'checking' ? 'Pass Anyway' : failed ? 'Pass Again' : 'Pass Milestone'}
          </Button>
          <Button size="small" onClick={() => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: m.milestone.id })}>
            Not Yet…
          </Button>
          {m.state === 'checking' || m.state === 'failed' ? (
            <Button size="small" variant="quiet" onClick={() => void act(() => api.recheck(plan.id, m.milestone.id))}>
              Check Again
            </Button>
          ) : null}
          {openChecker}
        </div>
      ) : openChecker ? (
        <div className={p.detailsActions}>{openChecker}</div>
      ) : null}
      {m.state !== 'draft' && m.state !== 'later' ? <MilestoneAgentSection m={m} /> : null}
      <MilestoneTasks m={m} onPick={onPick} />
      {m.milestone.goal ? (
        <section className={p.detailsSection}>
          <h4>Goal</h4>
          <Markdown text={m.milestone.goal} />
        </section>
      ) : null}
      <section className={p.detailsSection}>
        <h4>Passes when</h4>
        {m.milestone.criteria.length ? (
          <ul className={p.checks}>
            {m.milestone.criteria.map((c) => (
              <li key={c} className={m.state === 'passed' ? p.checkDone : undefined}>
                <span className={p.checkBox} aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
        ) : (
          <p className={p.muted}>No criteria: you pass it when its tasks are done.</p>
        )}
      </section>
      {check ? (
        <section className={p.detailsSection}>
          <h4>{check.verdict === 'pass' ? 'The agent’s check: passes' : 'The agent’s check: not yet'}</h4>
          <Markdown text={check.notes} />
        </section>
      ) : null}
    </>
  );
}

/** Its one Claude: what it's doing right now (even between tasks), and its chat a click away. */
function MilestoneAgentSection({ m }: { m: MilestoneView }) {
  const { openWorktree } = usePlanActions();
  const now = useClock(m.agentNow?.kind === 'working' || m.agentNow?.kind === 'command');
  const words = milestoneNowWords(m, now);
  if (!m.agent) return null;
  const left = m.tasks.some((t) => t.worktree === m.agent!.worktree && !FINISHED.has(t.state));
  return (
    <section className={p.detailsSection} aria-label="Its agent">
      <h4>Its agent</h4>
      <p className={cx(p.agentNowLine, words && p[`tone_${words.tone}`])} data-agent-now={words ? 'live' : 'quiet'}>
        {words ? words.tone === 'claude' ? <LiveDot /> : <Icon name="chat" size={12} /> : null}
        <span>
          {words ? words.label : left ? 'Not at work right now' : 'Done with its tasks'}
          {words?.sub ? <span className={p.muted}> · {words.sub}</span> : null}
        </span>
      </p>
      <div className={p.detailsActions}>
        <Button size="small" icon="chat" variant={words?.tone === 'warn' ? 'primary' : 'plain'} onClick={() => openWorktree(m.agent!.worktree)}>
          {words?.tone === 'warn' ? 'Answer' : 'Open Agent’s Chat'}
          <TaskChatMark worktree={m.agent.worktree} />
        </Button>
      </div>
    </section>
  );
}

/** Its tasks in the order its agent does them, each where it stands: click one for its details. */
function MilestoneTasks({ m, onPick }: { m: MilestoneView; onPick: (id: string) => void }) {
  const tasks = taskOrder(m);
  if (!tasks.length) return null;
  return (
    <section className={p.detailsSection} aria-label="Its tasks">
      <h4>Tasks, in order</h4>
      <ul className={p.msTaskList}>
        {tasks.map((t) => (
          <li key={t.task.id}>
            <button type="button" className={p.msTaskRow} data-state={t.state} onClick={() => onPick(t.task.id)}>
              <TaskStateIcon state={t.state} size={12} />
              {t.issue?.key ? <span className={p.taskKey}>{t.issue.key}</span> : null}
              <span className={p.msTaskTitle}>{t.task.title}</span>
              <span className={p.msTaskState}>{t.queued ? 'Next up' : taskWords(t, 0).label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
