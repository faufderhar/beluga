import { autopilotWaitMinutes } from '../../shared/autopilot-wait.js';
import { type Plan, autonomyOf } from '../plans/model.js';
import type { DomainState } from '../store.js';
import { autopilotIn, planWorkOf } from './model.js';

/**
 * How long your own agent's question or plan waits for you in a conversation before it carries on
 * without your answer (BLG-998), in ms; undefined: it waits until you answer or press Stop.
 *
 * Only work on Autopilot gives up, after Settings › Agent › Autopilot's wait: a plan on Autopilot
 * (its own conversation, its draft's review) or a milestone of one (its worktree, its checker, its
 * tasks). Step by Step, Check-ins and chats outside a plan wait for you, and Full Autopilot has a
 * stand-in answer instead. Browser-safe.
 */
export function autopilotWaitMs(state: Pick<DomainState, 'plans' | 'board' | 'autopilot' | 'prefs'>, channel: string): number | undefined {
  const minutes = autopilotWaitMinutes(state.prefs.autopilotWait);
  if (!minutes || autopilotIn(state, channel)) return undefined;
  const work = planWorkOf(state, channel);
  if (!work || autonomyOf(work.plan, milestoneOf(work.plan, work.milestone)) !== 'autopilot') return undefined;
  return minutes * 60_000;
}

const milestoneOf = (plan: Plan, id: string | undefined) => (id ? (plan.body ?? plan.draft)?.milestones.find((m) => m.id === id) : undefined);
