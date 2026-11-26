import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { type TestRun, releaseSlot, slotCount, trySlot, waitForSlot, waitingLine, workerCount } from '../scripts/test-lock.mjs';
import { worktreeOf } from '../scripts/e2e-lock.mjs';
import { niceForWorktree } from '../src/agent/runtime/claude/claude-process.js';
import { waitFor } from './helpers.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-tests-'));
const run = (over: Partial<TestRun> = {}): TestRun => ({ pid: process.pid, name: 'KLD-49', worktree: '/w/kld-49', startedAt: Date.now(), ...over });

/** A pid that's surely dead: a process that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

// Not on Windows: nice and ps.

describe.skipIf(process.platform === 'win32')('how many workers and runs', () => {
  it('gives each run half the cores (all of them on CI), at least 2, unless KLAUD_TEST_WORKERS says otherwise', () => {
    expect(workerCount({}, 14)).toBe(7);
    expect(workerCount({}, 2)).toBe(2);
    expect(workerCount({}, 1)).toBe(2);
    expect(workerCount({ KLAUD_TEST_WORKERS: '3' }, 14)).toBe(3);
    expect(workerCount({ KLAUD_TEST_WORKERS: 'lots' }, 14)).toBe(7);
    // CI's runner runs nothing else: every core.
    expect(workerCount({ CI: 'true' }, 4)).toBe(4);
    expect(workerCount({ CI: 'true' }, 1)).toBe(2);
    expect(workerCount({ CI: 'true', KLAUD_TEST_WORKERS: '3' }, 4)).toBe(3);
  });

  it('lets 2 runs go at once unless KLAUD_TEST_SLOTS says otherwise (0: no limit)', () => {
    expect(slotCount({})).toBe(2);
    expect(slotCount({ KLAUD_TEST_SLOTS: '4' })).toBe(4);
    expect(slotCount({ KLAUD_TEST_SLOTS: '0' })).toBe(0);
    expect(slotCount({ KLAUD_TEST_SLOTS: '-1' })).toBe(2);
  });
});

// Not on Windows: nice and ps.

describe.skipIf(process.platform === 'win32')('the slots', () => {
  it('lets N runs in and tells the next one who it waits for', () => {
    const dir = tmp();
    const parent = process.ppid;
    expect(trySlot(run({ name: 'KLD-1' }), { dir, slots: 2 }).ok).toBe(true);
    // Another live process (the one that started vitest) holds the second.
    expect(trySlot(run({ pid: parent, name: 'KLD-2' }), { dir, slots: 2 }).ok).toBe(true);
    const third = trySlot(run({ pid: 999_999_999, name: 'KLD-3' }), { dir, slots: 2 });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.holders.map((h) => h.name)).toEqual(['KLD-1', 'KLD-2']);
    expect(waitingLine(third.holders, 2)).toBe('waiting for a unit-test slot: KLD-1, KLD-2 are running (2 at a time; KLAUD_TEST_SLOTS changes it)');
  });

  it('gives a run its own slot again, and frees it only for its owner', () => {
    const dir = tmp();
    const got = trySlot(run(), { dir, slots: 1 });
    expect(got).toEqual({ ok: true, file: path.join(dir, 'slot-0.json') });
    expect(trySlot(run(), { dir, slots: 1 }).ok).toBe(true);
    if (!got.ok) return;
    releaseSlot(got.file, process.pid + 1);
    expect(existsSync(got.file)).toBe(true);
    releaseSlot(got.file);
    expect(existsSync(got.file)).toBe(false);
  });

  it('takes over a slot whose run died without giving it back', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(run({ pid: await deadPid(), name: 'KLD-9' })));
    const got = trySlot(run(), { dir, slots: 1 });
    expect(got.ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'slot-0.json'), 'utf8')).pid).toBe(process.pid);
  });

  it('waits for a slot to free up, saying who it waits for once', async () => {
    const dir = tmp();
    const other = trySlot(run({ pid: process.ppid, name: 'KLD-2' }), { dir, slots: 1 });
    expect(other.ok).toBe(true);
    const said: string[] = [];
    const waiting = waitForSlot(run(), { dir, slots: 1, pollMs: 20, log: (l) => said.push(l) });
    await new Promise((r) => setTimeout(r, 120));
    if (other.ok) releaseSlot(other.file, process.ppid);
    expect(await waiting).toBe(path.join(dir, 'slot-0.json'));
    expect(said).toEqual(['waiting for a unit-test slot: KLD-2 is running (1 at a time; KLAUD_TEST_SLOTS changes it)']);
  });

  it('gives up after a while', async () => {
    const dir = tmp();
    trySlot(run({ pid: process.ppid }), { dir, slots: 1 });
    expect(await waitForSlot(run(), { dir, slots: 1, pollMs: 10, maxMs: 30, log: () => {} })).toBeUndefined();
  });
});

// Not on Windows: nice and ps.

describe.skipIf(process.platform === 'win32')("vitest's global setup", () => {
  const saved = { dir: process.env.KLAUD_TEST_DIR, slot: process.env.KLAUD_TEST_SLOT, slots: process.env.KLAUD_TEST_SLOTS };
  afterEach(() => {
    for (const [key, value] of [['KLAUD_TEST_DIR', saved.dir], ['KLAUD_TEST_SLOT', saved.slot], ['KLAUD_TEST_SLOTS', saved.slots]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('holds a slot for the run and gives it back at the end', async () => {
    const dir = tmp();
    process.env.KLAUD_TEST_DIR = dir;
    delete process.env.KLAUD_TEST_SLOT;
    delete process.env.KLAUD_TEST_SLOTS;
    const teardown = await setup();
    const slot = JSON.parse(readFileSync(path.join(dir, 'slot-0.json'), 'utf8'));
    expect(slot.pid).toBe(process.pid);
    // Named after whichever worktree runs the suite (its task key, or its folder).
    expect(slot.worktree).toBe(worktreeOf(process.cwd()));
    expect(slot.name).toMatch(/\S/);
    expect(process.env.KLAUD_TEST_SLOT).toBe(path.join(dir, 'slot-0.json'));
    teardown?.();
    expect(existsSync(path.join(dir, 'slot-0.json'))).toBe(false);
  });

  it('takes no slot inside a run that has one, or with the limit off', async () => {
    const dir = tmp();
    process.env.KLAUD_TEST_DIR = dir;
    process.env.KLAUD_TEST_SLOT = '/somewhere/slot-0.json';
    expect(await setup()).toBeUndefined();
    delete process.env.KLAUD_TEST_SLOT;
    process.env.KLAUD_TEST_SLOTS = '0';
    expect(await setup()).toBeUndefined();
    expect(existsSync(path.join(dir, 'slot-0.json'))).toBe(false);
  });
});

// Not on Windows: nice and ps.

describe.skipIf(process.platform === 'win32')("a worktree's Claude Code runs at lower priority", () => {
  it('nices a run that carries KLAUD_WORKTREE, and what it starts inherits it', async () => {
    // What it starts (a process of its own, started after the nice) prints its pid and waits, and
    // its niceness is read from here. Read from inside, macOS CI's runners sometimes say -10 for a
    // process niced to 10 (ps did too), so a process reading its own priority can't be trusted.
    const own = `${JSON.stringify(process.execPath)} -e 'console.log(process.pid); setTimeout(() => {}, 5000)'`;
    const child = spawn('/bin/sh', ['-c', `sleep 0.3; ${own}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    expect(niceForWorktree(child.pid!, { KLAUD_WORKTREE: '/w/kld-49' })).toBe(true);
    expect(os.getPriority(child.pid!)).toBe(10);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await waitFor(() => out.includes('\n'), 10_000);
    const started = Number(out.trim());
    expect(started).not.toBe(child.pid);
    try {
      expect(os.getPriority(started)).toBe(10);
    } finally {
      process.kill(started);
      await new Promise((r) => child.on('exit', r));
    }
  });

  it('leaves your own runs (no worktree) alone', () => {
    expect(niceForWorktree(process.pid, {})).toBe(false);
    expect(niceForWorktree(process.pid, undefined)).toBe(false);
    expect(os.getPriority(process.pid)).toBe(os.getPriority());
  });
});
