import { useEffect, useRef, useState } from 'react';
import { type Issue, PRIORITY_INFO, PROVIDER_INFO, STATUS_INFO, actorName, assigneeName, boardName, boardOf, isArchived, isEpic, progressOf, isFinished, isOpen, isStartable, issueById, reposAlong, taskProof, worktreeDoing, worktreeOf } from '@beluga/core/board/model.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga, useMachine } from '../lib/beluga.js';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import { agentPicker, pickedAgent } from '@beluga/shared/agent-picker.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { myRuntime, pickerState } from '../chat/ModelPicker.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { SplitButton } from '../components/SplitButton.js';
import type { AgentRef } from '@beluga/protocol.js';
import { useTaskStart } from './use-task-start.js';
import { usePlanActions } from '../plans/use-plans.js';
import { ActivityFeed } from './Activity.js';
import { Brief } from './Brief.js';
import { AssigneeMark, LabelChip, PrChip, PriorityIcon, StatusIcon } from './marks.js';
import { useIssueMenu, useSharedWith } from './parts.js';
import { AssigneePicker, LabelsPicker, PriorityPicker, StatusPicker, TaskPicker } from './pickers.js';
import { FilesList, ProofList, Relations, SubTasks } from './TaskSections.js';
import { taskDropProps, useTaskFileDrop } from './use-task-drop.js';
import { unexplained } from '@beluga/core/board/criteria.js';
import { checksWords } from '@beluga/shared/task-checks.js';
import { ago, dueText } from './tasks-model.js';
import { openSheet } from '../lib/sheets.js';
import { useBoard, useSelfId, useSolo, useTaskActions } from './use-tasks.js';
import { useSwipeBack } from './use-swipe-back.js';
import { SwipeBackEdge } from './SwipeBackEdge.js';
import { FixItButton, GitHubIssueProp, useInvestigated } from '../issues/task-bits.js';
import t from './tasks.module.css';
import { AssignedToYou, WaitingFor, WorkingOn } from '../team/Team.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { RepoPicker, useSeveralRepos } from './boards.js';
import { showWorktreeFolder } from '../lib/remote-open.js';
import { revealThereLabel } from '@beluga/machines/open.js';

/**
 * One task: its title (click to rename), what to do next (start a worktree with Claude on it, or
 * open the one doing it), the brief, sub-tasks, what waits on what, proof and everything that
 * happened, with its properties down the right.
 */
export function TaskPage({ id }: { id: string }) {
  const board = useBoard();
  const issue = issueById(board, id);
  if (!board.enabled) return <Empty icon="task" title="Tasks need the Beluga app" />;
  if (!issue) return <Empty icon="task" title="This task isn’t here anymore" detail="It may have been deleted." />;
  return <IssuePage issue={issue} />;
}

/**
 * The page itself. Getting back out is always at hand (BLG-5): the header with Back stays at the
 * top while the page scrolls, and a two-finger swipe right, ⌘[ or Esc go back too.
 */
function IssuePage({ issue }: { issue: Issue }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { back } = useTaskActions();
  const swipe = useSwipeBack(wrap, () => back(boardOf(issue)));
  const proofFirst = isFinished(issue.status) && taskProof(issue).length > 0;
  // Files dropped anywhere on the page are added to the task.
  const dropping = useTaskFileDrop();
  return (
    <div ref={wrap} className={t.pageWrap} {...taskDropProps(issue)}>
    {dropping}
    <SwipeBackEdge progress={swipe} />
    <div className={t.page}>
      <div className={t.pageMain}>
        <Header issue={issue} />
        {/* Finished work: what shows it works comes first (BLG-13). */}
        {proofFirst ? <ProofList issue={issue} /> : null}
        <Brief issue={issue} />
        <FilesList issue={issue} />
        <SubTasks issue={issue} />
        <Relations issue={issue} />
        {proofFirst ? null : <ProofList issue={issue} />}
        <section className={t.block} aria-label="Activity">
          <header className={t.blockHead}>
            <h3 className={t.sectionTitle}>Activity</h3>
          </header>
          <ActivityFeed issue={issue} />
        </section>
      </div>
      <Properties issue={issue} />
    </div>
    </div>
  );
}

function Header({ issue }: { issue: Issue }) {
  const board = useBoard();
  const onBoard = useApp((s) => boardName(s.board, boardOf(issue), (id) => s.projects.find((p) => p.id === id)?.name));
  const parent = issue.parent ? issueById(board, issue.parent) : undefined;
  const { open, openList, back } = useTaskActions();
  const menu = useIssueMenu();
  // The bar is the page's own child (not the header's), so it stays at the top all the way down.
  return (
    <>
      <nav className={t.crumbs} aria-label="Where this task is">
        <IconButton size="small" icon="back" label="Back" keys={shortcutKeys('page-back')} className={t.crumbBack} onClick={() => back(boardOf(issue))} />
        <button type="button" className={t.crumb} onClick={() => openList(boardOf(issue))}>
          Tasks
        </button>
        <Icon name="chevronRight" size={10} />
        <button type="button" className={t.crumb} onClick={() => openList(boardOf(issue))}>
          {onBoard}
        </button>
        {parent ? (
          <>
            <Icon name="chevronRight" size={10} />
            <button type="button" className={t.crumb} onClick={() => open(parent)}>
              {parent.key} {parent.title}
            </button>
          </>
        ) : null}
        <span className={t.grow} />
        <span className={t.pageKey}>{issue.key}</span>
        <ActionsDropdown items={menu(issue).filter((i) => i.label !== 'Open')}>
          <IconButton size="small" icon="more" label="More" />
        </ActionsDropdown>
      </nav>
      <header className={t.pageHead}>
        {isEpic(board, issue) ? <EpicLine issue={issue} /> : null}
        <Title issue={issue} />
        <WorkingOn issueId={issue.id} />
        <WaitingFor issueId={issue.id} />
        <AssignedToYou issueId={issue.id} />
        <PrivateBanner issue={issue} />
        <ArchivedBanner issue={issue} />
        <GoneBanner issue={issue} />
        <ChecksBanner issue={issue} />
        {isArchived(issue) ? null : <NextStep issue={issue} />}
      </header>
    </>
  );
}

/** Above an epic's title: that it is one, and how far its sub-tasks are. */
function EpicLine({ issue }: { issue: Issue }) {
  const board = useBoard();
  const { done, total } = progressOf(board, issue);
  return (
    <div className={t.pageEpic}>
      <Icon name="epic" size={12} />
      Epic
      {total ? <span className={t.epicCount}>· {done} of {total} sub-tasks done</span> : null}
    </div>
  );
}

/** The title, renamed in place (Return saves, Esc puts it back). */
function Title({ issue }: { issue: Issue }) {
  const [draft, setDraft] = useState<string>();
  const { api, act } = useTaskActions();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, issue.title]);
  const save = (): void => {
    const next = draft?.replace(/\s+/g, ' ').trim();
    setDraft(undefined);
    if (next && next !== issue.title) void act(() => api.update(issue.id, { title: next }));
  };
  // While its agent writes the task, the title is its stand-in and theirs to replace (BLG-598).
  const writing = Boolean(issue.drafting);
  return (
    <textarea
      ref={input}
      className={cx(t.pageTitle, writing && t.pageTitleWriting)}
      value={draft ?? issue.title}
      rows={1}
      aria-label="Title"
      readOnly={writing}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(undefined);
          requestAnimationFrame(() => input.current?.blur());
        }
      }}
    />
  );
}

/** Kept out of review (or out of Done, its work merged: BLG-952): which criteria still need a tick or a reason. */
function ChecksBanner({ issue }: { issue: Issue }) {
  if (!issue.needsChecks || !STATUS_INFO[issue.status].open) return null;
  const open = unexplained(issue.brief.acceptance);
  if (!open.length) return null;
  return (
    <div className={t.banner} role="status">
      <Icon name="alert" size={14} />
      <span className={t.bannerText}>
        <strong>Needs its checks.</strong> {checksWords(open.length, issue.mergedHeld === true)}
      </span>
    </div>
  );
}

/** Private (BLG-501): only you see it, and who would once it's shared, in one click. */
function PrivateBanner({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  const board = useBoard();
  const sharedWith = useSharedWith()(issue.projectId);
  if (!issue.private || isArchived(issue)) return null;
  const kids = board.issues.filter((i) => i.parent === issue.id && i.private).length;
  return (
    <div className={t.banner} role="status">
      <Icon name="lock" size={14} />
      <span className={t.bannerText}>
        <strong>Private.</strong> Only you see it{sharedWith ? '; your team won’t until you share it' : ''}.
      </span>
      {sharedWith ? (
        <Button size="small" onClick={() => void act(() => api.setPrivate(issue.id, false), `Shared ${issue.key}${kids ? ' and its sub-tasks' : ''} with the team`)}>
          Share with Team
        </Button>
      ) : null}
    </div>
  );
}

/** In the Archive: off the board, its words kept, its proof files let go. Back out, or gone for good. */
function ArchivedBanner({ issue }: { issue: Issue }) {
  const { api, act, back } = useTaskActions();
  if (!isArchived(issue)) return null;
  return (
    <div className={t.banner} role="status">
      <Icon name="archive" size={14} />
      <span className={t.bannerText}>
        <strong>Archived {ago(issue.archivedAt!)}.</strong> Its words and history are kept{issue.proof.some((p) => p.thumb || p.bytes !== undefined) ? '; its screenshots were kept small and its other proof files let go' : ''}.
      </span>
      <Button size="small" onClick={() => void act(() => api.unarchive(issue.id), `${issue.key} is back on the board`)}>
        Restore
      </Button>
      <Button
        size="small"
        variant="quiet"
        onClick={() =>
          openSheet({
            kind: 'confirm',
            title: `Delete ${issue.key} for good?`,
            message: `“${issue.title}”, its brief, its history and what’s left of its proof go away. This can’t be undone.`,
            confirm: 'Delete for Good',
            destructive: true,
            run: () => void act(() => api.remove(issue.id), `Deleted ${issue.key}`).then(() => back(boardOf(issue))),
          })
        }
      >
        Delete for Good
      </Button>
    </div>
  );
}

/** Its worktree was archived or deleted before it was done: what now? */
function GoneBanner({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  if (!issue.worktreeGone) return null;
  return (
    <div className={t.banner} role="status">
      <Icon name="archive" size={14} />
      <span className={t.bannerText}>Its worktree was put away before the task was done.</span>
      <Button size="small" variant="quiet" onClick={() => void act(() => api.settleGone(issue.id, 'keep'))}>
        Keep As Is
      </Button>
      <Button size="small" onClick={() => void act(() => api.settleGone(issue.id, 'backlog'))}>
        Back to Backlog
      </Button>
      <Button size="small" onClick={() => void act(() => api.settleGone(issue.id, 'canceled'))}>
        Cancel Task
      </Button>
    </div>
  );
}

/**
 * The worktree a task has (or had): the last one that did it, even once it's archived or its work
 * finished (BLG-13). `had`: some worktree did it (perhaps since removed): that's where its work is,
 * so the page offers no Start (starting afresh is ⋯ › Start). A worktree carrying its work (Claude
 * moved it along there) counts as the one doing it: Open Worktree, not Start.
 */
function useTaskWorktree(issue: Issue): { readonly ws: Workspace | undefined; readonly live: Workspace | undefined; readonly had: boolean } {
  const last = issue.worktrees.at(-1);
  const own = useApp((s) => (last ? findWorkspace(s.projects, last) : undefined));
  const carrier = useApp((s) => (issue.carriedBy ? findWorkspace(s.projects, issue.carriedBy) : undefined));
  const doing = worktreeDoing(issue, (id) => (id === own?.id ? !own.archived : id === carrier?.id ? !carrier.archived : false));
  const live = doing === own?.id ? own : doing === carrier?.id ? carrier : undefined;
  const ws = live ?? own;
  const had = Boolean(ws) || issue.worktrees.length > 0 || issue.activity.some((a) => a.kind === 'worktree');
  return { ws, live, had };
}

/** Where a task's work is: its worktree (open it, reveal its folder in Finder), or what became of it. `secondary`: something else is the main action (Fix It). */
function WorktreeLinks({ issue, ws, live, secondary }: { issue: Issue; ws: Workspace | undefined; live: Workspace | undefined; secondary?: boolean }) {
  const { openWorktree } = useTaskActions();
  const { client } = useBeluga();
  // On a computer's page: Copy Path, never Finder over there (BLG-852).
  const revealWords = useMachine() ? revealThereLabel('folder') : 'Reveal Folder';
  const api = useApi();
  // An epic across repos (BLG-561): the repos of its sub-tasks' worktrees it works in too.
  const also = useApp((s) =>
    live
      ? [...new Set(s.board.issues.filter((k) => k.parent === issue.id && k.projectId !== issue.projectId && isOpen(k.status) && s.projects.some((p) => p.workspaces.some((w) => w.id === worktreeOf(k) && !w.archived))).map((k) => s.projects.find((p) => p.id === k.projectId)?.name ?? ''))].filter(Boolean).join(', ')
      : '',
  );
  if (live) {
    return (
      <>
        <Button variant={secondary ? 'plain' : 'primary'} size="small" icon="branch" onClick={() => openWorktree(live.id)}>
          Open Worktree
        </Button>
        <Button size="small" variant="quiet" icon="folder" onClick={() => void showWorktreeFolder(client, live.id)}>
          {revealWords}
        </Button>
        <span className={t.nextInfo}>
          <span className={t.mono}>{live.name}</span>
          {issue.branch ? <span className={t.nextBranch}>on {issue.branch}</span> : null}
          {also ? <span className={t.nextBranch}>also in {also}</span> : null}
        </span>
      </>
    );
  }
  // Archived: its conversation is still there (it's restored from there); removed: its branch is what's left.
  return (
    <>
      {ws ? (
        <Button size="small" icon="chat" onClick={() => openWorktree(ws.id)}>
          Open the Conversation
        </Button>
      ) : null}
      <span className={t.nextInfo}>
        {ws ? (
          <>
            <span className={t.mono}>{ws.name}</span> is archived
          </>
        ) : (
          'Its worktree was removed'
        )}
        {issue.branch ? <span className={t.nextBranch}>on {issue.branch}</span> : null}
      </span>
    </>
  );
}

/** What to do next: open the worktree doing it (and its pull request), or start one; finished work shows how it ended. */
function NextStep({ issue }: { issue: Issue }) {
  const { ws, live, had } = useTaskWorktree(issue);
  const [starting, setStarting] = useState(false);
  // Its GitHub issue investigated: Fix It (there) is the one main action.
  const fixFirst = useInvestigated(issue);
  const { who, start: startWith, items } = useTaskStart(issue);
  // An epic across repos (BLG-561): Start makes a worktree in each of its sub-tasks' repos too, one agent on all.
  const along = useApp((s) => reposAlong(s.board, issue).map((r) => s.projects.find((p) => p.id === r)?.name ?? r).join('\u0000'));
  const repo = useApp((s) => s.projects.find((p) => p.id === issue.projectId)?.name ?? 'its repo');
  const others = along ? along.split('\u0000') : [];
  // One click: a new worktree named after it, In Progress, its agent on it with its brief, and you there (BLG-55).
  // Start with… (BLG-506): another agent, this start only.
  const start = async (agent?: AgentRef): Promise<void> => {
    setStarting(true);
    await startWith(agent);
    setStarting(false);
  };
  if (isFinished(issue.status)) return <Outcome issue={issue} ws={ws} live={live} />;
  if (!STATUS_INFO[issue.status].open && !live) return null;
  // Its agent is still writing it: Start waits for the brief (BLG-598).
  const writing = Boolean(issue.drafting);
  return (
    <div className={t.nextStep}>
      {had || live ? (
        <>
          <FixItButton issue={issue} />
          <WorktreeLinks issue={issue} ws={ws} live={live} secondary={fixFirst} />
        </>
      ) : (
        <>
          <SplitButton label="Start with another agent" disabled={starting || writing} items={items((a) => void start(a))}>
            <Button variant="primary" size="small" icon="play" disabled={starting || writing} onClick={() => void start()}>
              {starting ? 'Starting…' : 'Start'}
            </Button>
          </SplitButton>
          <span className={t.nextInfo}>
            {writing
              ? 'You can start it once its brief is written'
              : others.length
              ? `A worktree in ${[repo, ...others].slice(0, -1).join(', ')} and ${others.at(-1)} from the latest origin, with ${who} working on ${issue.key} across them`
              : `A new worktree from the latest origin, with ${who} working on ${issue.key}${issue.brief.goal ? ' from this brief' : ''}`}
          </span>
        </>
      )}
      <span className={t.grow} />
      {issue.pr ? <PrLink pr={issue.pr} /> : null}
    </div>
  );
}

/**
 * A finished task (in review, merged into its plan, or shipped): what happened, where its work is
 * (branch, its worktree and folder, pull request, plan) and its conversation, to look at it or
 * ask it things still. Starting again is ⋯ › Reopen the Task.
 */
function Outcome({ issue, ws, live }: { issue: Issue; ws: Workspace | undefined; live: Workspace | undefined }) {
  const { openWorktree } = useTaskActions();
  const { client } = useBeluga();
  // On a computer's page: Copy Path, never Finder over there (BLG-852).
  const revealWords = useMachine() ? revealThereLabel('folder') : 'Reveal Folder';
  const api = useApi();
  const plan = useApp((s) => (issue.plan ? s.plans.plans.find((p) => p.id === issue.plan!.id) : undefined));
  const { open: openPlan } = usePlanActions();
  const what =
    issue.status === 'in_review'
      ? issue.pr ? 'In review · its pull request is open' : 'In review'
      : issue.status === 'in_plan'
        ? 'Merged into the plan · ships with the plan’s pull request'
        : plan ? 'Done · shipped with the plan' : 'Done';
  const pr = issue.status === 'in_plan' ? (plan?.pr ?? issue.pr) : issue.pr;
  return (
    <div className={t.nextStep} data-testid="task-outcome">
      <span className={t.outcome}>
        <StatusIcon status={issue.status} />
        {what}
      </span>
      {issue.branch ? <span className={t.mono}>{issue.branch}</span> : null}
      <span className={t.grow} />
      {pr ? <PrLink pr={pr} /> : null}
      {plan ? (
        <Button size="small" variant="quiet" icon="graph" onClick={() => openPlan(plan.id)}>
          Open the Plan
        </Button>
      ) : null}
      {live ? (
        <>
          <Button size="small" variant="quiet" icon="folder" onClick={() => void showWorktreeFolder(client, live.id)}>
            {revealWords}
          </Button>
          <Button size="small" icon="branch" onClick={() => openWorktree(live.id)}>
            Open Worktree
          </Button>
        </>
      ) : ws ? (
        <Button size="small" icon="chat" onClick={() => openWorktree(ws.id)}>
          Open the Conversation
        </Button>
      ) : null}
    </div>
  );
}

function PrLink({ pr }: { pr: NonNullable<Issue['pr']> }) {
  const actions = useActions();
  return (
    <button type="button" className={t.prLink} onClick={() => actions.openLink({ kind: 'url', url: pr.url })}>
      <PrChip pr={pr} />
      <span className={t.prTitle}>{pr.title}</span>
      <Icon name="external" size={11} />
    </button>
  );
}

/** The right column: every property, each one a menu. */
function Properties({ issue }: { issue: Issue }) {
  const board = useBoard();
  const solo = useSolo(issue.projectId);
  const selfId = useSelfId();
  const { api, act, open } = useTaskActions();
  const project = useApp((s) => s.projects.find((p) => p.id === issue.projectId));
  const parent = issue.parent ? issueById(board, issue.parent) : undefined;
  const due = issue.due ? dueText(issue.due) : undefined;
  const parents = board.issues.filter((i) => i.id !== issue.id && boardOf(i) === boardOf(issue) && i.parent !== issue.id);
  const several = useSeveralRepos(issue);
  const boardTitle = useApp((s) => boardName(s.board, boardOf(issue), (id) => s.projects.find((p) => p.id === id)?.name));
  return (
    <aside className={t.props} aria-label="Properties">
      <Prop label="Status">
        <StatusPicker issue={issue} align="end">
          <button type="button" className={t.propValue}>
            <StatusIcon status={issue.status} />
            {STATUS_INFO[issue.status].label}
          </button>
        </StatusPicker>
      </Prop>
      {/* A board of several repos: the one it runs in (Start makes its worktree there). */}
      {several ? (
        <Prop label="Repo">
          <RepoPicker issue={issue}>
            <button type="button" className={t.propValue}>
              <ProjectIcon id={issue.projectId} name={project?.name ?? 'Repo'} size={16} />
              {project?.name ?? 'Repo'}
            </button>
          </RepoPicker>
        </Prop>
      ) : null}
      <Prop label="Priority">
        <PriorityPicker issue={issue} align="end">
          <button type="button" className={t.propValue}>
            <PriorityIcon priority={issue.priority} />
            {PRIORITY_INFO[issue.priority].label}
          </button>
        </PriorityPicker>
      </Prop>
      {solo ? null : <Prop label="Assignee">
        <AssigneePicker projectId={issue.projectId} value={issue.assignee} onChange={(a) => void act(() => api.update(issue.id, { assignee: a }))} align="end">
          <button type="button" className={t.propValue}>
            <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />
            {assigneeName(issue.assignee, selfId)}
          </button>
        </AssigneePicker>
      </Prop>}
      <AgentProp issue={issue} />
      <Prop label="Labels">
        <div className={t.propLabels}>
          {issue.labels.map((l) => (
            <LabelChip key={l} label={l} projectId={boardOf(issue)} onRemove={() => void act(() => api.update(issue.id, { labels: issue.labels.filter((x) => x !== l) }))} />
          ))}
          <LabelsPicker issue={issue} align="end">
            <button type="button" className={cx(t.propValue, t.propAdd)}>
              <Icon name="plus" size={11} />
              {issue.labels.length ? '' : 'Add Label'}
            </button>
          </LabelsPicker>
        </div>
      </Prop>
      <Prop label="Estimate">
        <div className={t.estimates} role="radiogroup" aria-label="Estimate">
          {[1, 2, 3, 5, 8].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={issue.estimate === n} className={cx(t.estimate, issue.estimate === n && t.estimateOn)} onClick={() => void act(() => api.update(issue.id, { estimate: issue.estimate === n ? null : n }))}>
              {n}
            </button>
          ))}
        </div>
      </Prop>
      <Prop label="Due">
        <DuePicker issue={issue} late={Boolean(due?.late && STATUS_INFO[issue.status].open)} text={due?.text} />
      </Prop>
      <Prop label="Parent">
        {parent ? (
          <div className={t.propRow}>
            <button type="button" className={t.propValue} onClick={() => open(parent)}>
              <StatusIcon status={parent.status} />
              <span className={t.ellipsis}>
                {parent.key} {parent.title}
              </span>
            </button>
            <IconButton size="small" icon="x" label="Make It a Task of Its Own" onClick={() => void act(() => api.update(issue.id, { parent: null }))} />
          </div>
        ) : (
          <TaskPicker label="Parent" candidates={parents} onPick={(p) => void act(() => api.update(issue.id, { parent: p.id }))} align="end">
            <button type="button" className={cx(t.propValue, t.propAdd)}>
              <Icon name="plus" size={11} />
              Set Parent
            </button>
          </TaskPicker>
        )}
      </Prop>
      <div className={t.propsRule} />
      {/* On a board of several repos the repo is up top: here, the board it's on. */}
      <Prop label={several ? 'Board' : 'Project'} quiet>
        <span className={t.propStatic}>{several ? boardTitle : (project?.name ?? '—')}</span>
      </Prop>
      {issue.branch ? (
        <Prop label="Branch" quiet>
          <Tip label={issue.branch}>
            <span className={cx(t.propStatic, t.mono, t.ellipsis)}>{issue.branch}</span>
          </Tip>
        </Prop>
      ) : null}
      {issue.link ? <TrackerLink link={issue.link} /> : null}
      <GitHubIssueProp issue={issue} Prop={Prop} />
      <Prop label="Created" quiet>
        <span className={t.propStatic}>
          {ago(issue.createdAt)} by {actorName(issue.createdBy, selfId)}
        </span>
      </Prop>
      <Prop label="Updated" quiet>
        <span className={t.propStatic}>{ago(issue.updatedAt)}</span>
      </Prop>
    </aside>
  );
}

/**
 * Who works the task, shown, never changed here (BLG-569): with a worktree on it, the agent and model
 * running there (a click opens its conversation, where they're changed); before it starts, the one
 * that will (Start › Start with another agent picks another for that start).
 */
function AgentProp({ issue }: { issue: Issue }) {
  const { live } = useTaskWorktree(issue);
  const { openWorktree } = useTaskActions();
  const { who } = useTaskStart(issue);
  const mine = useMyAgentName();
  const running = useApp((s) => (live ? pickedAgent(agentPicker(pickerState(s), `ws:${live.id}`, myRuntime(s.prefs))) : undefined), sameAgent);
  if (running && live) {
    return (
      <Prop label="Agent">
        <button type="button" className={t.propValue} onClick={() => openWorktree(live.id)} title={`Running in ${live.name}: change it in its conversation`} aria-label={`Agent: ${agentName(running, { model: true })}, in ${live.name}`}>
          <Icon name={runtimeMark(running.runtime)} size={13} />
          {agentName(running, { model: true })}
        </button>
      </Prop>
    );
  }
  if (!isStartable(issue)) return null;
  return (
    <Prop label="Agent" quiet>
      <span className={t.propStatic} title="Works it when it starts: Start › Start with another agent picks another">
        {who === 'your agent' ? `Your agent (${mine})` : who}
      </span>
    </Prop>
  );
}

const sameAgent = (a: AgentRef | undefined, b: AgentRef | undefined): boolean => a?.runtime === b?.runtime && a?.label === b?.label && a?.model === b?.model;

/** A due date: the Mac's date picker from a plain button, and a way to clear it. */
function DuePicker({ issue, late, text }: { issue: Issue; late: boolean; text: string | undefined }) {
  const { api, act } = useTaskActions();
  const input = useRef<HTMLInputElement>(null);
  const pick = (): void => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <div className={t.propRow}>
      <button type="button" className={cx(t.propValue, !issue.due && t.propAdd, late && t.dueLate)} onClick={pick}>
        <Icon name="calendar" size={12} />
        {issue.due ? `${new Date(`${issue.due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · ${text ?? ''}` : 'Set Due Date'}
      </button>
      {issue.due ? <IconButton size="small" icon="x" label="Remove the Due Date" onClick={() => void act(() => api.update(issue.id, { due: null }))} /> : null}
      <input ref={input} type="date" className={t.dateHidden} tabIndex={-1} aria-hidden="true" value={issue.due ?? ''} onChange={(e) => void act(() => api.update(issue.id, { due: e.target.value || null }))} />
    </div>
  );
}

/** The same task in Linear (kept in step by sync): its key, opening it there. */
function TrackerLink({ link }: { link: NonNullable<Issue['link']> }) {
  const actions = useActions();
  const name = PROVIDER_INFO[link.provider].label;
  return (
    <Prop label={name} quiet>
      <Tip label={`Open ${link.key} in ${name}`}>
        <button type="button" className={t.propValue} onClick={() => actions.openLink({ kind: 'url', url: link.url })}>
          <span className={t.mono}>{link.key}</span>
          <Icon name="external" size={11} />
        </button>
      </Tip>
    </Prop>
  );
}

function Prop({ label, children, quiet }: { label: string; children: React.ReactNode; quiet?: boolean }) {
  return (
    <div className={cx(t.prop, quiet && t.propStaticRow)}>
      <span className={t.propLabel}>{label}</span>
      <div className={t.propControl}>{children}</div>
    </div>
  );
}
