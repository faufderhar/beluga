import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blackboxPaths, readJournal } from '../src/core/blackbox/paths.js';
import { Recorder, SLOW_CALL_MS, type Snapshot, TEXT_MAX, blackbox } from '../src/core/blackbox/recorder.js';
import { makeReport } from '../src/core/blackbox/report.js';
import { KEEP_INCIDENTS, startBlackbox } from '../src/daemon/blackbox.js';
import { problemIssueUrl } from '../packages/mac/src/lib/report.js';
import { API } from '../src/ipc/api.js';
import { DIAGNOSTICS_HANDLERS } from '../src/ipc/diagnostics-handlers.js';
import type { Session } from '../src/core/session.js';
import { waitFor } from './helpers.js';

const lag = { p50: 1, p95: 2, max: 3 };
const memory = { rss: 100 * 1024 * 1024, heapUsed: 40 * 1024 * 1024 };

describe('the black box keeps the recent past in memory', () => {
  it('keeps only the newest entries, oldest first', () => {
    const r = new Recorder(3);
    for (const n of [1, 2, 3, 4, 5]) r.record('log', `line ${n}`);
    expect(r.entries().map((e) => e.text)).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('cuts a long text', () => {
    const r = new Recorder(2);
    r.record('error', 'x'.repeat(TEXT_MAX + 50));
    expect(r.entries()[0]?.text.length).toBe(TEXT_MAX + 1);
  });

  it('counts calls and actions, and only keeps the failed or slow calls as entries', () => {
    const r = new Recorder(10);
    r.call('session.submit', 5);
    r.call('session.submit', 8);
    r.call('git.push', SLOW_CALL_MS + 1);
    r.call('files.read', 3, 'No such file');
    for (let i = 0; i < 40; i++) r.action('log_append');
    expect(r.entries().map((e) => e.text)).toEqual([`git.push took ${SLOW_CALL_MS + 1} ms`, 'files.read failed after 3 ms: No such file']);
    r.period(lag, memory);
    const period = r.entries().at(-1);
    expect(period?.kind).toBe('period');
    expect(period?.text).toBe('calls: session.submit ×2, git.push ×1, files.read ×1; actions: log_append ×40');
    expect(period?.data).toMatchObject({ calls: 4, failed: 1, actions: 40, rssMb: 100, heapMb: 40, p95: 2 });
    r.period(lag, memory);
    expect(r.entries().at(-1)?.text).toBe('idle');
  });
});

describe('the black box on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'beluga-box-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sets the last run aside, saves on exit, and freezes one copy per burst of problems', () => {
    const paths = blackboxPaths(dir);
    writeFileSync(paths.current, '{"version":"9.9.8","pid":1,"startedAt":1}\n');
    const r = new Recorder(50);
    const box = startBlackbox({ version: '9.9.9', recorder: r, paths });
    expect(readJournal(paths.previous)?.version).toBe('9.9.8');
    box.incident('uncaught exception', 'Error: boom\n    at x.js:1');
    box.incident('uncaught exception', 'Error: boom again');
    const frozen = readdirSync(paths.incidents);
    expect(frozen).toHaveLength(1);
    const snap = JSON.parse(readFileSync(path.join(paths.incidents, frozen[0] ?? ''), 'utf8')) as Snapshot;
    expect(snap.reason).toBe('uncaught exception');
    expect(snap.entries.map((e) => e.kind)).toEqual(['start', 'incident']);
    box.saveNow('exit 1');
    const saved = readJournal(paths.current);
    expect(saved?.version).toBe('9.9.9');
    expect(saved?.entries.map((e) => e.kind)).toEqual(['start', 'incident', 'incident', 'stop']);
    expect(saved?.entries.at(-1)?.text).toBe('exit 1');
    box.stop();
  });

  it('appends only what is new each minute, and rewrites the journal once it grew too big', async () => {
    const paths = blackboxPaths(dir);
    const r = new Recorder(4);
    const box = startBlackbox({ version: '1', recorder: r, paths, everyMs: 20, journalMax: 600 });
    for (let i = 0; i < 3; i++) r.record('log', `line ${i}`);
    // Its next save, however late a busy machine runs it.
    await waitFor(() => readJournal(paths.current)?.entries.at(-1)?.text === 'line 2', 5_000).catch(() => undefined);
    expect(readJournal(paths.current)?.entries.map((e) => e.text)).toEqual(['Beluga 1 started (pid ' + process.pid + ', Node ' + process.version + ', ' + process.platform + ' ' + process.arch + ')', 'line 0', 'line 1', 'line 2']);
    for (let i = 3; i < 30; i++) r.record('log', `line ${i} ${'x'.repeat(40)}`);
    await new Promise((res) => setTimeout(res, 60));
    r.record('log', 'last');
    // Until its save after the burst has rewritten it (a slow disk takes longer than a few saves: BLG-728).
    await waitFor(() => readJournal(paths.current)?.entries.at(-1)?.text === 'last', 5_000).catch(() => undefined);
    box.stop();
    // Rewritten from the ring (4 entries), so the burst before it isn't all there twice.
    const after = readJournal(paths.current)?.entries.map((e) => e.text) ?? [];
    expect(after.length).toBeLessThanOrEqual(5);
    expect(after.at(-1)).toBe('last');
  });

  it('reads a journal a crash cut short', () => {
    const file = path.join(dir, 'cut.jsonl');
    writeFileSync(file, '{"version":"2","pid":7,"startedAt":5}\n{"t":9,"kind":"log","text":"ok"}\n{"t":10,"kind":"lo');
    expect(readJournal(file)).toEqual({ version: '2', pid: 7, startedAt: 5, savedAt: 9, entries: [{ t: 9, kind: 'log', text: 'ok' }] });
  });

  it('keeps the newest incidents only', () => {
    const paths = blackboxPaths(dir);
    mkdirSync(paths.incidents, { recursive: true });
    for (let i = 0; i < KEEP_INCIDENTS + 4; i++) writeFileSync(path.join(paths.incidents, `old-${i}.json`), '{}');
    startBlackbox({ version: '1', recorder: new Recorder(5), paths }).stop();
    expect(readdirSync(paths.incidents)).toHaveLength(KEEP_INCIDENTS);
  });
});

describe('a problem report', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'beluga-report-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('has the black box, incidents and the log, with secrets, the home folder and the environment left out', () => {
    const home = '/Users/someone';
    const paths = blackboxPaths(path.join(dir, 'logs'));
    mkdirSync(paths.incidents, { recursive: true });
    writeFileSync(path.join(paths.logs, 'daemon.log'), `2026-11-03T10:00:00Z listening\n2026-11-03T10:00:01Z cloned ${home}/Projects/app with ghp_abcdefghijklmnopqrstuvwxyz123456\n`);
    writeFileSync(
      path.join(paths.incidents, 'report.20261103.json'),
      JSON.stringify({ header: { event: 'Allocation failed - JavaScript heap out of memory', commandLine: ['node', `${home}/cli.js`], nodejsVersion: 'v24' }, javascriptStack: { message: 'oom' }, environmentVariables: { ANTHROPIC_API_KEY: 'sk-ant-very-secret-value' }, sharedObjects: ['/usr/lib/x'] }),
    );
    writeFileSync(path.join(paths.incidents, '1-exit.json'), JSON.stringify({ kind: 'exit', at: 1, status: 'signal: 9 (SIGKILL)' }));
    const r = new Recorder(10);
    r.record('error', `Error: password=hunter2 at ${home}/x.ts`);
    const made = makeReport({ version: '2.1.0', recorder: r, paths, home, now: Date.UTC(2026, 10, 3, 12) });
    const text = readFileSync(made.path, 'utf8');
    expect(made.path).toBe(path.join(paths.reports, 'beluga-report-2026-11-03-12-00-00.json'));
    expect(text).not.toContain(home);
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('sk-ant-very-secret-value');
    expect(text).not.toContain('commandLine');
    expect(text).not.toContain('sharedObjects');
    expect(text).toContain('~/Projects/app');
    expect(text).toContain('heap out of memory');
    expect(made.summary).toMatchObject({ version: '2.1.0', problems: 2 });
    expect(existsSync(made.path)).toBe(true);
  });

  it('says where quitting stuck when the app had to end itself (#426, src-tauri/src/quit.rs)', () => {
    const paths = blackboxPaths(path.join(dir, 'logs'));
    mkdirSync(paths.incidents, { recursive: true });
    const reason = 'Quitting Beluga stuck while stopping the engine (12 s): Beluga ended itself';
    writeFileSync(path.join(paths.incidents, '7-quit.json'), JSON.stringify({ kind: 'quit', at: 7, stage: 'stopping the engine', reason }));
    const made = makeReport({ version: '3.0.0', recorder: new Recorder(10), paths, home: '/Users/someone', now: Date.UTC(2026, 10, 10, 12) });
    expect(made.summary).toMatchObject({ problems: 1, lastProblem: reason });
  });

  it('opens an issue with the summary filled in', () => {
    const url = new URL(problemIssueUrl('https://github.com/kayraucklnc/beluga', { version: '2.1.0', os: 'Darwin 25.6.0 (arm64)', problems: 1, lastProblem: 'uncaught exception' }, 'beluga-report.json'));
    expect(url.pathname).toBe('/kayraucklnc/beluga/issues/new');
    expect(url.searchParams.get('title')).toBe('Problem: uncaught exception');
    expect(url.searchParams.get('body')).toContain('Beluga 2.1.0 on Darwin 25.6.0 (arm64)');
    expect(url.searchParams.get('body')).toContain('beluga-report.json');
  });
});

describe('the window notes a part of itself that did not load (#370)', () => {
  const args = API['diagnostics.windowProblem'].args;
  const note = DIAGNOSTICS_HANDLERS['diagnostics.windowProblem'];

  it('records which chunk stalled and how long it waited', () => {
    const before = blackbox.version;
    const [problem] = args.parse([{ kind: 'stalled', chunk: 'views/ProjectHome', ms: 20_000, message: 'no answer after 20 s' }]);
    note({} as Session, problem);
    expect(blackbox.since(before).map((e) => [e.kind, e.text])).toEqual([['error', 'window: chunk views/ProjectHome never finished loading after 20000 ms: no answer after 20 s']]);
  });

  it('takes only a short, known shape', () => {
    expect(args.safeParse([{ kind: 'stalled', chunk: 'x', ms: 1, message: 'y' }]).success).toBe(true);
    expect(args.safeParse([{ kind: 'crashed', chunk: 'x', ms: 1, message: 'y' }]).success).toBe(false);
    expect(args.safeParse([{ kind: 'failed', chunk: 'x'.repeat(201), ms: 1, message: 'y' }]).success).toBe(false);
    expect(args.safeParse([{ kind: 'failed', chunk: 'x', ms: 1, message: 'y', extra: 1 }]).success).toBe(false);
  });
});

describe('the window notes a part of itself that crashed while drawing (BLG-905)', () => {
  const args = API['diagnostics.windowCrash'].args;
  const note = DIAGNOSTICS_HANDLERS['diagnostics.windowCrash'];

  it('records which part, its error and its stack', () => {
    const before = blackbox.version;
    const [crash] = args.parse([{ part: 'notifications', message: 'boom', stack: 'Error: boom\nat Row' }]);
    note({} as Session, crash);
    expect(blackbox.since(before).map((e) => [e.kind, e.text])).toEqual([['error', 'window: notifications crashed: boom\nError: boom\nat Row']]);
  });

  it('takes only a short, known shape', () => {
    expect(args.safeParse([{ part: 'window', message: 'y' }]).success).toBe(true);
    expect(args.safeParse([{ part: '', message: 'y' }]).success).toBe(false);
    expect(args.safeParse([{ part: 'window', message: 'y', stack: 'z'.repeat(4001) }]).success).toBe(false);
    expect(args.safeParse([{ part: 'window', message: 'y', extra: 1 }]).success).toBe(false);
  });
});
