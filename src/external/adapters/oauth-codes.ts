import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_CODE_MS, PAIRING_CODE_MS, type PairingSpec } from '../domain/oauth.js';

/** The sign-in's secrets, in memory and as hashes only: pairing codes, authorization codes and PKCE. */

const CODES_MAX = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** One-time codes, held only as hashes, gone with the daemon. */
export class PairingCodes {
  private codes: ReadonlyArray<{ readonly hash: string; readonly spec: PairingSpec; readonly expiresAt: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  create(spec: PairingSpec): { readonly code: string; readonly expiresAt: number } {
    const code = newCode();
    const expiresAt = this.now() + PAIRING_CODE_MS;
    this.codes = [...this.live(), { hash: hashOf(normalize(code)), spec, expiresAt }].slice(-CODES_MAX);
    return { code, expiresAt };
  }

  /** What the code gives, and it stays good. */
  peek(code: string): PairingSpec | undefined {
    const hash = hashOf(normalize(code));
    return this.live().find((c) => c.hash === hash)?.spec;
  }

  /** What the code gives, once. Case and separators don't matter. */
  spend(code: string): PairingSpec | undefined {
    const hash = hashOf(normalize(code));
    const found = this.live().find((c) => c.hash === hash);
    if (!found) return undefined;
    this.codes = this.codes.filter((c) => c !== found);
    return found.spec;
  }

  private live(): typeof this.codes {
    const now = this.now();
    return this.codes.filter((c) => c.expiresAt > now);
  }
}

/** What an authorization code was given for. */
export interface AuthCodeRecord {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string;
}

export type AuthCodeUse = { readonly outcome: 'ok' | 'reused'; readonly record: AuthCodeRecord } | { readonly outcome: 'unknown' };

/** Authorization codes: one use, a minute. A used one stays known a while, so reuse can be told apart. */
export class AuthCodes {
  private readonly codes = new Map<string, { readonly record: AuthCodeRecord; readonly expiresAt: number; used: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(record: AuthCodeRecord): string {
    const now = this.now();
    for (const [hash, held] of this.codes) if (held.expiresAt + AUTH_CODE_MS * 10 <= now) this.codes.delete(hash);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(hashOf(code), { record, expiresAt: now + AUTH_CODE_MS, used: false });
    return code;
  }

  use(code: string): AuthCodeUse {
    const held = this.codes.get(hashOf(code));
    if (!held) return { outcome: 'unknown' };
    if (held.used) return { outcome: 'reused', record: held.record };
    if (held.expiresAt <= this.now()) return { outcome: 'unknown' };
    held.used = true;
    return { outcome: 'ok', record: held.record };
  }
}

export const validChallenge = (challenge: string): boolean => CHALLENGE.test(challenge);

/** RFC 7636 S256, the only method taken. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const made = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const want = Buffer.from(challenge);
  return made.length === want.length && timingSafeEqual(made, want);
}

function newCode(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  out += BASE32[(value << (5 - bits)) & 31];
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

const normalize = (code: string): string => code.toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
