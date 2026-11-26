import { expect, test, type Locator, type Page } from './fixtures.js';
import { openTasks, openWork } from './helpers.js';

/**
 * Enter that picks an input method's words never sends, submits or closes, in any box: one guard
 * on the window (src/lib/ime-guard.ts), none in the boxes. WebKit
 * ends the composition before keydown, so isComposing is already false there: only keyCode 229
 * tells, and that is what these press. The next, plain Enter does what it always did.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const chat = (page: Page) => page.getByRole('complementary', { name: 'Conversation' });
const planBox = (page: Page) => chat(page).getByRole('textbox', { name: 'Message your agent about the plan' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

test.describe.configure({ mode: 'serial' });

/** Enter as WebKit sends it when it picks an IME's words: keyCode 229, isComposing false. */
async function imeEnter(box: Locator, mods: { metaKey?: boolean } = {}): Promise<void> {
  await box.evaluate((el, m) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...m });
    Object.defineProperty(e, 'keyCode', { get: () => 229 });
    el.dispatchEvent(e);
  }, mods);
  await box.page().waitForTimeout(300);
}

async function newPlan(page: Page, goal: string): Promise<void> {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill(goal);
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  await expect(planBox(page)).toBeVisible({ timeout: 20_000 });
}

test('the plan’s chat and its name: Enter that picks an IME’s words does nothing; the next Enter does', async ({ page }) => {
  await newPlan(page, 'A plan typed with a Chinese input method');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  const box = planBox(page);
  await box.fill('hello');
  await imeEnter(box);
  await expect(box).toHaveValue('hello');
  await expect(chat(page)).not.toContainText('Added hello');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(chat(page)).toContainText('Added hello', { timeout: 30_000 });

  // Renaming the plan: Enter ends the edit (blurs), but not the one that picks words.
  const name = page.getByRole('textbox', { name: 'Plan name' });
  await name.click();
  await name.fill('计划改名');
  await imeEnter(name);
  await expect(name).toBeFocused();
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue('计划改名');
});

test('the main chat box: Enter that picks an IME’s words doesn’t send', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('输入法选词');
  await imeEnter(box);
  await expect(box).toHaveValue('输入法选词');
  await box.press('Enter');
  await expect(box).toHaveValue('');
});

test('New Task: ⌘↩ that picks an IME’s words doesn’t create it; a plain ⌘↩ does', async ({ page }) => {
  await page.goto('/');
  await openTasks(page);
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Task' });
  const box = sheet.getByRole('textbox', { name: 'Describe the task' });
  await box.fill('Check the IME guard on the new task sheet');
  await imeEnter(box, { metaKey: true });
  await expect(sheet).toBeVisible();
  await expect(box).toHaveValue('Check the IME guard on the new task sheet');
  await box.press('Meta+Enter');
  await expect(sheet).toBeHidden({ timeout: 20_000 });
});
