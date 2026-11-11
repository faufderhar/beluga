import type { Denial, Route } from './decide.js';

/**
 * How much one external agent can do, without I/O: a stolen or noisy client has a bounded blast
 * radius. A remote grant gets less than a local one, and a remote visitor with no token less still.
 */

export interface RouteLimits {
  /** Requests per grant per minute. */
  readonly perMinute: number;
  /** Requests of one grant in flight at once (a card can hold one for minutes). */
  readonly inFlight: number;
  /** Runs one grant has going at once. */
  readonly runs: number;
  readonly bodyBytes: number;
  /** A tool result's text. Past this it is cut, so one call can't pull a whole log. */
  readonly responseChars: number;
}

const ROUTE_LIMITS: Readonly<Record<Route, RouteLimits>> = {
  remote: { perMinute: 120, inFlight: 8, runs: 3, bodyBytes: 256 * 1024, responseChars: 64 * 1024 },
  local: { perMinute: 1200, inFlight: 32, runs: 16, bodyBytes: 4 * 1024 * 1024, responseChars: 1024 * 1024 },
};

export const LIMITS = {
  ...ROUTE_LIMITS,
  /** Any request through a route with no valid token, per visitor and in all. */
  remoteVisitor: { perMinute: 300, totalPerMinute: 1500, maxVisitors: 10_000 },
} as const;

/** Wrong pairing codes through a route, per visitor and in all, per 10 minutes: as the web port's public join links. */
export const REMOTE_SIGN_IN = { perAddress: 5, total: 20, windowMs: 10 * 60_000 } as const;

/**
 * Invalid codes and tokens at /token: per visitor per 10 minutes, and in all per minute through a
 * route. Both count only after the lookup, so a stranger can stop junk and never a valid token.
 */
export const TOKEN_FAILURES = { perVisitor: 10, windowMs: 10 * 60_000, maxVisitors: 10_000, totalPerMinute: 300 } as const;

/** A sign-in form. Past this it is refused, and it is read only up to FORM_DRAIN so that the client gets its answer. */
export const FORM_MAX = 16 * 1024;
export const FORM_DRAIN = 256 * 1024;

/** Policy denials in a window that suspend a remote grant. A person must lift it. */
export const SUSPEND_AFTER = { denials: 10, windowMs: 10 * 60_000 } as const;

/** Refusals that say a client tries what it was not given. A wrong id or argument is only a mistake. */
const SUSPENDING: ReadonlySet<Denial> = new Set<Denial>(['capability_denied', 'level_denied', 'project_denied', 'needs_person', 'declined']);

export const countsTowardSuspension = (denial: Denial): boolean => SUSPENDING.has(denial);

export const RATE_WINDOW_MS = 60_000;

/**
 * How long one call waits for the owner's card. A card lasts 5 minutes, and a client gives up long
 * before that: claude.ai said "the server isn't responding" after about 2 minutes (BLG-216).
 */
export const CARD_WAIT_MS = 50_000;
/** An answer that came with no call waiting waits this long for the client to call again. */
export const CARD_ANSWER_KEEP_MS = 10 * 60_000;

/** What a client is told at initialize, so it can tell its user why a call takes long. */
export const WAITING_INSTRUCTIONS = 'A call can need a person. The owner of this Beluga then gets a card on their own screen, which lasts 5 minutes. While it waits, a call returns the error waiting_for_owner: tell your user, then call again with the same arguments. Nothing has run until the owner says yes. The error declined means that the owner said no or did not answer.';

/**
 * Refusals with no agent behind them, as the audit log keeps them: one record per window per kind, in
 * total, so a flood can't grow the log. The words are fixed, never from a request.
 */
export const VISITOR_REFUSALS = {
  visitor_flood: { windowMs: RATE_WINDOW_MS, summary: 'Too many requests through a route' },
  wrong_pairing_codes: { windowMs: REMOTE_SIGN_IN.windowMs, summary: 'Too many wrong pairing codes' },
  token_failures: { windowMs: TOKEN_FAILURES.windowMs, summary: 'Too many invalid codes or tokens' },
} as const;
export type VisitorRefusal = keyof typeof VISITOR_REFUSALS;

/** Hits per key in a sliding window. Keys with nothing in the window are dropped. */
export class WindowCounter {
  private hits = new Map<string, number[]>();
  private swept = 0;

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number,
    private readonly maxKeys = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  /** One more hit, unless the key holds `limit` already. True when it fit. */
  take(key: string, limit: number): boolean {
    const now = this.now();
    this.sweep(now);
    const live = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (live.length >= limit) {
      this.hits.set(key, live);
      return false;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    this.hits.set(key, [...live, now]);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.swept < this.windowMs) return;
    this.swept = now;
    for (const [key, at] of this.hits) if (!at.some((t) => t > now - this.windowMs)) this.hits.delete(key);
  }
}

/**
 * Who a request is, for limits. Every request through a route arrives from loopback, so the proxy's
 * word is used. A client on the tailnet can make up a Cloudflare header, so each limit has a total too.
 */
export function visitorOf(headers: Readonly<Record<string, string | string[] | undefined>>, socket: string | undefined, remote: boolean): string {
  if (!remote) return socket ?? 'unknown';
  const one = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const cf = one('cf-connecting-ip');
  if (cf) return `public:${cf}`;
  const login = one('tailscale-user-login');
  return login ? `tailnet:${login}` : 'remote:unknown';
}

/** A tool result's text, whole or cut with a note. */
export function boundedText(text: string, max: number): string {
  if (text.length <= max) return text;
  return JSON.stringify({ truncated: true, note: 'This result was too long and is cut. Ask a narrower question, or read in smaller parts.', partial: text.slice(0, max) });
}
