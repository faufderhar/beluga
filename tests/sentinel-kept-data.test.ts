import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportName, metricExport } from '../src/core/sentinel/data-export.js';
import { brief, setup } from './sentinel-fakes.js';

/** Kept data (BLG-392): what a sentinel keeps, to look at in Beluga and take out to a file. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const T = Date.UTC(2026, 9, 28, 9);

describe('a metric’s history as a file', () => {
  it('writes a number per run, a table’s rows run by run, a kept array’s points, an output’s text', () => {
    expect(metricExport('number', [{ at: T, runId: 'r1', value: 3 }, { at: T + 1000, runId: 'r2', value: 4.5 }], 'csv')).toBe('kept_at,run,value\r\n2026-10-28T09:00:00.000Z,r1,3\r\n2026-10-28T09:00:01.000Z,r2,4.5\r\n');
    // Every column any run kept; a value with a comma, a quote or a line break is quoted; a formula is defused.
    const rows = metricExport('rows', [{ at: T, runId: 'r1', columns: ['who'], rows: [{ who: 'lena' }] }, { at: T, runId: 'r2', columns: ['who', 'note'], rows: [{ who: 'bob, jr', note: '=HYPERLINK("x")' }] }], 'csv');
    expect(rows.split('\r\n')).toEqual(['kept_at,run,who,note', '2026-10-28T09:00:00.000Z,r1,lena,', '2026-10-28T09:00:00.000Z,r2,"bob, jr","\'=HYPERLINK(""x"")"', '']);
    expect(metricExport('series', [{ at: T, runId: 'r1', series: [{ x: 'Mon', y: 2 }] }], 'csv')).toContain('2026-10-28T09:00:00.000Z,r1,Mon,2');
    expect(metricExport('output', [{ at: T, runId: 'r1', output: { text: 'line one\nline two', format: 'text' } }], 'csv')).toContain('"line one\nline two"');
    // JSON: the lines as they are, times in ISO.
    expect(JSON.parse(metricExport('number', [{ at: T, runId: 'r1', value: 3 }], 'json'))).toEqual([{ at: '2026-10-28T09:00:00.000Z', runId: 'r1', value: 3 }]);
    expect(exportName('Stripe: revenue', 'Revenue/day', 'csv')).toBe('Stripe- revenue · Revenue-day.csv');
  });
});

describe('what a sentinel keeps', () => {
  function kept() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-kept-'));
    dirs.push(home);
    const s = setup({ home });
    const sn = s.sentinels.create(brief);
    // The run has to sit inside the document keep window (14 days). A fixed October date falls out of it.
    const recent = Date.now() - 60_000;
    const run = s.sentinels.addHistory(sn.id, { by: 'schedule', trigger: { kind: 'schedule', summary: 'On its schedule' }, state: 'done', startedAt: recent, endedAt: recent + 1000, headline: 'Kept it', steps: sn.steps.map((st) => ({ id: st.id, state: 'done' as const })), tasks: [] }, { outputs: ['token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and more'], report: '# Today\n\nAll good.' });
    s.sentinels.demoKeep(sn.id, run.id, [{ name: 'issues', label: 'Open issues', better: 'down', value: 9 }, { name: 'jobs', label: 'Jobs', better: 'none', columns: ['job', 'log'], columnTypes: [{ key: 'log', type: 'html', name: '{{job}}.html' }], rows: [{ job: 'deploy', log: '<p>done</p>' }] }]);
    return { ...s, sn, run, home };
  }

  it('lists each metric with how much it keeps, and each run’s files by what they are (never its trigger)', () => {
    const k = kept();
    const data = k.sentinels.dataList(k.sn.id);
    expect(data.metrics).toEqual([
      { name: 'issues', label: 'Open issues', kind: 'number', unit: 'count', lines: 1, first: expect.any(Number), last: expect.any(Number) },
      { name: 'jobs', label: 'Jobs', kind: 'rows', unit: 'count', lines: 1, first: expect.any(Number), last: expect.any(Number), rows: 1 },
    ]);
    expect(data.runs).toHaveLength(1);
    const files = data.runs[0]!.files;
    expect(files.map((f) => [f.name, f.label, f.kind])).toEqual(expect.arrayContaining([['report.md', 'Report', 'report'], ['step-1.txt', k.sn.steps[0]!.name, 'step'], ['files/deploy.html', 'deploy.html', 'document']]));
    expect(files.some((f) => f.name.includes('trigger'))).toBe(false);
    expect(data.keepsDays).toBe(14);
  });

  it('reads a run’s file for the viewer: a step’s output redacted, by its step’s name; a document as kept', () => {
    const k = kept();
    const step = k.sentinels.runFile(k.run.id, 'step-1.txt');
    expect(step).toMatchObject({ name: `${k.sn.steps[0]!.name}.txt`, mime: 'text/plain', runId: k.run.id });
    expect(step.text).not.toContain('sk-ant-api03');
    expect(k.sentinels.runFile(k.run.id, 'report.md')).toMatchObject({ name: 'Report.md', mime: 'text/markdown', text: '# Today\n\nAll good.' });
    expect(k.sentinels.runFile(k.run.id, 'files/deploy.html')).toMatchObject({ name: 'deploy.html', mime: 'text/html', text: '<p>done</p>' });
    // Nothing else of the run's folder can be named.
    expect(() => k.sentinels.runFile(k.run.id, 'trigger.json')).toThrow(/no longer kept/);
    expect(() => k.sentinels.runFile(k.run.id, '../sentinel.json')).toThrow(/no longer kept/);
  });

  it('takes it out to Downloads › Beluga: a history as CSV, a run’s files as a folder, a step’s output redacted', () => {
    const k = kept();
    const csv = k.sentinels.dataExport(k.sn.id, { metric: 'issues', format: 'csv' });
    expect(csv).toBe(path.join(k.home, 'Downloads', 'Beluga', 'Morning brief', 'Morning brief · Open issues.csv'));
    expect(readFileSync(csv, 'utf8')).toMatch(/^kept_at,run,value\r\n.+,9\r\n$/);
    // Again: a new name beside it, never over it.
    expect(path.basename(k.sentinels.dataExport(k.sn.id, { metric: 'issues', format: 'csv' }))).toBe('Morning brief · Open issues 2.csv');
    const folder = k.sentinels.dataExport(k.sn.id, { runId: k.run.id });
    expect(readdirSync(folder).sort()).toEqual([`1 ${k.sn.steps[0]!.name}.txt`, 'deploy.html', 'report.md'].sort());
    expect(readFileSync(path.join(folder, `1 ${k.sn.steps[0]!.name}.txt`), 'utf8')).not.toContain('sk-ant-api03');
    // Kept in memory (no folder on disk): Show in Finder says so.
    expect(() => k.sentinels.dataFolder(k.sn.id)).toThrow(/keeps no numbers on this Mac yet/);
  });
});
