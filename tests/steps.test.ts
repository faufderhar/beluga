import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepRecorder } from '../src/agent/step-recorder.js';
import { transcriptToTurns, type TranscriptMessage } from '../src/agent/transcript.js';
import { createMockBackend } from '../src/agent/mock.js';
import { mockTool } from '../src/agent/mock-steps.js';
import type { RoomBridge } from '../src/agent/types.js';
import { AgentHost, type AgentHostDeps } from '../src/core/agent-host.js';
import { MAX_RUN_STEPS, StepBook, importedKey, runKey } from '../src/core/step-book.js';
import { Store, initialState } from '../src/core/store.js';
import { TranscriptTracker } from '../src/core/claude-code/sessions.js';
import { STEPS_HANDLERS } from '../src/ipc/steps-handlers.js';
import { parseArgs } from '../src/ipc/api.js';
import type { Session } from '../src/core/session.js';
import { parseAnsi, stripAnsi } from '../src/shared/ansi.js';
import { editDiff } from '../src/shared/line-diff.js';
import { humanizeLine, humanizeTool } from '../src/shared/step-titles.js';
import { INPUT_TOTAL_MAX, OUTPUT_HEAD, OUTPUT_TAIL, type StepRecord, boundInput, boundText, redactSecrets, thinkingTitle, toolFamily } from '../src/shared/steps.js';

describe('bounds and redaction', () => {
  it('keeps the start and end of a long output with a marker', () => {
    const long = `${'a'.repeat(OUTPUT_HEAD)}MIDDLE${'z'.repeat(OUTPUT_TAIL + 5000)}`;
    const b = boundText(long);
    expect(b.truncated).toBe(true);
    expect(b.text.startsWith('a'.repeat(100))).toBe(true);
    expect(b.text.endsWith('z'.repeat(100))).toBe(true);
    expect(b.text).toMatch(/… \d+(\.\d)? KB not shown …/);
    expect(b.text).not.toContain('MIDDLE');
    expect(b.text.length).toBeLessThan(OUTPUT_HEAD + OUTPUT_TAIL + 100);
    expect(boundText('short')).toEqual({ text: 'short', truncated: false });
  });

  it('redacts tokens, keys and secret assignments, and leaves ordinary text alone', () => {
    const text = [
      'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
      'curl -H "Authorization: Bearer abc.def.ghi" https://x',
      'GITHUB_TOKEN="ghp_0123456789abcdefghijABCDEFGHIJ" gh pr list',
      'aws AKIAABCDEFGHIJKLMNOP',
      '{"password": "hunter2", "user": "kay"}',
      'git log --author=bob --oneline',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).not.toMatch(/sk-ant-api03|abc\.def\.ghi|ghp_0123|AKIAABCD|hunter2/);
    expect(out).toContain('ANTHROPIC_API_KEY=[redacted]');
    expect(out).toContain('"user": "kay"');
    expect(out).toContain('git log --author=bob --oneline');
  });

  it('redacts RevenueCat secret keys bare, in a Bearer header and in an assignment, but not ordinary words', () => {
    const rc = ['sk', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('_');
    const out = redactSecrets([`key ${rc} here`, `curl -H "Authorization: Bearer ${rc}" https://api`, `REVENUECAT_API_KEY=${rc}`, 'rename task_name_value and risk_assessment_value_long'].join('\n'));
    expect(out).not.toContain(rc);
    expect(out).not.toContain('AbCdEfGh');
    expect(out).toContain('REVENUECAT_API_KEY=[redacted]');
    expect(out).toContain('task_name_value');
    expect(out).toContain('risk_assessment_value_long');
    // Bare, with nothing else on the line that would also trigger a header/assignment rule.
    expect(redactSecrets(`key ${rc} here`)).toBe('key [redacted] here');
  });

  it('bounds tool input: secret keys hidden, long strings cut, the whole kept small', () => {
    const b = boundInput({ command: 'npm test', api_key: 'xyz', content: 'x'.repeat(40_000), nested: { token: 't', ok: 1 } });
    expect(b.input.command).toBe('npm test');
    expect(b.input.api_key).toBe('[redacted]');
    expect((b.input.nested as Record<string, unknown>).token).toBe('[redacted]');
    expect((b.input.content as string).length).toBeLessThan(17_000);
    expect(b.truncated).toBe(true);
    const many = boundInput(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'y'.repeat(15_000)])));
    expect(JSON.stringify(many.input).length).toBeLessThanOrEqual(INPUT_TOTAL_MAX);
  });

  it('names tool families and thinking durations', () => {
    expect(['Bash', 'Read', 'MultiEdit', 'Glob', 'WebSearch', 'Task', 'mcp__beluga__send_chat', 'TodoWrite', 'Weird'].map(toolFamily)).toEqual(['bash', 'read', 'edit', 'search', 'web', 'agent', 'mcp', 'todo', 'other']);
    expect(thinkingTitle(12_400, false)).toBe('Thought for 12s');
    expect(thinkingTitle(300, false)).toBe('Thought briefly');
    expect(thinkingTitle(75_000, false)).toBe('Thought for 1m 15s');
    expect(thinkingTitle(5000, true)).toBe('Thinking (hidden by the agent)');
  });
});

describe('StepRecorder (SDK messages → step records)', () => {
  const setup = () => {
    let t = 1000;
    const out: StepRecord[] = [];
    const rec = new StepRecorder({ cwd: '/repo', emit: (r) => out.push(r), now: () => t });
    return { rec, out, tick: (ms: number) => (t += ms), latest: (id: string) => [...out].reverse().find((r) => r.id === id) };
  };

  it('records a tool call, then its result and how long it took', () => {
    const { rec, tick, latest } = setup();
    rec.begin();
    tick(500);
    rec.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } });
    expect(latest('tu1')).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash npm test', label: 'Ran npm test', doing: 'Running npm test', status: 'running', startedAt: 1500, input: { command: 'npm test' } });
    tick(250);
    rec.observe({ type: 'tool_progress', tool_use_id: 'tu1', elapsed_time_seconds: 0.25 });
    expect(latest('tu1')?.durationMs).toBe(250);
    tick(1000);
    rec.observe({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '24 passed' }] }] } });
    expect(latest('tu1')).toMatchObject({ status: 'done', output: '24 passed', durationMs: 1250, endedAt: 2750 });
  });

  it('marks failed tools, redacts their output and titles, and tags sub-agent steps', () => {
    const { rec, latest } = setup();
    rec.observe({ type: 'assistant', parent_tool_use_id: 'task1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'TOKEN=abc123 deploy' } }] } });
    rec.observe({ type: 'user', parent_tool_use_id: 'task1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'failed with key sk-ant-xyz12345678' }] } });
    const r = latest('tu2')!;
    expect(r).toMatchObject({ status: 'error', isError: true, parent: 'task1' });
    expect(r.title).toBe('Bash TOKEN=[redacted] deploy');
    expect((r.input as { command: string }).command).toBe('TOKEN=[redacted] deploy');
    expect(r.output).toBe('failed with key [redacted]');
  });

  it('records thinking with how long it took, and redacted thinking as hidden', () => {
    const { rec, tick, out } = setup();
    rec.begin();
    tick(12_000);
    rec.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'I should read the README first.' }] } });
    tick(3000);
    rec.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'redacted_thinking', data: 'xx' }] } });
    rec.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }] } });
    expect(out[0]).toMatchObject({ kind: 'thinking', title: 'Thought for 12s', text: 'I should read the README first.', durationMs: 12_000, status: 'done' });
    expect(out[1]).toMatchObject({ kind: 'thinking', hidden: true, title: 'Thinking (hidden by the agent)' });
    expect(out[1]?.text).toBeUndefined();
    expect(out[2]).toMatchObject({ hidden: true });
    expect(new Set(out.map((r) => r.id)).size).toBe(3);
  });

  it('bounds big outputs and closes steps still open when the run ends', () => {
    const { rec, latest } = setup();
    rec.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/repo/big.txt' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'sleep 100' } }] } });
    rec.observe({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(100_000) }] } });
    expect(latest('a')).toMatchObject({ truncated: true, title: 'Read big.txt' });
    expect(latest('a')!.output!.length).toBeLessThan(OUTPUT_HEAD + OUTPUT_TAIL + 100);
    rec.finish(true);
    expect(latest('b')).toMatchObject({ status: 'error', isError: true, output: 'Stopped before it finished' });
  });
});

describe('StepBook (the details beside the chat)', () => {
  const rec = (id: string, extra: Partial<StepRecord> = {}): StepRecord => ({ id, kind: 'tool', tool: 'Bash', title: `Bash ${id}`, status: 'done', startedAt: 1, input: { command: id }, output: `out ${id}`, ...extra });

  it('serves a light list, one step in full, and only changes after a version', () => {
    const book = new StepBook();
    book.put('k', rec('a', { status: 'running', output: undefined }));
    book.put('k', rec('b'));
    book.put('k', rec('a'));
    const page = book.page('k');
    expect(page.steps.map((s) => [s.id, s.status])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ]);
    expect(page.steps[0]).not.toHaveProperty('output');
    expect(page.steps[0]).not.toHaveProperty('input');
    expect(book.get('k', 'a')?.output).toBe('out a');
    expect(book.page('k', page.version)).toEqual({ steps: [], version: page.version, unchanged: true });
    expect(book.page('nope')).toMatchObject({ missing: true });
  });

  it('keeps at most MAX_RUN_STEPS per run', () => {
    const book = new StepBook();
    for (let i = 0; i < MAX_RUN_STEPS + 10; i++) book.put('k', rec(`s${i}`));
    const ids = book.page('k').steps.map((s) => s.id);
    expect(ids).toHaveLength(MAX_RUN_STEPS);
    expect(ids[0]).toBe('s10');
  });

  it('drops an app’s result (structuredContent and _meta) from the oldest steps when a run is too big, keeping where it is drawn from', () => {
    const book = new StepBook();
    const app = { server: 'ratel', tool: 'get_session', resourceUri: 'ui://ratel/replay', structuredContent: { ok: true }, resultMeta: { view: 'x'.repeat(200_000) } };
    for (let i = 0; i < 20; i++) book.put('k', rec(`s${i}`, { input: undefined, output: undefined, app }));
    expect(book.get('k', 's0')?.app).toEqual({ server: 'ratel', tool: 'get_session', resourceUri: 'ui://ratel/replay' });
    expect(book.get('k', 's19')?.app?.resultMeta).toEqual(app.resultMeta);
  });

  it('saves runs to disk and reads them back after a restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-steps-'));
    const book = new StepBook(dir);
    book.put('k', rec('a'));
    book.flush('k');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    const again = new StepBook(dir);
    expect(again.get('k', 'a')).toMatchObject({ output: 'out a' });
    expect(again.page('k').steps).toHaveLength(1);
    // A broken file is no details, not a crash.
    writeFileSync(path.join(dir, readdirSync(dir)[0]!), '{nope');
    expect(new StepBook(dir).page('k')).toMatchObject({ missing: true });
  });
});

describe('agent.steps / agent.step', () => {
  const setup = () => {
    const store = new Store(initialState('room'));
    const host = new AgentHost({ store, selfId: () => 'me' } as unknown as AgentHostDeps);
    const event = (owner: string, requestId: string, channel = 'ws:1') => store.dispatch({ type: 'agent_event', owner, requestId, requester: owner, event: 'started', text: '', ts: 1, channel });
    const itemOf = (requestId: string) => store.getState().log.find((l) => l.type === 'agent' && l.requestId === requestId)!;
    const session = { host } as unknown as Session;
    return { store, host, event, itemOf, session };
  };

  it("serves your own Claude's steps by chat item, never someone else's", () => {
    const { host, event, itemOf, session } = setup();
    event('me', 'r1');
    event('bob', 'r2');
    host.steps.put(runKey('r1'), { id: 'tu1', kind: 'tool', tool: 'Bash', title: 'Bash ls', status: 'done', startedAt: 1, output: 'a\nb' });
    host.steps.put(runKey('r2'), { id: 'tu9', kind: 'tool', tool: 'Bash', title: 'Bash cat secrets', status: 'done', startedAt: 1, output: 'x' });
    const mine = STEPS_HANDLERS['agent.steps'](session, 'ws:1', itemOf('r1').id, undefined);
    expect(mine.steps.map((x) => x.id)).toEqual(['tu1']);
    expect(STEPS_HANDLERS['agent.step'](session, 'ws:1', itemOf('r1').id, 'tu1')).toMatchObject({ output: 'a\nb' });
    expect(STEPS_HANDLERS['agent.steps'](session, 'ws:1', itemOf('r2').id, undefined)).toMatchObject({ missing: true, steps: [] });
    expect(STEPS_HANDLERS['agent.step'](session, 'ws:1', itemOf('r2').id, 'tu9')).toBeUndefined();
    // The wrong conversation finds nothing.
    expect(STEPS_HANDLERS['agent.steps'](session, 'room', itemOf('r1').id, undefined)).toMatchObject({ missing: true });
  });

  it('serves the steps of turns imported from a Claude Code transcript', () => {
    const { store, host, session } = setup();
    store.dispatch({
      type: 'history',
      channel: 'ws:2',
      items: [
        { id: 't-3', type: 'agent', channel: 'ws:2', subagents: [], requestId: 't-3', owner: 'me', ownerName: 'kay', requesterName: 'kay', status: 'done', text: 'ok', steps: ['Read a.ts'], ts: 1 },
        { id: 'import-sess1', type: 'system', channel: 'ws:2', text: 'Continuing', ts: 2, level: 'info' },
      ],
    });
    host.keepImported('sess1', { 't-3': [{ id: 'x', kind: 'tool', tool: 'Read', title: 'Read a.ts', status: 'done', startedAt: 1, output: '1\thello' }] });
    expect(host.steps.has(importedKey('sess1', 't-3'))).toBe(true);
    expect(STEPS_HANDLERS['agent.step'](session, 'ws:2', 't-3', 'x')).toMatchObject({ output: '1\thello' });
  });

  it('checks its arguments', () => {
    expect(parseArgs('agent.steps', ['ws:1', 'l1', 3])).toEqual(['ws:1', 'l1', 3]);
    expect(() => parseArgs('agent.steps', ['', 'l1'])).toThrow();
    expect(() => parseArgs('agent.step', ['ws:1', 'l1'])).toThrow();
  });
});

describe('transcripts → the same step records', () => {
  const msg = (type: TranscriptMessage['type'], content: unknown, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ type, message: { content }, parent_tool_use_id: null, ...extra });

  it('maps tool calls, their results and thinking for each imported turn', () => {
    const { items, steps } = transcriptToTurns(
      [
        msg('user', 'fix the login bug'),
        msg('assistant', [{ type: 'thinking', thinking: 'Check login.ts first.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/wt/src/login.ts' } }]),
        msg('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: '1\texport {}' }]),
        msg('assistant', [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }]),
        msg('user', [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'FAIL' }]),
        msg('assistant', [{ type: 'text', text: 'Fixed.' }]),
      ],
      { selfId: 'me', selfName: 'kay', cwd: '/wt', start: 0, end: 1000 },
    );
    const turn = items.find((i) => i.type === 'agent')!;
    expect(turn.type === 'agent' && turn.steps).toEqual(['Read src/login.ts', 'Bash npm test']);
    expect(steps[turn.id]).toMatchObject([
      { kind: 'thinking', text: 'Check login.ts first.', title: 'Thought' },
      { id: 'tu1', kind: 'tool', tool: 'Read', status: 'done', output: '1\texport {}', input: { file_path: '/wt/src/login.ts' } },
      { id: 'tu2', status: 'error', isError: true, output: 'FAIL' },
    ]);
  });

  it('gives live Claude Code transcripts thinking steps and tool details on demand', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-cc-'));
    const file = path.join(dir, 's.jsonl');
    const line = (o: unknown) => JSON.stringify(o);
    writeFileSync(
      file,
      [
        line({ type: 'user', timestamp: '2026-10-19T10:00:00.000Z', cwd: '/wt', message: { role: 'user', content: 'run the tests' } }),
        line({ type: 'assistant', timestamp: '2026-10-19T10:00:09.000Z', cwd: '/wt', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Run vitest.' }] } }),
        line({ type: 'assistant', timestamp: '2026-10-19T10:00:10.000Z', cwd: '/wt', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } }),
        line({ type: 'user', timestamp: '2026-10-19T10:00:14.000Z', cwd: '/wt', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '\u001b[32m24 passed\u001b[39m' }] } }),
      ].join('\n') + '\n',
    );
    const t = new TranscriptTracker(file);
    t.update();
    const page = t.page().steps;
    const thinking = page.find((s) => s.kind === 'thinking')!;
    const tool = page.find((s) => s.kind === 'tool')!;
    expect(thinking).toMatchObject({ text: 'Thought for 9s', durationMs: 9000, detail: true });
    expect(tool).toMatchObject({ status: 'done', durationMs: 4000, detail: true });
    expect(tool).not.toHaveProperty('details');
    expect(t.detail(thinking.seq)).toMatchObject({ kind: 'thinking', text: 'Run vitest.' });
    expect(t.detail(tool.seq)).toMatchObject({ kind: 'tool', tool: 'Bash', input: { command: 'npm test' }, output: '\u001b[32m24 passed\u001b[39m', durationMs: 4000 });
  });
});

describe('the demo Claude shows realistic steps', () => {
  it('emits tool inputs and outputs and a thinking step', async () => {
    const records: StepRecord[] = [];
    const bridge = { writeReport: async () => undefined } as unknown as RoomBridge;
    await createMockBackend(bridge, 0).run({ prompt: 'run the tests', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onStep: (r) => records.push(r), onFileTouched: () => undefined, canUseTool: async () => true });
    const last = new Map(records.map((r) => [r.id, r]));
    const bash = [...last.values()].find((r) => r.tool === 'Bash')!;
    expect(bash).toMatchObject({ title: 'Bash npm test', status: 'done', input: { command: 'npm test' } });
    expect(stripAnsi(bash.output!)).toContain('24 passed');
    expect([...last.values()].find((r) => r.kind === 'thinking')?.text).toContain('run the tests');
    expect(mockTool('Edit src/server.ts').input).toHaveProperty('old_string');
  });
});

describe('terminal colours and edit diffs', () => {
  it('parses colours and drops other escape codes', () => {
    const pieces = parseAnsi('\u001b[1m\u001b[32m✓\u001b[39m ok\u001b[0m plain\u001b[2K');
    expect(pieces.map((p) => p.text).join('')).toBe('✓ ok plain');
    expect(pieces[0]).toMatchObject({ text: '✓', style: { bold: true, fg: 2 } });
    expect(pieces.at(-1)?.style).toEqual({});
    expect(parseAnsi('\u001b[38;5;196mred\u001b[38;2;1;2;3mrgb')[1]?.style.fg).toBe('#010203');
    expect(stripAnsi('50%\r100%\n')).toBe('100%\n');
  });

  it('diffs an edit with context', () => {
    const rows = editDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nc\nd\ne\nF\ng\nh\ni\nj');
    expect(rows.filter((r) => r.kind === 'del').map((r) => r.text)).toEqual(['f']);
    expect(rows.filter((r) => r.kind === 'add').map((r) => [r.text, r.new])).toEqual([['F', 6]]);
    expect(rows[0]).toMatchObject({ kind: 'ctx', text: 'c' });
    expect(rows).toHaveLength(8); // 3 lines of context, the change, 3 lines of context
  });
});

describe('steps in words', () => {
  it('says built-in tools the way people would', () => {
    expect(humanizeTool('Read', { file_path: '/r/src/auth.ts' }, '/r')).toEqual({ done: 'Read src/auth.ts', doing: 'Reading src/auth.ts' });
    expect(humanizeTool('Bash', { command: 'npm test' }).done).toBe('Ran npm test');
    expect(humanizeTool('Grep', { pattern: 'requireUser' }).done).toBe('Searched for ‘requireUser’');
    expect(humanizeTool('Edit', { file_path: '/r/src/auth.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }, '/r').done).toBe('Edited src/auth.ts (+2 −1)');
    expect(humanizeTool('Write', { file_path: 'x.ts', content: 'a\nb\n' }).done).toBe('Wrote x.ts (+2)');
    expect(humanizeTool('Agent', { description: 'Review the diff' }).done).toBe('Started a sub-agent: Review the diff');
    expect(humanizeTool('mcp__context7__query-docs', {}).done).toBe('Used query docs from context7');
  });

  it("says Beluga's tools with who they involve, never a tool name or a task id", () => {
    expect(humanizeTool('mcp__beluga__who_can', {}).done).toBe('Looked for who can help');
    expect(humanizeTool('mcp__beluga__ask_person', { person: 'bob', ask: 'Run the tests\nand report' })).toEqual({ done: 'Asked bob’s agent: Run the tests', doing: 'Asking bob’s agent: Run the tests', person: 'bob' });
    expect(humanizeTool('mcp__beluga__wait_for', { task: 't_1' })).toMatchObject({ wait: true, task: 't_1' });
    expect(humanizeTool('mcp__beluga__run_on', { person: 'bob', command: 'npm test' }).done).toBe('Ran on bob’s Mac: npm test');
    expect(humanizeTool('mcp__beluga__get_file', { person: 'mia', path: '~/notes/plan.md' }).done).toBe('Got plan.md from mia’s Mac');
    for (const name of ['who_can', 'ask_person', 'wait_for', 'run_on', 'check', 'cancel', 'answer_question', 'get_file']) {
      const h = humanizeTool(`mcp__beluga__${name}`, { task: 't_lbTQ6LYNbZrq', person: 'bob' });
      expect(h.done).not.toMatch(/_|t_lb/);
    }
  });

  it('reads the one-line steps of older cards and other Claudes', () => {
    expect(humanizeLine('Bash npm test').done).toBe('Ran npm test');
    // Beluga's step before the agent starts (core/before-run.ts), as a friend's or the phone's one-line step.
    expect(humanizeLine('make_worktree pr-49')).toMatchObject({ done: 'Made the worktree pr-49', doing: 'Making the worktree pr-49' });
    expect(humanizeLine('Grep "TODO"').done).toBe('Searched for ‘TODO’');
    expect(humanizeLine('ask_person bob')).toMatchObject({ done: 'Asked bob’s agent', person: 'bob' });
    expect(humanizeLine('wait_for t_lbTQ6LYNbZrq')).toMatchObject({ doing: 'Waiting for an answer', task: 't_lbTQ6LYNbZrq', wait: true });
    expect(humanizeLine('24 passed').done).toBe('24 passed');
    expect(humanizeLine('Fixing the login bug').done).toBe('Fixing the login bug');
  });
});
