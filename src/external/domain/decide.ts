/**
 * What an external agent (you on another screen, with its own grant) may do: one pure function from an
 * operation and its grant to allow, ask, ask-once or deny. No I/O here, and no caller yet.
 */

export const LEVELS = ['blocked', 'ask', 'trusted', 'full'] as const;
export type Level = (typeof LEVELS)[number];

export const ROUTES = ['local', 'remote'] as const;
export type Route = (typeof ROUTES)[number];

export const OPERATION_CLASSES = [
  /** Chats, board, status. */
  'read',
  /** Stop or interrupt work this agent started. */
  'stop_own',
  /** Launch a chat, or send in one. */
  'launch_or_send',
  /** A file step in its run, inside shared folders. */
  'file_inside',
  /** A file step outside shared folders, or a shell command in its run. */
  'file_outside_or_shell',
  /** A change to a file that runs code later. */
  'writes_code',
  /** Board, sentinel create or update, dashboard, plan. */
  'state_write',
  /** A request to a person or their agent, or a message that other people read. */
  'reach_people',
  /** Delete or archive (sentinel, dashboard, runs, worktree), merge. */
  'destructive',
  /** What was only a person's: one card at every level (BLG-244). */
  'gated',
  /** .env, keys. */
  'secret_file',
  /** Never exposed: answering approvals, a grant, secret values, signing in, pairing a phone in hand. */
  'human_only',
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/** ask: the owner sees a card. ask-once: the same card, with no Always. */
export const OUTCOMES = ['allow', 'ask', 'ask-once', 'deny'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DENIALS = ['capability_denied', 'level_denied', 'project_denied', 'needs_person', 'declined', 'not_found', 'not_sendable', 'not_interruptible', 'invalid_request', 'grant_gone', 'rate_limited', 'grant_suspended', 'waiting_for_owner'] as const;
export type Denial = (typeof DENIALS)[number];

/** A tool or its port refuses for a reason the client should read by name. */
export class ToolRefusal extends Error {
  constructor(readonly denial: Denial, message: string) {
    super(message);
  }
}

export type Decision = { readonly outcome: Exclude<Outcome, 'deny'> } | { readonly outcome: 'deny'; readonly denial: Denial };

export interface DecideInput {
  readonly operation: OperationClass;
  readonly level: Level;
  /** The project or chat it touches is one the grant covers. */
  readonly inScope: boolean;
}

const TABLE: Readonly<Record<OperationClass, Readonly<Record<Level, Outcome>>>> = {
  read: { blocked: 'deny', ask: 'ask', trusted: 'allow', full: 'allow' },
  stop_own: { blocked: 'deny', ask: 'allow', trusted: 'allow', full: 'allow' },
  launch_or_send: { blocked: 'deny', ask: 'ask', trusted: 'allow', full: 'allow' },
  file_inside: { blocked: 'deny', ask: 'ask', trusted: 'allow', full: 'allow' },
  file_outside_or_shell: { blocked: 'deny', ask: 'ask', trusted: 'ask', full: 'allow' },
  writes_code: { blocked: 'deny', ask: 'ask-once', trusted: 'ask-once', full: 'allow' },
  state_write: { blocked: 'deny', ask: 'ask', trusted: 'ask', full: 'allow' },
  reach_people: { blocked: 'deny', ask: 'ask', trusted: 'ask', full: 'allow' },
  destructive: { blocked: 'deny', ask: 'ask-once', trusted: 'ask-once', full: 'ask-once' },
  // What was only a person's until the owner chose a card for each (BLG-244): one card, at every level.
  gated: { blocked: 'deny', ask: 'ask-once', trusted: 'ask-once', full: 'ask-once' },
  secret_file: { blocked: 'deny', ask: 'deny', trusted: 'deny', full: 'deny' },
  human_only: { blocked: 'deny', ask: 'deny', trusted: 'deny', full: 'deny' },
};

/** Why a class is denied whatever the level; anything else is denied by its level. */
const CLASS_DENIAL: Partial<Readonly<Record<OperationClass, Denial>>> = { secret_file: 'capability_denied', human_only: 'needs_person' };

/** The same table on every route: what a route may hold is settled when a grant is made (canHold). */
export function decide({ operation, level, inScope }: DecideInput): Decision {
  const outcome = TABLE[operation][level];
  if (outcome === 'deny') return deny(CLASS_DENIAL[operation] ?? 'level_denied');
  return inScope ? { outcome } : deny('project_denied');
}

/** A remote grant holds full only by the explicit choice its code carried. A file edited by hand has no such choice. */
export function canHold(route: Route, level: Level, allowRemoteFull = false): boolean {
  return route === 'local' || level !== 'full' || allowRemoteFull;
}

const deny = (denial: Denial): Decision => ({ outcome: 'deny', denial });
