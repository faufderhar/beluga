import type { AgentRef } from '../../../../src/protocol.js';
import { type Autonomy, PLAN_ROLES, type Plan, type PlanRole } from '../../../../src/core/plans/model.js';
import { choiceForAgent } from '../../../../src/ui/agent-choice.js';

/**
 * Plan Settings: a plan's agents as New Plan's pickers say them, and what a Save has to send.
 * No React here, so tests load it (tests/mac-plan-settings.test.ts).
 */

/** components/agent-options.ts's YOUR_AGENT: the pick that follows your default agent. */
const YOURS = '';

/** Each part's pick (plans/AgentRoles.tsx's RoleChoice): YOURS or a picker's `runtime:model`. */
export type RolePicks = Readonly<Record<PlanRole, string>>;

/** Who does each part as plans.create takes it (AgentRoles' rolesInput): `agent` builds; no planner or checker means the builder. */
export interface RoleAgents {
  readonly agent?: AgentRef | undefined;
  readonly planner?: AgentRef | undefined;
  readonly checker?: AgentRef | undefined;
}

/** The plan's agents as the pickers show them: a planner or checker it never picked reads as its builder. */
export function picksOfPlan(plan: Partial<Pick<Plan, 'agent' | 'planner' | 'checker'>>): RolePicks {
  const builder = plan.agent ? choiceForAgent(plan.agent) : YOURS;
  return { builder, planner: plan.planner ? choiceForAgent(plan.planner) : builder, checker: plan.checker ? choiceForAgent(plan.checker) : builder };
}

const KEY: Readonly<Record<PlanRole, keyof RoleAgents>> = { planner: 'planner', builder: 'agent', checker: 'checker' };
const same = (a: AgentRef | undefined, b: AgentRef | undefined): boolean => a?.runtime === b?.runtime && (a?.model ?? '') === (b?.model ?? '');

/**
 * The parts whose agent moved between when the sheet opened and Save, each as plans.setRoleAgent
 * takes it (null: your agent for the builder, the builder for the others). Compared with what the
 * sheet opened on, so a part you didn't touch is never sent. The builder goes first.
 */
export function roleChanges(was: RoleAgents, now: RoleAgents): Array<readonly [PlanRole, AgentRef | null]> {
  const order: readonly PlanRole[] = ['builder', ...PLAN_ROLES.filter((r) => r !== 'builder')];
  return order.flatMap((role) => (same(was[KEY[role]], now[KEY[role]]) ? [] : [[role, now[KEY[role]] ?? null] as const]));
}

/** How a plan runs, as Plan Settings shows it: its autonomy, and Never wait for me (Full Autopilot, only on Autopilot). */
export interface HowItRuns {
  readonly autonomy: Autonomy;
  readonly full: boolean;
}

/**
 * What Save sends for how the plan runs (How It Runs' own calls): Never wait for me turned on is
 * plans.setFullAuto(true), which puts the plan on Autopilot too; turned off on Autopilot is
 * setFullAuto(false); any other way to run is setAutonomy, which ends Full Autopilot. Nothing moved: nothing.
 */
export function runsChange(was: HowItRuns, now: HowItRuns): { readonly fullAuto: boolean } | { readonly autonomy: Autonomy } | undefined {
  const full = now.autonomy === 'autopilot' && now.full;
  if (now.autonomy === was.autonomy && full === was.full) return undefined;
  if (full) return { fullAuto: true };
  if (was.full && now.autonomy === 'autopilot') return { fullAuto: false };
  return { autonomy: now.autonomy };
}

/**
 * Under Agents, before Save: a new builder works what starts next, and what is already at work
 * (milestones, or tasks when each has a worktree of its own) keeps the agent it opened with. Says
 * which, and how to move one now (its conversation's agent picker), so nobody waits for a change
 * that never reaches them. `atWork`: their titles. Undefined: nothing to say.
 */
export function keptAgentWords(changes: ReadonlyArray<readonly [PlanRole, AgentRef | null]>, atWork: readonly string[], unit: 'milestone' | 'task' = 'milestone'): string | undefined {
  if (!atWork.length || !changes.some(([role]) => role === 'builder')) return undefined;
  if (atWork.length === 1) return `“${atWork[0]}” is already at work and keeps its agent. To switch it now, pick an agent in its conversation.`;
  return unit === 'task' ? `${atWork.length} tasks already at work keep their agent. To switch one now, pick an agent in its conversation.` : `${atWork.length} milestones already at work keep their agent. To switch one now, pick an agent in its conversation.`;
}
