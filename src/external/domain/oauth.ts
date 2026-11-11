import type { ChatScope, ProjectScope } from './grant.js';
import type { Level, Route } from './decide.js';

/**
 * Signing in an external agent, without I/O: how long things last, what a pairing code gives, and
 * the redirect rules. The owner chooses a level and projects when making a code; the sign-in page only spends it.
 */

export const SIGN_IN_MS = 30 * 24 * 60 * 60_000;
export const ACCESS_MS = 60 * 60_000;
export const PAIRING_CODE_MS = 10 * 60_000;
export const AUTH_CODE_MS = 60_000;

/** What a pairing code gives. It never comes from a client or the page. */
export interface PairingSpec {
  readonly level: Exclude<Level, 'blocked'>;
  readonly projects: ProjectScope;
  readonly chats?: ChatScope;
  /** For an agent outside this computer: its grant is remote wherever it signs in. */
  readonly remote?: boolean;
  /** With remote at full: the owner chose this for this one code. Never a default or a remembered setting. */
  readonly allowRemoteFull?: boolean;
}

/** Failed attempts allowed per address, and in all, per window: a 128-bit secret can't be guessed, but nobody gets to try. */
export class SignInLimiter {
  private failures: ReadonlyArray<{ readonly at: number; readonly who: string }> = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly perAddress = 10,
    private readonly total = 50,
    private readonly windowMs = 10 * 60_000,
  ) {}

  allowed(who: string): boolean {
    const since = this.now() - this.windowMs;
    this.failures = this.failures.filter((f) => f.at > since);
    return this.failures.length < this.total && this.failures.filter((f) => f.who === who).length < this.perAddress;
  }

  failed(who: string): void {
    this.failures = [...this.failures, { at: this.now(), who }];
  }

  /** The total is used up: nobody gets a try until old failures leave the window. */
  locked(): boolean {
    const since = this.now() - this.windowMs;
    return this.failures.filter((f) => f.at > since).length >= this.total;
  }
}

/** A redirect a client may register: http on a loopback address, or https. Nothing else, no fragment. */
export function allowedRedirect(uri: string): boolean {
  const url = parsed(uri);
  if (!url || url.hash || url.username || url.password) return false;
  return url.protocol === 'https:' || isLoopbackHttp(url);
}

/** RFC 8252: a loopback redirect matches on any port; anything else matches exactly. */
export function redirectMatches(uri: string, registered: readonly string[]): boolean {
  const url = parsed(uri);
  if (!url || !allowedRedirect(uri)) return false;
  if (!isLoopbackHttp(url)) return registered.includes(uri);
  return registered.some((r) => {
    const reg = parsed(r);
    return reg !== undefined && isLoopbackHttp(reg) && reg.hostname === url.hostname && reg.pathname === url.pathname && reg.search === url.search;
  });
}

/** Where its access goes: this computer, or a hosted service. */
export function routeOf(redirectUri: string): { readonly route: Route; readonly host: string } {
  const url = new URL(redirectUri);
  return { route: isLoopbackHttp(url) ? 'local' : 'remote', host: url.hostname };
}

const isLoopbackHttp = (url: URL): boolean => url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');

function parsed(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}
