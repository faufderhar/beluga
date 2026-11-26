import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, FULL_AUTOPILOT_INFO, MAX_PARALLEL, type Plan, type PlanRole, TESTS_AT, TESTS_AT_INFO, reviewState, shownBody, startsByItself } from '@beluga/core/plans/model.js';
import { type PlanView, tidyOffer } from '@beluga/core/plans/progress.js';
import { CONTINUE_PROMPT, decodeFailure, resetWords } from '@beluga/shared/run-failure.js';
import { formatDuration } from '@beluga/shared/text.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { useNow } from '../chat/Items.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { usePrefs } from '../lib/prefs.js';
import { PLAN_CHAT_TOGGLE } from '../lib/panel.js';
import { OPEN_DECISION } from './plan-ask-model.js';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { taskChatsItem } from '../layout/plan-task-chats.js';
import { Button, Empty, IconButton, Segmented, Tip, Working, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { RunsOnLabel } from '../chat/RunsOn.js';
import { useStartWith } from '../components/agent-options.js';
import { SplitButton } from '../components/SplitButton.js';
import { agentName, useMyAgent } from '../lib/agent-words.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import type { AgentRef } from '@beluga/protocol.js';
import { openSheet } from '../lib/sheets.js';
import { mod, openExternal } from '../lib/system.js';
import { MilestoneBar, PlanPrChip, PlanProgress, Said, TonePill } from './marks.js';
import { PlanChat } from './PlanChat.js';
import { BRANCH, DECISIONS, FEED, PlanDetails } from './PlanDetails.js';
import { PlanOutline } from './PlanOutline.js';
import { ReviewLine } from './ReviewLine.js';
import { CHAT_DEFAULT, DEFAULT_PLAN_LAYOUT, type Display, PLAN_LAYOUT_KEY, type PlanLayout, chatOpen, clampChatWidth, readPlanLayout, setChatOpen } from './plan-layout.js';
import { barColumns, changeWords, headline, nextWords, shipAction, titleOf } from './plans-model.js';
import { useCheckerChat, useConversationLoaded, usePlanActions, usePlanStep, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';
import { TeamReviews, usePlanTeamItems } from '../team/SharedPlans.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { revealLabel } from '../lib/os-words.js';
import { useActions } from '../lib/actions.js';
import { onMachine } from '../machines/pane-model.js';
import { useMoveTo } from './move-to.js';
import { PlanAgentsButton } from './AgentRoles.js';

const PlanCanvas = lazy(() => import('./PlanCanvas.js'));

function readPrefs(): PlanLayout {
  try {
    return readPlanLayout(JSON.parse(localStorage.getItem(PLAN_LAYOUT_KEY) ?? '{}'));
  } catch {
    return DEFAULT_PLAN_LAYOUT;
  }
}

/**
 * A plan's page: what it is and the one thing it waits for, at the top; the plan as a living graph
 * (or an outline) in the middle; and the conversation with Claude beside it, where the plan is
 * talked through and changed. Everything else is a click away (⋯, a task, a gate).
 */
export function PlanPage({ id, task }: { id: string; task?: string }) {
  const plan = usePlans().plans.find((x) => x.id === id);
  const view = usePlanView(plan);
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = useCallback((change: (layout: PlanLayout) => PlanLayout): void => {
    setPrefsState((was) => {
      const next = change(was);
      try {
        localStorage.setItem(PLAN_LAYOUT_KEY, JSON.stringify(next));
      } catch {
        // Kept for now.
      }
      return next;
    });
  }, []);
  const [picked, setPicked] = useState<string | undefined>(task);
  // Opened at a task (a notification about it): that task is picked.
  useEffect(() => {
    if (task) setPicked(task);
  }, [task]);
  const { openList } = usePlanActions();
  // A task taken out of the plan isn't picked any more.
  useEffect(() => {
    if (picked && view && picked !== FEED && picked !== BRANCH && picked !== DECISIONS && !picked.startsWith('gate:') && !view.milestones.some((m) => m.tasks.some((t) => t.task.id === picked))) setPicked(undefined);
  }, [view, picked]);
  if (!plan || !view) return <Empty icon="flag" title="This plan is gone" detail="It was deleted. Its tasks stay on the board." action={<Button size="small" onClick={() => openList()}>Back to Plans</Button>} />;
  return <Page view={view} prefs={prefs} setPrefs={setPrefs} picked={picked} setPicked={setPicked} />;
}

/** It moved to another computer (BLG-806): this is its record here; it runs there. */
function MovedAway({ plan }: { plan: Plan }) {
  const actions = useActions();
  const to = plan.movedTo;
  if (!to) return null;
  const page = { kind: 'plan' as const, id: to.planId ?? plan.id };
  return (
    <div className={p.changes} role="status">
      <Icon name="send" size={13} />
      <strong>Moved to {to.name}</strong>
      <span>It runs there now, with its chat and tasks; this is its record.</span>
      <span className={p.grow} />
      <Button size="small" onClick={() => actions.run({ type: 'view', view: to.id ? onMachine(to.id, page) : page })}>
        Open There
      </Button>
    </div>
  );
}

/**
 * Your usage limit stopped the plan: when it goes on by itself, and Resume now. Beluga resumes the
 * head Claude and each paused task once the limit resets (see core/plans/watchdog.ts).
 */
function LimitPause({ view }: { view: PlanView }) {
  const { plan } = view;
  const { api, act } = usePlanActions();
  const { client } = useBeluga();
  const paused = view.active.filter((t) => t.pulse?.kind === 'paused');
  // The head Claude's own last turn, when your limit stopped it.
  const home = useApp((st) => {
    const card = st.log.findLast((l) => l.type === 'agent' && l.channel === plan.home);
    const f = card?.type === 'agent' && card.status === 'error' ? decodeFailure(card.text) : undefined;
    return f?.kind === 'usage_limit' ? (f.resetsAt ?? 0) : undefined;
  });
  if (plan.status !== 'active' || (!paused.length && home === undefined)) return null;
  const until = Math.max(home ?? 0, ...paused.map((t) => (t.pulse?.kind === 'paused' ? t.pulse.until : 0)));
  const resume = (): void => {
    if (home !== undefined) void act(() => client.api.session.submit(CONTINUE_PROMPT, { channel: plan.home, urgent: true }));
    for (const t of paused) void act(() => api.resumeTask(plan.id, t.task.id));
  };
  return (
    <div className={p.changes} role="status">
      <Icon name="clock" size={13} />
      <strong>Paused: usage limit</strong>
      <span>{until > Date.now() ? `resumes at ${resetWords(until)}` : 'resuming as usage comes back'}</span>
      <span className={p.grow} />
      <Button size="small" variant="primary" icon="play" onClick={resume}>
        Resume now
      </Button>
    </div>
  );
}

function Page({ view, prefs, setPrefs, picked, setPicked }: { view: PlanView; prefs: PlanLayout; setPrefs: (change: (layout: PlanLayout) => PlanLayout) => void; picked?: string; setPicked: (id: string | undefined) => void }) {
  const { plan } = view;
  const chat = chatOpen(prefs, plan.id);
  const showChat = useCallback((open: boolean) => setPrefs((l) => setChatOpen(l, plan.id, open)), [plan.id, setPrefs]);
  // ⌥⌘0 (and View › Show Panel): on a plan's page its right side is the chat.
  useEffect(() => {
    const toggle = (): void => setPrefs((l) => setChatOpen(l, plan.id, !chatOpen(l, plan.id)));
    document.addEventListener(PLAN_CHAT_TOGGLE, toggle);
    return () => document.removeEventListener(PLAN_CHAT_TOGGLE, toggle);
  }, [plan.id, setPrefs]);
  const { api, act, openList, openWorktree } = usePlanActions();
  const { client } = useBeluga();
  const startWith = useStartWith();
  const mine = useMyAgent();
  // The plan's conversation (its chat, the head Claude's last turn) loads with the page, the chat shown or not.
  useConversationLoaded(plan.home);
  const uiPrefs = usePrefs();
  const body = shownBody(plan);
  const keys = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.flatMap((t) => (t.issue ? [[t.task.id, t.issue.key] as const] : [])))), [view]);
  const startable = useMemo(() => {
    if (!plan.body || plan.draft || !view.open.length) return new Set<string>();
    // Yours never start in a worktree: their button is Decide…, which opens the plan's conversation (its card asks you).
    const yours = view.ready.filter((t) => t.forYou).map((t) => t.task.id);
    if (view.active.length >= plan.maxParallel) return new Set(yours);
    const step = new Set(view.open.filter((m) => !startsByItself(plan, m.autonomy)).map((m) => m.milestone.id));
    return new Set([...yours, ...view.ready.filter((t) => !t.forYou && (plan.paused || step.has(t.milestoneId))).map((t) => t.task.id)]);
  }, [view, plan]);
  // The chat's width: dragged (live), else the one you left it at, never past half the plan's area.
  const split = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  const splitWidth = (): number => split.current?.clientWidth ?? window.innerWidth;
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const el = split.current;
    if (!el) return;
    setAreaWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setAreaWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const chatWidth = drag ?? clampChatWidth(prefs.chatWidth, areaWidth || window.innerWidth);
  const start = useCallback(
    (taskId: string, agent?: AgentRef) => (view.ready.some((t) => t.task.id === taskId && t.forYou) ? showChat(true) : void act(() => api.startTask(plan.id, taskId, agent))),
    [plan.id, act, api, view, showChat],
  );
  // Decide… on a task of yours (the outline, its details): the conversation, where its card is.
  useEffect(() => {
    const open = (): void => showChat(true);
    document.addEventListener(OPEN_DECISION, open);
    return () => document.removeEventListener(OPEN_DECISION, open);
  }, [showChat]);
  const next = view.next;
  const words = nextWords(next);
  const checker = useCheckerChat(next.kind === 'checking' ? next.milestone : undefined);
  const line = headline(view);
  // Claude is writing the first plan: one placeholder and one line say so, nothing else.
  const drafting = !plan.body && !body?.milestones.length;

  // The big steps (Open PR, Merge, Resolve Conflicts, Pass): the button says what's under way and
  // waits; what went wrong stays on the page with Try Again (see usePlanStep).
  const step = usePlanStep(plan.id);
  const pr = plan.pr;
  const conflictWaits = Boolean(plan.mainMerge?.conflict?.stuck || Object.values(plan.merging ?? {}).some((m) => m.conflict?.stuck));
  const conflictHere = Boolean(plan.mainMerge?.conflict || Object.values(plan.merging ?? {}).some((m) => m.conflict) || Object.values(plan.combining ?? {}).some((c) => c.conflict));
  // Conflicts go to the plan's head agent: yours.
  const who = agentName(mine);
  const askAgain = (): void => void step.run(`ask ${who} to fix the conflict again`, `Asking ${who}…`, () => api.retryConflicts(plan.id), `${who} is on the conflict again`);
  const mergeNow = (auto: boolean): void =>
    void step.run(auto ? `turn on Merge When Checks Pass for #${pr?.number}` : `merge #${pr?.number} on GitHub`, auto ? 'Turning On…' : 'Merging…', () => api.mergePr(plan.id, auto ? { auto: true } : {}), auto ? `#${pr?.number} merges once its checks pass` : `Merged #${pr?.number}: the plan’s tasks are Done`);
  const openPr = (): void => void step.run('open the plan’s pull request', 'Opening PR…', () => api.openPr(plan.id), 'Opened the plan’s pull request');

  // Start with ▸ (BLG-506): "Your agent" over a plan with its own agent is yours by name (none would mean the plan's again).
  const startTasks = (tasks: readonly { readonly task: { readonly id: string } }[], agent?: AgentRef): void => tasks.forEach((t) => void act(() => api.startTask(plan.id, t.task.id, agent)));
  const approvePlan = (): void => void act(() => api.approve(plan.id), 'Plan approved: its tasks are on the board');
  // Verifying a first draft with a fresh agent, when you ask (BLG-772): Approve Plan waits for it, or Fix what it found.
  const review = reviewState(plan);
  const fixReview = (): void => void act(() => api.fixReview(plan.id), 'Sent to your agent');
  const verify = (thenApprove: boolean): void => void act(() => api.verify(plan.id, { thenApprove }), thenApprove ? 'A fresh agent is verifying the plan: it’s approved once nothing needs fixing' : 'A fresh agent is verifying the plan');
  // `with`: the same action by another agent, as the ▾ of a split button.
  const primary = ((): { label: string; run?: () => void; icon?: IconName; busy?: boolean; with?: { readonly label: string; readonly items: ActionItem[] } } | undefined => {
    if (step.busy) return { label: step.busy, busy: true };
    switch (next.kind) {
      case 'approve':
        if (body?.milestones.length && review === 'reviewing') return { label: 'Verifying the Plan…', busy: true };
        if (body?.milestones.length && review === 'findings' && !plan.review?.fixAsked) return { label: 'Fix', icon: 'wand', run: fixReview, with: { label: 'Approve anyway', items: [{ label: 'Approve Anyway', onSelect: approvePlan }] } };
        // Approve, worked by ▸: who works its milestones and tasks, set as it's approved.
        return body?.milestones.length
          ? {
              label: 'Approve Plan',
              icon: 'check',
              run: approvePlan,
              with: {
                label: 'More ways to approve',
                items: [
                  // A fresh agent reads it first (contradictions, duplicates, stale decisions), and approves it once nothing needs fixing.
                  // Who: the same agents and models as Approve, worked by ▸; the one picked verifies it and then works it.
                  {
                    label: 'Verify, Then Approve',
                    icon: 'eye',
                    onSelect: () => undefined,
                    submenu: startWith(plan.agent, (a) => void act(async () => (await api.setWorkAgent(plan.id, a ?? null), api.verify(plan.id, { thenApprove: true })), 'A fresh agent is verifying the plan: it’s approved once nothing needs fixing'), ''),
                  },
                  ...startWith(plan.agent, (a) => void act(async () => (await api.setWorkAgent(plan.id, a ?? null), api.approve(plan.id)), 'Plan approved: its tasks are on the board'), 'Approve, worked by').map((item, i) => (i === 0 ? { ...item, separate: true } : item)),
                ],
              },
            }
          : undefined;
      case 'review_changes':
        return { label: 'Apply Changes', icon: 'check', run: () => void act(() => api.approve(plan.id), 'Changes applied') };
      case 'resume':
        return { label: 'Resume', icon: 'play', run: () => void act(() => api.setPaused(plan.id, false)) };
      case 'start':
        // Yours: the plan's conversation, where its card asks you; Claude's: started.
        if (next.tasks.every((t) => t.forYou)) return { label: words.title, run: () => showChat(true) };
        return {
          label: words.title,
          icon: 'play',
          run: () => startTasks(next.tasks.filter((t) => !t.forYou)),
          with: { label: 'Start with another agent', items: startWith(plan.agent, (a) => startTasks(next.tasks.filter((t) => !t.forYou), a ?? (plan.agent ? mine : undefined))) },
        };
      case 'pass': {
        const again = Boolean(next.milestone.run.mergeFailed);
        return { label: again ? 'Pass Again' : 'Pass Milestone', icon: 'check', run: () => void step.run(`pass “${next.milestone.milestone.title}”`, 'Passing…', () => api.pass(plan.id, next.milestone.milestone.id)) };
      }
      case 'merging': {
        // Merging runs by itself; a conflict goes to Claude, and only one it couldn't fix waits for you.
        const c = next.milestone.merging?.conflict;
        if (c?.stuck) return { label: `Ask ${who} Again`, icon: agentMark(mine), run: askAgain };
        return { label: c ? `${who} Is Fixing the Conflict` : 'Merging…', busy: true };
      }
      case 'checking':
        // Its checker's conversation (off the sidebar, folded into the plan); the head Claude's own check: the plan's chat.
        return { label: 'Watch the Check', icon: 'eye', run: checker ? () => openWorktree(checker) : () => showChat(true) };
      case 'failed':
        return { label: 'Not Yet…', run: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) };
      case 'ship': {
        // One pull request for the whole plan (plan/<slug> → main): opened, brought up to date with main when it conflicts, merged.
        const a = shipAction(plan, next.pr);
        switch (a.kind) {
          case 'open':
            return { label: a.again ? 'Open PR Again' : 'Open PR', icon: 'pr', run: openPr };
          case 'catching_up':
            return { label: 'Bringing Main In…', busy: true };
          case 'fixing':
            return { label: `${who} Is Fixing the Conflict`, busy: true };
          case 'stuck':
            return { label: `Ask ${who} Again`, icon: agentMark(mine), run: askAgain };
          case 'resolve':
            return { label: 'Resolve Conflicts', icon: 'merge', run: () => void step.run(`bring main into ${next.branch}`, 'Bringing Main In…', () => api.bringInMain(plan.id)) };
          case 'draft':
            return { label: 'Mark Ready on GitHub', icon: 'external', run: () => void openExternal(next.pr!.url) };
          case 'wait':
            return { label: 'Merge When Checks Pass', icon: 'check', run: () => mergeNow(true) };
          case 'merge':
            return { label: 'Merge on GitHub', icon: 'check', run: () => mergeNow(false) };
          default:
            return undefined;
        }
      }
      case 'answer':
        return next.tasks[0]?.worktree ? { label: `Answer in ${next.tasks[0].issue?.key ?? 'Its Worktree'}`, run: () => openWorktree(next.tasks[0]!.worktree!) } : undefined;
      case 'stalled':
        return { label: words.title, icon: 'play', run: () => next.tasks.forEach((t) => void act(() => api.resumeTask(plan.id, t.task.id))) };
      default:
        return undefined;
    }
  })();

  const teamItems = usePlanTeamItems(plan.id, plan.projectId);
  // Move To ▸ another computer of yours (BLG-806): Pause and Move To while something runs in it.
  const moveTo = useMoveTo(plan, view, step);
  // Who plans, builds and checks it (BLG-982), from the header's Agents: from now on; milestones at work keep theirs (the toast says so).
  const roleAgent = (role: PlanRole, agent: AgentRef | null): void =>
    void act(() => api.setRoleAgent(plan.id, role, agent)).then((said) => {
      if (typeof said === 'string') toast(client, said, 'success');
    });
  const more: ActionItem[] = [
    ...(plan.body && plan.status === 'active' ? [{ label: plan.paused ? 'Resume' : 'Pause', onSelect: () => void act(() => api.setPaused(plan.id, !plan.paused)) }] : []),
    { label: 'Run at Once', submenu: [1, 2, 3, 4, 6, MAX_PARALLEL].map((n) => ({ label: `${n} ${n === 1 ? 'milestone' : 'milestones'}`, checked: plan.maxParallel === n, onSelect: () => void act(() => api.setParallel(plan.id, n)) })), onSelect: () => undefined },
    { label: 'When to Run Tests', submenu: TESTS_AT.map((t) => ({ label: TESTS_AT_INFO[t].label, hint: TESTS_AT_INFO[t].hint, checked: plan.testsAt === t, onSelect: () => void act(() => api.setTestsAt(plan.id, t), t === 'end' ? 'From now on, milestone checks skip the test suites; they all run once, in the final step' : 'From now on, each milestone’s check runs the full suites once, on its combined work') })), onSelect: () => undefined },
    ...(review === 'reviewing' ? [{ label: 'Approve Without Waiting', onSelect: approvePlan }] : []),
    ...(review !== 'off' && review !== 'reviewing' ? [{ label: review === 'none' ? 'Verify the Plan' : 'Verify the Plan Again', onSelect: () => verify(false) }] : []),
    ...(next.kind === 'stalled' ? next.tasks.flatMap((t) => (t.worktree ? [{ label: `Open ${t.issue?.key ?? 'Its'} Chat`, onSelect: () => openWorktree(t.worktree!) }] : [])) : []),
    ...(next.kind === 'pass' ? [{ label: 'Not Yet…', onSelect: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) }] : []),
    ...(next.kind === 'failed' || next.kind === 'checking'
      ? [
          { label: 'Check Again', onSelect: () => void act(() => api.recheck(plan.id, next.milestone.milestone.id)) },
          { label: 'Pass Anyway', onSelect: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) },
        ]
      : []),
    ...(pr ? [{ label: `View PR #${pr.number} on GitHub`, onSelect: () => void openExternal(pr.url) }] : []),
    ...(next.kind === 'ship'
      ? [
          ...(shipAction(plan, next.pr).kind === 'wait' ? [{ label: 'Merge Now', onSelect: () => mergeNow(false) }] : []),
          ...(next.pr?.state === 'OPEN' && !next.pr.conflicts && !plan.mainMerge ? [{ label: 'Bring Main In', hint: `Merge main into ${next.branch} now`, onSelect: () => void step.run(`bring main into ${next.branch}`, 'Bringing Main In…', () => api.bringInMain(plan.id), `Main is in ${next.branch}`) }] : []),
          { label: 'Merge into Main Locally', onSelect: () => openSheet({ kind: 'confirm', title: `Merge ${next.branch} into main here?`, message: 'The main folder must be on main with no uncommitted changes. The plan’s tasks go to Done.', confirm: 'Merge', run: () => void step.run(`merge ${next.branch} into main here`, 'Merging…', () => api.mergeLocal(plan.id), 'Merged into main: the plan’s tasks are Done') }) },
        ]
      : []),
    ...(conflictWaits && primary?.run !== askAgain ? [{ label: `Ask ${who} Again`, onSelect: askAgain }] : []),
    ...(conflictHere ? [{ label: revealLabel('Conflict'), onSelect: () => void act(() => api.showConflict(plan.id)) }] : []),
    ...(plan.status === 'active' ? [taskChatsItem(plan.id, uiPrefs)] : []),
    ...teamItems,
    ...(moveTo ? [moveTo] : []),
    { label: 'Copy as Markdown', separate: true, onSelect: () => void copyText(markdownOf(view)) },
    { label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) },
    // How it runs and when its tests run, in one sheet (plans/PlanSettingsSheet.tsx).
    ...(plan.status !== 'done' ? [{ label: 'Plan Settings…', onSelect: () => openSheet({ kind: 'plan_settings', planId: plan.id }) }] : []),
    ...(plan.draft ? [{ label: plan.body ? 'Discard Changes' : 'Discard Draft', danger: true, separate: true, onSelect: () => openSheet({ kind: 'confirm', title: plan.body ? 'Discard the proposed changes?' : 'Discard this draft?', message: plan.body ? 'The plan stays as you approved it.' : 'Nothing was put on the board, so nothing else changes.', confirm: 'Discard', destructive: true, run: () => void act(() => api.discard(plan.id)) }) }] : []),
    ...(plan.body ? [{ label: 'Delete Plan…', danger: true, separate: !plan.draft, onSelect: () => openSheet({ kind: 'confirm', title: `Delete “${titleOf(plan)}”?`, message: 'Its tasks stay on the board; only the plan goes.', confirm: 'Delete', destructive: true, run: () => void act(() => api.remove(plan.id)).then(() => openList(plan.projectId)) }) }] : []),
  ];

  return (
    <div className={p.page}>
      <header className={p.pageHead}>
        <div className={p.headMain}>
          <div className={p.titleRow}>
            <IconButton size="small" icon="back" label="All Plans" className={p.back} onClick={() => openList(plan.projectId)} />
            <TitleField value={titleOf(plan)} onSave={(title) => void act(() => api.edit(plan.id, [{ op: 'retitle', title }]))} />
          </div>
          {drafting ? null : (
            <>
              {view.milestones.length && plan.body ? <PlanProgress columns={barColumns(view)} /> : null}
              <button type="button" className={p.saidButton} onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-label={`${line.who === 'you' ? 'You: ' : ''}${line.text}. Show what happened`}>
                <Said line={line} />
              </button>
            </>
          )}
        </div>
        <div className={p.headActions}>
          {/* Where it runs (BLG-786): the computer it was made on. Only with a computer paired. */}
          <RunsOnLabel tip="It runs on the computer it was made on until you move it." />
          {/* The plan's pull request, always one click from GitHub, with what stands in its way. */}
          {pr ? <PlanPrChip pr={pr} /> : null}
          {/* How it runs: nothing to run while Claude writes it. A real decision: its sheet says what changes. */}
          {drafting ? null : (
            <Button size="small" variant="quiet" icon={plan.fullAuto ? 'bot' : 'gauge'} title={plan.fullAuto ? FULL_AUTOPILOT_INFO.hint : AUTONOMY_INFO[plan.autonomy].hint} onClick={() => openSheet({ kind: 'plan_mode', planId: plan.id })}>
              Runs on {plan.fullAuto ? FULL_AUTOPILOT_INFO.label : AUTONOMY_INFO[plan.autonomy].label}
              {!plan.fullAuto && view.milestones.some((m) => m.milestone.autonomy && m.milestone.autonomy !== plan.autonomy) ? ' (mixed)' : ''}
            </Button>
          )}
          {/* Who plans, builds and checks it (BLG-982): one name, or how many; each part changed from its menu. */}
          {plan.status !== 'done' ? <PlanAgentsButton plan={plan} pick={roleAgent} /> : null}
          {/* The orchestrator's chat beside the plan, in and out: always here, whichever way it is. */}
          <Tip label={chat ? 'Hide the orchestrator’s chat' : 'Open the orchestrator’s chat'} keys={shortcutKeys('toggle-inspector')}>
            <Button size="small" variant="quiet" icon="claude" aria-pressed={chat} onClick={() => showChat(!chat)}>
              {chat ? 'Hide Orchestrator' : 'Open Orchestrator'}
            </Button>
          </Tip>
          <ActionsDropdown items={more}>
            <IconButton size="small" icon="more" label="Plan Options" />
          </ActionsDropdown>
          {primary?.with && !primary.busy ? (
            <SplitButton label={primary.with.label} items={primary.with.items}>
              <Button variant="primary" size="small" {...(primary.icon ? { icon: primary.icon } : {})} onClick={primary.run}>
                {primary.label}
              </Button>
            </SplitButton>
          ) : primary ? (
            <Button variant="primary" size="small" {...(primary.icon && !primary.busy ? { icon: primary.icon } : {})} disabled={primary.busy} aria-busy={primary.busy || undefined} className={primary.busy ? p.busyButton : undefined} onClick={primary.run}>
              {primary.busy ? <Working /> : null}
              {primary.label}
            </Button>
          ) : null}
        </div>
      </header>
      {step.trouble ? (
        <div className={cx(p.changes, p.trouble)} role="alert">
          <Icon name="alert" size={13} />
          <strong>Couldn’t {step.trouble.what}</strong>
          <span className={p.troubleWhy}>{step.trouble.why}</span>
          <span className={p.grow} />
          <Button size="small" variant="quiet" onClick={step.dismiss}>
            Dismiss
          </Button>
          {step.trouble.retry ? (
            <Button size="small" onClick={step.trouble.retry}>
              Try Again
            </Button>
          ) : null}
        </div>
      ) : null}
      <MovedAway plan={plan} />
      <ConflictLine view={view} onShow={setPicked} />
      <MergeFailed view={view} onPass={(id, title) => void step.run(`pass “${title}”`, 'Passing…', () => api.pass(plan.id, id))} />
      <LimitPause view={view} />
      <TidyOffer view={view} />
      <TeamReviews planId={plan.id} />
      <ReviewLine plan={plan} onApprove={approvePlan} />
      {plan.body && plan.draft ? (
        <div className={p.changes} role="status">
          <Icon name="wand" size={13} />
          <strong>Your agent proposes changes</strong>
          <span>{changeWords(plan)}</span>
          <span className={p.grow} />
          <Button size="small" variant="quiet" onClick={() => void act(() => api.discard(plan.id))}>
            Discard
          </Button>
          <Button size="small" variant="primary" onClick={() => void act(() => api.approve(plan.id), 'Changes applied')}>
            Apply Changes
          </Button>
        </div>
      ) : null}
      <div ref={split} className={cx(p.split, chat && p.splitChat)} style={chat ? { gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px` } : undefined}>
        <div className={p.stage}>
          <div className={p.stageTools}>
            {drafting ? null : (
              <Segmented<Display> size="small"
                label="Show"
                value={prefs.display}
                onChange={(display) => setPrefs((l) => ({ ...l, display }))}
                options={[
                  { value: 'graph', label: 'Canvas', hint: 'The plan as a graph' },
                  { value: 'outline', label: 'List', hint: 'Milestone by milestone' },
                ]}
              />
            )}
            {drafting ? null : (
              <Button size="small" variant="quiet" icon="clock" onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-pressed={picked === FEED}>
                What Happened
              </Button>
            )}
            {/* What the plan has decided (BLG-772): there once it decided something. */}
            {body?.decisions?.length ? (
              <Button size="small" variant="quiet" icon="bulb" onClick={() => setPicked(picked === DECISIONS ? undefined : DECISIONS)} aria-pressed={picked === DECISIONS}>
                Decisions
              </Button>
            ) : null}
            {/* Where the work goes: each milestone into the plan's branch, the branch into main as one PR. */}
            {plan.body && !plan.draft ? (
              <Button size="small" variant="quiet" icon="branch" onClick={() => setPicked(picked === BRANCH ? undefined : BRANCH)} aria-pressed={picked === BRANCH} title={`Where the plan’s work goes, step by step${plan.branch ? ` (${plan.branch})` : ''}`} className={p.branchButton}>
                {plan.branch ?? 'Branch'}
              </Button>
            ) : null}
          </div>
          {!body?.milestones.length ? (
            <Drafting plan={plan} />
          ) : prefs.display === 'graph' ? (
            <Suspense fallback={<div className={p.canvasNote}>Laying out…</div>}>
              <PlanCanvas view={view} keys={keys} selected={picked} onSelect={setPicked} onStart={start} startable={startable} />
            </Suspense>
          ) : (
            <PlanOutline view={view} keys={keys} selected={picked} onSelect={setPicked} startable={startable} />
          )}
          {picked ? <PlanDetails view={view} picked={picked} canStart={startable.has(picked)} onPick={setPicked} onClose={() => setPicked(undefined)} /> : null}
        </div>
        {/* Hidden, not gone: what you typed, where you'd scrolled and a send to retry are there when it's back. */}
        {plan.home ? (
          <div className={p.chatSide} style={chat ? undefined : { display: 'none' }} aria-hidden={chat ? undefined : true}>
            <ResizeHandle
              axis="x"
              label="Resize the chat"
              className={p.chatEdge}
              onMove={(x) => setDrag(clampChatWidth((split.current?.getBoundingClientRect().right ?? window.innerWidth) - x, splitWidth()))}
              onEnd={() => {
                if (drag !== undefined) setPrefs((l) => ({ ...l, chatWidth: drag }));
                setDrag(undefined);
              }}
              onReset={() => setPrefs((l) => ({ ...l, chatWidth: CHAT_DEFAULT }))}
              onStep={(dir) => setPrefs((l) => ({ ...l, chatWidth: clampChatWidth(chatWidth + dir * 24, splitWidth()) }))}
            />
            <PlanChat channel={plan.home} draft={!plan.body || Boolean(plan.draft)} drafting={drafting} project={plan.projectId} onClose={() => showChat(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The plan's name, changed in place: wraps instead of clipping (descenders and long names show whole); Enter saves. */
function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [text, setText] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  // What you typed and haven't saved: a name arriving meanwhile (your last rename coming back) never overwrites it.
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) setText(value);
  }, [value]);
  // As tall as its lines: on every change and whenever a new width changes the wrapping.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (): void => {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      // Next frame: resizing the box inside its own observer's callback is a ResizeObserver loop.
      if (el.clientWidth !== width) (width = el.clientWidth), cancelAnimationFrame(frame), (frame = requestAnimationFrame(fit));
    });
    let frame = 0;
    watch.observe(el);
    return () => (watch.disconnect(), cancelAnimationFrame(frame));
  }, [text]);
  const save = (): void => {
    if (typed.current && text.trim() && text.trim() !== value) onSave(text.trim());
    else setText(value);
    typed.current = false;
  };
  return (
    <textarea
      ref={box}
      className={cx(p.title, 'selectable')}
      aria-label="Plan name"
      rows={1}
      spellCheck={false}
      value={text}
      onChange={(e) => ((typed.current = true), setText(e.target.value.replace(/\s*\n\s*/g, ' ')))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          typed.current = false;
          setText(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * While Claude writes the first plan: the outline of three milestone columns, drawn softly inside
 * the canvas, and the one line that says what's going on (how long it's been at it).
 */
function Drafting({ plan }: { plan: Plan }) {
  const project = useApp((s) => s.projects.find((x) => x.id === plan.projectId)?.name);
  const activity = useApp((s) => activityOf(s.log, plan.home));
  const now = useNow(true);
  const since = activity.startedAt ?? plan.createdAt;
  const fresh = now - plan.createdAt < 20_000;
  const line = activity.running
    ? `Your agent is reading ${project ?? 'the code'} and writing the plan · ${formatDuration(Math.max(0, now - since))}`
    : fresh
      ? 'Your agent is starting on the plan…'
      : 'Your agent isn’t writing the plan right now. Tell it what to plan in the conversation.';
  return (
    <div className={p.writing}>
      <div className={p.skeleton} data-live={activity.running || fresh ? 'true' : undefined} aria-hidden="true">
        {[3, 2, 2].map((n, i) => (
          <div key={i} className={p.skMilestone} style={{ animationDelay: `${i * 220}ms` }}>
            <div className={p.skHead} />
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className={p.skTask} />
            ))}
          </div>
        ))}
      </div>
      <p className={p.writingLine} role="status">
        {line}
      </p>
    </div>
  );
}

/** The plan as Markdown (to paste somewhere). */
function markdownOf(view: PlanView): string {
  const body = shownBody(view.plan);
  if (!body) return '';
  const lines = [`# ${body.title}`, '', body.goal, ''];
  for (const m of view.milestones) {
    lines.push(`## ${m.index + 1}. ${m.milestone.title}`, '');
    if (m.milestone.goal) lines.push(m.milestone.goal, '');
    for (const t of m.tasks) lines.push(`- [${t.state === 'done' ? 'x' : ' '}] ${t.issue ? `${t.issue.key} ` : ''}${t.task.title}${t.task.blockedBy.length ? ` (after ${t.task.blockedBy.join(', ')})` : ''}`);
    if (m.milestone.criteria.length) lines.push('', '**Passes when:**', ...m.milestone.criteria.map((c) => `- ${c}`));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The plan adopted a branch after some milestones passed: their tasks still In Review can be merged
 * into it and their worktrees cleared away, but only on your Yes (never by itself, nor on a restart).
 */
function TidyOffer({ view }: { view: PlanView }) {
  const { api, act } = usePlanActions();
  const tasks = tidyOffer(view);
  if (!tasks.length) return null;
  const plan = view.plan;
  return (
    <div className={p.changes} role="status" aria-label="Tidy up">
      <Icon name="branch" size={13} />
      <strong>
        Tidy up {tasks.length} merged task {tasks.length === 1 ? 'worktree' : 'worktrees'}?
      </strong>
      <span title={tasks.map((t) => `${t.issue!.key} ${t.task.title}`).join('\n')}>
        {tasks.map((t) => t.issue!.key).join(', ')}: their milestones passed before {plan.branch} was the plan’s branch. Tidy Up merges each into it, then archives its worktree (the conversation stays) and deletes its branch only if merged.
      </span>
      <span className={p.grow} />
      <Button size="small" variant="quiet" onClick={() => void act(() => api.tidyUp(plan.id, false), 'Left as they are')}>
        No
      </Button>
      <Button size="small" variant="primary" onClick={() => void act(() => api.tidyUp(plan.id, true), `Tidying up ${tasks.length === 1 ? '1 worktree' : `${tasks.length} worktrees`}`)}>
        Tidy Up
      </Button>
    </div>
  );
}


/**
 * A merge conflict in the plan (a milestone merging into its branch, or main into it for the PR):
 * which files, and whether Claude is on it. One it couldn't fix waits for you: Ask Claude Again
 * and Show in Finder sit in ••• and the main button.
 */
function ConflictLine({ view, onShow }: { view: PlanView; onShow: (id: string) => void }) {
  const { plan } = view;
  const merging = Object.entries(plan.merging ?? {}).find(([, m]) => m.conflict);
  const main = plan.mainMerge?.conflict;
  const c = main ?? merging?.[1].conflict;
  if (!c) return null;
  const m = merging ? view.milestones.find((x) => x.milestone.id === merging[0]) : undefined;
  const what = main ? `${plan.mainMerge!.main} into ${plan.branch}` : `${merging![1].conflict!.key ?? merging![1].conflict!.merging} (“${m?.milestone.title ?? 'a milestone'}”) into ${plan.branch}`;
  const shown = c.files.slice(0, 4);
  return (
    <div className={cx(p.changes, c.stuck ? p.trouble : undefined)} role="status" aria-label="Merge conflict">
      <Icon name="merge" size={13} />
      <strong>{c.stuck ? 'Conflict: needs you' : 'Your agent is fixing a conflict'}</strong>
      <span className={p.troubleWhy} title={c.files.join('\n')}>
        Merging {what} · {shown.map((f) => (
          <code key={f} className={p.conflictFile}>{f}</code>
        ))}
        {c.files.length > shown.length ? ` and ${c.files.length - shown.length} more` : ''}
      </span>
      <span className={p.grow} />
      {!c.stuck ? <Working /> : null}
      <Button size="small" variant="quiet" onClick={() => onShow(main ? BRANCH : `gate:${merging![0]}`)}>
        Details
      </Button>
    </div>
  );
}

/** A milestone you passed whose work couldn't go into the plan's branch (not a conflict): why, kept, and Pass Again. */
function MergeFailed({ view, onPass }: { view: PlanView; onPass: (milestoneId: string, title: string) => void }) {
  const failed = view.milestones.filter((m) => m.run.mergeFailed && !m.run.passedAt && m.state !== 'merging');
  if (!failed.length) return null;
  return (
    <>
      {failed.map((m) => (
        <div key={m.milestone.id} className={cx(p.changes, p.trouble)} role="alert">
          <Icon name="alert" size={13} />
          <strong>
            “{m.milestone.title}” couldn’t merge into {view.plan.branch ?? 'the plan’s branch'}
          </strong>
          <span className={p.troubleWhy}>{m.run.mergeFailed!.reason}</span>
          <span className={p.grow} />
          <Button size="small" onClick={() => onPass(m.milestone.id, m.milestone.title)}>
            Pass Again
          </Button>
        </div>
      ))}
    </>
  );
}
