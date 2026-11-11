import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMcp } from '../src/cli/mcp.js';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { externalConfigPath } from '../src/external/adapters/config-file.js';
import { grantFilePath } from '../src/external/adapters/grant-file.js';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { needExternal } from '../src/external/registry.js';
import { ExternalService } from '../src/external/service.js';
import { waitFor } from './helpers.js';

const tool: ExternalToolDef = { name: 'beluga_capabilities', description: 'test', inputSchema: {}, resolve: () => ({ target: '', inScope: true }), run: (_args, grant) => ({ level: grant.level }) };

let dir: string;
let service: ExternalService;
const cards: string[] = [];
let answer: 'yes' | 'no' = 'yes';

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-stdio-'));
  cards.length = 0;
  answer = 'yes';
  service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0, tools: [tool], ask: async (title) => { cards.push(title); return answer; } });
  await service.setEnabled(true);
});
afterEach(async () => {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
});

const bridge = (token: string): StdioClientTransport =>
  new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', 'mcp', 'stdio'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BELUGA_MCP_TOKEN: token, BELUGA_MCP_URL: service.status().url! },
    stderr: 'pipe',
  });

describe('beluga mcp stdio', () => {
  it('lets a stdio client call a tool, keeps the token out of ps, shows in the list and revokes the same way', async () => {
    const { grant, token } = await service.localToken('Local model', { level: 'trusted', projects: [] });
    expect(cards).toEqual(['A program on this Mac wants a Beluga token for Local model']);
    const transport = bridge(token);
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    const answered = await client.callTool({ name: 'beluga_capabilities', arguments: {} });
    expect(JSON.stringify(answered.content)).toContain('trusted');

    // Windows has no ps: the token goes by the environment there too, and this check is for macOS and Linux.
    if (process.platform !== 'win32') {
      const command = execFileSync('ps', ['-o', 'args=', '-p', String(transport.pid)], { encoding: 'utf8' });
      expect(command).toContain('mcp stdio');
      expect(command).not.toContain(token);
    }

    expect(service.grants.list()).toMatchObject([{ id: grant.id, name: 'Local model', route: 'local', level: 'trusted' }]);

    service.revoke(grant.id);
    await expect(client.callTool({ name: 'beluga_capabilities', arguments: {} })).rejects.toThrow(/refused|401|Unauthorized/i);
    await client.close();
  }, 30_000);

  it('makes no grant when the owner says no', async () => {
    answer = 'no';
    await expect(service.localToken('Local model', { level: 'ask', projects: [] })).rejects.toThrow(/Declined/);
    expect(service.grants.list()).toEqual([]);
  });

  it('refuses to start with no token in the environment', async () => {
    delete process.env.BELUGA_MCP_TOKEN;
    await expect(runMcp(['stdio'], () => undefined)).rejects.toThrow(/BELUGA_MCP_TOKEN/);
  });
});

describe('beluga mcp token, through the daemon', () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    clearDaemonInfo();
    rmSync(externalConfigPath(), { force: true });
    rmSync(grantFilePath(), { force: true });
  });

  it('waits for the card on the Mac, then prints the token once', async () => {
    daemon = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true });
    let printed = '';
    const running = runMcp(['token', '--name', 'Local model', '--level', 'trusted'], (t) => void (printed += t));
    const session = daemon.core.session;
    await waitFor(() => session.store.getState().approvals.length === 1);
    expect(session.store.getState().approvals[0]?.title).toContain('Local model');
    session.host.answerApproval('yes', session.store.getState().approvals[0]?.id);
    expect(await running).toBe(0);
    const token = /BELUGA_MCP_TOKEN=(\S+)/.exec(printed)![1]!;
    expect(needExternal(session).grants.lookup(token)?.name).toBe('Local model');
  });
});
