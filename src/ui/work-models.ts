import { type AppState, peerName } from '../core/store.js';
import { TRUST_INFO } from '../core/trust.js';
import { TRUST_LEVELS } from '../shared/settings-schema.js';
import { unreadCount } from '../core/work-store.js';
import { snippet } from '../core/search.js';
import { formatBytes } from '../shared/format.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { tokensOf } from '../workspaces/usage-days.js';
import { type Line, type Seg, lineWidth, pad, plain, truncate } from './text.js';
import { glyph, theme } from './theme.js';
import { type Model, type UiAction, type Zone, split } from './workspace-models.js';

/** A row of inverse buttons; registers each button's zone on row `y`. */
export function buttons(list: ReadonlyArray<{ label: string; action: UiAction; hint: string; color?: string; active?: boolean }>, y: number, zones: Zone[], x0 = 0, gap = 1): Seg[] {
  const segs: Seg[] = [];
  let x = x0;
  if (x0) segs.push({ text: ' '.repeat(x0) });
  for (const b of list) {
    const text = ` ${b.label} `;
    segs.push({ text, color: b.color ?? theme.text, bold: true, inverse: b.active ?? true });
    zones.push({ x0: x, x1: x + text.length - 1, y, action: b.action, hint: b.hint });
    segs.push({ text: ' '.repeat(gap) });
    x += text.length + gap;
  }
  return segs;
}

// ---------------------------------------------------------------- top bar

export const formatTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * The very top line: logo, room, and on the right your Claude's usage, people, connection,
 * and the inbox (click it to see what happened while you were elsewhere).
 */
export function topBarModel(state: AppState, width: number): Model {
  const zones: Zone[] = [];
  const solo = state.status === 'connected' && state.peers.length <= 1 && !state.hosting && !state.invite;
  const status = solo
    ? { label: 'solo', color: theme.muted, icon: glyph.ring }
    : state.status === 'connected'
      ? { label: 'live', color: theme.ok, icon: glyph.dot }
      : state.status === 'connecting'
        ? { label: 'connecting…', color: theme.warn, icon: glyph.wait }
        : { label: 'offline · reconnecting', color: theme.error, icon: glyph.fail };
  const left: Line = [
    { text: glyph.logo, color: theme.text, bold: true },
    { text: '_ ', color: theme.accent, bold: true },
    { text: 'Beluga', color: theme.text, bold: true },
    { text: '  ' },
    { text: state.room, bold: true },
  ];
  const mine = state.peers.find((p) => p.peerId === state.self?.peerId)?.usage;
  const unread = unreadCount(state);
  const people = state.peers.length;
  const right: Seg[] = [];
  if (state.follow) right.push({ text: `${glyph.eye} following ${peerName(state, state.follow)}   `, color: theme.warn });
  if (mine?.fiveHour || mine?.week) right.push({ text: `your Claude plan ${mine.fiveHour ? `5h ${mine.fiveHour.pct}%` : ''}${mine.fiveHour && mine.week ? ' · ' : ''}${mine.week ? `week ${mine.week.pct}%` : ''}   `, color: theme.muted });
  right.push({ text: `${people} ${people === 1 ? 'person' : 'people'}   `, color: theme.muted });
  right.push({ text: `${status.icon} ${status.label}   `, color: status.color });
  const inbox = unread ? ` ● ${unread} new ` : ' Inbox ';
  right.push({ text: inbox, color: unread ? theme.claude : theme.muted, bold: Boolean(unread), inverse: Boolean(unread) });
  const line = split(left, right, width);
  const x1 = lineWidth(line) - 1;
  zones.push({ x0: x1 - inbox.length + 1, x1, y: 0, action: { type: 'inbox' }, hint: unread ? `${unread} thing${unread === 1 ? '' : 's'} happened while you were elsewhere` : 'What happened in other workspaces' });
  return { lines: [line], zones };
}

// ---------------------------------------------------------------- search

/** Search results: one card-ish row per message, newest first. Click (or Enter) opens it. */
export function searchModel(state: AppState, width: number, frame = 0): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const s = state.search;
  void frame;
  if (!s.query.trim()) {
    lines.push(plain('Type in the box below to search every conversation: chats, worktrees, archived ones too.', { color: theme.muted }));
    lines.push(plain('All words must match. ↑↓ choose, Enter opens it.', { color: theme.muted }));
    return { lines, zones };
  }
  lines.push([
    { text: `${s.hits.length}${s.hits.length >= 200 ? '+' : ''} result${s.hits.length === 1 ? '' : 's'}`, color: theme.text, bold: true },
    { text: ` for "${s.query}" in ${s.searched} conversation${s.searched === 1 ? '' : 's'}`, color: theme.muted },
  ]);
  lines.push([]);
  if (!s.hits.length) lines.push(plain('Nothing found. Try fewer or different words.', { color: theme.muted }));
  s.hits.forEach((hit, i) => {
    const selected = i === s.cursor;
    const when = new Date(hit.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const head: Line = [
      { text: selected ? '▸ ' : '  ', color: theme.accent },
      { text: hit.place, color: selected ? theme.text : theme.info, bold: true },
      ...(hit.archived ? [{ text: ' (archived)', color: theme.muted }] : []),
      { text: hit.who ? `  ${hit.who}` : '', color: theme.muted },
    ];
    const y = lines.length;
    lines.push(split(head, [{ text: when, color: theme.muted }], width));
    const snip = snippet(hit, width - 6);
    lines.push(truncate([{ text: '    ' }, { text: snip.before, color: theme.muted }, { text: snip.match, color: theme.text, bold: true, underline: true }, { text: snip.after, color: theme.muted }], width));
    zones.push({ x0: 0, x1: width - 1, y, action: { type: 'search_hit', index: i }, hint: `Open ${hit.place}` });
    zones.push({ x0: 0, x1: width - 1, y: y + 1, action: { type: 'search_hit', index: i }, hint: `Open ${hit.place}` });
  });
  return { lines, zones };
}

/** Where the selected search result is, so the list can scroll to it. */
export const searchCursorRow = (state: AppState): number => 2 + state.search.cursor * 2;

// ---------------------------------------------------------------- usage & space

const bar = (value: number, max: number, cells: number, color: string): Seg[] => {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * cells)) : 0;
  return [
    { text: '█'.repeat(filled), color },
    { text: '░'.repeat(Math.max(0, cells - filled)), color: theme.border },
  ];
};

/**
 * Every workspace's disk space and Claude usage side by side, as bars, biggest first.
 * Archiving a worktree frees its space (the branch and conversation are kept).
 */
export function usageModel(state: AppState, width: number): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  const rows = state.projects
    .flatMap((p) => p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) !== 'agent').map((w) => ({ p, w, disk: state.disk[w.id] ?? 0, tokens: tokensOf(w.usage), cost: w.usage?.cost ?? 0 })))
    .filter((r) => r.disk > 0 || r.tokens > 0)
    .sort((a, b) => b.disk - a.disk || b.tokens - a.tokens);
  const totalDisk = rows.filter((r) => r.w.kind !== 'main').reduce((n, r) => n + r.disk, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  lines.push([
    { text: 'Worktrees take ', color: theme.muted },
    { text: formatBytes(totalDisk), color: theme.text, bold: true },
    { text: '   ·   agents used ', color: theme.muted },
    { text: totalTokens ? `${formatTokens(totalTokens)} tokens` : 'nothing yet', color: theme.text, bold: true },
    { text: totalCost ? ` (≈ $${totalCost.toFixed(2)})` : '', color: theme.muted },
  ]);
  lines.push(plain('Archive a worktree to free its space; its branch and conversation are kept.', { color: theme.muted }));
  lines.push([]);
  if (!rows.length) {
    lines.push(plain('Measuring… sizes show up in a few seconds.', { color: theme.muted }));
    return { lines, zones };
  }
  const nameW = Math.min(30, Math.max(14, Math.floor(width * 0.28)));
  const cells = Math.max(6, Math.floor((width - nameW - 46) / 2));
  const maxDisk = Math.max(...rows.map((r) => r.disk), 1);
  const maxTokens = Math.max(...rows.map((r) => r.tokens), 1);
  lines.push([
    ...pad(plain('', {}), nameW + 2),
    ...pad(plain('disk', { color: theme.muted }), cells + 10),
    ...pad(plain('Agent tokens', { color: theme.muted }), cells + 9),
    { text: 'cost', color: theme.muted },
  ]);
  for (const r of rows) {
    const y = lines.length;
    const label = `${r.p.root ? `${r.p.name} › ` : ''}${r.w.name}`;
    const archive = r.w.kind === 'worktree' && !r.w.external ? ' Archive ' : '';
    const row: Seg[] = [
      { text: r.w.kind === 'main' ? '⌂ ' : r.w.kind === 'chat' ? '◇ ' : '⌥ ', color: theme.muted },
      ...pad(plain(label, { color: theme.text }), nameW),
      ...bar(r.disk, maxDisk, cells, theme.info),
      ...pad(plain(` ${r.disk ? formatBytes(r.disk) : '–'}`, { color: theme.info }), 10),
      ...bar(r.tokens, maxTokens, cells, theme.claude),
      ...pad(plain(` ${r.tokens ? formatTokens(r.tokens) : '–'}`, { color: r.tokens ? theme.claude : theme.muted }), 9),
      ...pad(plain(r.cost ? `$${r.cost.toFixed(2)}` : '', { color: theme.muted }), 8),
    ];
    const x = lineWidth(row) + 1;
    if (archive) {
      row.push({ text: ' ' }, { text: archive, color: theme.text, inverse: true });
      zones.push({ x0: x, x1: x + archive.length - 1, y, action: { type: 'ws', id: r.w.id, action: 'archive' }, hint: `Archive ${r.w.name} to free ${r.disk ? formatBytes(r.disk) : 'its space'}` });
    }
    zones.push({ x0: 0, x1: x - 2, y, action: { type: 'open_ws', id: r.w.id }, hint: `Open ${r.w.name}` });
    lines.push(truncate(row, width));
  }
  return { lines, zones };
}

// ---------------------------------------------------------------- drafts

/** A new worktree or chat: what happens, then templates to start from (click one). */
export function draftModel(state: AppState, width: number, kind: 'worktree' | 'chat'): Model {
  const lines: Line[] = [];
  const zones: Zone[] = [];
  if (kind === 'worktree') {
    lines.push(plain('A new worktree from the latest origin, with its own agent conversation.', { color: theme.text }));
    lines.push(plain('Describe the task below. A small model names the worktree from it, then your agent gets started.', { color: theme.muted }));
    lines.push(plain(state.prefs.autoSetup ? 'The project’s setup (e.g. npm install) runs in its Terminal tab.' : 'Setup scripts are off (Settings → Workspaces).', { color: theme.muted }));
  } else {
    lines.push(plain('A fresh conversation with your agent, with all its tools.', { color: theme.text }));
    lines.push(plain('Type your first message below to start.', { color: theme.muted }));
  }
  lines.push(plain('Esc goes back without creating anything.', { color: theme.muted }));
  lines.push([]);
  lines.push(plain('Or start from a template:', { color: theme.text, bold: true }));
  for (const t of state.templates.slice(0, 12)) {
    const y = lines.length;
    lines.push(truncate([{ text: `  ${glyph.arrow} ` , color: theme.accent }, { text: t.name, color: theme.text, bold: true }, { text: t.plan ? '  plans first' : '', color: theme.info }, { text: `  ${t.prompt.replace(/\s+/g, ' ')}`, color: theme.muted }], width));
    zones.push({ x0: 0, x1: width - 1, y, action: { type: 'template', id: t.id }, hint: `Fill the box with "${t.name}"` });
  }
  const y = lines.length;
  lines.push(buttons([{ label: 'Manage templates…', action: { type: 'templates_menu' }, hint: 'Remove yours, or save new ones', color: theme.muted }], y, zones, 2));
  return { lines, zones };
}

// ---------------------------------------------------------------- trust card

/** Someone new joined: one click to say how much you trust them (above the box you type in). */
export function trustCardModel(state: AppState, peerId: string, width: number): Model {
  const zones: Zone[] = [];
  const name = peerName(state, peerId);
  const more = state.trustPrompts.length - 1;
  const lines: Line[] = [
    truncate([{ text: `${glyph.dot} `, color: theme.info }, { text: `${name} joined.`, color: theme.text, bold: true }, { text: ` How much do you trust ${name}?`, color: theme.info, bold: true }, { text: more > 0 ? `   +${more} more` : '', color: theme.muted }], width),
    plain(`  This decides what ${name} can do with your agent on this computer. Change it any time by clicking ${name} in People.`, { color: theme.muted }),
  ];
  const y = lines.length;
  lines.push(
    buttons(
      [
        ...TRUST_LEVELS.map((level) => ({ label: TRUST_INFO[level].label, action: { type: 'trust', peerId, level } as UiAction, hint: TRUST_INFO[level].detail, color: level === 'full' ? theme.warn : level === 'blocked' ? theme.muted : theme.info })),
        { label: 'Later', action: { type: 'trust_later', peerId } as UiAction, hint: `Keep your default for now (${TRUST_INFO.ask.label.toLowerCase()} unless you changed it)`, color: theme.muted },
      ],
      y,
      zones,
      2,
      2,
    ),
  );
  return { lines, zones };
}

// ---------------------------------------------------------------- terminal

export interface TerminalTabInfo {
  readonly key: string;
  readonly label: string;
  readonly running: boolean;
  readonly exitCode?: number | null;
}

/** The session tabs at the start of a terminal bar; returns where the next item goes. */
function sessionTabs(tabs: readonly TerminalTabInfo[], active: string, segs: Seg[], zones: Zone[]): number {
  let x = 0;
  for (const t of tabs) {
    const mark = t.running ? '● ' : t.exitCode === 0 ? '✓ ' : t.exitCode !== undefined ? '✗ ' : '';
    const text = ` ${mark}${t.label} `;
    const on = t.key === active;
    segs.push({ text, color: on ? theme.text : t.exitCode !== undefined && t.exitCode !== 0 && !t.running ? theme.error : theme.muted, bold: on, inverse: on });
    zones.push({ x0: x, x1: x + text.length - 1, y: 0, action: { type: 'term_tab', key: t.key }, hint: `Show ${t.label}` });
    segs.push({ text: ' ' });
    x += text.length + 1;
  }
  return x;
}

/** How to leave the terminal, quietly on the right of its bar. */
const leaveHint = (focused: boolean): Seg => (focused ? { text: 'typing goes to the terminal · Ctrl+] or click outside to leave', color: theme.info } : { text: 'click the terminal to type in it', color: theme.muted });

/**
 * The row above the global Terminal tab: its shells (Shell 1, Shell 2…), "+" for another
 * one, and the folder they start in.
 */
export function globalTerminalBarModel(tabs: readonly TerminalTabInfo[], active: string, width: number, opts: { focused: boolean; dir: string }): Model {
  const zones: Zone[] = [];
  const segs: Seg[] = [];
  let x = sessionTabs(tabs, active, segs, zones);
  const plus = ' + ';
  segs.push({ text: plus, color: theme.info, bold: true });
  zones.push({ x0: x, x1: x + plus.length - 1, y: 0, action: { type: 'term_new' }, hint: `Open another shell in ${opts.dir}` });
  x += plus.length;
  const right: Line = [leaveHint(opts.focused)];
  const left: Line = [...segs, { text: `  ${opts.dir}`, color: theme.border }];
  // The folder is the first thing to go when space runs out; the leave hint stays.
  return { lines: [lineWidth(left) + lineWidth(right) + 1 <= width ? split(left, right, width) : split(segs, right, width)], zones: zones.filter((z) => z.x1 < width) };
}

/** The row above the terminal: its sessions (Shell, Setup, Run) and what you can do. */
export function terminalBarModel(wsId: string, tabs: readonly TerminalTabInfo[], active: string, width: number, opts: { hasRun: boolean; hasSetup: boolean; focused: boolean }): Model {
  const zones: Zone[] = [];
  const segs: Seg[] = [];
  let x = sessionTabs(tabs, active, segs, zones);
  segs.push({ text: '│ ', color: theme.border });
  x += 2;
  const runTab = tabs.find((t) => t.key.endsWith(':run'));
  const actions: Array<{ label: string; action: UiAction; hint: string }> = [
    ...(opts.hasRun ? [runTab?.running ? { label: 'Stop', action: { type: 'ws', id: wsId, action: 'stop_run' } as UiAction, hint: 'Stop the run command' } : { label: runTab ? 'Restart' : 'Run', action: { type: 'ws', id: wsId, action: 'run' } as UiAction, hint: "Start the project's run command" }] : []),
    ...(opts.hasSetup ? [{ label: 'Run setup again', action: { type: 'ws', id: wsId, action: 'setup' } as UiAction, hint: "Run the project's setup command again" }] : []),
  ];
  for (const a of actions) {
    const text = ` ${a.label} `;
    segs.push({ text, color: theme.text, bold: true });
    zones.push({ x0: x, x1: x + text.length - 1, y: 0, action: a.action, hint: a.hint });
    x += text.length;
  }
  return { lines: [split(segs, [leaveHint(opts.focused)], width)], zones };
}
