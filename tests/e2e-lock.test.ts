import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type E2eRun,
  alive,
  groupsUnder,
  homesFor,
  listeners,
  portFor,
  processesOf,
  processesTagged,
  stopRun,
  readLock,
  releaseLock,
  rerunArgs,
  runName,
  slotHomes,
  stopGroups,
  tryLock,
  waitForLock,
  waitingLine,
  workerCount,
  busyShare,
  cpuSeconds,
  pidsUnder,
  usageLine,
  usageMeter,
} from '../scripts/e2e-lock.mjs';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-lock-'));
const run = (over: Partial<E2eRun> = {}): E2eRun => ({ id: 'r1', pid: process.pid, name: 'KLD-39', worktree: '/w/kld-39', startedAt: Date.now(), groups: [], ...over });

/** A pid that's surely dead: a process that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      c.kill('SIGKILL');
    }
  }
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('names, ports and homes', () => {
  it('names a run after its task branch, else its worktree', () => {
    expect(runName('/w/kld-12-smarter-pr', 'klaud/kld-12-smarter-pr-polling')).toBe('KLD-12');
    expect(runName('/w/some-fix', 'main')).toBe('some-fix');
  });

  it('gives each worktree its own stable port and demo home', () => {
    expect(portFor('/w/a')).toBe(portFor('/w/a'));
    expect(portFor('/w/a')).not.toBe(portFor('/w/b'));
    expect(portFor('/w/a')).toBeGreaterThanOrEqual(14300);
    expect(portFor('/w/a')).toBeLessThan(17300);
    expect(homesFor('/w/a').home).not.toBe(homesFor('/w/b').home);
    expect(homesFor('/w/a').home.startsWith(os.tmpdir())).toBe(true);
  });

  it("gives each worker two homes of its own, next to the run's", () => {
    const homes = homesFor('/w/a');
    const all = [0, 1, 2].flatMap((w) => [slotHomes(homes, w, 0), slotHomes(homes, w, 1)]);
    expect(new Set(all.map((h) => h.home)).size).toBe(6);
    expect(new Set(all.map((h) => h.claude)).size).toBe(6);
    for (const h of all) expect(path.dirname(h.home)).toBe(path.dirname(homes.home));
    expect(slotHomes(homes, 2, 1)).toEqual({ home: `${homes.home}-2b`, claude: `${homes.claude}-2b` });
  });

  it('runs 3 workers, fewer on a small Mac or as the idle CPU runs out, unless E2E_WORKERS says', () => {
    expect(workerCount({}, 14, 0.3)).toBe(3);
    expect(workerCount({}, 4, 0.1)).toBe(2);
    expect(workerCount({}, 2, 0)).toBe(1);
    // A busy Mac steps down a worker at a time, not straight to 1.
    expect(workerCount({}, 14, 0.7)).toBe(2);
    expect(workerCount({}, 14, 0.9)).toBe(1);
    expect(workerCount({}, 14, 1.2)).toBe(1);
    expect(workerCount({ E2E_WORKERS: '4' }, 14, 1)).toBe(4);
    expect(workerCount({ E2E_WORKERS: 'lots' }, 14, 0.3)).toBe(3);
  });

  it('measures how busy the CPU is', async () => {
    const busy = await busyShare(50);
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(busy).toBeLessThanOrEqual(1);
  });
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('what a run costs', () => {
  it("reads ps's CPU time", () => {
    expect(cpuSeconds('0:01.50')).toBe(1.5);
    expect(cpuSeconds('2:03.00')).toBe(123);
    expect(cpuSeconds('1:00:00')).toBe(3600);
    expect(cpuSeconds('1-00:00:01')).toBe(86401);
  });

  it('finds the processes under a run, whatever their group', () => {
    const table = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }];
    expect([...pidsUnder(10, table)].sort()).toEqual([10, 11, 12]);
  });

  it('peaks: the cores used between two samples, and the memory at one', () => {
    const meter = usageMeter();
    meter.sample(new Set([1, 2]), [{ pid: 1, cpu: 10, bytes: 100 }, { pid: 2, cpu: 5, bytes: 50 }, { pid: 3, cpu: 99, bytes: 999 }], 0);
    expect(meter.peak).toEqual({ cores: 0, bytes: 150, busiest: [] });
    // 2 s later: pid 1 used 2 s, pid 2 ended, pid 4 is new and used 1 s: 1.5 cores.
    meter.sample(new Set([1, 4]), [{ pid: 1, cpu: 12, bytes: 100 }, { pid: 4, cpu: 1, bytes: 20 }], 2000);
    expect(meter.peak.cores).toBe(1.5);
    expect(meter.peak.bytes).toBe(150);
    expect(meter.peak.busiest).toEqual(['1 1.0', '4 0.5']);
    expect(usageLine(meter.peak, 150_000, 14)).toBe('e2e took 2.5 min; at most 1.5 of 14 cores and 0.00 GB of memory (busiest then: 1 1.0, 4 0.5)');
  });
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('the machine-wide lock', () => {
  it('lets one run in and says who holds it to the next', () => {
    const file = path.join(tmp(), 'lock.json');
    expect(tryLock(run(), { file })).toEqual({ ok: true });
    // Another live process (our parent) asks.
    const second = tryLock(run({ pid: process.ppid, name: 'KLD-20' }), { file });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(waitingLine(second.holder)).toMatch(/^waiting for KLD-39's e2e/);
    releaseLock(process.pid, file);
    expect(readLock(file)).toBeUndefined();
  });

  it("takes over a dead run's lock after cleaning up what it left", async () => {
    const file = path.join(tmp(), 'lock.json');
    const dead = await deadPid();
    writeFileSync(file, JSON.stringify(run({ pid: dead, name: 'KLD-3', groups: [12345] })));
    const stale: E2eRun[] = [];
    expect(tryLock(run(), { file, onStale: (old) => stale.push(old) })).toEqual({ ok: true });
    expect(stale.map((s) => s.name)).toEqual(['KLD-3']);
    expect(readLock(file)?.pid).toBe(process.pid);
  });

  it("waits, saying whose e2e it waits for, and goes once it's free", async () => {
    const file = path.join(tmp(), 'lock.json');
    writeFileSync(file, JSON.stringify(run({ pid: process.ppid, name: 'KLD-12' })));
    const said: string[] = [];
    const waiting = waitForLock(run(), { file, log: (l) => said.push(l), pollMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(said[0]).toMatch(/^waiting for KLD-12's e2e/);
    expect(said).toHaveLength(1);
    // The first run ends (its owner releases the lock).
    writeFileSync(file, JSON.stringify(run({ pid: await deadPid(), name: 'KLD-12' })));
    await expect(waiting).resolves.toBe(true);
    expect(readLock(file)?.name).toBe('KLD-39');
  });

  it('gives up after its limit', async () => {
    const file = path.join(tmp(), 'lock.json');
    writeFileSync(file, JSON.stringify(run({ pid: process.ppid })));
    await expect(waitForLock(run({ name: 'KLD-1' }), { file, log: () => undefined, pollMs: 10, maxMs: 30 })).resolves.toBe(false);
  });
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('teardown: nothing a run started survives it', () => {
  it('finds the groups under a process, even children that started their own', () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 12, ppid: 11, pgid: 12 }, // vite, in its own group
      { pid: 13, ppid: 12, pgid: 12 },
      { pid: 20, ppid: 1, pgid: 20 }, // someone else's
    ];
    expect([...groupsUnder(10, table)].sort()).toEqual([10, 12]);
  });

  it('stops a whole process group, children included', async () => {
    const leader = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`], { detached: true, stdio: 'ignore' });
    children.push(leader);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(leader.pid!)).toBe(true);
    await stopGroups({ groups: [leader.pid!] }, { graceMs: 1000 });
    await new Promise((r) => setTimeout(r, 100));
    let groupLeft = true;
    try {
      process.kill(-leader.pid!, 0);
    } catch {
      groupLeft = false;
    }
    expect(groupLeft).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('finds processes by the run id in their environment', async () => {
    const id = `t-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, KLAUD_E2E_RUN: id }, stdio: 'ignore', detached: true });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    expect(processesTagged('KLAUD_E2E_RUN', id).map((p) => p.pid)).toContain(child.pid);
    expect(processesTagged('KLAUD_E2E_RUN', `${id}x`)).toEqual([]);
  });
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('a stale lock’s cleanup only stops what it can verify is its own', () => {
  const rows = [
    { pid: 501, pgid: 501, line: 'node /w/kld-39/node_modules/.bin/vite --port 14321 PWD=/w/kld-39/packages/mac KLAUD_E2E_RUN=r1' },
    { pid: 502, pgid: 502, line: '/Users/me/Library/Caches/ms-playwright/chromium/chrome-headless-shell PWD=/w/kld-39/packages/mac KLAUD_E2E_RUN=r1' },
    // The same tag under another worktree, a longer tag, and a pid reused by something else.
    { pid: 503, pgid: 503, line: 'node /w/kld-39-other/x.js KLAUD_E2E_RUN=r1' },
    { pid: 504, pgid: 504, line: 'node /w/kld-39/x.js KLAUD_E2E_RUN=r10' },
    { pid: 505, pgid: 505, line: '/usr/sbin/sshd -D' },
  ];
  it('tagged with its run id and under its worktree: nothing else', () => {
    expect(processesOf(run({ id: 'r1', worktree: '/w/kld-39' }), rows).map((p) => p.pid)).toEqual([501, 502]);
    expect(processesOf(run({ id: 'r1', worktree: undefined }), rows)).toEqual([]);
  });

  it('a reused pid, its old group and whoever listens on its port now all survive', async () => {
    // Someone else's server, in its own group, listening on the dead run's port.
    const server = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n')); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(server);
    const port = await new Promise<number>((resolve) => server.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    // And a process of the dead run, tagged and under its worktree: that one goes.
    const worktree = tmp();
    const id = `stale-${Date.now()}`;
    const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, env: { ...process.env, KLAUD_E2E_RUN: id, PWD: worktree }, detached: true, stdio: 'ignore' });
    children.push(left);
    await new Promise((r) => setTimeout(r, 300));
    // The lock says: pid now reused by the server, its group, its port.
    const stale = run({ id, pid: server.pid!, worktree, port, groups: [server.pid!] });
    await stopRun(stale, { graceMs: 500 });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(server.pid!)).toBe(true);
    expect(listeners(port)).toContain(server.pid);
    if (process.platform === 'darwin') expect(alive(left.pid!)).toBe(false);
  });
});

// Not on Windows: the Mac app’s e2e tooling (ps, process groups).

describe.skipIf(process.platform === 'win32')('failures under load', () => {
  it('re-runs only the failed playwright tests', () => {
    expect(rerunArgs(['playwright', 'test', 'e2e/plans.spec.ts'])).toEqual(['playwright', 'test', 'e2e/plans.spec.ts', '--last-failed']);
    expect(rerunArgs(['playwright', 'test', '--last-failed'])).toEqual(['playwright', 'test', '--last-failed']);
    expect(rerunArgs(['vitest', 'run'])).toBeUndefined();
  });
});
