import type { Issue } from '../board/model.js';
import type { MilestoneRun, Plan } from './model.js';
import type { TaskPulse } from './watchdog.js';

/**
 * When things in a plan happened, from what the plan and the board already keep: the plan's own
 * times, each milestone's run, and each task's issue (its status changes in its activity). Read
 * back to the plan's agents (plan_get) and shown on the screens, so a task that is stuck reads
 * differently from one that just started, and two read-backs can be put in order. Browser-safe.
 */

/** "2026-11-19T10:42Z": an absolute time an agent reads, to the minute, in UTC. */
export const isoMinute = (at: number): string => (Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16)}Z` : 'unknown');

/** "12 min ago", "3h ago", "2d ago"; a time ahead of `now` (another computer's clock) is "just now". */
export function agoWords(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "2026-11-19T10:42Z (12 min ago)". */
export const whenWords = (at: number, now: number): string => (Number.isFinite(at) ? `${isoMinute(at)} (${agoWords(at, now)})` : 'unknown');

/** A task's times: since it reached the status it's in, its last change (or its agent's step now), and when it closed. */
export interface TaskTimes {
  readonly since: number;
  readonly updated: number;
  readonly closed?: number;
}

/** Changes this close to `since` say nothing more: the line leaves "updated" out. */
const SAME_MS = 60_000;

/** None when the task keeps no time at all (a task brought over from an older Beluga). */
export function taskTimes(issue: Issue, pulse?: TaskPulse): TaskTimes | undefined {
  // Its activity is kept newest last (and trimmed): the last status change is when it got here.
  const moved = [...(issue.activity ?? [])].reverse().find((a) => a.kind === 'status');
  const since = moved?.at ?? issue.createdAt;
  if (!Number.isFinite(since)) return undefined;
  const step = pulse && (pulse.kind === 'working' || pulse.kind === 'command') ? pulse.since : 0;
  return { since, updated: Math.max(Number.isFinite(issue.updatedAt) ? issue.updatedAt : 0, step, since), ...(issue.closedAt ? { closed: issue.closedAt } : {}) };
}

/** Whether "updated" says something "since" doesn't. */
export const updatedApart = (t: TaskTimes): boolean => t.updated - t.since >= SAME_MS;

/** A task's times as plan_get says them: "since … · updated …". */
export function taskTimeFacts(issue: Issue | undefined, pulse: TaskPulse | undefined, now: number): string[] {
  const t = issue && taskTimes(issue, pulse);
  if (!t) return [];
  return [`since ${whenWords(t.since, now)}`, ...(updatedApart(t) ? [`updated ${whenWords(t.updated, now)}`] : [])];
}

/** A milestone's times as plan_get says them: its agent started, its last check, passed. */
export function milestoneTimeFacts(run: MilestoneRun | undefined, now: number): string[] {
  if (!run) return [];
  return [
    run.agent ? `agent started ${whenWords(run.agent.at, now)}` : '',
    run.checkAsked && (!run.check || run.check.at < run.checkAsked) ? `check asked ${whenWords(run.checkAsked, now)}` : '',
    run.check ? `checked ${whenWords(run.check.at, now)} (${run.check.verdict})` : '',
    run.passedAt ? `passed ${whenWords(run.passedAt, now)}` : '',
  ].filter(Boolean);
}

/** The plan's own times, and when this read-back was made. */
export function planTimeLine(plan: Pick<Plan, 'createdAt' | 'updatedAt' | 'approvedAt' | 'doneAt'>, now: number): string {
  const parts = [
    `created ${whenWords(plan.createdAt, now)}`,
    plan.approvedAt ? `approved ${whenWords(plan.approvedAt, now)}` : '',
    `updated ${whenWords(plan.updatedAt, now)}`,
    plan.doneAt ? `done ${whenWords(plan.doneAt, now)}` : '',
  ].filter(Boolean);
  return `Read at ${isoMinute(now)} (times are UTC). Plan ${parts.join(' · ')}.`;
}
