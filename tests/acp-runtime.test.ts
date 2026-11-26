import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addDirArgs, findAcpCommand, spawnAcp } from '../src/agent/runtime/acp/connection.js';
import { acpComplete } from '../src/agent/runtime/acp/complete.js';
import type { AcpExtension } from '../src/agent/runtime/acp/extension.js';
import type { AcpAgentSpec } from '../src/agent/runtime/acp/spec.js';
import { createAcpBackend } from '../src/agent/runtime/acp/runner.js';
import { acpStatus } from '../src/agent/runtime/acp/status.js';
import { ScriptedAgy } from '../src/agent/runtime/antigravity/scripted.js';
import { agyDialect, belugaToolOf } from '../src/agent/runtime/antigravity/tools.js';
import { CodexRpcError } from '../src/agent/runtime/codex/rpc.js';
import { ACP_AUTH_REQUIRED, acpFailure, acpModel, acpSignedOut, declinedNote, modeValue, modelRows } from '../src/agent/runtime/acp/parts.js';
import type { AgentRunInput } from '../src/agent/types.js';
import type { ClaudeQuestion } from '../src/protocol.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';

/**
 * The ACP core on its own: nothing here names Antigravity. Antigravity's own behavior on the core
 * is in antigravity-flow.test.ts, unchanged since before the core.
 */

describe('the core’s small parts', () => {
  it('runs Claude’s aliases and Beluga’s own values on the agent’s own model', () => {
    expect(acpModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    for (const m of ['default', 'opus', 'Sonnet', 'haiku', 'best', 'opusplan', 'opus[1m]', 'ollama/qwen3', undefined]) expect(acpModel(m)).toBeUndefined();
  });

  it('finds a mode by what it is for', () => {
    const options = [{ id: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }];
    expect(modeValue(options, 'plan')).toBe('plan');
    expect(modeValue([], 'plan')).toBeUndefined();
  });

  it('tells a failure as the runtime’s own: signed out by ACP’s code, a limit by the agent’s words', () => {
    const out = acpFailure({ error: 'nope', stderr: [], cause: new CodexRpcError('auth', ACP_AUTH_REQUIRED) }, 'toy');
    expect(out).toBeInstanceOf(RunFailedError);
    expect((out as RunFailedError).failure).toMatchObject({ kind: 'signed_out', runtime: 'toy' });
    // Words no runtime's classifier knows (no "quota", "limit" or "429"): only the agent's own regex makes them a limit.
    const limited = acpFailure({ error: 'TOYFULL now', stderr: [] }, 'toy', /TOYFULL/);
    expect((limited as RunFailedError).failure).toMatchObject({ kind: 'usage_limit', runtime: 'toy' });
    expect((acpFailure({ error: 'TOYFULL now', stderr: [] }, 'toy') as RunFailedError).failure.kind).not.toBe('usage_limit');
  });

  it('knows signed out by ACP’s code or its words', () => {
    expect(acpSignedOut(new CodexRpcError('x', ACP_AUTH_REQUIRED))).toBe(true);
    expect(acpSignedOut(new Error('Not logged in'))).toBe(true);
    expect(acpSignedOut(new Error('timeout'))).toBe(false);
  });

  it('tells the agent why a step was declined, once each', () => {
    expect(declinedNote(['No.', 'No.'])).toBe("Beluga declined that step: No. Carry on without it: answer the person now, saying what you couldn't do.");
  });

  it('reads a session’s models, with the thinking levels of the current one', () => {
    const rows = modelRows([
      { id: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'bee' }] },
      { id: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    ]);
    expect(rows).toEqual([{ value: 'a', label: 'A', description: '', efforts: ['low', 'high'] }, { value: 'b', label: 'B', description: 'bee' }]);
  });
});

/** An agent the core has never heard of. */
const TOY: AcpAgentSpec = {
  id: 'toy',
  label: 'Toy',
  command: 'toy',
  args: ['acp'],
  pathVar: 'BELUGA_TOY_PATH',
  searchDirs: (platform, home) => (platform === 'win32' ? [path.win32.join(home, 'toys')] : [path.posix.join(home, 'toys'), '/opt/toys']),
  addDirFlag: '--with',
  missingWords: (where) => `Toy isn’t installed on this ${where}.`,
  installFix: 'Install Toy',
  signInFix: 'Sign in to Toy',
};

describe('finding an ACP agent', () => {
  const at = (...files: string[]) => (f: string) => files.includes(f);

  it('takes its variable outright, and nothing else when it names nothing that runs', () => {
    expect(findAcpCommand(TOY, { BELUGA_TOY_PATH: '/x/toy', PATH: '/usr/bin' }, 'darwin', at('/x/toy', '/usr/bin/toy'), '/h')).toBe('/x/toy');
    expect(findAcpCommand(TOY, { BELUGA_TOY_PATH: '/x/toy', PATH: '/usr/bin' }, 'darwin', at('/usr/bin/toy'), '/h')).toBeUndefined();
  });

  it('looks on PATH first, then in its own folders', () => {
    expect(findAcpCommand(TOY, { PATH: '/usr/bin:/bin' }, 'linux', at('/bin/toy', '/h/toys/toy'), '/h')).toBe('/bin/toy');
    expect(findAcpCommand(TOY, { PATH: '/usr/bin' }, 'linux', at('/opt/toys/toy'), '/h')).toBe('/opt/toys/toy');
    expect(findAcpCommand(TOY, { PATH: '/usr/bin' }, 'linux', at(), '/h')).toBeUndefined();
  });

  it('finds its .exe on Windows', () => {
    expect(findAcpCommand(TOY, { Path: 'C:\\bin' }, 'win32', at('C:\\h\\toys\\toy.exe'), 'C:\\h')).toBe('C:\\h\\toys\\toy.exe');
  });

  it('passes each extra folder with its own flag, and none for an agent without one', () => {
    expect(addDirArgs(TOY, ['/a', '/b'])).toEqual(['--with', '/a', '--with', '/b']);
    expect(addDirArgs({}, ['/a'])).toEqual([]);
  });
});

// ScriptedAgy speaks plain ACP in the shapes agy 1.5.8 sends: here it is only "a process that speaks ACP".

describe('an ACP agent’s status', () => {
  it('is missing in its own words when nothing runs', async () => {
    const status = await acpStatus({ ...TOY, command: 'toy-acp-agent-for-tests', pathVar: 'BELUGA_TOY_NONE', searchDirs: () => [] }, {}, { now: 0 });
    expect(status).toEqual({ state: 'missing', fix: 'Install Toy', models: [] });
  });

  it('is ready with the models a session offers, and drops the session it opened to look', async () => {
    const agy = new ScriptedAgy();
    const dropped: string[] = [];
    const status = await acpStatus(TOY, {}, { connect: agy.connect, drop: async (id) => void dropped.push(id) });
    expect(status.state).toBe('ready');
    expect(status.models.length).toBeGreaterThan(0);
    await waitFor(() => dropped.length === 1);
  });
});

/** The least an extension may be: its instructions and its tools (Antigravity's shapes, which ScriptedAgy speaks). */
const bare: AcpExtension = { instructions: (text) => ({ toy: { instructions: text } }), tools: { dialect: agyDialect, belugaToolOf } };

describe('a side call on an ACP agent', () => {
  it('answers in a conversation of its own, and drops it after', async () => {
    const agy = new ScriptedAgy();
    const dropped: string[] = [];
    const text = await acpComplete(TOY, bare, { cwd: process.cwd(), prompt: 'hello', system: 'Answer.', tools: [] }, { connect: agy.connect, drop: async (id) => void dropped.push(id) });
    expect(text).toContain('hello');
    await waitFor(() => dropped.length === 1);
  });
});

describe('a run on an ACP agent the core has never heard of', () => {
  const run = (prompt: string, extra: { readonly model?: string } = {}) => {
    const events: Array<[string, string]> = [];
    const asked: ClaudeQuestion[] = [];
    const input: AgentRunInput = {
      prompt,
      requesterName: 'kay',
      viaAgent: false,
      context: [],
      scope: 'folder',
      signal: new AbortController().signal,
      onEvent: (k, t) => void events.push([k, t]),
      onFileTouched: () => undefined,
      canUseTool: async () => true,
      askUser: async (q) => (asked.push(q), { kind: 'skip' }),
      ...(extra.model ? { model: extra.model } : {}),
    };
    return { input, events, asked };
  };
  const toy = (agy: ScriptedAgy, ext: AcpExtension = bare) => createAcpBackend(TOY, ext, { cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room, connect: agy.connect });
  const deploy: ClaudeQuestion = { kind: 'question', questions: [{ question: 'Deploy?', header: '', options: [{ label: 'Yes', description: '' }], multiSelect: false }] };

  it('counts what each turn cost, though the agent says its session’s running total', async () => {
    const b = toy(new ScriptedAgy({ cost: 0.25 }));
    const costs: number[] = [];
    for (const words of ['one', 'two']) {
      const r = run(words);
      await b.run(r.input);
      for (const [k, t] of r.events) if (k === 'usage') costs.push((JSON.parse(t) as { cost: number }).cost);
    }
    expect(costs).toEqual([0.25, 0.25]);
  });

  it('answers, with Beluga’s instructions in the _meta its extension gives', async () => {
    const agy = new ScriptedAgy();
    expect(await toy(agy).run(run('hello').input)).toBe('echo: hello');
    const meta = agy.sent('session/new')[0]?._meta as { toy?: { instructions?: string } } | undefined;
    expect(meta?.toy?.instructions).toBeTruthy();
  });

  it('says what it can’t do in its own name', async () => {
    const r = run('hello', { model: 'claude-opus-9' });
    await toy(new ScriptedAgy()).run(r.input);
    expect(r.events.some(([k, t]) => k === 'progress' && t.startsWith('Toy has no claude-opus-9'))).toBe(true);
  });

  it('asks nothing for a question tool it wasn’t told about', async () => {
    const r = run('question');
    await toy(new ScriptedAgy()).run(r.input);
    expect(r.asked).toEqual([]);
  });

  it('asks a question its extension knows, and its answer is the next turn', async () => {
    const r = run('question');
    const ext: AcpExtension = { ...bare, questions: { tool: 'ask_question', detect: (raw) => (raw ? deploy : undefined), answer: () => 'The person skipped your question (ask_question).' } };
    const answer = await toy(new ScriptedAgy(), ext).run(r.input);
    expect(r.asked).toEqual([deploy]);
    expect(answer).toContain('skipped: going on');
  });

  it('sends /compact on as a message when its extension has no compact of its own', async () => {
    const r = run('/compact');
    await toy(new ScriptedAgy()).run(r.input);
    expect(r.events.some(([k]) => k === 'compact')).toBe(false);
  });

  it('reports no quota for an agent without one', async () => {
    const reportUsage = vi.fn();
    const b = createAcpBackend(TOY, bare, { cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: { ...room, reportUsage }, connect: new ScriptedAgy().connect });
    await b.refreshUsage?.();
    expect(reportUsage).not.toHaveBeenCalled();
  });
});

describe('the flags an extension starts an agent with', () => {
  const OLD: AcpAgentSpec = { ...TOY, args: [path.join(__dirname, 'fixtures', 'acp-old-agent.mjs'), 'acp'] };
  const started = async (env: Record<string, string>) => {
    const conn = await spawnAcp(OLD, { launch: async () => ['--new-flag'] })({ cwd: process.cwd(), env: { ...process.env, ...env }, bin: process.execPath, args: ['--with', 'x'] });
    await conn.proc.kill();
    return conn.init.agentInfo?.name;
  };

  it('go after its own args, before a run’s', async () => {
    expect(await started({ ACP_OLD: '0' })).toBe('acp --new-flag --with x');
  });

  it('are left out when they can’t be made ready', async () => {
    const conn = await spawnAcp(OLD, { launch: async () => Promise.reject(new Error('no')) })({ cwd: process.cwd(), env: { ...process.env, ACP_OLD: '0' }, bin: process.execPath });
    await conn.proc.kill();
    expect(conn.init.agentInfo?.name).toBe('acp');
  });

  // Last: from here on, this executable (node) starts without them.
  it('are left out for a version that says it doesn’t know one', async () => {
    expect(await started({ ACP_OLD: '1' })).toBe('acp --with x');
  });
});
