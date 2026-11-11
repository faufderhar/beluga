import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DashboardTools, SentinelTools, ToolTile } from '../../agent/types.js';
import { type Row, type Source, SourceSchema } from '../../shared/view-spec.js';
import type { NoticeEvent } from '../notify.js';
import type { Action, Store } from '../store.js';
import { filterIssues, isOpen } from '../board/model.js';
import { describeList } from '../board/prompt.js';
import { planTitle } from '../plans/model.js';
import { dueNow, nextRunAt } from './clock.js';
import type { AgentPlace } from '../../agent/types.js';
import { SentinelChats } from './chat.js';
import { type Dashboard, type MetricRef, OUTPUT_STEP_KINDS, type StepRef, TILE_INFO, dashboardSentinels, layoutTiles, outputFormat, outputSteps } from './dashboard-model.js';
import { Dashboards, type TileInput, type TilePatch } from './dashboards.js';
import { type DocumentRead, FILES_DIR, FILES_KEEP_DAYS, runFileMime, type MetricColumn, SIGNED_SECONDS, STORAGE_MAX, documentMime, isDocumentKind, safeFileName, sameRow, sizeWords, splitStorage, storageName, takeDocuments, typedWords, withStorage } from './columns.js';
import { RunFolders, SentinelFile, pruneRuns } from './files.js';
import { signStorageUrl } from './storage-sign.js';
import { MetricFiles } from './metric-files.js';
import { type ExportFormat, exportName, metricExport } from './data-export.js';
import { safeName } from '../../net/mesh/files.js';
import { type Measured, type MetricLine, COMPARE_WORDS, cellRows, describePoints, formatMetric, keptWords, labelOf, measureFrom, metricName, pointOf, readOutput, toNumber } from './metrics.js';
import { type SentinelTest, type SourcePreview, describePreviews, previewBroken, previewFailed, previewOf } from './preview.js';
import {
  type MeasureStep,
  type ScriptStep,
  APPROVAL_MS,
  CLAUDE_CHANGED,
  DEFAULT_LIMITS,
  KEEP_IN_STATE,
  MAX_RUN_AT_ONCE,
  OUTPUT_LINES_KEPT,
  STEP_OUTPUT_IN_STATE,
  type StepOutput,
  isSentinelChat,
  type DashboardRefresh,
  type Limits,
  type MetricKind,
  type MetricSeries,
  type MetricUnit,
  POINTS_IN_STATE,
  ROWS_KEPT,
  type Recipe,
  type Run,
  type RunBy,
  type RunDetail,
  type RunSummary,
  type RunTrigger,
  type Sentinel,
  type SentinelAsk,
  type SentinelDraft,
  type SentinelPatch,
  type SentinelState,
  type Step,
  type WebhookAddress,
  type WebhookState,
  type StepDraft,
  STEP_INFO,
  accessAllows,
  accessNeeded,
  ACCESS_INFO,
  capPayload,
  claudeWidened,
  firstLine,
  isLive,
  keepRuns,
  keepsChat,
  DEFAULT_KEEP_CHATS,
  RUN_STATES,
  lastRunOf,
  scheduleSentence,
  sentinelLabel,
  toSummary,
} from './model.js';
import { redactSecrets } from '../../shared/steps.js';
import { agentLabel, agentName } from '../../shared/agent-label.js';
import { defaultAgentOf } from '../../protocol.js';
import { dashboardAskBrief, describeSentinels, sentinelAskBrief, sentinelChatBrief, sentinelMaterial, sentinelNote } from './prompt.js';
import { RECIPES } from './recipes.js';
import { type ActiveRun, OUTPUT_KEPT, type SentinelChat, type SentinelClaude, type SentinelFriends, type SentinelGitHub, type SentinelPlaces, type SentinelShell, type SourceFetch, SentinelRunner, type YourAnswer, mergePinned, runSentinelShell } from './runner.js';
import { MetricUnitSchema, StepInputSchema } from './schema.js';
import type { ToolDraft, ToolPatch, ToolStep } from './tool-draft.js';
import { Triggers, isEventTrigger } from './triggers/index.js';
import type { TriggerDeps, TriggerEvent } from './triggers/types.js';
import { newSecret } from './triggers/webhook.js';
import { SentinelMover, type SentinelMovePort } from './move-work.js';

/**
 * Sentinels (docs/sentinel.md): the sentinels and their runs, kept in ~/.beluga/sentinel.json and
 * mirrored into the state; the clock that starts what's due; the queue (one run per sentinel at a
 * time, at most Run at Once Claude steps together); limits (time, runs per day, pausing after
 * failures); and Claude's tools. Yours only: friends' runs never see any of it.
 */

export interface SentinelsDeps {
  readonly store: Store;
  /** Where sentinel.json and the runs' folders live (~/.beluga); null: memory only. */
  readonly dir: string | null;
  readonly now?: () => number;
  readonly selfId: () => string;
  readonly claude?: SentinelClaude;
  readonly places?: SentinelPlaces;
  readonly shell?: SentinelShell;
  readonly envFor?: (cwd: string) => Record<string, string>;
  readonly notify: (e: NoticeEvent) => void;
  readonly home?: string;
  /** The schedules' time zone (none: the Mac's). */
  readonly tz?: string;
  /** How often the clock looks (30 s; 0: only when asked, the tests). */
  readonly tickMs?: number;
  /** The first look after start (10 s). */
  readonly firstTickMs?: number;
  readonly saveDelayMs?: number;
  /** How long a cancelled Claude request may take to end before its worktree is looked at (10 s). */
  readonly cancelGraceMs?: number;
  readonly fetch?: typeof fetch;
  readonly github?: SentinelGitHub;
  readonly chat?: SentinelChat;
  readonly friends?: SentinelFriends;
  /** How often pending checks are looked at again (15 s). */
  readonly pollMs?: number;
  /** How long a merge waits for your Merge (24 hours). */
  readonly approvalMs?: number;
  /**
   * The event triggers' sources (gh, fetch, Stripe keys, your variables, the tunnel). Without
   * them no event trigger watches (the tests that don't test them, a CLI without the app).
   */
  readonly triggers?: Omit<TriggerDeps, 'store' | 'selfId'>;
  /** Variables only Call a service steps get (the project's Earnings key as $STRIPE_EARNINGS_KEY). */
  readonly serviceEnv?: (projectId: string | undefined) => Record<string, string>;
  /** A view source run as you (Keep the numbers from a source): core/views/sources.ts fetchSource. */
  readonly fetchSource?: SourceFetch;
}

const TICK_MS = 30_000;
/** A chain of sentinels running each other (after, Run another sentinel) stops this long. */
const MAX_CHAIN = 8;
const FIRST_TICK_MS = 10_000;
/** A run over its runs per day says this. */
const OVER_DAY = 'Over its runs per day';
const MAX_SENTINELS = 200;
/** How long one source may take when it's checked or tested (it's a run's step otherwise). */
const CHECK_MS = 120_000;
/** A step that isn't a source's, in a test run, says this. */
export const NOT_IN_TEST = 'not run in a test: it runs when the sentinel is on, or on Run Now';
/** The runs that count toward runs per day. */
const COUNTS_PER_DAY: ReadonlySet<Run['state']> = new Set(['running', 'done', 'failed', 'stopped']);

const short = (prefix: string, bytes = 6): string => `${prefix}_${randomBytes(bytes).toString('hex')}`;
const startOfDay = (at: number): number => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export interface RunSentinel {
  readonly tools: SentinelTools;
  /** Dashboards and numbers (sentinel_measure inside a run). */
  readonly dashboard: DashboardTools;
  readonly brief: string;
  /** This conversation is a sentinel run's Claude step (it gets the task tools, even in a main folder). */
  readonly inRun: boolean;
}

export class Sentinels {
  private items: Sentinel[] = [];
  /** The index, oldest first. */
  private runs: RunSummary[] = [];
  private runAtOnce: number;
  private readonly file: SentinelFile;
  readonly folders: RunFolders;
  private readonly runner: SentinelRunner;
  private readonly now: () => number;
  /** "Your Claude", "your Codex": this Mac's agent, in a sentence. */
  private yourAgent(capital = true): string {
    return agentLabel(defaultAgentOf(this.deps.store.getState().self), undefined, true, { capital });
  }
  /** Runs going now, by sentinel. */
  private readonly active = new Map<string, ActiveRun>();
  /** A run waiting for its sentinel's run to end (one at most), by sentinel. */
  private readonly queued = new Map<string, RunSummary & { readonly payload?: unknown }>();
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly offs: Array<() => void> = [];
  private lastTick: number | undefined;
  private closed = false;
  /** Events that came while a run went and another waited: the history's note of them, by sentinel. */
  private readonly extra = new Map<string, { readonly runId: string; readonly n: number }>();
  /** Conversations where your Claude changes a sentinel (sentinel.ask), and which. */
  private readonly askChannels = new Map<string, string>();
  private asks: Record<string, SentinelAsk> = {};
  /** Sentinels whose ask is being set up (before its state says writing): a second one waits. */
  private readonly asking = new Set<string>();
  /** Runs Beluga was closed under that are being merged now (decide): one Merge at a time. */
  private readonly deciding = new Set<string>();
  /** What each event sentinel saw last (kept in the file). */
  private cursors: Record<string, unknown>;
  /** Webhook sentinels' secrets (in the file only, never in the state). */
  private secrets: Record<string, string>;
  /** The secrets GitHub signs their posts with (Copy Secret), apart from the URL's (in the file only). */
  private signingSecrets: Record<string, string>;
  private troubles: Record<string, string> = {};
  private webhook: WebhookState = { ready: false };
  private readonly triggers: Triggers | undefined;
  /** The numbers' files (~/.beluga/sentinel/metrics), and each metric as the state shows it. */
  private readonly metricFiles: MetricFiles;
  private metrics: Record<string, Record<string, MetricSeries>> = {};
  readonly dashboards: Dashboards;
  private refreshing: Record<string, DashboardRefresh> = {};
  /** Conversations where your Claude builds a dashboard (Describe it), and which. */
  private readonly dashboardChannels = new Map<string, string>();
  private dashboardAsks: Record<string, SentinelAsk> = {};
  /** Waiting for a run to end (a dashboard's Refresh), by run. */
  private readonly endWaiters = new Map<string, Array<() => void>>();
  /** The latest output of each step an output tile names, by sentinel, then step. */
  private outputs: Record<string, Record<string, StepOutput>> = {};
  /** The Sentinel chat's conversations (§12). */
  readonly chats: SentinelChats;
  /** Sentinels whose sources are being tested now (one test at a time each). */
  private readonly testing = new Set<string>();

  constructor(private readonly deps: SentinelsDeps) {
    this.now = deps.now ?? Date.now;
    this.file = new SentinelFile(deps.dir, this.now, deps.saveDelayMs ?? 300);
    this.folders = new RunFolders(deps.dir);
    const data = this.file.load();
    this.runAtOnce = data.runAtOnce;
    this.cursors = { ...data.cursors };
    this.secrets = { ...data.secrets };
    this.signingSecrets = { ...data.signingSecrets };
    const at = this.now();
    this.items = data.items.map((s) => (!s.paused && s.trigger.kind === 'schedule' && s.lastScheduledAt === undefined ? { ...s, lastScheduledAt: at } : s));
    // Runs that were going (or waiting their turn) when Beluga closed or crashed ended there; one
    // that waits for you (a merge) still does.
    this.runs = data.runs.map((r) => (r.state === 'running' || r.state === 'queued' ? { ...r, state: 'failed', why: 'Beluga closed while it ran', headline: 'Beluga closed while it ran', endedAt: r.endedAt ?? at, steps: r.steps.map((s) => (s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'skipped' as const } : s)) } : r));
    // A load that lost something (the file set aside, sentinels or runs that didn't read) sweeps
    // nothing: those runs' folders are kept for when the file is mended.
    if (!data.lossy) this.sweepFolders();
    // What didn't read is kept beside it now: sentinel.json is written again without it.
    else this.save();
    this.metricFiles = new MetricFiles(deps.dir, this.now);
    this.loadMetrics(!data.lossy);
    for (const item of this.items) this.sweepDocuments(item);
    this.dashboards = new Dashboards(deps.dir, this.now, (all) => {
      if (this.closed) return;
      deps.store.dispatch({ type: 'sentinel_dashboards', dashboards: all });
      // An output tile added (or the last one of a step removed): its step's latest output follows.
      this.syncOutputs();
    }, deps.saveDelayMs ?? 300);
    this.chats = new SentinelChats({ store: deps.store, dir: deps.dir, selfId: deps.selfId, now: this.now });
    this.syncOutputs(undefined, false);
    this.runner = new SentinelRunner({
      now: this.now,
      ...(deps.claude ? { claude: deps.claude } : {}),
      ...(deps.places ? { places: deps.places } : {}),
      shell: deps.shell ?? runSentinelShell,
      envFor: deps.envFor ?? (() => ({})),
      notify: (e) => deps.notify(e),
      folders: this.folders,
      project: (id) => {
        const p = deps.store.getState().projects.find((x) => x.id === id);
        return p ? { name: p.name, root: p.root } : undefined;
      },
      beluga: (projectId) => this.belugaData(projectId),
      home: deps.home ?? os.homedir(),
      claudeTurn: (signal) => this.claudeTurn(signal),
      ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.github ? { github: deps.github } : {}),
      ...(deps.chat ? { chat: deps.chat } : {}),
      ...(deps.friends ? { friends: deps.friends } : {}),
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      startOther: (id, from, output) => this.startFrom(id, from, output),
      waitForYou: (active) => this.waitForYou(active),
      ...(deps.fetchSource ? { fetchSource: deps.fetchSource } : {}),
      ...(deps.serviceEnv ? { serviceEnv: deps.serviceEnv } : {}),
      keep: (active, measured) => this.keepNumbers(active.sentinel, active.run.id, measured),
      // A step's model's effort levels, as its runtime lists them (Claude's: Claude Code's own); your default's aren't known here.
      efforts: (agent) => {
        if (!agent) return undefined;
        const st = deps.store.getState();
        const models = agent.runtime === 'claude' ? st.models : st.runtimes.find((r) => r.id === agent.runtime)?.models;
        return models?.find((m) => m.value === (agent.model ?? ''))?.efforts;
      },
    });
    this.expireWaiting();
    for (const item of this.items) this.ensureSecret(item);
    this.triggers = deps.triggers
      ? new Triggers({
          deps: { ...deps.triggers, store: deps.store, selfId: deps.selfId, now: deps.triggers.now ?? this.now },
          cursor: (id) => this.cursors[id],
          saveCursor: (id, c) => {
            this.cursors = { ...this.cursors, [id]: c };
            this.save();
          },
          fire: (id, e) => this.fireEvent(id, e),
          trouble: (id, words) => this.setTrouble(id, words),
          webhookState: (w) => {
            this.webhook = w;
            if (!this.closed) deps.store.dispatch({ type: 'sentinel_webhook', webhook: w });
          },
          hook: (id) => {
            const s = this.items.find((i) => i.id === id);
            const secret = this.secrets[id];
            if (!s || s.paused || s.trigger.kind !== 'webhook' || !secret) return undefined;
            const signingSecret = this.signingSecrets[id];
            const stripeSecret = s.trigger.signature === 'stripe' ? deps.triggers?.env?.(s.projectId).STRIPE_WEBHOOK_SECRET?.trim() : undefined;
            return { secret, ...(signingSecret ? { signingSecret } : {}), ...(s.trigger.signature ? { signature: s.trigger.signature } : {}), ...(stripeSecret ? { stripeSecret } : {}) };
          },
        })
      : undefined;
    deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
    this.triggers?.sync(this.items);
    // Tasks a run's Claude makes (labelled sentinel:<slug>) go on the run.
    this.offs.push(deps.store.onAction((a) => queueMicrotask(() => this.onAction(a))));
    const every = deps.tickMs ?? TICK_MS;
    if (every > 0) {
      const first = setTimeout(() => this.tick(), Math.min(deps.firstTickMs ?? FIRST_TICK_MS, every));
      const timer = setInterval(() => this.tick(), every);
      first.unref?.();
      timer.unref?.();
      this.offs.push(() => {
        clearTimeout(first);
        clearInterval(timer);
      });
    }
  }

  // ------------------------------------------------------------------ reading

  state(): SentinelState {
    const index = keepRuns(this.runs, KEEP_IN_STATE);
    const live: Record<string, { stepId?: string; state: Run['state'] }> = {};
    for (const r of index) {
      if (!isLive(r.state)) continue;
      const step = (r.steps.find((s) => s.state === 'running') ?? r.steps.find((s) => s.state === 'waiting'))?.id;
      live[r.id] = { ...(step ? { stepId: step } : {}), state: r.state };
    }
    const nextAt: Record<string, number> = {};
    for (const s of this.items) {
      const at = this.nextAtOf(s);
      if (at !== undefined) nextAt[s.id] = at;
    }
    return { enabled: true, items: this.items, runs: index, live, runAtOnce: this.runAtOnce, nextAt, asks: this.asks, troubles: this.troubles, webhook: this.webhook, metrics: this.metrics, dashboards: this.dashboards.list(), refreshing: this.refreshing, dashboardAsks: this.dashboardAsks, outputs: this.outputs, chats: this.chats.state() };
  }

  list = (): readonly Sentinel[] => this.items;

  get = (ref: string): Sentinel | undefined => this.items.find((s) => s.id === ref) ?? this.items.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());

  need(ref: string): Sentinel {
    const s = this.get(ref);
    if (!s) throw new Error(`There's no sentinel ${ref}`);
    return s;
  }

  /** A sentinel's whole index, newest first. */
  runsOf(ref: string): RunSummary[] {
    const id = this.need(ref).id;
    return this.runs.filter((r) => r.sentinelId === id).reverse();
  }

  /** A run with its steps' outputs (the first 16 KB each) and its report's text. */
  runGet(runId: string): RunDetail {
    const live = [...this.active.values()].find((a) => a.run.id === runId);
    const summary = live ? toSummary(live.run) : this.runs.find((r) => r.id === runId);
    if (!summary) throw new Error('That run is gone (only the last 200 of each sentinel are kept)');
    const sentinel = this.items.find((s) => s.id === summary.sentinelId);
    const saved = this.folders.read(runId, 'trigger.json');
    let payload: unknown;
    try {
      payload = saved ? (JSON.parse(saved) as { payload?: unknown }).payload : undefined;
    } catch {
      payload = undefined;
    }
    const run: Run = live
      ? live.run
      : {
          ...summary,
          trigger: { ...summary.trigger, ...(payload !== undefined ? { payload } : {}) },
          steps: summary.steps.map((s, i) => {
            const output = this.folders.read(runId, `step-${i + 1}.txt`);
            return output === undefined ? s : { ...s, output: output.slice(0, OUTPUT_KEPT) };
          }),
        };
    const report = this.folders.read(runId, 'report.md');
    return { run, ...(sentinel ? { sentinel: { id: sentinel.id, name: sentinel.name } } : {}), ...(report !== undefined ? { report } : {}) };
  }

  recipes = (): readonly Recipe[] => RECIPES;

  // ------------------------------------------------------------------ changing

  /** A new sentinel, paused until you Turn It On. */
  create(draft: SentinelDraft): Sentinel {
    if (this.items.length >= MAX_SENTINELS) throw new Error(`Up to ${MAX_SENTINELS} sentinels: delete one you don’t need first`);
    const at = this.now();
    const access = draft.access ?? 'look';
    const projectId = this.projectIdOf(draft.projectId ?? undefined);
    const steps = this.stepsOf(draft.steps ?? [], access);
    const item: Sentinel = {
      id: short('sn'),
      name: oneLine(draft.name, 80) || 'New sentinel',
      icon: draft.icon ?? 'eye',
      ...(projectId ? { projectId } : {}),
      trigger: draft.trigger ?? { kind: 'manual' },
      steps,
      access,
      limits: limitsOf({ ...DEFAULT_LIMITS, ...draft.limits }),
      ...(draft.keepChats && draft.keepChats !== DEFAULT_KEEP_CHATS ? { keepChats: draft.keepChats } : {}),
      notify: draft.notify ?? 'mac',
      paused: true,
      failures: 0,
      ...(draft.recipe ? { recipe: draft.recipe } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.items = [...this.items, item];
    this.put(item);
    return item;
  }

  /** Change a sentinel; it saves at once (the page has no Save button). */
  update(ref: string, patch: SentinelPatch): Sentinel {
    const was = this.need(ref);
    const access = patch.access ?? was.access;
    const steps = patch.steps ? this.stepsOf(patch.steps, access) : was.steps;
    if (patch.access && !patch.steps) this.checkAccess(steps, access);
    const projectId = patch.projectId === null ? undefined : patch.projectId !== undefined ? this.projectIdOf(patch.projectId) : was.projectId;
    const { projectId: _p, ...rest } = was;
    const triggerChanged = patch.trigger !== undefined && JSON.stringify(patch.trigger) !== JSON.stringify(was.trigger);
    const next: Sentinel = {
      ...rest,
      ...(patch.name !== undefined ? { name: oneLine(patch.name, 80) || was.name } : {}),
      ...(patch.icon ? { icon: patch.icon } : {}),
      ...(projectId ? { projectId } : {}),
      ...(patch.trigger ? { trigger: patch.trigger } : {}),
      steps,
      access,
      limits: limitsOf({ ...was.limits, ...patch.limits }),
      ...(patch.keepChats ? { keepChats: patch.keepChats } : {}),
      ...(patch.notify ? { notify: patch.notify } : {}),
      // A new schedule starts from now: nothing it would have run before is caught up.
      ...(triggerChanged ? { lastScheduledAt: this.now() } : {}),
      updatedAt: this.now(),
    };
    // Another trigger (or another project's GitHub, Stripe, board) watches from now: what the old one saw doesn't apply.
    if (triggerChanged || projectId !== was.projectId) this.forgetCursor(next.id);
    this.replace(next);
    if (patch.steps) this.relabelNumbers(next);
    // Keeping fewer chats puts the ones it no longer keeps away now, not at its next run.
    if (patch.keepChats && patch.keepChats !== (was.keepChats ?? DEFAULT_KEEP_CHATS)) this.tidyChats(next);
    return next;
  }

  /** Numbers already kept take their step's new label, unit and better at once (their tiles too), not at the next run. */
  private relabelNumbers(s: Sentinel): void {
    for (const step of s.steps) {
      if (step.kind !== 'measure') continue;
      for (const spec of step.metrics) {
        const name = metricName(spec.name);
        const was = this.metrics[s.id]?.[name];
        if (!was) continue;
        const meta = { label: spec.label?.trim() ? oneLine(spec.label, 80) : was.label, unit: spec.unit ?? was.unit, better: spec.better ?? was.better, kind: was.kind } as const;
        if (meta.label === was.label && meta.unit === was.unit && meta.better === was.better) continue;
        this.metricFiles.setMeta(s.id, name, meta);
        const series: MetricSeries = { ...was, ...meta };
        this.metrics = { ...this.metrics, [s.id]: { ...this.metrics[s.id], [name]: series } };
        this.deps.store.dispatch({ type: 'sentinel_metric', metric: series });
      }
    }
  }

  /** Turn it on (Resume) or pause it. */
  pause(ref: string, paused: boolean): Sentinel {
    const was = this.need(ref);
    if (was.paused === paused) return was;
    const { pausedWhy: _why, ...rest } = was;
    const next: Sentinel = paused ? { ...rest, paused: true, updatedAt: this.now() } : { ...rest, paused: false, failures: 0, lastScheduledAt: this.now(), updatedAt: this.now() };
    this.replace(next);
    return next;
  }

  /** Delete a sentinel: its run stops; its runs' folders go with the next prune. */
  remove(ref: string): void {
    const s = this.need(ref);
    // Its run stops; when it ends it's gone with the sentinel (record ignores a run whose sentinel is gone).
    this.active.get(s.id)?.abort.abort();
    this.active.delete(s.id);
    this.queued.delete(s.id);
    this.items = this.items.filter((i) => i.id !== s.id);
    this.runs = this.runs.filter((r) => r.sentinelId !== s.id);
    const { [s.id]: _ask, ...asks } = this.asks;
    this.asks = asks;
    const { [s.id]: _secret, ...secrets } = this.secrets;
    this.secrets = secrets;
    const { [s.id]: _signing, ...signing } = this.signingSecrets;
    this.signingSecrets = signing;
    this.extra.delete(s.id);
    const { [s.id]: _trouble, ...troubles } = this.troubles;
    this.troubles = troubles;
    this.forgetCursor(s.id);
    // Its numbers go with it; its tiles stay and say "gone" until you remove them.
    const { [s.id]: _metrics, ...metrics } = this.metrics;
    this.metrics = metrics;
    this.metricFiles.remove(s.id);
    const { [s.id]: _outputs, ...outputs } = this.outputs;
    this.outputs = outputs;
    this.triggers?.sync(this.items);
    this.deps.store.dispatch({ type: 'sentinel_remove', id: s.id });
    this.save();
  }

  // ------------------------------------------------------------------ moving to another computer (BLG-807)

  private moving: SentinelMover | undefined;
  /** Moving a sentinel to another computer of yours: this daemon's part. */
  get mover(): SentinelMover {
    return (this.moving ??= new SentinelMover(this.movePort(), this.deps.store, this.now));
  }

  /** What moving a sentinel to another computer reaches inside it here (see move-work.ts). */
  private movePort(): SentinelMovePort {
    return {
      get: (id) => this.items.find((i) => i.id === id),
      count: () => this.items.length,
      max: MAX_SENTINELS,
      runsOf: (id) => this.runs.filter((r) => r.sentinelId === id),
      running: (id) => this.active.has(id) || this.queued.has(id),
      folders: this.folders,
      metricFiles: this.metricFiles,
      dashboards: this.dashboards,
      cursor: (id) => this.cursors[id],
      env: (projectId) => {
        const own = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
        return { ...own, ...(this.deps.envFor?.(this.cwdOfProject(projectId)) ?? {}), ...(this.deps.serviceEnv?.(projectId) ?? {}) };
      },
      adopt: (item, runs, cursor) => {
        this.items = [...this.items, item];
        this.runs = [...this.runs, ...runs.filter((r) => !isLive(r.state))];
        if (cursor !== undefined) this.cursors = { ...this.cursors, [item.id]: cursor };
        this.put(item);
        this.loadMetrics(false);
        this.syncOutputs(item.id);
        this.deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
      },
      test: (id) => this.test(id, 'you'),
      setWhy: (id, why) => {
        const was = this.items.find((i) => i.id === id);
        if (was) this.replace({ ...was, pausedWhy: why, updatedAt: this.now() });
      },
      remove: (id) => this.remove(id),
    };
  }

  // ------------------------------------------------------------------ webhooks

  /** A webhook sentinel's address (with its secret), or why there isn't one now, in words. */
  webhookUrl(ref: string): WebhookAddress {
    const s = this.need(ref);
    if (s.trigger.kind !== 'webhook') throw new Error(`“${s.name}” doesn’t start from a webhook`);
    if (!this.triggers) return { why: 'Webhooks need the Beluga app for Mac' };
    const secret = this.ensureSecret(s);
    const signing = this.signingSecrets[s.id];
    const signingSecret = signing ? { signingSecret: signing } : {};
    const base = this.triggers.webhooks.base();
    const url = base ? `${base}/hook/${s.id}/${secret}` : undefined;
    if (s.paused) return { ...(url ? { url } : {}), why: 'It’s paused: posts to its URL are refused until you turn it on', ...signingSecret };
    if (!url) return { why: this.webhook.why ?? 'The tunnel is opening: its URL is here in a moment', ...signingSecret };
    return { url, ...signingSecret };
  }

  /** New secrets for a webhook sentinel (the URL's and GitHub's signing one): the old URL stops working at once. → its new address. */
  rotateSecret(ref: string): WebhookAddress {
    const s = this.need(ref);
    if (s.trigger.kind !== 'webhook') throw new Error(`“${s.name}” doesn’t start from a webhook`);
    this.secrets = { ...this.secrets, [s.id]: newSecret() };
    this.signingSecrets = { ...this.signingSecrets, [s.id]: newSecret() };
    this.save();
    return this.webhookUrl(s.id);
  }

  /** Something an event trigger saw: a run, unless it's paused, or a run of its own (or of a sentinel that led to it) made it. */
  private fireEvent(id: string, e: TriggerEvent): void {
    const s = this.items.find((i) => i.id === id);
    if (!s || s.paused || this.closed) return;
    let chain: string[] | undefined;
    if (e.from) {
      // The run that made it keeps its chain after it ended (a merge, a task done later).
      const runId = e.from.runId;
      const made = [...this.active.values()].find((a) => a.run.id === runId)?.run ?? this.runs.find((r) => r.id === runId) ?? [...this.queued.values()].find((q) => q.id === runId);
      chain = [...(made?.chain ?? []), e.from.sentinelId];
      if (chain.includes(s.id) || chain.length >= MAX_CHAIN) return;
    }
    // The payload is kept, and handed on, at most 64 KB.
    const payload = capPayload(e.payload);
    try {
      this.start(s.id, 'event', { kind: s.trigger.kind, summary: e.summary, ...(payload !== undefined ? { payload } : {}) }, chain);
    } catch {
      // Deleted or paused meanwhile.
    }
  }

  private setTrouble(id: string, words: string | undefined): void {
    if (this.closed || this.troubles[id] === words) return;
    if (words && !this.items.some((i) => i.id === id)) return;
    const { [id]: _was, ...rest } = this.troubles;
    this.troubles = words ? { ...rest, [id]: words } : rest;
    this.deps.store.dispatch({ type: 'sentinel_trouble', id, ...(words ? { trouble: words } : {}) });
  }

  private forgetCursor(id: string): void {
    if (!(id in this.cursors)) return;
    const { [id]: _c, ...rest } = this.cursors;
    this.cursors = rest;
  }

  /**
   * A webhook sentinel has its secrets from the start (a copy or a new one gets its own): the URL's,
   * and the one GitHub signs with. One made before they were apart signs with its URL's secret (what
   * was pasted into GitHub keeps working) until Rotate Secret.
   */
  private ensureSecret(s: Sentinel): string {
    const had = this.secrets[s.id];
    if (s.trigger.kind !== 'webhook') return had ?? '';
    if (had && this.signingSecrets[s.id]) return had;
    const secret = had ?? newSecret();
    this.secrets = { ...this.secrets, [s.id]: secret };
    this.signingSecrets = { ...this.signingSecrets, [s.id]: had ?? newSecret() };
    this.save();
    return secret;
  }

  duplicate(ref: string): Sentinel {
    const s = this.need(ref);
    const { id: _id, createdAt: _c, updatedAt: _u, pausedWhy: _w, lastScheduledAt: _l, recipe: _r, projectId, ...rest } = s;
    const at = this.now();
    const copy: Sentinel = { ...rest, ...(projectId ? { projectId } : {}), id: short('sn'), name: `${s.name} copy`.slice(0, 80), paused: true, failures: 0, createdAt: at, updatedAt: at };
    this.items = [...this.items, copy];
    this.put(copy);
    return copy;
  }

  setRunAtOnce(n: number): number {
    this.runAtOnce = Math.max(1, Math.min(MAX_RUN_AT_ONCE, Math.round(n)));
    this.deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
    this.save();
    this.pump();
    return this.runAtOnce;
  }

  // ------------------------------------------------------------------ running

  /**
   * Start a run (Run Now, the clock, Claude): one at a time per sentinel, so one that fires while
   * it runs waits (once). Paused sentinels only run when you ask (Run Now). → the run.
   */
  start(ref: string, by: RunBy, trigger?: RunTrigger, chain?: readonly string[]): RunSummary {
    const s = this.need(ref);
    const yours = by === 'you' || by === 'phone';
    if (s.paused && !yours) throw new Error(`“${s.name}” is paused: turn it on first`);
    const fired: RunTrigger = trigger ?? { kind: yours || by === 'claude' ? 'manual' : s.trigger.kind, summary: by === 'you' ? 'You pressed Run' : by === 'phone' ? 'You ran it from your phone' : by === 'claude' ? `${this.yourAgent()} ran it` : scheduleSentence(s.trigger) };
    const limit = s.limits.perDay;
    if (limit && !yours) {
      const today = startOfDay(this.now());
      // Runs that ran (or run now); skipped and queued ones don't count.
      const ran = this.runs.filter((r) => r.sentinelId === s.id && r.startedAt >= today && COUNTS_PER_DAY.has(r.state)).length;
      if (ran >= limit) return this.note(s, by, fired, OVER_DAY, `Skipped: it ran ${limit} ${limit === 1 ? 'time' : 'times'} today already`);
    }
    if (this.active.has(s.id)) {
      const waiting = this.queued.get(s.id);
      if (waiting) {
        if (by === 'event') this.oneMore(s, fired);
        return waiting;
      }
      const run = this.newRun(s, by, fired, 'queued', chain);
      this.queued.set(s.id, { ...toSummary(run), ...(fired.payload !== undefined ? { payload: fired.payload } : {}) });
      this.record(run);
      return toSummary(run);
    }
    // The chain is on the run from the start: a step that runs another sentinel at once sees it.
    const run = this.newRun(s, by, fired, 'running', chain);
    return toSummary(this.launch(s, run));
  }

  /** Stop a run going now (or one waiting its turn). → whether there was one. */
  stop(runId: string): boolean {
    for (const a of this.active.values()) {
      if (a.run.id !== runId) continue;
      a.abort.abort();
      return true;
    }
    for (const [id, q] of this.queued) {
      if (q.id !== runId) continue;
      this.queued.delete(id);
      const { payload: _p, ...run } = q;
      this.recordSummary({ ...run, steps: run.steps.map((st) => ({ ...st, state: 'skipped' as const })), state: 'stopped', headline: 'Stopped by you before it started', endedAt: this.now() });
      return true;
    }
    return false;
  }

  /**
   * A run waiting for you (a merge, docs/sentinel.md §5): Merge merges it (and archives its
   * worktree), Not Now ends it as stopped with the pull request left open. A run still going hears
   * it and goes on with its steps; one Beluga was closed under is merged from here. → the run, once
   * GitHub has merged it (or said why not).
   */
  async decide(runId: string, choice: 'merge' | 'skip'): Promise<RunSummary> {
    const going = [...this.active.values()].find((a) => a.run.id === runId);
    if (going) {
      if (going.run.state !== 'needs-you' || !going.answer) throw new Error('That run isn’t waiting for you');
      await going.answer(choice);
      return toSummary(going.run);
    }
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.state !== 'needs-you') throw new Error('That run isn’t waiting for you (anymore)');
    if (this.deciding.has(runId)) throw new Error('That run is being merged already');
    this.deciding.add(runId);
    try {
      return await this.decideClosed(run, choice);
    } finally {
      this.deciding.delete(runId);
    }
  }

  /**
   * decide for a run Beluga was closed under: Not Now stops it; Merge looks again (the sentinel
   * still has Ship access and its merge step, the pull request still at the commit that was checked
   * and reviewed, its checks passing there), merges pinned to that commit, and ends the run as a
   * run ends (its failures counted, the sentinels that run after it started).
   */
  private async decideClosed(run: RunSummary, choice: 'merge' | 'skip'): Promise<RunSummary> {
    const s = this.need(run.sentinelId);
    const at = s.steps.findIndex((st) => st.kind === 'merge');
    const mergeStep = at >= 0 ? s.steps[at] : undefined;
    const n = run.pr ? `#${run.pr.number}` : 'the pull request';
    const ended = (state: 'done' | 'skipped' | 'failed', why?: string): RunSummary['steps'] =>
      run.steps.map((st) => (mergeStep && st.id === mergeStep.id ? { ...st, state, endedAt: this.now(), ...(why ? { why } : {}) } : st.state === 'waiting' || st.state === 'running' ? { ...st, state: 'skipped' as const } : st));
    if (choice === 'skip') {
      const next: RunSummary = { ...run, state: 'stopped', headline: `Not now: ${n} stays open`, endedAt: this.now(), steps: ended('skipped') };
      this.recordSummary(next);
      return next;
    }
    const gh = this.deps.github;
    if (!gh || !run.pr) throw new Error('Merging needs the Beluga app and the run’s pull request');
    const end = (state: 'done' | 'failed', headline: string, why?: string): RunSummary => {
      const fresh = this.runs.find((r) => r.id === run.id) ?? run;
      const next: RunSummary = { ...fresh, state, headline: redactSecrets(headline), endedAt: this.now(), steps: ended(state, why), ...(why ? { why: redactSecrets(why) } : {}) };
      // Ended as a run ends: its failures counted, told, the sentinels after it started.
      const active: ActiveRun = { run: next, sentinel: s, abort: new AbortController(), deadline: this.now(), places: {} };
      this.finished(active, next);
      return next;
    };
    const refuse = (why: string): never => {
      end('failed', `${mergeStep?.name ?? 'Merge'}: ${firstLine(why, 100)}`, why);
      throw new Error(capitalFirst(why));
    };
    if (mergeStep?.kind !== 'merge') return refuse('this sentinel has no merge step anymore');
    if (!accessAllows(s.access, 'merge')) return refuse(`it needs ${ACCESS_INFO.ship.label} access, and this sentinel has ${ACCESS_INFO[s.access].label}`);
    if (!run.prHead) return refuse('Beluga can’t tell which commit the agent reviewed; run it again');
    const where = { ...(run.worktreeId ? { workspaceId: run.worktreeId } : {}), ...(s.projectId ? { projectId: s.projectId } : {}) };
    const res = await mergePinned(gh, where, run.pr, mergeStep.method, run.prHead);
    if (res !== true) return refuse(res);
    // Its work is on the base branch now; a worktree that can't go stays (nothing is lost).
    if (run.worktreeId) await this.deps.places?.archive(run.worktreeId).catch(() => undefined);
    return end('done', `Merged ${n}`);
  }

  /** The clock: start what's due (the Mac waking from sleep shows as a gap since the last look). */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const every = this.deps.tickMs || TICK_MS;
    const woke = this.lastTick !== undefined && now - this.lastTick > 3 * every;
    this.lastTick = now;
    this.expireWaiting();
    for (const s of this.items) {
      if (s.paused || s.trigger.kind !== 'schedule') continue;
      const due = dueNow(s.trigger, s.lastScheduledAt, now, this.deps.tz ? { tz: this.deps.tz } : {});
      if (due.kind === 'wait') {
        // The clock jumped: what the window says comes next is worked out again.
        if (woke) this.put(s);
        continue;
      }
      const moved: Sentinel = { ...s, lastScheduledAt: due.slot };
      this.replace(moved);
      const sentence = scheduleSentence(s.trigger);
      if (due.kind === 'skip') {
        this.note(moved, 'schedule', { kind: 'schedule', summary: sentence }, 'Missed while the Mac was asleep or Beluga was closed', 'Skipped: the Mac was asleep or Beluga was closed');
        continue;
      }
      try {
        this.start(moved.id, 'schedule', { kind: 'schedule', summary: due.late ? `${sentence} (caught up: the Mac was asleep or Beluga was closed)` : sentence });
      } catch {
        // Deleted or paused meanwhile.
      }
    }
  }

  /** Everything a run of Claude's gets: the tools (your own runs only), and the brief of a sentinel run's Claude step. */
  forRun(channel: string, from: string): RunSentinel | undefined {
    if (from !== this.deps.selfId()) return undefined;
    const active = [...this.active.values()].find((a) => a.claude?.channel === channel);
    if (active?.claude) return { tools: this.toolsFor(active), dashboard: this.dashboardTools(active), brief: active.claude.brief, inRun: true };
    // A conversation where your Claude changes a sentinel (sentinel.ask): the sentinel as material.
    const asked = this.askChannels.get(channel);
    const sentinel = asked ? this.items.find((i) => i.id === asked) : undefined;
    if (sentinel) return { tools: this.toolsFor(undefined, sentinel.id), dashboard: this.dashboardTools(undefined), brief: sentinelAskBrief(sentinel, this.items, RECIPES), inRun: false };
    // One where it builds a dashboard (Add a Tile by description): the dashboard, the numbers and the
    // sentinels as material; a sentinel it makes to fetch what nothing keeps yet is noted as the ask's.
    const building = this.dashboardChannels.get(channel);
    const dashboard = building ? this.dashboards.get(building) : undefined;
    if (dashboard) return { tools: this.toolsFor(undefined, undefined, (id) => this.madeFor(dashboard.id, id)), dashboard: this.dashboardTools(undefined, dashboard.id), brief: dashboardAskBrief(dashboard, this.metricList(), this.items, RECIPES), inRun: false };
    // The Sentinel chat (§12): how Sentinel works, and all of it as it is now.
    if (isSentinelChat(channel)) return { tools: this.toolsFor(undefined), dashboard: this.dashboardTools(undefined), brief: sentinelChatBrief(this.items, this.dashboards.list(), this.metricList(), RECIPES, (sn) => this.lastLine(sn)), inRun: false };
    return { tools: this.toolsFor(undefined), dashboard: this.dashboardTools(undefined), brief: sentinelNote(), inRun: false };
  }

  /** An external agent's sentinel and dashboard tools: the lists show only what `visible` holds. They have the same limits as your own agent's: never turning one on. */
  toolsForAgent(visible: (sentinel: Sentinel) => boolean): { readonly tools: SentinelTools; readonly dashboard: DashboardTools } {
    return { tools: this.toolsFor(undefined, undefined, undefined, visible), dashboard: this.dashboardTools(undefined, undefined, visible) };
  }

  /** Where the Sentinel chat's Claude runs (its own folder and session), your runs only. */
  chatPlace(channel: string, from: string): AgentPlace | undefined {
    return isSentinelChat(channel) ? this.chats.place(channel, from) : undefined;
  }

  /** What the card says when your Claude wants to delete a sentinel or a dashboard (it always asks you). */
  confirmWords(toolName: string, input: Record<string, unknown>): { readonly title: string; readonly detail: string } | undefined {
    if (toolName === 'mcp__beluga_sentinel__sentinel_remove') {
      const s = this.get(String(input.id ?? ''));
      return { title: `${this.yourAgent()} wants to delete the sentinel “${s?.name ?? String(input.id ?? 'a sentinel')}”`, detail: s ? `${scheduleSentence(s.trigger, (id) => this.get(id)?.name)} · ${s.steps.length} ${s.steps.length === 1 ? 'step' : 'steps'}. It stops watching, a run going now stops, and its numbers go with it.` : 'There’s no such sentinel: Decline.' };
    }
    if (toolName === 'mcp__beluga_dashboard__dashboard_remove') {
      const d = this.dashboards.get(String(input.dashboard ?? ''));
      return { title: `${this.yourAgent()} wants to delete the dashboard “${d?.name ?? String(input.dashboard ?? 'a dashboard')}”`, detail: d ? `${d.tiles.length} ${d.tiles.length === 1 ? 'tile' : 'tiles'} go; the numbers stay with their sentinels.` : 'There’s no such dashboard: Decline.' };
    }
    return undefined;
  }

  /** A sentinel's last run and next one, in a few words (sentinel_list, the chat's material). */
  private lastLine(s: Sentinel): string {
    const last = lastRunOf(this.state(), s.id);
    const next = this.nextAtOf(s);
    return `${last ? ` · last run ${last.state}${last.headline ? `: ${last.headline}` : ''}` : ' · never ran'}${next ? ` · next ${new Date(next).toLocaleString()}` : ''}`;
  }

  /** A sentinel your Claude made while building a dashboard: the ask says so (the draft to turn on). */
  private madeFor(dashboardId: string, sentinelId: string): void {
    const ask = this.dashboardAsks[dashboardId];
    if (!ask) return;
    const next = { ...ask, made: [...(ask.made ?? []), sentinelId] };
    this.dashboardAsks = { ...this.dashboardAsks, [dashboardId]: next };
    if (!this.closed) this.deps.store.dispatch({ type: 'sentinel_dashboard_ask', id: dashboardId, ask: next });
  }

  /**
   * Ask your Claude to change a sentinel (the page's box; Describe it is create, then this): a quiet
   * chat in its project's main folder (Claude reads, never changes files) or in Your Mac, told the
   * sentinel, the step kinds and the recipes, with the tools to change it. The page follows it
   * through the state (asks). → the conversation.
   */
  async ask(ref: string, text: string): Promise<{ readonly channel: string }> {
    const s = this.need(ref);
    const claude = this.deps.claude;
    const places = this.deps.places;
    if (!claude || !places) throw new Error(`Asking ${this.yourAgent(false)} needs the Beluga app with it on`);
    const words = text.trim();
    if (!words) throw new Error('Say what to change');
    if (this.asking.has(s.id) || this.asks[s.id]?.state === 'writing') throw new Error(`${this.yourAgent()} is changing “${s.name}” already: wait for it, or open its chat`);
    // Taken before the first await: a second ask in the meantime is refused, not run twice.
    this.asking.add(s.id);
    let place: Awaited<ReturnType<SentinelPlaces['projectChat']>>;
    try {
      place = s.projectId ? await places.projectChat(s.projectId, `Change “${s.name}”`) : places.macChat();
    } catch (err) {
      this.asking.delete(s.id);
      throw err;
    }
    if (!place) {
      this.asking.delete(s.id);
      throw new Error('The agent’s conversation couldn’t be made');
    }
    const { channel } = place;
    this.askChannels.set(channel, s.id);
    const ask: SentinelAsk = { channel, startedAt: this.now(), state: 'writing', text: firstLine(words, 200) };
    this.setAsk(s.id, ask);
    this.asking.delete(s.id);
    const requestId = claude.ask(words, channel, words);
    if (!requestId) {
      this.setAsk(s.id, { ...ask, state: 'failed', answer: `${this.yourAgent()} couldn’t be asked there`, endedAt: this.now() });
      throw new Error(`${this.yourAgent()} couldn’t be asked there`);
    }
    // As long as one of its runs may take: then it's stopped, and the page says so.
    let over = false;
    const timer = setTimeout(
      () => {
        over = true;
        claude.cancel(requestId, `Stopped by Beluga: ${agentName(defaultAgentOf(this.deps.store.getState().self))} took too long`);
        this.setAsk(s.id, { ...ask, state: 'failed', answer: TOOK_TOO_LONG, endedAt: this.now() });
      },
      (s.limits.minutes || DEFAULT_LIMITS.minutes) * 60_000,
    );
    timer.unref?.();
    void claude.wait(requestId).then(
      (answer) => {
        clearTimeout(timer);
        if (!over) this.setAsk(s.id, { ...ask, state: 'done', answer: clipLines(answer), endedAt: this.now() });
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!over) this.setAsk(s.id, { ...ask, state: 'failed', answer: firstLine(redactSecrets(err instanceof Error ? err.message : String(err)), 200) || 'The agent stopped', endedAt: this.now() });
      },
    );
    return { channel };
  }

  /** Your Claude's change (sentinel_update): a change to what it can do pauses one that was on. */
  claudeUpdate(ref: string, patch: ToolPatch): { readonly sentinel: Sentinel; readonly paused: boolean } {
    const was = this.need(ref);
    const next = this.update(was.id, this.fromToolPatch(patch));
    // Paused already (after failures, say): it now says Claude changed it, so Resume runs nothing new unseen.
    if (!claudeWidened(was, next)) return { sentinel: next, paused: false };
    const paused: Sentinel = { ...next, paused: true, pausedWhy: CLAUDE_CHANGED, updatedAt: this.now() };
    this.replace(paused);
    return { sentinel: paused, paused: true };
  }

  // ------------------------------------------------------------------ checking and testing sources (BLG-302, BLG-304)

  /**
   * Test a sentinel's sources without turning it on (paused or not): each Keep the numbers step that
   * reads a source runs once, what it finds is kept (its tiles fill), and the run says it was a test.
   * Nothing else runs: no Claude, script, service call, message or pull request, and nothing after it.
   * Your Claude's test (`claude`) runs only what's read-only by itself (a command waits for your yes).
   */
  async test(ref: string, by: 'you' | 'claude'): Promise<SentinelTest> {
    const s = this.need(ref);
    if (this.active.has(s.id)) throw new Error(`“${s.name}” is running now: its run shows what it finds`);
    if (!s.steps.some((st, i) => isSourceStep(st) || (by === 'you' && readsScript(s.steps, i)))) {
      return { previews: [], text: `“${s.name}” has no Keep the numbers step that reads a source${by === 'you' ? ' or a script' : ''}, so a test has nothing to run: ${by === 'claude' ? 'the user’s Run Now runs all of it (paused or not)' : 'Run Now runs all of it, paused or not'}.` };
    }
    if (this.testing.has(s.id)) throw new Error(`“${s.name}” is being tested already`);
    this.testing.add(s.id);
    let checks: SourceCheck[];
    try {
      checks = await this.checkSources(s.steps, s.projectId, by === 'claude', undefined, by === 'you' ? s : undefined);
    } finally {
      this.testing.delete(s.id);
    }
    const now = this.items.find((i) => i.id === s.id);
    if (!now) throw new Error(`“${s.name}” was deleted meanwhile`);
    const run = this.recordTest(now, by, checks, by === 'claude' ? `${this.yourAgent()} tested its sources` : 'You tested its sources');
    const previews = checks.map((c) => c.preview);
    return { runId: run.id, previews, text: redactSecrets(`${run.headline}\n\n${describePreviews(previews)}`) };
  }

  /**
   * Run sources once, read-only, as your Claude would (byClaude: nothing that needs your yes) or as you:
   * each source step's rows as a preview, and the numbers its step would keep. `only`: those steps.
   */
  private async checkSources(steps: readonly Step[], projectId: string | undefined, byClaude: boolean, only?: ReadonlySet<string>, scriptsOf?: Sentinel): Promise<SourceCheck[]> {
    const out: SourceCheck[] = [];
    for (const [i, st] of steps.entries()) {
      if (st.kind !== 'measure' || (only && !only.has(st.id))) continue;
      if (st.from === 'source') out.push(await this.checkSource(st.source, projectId, byClaude, st.id, st.name, (rows) => measureFrom(rows, st.metrics, st.keep), undefined, (rows) => typedOf(st, rows)));
      // Your own test runs a script step once, and the Keep the numbers step that reads it (BLG-350); your Claude's never does.
      else if (scriptsOf && readsScript(steps, i)) out.push(await this.checkScript(scriptsOf, steps[i - 1] as ScriptStep, st));
    }
    return out;
  }

  /** A script step run once for a test, and what the Keep the numbers step after it would keep from what it printed. */
  private async checkScript(s: Sentinel, script: ScriptStep, measure: MeasureStep): Promise<SourceCheck> {
    const said = await this.runner.scriptOnce(s, script, CHECK_MS);
    if ('why' in said) return { stepId: measure.id, preview: previewFailed(measure.id, measure.name, 'failed', `“${script.name}” ${redactSecrets(said.why)}`), found: [] };
    const data = readOutput(said.output);
    const m = measureFrom(data, measure.metrics, measure.keep, said.output);
    const rows = Array.isArray(data) ? cellRows(data.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')) : data && typeof data === 'object' ? cellRows([data as Record<string, unknown>]) : data === undefined ? [] : [{ value: typeof data === 'number' ? data : String(data).slice(0, 2000) }];
    const preview = previewOf(measure.id, measure.name, rows, [], { kept: m.found.map((f) => f.name), missing: m.missing }, undefined, typedOf(measure, rows));
    return { stepId: measure.id, preview, found: m.found };
  }

  /** One source, once: its preview (and what a step keeps from it, `measure`). */
  private async checkSource(source: Source | undefined, projectId: string | undefined, byClaude: boolean, stepId: string, stepName: string, measure?: (rows: readonly Row[]) => { readonly found: Measured[]; readonly missing: string[] }, sample?: number, typed?: (rows: readonly Row[]) => string[]): Promise<SourceCheck> {
    if (!source) return { stepId, preview: previewFailed(stepId, stepName, 'failed', 'it has no source yet: give it one'), found: [] };
    const fetch = this.deps.fetchSource;
    if (!fetch) return { stepId, preview: previewFailed(stepId, stepName, 'not-checked', 'sources need the Beluga app'), found: [] };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(`took longer than ${CHECK_MS / 60_000} minutes`);
      }, CHECK_MS);
      timer.unref?.();
    });
    const got = await Promise.race([fetch(source, this.cwdOfProject(projectId), abort.signal, { byClaude }).catch((err: unknown) => (err instanceof Error ? err.message : String(err))), timeout]).finally(() => clearTimeout(timer));
    if (typeof got === 'string') return { stepId, preview: previewFailed(stepId, stepName, 'failed', redactSecrets(got)), found: [] };
    if ('needsYes' in got) return { stepId, preview: previewFailed(stepId, stepName, 'not-checked', `it runs ${firstLine(got.needsYes, 200)}, which waits for the user’s yes: it runs on their Run Now`), found: [] };
    const rows = cellRows(got.rows as Record<string, unknown>[]);
    const m = measure?.(rows);
    return { stepId, preview: previewOf(stepId, stepName, rows, got.columns, m ? { kept: m.found.map((f) => f.name), missing: m.missing } : undefined, sample, typed?.(rows)), found: m?.found ?? [] };
  }

  /** A test as a run in the sentinel's history (by you or your Claude), its numbers kept; nothing follows it. */
  private recordTest(s: Sentinel, by: 'you' | 'claude', checks: readonly SourceCheck[], summary: string): RunSummary {
    const at = this.now();
    const run = this.newRun(s, by, { kind: 'manual', summary }, 'running');
    const byStep = new Map(checks.map((c) => [c.stepId, c]));
    const measured: Measured[] = [];
    let failed: string | undefined;
    let kept: string | undefined;
    const steps = s.steps.map((st, i): Run['steps'][number] => {
      const c = byStep.get(st.id);
      if (!c) return { id: st.id, state: 'skipped', why: NOT_IN_TEST };
      const p = c.preview;
      if (p.state === 'not-checked') return { id: st.id, state: 'skipped', startedAt: at, endedAt: at, why: p.why ?? 'not checked' };
      measured.push(...c.found);
      const output = c.found.length ? `${keptWords(c.found)}${p.missing?.length ? `\nNot found: ${p.missing.join(', ')}` : ''}` : undefined;
      if (output) {
        this.folders.write(run.id, `step-${i + 1}.txt`, output);
        kept ??= firstLine(output);
      }
      const why = p.state === 'failed' ? `the source didn’t answer: ${p.why ?? ''}` : p.missing?.length ? (p.rows ? `didn’t find ${p.missing.join(', ')}${c.found.length ? ' (the rest was kept)' : ''}` : 'no rows came back') : undefined;
      if (why) failed ??= `${st.name}: ${why}`;
      return { id: st.id, state: why ? 'failed' : 'done', startedAt: at, endedAt: at, ...(output ? { output: output.slice(0, OUTPUT_KEPT) } : {}), ...(why ? { why } : {}) };
    });
    const state: Run['state'] = failed ? 'failed' : measured.length ? 'done' : 'skipped';
    const headline = `Test: ${failed ? firstLine(failed, 120) : (kept ?? 'nothing to keep')}`;
    const done: Run = { ...run, steps, state, headline: redactSecrets(headline), endedAt: this.now(), ...(failed ? { why: redactSecrets(failed) } : {}) };
    this.record(done);
    if (measured.length) this.keepNumbers(s, done.id, measured);
    this.prune();
    return toSummary(done);
  }

  /** The folder a sentinel's sources run in: its project's main folder, else your home. */
  private cwdOfProject(projectId: string | undefined): string {
    const p = projectId ? this.deps.store.getState().projects.find((x) => x.id === projectId) : undefined;
    return p?.root || this.deps.home || os.homedir();
  }

  /** Recorded history (the demo): a run as if it had happened, with its outputs and report (the same id: that run, changed). */
  addHistory(sentinelId: string, run: Omit<Run, 'id' | 'sentinelId'> & { readonly id?: string }, files: { readonly outputs?: readonly (string | undefined)[]; readonly report?: string } = {}): Run {
    const full: Run = { ...run, id: run.id ?? short('run', 8), sentinelId };
    files.outputs?.forEach((o, i) => o !== undefined && this.folders.write(full.id, `step-${i + 1}.txt`, o));
    if (files.report !== undefined) this.folders.write(full.id, 'report.md', files.report);
    const report = files.report !== undefined ? this.folders.pathOf(full.id, 'report.md') : undefined;
    this.record(report ? { ...full, report } : full);
    return full;
  }

  /** The demo's history: a sentinel as if its runs had failed (and paused it). */
  demoSet(ref: string, patch: { readonly paused?: boolean; readonly failures?: number; readonly pausedWhy?: string; readonly lastScheduledAt?: number }): Sentinel {
    const next: Sentinel = { ...this.need(ref), ...patch };
    this.replace(next);
    return next;
  }

  /** On the way out: runs going now stop, and everything is written. */
  stopAll(): void {
    this.triggers?.stopAll();
    this.closed = true;
    for (const off of this.offs) off();
    // Nothing reads "running" after a restart: the steps going (or still to come) are skipped, and
    // the runs waiting their turn are stopped.
    const unfinished = (steps: RunSummary['steps']): RunSummary['steps'] => steps.map((st) => (st.state === 'running' || st.state === 'waiting' ? { ...st, state: 'skipped' as const } : st));
    for (const a of this.active.values()) {
      a.abort.abort();
      const run = toSummary(a.run);
      this.recordSummary({ ...run, state: 'stopped', headline: 'Beluga closed while it ran', endedAt: this.now(), steps: unfinished(run.steps) });
    }
    for (const q of this.queued.values()) {
      const { payload: _p, ...run } = q;
      this.recordSummary({ ...run, state: 'stopped', headline: 'Beluga closed before it started', endedAt: this.now(), steps: unfinished(run.steps) });
    }
    this.active.clear();
    this.queued.clear();
    this.file.flush();
    this.dashboards.flush();
    this.chats.stop();
    for (const waiters of this.endWaiters.values()) for (const w of waiters) w();
    this.endWaiters.clear();
  }

  // ------------------------------------------------------------------ inside

  private newRun(s: Sentinel, by: RunBy, trigger: RunTrigger, state: Run['state'], chain?: readonly string[]): Run {
    return { id: short('run', 8), sentinelId: s.id, by, trigger, state, startedAt: this.now(), headline: state === 'queued' ? 'Waiting for the run before it' : '', steps: s.steps.map((st) => ({ id: st.id, state: 'waiting' })), tasks: [], ...(chain?.length ? { chain } : {}) };
  }

  /**
   * An event while it runs and another run waits already: it isn't run, but the history says so,
   * one line for them all until the run ends ("2 more events while it ran").
   */
  private oneMore(s: Sentinel, trigger: RunTrigger): void {
    const was = this.extra.get(s.id);
    const n = (was?.n ?? 0) + 1;
    const headline = `Skipped: ${n} more ${n === 1 ? 'event' : 'events'} while it ran`;
    const prev = was && this.runs.find((r) => r.id === was.runId);
    const { payload: _p, ...summary } = trigger;
    if (prev) this.recordSummary({ ...prev, trigger: summary, headline, endedAt: this.now() });
    else {
      const note = this.note(s, 'event', summary, 'it was running, and another run waited already', headline);
      this.extra.set(s.id, { runId: note.id, n });
      return;
    }
    this.extra.set(s.id, { runId: prev.id, n });
  }

  /** A run that didn't run (over its runs per day, a missed slot skipped): a line in the history. */
  private note(s: Sentinel, by: RunBy, trigger: RunTrigger, why: string, headline: string): RunSummary {
    const at = this.now();
    const run: Run = { ...this.newRun(s, by, trigger, 'skipped'), why, headline, endedAt: at, steps: s.steps.map((st) => ({ id: st.id, state: 'skipped' })) };
    this.record(run);
    return toSummary(run);
  }

  private launch(s: Sentinel, run: Run): Run {
    const active: ActiveRun = { run, sentinel: s, abort: new AbortController(), deadline: this.now() + s.limits.minutes * 60_000, places: {} };
    this.active.set(s.id, active);
    this.folders.write(run.id, 'trigger.json', `${JSON.stringify(run.trigger, null, 2)}\n`);
    this.record(run);
    void this.runner
      .execute(active, (r) => !this.closed && this.record(r))
      .catch((err: unknown) => ({ ...active.run, state: 'failed' as const, why: redactSecrets(err instanceof Error ? err.message : String(err)), headline: 'Something went wrong', endedAt: this.now() }))
      .then((final) => this.finished(active, final));
    return active.run;
  }

  private finished(active: ActiveRun, run: Run): void {
    if (this.closed) return;
    const sid = active.sentinel.id;
    if (this.active.get(sid) === active) this.active.delete(sid);
    const s = this.items.find((i) => i.id === sid);
    // Its sentinel was deleted while it ran: it goes too, its folder with it.
    if (!s) {
      this.folders.remove(run.id);
      return;
    }
    this.record(run);
    const failures = run.state === 'failed' ? s.failures + 1 : run.state === 'done' || run.state === 'skipped' ? 0 : s.failures;
    const pausing = run.state === 'failed' && s.limits.pauseAfter > 0 && failures >= s.limits.pauseAfter && !s.paused;
    const next: Sentinel = { ...s, failures, ...(pausing ? { paused: true, pausedWhy: `Paused after ${failures} failures in a row` } : {}) };
    if (next.failures !== s.failures || pausing) this.replace(next);
    this.tell(next, run, pausing);
    this.follow(next, run);
    this.extra.delete(sid);
    this.tidyChats(next);
    this.prune();
    const waiting = this.active.has(sid) ? undefined : this.queued.get(sid);
    if (waiting) {
      this.queued.delete(sid);
      const { payload, ...q } = waiting;
      const fresh = this.items.find((i) => i.id === sid)!;
      if (fresh.paused && q.by !== 'you' && q.by !== 'phone') this.recordSummary({ ...q, state: 'skipped', why: 'paused', headline: 'Skipped: it was paused', endedAt: this.now() });
      else this.launch(fresh, { ...q, trigger: { ...q.trigger, ...(payload !== undefined ? { payload } : {}) }, state: 'running', startedAt: this.now(), headline: '', steps: fresh.steps.map((st) => ({ id: st.id, state: 'waiting' })) });
    }
  }

  /** The run's end, told: failures (and pausing) as problems, a finished run where the sentinel says. */
  private tell(s: Sentinel, run: Run, paused: boolean): void {
    const where = s.notify;
    const channel = run.channel ? { channel: run.channel } : {};
    if (paused) {
      this.deps.notify({ kind: 'problems', tag: 'sentinel', title: `${s.name} is paused after ${s.failures} failures`, body: run.why ? `The last one: ${run.why}` : 'Resume it from its page', key: `${run.id}:paused`, ...channel });
      return;
    }
    if (where === 'off') return;
    if (run.state === 'failed') this.deps.notify({ kind: 'problems', tag: 'sentinel', title: `${s.name} failed`, body: run.headline, key: `${run.id}:failed`, ...channel });
    // A Notify step told it already (with its own words).
    else if (run.state === 'done' && (where === 'mac' || where === 'both') && !s.steps.some((st, i) => st.kind === 'notify' && run.steps[i]?.state === 'done')) this.deps.notify({ kind: 'done', tag: 'sentinel', title: s.name, body: run.headline, key: run.id, ...channel });
    // The phone (where === 'phone' | 'both') is told by the companion host, from the state: a `done`
    // nudge collapsed as `sentinel:<id>` (src/companion/views.ts sentinelDone), the report on its page.
  }

  /** Sentinels that run after this one ("After “Nightly tests” fails"): started with its last output. */
  private follow(s: Sentinel, run: Run): void {
    const fits = (on: 'success' | 'failure' | 'always'): boolean => (on === 'success' ? run.state === 'done' : on === 'failure' ? run.state === 'failed' : run.state === 'done' || run.state === 'failed');
    const output = this.lastOutput(run);
    for (const f of this.items) {
      if (f.paused || f.trigger.kind !== 'after' || f.trigger.sentinelId !== s.id || !fits(f.trigger.on)) continue;
      const how = run.state === 'done' ? 'succeeded' : run.state === 'failed' ? 'failed' : 'ran';
      try {
        this.chained(f, run, s, { kind: 'after', summary: `After “${s.name}” ${how}${run.headline ? `: ${firstLine(run.headline, 120)}` : ''}`, payload: { sentinel: s.name, run: run.id, state: run.state, headline: run.headline, ...(output !== undefined ? { output } : {}) } });
      } catch {
        // Deleted, paused, or a loop: nothing starts.
      }
    }
  }

  /** Start `target` from another sentinel's run (after, Run another sentinel), never in a loop. */
  private chained(target: Sentinel, from: Pick<Run, 'id' | 'chain'>, by: Sentinel, trigger: RunTrigger): RunSummary {
    const chain = [...(from.chain ?? []), by.id];
    if (chain.includes(target.id)) throw new Error(`“${target.name}” led to this run: starting it again would run them in a loop`);
    if (chain.length >= MAX_CHAIN) throw new Error(`${MAX_CHAIN} sentinels ran each other in a row: “${target.name}” doesn’t start`);
    return this.start(target.id, `after:${from.id}`, trigger, chain);
  }

  /** Run another sentinel (a step): with this run's last output as its trigger's payload. → its name. */
  private startFrom(ref: string, from: ActiveRun, output: string | undefined): string {
    const target = this.need(ref);
    this.chained(target, from.run, from.sentinel, { kind: 'after', summary: `“${from.sentinel.name}” ran it`, payload: { sentinel: from.sentinel.name, run: from.run.id, ...(output !== undefined ? { output: output.slice(0, OUTPUT_KEPT) } : {}) } });
    return target.name;
  }

  /** A run's last step output (the first 16 KB), from its folder. */
  private lastOutput(run: Run): string | undefined {
    for (let i = run.steps.length; i >= 1; i--) {
      const out = this.folders.read(run.id, `step-${i}.txt`);
      if (out !== undefined) return out.slice(0, OUTPUT_KEPT);
    }
    return undefined;
  }

  /** A merge waits for your Merge or Not Now (decide), or 24 hours. */
  private waitForYou(active: ActiveRun): Promise<YourAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ choice: 'expired' }), this.deps.approvalMs ?? APPROVAL_MS);
      timer.unref?.();
      const onAbort = (): void => finish({ choice: 'expired' });
      active.abort.signal.addEventListener('abort', onAbort, { once: true });
      let done = false;
      function finish(a: YourAnswer): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        active.abort.signal.removeEventListener('abort', onAbort);
        active.answer = undefined;
        resolve(a);
      }
      active.answer = (choice) =>
        new Promise<void>((ok, no) => {
          finish({ choice, settle: (why) => (why ? no(new Error(why)) : ok()) });
        });
    });
  }

  /** Runs waiting for you that Beluga was closed under, unanswered for 24 hours: stopped. */
  private expireWaiting(): void {
    const now = this.now();
    const limit = this.deps.approvalMs ?? APPROVAL_MS;
    const going = new Set([...this.active.values()].map((a) => a.run.id));
    for (const r of this.runs) {
      if (r.state !== 'needs-you' || going.has(r.id)) continue;
      const since = r.waitingSince ?? r.steps.find((st) => st.state === 'running')?.startedAt ?? r.startedAt;
      if (now - since < limit) continue;
      const n = r.pr ? `#${r.pr.number}` : 'the pull request';
      this.recordSummary({ ...r, state: 'stopped', headline: `Nobody said Merge in 24 hours: ${n} stays open`, why: 'nobody said Merge in 24 hours', endedAt: now, steps: r.steps.map((st) => (st.state === 'running' || st.state === 'waiting' ? { ...st, state: 'skipped' as const } : st)) });
    }
  }

  private setAsk(id: string, ask: SentinelAsk): void {
    if (!this.items.some((i) => i.id === id)) return;
    this.asks = { ...this.asks, [id]: ask };
    this.deps.store.dispatch({ type: 'sentinel_ask', id, ask });
  }

  /** Claude's patch as a sentinel patch: its project and other sentinels by name. */
  private fromToolPatch(p: ToolPatch): SentinelPatch {
    const idOf = (ref: string): string => this.get(ref)?.id ?? ref;
    const trigger = p.trigger?.kind === 'after' ? { ...p.trigger, sentinelId: idOf(p.trigger.sentinelId) } : p.trigger;
    return {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.project !== undefined ? { projectId: p.project } : {}),
      ...(trigger ? { trigger } : {}),
      ...(p.steps ? { steps: p.steps.map((st) => toolStep(st.kind === 'trigger' ? { ...st, sentinelId: idOf(st.sentinelId) } : st)) } : {}),
      ...(p.access ? { access: p.access } : {}),
      ...(p.limits ? { limits: p.limits } : {}),
      ...(p.notify ? { notify: p.notify } : {}),
      ...(p.keepChats ? { keepChats: p.keepChats } : {}),
    };
  }

  private claudeTurn(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.inUse++;
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          this.inUse--;
          this.pump();
        });
      };
      if (this.inUse < this.runAtOnce) return grant();
      this.waiters.push(grant);
      signal.addEventListener(
        'abort',
        () => {
          const at = this.waiters.indexOf(grant);
          if (at >= 0) this.waiters.splice(at, 1);
        },
        { once: true },
      );
    });
  }

  private pump(): void {
    while (this.inUse < this.runAtOnce && this.waiters.length) this.waiters.shift()!();
  }

  private onAction(a: Action): void {
    if (a.type !== 'board_issue' || this.closed) return;
    const issue = a.issue;
    for (const active of this.active.values()) {
      if (!issue.labels.includes(sentinelLabel(active.sentinel)) || issue.createdAt < active.run.startedAt || active.run.tasks.includes(issue.key)) continue;
      active.run = { ...active.run, tasks: [...active.run.tasks, issue.key] };
      this.record(active.run);
    }
  }

  private nextAtOf(s: Sentinel): number | undefined {
    if (s.paused || s.trigger.kind !== 'schedule') return undefined;
    return nextRunAt(s.trigger, s.lastScheduledAt, this.now(), this.deps.tz);
  }

  private put(s: Sentinel): void {
    const at = this.nextAtOf(s);
    this.ensureSecret(s);
    this.deps.store.dispatch({ type: 'sentinel_put', item: s, ...(at !== undefined ? { nextAt: at } : {}) });
    this.save();
    if (isEventTrigger(s.trigger) || this.triggers?.watching().includes(s.id)) this.triggers?.sync(this.items);
  }

  private replace(next: Sentinel): void {
    this.items = this.items.map((i) => (i.id === next.id ? next : i));
    this.put(next);
  }

  private record(run: Run): void {
    this.recordSummary(toSummary(run));
  }

  private recordSummary(summary: RunSummary): void {
    // A deleted sentinel's run (one that ends after the delete) isn't kept: nothing shows it.
    if (!this.items.some((i) => i.id === summary.sentinelId)) return;
    const at = this.runs.findIndex((r) => r.id === summary.id);
    this.runs = at >= 0 ? this.runs.map((r, n) => (n === at ? summary : r)) : [...this.runs, summary];
    this.deps.store.dispatch({ type: 'sentinel_run', run: summary });
    this.save();
    if (!isLive(summary.state)) {
      if (this.outputs && this.dashboards) this.syncOutputs(summary.sentinelId);
      const waiters = this.endWaiters.get(summary.id);
      this.endWaiters.delete(summary.id);
      for (const w of waiters ?? []) w();
    }
  }

  /**
   * Put away the conversations of a sentinel's ended runs it doesn't keep (BLG-566, `keepChats`): an
   * hourly sentinel's chats don't pile up, and a run's report and outputs stay on its page. The run
   * says so (`putAway`), so its page doesn't offer a chat that's gone.
   */
  private tidyChats(s: Sentinel): void {
    const putAway = this.deps.places?.putAway;
    if (!putAway) return;
    const keep = s.keepChats ?? DEFAULT_KEEP_CHATS;
    const mine = this.runs.filter((r) => r.sentinelId === s.id && !r.putAway && chatsOf(r).length);
    const latest = [...mine].reverse().find((r) => !isLive(r.state))?.id;
    for (const r of mine) if (!keepsChat(keep, r, latest)) this.putAwayChats(r);
  }

  private putAwayChats(run: RunSummary): void {
    const putAway = this.deps.places?.putAway;
    if (!putAway) return;
    for (const channel of chatsOf(run)) void putAway(channel).catch(() => undefined);
    const now = this.runs.find((r) => r.id === run.id);
    if (now) this.recordSummary({ ...now, putAway: true });
  }

  /**
   * Delete what a run left, as you asked (BLG-577). `chat`: its agents' conversations, for good (the
   * run, its report and outputs stay). `run`: those, and the run itself: its folder (report, outputs,
   * documents) and its line in the history. A worktree it made stays (it's work, archived or not on
   * its own); numbers it kept stay on their charts. Not while it runs: stop it first.
   */
  async runDelete(runId: string, what: RunDeleteWhat): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw new Error('That run is gone (only the last 200 of each sentinel are kept)');
    if (isLive(run.state)) throw new Error(run.state === 'needs-you' ? 'This run waits for you: Merge it or Not Now first' : 'This run is still going: stop it first');
    const deleteChat = this.deps.places?.deleteChat;
    for (const channel of run.chatDeleted ? [] : chatsOf(run)) await deleteChat?.(channel).catch(() => undefined);
    if (what === 'chat') {
      const now = this.runs.find((r) => r.id === runId);
      if (now && !now.chatDeleted) this.recordSummary({ ...now, putAway: true, chatDeleted: true });
      return;
    }
    this.runs = this.runs.filter((r) => r.id !== runId);
    this.folders.remove(runId);
    this.deps.store.dispatch({ type: 'sentinel_runs_gone', ids: [runId] });
    this.save();
  }

  /**
   * Delete several of a sentinel's runs at once (your agent's sentinel_delete_runs, always through your
   * approval): by id, or those that ended in a state and/or started before a time → how many.
   */
  async runsDelete(ref: string, which: RunsWhich, what: RunDeleteWhat): Promise<number> {
    const s = this.need(ref);
    const ids = which.runs ? new Set(which.runs) : undefined;
    const picked = this.runs.filter((r) => r.sentinelId === s.id && !isLive(r.state) && (!ids || ids.has(r.id)) && (!which.state || r.state === which.state) && (which.before === undefined || r.startedAt < which.before) && (what === 'run' || (!r.chatDeleted && chatsOf(r).length > 0)));
    for (const r of picked) await this.runDelete(r.id, what);
    return picked.length;
  }

  private prune(): void {
    const { kept, gone } = pruneRuns(this.runs);
    if (!gone.length) return;
    // A run that goes takes its conversations with it: else they'd show up as anyone's chats.
    for (const id of gone) {
      const r = this.runs.find((x) => x.id === id);
      if (r && !r.putAway) for (const channel of chatsOf(r)) void this.deps.places?.putAway?.(channel).catch(() => undefined);
    }
    this.runs = kept;
    for (const id of gone) this.folders.remove(id);
    this.save();
  }

  /**
   * Run folders no run in the index has (a deleted sentinel's, pruned ones Beluga closed before
   * removing); never the runs an earlier load set aside (sentinel.dropped-*.json), and nothing at all
   * while an unreadable sentinel.json is kept beside it.
   */
  private sweepFolders(): void {
    const root = this.folders.root;
    if (!root) return;
    const aside = this.file.setAside();
    if (aside.all) return;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    const ids = new Set([...this.runs.map((r) => r.id), ...aside.ids]);
    for (const name of names) if (!ids.has(name)) this.folders.remove(name);
  }

  private save(): void {
    this.file.save(() => ({ runAtOnce: this.runAtOnce, items: this.items, runs: this.runs, cursors: this.cursors, secrets: this.secrets, signingSecrets: this.signingSecrets }));
  }

  private projectIdOf(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    const projects = this.deps.store.getState().projects;
    const p = projects.find((x) => x.id === ref) ?? projects.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!p) throw new Error(`There's no project ${ref}`);
    return p.id;
  }

  /** Steps with their ids, names and defaults, each one the access allows. */
  private stepsOf(drafts: readonly StepDraft[], access: Sentinel['access']): Step[] {
    const steps = drafts.map((d) => {
      const parsed = StepInputSchema.parse(d);
      // An action column's sentinel is kept by its id (it may be given by name).
      const own = parsed.kind === 'measure' ? { metrics: parsed.metrics.map((m) => (m.columns?.some((c) => c.type === 'action' && c.sentinel) ? { ...m, columns: m.columns.map((c) => (c.type === 'action' && c.sentinel ? { ...c, sentinel: this.get(c.sentinel)?.id ?? c.sentinel } : c)) } : m)) } : {};
      return { ...parsed, ...own, id: parsed.id ?? short('st', 4), name: oneLine(parsed.name ?? '', 80) || STEP_INFO[parsed.kind].label } as Step;
    });
    this.checkAccess(steps, access);
    return steps;
  }

  private checkAccess(steps: readonly Step[], access: Sentinel['access']): void {
    for (const st of steps) {
      const where = st.kind === 'claude' ? st.where : undefined;
      if (!accessAllows(access, st.kind, where)) throw new Error(`“${st.name}” needs ${ACCESS_INFO[accessNeeded(st.kind, where)].label} access; this sentinel has ${ACCESS_INFO[access].label}`);
    }
  }

  /** Beluga's own data for templates: open tasks (as task_list prints them), worktrees, plans. */
  private belugaData(projectId: string | undefined): { tasks: string; worktrees: string; plans: string } {
    const st = this.deps.store.getState();
    const tasks = st.board.enabled ? describeList(filterIssues(st.board, { scope: 'all', selfId: this.deps.selfId(), ...(projectId ? { repos: [projectId] } : {}) }).filter((i) => isOpen(i.status))) : '';
    const projects = st.projects.filter((p) => !projectId || p.id === projectId);
    const worktrees = projects.flatMap((p) => p.workspaces.filter((w) => w.kind === 'worktree' && !w.archived).map((w) => `${p.name}/${w.name}${w.branch ? ` (${w.branch})` : ''}`)).join('\n');
    const plans = st.plans.plans.filter((p) => (!projectId || p.projectId === projectId) && p.status !== 'done' && !p.movedTo).map((p) => `${planTitle(p)} · ${p.status}`).join('\n');
    return { tasks, worktrees, plans };
  }

  // ------------------------------------------------------------------ numbers and dashboards (§10)

  /** Each sentinel's metrics from their files: the last 90 points and the last rows. A sentinel that's gone has its numbers swept (not after a lossy load). */
  private loadMetrics(sweep: boolean): void {
    const ids = new Set(this.items.map((i) => i.id));
    for (const { sentinelId, names } of this.metricFiles.list()) {
      if (!ids.has(sentinelId)) {
        if (sweep) this.metricFiles.remove(sentinelId);
        continue;
      }
      const meta = this.metricFiles.meta(sentinelId);
      for (const name of names) {
        const lines = this.metricFiles.read(sentinelId, name);
        if (!lines.length) continue;
        const m = meta[name];
        const lastRows = [...lines].reverse().find((l) => l.rows || l.series || l.output);
        this.metrics[sentinelId] = {
          ...this.metrics[sentinelId],
          [name]: {
            sentinelId,
            name,
            label: m?.label ?? labelOf(name),
            unit: m?.unit ?? 'count',
            better: m?.better ?? 'up',
            kind: m?.kind ?? (lastRows?.rows ? 'rows' : lastRows?.series ? 'series' : lastRows?.output ? 'output' : 'number'),
            ...(m?.columnTypes?.length ? { columnTypes: m.columnTypes } : {}),
            points: lines.slice(-POINTS_IN_STATE).map(pointOf),
            ...(lastRows?.rows ? { rows: lastRows.rows, columns: lastRows.columns ?? Object.keys(lastRows.rows[0] ?? {}) } : {}),
            ...(lastRows?.series ? { series: lastRows.series } : {}),
            ...(lastRows?.output ? { output: lastRows.output } : {}),
            ...(lastRows ? { rowsAt: lastRows.at, rowsRunId: lastRows.runId } : {}),
          },
        };
      }
    }
  }

  /** A run's numbers, kept: in their files, in the state, and (the first ever) on a dashboard made for you. */
  private keepNumbers(s: Sentinel, runId: string, measured: readonly Measured[]): void {
    if (!this.items.some((i) => i.id === s.id)) return;
    const at = this.now();
    // The names this run's documents took (two metrics' documents never share one).
    const taken = new Set<string>();
    for (const m of measured) {
      const name = metricName(m.name);
      const was = this.metrics[s.id]?.[name];
      let rows = m.rows ? cellRows(m.rows as Record<string, unknown>[]).slice(0, ROWS_KEPT) : undefined;
      // A typed document column's values go to the run's folder (files/, readable only by you): the cell keeps the name.
      if (rows && m.columnTypes?.some((c) => isDocumentKind(c.type))) {
        const docs = takeDocuments(rows, m.columnTypes, taken);
        for (const f of docs.files) this.folders.writeDocument(runId, f.name, f.data);
        rows = docs.rows;
      }
      // An output is kept as said (it was redacted with the step's output); a series as its points.
      const output = m.output ? { text: redactSecrets(m.output.text), format: m.output.format } : undefined;
      const pts = m.series?.length ? m.series : undefined;
      const kind = rows ? 'rows' : pts ? 'series' : output ? 'output' : 'number';
      if (!rows && !pts && !output && m.value === undefined) continue;
      const columnTypes = rows ? m.columnTypes : undefined;
      const meta = { label: oneLine(m.label ?? was?.label ?? labelOf(m.name), 80), unit: m.unit ?? was?.unit ?? 'count', better: m.better ?? was?.better ?? (kind === 'number' || kind === 'series' ? 'up' : 'none'), kind, ...(columnTypes?.length ? { columnTypes } : {}) } as const;
      this.metricFiles.setMeta(s.id, name, meta);
      const line: MetricLine = rows ? { at, runId, rows, columns: m.columns?.length ? [...m.columns] : Object.keys(rows[0] ?? {}) } : pts ? { at, runId, series: pts } : output ? { at, runId, output } : { at, runId, value: m.value! };
      this.metricFiles.append(s.id, name, line, kind === 'output' ? OUTPUT_LINES_KEPT : undefined);
      // The latest rows, series or output: this run's, or what the metric had (it was a number before).
      const latest = rows ? { rows, columns: line.columns ?? [] } : pts ? { series: pts } : output ? { output } : undefined;
      const kept = latest ?? (was && (was.rows || was.series || was.output) ? { ...(was.rows ? { rows: was.rows, columns: was.columns ?? [] } : {}), ...(was.series ? { series: was.series } : {}), ...(was.output ? { output: was.output } : {}) } : undefined);
      const when = latest ? { rowsAt: at, rowsRunId: runId } : { ...(was?.rowsAt ? { rowsAt: was.rowsAt } : {}), ...(was?.rowsRunId ? { rowsRunId: was.rowsRunId } : {}) };
      const series: MetricSeries = {
        sentinelId: s.id,
        name,
        ...meta,
        points: [...(was?.points ?? []), pointOf(line)].slice(-POINTS_IN_STATE),
        ...(kept ? { ...kept, ...when } : {}),
      };
      this.metrics = { ...this.metrics, [s.id]: { ...this.metrics[s.id], [name]: series } };
      this.deps.store.dispatch({ type: 'sentinel_metric', metric: series });
    }
    this.dashboards.autoMake(this.allMetrics());
    this.sweepDocuments(s);
  }

  /** Documents the phone is streaming (documentBytes): a couple of minutes each, in memory only. */
  private readonly docCache = new Map<string, { readonly doc: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }; readonly until: number }>();

  /** How many days a sentinel's documents are kept: the longest any of its Keep the numbers steps asks (14 by default). */
  private filesKeepDays(s: Sentinel): number {
    const days = s.steps.flatMap((st) => (st.kind === 'measure' && st.filesKeepDays ? [st.filesKeepDays] : []));
    return days.length ? Math.max(...days) : FILES_KEEP_DAYS;
  }

  /** A sentinel's documents older than its days go (the rest of each run's folder stays). */
  private sweepDocuments(s: Sentinel): void {
    const before = this.now() - this.filesKeepDays(s) * 24 * 60 * 60_000;
    for (const r of this.runs) if (r.sentinelId === s.id && (r.endedAt ?? r.startedAt) < before && this.folders.hasDocuments(r.id)) this.folders.removeDocuments(r.id);
  }

  /**
   * A typed cell of a metric's latest rows, checked: the column is typed so, and the value is one its
   * rows hold (nothing else can be named: no path or bucket comes from the screen).
   */
  private typedCell(sentinel: string, metric: string, column: string, value: string, kinds: (c: MetricColumn) => boolean): { readonly s: Sentinel; readonly m: MetricSeries; readonly col: MetricColumn } {
    const s = this.need(sentinel);
    const m = this.metrics[s.id]?.[metric];
    if (!m?.rows) throw new Error(`“${s.name}” keeps no rows called ${metric}`);
    const col = m.columnTypes?.find((c) => c.key === column);
    if (!col || !kinds(col)) throw new Error(`${column} isn’t a document column of ${m.label}`);
    if (!m.rows.some((r) => r[column] === value)) throw new Error(`${m.label} has no ${column} “${value}” in its latest rows`);
    return { s, m, col };
  }

  /**
   * An action cell's button: the sentinel its column names runs now (as your Run Now does), with the
   * row as its trigger's payload. The row must be one of the metric's latest rows.
   */
  runRow(sentinel: string, metric: string, column: string, row: Readonly<Record<string, unknown>>, by: 'you' | 'phone'): RunSummary {
    const s = this.need(sentinel);
    const m = this.metrics[s.id]?.[metric];
    if (!m?.rows) throw new Error(`“${s.name}” keeps no rows called ${metric}`);
    const col = m.columnTypes?.find((c) => c.key === column && c.type === 'action');
    if (!col?.sentinel) throw new Error(`${column} isn’t an action column of ${m.label}`);
    // The whole row (the Mac's), or the columns a phone shows: either names one of the latest rows.
    const exact = m.rows.find((r) => sameRow(r, row));
    const alike = exact ? [exact] : m.rows.filter((r) => Object.keys(row).length > 0 && Object.entries(row).every(([k, v]) => (r[k] ?? null) === (v ?? null)));
    const kept = alike.length === 1 ? alike[0] : undefined;
    if (!kept) throw new Error(alike.length > 1 ? `Several of ${m.label}’s rows look like that one: run it from the Mac` : `That row isn’t in ${m.label}’s latest rows any more: refresh and try again`);
    const target = this.need(col.sentinel);
    const words = col.button?.trim() || col.label?.trim() || `Run ${target.name}`;
    return this.start(target.id, by, { kind: 'manual', summary: `You pressed “${words}” on a row of ${m.label}`, payload: { row: kept, sentinel: s.name, metric: m.label } }, [s.id]);
  }

  /**
   * A document a typed column kept: its name, kind and contents (text for text, base64 for the rest).
   * `max`: the most that may go (the phone's frame): text over it is cut, other bytes over it aren't sent.
   */
  document(sentinel: string, metric: string, column: string, name: string, max = 20 * 1024 * 1024): DocumentRead {
    const { s, m } = this.typedCell(sentinel, metric, column, name, (c) => isDocumentKind(c.type));
    const runId = m.rowsRunId ?? '';
    const bytes = runId ? this.folders.readDocument(runId, name) : undefined;
    if (!bytes) throw new Error(`${name} is no longer kept: “${s.name}” keeps its documents ${this.filesKeepDays(s)} days`);
    const read = documentRead(name, documentMime(name), bytes, max);
    if (!read) throw new Error(`${name} is too big to show here (${Math.round(bytes.byteLength / 1024)} KB): open it on the Mac`);
    return { ...read, runId, ...(m.rowsAt ? { at: m.rowsAt } : {}) };
  }

  /**
   * A storage cell's object, fetched now through a link signed for about a minute (the link isn't
   * kept, nor are the bytes): as a kept document reads, for Beluga's viewer. One too big to show
   * comes back with its name, kind and size only.
   */
  async storageDocument(sentinel: string, metric: string, column: string, value: string, max = 20 * 1024 * 1024): Promise<DocumentRead & { readonly bucket: string; readonly path: string }> {
    const { m } = this.typedCell(sentinel, metric, column, value, (c) => c.type === 'storage');
    const { name, mime, bytes, bucket, path: objectPath } = await this.fetchStorage(sentinel, metric, column, value);
    const read = documentRead(name, mime, bytes, max) ?? { name, mime, size: bytes.byteLength, tooBig: true as const };
    return { ...read, runId: m.rowsRunId ?? '', ...(m.rowsAt ? { at: m.rowsAt } : {}), bucket, path: objectPath };
  }

  /**
   * A storage cell's object saved on this Mac, to open in its own app or show in Finder (you asked
   * to): a copy in its run's files, readable only by you, swept with the run's documents.
   */
  async storagePath(sentinel: string, metric: string, column: string, value: string): Promise<string> {
    const { s, m } = this.typedCell(sentinel, metric, column, value, (c) => c.type === 'storage');
    const { name, bytes } = await this.fetchStorage(sentinel, metric, column, value);
    const copy = safeFileName(`storage-${name}`);
    const file = m.rowsRunId && this.folders.writeDocument(m.rowsRunId, copy, bytes) ? this.folders.documentPath(m.rowsRunId, copy) : undefined;
    if (!file) throw new Error(`Couldn’t save ${name} on this Mac for “${s.name}”`);
    return file;
  }

  /**
   * A typed cell's bytes for the phone, which streams them a piece at a time (companion/files.ts): a
   * kept document from its run's files, or a storage object fetched now. Held in memory for a couple
   * of minutes so its pieces don't fetch it again; never written anywhere.
   */
  async documentBytes(sentinel: string, metric: string, column: string, value: string): Promise<{ readonly name: string; readonly mime: string; readonly bytes: Uint8Array }> {
    const key = `${sentinel}\u0000${metric}\u0000${column}\u0000${value}`;
    const now = this.now();
    for (const [k, v] of this.docCache) if (v.until < now) this.docCache.delete(k);
    const hit = this.docCache.get(key);
    if (hit) return hit.doc;
    const { s, m, col } = this.typedCell(sentinel, metric, column, value, (c) => isDocumentKind(c.type) || c.type === 'storage');
    let doc: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array };
    if (col.type === 'storage') doc = await this.fetchStorage(sentinel, metric, column, value);
    else {
      const bytes = m.rowsRunId ? this.folders.readDocument(m.rowsRunId, value) : undefined;
      if (!bytes) throw new Error(`${value} is no longer kept: “${s.name}” keeps its documents ${this.filesKeepDays(s)} days`);
      doc = { name: value, mime: documentMime(value), bytes };
    }
    this.docCache.set(key, { doc, until: now + DOC_CACHE_MS });
    // The oldest go first past a few documents' worth.
    let total = [...this.docCache.values()].reduce((n, v) => n + v.doc.bytes.byteLength, 0);
    for (const [k, v] of this.docCache) {
      if (total <= DOC_CACHE_BYTES || k === key) break;
      total -= v.doc.bytes.byteLength;
      this.docCache.delete(k);
    }
    return doc;
  }

  /**
   * Everything a sentinel keeps, for you to look at and take out (BLG-392): each metric with how many
   * lines it keeps and since when, and each run that kept files (its report, each step's output, its
   * documents), newest first. Never a path, nor a trigger's payload.
   */
  dataList(sentinel: string): SentinelData {
    const s = this.need(sentinel);
    const metrics = Object.values(this.metrics[s.id] ?? {}).map((m) => {
      const lines = this.metricFiles.read(s.id, m.name);
      return { name: m.name, label: m.label, kind: m.kind, unit: m.unit, lines: lines.length, ...(lines.length ? { first: lines[0]!.at, last: lines.at(-1)!.at } : {}), ...(m.kind === 'rows' ? { rows: lines.reduce((n, l) => n + (l.rows?.length ?? 0), 0) } : {}) };
    });
    const runs = this.runs
      .filter((r) => r.sentinelId === s.id)
      .sort((a, b) => b.startedAt - a.startedAt)
      .flatMap((r) => {
        const files = this.folders.list(r.id).map((f) => {
          const step = /^step-(\d+)\.txt$/.exec(f.name);
          const label = f.name === 'report.md' ? 'Report' : step ? (s.steps.find((x) => x.id === r.steps[Number(step[1]) - 1]?.id)?.name ?? `Step ${step[1]}`) : f.name.slice(FILES_DIR.length + 1);
          return { name: f.name, label, kind: f.name === 'report.md' ? ('report' as const) : step ? ('step' as const) : ('document' as const), size: f.size };
        });
        return files.length ? [{ runId: r.id, at: r.endedAt ?? r.startedAt, headline: r.headline, state: r.state, files }] : [];
      });
    return { metrics, runs, keepsDays: this.filesKeepDays(s) };
  }

  /** A run's file as you read its name: a document's own, the report, a step's by the step ("Ask Stripe.txt"). */
  private runFileName(r: RunSummary, name: string): string {
    if (name.startsWith(`${FILES_DIR}/`)) return name.slice(FILES_DIR.length + 1);
    const step = /^step-(\d+)\.txt$/.exec(name);
    const s = this.items.find((x) => x.id === r.sentinelId);
    const called = step ? s?.steps.find((x) => x.id === r.steps[Number(step[1]) - 1]?.id)?.name : undefined;
    return step ? `${(called ?? `Step ${step[1]}`).replace(/[/\\:*?"<>|]+/g, '-')}.txt` : name === 'report.md' ? 'Report.md' : name;
  }

  /** A run's file as the viewer reads it: a report or a step's output redacted as everywhere, a document as kept. */
  runFile(runId: string, name: string, max = 20 * 1024 * 1024): DocumentRead {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) throw new Error('That run is gone (only the last 200 of each sentinel are kept)');
    const bytes = this.folders.readListed(runId, name);
    if (!bytes) throw new Error(`${name} is no longer kept`);
    const doc = name.startsWith(`${FILES_DIR}/`);
    const shown = this.runFileName(r, name);
    const mime = runFileMime(name);
    const data = doc ? bytes : new TextEncoder().encode(redactSecrets(new TextDecoder().decode(bytes)));
    const read = documentRead(shown, mime, data, max) ?? { name: shown, mime, size: data.byteLength, tooBig: true as const };
    return { ...read, runId, at: r.endedAt ?? r.startedAt };
  }

  /** A run's file's bytes for the phone, which streams them (text redacted, as runFile reads it). */
  runFileBytes(runId: string, name: string): { readonly name: string; readonly mime: string; readonly bytes: Uint8Array } {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) throw new Error('That run is gone');
    const bytes = this.folders.readListed(runId, name);
    if (!bytes) throw new Error(`${name} is no longer kept`);
    const doc = name.startsWith(`${FILES_DIR}/`);
    const shown = this.runFileName(r, name);
    return { name: shown, mime: runFileMime(name), bytes: doc ? bytes : new TextEncoder().encode(redactSecrets(new TextDecoder().decode(bytes))) };
  }

  /** Where a run's file is on this Mac, to open or show in Finder (none in memory). */
  runFilePath(runId: string, name: string): string {
    if (!this.runs.some((x) => x.id === runId)) throw new Error('That run is gone');
    const file = this.folders.listedPath(runId, name);
    if (!file || !this.folders.readListed(runId, name)) throw new Error(`${name} is no longer kept`);
    return file;
  }

  /** A metric's whole history as CSV or JSON (data-export.ts): its file's name and text. */
  metricExport(sentinel: string, name: string, format: ExportFormat): { readonly name: string; readonly mime: string; readonly text: string } {
    const { metric, lines } = this.metricRead(sentinel, name);
    const s = this.need(sentinel);
    return { name: exportName(s.name, metric.label, format), mime: format === 'csv' ? 'text/csv' : 'application/json', text: redactSecrets(metricExport(metric.kind, lines, format)) };
  }

  /**
   * Take it out: a metric's history (CSV or JSON), or a run's files (a folder), written to Downloads
   * (Beluga/<sentinel>/), where you can reach it → where it went, for Finder. Asked for, so it stays.
   */
  dataExport(sentinel: string, what: { readonly metric: string; readonly format: ExportFormat } | { readonly runId: string }): string {
    const s = this.need(sentinel);
    const base = path.join(this.deps.home ?? os.homedir(), 'Downloads', 'Beluga', s.name.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 80) || s.id);
    mkdirSync(base, { recursive: true });
    if ('metric' in what) {
      const out = this.metricExport(s.id, what.metric, what.format);
      const file = freeName(base, out.name);
      writeFileSync(file, out.text);
      return file;
    }
    const r = this.runs.find((x) => x.id === what.runId && x.sentinelId === s.id);
    if (!r) throw new Error('That run is gone');
    const stamp = new Date(r.endedAt ?? r.startedAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    const dir = freeName(base, `Run ${stamp}`);
    mkdirSync(dir, { recursive: true });
    for (const f of this.folders.list(r.id)) {
      const doc = f.name.startsWith(`${FILES_DIR}/`);
      const bytes = this.folders.readListed(r.id, f.name);
      if (!bytes) continue;
      const step = /^step-(\d+)\.txt$/.exec(f.name);
      const named = doc ? f.name.slice(FILES_DIR.length + 1) : step ? `${step[1]} ${(s.steps.find((x) => x.id === r.steps[Number(step[1]) - 1]?.id)?.name ?? 'Step').replace(/[/\\:*?"<>|]+/g, '-')}.txt` : f.name;
      writeFileSync(freeName(dir, named), doc ? bytes : redactSecrets(new TextDecoder().decode(bytes)));
    }
    return dir;
  }

  /** Where a sentinel's numbers are, or a run's folder, for Show in Finder (none in memory). */
  dataFolder(sentinel: string, runId?: string): string {
    const s = this.need(sentinel);
    const dir = runId ? (this.runs.some((x) => x.id === runId && x.sentinelId === s.id) ? this.folders.folder(runId) : undefined) : this.metricFiles.root ? path.join(this.metricFiles.root, safeName(s.id)) : undefined;
    if (!dir || !existsSync(dir)) throw new Error(runId ? 'That run kept no files on this Mac' : `“${s.name}” keeps no numbers on this Mac yet`);
    return dir;
  }

  private async fetchStorage(sentinel: string, metric: string, column: string, value: string): Promise<{ readonly name: string; readonly mime: string; readonly bytes: Uint8Array; readonly bucket: string; readonly path: string }> {
    const obj = splitStorage(value);
    if (!obj) throw new Error(`“${value}” isn’t a bucket and a path`);
    const { url } = await this.signStorage(sentinel, metric, column, value);
    const res = await (this.deps.fetch ?? fetch)(url);
    const name = storageName(value);
    if (!res.ok) throw new Error(`Supabase Storage answered ${res.status} for ${name}`);
    const size = Number(res.headers.get('content-length') ?? 0);
    if (size > STORAGE_MAX) throw new Error(`${name} is ${sizeWords(size)}: too big to fetch here`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > STORAGE_MAX) throw new Error(`${name} is ${sizeWords(bytes.byteLength)}: too big to fetch here`);
    // Its name says what it is; Storage's own type when the name doesn't.
    const said = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const byName = documentMime(name);
    return { name, mime: byName === 'application/octet-stream' && said ? said : byName, bytes, bucket: obj.bucket, path: obj.path };
  }

  /** Where a kept document is on this Mac, to open it in its own app (the Mac only: never to the phone). */
  documentPath(sentinel: string, metric: string, column: string, name: string): string {
    const { m } = this.typedCell(sentinel, metric, column, name, (c) => isDocumentKind(c.type));
    const file = m.rowsRunId ? this.folders.documentPath(m.rowsRunId, name) : undefined;
    if (!file || !this.folders.readDocument(m.rowsRunId!, name)) throw new Error(`${name} is no longer kept`);
    return file;
  }

  /**
   * A storage cell's link, signed now for about a minute with the project's Supabase variables (its
   * URL and service key; the key never leaves this Mac and the link is never kept).
   */
  async signStorage(sentinel: string, metric: string, column: string, value: string): Promise<{ readonly url: string; readonly expiresIn: number }> {
    const { s } = this.typedCell(sentinel, metric, column, value, (c) => c.type === 'storage');
    const obj = splitStorage(value);
    if (!obj) throw new Error(`“${value}” isn’t a bucket and a path`);
    const env = this.deps.envFor?.(this.cwdOfProject(s.projectId)) ?? {};
    const fetchFn = this.deps.fetch ?? fetch;
    const url = await signStorageUrl(env, obj.bucket, obj.path, SIGNED_SECONDS, fetchFn);
    return { url, expiresIn: SIGNED_SECONDS };
  }

  /** Every metric in the state, sentinel by sentinel. */
  private allMetrics(): MetricSeries[] {
    return this.items.flatMap((i) => Object.values(this.metrics[i.id] ?? {}));
  }

  /** metric_list: each sentinel's numbers, with their last value. */
  private metricList(visible: (sentinel: Sentinel) => boolean = () => true): string {
    const all = this.allMetrics();
    if (!all.length) return 'No numbers kept yet: a sentinel keeps them with a Keep the numbers step.';
    return this.items
      .filter((i) => this.metrics[i.id] && visible(i))
      .map((i) => {
        const lines = Object.values(this.metrics[i.id]!).map((m) => {
          const last = m.points.at(-1);
          const now = m.kind === 'rows' ? `${m.rows?.length ?? 0} rows (columns ${(m.columns ?? []).join(', ')})` : m.kind === 'series' ? `${m.series?.length ?? 0} points` : m.kind === 'output' ? `an output (${m.output?.format ?? 'text'})` : last ? formatMetric(last.value, m.unit) : 'none yet';
          return `  - ${m.name}: ${m.label} · ${m.kind === 'number' ? `${m.unit}, better ${m.better}` : m.kind} · last ${now}${last ? ` on ${new Date(last.at).toLocaleDateString()}` : ''} · ${m.points.length} recent points`;
        });
        return [`${i.name} (id ${i.id}, ${i.paused ? 'paused' : 'on'}, \`sentinel:${i.id}\`):`, ...lines].join('\n');
      })
      .join('\n');
  }

  /** A metric's points since then (the whole file: two years at most), oldest first. */
  metricRead(sentinel: string, name: string, since?: number): { readonly metric: MetricSeries; readonly lines: MetricLine[] } {
    const s = this.need(sentinel);
    const metric = this.metrics[s.id]?.[name] ?? Object.values(this.metrics[s.id] ?? {}).find((m) => m.label.toLowerCase() === name.trim().toLowerCase());
    if (!metric) throw new Error(`“${s.name}” keeps no number called ${name}${this.metrics[s.id] ? ` (it keeps ${Object.keys(this.metrics[s.id]!).join(', ')})` : ''}`);
    return { metric, lines: this.metricFiles.read(s.id, metric.name, since) };
  }

  /**
   * Refresh: Run Now on each sentinel a dashboard draws from, in order, one at a time (a paused one
   * is left as it is), the state saying how far ("Fetching… 2 of 3"). → how many it runs; it goes on
   * by itself.
   */
  refresh(ref: string): { readonly total: number } {
    const d = this.dashboards.need(ref);
    if (this.refreshing[d.id]) return { total: this.refreshing[d.id]!.total };
    const ids = dashboardSentinels(d).filter((id) => this.items.some((i) => i.id === id && !i.paused));
    if (!ids.length) return { total: 0 };
    const set = (r: DashboardRefresh | undefined): void => {
      if (r) this.refreshing = { ...this.refreshing, [d.id]: r };
      else {
        const { [d.id]: _was, ...rest } = this.refreshing;
        this.refreshing = rest;
      }
      if (!this.closed) this.deps.store.dispatch({ type: 'sentinel_refresh', id: d.id, ...(r ? { refreshing: r } : {}) });
    };
    void (async () => {
      for (const [n, id] of ids.entries()) {
        if (this.closed) return;
        set({ done: n, total: ids.length, sentinelId: id });
        let run: RunSummary;
        try {
          run = this.start(id, 'you');
        } catch {
          continue;
        }
        if (isLive(run.state)) await new Promise<void>((resolve) => this.endWaiters.set(run.id, [...(this.endWaiters.get(run.id) ?? []), resolve]));
      }
      set(undefined);
    })();
    return { total: ids.length };
  }

  /**
   * Describe it: your Claude builds a dashboard from your words, in a chat on Your Mac, told the
   * dashboard and every number there is, with its dashboard tools. → the conversation.
   */
  dashboardAsk(ref: string, text: string): { readonly channel: string } {
    const d = this.dashboards.need(ref);
    const claude = this.deps.claude;
    const place = this.deps.places?.macChat();
    if (!claude || !place) throw new Error(`Asking ${this.yourAgent(false)} needs the Beluga app with it on`);
    const words = text.trim();
    if (!words) throw new Error('Say what it should show');
    if (this.dashboardAsks[d.id]?.state === 'writing') throw new Error(`${this.yourAgent()} is building “${d.name}” already: wait for it, or open its chat`);
    const { channel } = place;
    this.dashboardChannels.set(channel, d.id);
    const ask: SentinelAsk = { channel, startedAt: this.now(), state: 'writing', text: firstLine(words, 200) };
    const setAsk = (a: SentinelAsk): void => {
      if (!this.dashboards.get(d.id) || this.closed) return;
      this.dashboardAsks = { ...this.dashboardAsks, [d.id]: a };
      this.deps.store.dispatch({ type: 'sentinel_dashboard_ask', id: d.id, ask: a });
    };
    setAsk(ask);
    // What it is now: the sentinels Claude made meanwhile stay on it when it ends.
    const latest = (): SentinelAsk => (this.dashboardAsks[d.id]?.channel === channel ? this.dashboardAsks[d.id]! : ask);
    const requestId = claude.ask(words, channel, words);
    if (!requestId) {
      setAsk({ ...ask, state: 'failed', answer: `${this.yourAgent()} couldn’t be asked there`, endedAt: this.now() });
      throw new Error(`${this.yourAgent()} couldn’t be asked there`);
    }
    let over = false;
    const timer = setTimeout(() => {
      over = true;
      claude.cancel(requestId, `Stopped by Beluga: ${agentName(defaultAgentOf(this.deps.store.getState().self))} took too long`);
      setAsk({ ...latest(), state: 'failed', answer: TOOK_TOO_LONG, endedAt: this.now() });
    }, DEFAULT_LIMITS.minutes * 60_000);
    timer.unref?.();
    void claude.wait(requestId).then(
      (answer) => {
        clearTimeout(timer);
        if (!over) setAsk({ ...latest(), state: 'done', answer: clipLines(answer), endedAt: this.now() });
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!over) setAsk({ ...latest(), state: 'failed', answer: firstLine(redactSecrets(err instanceof Error ? err.message : String(err)), 200) || 'The agent stopped', endedAt: this.now() });
      },
    );
    return { channel };
  }

  // ------------------------------------------------------------------ outputs (output tiles, §10)

  /**
   * The latest output of every step an output tile names, kept in the state (12 KB at most each,
   * from the run's folder, redacted as every run output is): all of them, or one sentinel's after its
   * run ended. Steps no tile names any more are let go.
   */
  private syncOutputs(only?: string, tell = true): void {
    const wanted = outputSteps(this.dashboards.list());
    const keys = new Set(wanted.map((r) => `${r.sentinelId}/${r.stepId}`));
    for (const [sid, steps] of Object.entries(this.outputs)) for (const stepId of Object.keys(steps)) if (!keys.has(`${sid}/${stepId}`)) this.setOutput(sid, stepId, undefined, tell);
    for (const r of wanted) {
      if (only && r.sentinelId !== only) continue;
      const next = this.latestOutput(r);
      const was = this.outputs[r.sentinelId]?.[r.stepId];
      if (next?.runId === was?.runId && next?.text === was?.text) continue;
      this.setOutput(r.sentinelId, r.stepId, next, tell);
    }
  }

  private setOutput(sentinelId: string, stepId: string, output: StepOutput | undefined, tell: boolean): void {
    const { [stepId]: _was, ...rest } = this.outputs[sentinelId] ?? {};
    const mine = output ? { ...rest, [stepId]: output } : rest;
    const { [sentinelId]: _old, ...others } = this.outputs;
    this.outputs = Object.keys(mine).length ? { ...others, [sentinelId]: mine } : others;
    if (tell && !this.closed) this.deps.store.dispatch({ type: 'sentinel_output', sentinelId, stepId, ...(output ? { output } : {}) });
  }

  /** A step's output from the newest run that ended where that step was done. */
  private latestOutput(r: StepRef): StepOutput | undefined {
    const s = this.items.find((i) => i.id === r.sentinelId);
    const step = s?.steps.find((st) => st.id === r.stepId);
    if (!s || !step || !OUTPUT_STEP_KINDS.has(step.kind)) return undefined;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]!;
      if (run.sentinelId !== s.id || isLive(run.state)) continue;
      const at = run.steps.findIndex((x) => x.id === r.stepId);
      const st = at >= 0 ? run.steps[at] : undefined;
      if (!st || st.state !== 'done') continue;
      const text = this.folders.read(run.id, `step-${at + 1}.txt`);
      if (!text?.trim()) continue;
      const clean = redactSecrets(text);
      return { runId: run.id, at: st.endedAt ?? run.endedAt ?? run.startedAt, format: outputFormat(clean, step.kind), text: clean.slice(0, STEP_OUTPUT_IN_STATE), ...(clean.length > STEP_OUTPUT_IN_STATE ? { cut: true } : {}) };
    }
    return undefined;
  }

  // ------------------------------------------------------------------ the Sentinel chat (§12)

  chatNew = (): { readonly id: string; readonly channel: string } => {
    const id = this.chats.newChat();
    return { id, channel: this.chats.state().chats.find((c) => c.id === id)!.channel };
  };

  chatOpen = (id: string): void => this.chats.openChat(id);

  chatClear = (id: string): void => this.chats.clear(id);

  chatDelete = (id: string): Promise<void> => this.chats.deleteChat(id);

  /** The demo's history: numbers as if a run had kept them (now: the demo's clock travels back). */
  demoKeep(ref: string, runId: string, measured: readonly Measured[]): void {
    this.keepNumbers(this.need(ref), runId, measured);
  }

  /** Dashboards and numbers as Claude's tools: sentinels by id or name; sentinel_measure inside a run only. */
  private dashboardTools(active: ActiveRun | undefined, building?: string, visible?: (sentinel: Sentinel) => boolean): DashboardTools {
    const ref = (sentinel: string, metric: string): MetricRef => {
      const s = this.need(sentinel);
      const name = this.metrics[s.id]?.[metric] ? metric : (Object.values(this.metrics[s.id] ?? {}).find((m) => m.label.toLowerCase() === metric.trim().toLowerCase())?.name ?? metricName(metric));
      return { sentinelId: s.id, metric: name };
    };
    /** A sentinel's step by its id or name (an output tile's). */
    const stepRef = (sentinel: string, step: string): StepRef => {
      const s = this.need(sentinel);
      const st = s.steps.find((x) => x.id === step) ?? s.steps.find((x) => x.name.toLowerCase() === step.trim().toLowerCase()) ?? (/^(claude|http|script)$/.test(step) ? [...s.steps].reverse().find((x) => x.kind === step) : undefined);
      if (!st) throw new Error(`“${s.name}” has no step ${step} (its steps: ${s.steps.map((x) => `${x.name} (${x.id}, ${x.kind})`).join(', ') || 'none'})`);
      if (!OUTPUT_STEP_KINDS.has(st.kind)) throw new Error(`An output tile shows what an Ask your agent, Call a service or Run a script step said; “${st.name}” is ${STEP_INFO[st.kind].label}`);
      return { sentinelId: s.id, stepId: st.id };
    };
    const tileInput = (t: Partial<ToolTile>): Omit<TileInput, 'kind'> => ({
      ...(t.width ? { width: t.width } : {}),
      ...(t.height ? { height: t.height } : {}),
      ...(t.title !== undefined ? { title: t.title } : {}),
      ...(t.sentinel && t.metric ? { metric: ref(t.sentinel, t.metric) } : {}),
      ...(t.metrics?.length ? { metrics: t.metrics.map((m) => ref(m.sentinel, m.metric)) } : {}),
      ...(t.chart ? { chart: t.chart } : {}),
      ...(t.kind === 'output' && t.sentinel && t.step ? { step: stepRef(t.sentinel, t.step) } : {}),
      ...(t.show ? { show: t.show } : {}),
      ...(t.kind === 'text' && t.sentinel ? { sentinelId: this.need(t.sentinel).id } : {}),
      ...(t.text ? { text: t.text } : {}),
      ...(t.compare ? { compare: t.compare } : {}),
      ...(t.columns ? { columns: [...t.columns] } : {}),
    });
    const describe = (d: Dashboard): string => {
      const places = layoutTiles(d.tiles);
      const tiles = d.tiles.map((t) => {
        const at = places.get(t.id);
        const refs = t.metric ? [t.metric] : (t.metrics ?? []);
        const stepName = t.step ? this.get(t.step.sentinelId)?.steps.find((x) => x.id === t.step!.stepId)?.name : undefined;
        const what = t.kind === 'divider' ? `“${t.title ?? ''}”` : t.kind === 'text' ? `${this.get(t.sentinelId ?? '')?.name ?? 'a sentinel that’s gone'} (${t.text ?? 'headline'})` : t.step ? `${this.get(t.step.sentinelId)?.name ?? 'gone'}, step “${stepName ?? 'gone'}” (${t.step.stepId})` : refs.map((r) => `${this.get(r.sentinelId)?.name ?? 'gone'}/${r.metric}`).join(', ');
        const cols = t.columns?.length ? `, columns ${t.columns.map((c) => `${c.key}${c.hidden ? ' (hidden)' : c.label ? ` as “${c.label}”` : ''}`).join(', ')}` : '';
        return `  - ${t.id}: ${TILE_INFO[t.kind].label.toLowerCase()} ${what}${t.title ? ` titled “${t.title}”` : ''}, ${t.width} wide${t.height === 2 ? ', tall' : ''}${at && t.row !== undefined ? `, at column ${at.col}, row ${at.row}` : ''}${t.chart && t.kind === 'series' ? `, ${t.chart}` : ''}${t.compare ? `, ${COMPARE_WORDS[t.compare]}` : ''}${cols}`;
      });
      return [`${d.name} (id ${d.id}) · ${COMPARE_WORDS[d.compare]} · ${d.tiles.length} ${d.tiles.length === 1 ? 'tile' : 'tiles'}`, ...tiles].join('\n');
    };
    return {
      ...(building ? { building } : {}),
      ...(active
        ? {
            measure: (name: string, value: number | string, unit?: string, label?: string) => {
              const n = toNumber(value);
              if (n === undefined) throw new Error(`${String(value)} isn’t a number: keep only real numbers you found`);
              const u = unit === undefined ? undefined : MetricUnitSchema.safeParse(unit);
              if (u && !u.success) throw new Error('unit is count, currency:USD (any currency code), percent, ms, bytes or plain');
              const m: Measured = { name: metricName(name), value: n, ...(u?.success ? { unit: u.data as MetricUnit } : {}), ...(label?.trim() ? { label: oneLine(label, 80) } : {}) };
              active.measured = [...(active.measured ?? []).filter((x) => x.name !== m.name), m];
              const keeps = active.sentinel.steps.some((st) => st.kind === 'measure' && st.from === 'claude');
              return `Noted ${m.label ?? labelOf(m.name)} = ${formatMetric(n, m.unit)}.${keeps ? ' The Keep the numbers step keeps it when you’re done.' : ' This sentinel has no Keep the numbers step from the agent, so it isn’t kept: say so in your report.'}`;
            },
          }
        : {}),
      list: () => (this.dashboards.list().length ? this.dashboards.list().map(describe).join('\n') : 'No dashboards yet: dashboard_create makes one.'),
      create: (name: string) => {
        const d = this.dashboards.create(name);
        return `Made the dashboard “${d.name}” (id ${d.id}); add tiles with dashboard_add_tile.`;
      },
      update: (dashboard: string, patch: { readonly name?: string; readonly compare?: Dashboard['compare'] }) => {
        const d = this.dashboards.update(dashboard, patch);
        return `“${d.name}” (id ${d.id}) now compares ${COMPARE_WORDS[d.compare]}.`;
      },
      // Through the user's approval (never in ALWAYS_OK): the tiles go, the numbers stay.
      remove: (dashboard: string) => {
        const d = this.dashboards.need(dashboard);
        this.dashboards.remove(d.id);
        return `Deleted the dashboard “${d.name}”. Its numbers stay with their sentinels.`;
      },
      moveTile: (dashboard: string, tileId: string, to: number | { readonly col: number; readonly row: number }) => {
        const d = this.dashboards.moveTile(dashboard, tileId, to);
        const t = d.tiles.find((x) => x.id === tileId);
        if (typeof to !== 'number' && t?.row !== undefined) return `Moved tile ${tileId} to column ${(t.col ?? 0) + 1}, row ${t.row + 1} on “${d.name}”.`;
        return `Moved tile ${tileId} to place ${d.tiles.findIndex((x) => x.id === tileId) + 1} of ${d.tiles.length} on “${d.name}”.`;
      },
      addTile: (dashboard: string, t: ToolTile) => {
        const { tile, dashboard: d } = this.dashboards.addTile(dashboard, { kind: t.kind, ...tileInput(t) });
        return `Added ${TILE_INFO[tile.kind].label.toLowerCase()} (tile ${tile.id}) to “${d.name}”; it has ${d.tiles.length} ${d.tiles.length === 1 ? 'tile' : 'tiles'} now.`;
      },
      updateTile: (dashboard: string, tileId: string, patch) => {
        const was = this.dashboards.need(dashboard).tiles.find((t) => t.id === tileId);
        const { compare, ...rest } = patch;
        const input: TilePatch = { ...tileInput({ kind: was?.kind ?? 'number', ...rest }), ...(compare !== undefined ? { compare } : {}) };
        const d = this.dashboards.updateTile(dashboard, tileId, input);
        return `Changed tile ${tileId} on “${d.name}”.`;
      },
      removeTile: (dashboard: string, tileId: string) => {
        const d = this.dashboards.removeTile(dashboard, tileId);
        return `Removed tile ${tileId} from “${d.name}”.`;
      },
      metricList: () => this.metricList(visible),
      metricRead: (sentinel: string, name: string, since?: string) => {
        const from = since ? sinceOf(since, this.now()) : undefined;
        if (since && from === undefined) throw new Error('since is a date (2026-09-01) or a time back (7d, 4w, 3 months)');
        const { metric, lines } = this.metricRead(sentinel, name, from);
        return describePoints(metric, lines);
      },
    };
  }

  // ------------------------------------------------------------------ Claude's tools

  private toolsFor(active: ActiveRun | undefined, asking?: string, onMade?: (sentinelId: string) => void, visible: (sentinel: Sentinel) => boolean = () => true): SentinelTools {
    const line = (s: Sentinel): string => {
      const last = lastRunOf(this.state(), s.id);
      const next = this.nextAtOf(s);
      return `${last ? ` · last run ${last.state}${last.headline ? `: ${last.headline}` : ''}` : ''}${next ? ` · next ${new Date(next).toLocaleString()}` : ''}`;
    };
    return {
      ...(asking ? { asking } : {}),
      ...(active
        ? {
            stop: (reason: string) => {
              active.stopReason = oneLine(reason, 200) || 'nothing to do';
              return 'Noted: this run ends as skipped (nothing to do) when you finish this message. Keep it to one line.';
            },
          }
        : {}),
      list: () => describeSentinels(this.items.filter(visible), line),
      create: (d: ToolDraft) => {
        const { name: _n, ...refs } = this.fromToolPatch({ trigger: d.trigger, steps: d.steps });
        const draft: SentinelDraft = { ...fromToolDraft(d), ...refs };
        const made = (s: Sentinel): string => `Made “${s.name}” (${scheduleSentence(s.trigger)}), paused: \`sentinel:${s.id}\`. Its steps: ${s.steps.map((st) => `${st.name} (step ${st.id})`).join(', ') || 'none'}. It runs once the user turns it on from its page (you can’t).`;
        if (!(draft.steps ?? []).some(isSourceStep)) {
          const s = this.create(draft);
          onMade?.(s.id);
          return made(s);
        }
        // Its sources run once before it's saved: one that can't connect, or whose query fails, saves nothing.
        return (async () => {
          const projectId = this.projectIdOf(draft.projectId ?? undefined);
          const steps = this.stepsOf(draft.steps ?? [], draft.access ?? 'look');
          const checks = await this.checkSources(steps, projectId, true);
          const broken = checks.filter((c) => previewBroken(c.preview));
          if (broken.length) throw new Error(notSaved('Not saved', broken));
          const s = this.create({ ...draft, steps });
          onMade?.(s.id);
          const run = this.recordTest(s, 'claude', checks, `${this.yourAgent()} checked it when setting it up`);
          return `${made(s)}\n\nIts ${checks.length === 1 ? 'source was' : 'sources were'} run once (a test run in its history${run.state === 'done' ? '; what it found is kept, so its tiles fill' : ''}). Show the user this preview before you say it’s done, and fix any flagged column (sentinel_update) or ask them what it means:\n\n${redactSecrets(describePreviews(checks.map((c) => c.preview)))}`;
        })();
      },
      test: async (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t test itself');
        const t = await this.test(s.id, 'claude');
        return `${t.text}${t.runId ? `\n\nThis test is in “${s.name}”’s history (\`sentinel:${s.id}\`); it ${s.paused ? 'stays paused: only the user turns it on' : 'is on'}.` : ''}`;
      },
      trySource: async (source: unknown, project?: string) => {
        const parsed = SourceSchema.safeParse(source);
        if (!parsed.success) throw new Error(`Not a source: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'source'}: ${i.message}`).join('; ')}`);
        const projectId = this.projectIdOf(project);
        const c = await this.checkSource(parsed.data, projectId, true, 'try', 'The source', undefined, TRY_ROWS);
        if (c.preview.state === 'failed') throw new Error(redactSecrets(describePreviews([c.preview])));
        return redactSecrets(describePreviews([c.preview]));
      },
      run: (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t start itself');
        const run = this.start(s.id, 'claude');
        return run.state === 'queued' ? `“${s.name}” is running already: this run waits for it` : run.state === 'skipped' ? `“${s.name}” didn’t run: ${run.headline}` : `Started “${s.name}” (\`sentinel:${s.id}\`)`;
      },
      // Pause-only: Claude never turns a sentinel on (that's the user's, from the Mac or the phone).
      pause: (ref: string) => {
        const was = this.need(ref);
        if (was.paused) return `“${was.name}” is paused already; only the user can turn it on, from its page`;
        const s = this.pause(ref, true);
        return `“${s.name}” is paused; the user can turn it back on from its page`;
      },
      get: (ref: string) => {
        const s = this.need(ref);
        return `“${s.name}” (${scheduleSentence(s.trigger, (id) => this.get(id)?.name)}) ${s.paused ? 'is paused' : 'is on'}${line(s)}. As material:\n${sentinelMaterial(s)}`;
      },
      update: (ref: string, patch: ToolPatch) => {
        if (active?.sentinel.id === this.get(ref)?.id) throw new Error('This run is that sentinel’s: it can’t change itself while it runs');
        const said = (s: Sentinel, paused: boolean): string => {
          const changed = Object.keys(patch).filter((k) => patch[k as keyof ToolPatch] !== undefined);
          return `Changed “${s.name}” (${changed.join(', ') || 'nothing'}): ${scheduleSentence(s.trigger, (id) => this.get(id)?.name)}; ${s.steps.length} ${s.steps.length === 1 ? 'step' : 'steps'}.${paused ? ' It changed what it can do, so it is paused now: the user turns it on again from its page (say so).' : s.paused ? ' It is paused: the user turns it on from its page.' : ''} \`sentinel:${s.id}\``;
        };
        const was = this.need(ref);
        const next = this.fromToolPatch(patch);
        const steps = next.steps ? this.stepsOf(next.steps, next.access ?? was.access) : undefined;
        const moved = next.projectId !== undefined;
        // The sources it adds or changes (all of them in another project) run once before it's saved.
        const changed = (steps ?? (moved ? was.steps : [])).filter((st) => isSourceStep(st) && (moved || sourceOf(was.steps.find((w) => w.id === st.id)) !== sourceOf(st)));
        if (!changed.length) {
          const { sentinel: s, paused } = this.claudeUpdate(ref, patch);
          return said(s, paused);
        }
        return (async () => {
          const projectId = next.projectId === null ? undefined : next.projectId !== undefined ? this.projectIdOf(next.projectId) : was.projectId;
          const checks = await this.checkSources(steps ?? was.steps, projectId, true, new Set(changed.map((st) => st.id)));
          const broken = checks.filter((c) => previewBroken(c.preview));
          if (broken.length) throw new Error(notSaved('Not changed', broken));
          // The steps as checked (their ids kept), so what the preview says is what was saved.
          const { sentinel: s, paused } = this.claudeUpdate(ref, steps ? { ...patch, steps: steps as unknown as ToolPatch['steps'] } : patch);
          return `${said(s, paused)}\n\nThe ${checks.length === 1 ? 'source it changed was' : 'sources it changed were'} run once. Show the user this preview, and fix any flagged column or ask them what it means; sentinel_test keeps what it finds:\n\n${redactSecrets(describePreviews(checks.map((c) => c.preview)))}`;
        })();
      },
      remove: (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t delete itself');
        this.remove(s.id);
        return `Deleted “${s.name}”. Its past runs’ reports go with the next clean-up.`;
      },
      runs: (ref: string) => {
        const s = this.need(ref);
        const mine = this.runs.filter((r) => r.sentinelId === s.id).sort((a, b) => b.startedAt - a.startedAt);
        if (!mine.length) return `“${s.name}” hasn’t run yet.`;
        const lines = mine.slice(0, 100).map((r) => `- ${r.id} · ${new Date(r.startedAt).toLocaleString()} · ${r.state}${r.headline ? ` · ${firstLine(r.headline, 120)}` : ''} · ${chatsOf(r).length && !r.putAway ? 'chat kept' : 'no chat kept'}`);
        return [`“${s.name}”: ${mine.length} run${mine.length === 1 ? '' : 's'}, newest first${mine.length > 100 ? ' (the newest 100)' : ''}. Each has its page and folder (report, outputs).`, ...lines].join('\n');
      },
      deleteRuns: async (ref, which, what) => {
        const s = this.need(ref);
        const before = which.before !== undefined ? sinceOf(which.before, this.now()) : undefined;
        if (which.before !== undefined && before === undefined) throw new Error(`“${which.before}” isn’t a time: say a date (2026-10-01) or how long ago (7d, 2 weeks)`);
        if (which.state !== undefined && !(RUN_STATES as readonly string[]).includes(which.state)) throw new Error(`A run’s state is one of ${RUN_STATES.join(', ')}`);
        if (!which.runs?.length && which.state === undefined && before === undefined) throw new Error('Say which runs: their ids, a state, or before when (all of them: before "0d")');
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: ask from another conversation');
        const n = await this.runsDelete(s.id, { ...(which.runs ? { runs: which.runs } : {}), ...(which.state ? { state: which.state as RunSummary['state'] } : {}), ...(before !== undefined ? { before } : {}) }, what);
        if (!n) return 'No run matched (one still going is never deleted).';
        return what === 'chat' ? `Deleted the agent chats of ${n} run${n === 1 ? '' : 's'} of “${s.name}”. Their reports and outputs stay on their pages.` : `Deleted ${n} run${n === 1 ? '' : 's'} of “${s.name}”: their chats, reports and outputs. Worktrees they made and numbers they kept stay.`;
      },
    };
  }
}

/** What deleting a run takes: its agents' chats only, or the whole run (BLG-577). */
export type RunDeleteWhat = 'chat' | 'run';
/** Which of a sentinel's runs: these ids, those that ended so, those that started before then. */
export interface RunsWhich {
  readonly runs?: readonly string[];
  readonly state?: RunSummary['state'];
  readonly before?: number;
}

/** A run's own chats (a project chat, a Your Mac chat): never its worktree, which keeps its work. */
function chatsOf(run: Pick<RunSummary, 'channel' | 'steps' | 'worktreeId'>): string[] {
  const worktree = run.worktreeId ? `ws:${run.worktreeId}` : undefined;
  const all = [run.channel, ...run.steps.map((s) => s.channel)].filter((c): c is string => Boolean(c) && c !== worktree);
  return [...new Set(all)];
}

/** Runs per day 0 is no limit, the same as none: kept as none. */
function limitsOf(l: Limits): Limits {
  const { perDay, ...rest } = l;
  return perDay ? { ...rest, perDay } : rest;
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Rows a source tried alone (sentinel_try_source) shows: enough for a table's columns. */
const TRY_ROWS = 60;

/** What a check compares to see that a source step changed: its source and what it keeps. */
const sourceOf = (st: Step | undefined): string => (st?.kind === 'measure' ? JSON.stringify([st.source, st.metrics, st.keep]) : '');

/** Setup refused: which sources didn't work, and what to do. */
function notSaved(what: string, broken: readonly SourceCheck[]): string {
  return `${what}: ${broken.length === 1 ? 'a source didn’t work' : `${broken.length} sources didn’t work`}.\n\n${redactSecrets(describePreviews(broken.map((c) => c.preview)))}\n\nFix the query (read the schema first) or the variables (Settings › Environment; leave a postgres source without url or env to use the project’s own), then call it again.`;
}

/** A Keep the numbers step that reads a source (the steps a check before saving, and a test, run). */
const isSourceStep = (st: Pick<Step, 'kind'> & { readonly from?: string }): boolean => st.kind === 'measure' && st.from === 'source';
/** A Keep the numbers step that reads the script step right before it (your test runs both). */
const readsScript = (steps: readonly Step[], i: number): boolean => steps[i]?.kind === 'measure' && (steps[i] as MeasureStep).from === 'previous' && steps[i - 1]?.kind === 'script';
/** A Keep the numbers step's typed columns in the preview's words ("html_content → 6 documents, 81 KB"). */
/** A name in `dir` nothing has yet ("Report.csv", then "Report 2.csv"). */
function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? name : `${stem} ${n}${ext}`);
    if (!existsSync(file)) return file;
  }
}

/** What a sentinel keeps (dataList). */
export interface SentinelData {
  readonly metrics: ReadonlyArray<{ readonly name: string; readonly label: string; readonly kind: MetricKind; readonly unit: MetricUnit; readonly lines: number; readonly first?: number; readonly last?: number; readonly rows?: number }>;
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly at: number; readonly headline: string; readonly state: RunSummary['state']; readonly files: ReadonlyArray<{ readonly name: string; readonly label: string; readonly kind: 'report' | 'step' | 'document'; readonly size: number }> }>;
  /** How many days its documents are kept. */
  readonly keepsDays: number;
}

/** How long, and how much, the documents the phone streams stay in memory. */
const DOC_CACHE_MS = 2 * 60_000;
const DOC_CACHE_BYTES = 80 * 1024 * 1024;

/**
 * A document's contents as the viewer reads them: text for text (cut past `max`), base64 for the rest
 * (none when it's past three quarters of `max`: base64 grows it by a third).
 */
function documentRead(name: string, mime: string, bytes: Uint8Array, max: number): Omit<DocumentRead, 'runId' | 'at'> | undefined {
  const text = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';
  if (text) {
    const cut = bytes.byteLength > max;
    return { name, mime, size: bytes.byteLength, text: new TextDecoder().decode(cut ? bytes.subarray(0, max) : bytes), ...(cut ? { cut: true } : {}) };
  }
  if (bytes.byteLength > (max * 3) / 4) return undefined;
  return { name, mime, size: bytes.byteLength, base64: Buffer.from(bytes).toString('base64') };
}

const typedOf = (st: MeasureStep, rows: readonly Row[]): string[] => st.metrics.flatMap((m) => (m.kind === 'rows' && m.columns?.length ? typedWords(withStorage(rows, Object.keys(rows[0] ?? {}), m.columns).rows, m.columns) : []));

/** One source checked: its step, its preview, and the numbers its step would keep. */
interface SourceCheck {
  readonly stepId: string;
  readonly preview: SourcePreview;
  readonly found: readonly Measured[];
}

/**
 * Claude's step as a step draft: what it left out is filled in (StepInputSchema's defaults). A
 * merge step always asks you: only the editor can untick its approval (with its alert).
 */
const toolStep = (st: ToolStep): StepDraft => StepInputSchema.parse(st.kind === 'merge' ? { ...st, require: { checks: true, approval: true } } : st) as StepDraft;

/** An ask that ran past its sentinel's time limit says this. */
export const TOOK_TOO_LONG = 'The agent took too long';

const capitalFirst = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** Claude's draft as a sentinel draft (its project by name). */
export function fromToolDraft(d: ToolDraft): SentinelDraft {
  return {
    name: d.name,
    ...(d.project ? { projectId: d.project } : {}),
    trigger: d.trigger,
    steps: d.steps.map(toolStep),
    ...(d.access ? { access: d.access } : {}),
    ...(d.notify ? { notify: d.notify } : {}),
    ...(d.keepChats ? { keepChats: d.keepChats } : {}),
  };
}

/** Claude's answer, its first lines (the page's box shows it). */
function clipLines(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 3).join('\n');
  return lines.length > 600 ? `${lines.slice(0, 599)}…` : lines;
}

/** "2026-09-01", "7d", "4 weeks", "3 months", "1y" → that time (none: it doesn't read). */
export function sinceOf(text: string, now: number): number | undefined {
  const t = text.trim().toLowerCase();
  const rel = /^(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)( ago)?$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]![0];
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - 7 * n);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d.getTime();
  }
  const at = Date.parse(t);
  return Number.isFinite(at) ? at : undefined;
}
