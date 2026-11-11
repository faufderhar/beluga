import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionReads, type SessionReadsDeps } from '../src/external/adapters/session-reads.js';
import { readTools } from '../src/external/adapters/tools/read.js';
import type { ChatScope } from '../src/external/domain/grant.js';
import type { ChatItem, ChatRead, ChatRef, NeedRef } from '../src/external/ports/chat-read.js';
import { ExternalService } from '../src/external/service.js';
import type { DomainState, LogItem } from '../src/core/store.js';

const SECRET = 'sk_' + 'live_abcdefghijklmnopqrstuvwx';

const chat = (over: Partial<ChatRef> & Pick<ChatRef, 'id'>): ChatRef => ({ kind: 'project', title: over.id, projectId: 'p1', projectName: 'api', status: 'idle', createdBy: 'you', creationSource: 'beluga', ...over });
const message = (n: number, text = `message ${n}`): ChatItem => ({ id: `m${n}`, role: n % 2 ? 'person' : 'agent', author: n % 2 ? 'kay' : 'Claude', text, ts: 1000 + n, ...(n % 2 ? {} : { status: 'done', stepLines: [`step of ${n}`] }) });

const CHATS: readonly ChatRef[] = [
  chat({ id: 'c1', lastAt: 30 }),
  chat({ id: 'c2', status: 'running', lastAt: 40 }),
  chat({ id: 'c3', projectId: 'p2', projectName: 'web', lastAt: 50 }),
  chat({ id: 'dm:bob', kind: 'dm', projectId: undefined, projectName: undefined, title: 'bob' } as ChatRef),
  chat({ id: 'room', kind: 'group', projectId: undefined, projectName: undefined, title: 'Group chat' } as ChatRef),
];
const HISTORY: Readonly<Record<string, readonly ChatItem[]>> = {
  c1: Array.from({ length: 5 }, (_, i) => message(i + 1)),
  c2: [message(1, `the key is ${SECRET} ok`), message(2, `OPENAI_API_KEY=abcdef123456\nDATABASE_URL=postgres://u:hunter2pass@db.example/app\nSOMETHING=plainvalue\nhello there`), message(3, 'x'.repeat(9000))],
  c3: [message(1, 'other project needle')],
  'dm:bob': [message(1, 'private dm needle')],
  room: [message(1, 'group needle')],
};
const NEEDS: readonly NeedRef[] = [
  { id: 'n1', kind: 'approval', title: 'in reach', chatId: 'c1' },
  { id: 'n2', kind: 'approval', title: 'out of reach', chatId: 'c3' },
  { id: 'n3', kind: 'approval', title: 'no chat' },
];
const reads: ChatRead = {
  projects: () => [{ id: 'p1', name: 'api' }, { id: 'p2', name: 'web' }],
  chats: () => CHATS,
  history: (id) => HISTORY[id] ?? [],
  steps: (id, item) => (id === 'c1' && item === 'm2' ? [{ title: 'Ran tests', tool: 'Bash', status: 'done', startedAt: 1 }] : undefined),
  needs: () => NEEDS,
  runtimes: async () => [{ id: 'claude', ready: true, asksEachStep: true, models: Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, label: `M${i}` })) }],
};

let dir: string;
let service: ExternalService;
let client: Client | undefined;
const cards: string[] = [];
let answer: 'yes' | 'no' = 'yes';

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'external-read-'));
  cards.length = 0;
  answer = 'yes';
  service = new ExternalService({ configFile: path.join(dir, 'external.json'), grantFile: path.join(dir, 'grants.json'), auditFile: path.join(dir, 'audit.jsonl'), port: 0, tools: readTools(reads), ask: async (title) => { cards.push(title); return answer; } });
  await service.setEnabled(true);
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
});

const connect = async (level: 'blocked' | 'ask' | 'trusted' = 'trusted', chats?: ChatScope): Promise<Client> => {
  const { token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], ...(chats ? { chats } : {}), expiresAt: Date.now() + 60_000 });
  client = new Client({ name: 'read-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> => {
  const res = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return JSON.parse(res.content[0]!.text);
};

describe('levels', () => {
  it('works at trusted with no card', async () => {
    const c = await connect('trusted');
    expect((await call(c, 'beluga_project_list')).projects).toEqual([{ id: 'p1', name: 'api' }]);
    expect(cards).toEqual([]);
  });

  it('gets a card at ask', async () => {
    const c = await connect('ask');
    expect((await call(c, 'beluga_chat_list')).chats).toHaveLength(2);
    expect(cards).toEqual(['GrokBot wants to use beluga_chat_list']);
    answer = 'no';
    expect((await call(c, 'beluga_chat_read', { chat: 'c1' })).error).toBe('declined');
  });

  it('is refused at blocked', async () => {
    const c = await connect('blocked');
    for (const tool of ['beluga_capabilities', 'beluga_project_list', 'beluga_chat_list', 'beluga_needs_list']) expect((await call(c, tool)).error, tool).toBe('level_denied');
    expect((await call(c, 'beluga_chat_read', { chat: 'c1' })).error).toBe('level_denied');
    expect((await call(c, 'beluga_chat_search', { query: 'x' })).error).toBe('level_denied');
    expect(cards).toEqual([]);
  });
});

describe('beluga_capabilities', () => {
  it('says what this agent has, and a short model list', async () => {
    const c = await connect('trusted');
    const caps = await call(c, 'beluga_capabilities');
    expect(caps).toMatchObject({ agent: 'GrokBot', level: 'trusted', route: 'local', projects: [{ id: 'p1', name: 'api' }], chats: { dms: false, groups: false } });
    expect(caps.tools).toContain('beluga_chat_read');
    expect(caps.tools).not.toContain('beluga_chat_send');
    expect(caps.runtimes[0].models).toHaveLength(8);
  });
});

describe('beluga_chat_list', () => {
  it('lists only the grant\'s chats, newest first, each with who made it', async () => {
    const c = await connect();
    const { chats, total } = await call(c, 'beluga_chat_list');
    expect(chats.map((x: Json) => x.id)).toEqual(['c2', 'c1']);
    expect(total).toBe(2);
    expect(chats[0]).toMatchObject({ createdBy: 'you', creationSource: 'beluga', status: 'running', snoozed: false, title: { untrusted: true, text: 'c2' } });
  });

  it('filters by status, pages by offset, and finds nothing snoozed', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_list', { status: 'idle' })).chats.map((x: Json) => x.id)).toEqual(['c1']);
    const first = await call(c, 'beluga_chat_list', { limit: 1 });
    expect(first.chats.map((x: Json) => x.id)).toEqual(['c2']);
    expect(first.nextOffset).toBe(1);
    const second = await call(c, 'beluga_chat_list', { limit: 1, offset: first.nextOffset });
    expect(second.chats.map((x: Json) => x.id)).toEqual(['c1']);
    expect(second.nextOffset).toBeNull();
    expect((await call(c, 'beluga_chat_list', { snoozed: true })).chats).toEqual([]);
  });

  it('refuses a project outside the grant, and says an unknown one is unknown', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_list', { project: 'p2' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_list', { project: 'web' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_list', { project: 'nope' })).error).toBe('not_found');
    expect((await call(c, 'beluga_chat_list', { project: 'api' })).chats).toHaveLength(2);
  });
});

describe('beluga_chat_read', () => {
  it('pages with afterPosition and nextPosition', async () => {
    const c = await connect();
    const first = await call(c, 'beluga_chat_read', { chat: 'c1', limit: 2 });
    expect(first.messages.map((m: Json) => m.position)).toEqual([1, 2]);
    expect(first.nextPosition).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = await call(c, 'beluga_chat_read', { chat: 'c1', limit: 2, afterPosition: first.nextPosition });
    expect(second.messages.map((m: Json) => m.position)).toEqual([3, 4]);
    const last = await call(c, 'beluga_chat_read', { chat: 'c1', limit: 2, afterPosition: second.nextPosition });
    expect(last.messages.map((m: Json) => m.position)).toEqual([5]);
    expect(last.hasMore).toBe(false);
    const none = await call(c, 'beluga_chat_read', { chat: 'c1', afterPosition: last.nextPosition });
    expect(none.messages).toEqual([]);
    expect(none.nextPosition).toBe(5);
  });

  it('marks message text as data and says so', async () => {
    const c = await connect();
    const read = await call(c, 'beluga_chat_read', { chat: 'c1', limit: 1 });
    expect(read.notice).toMatch(/data/i);
    expect(read.messages[0].text).toEqual({ untrusted: true, text: 'message 1', truncated: false });
    expect(read.chat).toMatchObject({ createdBy: 'you', creationSource: 'beluga' });
  });

  it('bounds long text with a truncated flag', async () => {
    const c = await connect();
    const read = await call(c, 'beluga_chat_read', { chat: 'c2' });
    expect(read.messages[2].text.truncated).toBe(true);
    expect(read.messages[2].text.text).toHaveLength(8000);
  });

  it('shows runs with their steps in the activity view, and pages them', async () => {
    const c = await connect();
    const read = await call(c, 'beluga_chat_read', { chat: 'c1', view: 'activity', limit: 1 });
    expect(read.activity).toHaveLength(1);
    expect(read.activity[0]).toMatchObject({ position: 2, status: 'done', steps: [{ title: { untrusted: true, text: 'Ran tests' }, tool: 'Bash', status: 'done' }] });
    const next = await call(c, 'beluga_chat_read', { chat: 'c1', view: 'activity', afterPosition: read.nextPosition });
    expect(next.activity[0]).toMatchObject({ position: 4, steps: [{ title: { text: 'step of 4' } }] });
  });

  it('answers project_denied outside the grant and not_found for an unknown chat', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_read', { chat: 'c3' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_read', { chat: 'nope' })).error).toBe('not_found');
  });
});

describe('DMs and group chats', () => {
  it('are refused unless the grant allows them', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_read', { chat: 'dm:bob' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_read', { chat: 'room' })).error).toBe('project_denied');
    expect((await call(c, 'beluga_chat_list')).chats.map((x: Json) => x.kind)).not.toContain('dm');
    expect((await call(c, 'beluga_chat_search', { query: 'needle' })).matches).toEqual([]);
  });

  it('are read when it does, one kind at a time', async () => {
    const dms = await connect('trusted', { dms: true, groups: false });
    expect((await call(dms, 'beluga_chat_read', { chat: 'dm:bob' })).messages).toHaveLength(1);
    expect((await call(dms, 'beluga_chat_read', { chat: 'room' })).error).toBe('project_denied');
    await dms.close();
    const groups = await connect('trusted', { dms: false, groups: true });
    expect((await call(groups, 'beluga_chat_read', { chat: 'room' })).messages).toHaveLength(1);
    expect((await call(groups, 'beluga_chat_read', { chat: 'dm:bob' })).error).toBe('project_denied');
  });
});

describe('secrets', () => {
  it('never come back in a read, with a .env-shaped message', async () => {
    const c = await connect();
    const text = JSON.stringify(await call(c, 'beluga_chat_read', { chat: 'c2' }));
    for (const secret of [SECRET, 'abcdef123456', 'hunter2pass', 'plainvalue']) expect(text).not.toContain(secret);
    expect(text).toContain('OPENAI_API_KEY=');
    expect(text).toContain('hello there');
  });

  it('never come back from a search, and searching for one finds nothing', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_search', { query: SECRET })).matches).toEqual([]);
    expect((await call(c, 'beluga_chat_search', { query: 'hunter2pass' })).matches).toEqual([]);
    const hit = await call(c, 'beluga_chat_search', { query: 'the key is' });
    expect(hit.matches).toHaveLength(1);
    expect(JSON.stringify(hit)).not.toContain(SECRET);
  });

  it('stay out of the audit file too', async () => {
    const c = await connect();
    await call(c, 'beluga_chat_search', { query: SECRET });
    expect(JSON.stringify(service.audit.recent(10))).not.toContain(SECRET);
  });
});

describe('beluga_chat_search and beluga_needs_list', () => {
  it('searches only the grant\'s chats', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_search', { query: 'needle' })).matches).toEqual([]);
    const found = await call(c, 'beluga_chat_search', { query: 'MESSAGE 3' });
    expect(found.matches.map((m: Json) => m.chat)).toEqual(['c1']);
    expect(found.matches[0].text.untrusted).toBe(true);
  });

  it('refuses a search in a project outside the grant', async () => {
    const c = await connect();
    expect((await call(c, 'beluga_chat_search', { query: 'needle', project: 'p2' })).error).toBe('project_denied');
  });

  it('lists only what waits in the chats it reaches', async () => {
    const c = await connect();
    const { needs } = await call(c, 'beluga_needs_list');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ id: 'n1', chat: 'c1', title: { text: 'in reach' } });
  });
});

describe('the read port over a daemon', () => {
  const workspace = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, name: id, kind: 'worktree', projectId: 'p1', ...over });
  const log = (id: string, text: string, channel = 'ws:w1'): LogItem => ({ id, type: 'chat', channel, from: 'x', name: 'kay', text, ts: 5, byAgent: false });
  const stateWith = (over: Record<string, unknown>): DomainState =>
    ({ room: 'My room', log: [], projects: [{ id: 'p1', name: 'api', root: '/x', workspaces: [workspace('main1', { kind: 'main' }), workspace('w1'), workspace('w2', { archived: true }), workspace('w3', { pending: true }), workspace('w4', { handedFrom: 'mia' }), workspace('w5', { importedSession: 's' })] }], network: { friends: [{ peerId: 'bob', name: 'bob' }], groups: [{ id: 'g1', name: 'team' }], messages: { 'dm:bob': [{ id: 'd1', name: 'bob', text: 'hi', ts: 9, mine: false }], 'group:g1': [{ id: 'g1m', name: 'mia', text: 'yo', ts: 10, mine: false }], 'dm:gone': [] } }, approvals: [], questions: [], gateway: { tasks: [] }, plans: { plans: [] }, ...over }) as unknown as DomainState;
  const deps = (state: DomainState, saved: readonly LogItem[] = []): SessionReadsDeps => ({ state: () => state, loadHistory: () => saved, stepsFor: () => ({ steps: [], version: 0, missing: true }), runtimes: async () => [] });

  it('lists a project\'s conversations with who made them, and leaves out main checkouts and ones being made', () => {
    const chats = sessionReads(deps(stateWith({}))).chats();
    const projectChats = chats.filter((c) => c.kind === 'project');
    expect(projectChats.map((c) => c.id)).toEqual(['w1', 'w2', 'w4', 'w5']);
    expect(chats.find((c) => c.id === 'w2')?.status).toBe('archived');
    expect(chats.find((c) => c.id === 'w4')).toMatchObject({ createdBy: 'mia', creationSource: 'friend' });
    expect(chats.find((c) => c.id === 'w5')?.creationSource).toBe('external');
    expect(chats.find((c) => c.id === 'room')?.kind).toBe('group');
    expect(chats.find((c) => c.id === 'dm:bob')).toMatchObject({ kind: 'dm', title: 'bob' });
    expect(chats.find((c) => c.id === 'group:g1')).toMatchObject({ kind: 'group', title: 'team' });
    expect(chats.find((c) => c.id === 'dm:gone')).toBeUndefined();
  });

  it('merges what is saved with what is live, without loading it into the state', () => {
    const state = stateWith({ log: [log('b', 'live edit'), log('c', 'new')] });
    const reads2 = sessionReads(deps(state, [log('a', 'old'), log('b', 'old b')]));
    expect(reads2.history('w1').map((i) => [i.id, i.text])).toEqual([['a', 'old'], ['b', 'live edit'], ['c', 'new']]);
  });

  it('marks a chat with a run going, and reads network messages and steps', () => {
    const run = { id: 'r', type: 'agent', channel: 'ws:w1', status: 'started', text: 'working', steps: ['one'], ts: 1, ownerName: 'kay', subagents: [], requestId: 'q', owner: 'o', requesterName: 'kay' };
    const reads2 = sessionReads(deps(stateWith({ log: [run] })));
    expect(reads2.chats().find((c) => c.id === 'w1')?.status).toBe('running');
    expect(reads2.history('w1')[0]).toMatchObject({ role: 'agent', status: 'started', stepLines: ['one'] });
    expect(reads2.steps('w1', 'r')).toBeUndefined();
    expect(reads2.history('dm:bob')).toEqual([{ id: 'd1', role: 'person', author: 'bob', text: 'hi', ts: 9 }]);
  });

  it('leaves a shell\'s output out of a chat', () => {
    const shell = { id: 's', type: 'shell', channel: 'ws:w1', ts: 1 } as unknown as LogItem;
    expect(sessionReads(deps(stateWith({ log: [shell] }))).history('w1')).toEqual([]);
  });
});

