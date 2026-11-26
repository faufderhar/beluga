import { z } from 'zod';
import { AgentRef } from '../protocol.js';
import { AUTONOMIES, MAX_PARALLEL, PLAN_ROLES, TESTS_AT } from '../core/plans/model.js';
import { PRIORITIES } from '../core/board/model.js';

/**
 * Plans in the API (see api.ts): the Mac app's Plans view and plan pages. You act as yourself;
 * Claude writes plans through its own tools in the plan's conversation. Browser-safe: zod only.
 */

const id = z.string().min(1).max(60);
const ref = z.string().min(1).max(40);
const lines = z.union([z.array(z.string().max(400)).max(20), z.string().max(8000)]);
const task = z.object({
  id: ref.optional(),
  title: z.string().min(1).max(200),
  goal: z.string().max(4000).optional(),
  context: z.string().max(8000).optional(),
  acceptance: lines.optional(),
  blockedBy: z.array(ref).max(20).optional(),
  parent: ref.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  estimate: z.number().int().min(1).max(8).nullable().optional(),
  labels: z.array(z.string().max(32)).max(8).optional(),
  touches: z.array(z.string().max(200)).max(20).optional(),
  assignee: z.enum(['claude', 'me']).optional(),
});
const autonomy = z.enum(AUTONOMIES);
/** The computer a plan moves from or to: its device id (none: the app's own Mac) and name. */
const move = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/).optional(), name: z.string().min(1).max(80), at: z.number().int().min(0) });

/** Your changes to a plan (the same ops Claude has). */
export const PlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('retitle'), title: z.string().max(200).optional(), goal: z.string().max(4000).optional() }),
  z.object({ op: z.literal('add_milestone'), milestone: z.object({ id: ref.optional(), title: z.string().min(1).max(200), goal: z.string().max(4000).optional(), criteria: lines.optional(), tasks: z.array(task).optional(), dependsOn: z.array(ref).optional() }), after: ref.optional() }),
  z.object({ op: z.literal('update_milestone'), id: ref, title: z.string().max(200).optional(), goal: z.string().max(4000).optional(), criteria: lines.optional(), autonomy: autonomy.nullable().optional(), dependsOn: z.array(ref).nullable().optional() }),
  z.object({ op: z.literal('remove_milestone'), id: ref }),
  z.object({ op: z.literal('add_task'), milestone: ref, task, after: ref.optional() }),
  z.object({ op: z.literal('update_task'), id: ref, patch: task.partial() }),
  z.object({ op: z.literal('remove_task'), id: ref }),
  z.object({ op: z.literal('move_task'), id: ref, milestone: ref, before: ref.optional() }),
  z.object({ op: z.literal('block'), id: ref, by: ref, on: z.boolean() }),
]);

export const PLANS_API = {
  // A new plan with Claude: its own conversation (in the project's main folder) and its page → the plan.
  // `agent`: who works its milestones and tasks (BLG-497); none: your default. `planner` / `checker`: who plans it
  // and who checks it when not that agent (BLG-982). `fullAuto`: Full Autopilot, a stand-in answers for you (BLG-981).
  'plans.create': { args: z.tuple([z.object({ projectId: z.string().min(1).max(200), goal: z.string().min(1).max(8000), autonomy: autonomy.optional(), testsAt: z.enum(TESTS_AT).optional(), agent: AgentRef.optional(), planner: AgentRef.optional(), checker: AgentRef.optional(), fullAuto: z.boolean().optional() })]) },
  // Plan in this conversation (the composer's Plan with Tasks) → the plan.
  'plans.here': { args: z.tuple([z.string().min(1).max(200), autonomy.optional()]) },
  // The draft goes on the board (a new plan, or changes to one).
  'plans.approve': { args: z.tuple([id]) },
  // Throw the draft away (a plan never approved goes with it).
  'plans.discard': { args: z.tuple([id]) },
  // Verify a draft with a fresh agent (BLG-772), and approve it once it reads well (`thenApprove`) → the plan.
  // Fix sends what it found to the plan's agent.
  'plans.verify': { args: z.tuple([id, z.object({ thenApprove: z.boolean().optional() }).strict().optional()]) },
  'plans.fixReview': { args: z.tuple([id]) },
  'plans.edit': { args: z.tuple([id, z.array(PlanOpSchema).min(1).max(40)]) },
  // The plan's autonomy, or one milestone's.
  'plans.setAutonomy': { args: z.tuple([id, autonomy, ref.optional()]) },
  'plans.setPaused': { args: z.tuple([id, z.boolean()]) },
  'plans.setParallel': { args: z.tuple([id, z.number().int().min(1).max(MAX_PARALLEL)]) },
  // When the e2e and full suites run: once per milestone (at its check), or only in the final step.
  'plans.setTestsAt': { args: z.tuple([id, z.enum(TESTS_AT)]) },
  // Who works the plan's milestones and tasks from here on (BLG-498): an agent, or null for your default.
  // Milestones and tasks already at work keep theirs → what happened, in words.
  'plans.setWorkAgent': { args: z.tuple([id, AgentRef.nullish()]) },
  // Who plays a part of the plan (BLG-982): planner, builder (= setWorkAgent) or checker; null: back to the builder's → in words.
  'plans.setRoleAgent': { args: z.tuple([id, z.enum(PLAN_ROLES), AgentRef.nullish()]) },
  // Full Autopilot on or off (BLG-981): on, Autopilot and a stand-in agent answers what would wait on you → the plan.
  'plans.setFullAuto': { args: z.tuple([id, z.boolean()]) },
  'plans.tidyUp': { args: z.tuple([id, z.boolean()]) },
  // Pass a milestone (the next one opens), or send it back to the head Claude with what's missing.
  'plans.pass': { args: z.tuple([id, ref]) },
  // Ask the plan's Claude to check a milestone again.
  'plans.recheck': { args: z.tuple([id, ref]) },
  'plans.sendBack': { args: z.tuple([id, ref, z.string().min(1).max(4000)]) },
  // The plan's one pull request (plan/<slug> → main), merging it on GitHub, or merging the branch into main here → the plan.
  'plans.openPr': { args: z.tuple([id]) },
  // auto: GitHub merges it once its checks and reviews pass.
  'plans.mergePr': { args: z.tuple([id, z.object({ auto: z.boolean().optional() }).strict().optional()]) },
  'plans.mergeLocal': { args: z.tuple([id]) },
  // Its pull request conflicts with main: main merged into the plan's branch, a conflict fixed by the plan's Claude.
  'plans.bringInMain': { args: z.tuple([id]) },
  // A conflict Claude couldn't fix: ask it again; or show the folder it waits in (Finder).
  'plans.retryConflicts': { args: z.tuple([id]) },
  'plans.showConflict': { args: z.tuple([id]) },
  // Start a ready task now → what happened. `agent` (Start with…, BLG-506): who works it this once,
  // instead of the task's own agent or the plan's (a milestone already at work keeps its agent).
  'plans.startTask': { args: z.tuple([id, ref, AgentRef.optional()]) },
  // Wake a started task whose Claude stopped without finishing (it waits for you) → what happened.
  'plans.resumeTask': { args: z.tuple([id, ref]) },
  'plans.remove': { args: z.tuple([id]) },
  // Your planning style (how you like plans cut), added to Claude's planning instructions.
  'plans.setStyle': { args: z.tuple([z.string().max(8000)]) },
  // Move To another computer (BLG-806), as your app runs it (src/machines/move-plan.ts). Here: whether it
  // can move now → { blocked?, running, dirty, paused, project }.
  'plans.moveCheck': { args: z.tuple([id]) },
  // Packed to go (changes not committed in its worktrees committed only with commit) → { token, chunks }.
  'plans.movePack': { args: z.tuple([id, z.object({ commit: z.boolean().optional(), to: z.string().min(1).max(80) }).strict()]) },
  // One piece of a packed plan (the last one lets it go here).
  'plans.moveChunk': { args: z.tuple([z.string().uuid(), z.number().int().min(0).max(200)]) },
  // There: one piece of it coming in (its number, how many in all, the piece).
  'plans.moveReceive': { args: z.tuple([z.string().uuid(), z.number().int().min(0).max(200), z.number().int().min(1).max(201), z.string().max(2 * 1024 * 1024)]) },
  // There: every piece is in, landed in that project, paused → the plan (or nothing is left there).
  'plans.moveLand': { args: z.tuple([z.string().uuid(), z.string().min(1).max(200), move]) },
  // Here: the copy runs there; this one becomes its record (its tasks archived, its conversations put away) → the plan.
  'plans.moveDone': { args: z.tuple([id, move.extend({ planId: id.optional() }).strict()]) },
  // There: a landed copy whose move didn't finish, taken back off.
  'plans.moveUndo': { args: z.tuple([id]) },
} as const;
