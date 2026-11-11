/**
 * The variables git sets for the commands it runs (`git rev-parse --local-env-vars`): they point
 * every git command at one repository, whatever folder it's run in. Beluga started from inside git
 * (a hook, an alias, `git bisect run`) would inherit them, and its own git commands (a worktree, the
 * demo's `git init --bare`) would land in that repository instead: one made it bare. Dropped once at
 * start, so Beluga's git always works where it's pointed.
 */
export const GIT_LOCAL_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  // Git before 2.40 (Debian 12's 2.39, say) still lists it.
  'GIT_INTERNAL_SUPER_PREFIX',
] as const;

/** Drop them from `env` (this process's own, by default: everything it starts inherits it) → the ones that were set. */
export function dropGitLocalEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped = GIT_LOCAL_ENV.filter((k) => env[k] !== undefined);
  for (const k of dropped) delete env[k];
  return dropped;
}
