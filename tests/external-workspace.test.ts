import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacTools, PhoneTools } from '../src/agent/types.js';
import { Board } from '../src/core/board/board.js';
import { actorName } from '../src/core/board/model.js';
import { BoardWork } from '../src/core/board/work.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { workspaceTools } from '../src/external/adapters/tools/workspace.js';
import type { Level } from '../src/external/domain/decide.js';
import { WORKSPACE_TOOLS } from '../src/external/domain/tools.js';
import type { ChatControl } from '../src/external/ports/chat-control.js';
import type { ChatRead, ChatRef } from '../src/external/ports/chat-read.js';
import type { WorkspacePort, WorktreeRef } from '../src/external/ports/workspace.js';
import { ExternalService } from '../src/external/service.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const chat = (id: string, projectId: string, status: ChatRef['status'] = 'idle'): ChatRef => ({ id, kind: 'project', title: id, projectId, projectName: projectId, status, createdBy: 'you', creationSource: 'beluga' });

describe('worktree, merge and phone look tools', () => {
  let dir: string;
  let service: ExternalService;
  let client: Client | undefined;
  let cards: Array<{ title: string; detail: string; once: boolean }>;
  let answer: 'yes' | 'no' | 'always';
  let worktrees: Record<string, WorktreeRef>;
  let phoneOff: boolean;
  let phoneUse: 'off' | 'ask' | 'use' | 'full';
  const tapped = vi.fn(async () => 'Tapped');
  const reads = {
    projects: () => [{ id: 'p1', name: 'api' }, { id: 'p2', name: 'other' }],
    chats: () => [chat('w1', 'p1', 'running'), chat('w2', 'p1'), chat('t1', 'p2')],
    runtimes: async () => [],
  } as unknown as ChatRead;
  const port = {
    worktree: (ref: string) => worktrees[ref],
    task: (key: string) => ({ 'BOB-1': { key: 'BOB-1', projectId: 'p1' }, 'THEIR-1': { key: 'THEIR-1', projectId: 'p2' } })[key],
    startTask: vi.fn(async () => ({ chatId: 'w9', message: 'Work on BOB-1.' })),
    startPlan: vi.fn(async () => ({ id: 'pl1' })),
    archive: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    merge: vi.fn(async () => ({ merged: true as const })),
    mac: () => ({ screenshot: async () => ({ text: 'A shot', image: { data: 'aGk=', mimeType: 'image/png' } }), deviceInfo: async () => 'A Mac' }) as unknown as MacTools,
    phone: () => ({ tap: tapped, status: async () => 'A phone', screenshot: async () => ({ text: 'Phone shot' }), screen: async () => '#1 OK', apps: async () => 'apps', info: async () => 'info', notifications: async () => 'Bank: API_TOKEN=abc123' }) as unknown as PhoneTools,
    phoneOff: () => phoneOff || phoneUse === 'off',
    phoneUse: () => phoneUse,
  } as unknown as WorkspacePort;
  const control = {
    launch: vi.fn(async () => ({ chatId: 'w8', runId: 'r1', delivery: 'started' })),
    send: vi.fn(async () => ({ runId: 'r2', delivery: 'started' })),
  } as unknown as ChatControl;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-workspace-'));
    vi.clearAllMocks();
    cards = [];
    answer = 'yes';
    phoneOff = false;
    phoneUse = 'use';
    worktrees = {
      w1: { id: 'w1', projectId: 'p1', name: 'one', archived: false },
      w2: { id: 'w2', projectId: 'p1', name: 'two', archived: true },
      t1: { id: 't1', projectId: 'p2', name: 'theirs', archived: false },
    };
    service = new ExternalService({
      configFile: path.join(dir, 'c.json'),
      grantFile: path.join(dir, 'g.json'),
      auditFile: path.join(dir, 'a.jsonl'),
      port: 0,
      tools: workspaceTools(reads, port, control),
      ask: async (title, detail, once) => {
        cards.push({ title, detail, once });
        return answer;
      },
    });
    await service.setEnabled(true);
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = async (level: Level = 'full'): Promise<Client> => {
    const { token } = service.grants.create({ name: 'GrokBot', clientId: 'c', redirectHost: '127.0.0.1', route: 'local', level, projects: ['p1'], expiresAt: Date.now() + 60_000 });
    await client?.close();
    client = new Client({ name: 'workspace-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.status().url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text);
  };

  it('serves each workspace tool, also each phone tool that acts', async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...WORKSPACE_TOOLS].sort());
    expect(names.filter((n) => /phone_(tap|swipe|type|key|scroll|open|install|shell|push|macro|pull|logcat|setup)/.test(n))).toHaveLength(16);
  });

  it('a secret file does not go to the phone, at full too', async () => {
    const c = await connect('full');
    expect(await call(c, 'phone_push', { path: '/tmp/project/.env' })).toMatchObject({ error: 'capability_denied' });
  });

  it('acting on the phone follows its own setting: off refuses, ask shows a card, use and full run', async () => {
    const c = await connect('full');
    phoneUse = 'off';
    expect(await call(c, 'phone_tap', { x: 1, y: 2 })).toMatchObject({ error: 'needs_person' });
    expect(tapped).not.toHaveBeenCalled();
    phoneUse = 'ask';
    answer = 'no';
    expect(await call(c, 'phone_tap', { x: 1, y: 2 })).toMatchObject({ error: 'declined' });
    expect(cards.at(-1)).toMatchObject({ once: true });
    expect(tapped).not.toHaveBeenCalled();
    answer = 'yes';
    await call(c, 'phone_tap', { x: 1, y: 2 });
    expect(tapped).toHaveBeenCalledTimes(1);
    const before = cards.length;
    for (const use of ['use', 'full'] as const) {
      phoneUse = use;
      await call(c, 'phone_tap', { x: 1, y: 2 });
    }
    expect(tapped).toHaveBeenCalledTimes(3);
    expect(cards).toHaveLength(before);
  });

  it.each(['ask', 'trusted', 'full'] as const)('at %s, merge asks once, with no Always', async (level) => {
    const c = await connect(level);
    answer = 'no';
    expect(await call(c, 'merge_worktree', { worktree: 'w1' })).toMatchObject({ error: 'declined' });
    expect(port.merge).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.once).toBe(true);
    expect(cards[0]!.detail).toContain('an agent works there now');
    answer = 'always';
    expect(await call(c, 'merge_worktree', { worktree: 'w1' })).toEqual({ merged: true });
    await call(c, 'merge_worktree', { worktree: 'w1' });
    expect(cards).toHaveLength(3);
  });

  it('a merge that cannot go says why', async () => {
    vi.mocked(port.merge).mockResolvedValueOnce({ merged: false, reason: 'conflict', files: ['a.ts'] });
    expect(await call(await connect(), 'merge_worktree', { worktree: 'w1' })).toEqual({ merged: false, reason: 'conflict', files: ['a.ts'] });
  });

  it.each(['ask', 'trusted', 'full'] as const)('at %s, archive asks once', async (level) => {
    const c = await connect(level);
    answer = 'always';
    await call(c, 'archive_worktree', { worktree: 'w1' });
    await call(c, 'archive_worktree', { worktree: 'w1' });
    expect(cards.map((x) => x.once)).toEqual([true, true]);
    expect(port.archive).toHaveBeenCalledTimes(2);
  });

  it('restore brings back an archived worktree, and only one', async () => {
    const c = await connect();
    expect(await call(c, 'restore_worktree', { worktree: 'w2' })).toEqual({ restored: true });
    expect(port.restore).toHaveBeenCalledWith('w2');
    expect(await call(c, 'restore_worktree', { worktree: 'w1' })).toMatchObject({ error: 'invalid_request' });
    expect(await call(c, 'archive_worktree', { worktree: 'w2' })).toMatchObject({ error: 'invalid_request' });
  });

  it('a worktree in another project is refused before any card', async () => {
    const c = await connect('trusted');
    for (const tool of ['merge_worktree', 'archive_worktree']) expect(await call(c, tool, { worktree: 't1' })).toMatchObject({ error: 'project_denied' });
    expect(await call(c, 'merge_worktree', { worktree: 'nope' })).toMatchObject({ error: 'not_found' });
    expect(cards).toEqual([]);
  });

  it.each([['ask', 1], ['trusted', 1], ['full', 0]] as const)('at %s, a screenshot shows %i cards', async (level, count) => {
    const c = await connect(level);
    const res = (await c.callTool({ name: 'screenshot', arguments: {} })) as { content: Array<{ type: string; data?: string; text?: string }> };
    expect(cards).toHaveLength(count);
    expect(res.content.map((x) => x.type)).toEqual(['text', 'image']);
    expect(res.content[1]!.data).toBe('aGk=');
    expect(JSON.parse(res.content[0]!.text!).result.text).toBe('A shot');
  });

  it('a declined screenshot takes none', async () => {
    const c = await connect('trusted');
    answer = 'no';
    expect(await call(c, 'screenshot')).toMatchObject({ error: 'declined' });
  });

  it('start_worktree runs as the agent, through the chat port', async () => {
    const c = await connect();
    await call(c, 'start_worktree', { project: 'api', message: 'Fix it', name: 'fix-it' });
    expect(control.launch).toHaveBeenCalledWith(expect.objectContaining({ by: expect.objectContaining({ name: 'GrokBot' }), projectId: 'p1', message: 'Fix it', strategy: 'worktree', name: 'fix-it' }));
    expect(await call(c, 'start_worktree', { project: 'other', message: 'x' })).toMatchObject({ error: 'project_denied' });
  });

  it('start_task sends its first message as the agent', async () => {
    const c = await connect();
    expect(await call(c, 'start_task', { key: 'BOB-1' })).toMatchObject({ chatId: 'w9', delivery: 'started' });
    expect(control.send).toHaveBeenCalledWith(expect.objectContaining({ by: expect.objectContaining({ name: 'GrokBot' }), chatId: 'w9', message: 'Work on BOB-1.' }));
    expect(await call(c, 'start_task', { key: 'THEIR-1' })).toMatchObject({ error: 'project_denied' });
  });

  it('start_plan is a state write and returns its id', async () => {
    const c = await connect('trusted');
    expect(await call(c, 'start_plan', { project: 'api', goal: 'Ship' })).toEqual({ plan: 'pl1' });
    expect(cards).toHaveLength(1);
  });

  it('list_work shows only what it reaches', async () => {
    const got = await call(await connect(), 'list_work');
    expect(got.projects.map((p: { id: string }) => p.id)).toEqual(['p1']);
    expect(got.projects[0].work.map((w: { id: string }) => w.id)).toEqual(['w1', 'w2']);
  });

  it('phone looks: scrubbed data, card below full, and off stops them', async () => {
    const c = await connect();
    expect((await call(c, 'phone_notifications')).result.text).not.toContain('abc123');
    expect(cards).toEqual([]);
    phoneOff = true;
    expect(await call(c, 'phone_screen')).toMatchObject({ error: 'needs_person' });
    expect((await call(c, 'phone_status')).result.text).toBe('A phone');
    phoneOff = false;
    const trusted = await connect('trusted');
    await call(trusted, 'phone_screenshot');
    expect(cards).toHaveLength(1);
  });
});

describe('what starts for an agent runs nothing as you', () => {
  const project = (id: string): Project => ({ id, name: id, root: '/tmp/x', workspaces: [] } as unknown as Project);
  const setup = () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [project('api')] });
    const asked: string[] = [];
    const startedBy: Array<[string, unknown]> = [];
    const made = (id: string, kind: string, name: string): Workspace => ({ id, projectId: 'api', name, kind, path: '/tmp/x', branch: name, createdAt: 1, external: false } as unknown as Workspace);
    const controller = {
      onWorktree: () => () => undefined,
      newWorktree: async (_p: string, name: string) => made('w1', 'worktree', name),
      newChat: async () => made('c1', 'chat', 'Plan'),
      manager: { setStartedBy: (id: string, by: unknown) => void startedBy.push([id, by]) },
    } as unknown as WorkspaceController;
    const board = new Board({ store, dir: null, projectName: () => 'api' });
    const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt) => void asked.push(prompt), sweepMs: 0 });
    const plans = new PlansWork({ store, plans: new Plans({ store, dir: null }), board: work, controller, git: null, askClaude: (prompt) => (asked.push(prompt), undefined), intend: () => undefined, delayMs: 0 });
    return { board, work, plans, asked, startedBy };
  };
  const AGENT = { id: 'g1', name: 'GrokBot' };

  it('a task started for an agent: its moves are the agent\'s, and your agent is not asked', async () => {
    const t = setup();
    const issue = t.board.create({ projectId: 'api', title: 'Fix', status: 'todo' }, t.work.me());
    await t.work.start(issue.key, { quiet: true, by: t.work.agentActor(AGENT) });
    expect(t.asked).toEqual([]);
    expect(t.board.need(issue.key).status).toBe('in_progress');
    expect(t.board.need(issue.key).assignee).toBeUndefined();
    expect(actorName(t.board.need(issue.key).activity.at(-1)!.by, 'p-me')).toBe('GrokBot (agent)');
    t.plans.stop();
    t.work.stop();
  });

  it('a plan started for an agent: a draft, no run of your agent, its conversation marked', async () => {
    const t = setup();
    const plan = await t.plans.createForAgent('api', 'Ship it', AGENT);
    expect(t.asked).toEqual([]);
    expect(plan.status).toBe('draft');
    expect(plan.body).toBeUndefined();
    expect(t.startedBy).toEqual([['c1', AGENT]]);
    expect(actorName(plan.activity.at(-1)!.by, 'p-me')).toBe('GrokBot (agent)');
    t.plans.stop();
    t.work.stop();
  });
});
