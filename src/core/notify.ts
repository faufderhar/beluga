import type { NotifySettings } from './settings.js';
import { type DomainState, type LogItem, type Store, isRunning } from './store.js';
import { dndActive } from '../shared/quiet.js';
import { isSentinelChat } from './sentinel/model.js';
import { loudestKind, type SoundChoice, type SoundPrefs, soundFor, volumeOf } from '../shared/notify-sound.js';
import { type Issue, issueForWorkspace } from './board/model.js';
import { type Plan, checkerOf, planById, planForHome, planTitle } from './plans/model.js';
import { type MilestoneView, planView } from './plans/progress.js';
import { isDecisionQid } from './plans/decisions.js';
import { ASSISTANT_TITLE, isAssistant } from '../shared/assistant.js';
import { allNeeds, needMatches } from '../companion/needs-you.js';
import { type AgentRef, defaultAgentOf } from '../protocol.js';
import { isExternalRequester } from './trust.js';
import { agentLabel, agentName } from '../shared/agent-label.js';
import { laterUntil } from './triage/facts.js';

/** The groups you can switch on or off in Settings → Notifications. */
export type NoticeKind = 'done' | 'needsYou' | 'problems' | 'people' | 'pr' | 'mentions' | 'background';

/** What exactly happened, when the kind alone doesn't say (screens pick an icon by it). */
export type NoticeTag = 'approval' | 'question' | 'plan' | 'milestone' | 'conflict' | 'joined' | 'left' | 'invited' | 'mention' | 'message' | 'task' | 'test' | 'sentinel' | 'woke';

export interface NoticeEvent {
  readonly kind: NoticeKind;
  readonly tag?: NoticeTag;
  /** The approval or question it's about. */
  readonly ref?: string;
  readonly title: string;
  readonly body: string;
  /** Conversation it's about (opening the notice goes there). */
  readonly channel?: string;
  /** Into the inbox, but no desktop notification (you're on Do Not Disturb or appearing offline). */
  readonly quiet?: boolean;
  /** A friend's request (the gateway) this approval is about. */
  readonly task?: string;
  /** That approval is Allow once / Decline only (a secret): the notification offers no Always. */
  readonly once?: boolean;
  /** The plan it's about (its id), and the plan's task (its id there): opening it goes to the plan at that task. */
  readonly plan?: string;
  readonly planTask?: string;
  /**
   * What waits for you that it's about: a needs-you item's id (companion/needs-you.ts), or the
   * start of one (`gwq:<task>`). The bell answers it in place and opens where it lives; answered,
   * the notice is read (BLG-255).
   */
  readonly need?: string;
  /** What happened, once: a notice with the same key is never raised again (a plan's milestone passing…). */
  readonly key?: string;
  /** Worth a desktop notification even while a screen in front shows its conversation (a long run of yours ended there). */
  readonly watched?: boolean;
}

/** A desktop notification: what it says, and where clicking it goes (when it's about one place). */
export interface DesktopNote {
  readonly title: string;
  readonly body: string;
  /** Whether it makes a sound (screens that can't play `tone` use their default sound). */
  readonly sound: boolean;
  /** Which sound (Settings › Notifications), and how loud Beluga's own sounds are (0–1). */
  readonly tone?: SoundChoice;
  readonly volume?: number;
  readonly channel?: string;
  /** The approval it asks for: the notification offers Approve / Decline (Always too for a friend's request). */
  readonly approval?: string;
  /** The friend's request that approval is about. */
  readonly task?: string;
  /** That approval offers no Always (a secret): only Review…. */
  readonly once?: boolean;
  /** Only what Claude needs from you, and the Mac's on-screen pop-up shows it: a banner would say it twice (its sound still plays). */
  readonly popup?: boolean;
  /** A friend's message while Beluga is in front: the window shows it as a banner, with its sound (macOS hides banners of the app in front). */
  readonly banner?: boolean;
}

/** A message from a friend or a group (the Beluga network), not the room's chat. */
const isNetworkMessage = (e: NoticeEvent): boolean => e.kind === 'mentions' && e.channel !== undefined && /^(dm|group):/.test(e.channel);

/** Your network status says not now (Do Not Disturb, or appearing offline): notices still arrive, silently. */
export function presenceQuiet(state: Pick<DomainState, 'network'>): boolean {
  const self = state.network.self;
  return Boolean(self && (self.appearOffline || self.presence.state === 'dnd'));
}

/**
 * About a conversation you put off (Remind Me Later, BLG-748, BLG-770), and not something your agent
 * asks you: it goes into the inbox already read, with no sound or banner; the reminder brings it back.
 */
export function remindLaterNotice(state: DomainState, e: Pick<NoticeEvent, 'kind' | 'channel'>, now = Date.now()): boolean {
  if (e.kind === 'needsYou' || !e.channel) return false;
  return laterUntil(state, e.channel, now) !== undefined;
}

/** Where what waits for you lives (companion/needs-you.ts reads these). */
const WAITING = ['approvals', 'questions', 'gateway', 'plans', 'board', 'knocks', 'network', 'team', 'sentinel'] as const satisfies ReadonlyArray<keyof DomainState>;

/** Runs that end like this were your own doing, so they're not worth a notification. */
const QUIET_ERRORS = /^(Interrupted by a newer message|Cancelled by owner|Stopped by owner)/;
const RECENT_LOG = 200;
/** A run of yours this long is one you stopped watching: its end is announced even in the conversation on screen. */
export const WATCHED_RUN_MS = 20_000;

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;
/** More new messages than this in one step is history arriving, not someone talking to you. */
const MESSAGE_BURST = 3;
const isFinal = (s: AgentItem['status']): boolean => s === 'done' || s === 'error' || s === 'denied';

const firstLine = (text: string, max = 140): string => {
  const line = text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "add-auth", "the group chat", or a shared workspace's name. */
export function placeName(state: DomainState, channel: string): string {
  if (channel === 'room') return state.peers.length > 1 ? 'the group chat' : 'your chat';
  if (isExternalRequester(channel)) return 'an external agent';
  if (isAssistant(channel)) return ASSISTANT_TITLE;
  if (isSentinelChat(channel)) return 'the Sentinel chat';
  // A friends' chat (your Claude acts there when you ask it, BLG-207).
  if (channel.startsWith('dm:')) return `your chat with ${state.network.friends.find((f) => f.peerId === channel.slice(3))?.name ?? 'a friend'}`;
  if (channel.startsWith('group:')) return state.network.groups.find((g) => g.id === channel.slice(6))?.name ?? 'a channel';
  const id = channel.slice(3);
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) ?? state.shared.find((w) => w.id === id);
  return ws?.name ?? 'a workspace';
}

/** A conversation a plan owns: one of its tasks' worktrees (with that task), or its home. */
export interface PlanPlace {
  readonly plan: Plan;
  /** The board task working there (none: the plan's home). */
  readonly issue?: Issue;
  /** Its task's id in the plan. */
  readonly task?: string;
}

/** The plan a conversation belongs to: a task worktree's chat (the board task's plan), or the plan's home chat. */
export function planOfChannel(state: Pick<DomainState, 'plans' | 'board'>, channel: string | undefined): PlanPlace | undefined {
  if (!channel?.startsWith('ws:')) return undefined;
  const issue = issueForWorkspace(state.board, channel.slice(3));
  const plan = issue?.plan ? planById(state.plans, issue.plan.id) : undefined;
  if (issue?.plan && plan) return { plan, issue, task: issue.plan.task };
  const home = planForHome(state.plans, channel) ?? checkerOf(state.plans, channel)?.plan;
  return home ? { plan: home } : undefined;
}

/** Plans speak for their tasks (Settings › Notifications › Plans: milestones only; missing: on). */
export const planMilestonesOnly = (prefs: NotifySettings): boolean => prefs.planMilestones !== false;

/**
 * A notice about a plan's task, as the plan tells it. Its Claude asking you something, or a merge
 * conflict, still reaches you (titled by the plan); the rest (finished, stopped, its pull request,
 * background work) goes quietly into the inbox under the plan: you hear from the plan at milestones.
 * The plan's home counts while the plan runs (its head Claude checking milestones). People talking
 * to you are never the plan's.
 */
function scopeToPlan(state: Pick<DomainState, 'plans' | 'board' | 'prefs'>, e: NoticeEvent): NoticeEvent {
  if (e.plan || e.kind === 'mentions' || e.kind === 'people' || e.tag === 'test') return e;
  const place = planOfChannel(state, e.channel);
  if (!place || place.plan.status === 'draft' || (!place.issue && place.plan.status !== 'active')) return e;
  const who = place.issue ? `${planTitle(place.plan)} · ${place.issue.key}` : planTitle(place.plan);
  const at = { plan: place.plan.id, ...(place.task ? { planTask: place.task } : {}) };
  if (e.kind === 'needsYou') {
    if (e.tag === 'question') return { ...e, ...at, title: `${who} ${e.ref && isDecisionQid(e.ref) ? 'needs your call' : 'asks'}: ${e.body}`, body: 'Answer it to keep the plan going' };
    if (e.tag === 'plan') return { ...e, ...at, title: `${who} has a plan`, body: e.body };
    return { ...e, ...at, title: `${who} asks: ${e.title}` };
  }
  if (e.tag === 'conflict') return { ...e, ...at, title: `${who}: ${e.title}` };
  if (!planMilestonesOnly(state.prefs.notify)) return e;
  return { ...e, ...at, title: `${who}: ${e.title}`, quiet: true };
}

/** A milestone you pass yourself: its tasks are finished and it waits for your click (Step by step, Check-ins; autopilot passes its own). */
const yoursToPass = (m: MilestoneView | undefined): boolean => Boolean(m && (m.state === 'gate' || m.state === 'checking') && m.autonomy !== 'autopilot');

/** Milestones being worked on (open, not passed). */
const OPEN_STATES: ReadonlySet<MilestoneView['state']> = new Set(['running', 'checking', 'gate', 'failed']);

/**
 * What a running plan has to tell you, from how it changed: a milestone passed (and what's next),
 * its check failed, it waits for you to pass it, or the plan is done. Plans that weren't there
 * before (the first state after a start) aren't news.
 */
function planNews(prev: DomainState, next: DomainState): NoticeEvent[] {
  if (prev.plans === next.plans && prev.board === next.board) return [];
  const out: NoticeEvent[] = [];
  for (const plan of next.plans.plans) {
    const old = prev.plans.plans.find((p) => p.id === plan.id);
    if (!old?.body || !plan.body || plan.status === 'draft' || plan.movedTo) continue;
    const name = planTitle(plan);
    const at = { plan: plan.id, channel: plan.home };
    const prs = (): number => next.board.issues.filter((i) => i.plan?.id === plan.id && i.pr?.state === 'OPEN').length;
    if (plan.status === 'done' && old.status !== 'done') {
      const n = prs();
      const body = n ? `${n === 1 ? 'Its pull request is' : `${n} pull requests are`} ready to merge` : `All ${plan.body.milestones.length} milestones passed`;
      out.push({ kind: 'done', tag: 'milestone', title: `${name} is done`, body, ...at, key: `plan:${plan.id}:done:${plan.doneAt ?? 0}` });
      continue;
    }
    if (plan.status !== 'active') continue;
    const before = planView(old, prev.board);
    const after = planView(plan, next.board);
    const was = new Map(before.milestones.map((m) => [m.milestone.id, m]));
    const opened = after.milestones.filter((m) => OPEN_STATES.has(m.state) && !OPEN_STATES.has(was.get(m.milestone.id)?.state ?? 'later'));
    const open = after.milestones.filter((m) => OPEN_STATES.has(m.state));
    for (const m of after.milestones) {
      const id = m.milestone.id;
      const run = m.run;
      const oldRun = old.runs[id];
      if (run.passedAt && !oldRun?.passedAt) {
        const body =
          opened.length > 1 ? `${opened.length} milestones now running` : opened[0] ? `Next: “${opened[0].milestone.title}”` : open.length ? `Still running: ${open.map((o) => `“${o.milestone.title}”`).join(', ')}` : 'Waiting on what comes next';
        out.push({ kind: 'done', tag: 'milestone', title: `${name}: “${m.milestone.title}” passed`, body, ...at, key: `plan:${plan.id}:${id}:passed:${run.passedAt}` });
        continue;
      }
      if (run.check?.verdict === 'fail' && run.check.at !== oldRun?.check?.at) {
        out.push({ kind: 'problems', tag: 'milestone', title: `${name}: “${m.milestone.title}” didn’t pass its check`, body: firstLine(run.check.notes) || 'See what your agent found', ...at, key: `plan:${plan.id}:${id}:failed:${run.check.at}` });
        continue;
      }
      if (yoursToPass(m) && !yoursToPass(was.get(id))) {
        const body = run.check?.verdict === 'pass' ? 'Your agent checked it: pass it to go on' : 'Its tasks are finished: pass it to go on';
        out.push({ kind: 'needsYou', tag: 'milestone', title: `${name}: “${m.milestone.title}” is ready for you`, body, ...at, need: `plan:${plan.id}:pass:${id}`, key: `plan:${plan.id}:${id}:yours:${run.checkAsked ?? 0}:${run.check?.at ?? 0}` });
      }
    }
    // Beluga woke a task and it stopped again, or it climbed a milestone's whole rescue ladder: only
    // then is it yours, and you hear why (the plan goes on by itself until then).
    const titleOf = new Map(after.milestones.flatMap((m) => [[m.milestone.id, m.milestone.title] as const, ...m.tasks.map((t) => [t.task.id, t.task.title] as const)]));
    for (const [taskId, w] of Object.entries(plan.watch ?? {})) {
      if (!w.needsYou || old.watch?.[taskId]?.needsYou) continue;
      out.push({ kind: 'needsYou', tag: 'milestone', title: `${name}: “${titleOf.get(taskId) ?? 'A task'}” stopped twice`, body: `${w.reason}. Resume it, or open its chat`, ...at, need: `plan:${plan.id}:stalled:${taskId}`, key: `plan:${plan.id}:${taskId}:stalled:${w.at}` });
    }
    for (const [msId, merge] of Object.entries(plan.merging ?? {})) {
      const c = merge.conflict;
      if (!c?.stuck || old.merging?.[msId]?.conflict?.stuck) continue;
      out.push({ kind: 'needsYou', tag: 'conflict', title: `${name}: merging “${titleOf.get(msId) ?? 'a milestone'}” hit a conflict Claude couldn’t fix`, body: `${c.key ?? c.merging} conflicts in ${c.files.join(', ')}: fix it in ${c.dir} and it passes`, ...at, key: `plan:${plan.id}:${msId}:conflict:${c.at}` });
    }
    for (const [unitId, r] of Object.entries(plan.rescue ?? {})) {
      if (!r.yours || old.rescue?.[unitId]?.yours) continue;
      const what = titleOf.get(unitId);
      out.push({ kind: 'needsYou', tag: 'milestone', title: `${name}: stuck${what ? ` on “${what}”` : ''}`, body: r.tried.length ? `Beluga tried: ${r.tried.join('; ')}` : 'Beluga couldn’t move it on by itself', ...at, need: `plan:${plan.id}:rescue:${unitId}`, key: `plan:${plan.id}:${unitId}:rescue:${r.at}` });
    }
  }
  return out;
}

function finishedRuns(prev: DomainState, next: DomainState): NoticeEvent[] {
  if (prev.log === next.log) return [];
  const before = new Map<string, AgentItem>();
  for (const l of prev.log.slice(-RECENT_LOG)) if (l.type === 'agent') before.set(l.id, l);
  const selfId = next.self?.peerId;
  const selfName = next.self?.name;
  const out: NoticeEvent[] = [];
  for (const item of next.log.slice(-RECENT_LOG)) {
    if (item.type !== 'agent' || !isFinal(item.status)) continue;
    // The Sentinel chat is quiet: you're looking at it when you use it (docs/sentinel.md §12).
    if (isSentinelChat(item.channel)) continue;
    const old = before.get(item.id);
    if (!old || isFinal(old.status)) continue;
    const mine = item.owner === selfId;
    // A friend's Claude matters when it was working for you.
    if (!mine && item.requesterName !== selfName) continue;
    const who = mine ? agentName(item.agent ?? defaultAgentOf(next.self)) : agentLabel(item.agent, item.ownerName, false);
    const where = placeName(next, item.channel);
    if (item.status === 'done') out.push({ kind: 'done', title: `${who} finished in ${where}`, body: firstLine(item.text) || 'Done', channel: item.channel, ...(mine && allDone(next, item) ? { watched: true } : {}) });
    else if (!QUIET_ERRORS.test(item.text)) out.push({ kind: 'problems', title: `${who} stopped in ${where}`, body: firstLine(item.text) || item.status, channel: item.channel });
  }
  return [...out, ...finishedTasks(next, before)];
}

/** The agent of your latest run in a conversation (the one asking there now, BLG-503); none: your default. */
function speakerIn(state: DomainState, channel: string | undefined): AgentRef {
  const selfId = state.self?.peerId;
  const run = state.log
    .slice(-RECENT_LOG)
    .reverse()
    .find((l): l is AgentItem => l.type === 'agent' && l.channel === channel && l.owner === selfId);
  return run?.agent ?? defaultAgentOf(state.self);
}

/** A long run of yours ended and nothing else runs or waits its turn in that conversation: everything there is finished. */
function allDone(state: DomainState, item: AgentItem): boolean {
  if (item.endTs === undefined || item.endTs - item.ts < WATCHED_RUN_MS) return false;
  return !state.log.slice(-RECENT_LOG).some((l) => l.type === 'agent' && l.channel === item.channel && l.id !== item.id && isRunning(l.status));
}

/** A task your Claude started in the background (a test run, a build) ending while it works on. */
function finishedTasks(next: DomainState, before: ReadonlyMap<string, AgentItem>): NoticeEvent[] {
  const out: NoticeEvent[] = [];
  for (const item of next.log.slice(-RECENT_LOG)) {
    // A run that just ended marks what's left as done: that's the run finishing, not its tasks.
    if (item.type !== 'agent' || item.owner !== next.self?.peerId || isFinal(item.status)) continue;
    const old = before.get(item.id);
    if (!old || old.subagents === item.subagents) continue;
    for (const task of item.subagents) {
      if (task.kind !== 'background' || task.status === 'running') continue;
      if (old.subagents.find((t) => t.id === task.id)?.status !== 'running') continue;
      const verb = task.status === 'done' ? 'finished' : 'failed';
      out.push({ kind: 'background', tag: 'task', title: `A background task ${verb} in ${placeName(next, item.channel)}`, body: firstLine(task.title), channel: item.channel });
    }
  }
  return out;
}

/** A new worktree's setup (npm install…) finished. Failed ones are announced as problems where they run. */
function finishedSetups(prev: DomainState, next: DomainState): NoticeEvent[] {
  if (prev.setup === next.setup) return [];
  return Object.entries(next.setup)
    .filter(([id, run]) => run.status === 'done' && prev.setup[id]?.status === 'running')
    .map(([id, run]) => ({ kind: 'background', tag: 'task', title: `${placeName(next, `ws:${id}`)} is set up`, body: run.command, channel: `ws:${id}` }));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a message says your name: "@name", not inside a longer word or handle. */
export const mentionOf = (name: string): RegExp => new RegExp(`(^|[^\\w@])@${escapeRe(name)}(?![\\w-])`, 'i');

/** Someone mentions you by name, or writes in the room when it's just the two of you. */
function messagesForYou(prev: DomainState, next: DomainState): NoticeEvent[] {
  const self = next.self;
  if (prev.log === next.log || !prev.self || !self) return [];
  const seen = new Set(prev.log.slice(-RECENT_LOG).map((l) => l.id));
  const fresh = next.log.slice(-RECENT_LOG).filter((l): l is ChatItem => l.type === 'chat' && !seen.has(l.id));
  if (!fresh.length || fresh.length > MESSAGE_BURST) return [];
  const mention = mentionOf(self.name);
  const others = next.peers.filter((p) => p.peerId !== self.peerId);
  const out: NoticeEvent[] = [];
  for (const m of fresh) {
    if (m.from === self.peerId || m.byAgent) continue;
    const where = placeName(next, m.channel);
    if (mention.test(m.text)) out.push({ kind: 'mentions', tag: 'mention', title: `${m.name} mentioned you in ${where}`, body: firstLine(m.text), channel: m.channel });
    else if (m.channel === 'room' && others.length === 1 && others[0]?.peerId === m.from) out.push({ kind: 'mentions', tag: 'message', title: `${m.name} wrote to you`, body: firstLine(m.text), channel: m.channel });
  }
  return out;
}

/**
 * Someone mentions you in a task's comment ("@kayra can you look?", BLG-419): a teammate's comment
 * arrives with the board. Opening it goes to the task.
 */
function taskMentions(prev: DomainState, next: DomainState, now: number): NoticeEvent[] {
  if (prev.board.issues === next.board.issues) return [];
  const selfId = next.selfId;
  const name = next.self?.name ?? next.network.self?.name;
  if (!selfId || !name) return [];
  // "@Kayra Uckilinc" as typed, or "@KayraUckilinc" as the "@" list puts it.
  const handles = [...new Set([name, name.replace(/[^\p{L}\p{N}_.-]+/gu, '')])].filter((h) => h.length > 1).map(escapeRe);
  const mention = new RegExp(`(^|[^\\w@])@(${handles.join('|')})(?![\\w-])`, 'iu');
  const before = new Map(prev.board.issues.map((i) => [i.id, i]));
  const out: NoticeEvent[] = [];
  for (const issue of next.board.issues) {
    const was = before.get(issue.id);
    // A task you hadn't got yet is history (the board loading, a teammate's board arriving).
    if (!was || was === issue || was.activity === issue.activity) continue;
    const seen = new Set(was.activity.map((e) => e.id));
    for (const e of issue.activity) {
      if (seen.has(e.id) || e.kind !== 'comment' || !e.body || now - e.at > STALE_MESSAGE_MS) continue;
      if (e.by.kind !== 'person' || e.by.id === selfId || !mention.test(e.body)) continue;
      out.push({ kind: 'mentions', tag: 'mention', title: `${e.by.name} mentioned you on ${issue.key}`, body: firstLine(e.body), channel: `task:${issue.id}`, key: `task-mention:${e.id}` });
    }
  }
  return out;
}

/** Messages older than this arriving (a group catching up after days away) aren't news any more. */
const STALE_MESSAGE_MS = 12 * 60 * 60_000;

/**
 * A friend writes to you, or someone writes in one of your groups (the Beluga network). Quiet
 * while your status is Do Not Disturb or you appear offline: the inbox still has them.
 */
function networkMessages(prev: DomainState, next: DomainState, now: number): NoticeEvent[] {
  const before = prev.network;
  const after = next.network;
  // The first messages after the network starts are history, not news.
  if (before.messages === after.messages || !before.enabled || !after.self) return [];
  const self = after.self;
  const quiet = self.appearOffline || self.presence.state === 'dnd';
  const mention = new RegExp(`(^|[^\\w@])@${escapeRe(self.name)}(?![\\w-])`, 'i');
  const out: NoticeEvent[] = [];
  for (const [conversation, list] of Object.entries(after.messages)) {
    const old = before.messages[conversation];
    if (old === list) continue;
    const seen = new Set((old ?? []).map((m) => m.id));
    // A task's card says nothing new: the task itself asks you (or tells you it ran).
    const fresh = list.filter((m) => !seen.has(m.id) && !m.mine && !m.task && m.status !== 'locked' && now - m.ts < STALE_MESSAGE_MS);
    if (fresh.length > MESSAGE_BURST * 4) continue;
    const group = conversation.startsWith('group:') ? after.groups.find((g) => `group:${g.id}` === conversation) : undefined;
    for (const m of fresh) {
      const who = m.claude ? agentLabel(m.claude.agent, m.name, false) : m.name;
      const title = group ? (mention.test(m.text) ? `${who} mentioned you in ${group.name}` : `${who} in ${group.name}`) : who;
      const body = firstLine(m.text) || (m.files?.length ? `Sent ${m.files.map((f) => f.name).join(', ')}` : '');
      out.push({ kind: 'mentions', tag: group && mention.test(m.text) ? 'mention' : 'message', title, body, channel: conversation, ...(quiet ? { quiet: true } : {}) });
    }
  }
  return out;
}

/** A dialogue between your agents that just paused at its cap: it waits for your Continue. */
function dialogueNews(prev: DomainState, next: DomainState): NoticeEvent[] {
  if (prev.dialogues === next.dialogues) return [];
  const out: NoticeEvent[] = [];
  for (const d of Object.values(next.dialogues)) {
    if (d.remoteChair || d.status !== 'paused' || prev.dialogues[d.id]?.status === 'paused') continue;
    const channel = d.channel ?? 'room';
    out.push({ kind: 'needsYou', tag: 'question', title: `Your agents paused in ${placeName(next, channel)}`, body: `${firstLine(d.topic)}: continue, or stop`, channel, need: `dialogue:${d.id}`, key: `dialogue:${d.id}:paused:${d.pauseAt}` });
  }
  return out;
}

/**
 * What happened between two states that you'd want to hear about: Claude finished or
 * stopped, needs an answer or approval, a merge conflict, someone joined or invited you.
 */
export function detectNotices(prev: DomainState, next: DomainState, now = Date.now()): NoticeEvent[] {
  const out = [...finishedRuns(prev, next), ...finishedSetups(prev, next), ...messagesForYou(prev, next), ...taskMentions(prev, next, now), ...networkMessages(prev, next, now), ...planNews(prev, next), ...dialogueNews(prev, next)];
  if (prev.approvals !== next.approvals) {
    const seen = new Set(prev.approvals.map((a) => a.id));
    // Someone else's request waits for you either way; on Do Not Disturb it just doesn't make a sound.
    const quiet = presenceQuiet(next);
    for (const a of next.approvals) {
      if (seen.has(a.id)) continue;
      // An approval a plan's task asks for opens the plan there.
      // One in a friends' chat (a request that came from there, your Claude working there) opens that chat.
      const inPlan = a.channel !== undefined && (planOfChannel(next, a.channel) || /^(dm|group):/.test(a.channel)) ? { channel: a.channel } : {};
      out.push({ kind: 'needsYou', tag: 'approval', ref: a.id, title: a.title, body: firstLine(a.detail), ...inPlan, ...(a.task ? { task: a.task } : {}), ...(a.once ? { once: true } : {}), ...(a.peer && quiet ? { quiet: true } : {}) });
    }
  }
  if (prev.questions !== next.questions) {
    const seen = new Set(prev.questions.map((q) => q.qid));
    for (const q of next.questions) {
      if (seen.has(q.qid)) continue;
      const where = placeName(next, q.channel);
      const who = agentName(speakerIn(next, q.channel));
      out.push(
        q.question.kind === 'plan'
          ? { kind: 'needsYou', tag: 'plan', ref: q.qid, title: `${who} has a plan for ${where}`, body: 'Approve it, or say what to change', channel: q.channel }
          : isDecisionQid(q.qid)
            ? { kind: 'needsYou', tag: 'question', ref: q.qid, title: `Your call in ${where}`, body: firstLine(q.question.questions[0]?.question ?? ''), channel: q.channel }
            : { kind: 'needsYou', tag: 'question', ref: q.qid, title: `${who} asks in ${where}`, body: firstLine(q.question.questions[0]?.question ?? ''), channel: q.channel },
      );
    }
  }
  if (prev.conflicts !== next.conflicts) {
    for (const [id, files] of Object.entries(next.conflicts)) {
      if (!files.length || prev.conflicts[id]?.length) continue;
      out.push({ kind: 'problems', tag: 'conflict', title: `Merge conflict in ${placeName(next, `ws:${id}`)}`, body: `${files.length} file(s): ${files.slice(0, 3).join(', ')}`, channel: `ws:${id}` });
    }
  }
  // People: only after you're in (the first peer list is everyone already there).
  if (prev.self && prev.peers !== next.peers && prev.peers.length) {
    const seen = new Set(prev.peers.map((p) => p.peerId));
    const still = new Set(next.peers.map((p) => p.peerId));
    const selfId = next.self?.peerId;
    for (const p of next.peers) if (!seen.has(p.peerId) && p.peerId !== selfId) out.push({ kind: 'people', tag: 'joined', title: `${p.name} joined`, body: p.agent ? `They brought their ${agentName(defaultAgentOf(p))}` : 'Say hi in the group chat', channel: 'room' });
    // Only while you're still in the room: losing the room isn't news about each person.
    if (next.status === 'connected' && next.peers.some((p) => p.peerId === selfId)) {
      for (const p of prev.peers) if (!still.has(p.peerId) && p.peerId !== selfId) out.push({ kind: 'people', tag: 'left', title: `${p.name} left`, body: p.agent ? `Their ${agentName(defaultAgentOf(p))} left with them` : 'They left the room', channel: 'room' });
    }
  }
  if (prev.shared !== next.shared) {
    const seen = new Set(prev.shared.map((w) => `${w.owner}:${w.id}`));
    for (const w of next.shared) {
      if (seen.has(`${w.owner}:${w.id}`)) continue;
      const peer = next.peers.find((p) => p.peerId === w.owner);
      const owner = peer?.name ?? 'Someone';
      out.push({ kind: 'people', tag: 'invited', title: `${owner} invited you to ${w.name}`, body: w.role === 'contribute' ? `You can work there with their ${agentName(defaultAgentOf(peer))}` : 'You can follow along', channel: `ws:${w.id}` });
    }
  }
  return next.plans.plans.length ? out.map((e) => scopeToPlan(next, e)) : out;
}

/** Friends' messages arriving within this long show as one banner. */
const BANNER_MS = 400;

export interface NotifierDeps {
  readonly store: Store;
  /** Show a desktop notification. */
  readonly desktop: (n: DesktopNote) => void;
  /** A short message on screen (for notices about what you're looking at). */
  readonly toast?: (text: string, level: 'info' | 'warn') => void;
  /** Coalesce bursts: at most one desktop notification per this many ms (default 1500). */
  readonly burstMs?: number;
  readonly now?: () => number;
}

/** Whether a notice that made the inbox also goes to the desktop right now (Settings → Notifications). */
export function desktopAllowed(state: Pick<DomainState, 'prefs' | 'attention'>, now = Date.now()): boolean {
  const prefs = state.prefs.notify;
  if (!prefs.desktop || dndActive(prefs, now)) return false;
  return !(prefs.onlyAway && state.attention.front);
}

/**
 * Watches the room and your workspaces, keeps an inbox of what happened while you were
 * looking elsewhere, and raises desktop notifications for it. Nothing is announced
 * about a conversation a screen in front is showing (see Attention in store.ts).
 */
export class Notifier {
  private prev: DomainState;
  private readonly unsubscribe: () => void;
  private queue: NoticeEvent[] = [];
  private timer?: NodeJS.Timeout;
  private lastSent = 0;
  /** Keys of what was already announced (a plan's milestone passing…): never twice. */
  private readonly told = new Set<string>();
  private banners: NoticeEvent[] = [];
  private bannerTimer?: NodeJS.Timeout;

  constructor(private readonly deps: NotifierDeps) {
    this.prev = deps.store.getState();
    this.unsubscribe = deps.store.subscribe(() => this.onChange());
  }

  stop(): void {
    this.unsubscribe();
    clearTimeout(this.timer);
    clearTimeout(this.bannerTimer);
  }

  /** Raise a notification directly (pull requests, setup scripts, handoffs). */
  notify(event: NoticeEvent): void {
    this.handle([event], this.deps.store.getState(), true);
  }

  /** Show a test notification whatever the settings say (you asked for it). */
  test(): void {
    const e: NoticeEvent = { kind: 'done', tag: 'test', title: 'Notifications work', body: 'This is how Beluga tells you your agent finished or needs you' };
    this.deps.store.dispatch({ type: 'notice_add', notice: { kind: e.kind, tag: e.tag, title: e.title, body: e.body } });
    this.queue.push(e);
    this.flush();
  }

  private onChange(): void {
    const next = this.deps.store.getState();
    const prev = this.prev;
    this.prev = next;
    if (prev === next) return;
    // Opening a conversation reads its notices; answering something reads the notice about it.
    if (prev.attention !== next.attention) this.markSeen(next);
    if (prev.approvals !== next.approvals || prev.questions !== next.questions) this.markAnswered(next);
    if (WAITING.some((k) => prev[k] !== next[k]) && next.inbox.some((n) => !n.read && n.need !== undefined)) this.markSettled(prev, next);
    const events = detectNotices(prev, next, this.now());
    if (events.length) this.handle(events, next);
  }

  private markSeen(state: DomainState): void {
    for (const channel of state.attention.visible) {
      if (state.inbox.some((n) => !n.read && n.channel === channel)) this.deps.store.dispatch({ type: 'notice_read', channel });
    }
  }

  private markAnswered(state: DomainState): void {
    const open = new Set([...state.approvals.map((a) => a.id), ...state.questions.map((q) => q.qid)]);
    for (const n of state.inbox) if (!n.read && n.ref !== undefined && !open.has(n.ref)) this.deps.store.dispatch({ type: 'notice_read', id: n.id });
  }

  /** A notice about something that waited for you (a team-up, a friend's question…) is read once it's settled, here or on another screen. */
  private markSettled(prev: DomainState, next: DomainState): void {
    const was = allNeeds(prev).map((x) => x.id);
    const now = allNeeds(next).map((x) => x.id);
    for (const n of next.inbox) {
      const need = n.need;
      if (n.read || need === undefined) continue;
      if (was.some((id) => needMatches(id, need)) && !now.some((id) => needMatches(id, need))) this.deps.store.dispatch({ type: 'notice_read', id: n.id });
    }
  }

  private handle(events: readonly NoticeEvent[], state: DomainState, direct = false): void {
    const prefs = state.prefs.notify;
    const desktop = desktopAllowed(state, this.now());
    for (const raw of events) {
      const e = direct ? scopeToPlan(state, raw) : raw;
      if (!enabled(prefs, e.kind, e.tag)) continue;
      if (e.key !== undefined) {
        if (this.told.has(e.key) || state.inbox.some((n) => n.key === e.key)) continue;
        this.told.add(e.key);
      }
      // A screen in front shows it: a direct notice (it isn't in the chat) still shows as a toast.
      // A long run of yours ending there still reaches the desktop (you may have looked away), not the bell.
      if (e.channel !== undefined && state.attention.visible.includes(e.channel)) {
        if (direct) this.deps.toast?.(`${e.title}${e.body ? `: ${e.body}` : ''}`, e.kind === 'problems' ? 'warn' : 'info');
        else if (e.watched && prefs.doneHere !== false && desktop && !e.quiet) this.queue.push(e);
        continue;
      }
      const { kind, tag, ref, title, body, channel, plan, planTask, need, key } = e;
      // A plan's task speaking quietly: it's in the inbox under the plan, already read.
      const hushed = remindLaterNotice(state, e, this.now());
      const read = Boolean(e.quiet && plan) || hushed;
      this.deps.store.dispatch({ type: 'notice_add', notice: { kind, ...(tag ? { tag } : {}), ...(ref ? { ref } : {}), title, body, channel, ...(plan ? { plan } : {}), ...(planTask ? { planTask } : {}), ...(need ? { need } : {}), ...(key ? { key } : {}) }, ...(read ? { read } : {}) });
      if (hushed) continue;
      // You're in Beluga, looking at another conversation: a friend's message shows in the window.
      if (state.attention.front && isNetworkMessage(e) && !e.quiet && !dndActive(prefs, this.now())) this.banners.push(e);
      else if (desktop && !e.quiet) this.queue.push(e);
    }
    this.flush();
    this.flushBanners();
  }

  /** Friends' messages shown in the window, a burst as one banner. */
  private flushBanners(): void {
    if (!this.banners.length || this.bannerTimer) return;
    this.bannerTimer = setTimeout(() => {
      this.bannerTimer = undefined;
      const batch = this.banners;
      this.banners = [];
      if (!batch.length) return;
      const prefs = this.deps.store.getState().prefs.notify;
      const note = combine(batch, prefs);
      const many = batch.length > 1 ? { title: `${batch.length} new messages`, body: batch.map((e) => e.title).slice(0, 4).join(' · ') } : {};
      this.deps.desktop({ ...note, ...many, banner: true });
    }, BANNER_MS);
    this.bannerTimer.unref?.();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private flush(): void {
    if (!this.queue.length || this.timer) return;
    const wait = Math.max(0, this.lastSent + (this.deps.burstMs ?? 1500) - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.queue;
      this.queue = [];
      if (!batch.length) return;
      this.lastSent = this.now();
      const prefs = this.deps.store.getState().prefs.notify;
      this.deps.desktop(combine(batch, prefs, prefs.popup !== false && prefs.needsYou !== false));
    }, wait);
    this.timer.unref?.();
  }
}

/** The sound part of a desktop notification: on/off only (`boolean`), or the sound its kinds make. */
function soundOf(batch: readonly NoticeEvent[], prefs: boolean | SoundPrefs): Pick<DesktopNote, 'sound' | 'tone' | 'volume'> {
  if (typeof prefs === 'boolean') return { sound: prefs };
  const tone = soundFor(prefs, loudestKind(batch.map((e) => e.kind)));
  return { sound: tone.kind !== 'none', tone, volume: volumeOf(prefs) };
}

/** One desktop notification for a burst; clicking it goes where they all are, if that's one place. */
export function combine(batch: readonly NoticeEvent[], prefs: boolean | SoundPrefs, popup = false): DesktopNote {
  const first = batch[0]!;
  const sound = { ...soundOf(batch, prefs), ...(popup && batch.every((e) => e.kind === 'needsYou') ? { popup: true } : {}) };
  const channel = first.channel !== undefined && batch.every((e) => e.channel === first.channel) ? { channel: first.channel } : {};
  // One approval on its own can be answered from the notification itself.
  const approval = first.tag === 'approval' && first.ref ? { approval: first.ref, ...(first.task ? { task: first.task } : {}), ...(first.once ? { once: true } : {}) } : {};
  if (batch.length === 1) return { title: first.title, body: first.body, ...sound, ...channel, ...approval };
  return { title: `${batch.length} updates in Beluga`, body: batch.map((e) => e.title).slice(0, 4).join(' · '), ...sound, ...channel };
}

/**
 * Whether you want to hear about this kind (missing in old settings: yes). Sentinels have their own
 * switch on top, for their results and failures; one that waits for you (a merge to allow) still tells.
 */
export const enabled = (prefs: NotifySettings, kind: NoticeKind, tag?: NoticeTag): boolean =>
  prefs[kind] !== false && !(tag === 'sentinel' && kind !== 'needsYou' && prefs.sentinels === false);
