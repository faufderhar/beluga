import { type ExtraResource, type OtlpLog, type OtlpSpan, type Sender, logsRequest, tracesRequest } from './otlp.js';
import { tracesProto } from './otlp-proto.js';
import { type TurnFacts, turnSpans } from './turn.js';

/**
 * Sends what was collected, in batches, without ever getting in the way: nothing here runs while a
 * turn is going (turns are queued as they end, masked and sent on a timer), each turn is masked on
 * a later tick of its own, the queue is capped (the oldest go first), a failed send waits longer
 * each time, and a key Ratel refuses (401/403: revoked) stops sending until Beluga starts again.
 * Nothing here throws.
 */

/** Where one destination takes OTLP JSON: its traces URL, its logs URL (none: logs are dropped) and the headers it wants. */
export interface ExportTarget {
  readonly traces: string;
  readonly logs?: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Resource attributes it reads (a project name), beside Beluga's own. */
  readonly resource?: ExtraResource;
  /** Traces as protobuf, which every OTLP endpoint takes (default: JSON, as Ratel reads usage statistics). */
  readonly protobuf?: boolean;
}

/** How a send went: sent, the key refused (sending stops), the data refused (dropped), or try again later. */
export type SendStatus = 'ok' | 'refused' | 'rejected' | 'retry';

/** One Ratel project as a target: `<url>/v1/traces` and `<url>/v1/logs`, its key as a Bearer token. */
export const ratelTarget = (config: { readonly url: string; readonly key: string }): ExportTarget => ({
  traces: `${config.url}/v1/traces`,
  logs: `${config.url}/v1/logs`,
  headers: { authorization: `Bearer ${config.key}` },
});

export interface ExporterDeps {
  /** One Ratel project: its ingest base and its ingest-only key (or `target`). */
  readonly config?: { readonly url: string; readonly key: string };
  /** Anywhere else that takes OTLP JSON (your own traces, src/telemetry/destinations.ts). */
  readonly target?: ExportTarget;
  /** Told how each request went, with its HTTP status (0: it never got an answer). */
  readonly onSend?: (status: SendStatus, code: number) => void;
  readonly sender: () => Sender;
  /** Masks a turn's text (level "on"); undefined drops the turn (the level went down since). */
  readonly prepare: (turn: TurnFacts) => TurnFacts | undefined;
  /** A turn's spans as this destination reads them best (its own attribute names beside gen_ai's); else as built. */
  readonly shape?: (spans: OtlpSpan[]) => OtlpSpan[];
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

  private readonly target: ExportTarget;

  constructor(private readonly deps: ExporterDeps) {
    const target = deps.target ?? (deps.config ? ratelTarget(deps.config) : undefined);
    if (!target) throw new Error('An exporter needs somewhere to send');
    this.target = target;
  }

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

  /** Spans already built (nothing in them to mask): sent with the next batch. */
  spans(list: readonly OtlpSpan[]): void {
    if (this.refused || !list.length) return;
    this.unsent = [...this.unsent, ...list].slice(-MAX_SPANS);
    if (this.unsent.length >= SOON * 5) void this.flush();
  }

  log(record: OtlpLog): void {
    if (this.refused || !this.target.logs) return;
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
      const ready = this.deps.prepare(t);
      if (ready) {
        const built = turnSpans(ready, sender.installId);
        spans.push(...(this.deps.shape ? this.deps.shape(built) : built));
      }
    }
    // post() takes what it sent off the front of each list: what's left is what didn't go.
    if (!(await this.post('traces', spans, (part) => tracesRequest(sender, part, this.target.resource)))) {
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

  private async request(kind: 'traces' | 'logs', payload: unknown): Promise<SendStatus> {
    const url = kind === 'traces' ? this.target.traces : this.target.logs;
    if (!url) return 'ok';
    const { status, code } = await postOtlp(url, this.target.headers, kind === 'traces' && this.target.protobuf ? tracesProto(payload) : payload, this.deps.fetch);
    this.deps.onSend?.(status, code);
    return status;
  }

}

/** One OTLP request: JSON, or protobuf when it's already bytes. Never throws: what went wrong is in the status. */
export async function postOtlp(url: string, headers: Readonly<Record<string, string>>, payload: unknown, fetcher: typeof fetch = fetch): Promise<{ status: SendStatus; code: number }> {
  const bytes = payload instanceof Uint8Array;
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': bytes ? 'application/x-protobuf' : 'application/json', ...headers },
      body: bytes ? (payload as Uint8Array<ArrayBuffer>) : JSON.stringify(payload),
      // A key never follows a redirect elsewhere (only Authorization is dropped across origins).
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: statusOf(res.status, res.ok), code: res.status };
  } catch {
    return { status: 'retry', code: 0 };
  }
}

function statusOf(code: number, ok: boolean): SendStatus {
  if (ok) return 'ok';
  if (code === 401 || code === 403) return 'refused';
  if (code === 429 || code >= 500) return 'retry';
  return 'rejected';
}
