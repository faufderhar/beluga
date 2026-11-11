import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayToolDefs } from '../../src/agent/gateway-tools.js';
import type { RoomBridge } from '../../src/agent/types.js';
import { gatewayBridge } from '../../src/core/agent-bridge.js';
import { DEFAULT_CAPABILITIES } from '../../src/core/gateway/access.js';
import { pretendSystem } from '../../src/core/gateway/demo-system.js';
import { describeDevice, deviceInfo, parseBattery, parseDf } from '../../src/core/gateway/device.js';
import { attachGateway } from '../../src/core/gateway/registry.js';
import { FileFetcher, FileOffers } from '../../src/core/gateway/transfer.js';
import { MAX_FILE_TOTAL } from '../../src/core/gateway/protocol.js';
import { type NoticeEvent, Notifier, detectNotices } from '../../src/core/notify.js';
import type { Session } from '../../src/core/session.js';
import { initialState } from '../../src/core/store.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * Approvals and rules, capabilities, big files and questions between Claudes: simulated people
 * on a local DHT, each with their own Beluga. The screen and the device are a pretend Mac.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

async function pair(a: string, b: string, extraB: Parameters<typeof node>[2] = {}): Promise<[Node, Node]> {
  const x = await node(net, a);
  const y = await node(net, b, extraB);
  await befriend(x.person, y.person);
  return [x, y];
}

const projects = (): Record<string, string> => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'klaud-projects-'));
  const out: Record<string, string> = {};
  for (const name of ['landing', 'api']) {
    out[name] = path.join(base, name);
    mkdirSync(out[name]!, { recursive: true });
  }
  return out;
};

describe('the request sheet: Approve once, Always (scoped), Decline', () => {
  it('Always for this project writes a rule with that scope and expiry; other projects still ask', async () => {
    const dirs = projects();
    const [kay, bob] = await pair('kay2', 'bob2', { projectRoot: (n) => dirs[n] });
    kay.trust(bob.id, 'trusted');
    const first = kay.gw.ask({ person: 'bob2', ask: 'tidy the hero copy', project: 'landing', needs: ['project'], by: 'agent' });
    await settle(() => task(bob, first.id)?.state === 'awaiting_approval');
    expect(bob.approvals[0]).toMatchObject({ kind: 'request', task: first.id, title: "kay2's agent wants to: tidy the hero copy" });
    bob.gw.decide(first.id, { answer: 'always', scope: 'this', expiry: 'week' });
    await settle(() => task(kay, first.id)?.state === 'done');
    // The approval card went away (taken back), and the rule is there, not trust.
    expect(bob.approvals[0]!.withdrawn).toBe(true);
    expect(bob.store.getState().levels[kay.id]).toBeUndefined();
    const [r] = bob.gw.rules.rules();
    expect(r).toMatchObject({ peerId: kay.id, kind: 'task', project: 'landing', needs: ['project'], decision: 'allow' });
    expect(r!.expiresAt! - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // Same project: straight through. Another project: asks again.
    const second = kay.gw.ask({ person: 'bob2', ask: 'and the footer', project: 'landing', needs: ['project'], by: 'agent' });
    await settle(() => task(kay, second.id)?.state === 'done');
    const other = kay.gw.ask({ person: 'bob2', ask: 'check the api', project: 'api', needs: ['project'], by: 'agent' });
    await settle(() => task(bob, other.id)?.state === 'awaiting_approval');
    expect(bob.approvals).toHaveLength(2);
    // Decline with a reason: it goes back to them.
    bob.gw.decide(other.id, { answer: 'no', reason: 'not today, the api is frozen' });
    await settle(() => task(kay, other.id)?.state === 'declined');
    expect(task(kay, other.id)?.result?.summary).toBe('bob2 declined: not today, the api is frozen');
    expect(() => bob.gw.decide(other.id, { answer: 'yes' })).toThrow('not waiting');
  }, 60_000);

  it('Always for any project covers the others too; deleting the rule makes the next one ask again', async () => {
    const dirs = projects();
    const [kay, bob] = await pair('kay3', 'bob3', { projectRoot: (n) => dirs[n] });
    kay.trust(bob.id, 'trusted');
    const first = kay.gw.ask({ person: 'bob3', ask: 'look around', project: 'landing', needs: ['project'], by: 'agent' });
    await settle(() => task(bob, first.id)?.state === 'awaiting_approval');
    bob.gw.decide(first.id, { answer: 'always', scope: 'any', expiry: 'never' });
    await settle(() => task(kay, first.id)?.state === 'done');
    const elsewhere = kay.gw.ask({ person: 'bob3', ask: 'look around the api', project: 'api', needs: ['project'], by: 'agent' });
    await settle(() => task(kay, elsewhere.id)?.state === 'done');
    expect(bob.approvals).toHaveLength(1);
    bob.gw.removeRule(bob.gw.rules.rules()[0]!.id);
    expect(bob.store.getState().gateway.rules).toHaveLength(0);
    const after = kay.gw.ask({ person: 'bob3', ask: 'once more', project: 'api', needs: ['project'], by: 'agent' });
    await settle(() => task(bob, after.id)?.state === 'awaiting_approval');
    expect(bob.approvals).toHaveLength(2);
  }, 60_000);

  it('a command: Always covers that exact command in that folder, not another command', async () => {
    const ran: string[] = [];
    const [kay, bob] = await pair('kay4', 'bob4', {
      serveShell: async (_from, ask, hooks) => {
        hooks.onStarted('~/api');
        ran.push(ask.command);
        return { ok: true, output: 'ok', exitCode: 0, cwd: '~/api' };
      },
    });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const first = kay.gw.ask({ person: 'bob4', kind: 'run', ask: 'npm test', command: 'npm test', by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    expect(bob.approvals[0]!.title).toBe("kay4's agent wants to run on your Mac: npm test");
    bob.approvals[0]!.answer('always');
    await settle(() => task(kay, first.id)?.state === 'done');
    // It names no folder: the rule is for where it ran (the default folder), not anywhere.
    expect(bob.gw.rules.rules()[0]).toMatchObject({ kind: 'command', command: 'npm test', folder: realpathSync(os.homedir()) });
    const again = kay.gw.ask({ person: 'bob4', kind: 'run', ask: 'npm test', command: 'npm test', by: 'agent' });
    await settle(() => task(kay, again.id)?.state === 'done');
    kay.gw.ask({ person: 'bob4', kind: 'run', ask: 'rm -rf build', command: 'rm -rf build', by: 'agent' });
    await settle(() => bob.approvals.length === 2);
    expect(ran).toEqual(['npm test', 'npm test']);
  }, 60_000);
});

describe('Do Not Disturb and appearing offline', () => {
  it('requests still queue for you, silently; rules still let requests in', async () => {
    const events: NoticeEvent[] = [];
    const [kay, bob] = await pair('kay5', 'bob5', { notify: (e) => void events.push(e) });
    kay.trust(bob.id, 'trusted');
    bob.person.mesh.setPresence({ state: 'dnd' });
    await settle(() => bob.store.getState().network.self?.presence.state === 'dnd');
    const desktop: unknown[] = [];
    const notifier = new Notifier({ store: bob.store, desktop: (n) => void desktop.push(n), burstMs: 0 });
    // Someone's request waits for you: it's in the inbox, but no desktop notification.
    const asked = kay.gw.ask({ person: 'bob5', ask: 'what time is the demo?', by: 'agent' });
    await settle(() => task(bob, asked.id)?.state === 'awaiting_approval');
    bob.store.dispatch({ type: 'approval_add', approval: { id: 'ap-1', kind: 'request', title: "kay5's Claude wants to: what time is the demo?", detail: '', peer: kay.id, task: asked.id } });
    await new Promise((r) => setTimeout(r, 20));
    expect(bob.store.getState().inbox.some((n) => n.ref === 'ap-1')).toBe(true);
    expect(desktop).toHaveLength(0);
    // Your own Claude's approvals still make a sound.
    bob.store.dispatch({ type: 'approval_add', approval: { id: 'ap-2', kind: 'tool', title: 'Your Claude wants to run npm test', detail: '' } });
    await settle(() => desktop.length === 1);
    notifier.stop();
    bob.approvals[0]!.answer('always');
    await settle(() => task(kay, asked.id)?.state === 'done');
    // A rule lets the next one in while you're away; its notice is quiet.
    bob.person.mesh.setPresence({ state: 'offline' });
    await settle(() => bob.store.getState().network.self?.appearOffline);
    const next = kay.gw.ask({ person: 'bob5', ask: 'and the room?', by: 'agent' });
    await settle(() => task(kay, next.id)?.state === 'done');
    expect(events.find((e) => e.title.includes('and the room?'))).toMatchObject({ kind: 'people', quiet: true });
  }, 60_000);

  it('a friend’s approval notice is marked quiet on DND; one notice on its own can be answered from the notification', () => {
    const base = initialState('room');
    const self = { peerId: 'me-peer-0000001', name: 'me', presence: { state: 'dnd' as const }, appearOffline: false };
    const prev = { ...base, network: { ...base.network, enabled: true, self } } as typeof base;
    const next = { ...prev, approvals: [{ id: 'a1', kind: 'request' as const, title: 'x', detail: 'y', peer: 'kay-peer-00001', task: 't_abcdefghijk' }] };
    expect(detectNotices(prev as never, next as never)).toEqual([expect.objectContaining({ ref: 'a1', task: 't_abcdefghijk', quiet: true })]);
  });
});

describe('capabilities: the screen and device info', () => {
  it('declines the screen while it’s off; with it on, Claude gets a screenshot tool and the picture comes back', async () => {
    const system = pretendSystem();
    let caps: unknown;
    const [kay, bob] = await pair('kay6', 'bob6', { system, loadCaps: () => caps, saveCaps: (c) => void (caps = c) });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.gw.setCapabilities({ levels: { screen: { ...DEFAULT_CAPABILITIES.levels.screen, trusted: 'off' } } });
    const no = kay.gw.ask({ person: 'bob6', ask: 'what is on screen?', needs: ['screen'], by: 'agent' });
    await settle(() => task(kay, no.id)?.state === 'declined');
    expect(task(kay, no.id)?.result?.summary).toBe("bob6's Beluga doesn't let you see the screen");
    expect(system.ran).toHaveLength(0);
    // Their card says what you're offered now.
    await settle(() => kay.store.getState().gateway.cards[bob.id]?.offers.includes('screen') === false);

    bob.gw.setCapabilities({ levels: { screen: { ...DEFAULT_CAPABILITIES.levels.screen, trusted: 'allow' } } });
    await settle(() => kay.store.getState().gateway.cards[bob.id]?.offers.includes('screen'));
    bob.claude.answer = async (input) => {
      expect(input.taskTools?.screenshot).toBeTypeOf('function');
      expect(input.taskTools?.deviceInfo).toBeUndefined();
      expect(input.prompt).toContain('screenshot tool');
      const shot = await input.taskTools!.screenshot!('Safari');
      expect(shot.image?.mimeType).toBe('image/jpeg');
      return `I see the staging page. ${shot.text}`;
    };
    const yes = kay.gw.ask({ person: 'bob6', ask: 'what is on screen?', needs: ['screen'], by: 'agent' });
    await settle(() => task(kay, yes.id)?.state === 'done');
    expect(system.ran.some((c) => c.startsWith('screencapture -x -t png -l4242 -o'))).toBe(true);
    const files = task(kay, yes.id)!.result!.files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ image: true });
    expect(readFileSync(files[0]!.path!).subarray(1, 4).toString()).toBe('PNG');
  }, 60_000);

  it('device info: allowed for trusted by default, summarised, nothing secret', async () => {
    const system = pretendSystem();
    const [kay, bob] = await pair('kay7', 'bob7', { system });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    let told = '';
    bob.claude.answer = async (input) => {
      told = await input.taskTools!.deviceInfo!();
      return 'It is a MacBook Pro on macOS 26.5.';
    };
    const t = kay.gw.ask({ person: 'bob7', ask: 'what Mac do you have?', needs: ['device'], by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(told).toContain('MacBook Pro · Apple M4 Pro · 10 cores · 24 GB memory');
    expect(told).toContain('macOS 26.5 (25F71)');
    expect(told).toContain('Battery: 82%');
    expect(told).toContain('en0 192.168.1.24');
    expect(told).not.toMatch(/C02SECRET|aa:bb:cc|fe80/);
    expect(bob.approvals).toHaveLength(0);
  }, 60_000);

  it('parses what the system says', async () => {
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1048576 0 524288 50% /\n')).toEqual({ totalGB: 1, freeGB: 0.5 });
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")).toMatchObject({ percent: 100, charging: true, power: 'AC Power' });
    expect(parseBattery("Now drawing from 'AC Power'\n")).toBeUndefined();
    const info = await deviceInfo(pretendSystem());
    expect(info.apps).toEqual(['Beluga', 'Figma', 'Safari', 'Xcode']);
    expect(describeDevice(info)).toContain('4 apps in /Applications');
  });
});

describe('big files: fetched in pieces', () => {
  it('a screenshot bigger than a result can carry arrives whole (checked), with progress', async () => {
    const system = pretendSystem({ big: true });
    const [kay, bob] = await pair('kay8', 'bob8', { system });
    kay.trust(bob.id, 'full');
    bob.trust(kay.id, 'full');
    let original = '';
    bob.claude.answer = async (input) => {
      await input.taskTools!.screenshot!();
      return 'Here is the screen.';
    };
    const seen: number[] = [];
    const t = kay.gw.ask({ person: 'bob8', ask: 'show me your screen', needs: ['screen'], by: 'agent' });
    await settle(() => {
      const now = task(kay, t.id);
      if (now?.incoming) seen.push(now.incoming.received);
      return now?.state === 'done';
    });
    const sent = bob.gw.get(t.id)!.result!.files[0]!;
    const shot = path.join(bob.gw.book.workDir(t.id, os.tmpdir()), 'screens');
    original = path.join(shot, (await import('node:fs')).readdirSync(shot).find((f) => f.endsWith('.png') && !f.includes('view'))!);
    expect(sent.size).toBeGreaterThan(MAX_FILE_TOTAL);
    const got = task(kay, t.id)!.result!.files[0]!;
    expect(got.path).toBeTruthy();
    expect(statSync(got.path!).size).toBe(sent.size);
    const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
    expect(sha(got.path!)).toBe(sha(original));
    expect(seen.length).toBeGreaterThan(0);
    expect(task(kay, t.id)?.incoming).toBeUndefined();
  }, 60_000);

  it('only the person a file was offered to gets it; a damaged file is not kept', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-offer-'));
    const file = path.join(dir, 'big.bin');
    writeFileSync(file, Buffer.alloc(300_000, 7));
    const offers = new FileOffers();
    const offered = (await offers.offer('t_abcdefghijk', 'kay-peer-00001', file))!;
    expect(await offers.chunk('mallory-peer-01', { t: 'file_get', id: 't_abcdefghijk', ref: offered.ref, offset: 0, ts: 0 })).toMatchObject({ error: 'That file is no longer available' });
    expect(await offers.chunk('kay-peer-00001', { t: 'file_get', id: 't_otherotherx', ref: offered.ref, offset: 0, ts: 0 })).toMatchObject({ error: 'That file is no longer available' });
    const fetcher = new FileFetcher({
      send: (_to, msg) => {
        if (msg.t === 'file_get') void offers.chunk('kay-peer-00001', msg).then((c) => fetcher.onChunk('bob-peer-000001', c as never));
        return true;
      },
      target: async (_t, name) => path.join(dir, `got-${name}`),
      chunkTimeoutMs: 500,
    });
    const [good] = await fetcher.fetchAll('bob-peer-000001', 't_abcdefghijk', [{ name: 'big.bin', ref: offered.ref, size: offered.size, sha256: offered.sha256 }], () => undefined);
    expect(good).toMatchObject({ size: 300_000, path: path.join(dir, 'got-big.bin') });
    const [bad] = await fetcher.fetchAll('bob-peer-000001', 't_abcdefghijk', [{ name: 'again.bin', ref: offered.ref, size: offered.size, sha256: '0'.repeat(64) }], () => undefined);
    expect(bad).toMatchObject({ error: 'it came damaged (checksum mismatch)' });
    expect(bad!.path).toBeUndefined();
  });
});

describe('a file from their Mac', () => {
  it('sends a file from a folder they chose; outside it or a secret is declined', async () => {
    const shared = mkdtempSync(path.join(os.tmpdir(), 'klaud-shared-'));
    writeFileSync(path.join(shared, 'notes.md'), '# notes');
    writeFileSync(path.join(shared, '.env'), 'TOKEN=1');
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'klaud-else-'));
    writeFileSync(path.join(elsewhere, 'private.txt'), 'mine');
    const [kay, bob] = await pair('kay9', 'bob9', { loadCaps: () => ({ folders: [shared] }) });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const ok = kay.gw.ask({ person: 'bob9', kind: 'file', ask: '', path: path.join(shared, 'notes.md'), by: 'agent' });
    await settle(() => task(kay, ok.id)?.state === 'done');
    expect(readFileSync(task(kay, ok.id)!.result!.files[0]!.path!, 'utf8')).toBe('# notes');
    const outside = kay.gw.ask({ person: 'bob9', kind: 'file', ask: '', path: path.join(elsewhere, 'private.txt'), by: 'agent' });
    await settle(() => task(kay, outside.id)?.state === 'declined');
    // A link inside the shared folder to a file outside it doesn't make that file shared.
    symlinkSync(path.join(elsewhere, 'private.txt'), path.join(shared, 'link.txt'));
    const linked = kay.gw.ask({ person: 'bob9', kind: 'file', ask: '', path: path.join(shared, 'link.txt'), by: 'agent' });
    await settle(() => task(kay, linked.id)?.state === 'declined');
    // A secret in a shared folder, from someone bob trusts, still asks him (Allow once / Decline).
    const secret = kay.gw.ask({ person: 'bob9', kind: 'file', ask: '', path: path.join(shared, '.env'), by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    expect(bob.approvals[0]).toMatchObject({ kind: 'request', task: secret.id, once: true, title: "kay9's agent wants your .env file .env" });
    bob.approvals[0]!.answer('no');
    await settle(() => task(kay, secret.id)?.state === 'declined');
    expect(task(kay, secret.id)?.result?.summary).toContain('bob9 declined');
  }, 60_000);

  it('one they said yes to comes from anywhere (their Desktop), with no folders shared', async () => {
    const desktop = mkdtempSync(path.join(os.tmpdir(), 'klaud-desktop-'));
    writeFileSync(path.join(desktop, 'contract.pdf'), 'pdf');
    writeFileSync(path.join(desktop, 'id_rsa'), 'key');
    const [kay, bob] = await pair('kayA', 'bobA');
    kay.trust(bob.id, 'trusted');
    // bob has kay on "Ask me each time" and shares no folders: he sees each request and decides.
    const t = kay.gw.ask({ person: 'bobA', kind: 'file', ask: 'the contract on your Desktop', path: path.join(desktop, 'contract.pdf'), by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    bob.approvals[0]!.answer('yes');
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(readFileSync(task(kay, t.id)!.result!.files[0]!.path!, 'utf8')).toBe('pdf');
  }, 60_000);
});

describe('a secret, with its own approval (BLG-209)', () => {
  it('is asked about every time, even with full trust; Allow once sends that one file and both sides know it was approved', async () => {
    const desktop = mkdtempSync(path.join(os.tmpdir(), 'klaud-desktop-'));
    writeFileSync(path.join(desktop, 'id_ed25519'), 'the key');
    const [kay, bob] = await pair('kayS', 'bobS');
    kay.trust(bob.id, 'full');
    bob.trust(kay.id, 'full');
    const first = kay.gw.ask({ person: 'bobS', kind: 'file', ask: 'my laptop needs the deploy key', path: path.join(desktop, 'id_ed25519'), by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    expect(bob.approvals[0]).toMatchObject({ kind: 'request', once: true, title: "kayS's agent wants your private SSH key id_ed25519" });
    expect(bob.approvals[0]!.detail).toContain('asked each time');
    expect(task(bob, first.id)).toMatchObject({ state: 'awaiting_approval', secret: { kind: 'ssh-key', label: 'your private SSH key id_ed25519' } });
    // "Always" (from anywhere) counts once and writes no rule.
    bob.approvals[0]!.answer('always');
    await settle(() => task(kay, first.id)?.state === 'done');
    const got = task(kay, first.id)!;
    expect(readFileSync(got.result!.files[0]!.path!, 'utf8')).toBe('the key');
    expect(got.result!.secret).toBe('private SSH key id_ed25519');
    expect(task(bob, first.id)?.allowedBy).toContain('this once');
    expect(bob.gw.rules.rules()).toHaveLength(0);
    // Kay's Claude is told it was approved, so it hands it over.
    const told = kay.gw.describe(first.id);
    expect(told).toContain('approved sending to your user');
    expect(told).toContain("Don't refuse");
    // The next time asks again: bob declines this one.
    const again = kay.gw.ask({ person: 'bobS', kind: 'file', ask: '', path: path.join(desktop, 'id_ed25519'), by: 'agent' });
    await settle(() => bob.approvals.length === 2);
    bob.gw.decide(again.id, { answer: 'no', reason: 'not this one' });
    await settle(() => task(kay, again.id)?.state === 'declined');
    expect(task(kay, again.id)?.result?.summary).toBe('bobS declined: not this one');
    expect(task(kay, again.id)?.result?.secret).toBeUndefined();
  }, 60_000);

  it('the keychains (and Beluga’s own files) never go: declined before anyone is asked', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'klaud-home-'));
    mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'keys');
    const [kay, bob] = await pair('kayK', 'bobK');
    kay.trust(bob.id, 'full');
    bob.trust(kay.id, 'full');
    const t = kay.gw.ask({ person: 'bobK', kind: 'file', ask: '', path: path.join(home, 'Library', 'Keychains', 'login.keychain-db'), by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'declined');
    expect(task(kay, t.id)?.result?.summary).toContain('not allowed');
    expect(bob.approvals).toHaveLength(0);
  }, 60_000);

  it('a friend whose Beluga declines every secret hears so at once', async () => {
    const [kay, bob] = await pair('kayO', 'bobO');
    const can = (f: string): boolean => Boolean(kay.store.getState().network.friends.find((x) => x.peerId === bob.id)?.beluga?.can.includes(f));
    await settle(() => can('task.secret'));
    // bob's Mac says it takes files, but not secrets (as an older Beluga does).
    bob.person.mesh.offer(['task.secret'], false);
    await settle(() => !can('task.secret') && can('task.file'));
    expect(() => kay.gw.ask({ person: 'bobO', kind: 'file', ask: '', path: '~/.ssh/id_rsa', by: 'agent' })).toThrow(/^bobO's Beluga .+ can't send secrets bobO approves yet\. Ask bobO to update Beluga\.$/);
    // Any other file still goes.
    expect(kay.gw.ask({ person: 'bobO', kind: 'file', ask: '', path: '~/notes.md', by: 'person' }).state).toBe('sent');
  }, 60_000);
});

/** Your Claude's gateway tools, as it would call them from conversation `channel`. */
function toolsOf(n: Node, channel = 'ws:abc') {
  const session = { host: { currentChannel: channel, viaIn: () => undefined } } as unknown as Session;
  attachGateway(session, n.gw);
  const defs = createGatewayToolDefs({ gateway: gatewayBridge(session) } as unknown as RoomBridge);
  return async (name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
    const def = defs.find((d) => d.name === name)!;
    const res = await (def.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
    return { text: res.content[0]!.text, error: Boolean(res.isError) };
  };
}

describe('questions from their Claude', () => {
  it('go to your Claude first (wait_for hands it over), its answer goes back, and their Claude carries on', async () => {
    const [kay, bob] = await pair('kayA', 'bobA');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.answer = async (input) => {
      const a = await input.askUser!({ kind: 'question', questions: [{ question: 'Which color for the button?', header: 'Color', options: [{ label: 'blue', description: '' }, { label: 'green', description: '' }], multiSelect: false }] });
      return a.kind === 'answers' ? `Made it ${a.answers['Which color for the button?']}.` : 'Picked one myself.';
    };
    const call = toolsOf(kay);
    const sent = await call('ask_person', { person: 'bobA', ask: 'restyle the button' });
    const id = /Task (t_[\w-]+)/.exec(sent.text)![1]!;
    const asked = await call('wait_for', { task: id, timeout_sec: 30 });
    expect(asked.text).toContain('<task_question from="bobA"');
    expect(asked.text).toContain('Which color for the button?');
    expect(asked.text).toContain('answer_question');
    expect(task(kay, id)?.question?.questions[0]?.options.map((o) => o.label)).toEqual(['blue', 'green']);
    // kayA never saw this task (trusted: it went straight out), so they see the answer first.
    const answered = await call('answer_question', { task: id, answers: ['blue'] });
    expect(answered.error).toBe(false);
    expect(answered.text).toContain("Your user hadn't seen task");
    expect(task(kay, id)?.answerDraft).toMatchObject({ answers: ['blue'] });
    kay.gw.answer(id, task(kay, id)!.answerDraft!.answers, 'person');
    expect(task(kay, id)?.question).toBeUndefined();
    const done = await call('wait_for', { task: id, timeout_sec: 30 });
    expect(done.text).toContain('Made it blue.');
    // Nothing started a turn on its own: wait_for had it.
    expect(kay.resumes).toHaveLength(0);
  }, 60_000);

  it('when your Claude isn’t waiting, a new turn starts with the question; you can also answer (or skip) yourself', async () => {
    const [kay, bob] = await pair('kayB', 'bobB');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.answer = async (input) => {
      const a = await input.askUser!({ kind: 'question', questions: [{ question: 'Deploy now or tonight?', header: '', options: [], multiSelect: false }] });
      return a.kind === 'answers' ? `OK: ${Object.values(a.answers)[0]}` : 'No answer: I will deploy tonight.';
    };
    const t = kay.gw.ask({ person: 'bobB', ask: 'deploy staging', by: 'agent', conversation: 'ws:q1' });
    await settle(() => kay.resumes.length === 1);
    expect(kay.resumes[0]).toMatchObject({ channel: 'ws:q1' });
    expect(kay.resumes[0]!.prompt).toContain("bobB's agent has a question about task");
    expect(kay.resumes[0]!.prompt).toContain('Deploy now or tonight?');
    kay.gw.answer(t.id, 'skip', 'person');
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(task(kay, t.id)?.result?.summary).toBe('No answer: I will deploy tonight.');
    expect(() => kay.gw.answer(t.id, ['now'], 'person')).toThrow('no question');
  }, 60_000);

  it('no answer in time: their Claude goes on with its best judgment', async () => {
    const [kay, bob] = await pair('kayC', 'bobC', { questionWaitMs: 300 });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.answer = async (input) => ((await input.askUser!({ kind: 'question', questions: [{ question: 'Sure?', header: '', options: [], multiSelect: false }] })).kind === 'skip' ? 'Went ahead.' : 'Asked.');
    const t = kay.gw.ask({ person: 'bobC', ask: 'do it', by: 'person' });
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(task(kay, t.id)?.result?.summary).toBe('Went ahead.');
    expect(task(bob, t.id)?.steps).toContain('No answer from kayC: going on');
  }, 60_000);
});
