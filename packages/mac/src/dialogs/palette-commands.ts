import { type AppState, channelOf } from '@beluga/core/store.js';
import { canRunOn } from '@beluga/core/trust.js';
import { type WorkspaceAction, findWorkspace, workspaceButtons } from '@beluga/ui/workspace-models.js';
import type { IconName } from '../components/Icon.js';
import type { Actions } from '../lib/actions.js';
import type { UiStore } from '../lib/beluga.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { openSettings } from '../lib/native-routes.js';
import { openSheet } from '../lib/sheets.js';
import { openEarnings } from '../lib/earnings.js';
import { openSupport } from '../lib/support.js';
import { SHOW_WELCOME } from '../onboarding/onboarding-model.js';
import { previewRequestPopup } from '../gateway/request-native.js';
import { revealLabel } from '../lib/os-words.js';

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: IconName;
  readonly run: () => void;
  readonly keywords?: string[];
}

interface Ctx {
  readonly client: SocketClient;
  readonly ui: UiStore;
  readonly actions: Actions;
  readonly state: AppState;
}

/** One command: a name you'd look for, what it does, and the /command it stands for (so typing that finds it too). */
const cmd = (slash: string, id: string, label: string, icon: IconName, run: () => void, hint?: string): PaletteCommand => ({ id: `cmd:${id}`, label, icon, run, keywords: [`/${slash}`, slash], ...(hint ? { hint } : {}) });

/** What you can do in the workspace on screen that its toolbar buttons (the palette's "Here") don't already list. */
function workspaceCommands({ ui, actions, state }: Ctx): PaletteCommand[] {
  const ws = state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
  if (!ws || ws.archived) return [];
  const here = new Set(workspaceButtons(state, ws).filter((b) => !b.disabled).map((b) => b.action));
  const act = (action: WorkspaceAction) => () => actions.run({ type: 'ws', id: ws.id, action });
  const project = state.projects.find((p) => p.id === ws.projectId);
  const worktree = ws.kind === 'worktree';
  const list: Array<[WorkspaceAction, PaletteCommand, boolean]> = [
    ['pr', cmd('pr', 'pr', state.prs[ws.id] ? 'Pull Request…' : 'Create Pull Request…', 'pr', act('pr'), 'Your agent pushes and opens one'), worktree],
    ['fork', cmd('fork', 'fork', 'Fork This Workspace…', 'branch', act('fork'), 'A copy with its conversation'), ws.kind !== 'chat'],
    ['handoff', cmd('handoff', 'handoff', 'Hand Off to Someone…', 'hand', act('handoff'), 'Their agent continues it'), worktree],
    ['commit', cmd('commit', 'commit', 'Commit All Changes…', 'commit', act('commit')), worktree && Boolean(ws.status?.changed)],
    ['merge', cmd('merge', 'merge', 'Merge into the Main Folder…', 'merge', act('merge')), worktree],
    ['compact', cmd('compact', 'compact', 'Compact the Conversation…', 'wand', act('compact'), 'Your agent keeps what matters'), true],
    ['run', cmd('run', 'run', 'Run the Project', 'play', act('run')), Boolean(project?.scripts?.run)],
    ['setup', cmd('setup', 'setup', 'Run Setup Again', 'refresh', act('setup')), Boolean(project?.scripts?.setup)],
    ['finder', cmd('finder', 'finder', revealLabel(), 'folder', act('finder')), true],
    ['archive', cmd('archive', 'archive', 'Archive This Workspace…', 'archive', act('archive')), ws.kind !== 'main'],
    ['delete', cmd('delete', 'delete', 'Delete This Workspace…', 'alert', act('delete')), ws.kind !== 'main'],
  ];
  return [
    ...list.filter(([action, , ok]) => ok && !here.has(action)).map(([, c]) => c),
    ...(project?.root ? [cmd('project', 'scripts', 'Project Settings…', 'terminal', () => ui.openMenu({ kind: 'scripts', projectId: project.id }), 'Setup and Run commands')] : []),
  ];
}

/**
 * The /commands as things to do: a name you'd look for, no `<arg>` syntax. The ones that need
 * more (a name, a command, a note for Claude) open their sheet; nothing is typed for you.
 */
export function paletteCommands(ctx: Ctx): PaletteCommand[] {
  const { client, ui, state } = ctx;
  const api = client.api;
  const channel = channelOf(state.view);
  const talking = state.view.kind === 'room' || state.view.kind === 'assistant' || state.view.kind === 'workspace';
  const following = state.peers.find((p) => p.peerId === state.follow);
  const canRun = state.peers.some((p) => canRunOn(state.granted[p.peerId]?.level));
  return [
    ...workspaceCommands(ctx),
    ...(talking
      ? [
          cmd('clear', 'clear', state.view.kind === 'room' ? 'Clear the Group Chat…' : 'Clear This Conversation…', 'x', () => ui.openMenu({ kind: 'clear', channel, host: state.isHost })),
          cmd('plan', 'plan', state.planMode[channel] ? 'Turn Off Plan First' : 'Turn On Plan First', 'claude', () => ctx.actions.run({ type: 'plan_toggle', channel }), 'Your agent plans, you approve, then it works'),
          cmd('visualize', 'visualize', 'Draw This as a Graph', 'grid', () => void api.session.submit('/visualize', { channel }), 'Your agent draws this conversation as an interactive diagram'),
          cmd('model', 'model', 'Choose the Model…', 'spark', () => ui.openMenu({ kind: 'model', ...(channel === 'room' ? {} : { channel }) }), 'For this conversation'),
        ]
      : []),
    ...(state.board.enabled
      ? [
          { id: 'tasks:new', label: 'New Task…', icon: 'task' as const, hint: 'Plan a piece of work', keywords: ['task', 'issue', 'todo', 'ticket'], run: () => openSheet({ kind: 'new_task' }) },
          { id: 'plans:new', label: 'New Plan…', icon: 'flag' as const, hint: 'Plan big work with your agent: milestones, tasks, what runs side by side', keywords: ['plan', 'milestone', 'roadmap', 'project'], run: () => openSheet({ kind: 'new_plan' }) },
          { id: 'plans:open', label: 'Go to Plans', icon: 'flag' as const, hint: 'Your plans, project by project', keywords: ['plans', 'milestones', 'roadmap'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'plans' } }) },
          { id: 'tasks:open', label: 'Go to Tasks', icon: 'task' as const, hint: 'Every project’s board', keywords: ['tasks', 'board', 'issues', 'backlog', 'kanban'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'tasks' } }) },
          { id: 'issues:open', label: 'Go to Issues', icon: 'issue' as const, hint: 'A project’s GitHub issues: your agent investigates, fixes, or writes them up as tasks', keywords: ['issues', 'github', 'bugs', 'triage', 'investigate', 'fix'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'issues' } }) },
          { id: 'pulls:open', label: 'Go to Pull Requests', icon: 'pr' as const, hint: 'A project’s open pull requests on GitHub, anyone’s: open one in a worktree', keywords: ['pull requests', 'prs', 'pulls', 'github', 'review', 'merge'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'pulls' } }) },
          { id: 'actions:open', label: 'Go to Actions', icon: 'pulse' as const, hint: 'A project’s GitHub Actions: runs as they go, and each workflow as a graph', keywords: ['actions', 'github', 'ci', 'workflows', 'runs', 'builds', 'checks', 'pipeline'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'actions' } }) },
        ]
      : []),
    ...(state.sentinel.enabled
      ? [
          { id: 'sentinel:open', label: 'Go to Sentinel', icon: 'sentinel' as const, hint: 'Watchers that run your agent, a script or a notification on a schedule', keywords: ['sentinel', 'schedule', 'cron', 'watch', 'every morning', 'brief', 'recurring'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'sentinel' } }) },
          { id: 'dashboard:open', label: 'Go to Dashboard', icon: 'gauge' as const, hint: 'Sentinel’s dashboard: what your sentinels keep, as tiles', keywords: ['dashboard', 'numbers', 'metrics', 'kpi', 'stats', 'revenue', 'subscribers', 'tiles'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'dashboard' } }) },
          { id: 'sentinel:chat', label: 'Go to Sentinel Chat', icon: 'chat' as const, hint: 'Talk to your agent about all of Sentinel', keywords: ['sentinel', 'chat', 'ask', 'watchers'], run: () => ctx.actions.run({ type: 'view', view: { kind: 'sentinel_chat', ...(ctx.state.sentinel.chats?.active ? { chat: ctx.state.sentinel.chats.active } : {}) } }) },
          { id: 'sentinel:new', label: 'New Sentinel…', icon: 'sentinel' as const, hint: 'Say what it should do, start from a recipe, or build it yourself', keywords: ['sentinel', 'schedule', 'cron', 'watch', 'recipe', 'automate'], run: () => openSheet({ kind: 'new_sentinel' }) },
        ]
      : []),
    cmd('template', 'template-new', 'New Template…', 'wand', () => openSheet({ kind: 'template' }), 'A way to start a task you do often'),
    cmd('template', 'templates', 'Manage Templates…', 'wand', () => ui.openMenu({ kind: 'templates', manage: true })),
    ...(canRun ? [cmd('run', 'peer-run', 'Run a Command on a Friend’s Computer…', 'terminal', () => openSheet({ kind: 'peer_run' }), 'The output shows in the chat')] : []),
    ...(following ? [cmd('unfollow', 'unfollow', `Stop Following ${following.name}`, 'eye', () => void api.session.follow(undefined))] : []),
    ...(state.myShares.length ? [cmd('unshare', 'unshare', 'Stop Sharing a Folder…', 'share', () => ui.openMenu({ kind: 'share_folder', launchDir: client.launchDir, mine: state.myShares }))] : []),
    cmd('name', 'name', 'Change Your Name…', 'person', () => openSettings(ui, 'general', 'settings-name'), state.self?.name ? `Now: ${state.self.name}` : undefined),
    cmd('people', 'people', 'People & Access…', 'people', () => openSettings(ui, 'people'), 'Who can use your agent, and how'),
    earningsCommand(state),
    { id: 'cmd:support', label: 'Star Beluga on GitHub…', icon: 'star', hint: 'Stars are how other developers find Beluga', keywords: ['support', 'star', 'github', 'sponsor'], run: () => openSupport() },
    cmd('env', 'env', 'Environment Variables…', 'lock', () => openSettings(ui, 'environment'), 'For your shells, scripts and agents'),
    cmd('shell', 'shell', 'Terminal Settings…', 'terminal', () => openSettings(ui, 'terminal'), 'Which shell, and how it starts'),
    {
      id: 'cmd:popup-preview',
      label: 'Preview Request Pop-up',
      icon: 'bell',
      hint: 'The card a friend’s request, or your agent needing you, gets on top of other apps (a pretend one)',
      keywords: ['popup', 'pop-up', 'request', 'notification', 'preview', 'test', 'friend'],
      run: previewRequestPopup,
    },
    { id: 'cmd:welcome', label: 'Onboard Again', icon: 'spark', hint: 'The welcome, the tour and the first settings', keywords: ['onboarding', 'welcome', 'tour', 'intro'], run: () => void document.dispatchEvent(new CustomEvent(SHOW_WELCOME)) },
    ...(state.isHost
      ? [
          cmd('lock', 'lock', state.roomOpen ? 'Close the Room to New People' : 'Let New People Join', 'lock', () => void api.session.setRoomOpen(!state.roomOpen)),
          cmd('newlink', 'newlink', 'Make a New Invite Link…', 'link', () =>
            openSheet({ kind: 'confirm', title: 'Make a new invite link?', message: 'The current link stops working. People already in the room stay.', confirm: 'New Link', run: () => void api.session.newInviteLink() }),
          ),
        ]
      : [cmd('quit', 'quit', 'Leave the Room…', 'x', () => openSheet({ kind: 'confirm', title: 'Leave the room?', message: 'Beluga disconnects and closes. You can come back with the invite link.', confirm: 'Leave', destructive: true, run: () => void api.session.quit() }))]),
  ];
}

/** Connect earnings (or see them) for the project on screen, or pick one in the sheet. */
function earningsCommand(state: AppState): PaletteCommand {
  const ws = state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
  const project = state.projects.find((p) => p.root && p.id === ws?.projectId);
  const connected = project ? Boolean(state.earnings[project.root] || state.revenuecat[project.root]) : false;
  return {
    id: 'cmd:earnings',
    label: project ? (connected ? `${project.name} Earnings…` : `Connect Earnings to ${project.name}…`) : 'Connect Earnings…',
    hint: 'All-time earnings beside a project in the sidebar',
    icon: 'coin',
    keywords: ['stripe', 'revenuecat', 'earnings', 'revenue', 'money', 'sales'],
    run: () => openEarnings(project?.id),
  };
}
