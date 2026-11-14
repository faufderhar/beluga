import { type OtlpLog, type OtlpSpan, type Sender, logsRequest, tracesRequest } from './otlp.js';
import { type TurnFacts, turnSpans } from './turn.js';
import type { ReleaseConfig } from './config.js';

/**
 * Sends what was collected, in batches, without ever getting in the way: nothing here runs while a
 * turn is going (turns are queued as they end, masked and sent on a timer), each turn is masked on
 * a later tick of its own, the queue is capped (the oldest go first), a failed send waits longer
 * each time, and a key Ratel refuses (401/403: revoked) stops sending until Beluga starts again.
 * Nothing here throws.
 */

export interface ExporterDeps {
  readonly config: ReleaseConfig;
  readonly sender: () => Sender;
  /** Masks a turn's text (level "on"); turns without text pass as they are. */
  readonly prepare: (turn: TurnFacts) => TurnFacts;
  readonly fetch?: typeof fetch;
  readonly flushMs?: number;
  readonly now?: () => number;
}

const FLUSH_MS = 30_000;
/** A batch this big goes out without waiting for the timer. */
const SOON = 200;
const MAX_TURNS = 500;
const MAX_LOGS = 2_000;
const MAX_SPANS = 20_000;
/** Ratel takes up to 5,000 items a request; smaller requests fail smaller. */
const PER_REQUEST = 1_000;
const TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;


export class Exporter {
  private turns: TurnFacts[] = [];
  private unsent: OtlpSpan[] = [];
  private logs: OtlpLog[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private refused = false;
  private failures = 0;
  private waitUntil = 0;

  constructor(private readonly deps: ExporterDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.deps.flushMs ?? FLUSH_MS);
    this.timer.unref?.();
  }

  /** Stop the timer and send what's left, waiting at most a moment. */
  async stop(waitMs = 2_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  /** Drop everything queued (the level went to off). */
  clear(): void {
    this.turns = [];
    this.unsent = [];
    this.logs = [];
  }

  get stopped(): boolean {
    return this.refused;
  }

  turn(t: TurnFacts): void {
    if (this.refused) return;
    this.turns.push(t);
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    if (this.turns.length >= SOON) void this.flush();
  }

  log(record: OtlpLog): void {
    if (this.refused) return;
    this.logs.push(record);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    if (this.logs.length >= SOON * 5) void this.flush();
  }

  flush(): Promise<void> {
    this.flushing ??= this.send().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async send(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.refused || now < this.waitUntil || (!this.turns.length && !this.unsent.length && !this.logs.length)) return;
    const turns = this.turns.splice(0);
    const logs = this.logs.splice(0);
    const sender = this.deps.sender();
    // Spans a failed send left: already masked and built, sent as they are.
    const spans: OtlpSpan[] = this.unsent.splice(0);
    for (const t of turns) {
      // A tick between turns: masking a long conversation never holds the daemon up.
      await new Promise((r) => setImmediate(r));
      spans.push(...turnSpans(this.deps.prepare(t), sender.installId));
    }
    // post() takes what it sent off the front of each list: what's left is what didn't go.
    if (!(await this.post('traces', spans, (part) => tracesRequest(sender, part)))) {
      this.retry(now, spans, logs);
      return;
    }
    if (!(await this.post('logs', logs, (part) => logsRequest(sender, part)))) {
      this.retry(now, [], logs);
      return;
    }
    this.failures = 0;
  }

  /** Keep what didn't go for the next try (the newest, if that's too many), and wait longer each time. */
  private retry(now: number, spans: readonly OtlpSpan[], logs: readonly OtlpLog[]): void {
    if (this.refused) return;
    this.unsent = [...spans, ...this.unsent].slice(-MAX_SPANS);
    this.logs = [...logs, ...this.logs].slice(-MAX_LOGS);
    this.failures++;
    this.waitUntil = now + Math.min(MAX_BACKOFF_MS, (this.deps.flushMs ?? FLUSH_MS) * 2 ** this.failures);
  }

  /** → whether every part went (or there was nothing). Spans already sent aren't sent twice: a failed part keeps only itself. */
  private async post<T>(kind: 'traces' | 'logs', items: T[], body: (part: T[]) => unknown): Promise<boolean> {
    while (items.length) {
      const part = items.slice(0, PER_REQUEST);
      const payload = body(part);
      const status = await this.request(kind, payload);
      if (status === 'refused') {
        this.refused = true;
        this.clear();
        return false;
      }
      // Ratel couldn't read it: retrying the same bytes won't help, so it's dropped.
      if (status === 'ok' || status === 'rejected') items.splice(0, part.length);
      else return false;
    }
    return true;
  }

  private async request(kind: 'traces' | 'logs', payload: unknown): Promise<'ok' | 'refused' | 'rejected' | 'retry'> {
    try {
      const res = await (this.deps.fetch ?? fetch)(`${this.deps.config.url}/v1/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.deps.config.key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return 'ok';
      if (res.status === 401 || res.status === 403) return 'refused';
      if (res.status === 429 || res.status >= 500) return 'retry';
      return 'rejected';
    } catch {
      return 'retry';
    }
  }

}
