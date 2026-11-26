import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Chat schedules (plan "Chat schedules on Sentinel", BLG-399…401): a chat's Info panel lists the
 * sentinels that wake it, with Run Now and an on/off switch; '/schedule ' turns the message box into a
 * schedule with a When chip (BLG-1023), and Custom… opens the sheet; a scheduled chat's row has a clock mark. Screenshots go to .beluga/scratch/chat-schedules-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const CHAT = 'Daily status';

/** A picture for the proof, with the terminal masked: its prompt is the real shell's, with personal data. */
const shoot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `chat-schedules-${name}.png`), mask: [page.locator('.xterm')] });

type Demo = { readonly endpoint: { readonly url: string; readonly token: string } };
const connect = (demo: Demo) => SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });

/** A chat in bob-api with one schedule that wakes it every day at 9:00 (made through the API, as the agent would). */
async function seed(demo: Demo): Promise<void> {
  const client = await connect(demo);
  // An off mark an older Beluga saved for the experiment changes nothing (BLG-1023).
  await client.api.session.setPrefs({ experiments: ['-chat-schedules'], folded: [] });
  const state = client.store.getState();
  const project = state.projects.find((p) => p.name === 'bob-api')!.id;
  const ws = (await client.api.workspaces.newChat(project, CHAT)) as string;
  const made = (await client.api.sentinel.create({ name: 'Morning status', trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' }, steps: [{ kind: 'chat', to: `${client.store.getState().selfId}/ws:${ws}`, text: 'Send XYZ' }] } as never)) as { id: string };
  await client.api.sentinel.pause(made.id, false);
  client.close();
}

async function openChat(page: Page): Promise<void> {
  await page.goto('/');
  // The demo's project starts folded.
  const show = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
  await show.click();
  await sidebar(page).getByRole('button', { name: new RegExp(`^${CHAT}`) }).first().click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('the Info panel lists the chat’s schedule; Run Now runs it and the switch turns it off', async ({ page, demo }) => {
  test.setTimeout(90_000);
  await seed(demo);
  await openChat(page);
  const row = inspector(page).locator('[data-schedule]');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText('Morning status');
  await expect(row).toContainText(/Every day at 9:00 · next/);
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  // The chat's row in the sidebar has the clock mark.
  await expect(sidebar(page).locator('[data-scheduled="on"]')).toHaveCount(1);
  await shoot(page, '01-info');

  await row.getByRole('button', { name: 'Run Morning status now' }).click();
  await expect(page.getByText('Morning status is running')).toBeVisible();

  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row).toContainText('Every day at 9:00 · paused');
  await expect(sidebar(page).locator('[data-scheduled="off"]')).toHaveCount(1);
  await shoot(page, '02-off');

  // A click on the row opens the sentinel's page.
  await row.getByRole('button', { name: /Morning status/ }).first().click();
  await expect(page.locator('main').getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning status');
});

const box = (page: Page) => page.locator('textarea[data-composer]');
const composer = (page: Page) => page.locator('[data-chat-box]').filter({ has: page.locator('textarea[data-composer]') });

test('/schedule turns the box into a schedule: a banner says when, the When chip picks, Schedule makes it on', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page);
  await box(page).fill('/schedule ');
  await expect(composer(page)).toHaveAttribute('data-mode', 'schedule');
  await expect(box(page)).toHaveValue('');
  await expect(composer(page).getByRole('status')).toContainText('Sends this here tomorrow at 9:00');
  await box(page).fill('Check the build');
  await shoot(page, '03-mode');
  await composer(page).getByRole('button', { name: /^When: / }).click();
  await shoot(page, '04-when');
  await page.getByRole('menuitem', { name: /In 3 hours/ }).click();
  await expect(composer(page).getByRole('status')).toContainText(/Sends this here (today|tomorrow) at \d+:\d\d/);
  await composer(page).getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText(/Scheduled: sends here/)).toBeVisible();
  await expect(box(page)).toHaveValue('');
  await expect(composer(page)).not.toHaveAttribute('data-mode', 'schedule');
  const row = inspector(page).locator('[data-schedule]').filter({ hasText: 'Check the build' });
  await expect(row).toContainText(/Once, .* · next/);
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await shoot(page, '05-made');
});

test('esc leaves the mode; Custom… opens the sheet with the words, and making it there clears the box', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page);
  await box(page).fill('/schedule ');
  await expect(composer(page)).toHaveAttribute('data-mode', 'schedule');
  await page.keyboard.press('Escape');
  await expect(composer(page)).not.toHaveAttribute('data-mode', 'schedule');

  // Schedule is one of the modes, beside Act and the plans; Act takes the box back.
  await composer(page).getByRole('button', { name: /^Mode: / }).click();
  await shoot(page, '07-modes');
  await page.getByRole('menuitem', { name: /^Schedule/ }).click();
  await expect(composer(page)).toHaveAttribute('data-mode', 'schedule');
  await expect(composer(page).getByRole('button', { name: 'Mode: Schedule' })).toBeVisible();
  await composer(page).getByRole('button', { name: 'Mode: Schedule' }).click();
  await page.getByRole('menuitem', { name: /^Act/ }).click();
  await expect(composer(page)).not.toHaveAttribute('data-mode', 'schedule');

  await box(page).fill('/schedule Weekly recap');
  await composer(page).getByRole('button', { name: /^When: / }).click();
  await page.getByRole('menuitem', { name: /Custom/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Schedule a Message' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Message' })).toHaveValue('Weekly recap');
  await sheet.getByRole('radio', { name: 'Repeats' }).click();
  await shoot(page, '06-custom');
  await sheet.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(box(page)).toHaveValue('');
  await expect(inspector(page).locator('[data-schedule]').filter({ hasText: 'Weekly recap' })).toContainText(/Every day at 9:00/);
});
