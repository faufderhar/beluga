import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as outputFiles from '../src/core/claude-code/output-files.js';
import { bgLaunchOf, cleanTerminal, exitCodeOf, taskIdOf } from '../src/core/claude-code/tasks.js';
import { factsOf, parseLine } from '../src/core/claude-code/transcript.js';
import { ClaudeCodeWatcher } from '../src/core/claude-code/watch.js';
import { attachClaudeCode } from '../src/core/claude-code/launch.js';
import { Store, initialState } from '../src/core/store.js';
import type { Session } from '../src/core/session.js';
import { CLAUDE_CODE_HANDLERS } from '../src/ipc/claude-code-handlers.js';
import { parseArgs } from '../src/ipc/api.js';

describe('background commands in a transcript', () => {
  it('knows a background command or a watch when it starts one', () => {
    expect(bgLaunchOf('toolu_1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, 5)).toEqual({ toolUseId: 'toolu_1', kind: 'command', description: 'Start the dev server', command: 'npm run dev', ts: 5 });
    expect(bgLaunchOf('toolu_2', 'Monitor', { command: 'while true; do sleep 1; done', description: 'deploy of #204' }, 6)).toMatchObject({ kind: 'monitor', description: 'deploy of #204' });
    expect(bgLaunchOf('toolu_3', 'Bash', { command: 'ls' }, 7)).toBeUndefined();
    // No description: the command, in a few words; secrets never kept.
    expect(bgLaunchOf('toolu_4', 'Bash', { command: 'API_TOKEN=abc123secret npm start', run_in_background: true }, 8)?.description).not.toContain('abc123secret');
  });

  it('finds its task id and how it ended', () => {
    expect(taskIdOf({ backgroundTaskId: 'btvoinfhr' }, '')).toBe('btvoinfhr');
    expect(taskIdOf({ taskId: 'bh1jbcdir' }, '')).toBe('bh1jbcdir');
    expect(taskIdOf(undefined, 'Command running in background with ID: b7onl746l. Output is being written to: /x')).toBe('b7onl746l');
    expect(taskIdOf(undefined, 'ok')).toBeUndefined();
    expect(exitCodeOf('Background command "Start the dev stack" failed with exit code 2')).toBe(2);
    expect(exitCodeOf('Background command "x" completed (exit code 0)')).toBe(0);
    expect(exitCodeOf('Agent "x" finished')).toBeUndefined();
  });

  it('reads the result that says where its output goes', () => {
    const line = JSON.stringify({ type: 'user', timestamp: '2026-10-19T10:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: b7onl746l. Output is being written to: /private/tmp/claude-501/-w/s1/tasks/b7onl746l.output. You will be notified when it completes.' }] }, toolUseResult: { backgroundTaskId: 'b7onl746l' } });
    expect(factsOf(parseLine(line)!).results[0]).toMatchObject({ toolUseId: 'toolu_1', taskId: 'b7onl746l', outputFile: '/private/tmp/claude-501/-w/s1/tasks/b7onl746l.output' });
  });

  it('cleans terminal output for reading: colours, carriage-return redraws', () => {
    expect(cleanTerminal('\u001b[32m✓\u001b[39m ok\nloading 10%\rloading 50%\rloading 100%\nend')).toBe('✓ ok\nloading 100%\nend');
  });
});

describe('the watcher: background commands, followed live', () => {
  const SID = 'c40fea54-5cab-4cc2-9384-84792e63291d';
  let root: string;
  let cwd: string;
  let tasks: string;
  let session: string;
  let w: ClaudeCodeWatcher;
  let store: Store;
  const now = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString();
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const use = (id: string, name: string, input: object, at: number, extra: object = {}) => line({ type: 'assistant', timestamp: iso(at), sessionId: SID, cwd, ...extra, message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
  const started = (id: string, task: string, at: number, extra: object = {}) =>
    line({ type: 'user', timestamp: iso(at), sessionId: SID, cwd, ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: ${tasks}/${task}.output. You will be notified when it completes.` }] }, toolUseResult: { backgroundTaskId: task } });
  const notice = (task: string, id: string, status: string, summary: string, at: number) =>
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), sessionId: SID, content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>${tasks}/${task}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-bg-')));
    cwd = path.join(root, 'app');
    mkdirSync(cwd, { recursive: true });
    tasks = path.join(root, 'claude-501', cwd.replace(/[^a-zA-Z0-9]/g, '-'), SID, 'tasks');
    mkdirSync(tasks, { recursive: true });
    const home = path.join(root, 'claude');
    const folder = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(path.join(folder, SID, 'subagents'), { recursive: true });
    session = path.join(folder, `${SID}.jsonl`);
    writeFileSync(path.join(tasks, 'bdev.output'), '\u001b[36m> next dev\u001b[0m\n  ▲ Ready on http://localhost:3000\nexport API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345\n');
    writeFileSync(path.join(tasks, 'btest.output'), 'Tests  2 failed | 40 passed\n');
    writeFileSync(path.join(tasks, 'blog.output'), '');
    writeFileSync(path.join(root, 'dev.log'), 'listening on :8080\n');
    writeFileSync(
      session,
      line({ type: 'user', timestamp: iso(now - 9000), sessionId: SID, cwd, message: { content: 'Run it' } }) +
        use('t1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, now - 8000) +
        started('t1', 'bdev', now - 7900) +
        use('t2', 'Bash', { command: 'npm test', description: 'Run the full tests', run_in_background: true }, now - 7000) +
        started('t2', 'btest', now - 6900) +
        notice('btest', 't2', 'failed', 'Background command "Run the full tests" failed with exit code 1', now - 3000) +
        use('t3', 'Bash', { command: `make dev > ${root}/dev.log 2>&1`, description: 'Start the stack', run_in_background: true }, now - 2000) +
        started('t3', 'blog', now - 1900) +
        use('t4', 'Bash', { command: 'ls' }, now - 1000),
    );
    // A sub-agent's own background command.
    const agents = path.join(folder, SID, 'subagents');
    writeFileSync(path.join(agents, 'agent-a1.meta.json'), JSON.stringify({ description: 'Check the build', toolUseId: 'toolu_A' }));
    writeFileSync(path.join(tasks, 'bbuild.output'), 'building…\n');
    writeFileSync(path.join(agents, 'agent-a1.jsonl'), use('u1', 'Bash', { command: 'npm run build', description: 'Build it', run_in_background: true }, now - 1500, { agentId: 'a1' }) + started('u1', 'bbuild', now - 1400, { agentId: 'a1' }));
    store = new Store(initialState('room'));
    w = new ClaudeCodeWatcher({ home, store, watch: false, publishMs: 0 });
    await w.scan();
    w.poll();
    w.publish();
  });
  afterEach(() => {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const tasksOf = () => store.getState().claudeCode.sessions[0]!.tasks ?? [];

  it('lists them with who started them, running first, and how the others ended', () => {
    expect(tasksOf().map((t) => [t.id, t.description, t.status, t.agentId ?? 'lead', t.exitCode ?? null])).toEqual([
      ['bbuild', 'Build it', 'running', 'a1', null],
      ['blog', 'Start the stack', 'running', 'lead', null],
      ['bdev', 'Start the dev server', 'running', 'lead', null],
      ['btest', 'Run the full tests', 'failed', 'lead', 1],
    ]);
    expect(tasksOf()[3]).toMatchObject({ kind: 'command', command: 'npm test', endedAt: now - 3000 });
  });

  it('a quiet one whose session went quiet is no longer said to be running', async () => {
    const old = (now - 60 * 60_000) / 1000;
    for (const f of ['bdev', 'blog', 'bbuild']) utimesSync(path.join(tasks, `${f}.output`), old, old);
    const later = new ClaudeCodeWatcher({ home: path.join(root, 'claude'), store, watch: false, publishMs: 0, now: () => now + 20 * 60_000 });
    await later.scan();
    later.poll();
    later.publish();
    expect(tasksOf().find((t) => t.id === 'bdev')?.status).toBe('idle');
    later.stop();
  });

  // Not on Windows: Claude Code keeps background output elsewhere there (its own tasks/ layout).
  it.skipIf(process.platform === 'win32')('shows its output as it grows: cleaned, secrets out; a command writing to its own log shows that', () => {
    const out = w.taskOutput(SID, undefined, 'bdev');
    expect(out?.text).toContain('Ready on http://localhost:3000');
    expect(out?.text).not.toContain('\u001b[');
    expect(out?.text).not.toContain('sk-ant-api03');
    appendFileSync(path.join(tasks, 'bdev.output'), 'GET / 200\n');
    expect(w.taskOutput(SID, undefined, 'bdev')?.text).toContain('GET / 200');
    // Its own output is empty: what it sends to its log instead.
    expect(w.taskOutput(SID, undefined, 'blog')).toMatchObject({ text: 'listening on :8080\n', file: path.join(root, 'dev.log') });
    expect(w.taskOutput(SID, 'a1', 'bbuild')?.text).toBe('building…\n');
    // Nothing that isn't one of its tasks.
    expect(w.taskOutput(SID, undefined, 'bbuild')).toBeUndefined();
    expect(w.taskOutput(SID, undefined, 'nope')).toBeUndefined();
  });

  it("never shows a file a command only names: not outside the project or temp folders, not one older than the command", async () => {
    const home = path.join(root, 'claude');
    // The test home is itself temporary. Model a file outside every allowed root without
    // writing into the developer's home (or assuming the checkout isn't in a temp folder).
    const outside = path.join(path.parse(os.homedir()).root, 'beluga-private', 'not-a-task.log');
    const readTail = outputFiles.readTail;
    const reads = vi.spyOn(outputFiles, 'readTail').mockImplementation((file, bytes) =>
      file === outside ? { text: 'private\n', size: 8, mtime: now } : readTail(file, bytes));
    const stale = path.join(cwd, 'old.log');
    writeFileSync(stale, 'from before\n');
    const old = (now - 60 * 60_000) / 1000;
    utimesSync(stale, old, old);
    for (const id of ['bout', 'bstale']) writeFileSync(path.join(tasks, `${id}.output`), '');
    appendFileSync(session, use('t5', 'Bash', { command: `true > ${outside}`, description: 'Names a file', run_in_background: true }, now - 500) + started('t5', 'bout', now - 400) + use('t6', 'Bash', { command: `true > ${stale}`, description: 'Names an old log', run_in_background: true }, now - 300) + started('t6', 'bstale', now - 200));
    const fresh = new ClaudeCodeWatcher({ home, store, watch: false, publishMs: 0 });
    await fresh.scan();
    fresh.poll();
    try {
      expect(fresh.taskOutput(SID, undefined, 'bout')?.text).toBe('');
      expect(fresh.taskOutput(SID, undefined, 'bstale')?.text).toBe('');
      expect(reads.mock.calls.some(([file]) => file === outside)).toBe(false);
    } finally {
      fresh.stop();
      reads.mockRestore();
    }
  });

  it('one with no word on it while its session works on: running only while it writes or just started', async () => {
    const old = (now - 60 * 60_000) / 1000;
    utimesSync(path.join(tasks, 'bdev.output'), old, old);
    // Its session goes on writing, 10 minutes after the dev server started.
    appendFileSync(session, use('t9', 'Bash', { command: 'ls' }, now + 10 * 60_000));
    const later = new ClaudeCodeWatcher({ home: path.join(root, 'claude'), store, watch: false, publishMs: 0, now: () => now + 10 * 60_000 + 1000 });
    await later.scan();
    later.poll();
    later.publish();
    expect(tasksOf().find((t) => t.id === 'bdev')?.status).toBe('idle');
    later.stop();
  });

  it('goes through the API, arguments checked', () => {
    const s = {} as Session;
    attachClaudeCode(s, w);
    expect(CLAUDE_CODE_HANDLERS['claudeCode.taskOutput'](s, SID, undefined, 'btest')?.text).toContain('2 failed');
    expect(() => parseArgs('claudeCode.taskOutput', [SID, undefined, '../x'])).toThrow();
  });
});
