import type { Grant, NewGrant } from '../domain/grant.js';

/** A refresh token as it was shown: live, for this grant and audience, or spent before (which ended the grant). */
export type RefreshUse = { readonly grant: Grant; readonly audience: string } | 'reused';

/** Where grants live. A token is shown once, when it is made; only its hash is kept. */
export interface GrantStore {
  /** Throws for a grant its route can't hold (a remote full) or when there are too many. */
  create(grant: NewGrant): { readonly grant: Grant; readonly token: string };
  /** One more token for a live grant, or undefined when there is none. */
  addToken(id: string): string | undefined;
  /** A short-lived token good only at this audience (RFC 8707), or undefined for no live grant. */
  issueAccess(id: string, audience: string, ttlMs: number): string | undefined;
  /** The grant's one refresh token: the one before it is spent. Undefined for no live grant. */
  issueRefresh(id: string, audience: string): string | undefined;
  /** What this refresh token is. A spent one ends its grant. It doesn't spend it: issueRefresh does. */
  useRefresh(token: string): RefreshUse | undefined;
  /**
   * The live grant this token belongs to, at this audience; undefined once it is revoked or expired,
   * or when it's an access token for another audience, or a local token at a remote one. A refresh
   * token is never one. Notes it was seen.
   */
  lookup(token: string, audience?: string): Grant | undefined;
  /** A live token that lookup refuses at this audience because it belongs to another address. */
  heldElsewhere(token: string, audience: string): boolean;
  list(): Grant[];
  /** Takes effect at once. False when there is no such grant. */
  revoke(id: string): boolean;
  /** Marks it suspended, or lifts that (undefined). False when there is no such grant. */
  setSuspended(id: string, at: number | undefined): boolean;
}
