import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { Machines } from '../src/machines/machines.js';
import { SettingsSync } from '../src/machines/sync.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * Your settings on every computer, for real (BLG-805): an app and a computer as the daemon runs
 * them, joined on a local DHT. A setting changed on either shows on the other within seconds, with
 * nothing to click; your secrets go only after Keep My Secrets in Sync, and never into a log.
 */

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

async function install(name: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-settings-sync-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const lines: string[] = [];
  let env: Record<string, string> = {};
  const envWatchers = new Set<() => void>();
  const setVar = (key: string, value: string | undefined): void => {
    const next = { ...env };
    if (value === undefined) delete next[key];
    else next[key] = value;
    env = next;
    for (const w of [...envWatchers]) w();
  };
  const settings = new SettingsSync({
    file: path.join(dir, 'settings-sync.json'),
    prefs: () => store.getState().prefs,
    watch: (l) => store.subscribe(l),
    apply: (patch) => store.dispatch({ type: 'prefs', prefs: patch as never }),
    secrets: { read: () => env, write: setVar, watch: (l) => (envWatchers.add(l), () => void envWatchers.delete(l)) },
    log: (l) => lines.push(l),
  });
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
    platform: name === 'MacBook' ? 'macos' : 'linux',
    removePhone: (id) => void host.removeDevice(id),
    onChange: () => host.machinesChanged(),
    retryMs: 300,
    info: async () => ({ at: Date.now(), cpus: 4, loadPerCore: 0.5, memory: { freeGB: 6, totalGB: 16 }, agentsRunning: 0, runtimes: [], gh: 'signed_in' as const, mcp: [], projects: [] }),
    pollMs: 60_000,
    settings,
    log: (l) => lines.push(l),
  });
  host = new CompanionHost({
    identity,
    store,
    devices,
    call: async () => ({ ok: true, value: undefined }),
    macName: () => name,
    version: '0.9.0',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
    machines,
  });
  cleanup.push(async () => {
    await machines.stop();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  machines.start();
  return { store, machines, lines, setVar, env: () => env };
}

type Install = Awaited<ReturnType<typeof install>>;

async function join(app: Install, computer: Install): Promise<void> {
  const info = await computer.machines.pairStart();
  await app.machines.joinStart(info.link);
  await app.machines.joinApprove();
  await waitFor(() => computer.machines.pairStatus().last?.kind === 'joined', 10_000);
}

describe('your settings on every computer', () => {
  it('a change on the Mac shows on the computer within 5 seconds, and one there shows on the Mac', async () => {
    const app = await install('MacBook');
    const box = await install('build-box');
    await join(app, box);
    // The first sync carries the app's settings over.
    app.store.dispatch({ type: 'prefs', prefs: { effort: 'high' } });
    await waitFor(() => box.store.getState().prefs.effort === 'high', 20_000);

    const t0 = Date.now();
    app.store.dispatch({ type: 'prefs', prefs: { theme: 'mono', model: 'opus' } });
    await waitFor(() => box.store.getState().prefs.theme === 'mono', 5_000);
    expect(box.store.getState().prefs.model).toBe('opus');
    expect(Date.now() - t0).toBeLessThan(5_000);

    // On the computer (what its phone's Settings does): the Mac follows.
    box.store.dispatch({ type: 'prefs', prefs: { runOn: 'best', tunnel: 'none' } });
    await waitFor(() => app.store.getState().prefs.runOn === 'best', 5_000);
    // Its web access stays its own.
    expect(app.store.getState().prefs.tunnel).toBe('auto');
  }, 120_000);

  it('the same setting changed on both at once: the Mac says the conflict, whichever side merged it (BLG-835)', async () => {
    const app = await install('MacBook');
    const box = await install('build-box');
    await join(app, box);
    app.store.dispatch({ type: 'prefs', prefs: { effort: 'high' } });
    await waitFor(() => box.store.getState().prefs.effort === 'high', 20_000);
    // Both before either sends (a change goes 100 ms after it's made): the Mac's is the newer. A
    // few ms apart without yielding, so no timer runs between them; a sleep there can stretch past
    // those 100 ms on a busy machine, and the box's would arrive first.
    box.store.dispatch({ type: 'prefs', prefs: { theme: 'contrast' } });
    for (const t = Date.now(); Date.now() - t < 3; );
    app.store.dispatch({ type: 'prefs', prefs: { theme: 'light' } });
    await waitFor(() => app.machines.settingsSync().conflicts.some((c) => c.key === 'theme'), 10_000);
    await waitFor(() => box.store.getState().prefs.theme === 'light', 10_000);
    expect(app.store.getState().prefs.theme).toBe('light');
    const said = app.machines.settingsSync().conflicts.filter((c) => c.key === 'theme');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ kept: { name: 'MacBook', value: 'light' }, lost: { name: 'build-box', value: 'contrast' } });
  }, 120_000);

  it('secrets go only after Keep My Secrets in Sync, and never into a log', async () => {
    const app = await install('MacBook');
    const box = await install('build-box');
    await join(app, box);
    app.setVar('OPENAI_API_KEY', 'sk-live-xyz');
    app.store.dispatch({ type: 'prefs', prefs: { theme: 'light' } });
    await waitFor(() => box.store.getState().prefs.theme === 'light', 10_000);
    expect(box.env()).toEqual({});

    const id = app.machines.list()[0]!.id;
    expect(app.machines.keepSecrets(id, true).secrets).toBe(true);
    await waitFor(() => box.env().OPENAI_API_KEY === 'sk-live-xyz', 5_000);
    box.setVar('GITHUB_TOKEN', 'ghp_back');
    await waitFor(() => app.env().GITHUB_TOKEN === 'ghp_back', 5_000);
    for (const i of [app, box]) expect(i.lines.join('\n')).not.toMatch(/sk-live-xyz|ghp_back/);
  }, 120_000);
});
