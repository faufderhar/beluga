import { type DomainState, type LogItem, isRunning } from '../store.js';
import { autoContinueFor, limitResumeAt } from '../../shared/auto-continue.js';
import { decodeFailure } from '../../shared/run-failure.js';
import { planById } from '../plans/model.js';
import { planConversations } from '../plans/owner.js';
import { chatsWithThreadsWorking } from '../threads/model.js';
import { type ChatTriage, type HandSource, type TriageFacts, type TriageSource, handRaisedOf, triageKey } from './model.js';

/**
 * What the state says about a chat, for the pure rules in model.ts. `key` is a triage record's:
 * `ws:<id>`, or `plan:<id>`, which stands for all the plan's conversations. Browser-safe.
 */

export type FactSource = Pick<DomainState, 'log' | 'projects' | 'approvals' | 'questions' | 'claudeCode' | 'plans' | 'board' | 'prefs'>;

interface RunFacts {
  readonly running: boolean;
  readonly waiting: readonly string[];
  /** When its latest failed run ended, a usage-limit stop left out. */
  readonly failedAt?: number;
  /** Its latest usage-limit stop: when it ended, and when Beluga sends it on (shared/auto-continue.ts). */
  readonly limit?: { readonly at: number; readonly resumeAt: number };
  readonly lastAt?: number;
}

// The log is replaced, never changed, so one pass per log serves every chat.
const runIndex = new WeakMap<readonly LogItem[], ReadonlyMap<string, RunFacts>>();

/** The conversations a record stands for. A plan that's done folds nothing any more, but its home still talks while its PR waits. */
export function channelsOf(state: Pick<DomainState, 'plans' | 'board'>, key: string): readonly string[] {
  if (!key.startsWith('plan:')) return [key];
  const id = key.slice(5);
  const home = planById(state.plans, id)?.home;
  return [...new Set([...planConversations(state, id).map((ws) => `ws:${ws}`), ...(home?.startsWith('ws:') ? [home] : [])])];
}

export function handSourceOf(state: FactSource, key: string): HandSource {
  const channels = channelsOf(state, key);
  const runs = channels.map((c) => [c, runsOf(state.log).get(c)] as const);
  // A usage-limit stop that Beluga continues by itself doesn't need you; one it won't continue does.
  const failed = runs.flatMap(([c, r]) => [...(r?.failedAt !== undefined ? [r.failedAt] : []), ...(r?.limit && autoContinueFor(state.prefs, c, r.limit.resumeAt).kind !== 'scheduled' ? [r.limit.at] : [])]);
  return {
    openIds: [...state.approvals.filter((a) => a.channel !== undefined && channels.includes(a.channel)).map((a) => a.id), ...state.questions.filter((q) => q.channel !== undefined && channels.includes(q.channel)).map((q) => q.qid), ...runs.flatMap(([, r]) => r?.waiting ?? [])],
    planStuck: key.startsWith('plan:') && planStuck(state, key.slice(5)),
    ...(failed.length ? { failedAt: Math.max(...failed) } : {}),
  };
}

/** A chat works while its own turn runs, a thread under it works, or a Claude Code session there does. */
export function workingIn(state: FactSource, key: string): boolean {
  return channelsOf(state, key).some((c) => runsOf(state.log).get(c)?.running || chatsWithThreadsWorking(state).has(c) || state.claudeCode.sessions.some((x) => !x.own && `ws:${x.workspaceId}` === c && x.status === 'working'));
}

export function triageFacts(state: FactSource & Pick<DomainState, 'triage'>, key: string): TriageFacts {
  return { handRaised: handRaisedOf(state.triage[key], handSourceOf(state, key)), working: workingIn(state, key) };
}

/** The keys of the records put off till later, once per records object (it's replaced, never changed). */
const laterKeys = new WeakMap<object, ReadonlySet<string>>();

/**
 * When a chat put off till later (Remind Me Later) reminds you, while that's still ahead and nothing
 * new asks you there (that ends it: the daemon wakes it); with the categories on or off. `triage`
 * is absent in a snapshot from an older daemon.
 */
export function laterUntil(state: FactSource & TriageSource & { readonly triage?: Readonly<Record<string, ChatTriage>> }, channel: string, now = Date.now()): number | undefined {
  const records = state.triage;
  if (!records) return undefined;
  let keys = laterKeys.get(records);
  if (!keys) {
    keys = new Set(Object.entries(records).flatMap(([key, r]) => (r.snoozed ? [key] : [])));
    laterKeys.set(records, keys);
  }
  if (!keys.size) return undefined;
  const key = triageKey(state, channel);
  const record = key === undefined ? undefined : records[key];
  const until = record?.snoozed?.until;
  if (until === undefined || until <= now) return undefined;
  return handRaisedOf(record, handSourceOf(state, key!)) ? undefined : until;
}

/** The last thing the log holds of a conversation. */
export const lastLogAt = (log: readonly LogItem[], channel: string): number | undefined => runsOf(log).get(channel)?.lastAt;

/** A plan gave up by itself: a task stopped again after Beluga woke it, or a milestone is past every rescue step. */
function planStuck(state: Pick<DomainState, 'plans'>, planId: string): boolean {
  const plan = planById(state.plans, planId);
  if (plan?.status !== 'active') return false;
  return Object.values(plan.watch ?? {}).some((w) => w.needsYou) || Object.values(plan.rescue ?? {}).some((r) => r.yours);
}

function runsOf(log: readonly LogItem[]): ReadonlyMap<string, RunFacts> {
  const hit = runIndex.get(log);
  if (hit) return hit;
  const out = new Map<string, RunFacts>();
  for (const item of log) {
    const was = out.get(item.channel) ?? { running: false, waiting: [] };
    if (item.type !== 'agent') {
      out.set(item.channel, { ...was, lastAt: item.ts });
      continue;
    }
    const ended = item.endTs ?? item.lastAt ?? item.ts;
    const failure = item.status === 'error' ? decodeFailure(item.text) : undefined;
    const limit = failure?.kind === 'usage_limit' ? { at: ended, resumeAt: limitResumeAt(failure, ended) } : was.limit;
    const failedAt = item.status === 'error' && failure?.kind !== 'usage_limit' ? ended : was.failedAt;
    out.set(item.channel, {
      running: was.running || isRunning(item.status),
      waiting: item.status === 'awaiting_approval' ? [...was.waiting, item.id] : was.waiting,
      lastAt: item.ts,
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(limit ? { limit } : {}),
    });
  }
  runIndex.set(log, out);
  return out;
}
