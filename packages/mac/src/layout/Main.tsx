import { Suspense, useEffect, useRef, useState } from 'react';
import { useApp, useBeluga } from '../lib/beluga.js';
import { groupChatOpen } from '../lib/group-chat.js';
import { ViewBoundary, lazyView } from '../lib/lazy-view.js';
import { useMaking } from '../lib/making.js';
import { MakingWorktree } from './MakingWorktree.js';
import { ChatView } from '../views/ChatView.js';
import { Toolbar } from './Toolbar.js';
import { ProjectCenter, WorkspaceCenter } from './panel/FocusView.js';
import { TerminalDrawer } from './panel/TerminalDrawer.js';
import { WorkFrame } from '../work/WorkNav.js';
import s from './Shell.module.css';
import { SharedPlanPage } from '../team/SharedPlans.js';
import { CallRoom } from '../call/CallRoom.js';
import { StartingThere } from '../machines/StartingThere.js';
import { useStarting } from '../machines/start-there.js';

const OverviewView = lazyView('views/OverviewView', () => import('../views/OverviewView.js').then((m) => m.OverviewView));
const SearchView = lazyView('views/SearchView', () => import('../views/SearchView.js').then((m) => m.SearchView));
const UsageView = lazyView('views/UsageView', () => import('../views/UsageView.js').then((m) => m.UsageView));
const FilesView = lazyView('views/FilesView', () => import('../views/FilesView.js').then((m) => m.FilesView));
const DiffView = lazyView('views/DiffView', () => import('../views/DiffView.js').then((m) => m.DiffView));
const ConversationView = lazyView('network/ConversationView', () => import('../network/ConversationView.js').then((m) => m.ConversationView));
const TerminalView = lazyView('views/TerminalView', () => import('../views/TerminalView.js').then((m) => m.TerminalView));
const ActivityView = lazyView('claude-code/ActivityView', () => import('../claude-code/ActivityView.js').then((m) => m.ActivityView));
const ProjectHome = lazyView('views/ProjectHome', () => import('../views/ProjectHome.js').then((m) => m.ProjectHome), 'first');
const HistoryView = lazyView('views/history/HistoryView', () => import('../views/history/HistoryView.js').then((m) => m.HistoryView));
const WorktreesView = lazyView('views/worktrees/WorktreesView', () => import('../views/worktrees/WorktreesView.js').then((m) => m.WorktreesView));
const RequestsView = lazyView('gateway/RequestsView', () => import('../gateway/RequestsView.js').then((m) => m.RequestsView));
const TasksView = lazyView('tasks/TasksView', () => import('../tasks/TasksView.js').then((m) => m.TasksView));
const TaskPage = lazyView('tasks/TaskPage', () => import('../tasks/TaskPage.js').then((m) => m.TaskPage));
const IssuesView = lazyView('issues/IssuesView', () => import('../issues/IssuesView.js').then((m) => m.IssuesView));
const IssuePage = lazyView('issues/IssuePage', () => import('../issues/IssuePage.js').then((m) => m.IssuePage));
const ActionsView = lazyView('ci/ActionsView', () => import('../ci/ActionsView.js').then((m) => m.ActionsView));
const PullsView = lazyView('issues/PullsView', () => import('../issues/PullsView.js').then((m) => m.PullsView));
const RunPage = lazyView('ci/RunPage', () => import('../ci/RunPage.js').then((m) => m.RunPage));
const PlansView = lazyView('plans/PlansView', () => import('../plans/PlansView.js').then((m) => m.PlansView));
const PlanPage = lazyView('plans/PlanPage', () => import('../plans/PlanPage.js').then((m) => m.PlanPage));
const SentinelPage = lazyView('sentinel/SentinelPage', () => import('../sentinel/SentinelPage.js').then((m) => m.SentinelPage));
const SentinelRunPage = lazyView('sentinel/RunPage', () => import('../sentinel/RunPage.js').then((m) => m.RunPage));
const SentinelHome = lazyView('sentinel/SentinelHome', () => import('../sentinel/SentinelHome.js').then((m) => m.SentinelHome));
const PhoneView = lazyView('phone/PhoneView', () => import('../phone/PhoneView.js').then((m) => m.PhoneView));

/**
 * The room's group chat with its call around it (BLG-716), while someone else is in the room.
 * Alone, it's no place (BLG-871): what still opens it (Back, a notification, /room, the phone's
 * Open on your Mac) goes to Overview. Someone leaving while you read it leaves you where you are.
 */
function RoomChat() {
  const { client } = useBeluga();
  const [open] = useState(() => groupChatOpen(client.store.getState()));
  useEffect(() => {
    if (!open) client.store.dispatch({ type: 'view', view: { kind: 'overview' } });
  }, [open, client]);
  if (!open) return null;
  return (
    <CallRoom id="room">
      <ChatView />
    </CallRoom>
  );
}

function Route() {
  const view = useApp((st) => st.view);
  const making = useMaking();
  // New work on its way to one of your computers (BLG-788): its steps here until it opens there.
  const starting = useStarting(view);
  if (starting) return <StartingThere start={starting} />;
  if (making) return <MakingWorktree />;
  switch (view.kind) {
    case 'room':
      return <RoomChat />;
    case 'assistant':
    case 'draft':
    case 'draft_worktree':
      return <ChatView />;
    case 'workspace':
      // Always the conversation; its changes, files and terminal are in the right panel (a diff or a file can take the center for a while).
      return <WorkspaceCenter />;
    case 'shared':
      // Its Files tab browses and searches.
      return view.tab === 'chat' ? <ChatView /> : view.tab === 'diff' ? <DiffView /> : <FilesView />;
    case 'overview':
      return <OverviewView />;
    case 'search':
      return <SearchView />;
    case 'usage':
      return <UsageView />;
    case 'files':
      return <FilesView />;
    case 'terminal':
      return <TerminalView />;
    case 'phone':
      return <PhoneView />;
    case 'conversation':
      return <ConversationView id={view.id} />;
    case 'claude_code':
      return <ActivityView />;
    case 'requests':
      return <RequestsView />;
    case 'tasks':
      return <WorkFrame page="tasks"><TasksView /></WorkFrame>;
    case 'task':
      return <TaskPage key={view.id} id={view.id} />;
    case 'issues':
      return <WorkFrame page="issues"><IssuesView /></WorkFrame>;
    case 'gh_issue':
      return <IssuePage key={`${view.projectId}#${view.number}`} projectId={view.projectId} number={view.number} />;
    case 'pulls':
      return <WorkFrame page="pulls"><PullsView /></WorkFrame>;
    case 'actions':
      return <WorkFrame page="actions"><ActionsView /></WorkFrame>;
    case 'gh_run':
      return <RunPage key={`${view.projectId}#${view.runId}`} projectId={view.projectId} runId={view.runId} />;
    case 'plans':
      return <WorkFrame page="plans"><PlansView /></WorkFrame>;
    case 'plan':
      return <PlanPage key={view.id} id={view.id} task={view.task} />;
    case 'team_plan':
      return <WorkFrame page="plans"><SharedPlanPage key={`${view.owner}/${view.id}`} owner={view.owner} id={view.id} /></WorkFrame>;
    // Sentinel is one page (BLG-300): its board is on it, its chat docks beside it; the old views land there.
    case 'sentinel_chat':
      // Asked from a sentinel's own page: that page stays, the chat beside it.
      if (view.about) return <SentinelPage key={view.about} id={view.about} />;
      return <SentinelHome />;
    case 'sentinel':
    case 'dashboard':
      return <SentinelHome />;
    case 'sentinel_page':
      return <SentinelPage key={view.id} id={view.id} />;
    case 'sentinel_run':
      return <SentinelRunPage key={view.runId} runId={view.runId} />;
    case 'worktrees':
      return <WorktreesView projectId={view.projectId} />;
    case 'project':
      return view.page === 'history' ? <HistoryView projectId={view.id} /> : (
        <ProjectCenter>
          <ProjectHome id={view.id} />
        </ProjectCenter>
      );
  }
}

export function Main() {
  const at = useApp((st) => JSON.stringify(st.view));
  const column = useRef<HTMLElement>(null);
  const making = useMaking();
  return (
    <main ref={column} className={s.main}>
      <Toolbar />
      <ViewBoundary at={at}>
        <Suspense fallback={<div className={s.loading} />}>
          <Route />
        </Suspense>
      </ViewBoundary>
      {/* Nothing to run in a worktree that isn't there yet. */}
      {making ? null : <TerminalDrawer column={column} />}
    </main>
  );
}
