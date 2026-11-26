import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import { askOpenCodeBtw } from '../src/agent/runtime/opencode/btw.js';
import { openCodeComplete, sideModel } from '../src/agent/runtime/opencode/complete.js';
import { askEverything, runConfig } from '../src/agent/runtime/opencode/config.js';
import { findOpenCode } from '../src/agent/runtime/opencode/connection.js';
import { OPENCODE_CAPABILITIES, createOpenCodeRuntime } from '../src/agent/runtime/opencode/index.js';
import { parseModels } from '../src/agent/runtime/opencode/models.js';
import { providerErrorOf } from '../src/agent/runtime/opencode/provider.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { createOpenCodeBackend } from '../src/agent/runtime/opencode/runner.js';
import { ScriptedOpenCode } from '../src/agent/runtime/opencode/scripted.js';
import { mapOpenCodeSlash } from '../src/agent/runtime/opencode/skills.js';
import { openCodeStatus } from '../src/agent/runtime/opencode/status.js';
import { belugaCalls, belugaTool, patchFiles } from '../src/agent/runtime/opencode/tools.js';
import type { AgentPlace, AgentRunInput } from '../src/agent/types.js';
import { agentForFriend } from '../src/core/gateway/serve.js';
import { fallbackFor, runtimeHas } from '../src/shared/runtime-fallbacks.js';
import type { StepRecord } from '../src/shared/steps.js';
import { room } from './runtime-conformance.js';

const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-opencode-'));

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[] } {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r), onFileTouched: () => undefined, canUseTool: async () => true, events, steps, ...extra };
}

const place = (extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } => {
  const sessions: string[] = [];
  return { cwd, additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), sessions, ...extra };
};

const backend = (oc: ScriptedOpenCode, resolve = async () => undefined) => createOpenCodeBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: oc.connect, resolve });

describe('Beluga’s config for an OpenCode run', () => {
  it('makes every permission ask (yours and each agent’s), keeps a deny, and turns the question tool off', () => {
    const yours = { '*': 'allow', bash: { 'git *': 'allow', 'rm *': 'deny' }, read: 'allow', mymcp_tool: 'allow' } as const;
    const out = askEverything(yours);
    expect(out['*']).toBe('ask');
    expect(out.bash).toEqual({ 'git *': 'ask', 'rm *': 'deny' });
    expect(out.read).toBe('ask');
    // A tool only your config names (an MCP server's) asks too.
    expect(out.mymcp_tool).toBe('ask');
    for (const key of ['edit', 'glob', 'grep', 'list', 'task', 'webfetch', 'external_directory']) expect(out[key]).toBe('ask');
    expect(out.question).toBe('deny');
    // Everything denied stays denied.
    expect(askEverything('deny')['*']).toBe('deny');
  });

  it('names every agent, its own ones too, and keeps the plan agent from editing; carries on after a decline', () => {
    const config = runConfig({ permission: 'allow', agent: { reviewer: { permission: { '*': 'allow' } } } }, { instructions: '/tmp/beluga.md' });
    const agents = config.agent as Record<string, { permission: Record<string, unknown> }>;
    expect(Object.keys(agents).sort()).toEqual(['build', 'explore', 'general', 'plan', 'reviewer']);
    expect(agents.build!.permission['*']).toBe('ask');
    expect(agents.reviewer!.permission['*']).toBe('ask');
    expect(agents.plan!.permission.edit).toBe('deny');
    expect(config.experimental).toEqual({ continue_loop_on_deny: true });
    expect(config.instructions).toEqual(['/tmp/beluga.md']);
  });
});

/** A path under `/w` as this system resolves it (`D:\w\a.ts` on Windows). */
const inW = (p: string): string => path.resolve('/w', p);

describe('OpenCode’s tools as Beluga’s', () => {
  it('names each the way Claude Code’s are, with their input in Claude Code’s fields', () => {
    expect(belugaCalls('read', { filePath: 'src/a.ts' }, '/w')).toEqual([{ name: 'Read', input: { file_path: inW('src/a.ts') } }]);
    expect(belugaCalls('bash', { command: 'npm test', description: 'tests' }, '/w')).toEqual([{ name: 'Bash', input: { command: 'npm test', description: 'tests' } }]);
    expect(belugaCalls('edit', { filePath: '/w/a.ts', oldString: 'a', newString: 'b' }, '/w')[0]).toEqual({ name: 'Edit', input: { file_path: inW('a.ts'), old_string: 'a', new_string: 'b' } });
    expect(belugaCalls('grep', { pattern: 'TODO', include: '*.ts' }, '/w')[0]).toEqual({ name: 'Grep', input: { pattern: 'TODO', path: '/w', glob: '*.ts' } });
    expect(belugaCalls('list', {}, '/w')[0]).toEqual({ name: 'LS', input: { path: '/w' } });
    expect(belugaCalls('webfetch', { url: 'https://x.dev' }, '/w')[0]!.name).toBe('WebFetch');
  });

  it('judges a patch on each file it touches', () => {
    const patch = '*** Begin Patch\n*** Add File: new.ts\n+x\n*** Update File: src/old.ts\n@@\n-a\n+b\n*** Delete File: gone.ts\n*** End Patch';
    expect(patchFiles(patch, '/w')).toEqual([
      { file: inW('new.ts'), kind: 'add' },
      { file: inW('src/old.ts'), kind: 'update' },
      { file: inW('gone.ts'), kind: 'delete' },
    ]);
    expect(belugaCalls('apply_patch', { patchText: patch }, '/w').map((c) => c.name)).toEqual(['Write', 'Edit', 'Edit']);
  });

  it('tells Beluga’s own MCP tools by their longest suite name', () => {
    expect(belugaTool('beluga_board_task_get', ['beluga', 'beluga_board'])).toBe('mcp__beluga_board__task_get');
    expect(belugaTool('beluga_send_chat', ['beluga', 'beluga_board'])).toBe('mcp__beluga__send_chat');
    expect(belugaTool('github_create_issue', ['beluga'])).toBeUndefined();
    expect(belugaCalls('github_create_issue', { title: 'x' }, '/w', ['beluga'])[0]!.name).toBe('mcp__opencode__github_create_issue');
  });
});

describe('a run on OpenCode', () => {
  it('gives OpenCode Beluga’s config and instructions, and its tools as stdio MCP servers', async () => {
    const oc = new ScriptedOpenCode();
    const at = place();
    let instructions = '';
    const run = input('hello', { place: at, onEvent: (k, t) => {
      // While it runs, the instructions file is there for OpenCode to read.
      if (k === 'text' && !instructions) instructions = readFileSync((oc.lastConfig().instructions as string[])[0]!, 'utf8');
      void t;
    } });
    expect(await backend(oc).run(run)).toBe('echo: hello');
    const config = oc.lastConfig();
    expect((config.permission as Record<string, string>)['*']).toBe('ask');
    expect(instructions).toContain('Beluga');
    // Gone once the run ends.
    expect(existsSync((config.instructions as string[])[0]!)).toBe(false);
    const servers = oc.sent('session/new')[0]!.mcpServers as Array<{ name: string; command: string; env: Array<{ name: string }> }>;
    expect(servers.map((s) => s.name)).toContain('beluga');
    expect(servers[0]!.env.map((e) => e.name)).toEqual(['BELUGA_TOOLS_URL', 'BELUGA_TOOLS_TOKEN']);
  });

  it('judges a read on the path from its update when its permission request names none, and turns a secret down', async () => {
    writeFileSync(path.join(cwd, 'notes.md'), 'hi');
    const oc = new ScriptedOpenCode();
    const ok = input(`read ${path.join(cwd, 'notes.md')}`);
    expect(await backend(oc).run(ok)).toBe(`read: ${path.join(cwd, 'notes.md')}`);
    expect(ok.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Read', status: 'done', input: { file_path: path.join(cwd, 'notes.md') } });

    // A key file: denied by Beluga's policy, whatever OpenCode's own config said, and the step says why.
    const secret = input(`read ${path.join(cwd, 'id_rsa')}`);
    expect(await backend(oc).run(secret)).toBe(`denied: read ${path.join(cwd, 'id_rsa')}`);
    expect(oc.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    const step = secret.steps.filter((s) => s.kind === 'tool').at(-1)!;
    expect(step.status).toBe('error');
    expect(step.output).not.toContain('rejected permission');
  });

  it('lets Beluga’s own tools through without asking you twice (their own gate asks)', async () => {
    const oc = new ScriptedOpenCode();
    const canUseTool = vi.fn(async () => false);
    expect(await backend(oc).run(input('board', { canUseTool }))).toBe('board: BLG-1');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('runs on the model picked, its effort clamped to what that model takes', async () => {
    const oc = new ScriptedOpenCode();
    await backend(oc).run(input('hello', { place: place({ model: 'anthropic/claude-sonnet-4-5' }), effort: 'xhigh' }));
    const set = oc.sent('session/set_config_option').map((p) => `${String(p.configId)}=${String(p.value)}`);
    expect(set).toContain('model=anthropic/claude-sonnet-4-5');
    expect(set).toContain('effort=high');
    // Claude's alias means nothing to OpenCode: its own default.
    const other = new ScriptedOpenCode();
    await backend(other).run(input('hello', { model: 'opus' }));
    expect(other.sent('session/set_config_option').filter((p) => p.configId === 'model')).toEqual([]);
  });

  it('plans in OpenCode’s plan agent, then works in build once you approve', async () => {
    const oc = new ScriptedOpenCode();
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: true, feedback: '' }));
    await backend(oc).run(input('hello', { plan: true, askUser }));
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan' }));
    const modes = oc.sent('session/set_config_option').filter((p) => p.configId === 'mode').map((p) => p.value);
    expect(modes).toEqual(['plan', 'build']);
    const prompts = oc.sent('session/prompt').map((p) => JSON.stringify(p.prompt));
    expect(prompts.at(-1)).toContain('The plan is approved');
  });

  it('compacts with its own /compact: the summary stays out of the chat, the window before and after is said', async () => {
    const oc = new ScriptedOpenCode();
    const run = input('/compact');
    await backend(oc).run(run);
    expect(run.events.filter(([k]) => k === 'text')).toEqual([]);
    const compact = JSON.parse(run.events.find(([k]) => k === 'compact')![1]) as { pre: number; post: number; trigger: string };
    expect(compact).toMatchObject({ pre: 0, post: 900, trigger: 'manual' });
  });

  it('continues a conversation later, and forks one into a new session', async () => {
    const oc = new ScriptedOpenCode();
    const first = place();
    await backend(oc).run(input('one', { place: first }));
    const again = place({ resume: first.sessions[0]! });
    await backend(oc).run(input('two', { place: again }));
    expect(oc.sent('session/resume').map((p) => p.sessionId)).toEqual([first.sessions[0]]);
    expect(again.sessions).toEqual([first.sessions[0]]);
    const fork = place({ resume: first.sessions[0]!, forkSession: true });
    await backend(oc).run(input('three', { place: fork }));
    expect(oc.sent('session/fork').map((p) => p.sessionId)).toEqual([first.sessions[0]]);
    expect(fork.sessions[0]).not.toBe(first.sessions[0]);
  });

  it('sends OpenCode’s own commands as they are, and expands a Claude Code custom command for it', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-home-'));
    const commands = path.join(home, 'commands');
    await import('node:fs').then((fs) => fs.mkdirSync(commands, { recursive: true }));
    writeFileSync(path.join(commands, 'ship.md'), '---\ndescription: ship it\n---\nShip $ARGUMENTS now.');
    const own = new Set(['init', 'api-design']);
    expect(await mapOpenCodeSlash('/api-design the login API', cwd, home, own)).toEqual({ prompt: '/api-design the login API', notes: [] });
    expect(await mapOpenCodeSlash('/ship v2', cwd, home, own)).toEqual({ prompt: 'Ship v2 now.', notes: [] });
    expect((await mapOpenCodeSlash('/doctor', cwd, home, own)).notes[0]).toMatch(/not on OpenCode/);
  });

  it('takes no message into a running turn, but stops it for one (Steer Now) and answers it next', async () => {
    const oc = new ScriptedOpenCode();
    const steers: Array<Parameters<NonNullable<AgentRunInput['onSteer']>>[0]> = [];
    const run = input('wait for it', { onSteer: (s) => void steers.push(s) });
    const running = backend(oc).run(run);
    await vi.waitFor(() => expect(run.steps.some((s) => s.status === 'running')).toBe(true));
    const steer = steers.at(-1)!;
    let answered = '';
    const followUp = { prompt: 'after', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t: string) => void (answered = t), onError: () => undefined };
    expect(steer(followUp)).toBe(false);
    expect(await steer.interrupt!(followUp, 'Stopped to read your message')).toBe(true);
    expect(await running).toContain('Stopped to read your message');
    expect(answered).toBe('echo: after');
    expect(oc.sent('session/cancel')).toHaveLength(1);
  });

  it('ends a turn OpenCode would retry forever on a used-up provider, as a usage limit', async () => {
    const oc = new ScriptedOpenCode();
    const run = input('limit');
    const err = await backend(oc).run(run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunFailedError);
    expect((err as RunFailedError).failure).toMatchObject({ kind: 'usage_limit', runtime: 'opencode', detail: expect.stringContaining('Free usage limit reached') });
    // Its turn was cancelled in OpenCode, not left retrying.
    expect(oc.sent('session/cancel')).toHaveLength(1);
  });

  it('says a provider error while OpenCode retries, and ends the turn once it keeps coming back', async () => {
    const oc = new ScriptedOpenCode();
    const run = input('retry');
    const err = await backend(oc).run(run).catch((e: unknown) => e);
    expect(run.events).toContainEqual(['progress', 'OpenCode is retrying: Too many requests']);
    expect((err as RunFailedError).failure.kind).toBe('usage_limit');
  });

  it('turns away friends’ tasks and guests (its plugins could answer a step before Beluga)', async () => {
    const oc = new ScriptedOpenCode();
    const guarded = guardedBackend(backend(oc), OPENCODE_CAPABILITIES);
    await expect(guarded.run(input('hello', { vetTool: () => undefined }))).rejects.toThrow(/friends/);
    await expect(guarded.run(input('hello', { guest: true }))).rejects.toThrow(/guests/);
  });
});

describe('around a run', () => {
  it('answers a side question on a fork of the conversation, with no tools, and drops the fork', async () => {
    const oc = new ScriptedOpenCode();
    const at = place();
    await backend(oc).run(input('one', { place: at }));
    const drop = vi.fn(async () => true);
    const said: string[] = [];
    const answer = await askOpenCodeBtw({ question: 'hello', cwd, resume: at.sessions[0]!, signal: new AbortController().signal, onText: (t) => void said.push(t) }, { connect: oc.connect, drop });
    expect(oc.sent('session/fork').at(-1)?.sessionId).toBe(at.sessions[0]);
    // It asked to run a command; nothing may run in a side question.
    expect(oc.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(answer).toBe('denied: hello');
    expect(said.at(-1)).toBe('denied: hello');
    expect(oc.starts.at(-1)?.pure).toBe(true);
    // Every tool asks, and Beluga says no (denied in OpenCode's own config, it never answers).
    expect((oc.lastConfig().permission as Record<string, string>)['*']).toBe('ask');
    expect(drop).toHaveBeenCalledWith(oc.sent('session/prompt').at(-1)?.sessionId);
  });

  it('makes a side call as an agent of Beluga’s with only the tools it was given', async () => {
    const oc = new ScriptedOpenCode();
    const drop = vi.fn(async () => true);
    const answer = await openCodeComplete({ prompt: 'hello', system: 'Name this worktree.', cwd, model: 'haiku', tools: ['Bash'], vetTool: () => ({ allow: true, reason: '' }) }, { connect: oc.connect, drop });
    expect(answer).toBe('echo: hello');
    const agent = (oc.lastConfig().agent as Record<string, { prompt: string; permission: Record<string, string> }>)['beluga-side']!;
    expect(agent.prompt).toBe('Name this worktree.');
    expect(agent.permission.bash).toBe('ask');
    expect(agent.permission['*']).toBe('ask');
    const set = oc.sent('session/set_config_option').map((p) => `${String(p.configId)}=${String(p.value)}`);
    // Claude's 'haiku': a small, fast model of OpenCode's.
    expect(set).toEqual(['mode=beluga-side', 'model=opencode/glm-5.3-flash-free']);
    expect(drop).toHaveBeenCalled();
    expect(sideModel('sonnet', [{ id: 'model', currentValue: 'a/b', options: [{ value: 'a/b', name: 'B' }] }])).toBeUndefined();
  });

  it('hands a friend’s task on to Claude when your agent is OpenCode, saying why', () => {
    const opencode = { runtime: 'opencode', label: 'OpenCode' };
    const claude = { runtime: 'claude', label: 'Claude' };
    expect(agentForFriend({ agent: opencode }, [opencode, claude], () => true)).toEqual({ agent: claude, note: fallbackFor('opencode', 'friends') });
    // Nothing else runs here: as it was (the run says it can't).
    expect(agentForFriend({ agent: opencode }, [opencode], (a) => a.runtime === 'opencode')).toEqual({ agent: opencode });
    expect(agentForFriend({ agent: claude }, [opencode], () => true)).toEqual({ agent: claude });
  });

  it('offers /btw and the terminal view only where the agent has them', () => {
    expect(runtimeHas('claude', 'btw')).toBe(true);
    expect(runtimeHas(undefined, 'terminal')).toBe(true);
    expect(runtimeHas('codex', 'btw')).toBe(false);
    expect(runtimeHas('opencode', 'btw')).toBe(true);
    expect(runtimeHas('opencode', 'terminal')).toBe(false);
    expect(runtimeHas('local', 'terminal')).toBe(true);
  });
});

describe('OpenCode on this Mac', () => {
  it('is found where its installer, npm, Homebrew or bun put it', () => {
    const at = (want: string) => (f: string) => f === want;
    expect(findOpenCode({ PATH: '' }, 'darwin', at('/Users/k/.opencode/bin/opencode'), '/Users/k')).toBe('/Users/k/.opencode/bin/opencode');
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', at('/opt/homebrew/bin/opencode'), '/Users/k')).toBe('/opt/homebrew/bin/opencode');
    expect(findOpenCode({ BELUGA_OPENCODE_PATH: '/x/opencode' }, 'darwin', at('/x/opencode'), '/Users/k')).toBe('/x/opencode');
    expect(findOpenCode({ PATH: 'C:\\npm' }, 'win32', at('C:\\npm\\opencode.cmd'), 'C:\\Users\\k')).toBe('C:\\npm\\opencode.cmd');
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', () => false, '/Users/k')).toBeUndefined();
  });

  it('reads a provider’s failure from its log, never a side agent’s', () => {
    const line = (error: string, small = false) => `timestamp=t level=ERROR run=a message="stream error" providerID=opencode modelID=m session.id=ses_1 small=${small} agent=build mode=primary error.error="${error}"`;
    expect(providerErrorOf(line('AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached. Subscribe'))).toEqual({ kind: 'usage_limit', text: 'Free usage limit reached. Subscribe' });
    expect(providerErrorOf(line('AI_APICallError: Invalid API key provided'))).toEqual({ kind: 'signed_out', text: 'Invalid API key provided' });
    expect(providerErrorOf(line('AI_APICallError: Overloaded'))).toEqual({ kind: 'retrying', text: 'Overloaded' });
    expect(providerErrorOf(line('AI_APICallError: Free usage limit reached', true))).toBeUndefined();
    expect(providerErrorOf('timestamp=t level=WARN message="something else"')).toBeUndefined();
  });

  it('reads its models with the efforts each takes', () => {
    const out = [
      'opencode/big-pickle',
      JSON.stringify({ id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', status: 'active', variants: {}, limit: { context: 200000 } }, null, 2),
      'anthropic/claude-sonnet-4-5',
      JSON.stringify({ id: 'claude-sonnet-4-5', providerID: 'anthropic', name: 'Claude Sonnet 4.5', status: 'active', variants: { low: {}, high: {}, max: {}, none: {} }, limit: { context: 1048576 } }, null, 2),
    ].join('\n');
    expect(parseModels(out)).toEqual([
      { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'opencode · 200K context' },
      { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'anthropic · 1M context', efforts: ['low', 'high', 'max'] },
    ]);
  });

  it('says whether it is installed and ready, with its models', async () => {
    expect(await openCodeStatus({ bin: undefined, models: async () => [] })).toMatchObject(findOpenCode() ? { state: 'signed_out' } : { state: 'missing' });
    expect(await openCodeStatus({ bin: '/x/opencode', models: async () => [{ value: 'opencode/big-pickle', label: 'Big Pickle', description: '' }] })).toMatchObject({ state: 'ready', models: [{ value: 'opencode/big-pickle' }] });
    // Found but not listing its models is installed (#568): never "Not installed".
    expect(await openCodeStatus({ bin: '/x/opencode', models: async () => undefined })).toMatchObject({ state: 'signed_out' });
  });

  it('is a runtime with its own status, separate from Claude’s', () => {
    const rt = createOpenCodeRuntime({ status: async () => ({ state: 'ready', models: [] }) });
    expect(rt.id).toBe('opencode');
    expect(rt.capabilities.canFork).toBe(true);
  });
});
