import type { ExternalDelivery, ExternalInterrupt, ExternalSendMode } from '../../core/agent-host.js';

/**
 * What the control tools may do to this Beluga. It has no way to answer an approval, change trust or
 * read a secret: a tool can only do what this port offers.
 */

export type WorkspaceStrategy = 'root' | 'worktree' | 'existing_worktree';

export interface AgentId {
  readonly id: string;
  readonly name: string;
}

export interface LaunchRequest {
  readonly by: AgentId;
  /** Left out: a chat with no project, in a folder of its own. There is no way to name another folder. */
  readonly projectId?: string;
  readonly message: string;
  readonly strategy: WorkspaceStrategy;
  readonly baseRef?: string;
  /** A short name for a new worktree. Left out, the message names it. */
  readonly name?: string;
  /** With existing_worktree: the chat to go on in. */
  readonly chatId?: string;
  readonly model?: string;
  /** A runtime this computer has. */
  readonly runtime?: string;
}

export interface SendRequest {
  readonly by: AgentId;
  readonly chatId: string;
  readonly message: string;
  readonly mode: ExternalSendMode;
}

export interface RunReceipt {
  readonly runId: string;
  /** How the message went in. It says nothing of how the run ends. */
  readonly delivery: Exclude<ExternalDelivery, 'denied' | 'not_interruptible'>;
}

/** Tells an agent that a person must act. It grants no authority: nothing an agent calls answers it. */
export interface PendingApproval {
  readonly id: string;
  readonly kind: string;
  readonly runId?: string;
}

export type RunStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunSnapshot {
  readonly runId?: string;
  readonly status: RunStatus;
  readonly text?: string;
  readonly hasPendingQuestion: boolean;
  readonly pendingApproval?: PendingApproval;
}

export interface QuestionRef {
  readonly id: string;
  readonly chatId: string;
  readonly runId: string;
  /** The questions the run asks, with their choices, in the run's own words. */
  readonly questions: ReadonlyArray<{ readonly question: string; readonly header: string; readonly options: readonly string[]; readonly multiSelect: boolean }>;
}

export interface ChatControl {
  launch(request: LaunchRequest): Promise<RunReceipt & { readonly chatId: string }>;
  send(request: SendRequest): Promise<RunReceipt>;
  run(chatId: string, runId?: string): RunSnapshot;
  /** Stops only this agent's own work there. */
  interrupt(by: AgentId, chatId: string): ExternalInterrupt;
  rename(chatId: string, name: string): Promise<void>;
  /** The agent that started this chat: undefined for one a person started. */
  startedBy(chatId: string): string | undefined;
  /** Open questions from the runs this agent started. A plan to approve is the owner's and is not here. */
  questions(agentId: string): readonly QuestionRef[];
  answerQuestion(agentId: string, questionId: string, answers: Readonly<Record<string, string>>): boolean;
}
