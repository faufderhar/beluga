import type { MacTools, PhoneTools } from '../../agent/types.js';
import type { AgentId } from './chat-control.js';

/**
 * The worktree life cycle, and looking at this Mac and the phone. A task or plan started here runs
 * nothing as you: a task's first message goes through the chat port, and an agent writes its own plan.
 */

export interface WorktreeRef {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly archived: boolean;
}

export type MergeOutcome = { readonly merged: true } | { readonly merged: false; readonly reason: string; readonly files: readonly string[] };

export interface WorkspacePort {
  /** A worktree, archived or not. Not a chat, and not a main folder. */
  worktree(ref: string): WorktreeRef | undefined;
  /** A task an agent can see, by its key. */
  task(key: string): { readonly key: string; readonly projectId: string } | undefined;
  /** Makes the task's worktree, marked as this agent's. → its chat and what its first message says. */
  startTask(key: string, by: AgentId): Promise<{ readonly chatId: string; readonly message: string }>;
  /** A plan with no run: the agent writes its draft. */
  startPlan(projectId: string, goal: string, by: AgentId): Promise<{ readonly id: string }>;
  archive(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
  merge(id: string): Promise<MergeOutcome | undefined>;
  mac(): MacTools;
  /** Undefined: no phone is set up. */
  phone(): PhoneTools | undefined;
  /** You turned the phone off for agents. */
  phoneOff(): boolean;
  /** The phone's own setting for agents and your runs. */
  phoneUse(): 'off' | 'ask' | 'use' | 'full';
}
