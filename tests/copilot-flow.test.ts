import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import { copilotComplete } from '../src/agent/runtime/copilot/complete.js';
import { SECRET_READS, copilotArgs, findCopilot, ownModel } from '../src/agent/runtime/copilot/connection.js';
import { COPILOT_CAPABILITIES, createCopilotRuntime } from '../src/agent/runtime/copilot/index.js';
import { copilotModel, modeValue } from '../src/agent/runtime/copilot/run-parts.js';
import { createCopilotBackend } from '../src/agent/runtime/copilot/runner.js';
import { ScriptedCopilot } from '../src/agent/runtime/copilot/scripted.js';
import { dropCopilotFolder, dropCopilotSession } from '../src/agent/runtime/copilot/sessions.js';
import { AUTO_MODEL, COPILOT_NO_ACCESS, copilotStatus, modelRows } from '../src/agent/runtime/copilot/status.js';
import { belugaToolOf, copilotCalls, copilotInput, copilotTool } from '../src/agent/runtime/copilot/tools.js';
import { runtimeFor, signInCommand } from '../src/agent/runtime/registry.js';
import type { AgentPlace, AgentRunInput } from '../src/agent/types.js';
import { agentForFriend } from '../src/core/gateway/serve.js';
import { agentMark, modelMark } from '../src/shared/agent-marks.js';
import { fallbackFor, runtimeHas } from '../src/shared/runtime-fallbacks.js';
import type { StepRecord } from '../src/shared/steps.js';
import { room } from './runtime-conformance.js';

/**
 * GitHub Copilot as an agent (BLG-873): its runs through `copilot --acp`, against a scripted Copilot
 * speaking the shapes Copilot CLI 1.0.107 sends. The scenarios every runtime shares are in
 * runtime-conformance.test.ts.
 */

const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-copilot-'));

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[] } {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r), onFileTouched: () => undefined, canUseTool: async () => true, events, steps, ...extra };
}

const place = (extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } => {
  const sessions: string[] = [];
  return { cwd, additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), sessions, ...extra };
};

const backend = (cp: ScriptedCopilot) => createCopilotBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: cp.connect });

/** A path under `/w` as this system resolves it (`D:\w\a.ts` on Windows). */
const inW = (p: string): string => path.resolve('/w', p);

describe('Copilot’s tools as Beluga’s', () => {
  it('knows each call by its kind, Copilot’s titles being words for people', () => {
    expect(copilotTool({ kind: 'read', title: 'Viewing /w/a.ts' })).toBe('read');
    expect(copilotTool({ kind: 'execute', title: 'List workspace contents' })).toBe('execute');
    expect(copilotTool({ kind: 'other', title: 'beluga_board-task_get' })).toBe('beluga_board-task_get');
    // A read-only MCP tool comes as a read: still known by its server and name.
    expect(copilotTool({ kind: 'read', title: 'beluga-list_peers' })).toBe('beluga-list_peers');
    expect(copilotTool({ kind: 'edit', title: 'apply_patch' })).toBe('edit');
  });

  it('names them the way Claude Code’s are, from the inputs Copilot sends', () => {
    expect(copilotCalls('read', { path: '/w/hello.txt' }, '/w')).toEqual([{ name: 'Read', input: { file_path: inW('hello.txt') } }]);
    expect(copilotCalls('execute', { command: 'ls -la', description: 'List workspace contents' }, '/w')).toEqual([{ name: 'Bash', input: { command: 'ls -la', description: 'List workspace contents' } }]);
    // Its apply_patch body comes as a bare string: one Write per file it adds.
    const patch = copilotInput({ rawInput: '*** Begin Patch\n*** Add File: /w/out.txt\n+hi\n*** Update File: /w/a.ts\n@@\n-a\n+b\n*** End Patch\n' as unknown as Record<string, unknown> });
    expect(copilotCalls('edit', patch, '/w').map((c) => [c.name, c.input.file_path])).toEqual([['Write', inW('out.txt')], ['Edit', inW('a.ts')]]);
    // Its permission request says the file and its diff instead.
    const created = { fileName: '/w/out.txt', diff: '\ndiff --git a/w/out.txt b/w/out.txt\ncreate file mode 100644\n--- a/dev/null\n+++ b/w/out.txt\n@@ -1,0 +1,1 @@\n+hi\n' };
    expect(copilotCalls('edit', created, '/w')).toEqual([{ name: 'Write', input: { file_path: inW('out.txt') } }]);
    expect(copilotCalls('edit', { path: '/w/a.ts', old_str: 'a', new_str: 'b' }, '/w')).toEqual([{ name: 'Edit', input: { file_path: inW('a.ts'), old_string: 'a', new_string: 'b' } }]);
    expect(copilotCalls('search', { pattern: 'TODO', path: '/w/src' }, '/w')[0]).toEqual({ name: 'Grep', input: { pattern: 'TODO', path: inW('src') } });
    expect(copilotCalls('fetch', { url: 'https://x.dev' }, '/w')[0]!.name).toBe('WebFetch');
    // Where a call is, from its locations when its input doesn't say.
    expect(copilotInput({ rawInput: {}, locations: [{ path: '/w/b.ts' }] })).toEqual({ path: '/w/b.ts' });
  });

  it('tells Beluga’s own MCP tools by `<server>-<tool>`, the longest suite first', () => {
    expect(belugaToolOf('beluga_board-task_get', ['beluga', 'beluga_board'])).toBe('mcp__beluga_board__task_get');
    expect(belugaToolOf('beluga-send_chat', ['beluga', 'beluga_board'])).toBe('mcp__beluga__send_chat');
    expect(belugaToolOf('github-mcp-server-get_issue', ['beluga'])).toBeUndefined();
    expect(copilotCalls('github-mcp-server-get_issue', { n: 1 }, '/w', ['beluga'])[0]!.name).toBe('mcp__copilot__github_mcp_server_get_issue');
  });
});

describe('Copilot’s command line for a run', () => {
  it('runs on Auto unless you picked a model or set one in Copilot (Free takes only Auto)', () => {
    expect(copilotArgs({}).slice(0, 2)).toEqual(['--model', 'auto']);
    expect(copilotArgs({ own: 'gpt-5.3-codex' })).not.toContain('--model');
    expect(copilotArgs({ model: 'claude-sonnet-4.5', effort: 'high' }).slice(0, 4)).toEqual(['--model', 'claude-sonnet-4.5', '--reasoning-effort', 'high']);
    // An effort goes with a model picked, never with Auto (each model takes its own levels).
    expect(copilotArgs({ model: 'auto', effort: 'high' })).not.toContain('--reasoning-effort');
  });

  it('turns secret reads down, since it reads in the folder without asking', () => {
    const args = copilotArgs({});
    for (const rule of ['read(.env)', 'read(.env.*)', 'read(*.pem)', 'read(~/.ssh/**)']) expect(args[args.indexOf(rule) - 1]).toBe('--deny-tool');
    expect(args.filter((a) => a === '--deny-tool')).toHaveLength(SECRET_READS.length);
  });

  it('maps Claude’s aliases to Copilot’s own choice, and keeps its own model ids', () => {
    expect(copilotModel('opus')).toBeUndefined();
    expect(copilotModel('sonnet[1m]')).toBeUndefined();
    expect(copilotModel('anthropic/claude-sonnet-4-5')).toBeUndefined();
    expect(copilotModel('claude-haiku-4.5')).toBe('claude-haiku-4.5');
    expect(copilotModel('auto')).toBe('auto');
  });

  it('reads the model you set in Copilot itself', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-cphome-'));
    mkdirSync(path.join(home, '.copilot'));
    writeFileSync(path.join(home, '.copilot', 'settings.json'), '{\n  // yours\n  "model": "gpt-5.3-codex"\n}');
    expect(ownModel({}, home)).toBe('gpt-5.3-codex');
    expect(ownModel({ COPILOT_MODEL: 'auto' }, home)).toBe('auto');
    expect(ownModel({}, mkdtempSync(path.join(os.tmpdir(), 'beluga-cpnone-')))).toBeUndefined();
  });

  it('finds ACP’s mode values by name', () => {
    const options = [{ id: 'mode', currentValue: 'x#agent', options: [{ value: 'https://agentclientprotocol.com/protocol/session-modes#agent', name: 'Agent' }, { value: 'https://agentclientprotocol.com/protocol/session-modes#plan', name: 'Plan' }] }];
    expect(modeValue(options, 'plan')).toBe('https://agentclientprotocol.com/protocol/session-modes#plan');
    expect(modeValue([], 'plan')).toBeUndefined();
  });
});

describe('a run on Copilot', () => {
  it('gives Copilot Beluga’s instructions as a file of its own, and Beluga’s tools as http MCP servers', async () => {
    const cp = new ScriptedCopilot();
    let instructions = '';
    const run = input('hello', {
      onEvent: (k) => {
        // While it runs, the instructions are there for Copilot to read.
        const dir = cp.starts.at(-1)?.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
        if (k === 'text' && !instructions && dir) instructions = readFileSync(path.join(dir, 'beluga.instructions.md'), 'utf8');
      },
    });
    expect(await backend(cp).run(run)).toBe('echo: hello');
    expect(instructions).toMatch(/^---\napplyTo: '\*\*'\n---\n/);
    expect(instructions).toContain('Beluga');
    expect(existsSync(cp.starts.at(-1)!.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS!)).toBe(false);
    expect(cp.starts.at(-1)!.args).toContain('--deny-tool');
    const servers = cp.sent('session/new')[0]!.mcpServers as Array<{ type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
    expect(servers.map((s) => s.name)).toContain('beluga');
    expect(servers.every((s) => s.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/mcp\//.test(s.url))).toBe(true);
    expect(servers[0]!.headers[0]).toMatchObject({ name: 'Authorization', value: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) });
  });

  it('streams its steps, and asks you only about what Copilot asks about (a command that changes things)', async () => {
    const cp = new ScriptedCopilot();
    const canUseTool = vi.fn(async () => true);
    const quiet = input('hello', { canUseTool });
    await backend(cp).run(quiet);
    expect(quiet.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Bash', status: 'done', input: { command: 'echo hello' } });
    expect(cp.answers).toEqual([]);
    const denied = input('ask first', { canUseTool: async () => false });
    expect(await backend(cp).run(denied)).toBe('denied: ask first');
    expect(cp.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect(denied.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Bash', status: 'error' });
  });

  it('judges a new file on its path, and says it was touched', async () => {
    const cp = new ScriptedCopilot();
    const touched: string[] = [];
    const file = path.join(cwd, 'out.txt');
    const run = input(`edit ${file}`, { onFileTouched: (f) => void touched.push(f) });
    expect(await backend(cp).run(run)).toBe(`edited: ${file}`);
    expect(run.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Write', status: 'done', input: { file_path: file } });
    expect(touched).toEqual([file]);
    // Outside the folder: Beluga's policy turns it down, and the step says why.
    const outside = input(`edit ${path.join(os.homedir(), '.zshrc')}`);
    expect(await backend(cp).run(outside)).toMatch(/^denied: edit/);
    expect(cp.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
  });

  it('lets Beluga’s own tools through without asking you twice (their own gate asks)', async () => {
    const cp = new ScriptedCopilot();
    const canUseTool = vi.fn(async () => false);
    expect(await backend(cp).run(input('room', { canUseTool }))).toBe('room: kay');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('runs on the model picked, as its flag; a model the session offers can change mid-run', async () => {
    const cp = new ScriptedCopilot({ models: ['claude-sonnet-4.5'] });
    await backend(cp).run(input('hello', { place: place({ model: 'claude-sonnet-4.5' }), effort: 'high' }));
    expect(cp.starts.at(-1)!.args.slice(0, 4)).toEqual(['--model', 'claude-sonnet-4.5', '--reasoning-effort', 'high']);
    await backend(cp).run(input('hello', { model: 'opus' }));
    expect(cp.starts.at(-1)!.args.slice(0, 2)).toEqual(['--model', 'auto']);
  });

  it('says a model your plan doesn’t include in words that say what to do', async () => {
    const cp = new ScriptedCopilot();
    const err = await backend(cp).run(input('noplan', { place: place({ model: 'claude-opus-4.5' }) })).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Your Copilot plan doesn’t include the model claude-opus-4\.5\. Pick Auto/);
  });

  it('plans in Copilot’s own Plan mode, then works in Agent mode once you approve', async () => {
    const cp = new ScriptedCopilot();
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: true, feedback: '' }));
    await backend(cp).run(input('hello', { plan: true, askUser }));
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan' }));
    const modes = cp.sent('session/set_config_option').filter((p) => p.configId === 'mode').map((p) => String(p.value).split('#')[1]);
    expect(modes).toEqual(['plan', 'agent']);
    expect(JSON.stringify(cp.sent('session/prompt').at(-1)?.prompt)).toContain('The plan is approved');
  });

  it('turns edits down while it plans', async () => {
    const cp = new ScriptedCopilot();
    const run = input(`edit ${path.join(cwd, 'plan-edit.txt')}`, { plan: true });
    expect(await backend(cp).run(run)).toMatch(/^denied: edit/);
    expect(run.steps.filter((s) => s.kind === 'tool').at(-1)?.output).toContain('Planning only looks');
  });

  it('continues a conversation with session/load, its replay kept out of the chat', async () => {
    const cp = new ScriptedCopilot();
    const first = place();
    await backend(cp).run(input('one', { place: first }));
    const again = place({ resume: first.sessions[0]! });
    const run = input('two', { place: again });
    expect(await backend(cp).run(run)).toBe('echo: two');
    expect(cp.sent('session/load').map((p) => p.sessionId)).toEqual([first.sessions[0]]);
    expect(again.sessions).toEqual([first.sessions[0]]);
    expect(run.events.filter(([k]) => k === 'text').map(([, t]) => t)).toEqual(['echo: two']);
    // A fork can't branch Copilot's session: it starts a new one.
    const fork = place({ resume: first.sessions[0]!, forkSession: true });
    await backend(cp).run(input('three', { place: fork }));
    expect(fork.sessions[0]).not.toBe(first.sessions[0]);
  });

  it('compacts with its own /compact: the summary stays out of the chat, the window before and after is said', async () => {
    const cp = new ScriptedCopilot();
    const run = input('/compact');
    await backend(cp).run(run);
    expect(run.events.filter(([k]) => k === 'text')).toEqual([]);
    expect(JSON.parse(run.events.find(([k]) => k === 'compact')![1])).toMatchObject({ pre: 0, post: 4_000, trigger: 'manual' });
  });

  it('takes no message into a running turn, but stops it for one (Steer Now) and answers it next', async () => {
    const cp = new ScriptedCopilot();
    const steers: Array<Parameters<NonNullable<AgentRunInput['onSteer']>>[0]> = [];
    const run = input('wait for it', { onSteer: (s) => void steers.push(s) });
    const running = backend(cp).run(run);
    await vi.waitFor(() => expect(run.steps.some((s) => s.status === 'running')).toBe(true));
    let answered = '';
    const followUp = { prompt: 'after', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t: string) => void (answered = t), onError: () => undefined };
    expect(steers.at(-1)!(followUp)).toBe(false);
    expect(await steers.at(-1)!.interrupt!(followUp, 'Stopped to read your message')).toBe(true);
    expect(await running).toContain('Stopped to read your message');
    expect(answered).toBe('echo: after');
    expect(cp.sent('session/cancel')).toHaveLength(1);
  });

  it('turns away friends’ tasks and guests, and hands a friend’s task to Claude, saying why', async () => {
    const cp = new ScriptedCopilot();
    const guarded = guardedBackend(backend(cp), COPILOT_CAPABILITIES);
    await expect(guarded.run(input('hello', { vetTool: () => undefined }))).rejects.toThrow(/friends/);
    await expect(guarded.run(input('hello', { guest: true }))).rejects.toThrow(/guests/);
    const copilot = { runtime: 'copilot', label: 'Copilot' };
    const claude = { runtime: 'claude', label: 'Claude' };
    expect(agentForFriend({ agent: copilot }, [copilot, claude], () => true)).toEqual({ agent: claude, note: fallbackFor('copilot', 'friends') });
  });
});

describe('around a run', () => {
  it('makes a side call without your instruction files, with only the tools it was given, and drops its session', async () => {
    const cp = new ScriptedCopilot();
    const drop = vi.fn(async () => true);
    const answer = await copilotComplete({ prompt: 'ask hello', system: 'Name this worktree.', cwd, model: 'haiku', tools: ['Read'], vetTool: () => ({ allow: true, reason: '' }) }, { connect: cp.connect, drop });
    // Its command wasn't one of the call's tools: turned down.
    expect(answer).toBe('denied: ask hello');
    expect(cp.starts.at(-1)!.args).toContain('--no-custom-instructions');
    expect(cp.starts.at(-1)!.args.slice(1, 3)).toEqual(['--model', 'auto']);
    expect(JSON.stringify(cp.sent('session/prompt').at(-1)?.prompt)).toContain('Name this worktree.');
    expect(drop).toHaveBeenCalledWith(cp.sent('session/prompt').at(-1)?.sessionId);
  });

  it('offers the terminal view, /btw and the steer box only where the agent has them', () => {
    expect(runtimeHas('copilot', 'btw')).toBe(false);
    expect(runtimeHas('copilot', 'terminal')).toBe(false);
    expect(runtimeHas('copilot', 'steer')).toBe(false);
    expect(fallbackFor('copilot', 'rewind')).toMatch(/starts a new conversation/);
  });

  it('forgets a deleted conversation’s session folder, and every one that ran in a folder', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-cpstate-'));
    const a = '11111111-2222-4333-8444-555555555555';
    const b = '66666666-7777-4888-9999-aaaaaaaaaaaa';
    for (const [id, at] of [[a, '/w/one'], [b, '/w/two']] as const) {
      mkdirSync(path.join(dir, id));
      writeFileSync(path.join(dir, id, 'workspace.yaml'), `id: ${id}\ncwd: ${at}\n`);
    }
    expect(await dropCopilotSession('../etc', dir)).toBe(false);
    expect(await dropCopilotSession(a, dir)).toBe(true);
    expect(existsSync(path.join(dir, a))).toBe(false);
    expect(await dropCopilotFolder('/w/two', dir)).toBe(1);
    expect(existsSync(path.join(dir, b))).toBe(false);
  });
});

describe('Copilot on this Mac', () => {
  it('is found where npm, Homebrew or its installer put it', () => {
    const at = (want: string) => (f: string) => f === want;
    expect(findCopilot({ PATH: '/usr/bin' }, 'darwin', at('/opt/homebrew/bin/copilot'), '/Users/k')).toBe('/opt/homebrew/bin/copilot');
    expect(findCopilot({ PATH: '' }, 'darwin', at('/Users/k/.local/bin/copilot'), '/Users/k')).toBe('/Users/k/.local/bin/copilot');
    expect(findCopilot({ BELUGA_COPILOT_PATH: '/x/copilot' }, 'darwin', at('/x/copilot'), '/Users/k')).toBe('/x/copilot');
    expect(findCopilot({ PATH: 'C:\\npm' }, 'win32', at('C:\\npm\\copilot.cmd'), 'C:\\Users\\k')).toBe('C:\\npm\\copilot.cmd');
    expect(findCopilot({ PATH: '/usr/bin' }, 'darwin', () => false, '/Users/k')).toBeUndefined();
  });

  it('says it is ready with Auto first and the models a session offers, or that the account has no Copilot', async () => {
    expect(await copilotStatus({ connect: new ScriptedCopilot().connect })).toEqual({ state: 'ready', models: [AUTO_MODEL] });
    const paid = await copilotStatus({ connect: new ScriptedCopilot({ models: ['gpt-5.3-codex'] }).connect });
    expect(paid.models.map((m) => m.value)).toEqual(['auto', 'gpt-5.3-codex']);
    const noAccess = new ScriptedCopilot();
    const connect: typeof noAccess.connect = async (o) => {
      const c = await noAccess.connect(o);
      return { ...c, rpc: Object.assign(Object.create(c.rpc) as typeof c.rpc, { request: async () => Promise.reject(new Error('403 "unauthorized: not authorized to use this Copilot feature"')) }) };
    };
    expect(await copilotStatus({ connect })).toEqual({ state: 'signed_out', fix: COPILOT_NO_ACCESS, models: [] });
    expect(modelRows(undefined)).toEqual([AUTO_MODEL]);
  });

  it('is a runtime of its own: named, signed in with copilot login, marked with its face', () => {
    expect(runtimeFor('copilot')?.label).toBe('Copilot');
    expect(signInCommand('copilot')?.at(-1)).toBe('login');
    expect(agentMark({ runtime: 'copilot' })).toBe('copilot');
    expect(modelMark('auto', 'copilot')).toBe('copilot');
    expect(modelMark('claude-sonnet-4.5', 'copilot')).toBe('anthropic');
    expect(modelMark('gpt-5.3-codex', 'copilot')).toBe('openai');
    expect(createCopilotRuntime({ status: async () => ({ state: 'ready', models: [] }) }).capabilities.toolMounts).toEqual(['http']);
  });
});
