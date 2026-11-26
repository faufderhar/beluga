import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, DEFAULT_AUTONOMY, FULL_AUTOPILOT_INFO, TESTS_AT, TESTS_AT_INFO, type TestsAt } from '@beluga/core/plans/model.js';
import { Field, FormSheet, Popup, TextArea } from '../components/FormSheet.js';
import { Checkbox } from '../components/Alert.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { RunsOnRow } from '../chat/RunsOn.js';
import { myRuntime } from '../chat/ModelPicker.js';
import { useMyAgent } from '../lib/agent-words.js';
import { AgentRoles, ONE_AGENT, type RoleChoice, rolesInput } from './AgentRoles.js';
import { sendToComputer, useStartDeps } from '../machines/start-there.js';
import { useTasksPrefs } from '../tasks/use-tasks.js';
import { modeChange } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';
import { chordLabel } from '../lib/shortcuts-model.js';
import { useActions } from '../lib/actions.js';

const AUTONOMY_ICON: Record<Autonomy, IconName> = { step: 'hand', gated: 'flag', autopilot: 'wand' };

/**
 * A new plan: what it's for (Claude plans from it, reading the code), how far it runs on its own
 * (Autopilot can go all the way: Full Autopilot, BLG-981), and who plans, builds and checks it, as
 * one sentence (BLG-982; your default agent for all three unless you pick others). Opened from a
 * project it's that project's (no picker).
 */
export function NewPlanSheet({ projectId, close }: { projectId?: string; close: () => void }) {
  const startDeps = useStartDeps();
  const prefsNow = () => startDeps.home.store.getState().prefs;
  const prefs = useTasksPrefs();
  const all = useApp((s) => s.projects);
  const projects = useMemo(() => all.filter((p) => p.root && !p.error), [all]);
  const { api, act } = usePlanActions();
  const actions = useActions();
  const [goal, setGoal] = useState('');
  const known = projectId !== undefined && projects.some((p) => p.id === projectId);
  const [project, setProject] = useState((known ? projectId : projects.some((p) => p.id === prefs.project) ? prefs.project : projects[0]?.id) ?? '');
  const [autonomy, setAutonomy] = useState<Autonomy>(DEFAULT_AUTONOMY);
  const [full, setFull] = useState(false);
  const [testsAt, setTestsAt] = useState<TestsAt>('milestone');
  const runtimes = useApp((s) => s.runtimes);
  const mine = useMyAgent();
  const [roles, setRoles] = useState<RoleChoice>(ONE_AGENT);
  if (!projects.length) {
    // The sidebar's own "Add a Project…", one click away (every OS has it; not every one has a File menu).
    const addProject = (): void => {
      close();
      actions.run({ type: 'add_project' });
    };
    return <FormSheet title="New Plan" intro="Plans belong to a project: a folder with your code. Add one first." submitLabel="Add a Project…" onSubmit={addProject} onCancel={close} />;
  }
  const name = projects.find((p) => p.id === project)?.name;
  return (
    <FormSheet
      title={name ? `Plan in ${name}` : 'New Plan'}
      icon="flag"
      intro="Say what you want built. Your agent reads the code and cuts it into milestones and tasks; you talk it through, and nothing reaches the board until you approve."
      submitLabel="Plan with Your Agent"
      width={600}
      canSubmit={Boolean(goal.trim() && project)}
      onCancel={close}
      onSubmit={async () => {
        const agents = rolesInput(roles, runtimes, mine);
        const input = { goal: goal.trim(), autonomy, testsAt, ...agents, ...(autonomy === 'autopilot' && full ? { fullAuto: true } : {}) };
        // Runs on one of your computers (BLG-788): the plan is made there and opens at once; held, the sheet stays.
        const sent = sendToComputer(startDeps, project, (agents.planner ?? agents.agent)?.runtime ?? myRuntime(prefsNow()), { kind: 'plan', input });
        if (sent === 'held') return;
        close();
        if (sent === 'sent') return;
        await act(() => api.create({ projectId: project, ...input }));
      }}
    >
      <div className={p.newPlan}>
        <label className={p.newPlanLabel} htmlFor="plan-goal">
          Goal
        </label>
        <GoalBox value={goal} onChange={setGoal} />
        <div className={p.newPlanHint}>What it’s for and what done looks like. {chordLabel('Cmd+Enter')} starts planning.</div>
        {known ? null : (
          <div className={p.newPlanRow}>
            <span className={p.newPlanLabel}>Project</span>
            <Popup label="Project" value={project} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={setProject} />
          </div>
        )}
        {/* Where it runs (BLG-786): the plan and its worktrees. Only with a computer paired. */}
        <RunsOnRow project={project} className={p.newPlanRow} labelClassName={p.newPlanLabel} />
        <div className={p.newPlanLabel} id="plan-runs">
          How it runs
        </div>
        <AutonomyCards value={autonomy} onChange={setAutonomy} />
        {autonomy === 'autopilot' ? <FullAutoBox checked={full} onChange={setFull} /> : null}
        <div className={p.newPlanLabel}>Agents</div>
        <AgentRoles value={roles} onChange={setRoles} />
        <div className={p.newPlanRow}>
          <span className={p.newPlanLabel}>When to run tests</span>
          <Popup label="When to run tests" value={testsAt} options={TESTS_AT.map((t) => ({ value: t, label: TESTS_AT_INFO[t].label }))} onChange={setTestsAt} />
        </div>
        <div className={p.newPlanHint}>{TESTS_AT_INFO[testsAt].hint}.</div>
      </div>
    </FormSheet>
  );
}

/** Autopilot, all the way: nothing waits for you (BLG-981). Under the cards, only with Autopilot picked. */
export function FullAutoBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={p.fullAuto}>
      <Checkbox checked={checked} onChange={onChange} label="Never wait for me" detail="A stand-in agent answers what the plan’s agents would ask you, so it keeps going. A secret, a friend’s request or a task only you can do still waits for you." />
    </div>
  );
}

/** The goal: six lines to start, growing with what you write (to about 60% of the sheet, then it scrolls). */
function GoalBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <TextArea
      ref={ref}
      id="plan-goal"
      className={p.goalBox}
      value={value}
      onChange={onChange}
      rows={6}
      placeholder={'Let customers pay by card: a checkout page, webhooks that never double-charge, and refunds from the admin.\nDone when a test card goes through end to end and a refund shows up in Stripe.'}
      data-autofocus
    />
  );
}

/** Step by Step, Check-ins, Autopilot: three cards you can read without hovering (a radio group; the arrows move). */
export function AutonomyCards({ value, onChange, current }: { value: Autonomy; onChange: (a: Autonomy) => void; current?: Autonomy }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = AUTONOMIES[(AUTONOMIES.indexOf(value) + step + AUTONOMIES.length) % AUTONOMIES.length]!;
    onChange(next);
    refs.current[AUTONOMIES.indexOf(next)]?.focus();
  };
  return (
    <div className={p.modeCards} role="radiogroup" aria-labelledby="plan-runs" onKeyDown={onKeyDown}>
      {AUTONOMIES.map((a, i) => {
        const on = a === value;
        return (
          <button
            key={a}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx(p.modeCard, on && p.modeCardOn)}
            onClick={() => onChange(a)}
          >
            <span className={p.modeIcon} aria-hidden="true">
              <Icon name={AUTONOMY_ICON[a]} size={16} />
            </span>
            <span className={p.modeName}>{AUTONOMY_INFO[a].label}</span>
            <span className={p.modeSummary}>{AUTONOMY_INFO[a].summary}</span>
            {a === current ? <span className={p.modeNow}>Now</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How a running plan runs: the same three cards as a new plan. Picking another one says, in plain
 * words, what changes from now on (and what happens at once); Switch applies it and it's in the feed.
 */
export function PlanModeSheet({ planId, close }: { planId: string; close: () => void }) {
  const plan = usePlans().plans.find((x) => x.id === planId);
  const view = usePlanView(plan);
  const { api, act } = usePlanActions();
  const [mode, setMode] = useState<Autonomy>(plan?.autonomy ?? DEFAULT_AUTONOMY);
  const [full, setFull] = useState(Boolean(plan?.fullAuto));
  if (!plan || !view) return <FormSheet title="How It Runs" intro="This plan is gone." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  const mixed = plan.body?.milestones.some((m) => m.autonomy && m.autonomy !== plan.autonomy);
  const fullNow = mode === 'autopilot' && full;
  const fullChange = fullNow !== Boolean(plan.fullAuto) && mode === plan.autonomy && !mixed ? fullAutoChange(fullNow) : undefined;
  const change = fullChange ?? (mode !== plan.autonomy || mixed ? modeChange(view, mode) : undefined);
  const nowLabel = plan.fullAuto ? FULL_AUTOPILOT_INFO.label : AUTONOMY_INFO[plan.autonomy].label;
  return (
    <FormSheet
      title="How It Runs"
      icon="flag"
      intro={`“${plan.body?.title ?? plan.draft?.title ?? 'This plan'}” runs on ${nowLabel} now. Pick how it runs from here on.`}
      submitLabel={change?.title ?? 'Switch'}
      canSubmit={Boolean(change)}
      width={600}
      onCancel={close}
      onSubmit={async () => {
        close();
        if (fullNow) await act(() => api.setFullAuto(plan.id, true), `Runs on ${FULL_AUTOPILOT_INFO.label} now`);
        else if (plan.fullAuto && mode === 'autopilot') await act(() => api.setFullAuto(plan.id, false), 'Runs on Autopilot now: questions come to you again, for as long as Settings › Agent › Autopilot says');
        else await act(() => api.setAutonomy(plan.id, mode), `Runs on ${AUTONOMY_INFO[mode].label} now`);
      }}
    >
      <div className={p.newPlan}>
        <div className={p.newPlanLabel} id="plan-runs">
          How it runs
        </div>
        <AutonomyCards value={mode} onChange={setMode} current={plan.autonomy} />
        {mode === 'autopilot' ? <FullAutoBox checked={full} onChange={setFull} /> : null}
        {change ? (
          <div className={p.modeConfirm} role="status" aria-label="What changes">
            <p>{change.from}</p>
            {change.now ? <p className={p.modeConfirmNow}>{change.now}</p> : null}
          </div>
        ) : (
          <p className={p.newPlanHint}>{AUTONOMY_INFO[plan.autonomy].hint}.</p>
        )}
      </div>
    </FormSheet>
  );
}

/** Turning Full Autopilot on or off on a plan already on Autopilot, in the words modeChange uses. */
export function fullAutoChange(on: boolean): { readonly title: string; readonly from: string; readonly now?: string } {
  return on
    ? { title: 'Never Wait for Me', from: 'From now on, what the plan’s agents would ask you a stand-in agent answers, and the plan carries on. A secret or a friend’s request still waits for you.', now: 'Anything waiting on you now is answered in a moment.' }
    : { title: 'Answer Myself Again', from: 'From now on, what the plan’s agents ask waits for you again. The plan stays on Autopilot.' };
}

/** How you like plans cut: added to Claude's planning instructions every time. */
export function PlanStyleSheet({ close }: { close: () => void }) {
  const style = usePlans().style;
  const { api, act } = usePlanActions();
  const [text, setText] = useState(style);
  return (
    <FormSheet
      title="Planning Style"
      icon="flag"
      intro="How you like plans cut: task size, when to add a review, what every milestone must prove. Your agent follows it whenever it plans."
      submitLabel="Save"
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.setStyle(text), 'Planning style saved');
      }}
    >
      <Field label="Style" htmlFor="plan-style" hint="Markdown. Kept in ~/.beluga/planning.md.">
        <TextArea id="plan-style" value={text} onChange={setText} rows={9} placeholder={'- Tasks are at most a day of work\n- Every milestone ends with screenshots of what changed\n- Tests before code; no task without them'} data-autofocus />
      </Field>
    </FormSheet>
  );
}

/** Not yet: what a milestone still needs. The plan's head Claude adds the work for it. */
export function SendBackSheet({ planId, milestone, close }: { planId: string; milestone: string; close: () => void }) {
  const title = usePlans().plans.find((p) => p.id === planId)?.body?.milestones.find((m) => m.id === milestone)?.title ?? 'this milestone';
  const { api, act } = usePlanActions();
  const [note, setNote] = useState('');
  return (
    <FormSheet
      title={`Not Yet: ${title}`}
      icon="flag"
      intro="Say what’s missing. Your agent adds the tasks that fix it to this milestone, for you to approve."
      submitLabel="Send to Your Agent"
      canSubmit={Boolean(note.trim())}
      onCancel={close}
      onSubmit={async () => {
        close();
        await act(() => api.sendBack(planId, milestone, note.trim()));
      }}
    >
      <Field label="What’s missing" htmlFor="plan-note">
        <TextArea id="plan-note" value={note} onChange={setNote} rows={4} placeholder="Refunds work, but the admin doesn’t show partial refunds yet." data-autofocus />
      </Field>
    </FormSheet>
  );
}
