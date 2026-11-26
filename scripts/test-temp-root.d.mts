// Types for scripts/test-temp-root.mjs (used by vitest.config.ts and the tests).


/** Remove the run folders in `base` whose run has ended (`isAlive` says whether a pid still runs). → the names removed */
export function sweepRunRoots(base: string, isAlive?: (pid: number) => boolean): string[];
/** Make this run's folder in `base` and point the temp variables of `env` at it. */
export function ownRunRoot(
  base?: string,
  env?: Record<string, string | undefined>,
  pid?: number,
): { root: string; remove: () => void };
export default function setup(): () => void;
