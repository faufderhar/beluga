import { type AppState, type LogItem, isRunning } from '../../../../src/core/store.js';
import { type Plan, planTitle } from '../../../../src/core/plans/model.js';
import { isLivePlan, isPlanOwned, planConversations, planOwnerOf } from '../../../../src/core/plans/owner.js';
import { type Sentinel, sentinelChannels, sentinelOfChannel } from '../../../../src/core/sentinel/model.js';
import { channelsOf, laterUntil, triageFacts } from '../../../../src/core/triage/facts.js';
import { type ChatCategory, type ChatTriage, categoryOf, triageKey } from '../../../../src/core/triage/model.js';
import { hhmm, span } from '../../../../src/shared/clock.js';
import { dateLocale } from '../i18n/index.js';
import { remindLabel } from '../../../../src/shared/remind.js';
import { threadNesting } from '../../../../src/ui/thread-tree.js';
import { activityOf } from '../../../../src/ui/workspace-models.js';
import type { Project, Workspace } from '../../../../src/workspaces/types.js';

/**
 * What each conversation in the sidebar is waiting on, Slack-style: it needs you (an approval,
 * Claude's question or plan, a merge conflict, failed checks), it has news you haven't seen
 * (Claude finished, a friend wrote), Claude is working, or nothing. Pure, so it's tested on its
 * own (tests/mac-attention.test.ts); the sidebar only draws it.
 */

/** `stuck`: a plan gave up moving one of its tasks or milestones on by itself (it's said why). */
export type Need = 'approval' | 'question' | 'plan' | 'conflict' | 'checks' | 'stuck';

/** Needs you > unread > working > idle: the one a row shows. */
export type Level = 'needs' | 'unread' | 'working' | 'idle';

export interface Signal {
  readonly level: Level;
  /** New messages since you last looked (cleared by opening the conversation). */
  readonly unread: number;
  /** What waits for you (cleared only by answering or fixing it). */
  readonly need?: Need;
  readonly working: boolean;
  /** What a tooltip says ("Claude finished · 2 new messages"); empty when idle. */
  readonly tip: string;
  /** Remind Me Later: when it reminds you (epoch ms). Till then its news and problems wait; only your agent's asks still show. */
  readonly remindAt?: number;
}

export const IDLE_SIGNAL: Signal = { level: 'idle', unread: 0, working: false, tip: '' };

type Source = Pick<AppState, 'log' | 'unread' | 'questions' | 'approvals' | 'conflicts' | 'prs' | 'claudeCode' | 'plans' | 'board' | 'sentinel'>;

const NEED_TIPS: Record<Need, string> = {
  approval: 'Your agent needs your approval',
  question: 'Your agent asks a question',
  plan: 'Your agent has a plan for you to approve',
  conflict: 'A merge conflict to resolve',
  checks: 'Checks failed on its pull request',
  stuck: 'Stuck: Beluga couldn’t move it on by itself',
};

export const needTip = (need: Need): string => NEED_TIPS[need];

const plural = (n: number, word: string): string => `${n} new ${word}${n === 1 ? '' : 's'}`;

/** What holds a conversation up. `ws`: one of your workspaces (conflicts and checks are kept per workspace). */
export function needOf(state: Source, channel: string, ws?: string): Need | undefined {
  if (state.approvals.some((a) => a.channel === channel) || activityOf(state.log, channel).awaiting) return 'approval';
  const asks = state.questions.filter((q) => q.channel === channel);
  if (asks.some((q) => q.question.kind === 'plan')) return 'plan';
  if (asks.length) return 'question';
  if (ws && state.conflicts[ws]?.length) return 'conflict';
  const pr = ws ? state.prs[ws] : undefined;
  if (pr?.state === 'OPEN' && pr.checks === 'failing') return 'checks';
  return undefined;
}

/** How the news starts: Claude finished (or stopped), when its answer is the last thing there. */
function newsLead(state: Source, channel: string): string | undefined {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const item = state.log[i]!;
    if (item.channel !== channel) continue;
    if (item.type !== 'agent') return undefined;
    return item.status === 'done' ? 'Your agent finished' : item.status === 'error' ? 'Your agent stopped' : undefined;
  }
  return undefined;
}

/** What your agent can be fixing (Fix with Your Agent, Resolve): while it works, it's no problem to show. */
const FIXABLE: ReadonlySet<Need> = new Set(['checks', 'conflict']);

/** One conversation's signal. `ws`: the id when it's one of your workspaces (not one shared with you). */
export function signalOf(state: Source, channel: string, ws?: string): Signal {
  const unread = state.unread[channel] ?? 0;
  const found = needOf(state, channel, ws);
  const working = activityOf(state.log, channel).running || (ws !== undefined && state.claudeCode.sessions.some((x) => !x.own && x.workspaceId === ws && x.status === 'working'));
  // Failing checks or a conflict while your agent works there: it's on it (BLG-748), so it reads as working. Still there when it stops: red again.
  const fixing = working && found !== undefined && FIXABLE.has(found) ? found : undefined;
  const need = fixing ? undefined : found;
  const news = unread ? [newsLead(state, channel), plural(unread, 'message')].filter(Boolean).join(' · ') : '';
  if (need) return { level: 'needs', unread, need, working, tip: [needTip(need), unread ? plural(unread, 'message') : ''].filter(Boolean).join(' · ') };
  if (unread) return { level: 'unread', unread, working, tip: news };
  if (working) return { level: 'working', unread: 0, working, tip: fixing ? `Your agent is working · ${needTip(fixing)}` : 'Your agent is working' };
  return IDLE_SIGNAL;
}

/**
 * A conversation put off till later: what's new and what's wrong wait, and so does what your agent
 * asked before you put it off (you saw it); your agent at work still shows. Anything it asks after
 * that ends the wait (laterUntil), so it shows as usual.
 */
export function laterSignal(signal: Signal, at: number, now = Date.now()): Signal {
  const label = remindLabel(at, now);
  return { level: signal.working ? 'working' : 'idle', unread: 0, working: signal.working, tip: signal.working ? `Your agent is working · ${label}` : label, remindAt: at };
}

/** What Remind Me Later reads: each person's records (core/triage), with the categories on or off. */
type LaterSource = Pick<AppState, 'projects' | 'shared' | 'plans' | 'board' | 'sentinel' | 'prefs'> & { readonly triage?: AppState['triage'] };

export function workspaceSignal(state: Source & LaterSource, ws: Workspace, now = Date.now()): Signal {
  if (ws.archived) return IDLE_SIGNAL;
  const signal = signalOf(state, `ws:${ws.id}`, ws.id);
  const until = laterUntil(state, `ws:${ws.id}`, now);
  return until === undefined ? signal : laterSignal(signal, until, now);
}

/** The channels of conversations you put off till later (a plan's: all of them). */
export function laterChannels(state: LaterSource, now = Date.now()): ReadonlySet<string> {
  const keys = Object.entries(state.triage ?? {}).flatMap(([key, r]) => (r.snoozed && r.snoozed.until > now ? [key] : []));
  return new Set(keys.flatMap((key) => channelsOf(state, key)));
}

/** What a project or group adds up to: how many conversations have news, how many need you. */
export interface Tally {
  readonly unread: number;
  readonly needs: number;
  readonly working: boolean;
}

export const NO_TALLY: Tally = { unread: 0, needs: 0, working: false };

export function tally(signals: readonly Signal[]): Tally {
  return {
    unread: signals.filter((x) => x.unread > 0).length,
    needs: signals.filter((x) => x.need).length,
    working: signals.some((x) => x.working),
  };
}

/**
 * A conversation a sentinel's run made (its Claude step's chat or worktree): the sentinel's, not
 * yours. It stays out of Unread, the tallies and the Dock (the Sentinel row's live dot says
 * something ran), except while it needs you: then it's one entry, the sentinel's (sentinelEntries).
 */
export const isSentinelOwned = (state: Pick<Source, 'sentinel'>, channel: string | undefined): boolean => sentinelOfChannel(state.sentinel, channel) !== undefined;

/** The conversations a project's row stands for: its live worktrees and chats (the main folder isn't listed), a plan's own and a sentinel run's not on their own. */
const projectConversations = (state: Pick<Source, 'plans' | 'board' | 'sentinel'>, p: Project): readonly Workspace[] =>
  p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && !isPlanOwned(state, w.id) && !isSentinelOwned(state, `ws:${w.id}`));

/** A project's live plans (each one item, however many tasks it runs). */
export const projectPlans = (state: Pick<Source, 'plans'>, p: Project): readonly Plan[] => state.plans.plans.filter((x) => x.projectId === p.id && isLivePlan(x));

/** A chat put off till later adds nothing, with the categories on or off: not to a project's tally, not to the Dock. */
type QuietSource = Source & Pick<AppState, 'triage' | 'prefs' | 'projects' | 'shared'>;

const isSnoozed = (state: QuietSource, channel: string): boolean => {
  const key = triageKey(state, channel);
  return key !== undefined && state.triage[key]?.snoozed !== undefined && categoryOf(state.triage[key], triageFacts(state, key)) === 'snoozed';
};

const projectSignals = (state: QuietSource, p: Project): Signal[] => [
  ...projectConversations(state, p)
    .filter((w) => !isSnoozed(state, `ws:${w.id}`))
    .map((w) => workspaceSignal(state, w)),
  ...projectPlans(state, p)
    .filter((x) => !isSnoozed(state, `plan:${x.id}`))
    .map((x) => planSignal(state, x)),
];

export const projectTally = (state: QuietSource, p: Project): Tally => tally(projectSignals(state, p));

export const groupTally = (state: QuietSource, projects: readonly Project[]): Tally => tally(projects.flatMap((p) => projectSignals(state, p)));

const NEED_WORDS: Record<Need, string> = {
  approval: 'needs your approval',
  question: 'asks a question',
  plan: 'has a plan for you to approve',
  conflict: 'has a merge conflict',
  checks: 'has failing checks',
  stuck: 'is stuck',
};

/** Where a plan waits on you: which of its conversations, and the plan's task there (its id), if it's a task's. */
export interface PlanNeed {
  readonly ws: string;
  readonly task?: string;
}

/** What a plan couldn't move on by itself: a task that stopped again after Beluga woke it, or a milestone past every rescue step. */
function stuckOf(state: Source, plan: Plan): { readonly tip: string; readonly task?: string; readonly ws?: string } | undefined {
  if (plan.status !== 'active') return undefined;
  const stalled = Object.entries(plan.watch ?? {}).find(([, w]) => w.needsYou);
  if (stalled) {
    const [task, w] = stalled;
    const issueId = plan.body?.milestones.flatMap((m) => m.tasks).find((t) => t.id === task)?.issueId;
    const issue = state.board.issues.find((i) => (issueId !== undefined && i.id === issueId) || (i.plan?.id === plan.id && i.plan.task === task));
    return { tip: `${issue?.key ?? 'A task'} stopped twice: ${w.reason}`, task, ...(issue?.worktrees?.[0] ? { ws: issue.worktrees[0] } : {}) };
  }
  const given = Object.entries(plan.rescue ?? {}).find(([, r]) => r.yours);
  if (!given) return undefined;
  const title = plan.body?.milestones.find((m) => m.id === given[0])?.title;
  return { tip: title ? `Stuck on “${title}”` : 'Stuck: Beluga couldn’t move it on' };
}

/**
 * A plan's signal, as one conversation's: the news in its home and all its tasks' worktrees added
 * up ("3 updates"), and the first of them that needs you, by name ("KLD-12 asks a question").
 */
export function planSignal(state: Source, plan: Plan): Signal & { readonly at?: PlanNeed } {
  const list = planConversations(state, plan.id).map((ws) => ({ ws, signal: signalOf(state, `ws:${ws}`, ws) }));
  const unread = list.reduce((n, x) => n + x.signal.unread, 0);
  const working = list.some((x) => x.signal.working);
  const news = unread ? `${unread} update${unread === 1 ? '' : 's'}` : '';
  const waiting = list.find((x) => x.signal.need);
  if (waiting) {
    const owner = planOwnerOf(state.plans, state.board, waiting.ws);
    const who = owner?.issue.key ?? 'Your agent';
    const need = waiting.signal.need!;
    const at = { ws: waiting.ws, ...(owner ? { task: owner.task.id } : {}) };
    return { level: 'needs', unread, need, working, tip: [`${who} ${NEED_WORDS[need]}`, news].filter(Boolean).join(' · '), at };
  }
  // Nothing asks, but the plan gave up on something by itself: it says what, and why.
  const stuck = stuckOf(state, plan);
  if (stuck) return { level: 'needs', unread, need: 'stuck', working, tip: [stuck.tip, news].filter(Boolean).join(' · '), ...(stuck.task && stuck.ws ? { at: { ws: stuck.ws, task: stuck.task } } : {}) };
  if (unread) return { level: 'unread', unread, working, tip: news };
  if (working) return { level: 'working', unread: 0, working, tip: 'Your agent is working' };
  return IDLE_SIGNAL;
}

/**
 * What a plan's own row in the sidebar shows (BLG-12): a count only of what's new at the plan's
 * level (its own conversation), never its tasks' worktrees added up; news in those is at most a
 * quiet dot (`inside`). One that needs you still says so (and which task). Opening the plan
 * counts all of it as seen (client/screen.ts › attentionOf).
 */
export interface PlanRowSignal extends Signal {
  /** Something new in one of its tasks' conversations (they have no row of their own). */
  readonly inside: boolean;
}

export function planRowSignal(state: Source, plan: Plan): PlanRowSignal {
  const all = planSignal(state, plan);
  const own = state.unread[plan.home] ?? 0;
  const tasks = planConversations(state, plan.id).filter((ws) => `ws:${ws}` !== plan.home);
  const inside = tasks.some((ws) => (state.unread[`ws:${ws}`] ?? 0) > 0);
  const news = own ? plural(own, 'message') : '';
  const tip = all.level === 'needs' ? all.tip.replace(/ · \d+ updates?$/, '') : own ? news : inside ? 'New in its tasks' : all.tip;
  const level: Level = all.level === 'needs' ? 'needs' : own ? 'unread' : all.working ? 'working' : 'idle';
  return { level, unread: own, ...(all.need ? { need: all.need } : {}), working: all.working, tip: [tip, all.level === 'needs' && own ? news : ''].filter(Boolean).join(' · '), inside };
}

/**
 * Claude is at work somewhere in a project: a Beluga run or a Claude Code session, in any of its
 * live workspaces (its main folder and worktrees made outside Beluga too). Folded, its row shows it.
 */
export const projectWorking = (state: Source & LaterSource, p: Project): boolean => p.workspaces.some((w) => !w.archived && workspaceSignal(state, w).working);

export const groupWorking = (state: Source & LaterSource, projects: readonly Project[]): boolean => projects.some((p) => projectWorking(state, p));

/** What a project's (or group's) row says on hover about what's inside. */
export function tallyTip(t: Tally): string {
  const parts = [t.needs ? `${t.needs} need${t.needs === 1 ? 's' : ''} you` : '', t.unread ? `${t.unread} unread` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** A conversation in a sidebar list (the Unread section, the categories). */
export type UnreadEntry = {
  readonly channel: string;
  readonly name: string;
  readonly signal: Signal;
  /** When something last happened there (newest first, after what needs you). */
  readonly ts: number;
} & (
  | { readonly kind: 'workspace'; readonly ws: Workspace; readonly project?: Project }
  | { readonly kind: 'shared'; readonly owner: string; readonly id: string }
  | { readonly kind: 'dm'; readonly peerId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  /** A plan, once for its home and all its tasks' conversations (`channels`); `at`: where it waits on you. */
  | { readonly kind: 'plan'; readonly plan: Plan; readonly project?: Project; readonly channels: readonly string[]; readonly at?: PlanNeed }
  /** A sentinel run's conversation that needs you ("Morning brief asks a question"): `at` is that conversation, `channels` all of the sentinel's. */
  | { readonly kind: 'sentinel'; readonly sentinel: Sentinel; readonly runId: string; readonly at: string; readonly project?: Project; readonly channels: readonly string[] }
);

type ListSource = Source & LaterSource & Pick<AppState, 'projects' | 'shared' | 'network'>;

const counts = (x: Signal): boolean => x.level === 'needs' || x.unread > 0;

/**
 * Sentinel runs' conversations that need you (an approval, a question): one entry per sentinel,
 * "Morning brief asks a question", that opens the run's chat. News there (Claude finished) is never
 * an entry: only needing you is.
 */
export function sentinelEntries(state: ListSource): UnreadEntry[] {
  const bySentinel = new Map<string, { channels: string[]; first?: { channel: string; runId: string; need: Need } }>();
  for (const [channel, owner] of sentinelChannels(state.sentinel)) {
    const e = bySentinel.get(owner.sentinel.id) ?? { channels: [] };
    e.channels.push(channel);
    if (!e.first) {
      const ws = channel.startsWith('ws:') ? channel.slice(3) : undefined;
      const need = needOf(state, channel, ws);
      // Only what Claude asks there: a quiet worktree's checks or conflicts are the run page's.
      if (need === 'approval' || need === 'question' || need === 'plan') e.first = { channel, runId: owner.runId, need };
    }
    bySentinel.set(owner.sentinel.id, e);
  }
  const out: UnreadEntry[] = [];
  for (const [id, e] of bySentinel) {
    if (!e.first) continue;
    const sentinel = state.sentinel.items.find((i) => i.id === id)!;
    const project = sentinel.projectId ? state.projects.find((p) => p.id === sentinel.projectId && p.root) : undefined;
    const unread = state.unread[e.first.channel] ?? 0;
    const working = activityOf(state.log, e.first.channel).running;
    const signal: Signal = { level: 'needs', unread, need: e.first.need, working, tip: `${sentinel.name} ${NEED_WORDS[e.first.need]}` };
    out.push({ kind: 'sentinel', channel: `sentinel:${id}`, name: sentinel.name, sentinel, runId: e.first.runId, at: e.first.channel, ...(project ? { project } : {}), channels: e.channels, signal, ts: activityOf(state.log, e.first.channel).lastTs ?? 0 });
  }
  return out;
}

/**
 * Every conversation the sidebar can list: your chats, worktrees and plans (a plan is one entry, never
 * its conversations one by one) and those friends share with you, whatever they wait on. Friends,
 * groups and sentinels have no list of their own here: an entry only while there's news or a need.
 */
export function conversationEntries(state: ListSource): UnreadEntry[] {
  const out: UnreadEntry[] = [];
  for (const p of state.projects) {
    for (const ws of projectConversations(state, p)) {
      out.push({ kind: 'workspace', channel: `ws:${ws.id}`, name: ws.name, ws, ...(p.root ? { project: p } : {}), signal: workspaceSignal(state, ws), ts: activityOf(state.log, `ws:${ws.id}`).lastTs ?? 0 });
    }
    for (const plan of projectPlans(state, p)) {
      const { at, ...signal } = planSignal(state, plan);
      const channels = planConversations(state, plan.id).map((ws) => `ws:${ws}`);
      const ts = Math.max(0, ...channels.map((c) => activityOf(state.log, c).lastTs ?? 0));
      out.push({ kind: 'plan', channel: `plan:${plan.id}`, name: planTitle(plan), plan, ...(p.root ? { project: p } : {}), channels, ...(at ? { at } : {}), signal, ts });
    }
  }
  out.push(...sentinelEntries(state));
  for (const w of state.shared) {
    out.push({ kind: 'shared', channel: `ws:${w.id}`, name: w.name, owner: w.owner, id: w.id, signal: signalOf(state, `ws:${w.id}`), ts: activityOf(state.log, `ws:${w.id}`).lastTs ?? 0 });
  }
  if (state.network.enabled) {
    for (const f of state.network.friends) {
      if (f.unread > 0) out.push({ kind: 'dm', channel: `dm:${f.peerId}`, name: f.name, peerId: f.peerId, signal: { level: 'unread', unread: f.unread, working: false, tip: plural(f.unread, 'message') }, ts: f.last?.ts ?? 0 });
    }
    for (const g of state.network.groups) {
      if (g.active && g.unread > 0) out.push({ kind: 'group', channel: `group:${g.id}`, name: g.name, groupId: g.id, signal: { level: 'unread', unread: g.unread, working: false, tip: plural(g.unread, 'message') }, ts: g.last?.ts ?? 0 });
    }
  }
  return out;
}

/** Every conversation with news or something waiting for you: what needs you first, then the latest. */
export function unreadEntries(state: ListSource): UnreadEntry[] {
  const rank = (e: UnreadEntry): number => (e.signal.level === 'needs' ? 0 : 1);
  return conversationEntries(state)
    .filter((e) => counts(e.signal))
    .sort((a, b) => rank(a) - rank(b) || b.ts - a.ts);
}

/**
 * The sidebar's lists, top to bottom. The UI calls the Active category Inbox and the Snoozed one
 * Later (Remind Me Later, BLG-770), the owner's choices; the code says `active` and `snoozed`.
 */
export const CATEGORY_ORDER: readonly ChatCategory[] = ['active', 'working', 'snoozed', 'settled'];
export const CATEGORY_TITLES: Readonly<Record<ChatCategory, string>> = { active: 'Inbox', working: 'Working', snoozed: 'Later', settled: 'Settled' };
/** How many Settled rows show before "Show more". */
export const SETTLED_PAGE = 50;

/** What a row says at its right edge; words and times are read with the clock (statusWords). */
export type RowStatus =
  | { readonly kind: 'need'; readonly need: Need }
  | { readonly kind: 'stopped' | 'back' | 'waiting' }
  | { readonly kind: 'working'; readonly since: number }
  | { readonly kind: 'age' | 'settled'; readonly at: number }
  | { readonly kind: 'left'; readonly until: number };

/** A conversation in one of the categories. */
export type CategoryEntry = UnreadEntry & {
  readonly category: ChatCategory;
  /** Its triage record's key. None (a DM, a group, a sentinel's): it has no settle or snooze. */
  readonly key?: string;
  readonly status: RowStatus;
  /** Bold: news, or a snooze that ended. */
  readonly bold: boolean;
  readonly pr?: number;
  readonly handRaised: boolean;
  /** What its list sorts on (see byCategory). */
  readonly sortAt: number;
};

type CategorySource = ListSource & Pick<AppState, 'triage' | 'selfId' | 'prefs' | 'plans' | 'board'>;

/**
 * Every conversation by category, each list in its order: Inbox by when it came back to you (hand raised first), Working by your last message, Later by soonest reminder, Settled by newest.
 * With threads on, a child thread shows under its parent's row (threadsShownUnder), as in the project list: only one put off till later has a row of its own, in Later.
 */
export function categoriesOf(state: CategorySource): Readonly<Record<ChatCategory, readonly CategoryEntry[]>> {
  const out: Record<ChatCategory, CategoryEntry[]> = { active: [], working: [], snoozed: [], settled: [] };
  const { nested } = threadNesting(state);
  for (const e of conversationEntries(state)) {
    if (isQuietOutside(e)) continue;
    const entry = categoryEntry(state, e);
    if (e.kind === 'workspace' && nested.has(e.ws.id) && entry.category !== 'snoozed') continue;
    out[entry.category].push(entry);
  }
  out.active.sort((a, b) => Number(b.handRaised) - Number(a.handRaised) || b.sortAt - a.sortAt);
  out.working.sort((a, b) => b.sortAt - a.sortAt);
  out.snoozed.sort((a, b) => a.sortAt - b.sortAt);
  out.settled.sort((a, b) => b.sortAt - a.sortAt);
  return out;
}

/** A worktree made outside Beluga that nobody talked in has no chat to sort: the Projects list has it. With news or a run it still shows. */
const isQuietOutside = (e: UnreadEntry): boolean => e.kind === 'workspace' && e.ws.kind === 'worktree' && e.ws.external && !e.ws.archived && !counts(e.signal) && !e.signal.working;

/** What a row's status says now; empty when its mark says it all (a conflict, failing checks) or there is no time to tell. */
export function statusWords(status: RowStatus, now: number): string {
  switch (status.kind) {
    case 'need':
      return NEED_LABELS[status.need];
    case 'stopped':
      return 'Stopped';
    case 'back':
      return 'Back';
    case 'waiting':
      return 'Waiting';
    case 'working':
      return `Working ${span(now - status.since)}`;
    case 'left':
      return `${span(status.until - now)} left`;
    case 'age':
    case 'settled':
      return status.at ? span(now - status.at) : '';
  }
}

/** A long list's rows: the first `limit`, and the one you're in wherever it is. */
export function visibleRows<E extends { readonly channel: string }>(rows: readonly E[], limit: number, here: string | undefined): readonly E[] {
  if (rows.length <= limit) return rows;
  const shown = rows.slice(0, limit);
  const open = rows.slice(limit).find((e) => e.channel === here);
  return open ? [...shown, open] : shown;
}

/** The fold state when the setting changes: on, it saves yours and folds Projects and the quiet categories; off, it gives yours back. */
export function foldsForCategories(on: boolean, folds: { readonly folded: readonly string[]; readonly foldedBeforeCategories: readonly string[] }): { folded: readonly string[]; foldedBeforeCategories: readonly string[] } {
  if (!on) return { folded: folds.foldedBeforeCategories, foldedBeforeCategories: [] };
  return { folded: [...new Set([...folds.folded, ...FOLDED_BY_CATEGORIES])], foldedBeforeCategories: folds.folded };
}

/** The next Active row after this chat: where you go when you settle or snooze the open one. */
export function nextActive(state: CategorySource, channel: string): CategoryEntry | undefined {
  const active = categoriesOf(state).active;
  const rest = active.filter((e) => e.channel !== channel);
  return rest[Math.max(0, active.findIndex((e) => e.channel === channel))] ?? rest.at(-1);
}

/** Why a chat is Settled, in the line above its composer. */
export function settledWords(settled: NonNullable<ChatTriage['settled']>, idleDays: number, now: number): string {
  const ago = `Settled ${span(now - settled.at)} ago`;
  switch (settled.why) {
    case 'you':
      return 'Settled by you';
    case 'pr_merged':
      return `${ago}: PR ${settled.pr === undefined ? '' : `#${settled.pr} `}merged`;
    case 'merged_here':
      return `${ago}: merged into main here`;
    case 'idle':
      return `Settled: idle for ${idleDays} day${idleDays === 1 ? '' : 's'}`;
  }
}

/** When a snooze ends, in local time: "15:30" today, else with its day ("Mon 09:00"). */
export function wakeWords(at: number, now: number): string {
  const day = new Date(at);
  const sameDay = day.toDateString() === new Date(now).toDateString();
  return sameDay ? hhmm(at) : `${day.toLocaleDateString(dateLocale(), { weekday: 'short' })} ${hhmm(at)}`;
}

const NEED_LABELS: Readonly<Record<Need, string>> = { question: 'Input', approval: 'Approval', plan: 'Plan', stuck: 'Stuck', conflict: '', checks: '' };

const FOLDED_BY_CATEGORIES = ['projects', 'working', 'snoozed', 'settled'];

function categoryEntry(state: CategorySource, e: UnreadEntry): CategoryEntry {
  const key = e.kind === 'workspace' || e.kind === 'shared' || e.kind === 'plan' ? triageKey(state, e.channel) : undefined;
  const pr = prOf(state, e);
  const tail = pr === undefined ? {} : { pr };
  if (key === undefined) {
    const handRaised = e.signal.level === 'needs';
    return { ...e, category: 'active', status: e.signal.need ? { kind: 'need', need: e.signal.need } : { kind: 'age', at: e.ts }, bold: e.signal.unread > 0, handRaised, sortAt: e.ts, ...tail };
  }
  const record = state.triage[key];
  const facts = triageFacts(state, key);
  const category = categoryOf(record, facts);
  const channels = e.kind === 'plan' ? e.channels : [e.channel];
  const log = channels.map((c) => runIndexOf(state)(c));
  // What Remind Me Later keeps quiet stays quiet on its row (a worktree's signal is quiet already).
  const signal = category === 'snoozed' && record?.snoozed && e.signal.remindAt === undefined ? laterSignal(e.signal, record.snoozed.until) : e.signal;
  const bold = signal.unread > 0 || (category === 'active' && record?.backAt !== undefined);
  return { ...e, signal, category, key, status: statusOf(category, record, signal, log), bold, handRaised: facts.handRaised, sortAt: sortAtOf(category, record, e, log), ...tail };
}

function statusOf(category: ChatCategory, record: ChatTriage | undefined, signal: Signal, log: readonly RunMarks[]): RowStatus {
  if (category === 'snoozed' && record?.snoozed) return { kind: 'left', until: record.snoozed.until };
  if (category === 'settled' && record?.settled) return { kind: 'settled', at: record.settled.at };
  if (signal.need) return { kind: 'need', need: signal.need };
  if (log.some((x) => x.stopped)) return { kind: 'stopped' };
  if (record?.backAt !== undefined) return { kind: 'back' };
  const since = log.flatMap((x) => x.runningSince ?? []);
  if (since.length) return log.every((x) => x.queued || x.runningSince === undefined) ? { kind: 'waiting' } : { kind: 'working', since: Math.min(...since) };
  // A Claude Code session at work has no run in the log.
  if (signal.working) return { kind: 'waiting' };
  return { kind: 'age', at: Math.max(record?.lastAt ?? 0, ...log.map((x) => x.lastAt)) };
}

function sortAtOf(category: ChatCategory, record: ChatTriage | undefined, e: UnreadEntry, log: readonly RunMarks[]): number {
  if (category === 'snoozed') return record?.snoozed?.until ?? 0;
  if (category === 'settled') return record?.settled?.at ?? 0;
  if (category === 'working') return Math.max(0, ...log.map((x) => x.sentAt));
  return Math.max(record?.backAt ?? 0, record?.lastAt ?? 0, e.ts);
}

function prOf(state: Pick<AppState, 'prs'>, e: UnreadEntry): number | undefined {
  if (e.kind === 'workspace') return state.prs[e.ws.id]?.number;
  return e.kind === 'plan' ? e.plan.pr?.number : undefined;
}

/** What the log says of one channel for its category row. */
interface RunMarks {
  /** Your last message there. */
  readonly sentAt: number;
  readonly lastAt: number;
  /** Its latest run failed. */
  readonly stopped: boolean;
  /** Since when a run goes on (or waits its turn). */
  readonly runningSince?: number;
  readonly queued: boolean;
}

const NO_MARKS: RunMarks = { sentAt: 0, lastAt: 0, stopped: false, queued: false };

// The log is replaced, never changed, so one pass per log serves every row.
const runMarks = new WeakMap<readonly LogItem[], ReadonlyMap<string, RunMarks>>();

const runIndexOf = (state: Pick<AppState, 'log' | 'selfId'>): ((channel: string) => RunMarks) => {
  let index = runMarks.get(state.log);
  if (!index) {
    index = indexRuns(state.log, state.selfId);
    runMarks.set(state.log, index);
  }
  const marks = index;
  return (channel) => marks.get(channel) ?? NO_MARKS;
};

function indexRuns(log: readonly LogItem[], self: string | undefined): ReadonlyMap<string, RunMarks> {
  const out = new Map<string, RunMarks>();
  for (const item of log) {
    const was = out.get(item.channel) ?? NO_MARKS;
    if (item.type !== 'agent') {
      out.set(item.channel, { ...was, lastAt: item.ts, sentAt: item.type === 'chat' && item.from === self && !item.byAgent ? item.ts : was.sentAt });
      continue;
    }
    const running = isRunning(item.status);
    const { runningSince: _was, ...rest } = was;
    out.set(item.channel, { ...rest, lastAt: item.ts, stopped: item.status === 'error', queued: running ? item.status === 'queued' : was.queued, ...(running ? { runningSince: was.runningSince ?? item.ts } : was.runningSince !== undefined ? { runningSince: was.runningSince } : {}) });
  }
  return out;
}

/**
 * The menu bar's "working" count: conversations where your own Claude is at work, read the way
 * the sidebar reads them (activityOf), so the two never disagree about what runs.
 */
export function workingCount(state: Pick<AppState, 'log' | 'selfId'>): number {
  const mine = new Set(state.log.flatMap((l) => (l.type === 'agent' && l.owner === state.selfId ? [l.channel] : [])));
  return [...mine].filter((channel) => activityOf(state.log, channel).running).length;
}

/**
 * The Dock badge and the menu-bar count: one per conversation in the Unread section (however
 * many messages or questions it holds), plus unread notifications and waiting approvals that
 * aren't about one of those, plus people at the door. Nothing is counted twice.
 */
export function dockCount(state: ListSource & QuietSource & Pick<AppState, 'inbox' | 'knocks'>): number {
  const { entries, quiet } = dockEntries(state);
  const channelsOf = (e: UnreadEntry): readonly string[] => (e.kind === 'plan' || e.kind === 'sentinel' ? e.channels : [e.channel]);
  const listed = new Set([...entries.flatMap(channelsOf), ...quiet.flatMap(channelsOf)]);
  const inListed = (channel: string | undefined): boolean => channel !== undefined && listed.has(channel);
  const covered = new Set([...state.approvals.filter((a) => inListed(a.channel)).map((a) => a.id), ...state.questions.filter((q) => inListed(q.channel)).map((q) => q.qid)]);
  // A sentinel run's conversation counts only while it needs you (its entry, above): its notices never.
  // A conversation put off till later: its notices wait with it.
  const later = laterChannels(state);
  const notices = state.inbox.filter((n) => !n.read && !inListed(n.channel) && !(n.channel !== undefined && later.has(n.channel)) && !isSentinelOwned(state, n.channel) && !(n.ref !== undefined && covered.has(n.ref)));
  const noted = new Set(notices.flatMap((n) => (n.ref === undefined ? [] : [n.ref])));
  const waiting = [...state.approvals.map((a) => a.id), ...state.questions.map((q) => q.qid)].filter((id) => !covered.has(id) && !noted.has(id)).length;
  return entries.length + notices.length + waiting + state.knocks.length;
}

/** What the Dock counts one each, and what it stays quiet about. With the categories on, a snoozed chat counts for nothing and a chat that's Back counts once. */
function dockEntries(state: ListSource & QuietSource): { readonly entries: readonly UnreadEntry[]; readonly quiet: readonly UnreadEntry[] } {
  if (!state.prefs.chatCategories) return { entries: unreadEntries(state), quiet: [] };
  const all = conversationEntries(state);
  const key = (e: UnreadEntry): string => triageKey(state, e.channel) ?? e.channel;
  const quiet = all.filter((e) => isSnoozed(state, e.channel));
  return { entries: all.filter((e) => !quiet.includes(e) && (counts(e.signal) || state.triage[key(e)]?.backAt !== undefined)), quiet };
}
