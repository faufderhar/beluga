import { REMOTE_FULL_WARNING } from '../src/shared/remote-full.js';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { phoneMay } from '../src/companion/coverage.js';
import { mayCall } from '../src/daemon/server.js';
import { METHODS } from '../src/ipc/api.js';
import { runMcp } from '../src/cli/mcp.js';
import { externalConfigPath, readExternalConfig } from '../src/external/adapters/config-file.js';
import { grantFilePath } from '../src/external/adapters/grant-file.js';
import { clearDaemonInfo } from '../src/daemon/files.js';
import { parseConfig } from '../src/config.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { needExternal } from '../src/external/registry.js';

const running: RunningDaemon[] = [];
const output = async (...args: string[]): Promise<{ code: number; text: string }> => {
  let text = '';
  const code = await runMcp(args, (t) => void (text += t));
  return { code, text };
};
const daemon = async (): Promise<RunningDaemon> => {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true });
  running.push(d);
  return d;
};

afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  rmSync(externalConfigPath(), { force: true });
  rmSync(grantFilePath(), { force: true });
});

describe('beluga mcp, with Beluga not running', () => {
  it('remembers on and off for the next start', async () => {
    await output('on');
    expect(readExternalConfig().enabled).toBe(true);
    expect((await output('status')).text).toMatch(/not running.*on/);
    await output('off');
    expect(readExternalConfig().enabled).toBe(false);
  });

  it('prints the URL and says how to use a wrong command', async () => {
    expect((await output('url')).text).toBe('http://127.0.0.1:7778/mcp\n');
    const wrong = await output('nope');
    expect(wrong.code).toBe(1);
    expect(wrong.text).toContain('Usage: beluga mcp');
  });
});

describe('beluga mcp, with Beluga running', () => {
  it('makes a pairing code in the daemon, lists an agent, and a revoke ends it with no restart', async () => {
    process.env.BELUGA_EXTERNAL_PORT = '0';
    try {
      const d = await daemon();
      const url = /(http:\S+)/.exec((await output('on')).text)![1]!;
      expect((await output('pair', '--level', 'trusted')).text).toMatch(/^Pairing code: [A-Z2-7-]{20,}\n/);
      expect((await output('pair')).text).toContain('It gives: full, all projects and chats, direct messages, groups.');
      await expect(runMcp(['pair', '--level', 'blocked'], () => undefined)).rejects.toThrow(/--level/);
      await expect(runMcp(['pair', '--remote', '--level', 'full'], () => undefined)).rejects.toThrow(/--allow-remote-full/);
      const remoteFull = await output('pair', '--remote', '--level', 'full', '--allow-remote-full');
      expect(remoteFull.text).toMatch(/^Pairing code: /);
      expect(remoteFull.text).toContain(`WARNING: ${REMOTE_FULL_WARNING}`);
      expect((await output('pair', '--remote', '--level', 'trusted')).text).not.toContain('WARNING');
      expect((await output('pair', '--remote')).text).toContain('It gives: trusted,');

      const { grant, token } = needExternal(d.core.session).grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: [], expiresAt: Date.now() + 60_000 });
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
      expect((await output('agents')).text).toContain(`${grant.id}  GrokBot  trusted  local`);

      expect((await output('revoke', grant.id)).code).toBe(0);
      const after = await fetch(url, { method: 'POST', headers, body });
      expect(after.status).toBe(401);
      expect(after.headers.get('www-authenticate')).toContain('resource_metadata=');
      expect((await output('revoke', grant.id)).code).toBe(1);
      expect((await output('agents')).text).toBe('No external agents.\n');
    } finally {
      delete process.env.BELUGA_EXTERNAL_PORT;
    }
  });

  it('turns the daemon\'s listener on and off through it, and a daemon that stops closes it', async () => {
    process.env.BELUGA_EXTERNAL_PORT = '0';
    try {
      const d = await daemon();
      expect((await output('status')).text).toBe('External agents: off\n');
      const on = await output('on');
      expect(on.text).toMatch(/^External agents: on, at http:\/\/127\.0\.0\.1:\d+\/mcp\n$/);
      const url = /(http:\S+)/.exec(on.text)![1]!;
      expect((await fetch(url, { method: 'POST' })).status).toBe(401);
      await d.stop();
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
      expect(readExternalConfig().enabled).toBe(true);
    } finally {
      delete process.env.BELUGA_EXTERNAL_PORT;
    }
  });
});

const PHONE_STOPS: readonly string[] = ['external.agents', 'external.revoke', 'external.stopAgent', 'external.stopAll', 'external.activity'];

describe('who may manage external agents', () => {
  it('is the Mac app and the command line: never a browser; the phone only stops and looks', () => {
    const managing = METHODS.filter((m) => m.startsWith('external.'));
    expect(managing.length).toBeGreaterThan(4);
    for (const method of managing) {
      expect(mayCall('web', method), method).toBe(false);
      expect(mayCall('mac', method), method).toBe(true);
      expect(mayCall('cli', method), method).toBe(true);
      // From the phone a person may see agents and stop them (BLG-122), never connect one or change how it listens.
      expect(phoneMay(method), method).toBe(PHONE_STOPS.includes(method));
    }
    expect(mayCall('web', 'session.submit')).toBe(true);
  });

  it('refuses a socket from a browser page at the door', async () => {
    const d = await daemon();
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}`, { origin: 'https://evil.example' });
      ws.once('open', () => resolve(false));
      ws.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});
