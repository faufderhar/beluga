import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * The toolbar says what a pull request really needs next (BLG-753): Resolve Conflicts (never a bare
 * "Resolve"), Checks running while they run, Fix Checks with Re-run Failed Checks beside it, and Push
 * when this worktree has commits the PR doesn't (GitHub's checks and conflicts are for an older one,
 * and merging would leave them out: BLG-840).
 * GitHub is the demo's stand-in (e2e/fake-gh.mjs); add-auth's PR is #7.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const toolbar = (page: Page) => page.locator('main header').first();
const branchGroup = (page: Page) => toolbar(page).getByRole('group', { name: /^Branch:/ });
const mainStep = (page: Page) => toolbar(page).locator('[data-branch-step]');

const ghFile = (): string => path.join(process.env.BELUGA_HOME!, 'fake-gh.json');
const readGh = (): { reruns?: string[][] } => JSON.parse(readFileSync(ghFile(), 'utf8'));
const writeGh = (state: object): void => writeFileSync(ghFile(), JSON.stringify(state, null, 2));
const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();
const check = (name: string, status: string, conclusion: string, job: number): object => ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion, startedAt: ago(120), completedAt: status === 'COMPLETED' ? ago(10) : '0001-01-01T00:00:00Z', detailsUrl: `https://github.com/bob/api/actions/runs/5/job/${job}` });
const openPr = (more: object = {}): object => ({ number: 7, url: 'https://github.com/bob/api/pull/7', state: 'OPEN', title: 'Protect the payments routes', isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', autoMergeRequest: null, statusCheckRollup: [check('test', 'COMPLETED', 'SUCCESS', 1)], ...more });

/** Ask about add-auth again now (its status, then its PR), as the PR sheet's Refresh does; → its folder. */
const lookAgain = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const boot = await import('/src/lib/boot.ts');
    const c = await boot.connect(boot.capabilities(() => ({ ok: true, message: '' })));
    await c.api.workspaces.refresh();
    const w = c.store.getState().projects.flatMap((p) => p.workspaces).find((x) => x.name === 'add-auth')!;
    await c.api.workbench.refreshPrs(w.id);
    return w.path;
  });
const showPr = async (page: Page, pr: object): Promise<string> => {
  writeGh({ prs: { 'add-auth': pr } });
  return lookAgain(page);
};
const otherSteps = async (page: Page): Promise<void> => {
  await toolbar(page).getByRole('button', { name: 'Other steps for this branch' }).click();
};

test('the toolbar names the PR’s real next step: conflicts, running, failed, not pushed', async ({ page }) => {
  try {
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
    const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
    if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
    await row.click();
    await expect(toolbar(page)).toContainText('add-auth');

    // Conflicts with main: the pill says with what, the button what it resolves.
    await showPr(page, openPr({ mergeable: 'CONFLICTING' }));
    // (The pill's words, folded or not: a narrow toolbar keeps only its icon and number.)
    await expect(toolbar(page).locator('[data-branch-state="conflicts"]')).toContainText('#7', { timeout: 20_000 });
    await expect(branchGroup(page)).toHaveAttribute('aria-label', 'Branch: Conflicts with main');
    await expect(mainStep(page)).toHaveText('Resolve Conflicts…');
    await expect(mainStep(page)).toHaveAttribute('data-branch-step', 'resolve_pr');
    await page.screenshot({ path: test.info().outputPath('01-conflicts.png') });

    // GitHub still working it out (UNKNOWN): no conflict.
    await showPr(page, openPr({ mergeable: 'UNKNOWN' }));
    await expect(toolbar(page).locator('[data-branch-state="conflicts"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(toolbar(page).locator('[data-branch-state="ready"]')).toBeVisible();

    // One check failed, another still runs: calm "Checks running", Fix Checks only in the menu.
    await showPr(page, openPr({ statusCheckRollup: [check('test', 'COMPLETED', 'FAILURE', 1), check('e2e', 'IN_PROGRESS', '', 2)] }));
    const running = toolbar(page).locator('[data-branch-state="checks_running"]');
    await expect(running).toBeVisible({ timeout: 20_000 });
    await expect(branchGroup(page)).toHaveAttribute('aria-label', 'Branch: Checks running');
    await expect(mainStep(page)).toHaveAttribute('data-branch-step', 'open_pr');
    await expect(branchGroup(page).locator('[class*="mainError"]')).toHaveCount(0);
    await otherSteps(page);
    await expect(page.getByRole('menuitem', { name: /^Fix Checks…/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: test.info().outputPath('02-checks-running.png') });

    // Failed, nothing running: Fix Checks… leads, Re-run Failed Checks is beside it (gh run rerun --failed).
    await showPr(page, openPr({ statusCheckRollup: [check('test', 'COMPLETED', 'FAILURE', 1), check('e2e', 'COMPLETED', 'SUCCESS', 2)] }));
    await expect(toolbar(page).locator('[data-branch-state="checks_failing"]')).toBeVisible({ timeout: 20_000 });
    await expect(mainStep(page)).toHaveText('Fix Checks…');
    await otherSteps(page);
    await page.getByRole('menuitem', { name: /^Re-run Failed Checks/ }).click();
    await expect.poll(() => readGh().reruns ?? []).toEqual([['run', 'rerun', '5', '--failed']]);
    await page.screenshot({ path: test.info().outputPath('03-checks-failed.png') });

    // A fix committed here, not pushed: GitHub's failure is for an older commit, so Push leads, calm.
    const dir = await lookAgain(page);
    writeFileSync(path.join(dir, 'src', 'auth.ts'), "export function requireUser(req: { session?: string }) {\n  if (!req.session) throw new Error('unauthorized: sign in first');\n}\n");
    execFileSync('git', ['-c', 'user.email=demo@beluga.dev', '-c', 'user.name=Beluga demo', 'commit', '-qam', 'Say why it refused'], { cwd: dir });
    await lookAgain(page);
    const notPushed = toolbar(page).locator('[data-branch-state="not_pushed"]');
    await expect(notPushed).toBeVisible({ timeout: 20_000 });
    await expect(branchGroup(page)).toHaveAttribute('aria-label', 'Branch: 1 commit not on PR');
    await expect(mainStep(page)).toHaveText(/^Push 1 Commit to PR #\d+$/);
    await expect(toolbar(page).locator('[data-branch-step="fix_checks"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('04-not-pushed.png') });
    // The sidebar row says it too (BLG-840), and the PR sheet won't merge without it: Push and Merge.
    await expect(sidebar(page).locator('[data-not-on-pr="1"]')).toHaveAttribute('aria-label', '1 commit not on PR #7');
    // The pill (first; the step's "Push 1 Commit to PR #7" ends in #7 too).
    await toolbar(page).getByRole('button', { name: /#7$/ }).first().click();
    const sheet = page.getByRole('dialog', { name: /Pull Request/ });
    await expect(sheet.getByRole('button', { name: 'Push and Merge' })).toHaveAttribute('data-push-first', '1');
    await expect(sheet).toContainText('1 commit not on it yet');
    await expect(sheet).toContainText('so merging it as it is would leave it out');
    await page.screenshot({ path: test.info().outputPath('05-pr-sheet-push-and-merge.png') });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // Folded (a narrow window), the words still say it.
    await page.setViewportSize({ width: 1040, height: 760 });
    await expect(mainStep(page)).toHaveText('Push');
    await showPr(page, openPr({ mergeable: 'CONFLICTING' }));
    await page.setViewportSize({ width: 1280, height: 800 });

    // Push: it goes to GitHub, and what GitHub says is about this commit again.
    await mainStep(page).click();
    await expect(notPushed).toHaveCount(0, { timeout: 20_000 });
    await expect(toolbar(page).locator('[data-branch-state="conflicts"]')).toBeVisible();
    const remote = execFileSync('git', ['rev-parse', '@{push}'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(remote).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());

    // Folded, the conflict button says what it resolves.
    await page.setViewportSize({ width: 1040, height: 760 });
    await expect(mainStep(page)).toHaveText('Resolve Conflicts');
    await page.screenshot({ path: test.info().outputPath('05-folded-conflicts.png') });
  } finally {
    if (existsSync(ghFile())) rmSync(ghFile());
  }
});
