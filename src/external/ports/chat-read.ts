/**
 * What the read tools see of this Beluga. Reads only, with no attaching as a screen: a screen's
 * welcome sends all state, and a tool should see only what it asked for.
 */

export type ChatKind = 'project' | 'dm' | 'group';

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

export interface ChatRef {
  readonly id: string;
  readonly kind: ChatKind;
  readonly title: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly branch?: string;
  readonly status: 'idle' | 'running' | 'archived';
  readonly lastAt?: number;
  /** Who started it: "you", a friend's name, or an external agent's. */
  readonly createdBy: string;
  /** The agent that started it. Only for scope: a tool's answer does not show it. */
  readonly startedById?: string;
  /** How it came here: Beluga, a friend's handoff, a conversation from outside Beluga, or an external agent (mcp). */
  readonly creationSource: 'beluga' | 'friend' | 'external' | 'network' | 'mcp';
}

/** One message or answer, in order. Its text is unfiltered here: the tools bound and scrub it. */
export interface ChatItem {
  readonly id: string;
  readonly role: 'person' | 'agent' | 'system';
  readonly author: string;
  readonly text: string;
  readonly ts: number;
  /** An agent's answer: its run's state. */
  readonly status?: string;
  /** An agent's answer: its steps in a line each, when it keeps no more. */
  readonly stepLines?: readonly string[];
}

export interface StepLine {
  readonly title: string;
  readonly tool?: string;
  readonly status?: string;
  readonly startedAt?: number;
  readonly durationMs?: number;
}

/** Something waiting on a person. */
export interface NeedRef {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly from?: string;
  /** The chat it holds up, when it holds one up. */
  readonly chatId?: string;
  readonly askedAt?: number;
}

export interface RuntimeRef {
  readonly id: string;
  readonly ready: boolean;
  /** It stops at Beluga's gate before each step: what a run at level ask needs. */
  readonly asksEachStep: boolean;
  readonly models: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export interface ChatRead {
  projects(): readonly ProjectRef[];
  chats(): readonly ChatRef[];
  /** The chat's whole history, oldest first: a position is an index into it, from 1. */
  history(chatId: string): readonly ChatItem[];
  steps(chatId: string, itemId: string): readonly StepLine[] | undefined;
  needs(): readonly NeedRef[];
  runtimes(): Promise<readonly RuntimeRef[]>;
}
