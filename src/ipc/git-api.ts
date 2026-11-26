import { z } from 'zod';

/**
 * Git for the Mac app's project home and History (see api.ts): keeping the main folder current
 * (fetch, Update main and its fallbacks, Claude's sync run), a project's GitHub repository, and
 * reading history. Browser-safe: zod only.
 */

const id = z.string().min(1).max(200);
const name = z.string().max(200);
const hash = z.string().regex(/^[0-9a-f]{4,64}$/i);
const LogOptions = z
  .object({
    branch: z.string().min(1).max(250).optional(),
    author: z.string().max(200).optional(),
    path: z.string().max(1000).optional(),
    before: z.string().regex(/^\d{1,7}$/).optional(),
    limit: z.number().int().min(1).max(300).optional(),
  })
  .strict();

export const GIT_API = {
  // Fetch the project's remote now (a toast if it fails) → { ok, reason?, message? }.
  'git.fetch': { args: z.tuple([id]) },
  // Opening a project's home: fetch quietly if the last fetch is a few minutes old → the same, or undefined (fresh enough).
  'git.fetchIfStale': { args: z.tuple([id]) },
  // Update main: fetch and fast-forward the default branch → what happened (updated, dirty, diverged…).
  'git.updateMain': { args: z.tuple([id]) },
  // Push main: the default branch's own commits (Straight to main's) go to its remote, on top of anything new there, never forced → PushMainOutcome. A project id or one of its worktrees'.
  'git.pushMain': { args: z.tuple([id]) },
  // Uncommitted changes in the way: stash, update, put them back → the outcome, plus restored / conflicts.
  'git.stashAndUpdate': { args: z.tuple([id]) },
  // Or move them to a new worktree first, then update → { wsId, outcome }.
  'git.moveAndUpdate': { args: z.tuple([id, name.optional()]) },
  // The main folder is on another branch: back to the default one (clean, carrying changes, or moving the branch to a worktree).
  'git.switchToDefault': { args: z.tuple([id, z.enum(['clean', 'stash', 'move'])]) },
  // Let Claude handle it: a main-folder conversation whose run may sync git → its workspace id.
  'git.askClaude': { args: z.tuple([id, z.string().max(2000).optional()]) },
  // Sync fork (origin is a GitHub fork): GitHub brings the original's new commits into the fork's default branch, then Update main → { kind: synced (how, update) | conflict | failed }.
  'git.syncFork': { args: z.tuple([id]) },
  // Sync fork stopped on conflicts: a worktree where your agent merges the original in and opens a PR into the fork → its workspace id.
  'git.syncForkWithClaude': { args: z.tuple([id, z.string().max(2000).optional()]) },
  // The project's GitHub repository and what gh says about it (cached an hour; true: ask again).
  'git.github': { args: z.tuple([id, z.boolean().optional()]) },
  // Just the project's GitHub page, from its remote (no gh, no network) → { host, owner, repo, url } or undefined.
  'git.githubRepo': { args: z.tuple([id]) },
  // History of a project (its main folder) or a worktree: a page of commits for the graph → { commits, next? }.
  'git.log': { args: z.tuple([id, LogOptions.optional()]) },
  // Before merging a worktree: where it goes, its commits and files, and what would stop it → MergePreview.
  'git.mergePreview': { args: z.tuple([id]) },
  // One commit: message, files with +/− and their diffs.
  'git.commit': { args: z.tuple([id, hash]) },
  // History's filter choices: branches, tags, recent authors, what's checked out.
  'git.filters': { args: z.tuple([id]) },
  // Start a worktree from a commit (on a new beluga/<name> branch) → its workspace id; it opens.
  'git.worktreeAt': { args: z.tuple([id, hash, name.optional()]) },
} as const;
