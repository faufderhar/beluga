import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { AgentRunInput } from '../agent/types.js';
import type { Store } from '../core/store.js';
import {
  type TelemetryAnswer,
  type TelemetryLevel,
  type TelemetryRecord,
  type TelemetryVia,
  answerAsk,
  chooseLevel,
  effectiveLevel,
  excludeProject,
  projectOfFolder,
  resetInstallId,
  telemetryView,
} from '../core/telemetry-store.js';
import { ClaudeOtel } from './claude-otel.js';
import type { ReleaseConfig } from './config.js';
import { type DestinationStore, TraceDestinations } from './destinations.js';
import { deviceFacts } from './device.js';
import { Exporter } from './exporter.js';
import { featureCounter } from './features.js';
import { SECRET_KEY } from '../shared/steps.js';
import { Masker, REDACTED } from './mask.js';
import type { ObserveDeps } from './observe.js';
import { type AttrValue, event } from './otlp.js';
import { loadTelemetryRecord, saveTelemetryRecord } from './record.js';
import { issueForWorkspace } from '../core/board/model.js';
import { ModelIds, type RunContext, type TurnFacts, belugaToolSpans } from './turn.js';

/**
 * Usage statistics for this daemon: the level you chose, the ask, and what's collected and sent to
 * Ratel, in two projects (src/telemetry/config.ts):
 * - Beluga's own project, at Essential and On: features used, calls to Beluga's own tools, app
 *   moments, this computer's kind;
 * - the agents project, at On only: your agents' turns (tokens, every tool with its masked arguments
 *   and result, the masked text) and
 *   Claude Code's own telemetry.
 * In a build that can't send (no release config), it publishes `available: false` and does nothing.
 *
 * Your own trace destinations (destinations.ts, BLG-1014) ride on the same watching of runs but are
 * yours: with one on, every run is watched as at On (its text only where it may go), whatever the
 * level, and what goes to usage statistics is still only what their level and exclusions allow.
 */

/** App moments the screens report (the onboarding, the ask): names from this list only. */
export const MARKS = ['onboarding_step', 'onboarding_done', 'ask_shown'] as const;
export type Mark = (typeof MARKS)[number];

export interface TelemetryDeps {
  readonly store: Store;
  readonly config?: ReleaseConfig;
  /** The demo: screens show the ask and the setting as a release would, and nothing is ever sent (no config). */
  readonly pretend?: boolean;
  readonly version: string;
  /** Where the record is kept; null: only in memory (the demo, tests). */
  readonly file?: string | null;
  /** The values to mask exactly: your variables and the projects' .env values (read when text is sent). */
  readonly secrets: () => Iterable<string>;
  /** Which agents this computer has (their runtime ids), for the daily facts. */
  readonly runtimes?: () => readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How often features are summed and sent (tests: shorter). */
  readonly tickMs?: number;
  /** Where your own trace destinations are kept (env.json); none: there are none. */
  readonly destinations?: DestinationStore;
}

const TICK_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;
/** The secret values are read again at most this often. */
const SECRETS_MS = 60_000;

export class TelemetryService {
  private record: TelemetryRecord;
  /** Beluga's own project. */
  private readonly product?: Exporter;
  /** Your agents' sessions (the same exporter as `product` when the release has one key). */
  private readonly agents?: Exporter;
  private otel?: ClaudeOtel;
  /** Your own trace destinations, apart from usage statistics. */
  readonly traces?: TraceDestinations;
  private readonly masker = new Masker(os.homedir());
  /** The ids the model names picked here stood for (BLG-1029). */
  private readonly modelIds = new ModelIds();
  private secretsAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastDevice = 0;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: TelemetryDeps) {
    this.record = deps.file === null ? { installId: randomUUID() } : loadTelemetryRecord(...(deps.file ? [deps.file] : [])).record;
    if (deps.config) {
      const { url, key, productKey } = deps.config;
      const common = { sender: () => ({ installId: this.record.installId, version: deps.version }), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) };
      this.agents = new Exporter({ ...common, config: { url, key }, prepare: (t) => this.prepare(t) });
      this.product = productKey ? new Exporter({ ...common, config: { url, key: productKey }, prepare: (t) => t }) : this.agents;
    }
    if (deps.destinations)
      this.traces = new TraceDestinations({
        store: deps.destinations,
        version: deps.version,
        mask: (t) => this.mask(t),
        onActive: () => this.applyCapture(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    // Claude Code's own telemetry, caught here: never in the demo (it runs no Claude). Its records go
    // only to usage statistics at On; its model requests make the turns' spans for both.
    if (!deps.pretend && (deps.config || deps.destinations)) this.otel = new ClaudeOtel({ emit: (r) => this.level === 'on' && this.agents?.log(r), installId: () => this.record.installId, ...(deps.now ? { now: deps.now } : {}) });
    this.publish();
    // The ask counts merges: told again when the count changes.
    this.offs.push(deps.store.onAction((a) => a.type === 'support' && queueMicrotask(() => this.publish())));
  }

  /** The level that counts now ('off' before a choice, and in a build that can't send). */
  get level(): TelemetryLevel {
    return effectiveLevel({ available: this.available, ...(this.record.level ? { level: this.record.level } : {}) });
  }

  /** How closely runs are watched: as at On while one of your own destinations is, else the level. */
  get capture(): TelemetryLevel {
    return this.traces?.active ? 'on' : this.level;
  }

  start(): void {
    this.applyLevel();
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    for (const e of this.exporters()) e.start();
    this.traces?.start();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
    this.tick();
    this.otel?.stop();
    featureCounter.enable(false);
    await Promise.all([...this.exporters().map((e) => e.stop()), this.traces?.stop()]);
  }

  /** What a runtime's backend reports its turns through (src/telemetry/hook.ts). */
  observeDeps(): ObserveDeps {
    return {
      level: () => this.capture,
      // Left out of usage statistics: straight through, unless your own destinations still want it.
      excluded: (input) => this.excludedRun(input) && !this.traces?.active,
      leftOut: (input) => this.excludedRun(input),
      // The level now, not when the run started: off drops it, limited keeps only Beluga's own tools.
      turn: (f) => this.turn(f),
      env: (rt) => (this.capture === 'on' && (rt === 'claude' || rt === 'local') ? this.otel?.env() : undefined),
      calls: (session, from, to) => this.otel?.callsFor(session, from, to) ?? [],
      refused: (session) => this.otel?.refusedFor(session) ?? new Map(),
      links: (session, ids) => this.otel?.linksFor(session, ids) ?? new Map(),
      skills: (session, from, to) => this.otel?.skillsFor(session, from, to) ?? [],
      hooks: (session, from, to) => this.otel?.hooksFor(session, from, to) ?? [],
      context: (input) => this.runContext(input),
    };
  }

  /**
   * Where a run is, from what Beluga already knows (no git is run): its project as the repo, and its
   * worktree with its branch, the board task it is doing and its pull request. Names as they are.
   */
  private runContext(input: AgentRunInput): RunContext | undefined {
    const cwd = input.place?.cwd;
    if (!cwd) return undefined;
    const state = this.deps.store.getState();
    const inside = (base: string): boolean => Boolean(base) && (cwd === base || cwd.startsWith(base.endsWith('/') ? base : `${base}/`));
    const project = state.projects.find((p) => p.root === projectOfFolder(state.projects, cwd));
    if (!project) return undefined;
    const ws = project.workspaces.filter((w) => inside(w.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const issue = ws ? issueForWorkspace(state.board, ws.id) : undefined;
    const pr = input.place?.openPr?.number ?? issue?.pr?.number;
    return {
      repo: project.name,
      ...(ws?.branch ? { branch: ws.branch } : {}),
      ...(ws ? { worktree: ws.name } : {}),
      ...(issue ? { task: issue.key } : {}),
      ...(pr !== undefined ? { pr } : {}),
    };
  }

  /** A turn ended: its calls to Beluga's tools to Beluga's project; at On, the whole turn to the agents project. */
  private turn(said: TurnFacts): void {
    // The model as an id, also on a turn that only had the name picked ("opus"): what an earlier turn said it stood for.
    const f = this.modelIds.settle(said);
    this.traces?.turn(f);
    const level = this.level;
    if (level === 'off' || f.leftOut) return;
    if (level === 'on') this.agents?.turn(f);
    // One project: the whole turn already has Beluga's tools in it.
    if (level !== 'on' || this.product !== this.agents) this.product?.spans(belugaToolSpans(f, this.record.installId));
  }

  /** Each project once (one exporter when the release has one key). */
  private exporters(): Exporter[] {
    return [...new Set([this.product, this.agents].filter((e): e is Exporter => Boolean(e)))];
  }

  /** A level chosen in the onboarding or in Settings. */
  choose(level: TelemetryLevel, via: Exclude<TelemetryVia, 'ask'>): void {
    this.record = chooseLevel(this.record, level, via, this.now());
    this.changed(via);
  }

  /**
   * This install's random id, for a privacy request (Settings shows it): once any level is chosen, Off
   * too, so it's still there after you withdraw. Before a choice it isn't kept anywhere and nothing went under it.
   */
  installId(): string | undefined {
    return this.record.level ? this.record.installId : undefined;
  }

  /**
   * Reset ID: a new random id from now on, at any level (at Off nothing is sent anyway). What was sent
   * stays under the old id; what was still waiting, and the feature counts not yet summed, are dropped,
   * so nothing goes under the new id that the old one made. No event says it happened.
   */
  resetId(): string {
    this.record = resetInstallId(this.record, randomUUID());
    for (const e of this.exporters()) e.clear();
    featureCounter.drain(this.now());
    this.save();
    return this.record.installId;
  }

  /** A project left out of usage statistics, or back in (its Settings). */
  exclude(root: string, excluded: boolean): void {
    this.record = excludeProject(this.record, root, excluded);
    if (this.deps.file !== null) {
      try {
        saveTelemetryRecord(this.record, ...(this.deps.file ? [this.deps.file] : []));
      } catch {
        // Kept in memory until the next save.
      }
    }
    this.publish();
  }

  /** Whether a run is in a project you left out. */
  private excludedRun(input: AgentRunInput): boolean {
    const left = this.record.excluded;
    const cwd = input.place?.cwd;
    if (!left?.length || !cwd) return false;
    const root = projectOfFolder(this.deps.store.getState().projects, cwd);
    return Boolean(root && left.includes(root));
  }

  /** The ask answered: Share (at `level`), Later, No thanks. */
  answer(answer: TelemetryAnswer, level: TelemetryLevel): void {
    this.record = answerAsk(this.record, answer, level, { merges: this.merges, now: this.now() });
    this.changed('ask', answer);
  }

  /** A moment a screen reports (only at a level that sends). */
  mark(name: Mark, detail?: string): void {
    if (this.level === 'off') return;
    this.product?.log(event(name, this.now(), { ...(detail ? { detail: detail.slice(0, 40) } : {}) }));
  }


  /** Whether screens offer it: a build that can send (or the demo, pretending). */
  private get available(): boolean {
    return Boolean(this.deps.config) || Boolean(this.deps.pretend);
  }

  private get merges(): number {
    return this.deps.store.getState().support?.merges ?? 0;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private changed(via: TelemetryVia, answer?: TelemetryAnswer): void {
    this.save();
    this.applyLevel();
    this.publish();
    if (this.level !== 'off') this.product?.log(event('level', this.now(), { level: this.level, via, ...(answer ? { answer } : {}) }));
  }

  private save(): void {
    if (this.deps.file === null) return;
    try {
      saveTelemetryRecord(this.record, ...(this.deps.file ? [this.deps.file] : []));
    } catch {
      // Kept in memory: it asks again next start, the lesser problem.
    }
  }

  private applyLevel(): void {
    const on = this.level !== 'off';
    featureCounter.enable(on);
    if (!on) for (const e of this.exporters()) e.clear();
    // Essential: your agents' sessions don't go, not even what was waiting.
    else if (this.level !== 'on' && this.agents !== this.product) this.agents?.clear();
    this.applyCapture();
    if (on && this.now() - this.lastDevice > DAY_MS) this.device();
  }

  /** Claude Code's own telemetry is caught while runs are watched as at On (the level, or a destination of yours). */
  private applyCapture(): void {
    if (this.capture === 'on') void this.otel?.start().catch(() => undefined);
    else this.otel?.stop();
  }

  private device(): void {
    this.lastDevice = this.now();
    const runtimes = this.deps.runtimes?.() ?? [];
    this.product?.log(event('device', this.now(), deviceFacts({ app_version: this.deps.version, level: this.level, runtimes: runtimes.join(',') || undefined } satisfies Record<string, AttrValue>)));
  }

  /** Each minute: what got used, summed; once a day, this computer's kind. */
  private tick(): void {
    // A Later comes due with time too, not only with merges.
    const due = this.view().due;
    if (due !== this.deps.store.getState().telemetry.due) this.publish();
    if (this.level === 'off') return;
    const { since, counts } = featureCounter.drain(this.now());
    for (const c of counts) this.product?.log(event('feature', since, { method: c.method, calls: c.calls, errors: c.errors, total_ms: c.totalMs, max_ms: c.maxMs, window_s: Math.round((this.now() - since) / 1000) }));
    if (this.now() - this.lastDevice > DAY_MS) this.device();
  }

  /** A whole turn as it's sent: dropped below On, its text and its tools' arguments and results masked (the secret values read again at most once a minute). */
  private prepare(t: TurnFacts): TurnFacts | undefined {
    // Turned down since it was queued: it doesn't go.
    if (this.level !== 'on') return undefined;
    return this.mask(t);
  }

  /** A turn with its text, questions and tools' arguments and results masked (whatever the level: your own destinations too). */
  private mask(t: TurnFacts): TurnFacts {
    if (!t.text && !t.tools.some((tool) => tool.input || tool.output !== undefined) && !t.waits?.some((w) => w.question)) return t;
    if (this.now() - this.secretsAt > SECRETS_MS) {
      this.secretsAt = this.now();
      try {
        this.masker.setSecrets(this.deps.secrets());
      } catch {
        // The patterns still run.
      }
    }
    return {
      ...t,
      ...(t.text ? { text: { prompt: this.masker.mask(t.text.prompt), answer: this.masker.mask(t.text.answer) } } : {}),
      // What a wait asked you, the same way.
      ...(t.waits ? { waits: t.waits.map((w) => (w.question ? { ...w, question: this.masker.mask(w.question) } : w)) } : {}),
      // What each tool was given and gave back: every string in it, before a span is built from it.
      tools: t.tools.map((tool) => ({
        ...tool,
        ...(tool.input ? { input: this.masked(tool.input) as Readonly<Record<string, unknown>> } : {}),
        ...(tool.output !== undefined ? { output: this.masker.mask(tool.output) } : {}),
      })),
    };
  }

  /** A tool's input with every string in it masked (its keys and shape kept). A value under a secret's name goes whole. */
  private masked(v: unknown, key?: string): unknown {
    if (typeof v === 'string') return key && SECRET_KEY.test(key) && v ? REDACTED : this.masker.mask(v);
    if (Array.isArray(v)) return v.map((x) => this.masked(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.masked(x, k)]));
    return v;
  }

  private view() {
    return telemetryView(this.record, { available: this.available, merges: this.merges, now: this.now() });
  }

  private publish(): void {
    this.deps.store.dispatch({ type: 'telemetry', telemetry: this.view() });
  }
}
