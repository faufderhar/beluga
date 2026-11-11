import { createHash } from 'node:crypto';
import { type ClientRequest, createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server as HttpServer, type ServerResponse } from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo, createConnection, type LookupFunction, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientIdUrl, fetchClientMetadata, isPublicAddress } from '../src/external/adapters/client-metadata.js';
import { sendSignInError, sendSignInPage, type SignInPage } from '../src/external/adapters/signin-page.js';
import { PAIRING_CODE_MS } from '../src/external/domain/oauth.js';
import { ExternalService, type ExternalServiceOptions } from '../src/external/service.js';

const REDIRECT = 'http://127.0.0.1:43210/callback';
const VERIFIER = 'v'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let dir: string;
let clock: number;
let origin: string;
let resource: string;
let service: ExternalService;
const notified: string[] = [];

const makeService = async (opts: Partial<ExternalServiceOptions> = {}): Promise<void> => {
  service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0, now: () => clock, notify: (g) => notified.push(g.name), ...opts });
  await service.setEnabled(true);
  origin = `http://127.0.0.1:${service.status().port!}`;
  resource = `${origin}/mcp`;
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-oauth-'));
  clock = Date.now();
  notified.length = 0;
  await makeService();
});
afterEach(async () => {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
});

const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

const register = async (redirects = [REDIRECT], name = 'Claude Code'): Promise<string> => {
  const res = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: redirects }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
};

const authorizeUrl = (clientId: string, over: Record<string, string | undefined> = {}): string => {
  const params: Record<string, string | undefined> = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1', code_challenge: CHALLENGE, code_challenge_method: 'S256', resource, ...over };
  const defined = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return `${origin}/authorize?${new URLSearchParams(defined).toString()}`;
};

const pendingOf = (html: string): string => /name="pending" value="([^"]+)"/.exec(html)![1]!;

/** The page for this request, then the pairing code spent on it: where it sends the browser back. */
const approve = async (clientId: string, code: string, over: Record<string, string | undefined> = {}): Promise<URL> => {
  const page = await fetch(authorizeUrl(clientId, over), { redirect: 'manual' });
  expect(page.status).toBe(200);
  const res = await fetch(`${origin}/authorize`, form({ pending: pendingOf(await page.text()), code, action: 'approve' }));
  expect(res.status).toBe(303);
  return new URL(res.headers.get('location')!);
};

const pair = (): string => service.pairingCode({ level: 'trusted', projects: ['p1'] }).code;

const authCode = async (): Promise<{ clientId: string; code: string }> => {
  const clientId = await register();
  const back = await approve(clientId, pair());
  return { clientId, code: back.searchParams.get('code')! };
};

const exchange = (clientId: string, code: string, over: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}/token`, form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource, ...over }));

const tokens = async (): Promise<{ clientId: string; access: string; refresh: string }> => {
  const { clientId, code } = await authCode();
  const res = await exchange(clientId, code);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: body.access_token, refresh: body.refresh_token };
};

const refresh = (clientId: string, token: string, over: Record<string, string> = {}): Promise<Response> => fetch(`${origin}/token`, form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...over }));

const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const mcp = (token: string, url = resource): Promise<Response> => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INITIALIZE });

describe('discovery', () => {
  it('says how to sign in', async () => {
    const prm = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource, authorization_servers: [origin] });
    const as = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true });
  });
});

describe('a real MCP client (the SDK Claude Code and others use)', () => {
  it('signs in with a pairing code, then connects', async () => {
    let saved: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
    let info: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
    let verifier = '';
    let sentTo: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: REDIRECT,
      clientMetadata: { client_name: 'SDK client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => info,
      saveClientInformation: (i) => void (info = i),
      tokens: () => saved,
      saveTokens: (t) => void (saved = t),
      redirectToAuthorization: (url) => void (sentTo = url),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };
    expect(await auth(provider, { serverUrl: resource })).toBe('REDIRECT');
    const page = await fetch(sentTo!, { redirect: 'manual' });
    const html = await page.text();
    expect(html).toContain('SDK client');
    const back = await fetch(`${origin}/authorize`, form({ pending: pendingOf(html), code: pair(), action: 'approve' }));
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    expect(await auth(provider, { serverUrl: resource, authorizationCode: code })).toBe('AUTHORIZED');

    const client = new Client({ name: 'sdk', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }));
    expect(client.getServerVersion()?.name).toBe('beluga');
    await client.close();
    expect(notified).toEqual(['SDK client']);
  });
});

describe('the pairing code decides what the agent gets', () => {
  it('gives its level and projects, whatever the request says', async () => {
    const clientId = await register();
    const { code } = service.pairingCode({ level: 'ask', projects: ['only-this'] });
    await approve(clientId, code, { scope: 'admin', level: 'full', projects: 'everything' });
    expect(service.grants.list()).toMatchObject([{ name: 'Claude Code', level: 'ask', projects: ['only-this'], route: 'local', redirectHost: '127.0.0.1' }]);
    expect(service.grants.list()[0]!.expiresAt - clock).toBe(30 * 24 * 60 * 60_000);
  });

  it('refuses a wrong code and stays on the page, without echoing it', async () => {
    const clientId = await register();
    const page = await fetch(authorizeUrl(clientId));
    const res = await fetch(`${origin}/authorize`, form({ pending: pendingOf(await page.text()), code: 'WRONG-CODE-123', action: 'approve' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('wrong, used or expired');
    expect(html).not.toContain('WRONG-CODE-123');
    expect(service.grants.list()).toEqual([]);
  });

  it('spends a code once, and it expires', async () => {
    const clientId = await register();
    const code = pair();
    await approve(clientId, code);
    const page = await fetch(authorizeUrl(clientId));
    const again = await fetch(`${origin}/authorize`, form({ pending: pendingOf(await page.text()), code, action: 'approve' }));
    expect(await again.text()).toContain('wrong, used or expired');

    const late = pair();
    clock += PAIRING_CODE_MS + 1;
    const page2 = await fetch(authorizeUrl(clientId));
    const expired = await fetch(`${origin}/authorize`, form({ pending: pendingOf(await page2.text()), code: late, action: 'approve' }));
    expect(await expired.text()).toContain('wrong, used or expired');
    expect(service.grants.list()).toHaveLength(1);
  });

  it('limits wrong codes, even when the next one is right', async () => {
    const clientId = await register();
    const pending = pendingOf(await (await fetch(authorizeUrl(clientId))).text());
    for (let i = 0; i < 10; i++) await fetch(`${origin}/authorize`, form({ pending, code: `bad-${i}`, action: 'approve' }));
    const res = await fetch(`${origin}/authorize`, form({ pending, code: pair(), action: 'approve' }));
    expect(res.status).toBe(429);
    expect(service.grants.list()).toEqual([]);
  });

  it('sends a denial back with the state', async () => {
    const clientId = await register();
    const page = await fetch(authorizeUrl(clientId));
    const res = await fetch(`${origin}/authorize`, form({ pending: pendingOf(await page.text()), action: 'deny' }));
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st-1');
  });

  it('will not give a hosted service full trust from a local code', async () => {
    const hosted = 'https://agent.example/cb';
    const clientId = await register([hosted]);
    const page = await fetch(authorizeUrl(clientId, { redirect_uri: hosted }));
    const html = await page.text();
    expect(html).toContain('Anyone who runs that service gets the access');
    const { code } = service.pairingCode({ level: 'full', projects: [] });
    const res = await fetch(`${origin}/authorize`, form({ pending: pendingOf(html), code, action: 'approve' }));
    expect(res.status).toBe(403);
    expect(service.grants.list()).toEqual([]);
  });

  it('says a local agent stays on this computer, and locks the page down', async () => {
    const clientId = await register();
    const page = await fetch(authorizeUrl(clientId));
    expect(await page.text()).toContain('this computer');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('http://127.0.0.1:43210');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    // no-referrer would make a browser post the form with `Origin: null`, and the listener refuses that.
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('escapes a client name on the page and takes a secret out of it', async () => {
    const clientId = await register([REDIRECT], '<script>alert(1)</script> sk_' + 'live_abcdefghijklmnopqrstuvwx');
    const html = await (await fetch(authorizeUrl(clientId))).text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('sk_' + 'live_abcdefghijklmnopqrstuvwx');
  });
});

describe('the sign-in page, in each state', () => {
  const rendered = (write: (res: ServerResponse) => void): { status: number; headers: Record<string, string>; html: string } => {
    const out = { status: 0, headers: {} as Record<string, string>, html: '' };
    write({ writeHead: (status: number, headers: Record<string, string>) => Object.assign(out, { status, headers }), end: (html: string) => void (out.html = html) } as unknown as ServerResponse);
    return out;
  };
  const base: SignInPage = { agent: 'Claude Code', route: 'local', host: '127.0.0.1', pending: 'p1', redirectOrigin: 'http://127.0.0.1:43210' };
  const states: Record<string, { page: ReturnType<typeof rendered>; target: string }> = {
    'the code form': { page: rendered((res) => sendSignInPage(res, base)), target: 'http://127.0.0.1:43210' },
    'a hosted service': { page: rendered((res) => sendSignInPage(res, { ...base, route: 'remote', host: 'agent.example', redirectOrigin: 'https://agent.example' })), target: 'https://agent.example' },
    'the remote Full warning': { page: rendered((res) => sendSignInPage(res, { ...base, route: 'remote', host: 'agent.example', redirectOrigin: 'https://agent.example', confirmFullCode: 'ABCD-1234' })), target: 'https://agent.example' },
    'a wrong or used code': { page: rendered((res) => sendSignInPage(res, { ...base, error: 'That code is wrong, used or expired. Make a new one in Beluga.' })), target: 'http://127.0.0.1:43210' },
    'a lockout': { page: rendered((res) => sendSignInError(res, 429, { title: 'Too many wrong codes', message: 'Wait a few minutes.' })), target: '' },
    'an expired sign-in': { page: rendered((res) => sendSignInError(res, 400, { title: 'This sign-in expired', message: 'Start it again.' })), target: '' },
  };

  it.each(Object.keys(states))('%s keeps the CSP byte for byte, apart from the nonce', (name) => {
    const { page, target } = states[name]!;
    const nonce = /<style nonce="([^"]+)">/.exec(page.html)![1]!;
    expect(page.headers['content-security-policy']).toBe(`default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${target}; frame-ancestors 'none'; base-uri 'none'`);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('same-origin');
  });

  it.each(Object.keys(states))('%s loads nothing from another address and runs no script', (name) => {
    const { html } = states[name]!.page;
    expect(html.match(/https?:\/\/[^\s"'<)]+/g) ?? []).toEqual([]);
    expect(html).not.toMatch(/<script|<img|<link|<iframe|url\(|@import|data:/i);
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).toContain('<svg viewBox="0 0 1024 1024" aria-hidden="true"');
  });

  it('ties each label to its input, and asks for the Full trust box', () => {
    expect(states['the code form']!.page.html).toContain('<label class="field-label" for="code">');
    expect(states['the code form']!.page.html).toContain('id="code" name="code"');
    expect(states['the remote Full warning']!.page.html).toMatch(/id="confirm" name="confirm_full" value="yes" required><label for="confirm">/);
  });

  it('is served with no-store, and its only address is the form target', async () => {
    const clientId = await register();
    const page = await fetch(authorizeUrl(clientId));
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect((await page.text()).match(/https?:\/\/[^\s"'<)]+/g) ?? []).toEqual([]);
  });
});

describe('/authorize refuses', () => {
  it('a made-up or tampered client_id, without redirecting', async () => {
    const clientId = await register();
    const tampered = clientId.replace(/\.[^.]+$/, '.AAAA');
    for (const id of ['nope', tampered, '']) expect((await fetch(authorizeUrl(id), { redirect: 'manual' })).status).toBe(400);
  });

  it('a redirect it did not register, without redirecting there', async () => {
    const clientId = await register();
    for (const redirect_uri of ['http://127.0.0.1:43210/other', 'https://evil.example/cb', 'http://evil.example/callback', 'http://localhost:43210/callback', 'javascript:alert(1)']) {
      const res = await fetch(authorizeUrl(clientId, { redirect_uri }), { redirect: 'manual' });
      expect(res.status, redirect_uri).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('takes a registered loopback redirect on any port', async () => {
    const clientId = await register();
    expect((await fetch(authorizeUrl(clientId, { redirect_uri: 'http://127.0.0.1:9/callback' }), { redirect: 'manual' })).status).toBe(200);
  });

  it('will not register plain http beyond loopback', async () => {
    const res = await fetch(`${origin}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(res.status).toBe(400);
  });

  it('missing PKCE, a plain challenge, or a missing or wrong resource, back to the client with the state', async () => {
    const clientId = await register();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ resource: undefined }, 'invalid_target'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [over, error] of cases) {
      const res = await fetch(authorizeUrl(clientId, over), { redirect: 'manual' });
      expect(res.status).toBe(303);
      const back = new URL(res.headers.get('location')!);
      expect(back.searchParams.get('error'), JSON.stringify(over)).toBe(error);
      expect(back.searchParams.get('state')).toBe('st-1');
    }
  });
});

describe('/token', () => {
  it('hands out tokens the code was for, with an hour on the access token', async () => {
    const { clientId, code } = await authCode();
    const res = await exchange(clientId, code);
    const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number; refresh_token: string };
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect((await mcp(body.access_token)).status).toBe(200);
    clock += 3600_000 + 1;
    expect((await mcp(body.access_token)).status).toBe(401);
  });

  it('refuses a wrong or missing verifier', async () => {
    for (const code_verifier of ['w'.repeat(50), '']) {
      const { clientId, code } = await authCode();
      const res = await exchange(clientId, code, { code_verifier });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
  });

  it('refuses a wrong resource', async () => {
    const { clientId, code } = await authCode();
    const res = await exchange(clientId, code, { resource: 'https://other.example/mcp' });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('refuses a wrong redirect or client', async () => {
    const a = await authCode();
    expect((await exchange(a.clientId, a.code, { redirect_uri: 'http://127.0.0.1:1/callback' })).status).toBe(400);
    const b = await authCode();
    expect((await exchange(await register([REDIRECT], 'Other'), b.code)).status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const { clientId, code } = await authCode();
    clock += 61_000;
    expect((await exchange(clientId, code)).status).toBe(400);
  });

  it('ends the grant when a code comes back a second time', async () => {
    const { clientId, code } = await authCode();
    const first = (await (await exchange(clientId, code)).json()) as { access_token: string };
    expect((await mcp(first.access_token)).status).toBe(200);
    expect((await exchange(clientId, code)).status).toBe(400);
    expect((await mcp(first.access_token)).status).toBe(401);
    expect(service.grants.list()).toEqual([]);
  });

  it('rotates the refresh token, and a reused one ends the grant', async () => {
    const { clientId, refresh: first } = await tokens();
    const res = await refresh(clientId, first);
    expect(res.status).toBe(200);
    const next = (await res.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(first);
    expect((await mcp(next.access_token)).status).toBe(200);

    const reused = await refresh(clientId, first);
    expect(((await reused.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await mcp(next.access_token)).status).toBe(401);
    expect((await refresh(clientId, next.refresh_token)).status).toBe(400);
    expect(service.grants.list()).toEqual([]);
  });

  it('refuses a refresh from another client, or for another resource', async () => {
    const { clientId, refresh: token } = await tokens();
    expect((await refresh(await register([REDIRECT], 'Other'), token)).status).toBe(400);
    expect((await refresh(clientId, token, { resource: 'https://other.example/mcp' })).status).toBe(400);
  });

  it('keeps refresh tokens across a restart, and access tokens not', async () => {
    const { clientId, access, refresh: token } = await tokens();
    const port = service.status().port!;
    await service.stop();
    await makeService({ port });
    // fetch's pooled connection to the same port died with the old server.
    await fetch(origin).catch(() => undefined);
    expect((await mcp(access)).status).toBe(401);
    expect((await refresh(clientId, token)).status).toBe(200);
  });

  it('limits wrong codes here too', async () => {
    const clientId = await register();
    for (let i = 0; i < 10; i++) await exchange(clientId, `bad-${i}`);
    expect((await exchange(clientId, 'one-more')).status).toBe(429);
  });
});

describe('a token is good only for what it was given', () => {
  it('a refresh token is not an access token', async () => {
    const { refresh: token } = await tokens();
    expect((await mcp(token)).status).toBe(401);
  });

  it('a token for one audience gets 401 and a challenge at another', async () => {
    const { access } = await tokens();
    const other = `http://localhost:${service.status().port!}/mcp`;
    const res = await mcp(access, other);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

describe('secrets stay out of files and logs', () => {
  it('writes no token, code or verifier in the grant file, the audit file or the log', async () => {
    const lines: string[] = [];
    await service.stop();
    await makeService({ log: (l) => lines.push(l) });
    const { clientId, code } = await authCode();
    const body = (await (await exchange(clientId, code)).json()) as { access_token: string; refresh_token: string };
    await refresh(clientId, body.refresh_token);
    await refresh(clientId, body.refresh_token);
    const written = [readFileSync(path.join(dir, 'grants.json'), 'utf8'), lines.join('\n')].join('\n');
    for (const secret of [code, body.access_token, body.refresh_token, VERIFIER]) expect(written).not.toContain(secret);
  });
});

describe('a metadata document as client_id (CIMD)', () => {
  const URLID = 'https://agent.example/client.json';

  it('names the agent from its document', async () => {
    const fetchClient = vi.fn(async () => ({ name: 'Hosted Bot', redirectUris: ['https://agent.example/cb'] }));
    await service.stop();
    await makeService({ fetchClient });
    const page = await fetch(authorizeUrl(URLID, { redirect_uri: 'https://agent.example/cb' }));
    expect(await page.text()).toContain('Hosted Bot');
    expect(fetchClient).toHaveBeenCalledWith(URLID);
  });

  it('refuses a client whose document cannot be fetched', async () => {
    await service.stop();
    await makeService({ fetchClient: async () => { throw new Error('no'); } });
    expect((await fetch(authorizeUrl(URLID))).status).toBe(400);
  });

  it.each(['http://agent.example/c.json', 'https://u:p@agent.example/c.json', 'https://agent.example/', 'https://agent.example:8443/c.json', 'https://agent.example/c.json#x', 'file:///etc/passwd', `https://agent.example/${'x'.repeat(2000)}`])('does not fetch %s', (id) => {
    expect(clientIdUrl(id)).toBeUndefined();
  });

  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '224.0.0.1', 'not-an-ip'])('counts %s as not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '2606:4700:4700::1111'])('counts %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['https://127.0.0.1/c.json', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/c.json', 'https://10.0.0.1/c.json'])('refuses the private address in %s', async (id) => {
    await expect(fetchClientMetadata(id)).rejects.toThrow(/private address/);
  });

  const resolvesTo = (...addresses: string[]): LookupFunction => (_host, _opts, callback) => (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it.each([[['127.0.0.1']], [['169.254.169.254']], [['1.1.1.1', '10.0.0.5']]])('refuses a name that resolves to %j', async (addresses) => {
    await expect(fetchClientMetadata('https://rebind.example/c.json', { lookup: resolvesTo(...addresses) })).rejects.toThrow(/private address/);
  });

  it('never connects to the private address a name resolves to', async () => {
    let hits = 0;
    const local = createHttpServer((_req, res) => {
      hits++;
      res.end('{}');
    });
    await new Promise<void>((resolve) => local.listen(443, '127.0.0.1', resolve).once('error', () => resolve()));
    await expect(fetchClientMetadata('https://rebind.example/c.json', { lookup: resolvesTo('127.0.0.1') })).rejects.toThrow();
    expect(hits).toBe(0);
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  it('uses the real resolver by default, so a name for loopback is refused', async () => {
    await expect(fetchClientMetadata('https://localhost/c.json')).rejects.toThrow(/private address/);
  });

  it.each(['::127.0.0.1', '::7f00:1', '64:ff9b:1::7f00:1', 'fec0::1', '192.88.99.1'])('counts the odd form %s as not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  describe('against a server that misbehaves', () => {
    const ID = 'https://client.example/c.json';
    const DOCUMENT = JSON.stringify({ client_id: ID, redirect_uris: ['https://client.example/cb'] });
    let server: HttpServer | undefined;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    afterEach(async () => {
      spy?.mockRestore();
      server?.closeAllConnections();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    /** The name passes the guard as a public address, and the socket goes to a plain local server, which is the attacker's. */
    const attacker = async (handler: RequestListener): Promise<{ hits: () => number }> => {
      let hits = 0;
      server = createHttpServer((req, res) => {
        hits++;
        handler(req, res);
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const real = https.request.bind(https) as (url: URL, opts: https.RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;
      const agent = new https.Agent();
      (agent as unknown as { createConnection: () => Socket }).createConnection = () => createConnection({ port, host: '127.0.0.1' });
      spy = vi.spyOn(https, 'request').mockImplementation(((url: URL, opts: https.RequestOptions, cb: (res: IncomingMessage) => void) => real(url, { ...opts, agent }, cb)) as never);
      return { hits: () => hits };
    };

    it('reads a good document, so the rest of these attack the fetch and not the seam', async () => {
      await attacker((_req, res) => void res.end(DOCUMENT));
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1') })).resolves.toMatchObject({ redirectUris: ['https://client.example/cb'] });
    });

    it('a body that drips for ever is cut at the time limit, though no gap reaches it', async () => {
      await attacker((_req, res) => {
        res.writeHead(200);
        const drip = setInterval(() => res.write(' '), 20);
        res.once('close', () => clearInterval(drip));
      });
      const at = Date.now();
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1'), timeoutMs: 200 })).rejects.toThrow(/too long/);
      expect(Date.now() - at).toBeLessThan(2000);
    });

    it('a server that never answers is cut at the time limit', async () => {
      await attacker(() => undefined);
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1'), timeoutMs: 200 })).rejects.toThrow(/too long/);
    });

    it('an oversized document is refused while it comes', async () => {
      await attacker((_req, res) => {
        res.writeHead(200);
        res.write(Buffer.alloc(32 * 1024, 0x20));
        res.write(Buffer.alloc(32 * 1024, 0x20));
        res.write(Buffer.alloc(32 * 1024, 0x20));
      });
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1') })).rejects.toThrow(/too big/);
    });

    it.each([301, 302, 303, 307, 308])('a %i is not followed', async (status) => {
      const { hits } = await attacker((_req, res) => void res.writeHead(status, { location: 'https://169.254.169.254/latest/meta-data' }).end());
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1') })).rejects.toThrow(new RegExp(String(status)));
      expect(hits()).toBe(1);
    });

    it('a connection cut in the middle of the body is an error, not a wait', async () => {
      await attacker((req, res) => {
        res.writeHead(200, { 'content-length': '100' });
        res.write('{');
        setTimeout(() => req.socket.destroy(), 20);
      });
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1'), timeoutMs: 2000 })).rejects.toThrow(/aborted|hang up|reset/i);
    });

    it('a document for another client_id is refused', async () => {
      await attacker((_req, res) => void res.end(JSON.stringify({ client_id: 'https://other.example/c.json', redirect_uris: ['https://client.example/cb'] })));
      await expect(fetchClientMetadata(ID, { lookup: resolvesTo('1.1.1.1') })).rejects.toThrow(/another client_id/);
    });
  });
});
