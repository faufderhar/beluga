import { z } from 'zod';
import { SourceSchema } from '../../shared/view-spec.js';
import { CHART_TILE_KINDS, LEGACY_TILE_KINDS, OUTPUT_SHOWS, TILE_KINDS } from './dashboard-model.js';
import { COLUMN_ENCODINGS, COLUMN_KINDS, FILES_KEEP_MAX } from './columns.js';
import { COMPARE } from './metrics.js';
import { ACCESS, BELUGA_EVENTS, KEEP_CHATS, BETTER, SCRIPT_CODE_MAX, SCRIPT_LANGUAGES, GITHUB_EVENTS, MEASURE_FROM, METRIC_KINDS, NOTIFY_WHERE, ROWS_KEPT, SCHEDULE_EVERY, SENTRY_EVENTS, STRIPE_EVENTS } from './model.js';

/**
 * Sentinels as zod checks: what the API takes (sentinel-api.ts), what sentinel.json holds, and
 * what Claude's sentinel_create sends. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);
const text = (max: number) => z.string().max(max);
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 07:00');

export const ScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  every: z.enum(SCHEDULE_EVERY),
  at: HHMM.default('07:00'),
  hours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]).optional(),
  minutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  day: z.number().int().min(1).max(28).optional(),
  missed: z.enum(['catch-up', 'skip']).default('catch-up'),
});

export const TriggerSchema = z.discriminatedUnion('kind', [
  ScheduleTriggerSchema,
  z.object({ kind: z.literal('manual') }),
  // Its sentinel may be picked later (empty: a run says to pick one).
  z.object({ kind: z.literal('after'), sentinelId: z.string().max(80), on: z.enum(['success', 'failure', 'always']).default('failure') }),
  z.object({ kind: z.literal('beluga'), what: z.enum(BELUGA_EVENTS), projectId: id.optional() }),
  z.object({ kind: z.literal('github'), what: z.enum(GITHUB_EVENTS), label: text(64).optional(), minutes: z.number().int().min(1).max(60).optional() }),
  z.object({ kind: z.literal('stripe'), what: z.enum(STRIPE_EVENTS) }),
  z.object({ kind: z.literal('uptime'), url: z.string().url().max(2000), minutes: z.union([z.literal(1), z.literal(5), z.literal(15)]), expect: z.number().int().min(100).max(599).optional() }),
  // Its organization and project may be filled in later (empty: the page says to).
  z.object({ kind: z.literal('sentry'), org: text(100), project: text(100), what: z.enum(SENTRY_EVENTS) }),
  z.object({ kind: z.literal('webhook'), signature: z.enum(['github', 'stripe']).optional() }),
]);

const stepId = z.string().min(1).max(40).optional();
const stepName = z.string().max(80).optional();

/** A metric's unit: count, percent, ms, bytes, plain, or currency:<ISO code>. */
export const MetricUnitSchema = z.union([z.enum(['count', 'percent', 'ms', 'bytes', 'plain']), z.custom<`currency:${string}`>((v) => typeof v === 'string' && /^currency:[A-Za-z]{3}$/.test(v), 'A currency like currency:USD')]);
export const MetricNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'A name like subscribers or failed-payments');

/** A typed column of a rows metric (columns.ts): a document, a storage object, a link or a path. */
export const MetricColumnSchema = z.object({
  key: z.string().min(1).max(80),
  type: z.enum(COLUMN_KINDS),
  label: z.string().max(80).optional(),
  name: z.string().max(200).optional(),
  bucket: z.string().max(100).optional(),
  path: z.string().max(80).optional(),
  encoding: z.enum(COLUMN_ENCODINGS).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  decimals: z.number().int().min(0).max(8).optional(),
  max: z.number().positive().max(1_000_000).optional(),
  better: z.enum(BETTER).optional(),
  sentinel: z.string().max(80).optional(),
  button: z.string().max(40).optional(),
});

/** One number (or a series, rows, or an output) a Keep the numbers step keeps. */
export const MetricSpecSchema = z.object({
  name: MetricNameSchema,
  label: z.string().max(80).optional(),
  pick: z.string().max(400).optional(),
  unit: MetricUnitSchema.optional(),
  better: z.enum(BETTER).optional(),
  kind: z.enum(METRIC_KINDS).optional(),
  // A series of rows: the label column and the value column.
  x: z.string().max(80).optional(),
  y: z.string().max(80).optional(),
  columns: z.array(MetricColumnSchema).max(20).optional(),
});

/** A step as given: ids and names are filled in when missing. */
export const StepInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), id: stepId, name: stepName, prompt: text(20_000), where: z.enum(['project', 'worktree', 'mac']).default('project'), runtime: z.string().regex(/^[a-z][\w-]{0,31}$/).optional(), model: text(80).optional(), effort: text(20).optional() }),
  // Empty until it's filled in (a new step from Add a Step): a run says so.
  z.object({ kind: z.literal('script'), id: stepId, name: stepName, command: text(4000).default(''), code: text(SCRIPT_CODE_MAX).optional(), language: z.enum(SCRIPT_LANGUAGES).optional(), cwd: z.enum(['project', 'home']).default('project'), timeoutSec: z.number().int().min(1).max(3600).default(120) }),
  z.object({ kind: z.literal('notify'), id: stepId, name: stepName, title: text(200).optional(), body: text(4000).optional(), phone: z.boolean().default(false) }),
  z.object({
    kind: z.literal('http'),
    id: stepId,
    name: stepName,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    // Empty until it's filled in (the Groqbot preset's address): a run says so.
    url: text(2000),
    headers: z.record(z.string().max(200), z.string().max(4000)).default({}),
    body: text(60_000).optional(),
    timeoutSec: z.number().int().min(1).max(600).default(30),
    preset: z.enum(['groqbot', 'slack', 'discord', 'url']).optional(),
  }),
  z.object({ kind: z.literal('pr'), id: stepId, name: stepName, draft: z.boolean().optional() }),
  z.object({ kind: z.literal('merge'), id: stepId, name: stepName, require: z.object({ checks: z.literal(true).default(true), approval: z.boolean().default(true) }).default({ checks: true, approval: true }), method: z.enum(['squash', 'merge']).default('squash') }),
  // Who it messages, asks or runs may be picked later (empty: a run says to pick one).
  z.object({ kind: z.literal('message'), id: stepId, name: stepName, to: z.string().regex(/^((dm|group):[\w-]{1,80})?$/, 'A chat: dm:<peer> or group:<id>').default(''), text: text(8000).default('') }),
  z.object({ kind: z.literal('friend'), id: stepId, name: stepName, peerId: z.string().max(80).default(''), prompt: text(20_000).default(''), project: text(200).optional() }),
  z.object({ kind: z.literal('trigger'), id: stepId, name: stepName, sentinelId: z.string().max(80).default('') }),
  // Its source may be filled in later (none: a run says to pick one).
  z.object({ kind: z.literal('measure'), id: stepId, name: stepName, from: z.enum(MEASURE_FROM).default('previous'), source: SourceSchema.optional(), metrics: z.array(MetricSpecSchema).max(40).default([]), keep: z.number().int().min(1).max(ROWS_KEPT).optional(), filesKeepDays: z.number().int().min(1).max(FILES_KEEP_MAX).optional() }),
]);

export const LimitsSchema = z.object({
  minutes: z.number().int().min(1).max(240),
  // 0: no limit (how the page turns a limit off again: a patch can't send undefined).
  perDay: z.number().int().min(0).max(500).optional(),
  pauseAfter: z.number().int().min(0).max(50),
});

export const SentinelDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().min(1).max(40).optional(),
  projectId: id.nullable().optional(),
  trigger: TriggerSchema.optional(),
  steps: z.array(StepInputSchema).max(20).optional(),
  access: z.enum(ACCESS).optional(),
  limits: LimitsSchema.partial().optional(),
  keepChats: z.enum(KEEP_CHATS).optional(),
  notify: z.enum(NOTIFY_WHERE).optional(),
  recipe: z.string().min(1).max(40).optional(),
});

export const SentinelPatchSchema = SentinelDraftSchema.omit({ recipe: true }).partial();

/** A sentinel as saved in sentinel.json: checked (it's our own file), the rest kept as it is. */
export const SavedSentinelSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    icon: z.string().default('eye'),
    projectId: id.optional(),
    trigger: TriggerSchema,
    steps: z.array(StepInputSchema.and(z.object({ id: z.string().min(1), name: z.string() }))).default([]),
    access: z.enum(ACCESS).default('look'),
    limits: LimitsSchema.default({ minutes: 30, pauseAfter: 3 }),
    keepChats: z.enum(KEEP_CHATS).optional().catch(undefined),
    notify: z.enum(NOTIFY_WHERE).default('mac'),
    paused: z.boolean().default(true),
    pausedWhy: z.string().optional(),
    failures: z.number().int().min(0).default(0),
    lastScheduledAt: z.number().optional(),
    recipe: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();

/** A run in the index: loosely checked. */
export const SavedRunSchema = z
  .object({
    id,
    sentinelId: id,
    by: z.string(),
    trigger: z.object({ kind: z.string(), summary: z.string() }).passthrough(),
    state: z.enum(['queued', 'running', 'needs-you', 'done', 'skipped', 'failed', 'stopped']),
    startedAt: z.number(),
    headline: z.string().default(''),
    steps: z.array(z.object({ id: z.string(), state: z.string() }).passthrough()).default([]),
    tasks: z.array(z.string()).default([]),
  })
  .passthrough();

export const SentinelFileSchema = z.object({
  version: z.literal(1),
  runAtOnce: z.number().int().min(1).max(6).default(2),
  items: z.array(z.unknown()).default([]),
  runs: z.array(z.unknown()).default([]),
  // What each event sentinel saw last (GitHub's newest ids, the uptime's up or down…): one that
  // doesn't read starts again from now, never takes the file with it.
  cursors: z.record(z.string(), z.unknown()).default({}).catch({}),
  // Webhook sentinels' secrets (32 bytes, hex): in the file only, never in the state.
  secrets: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).default({}).catch({}),
  // The secrets GitHub signs a webhook sentinel's posts with (its form's Secret): the same, apart from the URL's.
  signingSecrets: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).default({}).catch({}),
});

// ---------------------------------------------------------------- dashboards (§10)

const MetricRefSchema = z.object({ sentinelId: id, metric: MetricNameSchema });
const StepRefSchema = z.object({ sentinelId: id, stepId: z.string().min(1).max(40) });

/** A tile's kind: one of TILE_KINDS, or an older name for one (`chart` is a series tile now). */
export const TileKindSchema = z.preprocess((v) => (typeof v === 'string' && LEGACY_TILE_KINDS[v] ? LEGACY_TILE_KINDS[v] : v), z.enum(TILE_KINDS));
export const TileWidthSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6)]);

/** A tile as given (Add a Tile, Claude's dashboard_add_tile): its id is made when missing. */
export const TileInputSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  kind: TileKindSchema,
  width: TileWidthSchema.optional(),
  height: z.union([z.literal(1), z.literal(2)]).optional(),
  // Where it was put on the grid (both or neither): none, it flows in order.
  col: z.number().int().min(0).max(5).optional(),
  row: z.number().int().min(0).max(1000).optional(),
  title: z.string().max(80).optional(),
  metric: MetricRefSchema.optional(),
  metrics: z.array(MetricRefSchema).max(8).optional(),
  chart: z.enum(CHART_TILE_KINDS).optional(),
  step: StepRefSchema.optional(),
  show: z.enum(OUTPUT_SHOWS).optional(),
  sentinelId: id.optional(),
  text: z.enum(['headline', 'report']).optional(),
  compare: z.enum(COMPARE).optional(),
  // A table's own columns (BLG-347): in order, renamed or hidden.
  columns: z.array(z.object({ key: z.string().min(1).max(80), label: z.string().max(80).optional(), hidden: z.boolean().optional() })).max(40).optional(),
});

/** A tile's change: anything but its id and kind (compare null: the dashboard's again). */
export const TilePatchSchema = TileInputSchema.omit({ id: true, kind: true }).extend({ compare: z.enum(COMPARE).nullable().optional() }).partial();

export const DashboardPatchSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), compare: z.enum(COMPARE).optional() });

export const SavedDashboardSchema = z
  .object({
    id,
    name: z.string().min(1).max(60),
    compare: z.enum(COMPARE).default('previous'),
    tiles: z.array(TileInputSchema.extend({ id: z.string().min(1).max(40), width: TileWidthSchema.default(1) })).default([]),
    auto: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();

/** ~/.beluga/dashboards.json: your dashboards, and whether the first was made for you already (so it isn't made again). */
export const DashboardFileSchema = z.object({
  version: z.literal(1),
  made: z.boolean().default(false),
  dashboards: z.array(z.unknown()).default([]),
});
