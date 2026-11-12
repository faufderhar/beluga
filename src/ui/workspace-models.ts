import type { LinkTarget } from './links.js';
import { type AppState, type LogItem, type ReviewState, type SharedTab, type WorkspaceTab, newShares } from '../core/store.js';
import type { TrustLevel } from '../core/settings.js';
import { notOnPr, notOnPrLabel } from '../core/branch-state.js';
import { describePr } from '../shared/format.js';
import { COMPUTER, type ComputerKind, FILE_MANAGER } from '../shared/assistant.js';
import { formatBytes } from '../shared/format.js';
import { fallbackFor, runtimeHere } from '../shared/runtime-fallbacks.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { tokensOf } from '../workspaces/usage-days.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { isRunning } from './format.js';
import { steerWaiting } from '../shared/claude-notices.js';
import { type Line, type Seg, formatDuration, lineWidth, pad, plain, truncate } from './text.js';
import { SPINNER, glyph, theme } from './theme.js';
import { handoffPeople, worktreeShareRows } from './worktree-share.js';

/** Something clickable, in coordinates relative to the model's own top-left corner. */
export interface Zone {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly action: UiAction;
  /** Shown in the bottom bar while hovering: what clicking does. */
  readonly hint?: string;
  /** Visible but inactive (e.g. nothing to merge); clicking explains why. */
  readonly disabled?: boolean;
}

export type WorkspaceAction =
  | 'merge'
  | 'fork'
  | 'commit'
  | 'finder'
  | 'archive'
  | 'restore'
  | 'delete'
  | 'review_claude'
  | 'merge_claude'
  | 'compact'
  | 'share'
  | 'pr'
  | 'run'
  | 'stop_run'
  | 'setup'
  | 'handoff';

export type UiAction =
  | { readonly type: 'open_ws'; readonly id: string; readonly tab?: WorkspaceTab }
  | { readonly type: 'toggle_project'; readonly id: string }
  | { readonly type: 'toggle_fold'; readonly key: string }
  | { readonly type: 'agents_menu'; readonly projectId: string }
  | { readonly type: 'toggle_group'; readonly name: string }
  | { readonly type: 'toggle_archive'; readonly projectId: string }
  | { readonly type: 'project_menu'; readonly id: string }
  | { readonly type: 'archived_menu'; readonly id: string }
  | { readonly type: 'new_worktree'; readonly projectId: string }
  | { readonly type: 'new_chat'; readonly projectId: string }
  | { readonly type: 'add_project' }
  | { readonly type: 'view'; readonly view: AppState['view'] }
  | { readonly type: 'close_tab'; readonly id: string }
  | { readonly type: 'ws'; readonly id: string; readonly action: WorkspaceAction }
  | { readonly type: 'review_file'; readonly index: number }
  | { readonly type: 'plan_toggle'; readonly channel: string }
  /** Open (or close) Claude's proposed plan full screen. */
  | { readonly type: 'plan_full'; readonly qid?: string }
  | { readonly type: 'open_shared'; readonly owner: string; readonly id: string; readonly tab?: SharedTab }
  /** The card for someone at the door with your link: let them in (as offered, or watch only), or not. */
  | { readonly type: 'knock'; readonly peerId: string; readonly pick: 'in' | 'watch' | 'decline' }
  /** A name clicked in a shared workspace's read-only shell (folders list, files open). */
  | { readonly type: 'shell_open'; readonly id: string; readonly rel: string; readonly dir: boolean }
  | { readonly type: 'shell_run'; readonly id: string; readonly cmd: string }
  | { readonly type: 'shared_menu'; readonly owner: string; readonly id: string }
  /** Answer a question card: pick an option, skip, approve or revise a plan, or finish a multi-select. */
  | { readonly type: 'answer'; readonly qid: string; readonly pick: 'option' | 'skip' | 'approve' | 'revise' | 'done'; readonly label?: string; readonly question?: string }
  | { readonly type: 'inbox' }
  | { readonly type: 'model_menu'; readonly channel: string }
  | { readonly type: 'template'; readonly id: string }
  | { readonly type: 'templates_menu' }
  | { readonly type: 'trust'; readonly peerId: string; readonly level: TrustLevel }
  | { readonly type: 'trust_later'; readonly peerId: string }
  | { readonly type: 'search_hit'; readonly index: number }
  | { readonly type: 'term_tab'; readonly key: string }
  /** Another shell in the global Terminal tab. */
  | { readonly type: 'term_new' }
  /** The workspace buttons that didn't fit in the top bar. */
  | { readonly type: 'ws_more'; readonly id: string; readonly actions: ReadonlyArray<{ readonly action: WorkspaceAction; readonly label: string; readonly hint: string }> }
  /** A file, folder, URL or image mentioned in the chat. */
  | { readonly type: 'open_link'; readonly link: LinkTarget }
  /** Attach the image on the clipboard to the message being typed. */
  | { readonly type: 'paste_image' }
  | { readonly type: 'none' };

export interface Model {
  readonly lines: readonly Line[];
  readonly zones: readonly Zone[];
}

const COMPACT_ANIMATION_MS = 1600;
export function contextMeter(state: AppState, channel: string, width: number, now = Date.now()): Line {
  const info = state.context[channel];
  if (!info) return [];
  const compaction = state.compactions[channel];
  const sinceCompact = compaction ? now - compaction.at : Infinity;
  let used = info.used;
  let label = '';
  if (compaction && sinceCompact < COMPACT_ANIMATION_MS) {
    const t = Math.max(0, sinceCompact) / COMPACT_ANIMATION_MS;
    const eased = 1 - (1 - t) ** 3;
    used = Math.round(compaction.pre + (compaction.post - compaction.pre) * eased);
    label = ' compacting…';
  } else if (compaction && sinceCompact < COMPACT_ANIMATION_MS + 4000) {
    label = ` compacted ${fmtK(compaction.pre)}→${fmtK(compaction.post)}`;
  }
  const pct = Math.max(0, Math.min(100, Math.round((used / Math.max(1, info.window)) * 100)));
  const cells = Math.max(6, Math.min(16, width));
  const filled = Math.round((pct / 100) * cells);
  const color = label === ' compacting…' ? theme.info : pct >= 90 ? theme.error : pct >= 70 ? theme.warn : theme.muted;
  return [
    { text: 'context ', color: theme.muted },
    { text: '▰'.repeat(filled), color },
    { text: '▱'.repeat(cells - filled), color: theme.border },
    { text: ` ${pct}% · ${fmtK(used)}/${fmtK(info.window)}`, color },
    { text: label, color: theme.info },
  ];
}

const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** True while a compaction animation is playing somewhere (keeps frames ticking). */
export const isCompacting = (state: AppState, now = Date.now()): boolean =>
  Object.values(state.compactions).some((c) => now - c.at < COMPACT_ANIMATION_MS + 4000);



const ago = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

export interface Activity {
  readonly running: boolean;
  readonly awaiting: boolean;
  readonly subagents: number;
  readonly background: number;
  readonly startedAt?: number;
  readonly last?: string;
  readonly lastTs?: number;
}

const IDLE: Activity = { running: false, awaiting: false, subagents: 0, background: 0 };
// The log is replaced, never changed, so one pass per log serves every channel (the sidebar
// asks for each workspace on every update).
const activityIndex = new WeakMap<readonly LogItem[], ReadonlyMap<string, Activity>>();

/** What Claude is doing in a workspace, derived from its conversation. */
export function activityOf(log: readonly LogItem[], channel: string): Activity {
  let index = activityIndex.get(log);
  if (!index) {
    index = indexActivity(log);
    activityIndex.set(log, index);
  }
  return index.get(channel) ?? IDLE;
}

function indexActivity(log: readonly LogItem[]): ReadonlyMap<string, Activity> {
  const last = new Map<string, LogItem>();
  const run = new Map<string, Extract<LogItem, { type: 'agent' }>>();
  for (const item of log) {
    last.set(item.channel, item);
    // A steered message not read yet is a note in the turn already running: the turn's time and steps stay that turn's.
    if (item.type === 'agent' && isRunning(item.status) && !(steerWaiting(item) && run.has(item.channel))) run.set(item.channel, item);
  }
  const out = new Map<string, Activity>();
  for (const [channel, latest] of last) out.set(channel, activity(latest, run.get(channel)));
  return out;
}

function activity(last: LogItem, run: Extract<LogItem, { type: 'agent' }> | undefined): Activity {
  const lastText = last.type === 'agent' ? last.text || last.steps.at(-1) : last.type === 'chat' ? last.text : undefined;
  return {
    running: Boolean(run),
    awaiting: run?.status === 'awaiting_approval',
    subagents: run?.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length ?? 0,
    background: run?.subagents.filter((s) => s.status === 'running' && s.kind === 'background').length ?? 0,
    startedAt: run?.ts,
    last: lastText?.split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim(),
    lastTs: last.ts,
  };
}

export function findWorkspace(projects: readonly Project[], id: string): Workspace | undefined {
  for (const p of projects) {
    const ws = p.workspaces.find((w) => w.id === id);
    if (ws) return ws;
  }
  return undefined;
}

/** Left / right columns on one line, right side kept visible. */
export function split(left: Line, right: Line, width: number): Line {
  const rw = lineWidth(right);
  return [...pad(left, Math.max(1, width - rw - 1)), { text: ' ' }, ...right];
}

// ---------------------------------------------------------------- state words

export interface WorkspaceState {
  readonly label: string;
  readonly color: string;
  readonly icon: string;
  /** What the color means (for screens with their own palette). */
  readonly tone: 'error' | 'warn' | 'claude' | 'muted' | 'info' | 'ok';
}

/** One plain-language phrase for a workspace's state, used everywhere it's shown. */
export function stateOf(state: AppState, ws: Workspace, frame: number, now = Date.now()): WorkspaceState {
  const act = activityOf(state.log, `ws:${ws.id}`);
  const spin = SPINNER[frame % SPINNER.length] ?? '•';
  if (state.conflicts[ws.id]?.length) return { label: 'Merge conflict', color: theme.error, icon: '!', tone: 'error' };
  if (act.awaiting) return { label: 'Needs your approval', color: theme.warn, icon: glyph.wait, tone: 'warn' };
  if (act.running) {
    const extra = act.subagents ? ` · ${act.subagents} sub-agent${act.subagents > 1 ? 's' : ''} running` : act.background ? ' · background task' : '';
    return { label: `Agent working${act.startedAt ? ` ${formatDuration(now - act.startedAt)}` : ''}${extra}`, color: theme.claude, icon: spin, tone: 'claude' };
  }
  if (ws.archived) return { label: 'Archived', color: theme.muted, icon: glyph.ring, tone: 'muted' };
  if (ws.kind === 'chat') return { label: act.lastTs ? `Chat · ${ago(act.lastTs, now)}` : 'New chat', color: theme.muted, icon: '◇', tone: 'muted' };
  const st = ws.status;
  // Committed here but not on its open PR (BLG-840): Merge on GitHub would leave it out, so it says so first.
  const gap = ws.kind === 'worktree' ? notOnPr(state.prs[ws.id], ws) : undefined;
  if (gap) return { label: `${notOnPrLabel(gap)}${st?.changed ? ` · ${st.changed} uncommitted change${st.changed > 1 ? 's' : ''}` : ''}`, color: theme.info, icon: glyph.dot, tone: 'info' };
  // Work in progress, not a problem: quiet, like the branch pill (no warning dot on the row).
  if (st?.changed) return { label: `${st.changed} uncommitted change${st.changed > 1 ? 's' : ''}`, color: theme.muted, icon: glyph.dot, tone: 'muted' };
  if (ws.kind === 'worktree' && state.prs[ws.id]?.state === 'MERGED') return { label: 'Merged on GitHub', color: theme.ok, icon: glyph.dot, tone: 'ok' };
  // Continued after a merged PR (prDone): what's landed is that PR's work, so nothing new yet (not Merged again).
  if (ws.kind === 'worktree' && st?.landed && ws.prDone !== undefined && !state.prs[ws.id]) return { label: 'Up to date', color: theme.ok, icon: glyph.dot, tone: 'ok' };
  if (ws.kind === 'worktree' && st?.landed && state.prs[ws.id]?.state !== 'OPEN') return { label: 'Merged', color: theme.ok, icon: glyph.dot, tone: 'ok' };
  if (ws.kind === 'worktree' && st?.ahead) return { label: `Ready to merge · ${st.ahead} commit${st.ahead > 1 ? 's' : ''}`, color: theme.info, icon: glyph.dot, tone: 'info' };
  return { label: ws.kind === 'main' ? 'Main folder' : 'Up to date', color: theme.ok, icon: glyph.dot, tone: 'ok' };
}

const BRANCH = '⌥'; // in every common terminal font, and it looks like a fork

// ---------------------------------------------------------------- sidebar

/**
 * Whether a project is unfolded: folded by default (only the one you're in opens itself);
 * `toggled` flips that.
 */
/**
 * Projects start folded, except the one you're working in. Clicking records an explicit
 * choice (`open:<id>` / `closed:<id>`) that wins from then on, so moving between
 * workspaces never flips a project you opened or closed yourself.
 */
export function isProjectOpen(state: AppState, p: Project, toggled: ReadonlySet<string>): boolean {
  if (toggled.has(`open:${p.id}`)) return true;
  if (toggled.has(`closed:${p.id}`)) return false;
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  return p.workspaces.some((w) => w.id === current) || !p.root;
}

/** The fold choices after clicking a project's row. */
export function toggleProject(state: AppState, p: Project, choices: readonly string[]): string[] {
  const open = isProjectOpen(state, p, new Set(choices));
  const rest = choices.filter((c) => c !== `open:${p.id}` && c !== `closed:${p.id}`);
  return [...rest, `${open ? 'closed' : 'open'}:${p.id}`];
}

const section = (title: string, color: string): Seg[] => [{ text: title, color, bold: true }];

/**
 * The sidebar: CHATS, then PROJECTS (and your groups). Each project row has compact
 * "+⌥" (new worktree) and "+◇" (new chat) buttons and a "⋯" menu.
 */
export function projectsModel(state: AppState, toggled: ReadonlySet<string>, frame: number, width: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const current = state.view.kind === 'workspace' ? state.view.id : undefined;
  const add = (line: Line, action?: UiAction, hint?: string): void => {
    if (action) zones.push({ x0: 0, x1: width - 1, y: lines.length, action, hint });
    lines.push(line);
  };
  /** A row with extra buttons on the right; each button is its own click target. */
  const addWithButtons = (left: Line, buttons: Array<{ label: string; color: string; action: UiAction; hint: string }>, rowAction: UiAction, rowHint: string): void => {
    const right: Seg[] = [];
    buttons.forEach((b, i) => {
      if (i) right.push({ text: ' ' });
      right.push({ text: b.label, color: b.color });
    });
    const y = lines.length;
    const rw = lineWidth(right);
    let x = width - rw;
    buttons.forEach((b) => {
      zones.push({ x0: x, x1: x + b.label.length - 1, y, action: b.action, hint: b.hint });
      x += b.label.length + 1;
    });
    zones.push({ x0: 0, x1: width - rw - 2, y, action: rowAction, hint: rowHint });
    lines.push(split(left, right, width));
  };

  const wsRow = (ws: Workspace, indent: string): void => {
    const st = stateOf(state, ws, frame);
    const selected = ws.id === current;
    const icon = ws.kind === 'chat' ? '◇' : ws.kind === 'main' ? '⌂' : BRANCH;
    const unread = state.unread[`ws:${ws.id}`];
    const left: Line = [
      { text: selected ? '▌' : ' ', color: theme.accent },
      { text: indent },
      { text: `${icon} `, color: selected ? theme.accent : theme.muted },
      { text: ws.name, color: selected ? theme.text : ws.external ? theme.muted : theme.text, bold: selected },
      ...(unread ? [{ text: ` ${unread}`, color: theme.claude, bold: true }] : []),
    ];
    const right: Line = [{ text: st.icon, color: st.color }];
    add(split(left, right, width), { type: 'open_ws', id: ws.id }, `Open ${ws.name}: ${st.label}`);
  };

  // CHATS
  const chats = state.projects.find((p) => !p.root);
  addWithButtons(section('CHATS', theme.claude), [{ label: '+ new', color: theme.claude, action: { type: 'new_chat', projectId: 'chats' }, hint: 'Start an agent chat that is not tied to any project' }], { type: 'none' }, '');
  const liveChats = chats?.workspaces.filter((w) => !w.archived) ?? [];
  if (!liveChats.length) add(plain('  Talk to your agent about anything', { color: theme.border }));
  for (const ws of liveChats) wsRow(ws, ' ');
  lines.push([]);

  // PROJECTS, grouped
  const repos = state.projects.filter((p) => p.root);
  const grouped = new Map<string, Project[]>();
  const loose: Project[] = [];
  for (const p of repos) {
    const g = state.projectGroups.find((x) => x.projects.includes(p.root));
    if (g) grouped.set(g.name, [...(grouped.get(g.name) ?? []), p]);
    else loose.push(p);
  }
  const projectBlock = (p: Project): void => {
    const open = isProjectOpen(state, p, toggled);
    const busy = p.workspaces.some((w) => activityOf(state.log, `ws:${w.id}`).running);
    const worktrees = p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && worktreeOrigin(w) !== 'agent').length;
    addWithButtons(
      [
        { text: open ? '▾ ' : '▸ ', color: theme.muted },
        { text: '▣ ', color: theme.info },
        { text: p.name, color: theme.text, bold: true },
        ...(busy ? [{ text: ` ${SPINNER[frame % SPINNER.length]}`, color: theme.claude }] : worktrees && !open ? [{ text: ` ${worktrees}`, color: theme.muted }] : []),
      ],
      [
        { label: `+${BRANCH}`, color: theme.info, action: { type: 'new_worktree', projectId: p.id }, hint: `New worktree in ${p.name} from the latest origin` },
        { label: '+◇', color: theme.claude, action: { type: 'new_chat', projectId: p.id }, hint: `New agent chat in ${p.name}'s main folder` },
        { label: '⋯', color: theme.muted, action: { type: 'project_menu', id: p.id }, hint: `More for ${p.name}: groups, hide, ${FILE_MANAGER}` },
      ],
      { type: 'toggle_project', id: p.id },
      open ? `Collapse ${p.name}` : `Expand ${p.name}`,
    );
    if (!open) return;
    const live = p.workspaces.filter((w) => !w.archived);
    for (const ws of live.filter((w) => worktreeOrigin(w) === 'beluga')) wsRow(ws, '  ');
    // Worktrees other apps made stay folded so they don't drown yours. Claude Code's own
    // sub-agent worktrees aren't shown at all: they have no conversation here (tidy them up in ⋯).
    const external = live.filter((w) => worktreeOrigin(w) === 'external');
    if (external.length) {
      const key = `external:${p.id}`;
      const showing = toggled.has(key) || external.some((w) => w.id === current);
      add([{ text: `    ${showing ? '▾' : '▸'} Other worktrees `, color: theme.muted }, { text: String(external.length), color: theme.muted, bold: true }], { type: 'toggle_fold', key }, `${showing ? 'Hide' : 'Show'} worktrees made outside Beluga`);
      if (showing) for (const ws of external) wsRow(ws, '    ');
    }
    const archived = p.workspaces.filter((w) => w.archived);
    if (archived.length) {
      const showing = toggled.has(`archive:${p.id}`);
      add(plain(`    ${showing ? '▾' : '▸'} Archived (${archived.length})`, { color: theme.muted }), { type: 'toggle_archive', projectId: p.id }, showing ? 'Hide archived workspaces' : 'Show archived workspaces');
      if (showing) {
        for (const ws of archived) {
          add([{ text: '      ' }, { text: `${glyph.ring} ${ws.name}`, color: theme.muted }], { type: 'archived_menu', id: ws.id }, `${ws.name}: restore, open folder, or delete`);
        }
      }
    }
  };

  addWithButtons(section('PROJECTS', theme.info), [{ label: '+ add', color: theme.info, action: { type: 'add_project' }, hint: 'Add a project, or a folder of projects' }], { type: 'none' }, '');
  if (!repos.length) add(plain('  No projects found yet', { color: theme.border }));
  for (const p of loose) projectBlock(p);
  for (const [name, list] of grouped) {
    lines.push([]);
    const open = !toggled.has(`group:${name}`);
    add([{ text: open ? '▾ ' : '▸ ', color: theme.muted }, { text: name.toUpperCase(), color: theme.accent, bold: true }, { text: ` ${list.length}`, color: theme.muted }], { type: 'toggle_group', name }, open ? `Collapse ${name}` : `Expand ${name}`);
    if (open) for (const p of list) projectBlock(p);
  }
  return { lines, zones };
}

/** A top tab: the view it opens, its label (and a shorter one for narrow screens), and what's new there. */
export interface TopTab {
  readonly kind: 'room' | 'files' | 'overview' | 'search' | 'usage' | 'terminal';
  readonly label: string;
  readonly short: string;
  readonly hint: string;
  /** Something new there since you looked (0 = nothing). */
  readonly badge: number;
  /** The badge asks for you (a workspace waiting on an approval or a conflict). */
  readonly urgent?: boolean;
}

/** Workspaces worth a look in the Overview: Claude finished or wrote there, or one needs you. */
export function overviewNews(state: AppState): { count: number; urgent: boolean } {
  let count = 0;
  let urgent = false;
  for (const p of state.projects) {
    for (const w of p.workspaces) {
      if (w.archived) continue;
      const needs = Boolean(state.conflicts[w.id]?.length) || activityOf(state.log, `ws:${w.id}`).awaiting;
      if (needs) urgent = true;
      if (needs || state.unread[`ws:${w.id}`]) count++;
    }
  }
  return { count, urgent };
}

/** Option+N on a Mac, Alt+N elsewhere: the quick key for tab N, shown only in hover hints. */
export const tabKey = (n: number, computer: ComputerKind = COMPUTER): string => (computer === 'mac' ? `⌥${n}` : `Alt+${n}`);

/** The six top tabs, in order (Option/Alt+1…6 jump to them). */
export function topTabs(state: AppState): TopTab[] {
  const solo = state.peers.length <= 1;
  const files = newShares(state);
  const news = state.view.kind === 'overview' ? { count: 0, urgent: false } : overviewNews(state);
  const tabs: TopTab[] = [
    { kind: 'room', label: solo ? 'Chat' : 'Group chat', short: 'Chat', hint: solo ? 'Talk with your agent, or @a-workspace to reach the agent working there' : 'Chat with everyone in the room and their agents', badge: state.unread.room ?? 0 },
    { kind: 'files', label: 'Shared files', short: 'Files', hint: files ? `${files} new shared folder${files === 1 ? '' : 's'}: browse what friends and the room share` : 'Browse folders friends and the room share', badge: files },
    { kind: 'overview', label: 'Overview', short: 'Overview', hint: news.count ? `${news.count} workspace${news.count === 1 ? '' : 's'} to look at${news.urgent ? ' (one needs you)' : ''}: every worktree and chat at a glance` : 'Every worktree and chat at a glance', badge: news.count, urgent: news.urgent },
    { kind: 'search', label: 'Search', short: 'Search', hint: 'Search every conversation: type below, ↑↓ choose, Enter opens', badge: 0 },
    { kind: 'usage', label: 'Usage', short: 'Usage', hint: 'Disk space and agent tokens per workspace', badge: 0 },
    { kind: 'terminal', label: 'Terminal', short: 'Terminal', hint: 'Your own shell in the current project (or home) folder; click it to type', badge: 0 },
  ];
  return tabs.map((t, i) => ({ ...t, hint: `${t.hint} · ${tabKey(i + 1)}` }));
}

/** The tab Ctrl+Tab (+1) or Ctrl+Shift+Tab (-1) goes to; from a workspace, the first or last one. */
export function stepTab(state: AppState, delta: 1 | -1): TopTab['kind'] {
  const kinds = topTabs(state).map((t) => t.kind);
  const at = kinds.indexOf(state.view.kind as TopTab['kind']);
  if (at < 0) return delta > 0 ? kinds[0]! : kinds[kinds.length - 1]!;
  return kinds[(at + delta + kinds.length) % kinds.length]!;
}

/** Where you are past the tabs, when it isn't one of them (a workspace, a draft…). */
function breadcrumb(state: AppState): { text: string; color: string } | undefined {
  const v = state.view;
  if (v.kind === 'workspace') {
    const ws = findWorkspace(state.projects, v.id);
    return ws ? { text: ws.name, color: theme.accent } : undefined;
  }
  if (v.kind === 'draft') return { text: 'New chat', color: theme.accent };
  if (v.kind === 'draft_worktree') return { text: 'New worktree', color: theme.accent };
  if (v.kind === 'shared') {
    const w = state.shared.find((x) => x.id === v.id);
    return w ? { text: w.name, color: theme.ok } : undefined;
  }
  return undefined;
}

const CRUMB = '  › ';

/**
 * The top tabs on one line that never wraps: full labels when they fit, shorter ones when
 * they don't, and the `› workspace` breadcrumb shortened (or left out) to fit what's left.
 */
export function tabsModel(state: AppState, width: number): Model {
  const tabs = topTabs(state);
  const crumb = breadcrumb(state);
  const badgeText = (t: TopTab): string => (t.badge ? ` ${t.badge > 99 ? '99+' : t.badge}` : '');
  const tabsWidth = (short: boolean): number => tabs.reduce((n, t, i) => n + (short ? t.short : t.label).length + 2 + badgeText(t).length + (i ? 1 : 0), 0);
  // Room for at least a few letters of the breadcrumb, if there is one.
  const crumbMin = crumb ? CRUMB.length + Math.min(crumb.text.length, 4) : 0;
  const short = tabsWidth(false) + crumbMin > width;
  const segs: Seg[] = [];
  const zones: Zone[] = [];
  let x = 0;
  tabs.forEach((t, i) => {
    if (i) {
      segs.push({ text: ' ' });
      x += 1;
    }
    const active = state.view.kind === t.kind;
    const label = ` ${short ? t.short : t.label}`;
    const badge = badgeText(t);
    segs.push({ text: label, color: active ? theme.text : theme.muted, bold: active, inverse: active });
    if (badge) segs.push({ text: badge, color: t.urgent ? theme.warn : t.kind === 'files' ? theme.info : theme.claude, bold: true, inverse: active });
    segs.push({ text: ' ', inverse: active });
    const w = label.length + badge.length + 1;
    zones.push({ x0: x, x1: x + w - 1, y: 0, action: { type: 'view', view: { kind: t.kind } }, hint: t.hint });
    x += w;
  });
  const room = width - x - CRUMB.length;
  if (crumb && room >= Math.min(crumb.text.length, 2)) {
    const text = crumb.text.length > room ? `${crumb.text.slice(0, Math.max(1, room - 1))}…` : crumb.text;
    segs.push({ text: CRUMB, color: theme.border }, { text, color: crumb.color, bold: true });
  }
  return { lines: [truncate(segs, width)], zones: zones.filter((z) => z.x1 < width) };
}

// ---------------------------------------------------------------- overview

/** The buttons a workspace row offers besides opening it: only what makes sense right now. */
function rowActions(state: AppState, p: Project, w: Workspace): Array<{ label: string; action: UiAction; hint: string }> {
  const pr = state.prs[w.id];
  const conflict = Boolean(state.conflicts[w.id]?.length);
  const ahead = w.kind === 'worktree' ? (w.status?.ahead ?? 0) : 0;
  return [
    ...(conflict ? [{ label: 'Solve conflict', action: { type: 'ws', id: w.id, action: 'merge_claude' } as UiAction, hint: 'Ask your agent to resolve the merge conflict' }] : []),
    ...(ahead > 0 && !(w.status?.changed ?? 0) && !conflict ? [{ label: 'Merge Locally', action: { type: 'ws', id: w.id, action: 'merge' } as UiAction, hint: `Merge ${w.branch} into ${p.name}'s main folder on this computer (nothing on GitHub)` }] : []),
    ...(w.kind === 'worktree' && (ahead > 0 || pr) ? [{ label: pr ? 'View PR' : 'Open PR', action: { type: 'ws', id: w.id, action: 'pr' } as UiAction, hint: pr ? describePr(pr) : 'Your agent opens a pull request with a short description' }] : []),
  ];
}

/**
 * Everything in progress as one quiet list, grouped by project: name, one state phrase,
 * and only the buttons that apply. Click a row to open it.
 */
export function overviewModel(state: AppState, frame: number, width: number, now = Date.now()): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const groups = state.projects
    .map((p) => ({ p, list: p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && worktreeOrigin(w) !== 'agent') }))
    .filter((g) => g.list.length);
  const all = groups.flatMap((g) => g.list);
  const working = all.filter((w) => activityOf(state.log, `ws:${w.id}`).running).length;
  const needsYou = all.filter((w) => state.conflicts[w.id]?.length || activityOf(state.log, `ws:${w.id}`).awaiting).length;
  lines.push([
    { text: `${all.length} in progress`, color: theme.text, bold: true },
    ...(working ? [{ text: '  ·  ', color: theme.border }, { text: `${SPINNER[frame % SPINNER.length]} ${working} working`, color: theme.claude }] : []),
    ...(needsYou ? [{ text: '  ·  ', color: theme.border }, { text: `${glyph.wait} ${needsYou} need${needsYou === 1 ? 's' : ''} you`, color: theme.warn }] : []),
  ]);
  if (!all.length) {
    lines.push([]);
    lines.push(plain(`Nothing in progress. Use +${BRANCH} on a project to start a worktree, or + new under CHATS.`, { color: theme.muted }));
    return { lines, zones };
  }
  const nameW = Math.min(Math.max(...all.map((w) => w.name.length)) + 2, 30, Math.floor(width * 0.4));
  for (const { p, list } of groups) {
    lines.push([]);
    lines.push([{ text: p.root ? p.name : 'Chats', color: theme.muted, bold: true }, { text: ` ${list.length}`, color: theme.border }]);
    for (const w of list) {
      const st = stateOf(state, w, frame, now);
      const pr = state.prs[w.id];
      const actions = rowActions(state, p, w);
      const right: Seg[] = [];
      const y = lines.length;
      let rx = width - actions.reduce((n, a, i) => n + a.label.length + (i ? 2 : 0), 0);
      actions.forEach((a, i) => {
        if (i) right.push({ text: '  ' });
        right.push({ text: a.label, color: theme.info });
        zones.push({ x0: rx, x1: rx + a.label.length - 1, y, action: a.action, hint: a.hint });
        rx += a.label.length + 2;
      });
      const left: Line = [
        { text: `  ${w.kind === 'chat' ? '◇' : BRANCH} `, color: theme.muted },
        ...pad(truncate([{ text: w.name, color: theme.text }], nameW - 1), nameW),
        { text: `${st.icon} `, color: st.color },
        { text: st.label, color: st.color === theme.ok ? theme.muted : st.color },
        ...(pr ? [{ text: `  ·  ${describePr(pr)}`, color: pr.checks === 'failing' ? theme.error : theme.muted }] : []),
      ];
      const rw = lineWidth(right);
      zones.push({ x0: 0, x1: Math.max(0, width - rw - 2), y, action: { type: 'open_ws', id: w.id }, hint: `Open ${w.name}: ${st.label}` });
      lines.push(rw ? split(truncate(left, width - rw - 2), right, width) : truncate(left, width));
    }
  }
  return { lines, zones };
}

// ---------------------------------------------------------------- workspace header

/**
 * Workspace header: where you are + state, the Chat/Files/Diff tabs, and every action as
 * a button. Buttons that can't do anything right now are dimmed and explain why.
 */
/** "Share" (or "Shared · 2") opens who's in this workspace and lets you invite or remove people. */
function sharedButton(state: AppState, wsId: string): WorkspaceButton {
  // Friends it's shared with over the network count too, not only the room's members (BLG-340).
  const count = worktreeShareRows(state, wsId).filter((r) => r.access !== 'none').length;
  return {
    label: count ? `Shared · ${count}` : 'Share',
    action: 'share',
    tone: 'info',
    hint: count ? `${count} ${count === 1 ? 'person is' : 'people are'} in this workspace: invite or remove people` : 'Invite a friend to just this worktree: they see the chat and files and can ask your agent here',
  };
}

/** A workspace's views: its chat, files, what changed (not for chats), and its terminal. */
export function workspaceTabs(ws: Workspace): Array<{ label: string; tab: WorkspaceTab; hint: string }> {
  return [
    { label: 'Chat', tab: 'chat', hint: 'Your conversation with your agent' },
    { label: 'Files', tab: 'files', hint: 'Browse this folder' },
    ...(ws.kind === 'chat' ? [] : [{ label: 'Diff', tab: 'review' as WorkspaceTab, hint: 'See exactly what changed' }]),
    { label: 'Terminal', tab: 'terminal', hint: 'A real shell in this folder, plus setup and run' },
  ];
}

/** One button of a workspace's toolbar. `tone`: a color that means something (a failing PR, a conflict). */
export interface WorkspaceButton {
  readonly label: string;
  readonly action: WorkspaceAction;
  readonly hint: string;
  /** Shown but inactive (nothing to merge yet); the hint says why. */
  readonly disabled?: boolean;
  readonly tone?: 'error' | 'ok' | 'info';
}

/** The toolbar of a workspace, in order (your hidden buttons left out). */
export function workspaceButtons(state: AppState, ws: Workspace): WorkspaceButton[] {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const changed = ws.status?.changed ?? 0;
  const ahead = ws.status?.ahead ?? 0;
  const conflict = Boolean(state.conflicts[ws.id]?.length);
  const pr = state.prs[ws.id];
  const scripts = project?.scripts;
  // In your room with their Claude, or a friend over the network (BLG-341).
  const friends = handoffPeople(state).length > 0;
  // What its runtime does instead (BLG-461): Compact greyed with why, Fork saying what comes along.
  const runtime = runtimeHere(ws.agent, state.self);
  const noCompact = fallbackFor(runtime, 'compact');
  const all: WorkspaceButton[] = ws.archived
    ? [
        { label: 'Restore', action: 'restore', hint: 'Bring this workspace back' },
        { label: 'Delete', action: 'delete', hint: 'Delete permanently', tone: 'error' },
      ]
    : [
        ...(scripts?.run ? ([{ label: 'Run', action: 'run', hint: `Start ${scripts.run.command} in the Terminal tab` }] as WorkspaceButton[]) : []),
        // A main folder is questions only: a review there would want to fix things.
        ...(ws.askOnly ? [] : ([{ label: 'Review', action: 'review_claude', hint: 'Ask your agent to check everything: bugs, security, tests and quality' }] as WorkspaceButton[])),
        ...(ws.kind === 'worktree'
          ? ([
              { label: 'Commit', action: 'commit', hint: changed ? `Commit ${changed} changed file(s)` : 'Nothing to commit', disabled: !changed },
              pr
                ? { label: `PR #${pr.number}${pr.checks === 'passing' ? ' ✓' : pr.checks === 'failing' ? ' ✗' : pr.checks === 'pending' ? ' …' : ''}`, action: 'pr', hint: `${describePr(pr)}: open it, fix checks, or update it`, tone: pr.checks === 'failing' ? 'error' : pr.state === 'MERGED' ? 'ok' : 'info' }
                : { label: 'PR', action: 'pr', hint: ahead || changed ? 'Your agent pushes and opens a pull request with a short description' : 'Nothing to put in a pull request yet', disabled: !ahead && !changed },
              conflict
                ? { label: 'Solve conflict', action: 'merge_claude', hint: 'Ask your agent to resolve the merge conflict and finish the merge', tone: 'error' }
                : {
                    label: 'Merge Locally',
                    action: 'merge',
                    hint: changed ? 'Commit your changes first' : ahead ? `Merge ${ahead} commit(s) into ${project?.name ?? 'the'} main folder` : 'Nothing to merge yet',
                    disabled: !ahead || changed > 0,
                  },
              { label: 'Hand off', action: 'handoff', hint: friends ? "A friend's agent continues this on their computer" : state.network.enabled ? 'Add a friend first; then their agent can take this over' : 'Turn on the Beluga network to hand this to a friend, or invite someone to your room', disabled: !friends },
            ] as WorkspaceButton[])
          : []),
        ...(state.context[`ws:${ws.id}`] ? ([noCompact ? { label: 'Compact', action: 'compact', hint: noCompact, disabled: true } : { label: 'Compact', action: 'compact', hint: 'Shrink the conversation so your agent has room to keep going' }] as WorkspaceButton[]) : []),
        ...(ws.kind !== 'chat' && !ws.askOnly ? ([{ label: 'Fork', action: 'fork', hint: fallbackFor(runtime, 'fork') ?? 'Copy this workspace and its conversation into a new worktree' }] as WorkspaceButton[]) : []),
        { label: FILE_MANAGER, action: 'finder', hint: `Open this folder in ${FILE_MANAGER}` },
        ...(ws.kind !== 'main' ? ([{ label: 'Archive', action: 'archive', hint: 'Put it away; keeps the branch and conversation' }] as WorkspaceButton[]) : []),
        sharedButton(state, ws.id),
      ];
  // You choose which buttons show (Settings → Workspaces → Top bar buttons); hidden ones still work as /commands.
  // "Solve conflict" is never hidden: it's the way out of a conflict.
  return all.filter((b) => b.action === 'merge_claude' || !state.prefs.hiddenButtons.includes(b.action));
}

export function workspaceHeaderModel(state: AppState, ws: Workspace, width: number, frame = 0): Model {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const view = state.view.kind === 'workspace' ? state.view : undefined;
  const st = stateOf(state, ws, frame);
  const zones: Zone[] = [];
  const title: Line = [
    { text: project?.root ? `${project.name} › ` : '', color: theme.muted },
    { text: ws.name, color: theme.text, bold: true },
    { text: ws.kind === 'chat' ? (ws.projectRoot ? '  chat in main folder' : '  agent chat') : ws.branch ? `  ${BRANCH} ${ws.branch}` : '', color: theme.muted },
    { text: '   ' },
    { text: `${st.icon} ${st.label}`, color: st.color },
  ];
  const tabs = workspaceTabs(ws);
  const conflict = Boolean(state.conflicts[ws.id]?.length);
  const buttons = workspaceButtons(state, ws);
  const segs: Seg[] = [];
  let x = 0;
  for (const { label, tab, hint } of tabs) {
    const active = view?.tab === tab;
    const text = ` ${label} `;
    segs.push({ text, color: active ? theme.text : theme.muted, bold: active, inverse: active });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'open_ws', id: ws.id, tab }, hint });
    x += text.length;
    segs.push({ text: ' ' });
    x += 1;
  }
  segs.push({ text: '│ ', color: theme.border });
  x += 2;
  // Buttons that don't fit go under "⋯ More" (a menu), so nothing is ever cut off.
  const MORE = ' ⋯ More ';
  const widths = buttons.map((b) => b.label.length + 2);
  const total = widths.reduce((n, w) => n + w, 0);
  let fit = buttons.length;
  if (x + total > width) {
    fit = 0;
    let used = x + MORE.length;
    while (fit < buttons.length && used + widths[fit]! <= width) used += widths[fit++]!;
  }
  for (const btn of buttons.slice(0, fit)) {
    const text = ` ${btn.label} `;
    segs.push({ text, color: btn.disabled ? theme.border : btn.tone ? theme[btn.tone] : theme.text, bold: !btn.disabled });
    zones.push({ x0: x, x1: x + text.length - 1, y: 1, action: { type: 'ws', id: ws.id, action: btn.action }, hint: btn.hint, disabled: btn.disabled });
    x += text.length;
  }
  const rest = buttons.slice(fit).filter((b) => !b.disabled);
  if (rest.length) {
    segs.push({ text: MORE, color: theme.muted, bold: true });
    zones.push({ x0: x, x1: x + MORE.length - 1, y: 1, action: { type: 'ws_more', id: ws.id, actions: rest.map((b) => ({ action: b.action, label: b.label, hint: b.hint })) }, hint: rest.map((b) => b.label).join(', ') });
  }
  const third: Line = conflict
    ? [{ text: `! Merge conflict in ${state.conflicts[ws.id]?.join(', ')}`, color: theme.error, bold: true }, { text: '   Click "Solve conflict" and your agent will resolve it', color: theme.muted }]
    : [{ text: '─'.repeat(width), color: theme.border }];
  const meter = state.prefs.contextMeter ? contextMeter(state, `ws:${ws.id}`, 12) : [];
  const disk = state.disk[ws.id];
  const tokens = tokensOf(ws.usage);
  const space: Line = [disk !== undefined ? formatBytes(disk) : '', tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ''].filter(Boolean).length
    ? [{ text: [disk !== undefined ? formatBytes(disk) : '', tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ''].filter(Boolean).join(' · '), color: theme.muted }, { text: meter.length ? '   ' : '' }]
    : [];
  const right: Line = [...space, ...meter];
  const titleLine = right.length ? split(title, right, width) : truncate(title, width);
  return { lines: [titleLine, truncate(segs, width), truncate(third, width)], zones: zones.filter((z) => z.x0 < width) };
}

// ---------------------------------------------------------------- review (diff)

export function reviewModel(review: ReviewState | undefined, width: number, height: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  if (!review || review.loading) return { lines: [plain('Loading changes…', { color: theme.muted })], zones };
  if (review.error) return { lines: [plain(review.error, { color: theme.error })], zones };
  const data = review.data;
  if (!data || (!data.files.length && !data.commits.length)) {
    return { lines: [plain('No changes yet compared to the base branch.', { color: theme.muted })], zones };
  }
  const listW = Math.min(44, Math.max(26, Math.floor(width * 0.34)));
  const diffW = width - listW - 3;
  const left: Line[] = [];
  left.push(plain(`${data.commits.length} commit${data.commits.length === 1 ? '' : 's'} · ${data.files.length} file${data.files.length === 1 ? '' : 's'}`, { bold: true, color: theme.text }));
  for (const c of data.commits.slice(0, 5)) left.push([{ text: `${c.hash} `, color: theme.muted }, { text: c.subject, color: theme.text }]);
  if (data.commits.length > 5) left.push(plain(`…${data.commits.length - 5} more`, { color: theme.muted }));
  left.push([]);
  const fileStart = left.length;
  data.files.forEach((f, i) => {
    const sel = i === review.selected;
    const mark = f.state === 'added' || f.state === 'untracked' ? '+' : f.state === 'deleted' ? '−' : '~';
    const counts: Line = f.state === 'untracked' ? [{ text: 'new', color: theme.ok }] : [{ text: `+${f.added}`, color: theme.ok }, { text: ` −${f.removed}`, color: theme.error }];
    left.push(split([{ text: sel ? '▸ ' : '  ', color: theme.accent }, { text: `${mark} `, color: theme.muted }, { text: f.path, color: sel ? theme.text : theme.muted, bold: sel }], counts, listW));
  });
  const right: Line[] = [];
  const diff = review.diff;
  if (diff === undefined) right.push(plain('Loading diff…', { color: theme.muted }));
  else {
    for (const raw of diff.split('\n').slice(review.diffScroll)) {
      if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(raw)) continue;
      const color = raw.startsWith('+') ? theme.ok : raw.startsWith('-') ? theme.error : raw.startsWith('@@') ? theme.info : theme.muted;
      right.push(plain(raw.replace(/\t/g, '  '), { color }));
    }
  }
  for (let r = 0; r < Math.max(1, height); r++) {
    const l = left[r] ?? [];
    const d = right[r] ?? [];
    lines.push([...pad(l, listW), { text: ' │ ', color: theme.border }, ...truncate(d, diffW)]);
  }
  data.files.forEach((_f, i) => zones.push({ x0: 0, x1: listW - 1, y: fileStart + i, action: { type: 'review_file', index: i } }));
  return { lines, zones };
}
