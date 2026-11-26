import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { workerCount } from './scripts/test-lock.mjs';

const SLOW_RUNNER = Boolean(process.env.CI) && process.platform === 'win32';

export default defineConfig({
  // The tests load a few of the phone app's files (packages/companion, an Expo app): read them with
  // this tsconfig, not theirs, which extends expo/tsconfig.base (not installed where only the root is).
  tsconfig: 'tsconfig.json',
  // The Mac app's alias for the core (packages/mac/vite.config.ts), so a test can load its models.
  resolve: { alias: [{ find: /^@beluga\//, replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}` }] },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Ten worktrees testing at once leave the Mac usable: half the cores per run (KLAUD_TEST_WORKERS
    // overrides it), and a few runs at a time machine-wide (scripts/test-lock.mjs, KLAUD_TEST_SLOTS).
    maxWorkers: workerCount(),
    // Each run keeps its temp files in its own beluga-run-* folder, removed when it ends (and by the
    // next run if it was killed), so a test that misses its cleanup leaves nothing behind.
    // First of all, scripts/test-repo-guard.mjs: git's own variables (a run started from `git rebase -x`,
    // an alias or a hook) are dropped, so no test's git lands in the repository the suite runs in, and
    // the run fails if the worktree it runs in is gone at the end (BLG-867).
    globalSetup: ['scripts/test-repo-guard.mjs', 'scripts/test-lock.mjs', 'scripts/test-temp-root.mjs'],
    // The whole suite passing on a Mac prints a "Tested-on: macOS <tree>" line for the commit, and CI
    // skips its macOS run for it (scripts/local-pass.mjs).
    reporters: ['default', './scripts/local-pass.mjs'],
    // Real git, terminals and peer-to-peer links: GitHub's runners (and a busy Mac) need longer than
    // vitest's 5 s, or a slow moment fails the release. Windows' runners are the slowest by far (a
    // demo Mac alone can take 30 s there): twice that.
    testTimeout: SLOW_RUNNER ? 60_000 : 30_000,
    hookTimeout: SLOW_RUNNER ? 60_000 : 30_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/agent/runner.ts', 'src/core/clipboard.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
