import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/runtime/claude/runner.js';
import { contextEvent } from '../src/agent/runtime/codex/events.js';
import { NOT_ALLOWED, codexComplete, sideCallGate } from '../src/agent/runtime/codex/complete.js';
import { TOOL_TIMEOUT_SEC, clampEffort, createCodexBackend, mcpConfig, pickCodexModel, smallCodexModel } from '../src/agent/runtime/codex/runner.js';
import type { Model } from '../src/agent/runtime/codex/protocol.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import type { ToolGate, ToolHost } from '../src/agent/tool-host.js';
import type { AgentRunInput, BoardTools, FollowUp, Steer } from '../src/agent/types.js';
import { FakeClaude } from './fake-claude.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

// Claude Code behind a scripted Agent SDK `query` (fake-claude.ts), for the same runs on Claude.
const fakeClaude = vi.hoisted(() => ({ query: undefined as unknown as (args: unknown) => unknown }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...(await original<object>()), query: (args: unknown) => fakeClaude.query(args) }));
vi.mock('../src/agent/claude-code.js', async (original) => ({ ...(await original<object>()), claudeCodeReady: async () => undefined }));

/** BLG-504: a Codex conversation behaves like Claude's (plan mode, asking, tools, the meter, models, wording). */

const cwd = process.cwd();

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]> } {
  const events: Array<[string, string]> = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onFileTouched: () => undefined, canUseTool: async () => true, events, ...extra };
}

const backend = (codex: FakeCodex) => createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect });
const texts = (codex: FakeCodex): string[] => codex.sent('turn/start').map((p) => (p.input as Array<{ type: string; text?: string }>).find((i) => i.type === 'text')!.text!);

const model = (id: string, extra: Partial<Model> = {}): Model => ({ id, model: id, displayName: id, description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [], ...extra });

describe('plan mode on Codex', () => {
  it('declines every escalation while planning, whatever would allow it, and asks for nothing', async () => {
    const codex = new FakeCodex();
    const canUseTool = vi.fn(async () => true);
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: false, feedback: 'smaller' }));
    await backend(codex).run(input('ask to look around', { plan: true, askUser, canUseTool }));
    expect(codex.sent('thread/start')[0]!.approvalPolicy).toBe('never');
    expect(codex.sent('turn/start')[0]!.approvalPolicy).toBe('never');
    expect(codex.approvals[0]).toEqual({ decision: 'decline' });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('"Keep planning" without a word: Codex asks what to change, and the run ends on its question', async () => {
    const codex = new FakeCodex();
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: false, feedback: '' }));
    const answer = await backend(codex).run(input('hello', { plan: true, askUser }));
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(texts(codex)).toHaveLength(2);
    expect(texts(codex)[1]).toMatch(/did not approve the plan yet\. Ask them what they would like to change/);
    expect(answer).toMatch(/^echo: The person did not approve/);
    // Still planning: never reopened for work.
    expect(codex.connections).toBe(1);
  });

  it("a plan for a task: Codex defines the task first (task_define), once, as Claude does", async () => {
    const codex = new FakeCodex();
    let defined = false;
    const needsDefinition = vi.fn(() => !defined);
    const askUser = vi.fn(async () => {
      defined = true;
      return { kind: 'plan' as const, approve: true, feedback: '' };
    });
    await backend(codex).run(input('hello', { plan: true, askUser, planTask: { needsDefinition, approved: () => undefined } }));
    const sent = texts(codex);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatch(/call mcp__beluga_board__task_define/);
    expect(sent[2]).toBe('The plan is approved. Do the work now.');
    // The plan that comes to you is the one after the definition.
    expect(askUser).toHaveBeenCalledWith({ kind: 'plan', plan: expect.stringMatching(/^echo: Before the plan goes/) });
  });
});

describe('"My agent asks before commands" on Codex', () => {
  it('your own run asks for every command (untrusted); a friend’s row stays as the trust table says', async () => {
    const own = new FakeCodex();
    await backend(own).run(input('hello', { askBeforeCommands: true }));
    expect(own.sent('thread/start')[0]!.approvalPolicy).toBe('untrusted');
    expect(own.sent('turn/start')[0]!.approvalPolicy).toBe('untrusted');

    const off = new FakeCodex();
    await backend(off).run(input('hello'));
    expect(off.sent('thread/start')[0]!.approvalPolicy).toBe('on-request');

    const friend = new FakeCodex();
    await backend(friend).run(input('hello', { askBeforeCommands: true, viaAgent: true, vetTool: () => undefined, scope: 'folder' }));
    expect(friend.sent('thread/start')[0]!.approvalPolicy).toBe('never');
  });

  it('a command it asks about comes to you', async () => {
    const codex = new FakeCodex();
    const canUseTool = vi.fn(async () => false);
    await backend(codex).run(input('ask first', { askBeforeCommands: true, canUseTool }));
    expect(canUseTool).toHaveBeenCalledWith('Bash', { command: 'echo ask first' });
    expect(codex.approvals).toEqual([{ decision: 'decline' }]);
  });
});

/** What Beluga answers when a run's agent calls one of its tools: allowed (undefined) or why not. */
type Decision = string | undefined;
const ARGS = { peer: 'mia', command: 'uptime' };

/** The Codex run: its tool calls go through Codex (fake-codex.ts) to the tool server's gate, as the real stdio server's do. */
async function codexDecides(tool: string, run: Partial<AgentRunInput>): Promise<Decision[]> {
  const codex = new FakeCodex();
  let gate: ToolGate = async () => 'not mounted';
  let mounted: string[] = [];
  const toolHost = { mount: async (suites: Record<string, unknown>, g: ToolGate) => ((gate = g), (mounted = Object.keys(suites)), { token: 't', servers: Object.fromEntries(mounted.map((n) => [n, { type: 'stdio', command: 'x', args: [], env: {} }])), close: () => undefined }) } as unknown as ToolHost;
  const decisions: Decision[] = [];
  codex.mcpCall = async (server, name, args) => void decisions.push(mounted.includes(server) ? await gate(`mcp__${server}__${name}`, args) : 'not Beluga’s');
  await createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect, toolHost }).run(input(`mcp ${tool}`, run));
  // A call Codex refused itself never reached Beluga: that's a difference too.
  return [...decisions, ...codex.refused.map((t) => `refused by Codex: ${t}`)];
}

/** The Claude run: Claude Code asks its PreToolUse hook, then canUseTool, before an MCP tool runs. */
async function claudeDecides(tool: string, run: Partial<AgentRunInput>): Promise<Decision[]> {
  const claude = new FakeClaude();
  fakeClaude.query = claude.query as (args: unknown) => unknown;
  await createClaudeBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room }).run(input('hello', run));
  const options = claude.options[0]!;
  const name = `mcp__${tool.replace('/', '__')}`;
  const hook = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
  const said = (await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: ARGS, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd } as never, 't1', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  if (said.hookSpecificOutput?.permissionDecision === 'deny') return [said.hookSpecificOutput.permissionDecisionReason];
  if (said.hookSpecificOutput?.permissionDecision === 'allow') return [undefined];
  const verdict = await (options.canUseTool as CanUseTool)(name, ARGS, { signal: new AbortController().signal, toolUseID: 't1' } as never);
  return [verdict?.behavior === 'deny' ? verdict.message : undefined];
}

describe("Beluga's tools get the same answer on Codex as on Claude", () => {
  /** A friend's limits (gateway's vetTool stands in): their run may not reach your other machines. */
  const friendLimits = (name: string): string | undefined => (name === 'mcp__beluga__run_on_peer' ? 'Your friend’s task can’t run commands on your machines.' : undefined);
  const kinds: Array<[string, Partial<AgentRunInput>]> = [
    ['your own run', { scope: 'full' }],
    ['a plan being made', { scope: 'full', plan: true }],
    ["a friend's task", { scope: 'folder', viaAgent: true, vetTool: friendLimits, boardAsks: 'writes' }],
    ["a full-trust friend's task", { scope: 'full', viaAgent: true, vetTool: friendLimits }],
    ['an external agent below Full trust', { scope: 'folder', asOwner: true }],
  ];
  const tools = ['beluga_board/task_define', 'beluga_board/task_get', 'beluga/run_on_peer', 'beluga/send_chat'];

  it.each(kinds.flatMap(([kind, run]) => tools.map((tool) => [kind, tool, run] as const)))('%s: %s', async (_kind, tool, run) => {
    for (const answer of [true, false]) {
      const asked = { codex: [] as string[], claude: [] as string[] };
      const runFor = (who: 'codex' | 'claude'): Partial<AgentRunInput> => ({
        ...run,
        board: {} as BoardTools,
        canUseTool: async (name) => (name.startsWith('mcp__') && asked[who].push(name), answer),
      });
      const codex = await codexDecides(tool, runFor('codex'));
      const claude = await claudeDecides(tool, runFor('claude'));
      expect(codex).toEqual(claude);
      expect(asked.codex).toEqual(asked.claude);
    }
  });

  it('a plan for a task: the task_define Codex is told to call reaches the gate and runs, as on Claude', async () => {
    const codex = new FakeCodex();
    const ran: Array<[string, Decision]> = [];
    let gate: ToolGate = async () => 'not mounted';
    const toolHost = { mount: async (suites: Record<string, unknown>, g: ToolGate) => ((gate = g), { token: 't', servers: Object.fromEntries(Object.keys(suites).map((n) => [n, { type: 'stdio', command: 'x', args: [], env: {} }])), close: () => undefined }) } as unknown as ToolHost;
    codex.mcpCall = async (server, tool, args) => void ran.push([`mcp__${server}__${tool}`, await gate(`mcp__${server}__${tool}`, args)]);
    let defined = false;
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: true, feedback: '' }));
    await createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect, toolHost }).run(
      input('hello', { plan: true, askUser, board: {} as BoardTools, planTask: { needsDefinition: () => !defined, approved: () => void (defined = true) } }),
    );
    expect(codex.sent('thread/start')[0]!.approvalPolicy).toBe('never');
    expect(ran).toEqual([['mcp__beluga_board__task_define', undefined]]);
    expect(codex.refused).toEqual([]);
    expect(await claudeDecides('beluga_board/task_define', { plan: true })).toEqual([undefined]);
  });

  it("a quick side call: its vetTool decides, else only the tools it allows run, as Claude Code's allowedTools", () => {
    expect(sideCallGate({ allowedTools: ['mcp__beluga_chat__read_earlier'] }, 'mcp__beluga_chat__read_earlier', {})).toBeUndefined();
    expect(sideCallGate({ allowedTools: ['mcp__beluga_chat__read_earlier'] }, 'mcp__beluga_chat__other', {})).toBe(NOT_ALLOWED);
    expect(sideCallGate({}, 'mcp__beluga_chat__read_earlier', {})).toBe(NOT_ALLOWED);
    expect(sideCallGate({ vetTool: () => ({ allow: true, reason: 'looks' }) }, 'mcp__beluga_chat__other', {})).toBeUndefined();
    expect(sideCallGate({ allowedTools: ['t'], vetTool: () => ({ allow: false, reason: 'no' }) }, 't', {})).toBe('no');
  });
});

describe("Beluga's tools on Codex", () => {
  it.each(['beluga_plan', 'beluga_board'])("lets %s calls reach Beluga's own permission gate", (name) => {
    const config = mcpConfig({ [name]: { type: 'stdio', command: 'node', args: [], env: {} } });
    expect(config[`mcp_servers.${name}`]).toMatchObject({ default_tools_approval_mode: 'approve' });
  });

  it('waits long enough for a tool that waits on you or a friend (tool_timeout_sec)', async () => {
    expect(TOOL_TIMEOUT_SEC).toBeGreaterThanOrEqual(900);
    expect(mcpConfig({ beluga: { type: 'stdio', command: 'node', args: [], env: {} } })['mcp_servers.beluga']).toMatchObject({ tool_timeout_sec: TOOL_TIMEOUT_SEC });
    const codex = new FakeCodex();
    await backend(codex).run(input('hello'));
    const config = codex.sent('thread/start')[0]!.config as Record<string, { tool_timeout_sec?: number }>;
    expect(config['mcp_servers.beluga']!.tool_timeout_sec).toBe(TOOL_TIMEOUT_SEC);
  });

  it("turns Codex's own multi-agent on for your runs (its sub-agents show, BLG-519), off for side calls", async () => {
    const codex = new FakeCodex();
    await backend(codex).run(input('hello'));
    expect((codex.sent('thread/start')[0]!.config as Record<string, unknown>)['features.multi_agent']).toBe(true);
    const side = new FakeCodex();
    await codexComplete({ system: 'Name it.', prompt: 'name this', cwd }, { connect: side.connect });
    expect((side.sent('thread/start')[0]!.config as Record<string, unknown>)['features.multi_agent']).toBe(false);
  });

  it("a side call's instructions are its system alone: no project docs, so none to load under Codex's sandbox (#425)", async () => {
    const side = new FakeCodex();
    await codexComplete({ system: 'Name it.', prompt: 'name this', cwd }, { connect: side.connect });
    expect((side.sent('thread/start')[0]!.config as Record<string, unknown>).project_doc_max_bytes).toBe(0);
  });
});

describe("Codex's context meter", () => {
  it("emits the 'context' event Claude's runs do: the window's tokens and the model's window", async () => {
    const codex = new FakeCodex();
    const run = input('hello');
    await backend(codex).run(run);
    const ctx = run.events.filter(([k]) => k === 'context').map(([, t]) => JSON.parse(t));
    expect(ctx).toEqual([{ used: 30, window: 258400, model: 'gpt-fake' }]);
  });

  it('falls back to Beluga’s window when Codex says none, and says nothing before any tokens', () => {
    expect(JSON.parse(contextEvent({ last: { totalTokens: 0, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }, modelContextWindow: null }, 'gpt-x')!)).toEqual({ used: 1000, window: 200_000, model: 'gpt-x' });
    expect(contextEvent({ modelContextWindow: 1000 })).toBeUndefined();
  });
});

describe('models and efforts on Codex', () => {
  it("clamps the effort to the model's own", async () => {
    expect(clampEffort('medium', ['low', 'high'])).toBe('low');
    expect(clampEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    expect(clampEffort('max', ['low', 'high'])).toBe('high');
    expect(clampEffort('low', ['high', 'xhigh'])).toBe('high');
    expect(clampEffort('high', undefined)).toBe('high');
    expect(clampEffort(undefined, ['low'])).toBeUndefined();
    const codex = new FakeCodex();
    await backend(codex).run(input('hello', { effort: 'xhigh' }));
    expect(codex.sent('turn/start')[0]!.effort).toBe('high');
  });

  it('a model picked after the run started: the next turn runs on it, its effort clamped to it', async () => {
    const codex = new FakeCodex();
    codex.models = [...codex.models, model('gpt-other', { supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] })];
    const steers: Array<Steer | undefined> = [];
    const run = input('wait', { effort: 'high', onSteer: (s) => void steers.push(s) });
    const running = backend(codex).run(run);
    await vi.waitFor(() => expect(codex.sent('turn/start')).toHaveLength(1));
    await vi.waitFor(() => expect(steers.at(-1)).toBeDefined());
    const done = vi.fn();
    const next: FollowUp = { prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], model: 'gpt-other', onEvent: () => undefined, onDone: done, onError: () => undefined };
    await vi.waitFor(async () => expect(await steers.at(-1)!.interrupt!(next, 'Stopped.')).toBe(true));
    await running;
    expect(done).toHaveBeenCalledWith('echo: hello');
    const [first, second] = codex.sent('turn/start');
    expect(first).toMatchObject({ effort: 'high' });
    expect(first!.model).toBeUndefined();
    expect(second).toMatchObject({ model: 'gpt-other', effort: 'medium' });
  });

  it("maps Claude's aliases: haiku to Codex's small, fast model, sonnet and opus to its default", async () => {
    const list = [model('gpt-5.5', { isDefault: true, description: 'Fast frontier model' }), model('gpt-hidden-mini', { hidden: true }), model('gpt-5.5-mini', { description: 'Fast and affordable model for easier tasks.' })];
    expect(smallCodexModel(list)).toBe('gpt-5.5-mini');
    expect(smallCodexModel([model('gpt-5.5', { isDefault: true })])).toBeUndefined();
    expect(await pickCodexModel('haiku', async () => list)).toBe('gpt-5.5-mini');
    expect(await pickCodexModel('claude-haiku-4-5', async () => list)).toBe('gpt-5.5-mini');
    // No list, or none small: Codex's default.
    expect(await pickCodexModel('haiku', async () => Promise.reject(new Error('down')))).toBeUndefined();
    expect(await pickCodexModel('sonnet', async () => list)).toBeUndefined();
    expect(await pickCodexModel('opus', async () => list)).toBeUndefined();
    expect(await pickCodexModel('', async () => list)).toBe('gpt-5.5');
    expect(await pickCodexModel('gpt-x', async () => list)).toBe('gpt-x');

    const codex = new FakeCodex();
    codex.models = list;
    await codexComplete({ cwd, system: 'Name it.', prompt: 'echo', model: 'haiku' }, { connect: codex.connect });
    expect(codex.sent('thread/start')[0]!.model).toBe('gpt-5.5-mini');
  });
});

describe('wording true to Codex', () => {
  const worktree = (agent?: { runtime: 'codex' | 'claude'; label: string }) => runInstructions(input('hi', { env: { KLAUD_WORKTREE: cwd } }), 'kay', agent);

  it('says the sandbox denies .env files, and how to keep a server running without run_in_background', () => {
    const codex = worktree({ runtime: 'codex', label: 'Codex' });
    expect(codex).toMatch(/your sandbox denies \.env files/);
    expect(codex).not.toMatch(/\.env file asks them first/);
    expect(codex).toContain('BELUGA_KEEP=1 nohup npm run dev > .beluga/dev.log 2>&1 &');
    expect(codex).not.toContain('run_in_background');
  });

  it("keeps Claude's words as they were", () => {
    const claude = worktree();
    expect(claude).toMatch(/\.env file asks them first/);
    expect(claude).toContain('run_in_background works too');
  });
});

describe("a model Codex's config names that the account can't use", () => {
  it("falls back to the account's default; a usable or a picked one is left alone", async () => {
    const { pickCodexModel } = await import('../src/agent/runtime/codex/runner.js');
    const list = async () => [
      { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [] },
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [] },
    ] as never;
    expect(await pickCodexModel(undefined, list, async () => 'gpt-5.5')).toBe('gpt-6-luna');
    expect(await pickCodexModel(undefined, list, async () => 'gpt-5.6-terra')).toBeUndefined();
    expect(await pickCodexModel(undefined, list, async () => undefined)).toBeUndefined();
    expect(await pickCodexModel('gpt-5.6-terra', list, async () => 'gpt-5.5')).toBe('gpt-5.6-terra');
  });
});
