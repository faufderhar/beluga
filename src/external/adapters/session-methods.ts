import { type DomainState, peerName } from '../../core/store.js';
import { reposOf } from '../../core/board/model.js';
import { boardOf } from '../../core/board/registry.js';
import { plansOf } from '../../core/plans/registry.js';
import type { Session } from '../../core/session.js';
import { HANDLERS } from '../../ipc/handlers.js';
import { post } from '../../ipc/network-handlers.js';
import type { ChatFile } from '../../net/mesh/views.js';
import type { MethodCalls } from '../ports/methods.js';
import { planChangesOf } from './plan-changes.js';
import { sessionState } from './session-state.js';

/** Methods that leave their answer in the state for a screen to draw: a tool hands it on, or it would say only "done". */
const ANSWER_IN_STATE: Readonly<Record<string, (state: DomainState) => unknown>> = {
  'workspaces.review': (state) => state.review,
  'diff.load': (state) => state.review,
  'workbench.search': (state) => state.search,
  'workbench.measureDisk': (state) => state.disk,
};

/** The named methods over a daemon's session: what a screen's call does, after the tool's own gate. */
export function sessionMethods(session: Session): MethodCalls {
  const state = sessionState(session);
  const handlers = HANDLERS as unknown as Record<string, (s: Session, ...args: readonly unknown[]) => unknown>;
  return {
    call: (method, args) => {
      const out = handlers[method]!(session, ...args);
      const read = ANSWER_IN_STATE[method];
      if (read) return Promise.resolve(out).then(() => read(session.store.getState()));
      // A screen hears of a failed commit by a toast. An agent has only this answer.
      if (method === 'workspaces.commit') return Promise.resolve(out).then((committed) => ({ committed: orFailed(committed, 'Beluga could not commit here.') }));
      return out;
    },
    personName: (peerId) => peerName(session.store.getState(), peerId),
    postAs: (conversation, text, via, extras) => post(session, conversation, { text, ...(extras as { files?: readonly ChatFile[]; ask?: 'all' | readonly string[] } | undefined) }, via),
    projectsOf: (kind, id) => {
      if (kind === 'task') {
        const task = state.task(id);
        return task && [task.projectId];
      }
      if (kind === 'plan') {
        const plan = state.plans().find((p) => p.id === id);
        return plan && [plan.projectId];
      }
      if (kind === 'sentinel') {
        const found = state.sentinel(id);
        return found && (found.projectId ? [found.projectId] : []);
      }
      const boards = boardOf(session)?.board.state();
      return boards?.projects[id] ? reposOf(boards, id) : state.boardRepos(id);
    },
    dashboardExists: (id) => Boolean(state.dashboard(id)),
    changedPlan: (planId, agentId) => {
      const home = plansOf(session)?.plans.get(planId)?.home;
      return planChangesOf(session).has(`${planId} ${agentId}`) || (home !== undefined && session.workspaces?.manager.find(home.replace(/^ws:/, ''))?.startedByAgent?.id === agentId);
    },
    channelOfRequest: (requestId) => session.store.getState().log.find((l) => l.type === 'agent' && l.requestId === requestId)?.channel,
  };
}

function orFailed<T>(value: T | undefined, why: string): T {
  if (value === undefined) throw new Error(why);
  return value;
}
