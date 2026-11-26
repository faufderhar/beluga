import { existsSync } from 'node:fs';
import { defineConfig, firefox, webkit } from '@playwright/test';
import { homesFor, portFor, workerCount, worktreeOf } from '../../scripts/e2e-lock.mjs';

// `npm run e2e` runs through scripts/e2e-lock.mjs: one Mac e2e run at a time, nothing left behind.
// It hands every run its worktree's own port and demo home; a bare `playwright test` gets the same ones.
// Never an inherited KLAUD_HOME without the lock (inside Beluga that's your real data; the demo home is wiped).
// Each worker runs its own demo daemons in homes next to these (e2e/fixtures.ts): specs run side by side.
const worktree = worktreeOf(import.meta.dirname);
if (!process.env.BELUGA_E2E_RUN && !process.env.KLAUD_E2E_RUN) {
  // Both names: the daemon reads BELUGA_HOME first, so an inherited one must never be left pointing at real data.
  process.env.BELUGA_HOME = process.env.KLAUD_HOME = homesFor(worktree).home;
  // A pretend ~/.claude the demo daemon watches for Claude Code sessions (e2e/claude-code.spec.ts writes there).
  process.env.BELUGA_CLAUDE_HOME = process.env.KLAUD_CLAUDE_HOME = homesFor(worktree).claude;
}
const port = Number(process.env.E2E_PORT || portFor(worktree));
// Decided once, here (the workers load this file too, and the Mac's load moves meanwhile).
process.env.E2E_WORKERS ||= String(workerCount());
process.env.E2E_PORT = String(port);

export default defineConfig<object, { demoLinkMs: number }>({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Files run side by side, each with its own daemon; a file's tests run in order (some build on each other).
  fullyParallel: false,
  workers: workerCount(),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Every spec starts past the first-run welcome (src/onboarding); e2e/onboarding.spec.ts clears this.
    // And on Tasks' list (the board is the default since BLG-216; the specs pick it when they mean it).
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'beluga.onboarding.v1', value: JSON.stringify({ version: 'e2e', at: 0, how: 'finished' }) }, { name: 'beluga.tasks.v2', value: JSON.stringify({ display: 'list' }) }] }] },
  },
  projects: [
    // The app through the dev server and per-file demo daemons (e2e/fixtures.ts).
    { name: 'app', testIgnore: ['web/**', 'remote/**'] },
    // Work on the demo's computer, 80 ms away (e2e/remote/, BLG-795): the main flows again, on a computer's page.
    { name: 'remote', testMatch: /remote\/.*\.spec\.ts$/, use: { demoLinkMs: 80 } },
    // The real served build through the daemon's web port, joined by a link (e2e/web/, BLG-652): built once first.
    { name: 'web-build', testMatch: /web\/build\.setup\.ts$/ },
    { name: 'web', testMatch: /web\/.*\.spec\.ts$/, dependencies: ['web-build'], use: { baseURL: undefined, storageState: { cookies: [], origins: [] } } },
    // The phone layout (BLG-6) in Safari's engine too, where it's installed: what an iPhone runs.
    ...(existsSync(webkit.executablePath()) ? [{ name: 'phone-webkit', testMatch: /phone\.spec\.ts$/, use: { browserName: 'webkit' as const } }] : []),
    // The same in Firefox and Safari's WebKit, where they're installed (`npx playwright install firefox webkit`).
    ...(['firefox', 'webkit'] as const)
      .filter((name) => existsSync({ firefox, webkit }[name].executablePath()))
      .map((name) => ({ name: `web-${name}`, testMatch: /web\/.*\.spec\.ts$/, dependencies: ['web-build'], use: { browserName: name, baseURL: undefined, storageState: { cookies: [], origins: [] } } })),
  ],
  webServer: { command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false, env: { BELUGA_HOME: process.env.KLAUD_HOME!, KLAUD_HOME: process.env.KLAUD_HOME! } },
});
