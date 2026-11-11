import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store, initialState } from '../src/core/store.js';
import { callTool, type ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { withDiscovery } from '../src/external/adapters/tools/discover.js';
import { decide, type Level, OPERATION_CLASSES } from '../src/external/domain/decide.js';
import type { Grant } from '../src/external/domain/grant.js';
import { CHAT_TOOLS, type ExternalTool, TOOL_ACCESS } from '../src/external/domain/tools.js';
import { launchExternal } from '../src/external/launch.js';
import { needExternal } from '../src/external/registry.js';
import { ExternalService } from '../src/external/service.js';
import type { Session } from '../src/core/session.js';

const LEVELS: readonly Level[] = ['blocked', 'ask', 'trusted', 'full'];
/** One tool of each class that has tools. */
const ONE_OF_EACH: readonly ExternalTool[] = (OPERATION_CLASSES as readonly string[]).flatMap((operation) => {
  const name = (Object.keys(TOOL_ACCESS) as ExternalTool[]).find((t) => TOOL_ACCESS[t] === operation && t !== 'beluga_find' && t !== 'beluga_call');
  return name ? [name] : [];
});

const grant = (level: Level): Grant => ({ id: 'g1', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: ['p1'], chats: { dms: false, groups: false }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 });

/** Words a person or an agent would use, and the tools that do it. */
const REAL_QUERIES: ReadonlyArray<readonly string[]> = [
  ['commit this worktree', 'worktree_commit'],
  ['open a pull request', 'pr_create', 'pr_quick', 'plan_open_pr'],
  ['send a DM', 'dm_send'],
  ['merge the pull request', 'pr_merge'],
  ['read a file', 'file_read'],
  ['open a terminal', 'terminal_open'],
  ['list github issues', 'issue_list'],
  ['run the failed CI jobs again', 'ci_rerun'],
  ['create a task on the board', 'task_create'],
  ['approve a plan', 'plans_approve'],
  ['tap on the phone screen', 'phone_tap'],
  ['set a friend to full trust', 'people_set_trust'],
];

describe('what a client lists', () => {
  it('over a real MCP client on the real tools: 14, the chat tools and find and call', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'external-list-'));
    const before = { ...process.env };
    process.env.BELUGA_HOME = home;
    process.env.BELUGA_EXTERNAL_PORT = '0';
    const session = { store: new Store(initialState('room', 'ask')), host: { setExternalAgents: () => undefined, ask: async () => 'no' }, toast: () => undefined } as unknown as Session;
    const stop = launchExternal({ session });
    const service = needExternal(session);
    await service.setEnabled(true);
    const { token } = service.grants.create({ name: 'm', clientId: 'c', redirectHost: 'h', route: 'local', level: 'full', projects: 'all', expiresAt: Date.now() + 60_000 });
    const client = new Client({ name: 'list-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...CHAT_TOOLS, 'beluga_find', 'beluga_call'].sort());
      expect(tools).toHaveLength(14);
      expect(client.getInstructions()).toContain('beluga_find');
      // Through find and call, a tool that is not listed is there.
      const found = JSON.parse(((await client.callTool({ name: 'beluga_find', arguments: { query: 'git log' } })) as { content: Array<{ text: string }> }).content[0]!.text) as { tools: Array<{ name: string; inputSchema: { properties: object } }> };
      expect(found.tools.map((t) => t.name)).toContain('git_log');
      // Each real tool can be described to a client.
      const big = JSON.parse(((await client.callTool({ name: 'beluga_find', arguments: { query: 'person asked each time', limit: 20 } })) as { content: Array<{ text: string }> }).content[0]!.text) as { tools: unknown[] };
      expect(big.tools).toHaveLength(20);
      // The right tool in the top 5 for real words, with nothing leaving this Mac.
      const network = vi.spyOn(globalThis, 'fetch');
      const missed: string[] = [];
      const lines: string[] = [];
      for (const [query, ...want] of REAL_QUERIES) {
        const started = performance.now();
        const out = JSON.parse(((await client.callTool({ name: 'beluga_find', arguments: { query, limit: 5 } })) as { content: Array<{ text: string }> }).content[0]!.text) as { tools: Array<{ name: string }> };
        const names = out.tools.map((t) => t.name);
        lines.push(`${query}: ${names.join(', ')} (${(performance.now() - started).toFixed(1)} ms over MCP)`);
        if (!want.some((w) => names.includes(w))) missed.push(`${query} -> ${names.join(', ')}`);
      }
      if (process.env.FIND_OUT) writeFileSync(process.env.FIND_OUT, `${lines.join('\n')}\n`);
      // Only the client's own requests to this server.
      expect(network.mock.calls.filter(([to]) => !String(to).startsWith(service.status().url!))).toEqual([]);
      network.mockRestore();
      expect(missed).toEqual([]);
    } finally {
      await client.close();
      await stop();
      process.env = before;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('beluga_find and beluga_call', () => {
  let dir: string;
  let auditFile: string;
  let service: ExternalService | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-discover-'));
    auditFile = path.join(dir, 'a.jsonl');
  });
  afterEach(async () => {
    await service?.stop();
    service = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A tool under a real name, with a schema, that says when it ran. */
  const stub = (name: ExternalTool, ran: () => void): ExternalToolDef => ({
    name,
    description: `The ${name} stub, for testing words.`,
    inputSchema: { thing: z.string().min(2), count: z.number().optional() },
    resolve: () => ({ target: 'project:p1', inScope: true }),
    run: () => {
      ran();
      return { ran: name };
    },
  });
  const setup = (names: readonly ExternalTool[], answer: 'yes' | 'no' | Promise<'yes' | 'no'> = 'no', opts: { cardWaitMs?: number; live?: () => boolean } = {}) => {
    const ran = vi.fn();
    const tools = withDiscovery([], names.map((n) => stub(n, () => ran(n))));
    const cards: Array<{ title: string; once: boolean }> = [];
    const audit: Array<{ tool: string; class: string; result: string; decidedBy: string }> = [];
    const deps = { audit: { append: (e: never) => void audit.push(e) } as never, ask: async (title: string, _d: string, once: boolean) => { cards.push({ title, once }); return answer; }, now: Date.now, always: new Set<string>(), live: opts.live ?? (() => true), cards: new Map(), ...(opts.cardWaitMs !== undefined ? { cardWaitMs: opts.cardWaitMs } : {}) };
    const use = async (name: 'beluga_find' | 'beluga_call', args: Record<string, unknown>, g: Grant = grant('full')) => JSON.parse(((await callTool(tools.find((t) => t.name === name)!, args, g, deps)).content[0] as { text: string }).text) as { error?: string; message?: string; ran?: string; tools?: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> };
    return { use, ran, cards, audit };
  };

  it('find returns a tool with its schema, best match first, and no more than the limit', async () => {
    const f = setup(['git_log', 'git_fetch', 'task_get']);
    const out = await f.use('beluga_find', { query: 'git log' });
    expect(out.tools!.map((t) => t.name)).toEqual(['git_log', 'git_fetch']);
    expect(out.tools![0]).toMatchObject({ name: 'git_log', description: expect.stringContaining('git_log'), inputSchema: { properties: { thing: { type: 'string' }, count: { type: 'number' } }, required: ['thing'] } });
    expect((await f.use('beluga_find', { query: 'git', limit: 1 })).tools).toHaveLength(1);
    expect((await f.use('beluga_find', { query: 'nothing here' })).tools).toEqual([]);
  });

  it('find hides what the level denies: a blocked agent gets nothing', async () => {
    const f = setup(['git_log']);
    expect((await f.use('beluga_find', { query: 'git' }, grant('blocked'))).error).toBe('level_denied');
    expect(JSON.stringify(f.audit)).not.toContain('git_log');
  });

  it('find leaves out a tool of a class the level denies', async () => {
    const spy = vi.spyOn(TOOL_ACCESS as unknown as Record<string, string>, 'git_log', 'get').mockReturnValue('secret_file');
    const f = setup(['git_log', 'git_fetch']);
    const out = await f.use('beluga_find', { query: 'git' }, grant('trusted'));
    spy.mockRestore();
    expect(out.tools!.map((t) => t.name)).toEqual(['git_fetch']);
  });

  it('call with bad arguments gets invalid_request, names the tool in the log, and the tool does not run', async () => {
    const f = setup(['task_update']);
    const out = await f.use('beluga_call', { tool: 'task_update', arguments: { thing: 'x' } });
    expect(out.error).toBe('invalid_request');
    expect(out.message).toContain('thing');
    expect((await f.use('beluga_call', { tool: 'task_update' })).error).toBe('invalid_request');
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.cards).toEqual([]);
    expect(f.audit.at(-1)).toMatchObject({ tool: 'task_update', result: 'invalid_request' });
  });

  it('call passes only what the schema knows', async () => {
    const seen = vi.fn();
    const tools = withDiscovery([], [{ ...stub('git_log', () => undefined), run: (args) => seen(args) as never }]);
    const deps = { audit: { append: () => undefined } as never, ask: async () => 'yes' as const, now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    await callTool(tools.find((t) => t.name === 'beluga_call')!, { tool: 'git_log', arguments: { thing: 'ok', extra: 'dropped' } }, grant('full'), deps);
    expect(seen).toHaveBeenCalledWith({ thing: 'ok' });
  });

  describe.each(LEVELS)('at level %s', (level) => {
    it.each(ONE_OF_EACH)('call follows decide() for %s: the card and the audit record name it', async (name) => {
      const rule = decide({ operation: TOOL_ACCESS[name], level, inScope: true });
      const f = setup([name]);
      const out = await f.use('beluga_call', { tool: name, arguments: { thing: 'ok' } }, grant(level));
      const raw = JSON.stringify(f.audit);
      expect(f.audit.at(-1)).toMatchObject({ tool: name, class: TOOL_ACCESS[name] });
      expect(raw).not.toContain('beluga_call');
      if (rule.outcome === 'deny') {
        expect(out.error).toBe(rule.denial);
        expect(f.cards).toEqual([]);
        expect(f.ran).not.toHaveBeenCalled();
      } else if (rule.outcome === 'allow') {
        expect(out.ran).toBe(name);
        expect(f.cards).toEqual([]);
      } else {
        expect(out.error).toBe('declined');
        expect(f.ran).not.toHaveBeenCalled();
        expect(f.cards).toEqual([{ title: `GrokBot wants to use ${name}`, once: rule.outcome === 'ask-once' }]);
      }
    });
  });

  it('covers each class that has a tool', () => {
    expect(new Set(ONE_OF_EACH.map((t) => TOOL_ACCESS[t]))).toEqual(new Set(Object.values(TOOL_ACCESS)));
    expect(ONE_OF_EACH.length).toBeGreaterThan(6);
  });

  it('a late yes does not run on a grant that ended; a live one does', async () => {
    let live = true;
    let say: (a: 'yes') => void = () => undefined;
    const f = setup(['sentinel_remove'], new Promise((resolve) => (say = resolve)), { live: () => live });
    const call = f.use('beluga_call', { tool: 'sentinel_remove', arguments: { thing: 'ok' } });
    await vi.waitFor(() => expect(f.cards).toHaveLength(1));
    live = false;
    say('yes');
    expect((await call).error).toBe('grant_gone');
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.audit.at(-1)).toMatchObject({ tool: 'sentinel_remove', result: 'grant_gone', decidedBy: 'person' });
  });

  it('a card that takes long gets waiting_for_owner, and a retry finds it under the inner tool', async () => {
    let say: (a: 'yes') => void = () => undefined;
    const f = setup(['sentinel_remove'], new Promise((resolve) => (say = resolve)), { cardWaitMs: 5 });
    const args = { tool: 'sentinel_remove', arguments: { thing: 'ok' } };
    expect((await f.use('beluga_call', args)).error).toBe('waiting_for_owner');
    expect(f.audit.at(-1)).toMatchObject({ tool: 'sentinel_remove', result: 'waiting_for_owner' });
    expect(f.ran).not.toHaveBeenCalled();
    expect((await f.use('beluga_call', args)).error).toBe('waiting_for_owner');
    expect(f.cards).toHaveLength(1);
    say('yes');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await f.use('beluga_call', args)).ran).toBe('sentinel_remove');
    expect(f.ran).toHaveBeenCalledTimes(1);
  });

  it.each(['beluga_call', 'beluga_find', 'nope', 'host_answer_approval', 'external_revoke', 'external_set_paused', 'env_get', 'stripe_connect', 'answer_approval'])('call cannot reach %s', async (tool) => {
    const f = setup(['git_log']);
    const out = await f.use('beluga_call', { tool, arguments: { tool: 'git_log', arguments: { thing: 'ok' } } });
    expect(out.error).toBe('not_found');
    expect(f.ran).not.toHaveBeenCalled();
    expect(f.audit.at(-1)).toMatchObject({ tool: 'beluga_call', result: 'not_found' });
    expect(JSON.stringify(f.audit)).not.toContain(tool === 'beluga_call' ? '___' : tool);
  });

  it('a blocked agent learns nothing from a name', async () => {
    const f = setup(['git_log']);
    expect((await f.use('beluga_call', { tool: 'nope' }, grant('blocked'))).error).toBe('level_denied');
    expect((await f.use('beluga_call', { tool: 'git_log', arguments: {} }, grant('blocked'))).error).toBe('level_denied');
    expect(f.ran).not.toHaveBeenCalled();
  });

  it('the raw audit file names the inner tool, through a real client', async () => {
    const ran = vi.fn();
    service = new ExternalService({ configFile: path.join(dir, 'c.json'), grantFile: path.join(dir, 'g.json'), auditFile, port: 0, tools: withDiscovery([], [stub('task_update', () => ran())]), ask: async () => 'yes' });
    await service.setEnabled(true);
    const { token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level: 'trusted', projects: [], expiresAt: Date.now() + 60_000 });
    const client = new Client({ name: 'audit-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    await client.callTool({ name: 'beluga_call', arguments: { tool: 'task_update', arguments: { thing: 'plantedword' } } });
    await client.close();
    expect(ran).toHaveBeenCalledTimes(1);
    const raw = readFileSync(auditFile, 'utf8');
    expect(JSON.parse(raw.trim().split('\n').at(-1)!)).toMatchObject({ tool: 'task_update', class: 'state_write', decidedBy: 'person', result: 'ok' });
    expect(raw).not.toContain('beluga_call');
    expect(raw).not.toContain('plantedword');
  });
});
