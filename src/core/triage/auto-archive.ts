import type { DomainState } from '../store.js';
import { triageFacts } from './facts.js';
import { triageKey } from './model.js';

/**
 * Which of your chats archive by themselves now: settled for more than `archiveSettledDays` days
 * (0: never). Only your own chats and worktrees: a friend's chat isn't yours to put away, and a
 * plan's row follows its plan. A running turn waits. It reads only state, like autoSettle.
 */

const DAY_MS = 86_400_000;

/** The workspace ids to archive. */
export function autoArchive(state: DomainState, now: number): readonly string[] {
  const days = state.prefs.archiveSettledDays;
  if (!state.prefs.chatCategories || days <= 0) return [];
  const limit = days * DAY_MS;
  return Object.entries(state.triage)
    .filter(([key, record]) => record.settled !== undefined && now - record.settled.at > limit && isOwn(state, key) && !triageFacts(state, key).working)
    .map(([key]) => key.slice(3));
}

const isOwn = (state: DomainState, key: string): boolean => key.startsWith('ws:') && triageKey(state, key) === key && state.projects.some((p) => p.workspaces.some((w) => `ws:${w.id}` === key));
