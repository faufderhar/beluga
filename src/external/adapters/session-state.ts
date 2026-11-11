import { callNotesToolsOf } from '../../core/calls/launch.js';
import { boardOf } from '../../core/board/registry.js';
import { boardName, reposOf } from '../../core/board/model.js';
import { planTitle } from '../../core/plans/model.js';
import { plansOf } from '../../core/plans/registry.js';
import { sentinelOf } from '../../core/sentinel/registry.js';
import type { Session } from '../../core/session.js';
import type { StatePort } from '../ports/state.js';
import { planChangesOf } from './plan-changes.js';

/** The state port over a daemon's session. Each piece is looked up when it is used: a core with none of them says so. */
export function sessionState(session: Session): StatePort {
  const projects = () => session.store.getState().projects;
  const board = () => boardOf(session) ?? missing('The task board');
  const sentinels = () => sentinelOf(session) ?? missing('Sentinels');
  const plans = () => plansOf(session) ?? missing('Plans');
  const repoName = (id: string): string | undefined => projects().find((p) => p.id === id)?.name;

  return {
    projectName: (idOrName) => projects().find((p) => p.id === idOrName.trim() || p.name.toLowerCase() === idOrName.trim().toLowerCase())?.name,
    callNotes: () => callNotesToolsOf(session),
    // beluga_project_list gives both, and a method tool takes both.
    projectId: (name) => projects().find((p) => p.id === name.trim() || p.name.toLowerCase() === name.trim().toLowerCase())?.id,
    projectIds: () => projects().filter((p) => p.root).map((p) => p.id),
    projectDirs: (id) => {
      const project = projects().find((p) => p.id === id);
      return project ? [project.root, ...project.workspaces.map((w) => w.path)].filter(Boolean) : [];
    },
    task: (key) => {
      const issue = board().board.get(key);
      return issue && !issue.private ? { key: issue.key, projectId: issue.projectId } : undefined;
    },
    boardRepos: (name) => {
      const state = board().board.state();
      const want = name.trim().toLowerCase();
      const ids = Object.keys(state.projects);
      const id = ids.find((x) => boardName(state, x, repoName).toLowerCase() === want) ?? ids.find((x) => state.projects[x]!.prefix.toLowerCase() === want);
      return id === undefined ? undefined : reposOf(state, id);
    },
    sentinel: (ref) => {
      const found = sentinels().get(ref);
      return found && { id: found.id, ...(found.projectId ? { projectId: found.projectId } : {}) };
    },
    dashboard: (ref) => {
      const found = sentinels().dashboards.get(ref);
      return found && { id: found.id };
    },
    plans: () => plans().plans.list().map((p) => ({ id: p.id, projectId: p.projectId, title: planTitle(p), status: p.status })),
    planTaskChat: (planId, task) => plans().taskChat(planId, task),
    board: (agent, visible) => board().toolsForAgent(agent, visible),
    sentinels: (visible) => sentinels().toolsForAgent((s) => visible(s.projectId)).tools,
    dashboards: (visible) => sentinels().toolsForAgent((s) => visible(s.projectId)).dashboard,
    notePlanChange: (planId, agentId) => void planChangesOf(session).add(`${planId} ${agentId}`),
    plan: (planId, agent) => plans().toolsForAgent(planId, agent),
  };
}

function missing(what: string): never {
  throw new Error(`${what} need the Beluga app (its daemon).`);
}
