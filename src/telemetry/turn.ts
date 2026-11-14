import { type OtlpSpan, attrs, nanos, pseudonym, spanId, traceId } from './otlp.js';

/**
 * One turn of an agent, as Beluga saw it (src/telemetry/observe.ts), and that turn as spans.
 * Text is here only at level "on", and only for your own turns; it's masked before it's turned
 * into spans (src/telemetry/exporter.ts).
 */

export interface TurnUsage {
  /** Fresh input tokens (cache not included, as Beluga's usage events count them). */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export interface TurnTool {
  readonly id: string;
  /** As the agent named it: "Bash", "mcp__beluga_board__task_update", "mcp__github__search". */
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  /** A sub-agent's step. */
  readonly sub?: boolean;
}

/** One model request (Claude Code's own telemetry has one per request: src/telemetry/claude-otel.ts). */
export interface TurnCall {
  readonly model?: string;
  readonly at: number;
  readonly durationMs: number;
  readonly usage: TurnUsage;
  readonly error?: string;
}

export type TurnOutcome = 'ok' | 'error' | 'stopped';

export interface TurnFacts {
  readonly runtime: string;
  readonly model?: string;
  readonly effort?: string;
  /** The agent's own session (hashed with the install id before it's sent). */
  readonly session?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: TurnOutcome;
  /** What kind of error (its class), never its message. */
  readonly errorKind?: string;
  readonly usage?: TurnUsage;
  readonly calls?: readonly TurnCall[];
  readonly tools: readonly TurnTool[];
  /** Your own turn, or one someone else asked for (a friend, a friend's agent). */
  readonly own: boolean;
  /** Where it ran: a worktree, a project, a chat, a plan, a sentinel… */
  readonly place: string;
  readonly subagents: number;
  readonly compactions: number;
  readonly promptChars: number;
  readonly answerChars: number;
  /** Level "on", your own turn: the text, already masked. */
  readonly text?: { readonly prompt: string; readonly answer: string };
}

const PROVIDERS: Readonly<Record<string, string>> = { claude: 'anthropic', local: 'local', codex: 'openai', copilot: 'github', opencode: 'opencode' };

/** Ratel's words for how a call ended. */
const finish = (f: TurnFacts, last: boolean): string => (f.outcome === 'error' ? 'error' : f.outcome === 'stopped' ? 'stop' : !last ? 'tool_call' : 'stop');

const usageAttrs = (u: TurnUsage | undefined) =>
  u
    ? {
        // Ratel follows the semconv: input includes the cache.
        'gen_ai.usage.input_tokens': u.input + u.cacheRead + u.cacheWrite,
        'gen_ai.usage.output_tokens': u.output,
        'gen_ai.usage.cache_read.input_tokens': u.cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': u.cacheWrite,
        'beluga.cost_usd': u.cost,
      }
    : {};

export function turnSpans(f: TurnFacts, installId: string): OtlpSpan[] {
  const trace = traceId();
  const root = spanId();
  const conversation = f.session ? pseudonym(installId, f.session) : undefined;
  const provider = PROVIDERS[f.runtime] ?? f.runtime;
  const common = { 'gen_ai.provider.name': provider, ...(conversation ? { 'gen_ai.conversation.id': conversation } : {}), 'gen_ai.agent.name': f.runtime };
  const spans: OtlpSpan[] = [
    {
      traceId: trace,
      spanId: root,
      name: `invoke_agent ${f.runtime}`,
      kind: 1,
      startTimeUnixNano: nanos(f.startedAt),
      endTimeUnixNano: nanos(f.endedAt),
      attributes: attrs({
        'gen_ai.operation.name': 'invoke_agent',
        ...common,
        'gen_ai.request.model': f.model,
        'beluga.runtime': f.runtime,
        'beluga.effort': f.effort,
        'beluga.place': f.place,
        'beluga.own': f.own,
        'beluga.outcome': f.outcome,
        'beluga.tools': f.tools.length,
        'beluga.tool_errors': f.tools.filter((t) => !t.ok).length,
        'beluga.subagents': f.subagents,
        'beluga.compactions': f.compactions,
        'beluga.prompt_chars': f.promptChars,
        'beluga.answer_chars': f.answerChars,
        'beluga.cost_usd': f.usage?.cost,
        'error.type': f.errorKind,
      }),
      status: { code: f.outcome === 'error' ? 2 : 1 },
    },
  ];
  // The model requests: Claude Code's own (one per request) when they came, else the turn's total as one.
  const calls: TurnCall[] = f.calls?.length ? [...f.calls].sort((a, b) => a.at - b.at) : f.usage ? [{ ...(f.model ? { model: f.model } : {}), at: f.endedAt, durationMs: f.endedAt - f.startedAt, usage: f.usage }] : [];
  const chats = calls.map((c, i) => {
    const id = spanId();
    const last = i === calls.length - 1;
    const start = Math.max(f.startedAt, c.at - c.durationMs);
    const text = f.text;
    const span: OtlpSpan = {
      traceId: trace,
      spanId: id,
      parentSpanId: root,
      name: `chat ${c.model ?? f.model ?? f.runtime}`,
      kind: 3,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(c.at),
      attributes: attrs({
        'gen_ai.operation.name': 'chat',
        ...common,
        'gen_ai.request.model': c.model ?? f.model,
        ...usageAttrs(c.usage),
        'gen_ai.response.finish_reasons': [c.error ? 'error' : finish(f, last)],
        'error.type': c.error,
        ...(text && i === 0 ? { 'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: text.prompt }] }]) } : {}),
      }),
      ...(text && last ? { events: [{ name: 'gen_ai.client.inference.operation.details', timeUnixNano: nanos(c.at), attributes: attrs({ 'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: text.answer }], finish_reason: finish(f, true) }]) }) }] } : {}),
      status: { code: c.error ? 2 : 1 },
    };
    return { span, start, end: c.at };
  });
  spans.push(...chats.map((c) => c.span));
  // A tool goes under the request that asked for it: the last one that ended before it started.
  const parentOf = (at: number): string => [...chats].reverse().find((c) => c.end <= at + 1)?.span.spanId ?? chats[0]?.span.spanId ?? root;
  for (const t of f.tools) {
    spans.push({
      traceId: trace,
      spanId: spanId(),
      parentSpanId: parentOf(t.startedAt),
      name: `execute_tool ${t.name}`,
      kind: 1,
      startTimeUnixNano: nanos(t.startedAt),
      endTimeUnixNano: nanos(t.endedAt ?? t.startedAt),
      attributes: attrs({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': t.name, 'gen_ai.tool.call.id': t.id, 'beluga.sub_agent': t.sub || undefined, ...(t.ok ? {} : { 'error.type': 'tool_error' }) }),
      status: { code: t.ok ? 1 : 2 },
    });
  }
  return spans;
}
