import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuditFile } from '../src/external/adapters/audit-file.js';
import { callTool } from '../src/external/adapters/mcp-tools.js';
import { ALL_METHOD_ROWS, methodTools } from '../src/external/adapters/tools/method-rows.js';
import { peopleTools } from '../src/external/adapters/tools/people.js';
import { decide, type Level } from '../src/external/domain/decide.js';
import type { Grant } from '../src/external/domain/grant.js';
import { TOOL_ACCESS } from '../src/external/domain/tools.js';
import type { ChatRead } from '../src/external/ports/chat-read.js';
import type { MethodCalls } from '../src/external/ports/methods.js';
import { extrasFields, parseExtras } from '../src/net/mesh/extras.js';

const PEER = 'a'.repeat(32);
const GROUP = 'b'.repeat(32);
const grant = (level: Level, chats = { dms: true, groups: true }): Grant => ({ id: 'g1', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: [], chats, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 });
const reads = { projects: () => [], chats: () => [] } as unknown as ChatRead;

describe('direct messages, groups and friends', () => {
  let dir: string;
  let audit: AuditFile;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-people-'));
    audit = new AuditFile({ file: path.join(dir, 'a.jsonl') });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (answer: 'yes' | 'no' = 'yes') => {
    const posted = vi.fn(() => ({ id: 'm1' }));
    const called = vi.fn(() => ({ ok: true }));
    const calls: MethodCalls = { call: called, postAs: posted, channelOfRequest: () => undefined, projectsOf: () => undefined, dashboardExists: () => false, changedPlan: () => false, personName: (id) => id };
    const tools = [...peopleTools(calls), ...methodTools(ALL_METHOD_ROWS.filter((r) => /^network\./.test(r.method)), reads, calls, () => undefined)];
    const cards: Array<{ once: boolean }> = [];
    const deps = { audit, ask: async (_t: string, _d: string, once: boolean) => { cards.push({ once }); return answer; }, now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    const use = async (name: string, args: Record<string, unknown>, g: Grant = grant('full')) => JSON.parse(((await callTool(tools.find((t) => t.name === name)!, args, g, deps)).content[0] as { text: string }).text) as Record<string, unknown>;
    return { posted, called, tools, cards, use };
  };

  it('a DM from an agent goes out with the label', async () => {
    const f = setup();
    expect(await f.use('dm_send', { peer: PEER, text: 'hello' })).toEqual({ sent: true, id: 'm1' });
    expect(f.posted).toHaveBeenCalledWith(`dm:${PEER}`, 'hello', { id: 'g1', name: 'GrokBot', creationSource: 'mcp' });
    await f.use('group_send', { group: GROUP, text: 'hi all' });
    expect(f.posted).toHaveBeenLastCalledWith(`group:${GROUP}`, 'hi all', { id: 'g1', name: 'GrokBot', creationSource: 'mcp' });
  });

  it('the label reaches the friend: through their parsing and into their view', () => {
    const via = { id: 'g1', name: 'GrokBot', creationSource: 'mcp' };
    const onTheirMac = parseExtras(JSON.parse(JSON.stringify({ via })));
    expect(extrasFields(onTheirMac).via).toEqual(via);
  });

  it('an old client still shows the message: it drops the field and keeps the rest', () => {
    const OldExtras = z.object({ ask: z.object({ to: z.union([z.literal('all'), z.array(z.string())]) }).optional() });
    const wire = { via: { id: 'g1', name: 'GrokBot', creationSource: 'mcp' }, ask: { to: 'all' } };
    expect(OldExtras.safeParse(wire).data).toEqual({ ask: { to: 'all' } });
    // A malformed label is dropped alone: never the message's other extras.
    expect(parseExtras({ via: { name: 'x'.repeat(500) }, ask: { to: 'all' } })).toEqual({ ask: { to: 'all' } });
  });

  it('with chats.dms off, read and send get project_denied; groups have their own switch', async () => {
    const f = setup();
    const noDms = grant('full', { dms: false, groups: true });
    expect((await f.use('dm_send', { peer: PEER, text: 'x' }, noDms)).error).toBe('project_denied');
    expect((await f.use('dm_history', { peer: PEER }, noDms)).error).toBe('project_denied');
    expect((await f.use('friend_list', {}, noDms)).error).toBe('project_denied');
    expect((await f.use('conversation_post', { conversation: `dm:${PEER}`, text: 'x' }, noDms)).error).toBe('project_denied');
    expect((await f.use('group_send', { group: GROUP, text: 'x' }, noDms)).error).toBeUndefined();
    const noGroups = grant('full', { dms: true, groups: false });
    expect((await f.use('group_send', { group: GROUP, text: 'x' }, noGroups)).error).toBe('project_denied');
    expect((await f.use('group_history', { group: GROUP }, noGroups)).error).toBe('project_denied');
    expect(f.called).not.toHaveBeenCalled();
  });

  it.each(['friend_remove', 'group_leave', 'group_delete'])('%s asks once at full', async (name) => {
    const f = setup('no');
    expect((await f.use(name, { peer: PEER, group: GROUP })).error).toBe('declined');
    expect(f.cards).toEqual([{ once: true }]);
    expect(f.called).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'ask', 'trusted', 'full'] as const)('at %s each tool that writes as you follows reach_people', async (level) => {
    const f = setup('no');
    const rule = decide({ operation: TOOL_ACCESS.dm_send, level, inScope: true });
    const out = await f.use('dm_send', { peer: PEER, text: 'x' }, grant(level));
    if (rule.outcome === 'deny') expect(out.error).toBe(rule.denial);
    if (rule.outcome === 'ask') expect(out.error).toBe('declined');
    if (rule.outcome === 'allow') expect(out.sent).toBe(true);
    expect(TOOL_ACCESS.dm_send).toBe('reach_people');
  });

  it('a secret file is not taken in, or written to, by a shared-file tool', async () => {
    const f = setup();
    expect((await f.use('net_file_add', { paths: ['/tmp/ok.txt', '/tmp/project/.env'] })).error).toBe('capability_denied');
    expect((await f.use('net_file_save_to', { sha: 'a'.repeat(64), target: '/tmp/project/.env' })).error).toBe('capability_denied');
    expect(f.called).not.toHaveBeenCalled();
  });

  it('the audit log holds no message text', async () => {
    const f = setup();
    await f.use('dm_send', { peer: PEER, text: 'plantedword' });
    expect(readFileSync(path.join(dir, 'a.jsonl'), 'utf8')).not.toContain('plantedword');
  });
});
