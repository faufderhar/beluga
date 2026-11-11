import { z } from 'zod';
import { ToolRefusal } from '../../domain/decide.js';
import { reachesProject, type Grant } from '../../domain/grant.js';
import type { ChatControl, RunSnapshot, WorkspaceStrategy } from '../../ports/chat-control.js';
import type { ChatRead } from '../../ports/chat-read.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { DATA_NOTICE, chatInScope, untrusted } from './read.js';

/**
 * The tools that start and steer work, with T3's send and wait rules. An acknowledgement is never a
 * final status: only beluga_chat_wait says how a run ended.
 */

const MESSAGE_MAX = 60_000;
const NAME_MAX = 80;
const QUESTION_MAX = 1000;
const WAIT_DEFAULT_MS = 30_000;
const WAIT_MAX_MS = 120_000;
const WAIT_POLL_MS = 200;
const RETRIES_KEPT = 500;

const clientRequestId = z.string().min(1).max(128).optional().describe('The same id on a retry returns the first result and starts no new work.');
/** A launch with no project, until the chat exists: not a `chat:` target, as there is no chat to show on its card. */
const STANDALONE_TARGET = 'new_chat';
const FINAL: ReadonlySet<RunSnapshot['status']> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export function controlTools(reads: ChatRead, control: ChatControl, opts: { readonly waitPollMs?: number } = {}): ExternalToolDef[] {
  const retries = new Map<string, Promise<unknown>>();
  /** Runs once for one client request id. A failure is not kept: it may be tried again. */
  const once = (tool: string, grant: Grant, id: unknown, work: () => Promise<unknown>): Promise<unknown> => {
    if (typeof id !== 'string') return work();
    const key = `${grant.id} ${tool} ${id}`;
    const known = retries.get(key);
    if (known) return known;
    const started = work();
    retries.set(key, started);
    if (retries.size > RETRIES_KEPT) retries.delete(retries.keys().next().value!);
    started.catch(() => retries.delete(key));
    return started;
  };
  const agent = (grant: Grant) => ({ id: grant.id, name: grant.name });
  /** A chat this tool acts on. Foreign: this agent didn't start it, and its level then decides what a call needs. */
  const chatTarget = (id: unknown, grant: Grant, writes: boolean): Resolved => {
    const chat = reads.chats().find((c) => c.id === id);
    if (!chat) return { denial: 'not_found', message: 'No such chat.' };
    if (writes && chat.kind !== 'project') return { denial: 'not_sendable', message: 'This chat is not one an agent can work in.' };
    if (writes && chat.status === 'archived') return { denial: 'not_sendable', message: 'This chat is archived.' };
    return { target: `chat:${chat.id}`, inScope: chatInScope(chat, grant), ...(writes && control.startedBy(chat.id) !== grant.id ? { foreign: true } : {}) };
  };

  return [
    {
      name: 'beluga_chat_launch',
      description: 'Start work: a new chat in the project folder (root), a new worktree (worktree, optional baseRef), or a message in a worktree that exists (existing_worktree with chat). With no project: a new chat like the sidebar\'s New chat, in a folder of its own, and the strategy must be root or absent. This needs no project on the grant. This agent reaches the chats it started this way. It reaches other chats with no project only when the grant names \'chats\'. Modes inherit. A workspace does not. The result acknowledges the launch; use beluga_chat_wait for how it ends.',
      inputSchema: {
        project: z.string().max(200).optional(),
        message: z.string().min(1).max(MESSAGE_MAX),
        workspaceStrategy: z.enum(['root', 'worktree', 'existing_worktree']).optional(),
        baseRef: z.string().max(200).optional(),
        chat: z.string().max(300).optional(),
        model: z.string().max(100).optional(),
        agent: z.string().max(40).optional().describe('A runtime from beluga_capabilities.'),
        clientRequestId,
      },
      resolve: (args, grant) => {
        if (args.project === undefined) {
          if (args.workspaceStrategy && args.workspaceStrategy !== 'root') return { denial: 'invalid_request', message: 'A worktree needs a project. With no project, leave out workspaceStrategy or use root.' };
          return { target: STANDALONE_TARGET, inScope: true, detail: 'A new chat with no project, in a folder of its own.' };
        }
        const project = reads.projects().find((p) => p.id === args.project || p.name === args.project);
        if (!project) return { denial: 'not_found', message: 'No such project.' };
        if (!reachesProject(grant, project.id)) return { target: `project:${project.id}`, inScope: false };
        if (args.workspaceStrategy !== 'existing_worktree') return { target: `project:${project.id}`, inScope: true };
        const chat = reads.chats().find((c) => c.id === args.chat && c.projectId === project.id);
        if (!chat) return { denial: 'not_found', message: 'No such chat in that project.' };
        return chatTarget(chat.id, grant, true);
      },
      run: (args, grant) =>
        once('launch', grant, args.clientRequestId, () => {
          const project = reads.projects().find((p) => p.id === args.project || p.name === args.project);
          return control.launch({
            by: agent(grant),
            ...(project ? { projectId: project.id } : {}),
            message: args.message as string,
            strategy: (args.workspaceStrategy as WorkspaceStrategy | undefined) ?? (project ? 'worktree' : 'root'),
            ...(args.baseRef ? { baseRef: args.baseRef as string } : {}),
            ...(args.chat ? { chatId: args.chat as string } : {}),
            ...(args.model ? { model: args.model as string } : {}),
            ...(args.agent ? { runtime: args.agent as string } : {}),
          });
        }),
      auditTarget: (result, args) => (args.project === undefined ? `chat:${(result as { chatId: string }).chatId}` : undefined),
    },
    {
      name: 'beluga_chat_send',
      description: 'Send a message in a chat. Mode auto goes in now or waits its turn; queue waits its turn; steer goes into this agent\'s running turn, and else waits its turn; restart stops this agent\'s own current run and goes first. On a run that this agent did not ask for, restart returns not_interruptible and posts nothing. The result has delivery: started, queued, steered or restarted.',
      inputSchema: {
        chat: z.string().max(300),
        message: z.string().min(1).max(MESSAGE_MAX),
        mode: z.enum(['auto', 'queue', 'steer', 'restart']).optional(),
        clientRequestId,
      },
      resolve: (args, grant) => chatTarget(args.chat, grant, true),
      run: (args, grant) => once('send', grant, args.clientRequestId, () => control.send({ by: agent(grant), chatId: args.chat as string, message: args.message as string, mode: (args.mode as 'auto' | 'queue' | 'steer' | 'restart' | undefined) ?? 'auto' })),
    },
    {
      name: 'beluga_chat_wait',
      description: 'Wait for a run. It ends on completed, failed, cancelled or interrupted, or on a pending question or approval. A pending approval is for a person: no tool answers it. A timeout does not cancel the work: call this again.',
      inputSchema: { chat: z.string().max(300), runId: z.string().max(256).optional(), timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).optional() },
      resolve: (args, grant) => chatTarget(args.chat, grant, false),
      run: async (args) => {
        const deadline = Date.now() + ((args.timeoutMs as number | undefined) ?? WAIT_DEFAULT_MS);
        for (;;) {
          const now = control.run(args.chat as string, args.runId as string | undefined);
          const ended = FINAL.has(now.status) || now.status === 'idle';
          if (ended || now.hasPendingQuestion || now.pendingApproval) return waitView(now, false);
          if (Date.now() >= deadline) return waitView(now, true);
          await new Promise((r) => setTimeout(r, opts.waitPollMs ?? WAIT_POLL_MS));
        }
      },
    },
    {
      name: 'beluga_chat_interrupt',
      description: 'Stop the work this agent asked for in a chat: its current run and its queued messages. Waiting cards of that run are declined. No tool can say yes to a card. On a run that this agent did not ask for, only its own queued messages go, and the result is not_interruptible: the run, its cards and its questions stay. The result is an acknowledgement, not a final status: use beluga_chat_wait. The status no_active_run says nothing was running.',
      inputSchema: { chat: z.string().max(300) },
      resolve: (args, grant) => chatTarget(args.chat, grant, true),
      run: (args, grant) => {
        const done = control.interrupt(agent(grant), args.chat as string);
        if (done === 'not_yours') throw new ToolRefusal('not_interruptible', 'The run in this chat is not one this agent asked for, so it cannot stop it. Its own queued messages there are gone.');
        return { status: done === 'stopped' ? 'interrupt_requested' : 'no_active_run', terminal: false };
      },
    },
    {
      name: 'beluga_chat_update',
      description: 'Rename a chat. Settle, snooze and PR links are not available in this Beluga yet.',
      inputSchema: { chat: z.string().max(300), name: z.string().min(1).max(NAME_MAX) },
      resolve: (args, grant) => chatTarget(args.chat, grant, true),
      run: async (args) => {
        await control.rename(args.chat as string, args.name as string);
        return { chat: args.chat, name: untrusted(args.name as string, NAME_MAX) };
      },
    },
    {
      name: 'beluga_question_answer',
      description: 'List, read or answer questions from runs this agent started. It cannot answer an approval, and it cannot approve a plan: those are for a person.',
      inputSchema: {
        action: z.enum(['list', 'read', 'respond']),
        question: z.string().max(256).optional(),
        answers: z.record(z.string().max(QUESTION_MAX), z.string().max(4000)).optional().describe('With respond: the answer to each question, by its text.'),
      },
      resolve: (args, grant) => {
        if (args.action === 'list') return { target: '', inScope: true };
        const found = control.questions(grant.id).find((q) => q.id === args.question);
        if (!found) return { denial: 'not_found', message: 'No such question from a run of this agent.' };
        if (args.action === 'respond' && !args.answers) return { denial: 'invalid_request', message: 'Respond needs answers.' };
        return { target: `question:${found.id}`, inScope: true };
      },
      run: (args, grant) => {
        const open = control.questions(grant.id);
        if (args.action === 'list') return { notice: DATA_NOTICE, questions: open.map(questionView) };
        if (args.action === 'read') return { notice: DATA_NOTICE, question: questionView(open.find((q) => q.id === args.question)!) };
        if (!control.answerQuestion(grant.id, args.question as string, args.answers as Record<string, string>)) throw new Error('That question is not open any more.');
        return { answered: true, terminal: false };
      },
    },
  ];
}

/** `timedOut`: the run goes on. Nothing here gives authority over an approval. */
function waitView(now: RunSnapshot, timedOut: boolean): Record<string, unknown> {
  return {
    status: now.status,
    terminal: FINAL.has(now.status),
    timedOut,
    ...(now.runId ? { runId: now.runId } : {}),
    hasPendingQuestion: now.hasPendingQuestion,
    ...(now.pendingApproval ? { pendingApproval: { ...now.pendingApproval, grantsAuthority: false, answeredBy: 'a person, in Beluga' } } : {}),
    ...(now.text !== undefined ? { notice: DATA_NOTICE, text: untrusted(now.text, 8000) } : {}),
  };
}

const questionView = (q: ReturnType<ChatControl['questions']>[number]) => ({
  id: q.id,
  chat: q.chatId,
  runId: q.runId,
  questions: q.questions.map((x) => ({ question: untrusted(x.question, QUESTION_MAX), header: untrusted(x.header, 40), options: x.options.map((o) => untrusted(o, 200)), multiSelect: x.multiSelect })),
});
