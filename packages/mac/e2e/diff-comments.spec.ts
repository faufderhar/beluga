import { expect, test, type Page } from './fixtures.js';

/**
 * Commenting on a diff's lines: a line's + opens a box under it, Add to Chat puts the comment
 * above the message box as a card, and the line stays marked while it waits there. Sending takes
 * it (where, the lines, what you said) after your words. Full size, the diff says how many wait.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.getByRole('textbox', { name: /^Message/ }).or(page.locator('textarea[placeholder*="new-hero"]')).first();
const SHOTS = process.env.BELUGA_SHOTS;

async function openReadmeChanges(page: Page) {
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toBeVisible();
  await panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name: 'Changes', exact: true }).click();
  await panel(page).getByRole('option', { name: /README\.md/ }).click();
  const readme = panel(page).getByRole('region', { name: 'Changes in README.md' });
  const changes = readme.getByRole('tab', { name: 'Changes' });
  if (await changes.isVisible()) await changes.click();
  return readme;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a comment on a changed line waits above the message box as a card, and goes when you send', async ({ page }) => {
  const readme = await openReadmeChanges(page);
  const cards = page.getByRole('list', { name: 'Comments on the changes' });
  const lines = readme.locator('tr:has(button[aria-label^="Comment on line"])');
  await expect(lines.first()).toBeVisible();
  await lines.nth(0).hover();
  await lines.nth(0).getByRole('button', { name: /^Comment on line/ }).click();
  // Shift-click a later line: the comment is on the range.
  await lines.nth(2).hover();
  await lines.nth(2).getByRole('button', { name: /^Comment on line/ }).click({ modifiers: ['Shift'] });
  const box = readme.getByRole('textbox', { name: /^Comment on lines/ });
  await expect(box).toBeFocused();
  await box.fill('Can this say it more plainly?');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-comment-box.png` });
  await box.press('Meta+Enter');
  await expect(box).toBeHidden();

  // A card above the box, not text in it.
  const card = cards.getByRole('listitem', { name: /^Comment on README\.md:\d+-\d+$/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Can this say it more plainly?');
  expect(await composer(page).inputValue()).toBe('');
  await expect(readme.getByRole('button', { name: /has a comment waiting to send/ }).first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-card-in-the-box.png` });

  // Escape closes a comment box without adding anything.
  await lines.nth(4).hover();
  await lines.nth(4).getByRole('button', { name: /^Comment on line|has a comment/ }).click();
  await readme.getByRole('textbox', { name: /^Comment on/ }).press('Escape');
  await expect(readme.getByRole('textbox', { name: /^Comment on/ })).toBeHidden();
  await expect(cards.getByRole('listitem')).toHaveCount(1);

  // Full size: it says what's waiting; Split has a + on each side too; Go to Chat is back at the box.
  await readme.getByRole('button', { name: 'Open in full' }).click();
  await expect(page.getByText('1 comment waiting to send')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/03-full-size.png` });
  await page.getByRole('radio', { name: 'Split' }).or(page.getByRole('tab', { name: 'Split' })).first().click();
  const split = page.locator('table tr:has(button[aria-label^="Comment on line"])').first();
  await split.hover();
  await split.getByRole('button', { name: /^Comment on line/ }).last().click();
  await expect(page.getByRole('textbox', { name: /^Comment on/ })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('radio', { name: 'Unified' }).or(page.getByRole('tab', { name: 'Unified' })).first().click();
  await page.getByRole('button', { name: 'Go to Chat' }).click();
  await expect(composer(page)).toBeFocused();

  // × takes a card away; the marks on its lines go with it.
  await panel(page).getByRole('option', { name: /README\.md/ }).click();
  await expect(readme.getByRole('button', { name: /has a comment waiting to send/ }).first()).toBeAttached();
  await card.getByRole('button', { name: /^Remove the comment/ }).click();
  await expect(cards).toBeHidden();
  await expect(readme.getByRole('button', { name: /has a comment waiting to send/ })).toHaveCount(0);

  // Again, and sent with words: it goes after them, and the box is empty again.
  await lines.nth(1).hover();
  await lines.nth(1).getByRole('button', { name: /^Comment on line/ }).click();
  await readme.getByRole('textbox', { name: /^Comment on/ }).fill('Shorter, please');
  await readme.getByRole('button', { name: 'Add to Chat' }).click();
  await composer(page).fill('Two notes on the README');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(cards).toBeHidden();
  await expect(page.getByText('Shorter, please').first()).toBeVisible();
  await expect(page.getByText('Two notes on the README').first()).toBeVisible();
  await expect(readme.getByRole('button', { name: /has a comment waiting to send/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/04-sent.png` });
});
