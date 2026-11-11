import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexEvents, toolCallOf, unwrapShell, usageEvent } from '../src/agent/runtime/codex/events.js';
import { createCodexBackend, codexEffort, codexModel, toCodexModelChoices } from '../src/agent/runtime/codex/runner.js';
import type { AgentRunInput, FollowUp, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';
import { failureText } from '../src/shared/run-failure.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

const cwd = process.cwd();

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[] } {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r), onFileTouched: () => undefined, canUseTool: async () => true, sandbox: true, events, steps, ...extra };
}

const backend = (codex: FakeCodex) => createCodexBackend({ cwd, autoEdit: true, additionalDirectories: ['/tmp/extra'], bridge: room, connect: codex.connect });

describe("Codex's items as Beluga's steps", () => {
  it('names each item as the tool Beluga already draws', () => {
    expect(toolCallOf({ type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'npm test'", cwd, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null }, cwd)).toEqual({ name: 'Bash', input: { command: 'npm test' } });
    expect(toolCallOf({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'add' }, diff: '+x' }] }, cwd)).toEqual({ name: 'Write', input: { file_path: path.join(cwd, 'src/a.ts') } });
    expect(toolCallOf({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '' }] }, cwd)?.name).toBe('Edit');
    expect(toolCallOf({ type: 'mcpToolCall', id: 'm', server: 'beluga', tool: 'send_chat', status: 'inProgress', arguments: { text: 'hi' }, result: null, error: null }, cwd)).toEqual({ name: 'mcp__beluga__send_chat', input: { text: 'hi' } });
    expect(toolCallOf({ type: 'webSearch', id: 'w', query: 'codex' }, cwd)).toEqual({ name: 'WebSearch', input: { query: 'codex' } });
    expect(toolCallOf({ type: 'agentMessage', id: 'a', text: 'hi' }, cwd)).toBeUndefined();
  });

  it('unwraps the login shell around a command', () => {
    expect(unwrapShell("/bin/zsh -lc 'git status'")).toBe('git status');
    expect(unwrapShell('bash -c "ls -la"')).toBe('ls -la');
    expect(unwrapShell('ls')).toBe('ls');
  });

  it('streams a file change, an MCP call and thinking as records, and says which files changed', () => {
    const steps: StepRecord[] = [];
    const events: Array<[string, string]> = [];
    const touched: string[] = [];
    const ev = new CodexEvents(cwd, { onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r) }, { onFileTouched: (f) => void touched.push(f) });
    ev.beginTurn({ onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r) });
    const change = { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'README.md', kind: { type: 'update' }, diff: '-a\n+b' }] };
    ev.handle('item/started', { item: change });
    ev.handle('item/completed', { item: { ...change, status: 'completed' } });
    ev.handle('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'beluga', tool: 'list_peers', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'nobody' }] }, error: null } });
    ev.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Looking at the readme.'], content: [] } });
    ev.handle('item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Done.' } });
    expect(touched).toEqual([path.join(cwd, 'README.md')]);
    expect(steps.find((s) => s.id === 'f1' && s.status === 'done')).toMatchObject({ tool: 'Edit', output: '-a\n+b' });
    expect(steps.find((s) => s.id === 'm1' && s.status === 'done')).toMatchObject({ tool: 'mcp__beluga__list_peers', output: 'nobody' });
    expect(steps.find((s) => s.kind === 'thinking')).toMatchObject({ text: 'Looking at the readme.' });
    expect(events).toContainEqual(['text', 'Done.']);
    expect(ev.endTurn().text).toBe('Done.');
  });

  it('reports tokens in the shape usage events carry', () => {
    expect(JSON.parse(usageEvent({ totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, 't'))).toEqual({ input: 15, output: 10, cacheRead: 5, cacheWrite: 0, cost: 0, session: 't' });
  });
});

describe('a Codex run', () => {
  it("mounts Beluga's tools as stdio MCP servers and gives Beluga's instructions as developer instructions", async () => {
    const codex = new FakeCodex();
    const run = input('hello', { scratchDir: '.beluga/scratch' });
    expect(await backend(codex).run(run)).toBe('echo: hello');
    const [start] = codex.sent('thread/start');
    const config = start!.config as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    expect(Object.keys(config)).toEqual(expect.arrayContaining(['mcp_servers.beluga', 'mcp_servers.beluga_view']));
    expect(config['mcp_servers.beluga']!.args.slice(-2)).toEqual(['mcp-serve', 'beluga']);
    expect(config['mcp_servers.beluga']!.env.BELUGA_TOOLS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(start!.developerInstructions).toMatch(/kay's Codex/);
    expect(start!.developerInstructions).toContain('beluga-graph');
    expect(start!.developerInstructions).toContain('.beluga/scratch');
    expect(start).toMatchObject({ cwd, approvalPolicy: 'on-request', config: { default_permissions: 'beluga' } });
    expect(start!.sandbox).toBeUndefined();
    const profile = (start!.config as Record<string, { extends: string; filesystem: Record<string, string>; network: { enabled: boolean } }>)['permissions.beluga']!;
    expect(profile).toMatchObject({ extends: ':workspace', network: { enabled: true } });
    expect(profile.filesystem).toMatchObject({ [cwd]: 'write', [path.resolve('/tmp/extra')]: 'write', [`${cwd}/**/.env*`]: 'deny' });
    // A turn's own sandbox would replace the profile: none is sent.
    expect(codex.sent('turn/start')[0]!.sandboxPolicy).toBeUndefined();
    expect(run.events.some(([k]) => k === 'usage')).toBe(true);
  });

  it('takes Codex model names and maps efforts, leaving Claude aliases to its default', () => {
    expect(codexModel('gpt-5.5')).toBe('gpt-5.5');
    expect(codexModel('sonnet')).toBeUndefined();
    expect(codexModel(undefined)).toBeUndefined();
    expect(codexEffort('max')).toBe('xhigh');
    expect(codexEffort('low')).toBe('low');
  });

  it('starts a new thread when the one to resume is gone', async () => {
    const codex = new FakeCodex();
    const sessions: string[] = [];
    const run = input('hello', { place: { cwd, additionalDirectories: [], autoEdit: true, resume: 'gone', onSession: (id) => void sessions.push(id) } });
    expect(await backend(codex).run(run)).toBe('echo: hello');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toBe('gone');
    expect(run.events.some(([k, t]) => k === 'progress' && /new Codex conversation/.test(t))).toBe(true);
  });

  it('plans in a read-only turn, then works once the plan is approved', async () => {
    const codex = new FakeCodex();
    const approved = vi.fn();
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: true, feedback: '' }));
    await backend(codex).run(input('hello', { plan: true, askUser, planTask: { needsDefinition: () => false, approved } }));
    const profileOf = (p: Record<string, unknown>) => (p.config as Record<string, { extends: string }>)['permissions.beluga']!.extends;
    expect(profileOf(codex.sent('thread/start')[0]!)).toBe(':read-only');
    expect(askUser).toHaveBeenCalledWith({ kind: 'plan', plan: 'echo: Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.' });
    expect(approved).toHaveBeenCalled();
    // The work is done on the same thread, reopened under the working profile.
    expect(codex.connections).toBe(2);
    const [resumed] = codex.sent('thread/resume');
    expect(resumed!.threadId).toBe(codex.sent('turn/start')[0]!.threadId);
    expect(profileOf(resumed!)).toBe(':workspace');
    expect(codex.sent('turn/start')).toHaveLength(2);
  });

  it('a main folder is read only', async () => {
    const codex = new FakeCodex();
    await backend(codex).run(input('hello', { place: { cwd, additionalDirectories: [], autoEdit: false, askOnly: { project: 'beluga' }, onSession: () => undefined } }));
    const profile = (codex.sent('thread/start')[0]!.config as Record<string, { extends: string; filesystem: Record<string, string> }>)['permissions.beluga']!;
    expect(profile.extends).toBe(':read-only');
    expect(profile.filesystem[cwd]).toBe('read');
  });

  it('steers a message into the running turn', async () => {
    const codex = new FakeCodex();
    const steers: Array<Steer | undefined> = [];
    const run = input('wait', { onSteer: (s) => void steers.push(s) });
    const running = backend(codex).run(run);
    await vi.waitFor(() => expect(run.steps.some((s) => s.status === 'running')).toBe(true));
    const folded = vi.fn();
    const msg: FollowUp = { prompt: 'also this', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: () => undefined, onError: () => undefined, onFolded: folded };
    expect(steers.at(-1)!(msg)).toBe(true);
    await vi.waitFor(() => expect(folded).toHaveBeenCalled());
    expect(codex.sent('turn/steer')[0]).toMatchObject({ expectedTurnId: expect.any(String) });
    expect(steers.at(-1)!.status!()).toMatchObject({ between: false, alive: true, tool: { label: 'echo wait' } });
    await steers.at(-1)!.interrupt!({ ...msg, prompt: 'hello' }, 'Stopped.');
    await expect(running).resolves.toBe('Stopped.');
  });

  it("asks you before a command leaves Codex's sandbox", async () => {
    const codex = new FakeCodex();
    const canUseTool = vi.fn(async () => false);
    await backend(codex).run(input('ask first', { canUseTool }));
    expect(canUseTool).toHaveBeenCalledWith('Bash', { command: 'echo ask first' });
    expect(codex.approvals).toEqual([{ decision: 'decline' }]);
  });

  it("confines a friend's task as the trust table says: no network, no home, no asking, none of your own Codex tools", async () => {
    const codex = new FakeCodex();
    const vetTool = vi.fn(() => undefined);
    expect(await backend(codex).run(input('hello', { vetTool, viaAgent: true, scope: 'folder' }))).toBe('echo: hello');
    const start = codex.sent('thread/start')[0]!;
    const config = start.config as Record<string, unknown>;
    const profile = config['permissions.beluga'] as { filesystem: Record<string, string>; network: { enabled: boolean } };
    expect(start.approvalPolicy).toBe('never');
    expect(profile.network.enabled).toBe(false);
    if (process.platform === 'linux') {
      expect(profile.filesystem[':minimal']).toBe('read');
      expect(profile.filesystem[os.homedir()]).toBeUndefined();
    } else expect(profile.filesystem[os.homedir()]).toBe('deny');
    expect(profile.filesystem[`${cwd}/**/.env*`]).toBe('deny');
    expect(config).toMatchObject({ 'mcp_servers.figma.enabled': false, 'features.plugins': false, 'features.apps': false, 'shell_environment_policy.inherit': 'core' });
    // Beluga's own tools stay, gated by the friend's limits.
    expect(config['mcp_servers.beluga']).toBeDefined();
  });

  describe("on Codex's unelevated Windows sandbox, which can't deny reads (#425)", () => {
    const profileOf = (p: Record<string, unknown>) => (p.config as Record<string, { filesystem: Record<string, string> }>)['permissions.beluga']!;
    const windows = (): FakeCodex => Object.assign(new FakeCodex(), { unelevatedWindows: true });

    it('your own worktree run opens with writes still confined, and says what it can read', async () => {
      const codex = windows();
      const run = input('hello', { place: { cwd, additionalDirectories: [], autoEdit: true, onSession: () => undefined } });
      expect(await backend(codex).run(run)).toBe('echo: hello');
      const [first, second] = codex.sent('thread/start');
      expect(Object.values(profileOf(first!).filesystem)).toContain('deny');
      expect(Object.values(profileOf(second!).filesystem)).not.toContain('deny');
      expect(profileOf(second!).filesystem[cwd]).toBe('write');
      expect(second!.developerInstructions).toMatch(/can't hide \.env files/);
      expect(run.events.some(([k, t]) => k === 'progress' && /can read your \.env files/.test(t))).toBe(true);
    });

    it('learns it once: the next run, and a resumed thread, open without the denials straight away', async () => {
      const codex = windows();
      const sessions: string[] = [];
      const b = backend(codex);
      const place = (resume?: string) => ({ cwd, additionalDirectories: [], autoEdit: true, ...(resume ? { resume } : {}), onSession: (id: string) => void sessions.push(id) });
      await b.run(input('hello', { place: place() }));
      await b.run(input('again', { place: place(sessions[0]) }));
      expect(codex.sent('thread/start')).toHaveLength(2);
      expect(codex.sent('thread/resume')).toHaveLength(1);
      expect(sessions[1]).toBe(sessions[0]);
    });

    it("refuses a friend's task rather than run it without its denials", async () => {
      const codex = windows();
      const err = await backend(codex).run(input('hello', { vetTool: () => undefined, viaAgent: true, scope: 'full' })).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/can’t keep this task away from/);
      expect(codex.sent('thread/start').every((s) => Object.values(profileOf(s).filesystem).includes('deny'))).toBe(true);
      expect(codex.sent('turn/start')).toHaveLength(0);
    });
  });

  it("asks you before an edit outside the run's folders, in the same prompt as Claude's", async () => {
    const codex = new FakeCodex();
    const canUseTool = vi.fn(async () => true);
    await backend(codex).run(input('edit the hosts file', { canUseTool, scope: 'full' }));
    expect(canUseTool).toHaveBeenCalledWith('Edit', { file_path: path.resolve('/etc/hosts') });
    expect(codex.approvals).toEqual([{ decision: 'accept' }]);
  });

  it("fails as Codex's failure, saying to sign in when that's why", async () => {
    const err = await backend(new FakeCodex()).run(input('fail')).catch((e: Error) => e);
    expect(failureText((err as Error).message)).toBe("OpenAI's API failed: Your access token could not be refreshed. Sign in to Codex again (`codex login`), then resend.");
  });

  it('lists its models for the picker', async () => {
    expect(await backend(new FakeCodex()).listModels!()).toEqual([{ value: '', label: 'GPT-5.5', description: 'Frontier', efforts: ['low', 'high'] }]);
    expect(toCodexModelChoices([{ id: 'x', model: 'x', displayName: 'X', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [] }])).toEqual([]);
  });
});

describe('the Codex runtime', () => {
  it("never runs Claude Code's binary as Codex (the Mac app's executablePath is Claude's)", async () => {
    const { createCodexRuntime } = await import('../src/agent/runtime/codex/index.js');
    const codex = new FakeCodex();
    const bins: Array<string | undefined> = [];
    const connect: typeof codex.connect = (opts) => {
      bins.push(opts.bin);
      return codex.connect(opts);
    };
    const backend = createCodexRuntime({ connect }).create({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, executablePath: '/Applications/Beluga.app/claude' });
    expect(await backend.run(input('hello'))).toBe('echo: hello');
    expect(bins).toEqual([undefined]);
  });
});
