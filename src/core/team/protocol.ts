import { z } from 'zod';
import { ISSUE_STATUSES, MAX_PROJECT_CONTEXT } from '../board/model.js';
import { AgentRef } from '../../protocol.js';

/**
 * What teammates' Macs say inside the mesh's `team` frame (a Noise link between two friends; see
 * docs/tasks-and-plans.md, "Sharing with friends — phase 3"). Each message rides in a frame
 * `{f, m}` the other side acknowledges (`{ack}`), through the same courier as sharing's.
 *
 * Finding each other:
 * - `repos`: fingerprints of your GitHub projects, keyed for this one friend (fingerprint.ts), so
 *   a friend who doesn't have a repository learns nothing about it.
 * - `invite`: you said yes to teaming up on the repository with that fingerprint (`link`: the id
 *   the two of you will use for it; `project`: your project's name, for their Claude's requests).
 * - `accept`: you said yes to their invite: the team is formed. `decline`: not now. `leave`: you left.
 *
 * The board (board-sync.ts, BLG-222):
 * - `ops`: tasks as the team has them, or only what changed: each field with who set it and when
 *   (`l` Lamport time, `a` author peer id; the later one wins, by l then a), activity to add
 *   (append-only; `drop`: lines its author took back when it folded two quick changes into one),
 *   and how it was born (the first time). A snapshot is the same message with everything.
 * - `digest`: a hash of every field's clock, sent when a link comes up; a different one gets a snapshot.
 *
 * Plans you choose to share (plan-share.ts, BLG-225):
 * - `plan`: a plan's draft (or what was approved) as its owner has it now, with everyone's reviews;
 *   the newest replaces one still waiting. `plan_gone`: no longer shared (or deleted).
 * - `review`: a teammate's comment, approval or suggested changes (the plan's own edit ops).
 *
 * The project's context (context-share.ts, BLG-298):
 * - `context`: About This Project as the sender has it (`by`: who wrote it, `at`: when); the
 *   newest wins on every Mac, and the newest replaces one still waiting.
 *
 * Knocking on a teammate's worktree (knock.ts, BLG-416):
 * - `knock`: you'd like to join the worktree doing this task (`note`: a few words with it).
 * - `knock_answer`: let in as `view` or `contribute` (`ws`: the worktree, shared the friend-share
 *   way), `decline` (not now), or `gone` (no worktree does it any more).
 * - `knock_cancel`: you took your knock back.
 */

export const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
export const linkId = z.string().regex(/^[\w-]{8,40}$/);
const name = z.string().max(200);

export const peerId = z.string().regex(/^[\w-]{32}$/);
const words = (max: number) => z.string().max(max);
export const ActorSchema = z.union([
  z.object({ kind: z.literal('person'), id: peerId, name: words(80) }),
  // BLG-498: which agent (an older Mac leaves it out: Claude; a bad one is dropped, not the line).
  z.object({ kind: z.literal('claude'), owner: peerId, ownerName: words(80), agent: AgentRef.optional().catch(undefined), external: z.object({ id: words(80), name: words(80) }).optional().catch(undefined), for: z.object({ id: peerId, name: words(64) }).optional().catch(undefined) }),
  z.object({ kind: z.literal('beluga') }),
]);
export const AssigneeSchema = z.union([z.object({ kind: z.literal('person'), id: peerId, name: words(80) }), z.object({ kind: z.literal('claude'), owner: peerId, ownerName: words(80) })]);
const ACT_KINDS = ['created', 'title', 'status', 'priority', 'assignee', 'labels', 'estimate', 'due', 'parent', 'relation', 'brief', 'comment', 'note', 'worktree', 'pr', 'proof', 'project', 'plan', 'link'] as const;
export const ActivitySchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  at: z.number().int().min(0),
  by: ActorSchema,
  kind: z.enum(ACT_KINDS),
  text: words(2000),
  body: words(8000).optional(),
  assignee: AssigneeSchema.nullable().optional(),
  was: words(400).optional(),
  now: words(400).optional(),
});
export const taskId = z.string().regex(/^[\w-]{1,40}$/);
export const knockId = z.string().regex(/^[\w-]{8,40}$/);
export const FieldSchema = z.object({ v: z.unknown(), l: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), a: peerId });
export const TaskDelta = z.object({
  id: taskId,
  fields: z.record(z.string().regex(/^[\w.-]{1,60}$/), FieldSchema),
  acts: z.array(ActivitySchema).max(200),
  drop: z.array(z.string().max(40)).max(200).optional(),
  born: z.object({ at: z.number().int().min(0), by: ActorSchema, origin: z.enum(['manual', 'worktree', 'claude', 'plan', 'sync', 'github']) }).optional(),
});
export type TaskDelta = z.infer<typeof TaskDelta>;

/** What each synced field may hold (anything else is ignored). `null` is "none". */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(taskId).max(100);
export const FIELD_VALUES: Readonly<Record<string, z.ZodType>> = {
  title: z.string().min(1).max(200),
  status: z.enum(ISSUE_STATUSES),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  labels: z.array(z.string().max(32)).max(12),
  estimate: z.number().int().min(1).max(100).nullable(),
  due: day.nullable(),
  assignee: AssigneeSchema.nullable(),
  parent: taskId.nullable(),
  blockedBy: ids,
  related: ids,
  github: z.object({ repo: z.string().max(200), host: z.string().max(200).optional(), number: z.number().int().positive(), url: z.string().max(500), step: z.enum(['investigate', 'fix']).optional(), investigated: z.boolean().optional() }).nullable(),
  deleted: z.boolean(),
};
/** A field's value checker: the fixed ones, a brief section, or someone working on it (their Claude running there: additive, BLG-278). */
export function fieldValue(name: string): z.ZodType | undefined {
  if (FIELD_VALUES[name]) return FIELD_VALUES[name];
  if (/^brief\.(goal|context|acceptance|decisions|questions|handoff)$/.test(name)) return z.string().max(20_000);
  if (/^(working|running)\.[\w-]{32}$/.test(name)) return z.literal(true).nullable();
  return undefined;
}

const PlanTaskSchema = z
  .object({ id: z.string().max(60), title: words(200), goal: words(4000).optional(), context: words(8000).optional(), acceptance: z.array(words(400)).max(20), blockedBy: z.array(z.string().max(60)).max(40), parent: z.string().max(60).optional(), touches: z.array(words(200)).max(20).optional(), assignee: z.enum(['claude', 'me']).optional(), estimate: z.number().optional(), priority: z.string().max(20).optional(), labels: z.array(words(32)).max(12).optional(), issueId: z.string().max(40).optional() })
  .passthrough();
export const PlanBodySchema = z.object({
  title: words(200),
  goal: words(8000),
  milestones: z.array(z.object({ id: z.string().max(60), title: words(200), goal: words(4000).optional(), criteria: z.array(words(400)).max(40), tasks: z.array(PlanTaskSchema), dependsOn: z.array(z.string().max(60)).optional() }).passthrough()),
});
export const ReviewSchema = z.object({
  id: z.string().regex(/^[\w-]{8,40}$/),
  by: peerId,
  name: words(80),
  kind: z.enum(['comment', 'approve', 'suggest']),
  text: words(8000).optional(),
  ops: z.array(z.unknown()).max(40).optional(),
  rev: z.number().int().min(0),
  at: z.number().int().min(0),
  settled: z.enum(['applied', 'dismissed']).optional(),
});
export const SharedPlanSchema = z.object({ id: z.string().regex(/^[\w-]{1,60}$/), title: words(200), body: PlanBodySchema, rev: z.number().int().min(0), status: z.enum(['draft', 'active', 'done']), reviews: z.array(ReviewSchema).max(200) });

export const TeamMsg = z.discriminatedUnion('k', [
  z.object({ k: z.literal('repos'), prints: z.array(hex32).max(500) }),
  // `team`: who's on it already, by name (BLG-510: you're asked onto a group, not a pair).
  z.object({ k: z.literal('invite'), print: hex32, link: linkId, project: name, team: z.array(words(80)).max(50).optional() }),
  z.object({ k: z.literal('accept'), print: hex32, link: linkId, project: name }),
  z.object({ k: z.literal('decline'), print: hex32 }),
  // `all`: they left the whole team, not only the two of you (BLG-510).
  z.object({ k: z.literal('leave'), link: linkId, all: z.literal(true).optional() }),
  // A friend request to someone on the team who isn't your friend (BLG-510), passed on by teammates
  // until it reaches them: a one-time invitation only they can use (`invite`), so it pairs with them alone.
  z.object({ k: z.literal('befriend'), link: linkId, id: z.string().regex(/^[\w-]{8,40}$/), from: peerId, to: peerId, name: words(80), invite: z.string().min(1).max(4000), expiresAt: z.number().int().min(0) }),
  // Who's on the team, as this Mac knows it (BLG-510): each line last-writer-wins on `at`.
  z.object({ k: z.literal('roster'), link: linkId, members: z.array(z.object({ peerId, name: words(80), since: z.number().int().min(0), on: z.boolean(), at: z.number().int().min(0) })).max(200) }),
  z.object({ k: z.literal('ops'), link: linkId, tasks: z.array(TaskDelta).max(50) }),
  z.object({ k: z.literal('digest'), link: linkId, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ k: z.literal('plan'), link: linkId, plan: SharedPlanSchema }),
  z.object({ k: z.literal('plan_gone'), link: linkId, id: z.string().max(60) }),
  z.object({ k: z.literal('context'), link: linkId, text: words(MAX_PROJECT_CONTEXT), by: words(80), at: z.number().int().min(0) }),
  z.object({ k: z.literal('review'), link: linkId, plan: z.string().max(60), review: ReviewSchema.omit({ by: true, name: true, settled: true }) }),
  z.object({ k: z.literal('knock'), link: linkId, id: knockId, task: taskId, note: words(500).optional() }),
  z.object({ k: z.literal('knock_answer'), link: linkId, id: knockId, answer: z.enum(['view', 'contribute', 'decline', 'gone']), ws: z.string().regex(/^[\w:.-]{1,80}$/).optional() }),
  z.object({ k: z.literal('knock_cancel'), link: linkId, id: knockId }),
]);
export type TeamMsg = z.infer<typeof TeamMsg>;

const frameId = z.string().regex(/^[\w-]{8,40}$/);
export const TeamFrame = z.union([z.object({ f: frameId, m: TeamMsg }), z.object({ ack: frameId })]);
export type TeamFrame = z.infer<typeof TeamFrame>;

export function parseTeamFrame(raw: unknown): TeamFrame | undefined {
  const parsed = TeamFrame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
