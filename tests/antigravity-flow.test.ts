import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import { agyComplete } from '../src/agent/runtime/antigravity/complete.js';
import { agyArgs, findAgy } from '../src/agent/runtime/antigravity/connection.js';
import { ANTIGRAVITY_CAPABILITIES, createAntigravityRuntime } from '../src/agent/runtime/antigravity/index.js';
import { agyFailure, agyModel, agyThought, modeValue, systemMeta } from '../src/agent/runtime/antigravity/run-parts.js';
import { createAgyBackend } from '../src/agent/runtime/antigravity/runner.js';
import { ScriptedAgy } from '../src/agent/runtime/antigravity/scripted.js';
import { agyAnswerPrompt, agyQuestion } from '../src/agent/runtime/antigravity/questions.js';
import { agyBrainDir, dropAgyFolder, dropAgySession } from '../src/agent/runtime/antigravity/sessions.js';
import { AGY_SIGN_IN, agyStatus, modelRows } from '../src/agent/runtime/antigravity/status.js';
import { agyCalls, agyInput, agyTool, belugaToolOf } from '../src/agent/runtime/antigravity/tools.js';
import { acpAgents } from '../src/agent/runtime/acp/agents.js';
import { runtimeFor, signInCommand } from '../src/agent/runtime/registry.js';
import type { AgentPlace, AgentRunInput, FollowUp, Steer } from '../src/agent/types.js';
import { agentForFriend } from '../src/core/gateway/serve.js';
import { agentMark, modelMark } from '../src/shared/agent-marks.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { CodexRpcError } from '../src/agent/runtime/codex/rpc.js';
import { fallbackFor, runtimeHas } from '../src/shared/runtime-fallbacks.js';
import type { StepRecord } from '../src/shared/steps.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';

/**
 * Antigravity as an agent: its runs through `agy acp`, against a scripted one speaking the shapes
 * the Antigravity CLI 1.5.8 sends. The scenarios every runtime shares are in runtime-conformance.test.ts.
 */

const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-'));

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[] } {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r), onFileTouched: () => undefined, canUseTool: async () => true, events, steps, ...extra };
}

const place = (extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } => {
  const sessions: string[] = [];
  return { cwd, additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), sessions, ...extra };
};

const backend = (agy: ScriptedAgy, dataDir?: string) => createAgyBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: agy.connect, ...(dataDir ? { dataDir } : {}) });

/** A path under `/w` as this system resolves it (`D:\w\a.ts` on Windows). */
const inW = (p: string): string => path.resolve('/w', p);

describe('Antigravity’s tools as Beluga’s', () => {
  it('knows each call by its own name, else its kind', () => {
    expect(agyTool({ name: 'run_command', kind: 'execute', title: 'ls -la' })).toBe('run_command');
    expect(agyTool({ name: 'mcp_beluga_board_task_get', kind: 'other', title: 'Run mcp_beluga_board_task_get' })).toBe('mcp_beluga_board_task_get');
    expect(agyTool({ kind: 'read', title: 'File a.ts' })).toBe('read');
  });

  it('names them the way Claude Code’s are, from the PascalCase inputs it sends', () => {
    expect(agyCalls('run_command', agyInput({ rawInput: { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000, toolSummary: 'List files' } }), '/w')).toEqual([{ name: 'Bash', input: { command: 'ls -la' } }]);
    expect(agyCalls('read_file', { Path: '/w/a.ts' }, '/w')).toEqual([{ name: 'Read', input: { file_path: inW('a.ts') } }]);
    expect(agyCalls('write_file', { Path: '/w/new.txt', Content: 'hi' }, '/w')).toEqual([{ name: 'Write', input: { file_path: inW('new.txt') } }]);
    expect(agyCalls('edit_file', { Path: '/w/a.ts', Target: 'a = 41', Replacement: 'a = 42' }, '/w')).toEqual([{ name: 'Edit', input: { file_path: inW('a.ts'), old_string: 'a = 41', new_string: 'a = 42' } }]);
    expect(agyCalls('grep_search', { Query: 'TODO', SearchPath: '/w/src' }, '/w')[0]).toEqual({ name: 'Grep', input: { pattern: 'TODO', path: inW('src') } });
    expect(agyCalls('read_url_content', { Url: 'https://x.dev' }, '/w')[0]).toEqual({ name: 'WebFetch', input: { url: 'https://x.dev' } });
    // A tool it names that Beluga doesn't know is read by its kind.
    expect(agyCalls('execute', { CommandLine: 'pwd' }, '/w')[0]!.name).toBe('Bash');
    // Where a call is, from its locations when its input doesn't say; its words for people dropped.
    expect(agyInput({ rawInput: { toolSummary: 'x' }, locations: [{ path: '/w/b.ts' }] })).toEqual({ Path: '/w/b.ts' });
  });

  it('tells Beluga’s own MCP tools by `mcp_<server>_<tool>`, the longest suite first', () => {
    expect(belugaToolOf('mcp_beluga_board_task_get', ['beluga', 'beluga_board'])).toBe('mcp__beluga_board__task_get');
    expect(belugaToolOf('mcp_beluga_list_peers', ['beluga', 'beluga_board'])).toBe('mcp__beluga__list_peers');
    expect(belugaToolOf('mcp_context7_resolve', ['beluga'])).toBeUndefined();
    expect(agyCalls('mcp_context7_resolve', {}, '/w', ['beluga'])[0]!.name).toBe('mcp__antigravity__mcp_context7_resolve');
  });

  it('takes a tool for Beluga’s only when it is one mounted for the run, whatever its server is called', () => {
    const ours = new Set(['mcp__beluga__list_peers', 'mcp__beluga_board__task_get']);
    expect(belugaToolOf('mcp_beluga_list_peers', ['beluga', 'beluga_board'], ours)).toBe('mcp__beluga__list_peers');
    expect(belugaToolOf('mcp_beluga_board_task_get', ['beluga', 'beluga_board'], ours)).toBe('mcp__beluga_board__task_get');
    // A server of your own named `beluga_helper`, or `beluga_board_x`: its tools only start like Beluga's.
    expect(belugaToolOf('mcp_beluga_helper_wipe', ['beluga', 'beluga_board'], ours)).toBeUndefined();
    expect(belugaToolOf('mcp_beluga_board_x_wipe', ['beluga', 'beluga_board'], ours)).toBeUndefined();
    expect(agyCalls('mcp_beluga_helper_wipe', {}, '/w', ['beluga'], ours)[0]!.name).toBe('mcp__antigravity__mcp_beluga_helper_wipe');
  });

  it('judges a move on both files: the one it takes and where it lands, as its ACP locations say', () => {
    const raw = agyInput({ rawInput: { toolSummary: 'Move it' }, locations: [{ path: inW('a.ts') }, { path: inW('../out/b.ts') }] });
    expect(agyCalls('move', raw, '/w')).toEqual([
      { name: 'Edit', input: { file_path: inW('a.ts') } },
      { name: 'Write', input: { file_path: inW('../out/b.ts') } },
    ]);
    // No landing place said: judged on no file, so it's turned down.
    expect(agyCalls('rename_file', { Path: 'a.ts' }, '/w')[1]).toEqual({ name: 'Write', input: { file_path: '' } });
  });
});

describe('the parts of a run', () => {
  it('passes its own models through, never Claude’s aliases', () => {
    expect(agyModel('claude-opus-4-6-thinking')).toBe('claude-opus-4-6-thinking');
    expect(agyModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(agyModel('opus')).toBeUndefined();
    expect(agyModel('sonnet[1m]')).toBeUndefined();
    expect(agyModel(undefined)).toBeUndefined();
  });

  it('says Beluga’s efforts as its thinking levels, and its modes by what they’re for', () => {
    expect(agyThought('max')).toBe('high');
    expect(agyThought('medium')).toBe('medium');
    expect(agyThought(undefined)).toBeUndefined();
    const options = [{ id: 'mode', currentValue: 'default', options: ['default', 'accept-edits', 'auto', 'plan'].map((value) => ({ value, name: value })) }];
    expect(modeValue(options, 'plan')).toBe('plan');
    expect(modeValue(options, 'default')).toBe('default');
    expect(systemMeta('Be brief.')).toEqual({ antigravity: { systemPrompt: { append: 'Be brief.' } } });
  });

  it('passes extra folders as --add-dir', () => {
    expect(agyArgs({ addDirs: ['/a', '/b'] })).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
    expect(agyArgs()).toEqual([]);
  });

  it('finds agy where its install script puts it, or where BELUGA_AGY_PATH says', () => {
    const home = path.posix.join('/', 'Users', 'kay');
    const at = path.posix.join(home, '.local/bin/agy');
    expect(findAgy({ PATH: '/usr/bin' }, 'darwin', (f) => f === at, home)).toBe(at);
    expect(findAgy({ BELUGA_AGY_PATH: '/opt/agy' }, 'darwin', (f) => f === '/opt/agy', home)).toBe('/opt/agy');
    expect(findAgy({ PATH: '/usr/bin' }, 'darwin', () => false, home)).toBeUndefined();
  });

  it('tells a used-up quota and a sign-in from other failures, as Antigravity’s', () => {
    const limit = agyFailure({ error: 'RESOURCE_EXHAUSTED: You have reached your Five Hour Limit' });
    expect(limit).toBeInstanceOf(RunFailedError);
    expect((limit as RunFailedError).failure).toMatchObject({ kind: 'usage_limit', runtime: 'antigravity' });
    expect((agyFailure({ error: 'Authentication required' }) as RunFailedError).failure).toMatchObject({ kind: 'signed_out', runtime: 'antigravity' });
  });

  it('tells a sign-in by ACP’s own code, and takes no deadline, context window or stderr line for a used-up quota', () => {
    const kind = (error: string, extra: Parameters<typeof agyFailure>[0] = {}): string => (agyFailure({ error, ...extra }) as RunFailedError).failure.kind;
    for (const words of ['RESOURCE_EXHAUSTED: quota exceeded', 'Weekly limit reached', 'You have reached your Five Hour Limit', '429 Too Many Requests', 'rate limit exceeded']) expect(kind(words)).toBe('usage_limit');
    for (const words of ['rpc error: code = DeadlineExceeded desc = context deadline exceeded', 'maximum context length exceeded']) expect(kind(words)).not.toBe('usage_limit');
    expect(kind('Antigravity didn’t start', { cause: new CodexRpcError('Sign in first', -32000) })).toBe('signed_out');
    expect(kind('ENOENT: keyring.json')).not.toBe('signed_out');
    // A line of its log that mentions a quota is no failure of your plan's.
    expect(kind('Antigravity exited before the turn ended', { stderr: ['debug: quota check ok'] })).not.toBe('usage_limit');
  });

  it('lists the session’s models, the current one with its thinking levels', () => {
    const rows = modelRows([
      { id: 'model', category: 'model', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }] },
      { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })) },
    ]);
    expect(rows).toEqual([
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: '', efforts: ['low', 'medium', 'high'] },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', description: '' },
    ]);
  });
});

describe('a run on Antigravity', () => {
  it('adds Beluga’s instructions to its system prompt, and sets its model, thinking level and mode as the session’s options', async () => {
    const agy = new ScriptedAgy();
    const p = place({ effort: 'low' });
    const answer = await backend(agy).run(input('hello', { place: p, model: 'gemini-3.8-flash' }));
    expect(answer).toBe('echo: hello');
    const sid = p.sessions[0]!;
    expect(agy.appended.get(sid)).toBeTruthy();
    const set = agy.sent('session/set_config_option').map((o) => [o.configId, o.value]);
    expect(set).toContainEqual(['thought_level', 'low']);
    // Already on its default model and mode: nothing set for them.
    expect(set.filter(([id]) => id === 'model' || id === 'mode')).toEqual([]);
  });

  it('switches to a model your plan has, and says so when it hasn’t that one', async () => {
    const agy = new ScriptedAgy();
    await backend(agy).run(input('hello', { place: place(), model: 'claude-sonnet-4-6' }));
    expect(agy.sent('session/set_config_option')).toContainEqual(expect.objectContaining({ configId: 'model', value: 'claude-sonnet-4-6' }));
    const missing = input('hello', { place: place(), model: 'claude-opus-9' });
    await backend(agy).run(missing);
    expect(missing.events.some(([k, t]) => k === 'progress' && /no claude-opus-9 on your plan/.test(t))).toBe(true);
  });

  it('judges each command it asks about, and goes on when one is declined', async () => {
    const agy = new ScriptedAgy();
    const canUseTool = vi.fn(async () => false);
    const r = input('ask first', { place: place(), canUseTool });
    expect(await backend(agy).run(r)).toBe('denied: ask first');
    expect(canUseTool).toHaveBeenCalledWith('Bash', expect.objectContaining({ command: 'echo ask first' }));
    expect(agy.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('judges a new file on its path, with edits asked about here', async () => {
    const agy = new ScriptedAgy();
    const file = path.join(cwd, 'out.txt');
    const canUseTool = vi.fn(async () => true);
    const r = input(`edit ${file}`, { place: place({ autoEdit: false }), canUseTool });
    expect(await backend(agy).run(r)).toBe(`edited: ${file}`);
    expect(canUseTool).toHaveBeenCalledWith('Write', expect.objectContaining({ file_path: file }));
    expect(r.steps.some((s) => s.kind === 'tool' && s.tool === 'Write')).toBe(true);
  });

  it('lets its own notes through without asking you (its plan, in its notes folder)', async () => {
    const agy = new ScriptedAgy();
    const data = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-data-'));
    const canUseTool = vi.fn(async () => false);
    const p = place({ autoEdit: false });
    // The first run names the conversation; the next writes a note into its folder.
    await backend(agy, data).run(input('hello', { place: p, canUseTool: async () => true }));
    const note = path.join(agyBrainDir(p.sessions[0]!, data), 'plan.md');
    const r = input(`edit ${note}`, { place: place({ autoEdit: false, resume: p.sessions[0]! }), canUseTool });
    expect(await backend(agy, data).run(r)).toBe(`edited: ${note}`);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('turns writes down while it plans, then does the work once you approve', async () => {
    const agy = new ScriptedAgy();
    const file = path.join(cwd, 'planned.txt');
    const askUser = vi.fn(async () => ({ kind: 'plan' as const, approve: true, feedback: '' }));
    const r = input(`edit ${file}`, { place: place(), plan: true, askUser });
    await backend(agy).run(r);
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan' }));
    const modes = agy.sent('session/set_config_option').filter((o) => o.configId === 'mode').map((o) => o.value);
    expect(modes).toEqual(['plan', 'default']);
    // While planning, its write was turned down.
    expect(agy.answers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('asks you its own ask_question as a card, and gives Antigravity your answer as its next turn', async () => {
    const agy = new ScriptedAgy();
    const askUser = vi.fn(async (q: Parameters<NonNullable<AgentRunInput['askUser']>>[0]) => ({ kind: 'answers' as const, answers: { [q.kind === 'question' ? q.questions[0]!.question : '']: 'Not now' } }));
    const r = input('question', { place: place(), askUser });
    const answer = await backend(agy).run(r);
    // The question and its options, as agy sent them in its call (its form never reached Beluga).
    expect(askUser).toHaveBeenCalledWith({ kind: 'question', questions: [{ question: 'Deploy to the server now?', header: '', options: ['Yes, over SSH', 'Done (I did it)', 'Not now'].map((label) => ({ label, description: '' })), multiSelect: false }] });
    expect(askUser).toHaveBeenCalledTimes(1);
    // Your pick went back as its next turn, and that turn's answer is the run's.
    expect(agy.sent('session/prompt').length).toBe(2);
    expect(answer).toBe('answered: Not now');
    // The question shows once, as the card: its answer with the question written out stays out of the chat.
    const said = r.events.filter(([k]) => k === 'text').map(([, t]) => t);
    expect(said).toEqual(['answered: Not now']);
  });

  it('drops a question its turn asked before Steer Now stopped it: the message’s own turn goes on', async () => {
    const agy = new ScriptedAgy();
    const askUser = vi.fn(async () => ({ kind: 'skip' as const }));
    let steer: Steer | undefined;
    const r = input('question wait', { place: place(), askUser, onSteer: (s) => void (s && (steer = s)) });
    const run = backend(agy).run(r);
    await waitFor(() => steer && !steer.status!().between && agy.sent('session/prompt').length === 1);
    const done: string[] = [];
    const followUp: FollowUp = { prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (a) => void done.push(a), onError: (e) => void done.push(`error: ${e}`) };
    expect(await steer!.interrupt!(followUp, 'Stopped for your message.')).toBe(true);
    expect(await run).toBe('Stopped for your message.');
    expect(done).toEqual(['echo: hello']);
    expect(askUser).not.toHaveBeenCalled();
  });

  it('asks a question in Chinese the same way: the card, then your answer as its next turn', async () => {
    const agy = new ScriptedAgy();
    const askUser = vi.fn(async (q: Parameters<NonNullable<AgentRunInput['askUser']>>[0]) => ({ kind: 'answers' as const, answers: { [q.kind === 'question' ? q.questions[0]!.question : '']: '暂不' } }));
    const r = input('question zh', { place: place(), askUser });
    expect(await backend(agy).run(r)).toBe('answered: 暂不');
    expect(askUser).toHaveBeenCalledWith({ kind: 'question', questions: [{ question: '现在部署到服务器吗？', header: '', options: ['是，通过 SSH', '已完成（我自己做了）', '暂不'].map((label) => ({ label, description: '' })), multiSelect: false }] });
    // Shown once, as the card.
    expect(r.events.filter(([k]) => k === 'text').map(([, t]) => t)).toEqual(['answered: 暂不']);
  });

  it('tells it you skipped its question, and leaves it as it was with nobody to ask', async () => {
    const agy = new ScriptedAgy();
    const askUser = vi.fn(async () => ({ kind: 'skip' as const }));
    expect(await backend(agy).run(input('question', { place: place(), askUser }))).toBe('skipped: going on');
    // A side call or a run with nobody to ask: its answer stays, the question in it.
    const alone = new ScriptedAgy();
    expect(await backend(alone).run(input('question', { place: place() }))).toContain('- [3] Not now');
    expect(alone.sent('session/prompt').length).toBe(1);
  });

  it('reads the question from the shapes ask_question may take', () => {
    expect(agyQuestion({ questions: [{ question: 'Which?', options: [{ label: 'A', description: 'the first' }, 'B', ''], multiSelect: true }] })).toEqual({ kind: 'question', questions: [{ question: 'Which?', header: '', options: [{ label: 'A', description: 'the first' }, { label: 'B', description: '' }], multiSelect: true }] });
    expect(agyQuestion({ question: 'Go on?' })?.questions[0]).toMatchObject({ question: 'Go on?', options: [] });
    expect(agyQuestion({ questions: [] })).toBeUndefined();
    expect(agyQuestion(undefined)).toBeUndefined();
    const asked = agyQuestion({ question: 'Go on?' })!;
    expect(agyAnswerPrompt(asked, { kind: 'answers', answers: { 'Go on?': 'yes' } })).toContain('- Go on?\n  → yes');
  });

  it('asks you about a tool of your own server whose name starts like Beluga’s', async () => {
    const agy = new ScriptedAgy();
    const canUseTool = vi.fn(async () => false);
    const r = input('own mcp_beluga_helper_wipe', { place: place(), canUseTool });
    expect(await backend(agy).run(r)).toBe('denied: own mcp_beluga_helper_wipe');
    expect(canUseTool).toHaveBeenCalledWith('mcp__antigravity__mcp_beluga_helper_wipe', expect.anything());
    expect(agy.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('judges where a moved file lands, one of its own notes too', async () => {
    const agy = new ScriptedAgy();
    const data = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-data-'));
    const canUseTool = vi.fn(async () => true);
    const p = place();
    await backend(agy, data).run(input('hello', { place: p }));
    const note = path.join(agyBrainDir(p.sessions[0]!, data), 'plan.md');
    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-out-')), 'hook.sh');
    // Out of the run's folders: turned down without asking, though it comes from its own notes.
    const r = input(`move ${note} ${outside}`, { place: place({ resume: p.sessions[0]! }), canUseTool });
    expect(await backend(agy, data).run(r)).toBe(`denied: move ${note} ${outside}`);
    expect(canUseTool).not.toHaveBeenCalled();
    // Inside its folder: the move runs.
    const inside = path.join(cwd, 'plan.md');
    expect(await backend(agy, data).run(input(`move ${note} ${inside}`, { place: place({ resume: p.sessions[0]! }), canUseTool }))).toBe(`done: move ${note} ${inside}`);
  });

  it('shows no plan to approve for a planning turn stopped by Steer Now: the message’s own turn brings the plan', async () => {
    const agy = new ScriptedAgy();
    const plans: string[] = [];
    const askUser = vi.fn(async (q: { kind: string; plan?: string }) => (plans.push(q.plan ?? ''), { kind: 'plan' as const, approve: true, feedback: '' }));
    let steer: Steer | undefined;
    const r = input('wait here', { place: place(), plan: true, askUser: askUser as unknown as AgentRunInput['askUser'], onSteer: (s) => void (s && (steer = s)) });
    const run = backend(agy).run(r);
    await waitFor(() => steer && !steer.status!().between && agy.sent('session/prompt').length === 1);
    const done: string[] = [];
    const followUp: FollowUp = { prompt: 'plan this', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (a) => void done.push(a), onError: (e) => void done.push(`error: ${e}`) };
    expect(await steer!.interrupt!(followUp, 'Stopped for your message.')).toBe(true);
    expect(await run).toBe('Stopped for your message.');
    // The stopped turn's note was never a plan; the message's answer was, and approving it did the work.
    expect(plans).toEqual(['echo: plan this']);
    expect(done).toEqual(['echo: The plan is approved. Do the work now.']);
    const modes = agy.sent('session/set_config_option').filter((o) => o.configId === 'mode').map((o) => o.value);
    expect(modes).toEqual(['plan', 'default']);
  });

  it('puts the session back on a mode that asks when it goes to one that doesn’t', async () => {
    const agy = new ScriptedAgy();
    const r = input('mode auto', { place: place() });
    // The scripted turn only ends once its mode is set again.
    expect(await backend(agy).run(r)).toBe('mode: default');
    expect(agy.sent('session/set_config_option').filter((o) => o.configId === 'mode').map((o) => o.value)).toEqual(['default']);
    const other = input('mode accept-edits', { place: place() });
    expect(await backend(new ScriptedAgy()).run(other)).toBe('mode: default');
  });

  it('goes on with the same conversation (session/load), its replay kept out of the chat', async () => {
    const agy = new ScriptedAgy();
    const first = place();
    await backend(agy).run(input('one', { place: first }));
    const again = place({ resume: first.sessions[0]! });
    const r = input('two', { place: again });
    expect(await backend(agy).run(r)).toBe('echo: two');
    expect(again.sessions).toEqual(first.sessions);
    expect(agy.sent('session/load')).toHaveLength(1);
    expect(r.events.filter(([k]) => k === 'text').map(([, t]) => t)).toEqual(['echo: two']);
  });

  it('runs Beluga’s own tools over http, judged where they run, not asked twice', async () => {
    const agy = new ScriptedAgy();
    const canUseTool = vi.fn(async () => true);
    const r = input('room', { place: place(), canUseTool });
    expect(await backend(agy).run(r)).toBe('room: kay');
    const servers = agy.sent('session/new')[0]!.mcpServers as Array<{ type: string; name: string }>;
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s) => s.type === 'http')).toBe(true);
    expect(r.steps.some((s) => s.kind === 'tool' && s.tool === 'mcp__beluga__list_peers')).toBe(true);
  });

  it('compacts with its own /compact, its summary kept out of the chat', async () => {
    const agy = new ScriptedAgy();
    const r = input('/compact', { place: place() });
    await backend(agy).run(r);
    expect(r.events.some(([k]) => k === 'compact')).toBe(true);
    expect(r.events.filter(([k]) => k === 'text')).toEqual([]);
  });

  it('says a used-up quota as a usage limit', async () => {
    const agy = new ScriptedAgy();
    const err = await backend(agy).run(input('quota', { place: place() })).catch((e: unknown) => e);
    expect((err as RunFailedError).failure).toMatchObject({ kind: 'usage_limit', runtime: 'antigravity' });
  });

  it('turns away friends’ tasks and guests, and hands a friend’s task to Claude, saying why', async () => {
    const agy = new ScriptedAgy();
    const guarded = guardedBackend(backend(agy), ANTIGRAVITY_CAPABILITIES);
    await expect(guarded.run(input('hello', { vetTool: () => undefined }))).rejects.toThrow(/friends/);
    await expect(guarded.run(input('hello', { guest: true }))).rejects.toThrow(/guests/);
    const antigravity = { runtime: 'antigravity', label: 'Antigravity' };
    const claude = { runtime: 'claude', label: 'Claude' };
    expect(agentForFriend({ agent: antigravity }, [antigravity, claude], () => true)).toEqual({ agent: claude, note: fallbackFor('antigravity', 'friends') });
  });
});

describe('around a run', () => {
  it('makes a side call with only the tools it was given, its small model fast, and drops its conversation', async () => {
    const agy = new ScriptedAgy();
    const drop = vi.fn(async () => true);
    const answer = await agyComplete({ prompt: 'ask hello', system: 'Name this worktree.', cwd, model: 'haiku', tools: ['Read'], vetTool: () => ({ allow: true, reason: '' }) }, { connect: agy.connect, drop });
    // Its command wasn't one of the call's tools: turned down.
    expect(answer).toBe('denied: ask hello');
    expect(agy.sent('session/set_config_option')).toContainEqual(expect.objectContaining({ configId: 'thought_level', value: 'low' }));
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('says it’s ready with your plan’s models, or that you need to sign in', async () => {
    const agy = new ScriptedAgy();
    const ready = await agyStatus({ connect: agy.connect });
    expect(ready.state).toBe('ready');
    expect(ready.models.map((m) => m.value)).toEqual(['gemini-3.8-flash', 'claude-sonnet-4-6']);
    const signedOut = await agyStatus({
      connect: async (o) => {
        const conn = await agy.connect(o);
        return { ...conn, rpc: Object.assign(Object.create(Object.getPrototypeOf(conn.rpc) as object), conn.rpc, { request: async () => Promise.reject(new Error('Authentication required')) }) };
      },
    });
    expect(signedOut).toEqual({ state: 'signed_out', fix: AGY_SIGN_IN, models: [] });
  });

  it('drops the session it opened to look only once Antigravity has stopped', async () => {
    const agy = new ScriptedAgy();
    const order: string[] = [];
    const status = await agyStatus({
      connect: async (o) => {
        const conn = await agy.connect(o);
        return { ...conn, proc: { ...conn.proc, kill: async () => (order.push('stopped'), conn.proc.kill()) } };
      },
      drop: async (id) => void order.push(`dropped ${id}`),
    });
    expect(status.state).toBe('ready');
    expect(order).toEqual(['stopped', `dropped ${[...agy.sessions.keys()][0]}`]);
  });

  it('forgets a deleted chat’s conversation: its file, annotations and notes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-home-'));
    const id = '6e15d96b-cb2c-48c8-adb0-e718b9ab1dde';
    for (const sub of ['conversations', 'annotations', path.join('brain', id)]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, 'conversations', `${id}.db`), 'x');
    for (const end of ['-wal', '-shm']) writeFileSync(path.join(dir, 'conversations', `${id}.db${end}`), 'x');
    writeFileSync(path.join(dir, 'annotations', `${id}.pbtxt`), 'x');
    writeFileSync(path.join(dir, 'conversations', 'other.db'), 'kept');
    expect(await dropAgySession(id, dir)).toBe(true);
    expect(existsSync(path.join(dir, 'conversations', `${id}.db`))).toBe(false);
    // Its SQLite journal and shared memory go with it, not left behind.
    for (const end of ['-wal', '-shm']) expect(existsSync(path.join(dir, 'conversations', `${id}.db${end}`))).toBe(false);
    expect(existsSync(agyBrainDir(id, dir))).toBe(false);
    expect(readFileSync(path.join(dir, 'conversations', 'other.db'), 'utf8')).toBe('kept');
    expect(await dropAgySession('../escape', dir)).toBe(false);
  });

  it('forgets every conversation that ran in a folder being deleted, as session/list says', async () => {
    const agy = new ScriptedAgy();
    const folder = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-ws-'));
    const p = place({ cwd: folder });
    await createAgyBackend({ cwd: folder, autoEdit: true, additionalDirectories: [], bridge: room, connect: agy.connect }).run(input('hello', { place: p }));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-home-'));
    mkdirSync(path.join(dir, 'conversations'), { recursive: true });
    writeFileSync(path.join(dir, 'conversations', `${p.sessions[0]}.db`), 'x');
    expect(await dropAgyFolder(folder, { connect: agy.connect, dir })).toBe(1);
  });

  it('reads every page of session/list for a folder being deleted', async () => {
    const agy = new ScriptedAgy({ listPage: 2 });
    const folder = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-ws-'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-agy-home-'));
    mkdirSync(path.join(dir, 'conversations'), { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = place({ cwd: folder });
      await createAgyBackend({ cwd: folder, autoEdit: true, additionalDirectories: [], bridge: room, connect: agy.connect }).run(input('hello', { place: p }));
      ids.push(p.sessions[0]!);
      writeFileSync(path.join(dir, 'conversations', `${p.sessions[0]}.db`), 'x');
    }
    expect(await dropAgyFolder(folder, { connect: agy.connect, dir })).toBe(5);
    expect(ids.some((id) => existsSync(path.join(dir, 'conversations', `${id}.db`)))).toBe(false);
  });

  it('is registered, signs in by starting agy, and wears its own mark', () => {
    // One of your ACP agents: registered once you added it (Settings › Agent › ACP agents).
    expect(runtimeFor('antigravity')).toBeUndefined();
    acpAgents.add('antigravity');
    expect(runtimeFor('antigravity')?.label).toBe('Antigravity');
    expect(createAntigravityRuntime().capabilities).toBe(ANTIGRAVITY_CAPABILITIES);
    expect(signInCommand('antigravity')?.at(-1)).toMatch(/agy$/);
    expect(agentMark({ runtime: 'antigravity' })).toBe('antigravity');
    expect(modelMark('gemini-3.8-flash', 'antigravity')).toBe('antigravity');
    expect(modelMark('claude-opus-4-6-thinking', 'antigravity')).toBe('anthropic');
    expect(modelMark('gpt-oss-120b-medium', 'antigravity')).toBe('openai');
    expect(runtimeHas('antigravity', 'btw')).toBe(false);
    expect(runtimeHas('antigravity', 'terminal')).toBe(false);
    expect(fallbackFor('antigravity', 'rewind')).toMatch(/starts a new conversation/);
  });
});
