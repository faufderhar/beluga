import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveKeys, generateIdentity, generateSecret, loadIdentity, peerIdFor, seal, signBox, signNonce, verifyBox, verifyNonce } from '../src/net/crypto.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'klaude-identity-'));
});

describe('loadIdentity', () => {
  it('creates a private 0600 file and returns the same peer id next time', () => {
    const file = path.join(dir, 'sub', 'identity.json');
    const first = loadIdentity(file);
    expect(existsSync(file)).toBe(true);
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).privateKey).toMatch(/BEGIN PRIVATE KEY/);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    const second = loadIdentity(file);
    expect(second.peerId).toBe(first.peerId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.peerId).toBe(peerIdFor(first.publicKey));
    expect(first.peerId).toHaveLength(32);
  });

  it('leaves a corrupt identity file unchanged and writes no new key', () => {
    const file = path.join(dir, 'identity.json');
    writeFileSync(file, '{broken');
    expect(() => loadIdentity(file)).toThrow(/invalid/i);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('leaves an identity file with a missing or invalid key unchanged', () => {
    const file = path.join(dir, 'identity.json');
    writeFileSync(file, JSON.stringify({}));
    expect(() => loadIdentity(file)).toThrow(/invalid/i);
    expect(readFileSync(file, 'utf8')).toBe('{}');
    const bad = JSON.stringify({ privateKey: 'not a pem' });
    writeFileSync(file, bad);
    expect(() => loadIdentity(file)).toThrow(/invalid/i);
    expect(readFileSync(file, 'utf8')).toBe(bad);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('does not replace an identity file it cannot read', () => {
    if (process.platform === 'win32') return;
    const file = path.join(dir, 'identity.json');
    writeFileSync(file, '{broken');
    chmodSync(file, 0);
    try {
      expect(() => loadIdentity(file)).toThrow(/unreadable/i);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('still returns a working one-off identity when it cannot save', () => {
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'identity.json');
    const id = loadIdentity(file);
    expect(id.peerId).toBe(peerIdFor(id.publicKey));
    expect(loadIdentity(file).peerId).not.toBe(id.peerId);
  });
});

describe('signBox / verifyBox', () => {
  const keys = deriveKeys(generateSecret());
  const me = generateIdentity();
  const box = seal(keys, { text: 'hello' });

  it('round-trips with and without a recipient', () => {
    expect(verifyBox(me.publicKey, me.peerId, box, signBox(me, box))).toBe(true);
    expect(verifyBox(me.publicKey, me.peerId, box, signBox(me, box, 'bob'), 'bob')).toBe(true);
  });

  it('fails for a different key', () => {
    const other = generateIdentity();
    const sig = signBox(me, box);
    expect(verifyBox(other.publicKey, other.peerId, box, sig)).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, box, signBox(other, box))).toBe(false);
  });

  it('fails when the ciphertext, iv or tag is tampered with', () => {
    const sig = signBox(me, box);
    const ct = Buffer.from(box.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    expect(verifyBox(me.publicKey, me.peerId, { ...box, ct: ct.toString('base64') }, sig)).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, { ...box, iv: seal(keys, 'x').iv }, sig)).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, { ...box, tag: seal(keys, 'x').tag }, sig)).toBe(false);
  });

  it('fails for a different recipient', () => {
    const sig = signBox(me, box, 'bob');
    expect(verifyBox(me.publicKey, me.peerId, box, sig, 'carol')).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, box, sig)).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, box, signBox(me, box), 'bob')).toBe(false);
  });

  it("fails when the peer id doesn't match the key", () => {
    const other = generateIdentity();
    expect(verifyBox(me.publicKey, other.peerId, box, signBox(me, box))).toBe(false);
  });

  it('fails (without throwing) on a malformed key or signature', () => {
    const junk = Buffer.from('junk').toString('base64');
    expect(verifyBox(junk, peerIdFor(junk), box, signBox(me, box))).toBe(false);
    expect(verifyBox(me.publicKey, me.peerId, box, 'AAAA')).toBe(false);
  });

  it('works with an identity reloaded from disk', () => {
    const file = path.join(dir, 'identity.json');
    const saved = loadIdentity(file);
    const sig = signBox(saved, box, 'bob');
    const again = loadIdentity(file);
    expect(verifyBox(again.publicKey, again.peerId, box, sig, 'bob')).toBe(true);
  });
});

describe('signNonce / verifyNonce', () => {
  const me = generateIdentity();

  it('round-trips and is bound to the nonce, peer id and key', () => {
    const sig = signNonce(me, 'n1');
    expect(verifyNonce(me.publicKey, 'n1', me.peerId, sig)).toBe(true);
    expect(verifyNonce(me.publicKey, 'n2', me.peerId, sig)).toBe(false);
    const other = generateIdentity();
    expect(verifyNonce(me.publicKey, 'n1', other.peerId, sig)).toBe(false);
    expect(verifyNonce(other.publicKey, 'n1', other.peerId, sig)).toBe(false);
    const junk = Buffer.from('junk').toString('base64');
    expect(verifyNonce(junk, 'n1', peerIdFor(junk), sig)).toBe(false);
  });
});

describe('a broken identity.json at start', () => {
  it('starts with a one-off identity, leaves the file as it is and says where it is', async () => {
    const { identitiesAtStart } = await import('../src/machines/identity-load.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-identity-start-'));
    const file = path.join(dir, 'identity.json');
    writeFileSync(file, 'not json');
    const said: string[] = [];
    const { local, you } = identitiesAtStart(dir, (m) => said.push(m));
    expect(local.peerId).toBeTruthy();
    expect(you.peerId).toBe(local.peerId);
    expect(readFileSync(file, 'utf8')).toBe('not json');
    expect(said.join('\n')).toContain(file);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('identity.json read again after a handover', () => {
  it('falls back to a one-off identity and says why when the kept file is broken', async () => {
    const { identityOrOneOff } = await import('../src/machines/identity-load.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-identity-letgo-'));
    const file = path.join(dir, 'identity.json');
    writeFileSync(file, '{broken');
    const said: string[] = [];
    expect(identityOrOneOff(file, (m) => said.push(m)).peerId).toHaveLength(32);
    expect(said.join('\n')).toMatch(/invalid/i);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    // A good file is read as it is, with nothing said.
    const fresh = path.join(dir, 'fresh.json');
    const good = loadIdentity(fresh);
    expect(identityOrOneOff(fresh, (m) => said.push(m)).peerId).toBe(good.peerId);
    expect(said).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
