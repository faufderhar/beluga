import path from 'node:path';
import { STILLS_DIR, STILL_SCHEME } from '../shared/preview/ref.js';
import { SCRATCH_DIR } from '../shared/scratch-dir.js';
import { dialogueHeader } from '../core/dialogues/view.js';
import { agentPicker, pickedAgent } from '../shared/agent-picker.js';
import { roomAgentTags } from '../shared/agent-tags.js';
import { type Approval, type DomainState, type LogItem, type SubAgent, isRunning } from '../core/store.js';
import { agentLabel, agentName } from '../shared/agent-label.js';
import { waitingNote } from '../core/friend-share-people.js';
import { criteria, tally } from '../core/board/criteria.js';
import { OFFER_DETAIL, offerWords, waitingOn, waitingWords, workingOn, workingWords } from '../core/team/model.js';
import { type Issue, STATUS_INFO, actorName, activityText, assigneeName, boardName, boardOf, byStatus, isArchived, isEpic, isOwnBoard, isStartable, isVisiting, issueById, progressOf as boardProgress, reposOf, showsOn } from '../core/board/model.js';
import type { CcAgent } from '../core/claude-code/model.js';
import type { PendingQuestion } from '../core/collab-store.js';
import { type TaskView as GwTask, isFinal, requestGist, stateLabel, stateTone, targetLabel } from '../core/gateway/model.js';
import { parseDecisionQid } from '../core/plans/decisions.js';
import { type Plan, planForHome, planTitle, reviewState } from '../core/plans/model.js';
import { verifyProgress } from '../core/plans/verify-progress.js';
import { planOwnerOf } from '../core/plans/owner.js';
import { branchState, notOnPr } from '../core/branch-state.js';
import { type RunSummary, type Sentinel, type SentinelState, activeSentinelChat, firstLine, isLive, isSentinelChat, lastRunOf, pausedWords, runsOf, scheduleSentence, sentinelById, sentinelChatTitle } from '../core/sentinel/model.js';
import { type Dashboard, type Tile, metricOf, outputLook, tileColumns, tileCompare, tileMetrics, tileOutput, tileStateIn, tileTitle } from '../core/sentinel/dashboard-model.js';
import { documentMime, isDocumentKind, storageName, storageSources } from '../core/sentinel/columns.js';
import { sentinelGraph } from '../core/sentinel/workflow.js';
import { widgetSnapshot } from '../core/sentinel/widgets.js';
import { COMPARE, changeText, deltaOf, formatMetric } from '../core/sentinel/metrics.js';
import type { Workspace } from '../workspaces/types.js';
import { type MilestoneView, type PlanView as PlanProgress, agentNowWords, liveFrom, planView } from '../core/plans/progress.js';
import { triageFacts } from '../core/triage/facts.js';
import { categoryOf, triageKey } from '../core/triage/model.js';
import { shortVersion } from '../net/mesh/features.js';
import type { MessageView, PersonView } from '../net/mesh/views.js';
import { type Reaction, quickReactions } from '../shared/reactions.js';
import { chatReactions, reactableChannel } from '../core/chat-reactions.js';
import { resumeOf } from '../core/auto-continue.js';
import { chatPeople, claudePill, offlineNote, waitingIn, waitingLabel } from '../core/chat-people.js';
import { type AgentRef, CLAUDE_AGENT, type Profile, defaultAgentOf } from '../protocol.js';
import { threadNesting } from '../ui/thread-tree.js';
import { cacheHitRows, phoneCacheRows } from '../ui/cache-usage.js';
import { type LocalLedger, providerCards, withLocalUsage } from '../ui/usage-cards.js';
import {
  type BranchView,
  type ChatMessageView,
  type ChatsView,
  type ChatView,
  type ConvSummary,
  type AgentPickerView,
  type ConvView,
  type HomeView,
  type LiveView,
  type MergeView,
  type NeedsYou,
  type OutputView,
  type ProseView,
  type PeopleView,
  type PlansView,
  type PlanView,
  type SentinelPageView,
  type SentinelRunView,
  type SentinelSummary,
  type SentinelsView,
  type DashboardTileView,
  type DashboardView,
  type WidgetsView,
  type StepView,
  type SubAgentView,
  TASK_OTHERS,
  type TaskPageView,
  type TaskSummary,
  type TasksView,
  Topic,
  type TurnView,
  type UsageView,
  VIEW_TURNS,
  type WorkView,
} from './protocol.js';
import { HIDDEN_STEP, humanizeDoing, humanizeStep, plainLine, stepWords, stripCode } from './strip.js';
import { withMath } from './math-svg.js';
import { agentRefView, chatTopic, clip, convTopic, dashboardTopic, myId, nameOf, needsYou, planTopic, progressOf, sentinelTopic, taskTopic } from './needs-you.js';
import { familyOf, threadFamilyOf, threadRowOf } from './thread-family.js';

export { chatTopic, convTopic, dashboardTopic, planTopic, sentinelTopic, taskTopic } from './needs-you.js';
export { needsYou };
import { ASSISTANT_CHANNEL, ASSISTANT_TITLE, activeAssistantChannel, assistantChatTitle, isAssistant } from '../shared/assistant.js';
import { STEERED_IN, TAKEN_BACK, type SteeredMessage, asSent, steeredMessages, steerWaiting } from '../shared/claude-notices.js';
import { slotWaitDetail } from '../shared/run-slots.js';
import type { DocKey } from './files.js';

/** Words for a turn: code taken out (strip.ts), math typeset (math-svg.ts). */
const proseOf = (markdown: string) => withMath(stripCode(markdown));

/** A picture in Claude's words: `![alt](src)`, or `![alt](<src with spaces>)`. */
const PICTURE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))\)/g;

/**
 * Pictures Claude showed by their path on this Mac (`![Home](/…/.beluga/scratch/home.png)`) as a
 * ref the phone fetches (`![Home](out:…)`): the phone can't open a Mac path, and saw only "!Home".
 * The ref is handed out by the same rules as any output (pictures, never secrets), checked again
 * when it's fetched; anything else (a web picture, a path that isn't one) is left as written.
 */
export function withPictures(prose: ProseView, refs: ViewContext['refs'], cwd?: string): ProseView {
  if (!prose.text.includes('![')) return prose;
  const text = prose.text.replace(PICTURE, (all, alt: string, angled: string | undefined, bare: string | undefined) => {
    // A live preview (strip.ts): its newest picture, from the worktree's scratch folder, else in words.
    if (bare?.startsWith(STILL_SCHEME)) {
      const name = bare.slice(STILL_SCHEME.length);
      const still = cwd && /^[\w.-]+\.png$/.test(name) ? refs.output(path.join(cwd, SCRATCH_DIR, STILLS_DIR, name), { cwd }) : undefined;
      return still?.kind === 'image' ? `![${alt}](${still.ref})` : `_${alt}._`;
    }
    // file:///C:/x is C:/x on Windows; ~ is your home there too (USERPROFILE: Windows has no $HOME).
    let p = (angled ?? bare ?? '').replace(/^file:\/\//, '').replace(/^\/(?=[A-Za-z]:[\\/])/, '').replace(/^~(?=[\\/])/, () => process.env.HOME || process.env.USERPROFILE || '~');
    try {
      p = decodeURI(p);
    } catch {}
    const out = p.startsWith('/') || /^[A-Za-z]:[\\/]|^\\\\/.test(p) ? refs.output(p, cwd ? { cwd } : {}) : undefined;
    return out?.kind === 'image' ? `![${alt}](${out.ref})` : all;
  });
  return text === prose.text ? prose : { ...prose, text };
}

/**
 * What the phone sees: small, finished views of the Mac's shared state, one per topic
 * (docs/companion.md, "Views, not state"). Pure functions of `DomainState` (and the outputs on
 * disk the host looks up), so a change to the state that breaks a view breaks the typecheck, and
 * tests/companion-views.test.ts shows in review what a change does to the phone.
 *
 * Cut down for the phone: code stripped from Claude's words (strip.ts), steps in words, paths only
 * as refs (files.ts), never keys, diffs, terminals or settings. Each needs-you item carries the API
 * calls its buttons make, exactly as the phone sends them (all `phone` in coverage.ts).
 */

/** An output on disk for one conversation (a sub-agent's, the scratch folder's): the host finds them. */
export interface ConvOutput {
  readonly path: string;
  readonly size?: number;
  readonly ts?: number;
  /** The sub-agent that made it (a SubAgent's id), if known. */
  readonly by?: string;
  /** The folder the conversation works in (text inside it is source unless it's where outputs go). */
  readonly cwd?: string;
}

export interface ViewContext {
  /** Hands out refs for paths (files.ts RefTable). */
  readonly refs: { output(path: string, extra?: { size?: number; ts?: number; by?: string; cwd?: string }): OutputView | undefined; docRef?(doc: DocKey): string };
  readonly mac: { readonly name: string; readonly version: string };
  /** Outputs per conversation (channel), newest first. */
  readonly outputs?: (channel: string) => readonly ConvOutput[];
  /** A project's icon, as the checksum of its small PNG (companion.icon), once it's been made (icons.ts). */
  readonly icons?: (projectId: string) => string | undefined;
  /** Where a merge started from the phone stands, per worktree (merge.ts). */
  readonly merges?: (workspaceId: string) => MergeView | undefined;
}

// ---- small helpers

/** The channel a `conv:` topic names. */
export const channelOf = (topic: string): string | undefined => (topic.startsWith('conv:') ? topic.slice(5) : undefined);

const myName = (state: DomainState): string => state.self?.name ?? state.network.self?.name ?? 'me';

// ---- usage

/** The phone's words for Claude's windows (the Mac says "5-hour" and "Weekly"). */
const PHONE_WINDOW: Readonly<Record<string, string>> = { '5-hour': '5 hours', Weekly: 'Week' };

/**
 * Someone's providers as the phone's usage cards (src/ui/usage-cards.ts, as the Mac draws them):
 * plan windows where they have them, tokens and speed where not; their default first. A provider
 * that has said nothing yet is left out, unless it's signed out or its card explains why (Grok's
 * period, when this Mac's own ledger is passed). A friend's card gets no ledger.
 */
export function usageViews(p: Pick<Profile, 'usage' | 'usages' | 'agents'> | undefined, defaultAgent: AgentRef | undefined, ledger?: LocalLedger): UsageView[] {
  const cards = withLocalUsage(providerCards(p, defaultAgent), ledger)
    .filter((c) => c.shape !== 'empty' || !c.signedIn || Boolean(c.note))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return cards.slice(0, 8).map((c) => ({
    provider: c.key === CLAUDE_AGENT.runtime ? 'Claude Code' : clip(c.agent.label, 40),
    ...(c.plan ? { plan: clip(c.plan, 40) } : {}),
    windows: c.windows.slice(0, 8).map((w) => ({ label: clip(PHONE_WINDOW[w.label] ?? w.label, 40), pct: Math.max(0, Math.min(100, w.pct)), ...(w.resetsAt !== undefined ? { resetsAt: Math.round(w.resetsAt) } : {}) })),
    updatedAt: Math.round(c.updatedAt ?? 0),
    runtime: c.key,
    isDefault: c.isDefault,
    ...(c.tokens ? { tokens: c.tokens } : {}),
    ...(c.tokensPerSec !== undefined ? { tokensPerSec: c.tokensPerSec } : {}),
    ...(c.signedIn ? {} : { signedIn: false }),
    ...(c.note ? { note: clip(c.note, 200) } : {}),
  }));
}

// ---- conversations

type AgentItem = Extract<LogItem, { type: 'agent' }>;

interface Conversation {
  readonly channel: string;
  readonly title: string;
  readonly project?: string;
  readonly projectId?: string;
  /** The folder it works in. */
  readonly cwd?: string;
  readonly mine: boolean;
}

/**
 * "Your Mac" (BLG-47, core/assistant): your Claude for the whole Mac, not in any project. Since
 * BLG-102 it has chats (the Mac's tabs): each its own conversation, named by its tab when there
 * are more than one; the open one is Home's Ask your Mac.
 */
function assistantConversations(state: DomainState): Conversation[] {
  const chats = state.assistant.chats;
  if (!chats.length) return [{ channel: ASSISTANT_CHANNEL, title: ASSISTANT_TITLE, mine: true }];
  return chats.map((c) => ({ channel: c.channel, title: chats.length > 1 ? `${ASSISTANT_TITLE} · ${assistantChatTitle(c.channel, state.log)}` : ASSISTANT_TITLE, mine: true }));
}

/** The open chat of Your Mac: Home's Ask your Mac. */
const openAssistant = (state: DomainState): Conversation => {
  const channel = activeAssistantChannel(state.assistant);
  return assistantConversations(state).find((c) => c.channel === channel) ?? { channel, title: ASSISTANT_TITLE, mine: true };
};

/** Your Mac's chats for the phone's list (1.14): in tab order, each titled by its tab; a sentinel run's are on its run (BLG-566). */
function macChatSummaries(state: DomainState, waiting: ReadonlySet<string>, ctx?: ViewContext): ConvSummary[] {
  return state.assistant.chats.filter((c) => !c.auto).slice(0, 40).flatMap((c) => summaryOf(state, { channel: c.channel, title: assistantChatTitle(c.channel, state.log, 60), mine: true }, waiting, ctx) ?? []);
}

/**
 * The conversation a channel the phone names is: an older phone knows only `mac:assistant`, so
 * once that first chat is deleted it means the chat open on the Mac. Anything else as it is.
 */
export function phoneChannel(state: DomainState, channel: string): string {
  if (channel !== ASSISTANT_CHANNEL || !state.assistant.chats.length || state.assistant.chats.some((c) => c.channel === channel)) return channel;
  return activeAssistantChannel(state.assistant);
}

/**
 * Every conversation the phone can open: Your Mac, your workspaces (not archived), the ones shared
 * with you, and the room's. A project's main checkout is none (BLG-70): its conversations are the
 * chats and worktrees you started (an old main conversation became one of its chats).
 */
export function conversations(state: DomainState): Conversation[] {
  const own = state.projects.flatMap((p) =>
    p.workspaces.filter((w) => !w.archived && !w.pending && w.kind !== 'main').map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: p.name, projectId: p.id, cwd: w.path, mine: true })),
  );
  const shared = state.shared.map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: `${nameOf(state, w.owner) ?? 'a friend'} · ${w.project}`, mine: w.role === 'contribute' }));
  const room = state.log.some((l) => l.channel === 'room') ? [{ channel: 'room', title: state.room || 'The room', mine: true }] : [];
  // What you asked friends' Claudes yourself (not from a conversation): each reads as its own conversation.
  const asked = state.gateway.tasks
    .filter((t) => t.direction === 'sent' && !t.conversation)
    .slice(-TASKS_SHOWN)
    .map((t) => ({ channel: `task:${t.id}`, title: plainLine(t.summary ?? t.ask, 300) || 'A question', project: 'Asked of friends', projectId: 'asked', mine: false }));
  const seen = new Set<string>();
  return [...assistantConversations(state), ...own, ...shared, ...room, ...asked].filter((c) => !seen.has(c.channel) && Boolean(seen.add(c.channel)));
}

const itemsOf = (state: DomainState, channel: string): LogItem[] => state.log.filter((l) => l.channel === channel);

/** Tasks you asked of friends shown as conversations, the newest. */
const TASKS_SHOWN = 30;

/** The task a `task:<id>` channel is about. */
const taskOf = (state: DomainState, channel: string): GwTask | undefined => (channel.startsWith('task:') ? state.gateway.tasks.find((t) => t.id === channel.slice(5)) : undefined);

/** Where a task you asked stands, as a turn's status and step. */
function taskStatus(t: GwTask): { status: NonNullable<TurnView['status']>; step?: string } {
  const who = clip(t.peerName, 60);
  switch (t.state) {
    case 'confirm':
      return { status: 'queued', step: 'Waiting for you to say Ask' };
    case 'sent':
      return { status: 'queued', step: `Sent to ${who}` };
    case 'queued':
      return { status: 'queued', step: `Waiting its turn on ${who}'s Mac` };
    case 'awaiting_approval':
      return { status: 'working', step: `Waiting for ${who} to approve` };
    case 'working':
      return { status: 'working', step: t.steps.length ? humanizeStep(t.steps.at(-1)!) : 'Working' };
    case 'done':
      return { status: 'done' };
    case 'cancelled':
      return { status: 'stopped' };
    default:
      return { status: 'failed' };
  }
}

/** A task you asked of a friend's Claude, as two turns: what you asked, and their Claude's answer (its files as outputs). */
function taskTurns(state: DomainState, ctx: ViewContext, t: GwTask): TurnView[] {
  const { status, step } = taskStatus(t);
  const said = t.result?.summary || (t.state === 'declined' ? `${t.peerName} declined.` : t.state === 'failed' ? 'It failed.' : '');
  const outputs = (t.result?.files ?? []).flatMap((f) => {
    const v = f.path ? ctx.refs.output(f.path, { size: f.size, ...(t.endedAt ? { ts: t.endedAt } : {}) }) : undefined;
    return v ? [v] : [];
  });
  return [
    { id: `${t.id}:ask`, who: 'you', name: clip(myName(state), 100), prose: proseOf(t.ask), ts: t.createdAt },
    {
      id: `${t.id}:answer`,
      who: 'friend',
      name: clip(`${t.peerName}'s agent`, 100),
      prose: proseOf(said),
      ts: t.startedAt ?? t.updatedAt,
      status,
      ...(step ? { step: clip(step, 300) } : {}),
      steps: t.steps.length,
      ...(outputs.length ? { outputs: outputs.slice(0, 50) } : {}),
      ...(t.endedAt ? { endTs: t.endedAt } : {}),
    },
  ];
}

function turnStatus(item: AgentItem): TurnView['status'] {
  switch (item.status) {
    case 'queued':
      return 'queued';
    case 'done':
    case 'answered':
      return 'done';
    case 'error':
    case 'denied':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    default:
      return 'working';
  }
}

/** Steps in words with their tools' kinds, newest last (what the Mac's chat hides stays hidden). */
const trailOf = (steps: readonly string[], max: number): StepView[] =>
  steps
    .filter((s) => !HIDDEN_STEP.test(s))
    .slice(-max)
    .map((s) => {
      const w = stepWords(s);
      return { tool: w.tool, text: w.did };
    });

/** The Claude Code agents of a conversation's own sessions (a worktree's), by the tool call that started each: their live step and kind. */
function ccAgents(state: DomainState, channel: string): Map<string, CcAgent> {
  const ws = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const out = new Map<string, CcAgent>();
  if (!ws) return out;
  for (const s of state.claudeCode.sessions) if (s.workspaceId === ws) for (const a of s.agents) out.set(a.toolUseId ?? a.id, a);
  return out;
}

function subView(sub: SubAgent, outputs: readonly OutputView[], cc?: CcAgent): SubAgentView {
  const steps = sub.steps.filter((s) => !HIDDEN_STEP.test(s));
  const last = steps.at(-1);
  // Still at work when Claude Code sees it working, though its run counted it done (BLG-110: its
  // turn ended while it works on in the background): the phone shouldn't say nothing happens.
  const status = sub.status === 'done' && cc?.status === 'running' ? 'running' : sub.status;
  // What it's doing now: Claude Code's own words for it when it's watched, else its last step.
  const now = status !== 'running' ? undefined : cc?.step ? humanizeDoing(cc.step) : last ? (({ doing, tool }) => ({ text: doing, tool }))(stepWords(last)) : undefined;
  return {
    id: clip(sub.id, 200),
    title: clip(plainLine(sub.title, 300) || 'Sub-agent', 300),
    status,
    steps: sub.steps.slice(-30).map(humanizeStep),
    outputs: outputs.filter((o) => o.by === sub.id).slice(0, 50),
    trail: trailOf(sub.steps, 30),
    ...(now ? { step: clip(now.text, 300), tool: now.tool } : {}),
    ...(cc?.type ? { type: clip(cc.type, 60) } : {}),
    ...((sub.startedAt ?? cc?.startedAt) !== undefined ? { startedAt: Math.round((sub.startedAt ?? cc?.startedAt)!) } : {}),
    ...(cc?.endedAt !== undefined && status !== 'running' ? { endTs: Math.round(cc.endedAt) } : {}),
    count: Math.max(steps.length, cc?.steps ?? 0),
  };
}

/**
 * A Claude Code agent of this worktree's sessions that no run reported as its own sub-agent (one a
 * sub-agent started, say): drawn with the turn it worked in, from what Claude Code says of it.
 */
function ccSubView(a: CcAgent, outputs: readonly OutputView[]): SubAgentView {
  const status: SubAgentView['status'] = a.status === 'running' || a.status === 'idle' ? (a.status === 'running' ? 'running' : 'done') : a.status === 'failed' ? 'failed' : 'done';
  const now = status === 'running' && a.step ? humanizeDoing(a.step) : undefined;
  const id = a.toolUseId ?? a.id;
  return {
    id: clip(id, 200),
    title: clip(plainLine(a.description, 300) || a.type || 'Sub-agent', 300),
    status,
    steps: [],
    outputs: outputs.filter((o) => o.by === id).slice(0, 50),
    trail: [],
    ...(now ? { step: clip(now.text, 300), tool: now.tool } : {}),
    ...(a.type ? { type: clip(a.type, 60) } : {}),
    startedAt: Math.round(a.startedAt),
    ...(a.endedAt !== undefined ? { endTs: Math.round(a.endedAt) } : {}),
    count: a.steps,
  };
}

/** What a running turn is doing now: thinking, writing, a step with its tool and count, waiting. */
function liveOf(item: AgentItem): LiveView | undefined {
  if (!isRunning(item.status)) return undefined;
  const agents = item.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length;
  const subs = agents ? { agents } : {};
  if (item.status === 'queued') return { phase: 'queued', ...subs };
  if (item.status === 'awaiting_approval') return { phase: 'approval', ...subs };
  if (item.between === 'thinking' || item.between === 'writing') return { phase: item.between, ...(item.betweenAt !== undefined ? { since: Math.round(item.betweenAt) } : {}), ...subs };
  const last = item.steps.filter((s) => !HIDDEN_STEP.test(s)).at(-1);
  if (!last) return item.text ? { phase: 'writing', ...subs } : { phase: 'starting', ...(item.ts ? { since: item.ts } : {}), ...subs };
  const w = stepWords(last);
  return {
    phase: 'step',
    words: clip(w.doing, 300),
    tool: w.tool,
    ...(item.progress ? { progress: clip(item.progress, 40) } : {}),
    ...(item.stepAt !== undefined ? { since: Math.round(item.stepAt) } : {}),
    ...subs,
  };
}

/** The step a running turn is on, in words ("Running the tests · 137/215", "Thinking"). */
function liveStep(item: AgentItem): string | undefined {
  const live = liveOf(item);
  if (!live) return undefined;
  switch (live.phase) {
    case 'queued':
      return 'Waiting its turn';
    case 'approval':
      return 'Waiting for your approval';
    case 'thinking':
      return 'Thinking';
    case 'writing':
      return 'Writing';
    case 'starting':
      return 'Working';
    default:
      return clip(live.progress ? `${live.words ?? 'Working'} · ${live.progress}` : (live.words ?? 'Working'), 300);
  }
}

/**
 * A conversation's items with your steered messages as the Mac draws them (BLG-54): one Claude
 * hasn't read yet says so on the message, and the note cards about them aren't turns. What waits
 * in the queue above the composer (queueOf) isn't a turn yet; once it runs, it's where it ran (BLG-317).
 */
function withSteers(state: DomainState, all: readonly LogItem[]): Array<{ item: LogItem; steer?: SteeredMessage }> {
  const me = myId(state);
  const items = asSent(all, (l) => l.owner === me && (l.requester !== undefined ? l.requester === me : l.requesterName === l.ownerName));
  const { waiting, notes } = steeredMessages(items);
  return items.flatMap((item) => (notes.has(item.id) ? [] : [{ item, ...(waiting.has(item.id) ? { steer: waiting.get(item.id)! } : {}) }]));
}

/** Your message, editable from the phone (BLG-387): in a worktree or chat of yours, its words whole as shown (no code taken out). */
function editOf(state: DomainState, channel: string, text: string, prose: ProseView): TurnView['edit'] {
  if (!channel.startsWith('ws:') || prose.code.length || prose.text !== text) return undefined;
  const id = channel.slice(3);
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  return ws && !ws.archived && (ws.kind === 'worktree' || ws.kind === 'chat') ? { ws: clip(id, 200), kind: ws.kind } : undefined;
}

function turnOf(state: DomainState, item: LogItem, outputs: readonly OutputView[], cc: ReadonlyMap<string, CcAgent> = new Map(), steer?: SteeredMessage, pictures: (prose: ProseView) => ProseView = (p) => p): TurnView | undefined {
  const me = myId(state);
  if (item.type === 'chat') {
    const who = item.byAgent ? 'claude' : item.from === me ? 'you' : 'friend';
    const prose = who === 'claude' ? pictures(proseOf(item.text)) : proseOf(item.text);
    const edit = who === 'you' && !steer ? editOf(state, item.channel, item.text, prose) : undefined;
    const reactions = reactableChannel(item.channel) ? chipsView(state, chatReactions(item), me) : undefined;
    return { id: item.id, who, name: clip(who === 'you' ? myName(state) : item.name, 100), ...(who === 'claude' ? { agent: item.agent ?? CLAUDE_AGENT } : {}), prose, ts: item.ts, ...(steer && who === 'you' ? { steer: { request: clip(steer.request, 200), waiting: steer.waiting } } : {}), ...(edit ? { edit } : {}), ...(reactableChannel(item.channel) ? { reactable: true } : {}), ...(reactions ? { reactions } : {}) };
  }
  if (item.type === 'system') {
    // Earlier lines of a shared workspace's conversation ("bob: …") read as that person's turn.
    // A dialogue's header (BLG-466): the card the Mac draws, in words, with Stop / Continue.
    if (item.dialogue) {
      const d = state.dialogues[item.dialogue.id];
      if (!d) return undefined;
      const h = dialogueHeader(d);
      return {
        id: item.id,
        who: 'system',
        name: 'Dialogue',
        prose: proseOf(clip(h.topic, 500)),
        ts: item.ts,
        dialogue: { id: clip(d.id, 200), topic: clip(h.topic, 500), mode: h.mode, who: clip(h.who, 200), progress: h.progress, ...(h.budget ? { budget: h.budget } : {}), status: clip(h.status, 300), tone: h.tone, canStop: h.actions.includes('stop') || h.actions.includes('cancel'), canContinue: h.actions.includes('continue') },
      };
    }
    if (item.said) return { id: item.id, who: item.said.byAgent ? 'claude' : item.said.from === me ? 'you' : 'friend', name: clip(item.said.name, 100), prose: proseOf(item.said.text), ts: item.said.ts };
    // Info lines stay on the Mac, but a merge (and Continue After Merge's line) is news here too.
    if (item.level === 'info' && !item.merged && !item.shipped) return undefined;
    return { id: item.id, who: 'system', name: 'Beluga', prose: proseOf(item.text), ts: item.ts };
  }
  if (item.type === 'shell') {
    // A command on a friend's Mac: that it ran and how it went, not the command or its output.
    const how = item.status === 'done' ? 'finished' : item.status === 'failed' ? 'failed' : item.status === 'declined' ? 'was declined' : item.status === 'waiting' ? 'waits for their approval' : 'is running';
    return { id: item.id, who: 'system', name: 'Beluga', prose: { text: `${clip(item.by, 60)} ran a command on ${clip(item.ownerName, 60)}'s Mac: it ${how}.`, code: [] }, ts: item.ts };
  }
  const end = item.endTs ?? Number.POSITIVE_INFINITY;
  const status = turnStatus(item);
  const step = status === 'working' || status === 'queued' ? liveStep(item) : undefined;
  const live = status === 'working' || status === 'queued' ? liveOf(item) : undefined;
  const subs = item.subagents.filter((s) => s.kind !== 'background');
  const known = new Set(item.subagents.map((s) => s.id));
  // Agents Claude Code saw working in this turn that no run event named (a sub-agent's own helpers).
  const extra = [...cc.values()].filter((a) => !known.has(a.toolUseId ?? a.id) && !a.background && a.startedAt >= item.ts && a.startedAt <= end);
  const theirs = new Set([...known, ...extra.map((a) => a.toolUseId ?? a.id)]);
  const mineOut = outputs.filter((o) => o.ts !== undefined && o.ts >= item.ts && o.ts <= end && !(o.by && theirs.has(o.by)));
  const agents = [...subs.map((s) => subView(s, outputs, cc.get(s.id))), ...extra.map((a) => ccSubView(a, outputs.filter((o) => o.by === (a.toolUseId ?? a.id))))].slice(-40);
  const trail = trailOf(item.steps, 40);
  return {
    id: item.id,
    who: 'claude',
    name: clip(item.owner === me || !item.owner ? agentName(item.agent) : agentLabel(item.agent, item.ownerName, false), 100),
    agent: item.agent ?? CLAUDE_AGENT,
    prose: pictures(proseOf(item.text)),
    ts: item.ts,
    ...(status ? { status } : {}),
    ...(step ? { step } : {}),
    steps: item.steps.length,
    ...(agents.length ? { subagents: agents } : {}),
    ...(mineOut.length ? { outputs: mineOut.slice(0, 50) } : {}),
    ...(item.endTs !== undefined ? { endTs: item.endTs } : {}),
    ...(live ? { live } : {}),
    ...(trail.length ? { trail } : {}),
  };
}

/**
 * Outputs no turn claimed (written after the last answer ended: by hand, by a background job, or
 * after its last step) go with the newest answer from Claude, rather than nowhere.
 */
function withLateOutputs(turns: TurnView[], outputs: readonly OutputView[]): TurnView[] {
  let at = turns.length - 1;
  while (at >= 0 && turns[at]!.who !== 'claude') at--;
  const last = turns[at];
  if (!last) return turns;
  const claimed = new Set(turns.flatMap((t) => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)].map((o) => o.ref)));
  const late = outputs.filter((o) => !claimed.has(o.ref) && o.ts !== undefined && o.ts >= last.ts);
  if (!late.length) return turns;
  const copy = [...turns];
  copy[at] = { ...last, outputs: [...(last.outputs ?? []), ...late].slice(0, 50) };
  return copy;
}

/** A conversation's outputs as refs (what may go to the phone), newest first. */
function outputsOf(ctx: ViewContext, conv: Pick<Conversation, 'channel' | 'cwd'>): OutputView[] {
  return (ctx.outputs?.(conv.channel) ?? []).flatMap((o) => {
    const v = ctx.refs.output(o.path, { ...(o.size !== undefined ? { size: o.size } : {}), ...(o.ts !== undefined ? { ts: o.ts } : {}), ...(o.by ? { by: o.by } : {}), ...((o.cwd ?? conv.cwd) ? { cwd: o.cwd ?? conv.cwd } : {}) });
    return v ? [v] : [];
  });
}

/** A project's icon checksum, when the Mac has one for it. */
const iconOf = (ctx: ViewContext | undefined, projectId: string | undefined): { icon: string } | Record<string, never> => {
  const sum = projectId && ctx?.icons ? ctx.icons(projectId) : undefined;
  return sum && /^[0-9a-f]{16,64}$/.test(sum) ? { icon: sum } : {};
};

/** Outputs made since the conversation's latest run began (what Home hints at as new). */
function freshOutputs(state: DomainState, ctx: ViewContext | undefined, conv: Conversation): number {
  if (!ctx?.outputs) return 0;
  const since = [...itemsOf(state, conv.channel)].reverse().find((l) => l.type === 'agent' && l.status !== 'queued')?.ts;
  if (since === undefined) return 0;
  return outputsOf(ctx, conv).filter((o) => (o.ts ?? 0) >= since).length;
}

function summaryOf(state: DomainState, conv: Conversation, waiting: ReadonlySet<string>, ctx?: ViewContext): ConvSummary | undefined {
  const topic = convTopic(conv.channel);
  if (!topic) return undefined;
  const task = taskOf(state, conv.channel);
  if (task) {
    const { status } = taskStatus(task);
    const last = task.result?.summary ? plainLine(task.result.summary, 300) : taskStatus(task).step;
    return {
      topic,
      title: clip(conv.title, 300),
      project: clip(`${conv.project ?? 'Asked of friends'} · ${task.peerName}`, 200),
      status: waiting.has(topic) ? 'waiting' : status === 'working' || status === 'queued' ? 'working' : status === 'failed' ? 'failed' : 'idle',
      ...(last ? { last } : {}),
      lastAt: task.updatedAt,
      ...(waiting.has(topic) ? { needsYou: true } : {}),
    };
  }
  const items = itemsOf(state, conv.channel);
  const agents = items.filter((l): l is AgentItem => l.type === 'agent');
  const running = agents.filter((a) => isRunning(a.status));
  const lastAgent = agents.at(-1);
  // A note about a steered message ("reads this after its current step") isn't the last thing said.
  const last = [...items].reverse().find((l) => (l.type === 'chat' || (l.type === 'agent' && !steerWaiting(l) && l.text !== STEERED_IN && l.text !== TAKEN_BACK)) && (l.type === 'chat' ? l.text : l.text || l.prompt));
  const lastText = last?.type === 'chat' ? last.text : last?.type === 'agent' ? last.text || last.prompt || '' : '';
  const status: ConvSummary['status'] = waiting.has(topic) ? 'waiting' : running.length ? 'working' : lastAgent && (lastAgent.status === 'error' || lastAgent.status === 'denied') ? 'failed' : 'idle';
  const lastAt = Math.max(0, ...items.map((l) => (l.type === 'agent' ? (l.lastAt ?? l.endTs ?? l.ts) : l.ts)));
  const subs = running.reduce((n, a) => n + a.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length, 0);
  const unread = state.unread[conv.channel] ?? 0;
  const fresh = freshOutputs(state, ctx, conv);
  // While it works, its line is what it's doing now (as the conversation's live step says it).
  const liveLine = running.length ? liveStep(running.at(-1)!) : undefined;
  return {
    topic,
    title: clip(conv.title, 300),
    ...(conv.project ? { project: clip(conv.project, 200) } : {}),
    status,
    ...(liveLine && status === 'working' ? { last: liveLine } : lastText ? { last: plainLine(refWords(state, lastText), 300) } : {}),
    ...(lastAt ? { lastAt } : {}),
    ...(unread ? { unread } : {}),
    ...(waiting.has(topic) ? { needsYou: true } : {}),
    ...(subs ? { agents: subs } : {}),
    ...(conv.projectId && conv.projectId !== 'asked' ? { projectId: clip(conv.projectId, 200), ...iconOf(ctx, conv.projectId) } : {}),
    ...(fresh ? { fresh } : {}),
    ...notOnPrOf(state, conv.channel),
  };
}

/** A worktree's commits its open PR doesn't have (BLG-840), as the Mac's row chip counts them. */
function notOnPrOf(state: DomainState, channel: string): Pick<ConvSummary, 'notOnPr'> {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const ws = id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  const gap = ws?.kind === 'worktree' && !ws.archived ? notOnPr(state.prs[ws.id], ws) : undefined;
  return gap ? { notOnPr: { count: Math.min(gap.count, 100_000), pr: gap.number } } : {};
}

/** A one-line summary names what Your Mac started (`worktree:<id>`, `plan:<id>`, `task:<KEY>`) by its name, not its id. */
function refWords(state: DomainState, text: string): string {
  return text.replace(/`(worktree|plan|task):\s*([\w-]+)`/gi, (_m, kind: string, id: string) => {
    if (kind.toLowerCase() === 'worktree') return state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id)?.name ?? 'a new worktree';
    if (kind.toLowerCase() === 'plan') {
      const plan = state.plans.plans.find((p) => p.id === id);
      return plan ? planTitle(plan) : 'a plan';
    }
    return id.toUpperCase();
  });
}

const waitingTopics = (items: readonly NeedsYou[]): Set<string> => new Set(items.flatMap((n) => (n.topic ? [n.topic] : [])));

// ---- the views

export function homeView(state: DomainState, ctx: ViewContext): HomeView {
  const items = needsYou(state);
  const waiting = waitingTopics(items);
  const convs = conversations(state);
  const summaries = convs.flatMap((c) => summaryOf(state, c, waiting, ctx) ?? []);
  const running = summaries.filter((s) => s.status === 'working' || s.status === 'waiting').sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const work = convs.reduce((n, c) => n + (state.unread[c.channel] ?? 0), 0);
  const chats = state.network.friends.reduce((n, f) => n + f.unread, 0) + state.network.groups.reduce((n, g) => n + g.unread, 0);
  const review = boardIssues(state).filter((i) => i.status === 'in_review');
  const first = review[0] ? taskTopic(review[0].id) : undefined;
  const assistant = summaryOf(state, openAssistant(state), waiting, ctx);
  const macChats = macChatSummaries(state, waiting, ctx);
  return {
    mac: { name: clip(ctx.mac.name, 100), version: clip(ctx.mac.version, 40), keepAwake: state.prefs.keepAwake ?? 'off' },
    // 1.5: Your Mac, for Home's "Ask your Mac" (its last line, whether it works).
    ...(assistant ? { assistant } : {}),
    // 1.14: all of Your Mac's chats, for the phone's chat list.
    ...(macChats.length ? { macChats } : {}),
    me: { name: clip(myName(state), 64), peerId: myId(state) },
    usage: usageViews(state.peers.find((p) => p.peerId === state.self?.peerId) ?? state.self, state.prefs.defaultAgent, {
      projects: state.projects,
      runtimes: state.runtimes,
      defaultRuntime: state.prefs.defaultAgent?.runtime ?? 'claude',
      ...(state.prefs.projectAgents ? { projectAgents: state.prefs.projectAgents } : {}),
    }),
    cache: phoneCacheRows(
      cacheHitRows(state.projects, state.context, {
        runtime: state.prefs.defaultAgent?.runtime ?? 'claude',
        ...((state.prefs.defaultAgent?.runtime ?? 'claude') === 'claude' ? { model: state.prefs.defaultAgent?.model ?? state.prefs.model } : { ...(state.prefs.defaultAgent?.model ? { model: state.prefs.defaultAgent.model } : {}) }),
        ...(state.prefs.projectAgents ? { projectAgents: state.prefs.projectAgents } : {}),
      }),
      clip,
    ),
    needsYou: items,
    running: running.slice(0, 20),
    // Outputs live with their conversation now (ConvView `outputs`); Home only hints (`fresh`).
    outputs: [],
    unread: { work, chats },
    ...(review.length ? { review: { count: review.length, ...(first ? { first: { topic: first, key: clip(review[0]!.key, 40), title: clip(plainLine(review[0]!.title, 300), 300) } } : {}) } } : {}),
  };
}

export function workView(state: DomainState, ctx?: ViewContext): WorkView {
  const waiting = waitingTopics(needsYou(state));
  const convs = conversations(state);
  const nesting = threadNesting(state);
  const byProject = new Map<string, { id: string; name: string; conversations: ConvSummary[]; icon?: string }>();
  // Your Mac has its own places (Home, the Ask sheet's first target).
  for (const c of convs) {
    if (isAssistant(c.channel)) continue;
    const s = summaryOf(state, c, waiting, ctx);
    if (!s) continue;
    const key = c.projectId ?? (c.channel === 'room' ? 'room' : `shared:${c.project ?? ''}`);
    const entry = byProject.get(key) ?? { id: clip(key, 200), name: clip(c.project ?? c.title, 200), conversations: [], ...(c.projectId ? iconOf(ctx, c.projectId) : {}) };
    entry.conversations.push({ ...s, ...threadRowOf(state, c.channel, nesting), ...triageFields(state, c.channel) });
    byProject.set(key, entry);
  }
  // Every project of yours, even one with nothing in it yet (one just added on a server): the Ask
  // sheet starts the first worktree there. Not Chats, which is no project (BLG-675).
  for (const p of state.projects) {
    if (!p.root || byProject.has(p.id)) continue;
    byProject.set(p.id, { id: clip(p.id, 200), name: clip(p.name, 200), conversations: [], ...iconOf(ctx, p.id) });
  }
  const lastOf = (p: { conversations: ConvSummary[] }): number => Math.max(0, ...p.conversations.map((c) => c.lastAt ?? 0));
  return {
    projects: [...byProject.values()]
      .map((p) => ({ ...p, conversations: p.conversations.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 200) }))
      .sort((a, b) => lastOf(b) - lastOf(a))
      .slice(0, 200),
    ...(state.prefs.chatCategories ? { categories: true as const } : {}),
  };
}

/** A chat's category for Work: nothing while `chatCategories` is off, or for what has no category. */
function triageFields(state: DomainState, channel: string): Pick<ConvSummary, 'category' | 'snoozedUntil' | 'settledWhy' | 'back'> {
  const key = state.prefs.chatCategories ? triageKey(state, channel) : undefined;
  if (!key) return {};
  const record = state.triage[key];
  const category = categoryOf(record, triageFacts(state, key));
  return {
    category,
    ...(category === 'snoozed' && record?.snoozed ? { snoozedUntil: record.snoozed.until } : {}),
    ...(category === 'settled' && record?.settled ? { settledWhy: record.settled.why } : {}),
    ...(record?.backAt !== undefined ? { back: true as const } : {}),
  };
}

/** One conversation's turns (the last VIEW_TURNS, or those before `before`). */
export function convTurns(state: DomainState, ctx: ViewContext, named: string, opts: { before?: string; limit?: number } = {}): { turns: TurnView[]; more: boolean } {
  const channel = phoneChannel(state, named);
  const conv = conversations(state).find((c) => c.channel === channel) ?? { channel };
  const task = taskOf(state, channel);
  const outputs = task ? [] : outputsOf(ctx, conv);
  const cc = ccAgents(state, channel);
  const pictures = (p: ProseView) => withPictures(p, ctx.refs, 'cwd' in conv ? conv.cwd : undefined);
  const turned = task ? taskTurns(state, ctx, task) : withLateOutputs(withSteers(state, itemsOf(state, channel)).flatMap(({ item, steer }) => (turnOf(state, item, outputs, cc, steer, pictures) ?? [])), outputs);
  // A run stopped by your usage limit: when it continues on its own (1.42).
  const resume = task ? undefined : resumeOf(state, channel, Date.now());
  const all = resume ? turned.map((t) => (t.id === resume.id ? { ...t, resumesAt: resume.at } : t)) : turned;
  const end = opts.before ? all.findIndex((t) => t.id === opts.before) : all.length;
  const upto = end < 0 ? all.length : end;
  const limit = opts.limit ?? VIEW_TURNS;
  const turns = all.slice(Math.max(0, upto - limit), upto);
  return { turns, more: upto > turns.length };
}

/** The Sentinel chat's conversations (docs/sentinel.md §12): openable and writable, never listed with the others. */
function sentinelChatConversation(state: DomainState, channel: string): Conversation | undefined {
  if (!isSentinelChat(channel) || !state.sentinel.enabled) return undefined;
  const chats = state.sentinel.chats?.chats ?? [];
  if (chats.length && !chats.some((c) => c.channel === channel)) return undefined;
  const title = sentinelChatTitle(channel, state.log, 60);
  return { channel, title: title === 'New chat' ? 'Sentinel chat' : `Sentinel · ${title}`, project: 'Sentinel', mine: true };
}

export function convView(state: DomainState, ctx: ViewContext, topic: Topic): ConvView {
  const channel = phoneChannel(state, channelOf(topic) ?? '');
  const conv = conversations(state).find((c) => c.channel === channel) ?? sentinelChatConversation(state, channel);
  const { turns, more } = convTurns(state, ctx, channel);
  const real = convTopic(channel);
  // The plan it's the home of: its decisions (approve, pass a milestone) are asked here too, as on the Mac.
  const plan = planForHome(state.plans, channel);
  const planT = plan ? planTopic(plan.id) : undefined;
  const items = needsYou(state).filter((n) => n.topic === topic || (real && n.topic === real) || (planT && n.topic === planT));
  const task = taskOf(state, channel);
  const working = task ? !isFinal(task.state) : itemsOf(state, channel).some((l) => l.type === 'agent' && isRunning(l.status));
  // Everything this worktree made, newest first: what the viewer swipes through from here.
  const outputs = task ? turns.flatMap((t) => t.outputs ?? []) : outputsOf(ctx, conv ?? { channel });
  const queue = queueOf(state, channel);
  return {
    topic,
    title: clip(conv?.title ?? (channel === 'room' ? state.room || 'The room' : 'Conversation'), 300),
    ...(conv?.project ? { project: clip(conv.project, 200) } : {}),
    turns,
    more,
    needsYou: items.slice(0, 20),
    canSend: conv?.mine ?? false,
    working,
    ...(conv?.projectId && conv.projectId !== 'asked' ? { projectId: clip(conv.projectId, 200), ...iconOf(ctx, conv.projectId) } : {}),
    outputs: outputs.slice(0, 100),
    ...(queue.length ? { queue } : {}),
    ...mergeOf(state, ctx, channel),
    ...threadFamilyOf(state, channel),
    ...(plan && planT ? { plan: planBand(state, plan, planT) } : {}),
    ...waitingOf(state, channel),
    ...pickerOf(state, channel, conv?.mine ?? false),
    ...tagsOf(state, channel),
    ...terminalOf(state, channel),
    ...(reactableChannel(channel) ? { quick: quickRow(state) } : {}),
  };
}

/** The Mac's terminal view drives this conversation (BLG-534): who, so the phone can say so and take it back. */
function terminalOf(state: DomainState, channel: string): Pick<ConvView, 'terminal'> {
  const term = channel.startsWith('ws:') ? state.agentTerms[channel.slice(3)] : undefined;
  return term ? { terminal: { label: clip(term.label, 80) } } : {};
}

/** The room's agent tags for "@" (BLG-520): yours that run here, and each person's their card lists. */
function tagsOf(state: DomainState, channel: string): Pick<ConvView, 'tags'> {
  if (channel !== 'room') return {};
  const tags = roomAgentTags(state.peers, state.selfId, state.runtimes).slice(0, 40);
  return tags.length ? { tags: tags.map((t) => ({ tag: clip(t.tag, 80), hint: clip(t.hint, 200), agent: agentRefView(t.agent) })) } : {};
}

/** Your own worktree or chat: its agent picker, as the Mac's composer shows it (efforts stay the Mac's). */
function pickerOf(state: DomainState, channel: string, mine: boolean): { agent?: AgentPickerView } {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  if (!mine || !id || !state.projects.some((p) => p.workspaces.some((w) => w.id === id))) return {};
  return { agent: pickerView(agentPicker(state, channel)) };
}

/**
 * 1.35 (BLG-498): the list a task's or a plan's agent is picked from: your default agent's runtime
 * first, `ref` (the task's or plan's own pick; none: your default) the one marked on.
 */
function workPicker(state: DomainState, ref: AgentRef | undefined): AgentPickerView {
  const p = pickerView(agentPicker(state, 'draft', defaultAgentOf(state.self).runtime, ref));
  // None picked: the phone's "Your agent" row is the one on, not your default's model.
  return ref ? p : { ...p, groups: p.groups.map((g) => ({ ...g, models: g.models.map((m) => ({ ...m, on: false })) })) };
}

function pickerView(p: ReturnType<typeof agentPicker>): AgentPickerView {
  return {
    runtime: clip(p.runtime, 32),
    label: clip(p.label, 120),
    groups: p.groups.slice(0, 8).map((g) => ({
      runtime: clip(g.runtime, 32),
      label: clip(g.label, 64),
      available: g.available,
      ...(g.why ? { why: clip(g.why, 200) } : {}),
      isDefault: g.isDefault,
      current: g.current,
      models: g.models.slice(0, 30).map((m) => ({ value: clip(m.value, 80), label: clip(m.label, 80), description: clip(m.description, 200), on: m.on })),
    })),
  };
}

/** A friend's worktree whose Mac is offline: the message box says so (what you send waits for it). */
function waitingOf(state: DomainState, channel: string): { waiting?: string } {
  const note = channel.startsWith('ws:') ? waitingNote(state, channel.slice(3)) : undefined;
  return note ? { waiting: clip(note, 200) } : {};
}

function planBand(state: DomainState, plan: Plan, topic: Topic): NonNullable<ConvView['plan']> {
  const progress = progressOf(state, plan);
  return { topic, title: clip(planTitle(plan), 300), state: planState(plan, progress), done: progress.done, total: progress.total, milestones: progress.milestones.length };
}

const base = (p: string): string => p.split(/[\\/]/).at(-1) ?? p;

/**
 * A worktree's merge as the phone follows it: what the phone started (merging, Claude resolving),
 * or conflicts the Mac's own Merge found. Claude resolving reads as done once its run there ends.
 */
function mergeOf(state: DomainState, ctx: ViewContext, channel: string): Pick<ConvView, 'mergeable' | 'merge' | 'branch'> {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const ws = id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  if (!id || !ws || ws.kind !== 'worktree' || !ws.branch || ws.archived) return {};
  const conflicts = (state.conflicts[id] ?? []).slice(0, 100).map((f) => clip(base(f), 300));
  let merge = ctx.merges?.(id);
  if (merge?.phase === 'resolving') {
    const at = merge.at;
    const runs = itemsOf(state, channel).filter((l): l is AgentItem => l.type === 'agent' && l.ts >= at - 1000);
    if (runs.length && !runs.some((r) => isRunning(r.status))) merge = { ...merge, phase: 'resolved' };
  }
  // (No time: the Mac's merge doesn't say when; a view must hash the same while nothing changes.)
  if (!merge && conflicts.length) merge = { phase: 'conflicts', at: 0, conflicts };
  const branch = branchViewOf(state, ws);
  return { mergeable: true, ...(merge ? { merge } : {}), ...(branch ? { branch } : {}) };
}

/** The branch's state, the Mac toolbar's own (core/branch-state.ts), in words. */
function branchViewOf(state: DomainState, ws: Workspace): BranchView | undefined {
  const b = branchState(state, ws, { planned: Boolean(planOwnerOf(state.plans, state.board, ws.id)) });
  if (!b) return undefined;
  const next = b.steps[0];
  const url = state.prs[ws.id]?.url;
  // Create PR with Instructions is the Mac's sheet: the phone has the other ways.
  const phoneSteps = b.steps.filter((s) => s.id !== 'pr_custom');
  return {
    kind: b.kind,
    label: clip(b.label, 80),
    tone: b.tone,
    detail: clip(plainLine(b.detail, 300), 300),
    branch: clip(b.branch, 250),
    into: clip(b.into, 250),
    ...(b.pr ? { pr: { ...b.pr, ...(url ? { url: clip(url, 500) } : {}) } } : {}),
    ...(next ? { next: { id: next.id, label: clip(next.label, 80), ...(next.claude ? { claude: true } : {}) } } : {}),
    ...(phoneSteps.length ? { steps: phoneSteps.slice(0, 20).map((s) => ({ id: s.id, label: clip(s.label, 80), hint: clip(plainLine(s.hint, 300), 300), ...(s.claude ? { claude: true } : {}), ...(s.danger ? { danger: true } : {}) })) } : {}),
    ...familyOf(state, ws.id),
  };
}

/** Your messages waiting for your Claude in a conversation, in run order (the Mac's queue tray, src/ui/compose.ts queueIn). */
function queueOf(state: DomainState, channel: string): NonNullable<ConvView['queue']> {
  const me = myId(state);
  return state.log
    .filter((l): l is AgentItem => l.type === 'agent' && l.channel === channel && l.status === 'queued' && l.owner === me && (l.requester !== undefined ? l.requester === me : l.requesterName === l.ownerName))
    .slice(0, 20)
    .map((l) => ({ id: clip(l.requestId, 200), text: plainLine(l.prompt ?? '', 300) || 'A message', ...(l.slotWait ? { waiting: clip(slotWaitDetail(l.slotWait), 300) } : {}) }));
}

const planState = (plan: Plan, progress: PlanProgress): string => (plan.status === 'active' && plan.paused ? 'paused' : plan.status === 'active' && progress.next.kind === 'done' ? 'done' : plan.status);

export function plansView(state: DomainState): PlansView {
  return {
    // One that moved to another computer runs there (BLG-806): its record here stays off the list.
    plans: state.plans.plans.filter((p) => !p.movedTo).slice(0, 100).map((plan) => {
      const progress = progressOf(state, plan);
      const topic = planTopic(plan.id);
      return { id: clip(plan.id, 200), title: clip(planTitle(plan), 300), state: planState(plan, progress), ...(topic ? { topic } : {}), done: progress.done, total: progress.total };
    }),
  };
}

/** What a milestone's agent is doing right now (1.40), and its conversation: nothing while it isn't at work. */
function agentNowOf(m: MilestoneView): { readonly agentNow?: { text: string; asking?: true; topic?: Topic } } {
  const w = agentNowWords(m, 0);
  if (!w || !m.agent) return {};
  const topic = convTopic(`ws:${m.agent.worktree}`);
  return { agentNow: { text: clip(w.sub && !w.onCard ? `${w.label} · ${w.sub}` : w.label, 300), ...(w.asking ? { asking: true as const } : {}), ...(topic ? { topic } : {}) } };
}

/** A milestone's checker conversation (1.39), while its workspace is there (archived ones too: the check is kept). */
function checkerOfMilestone(state: DomainState, checker: string | undefined): { readonly checker?: Topic } {
  if (!checker || !state.projects.some((p) => p.workspaces.some((w) => w.id === checker))) return {};
  const topic = convTopic(`ws:${checker}`);
  return topic ? { checker: topic } : {};
}

export function planPageView(state: DomainState, id: string): PlanView | undefined {
  const plan = state.plans.plans.find((p) => p.id === id);
  if (!plan) return undefined;
  // Live (who's at work in each worktree): a running task says so, and so does each milestone's agent.
  const progress = planView(plan, state.board, liveFrom(state));
  const home = convTopic(plan.home);
  const goal = (plan.body ?? plan.draft)?.goal;
  const topic = planTopic(plan.id);
  return {
    id: clip(plan.id, 200),
    title: clip(planTitle(plan), 300),
    ...(goal ? { goal: clip(plainLine(goal, 4000), 4000) } : {}),
    state: planState(plan, progress),
    ...(home ? { topic: home } : {}),
    milestones: progress.milestones.slice(0, 50).map((m) => ({
      id: clip(m.milestone.id, 200),
      title: clip(m.milestone.title, 300),
      state: m.state,
      criteria: m.milestone.criteria.slice(0, 40).map((c) => clip(c, 1000)),
      tasks: m.tasks.slice(0, 100).map((t) => {
        const conv = t.worktree ? convTopic(`ws:${t.worktree}`) : undefined;
        const goal = t.task.goal ? plainLine(t.task.goal, 1000) : '';
        // What it still waits on while it can't start; the plan's wiring while it's a draft.
        const waits = t.state === 'draft' || t.state === 'later' ? t.task.blockedBy : t.waitsOn;
        return {
          id: clip(t.task.id, 200),
          title: clip(t.issue?.key ? `${t.issue.key} ${t.task.title}` : t.task.title, 300),
          state: t.state,
          ...(t.forYou ? { mine: true } : {}),
          ...(conv ? { topic: conv } : {}),
          ...(goal ? { goal } : {}),
          ...(t.task.acceptance.length ? { acceptance: t.task.acceptance.slice(0, 20).map((a) => clip(plainLine(a, 400), 400)) } : {}),
          ...(waits.length ? { blockedBy: waits.slice(0, 20).map((b) => clip(b, 200)) } : {}),
          ...(t.why ? { why: clip(plainLine(t.why, 300), 300) } : {}),
        };
      }),
      ...(m.dependsOn.length ? { dependsOn: m.dependsOn.slice(0, 20).map((d) => clip(d, 200)) } : {}),
      ...(m.autonomy !== plan.autonomy ? { autonomy: m.autonomy } : {}),
      ...checkerOfMilestone(state, m.run.checker),
      ...agentNowOf(m),
    })),
    autonomy: plan.autonomy,
    ...(plan.paused ? { paused: true } : {}),
    parallel: plan.maxParallel,
    running: progress.active.length,
    needsYou: needsYou(state)
      .filter((n) => n.topic === topic || (home && n.topic === home))
      .slice(0, 20),

    // 1.35 (BLG-498): who works its milestones and tasks (none: your default), and the list to change it from.
    ...(plan.agent ? { agent: agentRefView(plan.agent) } : {}),
    ...(plan.status !== 'done' ? { agents: workPicker(state, plan.agent) } : {}),
    // 1.45 (BLG-772): its decisions, and its draft's review.
    ...decisionsAndReview(state, plan),
  };
}

/** A verification under way, from its agent's run: so the phone shows it moving, never stuck. */
function verifyingNow(state: DomainState, review: NonNullable<Plan['review']>): { now: string; checksDone: number; since: number } {
  const channel = review.chat ? `ws:${review.chat}` : undefined;
  const run = channel ? [...state.log].reverse().find((l) => l.type === 'agent' && l.channel === channel && l.ts >= review.at - 2000) : undefined;
  const p = verifyProgress(run?.type === 'agent' ? run : undefined);
  return { now: clip(plainLine(p.now, 240), 240), checksDone: p.checks.filter((c) => c.state === 'done').length, since: p.startedAt ?? review.at };
}

function decisionsAndReview(state: DomainState, plan: Plan): Pick<PlanView, 'decisions' | 'review'> {
  const decided = (plan.draft ?? plan.body)?.decisions ?? [];
  const r = reviewState(plan);
  const review = plan.review;
  return {
    ...(decided.length ? { decisions: decided.slice(-60).map((d) => ({ text: clip(plainLine(d.text, 1000), 1000), ...(d.supersededBy ? { replaced: true } : {}) })) } : {}),
    ...(r !== 'off' && r !== 'none' && review ? { review: { state: r, ...(review.fixAsked ? { fixAsked: true } : {}), findings: review.findings.slice(0, 20).map((f) => ({ kind: f.kind, text: clip(plainLine(f.text, 1000), 1000) })), ...(r === 'reviewing' ? verifyingNow(state, review) : {}) } } : {}),
  };
}

// ---- tasks (the board)

/** The board's tasks the phone shows: not archived, of a project you have. */
const boardIssues = (state: DomainState): Issue[] => (state.board.enabled ? state.board.issues.filter((i) => !isArchived(i) && state.projects.some((p) => p.id === i.projectId)) : []);

/** "you", "Mia": who has it, from where you look (a task is for a person, BLG-278). */
const assigneeWords = (state: DomainState, i: Issue): string | undefined => {
  if (!i.assignee) return undefined;
  const name = assigneeName(i.assignee, myId(state));
  return clip(name === 'You' ? 'you' : name, 80);
};

/** The conversation of the worktree doing a task, when it's one the phone can open. */
function taskConv(state: DomainState, i: Issue): Topic | undefined {
  const ws = i.worktrees.at(-1) ?? i.carriedBy;
  if (!ws) return undefined;
  const open = state.projects.some((p) => p.workspaces.some((w) => w.id === ws && !w.archived && !w.pending));
  return open ? convTopic(`ws:${ws}`) : undefined;
}

/** `listedOn`: the board it's listed under, when it's one (a repo's own) that shows it from another board. */
function taskSummary(state: DomainState, i: Issue, listedOn?: string): TaskSummary | undefined {
  const topic = taskTopic(i.id);
  if (!topic) return undefined;
  const t = tally(i.brief.acceptance);
  const conv = taskConv(state, i);
  const who = assigneeWords(state, i);
  const working = workingWords(workingOn(state.team, i.id).map((p) => p.name));
  const waiting = waitingWords(waitingOn(state.team, i.id));
  const epicKey = i.parent ? issueById(state.board, i.parent)?.key : undefined;
  // On a board of several repos: which one it runs in.
  const repo = reposOf(state.board, boardOf(i)).length > 1 ? state.projects.find((p) => p.id === i.projectId)?.name : undefined;
  const onBoard = listedOn && isVisiting(i, listedOn) ? boardName(state.board, boardOf(i), (id) => state.projects.find((p) => p.id === id)?.name) : undefined;
  return {
    id: clip(i.id, 200),
    topic,
    key: clip(i.key, 40),
    title: clip(plainLine(i.title, 300) || i.key, 300),
    status: i.status,
    priority: i.priority,
    ...(who ? { assignee: who } : {}),
    ...(t.total ? { checks: { done: t.done, total: t.total } } : {}),
    ...(conv ? { conv } : {}),
    ...(i.pr ? { pr: { number: i.pr.number, state: i.pr.state } } : {}),
    ...(working ? { working: clip(working, 200) } : {}),
    ...(waiting ? { waiting: clip(waiting, 240) } : {}),
    ...(isEpic(state.board, i) ? { epic: boardProgress(state.board, i) } : {}),
    ...(epicKey ? { epicKey: clip(epicKey, 40) } : {}),
    ...(repo && !onBoard ? { repo: clip(repo, 200) } : {}),
    ...(onBoard ? { onBoard: clip(onBoard, 200) } : {}),
    ...(i.private ? { private: true as const } : {}),
    updatedAt: Math.round(i.updatedAt),
  };
}

/** The board's statuses as the phone lists them, and how many of the finished ones. */
const LISTED = ['in_progress', 'in_review', 'in_plan', 'todo', 'backlog', 'done'] as const;
const DONE_SHOWN = 10;
const PER_GROUP = 100;

export function tasksView(state: DomainState, ctx?: ViewContext): TasksView {
  const issues = boardIssues(state);
  // By board (a repo's own, then boards covering several): boards and repos are many to many (1.31).
  // A repo's own board lists what runs in its repo from other boards too, saying where it lives (1.37).
  const repoName = (id: string): string | undefined => state.projects.find((p) => p.id === id)?.name;
  const boards = [...state.projects.map((p) => p.id), ...Object.keys(state.board.projects).filter(isOwnBoard)];
  const projects = boards.flatMap((id) => {
    const mine = issues.filter((i) => showsOn(i, id));
    if (!mine.length) return [];
    const groups = byStatus(mine)
      .filter((g) => (LISTED as readonly string[]).includes(g.status) && g.issues.length)
      .sort((a, b) => LISTED.indexOf(a.status as (typeof LISTED)[number]) - LISTED.indexOf(b.status as (typeof LISTED)[number]))
      .map((g) => {
        // Done: the latest few, newest first; the rest in the board's order.
        const list = g.status === 'done' ? [...g.issues].sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt)) : g.issues;
        const max = g.status === 'done' ? DONE_SHOWN : PER_GROUP;
        const tasks = list.slice(0, max).flatMap((i) => taskSummary(state, i, id) ?? []);
        return { status: g.status, label: STATUS_INFO[g.status].label, tasks, ...(list.length > max ? { more: list.length - max } : {}) };
      });
    const icon = reposOf(state.board, id)[0] ?? id;
    return [{ id: clip(id, 200), name: clip(boardName(state.board, id, repoName), 200), ...iconOf(ctx, icon), groups }];
  });
  // The board with the latest change first.
  const latest = (id: string): number => Math.max(0, ...issues.filter((i) => showsOn(i, id)).map((i) => i.updatedAt));
  const sorted = projects.sort((a, b) => latest(b.id) - latest(a.id)).slice(0, 100);
  // Every other task by key, title and status (BLG-109): a key in Claude's words is a chip even when the list leaves it out.
  const listed = new Set(sorted.flatMap((p) => p.groups.flatMap((g) => g.tasks.map((t) => t.id))));
  const others = issues
    .filter((i) => !listed.has(i.id) && taskTopic(i.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, TASK_OTHERS)
    .map((i) => ({ id: clip(i.id, 200), key: clip(i.key, 40), title: clip(plainLine(i.title, 120) || i.key, 120), status: i.status }));
  return { projects: sorted, ...(others.length ? { others } : {}) };
}

/** Where a task may be moved from the phone (board.move): the open statuses and Done, not where it is. */
const MOVES = ['todo', 'in_progress', 'in_review', 'done', 'backlog', 'canceled'] as const;

export function taskPageView(state: DomainState, id: string, ctx?: ViewContext): TaskPageView | undefined {
  const i = boardIssues(state).find((x) => x.id === id);
  const summary = i ? taskSummary(state, i) : undefined;
  if (!i || !summary) return undefined;
  const project = state.projects.find((p) => p.id === i.projectId);
  const me = myId(state);
  const goal = i.brief.goal?.trim() ? stripCode(i.brief.goal.slice(0, 4000)) : undefined;
  const words = (s: string, max: number): string => clip(stripCode(s).text.replace(/\[\[code(?::\d+)?\]\]/g, '(code)'), max);
  const ws = i.worktrees.at(-1);
  const worktree = ws ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === ws)?.name : undefined;
  const { pr: _pr, ...rest } = summary;
  const live = summary.conv ? pickedAgent(agentPicker(state, summary.conv.slice('conv:'.length), defaultAgentOf(state.self).runtime)) : undefined;
  return {
    ...rest,
    project: clip(project?.name ?? '', 200),
    projectId: clip(i.projectId, 200),
    ...iconOf(ctx, i.projectId),
    ...(goal ? { goal } : {}),
    acceptance: criteria(i.brief.acceptance)
      .slice(0, 60)
      .map((c) => ({ text: clip(plainLine(c.text, 1000), 1000), state: c.state, ...(c.reason ? { reason: clip(plainLine(c.reason, 1000), 1000) } : {}) })),
    activity: i.activity.slice(-60).map((a) => ({
      id: clip(a.id, 200),
      at: Math.round(a.at),
      who: clip(actorName(a.by, me), 80),
      // An agent's line says which agent (BLG-498); an entry from before agents were named: Claude.
      ...(a.by.kind === 'claude' ? { agent: a.by.agent ?? CLAUDE_AGENT } : {}),
      text: clip(plainLine(activityText(a, me), 500), 500),
      ...(a.body ? { body: words(a.body, 8000) } : {}),
      ...(a.kind === 'comment' ? { comment: true } : {}),
    })),
    ...(worktree ? { worktree: clip(worktree, 200) } : {}),
    ...(i.pr ? { pr: { number: i.pr.number, state: i.pr.state, title: clip(plainLine(i.pr.title, 300), 300), checks: i.pr.checks } } : {}),
    moves: MOVES.filter((s) => s !== i.status).map((s) => ({ status: s, label: STATUS_INFO[s].label })),
    // Who works it (BLG-498), shown only (BLG-569): with a worktree on it, the agent and model running
    // there (changed in its conversation); else its own (none: your default). The list is for Start with….
    ...(live ? { agent: agentRefView(live) } : i.agent ? { agent: agentRefView(i.agent) } : {}),
    ...(isStartable(i) ? { agents: workPicker(state, i.agent) } : {}),
  };
}

// ---- Sentinel (docs/sentinel.md): your watchers, their runs and reports

/** Runs that ended, across sentinels, for Home's "ran since you looked". */
const RECENT_RUNS = 20;

function sentinelSummary(state: DomainState, s: SentinelState, sn: Sentinel): SentinelSummary | undefined {
  const topic = sentinelTopic(sn.id);
  if (!topic) return undefined;
  const project = sn.projectId ? state.projects.find((p) => p.id === sn.projectId) : undefined;
  const last = lastRunOf(s, sn.id);
  const next = s.nextAt[sn.id];
  return {
    id: clip(sn.id, 200),
    topic,
    name: clip(sn.name, 100),
    icon: clip(sn.icon, 40),
    ...(sn.projectId ? { projectId: clip(sn.projectId, 200) } : {}),
    ...(project ? { project: clip(project.name, 200) } : {}),
    sentence: clip(scheduleSentence(sn.trigger, (id) => sentinelById(s, id)?.name), 300),
    paused: sn.paused,
    ...(pausedWords(sn) ? { pausedWhy: clip(pausedWords(sn)!, 300) } : {}),
    ...(!sn.paused && s.troubles?.[sn.id] ? { trouble: clip(s.troubles[sn.id]!, 300) } : {}),
    ...(last ? { last: { state: last.state, headline: firstLine(last.headline, 300), at: Math.round(last.endedAt ?? last.startedAt) } } : {}),
    ...(next !== undefined && !sn.paused ? { nextAt: Math.round(next) } : {}),
    live: s.runs.some((r) => r.sentinelId === sn.id && isLive(r.state)),
  };
}

export function sentinelsView(state: DomainState): SentinelsView {
  const s = state.sentinel;
  if (!s.enabled) return { enabled: false, sentinels: [], recent: [] };
  const recent = s.runs
    .filter((r) => !isLive(r.state) && r.endedAt !== undefined && sentinelById(s, r.sentinelId))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RECENT_RUNS)
    .map((r) => ({ id: clip(r.id, 200), sentinelId: clip(r.sentinelId, 200), state: r.state, at: Math.round(r.endedAt!) }));
  const dashboards = dashboardRefs(s);
  const numbers = homeNumbers(s);
  const chat = sentinelChatSummary(state);
  return { enabled: true, sentinels: s.items.slice(0, 200).flatMap((sn) => sentinelSummary(state, s, sn) ?? []), recent, ...(dashboards.length ? { dashboards } : {}), ...(numbers ? { numbers } : {}), ...(chat ? { chat } : {}) };
}

/** The Sentinel chat's open conversation, for the phone's Sentinel screen: its topic, name, last line, and whether Claude works there. */
function sentinelChatSummary(state: DomainState): SentinelsView['chat'] {
  const channel = activeSentinelChat(state.sentinel.chats);
  const topic = convTopic(channel);
  if (!topic) return undefined;
  const items = itemsOf(state, channel);
  const last = [...items].reverse().find((l) => (l.type === 'chat' || l.type === 'agent') && 'text' in l && typeof l.text === 'string' && l.text.trim());
  const title = sentinelChatTitle(channel, state.log, 60);
  const words = last && 'text' in last && typeof last.text === 'string' ? clip(plainLine(stripCode(last.text).text, 300), 300) : undefined;
  return {
    topic,
    title: clip(title === 'New chat' ? 'Sentinel chat' : title, 100),
    ...(words ? { last: words } : {}),
    ...(last ? { lastAt: Math.round(last.ts) } : {}),
    working: items.some((l) => l.type === 'agent' && isRunning(l.status)),
  };
}

// ---- Dashboards (docs/sentinel.md §10): the numbers sentinels keep, as tiles

function dashboardRefs(s: SentinelState): DashboardView['dashboards'] {
  return (s.dashboards ?? []).slice(0, 30).flatMap((d) => {
    const topic = dashboardTopic(d.id);
    return topic ? [{ id: clip(d.id, 200), name: clip(d.name, 100), topic }] : [];
  });
}

/** Home's row: the first dashboard's first three numbers that have a value. */
function homeNumbers(s: SentinelState): SentinelsView['numbers'] {
  const d = s.dashboards?.[0];
  const topic = d ? dashboardTopic(d.id) : undefined;
  if (!d || !topic) return undefined;
  const items = d.tiles
    .filter((t) => t.kind === 'number' && tileStateIn(s, t) !== 'gone')
    .flatMap((t) => {
      const m = metricOf(s, t.metric);
      const delta = m ? deltaOf(m.points, tileCompare(d, t), m.better) : undefined;
      if (!m || !delta) return [];
      const change = changeText(delta, m.unit);
      return [{ label: clip(tileTitle(s, t), 100), value: clip(formatMetric(delta.value, m.unit), 60), ...(change ? { change: clip(change, 60) } : {}), tone: delta.tone }];
    })
    .slice(0, 3);
  return items.length ? { dashboard: { id: clip(d.id, 200), name: clip(d.name, 100), topic }, items } : undefined;
}

/** A tile with what it shows worked out (a number's change for every compare; a chart's series; a table's first rows). */
function tileView(s: SentinelState, d: Dashboard, t: Tile, ctx?: ViewContext): DashboardTileView {
  const state = tileStateIn(s, t);
  const ms = tileMetrics(s, t);
  const sentinelId = t.metric?.sentinelId ?? t.metrics?.[0]?.sentinelId ?? t.sentinelId;
  const sn = sentinelId ? sentinelById(s, sentinelId) : undefined;
  const topic = sn ? sentinelTopic(sn.id) : undefined;
  const sentinelOfTile = t.step?.sentinelId ?? sentinelId;
  const owner = sentinelOfTile ? sentinelById(s, sentinelOfTile) : undefined;
  const ownerTopic = owner ? sentinelTopic(owner.id) : undefined;
  // A series of numbers over time keeps the phone's `chart` kind (an older phone draws it as before).
  const kind = t.kind === 'series' && !ms.some((x) => x.kind === 'series') ? 'chart' : t.kind;
  const base: DashboardTileView = { id: clip(t.id, 200), kind, width: Math.min(3, t.width), ...(t.width > 3 ? { span: t.width } : {}), ...(t.height === 2 ? { tall: true } : {}), title: clip(tileTitle(s, t), 100), state, ...(owner ? { sentinel: clip(owner.name, 100) } : sn ? { sentinel: clip(sn.name, 100) } : {}), ...(ownerTopic ? { topic: ownerTopic } : topic ? { topic } : {}), ...(t.compare ? { pinned: t.compare } : {}) };
  if (state === 'gone') return base;
  const m = ms[0];
  if (t.kind === 'number' && m) {
    const last = m.points.at(-1);
    const deltas = Object.fromEntries(
      COMPARE.map((c) => {
        const dl = deltaOf(m.points, c, m.better);
        const change = changeText(dl, m.unit);
        return [c, { ...(change ? { change: clip(change, 60) } : {}), tone: dl?.tone ?? 'none' }];
      }),
    );
    return { ...base, ...(last ? { value: clip(formatMetric(last.value, m.unit), 60), at: Math.round(last.at), runId: clip(last.runId, 200) } : {}), deltas, trend: m.points.slice(-30).map((p) => p.value) };
  }
  if (t.kind === 'series' && m?.kind === 'series' && m.series?.length) {
    // A kept array: each point's place as its x, its label beside it.
    const pts = m.series.slice(0, 90);
    return { ...base, chart: { kind: t.chart ?? 'bar', unit: m.unit, series: [{ label: clip(m.label, 100), points: pts.map((p, i) => [i, p.y] as [number, number]) }], labels: pts.map((p) => clip(p.x, 80)) }, ...(m.rowsAt ? { at: Math.round(m.rowsAt) } : {}), ...(m.rowsRunId ? { runId: clip(m.rowsRunId, 200) } : {}) };
  }
  if (t.kind === 'series' && ms.length) return { ...base, chart: { kind: t.chart ?? 'line', unit: m!.unit, series: ms.slice(0, 8).map((x) => ({ label: clip(x.label, 100), points: x.points.slice(-90).map((p) => [Math.round(p.at), p.value] as [number, number]) })) } };
  if (t.kind === 'output') {
    const o = tileOutput(s, t);
    if (!o) return base;
    const look = outputLook(o, t.show);
    // What Claude wrote goes without its code, as Claude's answers do on the phone; JSON is data.
    const text = look === 'markdown' ? stripCode(o.text).text : o.text;
    return { ...base, output: { look, text: clip(text, 16_000), ...(o.cut || text.length > 16_000 ? { cut: true } : {}) }, ...(o.runId ? { runId: clip(o.runId, 200) } : {}), ...(o.at ? { at: Math.round(o.at) } : {}) };
  }
  if (t.kind === 'table' && m?.rows) {
    // The tile's own order, headings and hidden columns (BLG-347); a storage chip's bucket and path columns stay out.
    const present = m.columns?.length ? m.columns : Object.keys(m.rows[0] ?? {});
    const quiet = new Set(storageSources(m.columnTypes, present));
    const typedBy = new Map((m.columnTypes ?? []).map((c) => [c.key, c]));
    const shown = tileColumns(present, t.columns).filter((c) => !c.hidden && !(quiet.has(c.key) && !t.columns?.some((o) => o.key === c.key))).slice(0, 20);
    const rows = m.rows.slice(0, 50);
    const cell = (v: unknown): string | number | boolean | null => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' ? v : clip(String(v), 300));
    const typed = shown.flatMap((c, col) => {
      const ty = typedBy.get(c.key);
      if (!ty) return [];
      const values = rows.map((r) => (typeof r[c.key] === 'string' && r[c.key] ? clip(String(r[c.key]), 1200) : null));
      // A document or storage object goes as a ref the phone streams; the Mac reads or fetches it when asked (BLG-386).
      const refs = ctx?.refs;
      const docs = refs?.docRef && (isDocumentKind(ty.type) || ty.type === 'storage') ? values.map((v) => (v ? { ref: refs.docRef!({ sentinelId: m.sentinelId, metric: m.name, column: c.key, value: v }), name: clip(ty.type === 'storage' ? storageName(v) : v, 256), mime: documentMime(ty.type === 'storage' ? storageName(v) : v) } : null)) : undefined;
      return [{ col, key: clip(c.key, 80), kind: ty.type, values, ...(docs ? { docs } : {}), ...(ty.max !== undefined ? { max: ty.max } : {}), ...(ty.better ? { better: ty.better } : {}), ...(ty.button?.trim() ? { button: clip(ty.button.trim(), 60) } : {}) }];
    });
    const heading = (c: { key: string; label?: string }): string => clip(c.label ?? typedBy.get(c.key)?.label ?? c.key, 80);
    return {
      ...base,
      table: { columns: shown.map(heading), keys: shown.map((c) => clip(c.key, 80)), rows: rows.map((r) => shown.map((c) => cell(r[c.key]))), total: m.rows.length, ...(typed.length ? { typed, metric: { sentinelId: clip(m.sentinelId, 200), name: clip(m.name, 80) } } : {}) },
      ...(m.rowsAt ? { at: Math.round(m.rowsAt) } : {}),
    };
  }
  if (t.kind === 'text' && sn) {
    const last = lastRunOf(s, sn.id);
    return { ...base, ...(last ? { text: firstLine(last.headline, 2000), runId: clip(last.id, 200), at: Math.round(last.endedAt ?? last.startedAt) } : {}) };
  }
  return base;
}

export function dashboardView(state: DomainState, id: string, ctx?: ViewContext): DashboardView | undefined {
  const s = state.sentinel;
  const d = s.enabled ? s.dashboards?.find((x) => x.id === id) : undefined;
  if (!d) return undefined;
  const r = s.refreshing?.[d.id];
  const running = r?.sentinelId ? sentinelById(s, r.sentinelId)?.name : undefined;
  return {
    id: clip(d.id, 200),
    name: clip(d.name, 100),
    compare: d.compare,
    tiles: d.tiles.slice(0, 60).map((t) => tileView(s, d, t, ctx)),
    ...(r ? { refreshing: { done: r.done, total: r.total, ...(running ? { sentinel: clip(running, 100) } : {}) } } : {}),
    dashboards: dashboardRefs(s),
  };
}

/** Who ran it, in words ("schedule", "you", "after Nightly tests"). */
function runBy(s: SentinelState, r: RunSummary): string {
  if (r.by.startsWith('after:')) {
    const before = s.runs.find((x) => x.id === r.by.slice('after:'.length));
    const name = before ? sentinelById(s, before.sentinelId)?.name : undefined;
    return clip(name ? `after ${name}` : 'after another sentinel', 120);
  }
  if (r.by === 'event') return firstLine(r.trigger.summary, 120) || 'an event';
  return r.by === 'phone' ? 'your phone' : r.by === 'claude' ? 'your agent' : r.by;
}

function sentinelRunView(s: SentinelState, sn: Sentinel, r: RunSummary, ctx?: ViewContext): SentinelRunView {
  const live = s.live[r.id]?.stepId;
  const step = live && isLive(r.state) ? sn.steps.find((st) => st.id === live)?.name : undefined;
  const report = r.report ? ctx?.refs.output(r.report, r.endedAt !== undefined ? { ts: r.endedAt } : {}) : undefined;
  // Its Claude's conversation (the live one first): a workspace chat or Your Mac's, the ones the phone opens.
  // A chat its sentinel put away (BLG-566) isn't offered; its worktree's always is.
  const chats = r.steps.filter((x) => x.channel && /^(ws:|mac:assistant)/.test(x.channel) && (!r.putAway || x.channel === `ws:${r.worktreeId}`));
  const chat = (chats.find((x) => x.state === 'running') ?? chats.at(-1))?.channel;
  return {
    id: clip(r.id, 200),
    by: runBy(s, r),
    state: r.state,
    headline: firstLine(r.headline, 300),
    startedAt: Math.round(r.startedAt),
    ...(r.endedAt !== undefined ? { endedAt: Math.round(r.endedAt) } : {}),
    ...(r.why && (r.state === 'failed' || r.state === 'stopped' || r.state === 'skipped') ? { why: firstLine(r.why, 500) } : {}),
    ...(r.pr ? { pr: { number: r.pr.number, url: clip(r.pr.url, 500) } } : {}),
    ...(step ? { step: clip(step, 100) } : {}),
    ...(report ? { report } : {}),
    ...(chat ? { chat: clip(chat, 200) } : {}),
  };
}

export function sentinelPageView(state: DomainState, id: string, ctx?: ViewContext): SentinelPageView | undefined {
  const s = state.sentinel;
  const sn = s.enabled ? sentinelById(s, id) : undefined;
  const summary = sn ? sentinelSummary(state, s, sn) : undefined;
  if (!sn || !summary) return undefined;
  return {
    ...summary,
    steps: sn.steps.slice(0, 40).map((st) => ({ kind: st.kind, name: clip(st.name, 100) })),
    runs: runsOf(s, sn.id)
      .slice(0, 30)
      .map((r) => sentinelRunView(s, sn, r, ctx)),
    needsYou: needsYou(state)
      .filter((n) => n.topic === summary.topic)
      .slice(0, 10),
    // Its workflow, as the Mac's Steps › Graph draws it (step cards say what each does, never a key: headers by name only).
    ...(sn.steps.length ? { graph: clip(JSON.stringify(sentinelGraph(sn, { items: s.items, ...(lastRunOf(s, sn.id) ? { run: lastRunOf(s, sn.id)! } : {}), ...(s.dashboards ? { dashboards: s.dashboards } : {}) })), 200_000) } : {}),
  };
}

/**
 * Sentinel runs that ended since `prev`, to tell the phone (a `done` nudge): those whose sentinel
 * notifies the phone (`notify` phone or both), or whose Notify step for the phone ran. A failed
 * one says so (and that it paused the sentinel); skipped and stopped runs say nothing. A run only
 * counts when its sentinel was there before (the demo's history arriving isn't news).
 */
export function sentinelDone(prev: DomainState, state: DomainState): Array<{ title: string; body: string; topic?: Topic; channel?: string; run: string }> {
  const was = prev.sentinel;
  const s = state.sentinel;
  if (!s.enabled || !was.enabled || was === s) return [];
  return s.runs.flatMap((r) => {
    if (r.state !== 'done' && r.state !== 'failed') return [];
    const before = was.runs.find((x) => x.id === r.id);
    if (before ? !isLive(before.state) : false) return [];
    const sn = sentinelById(s, r.sentinelId);
    if (!sn || !sentinelById(was, sn.id)) return [];
    const phoneStep = sn.steps.some((st) => st.kind === 'notify' && st.phone && r.steps.find((x) => x.id === st.id)?.state === 'done');
    if (sn.notify !== 'phone' && sn.notify !== 'both' && !phoneStep) return [];
    const topic = sentinelTopic(sn.id);
    const failed = r.state === 'failed';
    const why = pausedWords(sn);
    const title = failed ? (why ? `${sn.name}: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : `${sn.name} failed`) : sn.name;
    const body = firstLine(r.headline, 300) || (failed && r.why ? firstLine(r.why, 300) : 'It ran');
    return [{ title: clip(title, 200), body: clip(body, 300), ...(topic ? { topic } : {}), ...(r.channel ? { channel: r.channel } : {}), run: r.id }];
  });
}

const lastLine = (m: MessageView | undefined): string | undefined => (m ? plainLine(m.text || (m.files?.length ? `${m.files.length} file${m.files.length === 1 ? '' : 's'}` : ''), 300) || undefined : undefined);

export function chatsView(state: DomainState): ChatsView {
  const net = state.network;
  const dms = net.friends.flatMap((f) => {
    const topic = chatTopic(`dm:${f.peerId}`);
    const last = lastLine(f.last);
    return topic ? [{ topic, name: clip(f.name, 100), kind: 'dm' as const, ...(last ? { last } : {}), ...(f.last ? { lastAt: f.last.ts } : {}), unread: f.unread }] : [];
  });
  const groups = net.groups.flatMap((g) => {
    const topic = chatTopic(`group:${g.id}`);
    const last = lastLine(g.last);
    return topic ? [{ topic, name: clip(g.name, 100), kind: 'group' as const, ...(last ? { last } : {}), ...(g.last ? { lastAt: g.last.ts } : {}), unread: g.unread }] : [];
  });
  return { chats: [...dms, ...groups].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 600) };
}

/** Whose a reaction is, in words: "You", or their name as this Mac knows it. */
function reactorName(state: DomainState, peerId: string): string {
  if (peerId === myId(state) || peerId === state.network.self?.peerId) return 'You';
  const net = state.network;
  return state.peers.find((p) => p.peerId === peerId)?.name ?? net.friends.find((f) => f.peerId === peerId)?.name ?? net.groups.flatMap((g) => g.members).find((p) => p.peerId === peerId)?.name ?? 'someone';
}

/** 1.41 (BLG-702): a message's reactions as the phone draws them (`me`: your id where they're kept). */
function chipsView(state: DomainState, reactions: readonly Reaction[] | undefined, me: string): ChatMessageView['reactions'] {
  if (!reactions?.length) return undefined;
  return reactions.slice(0, 20).map((r) => ({ emoji: r.emoji, count: r.by.length, mine: r.by.includes(me), who: r.by.slice(0, 20).map((p) => clip(reactorName(state, p), 100)) }));
}

const reactionsView = (state: DomainState, m: MessageView): ChatMessageView['reactions'] => chipsView(state, m.reactions, state.network.self?.peerId ?? myId(state));

/** Your quick row: the emojis you use most anywhere (friends' chats, the room, workspaces), then the defaults. */
function quickRow(state: DomainState): string[] {
  const inLog = state.log.flatMap((l) => (l.type === 'chat' && l.reacts?.length ? [{ reactions: chatReactions(l) }] : []));
  const me = [myId(state), state.network.self?.peerId].filter((x): x is string => Boolean(x));
  return quickReactions([...Object.values(state.network.messages).flat(), ...inLog], me);
}

function messageView(state: DomainState, ctx: ViewContext, m: MessageView): ChatMessageView {
  const files = (m.files ?? []).flatMap((f) => {
    const here = state.network.files?.[f.sha];
    const v = here?.state === 'here' && here.path ? ctx.refs.output(here.path, { size: f.size, ts: m.ts }) : undefined;
    return v ? [{ ...v, name: clip(f.name, 256) }] : [];
  });
  const text = stripCode(m.text).text;
  return {
    id: clip(m.id, 200),
    from: clip(m.mine ? myName(state) : m.name, 100),
    mine: m.mine,
    ...(m.claude ? { claude: true } : {}),
    ...(m.claude?.agent ? { agent: m.claude.agent } : {}),
    text,
    ts: m.ts,
    ...(m.edited ? { edited: m.edited } : {}),
    ...(m.mine && !m.claude && !m.task && m.conversation.startsWith('dm:') && text === m.text && text.trim() ? { editable: true } : {}),
    ...(files.length ? { files: files.slice(0, 20) } : {}),
    ...(m.reactions?.length ? { reactions: reactionsView(state, m) } : {}),
    ...(m.mine && (m.status === 'delivered' || m.status === 'seen') ? { delivery: m.status } : {}),
    ...(offerOf(state, m) ? { offer: offerOf(state, m) } : {}),
    ...(chatTaskOf(state, m) ? { task: chatTaskOf(state, m) } : {}),
  };
}

/** A task's card in a chat (BLG-208), from this Mac's task book; someone the task isn't between sees just the words. */
function chatTaskOf(state: DomainState, m: MessageView): ChatMessageView['task'] {
  const t = m.task ? state.gateway.tasks.find((x) => x.id === m.task?.id) : undefined;
  if (!t) return undefined;
  const title = t.direction === 'sent' ? `To ${targetLabel(t)}` : `From ${t.peerName}${t.by === 'agent' ? '’s agent' : ''}`;
  const summary = t.result?.summary ? plainLine(stripCode(t.result.summary).text, 600) : '';
  const files = (t.result?.files ?? []).map((f) => clip(f.name, 200)).slice(0, 8);
  // Whose it is, as the Mac's chat heads it (BLG-210): "Your Claude · asked ata’s Claude", "mia’s Claude · asked your Mac".
  const sent = t.direction === 'sent';
  const owner = t.by === 'agent' ? (sent ? 'Your agent' : `${t.peerName}’s agent`) : sent ? 'You' : t.peerName;
  const who = `${owner} · asked ${sent ? targetLabel(t) : t.kind === 'ask' ? 'your agent' : 'your Mac'}`;
  return {
    id: clip(t.id, 200),
    title: clip(title, 200),
    ask: clip(plainLine(t.kind === 'run' && t.command ? `$ ${t.command}` : requestGist(t, 300), 300), 300),
    state: clip(stateLabel(t), 80),
    tone: stateTone(t),
    ...(summary ? { summary: clip(summary, 600) } : {}),
    ...(files.length ? { files } : {}),
    who: clip(who, 200),
    ...(t.secret && !isFinal(t.state) ? { secret: true } : {}),
  };
}

/** A friend's Claude, answering a message of yours, offers to do it on their Mac as a request (unless your Mac sent it already: BLG-353). */
function offerOf(state: DomainState, m: MessageView): ChatMessageView['offer'] {
  const request = m.claude?.request;
  if (!request || m.mine || !state.network.messages[m.conversation]?.some((x) => x.id === m.claude?.for && x.mine)) return undefined;
  if (state.gateway.tasks.some((t) => t.answer === m.id)) return undefined;
  return { to: m.from, ask: clip(request.ask, 500), ...(request.needs?.length ? { needs: [...request.needs] } : {}) };
}

/** One chat's messages (the newest, or those before `before`). */
export function chatMessages(state: DomainState, ctx: ViewContext, conversation: string, opts: { before?: string; limit?: number } = {}): { messages: ChatMessageView[]; more: boolean } {
  const all = state.network.messages[conversation] ?? [];
  const end = opts.before ? all.findIndex((m) => m.id === opts.before) : all.length;
  const upto = end < 0 ? all.length : end;
  const limit = opts.limit ?? 100;
  const list = all.slice(Math.max(0, upto - limit), upto);
  return { messages: list.map((m) => messageView(state, ctx, m)), more: upto > list.length };
}

export function chatView(state: DomainState, ctx: ViewContext, topic: Topic): ChatView {
  const conversation = topic.slice('chat:'.length);
  const net = state.network;
  const dm = conversation.startsWith('dm:') ? net.friends.find((f) => `dm:${f.peerId}` === conversation) : undefined;
  const group = conversation.startsWith('group:') ? net.groups.find((g) => `group:${g.id}` === conversation) : undefined;
  const { messages, more } = chatMessages(state, ctx, conversation);
  const people = chatPeopleOf(state, conversation, dm, group);
  const waiting = waitingIn({ conversation, tasks: state.gateway.tasks, approvals: state.approvals });
  const note = offlineNote(people);
  const unread = dm ? dm.unread : group?.active ? group.unread : 0;
  return {
    topic,
    name: clip(dm?.name ?? group?.name ?? 'Chat', 100),
    kind: group || conversation.startsWith('group:') ? 'group' : 'dm',
    messages,
    more,
    live: (net.live?.[conversation] ?? []).slice(0, 20).map((l) => clip(`${l.name}'s agent`, 100)),
    members: chatMembers(state, dm, group, people),
    ...(waiting.length ? { waiting: waiting.slice(0, 10).map((w) => ({ text: clip(waitingLabel(w), 300), you: w.on === 'you', ...(w.target.kind === 'task' ? { task: clip(w.target.id, 200) } : {}) })) } : {}),
    ...(note ? { note: clip(note, 200) } : {}),
    ...(unread ? { unread } : {}),
    quick: quickRow(state),
  };
}

/** Who's in a chat and what their Claudes do (BLG-210), as the Mac's header says it. */
function chatPeopleOf(state: DomainState, conversation: string, dm: PersonView | undefined, group: { members: readonly (PersonView & { self: boolean })[] } | undefined) {
  const net = state.network;
  const others = dm ? [dm] : (group?.members ?? []).filter((m) => !m.self);
  const run = [...state.log].reverse().find((l) => l.type === 'agent' && l.channel === conversation && l.owner === state.selfId && isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
  const doing = run?.type === 'agent' ? (run.steps.at(-1) ?? run.prompt) : undefined;
  const now = Date.now();
  return chatPeople({
    conversation,
    self: { peerId: net.self?.peerId ?? myId(state), name: myName(state), ...(net.self ? { presence: net.self.appearOffline ? 'offline' : net.self.presence.state } : {}) },
    others,
    live: (net.live?.[conversation] ?? []).filter((l) => now - l.since < 3 * 60_000),
    tasks: state.gateway.tasks,
    myRun: { working: Boolean(run), ...(doing ? { doing } : {}) },
  });
}

/** Whose Claude a chat message can ask: you first, then the friend (a DM) or the group's members; each with presence and their Claude's state (1.20). */
function chatMembers(state: DomainState, dm: { peerId: string; name: string } | undefined, group: { members: readonly { peerId: string; name: string; self: boolean }[] } | undefined, people: ReturnType<typeof chatPeopleOf>): ChatView['members'] {
  const extra = (peerId: string, mine: boolean) => {
    const p = people.find((x) => (mine ? x.me : x.peerId === peerId));
    return p ? { presence: p.presence, claude: clip(claudePill(p), 80) } : {};
  };
  const me = { peerId: clip(myId(state), 200), name: clip(myName(state), 64), me: true, ...extra(myId(state), true) };
  const others = dm ? [{ peerId: dm.peerId, name: dm.name }] : (group?.members ?? []).filter((m) => !m.self && m.peerId !== me.peerId).map((m) => ({ peerId: m.peerId, name: m.name }));
  return [me, ...others.slice(0, 199).map((m) => ({ peerId: clip(m.peerId, 200), name: clip(m.name, 64), ...extra(m.peerId, false) }))];
}

export function peopleView(state: DomainState): PeopleView {
  return {
    people: state.network.friends.slice(0, 600).map((f) => {
      const peer = state.peers.find((p) => p.peerId === f.peerId);
      const card = state.gateway.cards[f.peerId];
      // In your room: their room profile's; else what their card shares with you (BLG-597).
      const inRoom = Boolean(peer?.usage || peer?.usages?.length);
      const usage = usageViews(inRoom ? peer : card?.usages?.length ? { usages: [...card.usages] } : undefined, defaultAgentOf(peer))[0];
      const chat = chatTopic(`dm:${f.peerId}`);
      return {
        peerId: clip(f.peerId, 200),
        name: clip(f.name, 64),
        presence: f.online ? f.presence.state : 'offline',
        ...(f.presence.note ? { note: clip(f.presence.note, 200) } : {}),
        ...(f.presence.emoji ? { emoji: clip(f.presence.emoji, 32) } : {}),
        ...(usage ? { usage } : {}),
        offers: [...(card?.claude ? ['claude'] : []), ...(card?.offers ?? [])].slice(0, 20),
        ...(chat ? { chat } : {}),
        ...(f.beluga && f.beluga.version !== 'unknown' ? { beluga: clip(shortVersion(f.beluga.version), 40) } : {}),
        ...(f.update ? { update: f.update } : {}),
      };
    }),
  };
}

/**
 * 1.26 (BLG-361): every board tile in words, for the phone's Home-screen widgets: the snapshot the
 * Mac's desktop widgets read (src/core/sentinel/widgets.ts), each project's icon as its checksum.
 */
export function widgetsView(state: DomainState, ctx?: ViewContext): WidgetsView {
  const s = state.sentinel;
  if (!s.enabled) return { tiles: [] };
  // A project's icon as its checksum (companion.icon), where the Mac's own widgets have a file.
  const snap = widgetSnapshot(s, (projectId) => {
    const p = projectId ? state.projects.find((x) => x.id === projectId) : undefined;
    return p ? { name: p.name, ...iconOf(ctx, p.id) } : undefined;
  });
  return {
    tiles: snap.tiles.slice(0, 120).map((w) => ({
      id: clip(w.id, 401),
      dashboard: clip(w.dashboard, 200),
      tile: clip(w.tile, 200),
      board: clip(w.board, 100),
      title: clip(w.title, 100),
      kind: w.kind,
      ...(w.value ? { value: clip(w.value, 60) } : {}),
      ...(w.change ? { change: clip(w.change, 60) } : {}),
      tone: w.tone,
      ...(w.vs ? { vs: clip(w.vs, 60) } : {}),
      ...(w.points?.length ? { points: w.points.slice(-40) } : {}),
      ...(w.from ? { from: clip(w.from, 80) } : {}),
      ...(w.to ? { to: clip(w.to, 80) } : {}),
      ...(w.text ? { text: clip(w.text, 1000) } : {}),
      ...(w.note ? { note: clip(w.note, 60) } : {}),
      ...(w.project ? { project: clip(w.project, 100) } : {}),
      ...(w.icon ? { icon: w.icon } : {}),
      ...(w.tint ? { tint: w.tint } : {}),
      ...(w.at !== undefined ? { at: Math.round(w.at) } : {}),
    })),
  };
}

/** The view a topic carries, or undefined when there's nothing by that name (a plan that's gone). */
export function viewOf(state: DomainState, ctx: ViewContext, topic: Topic): unknown {
  if (topic === 'home') return homeView(state, ctx);
  if (topic === 'work') return workView(state, ctx);
  if (topic === 'plans') return plansView(state);
  if (topic === 'chats') return chatsView(state);
  if (topic === 'people') return peopleView(state);
  if (topic === 'tasks') return tasksView(state, ctx);
  if (topic.startsWith('conv:')) return convView(state, ctx, topic);
  if (topic.startsWith('plan:')) return planPageView(state, topic.slice('plan:'.length));
  if (topic.startsWith('chat:')) return chatView(state, ctx, topic);
  if (topic.startsWith('task:')) return taskPageView(state, topic.slice('task:'.length), ctx);
  if (topic === 'sentinels') return sentinelsView(state);
  if (topic.startsWith('sentinel:')) return sentinelPageView(state, topic.slice('sentinel:'.length), ctx);
  if (topic.startsWith('dashboard:')) return dashboardView(state, topic.slice('dashboard:'.length), ctx);
  if (topic === 'widgets') return widgetsView(state, ctx);
  return undefined;
}
