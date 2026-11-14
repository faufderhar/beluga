import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { Machines } from '../src/machines/machines.js';
import { INSTALL_LINE, listSshHosts, sshHosts } from '../src/machines/ssh-pair.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * Add a computer over SSH (BLG-781), with a fake `ssh` standing in for the computer's shell: it
 * says Beluga is missing until the install line runs, starts it on `beluga up`, and for
 * `beluga pair --computer --json` prints what the real command prints, from a real computer's
 * pairing on a local DHT. The app joins it, and the pictures printed over SSH are checked.
 */

const WINDOWS = process.platform === 'win32';

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/**
 * The fake ssh. State lives in `dir`: `installed`, `running`; the pairing's lines are `pair.json`,
 * then `waiting.json` and `end.json` once the test writes them (as the real command prints them).
 */
function fakeSsh(dir: string, opts: { installed: boolean }): { bin: string; calls: () => string[][]; say: (file: string, value: unknown) => void } {
  const log = path.join(dir, 'calls.log');
  if (opts.installed) writeFileSync(path.join(dir, 'installed'), '1');
  const bin = path.join(dir, 'ssh');
  const at = (f: string): string => JSON.stringify(path.join(dir, f));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const last = args[args.length - 1];
const installed = fs.existsSync(${at('installed')});
if (last.includes('install.sh')) { fs.writeFileSync(${at('installed')}, '1'); process.stdout.write('Beluga is installed.\\n'); process.exit(0); }
if (!installed) { process.stderr.write('sh: 1: exec: beluga: not found\\n'); process.exit(127); }
if (last.includes('beluga version')) { process.stdout.write('Beluga 0.9.0\\n'); process.exit(0); }
if (last.endsWith(" up'")) { fs.writeFileSync(${at('running')}, '1'); process.stdout.write('Beluga is running.\\n'); process.exit(0); }
if (last.includes('pair --computer --json')) {
  if (!fs.existsSync(${at('running')})) { process.stderr.write('Beluga isn’t running here.\\n'); process.exit(1); }
  fs.writeFileSync(${at('pid')}, String(process.pid));
  process.stdout.write(fs.readFileSync(${at('pair.json')}, 'utf8') + '\\n');
  const told = new Set();
  setInterval(() => {
    // Its test is done and its folder gone: nothing will end it, so it ends itself (never left behind).
    if (!fs.existsSync(${JSON.stringify(dir)})) process.exit(0);
    for (const f of ['waiting.json', 'end.json']) {
      const file = require('path').join(${JSON.stringify(dir)}, f);
      if (!told.has(f) && fs.existsSync(file)) { told.add(f); process.stdout.write(fs.readFileSync(file, 'utf8') + '\\n'); if (f === 'end.json') process.exit(0); }
    }
  }, 30);
  process.on('SIGTERM', () => process.exit(0));
} else process.exit(255);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    // Said late (after the test is done and its folder gone), it's nobody's business.
    say: (file, value) => {
      try {
        writeFileSync(path.join(dir, file), JSON.stringify(value));
      } catch {
        // the folder is gone with its test
      }
    },
  };
}

async function install(name: string, ssh?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-ssh-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  let host!: CompanionHost;
  const machines = new Machines({
    dir,
    identity,
    devices,
    node: () => host.dhtNode(),
    address: () => host.address(),
    relayUrl: () => host.relayUrl(),
    relay: { add: (r) => host.reach.server.add(r), remove: (k) => host.reach.server.remove(k) },
    name: () => name,
    version: '0.9.0',
    platform: 'linux',
    removePhone: (id) => void host.removeDevice(id),
    onChange: () => host.machinesChanged(),
    pollMs: 60_000,
    // Only a computer that never prints its pictures waits this out; a slow CI runner can take seconds to.
    sshFingerprintMs: 30_000,
    ...(ssh ? { ssh } : {}),
  });
  host = new CompanionHost({ identity, store, devices, call: async () => ({ ok: true, value: undefined }), macName: () => name, version: '0.9.0', thumbsDir: path.join(dir, 'thumbs'), uploadsDir: path.join(dir, 'uploads'), dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' }, coalesceMs: 50, machines });
  cleanup.push(async () => {
    await machines.stop();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  machines.start();
  return { dir, host, machines };
}

type Install = Awaited<ReturnType<typeof install>>;

/** What the real `beluga pair --computer --json` on the computer prints, as its pairing goes. */
async function playComputer(mini: Install, ssh: ReturnType<typeof fakeSsh>, fingerprint?: string): Promise<void> {
  const info = await mini.machines.pairStart();
  ssh.say('pair.json', { link: info.link, code: info.code, expiresAt: info.expiresAt });
  void (async () => {
    const waiting = await waitFor(() => mini.machines.pairStatus().open?.waiting, 30_000).catch(() => undefined);
    if (waiting) ssh.say('waiting.json', { waiting: waiting.name, fingerprint: fingerprint ?? waiting.fingerprint });
    const last = await waitFor(() => mini.machines.pairStatus().last, 60_000).catch(() => undefined);
    if (last) ssh.say('end.json', { end: last.kind });
  })();
}

describe('the hosts to pick from', () => {
  it('are the Host names of the ssh config, without patterns', () => {
    const config = ['Host mini', '  HostName 192.168.1.20', '  User kayra', 'Host aws-box gpu', 'Host *.internal !bad', 'host lower', 'Host *', '  ForwardAgent no', 'Match host mini'].join('\n');
    expect(sshHosts(config)).toEqual(['mini', 'aws-box', 'gpu', 'lower']);
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-home-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    expect(listSshHosts(home)).toEqual([]);
    mkdirSync(path.join(home, '.ssh'));
    writeFileSync(path.join(home, '.ssh', 'config'), config);
    expect(listSshHosts(home)).toEqual(['mini', 'aws-box', 'gpu', 'lower']);
  });
});

describe.skipIf(WINDOWS)('adding a computer over SSH', () => {
  it('installs Beluga where it’s missing, starts it, pairs, checks the pictures over SSH, and the computer is yours', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'beluga-fake-ssh-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const ssh = fakeSsh(work, { installed: false });
    const app = await install('MacBook', ssh.bin);
    const mini = await install('mini');
    await playComputer(mini, ssh);

    const offer = await app.machines.sshPairStart('kayra@mini');
    expect(offer).toMatchObject({ name: 'mini', sshChecked: true });
    expect(offer.fingerprint).toBe(mini.machines.pairStatus().open?.waiting?.fingerprint);
    const added = await app.machines.joinApprove();
    expect(app.machines.list().map((m) => m.name)).toEqual(['mini']);
    expect(added.name).toBe('mini');
    // Its ssh host is kept: Open in Editor opens its folders over Remote-SSH (BLG-794).
    expect(added.ssh).toBe('kayra@mini');
    expect(app.machines.list()[0]?.ssh).toBe('kayra@mini');
    await waitFor(() => mini.machines.pairStatus().last?.kind === 'joined', 10_000);

    // What ran over ssh: your own ssh with keys only (BatchMode), the install line, up, then the pairing.
    const calls = ssh.calls();
    expect(calls.every((c) => c.includes('BatchMode=yes') && c.includes('kayra@mini'))).toBe(true);
    const commands = calls.map((c) => c[c.length - 1]!);
    expect(commands[0]).toContain('beluga version');
    expect(commands).toContain(INSTALL_LINE);
    expect(commands.some((c) => c.endsWith(" up'"))).toBe(true);
    expect(commands.at(-1)).toContain('pair --computer --json');
  }, 120_000);

  it('pictures over SSH that differ from the link’s add nothing', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'beluga-fake-ssh-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const ssh = fakeSsh(work, { installed: true });
    const app = await install('MacBook', ssh.bin);
    const mini = await install('mini');
    await playComputer(mini, ssh, '🐶 🐶 🐶 🐶');
    await expect(app.machines.sshPairStart('mini')).rejects.toThrow(/aren’t the ones its link showed/);
    expect(app.machines.list()).toEqual([]);
    await waitFor(() => mini.machines.pairStatus().last?.kind === 'declined', 10_000);
    expect(mini.machines.set.holdsIdentity).toBe(true);
  }, 120_000);

  it('a pairing still open when Beluga quits ends its ssh with it', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'beluga-fake-ssh-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const ssh = fakeSsh(work, { installed: true });
    const app = await install('MacBook', ssh.bin);
    const mini = await install('mini');
    // The computer prints its link and its pictures, and never how the pairing ended.
    const info = await mini.machines.pairStart();
    ssh.say('pair.json', { link: info.link, code: info.code, expiresAt: info.expiresAt });
    const offering = app.machines.sshPairStart('mini');
    const waiting = await waitFor(() => mini.machines.pairStatus().open?.waiting, 30_000);
    ssh.say('waiting.json', { waiting: waiting.name, fingerprint: waiting.fingerprint });
    await offering;
    const pid = Number(readFileSync(path.join(work, 'pid'), 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);

    await app.machines.stop();
    await waitFor(() => !alive(), 10_000);
  }, 120_000);

  it('a host it can’t reach, or one that isn’t a host, says so', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'beluga-fake-ssh-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const ssh = fakeSsh(work, { installed: true });
    writeFileSync(ssh.bin, `#!${process.execPath}\nprocess.stderr.write('ssh: connect to host nowhere port 22: Connection refused\\n'); process.exit(255);\n`);
    const app = await install('MacBook', ssh.bin);
    await expect(app.machines.sshPairStart('nowhere')).rejects.toThrow(/ssh couldn't reach nowhere with your keys/);
    await expect(app.machines.sshPairStart('-oProxyCommand=evil')).rejects.toThrow(/isn't a host/);
  }, 60_000);
});
