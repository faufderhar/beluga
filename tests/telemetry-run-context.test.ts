import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { harnessFacts } from '../src/agent/runtime/claude/runner.js';
import { Store, initialState } from '../src/core/store.js';
import { ClaudeOtel } from '../src/telemetry/claude-otel.js';
import { commandFacts } from '../src/telemetry/command.js';
import { attachObserver, liveObserver } from '../src/telemetry/hook.js';
import { type ObserveDeps, observedBackend } from '../src/telemetry/observe.js';
import { TelemetryService } from '../src/telemetry/service.js';
import type { OtlpSpan } from '../src/telemetry/otlp.js';
import { type TurnFacts, type TurnTool, DEFINITIONS_MAX, HOOK_EVENTS_MAX, belugaToolSpans, turnSpans } from '../src/telemetry/turn.js';

/** What a turn says around its tool calls (AOBS-6): where it ran, waits for a person, compactions, hooks, the tools it had. */

const ID = '7b0c9a52-2d1e-4f5b-9a3c-1e2f3a4b5c6d';
type Event = NonNullable<OtlpSpan['events']>[number];
const plain = (v: Record<string, unknown> | undefined): unknown => {
  if (!v) return undefined;
  if (v.arrayValue) return (v.arrayValue as { values: Array<{ stringValue: string }> }).values.map((x) => x.stringValue);
  return v.intValue !== undefined ? Number(v.intValue) : Object.values(v)[0];
};
const value = (span: OtlpSpan | Event, key: string): unknown => plain(span.attributes.find((a) => a.key === key)?.value);
const events = (span: OtlpSpan, name: string): Event[] => (span.events ?? []).filter((e) => e.name === name);
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
const op = (f: TurnFacts, name: string): OtlpSpan[] => turnSpans(f, ID).filter((s) => value(s, 'gen_ai.operation.name') === name);
const rootOf = (f: TurnFacts): OtlpSpan => turnSpans(f, ID).find((s) => !s.parentSpanId)!;
const call = (at: number, over: Partial<NonNullable<TurnFacts['calls']>[number]> = {}) => ({ model: 'claude-opus-5-5', source: 'sdk', at, durationMs: 400, usage: { input: 10, output: 5, cacheRead: 1_000, cacheWrite: 200, cost: 0.01 }, ...over });

describe('where a turn ran', () => {
  it('the root says the repo, branch, worktree, task and pull request, plainly, and the harness: version, permission mode, effort', () => {
    const root = rootOf(turn([], { effort: 'high', context: { repo: 'beluga', branch: 'feat/aobs-6-run-context', worktree: 'aobs-6-run-context', task: 'AOBS-6', pr: 579 }, harness: { version: '2.1.323', permissionMode: 'acceptEdits' } }));
    expect(value(root, 'ratel.run.repo')).toBe('beluga');
    expect(value(root, 'ratel.run.branch')).toBe('feat/aobs-6-run-context');
    expect(value(root, 'ratel.run.worktree')).toBe('aobs-6-run-context');
    expect(value(root, 'ratel.run.task')).toBe('AOBS-6');
    expect(value(root, 'ratel.run.pr')).toBe(579);
    expect(value(root, 'ratel.harness.version')).toBe('2.1.323');
    expect(value(root, 'ratel.harness.permission_mode')).toBe('acceptEdits');
    expect(value(root, 'ratel.harness.effort')).toBe('high');
  });

  it('says nothing it does not know', () => {
    const root = rootOf(turn([]));
    for (const key of ['ratel.run.repo', 'ratel.run.branch', 'ratel.run.task', 'ratel.run.pr', 'ratel.harness.version', 'ratel.harness.permission_mode']) expect(value(root, key)).toBeUndefined();
  });
});

describe('waiting for a person', () => {
  const ask = tool({ id: 'q1', name: 'AskUserQuestion', startedAt: 2_000, endedAt: 302_100, ok: false, error: 'denied' });

  it('a question nobody answered is a wait, not a failed tool: its time apart, no error', () => {
    const f = turn([ask, tool({ id: 'b1', name: 'Bash', ok: false, error: 'nonzero_exit', startedAt: 303_000, endedAt: 303_500 })], {
      endedAt: 310_000,
      waits: [{ kind: 'question', tool: 'AskUserQuestion', startedAt: 2_050, endedAt: 302_050, outcome: 'timeout', question: 'Which database?' }],
    });
    const [span] = op(f, 'execute_tool');
    expect(value(span!, 'ratel.wait.human_ms')).toBe(300_000);
    expect(value(span!, 'ratel.wait.kind')).toBe('question');
    expect(value(span!, 'ratel.wait.outcome')).toBe('timeout');
    expect(value(span!, 'error.type')).toBeUndefined();
    expect(span!.status?.code).toBe(1);
    const [waited] = events(span!, 'ratel.human.wait');
    expect(value(waited!, 'ratel.wait.human_ms')).toBe(300_000);
    expect(value(waited!, 'ratel.wait.outcome')).toBe('timeout');
    expect(value(waited!, 'ratel.wait.question')).toBe('Which database?');
    // The turn: one real failure (the command), and the wait under its own name.
    const root = rootOf(f);
    expect(value(root, 'ratel.run.tool_errors')).toBe(1);
    expect(value(root, 'ratel.run.human_waits')).toBe(1);
    expect(value(root, 'ratel.run.human_wait_ms')).toBe(300_000);
  });

  it('an approval is a permission decision on its tool, with how long you took; a refusal by you is not a failure', () => {
    const f = turn(
      [tool({ id: 'b1', name: 'Bash', startedAt: 2_000, endedAt: 9_000, input: { command: 'git push' } }), tool({ id: 'b2', name: 'Bash', startedAt: 10_000, endedAt: 14_000, ok: false, error: 'denied', input: { command: 'rm -rf build' } })],
      {
        endedAt: 20_000,
        waits: [
          { kind: 'permission', tool: 'Bash', startedAt: 2_010, endedAt: 8_010, outcome: 'approved' },
          { kind: 'permission', tool: 'Bash', startedAt: 10_010, endedAt: 13_010, outcome: 'declined' },
        ],
      },
    );
    const [pushed, removed] = op(f, 'execute_tool');
    const [yes] = events(pushed!, 'ratel.permission.decision');
    expect(value(yes!, 'ratel.permission.decision')).toBe('allow');
    expect(value(yes!, 'ratel.permission.source')).toBe('user');
    expect(value(yes!, 'ratel.wait.human_ms')).toBe(6_000);
    expect(value(yes!, 'gen_ai.tool.name')).toBe('Bash:git');
    expect(value(pushed!, 'ratel.wait.human_ms')).toBe(6_000);
    const [no] = events(removed!, 'ratel.permission.decision');
    expect(value(no!, 'ratel.permission.decision')).toBe('deny');
    expect(value(removed!, 'ratel.wait.outcome')).toBe('declined');
    expect(value(removed!, 'error.type')).toBeUndefined();
    expect(removed!.status?.code).toBe(1);
    expect(value(rootOf(f), 'ratel.run.tool_errors')).toBe(0);
  });

  it("without a wait, Claude Code's own decision is the event: what was decided and by what, no wait", () => {
    const [allowed, refused] = op(turn([tool({ id: 't1', name: 'Read', decision: 'allow', decisionSource: 'config' }), tool({ id: 't2', name: 'Write', ok: false, error: 'denied', decision: 'deny', decisionSource: 'hook' })]), 'execute_tool');
    const [a] = events(allowed!, 'ratel.permission.decision');
    expect(value(a!, 'ratel.permission.decision')).toBe('allow');
    expect(value(a!, 'ratel.permission.source')).toBe('config');
    expect(value(a!, 'ratel.wait.human_ms')).toBeUndefined();
    // A rule's refusal stays a failure.
    expect(value(refused!, 'error.type')).toBe('denied');
    expect(refused!.status?.code).toBe(2);
    expect(value(events(refused!, 'ratel.permission.decision')[0]!, 'ratel.permission.source')).toBe('hook');
  });

  it("the question's words go only on a run whose content may go (never a friend's or a guest's)", () => {
    const f = turn([ask], { content: false, own: false, waits: [{ kind: 'question', tool: 'AskUserQuestion', startedAt: 2_050, endedAt: 4_050, outcome: 'answered', question: 'Which database?' }] });
    expect(JSON.stringify(turnSpans(f, ID))).not.toContain('Which database?');
    expect(value(op(f, 'execute_tool')[0]!, 'ratel.wait.human_ms')).toBe(2_000);
  });

  it("Beluga's own project sees the same: a Beluga tool you declined is not a failed tool there either", () => {
    const f = turn([tool({ id: 'm1', name: 'mcp__beluga__send_file', ok: false, error: 'denied' }), tool({ id: 'm2', name: 'mcp__beluga__send_chat', ok: false, error: 'tool_error', startedAt: 5_000, endedAt: 5_100 })], {
      waits: [{ kind: 'permission', tool: 'mcp__beluga__send_file', startedAt: 2_010, endedAt: 2_400, outcome: 'declined' }],
    });
    const [root, declined, broken] = belugaToolSpans(f, ID);
    expect(value(root!, 'ratel.run.tool_errors')).toBe(1);
    expect(value(declined!, 'error.type')).toBeUndefined();
    expect(declined!.status?.code).toBe(1);
    expect(value(declined!, 'ratel.wait.outcome')).toBe('declined');
    expect(value(broken!, 'error.type')).toBe('tool_error');
  });

  it('a wait with no step of its own is on the turn; a turn told as one request says its wait there too (not model time)', () => {
    const f = turn([], { waits: [{ kind: 'plan', tool: 'ExitPlanMode', startedAt: 3_000, endedAt: 5_000, outcome: 'approved' }] });
    const root = rootOf(f);
    expect(value(events(root, 'ratel.human.wait')[0]!, 'ratel.wait.kind')).toBe('plan');
    expect(value(op(f, 'chat')[0]!, 'ratel.wait.human_ms')).toBe(2_000);
    // Told request by request, a request's own time never holds the wait.
    expect(value(op({ ...f, calls: [call(2_500)] }, 'chat')[0]!, 'ratel.wait.human_ms')).toBeUndefined();
  });
});

describe('compactions and hooks', () => {
  it('each compaction is an event on the turn: what started it, tokens before and after', () => {
    const root = rootOf(turn([], { compactions: 1, compacted: [{ at: 4_000, trigger: 'auto', pre: 180_000, post: 22_000 }] }));
    const [e] = events(root, 'ratel.compaction');
    expect(e!.timeUnixNano).toBe('4000000000');
    expect(value(e!, 'ratel.compaction.trigger')).toBe('auto');
    expect(value(e!, 'ratel.compaction.pre_tokens')).toBe(180_000);
    expect(value(e!, 'ratel.compaction.post_tokens')).toBe(22_000);
    expect(value(root, 'ratel.run.compactions')).toBe(1);
  });

  it('each hook is an event: which, how long, how it ended; the turn counts them, and only so many events go', () => {
    const hook = (i: number) => ({ at: 2_000 + i, event: 'PreToolUse', name: 'PreToolUse:Bash', source: 'sdk', durationMs: 10, outcome: 'success' as const, count: 1 });
    const root = rootOf(turn([], { hooks: [{ at: 1_500, event: 'SessionStart', name: 'SessionStart:startup', source: 'user', durationMs: 240, outcome: 'error', count: 2 }, ...Array.from({ length: HOOK_EVENTS_MAX + 5 }, (_, i) => hook(i))] }));
    const sent = events(root, 'ratel.hook');
    expect(sent).toHaveLength(HOOK_EVENTS_MAX);
    expect(value(sent[0]!, 'ratel.hook.event')).toBe('SessionStart');
    expect(value(sent[0]!, 'ratel.hook.name')).toBe('SessionStart:startup');
    expect(value(sent[0]!, 'ratel.hook.source')).toBe('user');
    expect(value(sent[0]!, 'ratel.hook.duration_ms')).toBe(240);
    expect(value(sent[0]!, 'ratel.hook.outcome')).toBe('error');
    expect(value(sent[0]!, 'ratel.hook.count')).toBe(2);
    expect(value(root, 'ratel.run.hooks')).toBe(HOOK_EVENTS_MAX + 6);
    expect(value(root, 'ratel.run.hook_ms')).toBe(240 + 10 * (HOOK_EVENTS_MAX + 5));
  });
});

describe('what the model saw', () => {
  it('each request says how large its context was', () => {
    const [first, second] = op(turn([], { contextWindow: 200_000, calls: [call(2_000), call(3_000, { usage: { input: 20, output: 5, cacheRead: 5_000, cacheWrite: 0, cost: 0.01 } })] }), 'chat');
    expect(value(first!, 'ratel.context.tokens')).toBe(1_210);
    expect(value(second!, 'ratel.context.tokens')).toBe(5_020);
    expect(value(first!, 'ratel.context.window')).toBe(200_000);
  });

  it("the window is the turn's own model's: a sub-agent's request (another model, perhaps) does not say it", () => {
    const agent = tool({ id: 'a1', name: 'Agent', input: { subagent_type: 'Explore' }, startedAt: 2_000, endedAt: 6_000 });
    const [own, sub] = op(turn([agent], { contextWindow: 200_000, calls: [call(1_900), call(4_000, { model: 'claude-haiku-5-5', agentName: 'Explore', agentId: 'ag1' })] }), 'chat');
    expect(value(own!, 'ratel.context.window')).toBe(200_000);
    expect(value(sub!, 'ratel.context.tokens')).toBe(1_210);
    expect(value(sub!, 'ratel.context.window')).toBeUndefined();
  });

  it('a turn told as one request says the context as the run last reported it, not the sum of its requests', () => {
    const [chat] = op(turn([], { usage: { input: 900, output: 50, cacheRead: 400_000, cacheWrite: 0, cost: 0 }, contextTokens: 61_000, contextWindow: 200_000 }), 'chat');
    expect(value(chat!, 'ratel.context.tokens')).toBe(61_000);
  });

  it("the tools it had go on the turn's first request, by name and kind, with its MCP servers", () => {
    const harness = { tools: ['Bash', 'Read', 'mcp__beluga_board__task_update'], mcpServers: ['beluga_board', 'github'] };
    const [first, second] = op(turn([], { harness, calls: [call(2_000), call(3_000)] }), 'chat');
    expect(JSON.parse(value(first!, 'gen_ai.tool.definitions') as string)).toEqual([
      { type: 'function', name: 'Bash' },
      { type: 'function', name: 'Read' },
      { type: 'extension', name: 'mcp__beluga_board__task_update' },
    ]);
    expect(value(first!, 'ratel.tool.declared_count')).toBe(3);
    expect(value(first!, 'ratel.mcp.servers')).toEqual(['beluga_board', 'github']);
    expect(value(second!, 'gen_ai.tool.definitions')).toBeUndefined();
  });

  it('a very long tool list is cut, and still says how many there were', () => {
    const tools = Array.from({ length: DEFINITIONS_MAX + 40 }, (_, i) => `mcp__srv__tool_${i}`);
    const [chat] = op(turn([], { harness: { tools } }), 'chat');
    expect(JSON.parse(value(chat!, 'gen_ai.tool.definitions') as string)).toHaveLength(DEFINITIONS_MAX);
    expect(value(chat!, 'ratel.tool.declared_count')).toBe(DEFINITIONS_MAX + 40);
  });
});

describe('what a call changed', () => {
  it('an edit says the kind of file and how many lines went in and out; never the path', () => {
    const [edit, write, multi] = op(
      turn(
        [
          tool({ id: 'e1', name: 'Edit', input: { file_path: '/repo/src/secret-plan/Auth.TS', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' } }),
          tool({ id: 'w1', name: 'Write', input: { file_path: '/repo/README.md', content: 'one\ntwo\nthree\n' } }),
          tool({ id: 'm1', name: 'MultiEdit', input: { file_path: '/repo/Makefile', edits: [{ old_string: 'x', new_string: 'x\ny' }, { old_string: 'p\nq', new_string: 'p' }] } }),
        ],
        { content: false },
      ),
      'execute_tool',
    );
    expect(value(edit!, 'ratel.tool.file_ext')).toBe('ts');
    expect(value(edit!, 'ratel.tool.lines_added')).toBe(2);
    expect(value(edit!, 'ratel.tool.lines_removed')).toBe(1);
    expect(value(write!, 'ratel.tool.file_ext')).toBe('md');
    expect(value(write!, 'ratel.tool.lines_added')).toBe(3);
    expect(value(write!, 'ratel.tool.lines_removed')).toBeUndefined();
    expect(value(multi!, 'ratel.tool.file_ext')).toBeUndefined();
    expect(value(multi!, 'ratel.tool.lines_added')).toBe(1);
    expect(value(multi!, 'ratel.tool.lines_removed')).toBe(1);
    expect(JSON.stringify([edit, write, multi])).not.toMatch(/secret-plan|README|Makefile/);
  });

  it('a command line says what it did that matters: a commit, a pull request opened, a test run', () => {
    expect(commandFacts('git add -A && git commit -m "x" && git push')?.effects).toEqual(['commit']);
    expect(commandFacts('gh pr create --draft --title t')?.effects).toEqual(['pr_open']);
    expect(commandFacts('cd app && npx vitest run tests/a.test.ts | tail -5')?.effects).toEqual(['test']);
    expect(commandFacts('npm run test:unit; pnpm test; cargo test; go test ./...')?.effects).toEqual(['test']);
    expect(commandFacts('git status')?.effects).toBeUndefined();
  });

  it('the turn counts them: commits, pull requests opened, test runs and the ones that failed', () => {
    const f = turn([
      tool({ id: 'b1', name: 'Bash', input: { command: 'npx vitest run' }, ok: false, error: 'nonzero_exit', output: 'Exit code 1' }),
      tool({ id: 'b2', name: 'Bash', input: { command: 'npx vitest run' } }),
      tool({ id: 'b3', name: 'Bash', input: { command: 'git commit -m done' } }),
      tool({ id: 'b4', name: 'Bash', input: { command: 'git commit -m again' }, ok: false, error: 'nonzero_exit', output: 'Exit code 1' }),
      tool({ id: 'b5', name: 'Bash', input: { command: 'gh pr create --draft' } }),
    ]);
    const root = rootOf(f);
    expect(value(root, 'ratel.run.test_runs')).toBe(2);
    expect(value(root, 'ratel.run.test_failures')).toBe(1);
    expect(value(root, 'ratel.run.commits')).toBe(1);
    expect(value(root, 'ratel.run.prs_opened')).toBe(1);
    expect(value(op(f, 'execute_tool')[0]!, 'ratel.tool.effects')).toEqual(['test']);
  });
});

describe('a run, observed: what happens around its tools', () => {
  const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'fix it', ownWords: 'fix it', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true, ...over }) as AgentRunInput;
  const backend = (script: (i: AgentRunInput) => void | Promise<void>): AgentBackend => ({ run: async (i: AgentRunInput) => (await script(i), 'done') }) as AgentBackend;
  const observe = async (script: (i: AgentRunInput) => void | Promise<void>, given: AgentRunInput, deps: Partial<ObserveDeps> = {}, clock?: { now: number }): Promise<TurnFacts> => {
    const facts: TurnFacts[] = [];
    await observedBackend(backend(script), 'claude', { level: () => 'on', turn: (f) => facts.push(f), ...(clock ? { now: () => clock.now } : {}), ...deps }).run(given);
    // A turn whose session has reports to wait for is told a moment later.
    await vi.waitFor(() => expect(facts).toHaveLength(1));
    return facts[0]!;
  };

  it('times each wait for a person: an approval, a .env file, a question, a plan; and what the person said', async () => {
    const clock = { now: 1_000 };
    const later = <T,>(ms: number, v: T) => async (): Promise<T> => ((clock.now += ms), v);
    const f = await observe(
      async (i) => {
        await i.canUseTool('Bash', { command: 'git push' });
        await i.canUseTool('Bash', { command: 'rm -rf x' });
        await i.canUseSecret?.('Read', { file_path: '.env' });
        await i.askUser?.({ kind: 'question', questions: [{ question: 'Which database?', header: 'DB', options: [], multiSelect: false }] });
        await i.askUser?.({ kind: 'question', questions: [{ question: 'Still there?', header: '', options: [], multiSelect: false }] });
        await i.askUser?.({ kind: 'plan', plan: 'step one' });
      },
      input({
        canUseTool: vi.fn().mockImplementationOnce(later(4_000, true)).mockImplementationOnce(later(2_000, false)),
        canUseSecret: later(1_500, true),
        askUser: vi
          .fn()
          .mockImplementationOnce(later(9_000, { kind: 'answers', answers: { 'Which database?': 'Postgres' } }))
          .mockImplementationOnce(later(300_000, { kind: 'skip' }))
          .mockImplementationOnce(later(7_000, { kind: 'plan', approve: false, feedback: 'no' })),
      }),
      {},
      clock,
    );
    expect(f.waits).toEqual([
      { kind: 'permission', tool: 'Bash', startedAt: 1_000, endedAt: 5_000, outcome: 'approved' },
      { kind: 'permission', tool: 'Bash', startedAt: 5_000, endedAt: 7_000, outcome: 'declined' },
      { kind: 'secret', tool: 'Read', startedAt: 7_000, endedAt: 8_500, outcome: 'approved' },
      { kind: 'question', tool: 'AskUserQuestion', startedAt: 8_500, endedAt: 17_500, outcome: 'answered', question: 'Which database?' },
      { kind: 'question', tool: 'AskUserQuestion', startedAt: 17_500, endedAt: 317_500, outcome: 'timeout', question: 'Still there?' },
      { kind: 'plan', tool: 'ExitPlanMode', startedAt: 317_500, endedAt: 324_500, outcome: 'declined' },
    ]);
    // The answer, the plan and the command are never kept.
    for (const leak of ['Postgres', 'step one', 'rm -rf']) expect(JSON.stringify(f.waits)).not.toContain(leak);
  });

  it('an approval settled at once (a rule of yours, not you) is not a wait; the run still gets its answer', async () => {
    const said: boolean[] = [];
    const f = await observe(async (i) => void said.push(await i.canUseTool('Bash', {})), input({ canUseTool: async () => false }));
    expect(said).toEqual([false]);
    expect(f.waits).toBeUndefined();
  });

  it("a friend's or a guest's run keeps how long it waited, never what was asked", async () => {
    const { ownWords: _w, ...friend } = input({ requesterName: 'bob', askUser: async () => ({ kind: 'skip' }) });
    const clock = { now: 0 };
    const f = await observe(async (i) => { const p = i.askUser?.({ kind: 'question', questions: [{ question: 'Secret plan?', header: '', options: [], multiSelect: false }] }); clock.now = 900; await p; }, friend as AgentRunInput, {}, clock);
    expect(f.waits).toEqual([{ kind: 'question', tool: 'AskUserQuestion', startedAt: 0, endedAt: 900, outcome: 'skipped' }]);
  });

  it('keeps each compaction with its sizes (its summary is neither kept nor counted twice), and the context as last reported', async () => {
    const f = await observe((i) => {
      i.onEvent('context', JSON.stringify({ used: 181_000, window: 200_000, model: 'claude-opus-5-5' }));
      i.onEvent('compact', JSON.stringify({ pre: 181_000, post: 21_000, trigger: 'auto', key: 'k1', window: 200_000 }));
      i.onEvent('compact', JSON.stringify({ key: 'k1', summary: 'what we did so far' }));
      i.onEvent('context', JSON.stringify({ used: 24_000, window: 200_000 }));
      i.onEvent('context', JSON.stringify({ compacting: false, window: 200_000 }));
    }, input(), { now: () => 4_000 });
    expect(f.compactions).toBe(1);
    expect(f.compacted).toEqual([{ at: 4_000, trigger: 'auto', pre: 181_000, post: 21_000 }]);
    expect(f.contextTokens).toBe(24_000);
    expect(f.contextWindow).toBe(200_000);
    expect(JSON.stringify(f)).not.toContain('what we did');
  });

  it('says where it ran, what the agent said about itself, its hooks and what decided each tool call', async () => {
    const heard: unknown[] = [];
    const f = await observe(
      (i) => {
        i.onEvent('usage', JSON.stringify({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, session: 's1' }));
        i.onHarness?.({ version: '2.1.323', permissionMode: 'acceptEdits', tools: ['Bash', 'mcp__gh__search'], mcpServers: ['gh'] });
        i.onStep?.({ id: 't1', kind: 'tool', tool: 'Bash', title: 'Bash', status: 'done', startedAt: 1, endedAt: 2 });
      },
      input({ effort: 'high', onHarness: (h) => heard.push(h) }),
      {
        settleMs: 0,
        context: () => ({ repo: 'beluga', branch: 'feat/x', worktree: 'x', task: 'BLG-1', pr: 7 }),
        hooks: (session) => (session === 's1' ? [{ at: 5, event: 'PreToolUse', name: 'PreToolUse:Bash', source: 'sdk', durationMs: 3, outcome: 'success', count: 1 }] : []),
        links: () => new Map([['t1', { requestId: 'r1', decision: 'allow' as const, decisionSource: 'config' }]]),
      },
    );
    expect(f.context).toEqual({ repo: 'beluga', branch: 'feat/x', worktree: 'x', task: 'BLG-1', pr: 7 });
    expect(f.harness).toEqual({ version: '2.1.323', permissionMode: 'acceptEdits', tools: ['Bash', 'mcp__gh__search'], mcpServers: ['gh'] });
    expect(f.effort).toBe('high');
    expect(f.hooks).toHaveLength(1);
    expect(f.tools[0]).toMatchObject({ decision: 'allow', decisionSource: 'config', requestId: 'r1' });
    // The run's own listener still hears it.
    expect(heard).toHaveLength(1);
  });
});

describe('what Claude Code says about itself when a run starts', () => {
  it('its version, how it asks, its tools and its MCP servers: names only', () => {
    const init = { type: 'system', subtype: 'init', cwd: '/Users/kay/code', claude_code_version: '2.1.323', permissionMode: 'acceptEdits', tools: ['Bash', 'Read', 7, ''], mcp_servers: [{ name: 'beluga_board', status: 'connected' }, { status: 'failed' }], slash_commands: ['x'], apiKeySource: 'none' };
    expect(harnessFacts(init)).toEqual({ version: '2.1.323', permissionMode: 'acceptEdits', tools: ['Bash', 'Read'], mcpServers: ['beluga_board'] });
    expect(harnessFacts({})).toEqual({});
  });
});

describe("Claude Code's own telemetry: hooks and decisions", () => {
  const kv = (o: Record<string, string | number>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
  const logs = (records: Array<Record<string, string | number>>) => ({ resourceLogs: [{ scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records.map((r) => ({ timeUnixNano: '5000000000', attributes: kv(r) })) }] }] });

  it('keeps each hook run for the turn: which, how long, how it ended', () => {
    const otel = new ClaudeOtel({ emit: () => undefined, installId: () => ID, now: () => 5_000 });
    otel.logs(
      logs([
        { 'event.name': 'hook_execution_start', 'session.id': 'S1', hook_event: 'PreToolUse', hook_name: 'PreToolUse:Bash', num_hooks: 1 },
        { 'event.name': 'hook_execution_complete', 'session.id': 'S1', hook_event: 'PreToolUse', hook_name: 'PreToolUse:Bash', hook_source: 'sdk', num_hooks: 1, num_success: 1, num_blocking: 0, num_non_blocking_error: 0, num_cancelled: 0, total_duration_ms: 12 },
        { 'event.name': 'hook_execution_complete', 'session.id': 'S1', hook_event: 'Stop', hook_name: 'Stop', hook_source: 'user', num_hooks: 2, num_success: 1, num_blocking: 1, num_non_blocking_error: 0, num_cancelled: 0, total_duration_ms: 340 },
        { 'event.name': 'hook_execution_complete', 'session.id': 'S1', hook_event: 'PostToolUse', hook_name: 'PostToolUse:Edit', hook_source: 'project', num_hooks: 1, num_success: 0, num_blocking: 0, num_non_blocking_error: 1, num_cancelled: 0, total_duration_ms: 8 },
      ]),
    );
    expect(otel.hooksFor('S1', 0, 10_000)).toEqual([
      { at: 5_000, event: 'PreToolUse', name: 'PreToolUse:Bash', source: 'sdk', durationMs: 12, outcome: 'success', count: 1 },
      { at: 5_000, event: 'Stop', name: 'Stop', source: 'user', durationMs: 340, outcome: 'blocked', count: 2 },
      { at: 5_000, event: 'PostToolUse', name: 'PostToolUse:Edit', source: 'project', durationMs: 8, outcome: 'error', count: 1 },
    ]);
    expect(otel.hooksFor('S1', 0, 10_000)).toEqual([]);
  });

  it('keeps what decided each tool call, with its request', () => {
    const otel = new ClaudeOtel({ emit: () => undefined, installId: () => ID, now: () => 5_000 });
    otel.logs(
      logs([
        { 'event.name': 'tool_decision', 'session.id': 'S1', tool_name: 'Bash', tool_use_id: 't1', request_id: 'r1', decision: 'accept', source: 'config' },
        { 'event.name': 'tool_result', 'session.id': 'S1', tool_name: 'Bash', tool_use_id: 't1', request_id: 'r1' },
        { 'event.name': 'tool_decision', 'session.id': 'S1', tool_name: 'Write', tool_use_id: 't2', decision: 'reject', source: 'hook' },
      ]),
    );
    expect([...otel.linksFor('S1', ['t1', 't2'])]).toEqual([
      ['t1', { requestId: 'r1', decision: 'allow', decisionSource: 'config' }],
      ['t2', { decision: 'deny', decisionSource: 'hook' }],
    ]);
  });
});

describe('the daemon ties them together', () => {
  it('every report of the service reaches a run (the requests, refusals, links, skills and hooks of its session, and where it ran)', () => {
    const seen: string[] = [];
    const note = <T,>(name: string, v: T) => () => (seen.push(name), v);
    attachObserver({ level: () => 'on', turn: () => undefined, calls: note('calls', []), refused: note('refused', new Map()), links: note('links', new Map()), skills: note('skills', []), hooks: note('hooks', []), context: note('context', undefined) });
    try {
      const live = liveObserver();
      live.calls?.('s', 0, 1);
      live.refused?.('s');
      live.links?.('s', []);
      live.skills?.('s', 0, 1);
      live.hooks?.('s', 0, 1);
      live.context?.({} as AgentRunInput);
      expect(seen).toEqual(['calls', 'refused', 'links', 'skills', 'hooks', 'context']);
    } finally {
      attachObserver(undefined);
    }
  });

  it('the service says where a run is from the projects and the board, and masks what a wait asked', async () => {
    const s = new Store(initialState('test', 'ask'));
    const ws = { id: 'w1', projectId: 'p1', projectRoot: '/code/beluga', name: 'aobs-6', path: '/wt/aobs-6', kind: 'worktree', branch: 'feat/aobs-6', createdAt: 1, external: false };
    s.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'beluga', root: '/code/beluga', base: 'main', workspaces: [ws] }] } as never);
    s.dispatch({ type: 'board_init', state: { enabled: true, issues: [{ id: 'i1', key: 'AOBS-6', worktrees: ['w1'], pr: { number: 579, url: 'https://github.com/o/r/pull/579', state: 'OPEN', title: 't', draft: true, checks: 'none' } }], projects: {}, autoTasks: false } } as never);
    const bodies: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('', { status: 202 }))) as unknown as typeof globalThis.fetch;
    const service = new TelemetryService({ store: s, version: '1', file: null, secrets: () => ['hunter2-secret'], config: { url: 'https://ratel.example', key: 'rtl_pub_xxxxxxxx' }, fetch });
    service.choose('on', 'settings');
    const place = { cwd: '/wt/aobs-6/src', additionalDirectories: [], autoEdit: true, onSession: () => undefined };
    expect(service.observeDeps().context?.({ place } as unknown as AgentRunInput)).toEqual({ repo: 'beluga', branch: 'feat/aobs-6', worktree: 'aobs-6', task: 'AOBS-6', pr: 579 });
    expect(service.observeDeps().context?.({ place: { ...place, cwd: '/elsewhere' } } as unknown as AgentRunInput)).toBeUndefined();
    service.observeDeps().turn(turn([tool({ id: 'q1', name: 'AskUserQuestion' })], { waits: [{ kind: 'question', tool: 'AskUserQuestion', startedAt: 2_050, endedAt: 2_400, outcome: 'answered', question: 'Is the password hunter2-secret?' }] }));
    await service.stop();
    expect(bodies.join('')).toContain('ratel.wait.question');
    expect(bodies.join('')).not.toContain('hunter2-secret');
  });
});
