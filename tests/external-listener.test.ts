import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { z } from 'zod';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { ExternalService, type ExternalServiceOptions } from '../src/external/service.js';

let dir: string;
const open: ExternalService[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-listener-'));
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

const newService = (): ExternalService => {
  const service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0 });
  open.push(service);
  return service;
};

const started = async (): Promise<{ service: ExternalService; port: number }> => {
  const service = newService();
  await service.setEnabled(true);
  return { service, port: service.status().port! };
};

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A raw request: fetch won't let a test set Host. */
const raw = (port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });

const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });

const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const grantToken = (service: ExternalService, over: { expiresAt?: number } = {}): string =>
  service.grants.create({ name: 'GrokBot', clientId: 'client-1', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: [], expiresAt: over.expiresAt ?? Date.now() + 60_000 }).token;

describe('turning the listener on and off', () => {
  it('listens on nothing until it is enabled', async () => {
    const service = newService();
    await service.start();
    expect(service.status()).toMatchObject({ on: false });
    expect(service.status().port).toBeUndefined();
  });

  it('stays off across a restart until enabled, and on after that', async () => {
    const first = newService();
    await first.start();
    await first.stop();

    const second = newService();
    await second.start();
    expect(second.status().on).toBe(false);
    await second.setEnabled(true);
    expect(second.status().on).toBe(true);
    await second.stop();

    const third = newService();
    await third.start();
    expect(third.status().on).toBe(true);
  });

  it('stops listening when it is turned off, and a restart keeps it off', async () => {
    const { service, port } = await started();
    await service.setEnabled(false);
    expect(await refused(port)).toBe(true);

    const next = newService();
    await next.start();
    expect(next.status().on).toBe(false);
  });

  it('closes the port when the daemon stops, without turning it off', async () => {
    const { service, port } = await started();
    expect(await refused(port)).toBe(false);
    await service.stop();
    expect(await refused(port)).toBe(true);
    const config = JSON.parse(readFileSync(path.join(dir, 'external.json'), 'utf8')) as { enabled: boolean };
    expect(config.enabled).toBe(true);
  });

  // Windows has no POSIX file modes.
  it.skipIf(process.platform === 'win32')('keeps its config private to you', async () => {
    await started();
    expect(statSync(path.join(dir, 'external.json')).mode & 0o777).toBe(0o600);
  });

  it('says so when the port is taken, and turning on fails', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    const service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: taken });
    open.push(service);
    await expect(service.setEnabled(true)).rejects.toThrow(/in use|EADDRINUSE/);
    expect(service.status().on).toBe(false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

describe('refusing before auth', () => {
  it('answers POST /mcp with no token with 401 and a resource_metadata challenge', async () => {
    const { port } = await started();
    const res = await raw(port, { headers: MCP_HEADERS, body: INITIALIZE });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('answers an unknown or expired token with 401 and invalid_token', async () => {
    const { service, port } = await started();
    const expired = grantToken(service, { expiresAt: Date.now() - 1 });
    for (const token of ['nope', expired]) {
      const res = await raw(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, body: INITIALIZE });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    }
  });

  it('answers a foreign Origin with 403, even with a good token', async () => {
    const { service, port } = await started();
    const token = grantToken(service);
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`, 'not a url']) {
      const res = await raw(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, origin }, body: INITIALIZE });
      expect(res.status, origin).toBe(403);
    }
  });

  it('refuses a Host it does not answer to, against DNS rebinding', async () => {
    const { service, port } = await started();
    const token = grantToken(service);
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1:1', `user@127.0.0.1:${port}`]) {
      const res = await raw(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, host }, body: INITIALIZE });
      expect(res.status, host).toBe(403);
    }
  });

  it('answers paths it does not serve with 404', async () => {
    const { port } = await started();
    expect((await raw(port, { path: '/', method: 'GET' })).status).toBe(404);
    expect((await raw(port, { path: '/mcp/board', method: 'POST' })).status).toBe(404);
  });
});

describe('a signed-in request', () => {
  it('reaches MCP on either loopback name, and from its own origin', async () => {
    const { service, port } = await started();
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${grantToken(service)}` };
    const plain = await raw(port, { headers, body: INITIALIZE });
    expect(plain.status).toBe(200);
    expect(plain.body).toContain('"serverInfo"');
    expect((await raw(port, { headers: { ...headers, host: `localhost:${port}`, origin: `http://localhost:${port}` }, body: INITIALIZE })).status).toBe(200);
  });

  it('only takes POST: no session, no stream', async () => {
    const { service, port } = await started();
    const res = await raw(port, { method: 'GET', headers: { authorization: `Bearer ${grantToken(service)}` } });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('answers a body that is not JSON with 400, and one too big with 413', async () => {
    const { service, port } = await started();
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${grantToken(service)}` };
    expect((await raw(port, { headers, body: '{nope' })).status).toBe(400);
    expect((await raw(port, { headers, body: `"${'x'.repeat(5 * 1024 * 1024)}"` })).status).toBe(413);
  });

  it('stops working at once when its grant is revoked', async () => {
    const { service, port } = await started();
    const created = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: [], expiresAt: Date.now() + 60_000 });
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${created.token}` };
    expect((await raw(port, { headers, body: INITIALIZE })).status).toBe(200);
    service.grants.revoke(created.grant.id);
    expect((await raw(port, { headers, body: INITIALIZE })).status).toBe(401);
  });
});

describe('the tool wrapper', () => {
  const SECRET = 'sk_' + 'live_abcdefghijklmnopqrstuvwx';
  const auditLines = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  const rawAudit = (): string => {
    try {
      return readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
    } catch {
      return '';
    }
  };

  const CHATS: Readonly<Record<string, string>> = { abc: 'p1', other: 'p2' };
  const readTool: ExternalToolDef = {
    name: 'beluga_chat_read',
    description: 'test',
    inputSchema: { chat: z.string(), note: z.string().optional() },
    resolve: (args, grant) => {
      const project = CHATS[args.chat as string];
      return project ? { target: `chat:${args.chat as string}`, inScope: grant.projects.includes(project) } : { denial: 'not_found', message: 'No such chat.' };
    },
    run: (args) => ({ read: args.chat }),
  };

  const withTools = async (over: Partial<ExternalServiceOptions> = {}, level: 'blocked' | 'ask' | 'trusted' = 'trusted'): Promise<{ service: ExternalService; port: number; token: string }> => {
    const service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0, tools: [readTool], ...over });
    open.push(service);
    await service.setEnabled(true);
    const { token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], expiresAt: Date.now() + 60_000 });
    return { service, port: service.status().port!, token };
  };

  const call = async (port: number, token: string, name: string, args: Record<string, unknown>): Promise<{ error?: unknown; result?: { isError?: boolean; content: Array<{ text: string }> } }> => {
    const res = await raw(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.parse(res.body) as { error?: unknown; result?: { isError?: boolean; content: Array<{ text: string }> } };
  };
  const denialOf = (answer: { result?: { content: Array<{ text: string }> } }): unknown => (JSON.parse(answer.result!.content[0]!.text) as { error?: string }).error;

  it('audits the registry\'s tool name and the grant\'s agent name for an allowed call', async () => {
    const { port, token } = await withTools();
    const answer = await call(port, token, 'beluga_chat_read', { chat: 'abc', note: SECRET });
    expect(answer.result?.isError).toBeUndefined();
    expect(auditLines()).toMatchObject([{ agent: 'GrokBot', tool: 'beluga_chat_read', class: 'read', target: 'chat:abc', decision: 'allow', decidedBy: 'rule', result: 'ok' }]);
    expect(rawAudit()).not.toContain(SECRET);
  });

  it('never writes a client-sent tool name holding a secret', async () => {
    const { port, token } = await withTools();
    const answer = await call(port, token, `beluga_chat_read ${SECRET}`, { chat: 'abc' });
    expect(answer.result?.isError ?? answer.error).toBeTruthy();
    expect(rawAudit()).not.toContain(SECRET);
  });

  it('builds a target only from a resolved id: an unknown chat leaves it empty', async () => {
    const { port, token } = await withTools();
    const answer = await call(port, token, 'beluga_chat_read', { chat: `nope-${SECRET}` });
    expect(denialOf(answer)).toBe('not_found');
    expect(auditLines()).toMatchObject([{ tool: 'beluga_chat_read', target: '', decision: 'deny', result: 'not_found' }]);
    expect(rawAudit()).not.toContain('nope-');
  });

  it('answers project_denied outside the grant\'s projects, with no card', async () => {
    let cards = 0;
    const { port, token } = await withTools({ ask: async () => { cards++; return 'yes'; } }, 'ask');
    expect(denialOf(await call(port, token, 'beluga_chat_read', { chat: 'other' }))).toBe('project_denied');
    expect(cards).toBe(0);
    expect(auditLines()).toMatchObject([{ target: 'chat:other', result: 'project_denied' }]);
  });

  it('refuses a blocked agent before resolving anything', async () => {
    const { port, token } = await withTools({}, 'blocked');
    expect(denialOf(await call(port, token, 'beluga_chat_read', { chat: 'other' }))).toBe('level_denied');
    expect(auditLines()).toMatchObject([{ target: '', result: 'level_denied' }]);
  });

  it('asks the owner at level ask: no is declined, always stops asking', async () => {
    const answers = ['no', 'always', 'yes'] as const;
    const cards: string[] = [];
    let n = 0;
    const { port, token } = await withTools({ ask: async (title, detail) => { cards.push(`${title} | ${detail}`); return answers[n++]!; } }, 'ask');
    expect(denialOf(await call(port, token, 'beluga_chat_read', { chat: 'abc' }))).toBe('declined');
    expect((await call(port, token, 'beluga_chat_read', { chat: 'abc' })).result?.isError).toBeUndefined();
    expect((await call(port, token, 'beluga_chat_read', { chat: 'abc' })).result?.isError).toBeUndefined();
    expect(cards).toEqual(Array(2).fill('GrokBot wants to use beluga_chat_read | On chat:abc\n{\n "chat": "abc"\n}'));
    expect(auditLines().map((l) => [l.decidedBy, l.result])).toEqual([['person', 'declined'], ['person', 'ok'], ['rule', 'ok']]);
  });

  it('says no when nobody can answer a card', async () => {
    const { port, token } = await withTools({}, 'ask');
    expect(denialOf(await call(port, token, 'beluga_chat_read', { chat: 'abc' }))).toBe('declined');
  });
});

describe('one grant book', () => {
  it('has a single place that opens it, and no CLI path does', () => {
    const all = execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const opening = all.filter((f) => /new GrantFile\(/.test(readFileSync(f, 'utf8')));
    expect(opening).toEqual(['src/external/service.ts']);
    const makingService = all.filter((f) => /new ExternalService\(/.test(readFileSync(f, 'utf8')));
    expect(makingService).toEqual(['src/external/launch.ts']);
    expect(all.filter((f) => f.startsWith('src/cli') && /grant-file|external\/service\.js'|external\/launch/.test(readFileSync(f, 'utf8').replace(/import type .*\n/g, '')))).toEqual([]);
  });
});
