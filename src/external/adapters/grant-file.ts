import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../../core/home.js';
import { canHold, LEVELS, ROUTES } from '../domain/decide.js';
import { DEFAULT_CHATS, isExpired, type Grant, type NewGrant } from '../domain/grant.js';
import { isLocalAudience } from '../domain/reach.js';
import type { GrantStore, RefreshUse } from '../ports/grant-store.js';

/**
 * External agents' grants, in ~/.beluga/external-agents.json (0600). Only tokens' hashes are kept.
 * A grant the file can't hold (a remote full, from a hand edit) doesn't load; the others do.
 */

const MAX_GRANTS = 100;
/** Tokens a grant holds at once (the oldest goes). */
const MAX_TOKENS = 8;
/** last seen is written at most this often per grant. */
const SEEN_EVERY_MS = 60_000;
/** Spent refresh tokens a grant remembers: showing one again ends the grant. */
const MAX_SPENT = 64;

export const grantFilePath = (): string => path.join(belugaHome(), 'external-agents.json');

const Stored = z
  .object({
    id: z.string().regex(/^[a-f0-9]{8,32}$/),
    name: z.string().min(1).max(80),
    clientId: z.string().max(4096),
    redirectHost: z.string().max(253),
    route: z.enum(ROUTES),
    level: z.enum(LEVELS),
    projects: z.union([z.literal('all'), z.array(z.string().max(200)).max(200)]),
    chats: z.object({ dms: z.boolean(), groups: z.boolean() }),
    createdAt: z.number(),
    expiresAt: z.number(),
    lastSeen: z.number(),
    allowRemoteFull: z.boolean().optional(),
    suspendedAt: z.number().optional(),
    tokenHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_TOKENS),
    refresh: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), audience: z.string().max(300), spent: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_SPENT) }).optional(),
  })
  .refine((g) => canHold(g.route, g.level, g.allowRemoteFull), 'A remote agent holds full trust only by an explicit choice');
type Stored = z.infer<typeof Stored>;
const StoredFile = z.object({ grants: z.array(z.unknown()) });

export interface GrantFileOptions {
  readonly file?: string;
  readonly now?: () => number;
  /** A grant just ended, whatever ended it: a person, or a code or token that came back. */
  readonly onRevoked?: (id: string) => void;
}

export class GrantFile implements GrantStore {
  private grants: readonly Stored[] = [];
  /** Access tokens live in memory only: after a restart a client refreshes. */
  private readonly access = new Map<string, { readonly id: string; readonly audience: string; readonly expiresAt: number }>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly onRevoked: ((id: string) => void) | undefined;

  constructor(opts: GrantFileOptions = {}) {
    this.file = opts.file ?? grantFilePath();
    this.now = opts.now ?? Date.now;
    this.onRevoked = opts.onRevoked;
    this.load();
  }

  create(grant: NewGrant): { grant: Grant; token: string } {
    if (!canHold(grant.route, grant.level, grant.allowRemoteFull)) throw new Error('A remote agent holds full trust only by an explicit choice');
    const now = this.now();
    const live = this.grants.length < MAX_GRANTS ? this.grants : this.grants.filter((g) => !isExpired(g, now));
    if (live.length >= MAX_GRANTS) throw new Error(`Too many external agents (${MAX_GRANTS}): revoke one first`);
    const token = newToken();
    const stored = Stored.parse({ chats: DEFAULT_CHATS, ...grant, id: randomBytes(6).toString('hex'), createdAt: now, lastSeen: now, tokenHashes: [sha256(token)] });
    this.grants = [...live, stored];
    this.save();
    return { grant: info(stored), token };
  }

  addToken(id: string): string | undefined {
    const found = this.grants.find((g) => g.id === id);
    if (!found || isExpired(found, this.now())) return undefined;
    const token = newToken();
    this.replace({ ...found, tokenHashes: [...found.tokenHashes, sha256(token)].slice(-MAX_TOKENS) });
    return token;
  }

  issueAccess(id: string, audience: string, ttlMs: number): string | undefined {
    const now = this.now();
    const found = this.grants.find((g) => g.id === id);
    if (!found || isExpired(found, now)) return undefined;
    for (const [hash, held] of this.access) if (held.expiresAt <= now) this.access.delete(hash);
    const token = newToken();
    this.access.set(sha256(token), { id, audience, expiresAt: now + ttlMs });
    return token;
  }

  issueRefresh(id: string, audience: string): string | undefined {
    const found = this.grants.find((g) => g.id === id);
    if (!found || isExpired(found, this.now())) return undefined;
    const token = newToken();
    const spent = found.refresh ? [...found.refresh.spent, found.refresh.hash].slice(-MAX_SPENT) : [];
    this.replace({ ...found, refresh: { hash: sha256(token), audience, spent } });
    return token;
  }

  useRefresh(token: string): RefreshUse | undefined {
    if (!token || token.length > 200) return undefined;
    const hash = sha256(token);
    const found = this.grants.find((g) => g.refresh?.hash === hash || g.refresh?.spent.includes(hash));
    if (!found?.refresh) return undefined;
    if (found.refresh.hash !== hash) {
      this.revoke(found.id);
      return 'reused';
    }
    return isExpired(found, this.now()) ? undefined : { grant: info(found), audience: found.refresh.audience };
  }

  lookup(token: string, audience?: string): Grant | undefined {
    if (!token || token.length > 200) return undefined;
    const hash = sha256(token);
    const now = this.now();
    const held = this.access.get(hash);
    const heldLive = held && held.expiresAt > now && held.audience === audience;
    // A long-lived token is for a client on this computer: it means nothing through a route.
    const localHere = audience === undefined || isLocalAudience(audience);
    const found = this.grants.find((g) => (heldLive ? g.id === held.id : localHere && g.tokenHashes.includes(hash)));
    if (!found || isExpired(found, now)) return undefined;
    if (now - found.lastSeen < SEEN_EVERY_MS) return info(found);
    const seen = { ...found, lastSeen: now };
    this.replace(seen);
    return info(seen);
  }

  heldElsewhere(token: string, audience: string): boolean {
    if (!token || token.length > 200) return false;
    const hash = sha256(token);
    const now = this.now();
    const held = this.access.get(hash);
    if (held && held.expiresAt > now && held.audience !== audience) return this.grants.some((g) => g.id === held.id && !isExpired(g, now));
    return !isLocalAudience(audience) && this.grants.some((g) => g.tokenHashes.includes(hash) && !isExpired(g, now));
  }

  list(): Grant[] {
    return this.grants.map(info);
  }

  revoke(id: string): boolean {
    const left = this.grants.filter((g) => g.id !== id);
    if (left.length === this.grants.length) return false;
    this.grants = left;
    for (const [hash, held] of this.access) if (held.id === id) this.access.delete(hash);
    this.save();
    this.onRevoked?.(id);
    return true;
  }

  setSuspended(id: string, at: number | undefined): boolean {
    const found = this.grants.find((g) => g.id === id);
    if (!found) return false;
    const { suspendedAt: _was, ...rest } = found;
    this.replace(at === undefined ? rest : { ...rest, suspendedAt: at });
    return true;
  }

  private replace(next: Stored): void {
    this.grants = this.grants.map((g) => (g.id === next.id ? next : g));
    this.save();
  }

  private load(): void {
    try {
      const parsed = StoredFile.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) return;
      this.grants = parsed.data.grants.flatMap((g) => {
        const one = Stored.safeParse(g);
        return one.success ? [one.data] : [];
      }).slice(0, MAX_GRANTS);
    } catch {
      // None yet.
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ grants: this.grants }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');

const info = ({ tokenHashes: _hashes, refresh: _refresh, ...grant }: Stored): Grant => grant;
