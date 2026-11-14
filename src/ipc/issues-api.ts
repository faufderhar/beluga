import { z } from 'zod';

/**
 * A project's GitHub issues in the API (see api.ts): the Mac app's Issues view and issue pages.
 * Reading goes through gh; working on one goes through a task on the board (core/issues).
 * Browser-safe: zod only.
 */

const projectId = z.string().min(1).max(200);
const number = z.number().int().positive().max(10_000_000);
/** What you add for Claude ("it only fails behind the proxy"). */
const note = z.string().max(4000).optional();
/** A teammate on the same repository is already on it: start anyway (asked first otherwise). */
const anyway = z.boolean().optional();

export const ISSUES_API = {
  /** A project's issues: open or closed, a GitHub search, `force` to ask GitHub again. */
  'issues.list': { args: z.tuple([projectId, z.object({ state: z.enum(['open', 'closed']).optional(), search: z.string().max(200).optional(), force: z.boolean().optional() }).strict().optional()]) },
  /** A project's open pull requests (anyone's, newest activity first), `force` to ask GitHub again. */
  'issues.pulls': { args: z.tuple([projectId, z.object({ force: z.boolean().optional() }).strict().optional()]) },
  /** An open pull request in a worktree on its branch (`id`: the one a screen shows as being made already, BLG-942; the one already there opens): → the worktree's id. */
  'issues.openPull': { args: z.tuple([projectId, number, z.object({ id: z.string().regex(/^wt-[0-9a-f-]{12}$/).optional() }).strict().optional()]) },
  /** One issue in full, with its comments. */
  'issues.get': { args: z.tuple([projectId, number, z.object({ force: z.boolean().optional() }).strict().optional()]) },
  /** Claude finds out why it happens and reproduces it, in the issue's task's worktree, without fixing it. */
  'issues.investigate': { args: z.tuple([projectId, number, z.object({ note, anyway }).strict().optional()]) },
  /** Claude fixes it and opens a pull request that closes it (after an investigation: in the same worktree). */
  'issues.fix': { args: z.tuple([projectId, number, z.object({ note, anyway }).strict().optional()]) },
  /** On the board as a task Claude writes from it (`look`: after a quick read-only look at the code). */
  'issues.toTask': { args: z.tuple([projectId, number, z.object({ look: z.boolean().optional(), note }).strict().optional()]) },
  /** A comment on the issue, as you. */
  'issues.comment': { args: z.tuple([projectId, number, z.string().min(1).max(60_000)]) },
} as const;
