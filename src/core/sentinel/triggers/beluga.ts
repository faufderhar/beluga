import type { Actor } from '../../board/model.js';
import type { Action, DomainState, Store } from '../../store.js';
import { planTitle } from '../../plans/model.js';
import { type BelugaTrigger, sentinelOfChannel } from '../model.js';
import { agentName } from '../../../shared/agent-label.js';
import { type TriggerContext, type TriggerDeps, type TriggerEvent, clip } from './types.js';

/**
 * Beluga's own events (docs/sentinel.md §1): a task is done, a pull request opens or merges, a
 * plan's milestone passes, a worktree's Claude finishes, a friend asks something. Heard from the
 * store as they happen (only changes count: a task that was done already isn't news). `projectId`
 * keeps it to one project. The loop guard: what a sentinel's own run made (its worktree, its pull
 * request, its chat) never starts that sentinel (TriggerEvent.from).
 */

/** What the listener remembers, to tell a change from a repeat. */
export interface Memory {
  readonly status: Map<string, string>;
  readonly prs: Map<string, { readonly number: number; readonly state: string }>;
  /**
   * Each worktree's pull request numbers seen (kept when gh briefly says none, and in the cursor
   * across restarts): only a number never seen there opens.
   */
  readonly prsSeen?: Map<string, Set<number>>;
  readonly passed: Set<string>;
  readonly asks: Set<string>;
}

/** The cursor: each worktree's pull request numbers seen. */
export interface BelugaCursor {
  readonly prs: Readonly<Record<string, readonly number[]>>;
}

/** Numbers kept per worktree (a worktree has a few pull requests over its life), and worktrees kept (the latest). */
const PRS_KEPT = 50;
const WORKTREES_KEPT = 500;

export function remembered(st: DomainState, cursor?: BelugaCursor): Memory {
  const passed = new Set<string>();
  for (const p of st.plans.plans) for (const [mid, run] of Object.entries(p.runs)) if (run.passedAt) passed.add(`${p.id}:${mid}`);
  const prsSeen = new Map<string, Set<number>>();
  for (const [id, nums] of Object.entries(cursor?.prs ?? {})) if (Array.isArray(nums)) prsSeen.set(id, new Set(nums.filter((n) => typeof n === 'number')));
  // The first look: what's open now isn't news (nor after a restart, with the cursor).
  for (const [id, pr] of Object.entries(st.prs)) prsSeen.set(id, (prsSeen.get(id) ?? new Set()).add(pr.number));
  return {
    status: new Map(st.board.issues.map((i) => [i.id, i.status])),
    prs: new Map(Object.entries(st.prs).map(([id, pr]) => [id, { number: pr.number, state: pr.state }])),
    prsSeen,
    passed,
    asks: new Set(st.gateway.tasks.map((t) => t.id)),
  };
}

/**
 * The memory's pull request numbers as a cursor: the worktrees with news last, the latest 500
 * kept (one gone isn't dropped by its absence: the projects may not have loaded yet).
 */
export function belugaCursor(mem: Memory): BelugaCursor {
  const prs: Record<string, number[]> = {};
  for (const [id, nums] of [...(mem.prsSeen ?? [])].slice(-WORKTREES_KEPT)) prs[id] = [...nums].slice(-PRS_KEPT);
  return { prs };
}

/**
 * Whose move a task's change was: yours (you, your Claude, Beluga here) or not (a teammate's,
 * through the team's board; a tracker's, through sync). The newest status line in its activity says.
 */
function movedHere(issue: { readonly activity?: ReadonlyArray<{ readonly kind: string; readonly at: number; readonly by: Actor }> }, selfId: string): boolean {
  const moves = (issue.activity ?? []).filter((a) => a.kind === 'status');
  const last = moves.reduce<(typeof moves)[number] | undefined>((m, a) => (!m || a.at >= m.at ? a : m), undefined);
  if (!last) return true;
  const by = last.by;
  return by.kind === 'beluga' || (by.kind === 'person' && by.id === selfId) || (by.kind === 'claude' && by.owner === selfId);
}

const workspaceOf = (st: DomainState, id: string) => {
  for (const p of st.projects) {
    const ws = p.workspaces.find((w) => w.id === id);
    if (ws) return { project: p, ws };
  }
  return undefined;
};

/** The sentinel run that made this place (its chat or worktree), for the loop guard. */
const madeBy = (st: DomainState, channel: string | undefined): TriggerEvent['from'] => {
  const owner = sentinelOfChannel(st.sentinel, channel);
  return owner?.runId ? { sentinelId: owner.sentinel.id, runId: owner.runId } : undefined;
};

/** The sentinel run whose prompt started this turn (its card's origin says so), if one did. */
const wokenBy = (st: DomainState, owner: string, requestId: string): TriggerEvent['from'] => {
  const card = st.log.find((l) => l.type === 'agent' && l.requestId === requestId && l.owner === owner);
  const woke = card?.type === 'agent' ? card.origin?.sentinel : undefined;
  return woke?.run ? { sentinelId: woke.id, runId: woke.run } : undefined;
};

/** One action, in Beluga's words: the event it is for this trigger (none: not this, or not news). Updates the memory. */
export function belugaEvent(t: BelugaTrigger, a: Action, st: DomainState, mem: Memory, selfId: string): TriggerEvent | undefined {
  const inProject = (projectId: string | undefined): boolean => !t.projectId || projectId === t.projectId;
  switch (a.type) {
    case 'board_issue': {
      const was = mem.status.get(a.issue.id);
      mem.status.set(a.issue.id, a.issue.status);
      // A task seen before, moved to done here: not one that came over done (a teammate's, the
      // tracker's), nor one a teammate or the tracker moved.
      if (t.what !== 'task-done' || a.issue.status !== 'done' || was === undefined || was === 'done' || !inProject(a.issue.projectId)) return undefined;
      if (a.origin === 'team' || !movedHere(a.issue, selfId)) return undefined;
      const issue = a.issue;
      const from = issue.worktrees.map((w) => madeBy(st, `ws:${w}`)).find(Boolean);
      const project = st.projects.find((p) => p.id === issue.projectId)?.name;
      return { summary: clip(`Beluga: ${issue.key} is done: ${issue.title}`, 130), payload: { event: 'task-done', key: issue.key, title: issue.title, project, labels: issue.labels, ...(issue.pr ? { pr: issue.pr } : {}) }, ...(from ? { from } : {}) };
    }
    case 'pr': {
      const was = mem.prs.get(a.id);
      const pr = a.pr;
      if (pr) mem.prs.set(a.id, { number: pr.number, state: pr.state });
      else mem.prs.delete(a.id);
      if (!pr) return undefined;
      // Seen before here (before a restart, before gh said none for a moment): not news.
      const nums = mem.prsSeen ?? new Map<string, Set<number>>();
      const seen = nums.get(a.id) ?? new Set<number>();
      const fresh = !seen.has(pr.number);
      if (fresh) {
        // Last in the map: the latest worktrees are the ones kept.
        nums.delete(a.id);
        nums.set(a.id, seen.add(pr.number));
      }
      if (t.what !== 'pr-opened' && t.what !== 'pr-merged') return undefined;
      const place = workspaceOf(st, a.id);
      if (!inProject(place?.project.id)) return undefined;
      const opened = t.what === 'pr-opened' && pr.state === 'OPEN' && fresh;
      const merged = t.what === 'pr-merged' && pr.state === 'MERGED' && was !== undefined && was.number === pr.number && was.state !== 'MERGED';
      if (!opened && !merged) return undefined;
      const from = madeBy(st, `ws:${a.id}`);
      return {
        summary: clip(`Beluga: pull request #${pr.number} ${opened ? 'opened' : 'merged'}: ${pr.title}`, 130),
        payload: { event: t.what, number: pr.number, title: pr.title, url: pr.url, draft: pr.draft, checks: pr.checks, project: place?.project.name, worktree: place?.ws.name, branch: place?.ws.branch },
        ...(from ? { from } : {}),
      };
    }
    case 'plan_put': {
      const plan = a.plan;
      let out: TriggerEvent | undefined;
      for (const [mid, run] of Object.entries(plan.runs)) {
        const key = `${plan.id}:${mid}`;
        if (!run.passedAt || mem.passed.has(key)) continue;
        mem.passed.add(key);
        if (t.what !== 'milestone-passed' || out || !inProject(plan.projectId)) continue;
        const milestone = plan.body?.milestones.find((m) => m.id === mid);
        const title = milestone?.title ?? 'A milestone';
        const planName = planTitle(plan);
        out = { summary: clip(`Beluga: milestone “${title}” passed in ${planName}`, 130), payload: { event: 'milestone-passed', plan: planName, milestone: title, goal: milestone?.goal, criteria: milestone?.criteria, project: st.projects.find((p) => p.id === plan.projectId)?.name } };
      }
      return out;
    }
    case 'agent_event': {
      if (t.what !== 'claude-finished' || a.event !== 'done' || a.owner !== selfId || !a.channel?.startsWith('ws:')) return undefined;
      const place = workspaceOf(st, a.channel.slice(3));
      if (!place || place.ws.kind !== 'worktree' || !inProject(place.project.id)) return undefined;
      // A turn one of your sentinels woke (Wake one of your chats) comes from that sentinel's run: the chain guard stops a loop.
      const from = wokenBy(st, a.owner, a.requestId) ?? madeBy(st, a.channel);
      return { summary: clip(`Beluga: ${agentName(a.agent)} finished in ${place.ws.name}`, 130), payload: { event: 'claude-finished', project: place.project.name, worktree: place.ws.name, branch: place.ws.branch, answer: clip(a.text, 2000) }, ...(from ? { from } : {}) };
    }
    case 'gw_task': {
      const task = a.task;
      if (mem.asks.has(task.id)) return undefined;
      mem.asks.add(task.id);
      if (t.what !== 'friend-asks' || task.direction !== 'received') return undefined;
      if (t.projectId && task.project && st.projects.find((p) => p.id === t.projectId)?.name !== task.project) return undefined;
      return { summary: clip(`Beluga: ${task.peerName} asks: ${task.summary ?? task.ask}`, 130), payload: { event: 'friend-asks', from: task.peerName, kind: task.kind, ask: clip(task.ask, 2000), project: task.project, state: task.state } };
    }
    case 'gw_init':
      for (const task of a.state.tasks) mem.asks.add(task.id);
      return undefined;
    case 'board_init':
      for (const i of a.state.issues) mem.status.set(i.id, i.status);
      return undefined;
    default:
      return undefined;
  }
}

/** Listen to the store until stopped; the first `warmupMs` only remembers (the daemon's start isn't news). → stop. */
export function startBeluga(t: BelugaTrigger, ctx: TriggerContext<BelugaCursor>, deps: TriggerDeps & { readonly store: Store }): () => void {
  const now = deps.now ?? Date.now;
  const quietUntil = now() + (deps.warmupMs ?? 0);
  const was = ctx.cursor();
  const mem = remembered(deps.store.getState(), was && typeof was === 'object' && was.prs && typeof was.prs === 'object' ? was : undefined);
  let saved = '';
  const save = (): void => {
    const c = belugaCursor(mem);
    const text = JSON.stringify(c);
    if (text === saved) return;
    saved = text;
    ctx.save(c);
  };
  save();
  return deps.store.onAction((a) => {
    // After the reducer: the state has what the action brought.
    queueMicrotask(() => {
      const e = belugaEvent(t, a, deps.store.getState(), mem, deps.selfId());
      if (a.type === 'pr' && a.pr) save();
      if (e && now() >= quietUntil) ctx.fire(e);
    });
  });
}
