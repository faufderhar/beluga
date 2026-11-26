import { createHash, randomBytes } from 'node:crypto';

/**
 * OTLP JSON, in the shape Ratel Cloud reads best (its mapper pins gen_ai semconv v1.42):
 * - one turn of an agent is one trace: an `invoke_agent` root (no usage on it, so it's never
 *   counted as a model call), `chat` spans under it with the tokens, each `execute_tool` span under
 *   the chat that asked for it, and a sub-agent as an `invoke_agent` span under the call that
 *   started it, with its own chats and tools below (src/telemetry/turn.ts);
 * - a tool's arguments and result (level "on", your own runs, masked) as
 *   `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` (src/telemetry/tool-detail.ts);
 * - what happens around the tools as span events: `ratel.compaction` and `ratel.hook` on the root,
 *   `ratel.permission.decision` and `ratel.human.wait` on the tool that waited (the root when none);
 *   the tools the model had as `gen_ai.tool.definitions` on the turn's first chat span;
 * - text (level "on" only) as `gen_ai.input.messages` on the first chat span and
 *   `gen_ai.output.messages` in the last one's `gen_ai.client.inference.operation.details` event;
 * - everything else (features used, this computer, the app) as `ratel.beluga.*` log records, the
 *   names Ratel keeps, with `ratel.*` attributes (the ones it keeps on them).
 */

export type AttrValue = string | number | boolean | readonly string[] | undefined;
export interface OtlpAttr {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

const anyValue = (v: Exclude<AttrValue, undefined>): Record<string, unknown> => {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
};

/** Attributes from a plain object (undefined values left out). */
export function attrs(o: Readonly<Record<string, AttrValue>>): OtlpAttr[] {
  return Object.entries(o).flatMap(([key, v]) => (v === undefined ? [] : [{ key, value: anyValue(v) }]));
}

export const traceId = (): string => randomBytes(16).toString('hex');
export const spanId = (): string => randomBytes(8).toString('hex');
/** Epoch ms → OTLP's nanoseconds, as a decimal string. */
export const nanos = (ms: number): string => `${BigInt(Math.max(0, Math.round(ms))) * 1_000_000n}`;
/** A stable, unlinkable id for something of this install's (a conversation, say): never the raw value. */
export const pseudonym = (installId: string, value: string): string => createHash('sha256').update(`${installId}\u0000${value}`).digest('hex').slice(0, 32);

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  /** 1 internal, 3 client. */
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: OtlpAttr[];
  readonly events?: ReadonlyArray<{ readonly name: string; readonly timeUnixNano: string; readonly attributes: OtlpAttr[] }>;
  /** 1 ok, 2 error. */
  readonly status?: { readonly code: number; readonly message?: string };
}

export interface OtlpLog {
  readonly timeUnixNano: string;
  readonly observedTimeUnixNano: string;
  readonly eventName: string;
  readonly severityNumber: number;
  readonly attributes: OtlpAttr[];
}

/** Who sends: Beluga, this version; the install as Ratel's end user (a random id, nothing else). */
export interface Sender {
  readonly installId: string;
  readonly version: string;
}

/** Extra resource attributes a destination reads its project from (Arize's `openinference.project.name`). */
export type ExtraResource = Readonly<Record<string, string>>;

const resource = (s: Sender, extra: ExtraResource = {}): { attributes: OtlpAttr[] } => ({
  attributes: attrs({ 'service.name': 'beluga', 'service.version': s.version, 'deployment.environment.name': 'production', 'user.id': s.installId, ...extra }),
});

export function tracesRequest(sender: Sender, spans: readonly OtlpSpan[], extra?: ExtraResource): unknown {
  return { resourceSpans: [{ resource: resource(sender, extra), scopeSpans: [{ scope: { name: 'beluga', version: sender.version }, spans }] }] };
}

export function logsRequest(sender: Sender, records: readonly OtlpLog[]): unknown {
  return { resourceLogs: [{ resource: resource(sender), scopeLogs: [{ scope: { name: 'beluga', version: sender.version }, logRecords: records }] }] };
}

/** One `ratel.beluga.<name>` record; its attributes are named `ratel.beluga.<key>`. */
export function event(name: string, at: number, fields: Readonly<Record<string, AttrValue>>): OtlpLog {
  const prefixed = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`ratel.beluga.${k}`, v]));
  return { timeUnixNano: nanos(at), observedTimeUnixNano: nanos(at), eventName: `ratel.beluga.${name}`, severityNumber: 9, attributes: attrs({ 'event.name': `ratel.beluga.${name}`, ...prefixed }) };
}
