import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { WEB_ADMIN } from '../src/daemon/server.js';
import { WEB_HELLO_TOKEN, checkBind, privateBind, splitWebArgs } from '../src/daemon/web.js';
import { readWebConfig, webConfigPath } from '../src/daemon/web-access.js';
import { safeName, sweepUploads, uploadsDir } from '../src/daemon/web-files.js';
import { COOKIE, SECURE_COOKIE, sessionCookie } from '../src/daemon/web-join.js';
import { WebSessions, webSessionsPath } from '../src/daemon/web-sessions.js';
import { IPC_VERSION } from '../src/ipc/protocol.js';
import { type Reply, builtUi, get } from './web-helpers.js';

/** The fixes the security review of the web port asked for (docs/security.md, Web access). */

function post(port: number, urlPath: string, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const daemons: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
  rmSync(webSessionsPath(), { force: true });
  rmSync(webConfigPath(), { force: true });
});

/** A daemon, a browser let in, and that browser's raw socket (frames as they come). */
async function browserIn(): Promise<{ d: RunningDaemon; ws: WebSocket; frames: Array<Record<string, unknown>>; send: (f: unknown) => void; port: number; cookie: string; origin: string }> {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root: builtUi() } });
  daemons.push(d);
  const port = Number(new URL(d.webUrl!).port);
  const origin = `http://127.0.0.1:${port}`;
  const joined = await post(port, '/join', JSON.stringify({ secret: d.web.sessions.link(d.webUrl!).url.split('#')[1] }), { origin });
  const cookie = String(joined.headers['set-cookie']?.[0]).split(';')[0]!;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin, cookie } });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await new Promise((r) => ws.once('open', r));
  const send = (f: unknown): void => ws.send(JSON.stringify(f));
  send({ t: 'hello', token: WEB_HELLO_TOKEN, ipc: IPC_VERSION, kind: 'mac', version: '1', caps: [] });
  await expect.poll(() => frames.some((f) => f.t === 'welcome')).toBe(true);
  return { d, ws, frames, send, port, cookie, origin };
}
const resultOf = (frames: Array<Record<string, unknown>>, id: string) => frames.find((f) => f.t === 'result' && f.id === id);

describe('a browser can use Beluga but not decide who gets in', () => {
  it('lists browsers, but may not make links, revoke or close the port', async () => {
    const { send, frames, ws } = await browserIn();
    send({ t: 'call', id: 'list', method: 'web.sessions.list', args: [] });
    for (const [i, method] of [...WEB_ADMIN].entries()) send({ t: 'call', id: `admin${i}`, method, args: method === 'web.sessions.revoke' ? ['x'] : [] });
    await expect.poll(() => frames.filter((f) => f.t === 'result').length).toBe(1 + WEB_ADMIN.size);
    expect(resultOf(frames, 'list')).toMatchObject({ ok: true });
    for (let i = 0; i < WEB_ADMIN.size; i++) expect(resultOf(frames, `admin${i}`)).toMatchObject({ ok: false, error: expect.stringMatching(/Beluga app or `beluga web`/) });
    ws.close();
  });

  it('is a web screen whatever its hello says', async () => {
    const { d, ws } = await browserIn();
    expect(d.server.clients.list().map((c) => c.kind)).toEqual(['web']);
    ws.close();
  });
});

describe('revoking cuts a browser off at once', () => {
  it("hears nothing more from a revoked browser, even one that doesn't answer the close", async () => {
    const { d, ws, frames, send } = await browserIn();
    const [me] = d.web.sessions.list();
    d.web.revoke(me!.id);
    // Sent after the revoke, before this side has even seen the close: never answered.
    send({ t: 'call', id: 'late', method: 'web.sessions.list', args: [] });
    await new Promise((r) => ws.once('close', r));
    expect(resultOf(frames, 'late')).toBeUndefined();
  });

  it('cuts off browsers pushed out when there are too many', () => {
    const revoked: string[] = [];
    let now = 1_000_000;
    const sessions = new WebSessions({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'ws-')), 'web-sessions.json'), onRevoke: (id) => revoked.push(id), now: () => (now += 1000) });
    const first = sessions.redeem(sessions.link('http://h').url.split('#')[1]!, 'x')!;
    for (let i = 0; i < 100; i++) sessions.redeem(sessions.link('http://h').url.split('#')[1]!, 'x');
    expect(revoked).toEqual([first.session.id]);
    expect(sessions.check(first.cookie)).toBeUndefined();
  });
});

describe('the session never travels in the clear', () => {
  it('refuses an address others reach over plain http, unless asked in so many words', () => {
    expect(() => checkBind({ host: '0.0.0.0', allowedHosts: [] })).toThrow(/plain http.*--insecure-http/);
    expect(() => checkBind({ host: '192.168.1.20', allowedHosts: [] })).toThrow(/--insecure-http/);
    expect(() => checkBind({ host: '0.0.0.0', allowedHosts: [], insecureHttp: true })).not.toThrow();
    for (const ok of ['127.0.0.1', '::1', 'localhost', '100.101.102.103', 'fd7a:115c:a1e0::1']) expect(privateBind(ok), ok).toBe(true);
    for (const no of ['0.0.0.0', '::', '10.0.0.2', '100.128.0.1', '8.8.8.8']) expect(privateBind(no), no).toBe(false);
    expect(() => checkBind({ host: '127.0.0.1', allowedHosts: ['*'] })).toThrow(/no wildcards/);
    expect(splitWebArgs(['--listen', '0.0.0.0', '--insecure-http']).web).toMatchObject({ host: '0.0.0.0', insecureHttp: true });
  });

  it("won't open such an address, and doesn't remember one opened with --insecure-http", async () => {
    await expect(startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { host: '0.0.0.0', port: 0, root: builtUi() } })).rejects.toThrow(/plain http/);
    clearDaemonInfo();
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { host: '0.0.0.0', port: 0, root: builtUi(), insecureHttp: true } });
    daemons.push(d);
    expect(d.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readWebConfig()).toBeUndefined();
  });

  it('on https, takes only the __Host- cookie (no other port could have set it)', () => {
    const req = (cookie: string) => ({ headers: { cookie } }) as never;
    expect(sessionCookie(req(`${COOKIE}=plain`), true)).toBeUndefined();
    expect(sessionCookie(req(`${COOKIE}=plain; ${SECURE_COOKIE}=good`), true)).toBe('good');
    expect(sessionCookie(req(`${COOKIE}=plain`), false)).toBe('plain');
  });
});

describe('the served app', () => {
  it('comes with a strict content security policy, and is cached privately', async () => {
    const { port, cookie, ws } = await browserIn();
    const index = await get(port, '/', { cookie });
    const csp = String(index.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(String((await get(port, '/assets/index-Ab12Cd34.js', { cookie })).headers['cache-control'])).toMatch(/^private,/);
    ws.close();
  });
});

describe('uploads', () => {
  it('names Windows would refuse get a prefix; trailing dots go', () => {
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('nul.txt')).toBe('_nul.txt');
    expect(safeName('report.pdf. ')).toBe('report.pdf');
    expect(safeName('console.log')).toBe('console.log');
  });

  it('clears copies made for downloads and uploads older than 30 days at a start', () => {
    const root = uploadsDir();
    for (const d of ['.out/abc', '2020-01-01/x', '2026-11-01/y']) mkdirSync(path.join(root, d), { recursive: true });
    expect(sweepUploads(Date.parse('2026-11-03T12:00:00Z'))).toBe(2);
    expect(existsSync(path.join(root, '.out'))).toBe(false);
    expect(existsSync(path.join(root, '2020-01-01'))).toBe(false);
    expect(existsSync(path.join(root, '2026-11-01'))).toBe(true);
  });
});
