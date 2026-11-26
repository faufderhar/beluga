import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownRunRoot, sweepRunRoots } from '../scripts/test-temp-root.mjs';

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'beluga-temp-root-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a run keeps its temp files in its own folder', () => {
  it('points the temp variables at a new folder, and puts them back and removes it when the run ends', () => {
    const env: Record<string, string | undefined> = { TMPDIR: '/old/tmp', TEMP: 'C:\\old' };
    const { root, remove } = ownRunRoot(base, env, 4242);
    expect(path.dirname(root)).toBe(base);
    expect(path.basename(root)).toMatch(/^beluga-run-4242-[A-Za-z0-9]{6}$/);
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([root, root, root]);

    // What a test forgot to remove goes with the run's folder.
    mkdirSync(path.join(root, 'beluga-test-abc', 'os-home'), { recursive: true });
    writeFileSync(path.join(root, 'beluga-test-abc', 'os-home', '.gitconfig'), '');
    remove();
    expect(existsSync(root)).toBe(false);
    expect(env).toEqual({ TMPDIR: '/old/tmp', TEMP: 'C:\\old' });
    remove(); // twice (teardown, then exit) is harmless
  });

  it('the next run removes the folders of runs that died, and leaves live runs and other folders alone', () => {
    for (const name of ['beluga-run-111-aaaaaa', 'beluga-run-222-bbbbbb', 'beluga-test-old123', 'beluga-run-x-cccccc']) {
      mkdirSync(path.join(base, name, 'inside'), { recursive: true });
    }
    expect(sweepRunRoots(base, (pid: number) => pid === 222)).toEqual(['beluga-run-111-aaaaaa']);
    expect(readdirSync(base).sort()).toEqual(['beluga-run-222-bbbbbb', 'beluga-run-x-cccccc', 'beluga-test-old123']);
  });

  it('a missing temp folder sweeps nothing', () => {
    expect(sweepRunRoots(path.join(base, 'gone'))).toEqual([]);
  });

  it('this run is in one now', () => {
    expect(path.basename(os.tmpdir())).toMatch(/^beluga-run-\d+-/);
  });
});
