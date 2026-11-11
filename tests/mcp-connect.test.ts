import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
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
