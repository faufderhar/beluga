import type { Method } from '../../ipc/api.js';
import type { MessageVia } from '../../protocol.js';

/**
 * What a method tool calls. Each tool names one method in its own row (adapters/tools/method-tool.ts),
 * with its own schema, class and scope: a client never chooses the method.
 */
export interface MethodCalls {
  call(method: Method, args: readonly unknown[]): unknown;
  /** A person's name, as a card says it. */
  personName(peerId: string): string;
  /** Write in a conversation as you, with the agent's name on the message. */
  postAs(conversation: string, text: string, via: MessageVia, extras?: { readonly files?: unknown; readonly ask?: unknown }): unknown;
  /** The projects a thing is in: empty for one in no project, undefined when there is no such thing. */
  projectsOf(kind: 'task' | 'plan' | 'sentinel' | 'board', id: string): readonly string[] | undefined;
  dashboardExists(id: string): boolean;
  /** This agent started this plan or changed it, so it may not check its own work. */
  changedPlan(planId: string, agentId: string): boolean;
  /** The conversation a queued or running request is in, when it is still known. */
  channelOfRequest(requestId: string): string | undefined;
}
