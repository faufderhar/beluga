import { describe, expect, it } from 'vitest';
import { NEW_RELIC_MAX, fitJson, messageText, shapeFor } from '../src/telemetry/dialects.js';
import type { OtlpSpan } from '../src/telemetry/otlp.js';
import { type TurnFacts, turnSpans } from '../src/telemetry/turn.js';
import { TRACE_PROVIDER_IDS } from '../src/shared/trace-destinations.js';

/** Each trace tool's own reading of a turn (BLG-1014): what its docs say it needs, on its copy only. */

const now = 1_800_000_000_000;
const facts: TurnFacts = {
  runtime: 'claude',
  model: 'opus',
  resolvedModel: 'claude-opus-5-5',
  session: 'sess-abc',
  startedAt: now - 20_000,
  endedAt: now,
  outcome: 'ok',
  usage: { input: 1200, output: 800, cacheRead: 30000, cacheWrite: 500, cost: 0.42 },
  calls: [
    { model: 'claude-opus-5-5', at: now - 15_000, durationMs: 4000, usage: { input: 600, output: 300, cacheRead: 15000, cacheWrite: 500, cost: 0.2 }, requestId: 'r1' },
    { model: 'claude-opus-5-5', at: now - 2_000, durationMs: 2000, usage: { input: 600, output: 500, cacheRead: 15000, cacheWrite: 0, cost: 0.22 }, requestId: 'r2' },
  ],
  tools: [
    { id: 'toolu_1', name: 'Bash', startedAt: now - 10_000, endedAt: now - 9_000, ok: true, input: { command: 'npm test' }, output: '12 passed', requestId: 'r1' },
    { id: 'toolu_2', name: 'mcp__github__search', startedAt: now - 8_000, endedAt: now - 7_500, ok: false, error: 'tool_error', input: { q: 'x' }, output: 'boom', requestId: 'r1' },
  ],
  own: true,
  content: true,
  place: 'worktree',
  subagents: 0,
  compactions: 0,
  promptChars: 20,
  answerChars: 30,
  text: { prompt: 'run the tests please', answer: 'All 12 tests passed.' },
  context: { repo: 'beluga', branch: 'feat/x', task: 'BLG-42' },
  harness: { tools: ['Bash', 'Read'] },
} as TurnFacts;

const USER = 'traces-user-1';
const spans = (): OtlpSpan[] => turnSpans(facts, 'install');
const shaped = (id: (typeof TRACE_PROVIDER_IDS)[number]) => shapeFor(id, USER)(spans());
const val = (s: OtlpSpan | undefined, key: string): unknown => {
  const v = s?.attributes.find((a) => a.key === key)?.value as Record<string, unknown> | undefined;
  return v ? (v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.doubleValue ?? v.boolValue))) : undefined;
};
const root = (list: OtlpSpan[]) => list.find((s) => !s.parentSpanId)!;
const chats = (list: OtlpSpan[]) => list.filter((s) => val(s, 'gen_ai.operation.name') === 'chat');
const tool = (list: OtlpSpan[], name: string) => list.find((s) => s.name.startsWith(`execute_tool ${name}`))!;

describe('every tool', () => {
  it('gets the answer as an attribute on the last request, not only in its event', () => {
    for (const id of TRACE_PROVIDER_IDS) {
      const last = chats(shaped(id)).at(-1);
      expect(messageText(val(last, 'gen_ai.output.messages') as string), id).toBe('All 12 tests passed.');
    }
  });

  it('Ratel gets nothing else: its own spans, as Beluga builds them', () => {
    const plain = spans();
    const ratel = shaped('ratel');
    expect(ratel.map((s) => s.attributes.length)).toEqual(plain.map((s, i) => s.attributes.length + (i === plain.length - 3 ? 1 : 0)));
  });

  it('every other tool gets the turn on its root, session and user on each span, and each request’s cost', () => {
    for (const id of TRACE_PROVIDER_IDS.filter((x) => x !== 'ratel')) {
      const list = shaped(id);
      expect(messageText(val(root(list), 'gen_ai.input.messages') as string), id).toBe('run the tests please');
      expect(messageText(val(root(list), 'gen_ai.output.messages') as string), id).toBe('All 12 tests passed.');
      for (const s of list) {
        expect(val(s, 'user.id'), id).toBe(USER);
        expect(val(s, 'session.id'), id).toBe(val(s, 'gen_ai.conversation.id'));
      }
      expect(chats(list).map((s) => val(s, 'gen_ai.usage.cost')), id).toEqual([0.2, 0.22]);
    }
  });

  it('never sends what the turn didn’t have: no text, no messages anywhere', () => {
    const { text: _t, ...rest } = facts;
    for (const id of TRACE_PROVIDER_IDS) {
      const list = shapeFor(id, USER)(turnSpans({ ...rest, tools: [], content: false } as TurnFacts, 'install'));
      expect(JSON.stringify(list), id).not.toMatch(/run the tests|All 12 tests/);
    }
  });
});

describe('each tool’s own names', () => {
  it('Braintrust: the root as a task with its input and output, tools with theirs', () => {
    const list = shaped('braintrust');
    expect(val(root(list), 'braintrust.span_attributes.type')).toBe('task');
    expect(val(root(list), 'braintrust.metadata.user_id')).toBe(USER);
    expect(val(tool(list, 'Bash'), 'braintrust.output')).toBe('12 passed');
  });

  it('LangSmith: a chain at the root, a thread, and what its cost needs', () => {
    const list = shaped('langsmith');
    expect(val(root(list), 'langsmith.span.kind')).toBe('chain');
    expect(val(chats(list)[0], 'langsmith.metadata.ls_provider')).toBe('anthropic');
    expect(val(chats(list)[0], 'langsmith.metadata.ls_model_name')).toBe('claude-opus-5-5');
    expect(val(tool(list, 'Bash'), 'output.value')).toBe('12 passed');
    expect(val(root(list), 'langsmith.metadata.thread_id')).toBe(val(root(list), 'gen_ai.conversation.id'));
  });

  it('Langfuse: the root’s input and output, and where it ran as trace metadata', () => {
    const list = shaped('langfuse');
    expect(messageText(val(root(list), 'langfuse.observation.output') as string)).toBe('All 12 tests passed.');
    expect(val(root(list), 'langfuse.trace.metadata.task')).toBe('BLG-42');
  });

  it('Arize and Phoenix: OpenInference kinds, text on the root, cache tokens and cost', () => {
    const list = shaped('arize');
    expect(list.map((s) => val(s, 'openinference.span.kind'))).toEqual(['AGENT', 'LLM', 'LLM', 'TOOL', 'TOOL']);
    expect(val(root(list), 'output.value')).toBe('All 12 tests passed.');
    expect(val(chats(list)[0], 'llm.token_count.prompt_details.cache_read')).toBe(15000);
    expect(val(chats(list)[0], 'llm.cost.total')).toBe(0.2);
  });

  it('PostHog: cache tokens said not to be on top of input, its cost, a failed tool', () => {
    const list = shaped('posthog');
    expect(val(chats(list)[0], '$ai_cache_reporting_exclusive')).toBe(false);
    expect(val(chats(list)[0], '$ai_total_cost_usd')).toBe(0.2);
    expect(val(tool(list, 'mcp__github__search'), '$ai_is_error')).toBe(true);
  });

  it('Sentry: its op on each span and finish reasons as one string', () => {
    const list = shaped('sentry');
    expect(list.map((s) => val(s, 'sentry.op'))).toEqual(['gen_ai.invoke_agent', 'gen_ai.chat', 'gen_ai.chat', 'gen_ai.execute_tool', 'gen_ai.execute_tool']);
    expect(JSON.parse(val(chats(list)[0], 'gen_ai.response.finish_reasons') as string)).toEqual(expect.any(Array));
    expect(val(chats(list)[1], 'gen_ai.cost.total_tokens')).toBe(0.22);
  });

  it('Logfire: each request’s cost, and the tools the model had on the agent', () => {
    const list = shaped('logfire');
    expect(val(chats(list)[0], 'operation.cost')).toBe(0.2);
    expect(val(root(list), 'gen_ai.tool.definitions')).toContain('Bash');
  });

  it('Databricks: the turn’s tokens summed on its root', () => {
    const list = shaped('databricks');
    const sum = (key: string) => chats(list).reduce((n, s) => n + (val(s, key) as number), 0);
    expect(val(root(list), 'gen_ai.usage.input_tokens')).toBe(sum('gen_ai.usage.input_tokens'));
    expect(val(root(list), 'gen_ai.usage.output_tokens')).toBe(800);
  });

  it('New Relic: no value over its limit, and long JSON stays JSON', () => {
    const long = { ...facts, text: { prompt: 'p'.repeat(9_000), answer: `${'a'.repeat(6_000)} "quoted" \n end` } } as TurnFacts;
    const list = shapeFor('newrelic', USER)(turnSpans(long, 'install'));
    for (const s of list) for (const a of s.attributes) expect(String((a.value as { stringValue?: string }).stringValue ?? '').length).toBeLessThanOrEqual(NEW_RELIC_MAX);
    const answer = val(root(list), 'gen_ai.output.messages') as string;
    expect(() => JSON.parse(answer)).not.toThrow();
    expect(messageText(answer)).toMatch(/^a+…$/);
  });
});

describe('fitJson', () => {
  it('leaves what fits, cuts plain text plainly, and keeps JSON valid when it cuts', () => {
    expect(fitJson('short', 10)).toBe('short');
    expect(fitJson('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    const cut = fitJson(JSON.stringify({ a: 'é"\\'.repeat(500), b: ['y'.repeat(800), 'z'] }), 300);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(JSON.parse(cut)).toMatchObject({ b: [expect.any(String), 'z'] });
  });
});
