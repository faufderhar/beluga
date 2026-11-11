import { z } from 'zod';
import { createBoardToolDefs } from '../../../agent/board-tools.js';
import { createCallNotesToolDefs } from '../../../agent/call-notes-tools.js';
import { createDashboardToolDefs } from '../../../agent/dashboard-tools.js';
import { createPlanToolDefs } from '../../../agent/plan-tools.js';
import { createSentinelToolDefs } from '../../../agent/sentinel-tools.js';
import type { BoardTools, CallNotesTools, DashboardTools, PlanTools, SentinelTools } from '../../../agent/types.js';
import { isSecretPath } from '../../../core/shares.js';
import { ToolRefusal } from '../../domain/decide.js';
import { reachedProjects, reachesProject, type Grant } from '../../domain/grant.js';
import type { AgentId, ChatControl } from '../../ports/chat-control.js';
import type { StatePort } from '../../ports/state.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { type Run, adapt, call, isInside } from './adapt.js';
import { DATA_NOTICE, untrusted } from './read.js';

/**
 * The board, sentinel, dashboard and plan tools your own agent has, for an external agent: the same
 * definitions, with a named target instead of "this conversation", the agent as actor, and its
 * grant's projects as the limit. plan_gate stays with a plan's checker. No tool here approves a plan
 * or turns a sentinel on. A message to a plan's task goes through the chat port, so it runs as you on
 * another screen: under the agent's grant, with its label.
 */

const CARD_DETAIL_MAX = 1000;

const TASK_KEY = z.string().min(2).max(40).describe('The task\'s key, like BOB-12.');
const PLAN_ID = z.string().min(1).max(80).describe('The plan\'s id, from plan_list.');

type Args = Record<string, unknown>;

export function stateTools(port: StatePort, control: ChatControl): ExternalToolDef[] {
  const agent = (grant: Grant): AgentId => ({ id: grant.id, name: grant.name });
  const has = (grant: Grant) => (projectId: string | undefined): boolean => (projectId === undefined ? grant.projects === 'all' : reachesProject(grant, projectId));

  const nothing: Resolved = { target: '', inScope: true };
  const notFound = (what: string): Resolved => ({ denial: 'not_found', message: `No such ${what}.` });

  const taskTarget = (key: unknown, grant: Grant): Resolved => {
    const task = port.task(String(key));
    return task ? { target: `task:${task.key}`, inScope: has(grant)(task.projectId) } : notFound('task');
  };
  /** A target, and whether each other thing the call names is in scope too. */
  const also = (first: Resolved, ...others: readonly boolean[]): Resolved => ('denial' in first ? first : { ...first, inScope: first.inScope && others.every(Boolean) });
  const named = (name: unknown, grant: Grant): boolean => has(grant)(port.projectId(String(name)));
  const sentinelTarget = (ref: unknown, grant: Grant): Resolved => {
    const found = port.sentinel(String(ref));
    return found ? { target: `sentinel:${found.id}`, inScope: has(grant)(found.projectId) } : notFound('sentinel');
  };
  const sentinelOk = (ref: unknown, grant: Grant): boolean => has(grant)(port.sentinel(String(ref))?.projectId);
  const dashboardTarget = (ref: unknown): Resolved => {
    const found = port.dashboard(String(ref));
    return found ? { target: `dashboard:${found.id}`, inScope: true } : notFound('dashboard');
  };
  /** The sentinels a tile names: a tile can't show what this agent can't read. */
  const tileTarget = (args: Args, grant: Grant): Resolved =>
    also(dashboardTarget(args.dashboard), ...(args.sentinel ? [sentinelOk(args.sentinel, grant)] : []), ...((args.metrics as readonly { sentinel: string }[] | undefined) ?? []).map((m) => sentinelOk(m.sentinel, grant)));
  const planTarget = (id: unknown, grant: Grant): Resolved => {
    const plan = port.plans().find((p) => p.id === id);
    return plan ? { target: `plan:${plan.id}`, inScope: has(grant)(plan.projectId) } : notFound('plan');
  };

  const taskCreate = (args: Args, grant: Grant): Resolved => {
    const parent = args.parent ? port.task(String(args.parent)) : undefined;
    if (args.parent && !parent) return notFound('parent task');
    const projectId = args.project ? port.projectId(String(args.project)) : parent?.projectId;
    if (args.project && !projectId) return notFound('project');
    if (!projectId) return { denial: 'invalid_request', message: 'Name the project it runs in, or a parent task.' };
    const blockers = ((args.blocked_by as readonly string[] | undefined) ?? []).map((k) => port.task(k));
    if (blockers.includes(undefined)) return notFound('task to wait on');
    const repos = args.board ? port.boardRepos(String(args.board)) : undefined;
    if (args.board && !repos) return notFound('board');
    // Beluga widens a board for your own agent. An agent's task goes only where its board already reaches.
    if (repos && !repos.includes(projectId)) return { denial: 'project_denied', message: 'That board does not cover that project.' };
    return { target: `project:${projectId}`, inScope: has(grant)(projectId) && has(grant)(parent?.projectId ?? projectId) && blockers.every((b) => has(grant)(b?.projectId)) };
  };

  const proofTarget = (args: Args, grant: Grant): Resolved => {
    const target = taskTarget(args.key, grant);
    if ('denial' in target || typeof args.path !== 'string') return target;
    if (isSecretPath(args.path)) return { denial: 'capability_denied', message: 'That file holds secrets.' };
    return also(target, reachedProjects(grant, port.projectIds()).some((id) => port.projectDirs(id).some((dir) => isInside(args.path as string, dir))));
  };

  const tryTarget = (args: Args, grant: Grant): Resolved => {
    const source = args.source as Record<string, unknown>;
    if ([source.path, source.file].some((p) => typeof p === 'string' && isSecretPath(p))) return { denial: 'capability_denied', message: 'That file holds secrets.' };
    const projectId = args.project ? port.projectId(String(args.project)) : undefined;
    if (args.project && !projectId) return notFound('project');
    // No project: Your Mac's variables and folder, which no grant holds.
    return { target: projectId ? `project:${projectId}` : '', inScope: has(grant)(projectId), detail: `It wants to read this source: ${JSON.stringify(untrusted(JSON.stringify(source), CARD_DETAIL_MAX).text)}` };
  };

  const boardDefs = createBoardToolDefs({} as BoardTools); // Only names and schemas: each call makes its own, for its agent.
  const sentinelDefs = createSentinelToolDefs({} as SentinelTools);
  const dashboardDefs = createDashboardToolDefs({} as DashboardTools);
  const callNoteDefs = createCallNotesToolDefs({} as CallNotesTools);
  const planDefs = createPlanToolDefs({} as PlanTools);

  // The board goes by a repo's name, and an agent may give its id.
  const runBoard: Run = (def, args, grant) => call(createBoardToolDefs(port.board(agent(grant), has(grant))), def.name, typeof args.project === 'string' ? { ...args, project: port.projectName(args.project) ?? args.project } : args);
  const runSentinel: Run = (def, args, grant) => call(createSentinelToolDefs(port.sentinels(has(grant))), def.name, args);
  const runCallNotes: Run = (def, args) => {
    const notes = port.callNotes();
    if (!notes) throw new Error('This Beluga has no call notes.');
    return call(createCallNotesToolDefs(notes), def.name, args);
  };
  const callNotesTarget = (_args: Args, grant: Grant): Resolved => ({ target: '', inScope: grant.chats.dms && grant.chats.groups });
  const runDashboard: Run = (def, args, grant) => call(createDashboardToolDefs(port.dashboards(has(grant))), def.name, args);
  const runPlan: Run = (def, { plan, ...rest }, grant) => {
    if (def.name === 'plan_write' || def.name === 'plan_update') port.notePlanChange(String(plan), grant.id);
    return call(createPlanToolDefs(port.plan(String(plan), agent(grant))), def.name, rest);
  };

  const keyed = { key: TASK_KEY };
  const onPlan = { plan: PLAN_ID };

  /** A plan's started task, as the chat it works in. Whether this agent started that chat decides what it may do there. */
  const planTaskTarget = (args: Args, grant: Grant): Resolved => {
    const plan = planTarget(args.plan, grant);
    if ('denial' in plan || !plan.inScope) return plan;
    const chat = port.planTaskChat(String(args.plan), String(args.task));
    if (!chat) return notFound('started task in this plan');
    return { target: `chat:${chat}`, inScope: true, ...(control.startedBy(chat) !== grant.id ? { foreign: true } : {}) };
  };

  return [
    ...adapt(boardDefs, runBoard, [
      { name: 'task_get', shape: keyed, resolve: (a, g) => taskTarget(a.key, g) },
      { name: 'task_list', resolve: () => nothing, extra: ' It shows only tasks in the projects this agent reaches.' },
      { name: 'task_create', drop: ['private'], resolve: taskCreate, extra: ' Name the project, or a parent task.' },
      { name: 'board_create', resolve: (a, g) => ((a.repos as readonly string[]).every((r) => named(r, g)) ? nothing : { target: '', inScope: false }) },
      { name: 'task_update', shape: keyed, resolve: (a, g) => also(taskTarget(a.key, g), ...(a.project ? [named(a.project, g)] : [])) },
      { name: 'task_brief_edit', shape: keyed, resolve: (a, g) => taskTarget(a.key, g) },
      { name: 'task_note', shape: keyed, resolve: (a, g) => taskTarget(a.key, g) },
      { name: 'task_relate', shape: keyed, resolve: (a, g) => {
        const other = taskTarget(a.other, g);
        return 'denial' in other ? other : also(taskTarget(a.key, g), other.inScope);
      } },
      { name: 'task_attach_proof', shape: keyed, resolve: proofTarget, extra: ' A file must be in a project this agent reaches.' },
    ]),
    ...adapt(sentinelDefs, runSentinel, [
      { name: 'sentinel_list', resolve: () => nothing, extra: ' It shows only sentinels in the projects this agent reaches.' },
      { name: 'sentinel_get', resolve: (a, g) => sentinelTarget(a.id, g) },
      { name: 'sentinel_create', resolve: (a, g) => (a.project && !port.projectId(String(a.project)) ? notFound('project') : { target: a.project ? `project:${port.projectId(String(a.project))!}` : '', inScope: Boolean(a.project) && named(a.project, g), ...askEachTime(g) }), extra: ' An external agent must name a project it reaches.' },
      { name: 'sentinel_run', resolve: (a, g) => sentinelTarget(a.id, g) },
      { name: 'sentinel_test', resolve: (a, g) => sentinelTarget(a.id, g) },
      { name: 'sentinel_try_source', resolve: tryTarget, extra: ' An external agent must name a project it reaches.' },
      // project null moves it to Your Mac, which no grant holds.
      { name: 'sentinel_update', resolve: (a, g) => withAsk(also(sentinelTarget(a.id, g), ...(a.project !== undefined ? [a.project !== null && named(a.project, g)] : [])), g) },
      { name: 'sentinel_pause', resolve: (a, g) => sentinelTarget(a.id, g) },
      { name: 'sentinel_delete_runs', resolve: (a, g) => sentinelTarget(a.id, g) },
      { name: 'sentinel_remove', resolve: (a, g) => sentinelTarget(a.id, g) },
    ]),
    // What was said in every call you were in: only for a grant that reaches all your chats.
    ...adapt(callNoteDefs, runCallNotes, [
      { name: 'call_notes_list', resolve: callNotesTarget },
      { name: 'call_notes_search', resolve: callNotesTarget },
      { name: 'call_notes_read', resolve: callNotesTarget },
    ]),
    ...adapt(dashboardDefs, runDashboard, [
      { name: 'dashboard_list', resolve: () => nothing },
      { name: 'dashboard_create', resolve: () => nothing },
      { name: 'dashboard_update', resolve: (a) => dashboardTarget(a.dashboard) },
      { name: 'dashboard_remove', resolve: (a) => dashboardTarget(a.dashboard) },
      { name: 'dashboard_add_tile', resolve: tileTarget },
      { name: 'dashboard_update_tile', resolve: tileTarget },
      { name: 'dashboard_move_tile', resolve: (a) => dashboardTarget(a.dashboard) },
      { name: 'dashboard_remove_tile', resolve: (a) => dashboardTarget(a.dashboard) },
      { name: 'metric_list', resolve: () => nothing, extra: ' It shows only sentinels in the projects this agent reaches.' },
      { name: 'metric_read', resolve: (a, g) => sentinelTarget(a.sentinel, g) },
    ]),
    {
      name: 'plan_list',
      description: 'The plans in the projects this agent reaches: id, title and status. The other plan tools take that id.',
      inputSchema: {},
      resolve: () => nothing,
      run: (_args, grant) => ({ notice: DATA_NOTICE, plans: port.plans().filter((p) => has(grant)(p.projectId)).map((p) => ({ id: p.id, project: p.projectId, status: p.status, title: untrusted(p.title, 200) })) }),
    },
    ...adapt(planDefs, runPlan, [
      { name: 'plan_get', shape: onPlan, resolve: (a, g) => planTarget(a.plan, g) },
      { name: 'plan_write', shape: onPlan, resolve: (a, g) => planTarget(a.plan, g), extra: ' A person approves it. No tool can.' },
      { name: 'plan_update', shape: onPlan, resolve: (a, g) => planTarget(a.plan, g), extra: ' From an external agent they always wait for a person to approve them, also on autopilot.' },
      { name: 'plan_start_task', shape: onPlan, resolve: (a, g) => planTarget(a.plan, g) },
      { name: 'plan_pause', shape: onPlan, resolve: (a, g) => (a.paused === false ? { denial: 'needs_person', message: 'Only a person resumes a plan.' } : planTarget(a.plan, g)), extra: ' An external agent can only pause: paused false is refused.' },
    ]),
    {
      name: 'plan_message_task',
      description: 'Send a message to the chat of a started task in a plan. It runs as this agent, labeled with its name. mode queue (default) waits for its turn. steer goes into this agent\'s running turn, and else waits its turn.',
      inputSchema: { ...onPlan, task: z.string().min(1).max(40).describe('Its id in the plan, or its board key'), text: z.string().min(1).max(8000), mode: z.enum(['queue', 'steer']).optional() },
      resolve: planTaskTarget,
      run: (args, grant) => control.send({ by: agent(grant), chatId: String(port.planTaskChat(String(args.plan), String(args.task))), message: args.text as string, mode: (args.mode as 'queue' | 'steer' | undefined) ?? 'queue' }),
    },
    {
      name: 'plan_stop_task',
      description: 'Stop the work this agent asked for on a started task of a plan: its current run and its queued messages. A run that this agent did not ask for is not_interruptible: a person stops it.',
      inputSchema: { ...onPlan, task: z.string().min(1).max(40).describe('Its id in the plan, or its board key') },
      resolve: planTaskTarget,
      run: (args, grant) => {
        const done = control.interrupt(agent(grant), String(port.planTaskChat(String(args.plan), String(args.task))));
        if (done === 'not_yours') throw new ToolRefusal('not_interruptible', 'The run on this task is not one this agent asked for, so it cannot stop it. Its own queued messages there are gone.');
        return { status: done === 'stopped' ? 'interrupt_requested' : 'no_active_run', terminal: false };
      },
    },
  ];
}

/** Below full a sentinel's sources and steps get a card each time: an Always would approve a script nobody has read. */
const askEachTime = (grant: Grant): { mustAsk?: true } => (grant.level === 'full' ? {} : { mustAsk: true });
const withAsk = (resolved: Resolved, grant: Grant): Resolved => ('denial' in resolved ? resolved : { ...resolved, ...askEachTime(grant) });
