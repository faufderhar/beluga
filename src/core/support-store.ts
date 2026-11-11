/**
 * Supporting Beluga, in the shared state: how many worktrees Beluga made have been merged (here,
 * through a GitHub pull request, or by git some other way), and whether the one ask is due now: a
 * star on GitHub after the third merge, once. Beluga never asks for money. The record itself (which
 * branches counted, what you answered) is kept in ~/.beluga/support.json (core/merge-counter.ts).
 * Browser-safe: the Mac app runs it.
 */

export type SupportAsk = 'star';
/** `yes`: opened the GitHub page to star it; `later`: Maybe Later or closed; `never`: kept for old records. */
export type SupportAnswer = 'yes' | 'later' | 'never';

/** The merge that asks for a star: the third, once you've seen Beluga's work land a few times. */
export const STAR_AT = 3;

/** An ask you answered: at how many merges, and how. */
export interface Answered {
  readonly merges: number;
  readonly answer: SupportAnswer;
  /** How many times it was shown. */
  readonly times: number;
  readonly at: number;
}

/** What support.json holds. */
export interface SupportRecord {
  /** Merged branches already counted, as `<project folder>#<branch>`: each counts once. */
  readonly counted: readonly string[];
  readonly star?: Answered;
}

export const EMPTY_SUPPORT: SupportRecord = { counted: [] };

/** One merged branch's key in `counted`. */
export const mergeKey = (root: string, branch: string): string => `${root}#${branch}`;

/** The ask due now, if any: the star, from the third merge until it's answered. */
export function dueAsk(record: SupportRecord): SupportAsk | undefined {
  return !record.star && record.counted.length >= STAR_AT ? 'star' : undefined;
}

/** The record after you answered an ask (`now`: epoch ms). */
export function answerAsk(record: SupportRecord, ask: SupportAsk, answer: SupportAnswer, now: number): SupportRecord {
  const before = record[ask];
  return { ...record, [ask]: { merges: record.counted.length, answer, times: (before?.times ?? 0) + 1, at: now } };
}

/** What screens see. */
export interface SupportView {
  /** Worktrees Beluga made that ended up merged. */
  readonly merges: number;
  /** The ask to show now. */
  readonly due?: SupportAsk;
  readonly starShown: boolean;
  /** How many people starred Beluga on GitHub, when the daemon could find out (once a day). */
  readonly stars?: number;
}

export const supportView = (record: SupportRecord, stars?: number): SupportView => {
  const due = dueAsk(record);
  return { merges: record.counted.length, ...(due ? { due } : {}), starShown: Boolean(record.star), ...(stars === undefined ? {} : { stars }) };
};

export interface SupportSlice {
  readonly support: SupportView;
}

export const initialSupport: SupportSlice = { support: { merges: 0, starShown: false } };

export type SupportAction = { type: 'support'; support: SupportView };
