import { readFileSync } from 'node:fs';
import os from 'node:os';
import path, { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { AgentRef } from '../src/protocol.js';
import type { Workspace } from '../src/workspaces/types.js';
import { agentModelItems } from '../packages/mac/src/plans/agent-menu-model.js';
import { keptAgentWords, picksOfPlan, roleChanges, runsChange } from '../packages/mac/src/plans/plan-settings-model.js';
import { waitFor } from './helpers.js';

/** Plan Settings: a plan's agents changed after it's made, with New Plan's own pickers; the header's Agents menu says and picks the same. */

const claude: AgentRef = { runtime: 'claude', label: 'Claude' };
const opus: AgentRef = { runtime: 'claude', label: 'Claude', model: 'opus' };
const codex: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };

describe('a plan’s agents, as the pickers show them', () => {
  it('nothing picked: your agent for every part', () => {
    expect(picksOfPlan({})).toEqual({ planner: '', builder: '', checker: '' });
  });

  it('a builder only: the planner and the checker read as the builder', () => {
    expect(picksOfPlan({ agent: opus })).toEqual({ planner: 'claude:opus', builder: 'claude:opus', checker: 'claude:opus' });
  });

  it('mixed: each part its own runtime and model', () => {
    expect(picksOfPlan({ agent: claude, planner: opus, checker: codex })).toEqual({ planner: 'claude:opus', builder: 'claude:', checker: 'codex:gpt-5.5' });
  });
});

describe('what Save sends', () => {
  it('nothing moved: nothing sent', () => {
    expect(roleChanges({}, {})).toEqual([]);
    expect(roleChanges({ agent: opus, checker: codex }, { agent: { ...opus }, checker: { ...codex } })).toEqual([]);
  });

  it('only the part that moved, with its model', () => {
    expect(roleChanges({ agent: claude }, { agent: claude, checker: codex })).toEqual([['checker', codex]]);
    expect(roleChanges({ agent: claude }, { agent: opus })).toEqual([['builder', opus]]);
  });

  it('a part given back: null (your agent for the builder, the builder for the others)', () => {
    expect(roleChanges({ agent: opus, planner: codex }, {})).toEqual([
      ['builder', null],
      ['planner', null],
    ]);
  });

  it('the builder goes first', () => {
    expect(roleChanges({}, { planner: opus, agent: codex, checker: claude }).map(([role]) => role)).toEqual(['builder', 'planner', 'checker']);
  });
});

describe('the milestones at work keep their agent, said before Save', () => {
  const HAIKU: AgentRef = { runtime: 'claude', label: 'Claude', model: 'claude-haiku-5-5' };
  const SONNET: AgentRef = { runtime: 'claude', label: 'Claude', model: 'claude-sonnet-5-5' };
  it('names the one at work, or counts several, and says how to switch one now', () => {
    expect(keptAgentWords([['builder', HAIKU]], ['H6 盘点'])).toBe('“H6 盘点” is already at work and keeps its agent. To switch it now, pick an agent in its conversation.');
    expect(keptAgentWords([['builder', null]], ['A', 'B'])).toBe('2 milestones already at work keep their agent. To switch one now, pick an agent in its conversation.');
  });
  it('a plan with a worktree per task counts its tasks', () => {
    expect(keptAgentWords([['builder', HAIKU]], ['A', 'B', 'C'], 'task')).toBe('3 tasks already at work keep their agent. To switch one now, pick an agent in its conversation.');
  });
  it('says nothing when the builder stays, or nothing is at work', () => {
    expect(keptAgentWords([['checker', SONNET]], ['A'])).toBeUndefined();
    expect(keptAgentWords([['builder', HAIKU]], [])).toBeUndefined();
  });
  it('the sheet shows it under Agents', () => {
    const sheet = readFileSync(join(import.meta.dirname, '../packages/mac/src/plans/PlanSettingsSheet.tsx'), 'utf8');
    expect(sheet).toMatch(/agentsAtWork\(view\)/);
    expect(sheet).toMatch(/keptAgentWords\(roles, view\.active/);
    expect(sheet.indexOf('{kept}')).toBeGreaterThan(sheet.indexOf('<AgentRoles'));
  });
});

describe('how it runs, as Save sends it (Never wait for me too)', () => {
  it('nothing moved: nothing sent; Never wait for me left on off Autopilot is nothing either', () => {
    expect(runsChange({ autonomy: 'gated', full: false }, { autonomy: 'gated', full: false })).toBeUndefined();
    expect(runsChange({ autonomy: 'autopilot', full: true }, { autonomy: 'autopilot', full: true })).toBeUndefined();
    // The box only counts under Autopilot.
    expect(runsChange({ autonomy: 'gated', full: false }, { autonomy: 'gated', full: true })).toBeUndefined();
  });

  it('turned on: Full Autopilot, from Autopilot or from another way to run', () => {
    expect(runsChange({ autonomy: 'autopilot', full: false }, { autonomy: 'autopilot', full: true })).toEqual({ fullAuto: true });
    expect(runsChange({ autonomy: 'step', full: false }, { autonomy: 'autopilot', full: true })).toEqual({ fullAuto: true });
  });

  it('turned off on Autopilot: it stays on Autopilot, questions come to you again', () => {
    expect(runsChange({ autonomy: 'autopilot', full: true }, { autonomy: 'autopilot', full: false })).toEqual({ fullAuto: false });
  });

  it('another way to run: setAutonomy, which ends Full Autopilot', () => {
    expect(runsChange({ autonomy: 'autopilot', full: true }, { autonomy: 'gated', full: true })).toEqual({ autonomy: 'gated' });
    expect(runsChange({ autonomy: 'step', full: false }, { autonomy: 'autopilot', full: false })).toEqual({ autonomy: 'autopilot' });
  });

  it('the sheet shows the box under Autopilot, and it has its Chinese', () => {
    expect(readFileSync(join('packages', 'mac', 'src', 'plans', 'PlanSettingsSheet.tsx'), 'utf8')).toContain("mode === 'autopilot' ? <FullAutoBox");
    const zh = JSON.parse(readFileSync(join('packages', 'mac', 'src', 'i18n', 'zh-CN.json'), 'utf8')) as Record<string, string>;
    for (const key of ['Never wait for me', 'Never Wait for Me', 'Answer Myself Again']) expect(zh[key], key).toBeTruthy();
  });
});

describe('where it opens from', () => {
  const read = (...parts: string[]): string => readFileSync(join('packages', 'mac', 'src', ...parts), 'utf8');

  it('a plan’s ••• menu has Plan Settings…, and the sheet is drawn', () => {
    expect(read('plans', 'PlanPage.tsx')).toContain("label: 'Plan Settings…', onSelect: () => openSheet({ kind: 'plan_settings', planId: plan.id })");
    expect(read('dialogs', 'native', 'WorkSheets.tsx')).toContain("case 'plan_settings':");
  });

  it('the menu item and the sheet have their Chinese', () => {
    const zh = JSON.parse(read('i18n', 'zh-CN.json')) as Record<string, string>;
    for (const key of ['Plan Settings…', 'Plan Settings', 'Plan settings saved', 'How “{0}” runs and who does each part. Changes apply from now on; work already running keeps its agent.']) expect(zh[key], key).toBeTruthy();
  });
});

/** What a Save in Plan Settings does to the work: what starts next runs the new agent and model; what's at work keeps its own. */
describe('after Save, the work', () => {
  const OPUS: AgentRef = { runtime: 'claude', label: 'Claude', model: 'claude-opus-5-5' };
  const HAIKU: AgentRef = { runtime: 'claude', label: 'Claude', model: 'claude-haiku-5-5' };
  const SONNET: AgentRef = { runtime: 'claude', label: 'Claude', model: 'claude-sonnet-5-5' };
  const BODY: BodyInput = {
    title: 'Sentinel',
    goal: 'A settings page.',
    milestones: [
      { id: 'base', title: 'Base', criteria: ['it loads'], tasks: [{ id: 'a', title: 'Config store' }] },
      { id: 'page', title: 'Page', criteria: ['it draws'], dependsOn: ['base'], tasks: [{ id: 'b', title: 'Settings page' }] },
    ],
  };

  function setup() {
    const store = new Store(initialState('room'));
    const ws = (id: string, name: string, kind: Workspace['kind']): Workspace => ({ id, projectId: 'api', name, path: path.join(os.tmpdir(), name), kind, projectRoot: os.tmpdir(), branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
    const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: [...p.workspaces, w] })) });
    store.dispatch({ type: 'projects', projects: [{ id: 'api', name: 'silk', root: os.tmpdir(), base: 'main', workspaces: [ws('main', 'silk', 'chat')] }] });
    const listeners: Array<(e: WorktreeEvent) => void> = [];
    const worktrees: Array<{ id: string; agent?: AgentRef }> = [];
    const chats: Array<{ id: string; title: string }> = [];
    const agentOf = new Map<string, AgentRef>();
    let n = 0;
    const controller = {
      onWorktree: (l: (e: WorktreeEvent) => void) => {
        listeners.push(l);
        return () => undefined;
      },
      newWorktree: async (_projectId: string, name: string, o: { agent?: AgentRef } = {}) => {
        const w = ws(`w${++n}`, name, 'worktree');
        worktrees.push({ id: w.id, ...(o.agent ? { agent: o.agent } : {}) });
        add(w);
        listeners.forEach((l) => l({ kind: 'created', ws: w }));
        return w;
      },
      newChat: async (_projectId: string, title: string) => {
        const w = ws(`c${++n}`, title, 'chat');
        chats.push({ id: w.id, title });
        add(w);
        return w;
      },
      archive: async () => true,
      manager: { setAgent: (id: string, agent: AgentRef) => void agentOf.set(id, agent), find: () => undefined },
    } as unknown as WorkspaceController;
    const board = new Board({ store, dir: null, projectName: () => 'silk' });
    const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
    const plans = new Plans({ store, dir: null });
    const work = new PlansWork({ store, plans, board: boardWork, controller, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0, workers: 'milestone' });
    const ran = (channel: string, event: 'started' | 'done', requestId: string): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId, requester: 'p-me', event, text: '', ts: Date.now(), channel });
    return { store, board, boardWork, plans, work, worktrees, chats, agentOf, ran };
  }

  it('the next milestone builds on the new model and its check runs on the new checker; the milestone at work keeps its own', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot', agent: OPUS }, t.boardWork.myClaude());
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await waitFor(() => t.worktrees.length === 1);
    expect(t.worktrees[0]!.agent).toEqual(OPUS);
    const atWork = t.plans.need(plan.id).runs.base!.agent!;

    // Save in Plan Settings: planned by Opus, built by Haiku, checked by Sonnet.
    const changes = roleChanges({ agent: OPUS }, { planner: OPUS, agent: HAIKU, checker: SONNET });
    expect(changes).toEqual([
      ['builder', HAIKU],
      ['planner', OPUS],
      ['checker', SONNET],
    ]);
    const said = changes.map(([role, agent]) => t.work.setRoleAgent(plan.id, role, agent));
    expect(said[0]).toBe('Claude (Haiku 5.5) works what starts next; the milestone already at work keeps its agent (to switch it now, pick an agent in its conversation)');
    expect(t.plans.need(plan.id)).toMatchObject({ agent: HAIKU, planner: OPUS, checker: SONNET });
    // The milestone at work keeps its worktree, its agent and its model.
    expect(t.worktrees).toHaveLength(1);
    expect(t.plans.need(plan.id).runs.base!.agent).toEqual(atWork);

    // Its task done: the check starts in a conversation of its own, on the new checker.
    const channel = `ws:${atWork.worktree}`;
    t.ran(channel, 'started', 'r-1');
    const issue = t.store.getState().board.issues.find((i) => i.title === 'Config store')!;
    t.board.update(issue.id, { status: 'in_review' }, t.boardWork.myClaude());
    t.ran(channel, 'done', 'r-1');
    await waitFor(() => t.chats.some((c) => c.title.startsWith('Check:')));
    const check = t.chats.find((c) => c.title.startsWith('Check:'))!;
    expect(t.agentOf.get(check.id)).toEqual(SONNET);

    // It passes: the next milestone starts on the new builder's model.
    await waitFor(() => t.plans.need(plan.id).runs.base?.checker === check.id && t.plans.need(plan.id).runs.base?.checkAsked !== undefined);
    t.work.forRun(`ws:${check.id}`, 'p-me')!.tools!.gate('base', 'pass', 'loads');
    await waitFor(() => t.worktrees.length === 2);
    expect(t.worktrees[1]!.agent).toEqual(HAIKU);
  });
});

describe('the header’s Agents menu', () => {
  it('each part ▸ each agent ▸ its models, the one in use checked; an agent not set up is a plain row', () => {
    const entries = [
      { section: 'Claude', options: [{ value: 'claude:', label: 'Claude' }, { value: 'claude:claude-opus-5-5', label: 'Claude · Opus 5.5' }, { value: 'claude:claude-haiku-5-5', label: 'Claude · Haiku 5.5' }] },
      { section: 'Codex', options: [{ value: 'codex:', label: 'Codex' }] },
      { section: 'OpenCode', options: [{ value: 'opencode:', label: 'OpenCode', disabled: true, description: 'not set up' }] },
    ];
    const picked: string[] = [];
    const items = agentModelItems(entries, { runtime: 'claude', label: 'Claude', model: 'claude-haiku-5-5' }, (v) => void picked.push(v));
    expect(items.map((i) => [i.label, Boolean(i.checked), Boolean(i.disabled), Boolean(i.submenu)])).toEqual([
      ['Claude', true, false, true],
      ['Codex', false, false, false],
      ['OpenCode', false, true, false],
    ]);
    const models = items[0]!.submenu!;
    expect(models.map((m) => [m.label, Boolean(m.checked)])).toEqual([
      ['Default Model', false],
      ['Opus 5.5', false],
      ['Haiku 5.5', true],
    ]);
    models[1]!.onSelect();
    items[1]!.onSelect();
    expect(picked).toEqual(['claude:claude-opus-5-5', 'codex:']);
  });

  it('an agent with no models listed is checked by its runtime, and picking it again keeps its model', () => {
    const entries = [
      { section: 'Claude', options: [{ value: 'claude:', label: 'Claude' }, { value: 'claude:claude-opus-5-5', label: 'Claude · Opus 5.5' }] },
      { section: 'Codex', options: [{ value: 'codex:', label: 'Codex' }] },
    ];
    const picked: string[] = [];
    const rows = agentModelItems(entries, { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' }, (v) => void picked.push(v));
    expect(rows.map((r) => [r.label, Boolean(r.checked)])).toEqual([
      ['Claude', false],
      ['Codex', true],
    ]);
    // Picked again, it keeps its model; an agent not in use is picked on its default.
    rows[1]!.onSelect();
    expect(picked).toEqual(['codex:gpt-5.5']);
    const other = agentModelItems(entries, undefined, (v) => void picked.push(v));
    other[1]!.onSelect();
    expect(picked).toEqual(['codex:gpt-5.5', 'codex:']);
  });

  it('“Default Model” has its Chinese', () => {
    const zh = JSON.parse(readFileSync(join('packages', 'mac', 'src', 'i18n', 'zh-CN.json'), 'utf8')) as Record<string, string>;
    expect(zh['Default Model']).toBe('默认模型');
  });
});
