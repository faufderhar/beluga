import { Fragment, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Plan } from '@beluga/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@beluga/core/plans/progress.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { MILESTONE_STATE, TASK_STATE, changeMarks, milestoneLabel, milestoneRows, taskWords } from './plans-model.js';
import { TaskChatMark, TaskStateIcon } from './marks.js';
import { openDecision } from './plan-ask-model.js';
import { useCardClock, useCheckerChat, usePlanActions } from './use-plans.js';
import { useStartWith } from '../components/agent-options.js';
import { useMyAgent } from '../lib/agent-words.js';
import type { AgentRef } from '@beluga/protocol.js';

/** A change you make to a plan (as the API takes it). */
type PlanOp = Parameters<ReturnType<typeof usePlanActions>['api']['edit']>[1][number];
import p from './plans.module.css';

/**
 * A plan as an outline: milestones in order, each with what passes it and its tasks. Names change
 * in place (double-click); a task's ⋯ (or right-click) moves it, starts it or takes it out. On an
 * approved plan your changes apply at once; on a draft they stay in the draft.
 */
export function PlanOutline({ view, keys, selected, onSelect, startable }: { view: PlanView; keys: ReadonlyMap<string, string>; selected?: string; onSelect: (id: string) => void; startable: ReadonlySet<string> }) {
  const marks = changeMarks(view.plan);
  // Milestones that run side by side share a row; a row starts once what it waits on has passed.
  const rows = milestoneRows(view.body ?? view.plan.draft);
  return (
    <div className={p.outline}>
      {view.body?.goal ? <p className={p.outlineGoal}>{view.body.goal}</p> : null}
      {rows.map((row, i) => {
        const ms = row.flatMap((id) => view.milestones.find((m) => m.milestone.id === id) ?? []);
        const after = [...new Set(ms.flatMap((m) => m.dependsOn))].flatMap((id) => view.milestones.find((m) => m.milestone.id === id) ?? []);
        return (
          <Fragment key={row.join()}>
            {i > 0 ? (
              <div className={p.oAfter} aria-label={`Then, once ${after.map((m) => m.milestone.title).join(' and ')} ${after.length === 1 ? 'passes' : 'pass'}`}>
                <Icon name="arrowRight" size={11} className={p.oAfterArrow} />
                {after.length ? `Once ${after.map((m) => `“${m.milestone.title}”`).join(' and ')} ${after.length === 1 ? 'passes' : 'pass'}` : 'Then'}
              </div>
            ) : null}
            <div className={p.oRow} data-parallel={ms.length > 1 ? ms.length : undefined} style={{ '--cols': ms.length } as React.CSSProperties}>
              {ms.map((m) => (
                <Milestone key={m.milestone.id} view={view} plan={view.plan} m={m} keys={keys} marks={marks} selected={selected} onSelect={onSelect} startable={startable} />
              ))}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function Milestone({ view, plan, m, keys, marks, selected, onSelect, startable }: { view: PlanView; plan: Plan; m: MilestoneView; keys: ReadonlyMap<string, string>; marks: ReadonlyMap<string, string>; selected?: string; onSelect: (id: string) => void; startable: ReadonlySet<string> }) {
  const { api, act, openWorktree } = usePlanActions();
  const edit = (ops: PlanOp[]): void => void act(() => api.edit(plan.id, ops));
  const info = MILESTONE_STATE[m.state];
  const checker = useCheckerChat(m);
  const menu: ActionItem[] = [
    ...(checker ? [{ label: m.state === 'checking' ? 'Watch the Check' : 'Open the Check', onSelect: () => openWorktree(checker) }] : []),
    { label: 'Runs', submenu: AUTONOMIES.map((a) => ({ label: AUTONOMY_INFO[a].label, hint: AUTONOMY_INFO[a].hint, checked: m.autonomy === a, onSelect: () => void act(() => api.setAutonomy(plan.id, a, m.milestone.id)) })), onSelect: () => undefined },
    ...(m.state === 'gate' || m.state === 'failed' || m.state === 'checking' ? [{ label: 'Not Yet…', onSelect: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: m.milestone.id }) }] : []),
    { label: 'Remove Milestone', danger: true, separate: true, onSelect: () => openSheet({ kind: 'confirm', title: `Remove “${m.milestone.title}”?`, message: plan.body ? 'Its tasks are taken out of the plan (unfinished ones are canceled on the board).' : 'Its tasks go with it.', confirm: 'Remove', destructive: true, run: () => edit([{ op: 'remove_milestone', id: m.milestone.id }]) }) },
  ];
  return (
    <section className={cx(p.oMilestone, p[`ms_${m.state}`])} aria-label={m.milestone.title}>
      <header className={p.oHead}>
        <span className={p.msIndex}>{m.state === 'passed' ? <Icon name="check" size={11} /> : m.index + 1}</span>
        <Rename value={m.milestone.title} className={p.oTitle} label="Milestone name" onDone={(title) => edit([{ op: 'update_milestone', id: m.milestone.id, title }])} />
        <span className={cx(p.msState, p[`tone_${info.tone}`])}>{milestoneLabel(view, m)}</span>
        {m.autonomy !== plan.autonomy ? <span className={p.msAuto}>{AUTONOMY_INFO[m.autonomy].label}</span> : null}
        <span className={p.grow} />
        <span className={p.msCount}>
          {m.state === 'draft' ? `${m.milestone.tasks.length} tasks` : `${m.finished}/${m.total}`}
        </span>
        <ActionsDropdown items={menu}>
          <IconButton size="small" icon="more" label={`${m.milestone.title} Options`} />
        </ActionsDropdown>
      </header>
      {m.milestone.goal ? <p className={p.oGoal}>{m.milestone.goal}</p> : null}
      <ul className={p.oTasks}>
        {m.milestone.tasks.map((task) => {
          const t = m.tasks.find((x) => x.task.id === task.id)!;
          return <TaskRow key={task.id} plan={plan} t={t} k={keys.get(task.id)} mark={marks.get(task.id)} selected={selected === task.id} onSelect={() => onSelect(task.id)} canStart={startable.has(task.id)} />;
        })}
      </ul>
      {m.milestone.criteria.length ? (
        <button type="button" className={cx(p.oGate, selected === `gate:${m.milestone.id}` && p.oGateSelected)} onClick={() => onSelect(`gate:${m.milestone.id}`)}>
          <Icon name="flag" size={12} />
          <span className={p.oGateLabel}>Passes when</span>
          <span className={p.oCriteria}>{m.milestone.criteria.join(' · ')}</span>
          {m.run.check ? <span className={cx(p.gateCheck, m.run.check.verdict === 'pass' ? p.tone_ok : p.tone_error)}>{m.run.check.verdict === 'pass' ? 'Agent: passes' : 'Agent: not yet'}</span> : null}
        </button>
      ) : null}
    </section>
  );
}

function TaskRow({ plan, t, k, mark, selected, onSelect, canStart }: { plan: Plan; t: TaskView; k?: string; mark?: string; selected: boolean; onSelect: () => void; canStart: boolean }) {
  const { api, act, openTask, openWorktree } = usePlanActions();
  const body = plan.draft ?? plan.body;
  const edit = (ops: PlanOp[]): void => void act(() => api.edit(plan.id, ops));
  const now = useCardClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
  const others = (body?.milestones ?? []).filter((m) => m.id !== t.milestoneId);
  const startWith = useStartWith();
  const mine = useMyAgent();
  // Its own agent, else the plan's: who Start uses. Start with ▸ (BLG-506): another, this start only.
  const own = t.issue?.agent ?? plan.agent;
  const startIt = (agent?: AgentRef): void => void act(() => api.startTask(plan.id, t.task.id, agent));
  const menu = (): ActionItem[] => [
    ...(canStart
      ? t.forYou
        ? [{ label: 'Decide…', icon: 'hand' as const, onSelect: openDecision }]
        : [
            { label: 'Start', icon: 'play' as const, onSelect: () => startIt() },
            { label: 'Start with', icon: 'play' as const, submenu: startWith(own, (a) => startIt(a ?? (own ? mine : undefined)), ''), onSelect: () => undefined },
          ]
      : []),
    ...(t.worktree ? [{ label: 'Open Worktree', onSelect: () => openWorktree(t.worktree!) }] : []),
    ...(t.issue ? [{ label: 'Open Task', onSelect: () => openTask(t.issue!.id) }] : []),
    ...(others.length ? [{ label: 'Move to', separate: true, submenu: others.map((m) => ({ label: m.title, onSelect: () => edit([{ op: 'move_task', id: t.task.id, milestone: m.id }]) })), onSelect: () => undefined }] : []),
    { label: t.task.assignee === 'me' ? 'Give It to the Agent' : 'I’ll Do It Myself', onSelect: () => edit([{ op: 'update_task', id: t.task.id, patch: { assignee: t.task.assignee === 'me' ? 'claude' : 'me' } }]) },
    { label: 'Take Out of the Plan', danger: true, separate: true, onSelect: () => edit([{ op: 'remove_task', id: t.task.id }]) },
  ];
  return (
    <ActionsContext items={menu}>
      <li className={cx(p.oTask, selected && p.oTaskSelected, p[`task_${t.state}`])}>
        <div role="button" tabIndex={0} className={p.oTaskMain} onClick={onSelect} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())} aria-label={`${t.task.title}, ${info.label}`}>
          <TaskStateIcon state={t.state} />
          {k ? <span className={p.taskKey}>{k}</span> : null}
          <Rename value={t.task.title} className={p.oTaskTitle} label="Task name" onDone={(title) => edit([{ op: 'update_task', id: t.task.id, patch: { title } }])} />
          {mark ? <span className={p.markChip}>{mark === 'added' ? 'New' : 'Changed'}</span> : null}
          {t.task.parent ? <span className={p.muted}>sub-task</span> : null}
          <TaskChatMark {...(t.worktree ? { worktree: t.worktree } : {})} />
        </div>
        <span className={p.oTaskMeta}>
          {info.sub && (t.pulse || t.state === 'running') ? <span className={p.oStep}>{info.sub}</span> : info.sub && t.state !== 'later' ? <span className={p.muted}>{info.sub}</span> : null}
          {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
          {t.forYou ? <Icon name="person" size={12} className={p.forYou} /> : null}
          {canStart ? (
            <button type="button" className={p.startButton} onClick={() => (t.forYou ? openDecision() : void act(() => api.startTask(plan.id, t.task.id)))}>
              <Icon name={t.forYou ? 'hand' : 'play'} size={9} />
              {t.forYou ? 'Decide…' : 'Start'}
            </button>
          ) : (
            <span className={cx(p.taskState, p[`tone_${info.tone}`])}>{info.label}</span>
          )}
        </span>
      </li>
    </ActionsContext>
  );
}

/** A name that changes in place: double-click, type, Return (Esc puts it back). */
function Rename({ value, onDone, className, label }: { value: string; onDone: (next: string) => void; className?: string; label: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) {
    return (
      <span
        className={className}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(value);
          setEditing(true);
        }}
        title="Double-click to rename"
      >
        {value}
      </span>
    );
  }
  const finish = (save: boolean): void => {
    setEditing(false);
    if (save && text.trim() && text.trim() !== value) onDone(text.trim());
  };
  return (
    <input
      className={cx(className, p.renameInput, 'selectable')}
      aria-label={label}
      value={text}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}
