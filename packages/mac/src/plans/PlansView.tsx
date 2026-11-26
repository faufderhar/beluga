import { RemoteList } from '../machines/RemoteList.js';
import { remotePlans } from '../machines/remote-work.js';
import { useRemoteSources } from '../machines/use-remote.js';
import { useEffect, useMemo } from 'react';
import type { Plan } from '@beluga/core/plans/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { currentSheet, openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago, projectToShow } from '../tasks/tasks-model.js';
import { useBoard, useTasksPrefs } from '../tasks/use-tasks.js';
import { MilestoneBar, TonePill } from './marks.js';
import { bars, nextWords, planStatus, plansOf, titleOf } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';
import v from './PlansView.module.css';
import { SharedPlansList } from '../team/SharedPlans.js';
import { isShortcut } from '../lib/shortcuts.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { NoProjects } from '../work/NoProjects.js';

/**
 * Plans: one project's at a time (the one you're in, like Tasks). Each is a row with how far it
 * got and what it waits for; New Plan (⌘N) starts one with Claude.
 */
export function PlansView() {
  const state = usePlans();
  const board = useBoard();
  const prefs = useTasksPrefs();
  const view = useApp((s) => s.view);
  const all = useApp((s) => s.projects);
  const projects = useMemo(() => all.filter((x) => x.root && !x.error), [all]);
  const { openList } = usePlanActions();
  const project = projectToShow(board, projects, view.kind === 'plans' ? view.projectId : undefined, prefs.project);
  const here = projects.find((x) => x.id === project);
  const plans = plansOf(state, project);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || currentSheet()) return;
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]');
      if (!typing && isShortcut('page-new', e)) {
        e.preventDefault();
        e.stopPropagation();
        openSheet({ kind: 'new_plan', ...(project ? { projectId: project } : {}) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [project]);

  if (!state.enabled) return <Empty icon="flag" title="Plans need the Beluga app" detail="Open the Beluga app to plan big work with your agent." />;
  if (!here) return <NoProjects icon="flag" detail="Plans belong to a project. Add one to plan its work here." />;
  return (
    <div className={p.list}>
      <div className={p.listBar}>
        <span className={v.caption}>
          Plans in
        </span>
        <PickMenu<string> label="Project" choices={projects.map((x) => ({ value: x.id, label: x.name, mark: <ProjectIcon id={x.id} name={x.name} size={16} /> }))} chosen={[here.id]} onPick={(id) => openList(id)}>
          <button type="button" className={cx(p.projectSwitch, v.switch)} aria-label={`Project: ${here.name}`} title="Switch Project">
            <ProjectIcon id={here.id} name={here.name} size={18} />
            <span>{here.name}</span>
            <Icon name="chevronDown" size={11} />
          </button>
        </PickMenu>
        <span className={p.grow} />
        <ActionsDropdown items={[{ label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) }]}>
          <IconButton size="small" icon="more" label="Plans Options" />
        </ActionsDropdown>
        <Button variant="primary" size="small" icon="plus" onClick={() => openSheet({ kind: 'new_plan', projectId: here.id })} title={`New Plan${shortcutKeys('page-new') ? ` (${shortcutKeys('page-new')})` : ''}`}>
          New Plan
        </Button>
      </div>
      {plans.length ? (
        <ul className={p.rows} aria-label="Plans">
          {plans.map((plan) => (
            <PlanRow key={plan.id} plan={plan} />
          ))}
        </ul>
      ) : (
        <Empty
          icon="flag"
          mark={<ProjectIcon id={here.id} name={here.name} size={28} />}
          title={`No plans in ${here.name} yet`}
          detail="Say what you want built. Your agent reads the code and cuts it into milestones and tasks that run side by side, each with what proves it’s done. You talk it through; nothing reaches the board until you approve."
          action={
            <EmptyActions>
              <Button size="small" variant="primary" icon="plus" onClick={() => openSheet({ kind: 'new_plan', projectId: here.id })}>
                {`Plan in ${here.name}`}
              </Button>
            </EmptyActions>
          }
        />
      )}
      <SharedPlansList projectId={here.id} />
      {/* The same project's plans on your computers (BLG-785). */}
      <RemotePlans project={here.name} />
    </div>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const view = usePlanView(plan)!;
  const { open } = usePlanActions();
  const status = planStatus(view);
  const next = nextWords(view.next);
  return (
    <li>
      <button type="button" className={p.row} onClick={() => open(plan.id)} aria-label={`${titleOf(plan)}, ${status.label}`}>
        <span className={p.rowMain}>
          <span className={p.rowTitle}>{titleOf(plan)}</span>
          <span className={p.rowSub}>{plan.body ? (next.detail ? `${next.title} · ${next.detail}` : next.title) : `${view.milestones.length} milestones · ${view.total} tasks · draft`}</span>
        </span>
        {view.milestones.length && plan.body ? <MilestoneBar items={bars(view)} /> : null}
        <TonePill tone={status.tone} live={status.tone === 'claude'}>
          {status.label}
        </TonePill>
        <span className={p.rowWhen}>{ago(plan.updatedAt)}</span>
      </button>
    </li>
  );
}

/** The plans of the project of this name on your computers, tagged. */
function RemotePlans({ project }: { project: string }) {
  const sources = useRemoteSources();
  const rows = useMemo(() => remotePlans(sources).filter((t) => t.item.project === project).map((t) => ({ ...t, item: { id: t.item.id, title: t.item.title, sub: t.item.status, page: { kind: 'plan' as const, id: t.item.id } } })), [sources, project]);
  return <RemoteList title="Plans on your computers" rows={rows} />;
}

