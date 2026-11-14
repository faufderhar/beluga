import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findGrok, writeGatePlugin } from '../src/agent/runtime/grok/connection.js';
import { createGrokRuntime } from '../src/agent/runtime/grok/index.js';
import { modelChoice, probeOf } from '../src/agent/runtime/grok/models.js';
import { grokFailure, grokUsageEvent } from '../src/agent/runtime/grok/runner.js';
import { ScriptedGrok } from '../src/agent/runtime/grok/scripted.js';
import { askGrokBtw, grokComplete } from '../src/agent/runtime/grok/side.js';
import { GROK_MISSING, GROK_SIGN_IN, grokStatus } from '../src/agent/runtime/grok/status.js';
import { dropGrokSession, grokSessionFolder } from '../src/agent/runtime/grok/sessions.js';
import { grokCalls, grokResultText, grokToolOf, isBelugaTool, mcpName } from '../src/agent/runtime/grok/tools.js';
import { runtimeFor, signInCommand } from '../src/agent/runtime/registry.js';
import type { AgentPlace, AgentRunInput } from '../src/agent/types.js';
import { agentBadge } from '../src/shared/agent-label.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { room } from './runtime-conformance.js';

const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-grok-test-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type Run = AgentRunInput & { events: Array<[string, string]> };

function run(prompt: string, extra: Partial<AgentRunInput> = {}): Run {
  const events: Array<[string, string]> = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (kind: string, text: string) => void events.push([kind, text]), canUseTool: async () => true, events, ...extra } as Run;
}

function place(extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } {
  const sessions: string[] = [];
  return { cwd, additionalDirectories: [], autoEdit: true, onSession: (id: string) => void sessions.push(id), sessions, ...extra };
}

function setup(): { grok: ScriptedGrok; backend: ReturnType<ReturnType<typeof createGrokRuntime>['create']> } {
  const grok = new ScriptedGrok();
  return { grok, backend: createGrokRuntime({ connect: grok.connect }).create({ cwd, autoEdit: true, additionalDirectories: [], bridge: room }) };
}

const prompts = (grok: ScriptedGrok): string[] => grok.sent('session/prompt').map((p) => (p.prompt as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'));
const verdicts = (grok: ScriptedGrok): Array<string | undefined> => grok.answers.map((a) => (a as { outcome?: { optionId?: string } }).outcome?.optionId);

describe('Grok Build as a runtime', () => {
  it('is registered, says whether it is set up here, and how to sign in', () => {
    const rt = runtimeFor('grok');
    expect(rt?.label).toBe('Grok Build');
    expect(rt?.status).toBeTypeOf('function');
    expect(signInCommand('grok')?.slice(1)).toEqual(['login']);
  });

  it('is listed in the agent picker, greyed with a reason when it is not installed', () => {
    const choice = runtimeChoices(() => undefined).find((r) => r.id === 'grok');
    expect(choice).toMatchObject({ label: 'Grok Build', available: false });
    expect(choice?.why).toMatch(/Grok Build/);
  });

  it('is named Grok Build on a message badge', () => {
    expect(agentBadge({ runtime: 'grok', label: 'Helper' })).toBe('Grok Build');
  });
});

describe('finding Grok', () => {
  const home = '/Users/kay';
  it('uses BELUGA_GROK_PATH when it is set, and only that', () => {
    expect(findGrok({ BELUGA_GROK_PATH: '/opt/grok' }, 'darwin', () => true, home)).toBe('/opt/grok');
    expect(findGrok({ BELUGA_GROK_PATH: '/opt/grok' }, 'darwin', () => false, home)).toBeUndefined();
  });

  it('prefers where its installer puts it, then PATH, then the usual folders', () => {
    expect(findGrok({ PATH: '/usr/bin' }, 'darwin', () => true, home)).toBe('/Users/kay/.grok/bin/grok');
    expect(findGrok({ PATH: '/usr/bin' }, 'darwin', (f) => f === '/usr/bin/grok', home)).toBe('/usr/bin/grok');
    expect(findGrok({ PATH: '/usr/bin' }, 'darwin', (f) => f === '/opt/homebrew/bin/grok', home)).toBe('/opt/homebrew/bin/grok');
  });

  it('says nothing when it is not there', () => {
    expect(findGrok({ PATH: '/usr/bin' }, 'darwin', () => false, home)).toBeUndefined();
  });
});

describe('the hook that makes every step ask', () => {
  it('is a plugin whose PreToolUse hook answers ask, for every tool', () => {
    const dir = writeGatePlugin(cwd);
    const plugin = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as { name: string };
    expect(plugin.name).toBe('beluga-gate');
    const { hooks } = JSON.parse(readFileSync(path.join(dir, 'hooks/hooks.json'), 'utf8')) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ type: string; command: string; args: string[] }> }> } };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]?.matcher).toBeUndefined();
    const hook = hooks.PreToolUse[0]!.hooks[0]!;
    expect(hook.type).toBe('command');
    expect(JSON.parse(execFileSync(hook.command, hook.args, { encoding: 'utf8' }))).toMatchObject({ decision: 'ask' });
  });
});

describe('what Grok says, as Beluga reads it', () => {
  it('names a tool from its meta, not the title that changes', () => {
    expect(grokToolOf({ title: 'Read `/a/b`', _meta: { 'x.ai/tool': { name: 'read_file' } } })).toBe('read_file');
    expect(grokToolOf({ title: 'Searching', rawInput: { variant: 'WebSearch', query: 'q' } })).toBe('web_search');
  });

  it("turns Grok's tools into the ones Beluga judges and draws", () => {
    const at = (p: string): string => path.resolve(cwd, p);
    expect(grokCalls('read_file', { target_file: '.env' }, cwd)).toEqual([{ name: 'Read', input: { file_path: at('.env') } }]);
    expect(grokCalls('write', { file_path: 'a.txt', content: 'x' }, cwd)).toEqual([{ name: 'Write', input: { file_path: at('a.txt'), content: 'x' } }]);
    expect(grokCalls('search_replace', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, cwd)).toEqual([{ name: 'Edit', input: { file_path: at('a.txt'), old_string: 'a', new_string: 'b' } }]);
    expect(grokCalls('run_terminal_command', { command: 'ls', description: 'List' }, cwd)).toEqual([{ name: 'Bash', input: { command: 'ls', description: 'List' } }]);
    expect(grokCalls('grep', { pattern: 'x', glob: '*.ts' }, cwd)).toEqual([{ name: 'Grep', input: { pattern: 'x', path: cwd, glob: '*.ts' } }]);
    expect(grokCalls('spawn_subagent', { prompt: 'p', description: 'd' }, cwd)).toEqual([{ name: 'Task', input: { description: 'd', prompt: 'p' } }]);
    expect(grokCalls('use_tool', { tool_name: 'beluga_board__task_get', tool_input: { id: 1 } }, cwd)).toEqual([{ name: 'mcp__beluga_board__task_get', input: { id: 1 } }]);
  });

  it("keeps an unknown tool in Grok's own namespace, so it is never taken for Beluga's", () => {
    expect(grokCalls('brand_new', { a: 1 }, cwd)).toEqual([{ name: 'mcp__grok__brand_new', input: { a: 1 } }]);
    expect(mcpName('loose')).toBe('mcp__grok__loose');
    expect(isBelugaTool('mcp__grok__beluga_board', ['beluga_board'])).toBe(false);
    expect(isBelugaTool('mcp__beluga_board__task_get', ['beluga_board'])).toBe(true);
  });

  it('reads a result from its content, then its raw MCP output', () => {
    expect(grokResultText({ content: [{ type: 'content', content: { type: 'text', text: '\u001b[31mred\u001b[0m' } }] })).toBe('red');
    expect(grokResultText({ rawOutput: { output: { OkayOutput: 'BLG-1' } } })).toBe('BLG-1');
  });

  it('counts tokens and cost in Beluga’s shape: input without the cached part, cost from ticks', () => {
    const used = JSON.parse(grokUsageEvent({ usage: { inputTokens: 400, outputTokens: 12, cachedReadTokens: 100, cacheCreationTokens: 5, costUsdTicks: 25_000_000 } }, 's1')!) as Record<string, unknown>;
    expect(used).toEqual({ input: 300, output: 12, cacheRead: 100, cacheWrite: 5, cost: 0.0025, session: 's1' });
    expect(grokUsageEvent({}, 's1')).toBeUndefined();
  });

  it('keeps headless cache beside uncached input, and does not add reasoning that is already in the output', () => {
    const headless = JSON.parse(grokUsageEvent({ usage: { inputTokens: 7210, outputTokens: 1893, cacheReadInputTokens: 41000, cacheCreationInputTokens: 20, reasoningTokens: 412, costUSD: 0.04 } }, 's1')!) as Record<string, unknown>;
    expect(headless).toEqual({ input: 7210, output: 1893, cacheRead: 41000, cacheWrite: 20, cost: 0.04, session: 's1' });
    const snake = JSON.parse(grokUsageEvent({ usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 90, cache_creation_input_tokens: 4, reasoning_tokens: 3 } }, 's2')!) as Record<string, unknown>;
    expect(snake).toMatchObject({ input: 10, output: 3, cacheRead: 90, cacheWrite: 4, cost: 0 });
  });

  it('tells a signed-out run as a sign-in, and as Grok’s', () => {
    expect(grokFailure({ error: 'Authentication required' })).toMatchObject({ failure: { kind: 'signed_out', runtime: 'grok' } });
  });
});

describe('its status and models', () => {
  const init = (defaultAuthMethodId: string | null) => ({ protocolVersion: 1, agentCapabilities: {}, _meta: { defaultAuthMethodId, modelState: { availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5', description: 'Fast', _meta: { totalContextTokens: 256_000, reasoningEfforts: [{ value: 'low' }, { value: 'high' }] } }] } } });

  it('shows a model with what it holds and the efforts it takes', () => {
    expect(modelChoice({ modelId: 'grok-4.5', name: 'Grok 4.5', description: 'Fast', _meta: { totalContextTokens: 256_000, reasoningEfforts: [{ value: 'low' }] } })).toEqual({ value: 'grok-4.5', label: 'Grok 4.5', description: 'Fast · 256K context', efforts: ['low'] });
  });

  it('is signed in by a cached token or an API key', () => {
    expect(probeOf(init('cached_token') as never, {}).signedIn).toBe(true);
    expect(probeOf(init(null) as never, {}).signedIn).toBe(false);
    expect(probeOf(init(null) as never, { XAI_API_KEY: 'k' }).signedIn).toBe(true);
  });

  it('is missing, signed out or ready', async () => {
    const models = [{ value: 'grok-4.5', label: 'Grok 4.5', description: '' }];
    await expect(grokStatus({ bin: '/grok', probe: async () => undefined })).resolves.toEqual({ state: 'missing', fix: GROK_MISSING, models: [] });
    await expect(grokStatus({ bin: '/grok', probe: async () => ({ models, signedIn: false }) })).resolves.toEqual({ state: 'signed_out', fix: GROK_SIGN_IN, models: [] });
    await expect(grokStatus({ bin: '/grok', probe: async () => ({ models, signedIn: true }) })).resolves.toEqual({ state: 'ready', models });
  });
});

describe('a run', () => {
  it('starts gated, with Beluga’s instructions in the new session', async () => {
    const { grok, backend } = setup();
    await backend.run({ ...run('hello'), place: place() });
    expect(grok.starts).toEqual([{ ungated: false, cwd }]);
    const rules = (grok.sent('session/new')[0]?._meta as { rules?: string } | undefined)?.rules;
    expect(rules).toBeTruthy();
    expect(prompts(grok)[0]).not.toContain('<beluga-instructions>');
  });

  it('only ever allows once: nothing it allows is kept in Grok', async () => {
    const { grok, backend } = setup();
    await backend.run({ ...run('hello'), place: place() });
    expect(verdicts(grok)).toEqual(['once']);
  });

  it('sends Grok back to work with the reason when a step is turned down', async () => {
    const { grok, backend } = setup();
    const said = await backend.run({ ...run('hello', { canUseTool: async () => false }), place: place() });
    expect(verdicts(grok)).toEqual(['reject']);
    expect(prompts(grok)).toHaveLength(2);
    expect(prompts(grok)[1]).toMatch(/^That step was turned down: /);
    expect(said).toBe('denied: hello');
  });

  it('turns a .env read down when you say no, and never lets it through unasked', async () => {
    const { grok, backend } = setup();
    const secrets: string[] = [];
    const tools: string[] = [];
    const said = await backend.run({ ...run('read .env', { canUseSecret: async (name: string) => (secrets.push(name), false), canUseTool: async (name: string) => (tools.push(name), true) } as Partial<AgentRunInput>), place: place() });
    expect(secrets).toHaveLength(1);
    expect(tools).toEqual([]);
    expect(verdicts(grok)).toEqual(['reject']);
    expect(said).toBe('denied: read .env');
  });

  it('stops sending it back after too many denials, and says why', async () => {
    const { grok, backend } = setup();
    const said = await backend.run({ ...run('stubborn', { canUseTool: async () => false }), place: place() });
    expect(prompts(grok)).toHaveLength(9);
    expect(said).toMatch(/too many steps were turned down/);
  });

  it('does not send it back when you stopped it', async () => {
    const { grok, backend } = setup();
    const abort = new AbortController();
    const going = backend.run({ ...run('wait', { signal: abort.signal }), place: place() });
    await expect.poll(() => grok.sent('session/prompt').length).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await expect(going).rejects.toThrow('aborted');
    expect(grok.sent('session/cancel')).toHaveLength(1);
    expect(grok.sent('session/prompt')).toHaveLength(1);
  });

  it('changes nothing while planning, and works once you approve', async () => {
    const { grok, backend } = setup();
    const asked: string[] = [];
    let plans = 0;
    await backend.run({ ...run('write notes.txt', { plan: true, canUseTool: async (name: string) => (asked.push(name), true), askUser: async () => (plans++, { kind: 'plan' as const, approve: true, feedback: '' }) } as Partial<AgentRunInput>), place: place() });
    expect(verdicts(grok)[0]).toBe('reject');
    expect(asked).not.toContain('Write');
    expect(prompts(grok)[1]).toMatch(/Planning only looks/);
    expect(plans).toBe(1);
    expect(prompts(grok).at(-1)).toMatch(/The plan is approved/);
  });

  it('turns its own plan tool down, so the plan comes back as its answer', async () => {
    const { grok, backend } = setup();
    const asked: string[] = [];
    const shown: string[] = [];
    await backend.run({ ...run('exitplan', { plan: true, canUseTool: async (name: string) => (asked.push(name), true), askUser: async (q: { plan?: string }) => (shown.push(q.plan ?? ''), { kind: 'plan' as const, approve: true, feedback: '' }) } as unknown as Partial<AgentRunInput>), place: place() });
    expect(verdicts(grok)[0]).toBe('reject');
    expect(asked).not.toContain('mcp__grok__exit_plan_mode');
    expect(prompts(grok)[1]).toMatch(/answer with the whole plan/);
    expect(shown).toEqual(['denied: exitplan']);
  });

  it('tells Grok when it asks for something Beluga cannot answer, and goes on', async () => {
    const { grok, backend } = setup();
    const said = await backend.run({ ...run('newask'), place: place() });
    expect(prompts(grok)[1]).toMatch(/can’t answer _x\.ai\/brand_new/);
    expect(said).toBe('denied: newask');
  });

  it('reports a turn Grok ended by itself as a failure, not as you stopping it', async () => {
    const { backend } = setup();
    const going = backend.run({ ...run('giveup'), place: place() });
    await expect(going).rejects.toBeInstanceOf(RunFailedError);
    await expect(going).rejects.not.toThrow(/^aborted$/);
  });

  it('turns writes down in a read-only conversation', async () => {
    const { grok, backend } = setup();
    await backend.run({ ...run('write notes.txt'), place: place({ askOnly: { project: cwd } }) });
    expect(verdicts(grok)[0]).toBe('reject');
    expect(prompts(grok)[1]).toMatch(/only looks/);
  });

  it('runs on the picked model at the picked effort', async () => {
    const { grok, backend } = setup();
    await backend.run({ ...run('hello', { effort: 'low' } as Partial<AgentRunInput>), place: place({ model: 'grok-4.5' }) });
    const set = grok.sent('session/set_config_option').map((p) => [p.configId, p.value]);
    expect(set).toEqual([['model', 'grok-4.5'], ['reasoning_effort', 'low']]);
  });

  it('says so when it has no such model', async () => {
    const { grok, backend } = setup();
    const r = run('hello');
    await backend.run({ ...r, place: place({ model: 'grok-9' }) });
    expect(grok.sent('session/set_config_option')).toEqual([]);
    expect(r.events.some(([k, t]) => k === 'progress' && /no model grok-9/.test(t))).toBe(true);
  });

  it('says usage and how full the context is', async () => {
    const { backend } = setup();
    const r = run('hello');
    await backend.run({ ...r, place: place() });
    const usage = r.events.find(([k]) => k === 'usage');
    expect(JSON.parse(usage![1])).toMatchObject({ input: 200, output: 12, cacheRead: 100, cost: 0.0025 });
    expect(r.events.some(([k]) => k === 'context')).toBe(true);
  });

  it('runs /compact as its own, and says how full it was', async () => {
    const { grok, backend } = setup();
    const r = run('/compact');
    await backend.run({ ...r, place: place() });
    expect(prompts(grok)).toEqual(['/compact']);
    expect(JSON.parse(r.events.find(([k]) => k === 'compact')![1])).toMatchObject({ pre: 12_000, post: 900, trigger: 'manual' });
  });
});

describe('picking a conversation up again', () => {
  it('resumes the same session, and gives it Beluga’s instructions in its first message', async () => {
    const { grok, backend } = setup();
    const first = place();
    await backend.run({ ...run('hello'), place: first });
    const sid = first.sessions[0]!;
    const again = place({ resume: sid });
    await backend.run({ ...run('again'), place: again });
    expect(grok.sent('session/new')).toHaveLength(1);
    expect(grok.sent('session/resume')[0]).toMatchObject({ sessionId: sid });
    expect(again.sessions).toEqual([sid]);
    expect(prompts(grok).at(-1)).toContain('<beluga-instructions>');
  });

  it('starts afresh and says so when the session is gone', async () => {
    const { grok, backend } = setup();
    const r = run('hello');
    const p = place({ resume: 'gone' });
    await backend.run({ ...r, place: p });
    expect(grok.sent('session/new')).toHaveLength(1);
    expect(p.sessions[0]).not.toBe('gone');
    expect(r.events.some(([k, t]) => k === 'progress' && /new Grok Build conversation/.test(t))).toBe(true);
  });

  it('forks through its own method, and opens the new session', async () => {
    const { grok, backend } = setup();
    const first = place();
    await backend.run({ ...run('hello'), place: first });
    const sid = first.sessions[0]!;
    const fork = place({ resume: sid, forkSession: true });
    await backend.run({ ...run('in the fork'), place: fork });
    expect(grok.sent('_x.ai/session/fork')[0]).toMatchObject({ sourceSessionId: sid, newCwd: cwd });
    expect(fork.sessions).toHaveLength(1);
    expect(fork.sessions[0]).not.toBe(sid);
    expect(grok.sent('session/resume').map((p) => p.sessionId)).toEqual(fork.sessions);
  });
});

describe('forgetting a session', () => {
  const id = '01a1c0ec-1051-7c01-9a37-3a10d2090cb3';
  const other = '01a1c0ef-9270-76e0-b93b-483b1548d811';

  it('removes what grok sessions delete left behind (a fork), and nothing else', async () => {
    const home = mkdtempSync(path.join(cwd, 'home-'));
    const folder = path.join(home, 'sessions', encodeURIComponent('/work/here'));
    mkdirSync(path.join(folder, id), { recursive: true });
    mkdirSync(path.join(folder, other), { recursive: true });
    await expect(dropGrokSession(id, '/usr/bin/true', home)).resolves.toBe(true);
    expect(existsSync(path.join(folder, id))).toBe(false);
    expect(existsSync(path.join(folder, other))).toBe(true);
  });

  it('touches nothing for something that is not a session id', async () => {
    const home = mkdtempSync(path.join(cwd, 'home-'));
    const sessions = path.join(home, 'sessions', 'folder');
    mkdirSync(sessions, { recursive: true });
    await expect(dropGrokSession('..', '/usr/bin/true', home)).resolves.toBe(false);
    expect(existsSync(sessions)).toBe(true);
  });

  it('finds the folder a session ran in', () => {
    const home = mkdtempSync(path.join(cwd, 'home-'));
    mkdirSync(path.join(home, 'sessions', encodeURIComponent('/work/here'), id), { recursive: true });
    expect(grokSessionFolder(id, home)).toBe('/work/here');
    expect(grokSessionFolder(other, home)).toBeUndefined();
  });
});

describe('side calls', () => {
  const noDrop = async (): Promise<void> => undefined;

  it('uses Beluga’s prompt as the whole system prompt, and turns down tools it was not given', async () => {
    const grok = new ScriptedGrok();
    const drops: string[] = [];
    const answer = await grokComplete({ prompt: 'Add a dark mode toggle', system: 'Name this task.', cwd }, { connect: grok.connect, drop: async (s) => void drops.push(s) });
    expect(grok.sent('session/new')[0]).toMatchObject({ _meta: { systemPromptOverride: 'Name this task.' } });
    expect(verdicts(grok)).toEqual(['reject']);
    expect(answer).toMatch(/^denied: /);
    expect(drops).toHaveLength(1);
  });

  it('answers /btw from a fork, with every tool turned down', async () => {
    const grok = new ScriptedGrok();
    const { backend } = { backend: createGrokRuntime({ connect: grok.connect }).create({ cwd, autoEdit: true, additionalDirectories: [], bridge: room }) };
    const first = place();
    await backend.run({ ...run('hello'), place: first });
    grok.answers.length = 0;
    const answer = await askGrokBtw({ cwd, question: 'what was it?', resume: first.sessions[0]!, onText: () => undefined, signal: new AbortController().signal } as never, { connect: grok.connect, drop: noDrop });
    expect(grok.sent('_x.ai/session/fork')).toHaveLength(1);
    expect(verdicts(grok).every((v) => v === 'reject')).toBe(true);
    expect(answer).toMatch(/denied/);
  });
});
