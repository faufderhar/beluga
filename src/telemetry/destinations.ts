import type { TraceDestination } from '../core/env-vars.js';
import {
  type TraceDestinationView,
  type TraceProviderId,
  type TraceState,
  type TraceTarget,
  type TraceTestResult,
  mergeTraceFields,
  traceProvider,
  traceTarget,
} from '../shared/trace-destinations.js';
import { type ExportTarget, Exporter, type SendStatus, postOtlp } from './exporter.js';
import { shapeFor } from './dialects.js';
import { type Sender, tracesRequest } from './otlp.js';
import { tracesProto } from './otlp-proto.js';
import { type TurnFacts, turnSpans } from './turn.js';

/**
 * Your own traces (BLG-1014): the tools you connected in Settings › Traces (shared/trace-destinations.ts),
 * each with an exporter of its own that gets every turn of every runtime as `gen_ai` spans, as OTLP
 * protobuf. This is apart from usage statistics. It doesn't care about their level, and it works in a
 * build from source too.
 *
 * Secrets are always masked out first, with the same masker as usage statistics. A destination with
 * text off gets no prompts, answers or tools' input and output. A run a friend or a guest asked for
 * never carries them (observe.ts), so they never go anywhere. A key a tool refuses stops that tool
 * until it's saved again. Nothing here throws into a run.
 */

/** What it reads and changes in env.json (core/env-vars.ts). */
export interface DestinationStore {
  readonly traceDestinations: () => readonly TraceDestination[];
  readonly saveTraceDestination: (change: { readonly id: TraceProviderId; readonly on?: boolean; readonly text?: boolean; readonly fields?: Readonly<Record<string, string>> }) => void;
  readonly removeTraceDestination: (id: string) => void;
  readonly tracesId: () => string;
}

export interface DestinationsDeps {
  readonly store: DestinationStore;
  readonly version: string;
  /** A turn with its secrets masked out (service.ts). */
  readonly mask: (turn: TurnFacts) => TurnFacts;
  /** Told when whether any destination is on changed (runs then start, or stop, being watched). */
  readonly onActive?: (active: boolean) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly flushMs?: number;
}

/** How its sends went: the last answer, and when one last went. */
interface Report {
  readonly status?: SendStatus;
  readonly code?: number;
  readonly lastSentAt?: number;
}

interface Live {
  /** What it was made from: a change makes a new one. */
  readonly sig: string;
  readonly exporter: Exporter;
  report: Report;
}

/** A turn without your words in it: no prompt, answer, question, or tool input or output. */
export function withoutText(t: TurnFacts): TurnFacts {
  const { text: _text, ...rest } = t;
  return {
    ...rest,
    content: false,
    tools: t.tools.map(({ input: _input, output: _output, ...tool }) => tool),
    ...(t.waits ? { waits: t.waits.map(({ question: _q, ...w }) => w) } : {}),
  };
}

/** Resource attributes a tool reads its user from (PostHog's distinct_id: else every event is anonymous). */
const userResource = (id: TraceProviderId, user: string): Readonly<Record<string, string>> => (id === 'posthog' ? { 'posthog.distinct_id': user } : {});

const asExport = (t: TraceTarget, extra: Readonly<Record<string, string>>): ExportTarget => {
  const resource = { ...t.resource, ...extra };
  return { traces: t.traces, headers: t.headers, ...(Object.keys(resource).length ? { resource } : {}), protobuf: true };
};

export class TraceDestinations {
  private readonly live = new Map<TraceProviderId, Live>();
  private sig = '';
  private wasActive = false;
  private started = false;

  constructor(private readonly deps: DestinationsDeps) {}

  start(): void {
    this.started = true;
    this.sync();
    for (const l of this.live.values()) l.exporter.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.live.values()].map((l) => l.exporter.stop()));
  }

  /** Whether any destination is on and still sending (not refused): then every run is watched. */
  get active(): boolean {
    this.sync();
    return [...this.live.values()].some((l) => !l.exporter.stopped);
  }

  /** A turn ended: to each destination, masked, and without your words where text is off. */
  turn(f: TurnFacts): void {
    this.sync();
    if (!this.live.size) return;
    for (const l of this.live.values()) l.exporter.turn(f);
  }

  /** Each destination for Settings: no secrets, only which are saved, and how it's doing. */
  views(): TraceDestinationView[] {
    this.sync();
    return this.deps.store.traceDestinations().flatMap((d) => {
      const provider = traceProvider(d.id);
      if (!provider) return [];
      const secret = new Set(provider.fields.filter((f) => f.kind === 'secret').map((f) => f.key));
      const fields = Object.fromEntries(Object.entries(d.fields).filter(([k]) => !secret.has(k)));
      const saved = Object.keys(d.fields).filter((k) => secret.has(k));
      const target = traceTarget(d.id, d.fields);
      const live = this.live.get(d.id);
      const { state, problem } = stateOf(d, target, live);
      const lastSentAt = live?.report.lastSentAt;
      return [{ id: d.id, on: d.on, text: d.text, fields, saved, state, ...(lastSentAt ? { lastSentAt } : {}), ...(problem ? { problem } : {}) }];
    });
  }

  /** Connect a tool, or change one (a secret left empty keeps the saved one). */
  save(change: { readonly id: TraceProviderId; readonly on?: boolean; readonly text?: boolean; readonly fields?: Readonly<Record<string, string>> }): TraceDestinationView[] {
    this.deps.store.saveTraceDestination(change);
    // Saved again: a key that was refused gets another go.
    this.drop(change.id);
    return this.views();
  }

  remove(id: TraceProviderId): TraceDestinationView[] {
    this.deps.store.removeTraceDestination(id);
    return this.views();
  }

  /**
   * Send Test: one small trace with what's typed (secrets left empty: the saved ones), so you know
   * the address and key work before a turn depends on it. Nothing is saved.
   */
  async test(id: TraceProviderId, typed?: Readonly<Record<string, string>>): Promise<TraceTestResult> {
    const provider = traceProvider(id);
    if (!provider) return { ok: false, words: 'Beluga doesn’t know that tool.' };
    const saved = this.deps.store.traceDestinations().find((d) => d.id === id)?.fields ?? {};
    const target = traceTarget(id, typed ? mergeTraceFields(provider, saved, typed) : saved);
    if ('error' in target) return { ok: false, words: `${target.error}.` };
    const now = this.deps.now?.() ?? Date.now();
    const spans = shapeFor(id, this.deps.store.tracesId())(turnSpans(testTurn(now), this.deps.store.tracesId()));
    const body = tracesProto(tracesRequest(this.sender(), spans, { ...target.resource, ...userResource(id, this.deps.store.tracesId()) }));
    const { status, code } = await postOtlp(target.traces, target.headers, body, this.deps.fetch);
    return { ok: status === 'ok', words: testWords(status, code, provider.name, provider.checksKeyLater === true) };
  }

  private sender(): Sender {
    return { installId: this.deps.store.tracesId(), version: this.deps.version };
  }

  private drop(id: TraceProviderId): void {
    const l = this.live.get(id);
    if (!l) return;
    void l.exporter.stop();
    this.live.delete(id);
    this.sig = '';
    this.sync();
  }

  /** Make the exporters match what's saved (read again when env.json changed). Cheap when nothing did. */
  private sync(): void {
    let list: readonly TraceDestination[];
    try {
      list = this.deps.store.traceDestinations();
    } catch {
      list = [];
    }
    const sig = JSON.stringify(list);
    if (sig === this.sig) return;
    this.sig = sig;
    const wanted = new Map<TraceProviderId, { readonly sig: string; readonly target: ExportTarget; readonly text: boolean }>();
    for (const d of list) {
      if (!d.on) continue;
      const target = traceTarget(d.id, d.fields);
      if ('error' in target) continue;
      wanted.set(d.id, { sig: JSON.stringify([target, d.text]), target: asExport(target, userResource(d.id, this.deps.store.tracesId())), text: d.text });
    }
    for (const [id, l] of this.live) {
      if (wanted.get(id)?.sig === l.sig) continue;
      void l.exporter.stop();
      this.live.delete(id);
    }
    for (const [id, w] of wanted) {
      if (this.live.has(id)) continue;
      const exporter = new Exporter({
        target: w.target,
        sender: () => this.sender(),
        prepare: (t) => this.deps.mask(w.text ? t : withoutText(t)),
        shape: shapeFor(id, this.deps.store.tracesId()),
        onSend: (status, code) => {
          const l = this.live.get(id);
          if (l?.exporter !== exporter) return;
          l.report = { status, code, lastSentAt: status === 'ok' ? (this.deps.now?.() ?? Date.now()) : l.report.lastSentAt };
          // Once the exporter has marked itself stopped (just after it tells this).
          if (status === 'refused') setTimeout(() => this.tellActive(), 0).unref?.();
        },
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(this.deps.flushMs ? { flushMs: this.deps.flushMs } : {}),
      });
      this.live.set(id, { sig: w.sig, exporter, report: {} });
      if (this.started) exporter.start();
    }
    this.tellActive();
  }

  /** Runs start, or stop, being watched for your tools when that changes (one saved or switched, one refused). */
  private tellActive(): void {
    const active = [...this.live.values()].some((l) => !l.exporter.stopped);
    if (active === this.wasActive) return;
    this.wasActive = active;
    queueMicrotask(() => this.deps.onActive?.(active));
  }
}

function stateOf(d: TraceDestination, target: TraceTarget | { readonly error: string }, live: Live | undefined): { state: TraceState; problem?: string } {
  if ('error' in target) return { state: 'invalid', problem: target.error };
  if (!d.on) return { state: 'off' };
  const r = live?.report;
  if (live?.exporter.stopped || r?.status === 'refused') return { state: 'refused', problem: 'It refused the key. Check it, then save again.' };
  if (r?.status === 'rejected') return { state: 'failing', problem: `It didn’t take the traces (HTTP ${r.code}).` };
  if (r?.status === 'retry') return { state: 'failing', problem: r.code ? `It answered HTTP ${r.code}. Beluga tries again.` : 'It couldn’t be reached. Beluga tries again.' };
  return { state: r?.lastSentAt ? 'sending' : 'waiting' };
}

function testWords(status: SendStatus, code: number, name: string, later: boolean): string {
  if (status === 'ok' && later) return `${name} took the test trace, but it checks the key only later. If “Beluga test” doesn’t show there in a minute, check the key and region.`;
  if (status === 'ok') return `${name} took the test trace. Look for “Beluga test” there.`;
  if (status === 'refused') return `${name} refused the key (HTTP ${code}).`;
  if (status === 'rejected') return `${name} answered HTTP ${code}. Check the project and region.`;
  return code ? `${name} answered HTTP ${code}. Try again in a moment.` : `${name} couldn’t be reached. Check the address and your connection.`;
}

/** A turn that says it's a test: one model request, one tool, no text of yours. */
function testTurn(now: number): TurnFacts {
  return {
    runtime: 'claude',
    model: 'beluga-test',
    session: `beluga-test-${now}`,
    startedAt: now - 1_200,
    endedAt: now,
    outcome: 'ok',
    usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0 },
    tools: [{ id: 'test-tool', name: 'Read', startedAt: now - 900, endedAt: now - 700, ok: true }],
    own: true,
    place: 'test',
    subagents: 0,
    compactions: 0,
    promptChars: 0,
    answerChars: 0,
    text: { prompt: 'Beluga test', answer: 'This trace checks that Beluga can reach this tool.' },
  };
}
