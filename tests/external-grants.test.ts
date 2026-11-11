import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditFile } from '../src/external/adapters/audit-file.js';
import { GrantFile } from '../src/external/adapters/grant-file.js';
import type { AuditEntry } from '../src/external/domain/audit.js';
import type { NewGrant } from '../src/external/domain/grant.js';
import type { AuditLog } from '../src/external/ports/audit-log.js';
import type { GrantStore } from '../src/external/ports/grant-store.js';

const DAY = 24 * 60 * 60_000;
const SECRET = 'sk_' + 'live_abcdefghijklmnopqrstuvwx';

let dir: string;
let clock: number;
const now = (): number => clock;
const mode = (file: string): number => statSync(file).mode & 0o777;

const newGrant = (over: Partial<NewGrant> = {}): NewGrant => ({
  name: 'GrokBot',
  clientId: 'client-1',
  redirectHost: '127.0.0.1',
  route: 'local',
  level: 'trusted',
  projects: ['beluga'],
  expiresAt: clock + DAY,
  ...over,
});

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  agent: 'grant-1',
  tool: 'beluga_chat_send',
  class: 'launch_or_send',
  target: 'chat:abc',
  decision: 'allow',
  decidedBy: 'rule',
  result: 'ok',
  durationMs: 12,
  args: { chat: 'abc' },
  summary: 'Sent in a chat',
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-grants-'));
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each<[string, () => GrantStore]>([['GrantFile', () => new GrantFile({ file: path.join(dir, 'grants.json'), now })]])('GrantStore contract: %s', (_name, makeStore) => {
  it('finds a grant by the token it gave out, and not by another', () => {
    const store = makeStore();
    const { grant, token } = store.create(newGrant());
    expect(store.lookup(token)?.id).toBe(grant.id);
    expect(store.lookup('not-the-token')).toBeUndefined();
    expect(store.lookup('')).toBeUndefined();
  });

  it('keeps DMs and groups off by default', () => {
    expect(makeStore().create(newGrant()).grant.chats).toEqual({ dms: false, groups: false });
  });

  it('never gives its token hashes to a caller', () => {
    const store = makeStore();
    const { grant, token } = store.create(newGrant());
    for (const g of [grant, store.lookup(token), store.list()[0]]) expect(g).not.toHaveProperty('tokenHashes');
  });

  it('forgets a revoked grant at once', () => {
    const store = makeStore();
    const { grant, token } = store.create(newGrant());
    expect(store.revoke(grant.id)).toBe(true);
    expect(store.lookup(token)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.revoke(grant.id)).toBe(false);
  });

  it('fails lookup for an expired grant', () => {
    const store = makeStore();
    const { token } = store.create(newGrant());
    clock += DAY - 1;
    expect(store.lookup(token)).toBeDefined();
    clock += 1;
    expect(store.lookup(token)).toBeUndefined();
  });

  it('refuses a remote grant at full with no explicit choice, and allows one with it, or at trusted', () => {
    const store = makeStore();
    expect(() => store.create(newGrant({ route: 'remote', level: 'full' }))).toThrow(/remote/i);
    expect(store.list()).toEqual([]);
    expect(store.create(newGrant({ route: 'remote', level: 'trusted' })).grant.level).toBe('trusted');
    expect(store.create(newGrant({ route: 'remote', level: 'full', allowRemoteFull: true })).grant).toMatchObject({ route: 'remote', level: 'full' });
  });

  it('gives a second token that works beside the first, not for an unknown or expired grant', () => {
    const store = makeStore();
    const { grant, token } = store.create(newGrant());
    const second = store.addToken(grant.id);
    expect(second).toBeDefined();
    expect(store.lookup(second ?? '')?.id).toBe(grant.id);
    expect(store.lookup(token)?.id).toBe(grant.id);
    expect(store.addToken('unknown')).toBeUndefined();
    clock += DAY;
    expect(store.addToken(grant.id)).toBeUndefined();
  });

  it('notes when a grant was last seen', () => {
    const store = makeStore();
    const { token, grant } = store.create(newGrant());
    expect(grant.lastSeen).toBe(clock);
    clock += 120_000;
    expect(store.lookup(token)?.lastSeen).toBe(clock);
  });
});

describe('GrantFile', () => {
  const file = (): string => path.join(dir, 'grants.json');
  const make = (): GrantFile => new GrantFile({ file: file(), now });

  it('writes 0600 and only hashes of tokens', () => {
    const store = make();
    const { grant, token } = store.create(newGrant());
    const second = store.addToken(grant.id) ?? '';
    if (process.platform !== 'win32') expect(mode(file())).toBe(0o600);
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain(token);
    expect(text).not.toContain(second);
    expect(JSON.parse(text).grants[0].tokenHashes).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it('keeps grants across a restart, and a revoke too', () => {
    const { grant, token } = make().create(newGrant());
    const other = make().create(newGrant({ name: 'Other' }));
    expect(make().lookup(token)?.id).toBe(grant.id);
    make().revoke(grant.id);
    expect(make().lookup(token)).toBeUndefined();
    expect(make().lookup(other.token)?.name).toBe('Other');
  });

  it('a remote full grant made by an explicit choice survives a reload', () => {
    const { grant, token } = make().create(newGrant({ route: 'remote', level: 'full', allowRemoteFull: true }));
    expect(make().list()).toMatchObject([{ id: grant.id, route: 'remote', level: 'full', allowRemoteFull: true }]);
    expect(make().lookup(token)?.level).toBe('full');
  });

  it('does not load a remote grant raised to full in a hand-edited file, and keeps the others', () => {
    const store = make();
    const a = store.create(newGrant({ route: 'remote', level: 'trusted' }));
    const b = store.create(newGrant({ name: 'Good' }));
    const onDisk = JSON.parse(readFileSync(file(), 'utf8'));
    onDisk.grants[0].level = 'full';
    writeFileSync(file(), JSON.stringify(onDisk));
    const reloaded = make();
    expect(reloaded.lookup(a.token)).toBeUndefined();
    expect(reloaded.lookup(b.token)?.name).toBe('Good');
  });

  it('starts empty on a broken file, and refuses a new grant past the cap', () => {
    writeFileSync(file(), 'not json');
    const store = make();
    expect(store.list()).toEqual([]);
    for (let i = 0; i < 100; i++) store.create(newGrant());
    expect(() => store.create(newGrant())).toThrow(/too many/i);
    clock += DAY;
    expect(store.create(newGrant({ expiresAt: clock + DAY })).grant.name).toBe('GrokBot');
    expect(store.list()).toHaveLength(1);
  });
});

describe.each<[string, () => AuditLog]>([['AuditFile', () => new AuditFile({ file: path.join(dir, 'audit.jsonl'), now })]])('AuditLog contract: %s', (_name, makeLog) => {
  it('gives back what it recorded, newest first, with each field', () => {
    const log = makeLog();
    log.append(entry({ tool: 'beluga_chat_read', class: 'read' }));
    clock += 1;
    log.append(entry({ decision: 'deny', result: 'level_denied', decidedBy: 'person' }));
    const [latest, first] = log.recent(10);
    expect(first?.tool).toBe('beluga_chat_read');
    expect(latest).toMatchObject({ ts: clock, agent: 'grant-1', tool: 'beluga_chat_send', class: 'launch_or_send', target: 'chat:abc', decision: 'deny', decidedBy: 'person', result: 'level_denied', durationMs: 12, summary: 'Sent in a chat' });
    expect(latest?.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(log.recent(1)).toHaveLength(1);
  });

  it('hashes the same arguments the same way, in any key order', () => {
    const log = makeLog();
    log.append(entry({ args: { a: 1, b: { c: 2, d: 3 } } }));
    log.append(entry({ args: { b: { d: 3, c: 2 }, a: 1 } }));
    log.append(entry({ args: { a: 2, b: { c: 2, d: 3 } } }));
    const [third, second, first] = log.recent(3);
    expect(first?.argsHash).toBe(second?.argsHash);
    expect(first?.argsHash).not.toBe(third?.argsHash);
  });

  it('records a call with no arguments', () => {
    const log = makeLog();
    log.append(entry({ args: undefined }));
    expect(log.recent(1)[0]?.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never holds a raw argument value, even when the caller repeats one', () => {
    const log = makeLog();
    const args = { apiKey: 'hunter2', note: `use ${SECRET} please`, nested: [{ prompt: 'the private plan for launch' }], chat: 'abc', limit: 12345 };
    log.append(
      entry({
        args,
        target: `chat:abc hunter2 ${SECRET} the private plan for launch`,
        summary: `Sent the private plan for launch with hunter2, ${SECRET}, use ${SECRET} please, limit 12345`,
      }),
    );
    const record = log.recent(1)[0];
    const stored = JSON.stringify(record);
    for (const raw of ['hunter2', SECRET, 'the private plan for launch', '12345']) expect(stored).not.toContain(raw);
    expect(record?.target).toContain('chat:abc');
    expect(record?.summary).toContain('[redacted]');
  });

  it('redacts a secret in the summary that no argument holds', () => {
    const log = makeLog();
    log.append(entry({ summary: `Failed with TOKEN=abc123xyz and ${SECRET}` }));
    const summary = log.recent(1)[0]?.summary ?? '';
    expect(summary).not.toContain('abc123xyz');
    expect(summary).not.toContain(SECRET);
  });

  it('keeps a summary and a target small', () => {
    const log = makeLog();
    log.append(entry({ summary: 'x'.repeat(5000), target: 'y'.repeat(5000) }));
    const record = log.recent(1)[0];
    expect(record?.summary.length).toBeLessThanOrEqual(300);
    expect(record?.target.length).toBeLessThanOrEqual(200);
  });
});

describe('AuditFile', () => {
  const file = (): string => path.join(dir, 'audit.jsonl');

  it('writes one JSON line per decision, 0600, and restores the mode if it was opened up', () => {
    const log = new AuditFile({ file: file(), now });
    log.append(entry());
    if (process.platform !== 'win32') expect(mode(file())).toBe(0o600);
    log.append(entry());
    expect(readFileSync(file(), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l).tool)).toEqual(['beluga_chat_send', 'beluga_chat_send']);
    chmodSync(file(), 0o644);
    log.append(entry());
    if (process.platform !== 'win32') expect(mode(file())).toBe(0o600);
  });

  it('keeps no raw argument value and no args key in the raw file', () => {
    // Reads the file itself: recent() parses each line through a schema that drops unknown keys.
    const prose = 'the private plan for launch';
    new AuditFile({ file: file(), now }).append(
      entry({
        args: { apiKey: 'hunter2', note: `use ${SECRET} please`, nested: [{ prompt: prose }] },
        target: `chat:abc hunter2 ${SECRET} ${prose}`,
        summary: `Sent ${prose} with hunter2 and ${SECRET}`,
      }),
    );
    const raw = readFileSync(file(), 'utf8');
    expect(JSON.parse(raw)).toHaveProperty('argsHash');
    for (const value of ['hunter2', SECRET, prose]) expect(raw).not.toContain(value);
    expect(raw).not.toContain('"args"');
  });

  it('appends, and leaves what was there', () => {
    new AuditFile({ file: file(), now }).append(entry({ tool: 'first' }));
    new AuditFile({ file: file(), now }).append(entry({ tool: 'second' }));
    expect(new AuditFile({ file: file(), now }).recent(10).map((r) => r.tool)).toEqual(['second', 'first']);
  });

  it('rotates at its size cap, keeps one old file at 0600, and still reads both', () => {
    const log = new AuditFile({ file: file(), now, maxBytes: 600 });
    for (let i = 0; i < 6; i++) log.append(entry({ tool: `tool-${i}` }));
    expect(statSync(file()).size).toBeLessThanOrEqual(600);
    if (process.platform !== 'win32') expect(mode(`${file()}.1`)).toBe(0o600);
    const tools = log.recent(100).map((r) => r.tool);
    expect(tools[0]).toBe('tool-5');
    expect(tools.length).toBeGreaterThan(2);
    expect(tools).toEqual([...tools].sort().reverse());
  });

  it('skips a line it cannot read', () => {
    const log = new AuditFile({ file: file(), now });
    log.append(entry({ tool: 'good' }));
    writeFileSync(file(), `not json\n{"ts":1}\n${readFileSync(file(), 'utf8')}`);
    expect(log.recent(10).map((r) => r.tool)).toEqual(['good']);
  });

  it('reads nothing when there is no file yet', () => {
    expect(new AuditFile({ file: file(), now }).recent(10)).toEqual([]);
  });
});
