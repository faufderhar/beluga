import type { TraceProviderId } from '../shared/trace-destinations.js';
import { type AttrValue, type OtlpAttr, type OtlpSpan, attrs } from './otlp.js';

/**
 * A turn's spans as each of your own trace tools reads them best (BLG-1014). The spans stay the
 * OTel `gen_ai` ones (turn.ts). Each tool gets, on its own copy only, the few attributes its docs
 * say it reads (the audit is in docs/traces.md):
 *
 * - Every tool: the answer as the last chat's `gen_ai.output.messages` attribute, beside the
 *   `gen_ai.client.inference.operation.details` event. Most tools never read span events.
 * - Every tool but Ratel: the turn's input and answer on its root `invoke_agent` span (what trace
 *   lists show), `session.id` and `user.id` on each span, and each request's cost as `gen_ai.usage.cost`.
 * - Then each tool's own names: Braintrust's `braintrust.*`, LangSmith's `langsmith.*`, Langfuse's
 *   `langfuse.*`, OpenInference's for Arize and Phoenix, PostHog's `$ai_*`, Sentry's `sentry.op`,
 *   Logfire's `operation.cost`, Databricks' totals on the root, and New Relic's 4,095-character cap.
 *
 * It only copies and renames what the spans already say: nothing new is sent.
 */

type Attrs = Readonly<Record<string, AttrValue>>;
const DETAILS = 'gen_ai.client.inference.operation.details';
/** New Relic keeps at most this many characters of a value. */
export const NEW_RELIC_MAX = 4_095;

/** An attribute's plain value. */
function read(list: readonly OtlpAttr[] | undefined, key: string): AttrValue {
  const v = list?.find((a) => a.key === key)?.value as Record<string, unknown> | undefined;
  if (!v) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  const arr = (v.arrayValue as { values?: Array<{ stringValue?: string }> } | undefined)?.values;
  return arr ? arr.map((x) => x.stringValue ?? '') : undefined;
}

const get = (s: OtlpSpan, key: string): AttrValue => read(s.attributes, key);
const str = (v: AttrValue): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: AttrValue): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const op = (s: OtlpSpan): string | undefined => str(get(s, 'gen_ai.operation.name'));

/** The span with these attributes set (replacing ones of the same name); undefined values are left out. */
function withAttrs(s: OtlpSpan, extra: Attrs): OtlpSpan {
  const added = attrs(extra);
  if (!added.length) return s;
  const keys = new Set(added.map((a) => a.key));
  return { ...s, attributes: [...s.attributes.filter((a) => !keys.has(a.key)), ...added] };
}

/** The text of a `gen_ai.*.messages` JSON: its parts' text, joined. */
export function messageText(json: string | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const list = JSON.parse(json) as Array<{ parts?: Array<{ type?: string; content?: unknown }> }>;
    const text = list.flatMap((m) => m.parts ?? []).flatMap((p) => (p.type === 'text' && typeof p.content === 'string' ? [p.content] : [])).join('\n');
    return text || undefined;
  } catch {
    return undefined;
  }
}

const eventOutput = (s: OtlpSpan): string | undefined => str(read(s.events?.find((e) => e.name === DETAILS)?.attributes, 'gen_ai.output.messages'));

/** What one turn's spans say, found once. */
interface Turn {
  readonly rootId?: string;
  readonly input?: string;
  readonly output?: string;
  readonly conversation?: string;
  readonly definitions?: string;
  readonly user: string;
  /** Its requests' tokens, summed (Databricks reads them from the root). */
  readonly tokens: { readonly input: number; readonly output: number };
}

function turnOf(spans: readonly OtlpSpan[], user: string): Turn {
  const pick = (f: (s: OtlpSpan) => string | undefined): string | undefined => spans.map(f).find(Boolean);
  const chats = spans.filter((s) => op(s) === 'chat');
  const sum = (key: string): number => chats.reduce((n, s) => n + (num(get(s, key)) ?? 0), 0);
  const root = spans.find((s) => !s.parentSpanId && op(s) === 'invoke_agent');
  return {
    ...(root ? { rootId: root.spanId } : {}),
    input: pick((s) => str(get(s, 'gen_ai.input.messages'))),
    output: spans.map(eventOutput).filter(Boolean).at(-1),
    conversation: pick((s) => str(get(s, 'gen_ai.conversation.id'))),
    definitions: pick((s) => str(get(s, 'gen_ai.tool.definitions'))),
    user,
    tokens: { input: sum('gen_ai.usage.input_tokens'), output: sum('gen_ai.usage.output_tokens') },
  };
}

/** Every tool but Ratel: input and answer on the root, session and user on each span, each request's cost in gen_ai's name. */
function common(s: OtlpSpan, t: Turn, root: boolean): Attrs {
  const cost = num(get(s, 'ratel.usage.cost_usd'));
  return {
    'session.id': t.conversation,
    'user.id': t.user,
    ...(root ? { 'gen_ai.input.messages': t.input, 'gen_ai.output.messages': t.output } : {}),
    ...(op(s) === 'chat' && cost ? { 'gen_ai.usage.cost': cost, 'gen_ai.usage.cost.currency': 'USD' } : {}),
  };
}

/** One tool's own attribute names, from its docs. */
function own(id: TraceProviderId, s: OtlpSpan, t: Turn, root: boolean): Attrs {
  const kind = op(s);
  const chat = kind === 'chat';
  const tool = kind === 'execute_tool';
  const args = str(get(s, 'gen_ai.tool.call.arguments'));
  const result = str(get(s, 'gen_ai.tool.call.result'));
  const cost = num(get(s, 'ratel.usage.cost_usd'));
  const cacheRead = num(get(s, 'gen_ai.usage.cache_read.input_tokens'));
  const cacheWrite = num(get(s, 'gen_ai.usage.cache_creation.input_tokens'));
  switch (id) {
    case 'braintrust':
      return {
        ...(tool ? { 'braintrust.input_json': args, 'braintrust.output': result } : {}),
        ...(root ? { 'braintrust.input_json': t.input, 'braintrust.output_json': t.output, 'braintrust.span_attributes.type': 'task', 'braintrust.metadata.session_id': t.conversation, 'braintrust.metadata.user_id': t.user } : {}),
      };
    case 'langsmith':
      return {
        'langsmith.metadata.thread_id': t.conversation,
        'langsmith.metadata.user_id': t.user,
        ...(root ? { 'langsmith.span.kind': 'chain' } : {}),
        ...(tool ? { 'input.value': args, 'output.value': result } : {}),
        // Its cost needs these two (it fills them only from the older gen_ai.system).
        ...(chat ? { 'langsmith.metadata.ls_provider': str(get(s, 'gen_ai.provider.name')), 'langsmith.metadata.ls_model_name': str(get(s, 'gen_ai.response.model')) ?? str(get(s, 'gen_ai.request.model')) } : {}),
      };
    case 'langfuse':
      return root
        ? { 'langfuse.observation.input': t.input, 'langfuse.observation.output': t.output, 'langfuse.trace.metadata.repo': str(get(s, 'ratel.run.repo')), 'langfuse.trace.metadata.branch': str(get(s, 'ratel.run.branch')), 'langfuse.trace.metadata.task': str(get(s, 'ratel.run.task')) }
        : {};
    case 'arize':
      return {
        'openinference.span.kind': kind === 'invoke_agent' ? 'AGENT' : chat ? 'LLM' : tool ? 'TOOL' : undefined,
        ...(root ? { 'input.value': messageText(t.input), 'output.value': messageText(t.output) } : {}),
        ...(tool ? { 'input.value': args, 'output.value': result } : {}),
        ...(chat ? { 'llm.token_count.prompt_details.cache_read': cacheRead, 'llm.token_count.prompt_details.cache_write': cacheWrite, 'llm.cost.total': cost } : {}),
      };
    case 'posthog':
      return {
        ...(root ? { $ai_input_state: t.input, $ai_output_state: t.output } : {}),
        ...(tool ? { $ai_input_state: args, $ai_output_state: result, ...(s.status?.code === 2 ? { $ai_is_error: true } : {}) } : {}),
        // Our input tokens include the cached ones: said so, so they're not priced twice.
        ...(chat ? { $ai_cache_read_input_tokens: cacheRead, $ai_cache_creation_input_tokens: cacheWrite, $ai_cache_reporting_exclusive: false, $ai_total_cost_usd: cost } : {}),
      };
    case 'sentry': {
      const reasons = get(s, 'gen_ai.response.finish_reasons');
      return {
        ...(kind ? { 'sentry.op': `gen_ai.${kind}` } : {}),
        // It reads finish reasons as one string, not a list.
        ...(Array.isArray(reasons) ? { 'gen_ai.response.finish_reasons': JSON.stringify(reasons) } : {}),
        ...(chat ? { 'gen_ai.cost.total_tokens': cost } : {}),
      };
    }
    case 'logfire':
      return { ...(chat ? { 'operation.cost': cost } : {}), ...(root ? { 'gen_ai.tool.definitions': t.definitions } : {}) };
    case 'databricks':
      // It reads a trace's tokens from its root only.
      return root && t.tokens.input + t.tokens.output > 0 ? { 'gen_ai.usage.input_tokens': t.tokens.input, 'gen_ai.usage.output_tokens': t.tokens.output } : {};
    default:
      return {};
  }
}

/**
 * A JSON value cut to fit `max` characters and still valid JSON: its longest strings are shortened
 * (with an ellipsis) until it fits. Text that isn't JSON is cut plainly.
 */
export function fitJson(value: string, max: number): string {
  if (value.length <= max) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return `${value.slice(0, max - 1)}…`;
  }
  const strings = (v: unknown, out: Array<{ value: string; set: (x: string) => unknown }>, set: (x: string) => unknown): void => {
    if (typeof v === 'string') out.push({ value: v, set });
    else if (Array.isArray(v)) v.forEach((x, k) => strings(x, out, (y) => (v[k] = y)));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, out, (y) => ((v as Record<string, unknown>)[k] = y));
  };
  for (let round = 0; round < 64; round++) {
    const out = JSON.stringify(parsed);
    if (out.length <= max) return out;
    const all: Array<{ value: string; set: (x: string) => unknown }> = [];
    strings(parsed, all, (y) => (parsed = y));
    const longest = all.sort((a, b) => b.value.length - a.value.length)[0];
    if (!longest || longest.value.length <= 1) break;
    // What's over, from the longest string (escapes can make it count for more: a margin).
    const keep = Math.max(0, longest.value.length - (out.length - max) - 8);
    longest.set(`${longest.value.slice(0, keep)}…`);
  }
  const out = JSON.stringify(parsed);
  return out.length <= max ? out : `${out.slice(0, max - 1)}…`;
}

function capped(s: OtlpSpan, max: number): OtlpSpan {
  const long = s.attributes.flatMap((a) => {
    const v = (a.value as { stringValue?: unknown }).stringValue;
    return typeof v === 'string' && v.length > max ? [[a.key, fitJson(v, max)] as const] : [];
  });
  return long.length ? withAttrs(s, Object.fromEntries(long)) : s;
}

/** A turn's spans for one tool. `user`: the random id your traces go under. */
export function shapeFor(id: TraceProviderId, user: string): (spans: OtlpSpan[]) => OtlpSpan[] {
  return (spans) => {
    // Every tool: the answer as an attribute, where only the event had it.
    const answered = spans.map((s) => {
      const out = eventOutput(s);
      return out && get(s, 'gen_ai.output.messages') === undefined ? withAttrs(s, { 'gen_ai.output.messages': out }) : s;
    });
    if (id === 'ratel') return answered;
    const t = turnOf(answered, user);
    return answered.map((s) => {
      const root = s.spanId === t.rootId;
      const shaped = withAttrs(s, { ...common(s, t, root), ...own(id, s, t, root) });
      return id === 'newrelic' ? capped(shaped, NEW_RELIC_MAX) : shaped;
    });
  };
}
