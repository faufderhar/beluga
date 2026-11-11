import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Listener, type ProcFacts, belongsTo, nameOf, parseLsof, parseProcNetTcp, parseWindowsScan, portsOf, worktreePorts } from '../src/workspaces/ports.js';

/** A worktree's ports (BLG-801): its processes' listening sockets, on macOS, Linux and Windows, named by what they are. */

const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A tiny server like a dev server: listens on a free port and says which. */
function serve(cwd: string, env: NodeJS.ProcessEnv, host = '127.0.0.1'): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', `require('http').createServer().listen(0, '${host}', function () { process.stdout.write(String(this.address().port) + '\\n') })`], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  stops.push(() => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (d: Buffer) => resolve({ child, port: Number(String(d).trim()) }));
    child.once('error', reject);
  });
}

/** Ask again until it holds (the OS lists a socket a moment after listen, and drops it after exit). */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-ports-')));
  stops.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(`on this computer (${process.platform})`, () => {
  it('lists a server working in the worktree, and one carrying its tag from elsewhere, with port and command', async () => {
    const wt = tmp();
    const elsewhere = tmp();
    const a = await serve(wt, {});
    const b = await serve(elsewhere, { BELUGA_WORKTREE: wt });
    const other = await serve(elsewhere, {});
    let ports: Awaited<ReturnType<typeof worktreePorts>> = [];
    await until(async () => (ports = await worktreePorts(wt)).length >= 2);
    expect(ports.map((p) => p.port).sort()).toEqual([a.port, b.port].sort());
    expect(ports.find((p) => p.port === a.port)).toMatchObject({ pid: a.child.pid, name: 'node', host: '127.0.0.1' });
    expect(ports.some((p) => p.port === other.port)).toBe(false);
    // Stopped, it's gone.
    a.child.kill('SIGKILL');
    await until(async () => !(await worktreePorts(wt)).some((p) => p.port === a.port));
  }, 30_000);
});

describe('reading what the OS says', () => {
  it('lsof’s fields', () => {
    const out = ['p501', 'cnode', 'f20', 'n127.0.0.1:5173', 'f21', 'n[::1]:5173', 'p502', 'cruby', 'f9', 'n*:3000', 'f10', 'n*:3000', ''].join('\n');
    expect(parseLsof(out)).toEqual([
      { pid: 501, port: 5173, host: '127.0.0.1', comm: 'node' },
      { pid: 501, port: 5173, host: '::1', comm: 'node' },
      { pid: 502, port: 3000, host: '0.0.0.0', comm: 'ruby' },
    ]);
  });

  it('/proc/net/tcp and tcp6: listening sockets only, addresses read right', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0',
      '   2: 0100007F:9C40 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000000000000000 100 0 0 10 0',
    ].join('\n');
    expect(parseProcNetTcp(tcp)).toEqual([
      { inode: 41001, host: '127.0.0.1', port: 5173 },
      { inode: 41002, host: '0.0.0.0', port: 3000 },
    ]);
    const tcp6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0',
      '   1: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52002 1 0',
      '   2: 0000000000000000FFFF00000100007F:0BBA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52003 1 0',
    ].join('\n');
    expect(parseProcNetTcp(tcp6)).toEqual([
      { inode: 52001, host: '::1', port: 8080 },
      { inode: 52002, host: '::', port: 3001 },
      { inode: 52003, host: '127.0.0.1', port: 3002 },
    ]);
  });

  it('names dev servers by what they are', () => {
    expect(nameOf('node /w/node_modules/.bin/vite --port 5173', 'node')).toBe('vite');
    expect(nameOf('next-server (v15.0.0)', 'node')).toBe('next');
    expect(nameOf('node /w/node_modules/next/dist/bin/next dev', 'node')).toBe('next');
    expect(nameOf('ruby bin/rails server -p 3000', 'ruby')).toBe('rails');
    expect(nameOf('python manage.py runserver', 'python3')).toBe('django');
    expect(nameOf('/usr/bin/python3 -m uvicorn app:app', 'python3')).toBe('uvicorn');
    expect(nameOf('node server.js', 'node')).toBe('node');
    expect(nameOf('', '')).toBe('server');
  });

  it('whose a process is: its tag or its folder; one row a port', () => {
    const wt = '/w/shop';
    expect(belongsTo({ env: 'PATH=/bin\0BELUGA_WORKTREE=/w/shop\0', cmdline: '' }, wt)).toBe(true);
    expect(belongsTo({ env: ' node x PATH=/bin BELUGA_WORKTREE=/w/shop HOME=/h ', cmdline: '' }, wt)).toBe(true);
    expect(belongsTo({ env: 'BELUGA_WORKTREE=/w/shop-2\0', cmdline: '' }, wt)).toBe(false);
    expect(belongsTo({ env: '', cwd: '/w/shop/apps/web', cmdline: '' }, wt)).toBe(true);
    expect(belongsTo({ env: '', cwd: '/w/shopping', cmdline: '' }, wt)).toBe(false);
    const listeners: Listener[] = [
      { pid: 1, port: 5173, host: '::1', comm: 'node' },
      { pid: 1, port: 5173, host: '127.0.0.1', comm: 'node' },
      { pid: 2, port: 3000, host: '0.0.0.0', comm: 'node' },
      { pid: 3, port: 4000, host: '127.0.0.1', comm: 'node' },
    ];
    const facts = new Map<number, ProcFacts>([
      [1, { env: '', cwd: wt, cmdline: 'node node_modules/.bin/vite' }],
      [2, { env: 'BELUGA_WORKTREE=/w/shop\0', cmdline: 'next-server' }],
      [3, { env: '', cwd: '/elsewhere', cmdline: 'node x' }],
    ]);
    expect(portsOf(listeners, facts, wt)).toEqual([
      { port: 3000, pid: 2, name: 'next', host: '0.0.0.0' },
      { port: 5173, pid: 1, name: 'vite', host: '::1' },
    ]);
  });

  it('on Windows: PowerShell’s listeners, each process by its command line or a parent’s', () => {
    const scan = parseWindowsScan(
      '\uFEFF' +
        JSON.stringify({
          listeners: [
            { LocalAddress: '::1', LocalPort: 5173, OwningProcess: 30 },
            { LocalAddress: '127.0.0.1', LocalPort: 5173, OwningProcess: 30 },
            { LocalAddress: '0.0.0.0', LocalPort: 3000, OwningProcess: 40 },
            { LocalAddress: '0.0.0.0', LocalPort: 135, OwningProcess: 4 },
            { LocalAddress: '0.0.0.0', LocalPort: 0, OwningProcess: 0 },
          ],
          procs: [
            { ProcessId: 10, ParentProcessId: 1, Name: 'pwsh.exe', CommandLine: 'pwsh.exe' },
            { ProcessId: 20, ParentProcessId: 10, Name: 'cmd.exe', CommandLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "D:\\W\\Shop\\node_modules\\.bin\\vite.cmd"' },
            { ProcessId: 30, ParentProcessId: 20, Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "D:\\W\\Shop\\node_modules\\.bin\\..\\vite\\bin\\vite.js"' },
            { ProcessId: 40, ParentProcessId: 40, Name: 'node.exe', CommandLine: 'node D:\\w\\shopping\\server.js' },
            { ProcessId: 4, ParentProcessId: 0, Name: 'System', CommandLine: null },
          ],
        }),
    );
    expect(scan.listeners.map((l) => [l.pid, l.port, l.host])).toEqual([
      [30, 5173, '::1'],
      [30, 5173, '127.0.0.1'],
      [40, 3000, '0.0.0.0'],
      [4, 135, '0.0.0.0'],
    ]);
    // Its parents' command lines too (a terminal there runs npm, npm runs the shim, the shim runs node), nearest first.
    expect(scan.facts.get(30)?.lineage).toHaveLength(3);
    // Any case and either slash: Windows' paths are one folder however they're written.
    expect(portsOf(scan.listeners, scan.facts, 'd:/w/shop')).toEqual([{ port: 5173, pid: 30, name: 'vite', host: '::1' }]);
    expect(portsOf(scan.listeners, scan.facts, 'D:\\w\\shopping')).toEqual([{ port: 3000, pid: 40, name: 'node', host: '0.0.0.0' }]);
    // A list of one comes as the one itself; anything else is no ports, not an error.
    expect(parseWindowsScan(JSON.stringify({ listeners: { LocalAddress: '::', LocalPort: 8080, OwningProcess: 7 }, procs: { ProcessId: 7, Name: 'python.exe', CommandLine: 'python -m http.server' } })).listeners).toEqual([{ pid: 7, port: 8080, host: '::', comm: 'python.exe' }]);
    expect(parseWindowsScan('')).toEqual({ listeners: [], facts: new Map() });
    expect(belongsTo({ env: '', cmdline: '', lineage: ['node C:\\w\\shop-2\\x.js'] }, 'C:\\w\\shop')).toBe(false);
  });
});
