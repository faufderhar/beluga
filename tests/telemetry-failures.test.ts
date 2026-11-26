import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import type { StepRecord } from '../src/shared/steps.js';
import { ERROR_TEXT_MAX, safeErrorText } from '../src/telemetry/error-text.js';
import { errorKind, errorMessage, observedBackend, placeOf, thrownOutcome } from '../src/telemetry/observe.js';
import { type TurnFacts, belugaToolSpans, turnSpans } from '../src/telemetry/turn.js';

/**
 * What Ratel's telemetry needs to tell failures apart (BLG-1029): a failed run's class and short
 * words, a stop that isn't a failure, a failed Beluga tool's stripped words, where a run really
 * ran, and how long a call waited before it ran.
 */

const ID = '7b0c9a52-2d1e-4f5b-9a3c-1e2f3a4b5c6d';
type Span = ReturnType<typeof turnSpans>[number];
const attr = (span: Span, key: string) => span.attributes.find((a) => a.key === key)?.value;
const text = (span: Span, key: string) => attr(span, key)?.stringValue;

const turn = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  runtime: 'codex',
  startedAt: 1_000,
  endedAt: 9_000,
  outcome: 'ok',
  tools: [],
  own: true,
  place: 'worktree',
  subagents: 0,
  compactions: 0,
  promptChars: 20,
  answerChars: 0,
  ...over,
});

describe('what a failure says, as it may leave this computer', () => {
  it('keeps the sentence and strips what could be someone’s: quotes, paths, links, emails, keys, task keys, ids', () => {
    const said = safeErrorText('“Fix the login page” can’t start: blocked by BLG-12 in /Users/kay/Projects/app (see https://x.dev/a?t=1, kay@x.dev) sk-ant-abcdefghijklmnopqrstuvwxyz0123 deadbeefdeadbeef1234')!;
    expect(said).toContain('can’t start: blocked by');
    for (const leak of ['Fix the login', 'BLG-12', '/Users', 'kay', 'x.dev', 'sk-ant', 'deadbeef']) expect(said).not.toContain(leak);
  });

  it('only the first line, and short', () => {
    expect(safeErrorText('There\'s no task "auth" in this plan\nsecond line with a secret')).toBe('There\'s no task … in this plan');
    expect(safeErrorText(`x ${'word '.repeat(200)}`)!.length).toBeLessThanOrEqual(ERROR_TEXT_MAX);
    expect(safeErrorText('')).toBeUndefined();
    expect(safeErrorText('"only a quote"')).toBeUndefined();
  });

  it('an MCP validation error names the bad field and why, never the value', () => {
    const sdk = 'MCP error -32602: Input validation error: Invalid arguments for tool plan_gate: Invalid option: expected one of "pass"|"fail" at verdict\nToo big: expected string to have <=200 characters at milestone';
    const said = safeErrorText(sdk)!;
    expect(said).toBe('Invalid arguments for tool plan_gate: Invalid option: expected one of …|… at verdict; Too big: expected string to have <=200 characters at milestone');
    // An older SDK's JSON issues: their paths and codes.
    const json = 'MCP error -32602: Invalid arguments for tool plan_gate: [{"code":"invalid_value","values":["pass","fail"],"path":["verdict"],"message":"Invalid option"}]';
    expect(safeErrorText(json)).toBe('Invalid arguments for tool plan_gate: verdict: invalid_value');
  });
});

describe('how a run that threw ended', () => {
  const limit = new RunFailedError({ kind: 'usage_limit', detail: 'You have hit your usage limit. secret stderr /Users/kay', runtime: 'codex' });

  it('a classified failure carries its class (usage_limit, signed_out…), never just "error"', () => {
    expect(errorKind(limit)).toBe('usage_limit');
    expect(errorKind(new RunFailedError({ kind: 'signed_out', detail: 'x' }))).toBe('signed_out');
    expect(errorKind(new TypeError('x'))).toBe('TypeError');
    expect(errorKind(new Error('boom'))).toBe('error');
    // Its words are the card's first line, never the detail with stderr and paths.
    expect(errorMessage(limit)).toBeTruthy();
    expect(errorMessage(limit)).not.toContain('stderr');
    expect(errorMessage(limit)).not.toContain('/Users');
  });

  it('a stop is a stop: the runtimes’ "aborted", an AbortError, or the run’s own signal', () => {
    expect(thrownOutcome(new Error('aborted'))).toBe('stopped');
    expect(thrownOutcome(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('stopped');
    const stopped = new AbortController();
    stopped.abort();
    expect(thrownOutcome(new Error('Codex exited'), stopped.signal)).toBe('stopped');
    expect(thrownOutcome(new Error('Codex exited'), new AbortController().signal)).toBe('error');
    expect(thrownOutcome(limit)).toBe('error');
    expect(errorMessage(new Error('aborted'))).toBeUndefined();
  });

  it('a failed run’s spans say its class and words, in both projects; a stopped one is no failure', () => {
    const tools = [{ id: 'b1', name: 'mcp__beluga_board__task_get', startedAt: 2_000, endedAt: 2_100, ok: true }];
    const failed = turn({ outcome: 'error', errorKind: 'usage_limit', errorMessage: 'You’ve hit your Codex usage limit', tools });
    for (const root of [turnSpans(failed, ID)[0]!, belugaToolSpans(failed, ID)[0]!]) {
      expect(text(root, 'error.type')).toBe('usage_limit');
      expect(text(root, 'error.message')).toBe('You’ve hit your Codex usage limit');
      expect(root.status).toEqual({ code: 2, message: 'You’ve hit your Codex usage limit' });
    }
    // Failed with no class known: still a class.
    expect(text(belugaToolSpans(turn({ outcome: 'error', tools }), ID)[0]!, 'error.type')).toBe('error');
    const stopped = turn({ outcome: 'stopped', errorKind: 'stopped', tools });
    for (const root of [turnSpans(stopped, ID)[0]!, belugaToolSpans(stopped, ID)[0]!]) {
      expect(attr(root, 'error.type')).toBeUndefined();
      expect(root.status).toEqual({ code: 1 });
      expect(text(root, 'ratel.run.outcome')).toBe('stopped');
    }
  });
});

describe('a run, watched', () => {
  const step = (over: Partial<StepRecord>): StepRecord => ({ id: 'x', kind: 'tool', tool: 'Bash', title: 'Bash', status: 'done', startedAt: 1_000, endedAt: 2_000, ...over });
  const input = (over: Partial<AgentRunInput> = {}) => ({ prompt: 'p', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', onEvent: () => undefined, signal: new AbortController().signal, ...over }) as unknown as AgentRunInput;
  const watch = async (backend: AgentBackend, given: AgentRunInput): Promise<TurnFacts> => {
    const facts: TurnFacts[] = [];
    await observedBackend(backend, 'claude', { level: () => 'limited', turn: (f) => facts.push(f) })
      .run(given)
      .catch(() => undefined);
    return facts[0]!;
  };

  it('a failed Beluga tool keeps its stripped words; any other tool only its class', async () => {
    const f = await watch(
      {
        run: async (i: AgentRunInput) => {
          i.onStep?.(step({ id: 'a', tool: 'mcp__beluga_plan__plan_start_task', status: 'error', isError: true, output: '“Login” can’t start: blocked' }));
          i.onStep?.(step({ id: 'b', tool: 'Bash', status: 'error', isError: true, output: 'Exit code 1\nmy secret output' }));
          return 'done';
        },
      } as unknown as AgentBackend,
      input(),
    );
    expect(f.tools.map((t) => t.errorMessage)).toEqual(['… can’t start: blocked', undefined]);
    const [, span] = belugaToolSpans(f, ID);
    expect(text(span!, 'error.message')).toBe('… can’t start: blocked');
    expect(span!.status).toEqual({ code: 2, message: '… can’t start: blocked' });
    expect(JSON.stringify(f)).not.toContain('my secret output');
  });

  it('a call that waited behind others says how long, apart from its own time', async () => {
    const f = await watch(
      {
        run: async (i: AgentRunInput) => {
          i.onToolRun?.('q', 500_000);
          i.onStep?.(step({ id: 'q', tool: 'mcp__beluga_board__task_get', startedAt: 1_000, endedAt: 501_000 }));
          return 'done';
        },
      } as unknown as AgentBackend,
      input(),
    );
    expect(f.tools[0]!.ranAt).toBe(500_000);
    const [, span] = belugaToolSpans(f, ID);
    expect(attr(span!, 'ratel.tool.queued_ms')).toEqual({ intValue: '499000' });
  });

  it('a stopped run (the runtimes throw "aborted") is stopped, not failed', async () => {
    const f = await watch({ run: async () => Promise.reject(new Error('aborted')) } as unknown as AgentBackend, input());
    expect(f.outcome).toBe('stopped');
    const limit = await watch({ run: async () => Promise.reject(new RunFailedError({ kind: 'usage_limit', detail: 'x' })) } as unknown as AgentBackend, input());
    expect(limit.outcome).toBe('error');
    expect(limit.errorKind).toBe('usage_limit');
    expect(limit.errorMessage).toBeTruthy();
  });

  it('only a sentinel’s own run is "sentinel": every run of yours has the sentinel tools and their note', () => {
    expect(placeOf(input({ sentinelBrief: 'Sentinels: …', place: { cwd: '/w' } } as Partial<AgentRunInput>))).toBe('worktree');
    expect(placeOf(input({ sentinelBrief: 'Sentinels: …', sentinelRun: true }))).toBe('sentinel');
    expect(placeOf(input({ sentinelBrief: 'Sentinels: …' }))).toBe('room');
  });
});

describe('a wait for you on Beluga’s own project', () => {
  it('an approved wait is on the call, so a long call that waited on a person isn’t read as a stall', () => {
    const f = turn({
      tools: [{ id: 'w', name: 'mcp__beluga_board__task_brief_edit', startedAt: 1_000, endedAt: 400_000, ok: true }],
      waits: [{ kind: 'permission', tool: 'mcp__beluga_board__task_brief_edit', startedAt: 1_500, endedAt: 399_000, outcome: 'approved' }],
    });
    const [, span] = belugaToolSpans(f, ID);
    expect(text(span!, 'ratel.wait.kind')).toBe('permission');
    expect(text(span!, 'ratel.wait.outcome')).toBe('approved');
    expect(attr(span!, 'ratel.wait.human_ms')).toEqual({ intValue: '397500' });
    expect(span!.status).toEqual({ code: 1 });
  });
});
