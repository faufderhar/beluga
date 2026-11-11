import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { z } from 'zod';

/**
 * A client's metadata document (CIMD: its client_id is an https URL). The URL is anyone's choice, so
 * the fetch is guarded against reaching this computer or its network: https on the default port, only
 * public addresses (checked when connecting, so a name can't change its answer in between), no
 * redirects, small and quick.
 */

export interface ClientMetadata {
  readonly name: string;
  readonly redirectUris: readonly string[];
}

export interface FetchOptions {
  readonly lookup?: LookupFunction;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const CLIENT_ID_MAX = 2000;

const Document = z.object({ client_id: z.string(), client_name: z.string().max(200).optional(), redirect_uris: z.array(z.string().max(500)).min(1).max(10) });

const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');

/** The client's metadata, or a throw saying why not. */
export async function fetchClientMetadata(clientId: string, opts: FetchOptions = {}): Promise<ClientMetadata> {
  const url = clientIdUrl(clientId);
  if (!url) throw new Error('That client_id is not a usable https URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('That client_id points at a private address');
  const text = await fetchText(url, opts);
  const doc = Document.parse(JSON.parse(text));
  if (doc.client_id !== clientId) throw new Error('That document is for another client_id');
  return { name: doc.client_name ?? url.hostname, redirectUris: doc.redirect_uris };
}

/** The URL of a client_id that could be a metadata document: https, default port, a path, nothing else. */
export function clientIdUrl(clientId: string): URL | undefined {
  if (clientId.length > CLIENT_ID_MAX) return undefined;
  try {
    const url = new URL(clientId);
    const clean = !url.username && !url.password && !url.hash && !url.port && url.pathname !== '/';
    return url.protocol === 'https:' && clean ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves as usual, then refuses a name with any address that isn't public. */
const guardedLookup = (inner: LookupFunction): LookupFunction => (hostname, options, callback) => {
  inner(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const all = addresses as unknown as LookupAddress[];
    if (all.length === 0 || all.some((a) => !isPublicAddress(a.address))) return callback(new Error('That client_id resolves to a private address'), '', 0);
    if (options.all) return callback(null, all as unknown as string, 0);
    callback(null, all[0]!.address, all[0]!.family);
  });
};

function fetchText(url: URL, opts: FetchOptions): Promise<string> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { accept: 'application/json' }, timeout: timeoutMs, lookup: guardedLookup(opts.lookup ?? (dnsLookup as LookupFunction)) }, (res) => {
      // A redirect is not followed: its target would go unchecked.
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`That client_id answered ${res.statusCode ?? 'nothing'}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) return void req.destroy(new Error('That client_id document is too big'));
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    // `timeout` counts only a silence, so a body that drips needs a limit on the whole fetch too.
    const tooLong = (): void => void req.destroy(new Error('That client_id took too long'));
    const deadline = setTimeout(tooLong, timeoutMs);
    req.once('close', () => clearTimeout(deadline));
    req.on('timeout', tooLong);
    req.on('error', reject);
    req.end();
  });
}
