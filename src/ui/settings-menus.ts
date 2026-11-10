import { agentPicker } from '../shared/agent-picker.js';
import { CLAUDE_AGENT } from '../protocol.js';
import type { AppState } from '../core/store.js';
import type { Settings } from '../shared/settings-schema.js';
import { TRUST_INFO, defaultTrust, trustOf } from '../core/trust.js';
import { THEME_LABELS } from './theme.js';
import type { MenuOption, MenuSpec } from './menus.js';
import { joinArgs, shellName } from '../shared/shells.js';
import { dndActive, dndLabel } from '../shared/quiet.js';
import { soundOn } from '../shared/notify-sound.js';
import { FILE_MANAGER } from '../shared/assistant.js';
import { type NoticeFilter, NOTICE_FILTERS, filterNotices, groupNotices, noticeAgo } from './notice-models.js';

export type SettingsSection = 'claude' | 'notify' | 'workspaces' | 'people' | 'display' | 'buttons' | 'terminal' | 'env';

const onOff = (on: boolean): string => (on ? 'On' : 'Off');
const sw = '  ·  Enter to switch';
const back: MenuOption = { id: 'set-back', label: '‹ Back', hint: 'Esc' };

export const TUNNEL_LABELS: Readonly<Record<Settings['tunnel'], string>> = {
  auto: 'Direct (peer-to-peer), Cloudflare as backup',
  p2p: 'Direct (peer-to-peer) only',
  cloudflared: 'Cloudflare only',
  ngrok: 'ngrok',
  none: 'Local network only',
};
export const TUNNEL_ORDER: readonly Settings['tunnel'][] = ['auto', 'p2p', 'cloudflared', 'ngrok', 'none'];

const SUBAGENT_LABELS = { full: 'Every step', compact: 'One line each', hidden: 'Hidden' } as const;

/** Workspace buttons you can hide from the top bar (id → label). */
export const HIDEABLE_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['run', 'Run'],
  ['terminal', 'Terminal'],
  ['review_claude', 'Review'],
  ['commit', 'Commit'],
  ['pr', 'PR'],
  ['merge', 'Merge'],
  ['handoff', 'Hand off'],
  ['compact', 'Compact'],
  ['fork', 'Fork'],
  ['finder', FILE_MANAGER],
  ['archive', 'Archive'],
  ['share', 'Share'],
];

export function modelLabel(state: AppState, value: string | undefined): string {
  if (!value) return 'Default';
  return state.models.find((m) => m.value === value)?.label ?? value;
}

/** The terminal's shell in words: "zsh" (yours), or the one you picked. */
export function shellLabel(state: AppState): string {
  const p = state.prefs;
  const login = state.shellChoices.find((c) => c.isDefault);
  if (!p.shell) return login ? `${login.name} (your login shell)` : 'your login shell';
  return state.shellChoices.find((c) => c.path === p.shell)?.name ?? shellName(p.shell);
}

/** Everything you can change, grouped so nothing is more than one click away. */
export function settingsMenu(state: AppState, section?: SettingsSection, extra: { prCustom?: boolean; remembered?: Settings['people'] } = {}): MenuSpec {
  const p = state.prefs;
  switch (section) {
    case 'claude':
      return {
        title: 'Settings › Agent',
        intro: ['How your agent works, for you and for the people you let use it.', ''],
        options: [
          { id: 'set-model', label: 'Model for new conversations', hint: `${modelLabel(state, p.model)}  ·  Enter to choose (each chat can pick its own)` },
          { id: 'set-effort', label: 'Thinking effort', hint: `${p.effort ?? 'Default'}${sw}` },
          { id: 'set-self-approval', label: 'My agent asks before commands', hint: `${p.selfApproval === 'ask' ? 'Yes (safer)' : 'No, it just works (secrets stay blocked)'}${sw}` },
          { id: 'set-pr-prompt', label: 'Pull request instructions', hint: `${extra.prCustom ? 'Customized' : 'Built-in'}  ·  Enter to edit in your editor` },
          ...(extra.prCustom ? [{ id: 'set-pr-reset', label: 'Reset pull request instructions', hint: 'back to the built-in ones' }] : []),
          { id: 'set-templates', label: 'Templates…', hint: `${state.templates.length} ways to start a task` },
          back,
        ],
      };
    case 'notify':
      return {
        title: 'Settings › Notifications',
        intro: ['Beluga tells you when something needs you, on the desktop and in the inbox (top right).', 'In the conversation you are looking at, only a long run of yours finishing is announced.', ''],
        options: [
          { id: 'n-desktop', label: 'Desktop notifications', hint: `${onOff(p.notify.desktop)}${sw}` },
          { id: 'n-sound', label: 'Sound', hint: `${onOff(soundOn(p.notify))}${sw}` },
          { id: 'n-onlyAway', label: 'Only when Beluga isn’t in front', hint: `${onOff(p.notify.onlyAway)}${sw}` },
          { id: 'n-dnd', label: 'Do Not Disturb', hint: dndActive(p.notify) ? `On ${dndLabel(p.notify)}  ·  Enter for longer, then off` : 'Off  ·  Enter: for 1 hour, then longer' },
          { id: 'n-needsYou', label: 'Your agent needs you', hint: `${onOff(p.notify.needsYou)}  ·  questions, plans, approvals` },
          { id: 'n-done', label: 'Your agent finished', hint: `${onOff(p.notify.done)}${sw}` },
          { id: 'n-mentions', label: 'Mentions and messages to you', hint: `${onOff(p.notify.mentions)}  ·  @${state.self?.name ?? 'you'}` },
          { id: 'n-people', label: 'People', hint: `${onOff(p.notify.people)}  ·  joins, leaves, invites, handoffs` },
          { id: 'n-background', label: 'Background tasks', hint: `${onOff(p.notify.background)}  ·  your agent's background work, worktree setup` },
          { id: 'n-problems', label: 'Errors and merge conflicts', hint: `${onOff(p.notify.problems)}${sw}` },
          { id: 'n-pr', label: 'Pull requests', hint: `${onOff(p.notify.pr)}  ·  opened, checks passed or failed` },
          { id: 'n-test', label: 'Send a test notification', hint: 'whatever the settings above say' },
          back,
        ],
      };
    case 'workspaces':
      return {
        title: 'Settings › Workspaces',
        intro: ['New worktrees, scripts, the terminal and the top bar.', ''],
        options: [
          { id: 'w-setup', label: 'Run setup in new worktrees', hint: `${onOff(p.autoSetup)}  ·  e.g. npm install (set per project in its ⋯ menu)` },
          { id: 'w-friend', label: 'Friends may start work here', hint: `${p.friendWorktrees === 'ask' ? 'Yes, I approve each one' : 'No'}  ·  worktrees and handoffs from friends` },
          { id: 'sec:terminal', label: 'Terminal ›', hint: `${shellLabel(state)}${p.shellLogin ? '' : ' · not a login shell'}${p.shellArgs.length ? ` · ${joinArgs(p.shellArgs)}` : ''}` },
          { id: 'sec:env', label: 'Environment variables ›', hint: envHint(state) },
          { id: 'w-buttons', label: 'Top bar buttons…', hint: p.hiddenButtons.length ? `${p.hiddenButtons.length} hidden` : 'all shown' },
          back,
        ],
      };
    case 'terminal': {
      const picked = p.shell ?? '';
      const listed = state.shellChoices.some((c) => c.path === picked);
      return {
        title: 'Settings › Terminal',
        intro: ['The shell your terminals run. New shells use it; open ones keep theirs.', ''],
        options: [
          ...state.shellChoices.map((c) => ({ id: `sh:${c.path}`, label: `${(picked || state.shellChoices.find((x) => x.isDefault)?.path) === c.path ? '◉' : '○'} ${c.name}`, hint: `${c.path}${c.isDefault ? '  ·  your login shell' : ''}` })),
          { id: 'sh-other', label: `${picked && !listed ? '◉' : '○'} Another shell…`, hint: picked && !listed ? `${picked}  ·  type a new path` : 'type its path' },
          { id: 'sh-login', label: 'Login shell', hint: `${onOff(p.shellLogin)}  ·  reads your profile (~/.zprofile…)${sw}` },
          { id: 'sh-args', label: 'Extra arguments', hint: `${p.shellArgs.length ? joinArgs(p.shellArgs) : 'none'}  ·  type them` },
          { id: 'set-back-workspaces', label: '‹ Back', hint: 'Esc' },
        ],
      };
    }
    case 'env': {
      const mine = state.envKeys.global;
      return {
        title: 'Settings › Environment variables',
        intro: [
          'Given to your shells, setup and run commands, and your agent (never to a friend\'s request).',
          'New shells and agent runs pick up changes. They stay on this computer.',
          'For one project only: /env project KEY=value in one of its workspaces.',
          '',
        ],
        options: [
          ...mine.map((key) => ({ id: `env:${key}`, label: key, hint: '••••••  ·  Enter to change or remove' })),
          { id: 'env-add', label: 'Add a variable…', hint: 'type KEY=value' },
          { id: 'set-back-workspaces', label: '‹ Back', hint: 'Esc' },
        ],
      };
    }
    case 'buttons':
      return {
        title: 'Settings › Top bar buttons',
        intro: ['Show only the workspace buttons you use. Hidden ones still work as /commands.', ''],
        options: [...HIDEABLE_BUTTONS.map(([id, label]) => ({ id: `btn:${id}`, label, hint: `${p.hiddenButtons.includes(id) ? '○ hidden' : '◉ shown'}${sw}` })), { id: 'set-back-workspaces', label: '‹ Back', hint: 'Esc' }],
      };
    case 'people': {
      const others = state.peers.filter((x) => x.peerId !== state.self?.peerId);
      const away = Object.entries(extra.remembered ?? {}).filter(([id]) => !state.peers.some((x) => x.peerId === id));
      return {
        title: 'Settings › People & permissions',
        intro: [
          'Pick how much you trust each person. Click someone to change it.',
          `  ${TRUST_INFO.ask.label}: ${TRUST_INFO.ask.detail}`,
          `  ${TRUST_INFO.trusted.label}: ${TRUST_INFO.trusted.detail}`,
          `  ${TRUST_INFO.full.label}: ${TRUST_INFO.full.detail}`,
          '',
        ],
        options: [
          { id: 'p-default', label: 'New people start at', hint: `${TRUST_INFO[defaultTrust(state)].label}${sw}` },
          ...others.map((x) => ({ id: `p-person:${x.peerId}`, label: x.name, hint: `${TRUST_INFO[trustOf(state, x.peerId)].label}  ·  Enter to change` })),
          ...away.map(([id, x]) => ({ id: `p-forget:${id}`, label: `${x.name} (not here)`, hint: `${TRUST_INFO[x.trust].label}  ·  Enter to forget` })),
          { id: 'set-tunnel', label: 'How friends connect', hint: `${TUNNEL_LABELS[p.tunnel]}  ·  applies next start` },
          back,
        ],
      };
    }
    case 'display':
      return {
        title: 'Settings › Display',
        intro: [''],
        options: [
          { id: 'set-mouse', label: 'Mouse clicks', hint: `${p.mouse ? 'On' : 'Off (keeps native text selection)'}${sw}` },
          { id: 'd-context', label: 'Context meter', hint: `${onOff(p.contextMeter)}  ·  how full each conversation is` },
          { id: 'd-subagents', label: 'Sub-agent detail', hint: `${SUBAGENT_LABELS[p.subagents]}${sw}` },
          { id: 'size-in', label: 'Make text bigger', hint: 'Option+↑ (Alt+↑) anywhere' },
          { id: 'size-out', label: 'Make text smaller', hint: 'Option+↓ (Alt+↓) anywhere' },
          { id: 'size-reset', label: 'Normal text size', hint: '' },
          back,
        ],
      };
    default: {
      const n = p.notify;
      const others = state.peers.filter((x) => x.peerId !== state.self?.peerId).length;
      return {
        title: 'Settings',
        intro: ['Saved to ~/.beluga/settings.json and used every time you run Beluga.', ''],
        options: [
          { id: 'set-name', label: 'Your name', hint: `${state.self?.name ?? '–'}  ·  type a new one` },
          { id: 'set-theme', label: 'Color theme', hint: `${THEME_LABELS[p.theme]}${sw}` },
          { id: 'sec:people', label: 'People & permissions ›', hint: `new people: ${TRUST_INFO[defaultTrust(state)].short}${others ? ` · ${others} here` : ''}` },
          { id: 'sec:notify', label: 'Notifications ›', hint: dndActive(n) ? `Do Not Disturb ${dndLabel(n)}` : n.desktop ? `desktop on${soundOn(n) ? ' · sound' : ''}` : 'desktop off · inbox only' },
          { id: 'sec:claude', label: 'Agent ›', hint: `${modelLabel(state, p.model)} · PR instructions · templates` },
          { id: 'sec:workspaces', label: 'Workspaces ›', hint: `setup ${p.autoSetup ? 'on' : 'off'} · terminal · environment · top bar` },
          { id: 'sec:display', label: 'Display ›', hint: 'mouse, text size, context meter, sub-agents' },
          { id: 'close', label: 'Done', hint: 'Esc' },
        ],
      };
    }
  }
}

/** "3 yours · 2 in projects", or "none yet". */
function envHint(state: AppState): string {
  const mine = state.envKeys.global.length;
  const projects = Object.values(state.envKeys.projects).reduce((n, x) => n + x.keys.length, 0);
  const parts = [mine ? `${mine} yours` : '', projects ? `${projects} in projects` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'none yet  ·  for shells, scripts and agents';
}

/** Pick the model for one conversation (or the default for new ones). */
/**
 * /model (BLG-446): the agent picker as a menu. Your default agent's models, then each other
 * runtime with its own, or greyed with what's missing. A model of the same runtime switches models
 * (`model:<value>`); one of another runtime switches agent (`agent:<runtime>:<value>`).
 */
export function modelMenu(state: AppState, channel: string | undefined, forWhat: string): MenuSpec {
  const picker = myAgentPicker(state, channel ?? 'draft');
  const options = picker.groups.flatMap((g) => {
    const head = picker.groups.length > 1 ? [{ id: `runtime:${g.runtime}`, label: `${g.label}${g.isDefault ? ' (your default)' : ''}`, ...(g.why ? { hint: g.why } : {}) }] : [];
    const rows = g.models.map((m) => ({
      id: g.current || !picker.conversation ? `model:${m.value}` : `agent:${g.runtime}:${m.value}`,
      label: `  ${m.on ? '◉' : '○'} ${m.label}`,
      hint: m.description,
    }));
    // New conversations take your default agent's models; another runtime is picked per worktree.
    return !picker.conversation && !g.isDefault ? head.map((h) => ({ ...h, hint: g.why ?? 'Pick it in a worktree' })) : [...head, ...rows];
  });
  return {
    title: `Agent and model for ${forWhat}`,
    intro: ['Each conversation can use its own agent and model. A model applies from the next message; another agent starts its own conversation.', ''],
    options: [...options, { id: 'close', label: 'Cancel', hint: 'Esc' }],
  };
}

/**
 * The picker from your agent's side: its runtime is "your default", and its model the default
 * model (Settings' model is Claude's; another runtime's model goes with the agent).
 */
export function myAgentPicker(state: AppState, channel: string): ReturnType<typeof agentPicker> {
  const mine = state.prefs.defaultAgent;
  const other = mine && mine.runtime !== CLAUDE_AGENT.runtime ? mine : undefined;
  return agentPicker({ ...state, prefs: { model: other ? other.model : state.prefs.model, openModels: state.prefs.openModels } }, channel, other?.runtime ?? CLAUDE_AGENT.runtime);
}

/** The inbox as the menu shows it: which notices, and whether each row clears one. */
export interface InboxView {
  readonly filter?: NoticeFilter;
  /** Each row clears its notice (instead of opening it). */
  readonly manage?: boolean;
}

const INBOX_ROWS = 30;

/** Everything that happened while you were elsewhere, newest first. Click one to go there. */
export function inboxMenu(state: AppState, view: InboxView = {}, now = Date.now()): MenuSpec {
  const filter = view.filter ?? 'all';
  const all = state.inbox;
  const unread = all.filter((x) => !x.read).length;
  const groups = groupNotices(filterNotices(all, filter), now);
  // "Earlier" starts on its row, so the list reads in the same two parts as the Mac app.
  const rows = groups.flatMap((g, gi) => g.notices.map((x, i) => ({ x, mark: gi > 0 && i === 0 ? 'Earlier · ' : '' }))).slice(0, INBOX_ROWS);
  const label = NOTICE_FILTERS.find((f) => f.value === filter)?.label ?? 'All';
  const next = NOTICE_FILTERS[(NOTICE_FILTERS.findIndex((f) => f.value === filter) + 1) % NOTICE_FILTERS.length]!;
  if (view.manage) {
    return {
      title: 'Inbox › Clear',
      intro: [all.length ? 'Pick what to clear. Clearing removes it from the inbox for every screen.' : 'The inbox is empty.', ''],
      options: [
        ...rows.map(({ x }) => ({ id: `notice-x:${x.id}`, label: `× ${x.title}`, hint: `${noticeAgo(x.ts, now)}  ·  Enter to clear` })),
        ...(all.length ? [{ id: 'inbox-clear', label: 'Clear all', hint: `${all.length} notice${all.length === 1 ? '' : 's'}` }] : []),
        { id: 'inbox-back', label: '‹ Back', hint: 'Esc' },
      ],
    };
  }
  const empty = all.length ? `Nothing ${filter === 'unread' ? 'unread' : `in ${label}`}.` : 'Nothing yet. Beluga lists what happens in other workspaces here.';
  return {
    title: 'Inbox',
    intro: [rows.length ? `${unread} new · click one to open it` : empty, ''],
    options: [
      ...rows.map(({ x, mark }) => ({ id: `notice:${x.id}`, label: `${x.read ? '  ' : '● '}${x.title}`, hint: `${mark}${noticeAgo(x.ts, now)}${x.body ? `  ·  ${x.body}` : ''}` })),
      ...(all.length ? [{ id: 'inbox-filter', label: `Showing: ${label}`, hint: `Enter for ${next.label}` }] : []),
      ...(unread ? [{ id: 'inbox-read', label: 'Mark all as read', hint: '' }] : []),
      ...(all.length ? [{ id: 'inbox-manage', label: 'Clear one by one…', hint: '' }, { id: 'inbox-clear', label: 'Clear all', hint: '' }] : []),
      { id: 'sec:notify', label: 'Notification settings…', hint: '' },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}
