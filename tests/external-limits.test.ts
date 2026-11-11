import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { grantLookup } from '../src/external/adapters/runs.js';
import { escapeHtml } from '../src/external/adapters/signin-page.js';
import { sessionControl } from '../src/external/adapters/session-control.js';
import { EXTERNAL_ACCESS } from '../src/external/coverage.js';
import { EXTERNAL_TOOLS } from '../src/external/domain/tools.js';
import { externalRequester } from '../src/core/trust.js';
import { REMOTE_FULL_WARNING } from '../src/shared/remote-full.js';
import type { Grant } from '../src/external/domain/grant.js';
import { FORM_MAX, LIMITS, RATE_WINDOW_MS, REMOTE_SIGN_IN, SUSPEND_AFTER, TOKEN_FAILURES, visitorOf, WindowCounter } from '../src/external/domain/limits.js';
import { ExternalService, type ExternalServiceOptions } from '../src/external/service.js';
import type { Session } from '../src/core/session.js';

const TUNNEL = 'https://some-name.trycloudflare.com';
const TUNNEL_HOST = 'some-name.trycloudflare.com';
const REDIRECT = 'https://hosted.example/cb';

let dir: string;
let clock: number;
const open: ExternalService[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-limits-'));
  clock = Date.now();
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

const tool = (name: ExternalToolDef['name'], over: Partial<ExternalToolDef> = {}): ExternalToolDef => ({ name, description: name, inputSchema: { n: z.number().optional() }, resolve: () => ({ target: '', inScope: true }), run: () => ({ ok: true }), ...over });

const started = async (extra: Partial<ExternalServiceOptions> = {}) => {
  const service = new ExternalService({
    configFile: path.join(dir, 'external.json'),
    grantFile: path.join(dir, 'grants.json'),
    auditFile: path.join(dir, 'audit.jsonl'),
    port: 0,
    now: () => clock,
    reach: { openTunnel: async (_p, _d) => ({ kind: 'cloudflared', publicUrl: TUNNEL, close: () => undefined }), reachable: async () => true },
    ...extra,
  });
  open.push(service);
  await service.setRoute('public', true);
  return { service, port: service.status().port! };
};

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const raw = (port: number, opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: { host: opts.host ?? TUNNEL_HOST, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });

const remoteGrant = (service: ExternalService, level: 'ask' | 'trusted' = 'trusted', projects: string[] = []): { grant: Grant; access: string } => {
  const { grant } = service.grants.create({ name: 'Hosted', clientId: 'c', redirectHost: 'hosted.example', route: 'remote', level, projects, expiresAt: clock + 3_600_000 });
  return { grant, access: service.grants.issueAccess(grant.id, `${TUNNEL}/mcp`, 3_600_000)! };
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const call = (name: string, id = 1): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const form = (values: Record<string, string>): { headers: Record<string, string>; body: string } => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });

const toolText = (answer: Answer): string => (JSON.parse(answer.body) as { result: { content: { text: string }[] } }).result.content[0]!.text;

describe('WindowCounter', () => {
  it('holds at most maxKeys keys, dropping the oldest', () => {
    const counter = new WindowCounter(() => 0, 1000, 2);
    expect(counter.take('a', 1)).toBe(true);
    expect(counter.take('a', 1)).toBe(false);
    counter.take('b', 1);
    counter.take('c', 1);
    expect(counter.size).toBe(2);
    expect(counter.take('a', 1)).toBe(true);
    expect(counter.take('c', 1)).toBe(false);
  });

  it('counts per key per window and forgets old hits', () => {
    let now = 0;
    const counter = new WindowCounter(() => now, 1000);
    expect(counter.take('a', 2)).toBe(true);
    expect(counter.take('a', 2)).toBe(true);
    expect(counter.take('a', 2)).toBe(false);
    expect(counter.take('b', 2)).toBe(true);
    now = 1001;
    expect(counter.take('a', 2)).toBe(true);
  });
});

describe('who a visitor is', () => {
  it('through a route: the proxy says, never the socket', () => {
    expect(visitorOf({ 'cf-connecting-ip': '1.2.3.4' }, '127.0.0.1', true)).toBe('public:1.2.3.4');
    expect(visitorOf({ 'tailscale-user-login': 'a@b.c' }, '127.0.0.1', true)).toBe('tailnet:a@b.c');
    expect(visitorOf({}, '127.0.0.1', true)).toBe('remote:unknown');
    expect(visitorOf({ 'cf-connecting-ip': '1.2.3.4' }, '127.0.0.1', false)).toBe('127.0.0.1');
  });
});

describe('rate limit per grant', () => {
  it('refuses a flood with 429 and Retry-After, the audit log shows it once, and it lifts after the window', async () => {
    const { service, port } = await started();
    const { access, grant } = remoteGrant(service);
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.remote.perMinute + 5; i++) statuses.push((await raw(port, { headers: bearer(access), body: ping })).status);
    expect(statuses.slice(0, LIMITS.remote.perMinute).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(LIMITS.remote.perMinute)).toEqual([429, 429, 429, 429, 429]);

    const refused = await raw(port, { headers: bearer(access), body: ping });
    expect(refused.headers['retry-after']).toBe('60');
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'rate_limited' });

    const records = service.activity({ agent: grant.id }).filter((r) => r.result === 'rate_limited');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'refused', decision: 'deny', decidedBy: 'rule' });

    clock += 61_000;
    expect((await raw(port, { headers: bearer(access), body: ping })).status).toBe(200);
  });

  it('a local grant has its own, larger limit', () => {
    expect(LIMITS.local.perMinute).toBeGreaterThan(LIMITS.remote.perMinute);
  });

  it('a flood of visitors with no token gets 429 too', async () => {
    const { port } = await started();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 2; i++) statuses.push((await raw(port, { headers: { 'cf-connecting-ip': '9.9.9.9' }, body: ping })).status);
    expect(statuses.at(0)).toBe(401);
    expect(statuses.at(-1)).toBe(429);
    // Someone else, and this computer, still get an answer.
    expect((await raw(port, { headers: { 'cf-connecting-ip': '8.8.8.8' }, body: ping })).status).toBe(401);
    expect((await raw(port, { host: `127.0.0.1:${port}`, body: ping })).status).toBe(401);
  });
});

describe('concurrent requests', () => {
  it('refuses more in flight than the cap, and frees the slot when one ends', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { service, port } = await started({ tools: [tool('beluga_chat_wait', { run: async () => { await held; return {}; } })] });
    const { access } = remoteGrant(service);
    const hanging = Array.from({ length: LIMITS.remote.inFlight }, (_, i) => raw(port, { headers: bearer(access), body: call('beluga_chat_wait', i) }));
    await vi.waitFor(async () => expect((await raw(port, { headers: bearer(access), body: ping })).status).toBe(429), { timeout: 3000 });
    release();
    expect((await Promise.all(hanging)).every((a) => a.status === 200)).toBe(true);
    await vi.waitFor(async () => expect((await raw(port, { headers: bearer(access), body: ping })).status).toBe(200), { timeout: 3000 });
  });
});

describe('body size', () => {
  it('refuses a remote body past its cap with 413, and a local grant may send more', async () => {
    const { service, port } = await started();
    const { access } = remoteGrant(service);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(LIMITS.remote.bodyBytes) } });
    expect((await raw(port, { headers: bearer(access), body: big })).status).toBe(413);
    const { token } = service.grants.create({ name: 'L', clientId: 'l', redirectHost: 'localhost', route: 'local', level: 'trusted', projects: [], expiresAt: clock + 60_000 });
    expect((await raw(port, { host: `127.0.0.1:${port}`, headers: bearer(token), body: big })).status).toBe(200);
  });
});

describe('response size', () => {
  it('cuts a long result for a remote grant and says so', async () => {
    const { service, port } = await started({ tools: [tool('beluga_chat_read', { run: () => ({ text: 'y'.repeat(LIMITS.remote.responseChars * 2) }) })] });
    const { access } = remoteGrant(service);
    const answer = await raw(port, { headers: bearer(access), body: call('beluga_chat_read') });
    const out = JSON.parse(toolText(answer)) as { truncated: boolean; partial: string; note: string };
    expect(out.truncated).toBe(true);
    expect(out.partial.length).toBe(LIMITS.remote.responseChars);
    expect(out.note).toMatch(/narrower/);
  });

  it('leaves a short result as it was', async () => {
    const { service, port } = await started({ tools: [tool('beluga_chat_read', { run: () => ({ text: 'short' }) })] });
    const { access } = remoteGrant(service);
    expect(JSON.parse(toolText(await raw(port, { headers: bearer(access), body: call('beluga_chat_read') })))).toEqual({ text: 'short' });
  });
});

describe('wrong codes through a route', () => {
  const pendingPage = async (port: number, host = TUNNEL_HOST, origin = TUNNEL, redirect = REDIRECT): Promise<string> => {
    const reg = await raw(port, { host, path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp` });
    return (await raw(port, { host, method: 'GET', path: `/authorize?${q}` })).body;
  };
  const pendingOf = (page: string): string => /name="pending" value="([^"]+)"/.exec(page)![1]!;

  it('stop after the hard per-visitor limit, while another visitor and this computer still try', async () => {
    const { port } = await started();
    const pending = pendingOf(await pendingPage(port));
    const wrong = (visitor: string, p = pending): Promise<Answer> => raw(port, { path: '/authorize', headers: { ...form({ pending: p, code: 'WRONG', action: 'approve' }).headers, 'cf-connecting-ip': visitor }, body: form({ pending: p, code: 'WRONG', action: 'approve' }).body });
    for (let i = 0; i < REMOTE_SIGN_IN.perAddress; i++) expect((await wrong('1.1.1.1')).status).toBe(200);
    expect((await wrong('1.1.1.1')).status).toBe(429);
    expect((await wrong('2.2.2.2')).status).toBe(200);
    const local = pendingOf(await pendingPage(port, `127.0.0.1:${port}`, `http://127.0.0.1:${port}`, 'http://127.0.0.1:9/cb'));
    const f = form({ pending: local, code: 'WRONG', action: 'approve' });
    expect((await raw(port, { host: `127.0.0.1:${port}`, path: '/authorize', ...f })).status).toBe(200);
  });

  it('stop for everyone after the total, whatever visitor they claim', async () => {
    const { port } = await started();
    const pending = pendingOf(await pendingPage(port));
    const f = form({ pending, code: 'WRONG', action: 'approve' });
    const statuses: number[] = [];
    for (let i = 0; i < REMOTE_SIGN_IN.total + 1; i++) statuses.push((await raw(port, { path: '/authorize', headers: { ...f.headers, 'cf-connecting-ip': `10.0.0.${i}` }, body: f.body })).status);
    expect(statuses.at(-2)).toBe(200);
    expect(statuses.at(-1)).toBe(429);
  });

  it('the page warns of a hosted redirect host, and a loopback redirect through a route says it is remote', async () => {
    const { port } = await started();
    expect(await pendingPage(port)).toContain('Anyone who runs that service gets the access');
    const loop = await pendingPage(port, TUNNEL_HOST, TUNNEL, 'http://127.0.0.1:9/cb');
    expect(loop).toContain('>Another computer<');
    expect(loop).not.toContain('>This computer<');
  });
});

describe('nobody else can lock a client out of /token', () => {
  /** A whole sign-in through the tunnel, as one visitor. */
  const signIn = async (service: ExternalService, port: number, visitor: string, host = TUNNEL_HOST, origin = TUNNEL, redirect = 'http://127.0.0.1:9/cb') => {
    const headers: Record<string, string> = visitor ? { 'cf-connecting-ip': visitor } : {};
    const reg = await raw(port, { host, path: '/register', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const resource = `${origin}/mcp`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource });
    const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}`, headers });
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)![1]!;
    const f = form({ pending, code: service.pairingCode({ level: 'trusted', projects: [] }).code, action: 'approve' });
    const posted = await raw(port, { host, path: '/authorize', headers: { ...headers, ...f.headers }, body: f.body });
    const code = posted.status === 303 ? new URL(posted.headers.location!).searchParams.get('code')! : '';
    const t = form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource });
    const tokens = await raw(port, { host, path: '/token', headers: { ...headers, ...t.headers }, body: t.body });
    return { posted, tokens, clientId, code, verifier, redirect, resource, refresh: tokens.status === 200 ? (JSON.parse(tokens.body) as { refresh_token: string }).refresh_token : '' };
  };
  const junkRefresh = (port: number, visitor: string): Promise<Answer> => {
    const f = form({ grant_type: 'refresh_token', refresh_token: 'junk', client_id: 'junk' });
    return raw(port, { path: '/token', headers: { ...f.headers, 'cf-connecting-ip': visitor }, body: f.body });
  };
  const goodRefresh = (port: number, visitor: string, clientId: string, refresh: string): Promise<Answer> => {
    const f = form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    return raw(port, { path: '/token', headers: { ...f.headers, 'cf-connecting-ip': visitor }, body: f.body });
  };
  const wrongCode = async (port: number, visitor: string): Promise<Answer> => {
    const reg = await raw(port, { path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${TUNNEL}/mcp` });
    const page = await raw(port, { method: 'GET', path: `/authorize?${q}` });
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)![1]!;
    const f = form({ pending, code: 'WRONG', action: 'approve' });
    return raw(port, { path: '/authorize', headers: { ...f.headers, 'cf-connecting-ip': visitor }, body: f.body });
  };

  it('a junk flood over many visitors, each under its own limit, gets 429 with one record; valid tokens and local clients are not touched', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    const SECRET = 'junk-refresh-token-value-for-the-file-check';
    const junk = form({ grant_type: 'refresh_token', refresh_token: SECRET, client_id: SECRET });
    const statuses: number[] = [];
    for (let i = 0; i < TOKEN_FAILURES.totalPerMinute + 5; i++) statuses.push((await raw(port, { path: '/token', headers: { ...junk.headers, 'cf-connecting-ip': `10.${i >> 8}.${i & 255}.9` }, body: junk.body })).status);
    expect(statuses.slice(0, TOKEN_FAILURES.totalPerMinute).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(TOKEN_FAILURES.totalPerMinute)).toEqual([429, 429, 429, 429, 429]);
    const refused = await raw(port, { path: '/token', headers: { ...junk.headers, 'cf-connecting-ip': '4.4.4.4' }, body: junk.body });
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'slow_down' });

    const file = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
    expect(file.trim().split('\n').map((l) => JSON.parse(l) as unknown)).toEqual([expect.objectContaining({ agent: 'visitor', tool: 'token_failures', result: 'rate_limited' })]);
    expect(file).not.toContain(SECRET);

    expect((await goodRefresh(port, '8.8.8.8', clientId, refresh)).status).toBe(200);
    const exchanged = await signIn(service, port, '9.9.9.9');
    expect(exchanged.tokens.status).toBe(200);

    const local = await raw(port, { host: `127.0.0.1:${port}`, path: '/token', ...junk });
    expect(JSON.parse(local.body)).toMatchObject({ error: 'invalid_grant' });

    clock += RATE_WINDOW_MS + 1;
    expect((await raw(port, { path: '/token', headers: { ...junk.headers, 'cf-connecting-ip': '3.3.3.3' }, body: junk.body })).status).toBe(400);
  }, 60_000);

  it('more junk than the visitor total, from many visitors, then a valid refresh gets 200', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    for (let i = 0; i < LIMITS.remoteVisitor.totalPerMinute + 10; i++) await junkRefresh(port, `10.${i >> 8}.${i & 255}.1`);
    expect((await goodRefresh(port, '8.8.8.8', clientId, refresh)).status).toBe(200);
  }, 60_000);

  it('more junk than the per-visitor limit from one visitor, then a valid refresh from it gets 200', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 10; i++) await junkRefresh(port, '6.6.6.6');
    expect((await goodRefresh(port, '6.6.6.6', clientId, refresh)).status).toBe(200);
  }, 60_000);

  it('junk at /token does not use up the visitor limits, and other paths still get through', async () => {
    const { port } = await started();
    for (let i = 0; i < LIMITS.remoteVisitor.totalPerMinute + 10; i++) await junkRefresh(port, i % 2 ? '6.6.6.6' : `10.${i >> 8}.${i & 255}.2`);
    expect((await raw(port, { headers: { 'cf-connecting-ip': '6.6.6.6' }, body: ping })).status).toBe(401);
    expect((await raw(port, { headers: { 'cf-connecting-ip': '8.8.8.8' }, body: ping })).status).toBe(401);
  }, 60_000);

  it('a /token flood writes one record, for /token only', async () => {
    const { port } = await started();
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 10; i++) await junkRefresh(port, '6.6.6.6');
    const lines = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; agent: string });
    expect(lines).toEqual([expect.objectContaining({ tool: 'token_failures', agent: 'visitor' })]);
  }, 60_000);

  it('an oversized form at /token gets 413 and is not read as a token', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    const big = form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, pad: 'x'.repeat(FORM_MAX) });
    expect((await raw(port, { path: '/token', headers: { ...big.headers, 'cf-connecting-ip': '6.6.6.6' }, body: big.body })).status).toBe(413);
    expect((await goodRefresh(port, '6.6.6.6', clientId, refresh)).status).toBe(200);
  });

  it('a huge body at /token is cut off: it cannot use the path with no limit to send without end', async () => {
    const { port } = await started();
    const CHUNKS = 64;
    const unsent = await new Promise<number>((resolve) => {
      let left = CHUNKS;
      const req = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path: '/token', headers: { host: TUNNEL_HOST, 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, (res) => res.resume());
      req.on('error', () => resolve(left));
      req.on('close', () => resolve(left));
      const chunk = Buffer.alloc(256 * 1024, 120);
      const pump = (): void => {
        if (left === 0) return void req.end();
        left -= 1;
        req.write(chunk, (err) => {
          if (!err) setImmediate(pump);
        });
      };
      pump();
    });
    expect(unsent).toBeGreaterThan(CHUNKS / 2);
  }, 30_000);

  it('one visitor past its limit does not use up the total, so another visitor gets through', async () => {
    const { port } = await started();
    const { perMinute, totalPerMinute } = LIMITS.remoteVisitor;
    const flood = (count: number): Promise<Answer[]> => Promise.all(Array.from({ length: count }, () => raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': '6.6.6.6' } })));
    const answers: Answer[] = [];
    for (let sent = 0; sent < totalPerMinute + 10; sent += 100) answers.push(...(await flood(100)));
    expect(answers.filter((a) => a.status === 404)).toHaveLength(perMinute);
    expect(answers.at(-1)!.status).toBe(429);
    expect((await raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': '7.7.7.7' } })).status).toBe(404);
  }, 60_000);

  it('a spent refresh token ends the work of its grant, as a revoke does', async () => {
    const stopWork = vi.fn(() => true);
    const { service, port } = await started({ stopWork });
    const { grant } = remoteGrant(service);
    const spent = service.grants.issueRefresh(grant.id, `${TUNNEL}/mcp`)!;
    service.grants.issueRefresh(grant.id, `${TUNNEL}/mcp`);
    const f = form({ grant_type: 'refresh_token', refresh_token: spent, client_id: 'c' });
    expect((await raw(port, { path: '/token', headers: f.headers, body: f.body })).status).toBe(400);
    expect(service.grants.list()).toEqual([]);
    expect(stopWork).toHaveBeenCalledWith(grant.id);
  });

  it('a replayed authorization code ends the work of its grant, as a revoke does', async () => {
    const stopWork = vi.fn(() => true);
    const { service, port } = await started({ stopWork });
    const signedIn = await signIn(service, port, '8.8.8.8');
    expect(service.grants.list()).toHaveLength(1);
    const f = form({ grant_type: 'authorization_code', code: signedIn.code, client_id: signedIn.clientId, redirect_uri: signedIn.redirect, code_verifier: signedIn.verifier, resource: signedIn.resource });
    expect((await raw(port, { path: '/token', headers: { ...f.headers, 'cf-connecting-ip': '8.8.8.8' }, body: f.body })).status).toBe(400);
    expect(service.grants.list()).toEqual([]);
    expect(stopWork).toHaveBeenCalled();
  });

  describe('a flood past the visitor total', () => {
    const flood = async (port: number, headers: Record<string, string> = {}): Promise<void> => {
      const { totalPerMinute } = LIMITS.remoteVisitor;
      for (let sent = 0; sent < totalPerMinute + 20; sent += 100) await Promise.all(Array.from({ length: 100 }, (_, i) => raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': `10.${sent >> 8}.${sent & 255}.${i}`, ...headers } })));
    };

    it("leaves a connected agent's valid MCP call working", async () => {
      const { service, port } = await started({ tools: [tool('beluga_chat_list')] });
      const { access } = remoteGrant(service);
      await flood(port);
      expect((await raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': '9.9.9.9' } })).status).toBe(429);
      const answer = await raw(port, { headers: { ...bearer(access), 'cf-connecting-ip': '9.9.9.9' }, body: call('beluga_chat_list') });
      expect(answer.status).toBe(200);
      expect(toolText(answer)).toContain('ok');
    }, 60_000);

    it('still counts an invalid bearer token as a visitor', async () => {
      const { port } = await started();
      const { perMinute } = LIMITS.remoteVisitor;
      const statuses: number[] = [];
      for (let i = 0; i < perMinute + 1; i += 50) statuses.push(...(await Promise.all(Array.from({ length: 50 }, () => raw(port, { headers: { ...bearer('not-a-token'), 'cf-connecting-ip': '6.6.6.6' }, body: ping })))).map((a) => a.status));
      expect(statuses.filter((s) => s === 401)).toHaveLength(perMinute);
      expect(statuses.at(-1)).toBe(429);
    }, 60_000);

    it('a valid token past its own grant limit gets its rate limit, and no visitor is charged', async () => {
      const { service, port } = await started();
      const { access } = remoteGrant(service);
      const statuses: number[] = [];
      for (let i = 0; i < LIMITS.remote.perMinute + 1; i++) statuses.push((await raw(port, { headers: { ...bearer(access), 'cf-connecting-ip': '5.5.5.5' }, body: ping })).status);
      expect(statuses.at(-1)).toBe(429);
      expect((await raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': '5.5.5.5' } })).status).toBe(404);
    }, 60_000);
  });

  it('other paths are still refused past the visitor total', async () => {
    const { port } = await started();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.remoteVisitor.totalPerMinute + 1; i++) statuses.push((await raw(port, { path: '/nothing-here', method: 'GET', headers: { 'cf-connecting-ip': `10.${i >> 8}.${i & 255}.3` } })).status);
    expect(statuses.at(0)).toBe(404);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('a GET at /token stays under the visitor limits', async () => {
    const { port } = await started();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 1; i++) statuses.push((await raw(port, { path: '/token', method: 'GET', headers: { 'cf-connecting-ip': '5.5.5.5' } })).status);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('junk from many visitors, then a valid refresh from another visitor gets 200', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    for (let i = 0; i < REMOTE_SIGN_IN.total * 2; i++) expect((await junkRefresh(port, `10.0.0.${i}`)).status).toBe(400);
    expect((await goodRefresh(port, '8.8.8.8', clientId, refresh)).status).toBe(200);
  });

  it('a visitor past its limit gets slow_down on junk, and a valid refresh from it gets 200', async () => {
    const { service, port } = await started();
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    for (let i = 0; i < TOKEN_FAILURES.perVisitor; i++) expect((await junkRefresh(port, '6.6.6.6')).status).toBe(400);
    const refused = await junkRefresh(port, '6.6.6.6');
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'slow_down' });
    expect((await goodRefresh(port, '6.6.6.6', clientId, refresh)).status).toBe(200);
    // The limit is that visitor's only.
    expect((await junkRefresh(port, '5.5.5.5')).status).toBe(400);
    clock += TOKEN_FAILURES.windowMs + 1;
    expect((await junkRefresh(port, '6.6.6.6')).status).toBe(400);
  });

  it('junk /token requests do not use up the wrong-code total, and a right code still works', async () => {
    const { service, port } = await started();
    for (let i = 0; i < REMOTE_SIGN_IN.total + 1; i++) await junkRefresh(port, `10.0.1.${i}`);
    const { posted, tokens } = await signIn(service, port, '7.7.7.7');
    expect(posted.status).toBe(303);
    expect(tokens.status).toBe(200);
  });

  it('wrong codes do not use up a visitor\'s /token failures', async () => {
    const { port } = await started();
    for (let i = 0; i < REMOTE_SIGN_IN.perAddress; i++) await wrongCode(port, '4.4.4.4');
    expect((await junkRefresh(port, '4.4.4.4')).status).toBe(400);
  });

  it('past the wrong-code total: a right code is refused through a route and not spent, a local sign-in works, one notice; existing agents go on', async () => {
    const lockouts: number[] = [];
    const { service, port } = await started({ notifyLockout: () => lockouts.push(clock) });
    const { clientId, refresh } = await signIn(service, port, '7.7.7.7');
    for (let i = 0; i < REMOTE_SIGN_IN.total; i++) expect((await wrongCode(port, `10.0.2.${i}`)).status).toBe(200);
    expect(lockouts).toEqual([clock]);

    const { posted } = await signIn(service, port, '8.8.8.8');
    expect(posted.status).toBe(429);
    expect((await wrongCode(port, '9.9.9.9')).status).toBe(429);
    expect(lockouts).toHaveLength(1);

    const local = await signIn(service, port, '', `127.0.0.1:${port}`, `http://127.0.0.1:${port}`);
    expect(local.posted.status).toBe(303);
    expect(local.tokens.status).toBe(200);
    expect((await goodRefresh(port, '7.7.7.7', clientId, refresh)).status).toBe(200);
  });

  it('a new lockout after the window gets a new notice', async () => {
    const lockouts: number[] = [];
    const { port } = await started({ notifyLockout: () => lockouts.push(clock) });
    for (let i = 0; i < REMOTE_SIGN_IN.total; i++) await wrongCode(port, `10.0.3.${i}`);
    clock += REMOTE_SIGN_IN.windowMs + 1;
    expect((await wrongCode(port, '3.3.3.3')).status).toBe(200);
    for (let i = 1; i < REMOTE_SIGN_IN.total; i++) await wrongCode(port, `10.0.4.${i}`);
    expect(lockouts).toHaveLength(2);
  });
});

describe('refusals with no agent behind them, in the raw audit file', () => {
  const SECRET = 'junk-token-value-that-must-not-be-kept';
  const lines = (): { agent: string; tool: string; target: string; result: string; decision: string; summary: string }[] => {
    const file = path.join(dir, 'audit.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as never) : [];
  };
  const raw_ = (): string => (existsSync(path.join(dir, 'audit.jsonl')) ? readFileSync(path.join(dir, 'audit.jsonl'), 'utf8') : '');
  const flood = async (port: number): Promise<void> => {
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 5; i++) await raw(port, { headers: { 'cf-connecting-ip': '9.9.9.9', authorization: `Bearer ${SECRET}` }, body: ping });
  };
  const junkTokens = async (port: number): Promise<void> => {
    const f = form({ grant_type: 'refresh_token', refresh_token: SECRET, client_id: SECRET });
    for (let i = 0; i < TOKEN_FAILURES.perVisitor + 3; i++) await raw(port, { path: '/token', headers: { ...f.headers, 'cf-connecting-ip': '6.6.6.6' }, body: f.body });
  };
  const wrongCodes = async (port: number): Promise<void> => {
    const reg = await raw(port, { path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${TUNNEL}/mcp` });
    const page = await raw(port, { method: 'GET', path: `/authorize?${q}` });
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)![1]!;
    const f = form({ pending, code: SECRET, action: 'approve' });
    for (let i = 0; i < REMOTE_SIGN_IN.perAddress + 3; i++) await raw(port, { path: '/authorize', headers: { ...f.headers, 'cf-connecting-ip': '5.5.5.5' }, body: f.body });
  };

  it('a tokenless flood writes one record, result rate_limited, agent visitor', async () => {
    const { port } = await started();
    for (let i = 0; i < LIMITS.remoteVisitor.perMinute + 5; i++) await raw(port, { headers: { 'cf-connecting-ip': '9.9.9.9' }, body: ping });
    expect(lines()).toEqual([expect.objectContaining({ agent: 'visitor', result: 'rate_limited', decision: 'deny', tool: 'visitor_flood', target: '' })]);
  });

  it('each sign-in limiter refusal writes one record per window', async () => {
    const { port } = await started();
    await junkTokens(port);
    expect(lines().map((l) => l.tool)).toEqual(['token_failures']);
    await wrongCodes(port);
    expect(lines().map((l) => l.tool)).toEqual(['token_failures', 'wrong_pairing_codes']);
    expect(lines().every((l) => l.agent === 'visitor' && l.result === 'rate_limited')).toBe(true);
  });

  it('a flood over several windows adds one record per window per kind', async () => {
    const { port } = await started();
    const count = (tool: string): number => lines().filter((l) => l.tool === tool).length;
    await flood(port);
    await junkTokens(port);
    await wrongCodes(port);
    clock += RATE_WINDOW_MS + 1;
    await flood(port);
    expect([count('visitor_flood'), count('token_failures'), count('wrong_pairing_codes')]).toEqual([2, 1, 1]);
    clock += REMOTE_SIGN_IN.windowMs + 1;
    await junkTokens(port);
    await wrongCodes(port);
    expect([count('visitor_flood'), count('token_failures'), count('wrong_pairing_codes')]).toEqual([2, 2, 2]);
  });

  it('many claimed visitors still write one record', async () => {
    const { port } = await started();
    const f = form({ grant_type: 'refresh_token', refresh_token: SECRET, client_id: SECRET });
    for (let v = 0; v < 5; v++) for (let i = 0; i < TOKEN_FAILURES.perVisitor + 1; i++) await raw(port, { path: '/token', headers: { ...f.headers, 'cf-connecting-ip': `10.0.5.${v}` }, body: f.body });
    expect(lines()).toHaveLength(1);
    expect(raw_()).not.toContain('10.0.5.');
  });

  it('a junk token value does not reach the file', async () => {
    const { port } = await started();
    await flood(port);
    await junkTokens(port);
    await wrongCodes(port);
    expect(lines().length).toBe(3);
    expect(raw_()).not.toContain(SECRET);
  });

  it('shows in Activity as refused', async () => {
    const { service, port } = await started();
    await junkTokens(port);
    expect(service.activity({ kind: 'refused' })).toEqual([expect.objectContaining({ agent: 'visitor', tool: 'token_failures' })]);
  });
});

describe('a call that waits for the owner', () => {
  const WAIT = 30;
  const toolOut = (a: Answer): { error?: string; message?: string; ok?: boolean } => JSON.parse(toolText(a)) as never;
  const setup = async (answers: Promise<'yes' | 'no' | 'always'>[], keep = 5000) => {
    const ran = vi.fn(() => ({ ok: true }));
    const cards: string[] = [];
    const { service, port } = await started({
      cardWaitMs: WAIT,
      cardKeepMs: keep,
      tools: [tool('beluga_chat_read', { run: ran })],
      ask: (title) => {
        cards.push(title);
        return answers.shift() ?? new Promise(() => undefined);
      },
    });
    const { access, grant } = remoteGrant(service, 'ask');
    const go = (): Promise<Answer> => raw(port, { headers: bearer(access), body: call('beluga_chat_read') });
    return { service, go, ran, cards, grant };
  };
  const held = (): { promise: Promise<'yes' | 'no' | 'always'>; answer: (a: 'yes' | 'no' | 'always') => void } => {
    let answer: (a: 'yes' | 'no' | 'always') => void = () => undefined;
    const promise = new Promise<'yes' | 'no' | 'always'>((r) => { answer = r; });
    return { promise, answer };
  };

  it('stops waiting with a typed result that says a person must answer, and nothing ran', async () => {
    const { go, ran, cards, service, grant } = await setup([held().promise]);
    const out = toolOut(await go());
    expect(out.error).toBe('waiting_for_owner');
    expect(out.message).toMatch(/owner.*card.*same arguments/is);
    expect(ran).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(service.activity({ agent: grant.id })[0]).toMatchObject({ result: 'waiting_for_owner', decision: 'ask', decidedBy: 'rule' });
  });

  it('a call again with the same arguments shows no second card, and gets the answer given meanwhile', async () => {
    const card = held();
    const { go, ran, cards } = await setup([card.promise]);
    expect(toolOut(await go()).error).toBe('waiting_for_owner');
    expect(toolOut(await go()).error).toBe('waiting_for_owner');
    expect(cards).toHaveLength(1);
    card.answer('yes');
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).not.toHaveBeenCalled();
    expect(toolOut(await go())).toEqual({ ok: true });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('one yes runs one call: the next one asks again', async () => {
    const { go, ran, cards } = await setup([Promise.resolve('yes'), held().promise]);
    expect(toolOut(await go())).toEqual({ ok: true });
    expect(toolOut(await go()).error).toBe('waiting_for_owner');
    expect(cards).toHaveLength(2);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('a no given meanwhile reaches the next call as declined', async () => {
    const card = held();
    const { go, ran } = await setup([card.promise]);
    await go();
    card.answer('no');
    const out = toolOut(await go());
    expect(out.error).toBe('declined');
    expect(out.message).toMatch(/did not answer/);
    expect(ran).not.toHaveBeenCalled();
  });

  it('an answer nobody came back for is dropped', async () => {
    const card = held();
    const { go, ran, cards } = await setup([card.promise], 10);
    await go();
    card.answer('yes');
    await new Promise((r) => setTimeout(r, 40));
    expect(toolOut(await go()).error).toBe('waiting_for_owner');
    expect(cards).toHaveLength(2);
    expect(ran).not.toHaveBeenCalled();
  });

  it('waiting does not count toward suspension', async () => {
    const { go, service } = await setup([held().promise]);
    for (let i = 0; i < SUSPEND_AFTER.denials + 1; i++) await go();
    expect(service.grants.list()[0]!.suspendedAt).toBeUndefined();
  });

  it('a revoke drops what the card held', async () => {
    const card = held();
    const { go, ran, service, grant } = await setup([card.promise]);
    await go();
    card.answer('yes');
    service.revoke(grant.id);
    expect((await go()).status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe('a remote grant at full, by an explicit choice', () => {
  const pagePending = (page: string): string => /name="pending" value="([^"]+)"/.exec(page)![1]!;
  const signInPage = async (port: number): Promise<string> => {
    const reg = await raw(port, { path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Hosted', redirect_uris: [REDIRECT] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${TUNNEL}/mcp` });
    return (await raw(port, { method: 'GET', path: `/authorize?${q}` })).body;
  };
  const post = (port: number, values: Record<string, string>): Promise<Answer> => raw(port, { path: '/authorize', ...form(values) });

  it('the sign-in page shows the warning and asks again, and only that makes the grant', async () => {
    const seen: Grant[] = [];
    const { service, port } = await started({ notifyRemoteFull: (g) => seen.push(g) });
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'full', projects: ['p1'], remote: true, allowRemoteFull: true });

    const first = await post(port, { pending, code, action: 'approve' });
    expect(first.status).toBe(200);
    expect(first.body).toContain(escapeHtml(REMOTE_FULL_WARNING));
    expect(first.body).toContain('hosted.example');
    expect(first.body).toContain('name="confirm_full"');
    expect(service.grants.list()).toEqual([]);
    expect(seen).toEqual([]);

    const second = await post(port, { pending: pagePending(first.body), code, action: 'approve', confirm_full: 'yes' });
    expect(second.status).toBe(303);
    expect(service.grants.list()).toMatchObject([{ route: 'remote', level: 'full', projects: ['p1'], redirectHost: 'hosted.example' }]);
    expect(seen.map((g) => g.level)).toEqual(['full']);
  });

  it('its answer is no-store, unframed and scriptless, and the code is in no address', async () => {
    const { service, port } = await started();
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'full', projects: ['p1'], remote: true, allowRemoteFull: true });
    const page = await post(port, { pending, code, action: 'approve' });
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.body).not.toContain('<script');
    expect(page.body).not.toContain('<a ');
    expect(page.body).not.toContain('<img');
  });

  it('"Don\'t connect" on it ends the code: a person refused what it gives', async () => {
    const { service, port } = await started();
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'full', projects: ['p1'], remote: true, allowRemoteFull: true });
    const page = await post(port, { pending, code, action: 'approve' });
    const denied = await post(port, { pending: pagePending(page.body), code, action: 'deny' });
    expect(denied.status).toBe(303);
    expect(denied.headers.location).toContain('error=access_denied');
    const again = await post(port, { pending: pagePending(await signInPage(port)), code, action: 'approve', confirm_full: 'yes' });
    expect(again.body).toContain('wrong, used or expired');
    expect(service.grants.list()).toEqual([]);
  });

  it('a visitor who only says no ends no code', async () => {
    const { service, port } = await started();
    const { code } = service.pairingCode({ level: 'trusted', projects: ['p1'], remote: true });
    await post(port, { pending: pagePending(await signInPage(port)), action: 'deny' });
    expect((await post(port, { pending: pagePending(await signInPage(port)), code, action: 'approve' })).status).toBe(303);
  });

  it('a remote full code with a loopback redirect is told as what it is: not this computer', async () => {
    const { service, port } = await started();
    const host = `127.0.0.1:${port}`;
    const redirect = 'http://127.0.0.1:9/cb';
    const reg = await raw(port, { host, path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `http://${host}/mcp` });
    const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}` });
    const { code } = service.pairingCode({ level: 'full', projects: [], remote: true, allowRemoteFull: true });
    const first = await raw(port, { host, path: '/authorize', ...form({ pending: pagePending(page.body), code, action: 'approve' }) });
    expect(first.body).toContain('>Another computer<');
    expect(first.body).not.toContain('>This computer<');
  });

  it('the first answer spends nothing, so a page left open can come back; a second grant needs a new code', async () => {
    const { service, port } = await started();
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'full', projects: [], remote: true, allowRemoteFull: true });
    await post(port, { pending, code, action: 'approve' });
    expect((await post(port, { pending, code, action: 'approve', confirm_full: 'yes' })).status).toBe(303);
    const again = await post(port, { pending: pagePending(await signInPage(port)), code, action: 'approve', confirm_full: 'yes' });
    expect(again.body).toContain('wrong, used or expired');
    expect(service.grants.list()).toHaveLength(1);
  });

  it('a sign-in cannot raise a level: a confirm on a lower code gives that lower level, with no warning', async () => {
    const { service, port } = await started();
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'ask', projects: [], remote: true });
    expect((await post(port, { pending, code, action: 'approve', confirm_full: 'yes', level: 'full', allowRemoteFull: 'true' })).status).toBe(303);
    expect(service.grants.list()).toMatchObject([{ route: 'remote', level: 'ask' }]);
    expect(service.grants.list()[0]!.allowRemoteFull).toBeUndefined();
  });

  it('a local full code stays refused through a route, whatever the form says', async () => {
    const { service, port } = await started();
    const pending = pagePending(await signInPage(port));
    const { code } = service.pairingCode({ level: 'full', projects: [] });
    expect((await post(port, { pending, code, action: 'approve', confirm_full: 'yes' })).status).toBe(403);
    expect(service.grants.list()).toEqual([]);
  });

  const remoteFull = (service: ExternalService): { grant: Grant; access: string } => {
    const { grant } = service.grants.create({ name: 'Hosted', clientId: 'c', redirectHost: 'hosted.example', route: 'remote', level: 'full', allowRemoteFull: true, projects: ['p1'], expiresAt: clock + 3_600_000 });
    return { grant, access: service.grants.issueAccess(grant.id, `${TUNNEL}/mcp`, 3_600_000)! };
  };

  it('a tool call at full shows no card where the table says allow', async () => {
    const cards: { title: string; once: boolean }[] = [];
    const { service, port } = await started({
      tools: [tool('beluga_chat_read'), tool('beluga_chat_send'), tool('beluga_chat_update'), tool('beluga_chat_interrupt')],
      ask: async (title, _d, once) => {
        cards.push({ title, once });
        return 'yes';
      },
    });
    const { access } = remoteFull(service);
    for (const name of ['beluga_chat_read', 'beluga_chat_send', 'beluga_chat_update', 'beluga_chat_interrupt']) expect(JSON.parse(toolText(await raw(port, { headers: bearer(access), body: call(name) })))).toEqual({ ok: true });
    expect(cards).toEqual([]);
  });

  it('a run goes at full; a grant raised by hand is blocked', async () => {
    const { service } = await started();
    const { grant } = remoteFull(service);
    expect(grantLookup(service.grants, () => clock)(externalRequester(grant.id))).toEqual({ name: 'Hosted', level: 'full' });
    const raised = { ...grant, allowRemoteFull: false };
    expect(grantLookup({ list: () => [raised] }, () => clock)(externalRequester(grant.id))).toEqual({ name: 'Hosted', level: 'blocked' });
  });

  it('answering an approval and changing a grant stay refused: no tool does them, and the API keeps them for people', () => {
    expect(EXTERNAL_TOOLS.filter((t) => /answer_approval|grant|^external/i.test(t))).toEqual([]);
    for (const method of ['host.answerApproval', 'external.pairingCode', 'external.localToken', 'external.revoke', 'external.resume', 'external.setPaused', 'external.setRoute', 'external.setEnabled'] as const) expect(EXTERNAL_ACCESS[method], method).toHaveProperty('refused');
    // The owner chose a card for this one (BLG-244), which tests/external-methods walks at remote full.
    expect(EXTERNAL_ACCESS['people.setTrust']).toBe('gated');
  });

  it('run limits, the limits on size and suspension stay those of a remote grant', async () => {
    const { service, port } = await started({ tools: [tool('beluga_chat_read', { resolve: () => ({ target: 'project:x', inScope: false }) })] });
    const { access } = remoteFull(service);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(LIMITS.remote.bodyBytes) } });
    expect((await raw(port, { headers: bearer(access), body: big })).status).toBe(413);
    for (let i = 0; i < SUSPEND_AFTER.denials; i++) await raw(port, { headers: bearer(access), body: call('beluga_chat_read', i) });
    expect(service.grants.list()[0]!.suspendedAt).toBe(clock);
  });
});

describe('remote grants', () => {
  it('a remote code at full without the explicit choice is refused when it is made', async () => {
    const { service } = await started();
    expect(() => service.pairingCode({ level: 'full', projects: [], remote: true })).toThrow(/--allow-remote-full/);
    expect(() => service.pairingCode({ level: 'full', projects: [], remote: true, allowRemoteFull: false })).toThrow(/--allow-remote-full/);
    expect(service.pairingCode({ level: 'full', projects: [], remote: true, allowRemoteFull: true }).code).toBeTruthy();
    expect(service.pairingCode({ level: 'trusted', projects: [], remote: true }).code).toBeTruthy();
    await expect(service.localToken('x', { level: 'ask', projects: [], remote: true })).rejects.toThrow(/remote/);
  });

  it('the explicit choice goes only with a remote code at full', async () => {
    const { service } = await started();
    expect(() => service.pairingCode({ level: 'full', projects: [], allowRemoteFull: true })).toThrow(/--remote/);
    expect(() => service.pairingCode({ level: 'trusted', projects: [], remote: true, allowRemoteFull: true })).toThrow(/--level full/);
  });

  it('a remote code makes a remote grant even at the local address; its chats and projects are only what the code gave', async () => {
    const { service, port } = await started();
    const host = `127.0.0.1:${port}`;
    const redirect = 'http://127.0.0.1:9/cb';
    const reg = await raw(port, { host, path: '/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `http://${host}/mcp` });
    const page = await raw(port, { host, method: 'GET', path: `/authorize?${q}` });
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)![1]!;
    await raw(port, { host, path: '/authorize', ...form({ pending, code: service.pairingCode({ level: 'trusted', projects: ['p1'], remote: true }).code, action: 'approve' }) });
    expect(service.grants.list()).toMatchObject([{ route: 'remote', level: 'trusted', projects: ['p1'], chats: { dms: false, groups: false } }]);
  });
});

describe('suspension', () => {
  const denied = tool('beluga_chat_launch', { resolve: () => ({ target: 'project:x', inScope: false }) });

  it('after repeated denials: a typed error, a notice, its work stopped, an audit record; resume lifts it', async () => {
    const suspended: string[] = [];
    const stopWork = vi.fn(() => true);
    const { service, port } = await started({ tools: [denied, tool('beluga_chat_read')], notifySuspended: (g) => suspended.push(g.name), stopWork });
    const { access, grant } = remoteGrant(service);
    for (let i = 0; i < SUSPEND_AFTER.denials; i++) expect((await raw(port, { headers: bearer(access), body: call('beluga_chat_launch', i) })).status).toBe(200);

    expect(suspended).toEqual(['Hosted']);
    expect(stopWork).toHaveBeenCalledWith(grant.id);
    expect(service.grants.list()[0]!.suspendedAt).toBe(clock);
    const refused = await raw(port, { headers: bearer(access), body: call('beluga_chat_read') });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'grant_suspended' });
    expect(service.activity({ agent: grant.id }).some((r) => r.result === 'grant_suspended')).toBe(true);

    expect(service.resume(grant.id)).toBe(true);
    expect(service.grants.list()[0]!.suspendedAt).toBeUndefined();
    expect((await raw(port, { headers: bearer(access), body: call('beluga_chat_read') })).status).toBe(200);
    // The count starts over: one more denial doesn't suspend it again.
    await raw(port, { headers: bearer(access), body: call('beluga_chat_launch') });
    expect(service.grants.list()[0]!.suspendedAt).toBeUndefined();
    expect(service.resume('nope')).toBe(false);
  });

  it('survives a restart', async () => {
    const { service, port } = await started({ tools: [denied] });
    const { access, grant } = remoteGrant(service);
    for (let i = 0; i < SUSPEND_AFTER.denials; i++) await raw(port, { headers: bearer(access), body: call('beluga_chat_launch', i) });
    await service.stop();
    const next = await started();
    expect(next.service.grants.list().find((g) => g.id === grant.id)?.suspendedAt).toBe(clock);
  });

  it('denials spread out over more than the window do not suspend', async () => {
    const { service, port } = await started({ tools: [denied] });
    const { access } = remoteGrant(service);
    for (let i = 0; i < SUSPEND_AFTER.denials + 2; i++) {
      await raw(port, { headers: bearer(access), body: call('beluga_chat_launch', i) });
      clock += SUSPEND_AFTER.windowMs / 4;
    }
    expect(service.grants.list()[0]!.suspendedAt).toBeUndefined();
  });

  it('a local grant is not suspended', async () => {
    const { service, port } = await started({ tools: [denied] });
    const { token } = service.grants.create({ name: 'L', clientId: 'l', redirectHost: 'localhost', route: 'local', level: 'trusted', projects: [], expiresAt: clock + 60_000 });
    for (let i = 0; i < SUSPEND_AFTER.denials + 1; i++) await raw(port, { host: `127.0.0.1:${port}`, headers: bearer(token), body: call('beluga_chat_launch', i) });
    expect(service.grants.list()[0]!.suspendedAt).toBeUndefined();
  });
});

describe('concurrent runs', () => {
  const session = (running: readonly string[]): Session =>
    ({
      host: { externalLevel: () => 'trusted', externalRunChannels: () => running, mayRestartExternal: () => true, runningIn: () => false, runExternal: () => 'started' },
      agentRef: { runtime: 'claude' },
      sendChat: () => undefined,
      workspaces: { agentIn: () => undefined, ensureLoaded: () => undefined },
      store: { getState: () => ({ questions: [] }) },
    }) as unknown as Session;
  const by = { id: 'abc', name: 'Hosted' };

  it('refuses a new run past the cap with a typed error', async () => {
    const control = sessionControl(session(['ws:a', 'ws:b']), { runCap: () => 2 });
    await expect(control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).rejects.toMatchObject({ denial: 'rate_limited' });
  });

  it('lets a message into a chat where its run already goes', async () => {
    const control = sessionControl(session(['ws:a', 'ws:b']), { runCap: () => 2 });
    await expect(control.send({ by, chatId: 'a', message: 'm', mode: 'auto' })).resolves.toMatchObject({ delivery: 'started' });
  });

  it('under the cap it runs', async () => {
    const control = sessionControl(session(['ws:a']), { runCap: () => 2 });
    await expect(control.send({ by, chatId: 'c', message: 'm', mode: 'auto' })).resolves.toMatchObject({ delivery: 'started' });
  });
});
