import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllKeptSessions } from '../src/agent/runtime/claude/kept-sessions.js';
import { McpConnect, type McpSession, type OpenMcpSession } from '../src/agent/runtime/claude/mcp-connect.js';

/** A home with one server of yours, one plugin's and one a project sets. */
function home(): { home: string; project: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-connect-'));
  const project = path.join(dir, 'ratel');
  const plugin = path.join(dir, '.claude', 'plugins', 'cache', 'vercel');
  mkdirSync(path.join(dir, '.claude', 'plugins'), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://f' } }, projects: { [project]: { mcpServers: { linear: { type: 'sse', url: 'https://l' } } } } }));
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'vercel@official': true } }));
  writeFileSync(path.join(dir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'vercel@official': [{ scope: 'user', installPath: plugin }] } }));
  writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { vercel: { type: 'http', url: 'https://v' } } }));
  return { home: dir, project };
}

/** Claude Code as these tests need it: statuses in turn (the last one stays), and a sign-in page. */
function fake(statuses: McpServerStatus[][], authUrl?: string): { open: OpenMcpSession; opened: Array<{ cwd: string; names: string[] }>; closed: () => number; asked: string[] } {
  const opened: Array<{ cwd: string; names: string[] }> = [];
  const asked: string[] = [];
  let closed = 0;
  const open: OpenMcpSession = (cwd, servers) => {
    opened.push({ cwd, names: Object.keys(servers) });
    let i = 0;
    const session: McpSession = {
      mcpServerStatus: async () => statuses[Math.min(i++, statuses.length - 1)]!,
      mcpAuthenticate: async (name) => {
        asked.push(name);
        return authUrl ? { authUrl, requiresUserAction: true } : { requiresUserAction: false };
      },
      close: () => void closed++,
    };
    return session;
  };
  return { open, opened, closed: () => closed, asked };
}

const http = (name: string, status: McpServerStatus['status'], extra: Partial<McpServerStatus> = {}): McpServerStatus => ({ name, status, config: { type: 'http', url: 'https://x' }, scope: 'dynamic', ...extra });
const quick = { pollMs: 1, settleMs: 200, signInMs: 200 };

describe('McpConnect', () => {
  it('lists your servers with where each comes from, once none is still starting', async () => {
    const h = home();
    const f = fake([
      [http('figma', 'pending'), http('plugin:vercel:vercel', 'needs-auth')],
      [http('figma', 'connected'), http('plugin:vercel:vercel', 'needs-auth'), http('linear', 'failed', { error: 'timed out', config: { type: 'sse', url: 'https://l' } }), { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' }],
    ]);
    const rows = await new McpConnect(f.open, { ...quick, env: {}, home: h.home }).list(['/room', h.project]);
    expect(f.opened[0]).toEqual({ cwd: '/room', names: expect.arrayContaining(['figma', 'plugin:vercel:vercel', 'linear']) });
    expect(rows).toEqual([
      { name: 'figma', label: 'figma', from: 'user', status: 'connected', canSignIn: false },
      { name: 'plugin:vercel:vercel', label: 'vercel', from: 'plugin', where: 'vercel', status: 'needs-auth', canSignIn: true },
      { name: 'linear', label: 'linear', from: 'project', where: 'ratel', status: 'failed', error: 'timed out', canSignIn: false },
      { name: 'claude.ai Gmail', label: 'Gmail', from: 'claude.ai', status: 'needs-auth', canSignIn: false },
    ]);
    expect(f.closed()).toBe(1);
  });

  it('reads ${VAR} in your servers from the variables you saved in Beluga, and gives Claude Code them too (#442)', async () => {
    const h = home();
    writeFileSync(path.join(h.home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://g', headers: { Authorization: 'Bearer ${GITHUB_PAT_TOKEN}' } } } }));
    const servers: Array<Record<string, unknown>> = [];
    const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const open: OpenMcpSession = (cwd, s, env) => {
      servers.push(s as Record<string, unknown>);
      envs.push(env);
      return fake([[http('github', 'connected')]]).open(cwd, s);
    };
    const ownEnv = (dir: string): Record<string, string> => (dir === '/room' ? { GITHUB_PAT_TOKEN: 'saved-token' } : {});
    await new McpConnect(open, { ...quick, env: { PATH: '/bin' }, ownEnv, home: h.home }).list(['/room']);
    expect(servers[0]?.github).toMatchObject({ headers: { Authorization: 'Bearer saved-token' } });
    expect(envs[0]).toEqual({ PATH: '/bin', GITHUB_PAT_TOKEN: 'saved-token' });
    // Without saved variables, Claude Code keeps Beluga's own environment, as before.
    envs.length = 0;
    await new McpConnect(open, { ...quick, env: {}, home: h.home }).list(['/room']);
    expect(envs[0]).toBeUndefined();
  });

  it('signs in: gives the page, keeps Claude Code waiting until the server connects, then lets it go', async () => {
    const h = home();
    const f = fake([[http('figma', 'needs-auth')], [http('figma', 'needs-auth')], [http('figma', 'connected')]], 'https://figma.com/oauth?x=1');
    const mcp = new McpConnect(f.open, { ...quick, env: {}, home: h.home });
    expect(await mcp.signIn(['/room'], 'figma')).toEqual({ url: 'https://figma.com/oauth?x=1' });
    expect(f.asked).toEqual(['figma']);
    expect(f.closed()).toBe(0);
    expect(await mcp.signedIn('figma')).toBe(true);
    expect(f.closed()).toBe(1);
    expect(await mcp.signedIn('figma')).toBeUndefined();
  });

  it('gives up after a while when you never come back from the browser', async () => {
    const h = home();
    const f = fake([[http('figma', 'needs-auth')]], 'https://figma.com/oauth');
    const mcp = new McpConnect(f.open, { ...quick, signInMs: 20, env: {}, home: h.home });
    await mcp.signIn(['/room'], 'figma');
    expect(await mcp.signedIn('figma')).toBe(false);
    expect(f.closed()).toBe(1);
  });

  it('says so for a server you do not have, or one already signed in', async () => {
    const h = home();
    const f = fake([[]]);
    const mcp = new McpConnect(f.open, { ...quick, env: {}, home: h.home });
    expect(await mcp.signIn(['/room'], 'planted')).toEqual({ error: 'No MCP server named planted.' });
    expect(f.opened).toHaveLength(0);
    expect(await mcp.signIn(['/room'], 'figma')).toEqual({ connected: true });
    expect(f.closed()).toBe(1);
  });
});

describe('McpConnect.readUiResource (MCP Apps)', () => {
  const st = (name: string, status: McpServerStatus['status']): McpServerStatus => ({ name, status }) as McpServerStatus;

  it('reads the page once its server is up, without waiting for the others, and keeps the session for the app', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'pending'), st('linear', 'pending')], [st('figma', 'connected'), st('linear', 'pending')]]);
    const read: Array<[string, string]> = [];
    let closed = 0;
    const open: OpenMcpSession = (cwd, servers) => {
      const s = f.open(cwd, servers);
      return {
        ...s,
        readMcpResource: async (server: string, uri: string) => {
          read.push([server, uri]);
          return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>app</p>', _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } } }] };
        },
        close: () => void closed++,
      };
    };
    const mcp = new McpConnect(open, { home: dir, env: {}, settleMs: 60_000, pollMs: 1 });
    const page = await mcp.readUiResource([dir], 'figma', 'ui://figma/app.html');
    expect(page).toEqual({ html: '<p>app</p>', meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } } });
    expect(read).toEqual([['figma', 'ui://figma/app.html']]);
    expect(closed).toBe(0);
    mcp.close();
    expect(closed).toBe(1);
  });

  it('says so when Claude Code cannot read resources', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'connected')]]);
    const mcp = new McpConnect(f.open, { home: dir, env: {}, pollMs: 1 });
    await expect(mcp.readUiResource([dir], 'figma', 'ui://figma/app.html')).rejects.toThrow(/can’t read MCP App views/);
    expect(f.closed()).toBe(1);
  });
});

describe('McpConnect app calls (MCP Apps: apps.call, apps.read)', () => {
  const st = (name: string, status: McpServerStatus['status'], tools?: unknown[]): McpServerStatus => ({ name, status, ...(tools ? { tools } : {}) }) as McpServerStatus;

  it('lists one server’s tools with their annotations and _meta, once it is up', async () => {
    const { home: dir } = home();
    const tools = [{ name: 'now', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://f/a.html' } } }];
    const f = fake([[st('figma', 'pending')], [st('figma', 'connected', tools)]]);
    const mcp = new McpConnect(f.open, { home: dir, env: {}, settleMs: 60_000, pollMs: 1 });
    expect(await mcp.appTools([dir], 'figma')).toEqual(tools);
    expect(await mcp.appTools([dir], 'linear')).toEqual([]);
    // linear is not up: its session is not kept.
    expect(f.closed()).toBe(1);
    mcp.close();
    expect(f.closed()).toBe(2);
  });

  it('calls a tool with mcp_call over the session’s control channel', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'connected')]]);
    const sent: unknown[] = [];
    let closed = 0;
    const open: OpenMcpSession = (cwd, servers) => ({
      ...f.open(cwd, servers),
      request: async (req: Record<string, unknown>) => {
        sent.push(req);
        return { response: { content: [{ type: 'text', text: 'ok' }] } };
      },
      close: () => void closed++,
    });
    const mcp = new McpConnect(open, { home: dir, env: {}, pollMs: 1 });
    expect(await mcp.appCall([dir], 'figma', 'now', { a: 1 })).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(sent).toEqual([{ subtype: 'mcp_call', tool: 'mcp__figma__now', arguments: { a: 1 }, result_not_for_model: true }]);
    mcp.close();
    expect(closed).toBe(1);
  });

  it('says so when Claude Code cannot call tools for apps', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'connected')]]);
    const mcp = new McpConnect(f.open, { home: dir, env: {}, pollMs: 1 });
    await expect(mcp.appCall([dir], 'figma', 'now', {})).rejects.toThrow(/can’t call MCP App tools/);
    expect(f.closed()).toBe(1);
  });

  it('reads a resource whole for the app', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'connected')]]);
    const open: OpenMcpSession = (cwd, servers) => ({
      ...f.open(cwd, servers),
      readMcpResource: async (_s: string, uri: string) => ({ contents: [{ uri, blob: 'AA==' }] }),
    });
    const mcp = new McpConnect(open, { home: dir, env: {}, pollMs: 1 });
    expect(await mcp.appRead([dir], 'figma', 'ui://figma/x.png')).toEqual({ contents: [{ uri: 'ui://figma/x.png', blob: 'AA==' }] });
  });
});

describe('McpConnect: an MCP App whose server needs a sign-in', () => {
  const st = (name: string, status: McpServerStatus['status']): McpServerStatus => ({ name, status }) as McpServerStatus;

  it('says the server needs a sign-in, and never reads or calls it', async () => {
    const { home: dir } = home();
    const f = fake([[st('figma', 'needs-auth')]]);
    const asked: string[] = [];
    const open: OpenMcpSession = (cwd, servers) => ({
      ...f.open(cwd, servers),
      readMcpResource: async (_s: string, uri: string) => (asked.push(uri), { contents: [] }),
      request: async () => (asked.push('call'), { response: { content: [] } }),
    });
    const mcp = new McpConnect(open, { home: dir, env: {}, pollMs: 1 });
    await expect(mcp.readUiResource([dir], 'figma', 'ui://figma/app.html')).rejects.toThrow(/figma needs you to sign in/);
    await expect(mcp.appCall([dir], 'figma', 'now', {})).rejects.toThrow(/sign in/);
    expect(asked).toEqual([]);
  });
});

describe('McpConnect: one kept session per server for app calls (BLG-391)', () => {
  const st = (name: string, status: McpServerStatus['status']): McpServerStatus => ({ name, status }) as McpServerStatus;
  const ok = { content: [{ type: 'text', text: 'ok' }] };

  /** Claude Code whose servers are as given; each session's mcp_call answers ok unless `fails`. */
  function claude(statuses: McpServerStatus[], fails = false): { open: OpenMcpSession; opened: () => number; closed: () => number; calls: () => number } {
    const f = fake([statuses]);
    let calls = 0;
    const open: OpenMcpSession = (cwd, servers) => ({
      ...f.open(cwd, servers),
      request: async () => {
        calls++;
        if (fails) throw new Error('Claude Code went away');
        return { response: ok };
      },
    });
    return { open, opened: () => f.opened.length, closed: f.closed, calls: () => calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens no new session for a second call, or for the tool list before it', async () => {
    const { home: dir } = home();
    const c = claude([st('figma', 'connected')]);
    const mcp = new McpConnect(c.open, { home: dir, env: {}, pollMs: 1 });
    await mcp.appTools([dir], 'figma');
    await mcp.appCall([dir], 'figma', 'now', {});
    expect(await mcp.appCall([dir], 'figma', 'now', {})).toEqual(ok);
    expect(c.opened()).toBe(1);
    expect(c.calls()).toBe(2);
    expect(c.closed()).toBe(0);
    mcp.close();
  });

  it('keeps one session for each server', async () => {
    const { home: dir } = home();
    const c = claude([st('figma', 'connected'), st('linear', 'connected')]);
    const mcp = new McpConnect(c.open, { home: dir, env: {}, pollMs: 1 });
    await Promise.all([mcp.appCall([dir], 'figma', 'now', {}), mcp.appCall([dir], 'figma', 'now', {}), mcp.appCall([dir], 'linear', 'now', {})]);
    expect(c.opened()).toBe(2);
    mcp.close();
    expect(c.closed()).toBe(2);
  });

  it('closes a session after it was idle for a while, and opens a new one after that', async () => {
    vi.useFakeTimers();
    const { home: dir } = home();
    const c = claude([st('figma', 'connected')]);
    const mcp = new McpConnect(c.open, { home: dir, env: {}, pollMs: 1, keepMs: 1_000 });
    await mcp.appCall([dir], 'figma', 'now', {});
    await vi.advanceTimersByTimeAsync(600);
    // A use starts the idle time again.
    await mcp.appCall([dir], 'figma', 'now', {});
    await vi.advanceTimersByTimeAsync(600);
    expect(c.closed()).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(c.closed()).toBe(1);
    await mcp.appCall([dir], 'figma', 'now', {});
    expect(c.opened()).toBe(2);
    mcp.close();
  });

  it('closes the kept sessions when it closes, and when the daemon stops', async () => {
    const { home: dir } = home();
    const a = claude([st('figma', 'connected')]);
    const b = claude([st('figma', 'connected')]);
    const first = new McpConnect(a.open, { home: dir, env: {}, pollMs: 1 });
    const second = new McpConnect(b.open, { home: dir, env: {}, pollMs: 1 });
    await first.appCall([dir], 'figma', 'now', {});
    await second.appCall([dir], 'figma', 'now', {});
    first.close();
    expect(a.closed()).toBe(1);
    // The daemon's exit closes every session still kept.
    closeAllKeptSessions();
    expect(b.closed()).toBe(1);
    await second.appCall([dir], 'figma', 'now', {});
    expect(b.opened()).toBe(2);
    second.close();
  });

  it('never keeps a session that failed', async () => {
    const { home: dir } = home();
    const c = claude([st('figma', 'connected')], true);
    const mcp = new McpConnect(c.open, { home: dir, env: {}, pollMs: 1 });
    await expect(mcp.appCall([dir], 'figma', 'now', {})).rejects.toThrow(/went away/);
    expect(c.closed()).toBe(1);
    await expect(mcp.appCall([dir], 'figma', 'now', {})).rejects.toThrow(/went away/);
    expect(c.opened()).toBe(2);
    expect(c.closed()).toBe(2);
  });

  it('never keeps a session whose server is not up', async () => {
    const { home: dir } = home();
    const c = claude([st('figma', 'failed')]);
    const mcp = new McpConnect(c.open, { home: dir, env: {}, pollMs: 1 });
    expect(await mcp.appTools([dir], 'figma')).toEqual([]);
    expect(c.closed()).toBe(1);
  });
});
