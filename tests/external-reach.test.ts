import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalReach, MCP_TAILSCALE_PORT, type TailscaleRun } from '../src/external/adapters/reach.js';
import { isLocalAudience, placeOfRequest, plainListenAllowed } from '../src/external/domain/reach.js';
import { ExternalService, type ExternalServiceOptions } from '../src/external/service.js';

const NAME_A = 'https://first-name.trycloudflare.com';
const NAME_B = 'https://second-name.trycloudflare.com';
const TS = 'mac.tail1234.ts.net';

let dir: string;
const open: ExternalService[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-reach-'));
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A tunnel opener a test drives: each call takes the next name, and `die` drops the newest. */
const fakeTunnels = (...names: string[]) => {
  const left = [...names];
  let died: ((reason: string) => void) | undefined;
  const closed = vi.fn();
  return {
    closed,
    die: () => died?.('cloudflared stopped'),
    open: async (_port: number, onDied: (reason: string) => void) => {
      const publicUrl = left.shift();
      if (!publicUrl) throw new Error('no tunnel left');
      died = onDied;
      return { kind: 'cloudflared' as const, publicUrl, close: closed };
    },
  };
};

const fakeTailscale = (serve: Record<string, unknown> = {}): { run: TailscaleRun; calls: string[][] } => {
  const calls: string[][] = [];
  const run: TailscaleRun = async (_bin, args) => {
    calls.push([...args]);
    if (args[0] === 'status') return { code: 0, out: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${TS}.` } }), err: '' };
    if (args.join(' ') === 'serve status --json') return { code: 0, out: JSON.stringify(serve), err: '' };
    return { code: 0, out: '', err: '' };
  };
  return { run, calls };
};

const newService = (extra: Partial<ExternalServiceOptions> = {}): ExternalService => {
  const service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0, ...extra });
  open.push(service);
  return service;
};

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A raw request from 127.0.0.1, as a tunnel makes it. fetch won't let a test set Host. */
const raw = (port: number, opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });

const form = (values: Record<string, string>): { headers: Record<string, string>; body: string } => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });

/** A whole OAuth sign-in at this origin. Returns the tokens and the location the sign-in ended at. */
async function signIn(service: ExternalService, port: number, host: string, origin: string, redirect = 'http://127.0.0.1:9999/cb', level: 'ask' | 'trusted' | 'full' = 'trusted') {
  const reg = await raw(port, { host, path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Hosted', redirect_uris: [redirect] }) });
  const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = `${origin}/mcp`;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource, state: 's' });
  const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}` });
  const pending = /name="pending" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  const { code } = service.pairingCode({ level, projects: [] });
  const posted = await raw(port, { host, path: '/authorize', ...form({ pending, code, action: 'approve' }) });
  const location = new URL(posted.headers.location ?? 'http://none/');
  const tokens = await raw(port, { host, path: '/token', ...form({ grant_type: 'authorization_code', code: location.searchParams.get('code') ?? '', client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource }) });
  return { page, posted, clientId, tokens: JSON.parse(tokens.body) as { access_token: string; refresh_token: string } };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

describe('where a request came from', () => {
  const port = 7778;
  const remote = [NAME_A, `https://${TS}:${MCP_TAILSCALE_PORT}`];

  it('a loopback Host at our port with no forwarding headers is local', () => {
    expect(placeOfRequest({ host: '127.0.0.1:7778' }, port, remote)).toEqual({ origin: 'http://127.0.0.1:7778', remote: false });
    expect(placeOfRequest({ host: 'localhost:7778' }, port, remote)).toEqual({ origin: 'http://localhost:7778', remote: false });
  });

  it('a route name is remote, with its https origin', () => {
    expect(placeOfRequest({ host: 'first-name.trycloudflare.com' }, port, remote)).toEqual({ origin: NAME_A, remote: true });
    expect(placeOfRequest({ host: `${TS}:${MCP_TAILSCALE_PORT}` }, port, remote)).toEqual({ origin: `https://${TS}:${MCP_TAILSCALE_PORT}`, remote: true });
  });

  it.each(['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login', 'x-real-ip', 'via'])('a loopback Host that carries %s is not local', (header) => {
    expect(placeOfRequest({ host: '127.0.0.1:7778', [header]: 'x' }, port, remote)).toBeUndefined();
  });

  it('an unknown name, an old tunnel name, a wrong port and no Host are refused', () => {
    expect(placeOfRequest({ host: 'evil.example' }, port, remote)).toBeUndefined();
    expect(placeOfRequest({ host: 'second-name.trycloudflare.com' }, port, remote)).toBeUndefined();
    expect(placeOfRequest({ host: `${TS}:443` }, port, remote)).toBeUndefined();
    expect(placeOfRequest({ host: '127.0.0.1:1' }, port, remote)).toBeUndefined();
    expect(placeOfRequest({}, port, remote)).toBeUndefined();
    expect(placeOfRequest({ host: `u:p@${TS}:${MCP_TAILSCALE_PORT}` }, port, remote)).toBeUndefined();
  });
});

describe('plain http', () => {
  it('only a loopback listen address may be plain http', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(plainListenAllowed(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.5', '100.100.101.34', 'mac.local', '']) expect(plainListenAllowed(host)).toBe(false);
  });

  it('turning it on at a non-loopback address fails and stays off', async () => {
    const service = newService({ listenHost: '0.0.0.0' });
    await expect(service.setEnabled(true)).rejects.toThrow(/plain http.*0\.0\.0\.0.*--tailscale.*--public/s);
    expect(service.status().on).toBe(false);
  });

  it('a local audience is http on a loopback name', () => {
    expect(isLocalAudience('http://127.0.0.1:7778/mcp')).toBe(true);
    expect(isLocalAudience('http://localhost:7778/mcp')).toBe(true);
    expect(isLocalAudience(`${NAME_A}/mcp`)).toBe(false);
    expect(isLocalAudience('https://127.0.0.1/mcp')).toBe(false);
    expect(isLocalAudience('not a url')).toBe(false);
  });
});

describe('through a tunnel', () => {
  const started = async (names: string[] = [NAME_A]) => {
    const tunnels = fakeTunnels(...names);
    const service = newService({ reach: { openTunnel: tunnels.open, reachable: async () => true, retryMs: () => 0 } });
    await service.setRoute('public', true);
    return { service, tunnels, port: service.status().port!, host: new URL(names[0]!).host };
  };
  const whenRoute = async (service: ExternalService, url: string): Promise<void> => {
    await vi.waitFor(() => expect(service.status().routes?.find((r) => r.kind === 'public')?.url).toBe(url), { timeout: 2000 });
  };

  it('setRoute opens the listener and shows the route', async () => {
    const { service, port } = await started();
    expect(service.status()).toMatchObject({ on: true, port, routes: [{ kind: 'public', state: 'on', url: `${NAME_A}/mcp` }] });
  });

  it('metadata and audience use the tunnel name', async () => {
    const { port, host } = await started();
    const meta = await raw(port, { host, method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
    expect(JSON.parse(meta.body)).toMatchObject({ resource: `${NAME_A}/mcp`, authorization_servers: [NAME_A] });
  });

  it('a request through the tunnel from 127.0.0.1 signs in as remote, even with a loopback redirect', async () => {
    const { service, port, host } = await started();
    const { tokens } = await signIn(service, port, host, NAME_A);
    expect(service.grants.list()).toMatchObject([{ route: 'remote', redirectHost: '127.0.0.1' }]);
    const ok = await raw(port, { host, headers: bearer(tokens.access_token), body: ping });
    expect(ok.status).toBe(200);
  });

  it('a local full code spent through a route gets 403 and makes no grant', async () => {
    const { service, port, host } = await started();
    const { posted } = await signIn(service, port, host, NAME_A, 'http://127.0.0.1:9999/cb', 'full');
    expect(posted.status).toBe(403);
    expect(service.grants.list()).toEqual([]);
  });

  it('a sign-in started at one address cannot end at another', async () => {
    const { service, port, host } = await started();
    const reg = await raw(port, { host, path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://hosted.example/cb'] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://hosted.example/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: `${NAME_A}/mcp` });
    const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}` });
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    const posted = await raw(port, { path: '/authorize', ...form({ pending, code: service.pairingCode({ level: 'ask', projects: [] }).code, action: 'approve' }) });
    expect(posted.status).toBe(400);
    expect(service.grants.list()).toEqual([]);
  });

  it('a token issued for the local URL fails through the tunnel with a clear message', async () => {
    const { service, port, host } = await started();
    const { tokens } = await signIn(service, port, `127.0.0.1:${port}`, `http://127.0.0.1:${port}`);
    expect((await raw(port, { headers: bearer(tokens.access_token), body: ping })).status).toBe(200);
    const through = await raw(port, { host, headers: bearer(tokens.access_token), body: ping });
    expect(through.status).toBe(401);
    expect(through.headers['www-authenticate']).toContain('error_description="');
    expect(through.headers['www-authenticate']).toContain('Sign in again');
    expect(through.headers['www-authenticate']).toContain(`resource_metadata="${NAME_A}/`);
  });

  it('a local token (beluga mcp token) fails through the tunnel', async () => {
    const service0 = await started();
    const { service, port, host } = service0;
    const { token } = service.grants.create({ name: 'Local', clientId: 'local-token', redirectHost: 'localhost', route: 'local', level: 'full', projects: [], expiresAt: Date.now() + 60_000 });
    expect((await raw(port, { headers: bearer(token), body: ping })).status).toBe(200);
    const through = await raw(port, { host, headers: bearer(token), body: ping });
    expect(through.status).toBe(401);
    expect(through.headers['www-authenticate']).toContain('Sign in again');
  });

  it('a new tunnel name makes old tokens fail with 401 and a clear message, and refresh with invalid_grant', async () => {
    const { service, tunnels, port, host } = await started([NAME_A, NAME_B]);
    const { tokens, clientId } = await signIn(service, port, host, NAME_A);
    tunnels.die();
    await whenRoute(service, `${NAME_B}/mcp`);

    const hostB = new URL(NAME_B).host;
    const stale = await raw(port, { host: hostB, headers: bearer(tokens.access_token), body: ping });
    expect(stale.status).toBe(401);
    expect(stale.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(stale.headers['www-authenticate']).toContain('Sign in again');
    expect(stale.headers['www-authenticate']).toContain(`resource_metadata="${NAME_B}/`);

    const refresh = await raw(port, { host: hostB, path: '/token', ...form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }) });
    expect(refresh.status).toBe(400);
    expect(JSON.parse(refresh.body)).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('Sign in again') });

    // The old name is no longer ours at all.
    expect((await raw(port, { host, headers: bearer(tokens.access_token), body: ping })).status).toBe(403);
    // The refused refresh ended nothing: signing in again at the new name works.
    const again = await signIn(service, port, hostB, NAME_B);
    expect((await raw(port, { host: hostB, headers: bearer(again.tokens.access_token), body: ping })).status).toBe(200);
  });

  it('turning the route off closes the tunnel and forgets the name', async () => {
    const { service, tunnels, port, host } = await started();
    await service.setRoute('public', false);
    expect(tunnels.closed).toHaveBeenCalled();
    expect(service.status().routes).toEqual([]);
    expect((await raw(port, { host, method: 'GET', path: '/.well-known/oauth-protected-resource' })).status).toBe(403);
    expect(service.status().on).toBe(true);
  });

  it('off closes every route and they stay closed after a restart', async () => {
    const { service } = await started();
    await service.setEnabled(false);
    const tunnels = fakeTunnels(NAME_B);
    const next = newService({ reach: { openTunnel: tunnels.open, reachable: async () => true } });
    await next.setEnabled(true);
    await next.start();
    expect(next.status().routes).toEqual([]);
  });

  it('a route left on opens at start under a new name', async () => {
    const { service } = await started();
    await service.stop();
    const tunnels = fakeTunnels(NAME_B);
    const next = newService({ reach: { openTunnel: tunnels.open, reachable: async () => true } });
    await next.start();
    await whenRoute(next, `${NAME_B}/mcp`);
  });

  it('a tunnel that cannot open refuses the route and leaves it off', async () => {
    const service = newService({ reach: { openTunnel: fakeTunnels().open, reachable: async () => true, retryMs: () => 60_000 } });
    await expect(service.setRoute('public', true)).rejects.toThrow('no tunnel left');
    expect(service.status().routes).toEqual([]);
    await service.start();
    expect(service.status().routes).toEqual([]);
  });

  it('a route must be https', async () => {
    const service = newService({ reach: { openTunnel: fakeTunnels('http://plain.example').open, reachable: async () => true, retryMs: () => 60_000 } });
    await expect(service.setRoute('public', true)).rejects.toThrow(/https/);
  });
});

describe('Tailscale', () => {
  it('serves the listener on 8443 and never touches Funnel or 443', async () => {
    const { run, calls } = fakeTailscale();
    const reach = new ExternalReach({ run });
    await reach.open('tailscale', 7778);
    expect(reach.routes()).toEqual([{ kind: 'tailscale', state: 'on', url: `https://${TS}:8443/mcp` }]);
    expect(reach.origins()).toEqual([`https://${TS}:8443`]);
    expect(calls).toContainEqual(['serve', '--bg', '--https=8443', 'http://127.0.0.1:7778']);
    await reach.close('tailscale');
    expect(calls).toContainEqual(['serve', '--https=8443', 'off']);
    expect(calls.flat().join(' ')).not.toMatch(/funnel|443 off.*443|--https=443/);
    expect(reach.routes()).toEqual([]);
  });

  it('refuses a port that serves something else, and leaves it alone', async () => {
    const { run, calls } = fakeTailscale({ Web: { [`${TS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } });
    const reach = new ExternalReach({ run });
    await expect(reach.open('tailscale', 7778)).rejects.toThrow(/8443.*already/);
    expect(calls.some((c) => c.includes('--bg'))).toBe(false);
    await reach.close('tailscale');
    expect(calls.some((c) => c.includes('off'))).toBe(false);
  });

  it('refuses a port that has Funnel on', async () => {
    const { run } = fakeTailscale({ AllowFunnel: { [`${TS}:8443`]: true } });
    await expect(new ExternalReach({ run }).open('tailscale', 7778)).rejects.toThrow(/Funnel/);
  });

  it('takes back its own serve after a crash', async () => {
    const { run, calls } = fakeTailscale({ Web: { [`${TS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7778' } } } } });
    await new ExternalReach({ run }).open('tailscale', 7778);
    expect(calls.some((c) => c.includes('--bg'))).toBe(true);
  });

  it('says what to do when it is not connected', async () => {
    const run: TailscaleRun = async () => ({ code: 0, out: JSON.stringify({ BackendState: 'NeedsLogin' }), err: '' });
    await expect(new ExternalReach({ run }).open('tailscale', 7778)).rejects.toThrow(/tailscale up/);
  });

  it('a request through Serve counts as remote and signs in at its name', async () => {
    const { run } = fakeTailscale();
    const service = newService({ reach: { run } });
    await service.setRoute('tailscale', true);
    const port = service.status().port!;
    const host = `${TS}:8443`;
    const { tokens } = await signIn(service, port, host, `https://${host}`);
    expect(service.grants.list()).toMatchObject([{ route: 'remote' }]);
    expect((await raw(port, { host, headers: { ...bearer(tokens.access_token), 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.1.2.3' }, body: ping })).status).toBe(200);
    expect((await raw(port, { host: `127.0.0.1:${port}`, headers: { 'tailscale-user-login': 'me@example.com' }, body: ping })).status).toBe(403);
  });
});

describe('a hosted client through a tunnel, as claude.ai signs in', () => {
  const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
  const host = new URL(NAME_A).host;

  const hosted = async () => {
    const tunnels = fakeTunnels(NAME_A);
    const service = newService({ reach: { openTunnel: tunnels.open, reachable: async () => true } });
    await service.setRoute('public', true);
    return { service, port: service.status().port! };
  };

  it('registers with its extra fields, comes back to https, gets a grant by that host, refreshes and calls', async () => {
    const { service, port } = await hosted();
    const visitor = { 'cf-connecting-ip': '160.79.104.10' };
    const challenged = await raw(port, { host, headers: { ...visitor, 'content-type': 'application/json' }, body: ping });
    expect(challenged.status).toBe(401);
    const meta = JSON.parse((await raw(port, { host, method: 'GET', path: '/.well-known/oauth-authorization-server', headers: visitor })).body) as { scopes_supported: string[]; registration_endpoint: string };
    expect(meta.scopes_supported).toContain('offline_access');
    expect(meta.registration_endpoint).toBe(`${NAME_A}/register`);

    const reg = await raw(port, { host, path: '/register', headers: { ...visitor, 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'offline_access' }) });
    expect(reg.status).toBe(201);
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const resource = `${NAME_A}/mcp`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'offline_access', state: 's1' });
    const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}`, headers: visitor });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain('https://claude.ai');
    expect(page.body).toContain('Anyone who runs that service gets the access');
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)?.[1] ?? '';

    // The owner's browser posts the form from the page's own origin.
    const f = form({ pending, code: service.pairingCode({ level: 'ask', projects: [], remote: true }).code, action: 'approve' });
    const posted = await raw(port, { host, path: '/authorize', headers: { ...f.headers, origin: NAME_A, 'cf-connecting-ip': '203.0.113.9' }, body: f.body });
    expect(posted.status).toBe(303);
    const back = new URL(posted.headers.location!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('iss')).toBe(NAME_A);
    expect(service.grants.list()).toMatchObject([{ route: 'remote', redirectHost: 'claude.ai', level: 'ask', name: 'Claude' }]);

    const exchange = form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier, resource });
    const tokens = JSON.parse((await raw(port, { host, path: '/token', headers: { ...exchange.headers, ...visitor }, body: exchange.body })).body) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.expires_in).toBe(3600);
    expect((await raw(port, { host, headers: { ...bearer(tokens.access_token), ...visitor }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(200);

    const renew = form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, resource });
    const renewed = await raw(port, { host, path: '/token', headers: { ...renew.headers, ...visitor }, body: renew.body });
    expect(renewed.status).toBe(200);
    const next = JSON.parse(renewed.body) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await raw(port, { host, headers: { ...bearer(next.access_token), ...visitor }, body: ping })).status).toBe(200);
  });

  it('says at initialize that a call can wait for a person, so a hosted client can tell its user', async () => {
    const { service, port } = await hosted();
    const { grant } = service.grants.create({ name: 'Claude', clientId: 'c', redirectHost: 'claude.ai', route: 'remote', level: 'ask', projects: [], expiresAt: Date.now() + 60_000 });
    const access = service.grants.issueAccess(grant.id, `${NAME_A}/mcp`, 60_000)!;
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const answer = await raw(port, { host, headers: bearer(access), body: init });
    const { instructions } = (JSON.parse(answer.body) as { result: { instructions: string } }).result;
    expect(instructions).toContain('5 minutes');
    expect(instructions).toContain('owner');
    expect(instructions).toContain('declined');
  });

  it('answers a GET and a DELETE on /mcp as a stateless server does', async () => {
    const { service, port } = await hosted();
    const { grant } = service.grants.create({ name: 'Claude', clientId: 'c', redirectHost: 'claude.ai', route: 'remote', level: 'ask', projects: [], expiresAt: Date.now() + 60_000 });
    const access = service.grants.issueAccess(grant.id, `${NAME_A}/mcp`, 60_000)!;
    expect((await raw(port, { host, method: 'GET', headers: bearer(access) })).status).toBe(405);
    expect((await raw(port, { host, method: 'DELETE', headers: bearer(access) })).status).toBe(405);
  });
});
