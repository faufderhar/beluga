import type { RoomBridge, SetupTools } from '../../agent/types.js';
import type { AgentId } from './chat-control.js';

/**
 * How an agent reaches people: your own agent's bridge, bound to this agent's own place. What it
 * sends carries its name, and every gate on the way still holds.
 */
export interface PeersPort {
  /** The room and gateway tools as this agent. `projectId`: where a report it writes goes. */
  bridge(agent: AgentId, projectId?: string): RoomBridge;
  /** Which agent sent a task. Undefined: none, or no such task. */
  taskSender(taskId: string): string | undefined;
  /** Its result is a secret its owner approved. It stays with you. */
  taskHoldsSecret(taskId: string): boolean;
  /** A project by its name, as the tools find it. */
  projectId(name: string): string | undefined;
  /** The projects that exist now: what a grant for all of them reaches. */
  projectIds(): readonly string[];
  projectDirs(projectId: string): readonly string[];
  /** The worktree's project, and its tool to change that project's setup. Undefined: no such worktree. */
  setup(worktree: string): { readonly projectId: string; readonly tools: SetupTools } | undefined;
}
