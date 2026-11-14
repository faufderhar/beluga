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
  telemetryView,
} from '../core/telemetry-store.js';
import { ClaudeOtel } from './claude-otel.js';
import type { ReleaseConfig } from './config.js';
import { deviceFacts } from './device.js';
import { Exporter } from './exporter.js';
import { featureCounter } from './features.js';
import { Masker } from './mask.js';
import type { ObserveDeps } from './observe.js';
import { type AttrValue, event } from './otlp.js';
import { loadTelemetryRecord, saveTelemetryRecord } from './record.js';
import type { TurnFacts } from './turn.js';

/**
 * Usage statistics for this daemon: the level you chose, the ask, and, when it's on, what's
 * collected (turns, features, Claude Code's own telemetry, this computer's kind) and sent to Ratel.
 * In a build that can't send (no release config), it publishes `available: false` and does nothing.
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
}

const TICK_MS = 60_000;

/** A turn without its text (a level below On). */
const withoutText = (t: TurnFacts): TurnFacts => {
  const { text: _text, ...rest } = t;
  return rest;
};
const DAY_MS = 24 * 60 * 60_000;
/** The secret values are read again at most this often. */
const SECRETS_MS = 60_000;

export class TelemetryService {
  private record: TelemetryRecord;
  private readonly exporter?: Exporter;
  private otel?: ClaudeOtel;
  private readonly masker = new Masker(os.homedir());
  private secretsAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastDevice = 0;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: TelemetryDeps) {
    this.record = deps.file === null ? { installId: randomUUID() } : loadTelemetryRecord(...(deps.file ? [deps.file] : [])).record;
    if (deps.config) {
      const config = deps.config;
      this.exporter = new Exporter({ config, sender: () => ({ installId: this.record.installId, version: deps.version }), prepare: (t) => this.prepare(t), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) });
      // Claude Code's own telemetry only in a real release (the demo runs no Claude).
      if (!deps.pretend) this.otel = new ClaudeOtel({ emit: (r) => this.level !== 'off' && this.exporter?.log(r), installId: () => this.record.installId, ...(deps.now ? { now: deps.now } : {}) });
    }
    this.publish();
    // The ask counts merges: told again when the count changes.
    this.offs.push(deps.store.onAction((a) => a.type === 'support' && queueMicrotask(() => this.publish())));
  }

  /** The level that counts now ('off' before a choice, and in a build that can't send). */
  get level(): TelemetryLevel {
    return effectiveLevel({ available: this.available, ...(this.record.level ? { level: this.record.level } : {}) });
  }

  start(): void {
    this.applyLevel();
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    this.exporter?.start();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
    this.tick();
    this.otel?.stop();
    featureCounter.enable(false);
    await this.exporter?.stop();
  }

  /** What a runtime's backend reports its turns through (src/telemetry/hook.ts). */
  observeDeps(): ObserveDeps {
    return {
      level: () => this.level,
      excluded: (input) => this.excludedRun(input),
      // The level now, not when the run started: off drops it, anything but on drops its text.
      turn: (f) => this.level !== 'off' && this.exporter?.turn(this.level === 'on' ? f : withoutText(f)),
      env: (rt) => (rt === 'claude' || rt === 'local' ? this.otel?.env() : undefined),
      calls: (session, from, to) => this.otel?.callsFor(session, from, to) ?? [],
    };
  }

  /** A level chosen in the onboarding or in Settings. */
  choose(level: TelemetryLevel, via: Exclude<TelemetryVia, 'ask'>): void {
    this.record = chooseLevel(this.record, level, via, this.now());
    this.changed(via);
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
    this.exporter?.log(event(name, this.now(), { ...(detail ? { detail: detail.slice(0, 40) } : {}) }));
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
    if (this.deps.file !== null) {
      try {
        saveTelemetryRecord(this.record, ...(this.deps.file ? [this.deps.file] : []));
      } catch {
        // Kept in memory: it asks again next start, the lesser problem.
      }
    }
    this.applyLevel();
    this.publish();
    if (this.level !== 'off') this.exporter?.log(event('level', this.now(), { level: this.level, via, ...(answer ? { answer } : {}) }));
  }

  private applyLevel(): void {
    const on = this.level !== 'off';
    featureCounter.enable(on);
    if (!on) {
      this.exporter?.clear();
      this.otel?.stop();
      return;
    }
    void this.otel?.start().catch(() => undefined);
    if (this.now() - this.lastDevice > DAY_MS) this.device();
  }

  private device(): void {
    this.lastDevice = this.now();
    const runtimes = this.deps.runtimes?.() ?? [];
    this.exporter?.log(event('device', this.now(), deviceFacts({ app_version: this.deps.version, level: this.level, runtimes: runtimes.join(',') || undefined } satisfies Record<string, AttrValue>)));
  }

  /** Each minute: what got used, summed; once a day, this computer's kind. */
  private tick(): void {
    // A Later comes due with time too, not only with merges.
    const due = this.view().due;
    if (due !== this.deps.store.getState().telemetry.due) this.publish();
    if (this.level === 'off') return;
    const { since, counts } = featureCounter.drain(this.now());
    for (const c of counts) this.exporter?.log(event('feature', since, { method: c.method, calls: c.calls, errors: c.errors, total_ms: c.totalMs, max_ms: c.maxMs, window_s: Math.round((this.now() - since) / 1000) }));
    if (this.now() - this.lastDevice > DAY_MS) this.device();
  }

  /** A turn's text, masked (level "on"); the secret values read again at most once a minute. */
  private prepare(t: TurnFacts): TurnFacts {
    if (!t.text) return t;
    // Turned down since it was queued: its text doesn't go.
    if (this.level !== 'on') return withoutText(t);
    if (this.now() - this.secretsAt > SECRETS_MS) {
      this.secretsAt = this.now();
      try {
        this.masker.setSecrets(this.deps.secrets());
      } catch {
        // The patterns still run.
      }
    }
    return { ...t, text: { prompt: this.masker.mask(t.text.prompt), answer: this.masker.mask(t.text.answer) } };
  }

  private view() {
    return telemetryView(this.record, { available: this.available, merges: this.merges, now: this.now() });
  }

  private publish(): void {
    this.deps.store.dispatch({ type: 'telemetry', telemetry: this.view() });
  }
}
