import { appendFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput, RoomBridge, TerminalLaunch, TerminalSink } from '../src/agent/types.js';
import { claudeTerminal, sessionArgs, trustFolder } from '../src/agent/runtime/claude/terminal.js';
import { ZSH_COMPAT, ZSH_COMPAT_FILE } from '../src/agent/runtime/claude/zsh-compat.js';
import { childEnv } from '../src/terminal/pty.js';
import { shellChildren } from '../src/terminal/shells-under.js';
import { readFileSync } from 'node:fs';
import { GATE_HOOK_SCRIPT, gateHookSettings, hasRawVisual, lastAnswer, shellQuote, terminalHookAnswer } from '../src/agent/terminal-hook.js';
import { buildGraphAppend } from '../src/agent/graph-prompt.js';
import { buildViewAppend } from '../src/agent/view-prompt.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { TerminalShelf, ViewShelf, createViewTools, showView } from '../src/agent/view-tools.js';
import { ToolHost } from '../src/agent/tool-host.js';
import { AgentHost, TERMINAL_DRIVING } from '../src/core/agent-host.js';
import { AgentTerminals, withoutHanded } from '../src/core/agent-term.js';
import { TranscriptTail, claudeTranscriptFile, claudeTurns } from '../src/core/agent-term-sync.js';
import { encodeProjectDir } from '../src/agent/runtime/claude/claude-sessions.js';
import { Store, initialState } from '../src/core/store.js';
import { GRAPH_FENCE } from '../src/shared/graph-spec.js';
import { describeVisual, expandVisuals, visualToken, visualsIn } from '../src/shared/term-visuals.js';
import { VIEW_FENCE, viewBlock } from '../src/shared/view-spec.js';
import type { PtyProcess } from '../src/terminal/pty-host.js';
import type { Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

/** BLG-534/535: the agent's own terminal on a conversation, its visuals, and its turns back in the chat. */

const GRAPH = { title: 'How login works', nodes: [{ id: 'a', label: 'Web app' }, { id: 'b', label: 'API' }, { id: 'g', type: 'group', label: 'Backend' }], edges: [{ from: 'a', to: 'b' }], steps: [{ title: 'One', text: 'x', focus: ['a'] }] };
const TABLE = { type: 'table', title: 'Customers by revenue', data: [{ customer: 'Acme', revenue: 1 }, { customer: 'Globex', revenue: 2 }], total: 124 };

describe('visuals in the terminal', () => {
  it('says what a link opens, in a few words', () => {
    expect(describeVisual(3, viewBlock(GRAPH, GRAPH_FENCE))).toEqual({ n: 3, kind: 'graph', title: 'How login works', meta: '2 parts · 1 link · 1 step' });
    expect(describeVisual(4, viewBlock(TABLE, VIEW_FENCE))).toEqual({ n: 4, kind: 'table', title: 'Customers by revenue', meta: '124 rows · sort, filter, chart' });
    expect(describeVisual(5, '```beluga-graph\n{nope\n```')).toMatchObject({ n: 5, kind: 'graph', title: 'Graph' });
  });

  it('puts each visual in place of its token for the chat, and drops one with none behind it', () => {
    const block = viewBlock(GRAPH, GRAPH_FENCE);
    const text = `Here it is:\n\n  ${visualToken(2)}\n\nAnd ${visualToken(9)} gone.`;
    expect(visualsIn(text)).toEqual([2, 9]);
    const out = expandVisuals(text, (n) => (n === 2 ? block : undefined));
    expect(out).toContain(block);
    expect(out).not.toContain('[[visual:');
    expect(out).toMatch(/And\s*gone\./);
  });

  it('says what any other block the chat draws is: task cards, code, comments, diagrams, pictures', () => {
    expect(describeVisual(1, '```beluga-tasks\nBLG-1\nBLG-2\n```')).toMatchObject({ kind: 'tasks', title: 'Tasks', meta: 'BLG-1, BLG-2' });
    expect(describeVisual(2, '```beluga-tasks\nBLG-1\n```')).toMatchObject({ kind: 'tasks', title: 'BLG-1' });
    expect(describeVisual(3, '```beluga-code\nsrc/auth.ts:40-62\nhighlight: 44\n```')).toMatchObject({ kind: 'source', title: 'src/auth.ts:40-62' });
    expect(describeVisual(4, '```beluga-pr-comments\nshow: all\n```')).toMatchObject({ kind: 'comments', meta: 'all threads' });
    expect(describeVisual(5, '```mermaid\nflowchart LR\nA-->B\n```')).toMatchObject({ kind: 'diagram', meta: 'flowchart' });
    expect(describeVisual(6, '![Login page](/Users/me/s/01.png)')).toMatchObject({ kind: 'image', title: 'Login page' });
    expect(describeVisual(7, '![](/Users/me/s/01.png)')).toMatchObject({ kind: 'image', title: '01.png' });
    expect(describeVisual(8, '```console\n$ npm test\nok\n```')).toMatchObject({ kind: 'block', title: 'Terminal output', meta: '2 lines' });
    expect(describeVisual(9, '## Notes\nsome words')).toMatchObject({ kind: 'block', title: 'Notes' });
  });

  it('the terminal’s show_block keeps any Markdown and answers with its token; a chat run has no show_block', async () => {
    const kept: string[] = [];
    const term = createViewTools(new TerminalShelf({ add: (b) => kept.push(b) }), os.tmpdir());
    const block = term.tools.find((t) => t.name === 'show_block')!;
    const out = await block.handler({ markdown: '```beluga-tasks\nBLG-1\n```' }, {});
    expect(JSON.stringify(out)).toContain('[[visual:1]]');
    expect(kept).toEqual(['```beluga-tasks\nBLG-1\n```']);
    expect(createViewTools(new ViewShelf(), os.tmpdir()).tools.some((t) => t.name === 'show_block')).toBe(false);
  });

  it('leaves out, in the chat, the rows written under a table’s token for the terminal', () => {
    const table = viewBlock(TABLE, VIEW_FENCE);
    const graph = viewBlock(GRAPH, GRAPH_FENCE);
    const text = 'Top customers:\n\n[[visual:1]]\n\n| name | revenue |\n|---|---|\n| Acme | 1 |\n\nAnd the flow:\n[[visual:2]]\n| kept | because a graph |\n';
    const out = expandVisuals(text, (n) => (n === 1 ? table : n === 2 ? graph : undefined));
    expect(out).not.toContain('| Acme | 1 |');
    expect(out).toContain('| kept | because a graph |');
    expect(out).toContain(table);
  });

  it('the terminal’s show tool keeps the view and answers with its token', async () => {
    const kept: string[] = [];
    const shelf = new TerminalShelf({ add: (b) => kept.push(b) + 6 });
    const said = await showView(shelf, os.tmpdir(), { type: 'graph', ...GRAPH });
    expect(said).toContain('[[visual:7]]');
    expect(kept[0]).toMatch(/^```beluga-graph\n/);
  });

  it('tells the agent, in the terminal only, to show visuals as tokens', () => {
    const input = { prompt: '', requesterName: 'me', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true } as unknown as AgentRunInput;
    expect(runInstructions(input, 'Kayra')).not.toContain('terminal view');
    const t = runInstructions({ ...input, terminal: true }, 'Kayra');
    expect(t).toContain('terminal view');
    expect(t).toContain('[[visual:3]]');
  });
});

describe('launching the agent’s terminal', () => {
  it('opens Claude Code on the conversation it had, a fork of one, or a new one with its id up front', () => {
    expect(sessionArgs('s1', false)).toEqual({ args: ['--resume', 's1'], session: 's1', fresh: false });
    expect(sessionArgs('s1', true, () => 'n1')).toEqual({ args: ['--resume', 's1', '--fork-session', '--session-id', 'n1'], session: 'n1', fresh: true });
    expect(sessionArgs(undefined, false, () => 'n2')).toEqual({ args: ['--session-id', 'n2'], session: 'n2', fresh: true });
  });

  it('trusts the worktree in Claude Code, so its terminal doesn’t open on “No, exit”, and touches nothing else', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-trust-'));
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', projects: { '/other': { allowedTools: ['x'] } } }));
    trustFolder('/work/tree', file);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.projects['/other']).toEqual({ allowedTools: ['x'] });
    // The folder as the platform spells it (D:\work\tree on Windows), and as Claude Code there does (D:/work/tree).
    const tree = path.resolve('/work/tree');
    expect(after.projects[tree]).toEqual({ hasTrustDialogAccepted: true });
    expect(after.projects[tree.replaceAll('\\', '/')]).toEqual({ hasTrustDialogAccepted: true });
    writeFileSync(file, '{ broken');
    trustFolder('/work/tree', file);
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('a claude in a terminal is a session of its own, never a child of the one Beluga runs under', () => {
    const was = { ...process.env };
    Object.assign(process.env, { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1' });
    try {
      const env = childEnv({});
      expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
    } finally {
      for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    }
  });

  it('applies Beluga’s rules to the terminal’s tool calls, as a chat run’s hook does', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-term-rules-'));
    const policy = { cwd, roots: [cwd], autoEdit: true, scope: 'full' as const, dotenv: true, askOnly: false };
    const hook = (tool_name: string, tool_input: Record<string, unknown>) => terminalHookAnswer({ hook_event_name: 'PreToolUse', tool_name, tool_input }, {}, policy);
    expect(hook('Write', { file_path: path.join(cwd, 'a.ts') })).toEqual({});
    expect(hook('Read', { file_path: path.join(cwd, '.env') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    expect(hook('mcp__beluga_view__show', {})).toEqual({});
    expect(terminalHookAnswer({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, { vetTool: () => 'not for friends' }, policy)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'not for friends' } });
    const main = terminalHookAnswer({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x') } }, {}, { ...policy, autoEdit: false, askOnly: true });
    expect(main).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(terminalHookAnswer({ hook_event_name: 'PostToolUse' }, {}, policy)).toEqual({});
  });

  describe('the tools’ token stays off the command line (BLG-110)', () => {
    const launched = async (home: string, host: ToolHost, cwd: string, signal = new AbortController().signal): Promise<TerminalLaunch> => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', home); // trustFolder writes here, not in your ~/.claude.json
      const input = { prompt: 'hello', requesterName: 'me', viaAgent: false, context: [], place: { cwd, autoEdit: true, additionalDirectories: [] }, signal, onEvent: () => undefined } as unknown as AgentRunInput;
      const bridge = { selfName: () => 'me', listPeers: () => [] } as unknown as RoomBridge;
      return claudeTerminal(input, { add: () => 1 }, { bridge, claudePath: '/bin/claude', toolHost: host, node: '/bin/node', home });
    };
    const configIn = (launch: TerminalLaunch): string => launch.args[launch.args.indexOf('--mcp-config') + 1]!;

    afterEach(() => vi.unstubAllEnvs());

    it('gives Claude Code a private file that goes when the run closes', async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-home-'));
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-cwd-'));
      const host = new ToolHost({ command: 'beluga', args: [] });
      const launch = await launched(home, host, cwd);
      const file = configIn(launch);
      const { mcpServers } = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
      const token = mcpServers.beluga!.env.BELUGA_TOOLS_TOKEN!;

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(launch.args.join(' ')).not.toContain(token);
      expect(launch.args.join(' ')).not.toContain('BELUGA_TOOLS_TOKEN');
      expect(launch.args.join(' ')).toContain('mcp__beluga');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      // Never in the worktree: its scratch folder shows on your screens and to friends sharing it.
      expect(file.startsWith(home + path.sep)).toBe(true);

      launch.close();
      expect(existsSync(file)).toBe(false);
      launch.close(); // closing again does no harm
      await host.close();
    });

    it.skipIf(process.platform === 'win32')('starts Claude Code with zsh-compat.sh from Beluga’s home, and says so when its shell is zsh (Git Bash on Windows)', async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-home-'));
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-cwd-'));
      const host = new ToolHost({ command: 'beluga', args: [] });
      vi.stubEnv('CLAUDE_ENV_FILE', '');
      vi.stubEnv('CLAUDE_CODE_SHELL', '');
      vi.stubEnv('SHELL', '/bin/zsh');
      const launch = await launched(home, host, cwd);
      const file = path.join(home, ZSH_COMPAT_FILE);
      expect(launch.env?.CLAUDE_ENV_FILE).toBe(file);
      expect(readFileSync(file, 'utf8')).toBe(ZSH_COMPAT);
      const instructions = launch.args[launch.args.indexOf('--append-system-prompt') + 1]!;
      if (existsSync('/bin/zsh')) expect(instructions).toContain('set up to take common bash');
      launch.close();

      // Your own CLAUDE_ENV_FILE stays, and the instructions say plain zsh.
      vi.stubEnv('CLAUDE_ENV_FILE', '/x/yours.sh');
      const yours = await launched(home, host, cwd);
      expect(yours.env?.CLAUDE_ENV_FILE).toBeUndefined();
      if (existsSync('/bin/zsh')) expect(yours.args[yours.args.indexOf('--append-system-prompt') + 1]).toContain('not bash');
      yours.close();
      await host.close();
    });

    it('gives each run its own file', async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-home-'));
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-mcp-cwd-'));
      const host = new ToolHost({ command: 'beluga', args: [] });
      const [a, b] = [await launched(home, host, cwd), await launched(home, host, cwd)];
      expect(configIn(a!)).not.toBe(configIn(b!));
      a!.close();
      expect(existsSync(configIn(b!))).toBe(true);
      b!.close();
      await host.close();
    });
  });

  it('the hook script asks the daemon, and refuses when it can’t', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-hook-'));
    const file = path.join(dir, 'gate.mjs');
    writeFileSync(file, GATE_HOOK_SCRIPT);
    const host = new ToolHost();
    const seen: Array<Record<string, unknown>> = [];
    const mounted = await host.mount({}, async () => undefined, async (h) => {
      seen.push(h);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } };
    });
    const run = (env: Record<string, string>): Promise<string> =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? '', ...env } });
        let out = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.on('close', () => resolve(out));
        p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
      });
    const asked = JSON.parse(await run({ BELUGA_GATE_URL: mounted.hookUrl!, BELUGA_GATE_TOKEN: mounted.token }));
    expect(asked.hookSpecificOutput.permissionDecisionReason).toBe('nope');
    expect(seen[0]).toMatchObject({ tool_name: 'Bash' });
    const lost = JSON.parse(await run({}));
    expect(lost.hookSpecificOutput.permissionDecision).toBe('deny');
    const wrong = JSON.parse(await run({ BELUGA_GATE_URL: mounted.hookUrl!, BELUGA_GATE_TOKEN: '0'.repeat(64) }));
    expect(wrong.hookSpecificOutput.permissionDecision).toBe('deny');
    mounted.close();
    await host.close();
    const command = `${shellQuote("/n o'de")} '/f.mjs'`;
    expect(gateHookSettings("/n o'de", '/f.mjs')).toEqual({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 600 }] }], Stop: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] } });
  });

  it('the hook script lets a turn end when Beluga can’t be asked (only tool calls are refused)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-hook-stop-'));
    const file = path.join(dir, 'gate.mjs');
    writeFileSync(file, GATE_HOOK_SCRIPT);
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? '' } });
      let text = '';
      p.stdout.on('data', (d: Buffer) => (text += d.toString()));
      p.on('close', () => resolve(text));
      p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }));
    });
    expect(out).toBe('');
  });
});

describe('graphs in the terminal (BLG-555)', () => {
  const graph = '```' + GRAPH_FENCE + '\n{"title":"x","nodes":[],"edges":[]}\n```';

  it('the terminal’s instructions show graphs and views through the tool, with no fence to copy', () => {
    const term = buildGraphAppend(true) + buildViewAppend(true);
    expect(term).not.toContain('```' + GRAPH_FENCE);
    expect(term).not.toContain('```' + VIEW_FENCE);
    expect(term).toContain('mcp__beluga_view__show as {"type": "graph"');
    expect(term).toContain('beluga-code block passed to mcp__beluga_view__show_block');
    // The chat keeps its fences.
    expect(buildGraphAppend()).toContain('```' + GRAPH_FENCE);
    expect(buildViewAppend()).toContain('fenced ' + VIEW_FENCE + ' block works without the tool');
    const input = { prompt: '', requesterName: 'K', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined } as unknown as AgentRunInput;
    expect(runInstructions({ ...input, terminal: true }, 'Kayra')).not.toContain('```' + GRAPH_FENCE);
    expect(runInstructions(input, 'Kayra')).toContain('```' + GRAPH_FENCE);
  });

  it('finds a graph or view written as a fence in the last answer', () => {
    expect(hasRawVisual(`Here:\n\n${graph}`)).toBe(true);
    expect(hasRawVisual('  ```' + VIEW_FENCE + '\n{}\n```')).toBe(true);
    expect(hasRawVisual('Shown: [[visual:3]] and `beluga-graph` named inline')).toBe(false);
    expect(hasRawVisual('```ts\nconst a = 1;\n```')).toBe(false);
    const jsonl = [
      line({ type: 'user', message: { content: 'old ask' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: graph }] } }),
      line({ type: 'user', message: { content: 'draw it' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      'not json',
    ].join('\n');
    expect(lastAnswer(jsonl)).toBe('Looking.\n\nDone.');
  });

  it('sends a turn that ended with a raw graph back once to show it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-stop-'));
    const file = path.join(dir, 's.jsonl');
    writeFileSync(file, [line({ type: 'user', message: { content: 'draw it' } }), line({ type: 'assistant', message: { content: [{ type: 'text', text: `Here:\n${graph}` }] } })].join('\n'));
    const policy = { cwd: dir, roots: [dir], autoEdit: true, scope: 'full' as const, dotenv: true, askOnly: false };
    const stop = (extra: Record<string, unknown>) => terminalHookAnswer({ hook_event_name: 'Stop', transcript_path: file, ...extra }, {}, policy);
    expect(stop({ stop_hook_active: false })).toMatchObject({ decision: 'block', reason: expect.stringContaining('mcp__beluga_view__show') });
    // Already sent back once: it ends.
    expect(stop({ stop_hook_active: true })).toEqual({});
    // Only Claude Code's own transcripts are read.
    expect(terminalHookAnswer({ hook_event_name: 'Stop', transcript_path: path.join(dir, 'x.txt') }, {}, policy)).toEqual({});
    expect(terminalHookAnswer({ hook_event_name: 'Stop', last_assistant_message: graph }, {}, policy)).toMatchObject({ decision: 'block' });
    expect(terminalHookAnswer({ hook_event_name: 'Stop', last_assistant_message: 'All done.' }, {}, policy)).toEqual({});
  });

  it('the chat keeps one copy of a graph shown again through the tool', () => {
    const block = viewBlock(GRAPH, GRAPH_FENCE);
    const text = expandVisuals(`Here:\n\n${graph}\n\n${visualToken(1)}`, (n) => (n === 1 ? block : undefined));
    expect(text.split('```' + GRAPH_FENCE).length).toBe(2);
    expect(text).toContain(block);
    // Without a token, a fence stays as it was written.
    expect(expandVisuals(graph, () => undefined)).toBe(graph);
  });
});

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const at = (s: number): string => new Date(Date.UTC(2026, 9, 31, 12, 0, s)).toISOString();

describe('the terminal’s turns, back in the chat', () => {
  const opts = { selfId: 'me', selfName: 'Kayra', cwd: '/w', key: 'k1', visual: (n: number) => (n === 1 ? viewBlock(GRAPH, GRAPH_FENCE) : undefined) };

  it('reads Claude Code’s transcript as the chat’s turns, visuals drawn, and skips what was there before', () => {
    const lines = [
      line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'old, copied by a fork' } }),
      line({ type: 'user', timestamp: at(10), message: { role: 'user', content: 'map login' } }),
      line({ type: 'assistant', timestamp: at(11), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }] } }),
      line({ type: 'user', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line({ type: 'assistant', timestamp: at(13), message: { role: 'assistant', content: [{ type: 'text', text: 'Here:\n\n[[visual:1]]' }] } }),
      line({ type: 'user', isSidechain: true, timestamp: at(14), message: { role: 'user', content: 'a sub-agent' } }),
      'not json',
    ];
    const { items, steps } = claudeTurns(lines, { ...opts, since: Date.parse(at(5)) });
    expect(items.map((i) => i.type)).toEqual(['chat', 'agent']);
    expect(items[0]).toMatchObject({ type: 'chat', text: 'map login', from: 'me' });
    const agent = items[1] as Extract<(typeof items)[number], { type: 'agent' }>;
    expect(agent.id).toMatch(/^term-k1-/);
    expect(agent.requestId).toBe(agent.id);
    expect(agent.text).toContain('```beluga-graph');
    expect(Object.keys(steps)).toEqual([agent.id]);
  });

  it('reads a transcript as it grows, whole lines only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-tail-'));
    const file = path.join(dir, 's.jsonl');
    writeFileSync(file, 'before\n');
    const tail = new TranscriptTail(file, 7);
    expect(tail.read()).toBe(false);
    appendFileSync(file, '{"a":1}\n{"b":');
    expect(tail.read()).toBe(true);
    expect(tail.lines).toEqual(['{"a":1}']);
    appendFileSync(file, '2}\n');
    expect(tail.read()).toBe(true);
    expect(tail.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('finds Claude Code’s transcript under any spelling of the folder', () => {
    const config = mkdtempSync(path.join(os.tmpdir(), 'beluga-cc-'));
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-wt-'));
    expect(claudeTranscriptFile(cwd, 's1', config)).toBeUndefined();
    const real = cwd.startsWith('/var/') ? `/private${cwd}` : cwd;
    mkdirSync(path.join(config, 'projects', encodeProjectDir(real)), { recursive: true });
    writeFileSync(path.join(config, 'projects', encodeProjectDir(real), 's1.jsonl'), '');
    expect(claudeTranscriptFile(cwd, 's1', config)).toMatch(/s1\.jsonl$/);

  });
});

/** A pty that only says when it ended. */
function fakePty(): PtyProcess & { end(): void } {
  const exits: Array<() => void> = [];
  let running = true;
  return {
    watchers: 0,
    lastOutputAt: 0,
    pid: 4242,
    get running() {
      return running;
    },
    onExit: (l: () => void) => (exits.push(l), () => undefined),
    resize: () => undefined,
    end() {
      running = false;
      exits.forEach((l) => l());
    },
  } as unknown as PtyProcess & { end(): void };
}

function terminals(extra: Partial<ConstructorParameters<typeof AgentTerminals>[0]> = {}) {
  const store = new Store(initialState('room', 'auto'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-terms-'));
  const config = path.join(home, 'claude');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-wt-'));
  const ws = { id: 'w1', path: cwd, kind: 'worktree' } as Workspace;
  const ptys = new Map<string, ReturnType<typeof fakePty>>();
  const remembered: string[] = [];
  let launches = 0;
  const prompts: Array<string | undefined> = [];
  let sink: TerminalSink | undefined;
  let closed = 0;
  const terms = new AgentTerminals({
    store,
    find: (id) => (id === 'w1' ? ws : undefined),
    ensureLoaded: () => undefined,
    launch: async (_channel, s, prompt) => {
      launches++;
      prompts.push(prompt);
      sink = s;
      return { file: 'claude', args: [], env: {}, session: 'sess1', fresh: true, close: () => void closed++ } satisfies TerminalLaunch;
    },
    openProgram: (key) => {
      const p = fakePty();
      ptys.set(key, p);
      return p;
    },
    closeTerminal: (key) => ptys.delete(key),
    pty: (key) => ptys.get(key),
    agentOf: () => ({ runtime: 'claude', label: 'Claude' }),
    rememberSession: (id, s) => remembered.push(`${id}:${s}`),
    self: () => ({ id: 'me', name: 'Kayra' }),
    home,
    claudeConfigDir: config,
    pollMs: 0,
    ...extra,
  });
  const transcript = (): string => {
    const variant = cwd.startsWith('/var/') ? `/private${cwd}` : cwd;
    const dir = path.join(config, 'projects', encodeProjectDir(variant));
    mkdirSync(dir, { recursive: true });
    return path.join(dir, 'sess1.jsonl');
  };
  return { store, terms, ptys, remembered, prompts, launches: () => launches, sink: () => sink!, closed: () => closed, transcript, home };
}

describe('the agent’s terminal on a conversation', () => {
  it('drives the conversation while it’s open, and gives it back when it ends', async () => {
    const t = terminals();
    const key = await t.terms.open('w1');
    expect(key).toBe('w1:agent');
    expect(t.terms.driving('ws:w1')).toBe(true);
    expect(t.store.getState().agentTerms['w1']).toMatchObject({ runtime: 'claude', label: 'Claude' });
    // Opening again is the same terminal.
    expect(await t.terms.open('w1')).toBe(key);
    expect(t.launches()).toBe(1);
    t.ptys.get(key)!.end();
    expect(t.terms.driving('ws:w1')).toBe(false);
    expect(t.store.getState().agentTerms['w1']).toBeUndefined();
    expect(t.closed()).toBe(1);
  });

  it('brings what’s said in it to the chat, and makes a new conversation the workspace’s once something’s said', async () => {
    const t = terminals();
    await t.terms.open('w1');
    const n = t.sink().add(viewBlock(GRAPH, GRAPH_FENCE));
    expect(t.store.getState().termVisuals['w1']).toEqual([expect.objectContaining({ n, title: 'How login works' })]);
    t.terms.sync('w1');
    expect(t.remembered).toEqual([]);
    const file = t.transcript();
    const now = new Date().toISOString();
    appendFileSync(file, `${line({ type: 'user', timestamp: now, message: { role: 'user', content: 'map login' } })}\n${line({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: `Here: ${visualToken(n)}` }] } })}\n`);
    t.terms.sync('w1');
    expect(t.remembered).toEqual(['w1:sess1']);
    const log = t.store.getState().log.filter((l) => l.channel === 'ws:w1');
    expect(log.map((l) => l.type)).toEqual(['chat', 'agent']);
    expect((log[1] as { text: string }).text).toContain('```beluga-graph');
    // Read again: the same items, not twice.
    t.terms.sync('w1');
    expect(t.store.getState().log.filter((l) => l.channel === 'ws:w1')).toHaveLength(2);
    expect(t.terms.visual('w1', n)).toContain('How login works');
  });

  it('lets go of finished turns once they’re in the chat, and later turns keep their own ids (BLG-609)', async () => {
    const t = terminals();
    await t.terms.open('w1');
    t.terms.sync('w1');
    const file = t.transcript();
    const say = (you: string, claude: string): void => {
      const now = new Date().toISOString();
      appendFileSync(file, `${line({ type: 'user', timestamp: now, message: { role: 'user', content: you } })}\n${line({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: claude }] } })}\n`);
      t.terms.sync('w1');
    };
    say('one', 'first answer');
    say('two', 'second answer');
    say('three', 'third answer');
    const log = t.store.getState().log.filter((l) => l.channel === 'ws:w1');
    expect(log.map((l) => (l as { text: string }).text)).toEqual(['one', 'first answer', 'two', 'second answer', 'three', 'third answer']);
    expect(new Set(log.map((l) => l.id)).size).toBe(6);
    // Only the last turn is still read.
    const live = (t.terms as unknown as { live: Map<string, { tail: { lines: string[] } }> }).live.get('w1')!;
    expect(live.tail.lines).toHaveLength(2);
    // Read again: nothing twice, nothing changed.
    t.terms.sync('w1');
    expect(t.store.getState().log.filter((l) => l.channel === 'ws:w1').map((l) => l.id)).toEqual(log.map((l) => l.id));
  });

  it('opens on a message sent from the chat, which stays the chat’s own (BLG-553)', async () => {
    const t = terminals();
    expect(t.terms.canOpen('w1')).toBe(true);
    expect(t.terms.canOpen('nope')).toBe(false);
    await t.terms.open('w1', undefined, 'fix the login');
    expect(t.prompts).toEqual(['fix the login']);
    // One open already has its conversation going: a first prompt can't go to it.
    await expect(t.terms.open('w1', undefined, 'another')).rejects.toThrow(/open here already/);
    expect(t.launches()).toBe(1);
    const now = new Date().toISOString();
    appendFileSync(t.transcript(), `${line({ type: 'user', timestamp: now, message: { role: 'user', content: 'fix the login' } })}\n${line({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } })}\n${line({ type: 'user', timestamp: now, message: { role: 'user', content: 'thanks' } })}\n`);
    t.terms.sync('w1');
    const log = t.store.getState().log.filter((l) => l.channel === 'ws:w1');
    expect(log.map((l) => [l.type, (l as { text?: string }).text])).toEqual([['agent', 'On it.'], ['chat', 'thanks']]);
  });

  it('leaves out only the first copy of the message it was handed', () => {
    const items = [{ type: 'chat', text: 'hi' }, { type: 'agent', text: 'hi' }, { type: 'chat', text: ' hi ' }];
    expect(withoutHanded(items, 'hi')).toEqual(items.slice(1));
    expect(withoutHanded(items, undefined)).toBe(items);
    expect(withoutHanded(items, 'other')).toBe(items);
  });

  it('keeps its visuals for its links after a restart', async () => {
    const t = terminals();
    await t.terms.open('w1');
    const n = t.sink().add(viewBlock(TABLE, VIEW_FENCE));
    const again = new AgentTerminals({ store: t.store, find: () => undefined, ensureLoaded: () => undefined, launch: async () => { throw new Error('no'); }, openProgram: () => undefined, closeTerminal: () => undefined, pty: () => undefined, agentOf: () => ({ runtime: 'claude', label: 'Claude' }), rememberSession: () => undefined, self: () => ({ id: 'me', name: 'K' }), home: t.home, pollMs: 0 });
    expect(again.visual('w1', n)).toContain('Customers by revenue');
    expect(again.visual('w1', 999)).toBeUndefined();
  });

  it('Take over closes it, and its pty going some other way (archiving) ends it too', async () => {
    const t = terminals();
    await t.terms.open('w1');
    t.terms.takeOver('w1');
    expect(t.ptys.has('w1:agent')).toBe(false);
    expect(t.terms.driving('ws:w1')).toBe(false);
    await t.terms.open('w1');
    t.ptys.delete('w1:agent');
    t.terms.tick('w1');
    expect(t.terms.driving('ws:w1')).toBe(false);
  });

  it('can’t open on what isn’t a conversation, nor on a Codex one (it stays in the chat)', async () => {
    const t = terminals();
    await expect(t.terms.open('nope')).rejects.toThrow(/archived or gone/);
    const codex = new AgentTerminals({ store: t.store, find: () => ({ id: 'w1', path: '/w', kind: 'worktree' }) as Workspace, ensureLoaded: () => undefined, launch: async () => { throw new Error('never launched'); }, openProgram: () => undefined, closeTerminal: () => undefined, pty: () => undefined, agentOf: () => ({ runtime: 'codex', label: 'Codex' }), rememberSession: () => undefined, self: () => ({ id: 'me', name: 'K' }), home: t.home, pollMs: 0 });
    await expect(codex.open('w1')).rejects.toThrow(/stay in the chat/);
  });
});

describe('an unseen, quiet terminal rests (BLG-610)', () => {
  const ended = (claude: string): string => `${line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n${line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: claude, content: [{ type: 'text', text: 'done' }] } })}\n`;
  const setup = async (o: { shell?: boolean; stop?: string } = {}) => {
    let now = 1_000;
    const asked: Array<number | undefined> = [];
    const t = terminals({ now: () => now, restAfterMs: 60_000, shellUnder: async (pid) => (asked.push(pid), o.shell ?? false) });
    const key = await t.terms.open('w1');
    appendFileSync(t.transcript(), ended(o.stop ?? 'end_turn'));
    const pty = t.ptys.get(key)! as unknown as { watchers: number; lastOutputAt: number };
    pty.lastOutputAt = now;
    const later = async (ms: number): Promise<void> => {
      now += ms;
      t.terms.tick('w1');
      await new Promise((r) => setImmediate(r));
    };
    return { t, key, pty, later, asked };
  };

  it('lets go of its program once nobody has shown it and nothing happened for a while, its turns in the chat', async () => {
    const { t, key, later, asked } = await setup();
    await later(30_000);
    expect(t.terms.driving('ws:w1')).toBe(true);
    await later(31_000);
    expect(asked).toEqual([4242]);
    expect(t.terms.driving('ws:w1')).toBe(false);
    expect(t.ptys.has(key)).toBe(false);
    expect(t.closed()).toBe(1);
    expect(t.store.getState().log.filter((l) => l.channel === 'ws:w1').map((l) => l.type)).toEqual(['chat', 'agent']);
    // Shown again: it opens on the same conversation.
    await t.terms.open('w1');
    expect(t.launches()).toBe(2);
  });

  it('keeps one a screen shows, one with a shell under it, and one in the middle of a turn', async () => {
    const shown = await setup();
    shown.pty.watchers = 1;
    await shown.later(120_000);
    expect(shown.t.terms.driving('ws:w1')).toBe(true);
    expect(shown.asked).toEqual([]);

    const server = await setup({ shell: true });
    await server.later(120_000);
    expect(server.asked).toEqual([4242]);
    expect(server.t.terms.driving('ws:w1')).toBe(true);

    const working = await setup({ stop: 'tool_use' });
    await working.later(120_000);
    expect(working.asked).toEqual([]);
    expect(working.t.terms.driving('ws:w1')).toBe(true);
  });

  it('counts only shells right under the program, not what its MCP servers start', () => {
    const ps = ['  100     1 /Users/k/.beluga/claude-code/0.3/claude', '  101   100 /bin/zsh', '  102   100 npm exec @ratel-ai/mcp-server', '  103   102 sh', '  104   100 -zsh', '  105     7 /bin/bash'].join('\n');
    expect(shellChildren(ps, 100)).toBe(2);
    expect(shellChildren(ps, 102)).toBe(1);
    expect(shellChildren(ps, 999)).toBe(0);
  });
});

describe('while the terminal drives', () => {
  it('a message in the chat waits for you to take over, and the terminal won’t open over a running turn', async () => {
    const store = new Store(initialState('room', 'auto'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-drive-'));
    const runs: string[] = [];
    let driving = true;
    let release: (() => void) | undefined;
    const sent: Array<{ event?: string; text?: string }> = [];
    const agent: AgentBackend = {
      run: async (input) => {
        runs.push(input.prompt);
        await new Promise<void>((r) => (release = r));
        return 'ok';
      },
      terminal: async () => ({ file: 'x', args: [], env: {}, session: 's', fresh: false, close: () => undefined }),
    };
    const host = new AgentHost({
      store,
      selfId: () => 'me',
      send: (body) => (sent.push(body as never), true),
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
      terminalDriving: () => driving,
    });
    const ask = (id: string, prompt: string) => host.onAgentRequest('me', { kind: 'agent_request', requestId: id, prompt, viaAgent: false, channel: 'ws:w1', urgent: false, plan: false });
    await ask('r1', 'hello');
    await waitFor(() => sent.some((b) => b.event === 'error'));
    expect(runs).toEqual([]);
    expect(sent.find((b) => b.event === 'error')).toMatchObject({ text: TERMINAL_DRIVING });
    driving = false;
    await ask('r2', 'now');
    await waitFor(() => runs.length === 1);
    await expect(host.terminalLaunch('ws:w1', { add: () => 1 })).rejects.toThrow(/still on a turn/);
    release?.();
    await host.idle('ws:w1');
    await expect(host.terminalLaunch('ws:w1', { add: () => 1 })).resolves.toMatchObject({ file: 'x' });
    let given = '';
    agent.terminal = async (input) => ((given = input.prompt), { file: 'x', args: [], env: {}, session: 's', fresh: false, close: () => undefined });
    await host.terminalLaunch('ws:w1', { add: () => 1 }, 'first words');
    expect(given).toBe('first words');
  });
});

describe('the shared state', () => {
  it('upserts the terminal’s items in order, without touching others', () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'system', channel: 'ws:w1', text: 'before', level: 'info' });
    const item = { id: 'term-a-t-1', type: 'chat', channel: '', from: 'me', name: 'K', text: 'hi', ts: 1, byAgent: false } as const;
    store.dispatch({ type: 'log_upsert', channel: 'ws:w1', items: [item] });
    store.dispatch({ type: 'log_upsert', channel: 'ws:w1', items: [{ ...item, text: 'hi there' }] });
    const log = store.getState().log.filter((l) => l.channel === 'ws:w1');
    expect(log.map((l) => (l as { text: string }).text)).toEqual(['before', 'hi there']);
    store.dispatch({ type: 'agent_term', id: 'w1', state: { runtime: 'codex', label: 'Codex', since: 1 } });
    expect(store.getState().agentTerms).toEqual({ w1: { runtime: 'codex', label: 'Codex', since: 1 } });
    store.dispatch({ type: 'term_visuals', id: 'w1', visuals: [{ n: 1, kind: 'graph', title: 'A', meta: '' }] });
    store.dispatch({ type: 'term_visuals', id: 'w1', visuals: [{ n: 1, kind: 'graph', title: 'B', meta: '' }, { n: 2, kind: 'table', title: 'C', meta: '' }] });
    expect(store.getState().termVisuals['w1']!.map((v) => v.title)).toEqual(['B', 'C']);
    store.dispatch({ type: 'agent_term', id: 'w1' });
    expect(store.getState().agentTerms).toEqual({});
  });
});
