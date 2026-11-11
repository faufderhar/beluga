import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { THREAD_TOOL_NAMES, createThreadToolDefs } from '../src/agent/thread-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import { runtimeFor as realRuntime } from '../src/agent/runtime/registry.js';
import { routedBackend } from '../src/agent/runtime/router.js';
import { AgentHost } from '../src/core/agent-host.js';
import { externalRequester } from '../src/core/trust.js';
import { PHONE } from '../src/companion/coverage.js';
import { localModels, parseLocalModel } from '../src/shared/local-endpoints.js';
import { ThreadService, type ThreadServiceDeps } from '../src/core/threads/service.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const PROJECT = { id: 'p1', name: 'app', root: '/code/app', base: 'main' };

/** A fake backend behind the service: its chats, and a turn that ends when the test says so. */
function setup(over: Partial<ThreadServiceDeps> = {}) {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/home/me' });
  store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
  store.dispatch({ type: 'runtimes', runtimes: [
    { id: 'claude', label: 'Claude', available: true },
    { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5', label: 'GPT-5', description: '' }] },
    { id: 'local', label: 'Local model', available: false, why: 'No local model endpoint is set' },
  ] });
  store.dispatch({ type: 'models', models: [{ value: 'opus', label: 'Opus', description: '' }] as never });
  const chats = new Map<string, Workspace>();
  let n = 0;
  const made: string[] = [];
  const asks: Array<{ prompt: string; channel: string; id: string; urgent: boolean; shown: string }> = [];
  const stops: string[] = [];
  const add = (id: string, fields: Partial<Workspace> = {}): Workspace => {
    const ws: Workspace = { id, projectRoot: PROJECT.root, name: id, path: `/code/app/${id}`, kind: 'worktree', createdAt: 1, projectId: PROJECT.id, external: false, ...fields };
    chats.set(id, ws);
    return ws;
  };
  add('root');
  const deps: ThreadServiceDeps = {
    store,
    selfId: () => ME,
    projects: () => [{ ...PROJECT, workspaces: [...chats.values()] }] as Project[],
    find: (id) => chats.get(id),
    setThread: (id, thread) => void chats.set(id, { ...chats.get(id)!, thread }),
    newWorktree: async (projectId, name, o) => {
      made.push(`worktree:${projectId}:${name}:${o.base ?? ''}`);
      const ws = add(`t${++n}`, { name, thread: o.thread, ...(o.agent ? { agent: { runtime: o.agent.runtime, label: o.agent.label } } : {}), ...(o.agent?.model ? { model: o.agent.model } : {}) });
      return ws;
    },
    newChat: async (projectId, title, o) => {
      made.push(`chat:${projectId}:${o.dir ?? ''}`);
      return add(`t${++n}`, { name: title, kind: 'chat', path: o.dir ?? PROJECT.root, thread: o.thread, askOnly: true });
    },
    setAgent: (id, agent) => void chats.set(id, { ...chats.get(id)!, agent, ...(agent?.model ? { model: agent.model } : {}) }),
    setEffort: (id, effort) => void chats.set(id, { ...chats.get(id)!, ...(effort ? { effort } : {}) }),
    ask: (prompt, channel, id, o) => void asks.push({ prompt, channel, id, urgent: o.urgent, shown: o.shown }),
    stopRun: (channel) => void stops.push(channel),
    runsAgent: (agent) => agent.runtime !== 'local',
    canSteer: (runtime) => runtime !== 'noSteer',
    wake: () => undefined,
    hasMacChat: () => true,
    terminalDriving: () => false,
    ...over,
  };
  const service = new ThreadService(deps);
  const finish = (channel: string, requestId: string, event: 'done' | 'error' = 'done', text = 'All green.') => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts: Date.now(), channel });
  const event = (channel: string, requestId: string, kind: 'started' | 'queued' | 'awaiting_approval') => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event: kind, text: '', ts: Date.now(), channel });
  const tools = (channel = 'ws:root') => service.forRun(channel)!;
  return { store, service, chats, made, asks, stops, tools, add, finish, event };
}

const idOf = (answer: string): string => /thread "([^"]+)"/.exec(answer)![1]!;

describe('thread_start', () => {
  it('starts a child in its own worktree, with the harness and model it asked for', async () => {
    const t = setup();
    const answer = await t.tools().start({ task: 'Fix the login test', title: 'Fix login', agent: { runtime: 'codex', model: 'gpt-5', effort: 'high' }, where: 'worktree', base: 'dev' });
    const id = idOf(answer);
    const child = t.chats.get(id)!;
    expect(t.made).toEqual(['worktree:p1:Fix login:dev']);
    expect(child.agent?.runtime).toBe('codex');
    expect(child.model).toBe('gpt-5');
    expect(child.effort).toBe('high');
    expect(child.thread).toMatchObject({ parent: 'ws:root', parentTitle: 'root', root: 'ws:root', depth: 1, task: 'Fix the login test' });
    expect(t.asks).toHaveLength(1);
    expect(t.asks[0]!.channel).toBe(`ws:${id}`);
    expect(t.asks[0]!.prompt).toContain('Fix the login test');
    expect(t.asks[0]!.prompt).toContain('not the user');
    expect(t.asks[0]!.shown).toBe('Fix the login test');
    expect(child.thread!.owed).toEqual([t.asks[0]!.id]);
    expect(child.thread!.by).toBe(t.asks[0]!.id);
  });

  it('a grandchild goes one deeper and keeps the root', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    const grand = idOf(await t.tools(`ws:${child}`).start({ task: 'two' }));
    expect(t.chats.get(grand)!.thread).toMatchObject({ parent: `ws:${child}`, root: 'ws:root', depth: 2 });
  });

  it('where=read makes a read-only chat in the parent’s folder, and no worktree', async () => {
    const t = setup();
    const id = idOf(await t.tools().start({ task: 'Read the code', where: 'read' }));
    expect(t.made).toEqual(['chat:p1:/code/app/root']);
    expect(t.chats.get(id)!.thread!.readOnly).toBe(true);
  });

  it('BLG-221: a read-only thread cannot start a worktree thread, and where=read still works', async () => {
    const t = setup();
    const reader = idOf(await t.tools().start({ task: 'Read the code', where: 'read' }));
    t.made.length = 0;
    await expect(t.tools(`ws:${reader}`).start({ task: 'Change it', where: 'worktree' })).rejects.toThrow(/read-only.*where=read/);
    await expect(t.tools(`ws:${reader}`).start({ task: 'Change it', project: 'app' })).rejects.toThrow(/read-only.*where=read/);
    expect(t.made).toEqual([]);
    const grand = idOf(await t.tools(`ws:${reader}`).start({ task: 'Read more', where: 'read' }));
    expect(t.chats.get(grand)!.thread).toMatchObject({ parent: `ws:${reader}`, readOnly: true, depth: 2 });
  });

  it('refuses base with where=read', async () => {
    const t = setup();
    await expect(t.tools().start({ task: 'x', where: 'read', base: 'dev' })).rejects.toThrow(/base/);
    expect(t.made).toEqual([]);
  });

  it('from Your Mac the project is required; a named project works', async () => {
    const t = setup();
    await expect(t.tools('mac:assistant').start({ task: 'x' })).rejects.toThrow(/project.*app/);
    expect(t.made).toEqual([]);
    const id = idOf(await t.tools('mac:assistant').start({ task: 'x', project: 'app' }));
    expect(t.chats.get(id)!.thread).toMatchObject({ parent: 'mac:assistant', root: 'mac:assistant', depth: 1 });
  });

  it('an unknown project, runtime or model is a clear error and creates nothing', async () => {
    const t = setup();
    await expect(t.tools().start({ task: 'x', project: 'nope' })).rejects.toThrow(/"nope".*app/);
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'gemini' } })).rejects.toThrow(/"gemini".*claude.*codex/);
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'local' } })).rejects.toThrow(/No local model endpoint/);
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'codex', model: 'gpt-9' } })).rejects.toThrow(/"gpt-9".*gpt-5/);
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'claude', model: 'mistral' } })).rejects.toThrow(/"mistral".*opus/);
    expect(t.made).toEqual([]);
    expect(t.asks).toEqual([]);
  });

  it('a failed worktree says so and sends nothing', async () => {
    const t = setup({ newWorktree: async () => undefined });
    await expect(t.tools().start({ task: 'x', base: 'gone' })).rejects.toThrow(/could not make/i);
    expect(t.asks).toEqual([]);
  });

  it('a parent in plan mode starts only plan-mode children', async () => {
    const t = setup();
    t.store.dispatch({ type: 'plan_mode', channel: 'ws:root', on: true });
    await expect(t.tools().start({ task: 'x', plan: false })).rejects.toThrow(/plan mode/);
    expect(t.made).toEqual([]);
    const id = idOf(await t.tools().start({ task: 'x' }));
    expect(t.store.getState().planMode[`ws:${id}`]).toBe(true);
  });

  it('plan=true turns on plan mode before the task goes', async () => {
    const t = setup();
    const id = idOf(await t.tools().start({ task: 'x', plan: true }));
    expect(t.store.getState().planMode[`ws:${id}`]).toBe(true);
  });

  it('a repeated key returns the same thread and starts no second run', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'x', key: 'k1' }));
    const b = idOf(await t.tools().start({ task: 'other words', key: 'k1' }));
    expect(b).toBe(a);
    expect(t.made).toHaveLength(1);
    expect(t.asks).toHaveLength(1);
  });

  it('two starts at once with one key make one thread', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.tools().start({ task: 'x', key: 'k1' }), t.tools().start({ task: 'x', key: 'k1' })]);
    expect(idOf(a)).toBe(idOf(b));
    expect(t.made).toHaveLength(1);
    expect(t.asks).toHaveLength(1);
  });

  it('one key in two parents makes two threads', async () => {
    const t = setup();
    t.add('other');
    const a = idOf(await t.tools().start({ task: 'x', key: 'k1' }));
    const b = idOf(await t.tools('ws:other').start({ task: 'x', key: 'k1' }));
    expect(a).not.toBe(b);
  });

  describe('limits', () => {
    const limits = (over: object) => ({ depth: 3, treeRunning: 8, treeLive: 30, macRunning: 16, ...over });

    it('refuses past the depth, creates no worktree and names the numbers', async () => {
      const t = setup();
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ depth: 1 }) } });
      const child = idOf(await t.tools().start({ task: 'one' }));
      await expect(t.tools(`ws:${child}`).start({ task: 'two' })).rejects.toThrow(/depth 2.*limit is 1/);
      expect(t.made).toHaveLength(1);
    });

    it('a changed limit holds for the next thread_start, with no restart', async () => {
      const t = setup();
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ treeRunning: 1 }) } });
      await t.tools().start({ task: 'one' });
      await expect(t.tools().start({ task: 'two' })).rejects.toThrow(/Settings › Agent › Thread limits/);
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ treeRunning: 2 }) } });
      await t.tools().start({ task: 'two' });
      expect(t.made).toHaveLength(2);
    });

    it('refuses at the tree running limit, and a finished thread frees the slot', async () => {
      const t = setup();
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ treeRunning: 1 }) } });
      const child = idOf(await t.tools().start({ task: 'one' }));
      await expect(t.tools().start({ task: 'two' })).rejects.toThrow(/1 threads are running or queued in this tree.*limit is 1/);
      expect(t.made).toHaveLength(1);
      t.finish(`ws:${child}`, t.asks[0]!.id);
      await t.tools().start({ task: 'two' });
      expect(t.made).toHaveLength(2);
    });

    it('refuses at the tree live limit, and an archive frees the slot', async () => {
      const t = setup();
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ treeLive: 1 }) } });
      const child = idOf(await t.tools().start({ task: 'one' }));
      t.finish(`ws:${child}`, t.asks[0]!.id);
      await expect(t.tools().start({ task: 'two' })).rejects.toThrow(/1 threads in this tree are not archived/);
      t.chats.set(child, { ...t.chats.get(child)!, archived: true });
      await t.tools().start({ task: 'two' });
      expect(t.made).toHaveLength(2);
    });

    it('refuses at the Mac limit across trees', async () => {
      const t = setup();
      t.add('other');
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ macRunning: 1 }) } });
      await t.tools().start({ task: 'one' });
      await expect(t.tools('ws:other').start({ task: 'two' })).rejects.toThrow(/1 threads are running or queued on this Mac/);
      expect(t.made).toHaveLength(1);
    });

    it('counts a start still making its worktree', async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((r) => (open = r));
      const t = setup({
        newWorktree: async (_p, name, o) => {
          await gate;
          return { id: name, projectRoot: PROJECT.root, name, path: `/x/${name}`, kind: 'worktree', createdAt: 1, projectId: PROJECT.id, external: false, thread: o.thread } as Workspace;
        },
      });
      t.store.dispatch({ type: 'prefs', prefs: { threadLimits: limits({ treeRunning: 1 }) } });
      const first = t.tools().start({ task: 'one', title: 'a' });
      await expect(t.tools().start({ task: 'two', title: 'b' })).rejects.toThrow(/running or queued in this tree/);
      open();
      await first;
    });
  });
});

describe('an OpenCode child', () => {
  /** The runtime's own capabilities, as Session.canSteer reads them. */
  const realSteer = (runtime: string | undefined): boolean => Boolean(runtime && realRuntime(runtime)?.capabilities.canSteer);
  const withOpenCode = () => {
    const t = setup({ canSteer: realSteer });
    t.store.dispatch({ type: 'runtimes', runtimes: [...t.store.getState().runtimes, { id: 'opencode', label: 'OpenCode', available: true, models: [{ value: 'opencode/big-pickle', label: 'Big Pickle', description: '' }] }] });
    return t;
  };

  it('starts through ThreadService with the runtime and model it asked for', async () => {
    const t = withOpenCode();
    const id = idOf(await t.tools().start({ task: 'Read the docs', agent: { runtime: 'opencode', model: 'opencode/big-pickle' } }));
    const child = t.chats.get(id)!;
    expect(child.agent).toMatchObject({ runtime: 'opencode', label: 'OpenCode' });
    expect(child.model).toBe('opencode/big-pickle');
    expect(t.asks[0]!.channel).toBe(`ws:${id}`);
  });

  it('refuses an OpenCode model that it does not list, and makes no worktree', async () => {
    const t = withOpenCode();
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'opencode', model: 'nope/none' } })).rejects.toThrow(/"nope\/none".*opencode\/big-pickle/);
    expect(t.made).toEqual([]);
  });

  it('refuses a steer, says why, and leaves the thread as it was', async () => {
    const t = withOpenCode();
    const id = idOf(await t.tools().start({ task: 'x', agent: { runtime: 'opencode' } }));
    expect(() => t.tools().message({ id, text: 'now', mode: 'steer' })).toThrow('OpenCode cannot steer. Use mode "queue": it reads the message when its turn ends.');
    expect(t.asks).toHaveLength(1);
    expect(t.chats.get(id)!.thread!.owed).toHaveLength(1);
    expect(t.tools().message({ id, text: 'later' })).toMatch(/Queued/);
  });

  it('thread_status lists it with steer off', async () => {
    const t = withOpenCode();
    const out = JSON.parse(await t.tools().status({})) as { agents: Array<{ runtime: string; canSteer: boolean; models: string[] }> };
    expect(out.agents.find((a) => a.runtime === 'opencode')).toEqual({ runtime: 'opencode', label: 'OpenCode', canSteer: false, models: ['opencode/big-pickle'] });
    expect(out.agents.find((a) => a.runtime === 'codex')?.canSteer).toBe(true);
  });
});

describe('a local-model child', () => {
  const ENDPOINT = { id: 'ollama', label: 'Ollama', models: [], found: ['qwen3-coder'], reachable: true, builtIn: true };
  /** The picker's real list and the real value parser, as session-parts and Session.runsAgent use them. */
  const withLocal = (endpoint: Parameters<typeof localModels>[0][number] = ENDPOINT) => {
    const t = setup({ runsAgent: (agent) => agent.runtime !== 'local' || parseLocalModel(agent.model)?.id === endpoint.id });
    t.store.dispatch({ type: 'runtimes', runtimes: t.store.getState().runtimes.map((r) => (r.id === 'local' ? { id: 'local', label: 'Local model', available: true, models: localModels([endpoint]) } : r)) });
    return t;
  };

  it('a local-model child starts with runtime local and its model when an endpoint answers', async () => {
    const t = withLocal();
    const id = idOf(await t.tools().start({ task: 'Read the docs', agent: { runtime: 'local', model: 'ollama/qwen3-coder' } }));
    const child = t.chats.get(id)!;
    expect(child.agent).toMatchObject({ runtime: 'local', label: 'Local model' });
    expect(child.model).toBe('ollama/qwen3-coder');
    expect(t.asks).toHaveLength(1);
  });

  it('the router runs that child’s place on the local runtime, with its model', async () => {
    const t = withLocal();
    const id = idOf(await t.tools().start({ task: 'x', agent: { runtime: 'local', model: 'ollama/qwen3-coder' } }));
    const child = t.chats.get(id)!;
    const ran: string[] = [];
    const backend = (name: string): AgentBackend => ({
      run: async (input) => {
        ran.push(`${name}:${input.place?.agent?.model}`);
        return 'ok';
      },
    });
    const routed = routedBackend(backend('claude'), 'claude', (runtime) => (runtime === 'local' ? backend('local') : undefined));
    await routed.run({ prompt: 'x', place: { agent: { ...child.agent!, model: child.model } } } as never);
    expect(ran).toEqual(['local:ollama/qwen3-coder']);
  });

  it('with no model it says which models there are, and makes no worktree', async () => {
    const t = withLocal();
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'local' } })).rejects.toThrow('Local model needs a model. Use one of: ollama/qwen3-coder.');
    expect(t.made).toEqual([]);
  });

  it('refuses a model of an endpoint that does not answer, and says why', async () => {
    const t = withLocal({ ...ENDPOINT, reachable: false });
    await expect(t.tools().start({ task: 'x', agent: { runtime: 'local', model: 'ollama/qwen3-coder' } })).rejects.toThrow(/Ollama isn't answering/);
    expect(t.made).toEqual([]);
  });

  it('the status list leaves out a local model that cannot run', async () => {
    const t = withLocal({ ...ENDPOINT, found: [], models: [] });
    const out = JSON.parse(await t.tools().status({})) as { agents: Array<{ runtime: string; models: string[] }> };
    expect(out.agents.find((a) => a.runtime === 'local')?.models).toEqual([]);
  });
});

describe('thread_status', () => {
  it('no id lists the descendants and the installed agents with models and canSteer', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one', agent: { runtime: 'codex' } }));
    await t.tools(`ws:${child}`).start({ task: 'two' });
    const out = JSON.parse(await t.tools().status({})) as { threads: Array<{ id: string; state: string; agent: string }>; agents: Array<{ runtime: string; canSteer: boolean; models: string[] }> };
    expect(out.threads).toHaveLength(2);
    expect(out.threads[0]).toMatchObject({ id: child, state: 'queued', agent: 'codex' });
    expect(out.agents.map((a) => a.runtime)).toEqual(['claude', 'codex']);
    expect(out.agents[1]).toMatchObject({ canSteer: true, models: ['gpt-5'] });
  });

  it('with an id: state, harness, times and the last answer', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one', agent: { runtime: 'codex', model: 'gpt-5' } }));
    t.event(`ws:${child}`, t.asks[0]!.id, 'started');
    expect(JSON.parse(await t.tools().status({ id: child }))).toMatchObject({ id: child, state: 'running', agent: 'codex', model: 'gpt-5' });
    t.finish(`ws:${child}`, t.asks[0]!.id);
    const out = JSON.parse(await t.tools().status({ id: child })) as { state: string; answer: string; endedAt: number };
    expect(out.state).toBe('done');
    expect(out.answer).toBe('All green.');
    expect(out.endedAt).toBeGreaterThan(0);
  });

  it('shows needs_you while the turn waits for a person', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.event(`ws:${child}`, t.asks[0]!.id, 'awaiting_approval');
    expect(JSON.parse(await t.tools().status({ id: child })).state).toBe('needs_you');
  });

  it('a failed turn reports failed, and a stopped turn reports stopped', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'one' }));
    t.finish(`ws:${a}`, t.asks[0]!.id, 'error', 'It broke');
    expect(JSON.parse(await t.tools().status({ id: a })).state).toBe('failed');
    const b = idOf(await t.tools().start({ task: 'two' }));
    t.finish(`ws:${b}`, t.asks[1]!.id, 'error', 'Stopped by you');
    expect(JSON.parse(await t.tools().status({ id: b })).state).toBe('stopped');
  });

  it('a wait timeout returns the state and does not stop the work', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.event(`ws:${child}`, t.asks[0]!.id, 'started');
    const out = JSON.parse(await t.tools().status({ id: child, waitSec: 0.02 })) as { state: string; waited: string };
    expect(out.state).toBe('running');
    expect(out.waited).toBe('timeout');
    expect(t.stops).toEqual([]);
  });

  it('a wait returns at the final state and claims the result', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.event(`ws:${child}`, t.asks[0]!.id, 'started');
    const wait = t.tools().status({ id: child, waitSec: 30 });
    t.finish(`ws:${child}`, t.asks[0]!.id);
    expect(JSON.parse(await wait).state).toBe('done');
    expect(t.chats.get(child)!.thread!.outcome?.delivered).toBe(true);
  });

  it('a wait ends on needs_you and does not claim anything', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.event(`ws:${child}`, t.asks[0]!.id, 'started');
    const wait = t.tools().status({ id: child, waitSec: 30 });
    t.event(`ws:${child}`, t.asks[0]!.id, 'awaiting_approval');
    expect(JSON.parse(await wait).state).toBe('needs_you');
    expect(t.chats.get(child)!.thread!.outcome).toBeUndefined();
  });

  it('a status without a wait does not claim the result', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.finish(`ws:${child}`, t.asks[0]!.id);
    await t.tools().status({ id: child });
    expect(t.chats.get(child)!.thread!.outcome?.delivered).toBe(false);
  });

  it('a wait with no id ends when one thread has a result, and claims it', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'one' }));
    const b = idOf(await t.tools().start({ task: 'two' }));
    t.event(`ws:${a}`, t.asks[0]!.id, 'started');
    t.event(`ws:${b}`, t.asks[1]!.id, 'started');
    const wait = t.tools().status({ waitSec: 30 });
    t.finish(`ws:${a}`, t.asks[0]!.id);
    const out = JSON.parse(await wait) as { threads: Array<{ id: string; state: string; answer?: string }> };
    expect(out.threads.find((x) => x.id === a)).toMatchObject({ state: 'done', answer: 'All green.' });
    expect(out.threads.find((x) => x.id === b)!.state).toBe('running');
    expect(t.chats.get(a)!.thread!.outcome?.delivered).toBe(true);
  });
});

describe('thread_message', () => {
  it('queues a message whose request joins owed', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one', agent: { runtime: 'codex' } }));
    const out = t.tools().message({ id: child, text: 'Also fix the docs' });
    expect(out).toMatch(/queue/i);
    const ask = t.asks[1]!;
    expect(ask.urgent).toBe(false);
    expect(ask.prompt).toContain('Also fix the docs');
    expect(ask.prompt).toContain('not the user');
    expect(t.chats.get(child)!.thread!.owed).toEqual([t.asks[0]!.id, ask.id]);
  });

  it('steers now on a runtime that can steer', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one', agent: { runtime: 'codex' } }));
    t.tools().message({ id: child, text: 'Stop that', mode: 'steer' });
    expect(t.asks[1]!.urgent).toBe(true);
  });

  it('refuses a steer on a runtime that cannot steer, and says so', async () => {
    const t = setup({ canSteer: () => false });
    const child = idOf(await t.tools().start({ task: 'one', agent: { runtime: 'codex' } }));
    expect(() => t.tools().message({ id: child, text: 'x', mode: 'steer' })).toThrow(/Codex cannot steer.*queue/);
    expect(t.asks).toHaveLength(1);
    expect(t.chats.get(child)!.thread!.owed).toHaveLength(1);
  });

  it('refuses an archived thread, and clears an old stop on a new message', async () => {
    const t = setup();
    const child = idOf(await t.tools().start({ task: 'one' }));
    t.tools().stop({ id: child });
    t.tools().message({ id: child, text: 'Carry on' });
    expect(t.chats.get(child)!.thread!.stopped).toBeUndefined();
    t.chats.set(child, { ...t.chats.get(child)!, archived: true });
    expect(() => t.tools().message({ id: child, text: 'x' })).toThrow(/archived/);
  });
});

describe('thread_stop', () => {
  it('stops the thread and its descendants, depth first', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    const a1 = idOf(await t.tools(`ws:${a}`).start({ task: 'a1' }));
    const a1x = idOf(await t.tools(`ws:${a1}`).start({ task: 'a1x' }));
    const b = idOf(await t.tools().start({ task: 'b' }));
    const out = t.tools().stop({ id: a, reason: 'wrong way' });
    expect(t.stops).toEqual([`ws:${a1x}`, `ws:${a1}`, `ws:${a}`]);
    expect(out).toContain('3');
    expect(t.chats.get(a1)!.thread!.stopped?.by).toBe('agent');
    expect(t.chats.get(b)!.thread!.stopped).toBeUndefined();
  });

  it('a thread that already ended stays as it ended', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.finish(`ws:${a}`, t.asks[0]!.id);
    const out = t.tools().stop({ id: a });
    expect(t.stops).toEqual([]);
    expect(out).toMatch(/already ended/i);
    expect(t.chats.get(a)!.thread!.outcome?.state).toBe('done');
  });

  it('the stopper already knows: a stop it asked for is not owed back to it', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.event(`ws:${a}`, t.asks[0]!.id, 'started');
    t.tools().stop({ id: a });
    t.finish(`ws:${a}`, t.asks[0]!.id, 'error', 'Stopped by you');
    expect(t.chats.get(a)!.thread!.outcome).toMatchObject({ state: 'stopped', delivered: true });
    expect(t.chats.get(a)!.thread!.owed).toEqual([]);
  });

  it('a person’s stop reports stopped to the parent', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.finish(`ws:${a}`, t.asks[0]!.id, 'error', 'Stopped by you');
    expect(t.chats.get(a)!.thread!.stopped?.by).toBe('person');
    expect(t.chats.get(a)!.thread!.outcome).toMatchObject({ state: 'stopped', delivered: false });
  });
});

describe('scope', () => {
  it('a chat cannot read, message or stop a thread outside its subtree', async () => {
    const t = setup();
    t.add('stranger');
    const child = idOf(await t.tools().start({ task: 'one' }));
    const sibling = idOf(await t.tools().start({ task: 'two' }));
    const outside = t.tools('ws:stranger');
    await expect(outside.status({ id: child })).rejects.toThrow(/not under this chat/);
    expect(() => outside.message({ id: child, text: 'x' })).toThrow(/not under this chat/);
    expect(() => outside.stop({ id: child })).toThrow(/not under this chat/);
    // Nor up or across its own tree.
    const inside = t.tools(`ws:${child}`);
    await expect(inside.status({ id: sibling })).rejects.toThrow(/not under this chat/);
    await expect(inside.status({ id: child })).rejects.toThrow(/not under this chat/);
    expect(() => inside.stop({ id: 'root' })).toThrow(/not under this chat/);
    expect(JSON.parse(await outside.status({})).threads).toEqual([]);
    expect(t.stops).toEqual([]);
  });

  it('a plain chat that is no thread is out of reach', async () => {
    const t = setup();
    t.add('plain');
    await expect(t.tools().status({ id: 'plain' })).rejects.toThrow(/not under this chat/);
  });

  it('runs only where a thread can have a parent', () => {
    const t = setup();
    expect(t.service.forRun('room')).toBeUndefined();
    expect(t.service.forRun('dm:someone')).toBeUndefined();
    expect(t.service.forRun('group:x')).toBeUndefined();
    expect(t.service.forRun('ws:root')).toBeDefined();
    expect(t.service.forRun('mac:assistant:abc')).toBeDefined();
  });
});

describe('the outcome', () => {
  it('a person’s turn updates the outcome and owes nothing', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.finish(`ws:${a}`, t.asks[0]!.id);
    const before = t.chats.get(a)!.thread!;
    t.chats.set(a, { ...t.chats.get(a)!, thread: { ...before, outcome: { ...before.outcome!, delivered: true } } });
    t.finish(`ws:${a}`, 'person-turn', 'done', 'Person asked, agent answered');
    expect(t.chats.get(a)!.thread!.outcome).toMatchObject({ summary: 'Person asked, agent answered', delivered: true });
  });

  it('a person’s turn does not erase a result still on its way', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.finish(`ws:${a}`, t.asks[0]!.id);
    t.finish(`ws:${a}`, 'person-turn');
    expect(t.chats.get(a)!.thread!.outcome?.delivered).toBe(false);
  });

  it('ignores a friend’s event in the same channel', async () => {
    const t = setup();
    const a = idOf(await t.tools().start({ task: 'a' }));
    t.store.dispatch({ type: 'agent_event', owner: 'friend', requestId: t.asks[0]!.id, requester: 'friend', event: 'done', text: 'x', ts: 1, channel: `ws:${a}` });
    expect(t.chats.get(a)!.thread!.outcome).toBeUndefined();
  });
});

describe('who gets the tools', () => {
  const threadTools = { start: async () => '', status: async () => '', message: () => '', stop: () => '' };

  function host(over: { agentThreads?: boolean; place?: object; sentinel?: object; sentinelChat?: object; guest?: boolean } = {}) {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'prefs', prefs: { agentThreads: over.agentThreads ?? true } });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-threads-host-'));
    const runs: AgentRunInput[] = [];
    const agent: AgentBackend = {
      async run(input) {
        runs.push(input);
        return 'ok';
      },
    };
    const h = new AgentHost({
      store,
      selfId: () => ME,
      send: () => true,
      agent: () => agent,
      shares: { roots: () => [] } as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined, ...over.place }), refreshWorkspace: async () => undefined, inChannel: () => undefined, manager: { list: [] } } as never,
      threads: () => threadTools as never,
      ...(over.sentinel ? { sentinel: () => over.sentinel as never } : {}),
      ...(over.sentinelChat ? { sentinelChat: () => over.sentinelChat as never } : {}),
      isGuest: () => over.guest ?? false,
    });
    const ask = (from: string, channel = 'ws:a') => h.onAgentRequest(from, { kind: 'agent_request', requestId: `r${runs.length}`, prompt: 'go', viaAgent: false, channel, urgent: false, plan: false });
    return { h, runs, ask, store, agent, dir };
  }

  it('owner run with the flag on has the thread tools', async () => {
    const t = host();
    await t.ask(ME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeDefined();
    expect(Object.keys(runToolSuites(t.runs[0]!, {} as never, {} as never, t.dir))).toContain('beluga_threads');
  });

  it.each(['trusted', 'full'] as const)('an external agent’s run at %s has no thread tools: a thread would run without its grant and label', async (level) => {
    const t = host();
    t.h.setExternalAgents((r) => (r === externalRequester('g1') ? { name: 'GrokBot', level } : undefined));
    await t.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'ext', prompt: 'go', viaAgent: false, channel: 'ws:a', urgent: false, plan: false, via: { id: 'g1', name: 'GrokBot', creationSource: 'mcp' } });
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('a read-only thread cannot move itself into a worktree', async () => {
    const t = host({ place: { autoEdit: false, askOnly: { project: 'p', stays: true } } });
    await t.ask(ME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.continueInWorktree).toBeUndefined();
  });

  it('turning the switch off takes the server from the next run, with no restart', async () => {
    const t = host();
    await t.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'on', prompt: 'go', viaAgent: false, channel: 'ws:a', urgent: false, plan: false });
    await waitFor(() => t.runs.length === 1);
    await t.h.idle('ws:a');
    t.store.dispatch({ type: 'prefs', prefs: { agentThreads: false } });
    await t.h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'off', prompt: 'go', viaAgent: false, channel: 'ws:a', urgent: false, plan: false });
    await waitFor(() => t.runs.length === 2);
    expect(Object.keys(runToolSuites(t.runs[0]!, {} as never, {} as never, t.dir))).toContain('beluga_threads');
    expect(Object.keys(runToolSuites(t.runs[1]!, {} as never, {} as never, t.dir))).not.toContain('beluga_threads');
  });

  it('no tool writes the switch or the limits: only the Mac’s Settings do', () => {
    expect([...THREAD_TOOL_NAMES].sort()).toEqual(['thread_message', 'thread_start', 'thread_status', 'thread_stop'].map((n) => `mcp__beluga_threads__${n}`));
    expect(PHONE['session.setPrefs']).toBe('mac');
  });

  it('flag off: runs have no beluga_threads server', async () => {
    const t = host({ agentThreads: false });
    await t.ask(ME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
    expect(Object.keys(runToolSuites(t.runs[0]!, {} as never, {} as never, t.dir))).not.toContain('beluga_threads');
  });

  it('friend request has no thread tools', async () => {
    const t = host();
    t.store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/home/me' });
    t.h.runOnBehalf('friend', 'ws:a', 'go');
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('guest request has no thread tools', async () => {
    const t = host({ guest: true });
    t.h.runOnBehalf('guest', 'ws:a', 'go');
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('dialogue turn has no thread tools', async () => {
    const t = host();
    await t.h.runDialogueTurn('ws:a', t.agent, { prompt: 'turn', signal: new AbortController().signal, dialogue: {} as never });
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('sentinel run has no thread tools', async () => {
    const t = host({ sentinel: { tools: {}, brief: 'b', inRun: true } });
    await t.ask(ME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('sentinel chat has no thread tools', async () => {
    const t = host({ sentinelChat: { cwd: '/tmp', additionalDirectories: [], autoEdit: false, onSession: () => undefined } });
    await t.ask(ME, 'sentinel:chat');
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('sync-main run has no thread tools', async () => {
    const t = host({ place: { askOnly: { project: 'p' }, syncMain: { branch: 'main', upstream: 'origin/main' } } });
    await t.ask(ME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.threadTools).toBeUndefined();
  });

  it('each tool says it is safe, or Codex asks an approval that Beluga refuses', () => {
    for (const def of createThreadToolDefs(threadTools as never)) expect(def.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
  });

  it('the policy allows the four tools without a prompt', () => {
    expect(THREAD_TOOL_NAMES).toEqual(['thread_start', 'thread_status', 'thread_message', 'thread_stop'].map((n) => `mcp__beluga_threads__${n}`));
    expect(createThreadToolDefs(threadTools as never).map((d) => `mcp__beluga_threads__${d.name}`)).toEqual(THREAD_TOOL_NAMES);
    for (const name of THREAD_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/x', roots: ['/x'], autoEdit: true })).toBe('allow');
  });
});

describe('a read-only chat, on the real manager', () => {
  it('is questions only in a worktree’s folder, also after a refresh; a plain chat there is not', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-threads-read-')));
    const repo = path.join(base, 'app');
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    writeFileSync(path.join(repo, 'README.md'), '# hi\n');
    sh('add', '.');
    sh('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init');
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [], projects: [repo], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const project = mgr.list.find((p) => p.root)!;
    const tree = await mgr.createWorktree(project.id, 'parent');
    const thread = { parent: `ws:${tree.id}`, parentTitle: 'parent', root: `ws:${tree.id}`, depth: 1, task: 't', startedAt: 1, owed: [], readOnly: true as const };
    const chat = await mgr.createChat(project.id, 'look', undefined, { dir: tree.path, thread });
    expect(chat.path).toBe(tree.path);
    expect(chat.askOnly).toBe(true);
    await mgr.refresh();
    expect(mgr.find(chat.id)?.askOnly).toBe(true);
    expect(mgr.find(chat.id)?.thread?.readOnly).toBe(true);
    const made = await mgr.createWorktree(project.id, 'child', undefined, { thread: { ...thread, readOnly: undefined } as never });
    expect(made.thread?.parent).toBe(`ws:${tree.id}`);
    expect(mgr.find(made.id)?.askOnly).toBeFalsy();
  });
});
