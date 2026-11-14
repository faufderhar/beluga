import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, type Prefs } from '../src/core/store.js';
import { LOCAL_SETTINGS, SYNCED_SETTINGS, SettingsFrame, SettingsSync, type SyncPeer } from '../src/machines/sync.js';
import { Settings } from '../src/shared/settings-schema.js';

/** Your settings on every computer (BLG-805): what syncs, newest wins, conflicts said, secrets only where you said yes. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let clock = 1_700_000_000_000;
/** How far the clock moves each time a device reads it (0: everything in the same millisecond). */
let tick = 10;
afterEach(() => {
  tick = 10;
});

/** One device of yours: its prefs (as the store holds them), its variables, its log. */
function device(id: string, name: string, role: SyncPeer['role'], start: Partial<Prefs> = {}, vars: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-sync-'));
  dirs.push(dir);
  let prefs: Prefs = { ...DEFAULT_PREFS, ...start };
  let env = { ...vars };
  const listeners = new Set<() => void>();
  const envListeners = new Set<() => void>();
  const lines: string[] = [];
  let pushes = 0;
  const file = path.join(dir, 'settings-sync.json');
  const make = () =>
    new SettingsSync({
      file,
      prefs: () => prefs,
      watch: (l) => (listeners.add(l), () => void listeners.delete(l)),
      apply: (patch) => {
        const next: Record<string, unknown> = { ...prefs };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next[k] = (DEFAULT_PREFS as unknown as Record<string, unknown>)[k];
          else next[k] = v;
        }
        prefs = next as unknown as Prefs;
        for (const l of [...listeners]) l();
      },
      secrets: {
        read: () => env,
        write: (k, v) => {
          const next = { ...env };
          if (v === undefined) delete next[k];
          else next[k] = v;
          env = next;
          for (const l of [...envListeners]) l();
        },
        watch: (l) => (envListeners.add(l), () => void envListeners.delete(l)),
      },
      now: () => (clock += tick),
      log: (line) => lines.push(line),
    });
  let sync = make();
  const begin = (): void => sync.start({ self: () => ({ id, name }), push: () => void pushes++ });
  begin();
  return {
    id,
    name,
    role,
    file,
    lines,
    get sync() {
      return sync;
    },
    get prefs() {
      return prefs;
    },
    get env() {
      return env;
    },
    get pushes() {
      return pushes;
    },
    /** A change made here (Settings, or the phone): the store's prefs change. */
    set(patch: Partial<Prefs>): void {
      prefs = { ...prefs, ...patch };
      for (const l of [...listeners]) l();
    },
    setVar(key: string, value: string | undefined): void {
      const next = { ...env };
      if (value === undefined) delete next[key];
      else next[key] = value;
      env = next;
      for (const l of [...envListeners]) l();
    },
    /** Beluga restarted here: the ledger is read back from its file. */
    restart(): void {
      sync.stop();
      sync = make();
      begin();
    },
  };
}
type Device = ReturnType<typeof device>;

const peerOf = (d: Device): SyncPeer => ({ id: d.id, name: d.name, role: d.role });

/** `from` dials `to` (what machines.ts syncWith does): `to` merges, answers, `from` merges the answer. */
function exchange(from: Device, to: Device): void {
  const holderFrom = from.role === 'app';
  const holderTo = to.role === 'app';
  const ask: SettingsFrame = JSON.parse(JSON.stringify(from.sync.frame({ id: to.id }, holderFrom)));
  to.sync.merge(peerOf(from), ask, holderTo);
  const answer: SettingsFrame = JSON.parse(JSON.stringify(to.sync.frame({ id: from.id }, holderTo)));
  from.sync.merge(peerOf(to), answer, holderFrom);
}

describe('which settings sync', () => {
  it('every setting is either yours (syncs) or the computer’s own (never syncs)', () => {
    const all = Object.keys(Settings.shape).sort();
    const classified = [...SYNCED_SETTINGS, ...LOCAL_SETTINGS].sort();
    expect(classified).toEqual(all);
    expect(SYNCED_SETTINGS.filter((k) => (LOCAL_SETTINGS as readonly string[]).includes(k))).toEqual([]);
  });

  it('paths, the service, web access and power never travel', () => {
    for (const k of ['shell', 'shellArgs', 'tunnel', 'mailbox', 'network', 'keepAwake', 'lowPower', 'computerName', 'computerIcon', 'capabilities'] as const) expect(LOCAL_SETTINGS).toContain(k);
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer', { tunnel: 'none', shell: '/bin/bash' });
    mac.set({ tunnel: 'ngrok', shell: '/bin/zsh', keepAwake: 'always', mouse: false, parallelRuns: 9 });
    exchange(mac, box);
    expect(box.prefs.tunnel).toBe('none');
    expect(box.prefs.shell).toBe('/bin/bash');
    expect(box.prefs.keepAwake).toBe('off');
    expect(box.prefs.mouse).toBe(true);
    expect(box.prefs.parallelRuns).toBe(DEFAULT_PREFS.parallelRuns);
    const frame = mac.sync.frame({ id: box.id }, true);
    for (const k of Object.keys(frame.entries)) expect(SYNCED_SETTINGS as readonly string[]).toContain(k);
  });
});

describe('a change follows you', () => {
  it('a setting changed on the Mac reaches the computer, and is sent at once', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    const before = mac.pushes;
    mac.set({ theme: 'mono', effort: 'high', model: 'opus' });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        // One push for the three, a moment later.
        expect(mac.pushes).toBe(before + 1);
        exchange(mac, box);
        expect(box.prefs.theme).toBe('mono');
        expect(box.prefs.effort).toBe('high');
        expect(box.prefs.model).toBe('opus');
        expect(box.lines.join('\n')).toMatch(/took .*theme.* from MacBook/);
        resolve();
      }, 200),
    );
  });

  it('a setting changed on a computer (from the phone) reaches the Mac, and the Mac passes it on', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    const mini = device('cccc000000000003', 'mini', 'computer');
    exchange(mac, box);
    exchange(mac, mini);
    box.set({ notify: { ...box.prefs.notify, done: false }, runOn: 'best' });
    // The computer dials its app.
    exchange(box, mac);
    expect(mac.prefs.runOn).toBe('best');
    expect(mac.prefs.notify.done).toBe(false);
    // The app passes it on to its other computers.
    exchange(mac, mini);
    expect(mini.prefs.runOn).toBe('best');
    expect(mini.prefs.notify.done).toBe(false);
  });

  it('a value set back to its default travels too', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', { model: 'opus' });
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    expect(box.prefs.model).toBe('opus');
    mac.set({ model: undefined });
    exchange(mac, box);
    expect(box.prefs.model).toBeUndefined();
  });

  it('a computer joining takes your app’s settings, not the other way round', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', { theme: 'light', effort: 'max' });
    const box = device('bbbb000000000002', 'build-box', 'computer', { theme: 'contrast' });
    exchange(mac, box);
    expect(box.prefs.theme).toBe('light');
    expect(box.prefs.effort).toBe('max');
    expect(mac.prefs.theme).toBe('light');
    expect(mac.sync.view().conflicts).toEqual([]);
  });

  it('a value that isn’t one this Beluga reads is left alone', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    box.sync.merge(peerOf(mac), { entries: { theme: { at: clock + 1e9, by: mac.id, name: 'MacBook', value: 'neon' }, shell: { at: clock + 1e9, by: mac.id, name: 'MacBook', value: '/bin/evil' } } }, false);
    expect(box.prefs.theme).toBe('calm');
    expect(box.prefs.shell).toBeUndefined();
  });

  it('nothing new: no push back and forth', async () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    await new Promise((r) => setTimeout(r, 200));
    const pushes = [mac.pushes, box.pushes];
    exchange(mac, box);
    exchange(box, mac);
    await new Promise((r) => setTimeout(r, 200));
    expect([mac.pushes, box.pushes]).toEqual(pushes);
  });
});

describe('offline, and conflicts', () => {
  it('a computer that was off catches up when it’s back, and what changed there comes back', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    // Apart: each changes a different setting; the computer restarts meanwhile.
    mac.set({ theme: 'light' });
    box.set({ subagents: 'compact' });
    box.restart();
    mac.restart();
    exchange(box, mac);
    expect(box.prefs.theme).toBe('light');
    expect(mac.prefs.subagents).toBe('compact');
    expect(mac.sync.view().conflicts).toEqual([]);
  });

  it('the same setting changed on two while apart keeps the latest and says so', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    mac.set({ theme: 'light' });
    box.set({ theme: 'mono' });
    exchange(box, mac);
    expect(mac.prefs.theme).toBe('mono');
    expect(box.prefs.theme).toBe('mono');
    const [said] = mac.sync.view().conflicts;
    expect(said).toMatchObject({ key: 'theme', label: 'Theme', kept: { name: 'build-box', value: 'mono' }, lost: { name: 'MacBook', value: 'light' } });
    mac.sync.clearConflicts();
    expect(mac.sync.view().conflicts).toEqual([]);
  });

  it('a change made in the same millisecond as the last sync still counts as made after it (BLG-721)', () => {
    // A busy machine: the computer takes the Mac's frame and you change the same setting there
    // within one millisecond (what failed tests/machines-settings-sync.test.ts on CI).
    tick = 0;
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    box.set({ theme: 'contrast' });
    mac.set({ theme: 'light' });
    exchange(mac, box);
    expect(box.prefs.theme).toBe(mac.prefs.theme);
    expect(mac.sync.view().conflicts.map((c) => c.key)).toEqual(['theme']);
  });
});

describe('secrets', () => {
  it('stay home until you say Keep My Secrets in Sync for that computer', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', {}, { OPENAI_API_KEY: 'sk-live-123' });
    const box = device('bbbb000000000002', 'build-box', 'computer');
    const mini = device('cccc000000000003', 'mini', 'computer');
    exchange(mac, box);
    exchange(mac, mini);
    expect(box.env).toEqual({});
    expect(JSON.stringify(mac.sync.frame({ id: box.id }, true))).not.toContain('sk-live-123');

    mac.sync.setSecretsWith(box.id, true);
    exchange(mac, box);
    exchange(mac, mini);
    expect(box.env).toEqual({ OPENAI_API_KEY: 'sk-live-123' });
    expect(mini.env).toEqual({});
    // Its changes come back to the app, and nothing reaches the computer you didn't say yes for.
    box.setVar('GITHUB_TOKEN', 'ghp_abc');
    box.setVar('OPENAI_API_KEY', undefined);
    exchange(box, mac);
    expect(mac.env).toEqual({ GITHUB_TOKEN: 'ghp_abc' });
    exchange(mac, mini);
    expect(mini.env).toEqual({});

    // Never a value in a log or the ledger.
    for (const d of [mac, box, mini]) {
      const text = d.lines.join('\n') + readFileSync(d.file, 'utf8');
      expect(text).not.toContain('sk-live-123');
      expect(text).not.toContain('ghp_abc');
      if (process.platform !== 'win32') expect(statSync(d.file).mode & 0o777).toBe(0o600);
    }
  });

  it('stop: the computer stops sending and taking them', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', {}, { A_KEY: 'one' });
    const box = device('bbbb000000000002', 'build-box', 'computer');
    mac.sync.setSecretsWith(box.id, true);
    exchange(mac, box);
    expect(box.sync.secretsOn(mac.id)).toBe(true);
    mac.sync.setSecretsWith(box.id, false);
    exchange(mac, box);
    expect(box.sync.secretsOn(mac.id)).toBe(false);
    box.setVar('B_KEY', 'two');
    mac.setVar('A_KEY', 'changed');
    exchange(box, mac);
    exchange(mac, box);
    expect(mac.env).toEqual({ A_KEY: 'changed' });
    expect(box.env).toEqual({ A_KEY: 'one', B_KEY: 'two' });
  });

  it('a computer can’t turn it on for the app', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer', {}, { STOLEN: 'x' });
    mac.sync.merge(peerOf(box), { entries: {}, secretsOk: true, secrets: { STOLEN: { at: clock + 1e9, by: box.id, name: 'build-box', value: 'x' } } }, true);
    expect(mac.env).toEqual({});
    expect(mac.sync.secretsOn(box.id)).toBe(false);
  });

  it('a conflict on a secret is said without its value', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', {}, { TOKEN: 'base' });
    const box = device('bbbb000000000002', 'build-box', 'computer');
    mac.sync.setSecretsWith(box.id, true);
    exchange(mac, box);
    mac.setVar('TOKEN', 'mac-secret');
    box.setVar('TOKEN', 'box-secret');
    exchange(box, mac);
    expect(mac.env.TOKEN).toBe('box-secret');
    const [said] = mac.sync.view().conflicts;
    expect(said).toMatchObject({ key: 'TOKEN', secret: true, kept: { name: 'build-box' }, lost: { name: 'MacBook' } });
    expect(JSON.stringify(mac.sync.view())).not.toMatch(/mac-secret|box-secret/);
  });
});

/** `exchange`, keeping what went over the wire both ways. */
function exchangeWire(from: Device, to: Device): [string, string] {
  const ask = JSON.stringify(from.sync.frame({ id: to.id }, from.role === 'app'));
  to.sync.merge(peerOf(from), JSON.parse(ask), to.role === 'app');
  const answer = JSON.stringify(to.sync.frame({ id: from.id }, to.role === 'app'));
  from.sync.merge(peerOf(to), JSON.parse(answer), from.role === 'app');
  return [ask, answer];
}

describe('conflicts a computer records reach the app (BLG-835)', () => {
  it('the Mac dials, its value is newer: the computer saw the conflict, and the Mac says it', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    box.set({ theme: 'contrast' });
    mac.set({ theme: 'light' });
    const [, answer] = exchangeWire(mac, box);
    expect(box.prefs.theme).toBe('light');
    expect(JSON.parse(answer).conflicts).toHaveLength(1);
    const said = mac.sync.view().conflicts;
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ key: 'theme', label: 'Theme', kept: { name: 'MacBook', value: 'light' }, lost: { name: 'build-box', value: 'contrast' } });
  });

  it('no duplicates: taken once, and a Got It on the Mac stays cleared', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    box.set({ effort: 'low' });
    mac.set({ effort: 'max' });
    exchange(mac, box);
    exchange(box, mac);
    exchange(mac, box);
    expect(mac.sync.view().conflicts).toHaveLength(1);
    // The computer stops sending it once the app says it has it.
    const [, answer] = exchangeWire(mac, box);
    expect(JSON.parse(answer).conflicts).toBeUndefined();
    mac.sync.clearConflicts();
    exchange(box, mac);
    exchange(mac, box);
    expect(mac.sync.view().conflicts).toEqual([]);
  });

  it('a secret’s conflict reaches the Mac with no value in the frame, the ledger or the logs', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app', {}, { TOKEN: 'base-value' });
    const box = device('bbbb000000000002', 'build-box', 'computer');
    mac.sync.setSecretsWith(box.id, true);
    exchange(mac, box);
    box.setVar('TOKEN', 'box-value');
    mac.setVar('TOKEN', 'mac-value');
    const [, answer] = exchangeWire(mac, box);
    expect(box.env.TOKEN).toBe('mac-value');
    const told = JSON.parse(answer).conflicts as unknown[];
    expect(told).toHaveLength(1);
    expect(JSON.stringify(told)).not.toMatch(/box-value|mac-value|base-value/);
    expect(mac.sync.view().conflicts[0]).toMatchObject({ key: 'TOKEN', secret: true, kept: { name: 'MacBook' }, lost: { name: 'build-box' } });
    for (const d of [mac, box]) expect(d.lines.join('\n') + readFileSync(d.file, 'utf8')).not.toMatch(/box-value|mac-value|base-value/);
  });

  it('older peers without the fields still sync, and ignore them', () => {
    const mac = device('aaaa000000000001', 'MacBook', 'app');
    const box = device('bbbb000000000002', 'build-box', 'computer');
    exchange(mac, box);
    box.set({ theme: 'contrast' });
    mac.set({ theme: 'light' });
    // An older app: its frame has no `heard`, and it reads only what it knows of the answer.
    const { heard: _h, ...old } = mac.sync.frame({ id: box.id }, true);
    box.sync.merge(peerOf(mac), old, false);
    const { conflicts: _c, ...forOld } = box.sync.frame({ id: mac.id }, false);
    mac.sync.merge(peerOf(box), forOld, true);
    expect(box.prefs.theme).toBe('light');
    expect(mac.prefs.theme).toBe('light');
    // A newer field this Beluga doesn't know is dropped, not refused.
    expect(SettingsFrame.safeParse({ entries: {}, conflicts: [], heard: 0, later: { anything: true } }).success).toBe(true);
  });
});
