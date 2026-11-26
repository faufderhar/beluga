import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { autonomyOf, planAutonomy, roleAgent } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { AgentRef } from '../src/protocol.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-982: who plans, who builds and who checks a plan, each any agent; BLG-981: Full Autopilot on a plan. */

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Qwen', model: 'qwen3-coder' };

const ws = (id: string, projectId: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind: 'chat', projectRoot: '/tmp/p', branch: `b/${name}`, createdAt: 0, external: false, askOnly: true, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [{ id: 'safe', title: 'Safe payments', criteria: ['401 without a session'], tasks: [{ id: 'auth', title: 'Auth on payment routes' }] }],
};

function setup(dir: string | null = null) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
  const setAgent: Array<{ id: string; agent: AgentRef }> = [];
  const followed: Array<{ channel: string; agent: AgentRef | undefined }> = [];
  let n = 0;
  const patchWs = (id: string, patch: Partial<Workspace>): void =>
    store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? ({ ...w, ...patch } as Workspace) : w)) })) });
  const controller = {
    onWorktree: () => () => undefined,
    newChat: async (projectId: string, title: string) => {
      const w = ws(`c${++n}`, projectId, title);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      return w;
    },
    renameChat: async () => undefined,
    archive: async () => true,
    manager: {
      setAgent: (id: string, agent: AgentRef) => {
        setAgent.push({ id, agent });
        patchWs(id, { agent } as Partial<Workspace>);
      },
      find: (id: string) => store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id),
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir, saveDelayMs: 0 });
  const work = new PlansWork({ store, plans, board: boardWork, controller, askClaude: () => undefined, intend: () => undefined, delayMs: 0, git: null, followAgent: (channel, agent) => void followed.push({ channel, agent }) });
  return { store, plans, work, setAgent, followed, patchWs };
}

describe('who plans, builds and checks a plan (BLG-982)', () => {
  it('one agent plays every part unless you pick another for one', () => {
    expect(roleAgent({}, 'planner')).toBeUndefined();
    expect(roleAgent({ agent: CODEX }, 'planner')).toEqual(CODEX);
    expect(roleAgent({ agent: CODEX }, 'checker')).toEqual(CODEX);
    expect(roleAgent({ agent: CODEX, planner: CLAUDE, checker: LOCAL }, 'planner')).toEqual(CLAUDE);
    expect(roleAgent({ agent: CODEX, planner: CLAUDE, checker: LOCAL }, 'builder')).toEqual(CODEX);
    expect(roleAgent({ agent: CODEX, planner: CLAUDE, checker: LOCAL }, 'checker')).toEqual(LOCAL);
  });

  it('a new plan’s own conversation runs on its planner, and keeps its builder and checker', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', agent: CODEX, planner: CLAUDE, checker: LOCAL });
    expect(t.setAgent).toEqual([{ id: plan.home.slice(3), agent: CLAUDE }]);
    expect(plan).toMatchObject({ agent: CODEX, planner: CLAUDE, checker: LOCAL });
  });

  it('picking nothing plans on the builder, as before', async () => {
    const t = setup();
    const opus: AgentRef = { ...CLAUDE, model: 'opus' };
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', agent: opus });
    expect(t.setAgent).toEqual([{ id: plan.home.slice(3), agent: opus }]);
    expect(plan.planner).toBeUndefined();
    expect(plan.checker).toBeUndefined();
  });

  it('a planner of its own keeps the conversation when the builder changes; changing the planner moves it', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', planner: CLAUDE });
    t.work.setWorkAgent(plan.id, CODEX);
    expect(t.followed).toEqual([]);
    expect(t.work.setRoleAgent(plan.id, 'planner', LOCAL)).toContain('plans with you here');
    expect(t.followed).toEqual([{ channel: plan.home, agent: LOCAL }]);
    // Back to the builder's: the conversation follows Codex.
    t.work.setRoleAgent(plan.id, 'planner', null);
    expect(t.followed.at(-1)).toEqual({ channel: plan.home, agent: CODEX });
    expect(t.plans.need(plan.id).planner).toBeUndefined();
  });

  it('the checker reviews the draft in a conversation on its own agent', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', agent: CODEX, checker: LOCAL });
    t.work.forRun(plan.home, 'p-me')!.tools!.write(BODY);
    await t.work.verify(plan.id);
    const review = t.plans.need(plan.id).review!;
    expect(t.setAgent).toContainEqual({ id: review.chat!, agent: LOCAL });
  });

  it('a milestone’s check is recorded as the checker’s own agent', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', checker: LOCAL });
    t.work.forRun(plan.home, 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    const chat = await (t.work as unknown as { deps: { controller: WorkspaceController } }).deps.controller.newChat('api', 'Check: Safe payments');
    t.patchWs(chat!.id, { agent: LOCAL } as Partial<Workspace>);
    t.plans.setChecker(plan.id, 'safe', chat!.id);
    t.work.forRun(`ws:${chat!.id}`, 'p-me')!.tools!.gate('safe', 'fail', 'No 401 yet');
    expect(t.plans.need(plan.id).runs.safe!.check!.by).toMatchObject({ kind: 'claude', agent: LOCAL });
  });

  it('Plan with Tasks in a chat that builds with another agent: that agent builds, the chat’s plans it', async () => {
    const t = setup();
    const chat = await (t.work as unknown as { deps: { controller: WorkspaceController } }).deps.controller.newChat('api', 'Ideas');
    t.patchWs(chat!.id, { agent: CLAUDE } as Partial<Workspace>);
    t.store.dispatch({ type: 'build_with', channel: `ws:${chat!.id}`, agent: CODEX });
    const plan = t.work.here(`ws:${chat!.id}`);
    expect(plan).toMatchObject({ agent: CODEX, planner: CLAUDE });
    // Used once: the pick is spent.
    expect(t.store.getState().buildWith).toEqual({});
  });

  it('saves and reads back each part, and lets go of one that doesn’t read', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'plan-roles-'));
    try {
      const t = setup(dir);
      const plan = t.plans.create({ projectId: 'api', home: 'ws:h', agent: CODEX, planner: CLAUDE, checker: LOCAL, fullAuto: true }, { kind: 'beluga' });
      t.plans.flush?.();
      const again = new Plans({ store: new Store(initialState('room')), dir });
      expect(again.need(plan.id)).toMatchObject({ agent: CODEX, planner: CLAUDE, checker: LOCAL, fullAuto: true, autonomy: 'autopilot' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Full Autopilot on a plan (BLG-981)', () => {
  it('runs every milestone on Autopilot, and ends when you pick another way to run', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', autonomy: 'step' });
    t.work.forRun(plan.home, 'p-me')!.tools!.update([{ op: 'retitle', title: 'Payments' }]);
    t.plans.setAutonomy(plan.id, 'gated', { kind: 'beluga' });
    const on = t.work.setFullAuto(plan.id, true);
    expect(on.fullAuto).toBe(true);
    expect(planAutonomy(on)).toBe('autopilot');
    expect(autonomyOf(on, { id: 'm', title: 'M', criteria: [], tasks: [], autonomy: 'step' })).toBe('autopilot');
    const off = t.work.setAutonomy(plan.id, 'gated');
    expect(off.fullAuto).toBeUndefined();
    expect(planAutonomy(off)).toBe('gated');
  });

  it('turning it off keeps Autopilot: only the stand-in stops', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Take payments', fullAuto: true });
    expect(plan).toMatchObject({ fullAuto: true, autonomy: 'autopilot' });
    const off = t.work.setFullAuto(plan.id, false);
    expect(off.fullAuto).toBeUndefined();
    expect(off.autonomy).toBe('autopilot');
  });
});
