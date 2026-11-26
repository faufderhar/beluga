// The suite never touches the repository it runs in (BLG-867). vitest.config.ts uses this file as the
// first global setup, so it runs before anything else and its changes to process.env reach every worker.
//
// Git hands its own variables (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE…) to whatever it runs: a hook,
// an alias, `git rebase -x 'npx vitest run'`, `git bisect run`. A suite started that way sent every
// fixture's git command to the enclosing repository instead of the fixture: it made the main checkout
// bare and switched a worktree's branch, rewriting its files. They're dropped here, as the daemon and
// the demo do as they start (src/core/git-env.ts).
//
// And a tripwire: the worktree the suite runs in is looked at before and after. Should it be gone (a
// worktree made in another worktree's scratch folder was, twice, with its uncommitted work), or its
// repository made bare, the run fails and says so, instead of the loss going unnoticed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Git's own list of the variables it sets for what it runs (`git rev-parse --local-env-vars`). */
export function gitLocalEnvNames() {
  try {
    return execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Drop git's own variables from `env` → the names that were set. */
export function dropGitEnv(env = process.env, names = gitLocalEnvNames()) {
  const dropped = names.filter((name) => env[name] !== undefined);
  for (const name of dropped) delete env[name];
  return dropped;
}

const gitOut = (cwd, args, env) => {
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

/** The worktree `dir` is in: its folder, its git folder, and whether its repository is bare. Undefined outside git. */
export function repoSnapshot(dir, env = process.env) {
  const top = gitOut(dir, ['rev-parse', '--show-toplevel'], env);
  const gitDir = gitOut(dir, ['rev-parse', '--absolute-git-dir'], env);
  if (!top || !gitDir) return undefined;
  // Git says C:/Users/… on Windows: in the computer's own form, as every other path here is.
  return { top: path.resolve(top), gitDir: path.resolve(gitDir), bare: gitOut(dir, ['config', '--bool', 'core.bare'], env) === 'true' };
}

/** What happened to the worktree since `before` (nothing: []). */
export function repoDamage(before, env = process.env) {
  if (!before) return [];
  const problems = [];
  if (!existsSync(before.top)) problems.push(`the worktree it ran in is gone: ${before.top}`);
  if (!existsSync(before.gitDir)) problems.push(`its git folder is gone (git no longer lists it): ${before.gitDir}`);
  if (problems.length) return problems;
  if (!before.bare && repoSnapshot(before.top, env)?.bare) problems.push(`its repository was made bare: ${before.top}`);
  return problems;
}

export default function setup() {
  dropGitEnv();
  const before = repoSnapshot(process.cwd());
  return () => {
    const problems = repoDamage(before);
    if (!problems.length) return;
    console.error(`\nThe test run damaged the repository it runs in (BLG-867):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exitCode = 1;
  };
}
