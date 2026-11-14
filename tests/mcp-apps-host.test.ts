import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { McpAppHost } from '../src/mcp-apps/adapters/app-host.js';

const hosts: McpAppHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});

function get(url: string, opts: { host?: string; method?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.host ? { host: opts.host } : {} }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('McpAppHost', () => {
  it('serves a page at its unguessable id with the CSP and frame-ancestors', async () => {
    const host = new McpAppHost(0);
    hosts.push(host);
    const url = await host.add('<p>hi</p>', "default-src 'none'; frame-ancestors tauri://localhost");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[0-9a-f]{32}\/$/);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body).toBe('<p>hi</p>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors tauri://localhost");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers only known ids', async () => {
    const host = new McpAppHost(0);
    hosts.push(host);
    const url = await host.add('<p>hi</p>', "default-src 'none'");
    const origin = new URL(url).origin;
    expect((await get(`${origin}/a/${'0'.repeat(32)}/`)).status).toBe(404);
    expect((await get(`${origin}/`)).status).toBe(404);
    expect((await get(`${url}other.js`)).status).toBe(404);
  });

  it('refuses a request under a host name that is not loopback (DNS rebinding)', async () => {
    const host = new McpAppHost(0);
    hosts.push(host);
    const url = await host.add('<p>hi</p>', "default-src 'none'");
    expect((await get(url, { host: 'evil.example.com' })).status).toBe(421);
  });

  it('answers GET only', async () => {
    const host = new McpAppHost(0);
    hosts.push(host);
    const url = await host.add('<p>hi</p>', "default-src 'none'");
    expect((await get(url, { method: 'POST' })).status).toBe(405);
  });
});
