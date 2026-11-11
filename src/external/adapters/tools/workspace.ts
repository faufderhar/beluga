import { z } from 'zod';
import { createMacToolDefs } from '../../../agent/mac-tools.js';
import { createPhoneToolDefs } from '../../../agent/phone-tools.js';
import type { MacTools, PhoneTools } from '../../../agent/types.js';
import { isSecretPath } from '../../../core/shares.js';
import { ToolRefusal } from '../../domain/decide.js';
import { reachesProject, type Grant } from '../../domain/grant.js';
import type { AgentId, ChatControl } from '../../ports/chat-control.js';
import type { ChatRead } from '../../ports/chat-read.js';
import type { WorkspacePort } from '../../ports/workspace.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { type Run, adapt, call } from './adapt.js';
import { DATA_NOTICE, chatInScope, untrusted } from './read.js';

/**
 * An agent runs the worktree life cycle, and looks at this Mac and the phone. Starting work runs as
 * the agent: its worktree, its task's first message, and its plan's draft are its own.
 */

const MESSAGE_MAX = 16_000;
const NAME_MAX = 200;
const PHONE_ACTS = ['phone_tap', 'phone_swipe', 'phone_type', 'phone_key', 'phone_scroll', 'phone_open', 'phone_install', 'phone_setup_link', 'phone_shell', 'phone_logcat', 'phone_push', 'phone_pull', 'phone_macro_save', 'phone_macro_list', 'phone_macro_run', 'phone_macro_delete'] as const;

export function workspaceTools(reads: ChatRead, port: WorkspacePort, control: ChatControl): ExternalToolDef[] {
  const agent = (grant: Grant): AgentId => ({ id: grant.id, name: grant.name });
  const has = (grant: Grant, projectId: string): boolean => reachesProject(grant, projectId);
  const nothing: Resolved = { target: '', inScope: true };

  const projectOf = (name: unknown) => reads.projects().find((p) => p.id === name || p.name === name);
  const projectTarget = (name: unknown, grant: Grant): Resolved => {
    const project = projectOf(name);
    return project ? { target: `project:${project.id}`, inScope: has(grant, project.id) } : { denial: 'not_found', message: 'No such project.' };
  };
  const worktreeTarget = (ref: unknown, grant: Grant, wants: 'open' | 'archived'): Resolved => {
    const found = port.worktree(String(ref));
    if (!found) return { denial: 'not_found', message: 'No such worktree.' };
    if (found.archived !== (wants === 'archived')) return { denial: 'invalid_request', message: wants === 'archived' ? 'This worktree is not archived.' : 'This worktree is archived.' };
    const busy = reads.chats().find((c) => c.id === found.id)?.status === 'running';
    return { target: `chat:${found.id}`, inScope: has(grant, found.projectId), detail: `Worktree ${untrusted(found.name, NAME_MAX).text}${busy ? ': an agent works there now, and this stops it.' : '.'}` };
  };

  const macDefs = createMacToolDefs({} as MacTools); // Only names and schemas: each call makes its own.
  const phoneDefs = createPhoneToolDefs({} as PhoneTools);
  const runMac: Run = (def, args) => call(createMacToolDefs(port.mac()), def.name, args);
  const runPhone: Run = (def, args) => {
    const phone = port.phone();
    if (!phone) throw new ToolRefusal('not_found', 'No phone is set up.');
    return call(createPhoneToolDefs(phone), def.name, args);
  };
  /** Acting follows the phone's own setting, as your own run does (agent-host.ts authorizeTool). A file of yours that goes to the phone is checked as any send. */
  const phoneAct = (args: Record<string, unknown>): Resolved => {
    const opened = phoneOn();
    if ('denial' in opened) return opened;
    if (typeof args.path === 'string' && isSecretPath(args.path)) return { denial: 'capability_denied', message: 'That file holds secrets.' };
    return { ...nothing, ...(port.phoneUse() === 'ask' ? { mustAsk: true, detail: 'Your phone is set to ask before each action.' } : {}) };
  };
  /** Off is your choice for agents: looking stops too. */
  const phoneOn = (): Resolved => (port.phoneOff() ? { denial: 'needs_person', message: 'The phone is off for agents. A person turns it on.' } : nothing);

  return [
    {
      name: 'list_work',
      description: 'The projects this agent reaches, with their worktrees and chats: id, title, branch, status (idle, running or archived).',
      inputSchema: {},
      resolve: () => nothing,
      run: (_args, grant) => ({
        notice: DATA_NOTICE,
        projects: reads.projects().filter((p) => has(grant, p.id)).map((p) => ({
          id: p.id,
          name: p.name,
          work: reads.chats().filter((c) => c.projectId === p.id && chatInScope(c, grant)).map((c) => ({ id: c.id, title: untrusted(c.title, NAME_MAX), status: c.status, ...(c.branch ? { branch: c.branch } : {}) })),
        })),
      }),
    },
    {
      name: 'start_worktree',
      description: 'Start a new worktree in a project, a branch and folder of its own, with an agent working on your message as this agent. The result acknowledges the start: use beluga_chat_wait for how it ends.',
      inputSchema: {
        project: z.string().max(200),
        message: z.string().min(1).max(MESSAGE_MAX).describe('The first message: the task, complete and self-contained.'),
        name: z.string().min(1).max(60).optional().describe('A short branch-style name. Left out, the message names it.'),
        baseRef: z.string().max(200).optional(),
      },
      resolve: (args, grant) => projectTarget(args.project, grant),
      run: (args, grant) =>
        control.launch({
          by: agent(grant),
          projectId: projectOf(args.project)!.id,
          message: args.message as string,
          strategy: 'worktree',
          ...(args.name ? { name: args.name as string } : {}),
          ...(args.baseRef ? { baseRef: args.baseRef as string } : {}),
        }),
    },
    {
      name: 'start_task',
      description: 'Start a task from the board: a worktree of its own, with an agent carrying it through as this agent. The result acknowledges the start: use beluga_chat_wait for how it ends.',
      inputSchema: { key: z.string().min(2).max(40).describe('The task\'s key, like BOB-12.') },
      resolve: (args, grant) => {
        const task = port.task(String(args.key));
        return task ? { target: `task:${task.key}`, inScope: has(grant, task.projectId) } : { denial: 'not_found', message: 'No such task.' };
      },
      run: async (args, grant) => {
        const by = agent(grant);
        const { chatId, message } = await port.startTask(String(args.key), by);
        return { chatId, ...(await control.send({ by, chatId, message, mode: 'auto' })) };
      },
    },
    {
      name: 'start_plan',
      description: 'Start a plan in a project: a draft and a conversation of its own. No agent runs. Write its milestones and tasks with plan_write. A person approves it, and no tool can.',
      inputSchema: { project: z.string().max(200), goal: z.string().min(1).max(8000) },
      resolve: (args, grant) => projectTarget(args.project, grant),
      run: async (args, grant) => ({ plan: (await port.startPlan(projectOf(args.project)!.id, args.goal as string, agent(grant))).id }),
    },
    {
      name: 'archive_worktree',
      description: 'Archive a worktree: its branch, conversation and uncommitted work are kept, and restore_worktree brings it back. A person is asked each time. An agent working there stops.',
      inputSchema: { worktree: z.string().max(300).describe('Its id, from list_work.') },
      resolve: (args, grant) => worktreeTarget(args.worktree, grant, 'open'),
      run: async (args) => {
        if (!(await port.archive(String(args.worktree)))) throw new Error('Beluga could not archive it. It stays as it was.');
        return { archived: true };
      },
    },
    {
      name: 'restore_worktree',
      description: 'Bring back an archived worktree, with its branch and conversation.',
      inputSchema: { worktree: z.string().max(300).describe('Its id, from list_work.') },
      resolve: (args, grant) => worktreeTarget(args.worktree, grant, 'archived'),
      run: async (args) => {
        if (!(await port.restore(String(args.worktree)))) throw new Error('Beluga could not restore it.');
        return { restored: true };
      },
    },
    {
      name: 'merge_worktree',
      description: 'Merge a worktree\'s branch into its project\'s main folder. A person is asked each time. The result says merged, or why not: dirty, conflict or wrong_branch.',
      inputSchema: { worktree: z.string().max(300).describe('Its id, from list_work.') },
      resolve: (args, grant) => worktreeTarget(args.worktree, grant, 'open'),
      run: async (args) => {
        const result = await port.merge(String(args.worktree));
        if (!result) throw new Error('Beluga could not merge it.');
        return result;
      },
    },
    ...adapt(macDefs, runMac, [
      { name: 'screenshot', resolve: () => ({ ...nothing, detail: 'It can show other apps on this Mac.' }) },
      { name: 'device_info', resolve: () => nothing },
    ]),
    ...adapt(phoneDefs, runPhone, [
      { name: 'phone_status', resolve: () => nothing },
      { name: 'phone_screenshot', resolve: phoneOn },
      { name: 'phone_screen', resolve: phoneOn },
      { name: 'phone_apps', resolve: phoneOn },
      { name: 'phone_info', resolve: phoneOn },
      { name: 'phone_notifications', resolve: phoneOn },
      ...PHONE_ACTS.map((name) => ({ name, resolve: phoneAct })),
    ]),
  ];
}
