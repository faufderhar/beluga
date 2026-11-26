// Types for scripts/test-repo-guard.mjs (used by vitest.config.ts and the tests).

export interface RepoSnapshot {
  readonly top: string;
  readonly gitDir: string;
  readonly bare: boolean;
}

/** Git's own list of the variables it sets for what it runs (`git rev-parse --local-env-vars`). */
export function gitLocalEnvNames(): string[];
/** Drop git's own variables from `env` → the names that were set. */
export function dropGitEnv(env?: Record<string, string | undefined>, names?: readonly string[]): string[];
/** The worktree `dir` is in: its folder, its git folder, and whether its repository is bare. Undefined outside git. */
export function repoSnapshot(dir: string, env?: Record<string, string | undefined>): RepoSnapshot | undefined;
/** What happened to the worktree since `before` (nothing: []). */
export function repoDamage(before: RepoSnapshot | undefined, env?: Record<string, string | undefined>): string[];
export default function setup(): () => void;
