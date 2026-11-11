/**
 * Where a request reached this server, without I/O. A tunnel or Tailscale Serve connects from
 * 127.0.0.1, so the socket address says nothing: only the Host and the proxies' own headers do.
 * A request is local only when nothing about it says otherwise. Anything unknown is refused.
 */

export const REMOTE_ROUTES = ['tailscale', 'public'] as const;
export type RemoteRoute = (typeof REMOTE_ROUTES)[number];

export interface RequestPlace {
  /** "http://127.0.0.1:7778", or a route's "https://….trycloudflare.com". Checked. */
  readonly origin: string;
  /** It came through a route. Never believed from a socket address. */
  readonly remote: boolean;
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_LISTEN: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);
/** What a proxy adds. A loopback Host with one of these came through a proxy that passed the Host on. */
const FORWARDED = /^(x-forwarded-|forwarded$|cf-|tailscale-|x-real-ip$|true-client-ip$|via$|cdn-loop$)/;

/** The place of a request by its headers; undefined when it isn't one of this server's names. */
export function placeOfRequest(headers: Headers, port: number, remoteOrigins: readonly string[]): RequestPlace | undefined {
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  if (!host) return undefined;
  const remote = cleanHost(`https://${host}`);
  if (remote && remoteOrigins.includes(remote.origin)) return { origin: remote.origin, remote: true };
  const local = cleanHost(`http://${host}`);
  if (!local || !LOOPBACK_NAMES.has(local.hostname) || local.port !== String(port)) return undefined;
  if (Object.keys(headers).some((name) => FORWARDED.test(name.toLowerCase()))) return undefined;
  return { origin: local.origin, remote: false };
}

/** A token good everywhere a local client connects: http on a loopback name. */
export function isLocalAudience(audience: string): boolean {
  const url = cleanUrl(audience);
  return url !== undefined && url.protocol === 'http:' && LOOPBACK_NAMES.has(url.hostname);
}

/** Plain http carries tokens in the clear, so it may only listen on this computer. */
export function plainListenAllowed(host: string): boolean {
  return LOOPBACK_LISTEN.has(host);
}

/** Host header as a URL, when it is a name and a port and nothing else. */
function cleanHost(candidate: string): URL | undefined {
  const url = cleanUrl(candidate);
  return url && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' ? url : undefined;
}

function cleanUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}
