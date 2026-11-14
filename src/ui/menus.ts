import type { AppState } from '../core/store.js';
import type { ThreadChildren } from '../shared/threads.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { clearMenu, invitePersonMenu, sharedMenu, wsShareMenu } from './collab-menus.js';
import { shareFolderMenu, shareWhoMenu } from './share-menus.js';
import { type InviteMenuKind, guestAddMenu, guestPersonMenu, inviteMenu } from './invite-menus.js';
import { type InboxView, type SettingsSection, inboxMenu, modelMenu, modelLabel, settingsMenu } from './settings-menus.js';
import { GRANT_INFO, TRUST_INFO, canRunOn, trustOf } from '../core/trust.js';
import { TRUST_LEVELS } from '../shared/settings-schema.js';
import { workMenuSpec, type WorkMenuKind } from './work-menus.js';
import { describeWindow } from '../agent/runtime/claude/usage.js';
import { type Usage, defaultAgentOf } from '../protocol.js';
import { agentLabel, agentName } from '../shared/agent-label.js';
import { contextFacts } from './context-facts.js';
import { FILE_MANAGER } from '../shared/assistant.js';

function usageLines(usage: Usage | undefined): string[] {
  if (!usage) return [];
  return [`Claude plan usage${usage.plan ? ` (${usage.plan})` : ''}:  5-hour ${describeWindow(usage.fiveHour)}   ·   week ${describeWindow(usage.week)}`];
}

export interface MenuOption {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface MenuSpec {
  readonly title: string;
  readonly intro: readonly string[];
  readonly options: readonly MenuOption[];
}

export type MenuKind =
  | { readonly kind: 'welcome' }
  | { readonly kind: 'settings'; readonly section?: SettingsSection }
  /** The model for one conversation (`channel`), or the default for new ones. */
  | { readonly kind: 'model'; readonly channel?: string }
  | ({ readonly kind: 'inbox' } & InboxView)
  | WorkMenuKind
  | InviteMenuKind
  | { readonly kind: 'person'; readonly index: number }
  | { readonly kind: 'confirm'; readonly action: 'archive' | 'delete'; readonly id: string; readonly children?: ThreadChildren }
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'archived'; readonly id: string }
  | { readonly kind: 'agents'; readonly projectId: string }
  | { readonly kind: 'ws_share'; readonly id: string }
  | { readonly kind: 'shared'; readonly owner: string; readonly id: string }
  | { readonly kind: 'clear'; readonly channel: string; readonly host: boolean }
  | { readonly kind: 'invite_person'; readonly peerId: string }
  | { readonly kind: 'share_folder'; readonly launchDir: string; readonly mine: ReadonlyArray<{ name: string; root?: string; private?: boolean; allowed?: readonly string[] }> }
  | { readonly kind: 'share_who'; readonly dir: string };

/** The ⋯ menu on a project: start work, organize into groups, hide, open in Finder (File Explorer, Files). */
export function projectMenu(state: AppState, id: string): MenuSpec | undefined {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return undefined;
  const group = state.projectGroups.find((g) => g.projects.includes(p.root));
  const otherGroups = state.projectGroups.filter((g) => g.name !== group?.name);
  const agents = p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent').length;
  return {
    title: p.name,
    intro: [p.root, group ? `In group: ${group.name}` : 'Not in a group'],
    options: [
      { id: 'p-worktree', label: 'New worktree', hint: 'from the latest origin' },
      { id: 'p-chat', label: 'New chat', hint: "a new one each time, in the project's main folder" },
      ...(p.root ? [{ id: 'p-invite', label: 'Invite someone to this project…', hint: 'a link: they watch, prompt or edit here' }] : []),
      { id: 'p-scripts', label: 'Project Settings…', hint: p.scripts?.setup ? `setup: ${p.scripts.setup.command}` : 'none yet' },
      { id: 'p-finder', label: `Open in ${FILE_MANAGER}`, hint: '' },
      ...otherGroups.map((g) => ({ id: `p-group:${g.name}`, label: `Move to "${g.name}"`, hint: 'group' })),
      { id: 'p-newgroup', label: 'Move to a new group…', hint: 'type a name' },
      ...(group ? [{ id: 'p-ungroup', label: `Remove from "${group.name}"`, hint: '' }] : []),
      ...(agents ? [{ id: 'p-agents', label: `Claude Code agent worktrees (${agents})…`, hint: 'left behind by sub-agents; clean up' }] : []),
      { id: 'p-hide', label: 'Hide this project', hint: 'add it back with /project add' },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

/** From a project's ⋯ menu: tidy up the worktrees Claude Code sub-agents left behind. */
export function agentsMenu(state: AppState, projectId: string): MenuSpec | undefined {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return undefined;
  const agents = p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent');
  const clean = agents.filter((w) => w.status?.changed === 0).length;
  return {
    title: `Claude Code agent worktrees in ${p.name}`,
    intro: [
      `${agents.length} worktree${agents.length === 1 ? '' : 's'} that Claude Code sub-agents created under .claude/worktrees.`,
      `${clean} have no uncommitted changes. Removing them keeps their branches, so no commits are lost.`,
    ],
    options: [
      ...(clean ? [{ id: 'agents-clean', label: `Remove ${clean} finished worktree${clean === 1 ? '' : 's'}`, hint: 'branches are kept' }] : []),
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

/** An archived workspace: bring it back, look at its project folder, or delete it for good. */
export function archivedMenu(state: AppState, id: string): MenuSpec | undefined {
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  if (!ws) return undefined;
  return {
    title: `${ws.name} (archived)`,
    intro: [ws.kind === 'worktree' ? `Branch ${ws.branch ?? ''} and its conversation are kept.` : 'Its conversation is kept.'],
    options: [
      { id: 'a-restore', label: 'Restore', hint: ws.kind === 'worktree' ? 'recreate the worktree from its branch' : 'show it again' },
      { id: 'a-open', label: 'Read its conversation', hint: 'without restoring' },
      { id: 'a-finder', label: `Open the project folder in ${FILE_MANAGER}`, hint: '' },
      { id: 'a-delete', label: 'Delete permanently', hint: 'branch and conversation' },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

/** "Are you sure?" for archive and delete, explaining exactly what happens. */
export function confirmMenu(state: AppState, action: 'archive' | 'delete', id: string): MenuSpec | undefined {
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  if (!ws) return undefined;
  const changed = ws.status?.changed ?? 0;
  const env = state.envChanges[id] ?? [];
  const envLines = env.length
    ? [
        '',
        'Env changes in this worktree (not in the main folder):',
        ...env.map((c) =>
          c.binary
            ? `  ${c.file}  (file differs)`
            : `  ${c.file}  ${[c.added.length ? `+${c.added.join(', +')}` : '', c.changed.length ? `~${c.changed.join(', ~')}` : '', c.removed.length ? `−${c.removed.join(', −')}` : ''].filter(Boolean).join('  ')}`,
        ),
      ]
    : [];
  const removedKeys = env.flatMap((c) => c.removed);
  const envOption = env.length
    ? [
        { id: `confirm-${action}-env`, label: `Copy env changes to the main folder, then ${action}`, hint: 'keeps your new keys' },
        // Removed keys go from the main folder's file too, only when chosen.
        ...(removedKeys.length ? [{ id: `confirm-${action}-env-all`, label: `Copy env changes and removals to the main folder, then ${action}`, hint: `also removes ${removedKeys.join(', ')}` }] : []),
      ]
    : [];
  if (action === 'archive') {
    return {
      title: `Archive ${ws.name}?`,
      intro: [
        ws.kind === 'worktree'
          ? 'The worktree folder is removed. Its branch and the agent conversation are kept, so you can restore it later.'
          : 'The chat is hidden from the sidebar. You can restore it from Overview.',
        ...(changed ? [`${changed} file(s) have uncommitted changes.`] : []),
        ...envLines,
      ],
      options: [
        ...envOption,
        ...(changed ? [{ id: 'confirm-commit-archive', label: 'Commit changes, then archive', hint: '' }] : []),
        { id: 'confirm-archive', label: changed ? 'Archive (uncommitted changes are kept)' : 'Archive', hint: '' },
        { id: 'close', label: 'Cancel', hint: 'Esc' },
      ],
    };
  }
  return {
    title: `Delete ${ws.name}?`,
    intro: [
      ws.kind === 'worktree' && !ws.external
        ? `This deletes the worktree folder, the branch ${ws.branch ?? ''} and the conversation. This can't be undone.`
        : "This removes it from Beluga and deletes the conversation. This can't be undone.",
      ...envLines,
    ],
    options: [
        ...envOption,
      { id: 'confirm-delete', label: 'Delete permanently', hint: '' },
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}

/** First screen after joining: decide whether friends may use your Claude. */
export function welcomeMenu(state: AppState): MenuSpec {
  const others = state.peers.filter((p) => p.peerId !== state.self?.peerId).map((p) => p.name);
  const who = others.length ? `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} here.` : 'Nobody else is here yet.';
  return {
    title: `Welcome to ${state.room}`,
    intro: [
      `You're ${state.self?.name ?? 'connected'}. ${who}`,
      '',
      'Friends can ask your agent to help. It runs on this computer with your agent',
      "subscription, inside the folders you shared. You'll always see what they ask.",
      '',
      'Can people in this room use your agent?',
    ],
    options: [
      { id: 'share-ask', label: 'Ask me each time', hint: 'recommended: approve every request' },
      { id: 'share-auto', label: 'Yes, everyone can use it', hint: 'requests run without asking' },
      { id: 'share-deny', label: 'No, keep my agent private', hint: 'only you can use it' },
    ],
  };
}

/** Actions for a person in the People panel. */
export function personMenu(state: AppState, index: number): MenuSpec | undefined {
  const peer = state.peers[index];
  if (!peer) return undefined;
  const guest = state.guests[peer.peerId];
  if (guest) return guestPersonMenu(state, guest);
  const isSelf = peer.peerId === state.self?.peerId;
  const share = peer.shares[0];
  const host = state.self?.host === true;
  const roomOptions: MenuOption[] = host
    ? [
        { id: 'invite-menu', label: 'Invite someone…', hint: 'to one project or everything; they knock first' },
        ...(state.invite ? [{ id: 'invite', label: 'Copy the room invite link', hint: 'anyone with it joins everything' }] : [{ id: 'invite', label: 'Invite friends', hint: 'open a link for the whole room' }]),
        ...(state.invite ? [{ id: 'room-new-link', label: 'Make a new invite link', hint: 'the old one stops working; people here stay' }] : []),
        state.roomOpen
          ? { id: 'room-close', label: 'Close the room to new people', hint: 'nobody new can join, even with the link' }
          : { id: 'room-open', label: 'Let new people join again', hint: 'now: closed' },
      ]
    : [
        ...(state.invite ? [{ id: 'invite', label: 'Copy invite link', hint: 'bring more friends' }] : []),
        { id: 'leave-room', label: 'Leave the room', hint: 'closes Beluga' },
      ];
  const options: MenuOption[] = isSelf
    ? [
        { id: 'ask-self', label: 'Ask my agent', hint: 'start a message with @claude' },
        { id: 'share-folder', label: 'Share a folder…', hint: 'with everyone, or just one person' },
        ...roomOptions,
        { id: 'sharing', label: 'People & permissions…', hint: 'how much you trust each person' },
        { id: 'settings', label: 'Settings', hint: 'name, theme, notifications, agents, workspaces' },
      ]
    : [
        ...TRUST_LEVELS.map((level) => ({ id: `trust:${level}`, label: `${trustOf(state, peer.peerId) === level ? '◉' : '○'} ${TRUST_INFO[level].label}`, hint: TRUST_INFO[level].detail })),
        ...(peer.agent ? [{ id: 'ask', label: `Ask ${agentLabel(defaultAgentOf(peer), peer.name, false)}`, hint: `runs on ${peer.name}'s computer` }] : []),
        ...(canRunOn(state.granted[peer.peerId]?.level)
          ? [{ id: 'person-run', label: `Run a command on ${peer.name}'s computer…`, hint: state.granted[peer.peerId]?.level === 'full' ? 'runs right away; the output shows in this chat' : `${peer.name} approves it; the output shows in this chat` }]
          : []),
        ...(peer.projects?.length ? [{ id: 'person-remote-ws', label: `Start a worktree on ${peer.name}'s computer…`, hint: `${peer.name} approves; you work there together` }] : []),
        { id: 'person-invite-ws', label: `Invite ${peer.name} into a workspace…`, hint: 'work together on a worktree or chat' },
        { id: 'person-share', label: `Share a folder with ${peer.name}…`, hint: 'pick the folder, then "Only ' + peer.name + '"' },
        state.follow === peer.peerId
          ? { id: 'unfollow', label: `Stop following ${peer.name}` }
          : { id: 'follow', label: `Follow ${peer.name}`, hint: 'see the files they and their agent open' },
        ...(share ? [{ id: 'browse', label: `Browse ${peer.name}'s files`, hint: `${share.name}${share.writable ? '' : ' (read-only)'}` }] : []),
        ...(host ? [{ id: 'person-remove', label: `Remove ${peer.name} from the room`, hint: 'they are disconnected; the invite link changes' }] : []),
      ];
  const about = isSelf ? 'What would you like to do?' : `${peer.agent ? `${agentName(defaultAgentOf(peer))} is on` : 'No agent'} · shares ${peer.shares.map((s) => s.name).join(', ') || 'nothing'}`;
  const grant = isSelf ? undefined : state.granted[peer.peerId];
  const lets = grant ? [`${peer.name} lets your agent: ${GRANT_INFO[grant.level].short}`] : [];
  const access = isSelf ? [] : ['', `How much do you trust ${peer.name}? Now: ${TRUST_INFO[trustOf(state, peer.peerId)].label}.`];
  return { title: isSelf ? `${peer.name} (you)` : peer.name, intro: [about, ...lets, ...usageLines(peer.usage), ...access], options };
}

/** The model a conversation uses: its own pick, else its agent's. Settings' model is Claude's only. */
export function modelOf(state: AppState, channel: string): string | undefined {
  return contextFacts(state, channel).modelId;
}

export { modelLabel };

export function menuSpec(state: AppState, menu: MenuKind): MenuSpec | undefined {
  if (menu.kind === 'welcome') return welcomeMenu(state);
  if (menu.kind === 'settings') return settingsMenu(state, menu.section, { prCustom: state.prCustom, remembered: state.remembered });
  if (menu.kind === 'model') return modelMenu(state, menu.channel, menu.channel === undefined ? 'new conversations' : 'this conversation');
  if (menu.kind === 'inbox') return inboxMenu(state, menu);
  const work = workMenuSpec(state, menu);
  if (work !== null) return work;
  if (menu.kind === 'confirm') return confirmMenu(state, menu.action, menu.id);
  if (menu.kind === 'project') return projectMenu(state, menu.id);
  if (menu.kind === 'archived') return archivedMenu(state, menu.id);
  if (menu.kind === 'agents') return agentsMenu(state, menu.projectId);
  if (menu.kind === 'ws_share') return wsShareMenu(state, menu.id);
  if (menu.kind === 'shared') return sharedMenu(state, menu.owner, menu.id);
  if (menu.kind === 'clear') return clearMenu(state, menu.channel, menu.host);
  if (menu.kind === 'invite_person') return invitePersonMenu(state, menu.peerId);
  if (menu.kind === 'share_folder') return shareFolderMenu(state, menu.launchDir, menu.mine);
  if (menu.kind === 'share_who') return shareWhoMenu(state, menu.dir);
  if (menu.kind === 'person') return personMenu(state, menu.index);
  if (menu.kind === 'invite_link') return inviteMenu(state, menu, state.self?.host === true);
  if (menu.kind === 'guest_add') return guestAddMenu(state, menu.peerId);
  return undefined;
}
