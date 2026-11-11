import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { alive, stopGroups } from '../../../scripts/e2e-lock.mjs';

// The port is checked by the lock before playwright starts (its web server is up by the time a worker starts).
export { portProblem } from '../../../scripts/e2e-lock.mjs';

/** Marks a folder as an e2e demo home: only such a folder is ever wiped. */
export const MARK = '.klaud-e2e';

/** A command line, for saying who holds a port ("node …/vite --port 14321"). */
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 160);
  } catch {
    return '';
  }
}

const pidIn = (file: string): number | undefined => {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = raw.startsWith('{') ? (JSON.parse(raw) as { pid?: unknown }).pid : Number(raw);
    return typeof pid === 'number' && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A fresh demo home: a daemon an interrupted run left behind (daemon.json, daemon.lock) is stopped and
 * its files go, then the folder is emptied. Refuses a folder that isn't an e2e home (never your real data).
 * → what it cleaned, in words (for the log).
 */
export async function freshHome(home: string): Promise<string[]> {
  const cleaned: string[] = [];
  if (existsSync(home) && readdirSync(home).length && !existsSync(path.join(home, MARK))) {
    throw new Error(`Won't use ${home} as the demo home: it isn't an e2e home (no ${MARK}), so it may be real Beluga data`);
  }
  for (const name of ['daemon.json', 'daemon.lock']) {
    const pid = pidIn(path.join(home, name));
    // A pid can be reused: only stop it if it's still a Beluga daemon.
    if (pid && pid !== process.pid && alive(pid) && /daemon/.test(commandOf(pid))) {
      await stopGroups({ pids: [pid] }, { graceMs: 2000 });
      cleaned.push(`stopped the demo daemon pid ${pid} an earlier run left (${name})`);
    } else if (existsSync(path.join(home, name))) cleaned.push(`removed a stale ${name}`);
  }
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, MARK), 'A demo home for Beluga e2e runs: emptied at the start of each run.\n');
  return cleaned;
}

/** The last lines of a log, for an error message. */
const tail = (file: string, lines = 15): string => {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each variable as BELUGA_<name> and as the KLAUD_<name> it was before the rename. */
const both = (vars: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(vars).flatMap(([name, value]) => [[`BELUGA_${name}`, value], [`KLAUD_${name}`, value]]));

/** A running demo daemon: where the page finds it (what the dev server's /__beluga/endpoint would say). */
export interface Demo {
  readonly home: string;
  readonly claude: string;
  readonly endpoint: { readonly url: string; readonly token: string; readonly version: string };
  stop(): Promise<void>;
}

/**
 * Start Beluga's demo (simulated friends and Claudes) as a daemon in its own e2e home, with its own
 * pretend ~/.claude and fake gh, and wait until it's ready: bob and mia are in the room and zoe knocks.
 * Its temp folders (the demo's projects, chats, tasks) are in its home too, so they go with it.
 */
/** `linkMs`: a round trip added to the demo's computers' pages (BLG-792), so remote work runs at a real link's pace. */
export async function startDemo({ home, claude, port, linkMs = 0 }: { home: string; claude: string; port: number; linkMs?: number }): Promise<Demo> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  for (const line of await freshHome(home)) console.log(`[e2e] ${line}`);
  rmSync(claude, { recursive: true, force: true });
  mkdirSync(claude, { recursive: true });
  const tmp = path.join(home, 'tmp');
  mkdirSync(tmp);
  // The demo's friends (bob, mia) are on the Beluga network, which is off until you turn it on: on
  // here as a saved setting (never $BELUGA_NETWORK, which would keep it on), so a test can turn it off.
  writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({ network: true })}\n`);

  const log = path.join(home, 'e2e-daemon.log');
  const out = openSync(log, 'a');
  // Its temp folder is its own, but tsx's compile cache is shared (or each daemon compiles Beluga again).
  const cache = `tsx-${process.getuid?.() ?? 0}`;
  mkdirSync(path.join(os.tmpdir(), cache), { recursive: true });
  symlinkSync(path.join(os.tmpdir(), cache), path.join(tmp, cache));
  // node itself, not npx tsx (two processes fewer per daemon).
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'daemon', '--keep-alive', 'demo'], {
    cwd: repo,
    // GitHub is a stand-in (e2e/fake-gh.mjs): its PRs are whatever a test writes to fake-gh.json. So is
    // Tailscale (e2e/fake-tailscale.mjs), and each daemon's web port is a free one (never the real 7777).
    // Under both names: the core reads BELUGA_* first, so an inherited BELUGA_HOME (the run's) must not win.
    env: {
      ...process.env,
      TMPDIR: `${tmp}/`,
      ...both({ HOME: home, CLAUDE_HOME: claude, GH: path.join(import.meta.dirname, 'fake-gh.mjs'), TAILSCALE: path.join(import.meta.dirname, 'fake-tailscale.mjs'), WEB_PORT: '0', FAKE_GH: path.join(home, 'fake-gh.json'), DEMO_PACE: process.env.E2E_DEMO_PACE ?? '0.3', ALLOW_ORIGINS: `http://localhost:${port}`, NETWORK: '', DEMO_LINK_MS: String(linkMs), EXTERNAL_PORT: '0' }),
    },
    stdio: ['ignore', out, out],
  });
  const stop = () => stopDaemon(home, child.pid);
  let exited: string | undefined;
  child.on('exit', (code, sig) => (exited = sig ? `was killed (${sig})` : `exited with code ${code}`));
  const fail = async (what: string): Promise<never> => {
    await stop();
    const holder = pidIn(path.join(home, 'daemon.lock'));
    const why = [
      exited ? `it ${exited}` : what,
      holder && holder !== child.pid && alive(holder) ? `daemon.lock is held by pid ${holder} (${commandOf(holder)})` : '',
      tail(log) ? `its log (${log}):\n${tail(log)}` : '',
    ].filter(Boolean);
    throw new Error(`The demo daemon did not start: ${why.join('; ')}`);
  };

  // Slow on a busy Mac: up to a minute, but stop waiting as soon as it has died.
  const info = path.join(home, 'daemon.json');
  const deadline = Date.now() + 60_000;
  while (!existsSync(info) && !exited && Date.now() < deadline) await sleep(100);
  if (!existsSync(info)) return fail('it gave no sign of life in 60s (is the Mac overloaded? see `uptime`)');
  const { port: daemonPort, token, version } = JSON.parse(readFileSync(info, 'utf8')) as { port: number; token: string; version: string };
  const endpoint = { url: `ws://127.0.0.1:${daemonPort}`, token, version };

  // Ready when the pretend friends are in (the demo brings bob, mia, then zoe's knock, over ~6s).
  let client: SocketClient | undefined;
  try {
    client = await SocketClient.connect({ url: endpoint.url, token, kind: 'test', version: 'e2e', timeoutMs: Math.max(1000, deadline - Date.now()) });
    const store = client.store;
    const ready = () => {
      const s = store.getState();
      const names = s.peers.map((p) => p.name.toLowerCase());
      return names.includes('bob') && names.includes('mia') && s.knocks.length > 0;
    };
    while (!ready() && !exited && Date.now() < deadline) await sleep(100);
    if (!ready()) return fail(`its pretend friends didn't arrive in 60s (in the room: ${store.getState().peers.map((p) => p.name).join(', ') || 'nobody'})`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The demo daemon did not start')) throw err;
    return fail(`it didn't answer: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client?.close();
  }
  return { home, claude, endpoint, stop };
}

/** Stop the demo daemon of a home (and what started it). Safe to call twice. */
export async function stopDaemon(home: string, starter?: number): Promise<void> {
  const info = pidIn(path.join(home, 'daemon.json'));
  const pid = info && /daemon/.test(commandOf(info)) ? info : undefined;
  await stopGroups({ pids: [pid, starter].filter((p): p is number => typeof p === 'number' && alive(p)) }, { graceMs: 3000 });
  rmSync(path.join(home, 'daemon.json'), { force: true });
  rmSync(path.join(home, 'daemon.lock'), { force: true });
}
