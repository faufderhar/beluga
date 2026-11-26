import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Store, initialState } from '../src/core/store.js';
import { usageOf } from '../src/agent/runtime/claude/runner.js';
import { CodexEvents, usageEvent } from '../src/agent/runtime/codex/events.js';
import { ClaudeOtel } from '../src/telemetry/claude-otel.js';
import { observedBackend } from '../src/telemetry/observe.js';
import type { OtlpSpan } from '../src/telemetry/otlp.js';
import { TelemetryService } from '../src/telemetry/service.js';
import { RESULT_MAX } from '../src/telemetry/tool-detail.js';
import { type TurnFacts, type TurnTool, turnSpans } from '../src/telemetry/turn.js';

/** What a tool span says about its call (AOBS-4): the command, the MCP server, the skill, and what went in and came back. */

const ID = '7b0c9a52-2d1e-4f5b-9a3c-1e2f3a4b5c6d';
const value = (span: OtlpSpan, key: string): unknown => {
  const v = span.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  if (v.arrayValue) return (v.arrayValue as { values: Array<{ stringValue: string }> }).values.map((x) => x.stringValue);
  return v.intValue !== undefined ? Number(v.intValue) : Object.values(v)[0];
};
const tool = (over: Partial<TurnTool> & Pick<TurnTool, 'id' | 'name'>): TurnTool => ({ startedAt: 2_000, endedAt: 2_500, ok: true, ...over });
const turn = (tools: readonly TurnTool[], over: Partial<TurnFacts> = {}): TurnFacts => ({
  runtime: 'claude',
  model: 'claude-opus-5-5',
  session: 'sess-1',
  startedAt: 1_000,
  endedAt: 9_000,
  outcome: 'ok',
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  tools,
  own: true,
  content: true,
  place: 'worktree',
  subagents: 0,
  compactions: 0,
  promptChars: 20,
  answerChars: 30,
  ...over,
});
const toolSpans = (f: TurnFacts): OtlpSpan[] => turnSpans(f, ID).filter((s) => value(s, 'gen_ai.operation.name') === 'execute_tool');

describe('a Bash span', () => {
  it('is named by its command, and carries the subcommand, every command, the segment count and the exit code', () => {
    const [span] = toolSpans(turn([tool({ id: 't1', name: 'Bash', input: { command: 'cd /repo && git status --short | head -5' }, output: ' M a.ts' })]));
    expect(span!.name).toBe('execute_tool Bash:git');
    expect(value(span!, 'gen_ai.tool.name')).toBe('Bash:git');
    expect(value(span!, 'ratel.tool.base_name')).toBe('Bash');
    expect(value(span!, 'ratel.tool.command')).toBe('git');
    expect(value(span!, 'ratel.tool.subcommand')).toBe('status');
    expect(value(span!, 'ratel.tool.commands')).toEqual(['cd', 'git', 'head']);
    expect(value(span!, 'ratel.tool.command_count')).toBe(2);
    expect(value(span!, 'ratel.tool.exit_code')).toBe(0);
    expect(value(span!, 'gen_ai.tool.type')).toBe('function');
  });

  it('a failed command says its exit code: read from what came back, or as the runtime gave it', () => {
    const [claude, codex, stopped] = toolSpans(
      turn([
        tool({ id: 't1', name: 'Bash', ok: false, error: 'nonzero_exit', input: { command: 'ls /nope' }, output: 'Exit code 2\nls: /nope: No such file or directory' }),
        tool({ id: 't2', name: 'Bash', ok: false, error: 'nonzero_exit', input: { command: 'npm test' }, output: '3 tests failed', exitCode: 1 }),
        tool({ id: 't3', name: 'Bash', ok: false, error: 'aborted', input: { command: 'sleep 100' }, output: 'Stopped before it finished' }),
      ]),
    );
    expect(value(claude!, 'ratel.tool.exit_code')).toBe(2);
    expect(value(codex!, 'ratel.tool.exit_code')).toBe(1);
    expect(value(stopped!, 'ratel.tool.exit_code')).toBeUndefined();
    expect(claude!.name).toBe('execute_tool Bash:ls');
  });

  it('without its command (an old step, a level that keeps none) it stays Bash', () => {
    const [span] = toolSpans(turn([tool({ id: 't1', name: 'Bash' })]));
    expect(span!.name).toBe('execute_tool Bash');
    expect(value(span!, 'ratel.tool.command')).toBeUndefined();
  });
});

describe('an MCP span', () => {
  it('keeps its name, and says its server and its own name apart', () => {
    const [span, other] = toolSpans(turn([tool({ id: 't1', name: 'mcp__beluga_board__task_update', input: { key: 'AOBS-4' } }), tool({ id: 't2', name: 'mcp__plugin_x_y__search__all' })]));
    expect(span!.name).toBe('execute_tool mcp__beluga_board__task_update');
    expect(value(span!, 'gen_ai.tool.name')).toBe('mcp__beluga_board__task_update');
    expect(value(span!, 'mcp.server.name')).toBe('beluga_board');
    expect(value(span!, 'ratel.tool.base_name')).toBe('task_update');
    expect(value(span!, 'gen_ai.tool.type')).toBe('extension');
    expect(value(other!, 'mcp.server.name')).toBe('plugin_x_y');
    expect(value(other!, 'ratel.tool.base_name')).toBe('search__all');
  });
});

describe('a Skill span', () => {
  it('names the skill, where it came from, and that the model called it', () => {
    const [span, plugin] = toolSpans(turn([tool({ id: 't1', name: 'Skill', input: { skill: 'pr-review' }, skillSource: 'userSettings' }), tool({ id: 't2', name: 'Skill', input: { skill: 'anthropic-skills:pdf', args: 'a.pdf' } })]));
    expect(span!.name).toBe('execute_tool Skill');
    expect(value(span!, 'ratel.skill.name')).toBe('pr-review');
    expect(value(span!, 'ratel.skill.source')).toBe('userSettings');
    expect(value(span!, 'ratel.skill.trigger')).toBe('model');
    expect(value(plugin!, 'ratel.skill.name')).toBe('anthropic-skills:pdf');
    expect(value(plugin!, 'ratel.skill.source')).toBe('plugin');
  });

  it('a turn you started with a slash command says so on its root', () => {
    const [root] = turnSpans(turn([], { slash: 'loop-do' }), ID);
    expect(value(root!, 'ratel.skill.name')).toBe('loop-do');
    expect(value(root!, 'ratel.skill.trigger')).toBe('slash_command');
    expect(value(turnSpans(turn([]), ID)[0]!, 'ratel.skill.name')).toBeUndefined();
  });
});

describe('what went in and what came back', () => {
  it('goes as the arguments and the result, each cut to its limit', () => {
    const long = 'x'.repeat(RESULT_MAX * 3);
    const [read, big] = toolSpans(turn([tool({ id: 't1', name: 'Read', input: { file_path: 'src/a.ts' }, output: 'const a = 1;' }), tool({ id: 't2', name: 'Write', input: { file_path: 'b.txt', content: long }, output: long })]));
    expect(value(read!, 'gen_ai.tool.call.arguments')).toBe('{"file_path":"src/a.ts"}');
    expect(value(read!, 'gen_ai.tool.call.result')).toBe('const a = 1;');
    for (const key of ['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']) {
      const sent = String(value(big!, key));
      expect(sent.length).toBeLessThan(RESULT_MAX + 60);
      expect(sent).toMatch(/\[cut: \d+ more characters\]$/);
    }
  });

  it("never on a run that isn't yours: the command's name still goes, its text does not", () => {
    const [span] = toolSpans(turn([tool({ id: 't1', name: 'Bash', input: { command: 'git push origin friend-branch' }, output: 'Everything up-to-date' })], { own: false, content: false }));
    expect(span!.name).toBe('execute_tool Bash:git');
    expect(value(span!, 'ratel.tool.subcommand')).toBe('push');
    expect(JSON.stringify(span)).not.toContain('friend-branch');
    expect(JSON.stringify(span)).not.toContain('up-to-date');
  });
});

describe('a run, observed: what its tools carry', () => {
  const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'fix it', ownWords: 'fix it', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined, ...over }) as AgentRunInput;
  const backend = (script: (i: AgentRunInput) => void): AgentBackend => ({ run: async (i: AgentRunInput) => (script(i), 'done') }) as AgentBackend;
  const steps = (i: AgentRunInput): void => {
    i.onStep?.({ id: 'x', kind: 'tool', tool: 'Bash', title: 'Bash npm test', status: 'error', isError: true, startedAt: 1, endedAt: 2, input: { command: 'npm test' }, output: '1 failed', exitCode: 1, native: 'commandExecution' });
  };
  const observe = async (level: 'limited' | 'on', given: AgentRunInput): Promise<TurnFacts> => {
    const facts: TurnFacts[] = [];
    await observedBackend(backend(steps), 'codex', { level: () => level, turn: (f) => facts.push(f) }).run(given);
    return facts[0]!;
  };

  it('at On, each tool keeps its input, its result, its exit code and the runtime\'s own name for it', async () => {
    const f = await observe('on', input());
    expect(f.tools[0]).toMatchObject({ name: 'Bash', input: { command: 'npm test' }, output: '1 failed', exitCode: 1, native: 'commandExecution' });
    expect(f.content).toBe(true);
    const [span] = toolSpans(f);
    expect(value(span!, 'ratel.tool.native_name')).toBe('commandExecution');
  });

  it('at Limited nothing of a tool\'s input or result is kept at all', async () => {
    const f = await observe('limited', input());
    expect(f.tools[0]!.input).toBeUndefined();
    expect(f.tools[0]!.output).toBeUndefined();
    expect(f.content).toBeFalsy();
  });

  it("a friend's or a guest's run never sends its arguments or results; a run of yours you did not type does", async () => {
    const { ownWords: _w, ...friend } = input({ requesterName: 'bob' });
    expect((await observe('on', friend as AgentRunInput)).content).toBeFalsy();
    expect((await observe('on', { ...friend, ownerMcp: true } as AgentRunInput)).content).toBe(true);
  });

  it('knows a slash command you typed, and not Claude Code\'s own commands', async () => {
    expect((await observe('on', input({ ownWords: '/loop-do fix the bug' }))).slash).toBe('loop-do');
    expect((await observe('on', input({ ownWords: '/compact' }))).slash).toBeUndefined();
    expect((await observe('on', input({ ownWords: 'see /tmp/x' }))).slash).toBeUndefined();
  });
});

describe('secrets never leave this computer in a tool call', () => {
  const HOME = process.env.HOME ?? '';
  const SECRETS = {
    env: 'tulip-garden-9431',
    anthropic: `sk-ant-${'a1B2c3D4'.repeat(6)}`,
    github: `ghp_${'Zx9'.repeat(12)}`,
    urlPassword: 'hunter2hunter2',
    inline: 'p4ssw0rd-value-xyz',
    email: 'kay.person@example.com',
    // Nothing in its shape says it is a secret: only the key it sits under does.
    bare: 'correct horse battery',
  };
  const leaky = (): TurnFacts =>
    turn([
      tool({
        id: 't1',
        name: 'Bash',
        input: { command: `API_TOKEN=${SECRETS.inline} curl -H "Authorization: Bearer ${SECRETS.anthropic}" https://kay:${SECRETS.urlPassword}@db.example.com/x && echo ${SECRETS.env}` },
        output: `user ${SECRETS.email} in ${HOME}/project has key ${SECRETS.github} and ${SECRETS.env}`,
      }),
      tool({ id: 't2', name: 'mcp__github__create_secret', input: { name: 'DEPLOY', nested: { value: SECRETS.env, list: [SECRETS.github] }, password: SECRETS.bare, headers: { Authorization: SECRETS.bare } }, output: `stored ${SECRETS.anthropic}` }),
    ]);

  it('arguments and results go masked: saved values, keys by shape, key=value, URL passwords, emails, the home folder', async () => {
    const sent: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => (sent.push(String(init.body)), new Response('', { status: 202 }))) as unknown as typeof globalThis.fetch;
    const service = new TelemetryService({ store: new Store(initialState('test', 'ask')), version: '1', file: null, secrets: () => [SECRETS.env], config: { url: 'https://ratel.example', key: 'rtl_pub_agents_123456' }, fetch });
    service.choose('on', 'settings');
    service.observeDeps().turn(leaky());
    await service.stop();
    const body = sent.join('\n');
    // The call itself went, with its shape: only the secrets are gone.
    expect(body).toContain('gen_ai.tool.call.arguments');
    expect(body).toContain('gen_ai.tool.call.result');
    expect(body).toContain('Bash:curl');
    expect(body).toContain('db.example.com');
    expect(body).toContain('[redacted]');
    for (const [kind, secret] of Object.entries(SECRETS)) expect(body, kind).not.toContain(secret);
    if (HOME.length > 1) expect(body).not.toContain(HOME);
  });
});

describe('the span tree: each tool under the request that asked for it', () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 };
  const byName = (spans: OtlpSpan[], name: string): OtlpSpan => spans.find((s) => s.name === name)!;
  const parentName = (spans: OtlpSpan[], s: OtlpSpan): string | undefined => spans.find((p) => p.spanId === s.parentSpanId)?.name;

  it('a tool goes under the chat span of its own request, whatever the clocks say', () => {
    // Claude Code reports a request when it ends: a tool can start before its own request's report (a streamed call).
    const spans = turnSpans(
      turn([tool({ id: 't1', name: 'Read', startedAt: 2_000, endedAt: 2_100, requestId: 'req_b' }), tool({ id: 't2', name: 'Grep', startedAt: 2_050, endedAt: 2_200, requestId: 'req_a' })], {
        calls: [
          { model: 'claude-opus-5-5', source: 'sdk', requestId: 'req_a', at: 1_900, durationMs: 500, usage },
          { model: 'claude-opus-5-5', source: 'sdk', requestId: 'req_b', at: 2_900, durationMs: 400, usage },
        ],
      }),
      ID,
    );
    const chats = spans.filter((s) => value(s, 'gen_ai.operation.name') === 'chat');
    expect(byName(spans, 'execute_tool Read').parentSpanId).toBe(chats[1]!.spanId);
    expect(byName(spans, 'execute_tool Grep').parentSpanId).toBe(chats[0]!.spanId);
    // The ids that tie them never leave.
    expect(JSON.stringify(spans)).not.toContain('req_');
  });

  it('the session-title request is never the parent of a tool, by id or by time', () => {
    const title = { model: 'claude-haiku-5-5', source: 'generate_session_title', requestId: 'req_title', at: 1_500, durationMs: 200, usage };
    const main = { model: 'claude-opus-5-5', source: 'sdk', requestId: 'req_main', at: 2_900, durationMs: 400, usage };
    // By time alone the title request "ended before" both tools.
    const spans = turnSpans(turn([tool({ id: 't1', name: 'Read', startedAt: 2_000 }), tool({ id: 't2', name: 'Grep', startedAt: 2_100, requestId: 'req_title' })], { calls: [title, main] }), ID);
    const chats = spans.filter((s) => value(s, 'gen_ai.operation.name') === 'chat');
    const titleSpan = chats.find((c) => value(c, 'ratel.request.source') === 'generate_session_title')!;
    const tools = spans.filter((s) => value(s, 'gen_ai.operation.name') === 'execute_tool');
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t.parentSpanId).not.toBe(titleSpan.spanId);
    expect(tools[0]!.parentSpanId).toBe(chats.find((c) => c !== titleSpan)!.spanId);
    // Only the title request: the tool hangs from the root.
    const alone = turnSpans(turn([tool({ id: 't1', name: 'Read', startedAt: 2_000 })], { calls: [title] }), ID);
    expect(byName(alone, 'execute_tool Read').parentSpanId).toBe(alone[0]!.spanId);
    // What you typed goes on the turn's own first request, not on the title's.
    const worded = turnSpans(turn([], { calls: [title, main], text: { prompt: 'fix the login', answer: 'fixed' } }), ID);
    const withPrompt = worded.filter((s) => value(s, 'gen_ai.input.messages') !== undefined);
    expect(withPrompt).toHaveLength(1);
    expect(value(withPrompt[0]!, 'ratel.request.source')).toBe('sdk');
  });

  it('an Agent call is an invoke_agent span under its tool span, with the sub-agent\'s requests and tools below it', () => {
    const spans = turnSpans(
      turn(
        [
          // A background launch: the Agent call itself returns at once, the sub-agent works on after it.
          tool({ id: 'agent-1', name: 'Agent', startedAt: 2_000, endedAt: 2_050, requestId: 'req_main1', input: { subagent_type: 'Explore', prompt: 'look around' } }),
          tool({ id: 's1', name: 'Bash', startedAt: 2_600, endedAt: 2_900, parent: 'agent-1', requestId: 'req_sub1', agentId: 'ag1', input: { command: 'ls src' } }),
          tool({ id: 't9', name: 'Bash', startedAt: 4_100, endedAt: 4_200, requestId: 'req_main2', input: { command: 'echo finished' } }),
        ],
        {
          subagents: 1,
          calls: [
            { model: 'claude-opus-5-5', source: 'sdk', requestId: 'req_main1', at: 1_950, durationMs: 800, usage },
            { model: 'claude-haiku-5-5', source: 'agent:builtin:Explore', requestId: 'req_sub1', agentId: 'ag1', agentName: 'Explore', at: 2_550, durationMs: 400, usage },
            { model: 'claude-haiku-5-5', source: 'agent:builtin:Explore', requestId: 'req_sub2', agentId: 'ag1', agentName: 'Explore', at: 3_400, durationMs: 300, usage },
            { model: 'claude-opus-5-5', source: 'sdk', requestId: 'req_main2', at: 4_000, durationMs: 500, usage },
          ],
        },
      ),
      ID,
    );
    const root = spans[0]!;
    const launch = byName(spans, 'execute_tool Agent');
    const agent = byName(spans, 'invoke_agent Explore');
    expect(agent.parentSpanId).toBe(launch.spanId);
    expect(value(agent, 'gen_ai.operation.name')).toBe('invoke_agent');
    expect(value(agent, 'gen_ai.agent.name')).toBe('Explore');
    expect(value(agent, 'ratel.agent.parent_call_id')).toBe('agent-1');
    expect(value(agent, 'gen_ai.request.model')).toBe('claude-haiku-5-5');
    expect(value(agent, 'gen_ai.conversation.id')).toBe(value(root, 'gen_ai.conversation.id'));
    // It lasts as long as the sub-agent's work, not as long as the call that started it.
    expect(agent.startTimeUnixNano).toBe(launch.startTimeUnixNano);
    expect(BigInt(agent.endTimeUnixNano)).toBe(3_400n * 1_000_000n);
    // No usage on it: its requests carry the tokens, so nothing is counted twice.
    expect(agent.attributes.some((a) => a.key.startsWith('gen_ai.usage.'))).toBe(false);

    const subChats = spans.filter((s) => value(s, 'gen_ai.operation.name') === 'chat' && s.parentSpanId === agent.spanId);
    expect(subChats).toHaveLength(2);
    expect(subChats.every((c) => value(c, 'gen_ai.agent.name') === 'Explore' && value(c, 'ratel.agent.parent_call_id') === 'agent-1')).toBe(true);
    expect(byName(spans, 'execute_tool Bash:ls').parentSpanId).toBe(subChats[0]!.spanId);
    expect(value(byName(spans, 'execute_tool Bash:ls'), 'gen_ai.agent.name')).toBe('Explore');

    const mainChats = spans.filter((s) => value(s, 'gen_ai.operation.name') === 'chat' && s.parentSpanId === root.spanId);
    expect(mainChats).toHaveLength(2);
    expect(launch.parentSpanId).toBe(mainChats[0]!.spanId);
    expect(byName(spans, 'execute_tool Bash:echo').parentSpanId).toBe(mainChats[1]!.spanId);
    // The turn's model is its own, not the sub-agent's.
    expect(value(root, 'gen_ai.request.model')).toBe('claude-opus-5-5');
    expect(parentName(spans, agent)).toBe('execute_tool Agent');
  });

  it('a sub-agent that used no tool is found by its type; one whose requests never came still holds its tools (Codex)', () => {
    const quiet = turnSpans(
      turn([tool({ id: 'agent-1', name: 'Agent', startedAt: 2_000, endedAt: 3_000, input: { subagent_type: 'Plan' } })], {
        calls: [
          { model: 'claude-opus-5-5', source: 'sdk', at: 1_950, durationMs: 800, usage },
          { model: 'claude-opus-5-5', source: 'agent:builtin:Plan', agentId: 'ag7', agentName: 'Plan', at: 2_800, durationMs: 700, usage },
        ],
      }),
      ID,
    );
    const plan = byName(quiet, 'invoke_agent Plan');
    expect(quiet.filter((s) => s.parentSpanId === plan.spanId).map((s) => value(s, 'gen_ai.operation.name'))).toEqual(['chat']);

    const codex = turnSpans(
      turn([tool({ id: 'thr-2', name: 'Agent', startedAt: 2_000, endedAt: 5_000, input: { description: 'Scout' } }), tool({ id: 'c1', name: 'Bash', startedAt: 2_500, endedAt: 2_700, parent: 'thr-2', input: { command: 'rg TODO' } })], { runtime: 'codex', model: 'gpt-5.2-codex' }),
      ID,
    );
    const scout = byName(codex, 'invoke_agent general-purpose');
    expect(byName(codex, 'execute_tool Bash:rg').parentSpanId).toBe(scout.spanId);
    expect(parentName(codex, scout)).toBe('execute_tool Agent');
  });

  it('a sub-agent inside a sub-agent nests the same way', () => {
    const spans = turnSpans(
      turn([
        tool({ id: 'a1', name: 'Agent', startedAt: 2_000, endedAt: 6_000, input: { subagent_type: 'general-purpose' } }),
        tool({ id: 'a2', name: 'Agent', startedAt: 2_500, endedAt: 5_000, parent: 'a1', input: { subagent_type: 'Explore' } }),
        tool({ id: 'r1', name: 'Read', startedAt: 3_000, endedAt: 3_100, parent: 'a2' }),
      ]),
      ID,
    );
    const outer = byName(spans, 'invoke_agent general-purpose');
    const inner = byName(spans, 'invoke_agent Explore');
    const innerLaunch = spans.find((s) => s.spanId === inner.parentSpanId)!;
    expect(innerLaunch.name).toBe('execute_tool Agent');
    expect(innerLaunch.parentSpanId).toBe(outer.spanId);
    expect(byName(spans, 'execute_tool Read').parentSpanId).toBe(inner.spanId);
  });
});

describe("Claude Code's own telemetry: what ties a tool to its request and its sub-agent", () => {
  const SCOPE = 'com.anthropic.claude_code.events';
  /** A real clock: the receiver reads a record's own time only when it looks like one. */
  const T = 1_700_000_000_000;
  const str = (v: string) => ({ stringValue: v });
  const record = (name: string, at: number, fields: Record<string, string>) => ({
    timeUnixNano: `${BigInt(T + at) * 1_000_000n}`,
    body: str(`claude_code.${name}`),
    attributes: [{ key: 'event.name', value: str(name) }, { key: 'session.id', value: str('s1') }, { key: 'user.email', value: str('kay@example.com') }, ...Object.entries(fields).map(([key, v]) => ({ key, value: str(v) }))],
  });
  const logs = (...records: unknown[]) => ({ resourceLogs: [{ scopeLogs: [{ scope: { name: SCOPE }, logRecords: records }] }] });
  const receiver = () => {
    const emitted: unknown[] = [];
    return { otel: new ClaudeOtel({ emit: (r) => emitted.push(r), installId: () => ID, now: () => T + 10_000 }), emitted };
  };

  it('keeps each request\'s id and its sub-agent, and each tool call\'s request and sub-agent, for the turn', () => {
    const { otel, emitted } = receiver();
    otel.logs(
      logs(
        record('api_request', 2_000, { model: 'claude-opus-5-5', query_source: 'sdk', request_id: 'req_1', duration_ms: '500' }),
        record('tool_decision', 2_010, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_agent', request_id: 'req_1' }),
        record('api_request', 3_000, { model: 'claude-haiku-5-5', query_source: 'agent:builtin:Explore', request_id: 'req_2', 'agent.name': 'Explore', agent_id: 'ag1', duration_ms: '300' }),
        record('tool_result', 3_100, { tool_name: 'Bash', tool_use_id: 'toolu_bash', request_id: 'req_2', agent_id: 'ag1', success: 'true' }),
      ),
    );
    const calls = otel.callsFor('s1', T, T + 5_000);
    expect(calls[0]).toMatchObject({ requestId: 'req_1', source: 'sdk' });
    expect(calls[0]!.agentId).toBeUndefined();
    expect(calls[1]).toMatchObject({ requestId: 'req_2', agentId: 'ag1', agentName: 'Explore' });
    // A turn takes only its own tool calls: the next turn's, already reported, stay for it.
    const links = otel.linksFor('s1', ['toolu_agent', 'toolu_unknown']);
    expect(links.get('toolu_agent')).toEqual({ requestId: 'req_1', decision: 'allow', decisionSource: 'config' });
    expect(links.has('toolu_bash')).toBe(false);
    expect(otel.linksFor('s1', ['toolu_bash']).get('toolu_bash')).toEqual({ requestId: 'req_2', agentId: 'ag1' });
    // Taken once, and none of these ids is forwarded.
    expect(otel.linksFor('s1', ['toolu_agent', 'toolu_bash']).size).toBe(0);
    for (const id of ['req_1', 'req_2', 'toolu_', 'ag1', 'kay@example.com']) expect(JSON.stringify(emitted), id).not.toContain(id);
  });

  it('keeps where each skill the model called lives, in order, and never its name', () => {
    const { otel, emitted } = receiver();
    otel.logs(
      logs(
        record('skill_activated', 2_000, { 'skill.name': 'custom_skill', 'skill.source': 'projectSettings', invocation_trigger: 'nested-skill' }),
        record('skill_activated', 2_500, { 'skill.name': 'custom_skill', 'skill.source': 'userSettings', invocation_trigger: 'user-slash' }),
        record('skill_activated', 9_000, { 'skill.name': 'custom_skill', 'skill.source': 'plugin', invocation_trigger: 'nested-skill' }),
      ),
    );
    expect(otel.skillsFor('s1', T + 1_000, T + 5_000)).toEqual(['projectSettings']);
    expect(otel.skillsFor('s1', T + 1_000, T + 5_000)).toEqual([]);
    expect(JSON.stringify(emitted)).not.toContain('custom_skill');
  });

  it('a turn\'s tools get their request, their sub-agent and their skill\'s source', async () => {
    const facts: TurnFacts[] = [];
    const backend = {
      run: async (i: AgentRunInput) => {
        i.onEvent('usage', JSON.stringify({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, session: 's1' }));
        i.onStep?.({ id: 'toolu_skill', kind: 'tool', tool: 'Skill', title: 'Skill greet', status: 'done', startedAt: 1, endedAt: 2, input: { skill: 'greet' } });
        i.onStep?.({ id: 'toolu_bash', kind: 'tool', tool: 'Bash', title: 'Bash ls', status: 'done', startedAt: 3, endedAt: 4, parent: 'toolu_agent', input: { command: 'ls' } });
        return 'done';
      },
    } as AgentBackend;
    const input = { prompt: 'go', ownWords: 'go', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined } as unknown as AgentRunInput;
    await observedBackend(backend, 'claude', {
      level: () => 'on',
      turn: (f) => facts.push(f),
      links: () => new Map([['toolu_bash', { requestId: 'req_2', agentId: 'ag1' }], ['toolu_skill', { requestId: 'req_1' }]]),
      skills: () => ['projectSettings'],
      settleMs: 0,
    }).run(input);
    await vi.waitFor(() => expect(facts).toHaveLength(1));
    expect(facts[0]!.tools[0]).toMatchObject({ name: 'Skill', requestId: 'req_1', skillSource: 'projectSettings' });
    expect(facts[0]!.tools[1]).toMatchObject({ name: 'Bash', requestId: 'req_2', agentId: 'ag1' });
  });
});

describe('Codex turns, and thinking', () => {
  const run = async (runtime: string, script: (i: AgentRunInput) => void): Promise<TurnFacts> => {
    const facts: TurnFacts[] = [];
    const backend = { run: async (i: AgentRunInput) => (script(i), 'done') } as AgentBackend;
    const input = { prompt: 'go', ownWords: 'go', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined } as unknown as AgentRunInput;
    await observedBackend(backend, runtime, { level: () => 'on', turn: (f) => facts.push(f) }).run(input);
    return facts[0]!;
  };
  const chat = (spans: OtlpSpan[]): OtlpSpan => spans.find((s) => value(s, 'gen_ai.operation.name') === 'chat')!;

  it('a Codex command step carries its exit code and Codex\'s own name for the tool; its compactions are counted', () => {
    const steps: Array<{ tool?: string; exitCode?: number; native?: string; output?: string; kind: string }> = [];
    const events: Array<[string, string]> = [];
    const ev = new CodexEvents('/repo', { onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r) });
    ev.beginTurn({ onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r) });
    const command = { type: 'commandExecution' as const, id: 'c1', command: "/bin/zsh -lc 'npm test'", cwd: '/repo', status: 'inProgress' as const, aggregatedOutput: null, exitCode: null, durationMs: null };
    ev.handle('item/started', { item: command });
    ev.handle('item/completed', { item: { ...command, status: 'failed', aggregatedOutput: '3 tests failed', exitCode: 1, durationMs: 900 } });
    ev.handle('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'search', status: 'completed', arguments: { q: 'x' }, result: { content: 'ok' }, error: null } });
    ev.handle('thread/compacted', {});
    ev.handle('thread/compacted', {});
    ev.handle('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 12 } } });
    const said = ev.endTurn();
    const done = steps.filter((s) => s.kind === 'tool' && s.output !== undefined);
    expect(done[0]).toMatchObject({ tool: 'Bash', native: 'commandExecution', exitCode: 1, output: '3 tests failed' });
    expect(done[1]).toMatchObject({ tool: 'mcp__github__search', native: 'mcpToolCall' });
    expect(done[1]!.exitCode).toBeUndefined();
    expect(said.compactions).toBe(2);
    expect(JSON.parse(usageEvent(said.usage!, 'thr-1', { compactions: said.compactions }))).toEqual({ input: 60, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0, session: 'thr-1', thinking: 12, compactions: 2 });
    // The chat gets one divider for them, with Codex's count after.
    expect(events.filter(([k]) => k === 'compact').map(([, t]) => JSON.parse(t))).toEqual([{ pre: 0, post: 130, trigger: 'auto', window: 200_000 }]);
    // A new turn counts from zero.
    ev.beginTurn({ onEvent: () => undefined });
    expect(ev.endTurn().compactions).toBe(0);
  });

  it('a Codex turn tells its compactions and its reasoning tokens, and sends no cost it does not know', async () => {
    const f = await run('codex', (i) => {
      i.onEvent('usage', JSON.stringify({ input: 60, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0, session: 'thr-1', thinking: 12, compactions: 2 }));
      i.onEvent('usage', JSON.stringify({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, session: 'thr-1', thinking: 3, compactions: 1 }));
    });
    expect(f.compactions).toBe(3);
    expect(f.usage).toMatchObject({ output: 35, thinking: 15, cost: 0 });
    const spans = turnSpans({ ...f, model: 'gpt-5.2-codex' }, ID);
    expect(value(spans[0]!, 'ratel.run.compactions')).toBe(3);
    expect(value(spans[0]!, 'ratel.run.thinking_tokens')).toBe(15);
    expect(value(chat(spans), 'gen_ai.usage.reasoning.output_tokens')).toBe(15);
    expect(value(chat(spans), 'gen_ai.usage.output_tokens')).toBe(35);
    // Zero is "not known" (Codex reports none): left out, so a price book prices the tokens.
    expect(value(chat(spans), 'ratel.usage.cost_usd')).toBeUndefined();
    expect(value(spans[0]!, 'ratel.run.cost_usd')).toBeUndefined();
    expect(value(chat(spans), 'gen_ai.request.model')).toBe('gpt-5.2-codex');
  });

  it('a cost the runtime knows still goes, on the request and on the turn', async () => {
    const f = await run('claude', (i) => i.onEvent('usage', JSON.stringify({ input: 60, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0.02, session: 's1' })));
    const spans = turnSpans(f, ID);
    expect(value(chat(spans), 'ratel.usage.cost_usd')).toBe(0.02);
    expect(value(spans[0]!, 'ratel.run.cost_usd')).toBe(0.02);
  });

  it('thinking goes as how long it took and how many tokens, never as its words', async () => {
    const f = await run('claude', (i) => {
      i.onStep?.({ id: 'think-1', kind: 'thinking', title: 'Thought for 2s', status: 'done', startedAt: 1_000, endedAt: 3_000, durationMs: 2_000, text: 'the plan is to rename the secret tulip function' });
      i.onStep?.({ id: 'think-2', kind: 'thinking', title: 'Thought for 1s', status: 'done', startedAt: 4_000, endedAt: 5_000, durationMs: 1_000, hidden: true });
      i.onEvent('usage', JSON.stringify({ input: 60, output: 300, cacheRead: 40, cacheWrite: 0, cost: 0.02, session: 's1', thinking: 95 }));
    });
    expect(f.thinking).toEqual({ ms: 3_000, blocks: 2 });
    const spans = turnSpans(f, ID);
    expect(value(spans[0]!, 'ratel.run.thinking_ms')).toBe(3_000);
    expect(value(spans[0]!, 'ratel.run.thinking_blocks')).toBe(2);
    expect(value(spans[0]!, 'ratel.run.thinking_tokens')).toBe(95);
    expect(JSON.stringify(f)).not.toContain('tulip');
    expect(JSON.stringify(spans)).not.toContain('tulip');
    // A turn without thinking says nothing about it.
    const plain = turnSpans(await run('claude', () => undefined), ID);
    expect(value(plain[0]!, 'ratel.run.thinking_ms')).toBeUndefined();
  });

  it("Claude's turn usage carries the thinking tokens its result reports", () => {
    const model = { inputTokens: 4, outputTokens: 274, cacheReadInputTokens: 10, cacheCreationInputTokens: 2 };
    expect(usageOf({ 'claude-haiku-5-5': model }, 0.01, 's1', { output_tokens_details: { thinking_tokens: 95 } })).toEqual({ input: 4, output: 274, cacheRead: 10, cacheWrite: 2, cost: 0.01, session: 's1', thinking: 95 });
    expect(usageOf({ 'claude-haiku-5-5': model }, 0.01, 's1')).toEqual({ input: 4, output: 274, cacheRead: 10, cacheWrite: 2, cost: 0.01, session: 's1' });
    expect(usageOf({ 'claude-haiku-5-5': model }, 0.01, 's1', { output_tokens_details: { thinking_tokens: 0 } })).not.toHaveProperty('thinking');
  });
});
