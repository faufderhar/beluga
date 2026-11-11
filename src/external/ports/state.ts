import type { BoardTools, CallNotesTools, DashboardTools, PlanTools, SentinelTools } from '../../agent/types.js';
import type { AgentId } from './chat-control.js';

/**
 * What the board, sentinel, dashboard and plan tools may reach. The look-ups say what a call touches,
 * so its grant can decide before anything runs. There is no way here to approve a plan or to turn a
 * sentinel on.
 */

export interface PlanRef {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
}

export interface StatePort {
  /** A project by its name, as the tools below find it. */
  projectId(name: string): string | undefined;
  projectName(idOrName: string): string | undefined;
  /** The folders of a project: its main folder and its worktrees. */
  /** The projects that exist now: what a grant for all of them reaches. */
  projectIds(): readonly string[];
  projectDirs(projectId: string): readonly string[];
  /** A task an agent can see. A private task is not one. */
  task(key: string): { readonly key: string; readonly projectId: string } | undefined;
  /** The repos of a board, by its name or key prefix. */
  boardRepos(name: string): readonly string[] | undefined;
  sentinel(ref: string): { readonly id: string; readonly projectId?: string } | undefined;
  dashboard(ref: string): { readonly id: string } | undefined;
  plans(): readonly PlanRef[];
  /** The chat of a plan's started task. */
  planTaskChat(planId: string, task: string): string | undefined;

  callNotes(): CallNotesTools | undefined;
  board(agent: AgentId, visible: (projectId: string) => boolean): BoardTools;
  sentinels(visible: (projectId: string | undefined) => boolean): SentinelTools;
  dashboards(visible: (projectId: string | undefined) => boolean): DashboardTools;
  /** This agent changed this plan: it may not pass that plan's milestones. */
  notePlanChange(planId: string, agentId: string): void;
  /** One plan's tools. Its changes stay a draft for a person. */
  plan(planId: string, agent: AgentId): PlanTools;
}
