import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditFile } from '../src/external/adapters/audit-file.js';
import { callTool, type ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { fileTools } from '../src/external/adapters/tools/files.js';
import { decide, type Level, type Route } from '../src/external/domain/decide.js';
import { TOOL_ACCESS } from '../src/external/domain/tools.js';
import type { Grant } from '../src/external/domain/grant.js';
import type { ChatRead, ChatRef } from '../src/external/ports/chat-read.js';

const chat = (id: string, projectId: string): ChatRef => ({ id, kind: 'project', title: id, projectId, projectName: projectId, status: 'idle', createdBy: 'you', creationSource: 'beluga' });
const grant = (level: Level, over: Partial<Grant> & { route?: Route } = {}): Grant => ({ id: 'g', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: ['p1'], chats: { dms: false, groups: false }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0, ...over });

describe('the file and terminal tools', () => {
  let dir: string;
  let root: string;
  let other: string;
  let tools: ExternalToolDef[];
  let answer: 'yes' | 'no';
  let cards: Array<{ title: string; once: boolean }>;
  let auditFile: string;
  let audit: AuditFile;
  const typed: string[] = [];
  const called = vi.fn((method: string, args: readonly unknown[]): unknown => (method === 'terminals.shell' ? `shell:${String(args[0])}` : undefined));

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'external-files-')));
    root = path.join(dir, 'api');
    other = path.join(dir, 'web');
    mkdirSync(root);
    mkdirSync(other);
    writeFileSync(path.join(root, 'a.txt'), 'hello needle\n');
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    writeFileSync(path.join(root, '.env'), 'NEEDLE=1\n');
    writeFileSync(path.join(other, 'b.txt'), 'outside needle\n');
    symlinkSync(path.join(other, 'b.txt'), path.join(root, 'link.txt'));
    answer = 'yes';
    cards = [];
    typed.length = 0;
    called.mockClear();
    auditFile = path.join(dir, 'a.jsonl');
    audit = new AuditFile({ file: auditFile });
    const reads = { projects: () => [{ id: 'p1', name: 'api' }, { id: 'p2', name: 'web' }], chats: () => [chat('c1', 'p1'), chat('c2', 'p2')] } as unknown as ChatRead;
    const folders: Record<string, string> = { p1: root, c1: root, p2: other, c2: other };
    tools = fileTools(reads, { folder: (where) => (folders[where] ? { root: folders[where]!, more: [] } : undefined), terminal: () => ({ write: (d: string) => void typed.push(d), backlog: () => 'output' }) }, { call: called, channelOfRequest: () => undefined, projectsOf: () => undefined, dashboardExists: () => false, changedPlan: () => false, postAs: () => undefined, personName: (id: string) => id });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const use = async (name: string, args: Record<string, unknown>, g: Grant = grant('full')) => {
    const deps = { audit, ask: async (title: string, _d: string, once: boolean) => { cards.push({ title, once }); return answer; }, now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    const res = await callTool(tools.find((t) => t.name === name)!, args, g, deps);
    return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown> & { error?: string; result?: { text: string } };
  };

  it.each(['blocked', 'ask', 'trusted', 'full'] as const)('at level %s each tool follows the decision table', async (level) => {
    await use('terminal_open', { chat: 'c1' });
    answer = 'no';
    for (const def of tools) {
      const before = cards.length;
      const rule = decide({ operation: TOOL_ACCESS[def.name], level, inScope: true });
      const out = await use(def.name, { where: 'c1', chat: 'c1', path: 'a.txt', query: 'needle', content: 'x', terminal: 'shell:c1', text: 'x', name: 'n' }, grant(level));
      if (rule.outcome === 'deny') expect(out.error, def.name).toBe(rule.denial);
      else if (rule.outcome === 'allow') expect(out.error, def.name).not.toBe('declined');
      else {
        expect(out.error, def.name).toBe('declined');
        expect(cards.length, def.name).toBe(before + 1);
      }
      if (def.name === 'terminal_close' && !out.error) await use('terminal_open', { chat: 'c1' }, grant('full'));
    }
  });

  it('reads and lists inside a folder the grant reaches', async () => {
    expect((await use('file_read', { where: 'c1', path: 'a.txt' })).result?.text).toContain('hello needle');
    expect((await use('file_read', { where: 'api', path: 'a.txt' })).result?.text).toContain('hello needle');
    expect((await use('file_list', { where: 'c1' })).result?.text).toContain('a.txt');
  });

  it('refuses a link inside a project to a file outside it, and does not list it', async () => {
    expect((await use('file_read', { where: 'c1', path: 'link.txt' })).error).toBe('project_denied');
    expect((await use('file_save', { where: 'c1', path: 'link.txt', content: 'x' })).error).toBe('project_denied');
    expect((await use('file_list', { where: 'c1' })).result?.text).not.toContain('link.txt');
    expect((await use('file_read', { where: 'c1', path: '../web/b.txt' })).error).toBe('project_denied');
    expect((await use('file_read', { where: 'c1', path: path.join(other, 'b.txt') })).error).toBe('project_denied');
    expect(readFileSync(path.join(other, 'b.txt'), 'utf8')).toBe('outside needle\n');
  });

  it('refuses a secret path in read, search and save, at full too', async () => {
    expect((await use('file_read', { where: 'c1', path: '.env' })).error).toBe('capability_denied');
    expect((await use('file_save', { where: 'c1', path: '.env', content: 'x' })).error).toBe('capability_denied');
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('NEEDLE=1\n');
    const found = (await use('file_search', { where: 'c1', query: 'needle' })).result?.text ?? '';
    expect(found).toContain('a.txt');
    expect(found).not.toContain('.env');
    // What a secret file matched must not show in the count: a regex would read its value letter by letter.
    expect(JSON.parse((await use('file_search', { where: 'c1', query: '^NEEDLE=1', regex: true })).result?.text ?? '{}')).toMatchObject({ count: 0, files: [] });
    // On a Mac's disk .GIT is .git.
    expect((await use('file_read', { where: 'c1', path: '.GIT/config' })).error).toBeDefined();
    expect((await use('file_save', { where: 'c1', path: '.Git/config', content: 'x' })).error).toBeDefined();
    expect((await use('file_find', { where: 'c1', query: '.env' })).result?.text).not.toContain('.env');
    expect((await use('file_list', { where: 'c1' })).result?.text).not.toContain('.env');
  });

  it.each(['ask', 'trusted'] as const)('at %s a save to package.json asks once, and a no leaves it', async (level) => {
    answer = 'no';
    expect((await use('file_save', { where: 'c1', path: 'package.json', content: 'changed' }, grant(level))).error).toBe('declined');
    expect(cards.at(-1)).toMatchObject({ once: true, title: expect.stringContaining('package.json') });
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('{}\n');
  });

  it('at full a save to package.json runs, as writes_code says', async () => {
    expect(await use('file_save', { where: 'c1', path: 'package.json', content: 'changed' })).toMatchObject({ ok: true });
    expect(cards).toEqual([]);
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('changed');
  });

  it('a remote grant reaches only its projects\' files', async () => {
    const remote = grant('trusted', { route: 'remote' });
    expect((await use('file_read', { where: 'c1', path: 'a.txt' }, remote)).result?.text).toContain('hello');
    for (const where of ['c2', 'p2', 'web']) expect((await use('file_read', { where, path: 'b.txt' }, remote)).error).toBe('project_denied');
    expect((await use('file_search', { where: 'c2', query: 'needle' }, remote)).error).toBe('project_denied');
    expect((await use('file_list', { where: 'nope' }, remote)).error).toBe('not_found');
  });

  it('a terminal opens with one card below full, with none at full', async () => {
    answer = 'no';
    expect((await use('terminal_open', { chat: 'c1' }, grant('trusted'))).error).toBe('declined');
    expect(cards).toEqual([{ title: 'GrokBot wants to open a shell, and it can type anything there', once: true }]);
    expect(called).not.toHaveBeenCalled();
    answer = 'yes';
    cards = [];
    expect(await use('terminal_open', { chat: 'c1' })).toEqual({ terminal: 'shell:c1' });
    expect(cards).toEqual([]);
  });

  it('terminal input reaches the audit log as a length only', async () => {
    await use('terminal_open', { chat: 'c1' });
    expect(await use('terminal_input', { terminal: 'shell:c1', text: 'plantedword\n' })).toEqual({ typed: 12 });
    expect(typed).toEqual(['plantedword\n']);
    const log = readFileSync(auditFile, 'utf8');
    expect(log).toContain('typed 12 characters');
    expect(log).not.toContain('plantedword');
    const same = JSON.parse(log.trim().split('\n').at(-1)!) as { argsHash: string };
    await use('terminal_input', { terminal: 'shell:c1', text: 'otherwordss\n' });
    expect((JSON.parse(readFileSync(auditFile, 'utf8').trim().split('\n').at(-1)!) as { argsHash: string }).argsHash).toBe(same.argsHash);
  });

  it('an agent reaches only the terminals it opened', async () => {
    expect((await use('terminal_input', { terminal: 'shell:c1', text: 'x' })).error).toBe('not_found');
    await use('terminal_open', { chat: 'c1' });
    expect((await use('terminal_read', { terminal: 'shell:c1' }, grant('full', { id: 'other' }))).error).toBe('not_found');
    expect((await use('terminal_read', { terminal: 'shell:c1' })).result?.text).toBe('output');
    expect(await use('terminal_close', { terminal: 'shell:c1' })).toEqual({ closed: true });
    expect((await use('terminal_read', { terminal: 'shell:c1' })).error).toBe('not_found');
  });
});
