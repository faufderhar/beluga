import { type KeyObject, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Box } from '../protocol.js';

/** Keys derived from the room secret. The secret itself never goes on the wire. */
export interface RoomKeys {
  readonly enc: Buffer;
  readonly auth: Buffer;
}

export function generateSecret(): string {
  // 144 bits: plenty for HKDF-derived keys, short enough to paste comfortably.
  return randomBytes(18).toString('base64url');
}

export function deriveKeys(secret: string): RoomKeys {
  if (secret.length < 16) throw new Error('Room secret is too short');
  const ikm = Buffer.from(secret, 'utf8');
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', ikm, Buffer.from('klaude-v1'), Buffer.from(info), 32));
  return { enc: derive('enc'), auth: derive('auth') };
}

export function seal(keys: RoomKeys, value: unknown): Box {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Decrypt a box. Returns undefined when tampered with or encrypted for another room. */
export function open(keys: RoomKeys, box: Box): unknown {
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function newNonce(): string {
  return randomBytes(24).toString('base64');
}

export function proveNonce(keys: RoomKeys, nonce: string, peerId: string): string {
  return createHmac('sha256', keys.auth).update(`${nonce}:${peerId}`).digest('base64');
}

export function verifyProof(keys: RoomKeys, nonce: string, peerId: string, proof: string): boolean {
  const expected = Buffer.from(proveNonce(keys, nonce, peerId), 'base64');
  const actual = Buffer.from(proof, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Each person's own signing key for this run. Their peer id is derived from the public
 * key, so nobody else (not even someone holding the invite) can claim it.
 */
export interface Identity {
  /** base64 SPKI DER of the Ed25519 public key. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
  readonly peerId: string;
}

export function peerIdFor(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url').slice(0, 32);
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: pub, privateKey, peerId: peerIdFor(pub) };
}

function identityFrom(privateKey: KeyObject): Identity {
  const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: pub, privateKey, peerId: peerIdFor(pub) };
}

/** An identity from its private key's PEM (as identity.json keeps it); throws when it isn't one. */
export function identityFromPem(pem: string): Identity {
  return identityFrom(createPrivateKey(pem));
}

/** The PEM identity.json keeps: the only form your identity ever travels in (BLG-796, over your own end-to-end link). */
export const identityPem = (identity: Identity): string => identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/**
 * Your long-lived identity, kept in ~/.beluga/identity.json (readable only by you). It lets
 * friends recognize you across sessions, so the trust level they gave you comes back.
 * A missing file is created. A file that is there but can't be read or isn't a key is left
 * as it is: replacing it would silently change your peer id, and the trust tied to it.
 */
export function loadIdentity(file: string): Identity {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Not there yet: make one. A path that can't exist (the parent is a file) stays a one-off.
    if (code === 'ENOENT') return createIdentity(file);
    if (code === 'ENOTDIR') return generateIdentity();
    throw new Error(`Identity file ${file} is unreadable (${code ?? 'error'})`);
  }
  try {
    const raw = JSON.parse(text) as { privateKey?: unknown };
    if (typeof raw?.privateKey !== 'string' || !raw.privateKey) throw new Error('missing key');
    return identityFrom(createPrivateKey(raw.privateKey));
  } catch {
    throw new Error(`Identity file ${file} is invalid: not a key`);
  }
}

/** A new identity.json (0600, written whole or not at all). If it can't be saved, a one-off for this run. */
function createIdentity(file: string): Identity {
  const fresh = generateIdentity();
  try {
    saveIdentity(file, fresh);
  } catch {
    try {
      unlinkSync(`${file}.${process.pid}.tmp`);
    } catch {
      // Nothing was written.
    }
  }
  return fresh;
}

/** Keep `identity` as identity.json (0600, written whole or not at all). */
export function saveIdentity(file: string, identity: Identity): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ privateKey: identityPem(identity) })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * What a message signature covers: the whole sealed box (a hash of it; the GCM tag alone isn't
 * enough, since everyone in the room holds the key) and who it's for.
 */
const signed = (box: Box, to: string): Buffer => Buffer.from(`klaud-msg:${createHash('sha256').update(box.iv).update(':').update(box.ct).update(':').update(box.tag).digest('base64')}:${to}`);

/** Sign one sealed message so nobody (not even the room's host) can send it in your name. */
export function signBox(identity: Identity, box: Box, to = ''): string {
  return sign(null, signed(box, to), identity.privateKey).toString('base64');
}

export function verifyBox(publicKey: string, peerId: string, box: Box, signature: string, to = ''): boolean {
  try {
    if (peerIdFor(publicKey) !== peerId) return false;
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, signed(box, to), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Sign the hub's challenge (bound to the peer id) with your own key. */
export function signNonce(identity: Identity, nonce: string): string {
  return sign(null, Buffer.from(`klaude-id:${nonce}:${identity.peerId}`), identity.privateKey).toString('base64');
}

export function verifyNonce(publicKey: string, nonce: string, peerId: string, signature: string): boolean {
  try {
    if (peerIdFor(publicKey) !== peerId) return false;
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`klaude-id:${nonce}:${peerId}`), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
