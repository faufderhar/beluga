import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AcpAgents } from '../src/agent/runtime/acp/agents.js';
import { BUILTIN_ACP_AGENTS, builtinAcpAgent } from '../src/agent/runtime/acp/catalog.js';
import { acpCalls, acpInput, acpTool, belugaToolOf, mcpServersFor } from '../src/agent/runtime/acp/dialect.js';
import { ACP_CAPABILITIES, RUNTIME_ID, acpRuntimeId, entryProblem, installCommandOf, specOf } from '../src/agent/runtime/acp/entry.js';
import { genericExtension } from '../src/agent/runtime/acp/generic.js';
import { acpMode, sessionModelRows, withInstructions } from '../src/agent/runtime/acp/parts.js';
import { createAcpRuntime } from '../src/agent/runtime/acp/runtime.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { fallbackFor, runtimeHas } from '../src/shared/runtime-fallbacks.js';
import { ScriptedCopilot } from '../src/agent/runtime/copilot/scripted.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { room, runtimeConformance } from './runtime-conformance.js';

/**
 * Your ACP agents: the built-in list, the agents you added, and the generic runtime every agent
 * without an extension of its own runs on. The scripted agent is Copilot's: it names its tools by
 * ACP kind and words for people, takes MCP over HTTP and calls its modes `…#agent` and `…#plan`,
 * as many ACP agents do.
 */

const generic = (agent: ScriptedCopilot) => createAcpRuntime(specOf(builtinAcpAgent('cursor')!), genericExtension(), ACP_CAPABILITIES, { connect: agent.connect });
const scripted = new ScriptedCopilot();
runtimeConformance('acp (generic)', () => generic(scripted));

describe('the built-in ACP agents', () => {
  it('has Antigravity and the agents T3 Code runs as its own, each a valid, unique runtime id', () => {
    const ids = BUILTIN_ACP_AGENTS.map((a) => a.id);
    for (const id of ['antigravity', 'cursor', 'grok', 'kiro', 'muse', 'pi', 'fx', 'gemini', 'qwen']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BUILTIN_ACP_AGENTS) {
      expect(a.id).toMatch(RUNTIME_ID);
      expect(entryProblem(a)).toBeUndefined();
      // The fixed agents keep their own ids.
      expect(['claude', 'codex', 'opencode', 'copilot', 'local']).not.toContain(a.id);
    }
  });

  it('starts each in its ACP mode', () => {
    expect(builtinAcpAgent('antigravity')).toMatchObject({ command: 'agy', args: ['acp'], pathVar: 'BELUGA_AGY_PATH' });
    expect(builtinAcpAgent('cursor')).toMatchObject({ command: 'cursor-agent', args: ['acp'] });
    expect(builtinAcpAgent('muse')).toMatchObject({ command: 'muse', args: ['acp'], env: { MUSE_EXPERIMENTAL_ACP: 'on' } });
  });

  it('gives the command to copy that installs one', () => {
    expect(installCommandOf(builtinAcpAgent('gemini')!)).toBe('npm i -g @google/gemini-cli');
    expect(installCommandOf(builtinAcpAgent('antigravity')!)).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(installCommandOf({ install: 'Install the fx CLI, then try again' })).toBeUndefined();
  });

  it('makes the core’s spec: its folders under your home, its own words when it isn’t there', () => {
    const spec = specOf(builtinAcpAgent('cursor')!);
    expect(spec.searchDirs?.('linux', '/home/u')).toEqual(['/home/u/.local/bin', '/home/u/.cursor/bin']);
    expect(spec.missingWords('Mac')).toMatch(/^Cursor isn’t installed on this Mac\. Install Cursor’s CLI/);
    expect(spec.signInFix).toMatch(/cursor-agent login/);
  });

  it('makes a runtime id for a Registry agent or a command of yours that the room protocol takes', () => {
    expect(acpRuntimeId('gemini')).toBe('acp-gemini');
    expect(acpRuntimeId('My Agent!')).toBe('acp-my-agent');
    expect(acpRuntimeId('x'.repeat(60))).toMatch(RUNTIME_ID);
  });
});

describe('your ACP agents', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-acp-agents-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => new AcpAgents({ file: path.join(dir, `agents-${n++}.json`) });

  it('has none until you add one, then lists them in the order you added them', () => {
    const agents = fresh();
    expect(agents.list()).toEqual([]);
    expect(agents.add('gemini')).toEqual({ ok: true, id: 'gemini' });
    expect(agents.add('antigravity')).toEqual({ ok: true, id: 'antigravity' });
    expect(agents.list().map((a) => a.id)).toEqual(['gemini', 'antigravity']);
    expect(agents.available().map((a) => a.id)).not.toContain('gemini');
    // Adding one twice keeps one.
    agents.add('gemini');
    expect(agents.list()).toHaveLength(2);
  });

  it('refuses a built-in agent it doesn’t know, and a command that takes a fixed agent’s id', () => {
    const agents = fresh();
    expect(agents.add('nope')).toMatchObject({ ok: false });
    expect(agents.addWhole({ id: 'codex', label: 'Codex', command: 'x', args: [], source: 'local' })).toMatchObject({ ok: false });
    expect(agents.addWhole({ id: 'cursor', label: 'Cursor', command: 'x', args: [], source: 'local' })).toMatchObject({ ok: false });
  });

  it('adds a command of yours as `acp-<its name>`, and refuses one with a line break', () => {
    const agents = fresh();
    expect(agents.addCommand({ label: 'dsh', command: 'dsh', args: ['acp'], env: { A: '1' } })).toEqual({ ok: true, id: 'acp-dsh' });
    expect(agents.get('acp-dsh')).toMatchObject({ label: 'dsh', command: 'dsh', args: ['acp'], env: { A: '1' }, source: 'local' });
    expect(agents.addCommand({ label: 'bad', command: 'a\nb' })).toMatchObject({ ok: false, error: expect.stringContaining('line breaks') });
  });

  it('removes one of yours', () => {
    const agents = fresh();
    agents.add('cursor');
    expect(agents.remove('cursor')).toBe(true);
    expect(agents.remove('cursor')).toBe(false);
    expect(agents.list()).toEqual([]);
  });

  it('adds Antigravity once for a Mac that ran it before, and never again after you remove it', () => {
    const agents = fresh();
    expect(agents.migrate(() => true)).toBe(true);
    expect(agents.has('antigravity')).toBe(true);
    agents.remove('antigravity');
    expect(agents.migrate(() => true)).toBe(false);
    expect(agents.has('antigravity')).toBe(false);
  });

  it('adds nothing for a Mac that never ran Antigravity, and keeps that', () => {
    const file = path.join(dir, 'never.json');
    const agents = new AcpAgents({ file });
    expect(agents.migrate(() => false)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ added: [], migrated: true });
    expect(agents.migrate(() => true)).toBe(false);
  });
});

describe('any ACP agent’s tools, as Beluga judges them', () => {
  const cwd = path.join(os.tmpdir(), 'proj');
  const suites = ['beluga', 'beluga_board'];

  it('knows Beluga’s own tools in every way agents name them, and only the ones mounted', () => {
    for (const name of ['beluga_board-task_get', 'beluga_board_task_get', 'mcp_beluga_board_task_get', 'mcp__beluga_board__task_get', 'beluga_board/task_get']) expect(belugaToolOf(name, suites)).toBe('mcp__beluga_board__task_get');
    expect(belugaToolOf('github_create_issue', suites)).toBeUndefined();
    expect(belugaToolOf('beluga_helper_x', suites, new Set(['mcp__beluga__list_peers']))).toBeUndefined();
  });

  it('reads a call by its ACP kind, its input in any case, and its locations', () => {
    expect(acpTool({ kind: 'read', title: 'Reading a file' }, suites)).toBe('read');
    expect(acpTool({ kind: 'read', title: 'beluga-list_peers' }, suites)).toBe('beluga-list_peers');
    expect(acpCalls('read', acpInput({ rawInput: { Path: 'a.ts' } }), cwd)).toEqual([{ name: 'Read', input: { file_path: path.join(cwd, 'a.ts') } }]);
    expect(acpCalls('read', acpInput({ rawInput: {}, locations: [{ path: path.join(cwd, 'b.ts') }, { path: path.join(cwd, 'c.ts') }] }), cwd).map((c) => c.input.file_path)).toEqual([path.join(cwd, 'b.ts'), path.join(cwd, 'c.ts')]);
    expect(acpCalls('execute', { cmd: ['git', 'status'] }, cwd)).toEqual([{ name: 'Bash', input: { command: 'git status' } }]);
    expect(acpCalls('edit', { path: 'new.ts', content: 'hello' }, cwd)[0]!.name).toBe('Write');
    expect(acpCalls('fetch', { url: 'https://x.dev' }, cwd)).toEqual([{ name: 'WebFetch', input: { url: 'https://x.dev' } }]);
    expect(acpCalls('github_issue', { a: 1 }, cwd, suites)[0]!.name).toBe('mcp__acp__github_issue');
  });

  it('mounts Beluga’s tools over HTTP when the agent takes them so, else stdio', () => {
    const mounted = { http: { beluga: { url: 'http://127.0.0.1:1', headers: {} } }, servers: { beluga: { type: 'stdio' as const, command: 'node', args: ['x'], env: {} } } };
    expect(mcpServersFor(mounted, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } as never)).toEqual([{ type: 'http', name: 'beluga', url: 'http://127.0.0.1:1', headers: [] }]);
    expect(mcpServersFor(mounted, { protocolVersion: 1 })).toEqual([{ name: 'beluga', command: 'node', args: ['x'], env: [] }]);
    expect(mcpServersFor(mounted, { protocolVersion: 1 }, 'http')[0]).toMatchObject({ type: 'http' });
  });
});

describe('an ACP session’s models and modes, in either shape', () => {
  it('lists the older models after Default', () => {
    const s = { models: { availableModels: [{ modelId: 'gemini-3-pro', name: 'Gemini 3 Pro' }], currentModelId: 'gemini-3-pro' } };
    expect(sessionModelRows(s, true).map((r) => r.label)).toEqual(['Default', 'Gemini 3 Pro']);
    expect(sessionModelRows(s).map((r) => r.value)).toEqual(['gemini-3-pro']);
  });

  it('finds plan and the mode that asks, never one that doesn’t', () => {
    const modes = { modes: { availableModes: [{ id: 'auto' }, { id: 'accept-edits' }, { id: 'default' }, { id: 'plan' }], currentModeId: 'auto' } };
    expect(acpMode(modes, 'plan')).toEqual({ via: 'modes', value: 'plan' });
    expect(acpMode(modes, 'default')).toEqual({ via: 'modes', value: 'default' });
    expect(acpMode({ modes: { availableModes: [{ id: 'auto' }, { id: 'yolo' }] } }, 'default')).toBeUndefined();
    expect(acpMode({ configOptions: [{ id: 'mode', currentValue: 'x#agent', options: [{ value: 'x#agent', name: 'Agent' }, { value: 'x#plan', name: 'Plan' }] }] }, 'default')).toEqual({ via: 'config', value: 'x#agent' });
  });

  it('puts Beluga’s instructions ahead of a first message', () => {
    expect(withInstructions('Be brief.', 'hello')).toBe('<beluga-instructions>\nBe brief.\n</beluga-instructions>\n\nhello');
    expect(withInstructions('', 'hello')).toBe('hello');
  });
});

describe('a run on a generic ACP agent', () => {
  const input = (prompt: string): AgentRunInput => ({ prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true });

  it('carries Beluga’s instructions in its first message, with no _meta, and not again', async () => {
    const agent = new ScriptedCopilot();
    const backend = generic(agent).create({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room });
    const sessions: string[] = [];
    const run = { ...input('hello'), place: { cwd: process.cwd(), additionalDirectories: [], autoEdit: true, onSession: (id: string) => void sessions.push(id) } };
    await backend.run(run);
    expect(agent.sent('session/new')[0]?._meta).toBeUndefined();
    const said = agent.sessions.get(sessions[0]!) ?? [];
    expect(said[0]).toMatch(/^<beluga-instructions>/);
    await backend.run({ ...run, place: { ...run.place, resume: sessions[0]! } });
    expect((agent.sessions.get(sessions[0]!) ?? []).slice(1).some((t) => t.startsWith('<beluga-instructions>'))).toBe(false);
  });

  it('lists its models after Default', async () => {
    const status = await generic(new ScriptedCopilot()).status!();
    expect(status.state).toBe('ready');
    expect(status.models[0]).toMatchObject({ value: '', label: 'Default' });
  });
});

describe('your ACP agents in the pickers', () => {
  it('lists them after the fixed agents, each only once you added it', () => {
    const runs = (ids: string[]) => (id: string) => (ids.includes(id) ? {} : undefined);
    expect(runtimeChoices(runs(['claude'])).map((c) => c.id)).toEqual(['claude', 'codex', 'opencode', 'copilot', 'grok', 'local']);
    const added = runtimeChoices(runs(['claude', 'antigravity', 'cursor']), [{ id: 'cursor', label: 'Cursor' }, { id: 'claude', label: 'Dup' }]);
    expect(added.map((c) => c.id)).toEqual(['claude', 'codex', 'opencode', 'copilot', 'grok', 'local', 'antigravity', 'cursor']);
    expect(added.find((c) => c.id === 'cursor')).toMatchObject({ available: true, label: 'Cursor' });
  });

  it('says why where any of them does differently, Antigravity keeping its own words', () => {
    for (const id of ['cursor', 'acp-dsh']) {
      expect(fallbackFor(id, 'fork')).toMatch(/new conversation/);
      expect(fallbackFor(id, 'guests')).toMatch(/guests/);
      expect(runtimeHas(id, 'btw')).toBe(false);
    }
    expect(fallbackFor('antigravity', 'guests')).toMatch(/^Antigravity/);
    expect(fallbackFor('claude', 'fork')).toBeUndefined();
  });
});
