import { randomUUID } from 'node:crypto';
import { slugify } from '../../agent/namer.js';
import type { ExternalSendMode } from '../../core/agent-host.js';
import type { Session } from '../../core/session.js';
import type { LogItem } from '../../core/store.js';
import { externalRequester } from '../../core/trust.js';
import { ToolRefusal } from '../domain/decide.js';
import { STANDALONE_CHATS } from '../domain/grant.js';
import { needAllowedRuntime } from './runs.js';
import type { AgentId, ChatControl, QuestionRef, RunReceipt, RunSnapshot } from '../ports/chat-control.js';

const WS_PREFIX = 'ws:';
const RUNS_KEPT = 1000;
const NOT_YOURS = 'The run in this chat is not one this agent asked for, so it cannot stop it.';

/** The control port over a daemon's session. Each run goes as `ext:<grant id>`: its own grant and name. */
export function sessionControl(session: Session, opts: { readonly runCap?: (agentId: string) => number } = {}): ChatControl {
  /** Which agent started each run, for the questions it may answer. */
  const runsBy = new Map<string, string>();
  /** Where each agent has worked since Beluga started: its first time in a project is worth telling you. */
  const usedProjects = new Set<string>();
  const channelOf = (chatId: string): string => `${WS_PREFIX}${chatId}`;

  /** Nothing is made or posted for a grant that has ended, card or no card. */
  const needLive = (by: AgentId): void => {
    if (session.host.externalLevel(externalRequester(by.id)) === 'blocked') throw new ToolRefusal('grant_gone', "This agent's grant has ended.");
  };

  const deliver = (by: AgentId, chatId: string, message: string, mode: ExternalSendMode): RunReceipt => {
    needLive(by);
    const channel = channelOf(chatId);
    needAllowedRuntime(session.host.externalLevel(externalRequester(by.id)), session.workspaces?.agentIn(channel)?.runtime ?? session.agentRef.runtime);
    // A new run past the cap. A message into a chat where its run goes already starts none.
    const cap = opts.runCap?.(by.id);
    const running = cap === undefined ? [] : session.host.externalRunChannels(externalRequester(by.id));
    if (cap !== undefined && running.length >= cap && !running.includes(channel)) throw new ToolRefusal('rate_limited', `This agent has ${running.length} runs going, and that is its limit. Wait for one to end.`);
    // Before anything is posted: a refused restart leaves no message behind.
    if (mode === 'restart' && !session.host.mayRestartExternal(externalRequester(by.id), channel)) throw new ToolRefusal('not_interruptible', NOT_YOURS);
    const runId = randomUUID();
    session.workspaces?.ensureLoaded(chatId);
    session.sendChat(message, false, channel, runId, mode === 'steer' && session.host.runningIn(channel), false, { id: by.id, name: by.name, creationSource: 'mcp' });
    const delivery = session.host.runExternal(externalRequester(by.id), channel, message, { requestId: runId, mode });
    if (delivery === 'denied') throw new Error('Beluga could not take this message now.');
    if (delivery === 'not_interruptible') throw new ToolRefusal('not_interruptible', NOT_YOURS);
    runsBy.set(runId, by.id);
    if (runsBy.size > RUNS_KEPT) runsBy.delete(runsBy.keys().next().value!);
    return { runId, delivery };
  };

  const open = (): readonly QuestionRef[] =>
    session.store.getState().questions.flatMap((q) => (q.question.kind === 'question' && q.channel.startsWith(WS_PREFIX) ? [{
      id: q.qid,
      chatId: q.channel.slice(WS_PREFIX.length),
      runId: q.requestId,
      questions: q.question.questions.map((x) => ({ question: x.question, header: x.header, options: x.options.map((o) => o.label), multiSelect: x.multiSelect })),
    }] : []));

  return {
    launch: async ({ by, projectId = STANDALONE_CHATS, message, strategy, baseRef, name, chatId, model, runtime }) => {
      const ctl = session.workspaces;
      if (!ctl) throw new Error('This Beluga has no projects.');
      needLive(by);
      // A chat that exists is checked in deliver, on the runtime it has.
      if (strategy !== 'existing_worktree') needAllowedRuntime(session.host.externalLevel(externalRequester(by.id)), runtime ?? session.agentRef.runtime);
      if (!usedProjects.has(`${by.id} ${projectId}`)) {
        usedProjects.add(`${by.id} ${projectId}`);
        const project = session.store.getState().projects.find((p) => p.id === projectId);
        session.toast(projectId === STANDALONE_CHATS ? `${by.name} started a chat` : `${by.name} is working in ${project?.name ?? 'a project'} for the first time`, 'info');
      }
      if (runtime && !session.runsAgent({ runtime, label: runtime })) throw new Error('That agent does not run on this computer.');
      const agent = runtime ? { runtime, label: runtime } : undefined;
      const made = strategy === 'existing_worktree'
        ? undefined
        : strategy === 'root'
          ? await ctl.newChat(projectId, message.replace(/\s+/g, ' ').trim().slice(0, 40), undefined, { quiet: true })
          : await ctl.startWorktree(projectId, '', async () => 'worktree', { name: slugify(name ?? message), quiet: true, ...(baseRef ? { base: baseRef } : {}), ...(agent ? { agent } : {}) });
      const id = made?.id ?? (strategy === 'existing_worktree' ? chatId : undefined);
      if (!id) throw new Error('Beluga could not start this chat.');
      if (made) {
        ctl.manager.setStartedBy(id, { id: by.id, name: by.name });
        if (agent && strategy === 'root') ctl.manager.setAgent(id, agent);
        if (model) ctl.manager.setModel(id, model);
        await ctl.refresh();
      }
      return { chatId: id, ...deliver(by, id, message, 'auto') };
    },
    send: async ({ by, chatId, message, mode }) => deliver(by, chatId, message, mode),
    run: (chatId, runId) => snapshot(session, channelOf(chatId), runId),
    interrupt: (by, chatId) => session.host.interruptExternal(externalRequester(by.id), channelOf(chatId)),
    rename: (chatId, name) => session.workspaces?.renameChat(chatId, name) ?? Promise.resolve(),
    startedBy: (chatId) => session.workspaces?.manager.find(chatId)?.startedByAgent?.id,
    questions: (agentId) => open().filter((q) => runsBy.get(q.runId) === agentId),
    answerQuestion: (agentId, questionId, answers) => {
      const question = open().find((q) => q.id === questionId && runsBy.get(q.runId) === agentId);
      if (!question) return false;
      session.questions.answer(question.id, { kind: 'answers', answers: { ...answers } });
      return true;
    },
  };
}

function snapshot(session: Session, channel: string, runId?: string): RunSnapshot {
  const state = session.store.getState();
  const runs = state.log.filter((l): l is Extract<LogItem, { type: 'agent' }> => l.type === 'agent' && l.channel === channel);
  const run = runId ? runs.find((r) => r.requestId === runId) : runs.at(-1);
  const status = run ? statusOf(run) : 'idle';
  const final = status !== 'queued' && status !== 'running';
  const approval = final ? undefined : state.approvals.find((a) => a.channel === channel);
  return {
    ...(run ? { runId: run.requestId } : {}),
    status,
    ...(run && final ? { text: run.text } : {}),
    hasPendingQuestion: !final && state.questions.some((q) => q.channel === channel && (!run || q.requestId === run.requestId)),
    ...(approval ? { pendingApproval: { id: approval.id, kind: approval.kind, ...(run ? { runId: run.requestId } : {}) } } : {}),
  };
}

/** A run's card in terms an agent can act on. The words come from the host's own reasons. */
function statusOf(run: Extract<LogItem, { type: 'agent' }>): RunSnapshot['status'] {
  switch (run.status) {
    case 'done':
      return 'completed';
    case 'denied':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'error':
      if (/^Interrupted/.test(run.text)) return 'interrupted';
      return /^(Stopped by|Cancelled|Taken out)/.test(run.text) ? 'cancelled' : 'failed';
    case 'queued':
      return 'queued';
    default:
      return 'running';
  }
}
