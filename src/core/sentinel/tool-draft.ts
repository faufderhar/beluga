import { z } from 'zod';
import { ACCESS, BELUGA_EVENTS, GITHUB_EVENTS, KEEP_CHATS, NOTIFY_WHERE, SENTRY_EVENTS, STRIPE_EVENTS } from './model.js';
import { SOURCE_KINDS } from '../../shared/view-spec.js';
import { LimitsSchema, MetricSpecSchema, ScheduleTriggerSchema } from './schema.js';
import { ASSISTANT_TITLE } from '../../shared/assistant.js';

/**
 * What Claude's sentinel_create and sentinel_update take (agent/sentinel-tools.ts): a sentinel in
 * the shapes this Beluga runs (a schedule, by hand, after another sentinel, or an event; every step kind),
 * its project by name. Browser-safe: zod only.
 *
 * Every part must turn into JSON Schema: a tool whose input can't (a preprocess, a transform, a
 * z.custom) is dropped from Claude's tools without a word. So the measure step's source and units
 * are plain here; StepInputSchema checks them for real when the step is made (sentinels.ts toolStep).
 */

// A view source as Claude gives it; SourceSchema reads it (a bare command, a kind left out) when the step is made.
const TOOL_SOURCE = z.union([z.string().min(1).max(8000), z.looseObject({ kind: z.enum(SOURCE_KINDS).optional() })]);
const TOOL_METRIC = MetricSpecSchema.extend({ unit: z.string().regex(/^(count|percent|ms|bytes|plain|currency:[A-Za-z]{3})$/).optional() });

const stepId = z.string().max(40).optional().describe('Keep a step’s id (from sentinel_get) when you keep or edit that step');
const stepName = z.string().max(80);

const TOOL_TRIGGER = z
  .discriminatedUnion('kind', [
    ScheduleTriggerSchema.describe('every: hours (with hours: 1|2|3|6|12), day, other-day, week (with days: 0 Sunday…6 Saturday), month (with day: 1…28); at: "HH:MM" local time'),
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('after'), sentinelId: z.string().min(1).max(80).describe('The other sentinel’s id (sentinel_list)'), on: z.enum(['success', 'failure', 'always']) }),
    z.object({ kind: z.literal('beluga'), what: z.enum(BELUGA_EVENTS), projectId: z.string().max(80).optional() }).describe('Something in Beluga happened'),
    z.object({ kind: z.literal('github'), what: z.enum(GITHUB_EVENTS), label: z.string().max(64).optional().describe('For issue-labelled'), minutes: z.number().int().min(1).max(60).optional().describe('How often GitHub is asked (2 by default)') }).describe('The project’s GitHub repository'),
    z.object({ kind: z.literal('stripe'), what: z.enum(STRIPE_EVENTS) }).describe('The project’s Stripe account (connected in Earnings)'),
    z.object({ kind: z.literal('uptime'), url: z.string().url().max(2000), minutes: z.union([z.literal(1), z.literal(5), z.literal(15)]), expect: z.number().int().min(100).max(599).optional() }).describe('Fires when the URL stops answering, and when it is back'),
    z.object({ kind: z.literal('sentry'), org: z.string().min(1).max(100), project: z.string().min(1).max(100), what: z.enum(SENTRY_EVENTS) }).describe('Needs $SENTRY_TOKEN in Settings › Environment'),
    z.object({ kind: z.literal('webhook'), signature: z.enum(['github', 'stripe']).optional() }).describe('Something posts to its URL (shown on the sentinel’s page)'),
  ])
  .describe('When it runs');

const TOOL_STEP = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), id: stepId, name: stepName, prompt: z.string().min(1).max(20_000).describe('What the agent does each run; may use {{date}}, {{project}}, {{tasks}}, {{previous}}'), where: z.enum(['project', 'worktree', 'mac']).describe('project: reads only (briefs, triage); worktree: changes code; mac: about the Mac itself'), runtime: z.string().regex(/^[a-z][\w-]{0,31}$/).optional().describe('The agent that does it: "claude", "codex", "opencode" or "copilot" (leave out: the user’s default agent)'), model: z.string().max(80).optional().describe('Its model (leave out: the agent’s default)'), effort: z.string().max(20).optional().describe('Its thinking effort (low, medium, high…; leave out: Settings’ effort)') }),
  z.object({ kind: z.literal('script'), id: stepId, name: stepName, command: z.string().min(1).max(4000), cwd: z.enum(['project', 'home']).optional(), timeoutSec: z.number().int().min(1).max(3600).optional() }),
  z.object({ kind: z.literal('notify'), id: stepId, name: stepName, title: z.string().max(200).optional(), body: z.string().max(4000).optional(), phone: z.boolean().optional() }),
  z.object({
    kind: z.literal('http'),
    id: stepId,
    name: stepName,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    url: z.string().max(2000).describe('May be $VAR (Settings › Environment), like $SLACK_WEBHOOK_URL'),
    headers: z.record(z.string().max(200), z.string().max(4000)).optional().describe('Secrets only as $VAR: "Bearer $GROQBOT_KEY"'),
    body: z.string().max(60_000).optional(),
    timeoutSec: z.number().int().min(1).max(600).optional(),
    preset: z.enum(['groqbot', 'slack', 'discord', 'url']).optional(),
  }),
  z.object({ kind: z.literal('pr'), id: stepId, name: stepName, draft: z.boolean().optional() }).describe('Opens a pull request from the worktree an earlier agent step (where: worktree) made; needs work access'),
  z.object({ kind: z.literal('merge'), id: stepId, name: stepName, require: z.object({ checks: z.literal(true), approval: z.boolean() }).optional(), method: z.enum(['squash', 'merge']).optional() }).describe('Merges that pull request once the checks pass, a review says ship and the user approves; needs ship access'),
  z.object({ kind: z.literal('message'), id: stepId, name: stepName, to: z.string().regex(/^(dm|group):[\w-]{1,80}$/).describe('dm:<peerId> or group:<id>'), text: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal('friend'), id: stepId, name: stepName, peerId: z.string().min(1).max(80), prompt: z.string().min(1).max(20_000), project: z.string().max(200).optional() }),
  z.object({ kind: z.literal('trigger'), id: stepId, name: stepName, sentinelId: z.string().min(1).max(80) }),
  z
    .object({
      kind: z.literal('measure'),
      id: stepId,
      name: stepName,
      from: z.enum(['previous', 'source', 'claude']).describe('previous: the step before’s output (a number, JSON, CSV, "name: value" lines); source: a view source run here (sqlite, postgres, http, command); claude: what the agent step before kept with sentinel_measure'),
      source: TOOL_SOURCE.optional().describe('For from: source, the same JSON a view’s source takes; secrets only as $VAR'),
      metrics: z.array(TOOL_METRIC).max(40).optional().describe('Each: name (subscribers), label, pick (a JSON path like $.items[0].statistics.subscriberCount, or a column), unit (count, currency:USD, percent, ms, bytes, plain), better (up, down, none), kind (number, or rows for a table). None: every top-level number'),
      keep: z.number().int().min(1).max(200).optional().describe('Rows kept per run for a rows metric (200)'),
    })
    .describe('Keep the numbers: they show on the sentinel’s page and dashboards, compared with the past'),
]);

export const TOOL_DRAFT_SHAPE = {
  name: z.string().trim().min(1).max(80).describe('A short name, like "Morning brief"'),
  project: z.string().max(200).optional().describe(`The project’s name; leave out for ${ASSISTANT_TITLE}`),
  trigger: TOOL_TRIGGER,
  steps: z.array(TOOL_STEP).min(1).max(12),
  access: z.enum(ACCESS).optional().describe('look (default): read and report; work: change code in a worktree and open pull requests; ship: also merge after checks and approval'),
  notify: z.enum(NOTIFY_WHERE).optional().describe('Where the run’s end is told (mac by default)'),
  keepChats: z.enum(KEEP_CHATS).optional().describe('Which runs’ agent conversations it keeps: all (default), failed (only failed or stopped runs’: right for frequent sentinels the user only checks when something breaks), latest (only the newest run’s). The rest are put away when a run ends; reports and outputs stay on each run'),
};

export const ToolDraftSchema = z.object(TOOL_DRAFT_SHAPE);
export type ToolDraft = z.infer<typeof ToolDraftSchema>;
export type ToolStep = z.infer<typeof TOOL_STEP>;

/** sentinel_update: only what changes. Steps are the whole new list, in order. */
export const TOOL_PATCH_SHAPE = {
  name: TOOL_DRAFT_SHAPE.name.optional(),
  project: z.string().max(200).nullable().optional().describe(`The project’s name; null for ${ASSISTANT_TITLE}`),
  trigger: TOOL_TRIGGER.optional(),
  steps: z.array(TOOL_STEP).max(12).optional().describe('The whole list of steps, in order (keep the ids of the ones you keep)'),
  access: TOOL_DRAFT_SHAPE.access,
  limits: LimitsSchema.partial().optional().describe('minutes per run, perDay (0: no limit), pauseAfter failures in a row (0: never)'),
  notify: TOOL_DRAFT_SHAPE.notify,
  keepChats: TOOL_DRAFT_SHAPE.keepChats,
};

export const ToolPatchSchema = z.object(TOOL_PATCH_SHAPE);
export type ToolPatch = z.infer<typeof ToolPatchSchema>;
