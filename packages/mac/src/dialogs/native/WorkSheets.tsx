import { NewLabelSheet } from '../../tasks/NewLabelSheet.js';
import { ProjectContextSheet } from '../../tasks/ProjectContextSheet.js';
import { EnvironmentSheet, WorktreeEnvSheet } from '../EnvironmentSheet.js';
import { NewTaskSheet } from '../../tasks/NewTaskSheet.js';
import { BoardSheet } from '../../tasks/boards.js';
import { NewSentinelSheet } from '../../sentinel/NewSentinelSheet.js';
import { AddTileSheet } from '../../sentinel/AddTileSheet.js';
import { DocumentSheet } from '../../sentinel/DocumentSheet.js';
import { DataSheet } from '../../sentinel/DataSheet.js';
import { ShareProjectSheet } from './ShareProjectSheet.js';
import { SyncSheet } from '../../tasks/SyncSheet.js';
import { NewPlanSheet, PlanModeSheet, PlanStyleSheet, SendBackSheet } from '../../plans/PlanSheets.js';
import { useState } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { canRunOn } from '@beluga/core/trust.js';
import { menuSpec } from '@beluga/ui/menus.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Alert } from '../../components/Alert.js';
import { Field, FormSheet, Popup, TextInput } from '../../components/FormSheet.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga, useMachine } from '../../lib/beluga.js';
import { type NativeSheet, closeSheet, useSheet } from '../../lib/sheets.js';
import { RemoteWorktreeForm } from './RemoteWorktreeSheet.js';
import { TemplateEditorSheet } from './TemplatesSheet.js';
import { ContinueSheet } from './ContinueSheet.js';
import { ForkToMacSheet } from './ForkToMacSheet.js';
import { ImportConversationSheet } from './ImportConversationSheet.js';
import { CleanUpWorktreesAlert } from './CleanUpWorktrees.js';
import { DeleteProjectAlert } from './DeleteProjectAlert.js';
import { WorkConfirm } from './WorkConfirm.js';
import { GitTroubleSheet } from './GitTroubleSheet.js';

/** The folder and branch name Beluga makes from a name (as the core's `slug` does). */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Fork a workspace: a copy of all of it (commits, uncommitted changes, Scratch, conversation), under a new name. */
function ForkSheet({ wsId, close }: { wsId: string; close: () => void }) {
  const api = useApi();
  const ws = useApp((st) => findWorkspace(st.projects, wsId));
  const siblings = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === wsId))?.workspaces);
  const [name, setName] = useState(ws ? `${ws.name}-2` : '');
  if (!ws) return null;
  const taken = siblings?.some((w) => w.name === slug(name));
  return (
    <FormSheet
      title={`Fork “${ws.name}”`}
      icon="branch"
      intro="A new worktree that starts exactly where this one is: its commits, uncommitted changes, Scratch and conversation, so you can try another direction. This one stays as it is."
      submitLabel="Fork"
      canSubmit={Boolean(slug(name)) && !taken}
      onSubmit={() => {
        void api.workspaces.fork(ws.id, name.trim());
        close();
      }}
      onCancel={close}
      width={500}
    >
      <Field label="Name" htmlFor="fork-name" error={taken ? 'A workspace in this project has this name.' : undefined} hint={slug(name) ? <>Branch <code>beluga/{slug(name)}</code></> : undefined}>
        <TextInput id="fork-name" value={name} onChange={setName} maxLength={120} invalid={taken} />
      </Field>
    </FormSheet>
  );
}

/** Run one command on a friend's computer; the output shows in this chat. */
function PeerRunSheet({ peerId, close }: { peerId?: string; close: () => void }) {
  const api = useApi();
  const peers = useApp((st) => st.peers);
  const granted = useApp((st) => st.granted);
  const view = useApp((st) => st.view);
  const able = peers.filter((p) => canRunOn(granted[p.peerId]?.level));
  const [who, setWho] = useState(peerId ?? able[0]?.peerId ?? '');
  const [command, setCommand] = useState('');
  const peer = peers.find((p) => p.peerId === who);
  const full = granted[who]?.level === 'full';
  if (!able.length && !peer) {
    return (
      <Alert
        icon="terminal"
        tone="info"
        title="Nobody lets you run commands yet"
        message="When a friend lets your agent run commands on their computer, you can run one there yourself too. They choose that in their People settings."
        cancel={false}
        confirm={{ label: 'OK', onClick: close }}
        onCancel={close}
      />
    );
  }
  return (
    <FormSheet
      title={peer ? `Run a Command on ${peer.name}’s Computer` : 'Run a Command on a Friend’s Computer'}
      icon="terminal"
      intro={peer ? (full ? 'It runs right away. The output shows in this chat.' : `${peer.name} approves it first. The output shows in this chat.`) : 'The output shows in this chat.'}
      submitLabel="Run"
      canSubmit={Boolean(peer && command.trim())}
      onSubmit={() => {
        if (!peer) return;
        void api.session.runOnPeerByHand(peer.name, command.trim(), channelOf(view));
        close();
      }}
      onCancel={close}
      width={520}
    >
      {peerId ? null : (
        <Field label="On" htmlFor="run-peer">
          <Popup id="run-peer" label="Whose computer" value={who} onChange={setWho} options={able.map((p) => ({ value: p.peerId, label: `${p.name}’s computer` }))} />
        </Field>
      )}
      <Field label="Command" htmlFor="run-command">
        <TextInput id="run-command" value={command} onChange={setCommand} mono placeholder="npm test" data-autofocus />
      </Field>
    </FormSheet>
  );
}

/** What removing or leaving does, asked before the menu option runs. */
function OptionAlert({ sheet, close }: { sheet: Extract<NativeSheet, { kind: 'confirm_option' }>; close: () => void }) {
  const actions = useActions();
  const { client } = useBeluga();
  const state = client.store.getState();
  const go = (): void => {
    close();
    actions.pick(sheet.menu, sheet.index, true);
  };
  const { menu } = sheet;
  const project = menu.kind === 'project' ? state.projects.find((p) => p.id === menu.id) : undefined;
  const shared = menu.kind === 'shared' ? state.shared.find((w) => w.owner === menu.owner && w.id === menu.id) : undefined;
  const owner = shared ? (state.peers.find((p) => p.peerId === shared.owner)?.name ?? 'The owner') : '';
  switch (sheet.id) {
    case 'p-hide':
      return (
        <Alert
          icon="eye"
          tone="info"
          title={`Hide “${project?.name ?? 'this project'}”?`}
          message="It leaves the sidebar. Nothing is deleted: its folder and worktrees stay on disk, and you can add it back any time with Add Project."
          confirm={{ label: 'Hide Project', onClick: go }}
          onCancel={close}
        />
      );
    case 'sh-leave':
      return (
        <Alert
          icon="share"
          tone="caution"
          title={`Leave “${shared?.name ?? 'this workspace'}”?`}
          message={`You stop seeing its chat and files. ${owner} can invite you again.`}
          confirm={{ label: 'Leave', destructive: true, onClick: go }}
          onCancel={close}
        />
      );
    default: {
      // Anything else that asks first: its own words from the menu.
      const option = menuSpec(state, menu)?.options[sheet.index];
      return <Alert title={`${option?.label ?? 'Continue'}?`} message={option?.hint} confirm={{ label: option?.label ?? 'OK', destructive: true, onClick: go }} onCancel={close} />;
    }
  }
}

/** Sheets this window opens instead of typing into the message box (see lib/sheets.ts). */
export function NativeSheets() {
  // A computer's page draws its own (machines/MachinePane.tsx); the window's, this Mac's.
  const sheet = useSheet(useMachine());
  if (!sheet) return null;
  const close = closeSheet;
  switch (sheet.kind) {
    case 'fork':
      return <ForkSheet key={sheet.wsId} wsId={sheet.wsId} close={close} />;
    case 'continue_worktree':
      return <ContinueSheet key={sheet.wsId} wsId={sheet.wsId} close={close} />;
    case 'fork_to_mac':
      return <ForkToMacSheet key={sheet.wsId} owner={sheet.owner} wsId={sheet.wsId} close={close} />;
    case 'peer_run':
      return <PeerRunSheet key={sheet.peerId ?? ''} {...(sheet.peerId ? { peerId: sheet.peerId } : {})} close={close} />;
    case 'template':
      return <TemplateEditorSheet close={close} />;
    case 'remote':
      return <RemoteWorktreeForm key={sheet.peerId} peerId={sheet.peerId} {...(sheet.project ? { project: sheet.project } : {})} close={close} />;
    case 'confirm_option':
      return <OptionAlert sheet={sheet} close={close} />;
    case 'work':
      return <WorkConfirm key={`${sheet.wsId}:${sheet.action}`} wsId={sheet.wsId} action={sheet.action} close={close} />;
    case 'clean_up_worktrees':
      return <CleanUpWorktreesAlert key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'delete_project':
      return <DeleteProjectAlert key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'import_conversation':
      return <ImportConversationSheet key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'share_project':
      return <ShareProjectSheet key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'new_task':
      return <NewTaskSheet {...(sheet.boardId ? { boardId: sheet.boardId } : {})} {...(sheet.projectId ? { projectId: sheet.projectId } : {})} {...(sheet.status ? { status: sheet.status } : {})} {...(sheet.parent ? { parent: sheet.parent } : {})} close={close} />;
    case 'task_board':
      return <BoardSheet key={sheet.boardId ?? 'new'} {...(sheet.boardId ? { boardId: sheet.boardId } : {})} {...(sheet.repos ? { repos: sheet.repos } : {})} close={close} />;
    case 'new_label':
      return <NewLabelSheet key={sheet.projectId} projectId={sheet.projectId} {...(sheet.issueId ? { issueId: sheet.issueId } : {})} close={close} />;
    case 'task_sync':
      return <SyncSheet key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'project_context':
      return <ProjectContextSheet key={sheet.projectId} projectId={sheet.projectId} close={close} />;
    case 'project_env':
      return <EnvironmentSheet key={sheet.projectId} projectId={sheet.projectId} {...(sheet.tab ? { tab: sheet.tab } : {})} close={close} />;
    case 'worktree_env':
      return <WorktreeEnvSheet key={sheet.workspaceId} workspaceId={sheet.workspaceId} close={close} />;
    case 'new_plan':
      return <NewPlanSheet {...(sheet.projectId ? { projectId: sheet.projectId } : {})} close={close} />;
    case 'new_sentinel':
      return <NewSentinelSheet {...(sheet.projectId ? { projectId: sheet.projectId } : {})} {...(sheet.way ? { way: sheet.way } : {})} close={close} />;
    case 'add_tile':
      return <AddTileSheet key={sheet.dashboardId} dashboardId={sheet.dashboardId} close={close} />;
    case 'sentinel_data':
      return <DataSheet key={`${sheet.sentinelId}:${sheet.metric}`} sentinelId={sheet.sentinelId} metric={sheet.metric} close={close} />;
    case 'sentinel_document':
      return <DocumentSheet key={`${sheet.source}:${sheet.name}`} source={sheet.source} sentinelId={sheet.sentinelId} metric={sheet.metric} column={sheet.column} name={sheet.name} close={close} />;
    case 'plan_style':
      return <PlanStyleSheet close={close} />;
    case 'plan_send_back':
      return <SendBackSheet planId={sheet.planId} milestone={sheet.milestone} close={close} />;
    case 'plan_mode':
      return <PlanModeSheet key={sheet.planId} planId={sheet.planId} close={close} />;
    case 'git_trouble':
      return <GitTroubleSheet key={`${sheet.wsId}:${sheet.trouble.kind}`} wsId={sheet.wsId} trouble={sheet.trouble} retry={sheet.retry} close={close} />;
    case 'share_copy':
      return <ShareCopyAlert sheet={sheet} close={close} />;
    case 'confirm':
      return (
        <Alert
          title={sheet.title}
          message={sheet.message}
          tone={sheet.destructive ? 'danger' : 'caution'}
          confirm={{
            label: sheet.confirm,
            destructive: sheet.destructive ?? false,
            onClick: () => {
              close();
              sheet.run();
            },
          }}
          {...(sheet.cancel ? { cancel: sheet.cancel } : {})}
          onCancel={close}
        />
      );
  }
}

/**
 * Their agent can't read your chat: a copy of its messages can go with yours, only if you say so.
 * Cancel keeps the words in the box; Send Without It sends them alone.
 */
function ShareCopyAlert({ sheet, close }: { sheet: Extract<NativeSheet, { kind: 'share_copy' }>; close: () => void }) {
  const named = sheet.titles.map((t) => `“${t}”`).join(', ');
  const one = sheet.titles.length === 1;
  return (
    <Alert
      title={`Share a copy of ${named} with ${sheet.person}?`}
      message={`${sheet.person}’s agent can’t read ${one ? 'that chat' : 'those chats'}. A copy of ${one ? 'its' : 'their'} messages, as ${one ? 'it is' : 'they are'} now, leaves this computer with your message: no tool output, secrets hidden.`}
      tone="info"
      icon="people"
      confirm={{ label: 'Share Copy', onClick: () => (close(), sheet.share()) }}
      alternative={{ label: 'Send Without It', onClick: () => (close(), sheet.without()) }}
      onCancel={close}
    />
  );
}
