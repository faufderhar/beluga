import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type Served, startServed } from './served.js';

/**
 * The real served build through the daemon's web port (BLG-652), not the dev server: a browser
 * is let in by a join link, chats with its agent, uses a terminal, and locks when it's revoked.
 */

test.describe.configure({ mode: 'serial' });

let web: Served;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  web = await startServed();
});
test.afterAll(async () => web?.stop());

/** Past the first-run welcome, on Tasks' list, as the other specs start. */
const settled = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem('beluga.onboarding.v1', JSON.stringify({ version: 'e2e', at: 0, how: 'finished' }));
    localStorage.setItem('beluga.tasks.v2', JSON.stringify({ display: 'list' }));
  });
};
/**
 * What the page says is wrong: console errors, uncaught errors, and CSP violations (Firefox logs
 * those as errors; Chromium only fires the event, so it's listened for).
 */
const watchErrors = async (page: Page): Promise<string[]> => {
  const errors: string[] = [];
  page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())));
  page.on('pageerror', (e) => void errors.push(String(e)));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} blocked ${e.blockedURI}`)));
  return errors;
};
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const askPage = (page: Page) => page.getByRole('heading', { name: 'Ask for a link to open Beluga' });

test('a browser without a link gets only the Ask for a link page', async ({ page }) => {
  await page.goto(web.url);
  await expect(askPage(page)).toBeVisible();
  const res = await page.request.get(`${web.url}/__beluga/endpoint`);
  expect(res.status()).toBe(401);
});

test('joins by a link, chats, uses a terminal, and locks at once when revoked', async ({ page, browser }) => {
  const errors = await watchErrors(page);
  await settled(page);
  await page.goto(web.link);
  await expect(sidebar(page)).toBeVisible({ timeout: 30_000 });
  // The secret left the address bar, and the session cookie is out of scripts' reach.
  expect(page.url()).toBe(`${web.url}/`);
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // A chat: send, and see the agent's answer.
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Add a health check endpoint');
  await composer(page).press('Enter');
  await expect(page.getByText('Add a health check endpoint').last()).toBeVisible();
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });

  // A terminal: a real shell on the computer Beluga runs on.
  await page.keyboard.press('Meta+J');
  const term = page.getByRole('complementary', { name: 'Panel' }).getByRole('region', { name: 'Terminal' });
  await expect(term).toBeVisible();
  await term.locator('.xterm').click();
  // Terminals draw with the GPU (BLG-963): no text in the page, so the shell's answer goes to a file.
  const out = path.join(os.tmpdir(), `beluga-web-term-${process.pid}-${Date.now()}.txt`);
  await page.keyboard.type(`echo web-$((6*7)) > '${out}'\n`);
  await expect.poll(() => readFile(out, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('web-42');
  await rm(out, { force: true });

  // The main screens, with nothing wrong in the console since joining (BLG-672).
  for (const screen of ['Overview', 'Work', 'Sentinel', 'Files', 'Group chat']) {
    await sidebar(page).getByText(screen, { exact: true }).first().click();
    await page.waitForTimeout(400);
  }
  expect(errors).toEqual([]);

  // The same link doesn't let a second browser in.
  const other = await browser.newPage();
  await other.goto(web.link);
  await expect(other.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await other.close();

  // Revoked from the command line: the page locks by itself.
  const [me] = web.sessions();
  expect(me).toBeDefined();
  expect(await web.cli('revoke', me!.id)).toContain('signed out and cut off');
  await expect(askPage(page)).toBeVisible({ timeout: 15_000 });
});

test('a new link from `beluga web` lets the browser back in', async ({ page }) => {
  await settled(page);
  const link = /(http:\/\/\S+\/join#\S+)/.exec(await web.cli())?.[1];
  expect(link?.startsWith(`${web.url}/join#`)).toBe(true);
  await page.goto(link!);
  await expect(sidebar(page)).toBeVisible({ timeout: 30_000 });
});
