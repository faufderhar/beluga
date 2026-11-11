import { expect, test, type Page } from './fixtures.js';

/**
 * Claude's steps open to show what ran and what came back (the demo's Claude records realistic
 * tool calls and a stretch of thinking), and a message you send flies from the box into the chat.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const lastSteps = (page: Page) => page.getByRole('list', { name: "The agent's steps" }).last();

async function openWorkspace(page: Page, name: string, project = 'bob-api'): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** Counts copies of a sent message flying in (they live for well under a second). */
async function countFlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { flights: number };
    w.flights = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.dataset.sendFlight) w.flights++;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const flights = (page: Page) => page.evaluate(() => (window as unknown as { flights: number }).flights);

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** Sends a message and waits for its answer (not an earlier one in the same chat). */
async function answer(page: Page, text: string) {
  const done = page.locator('[data-turn="done"]');
  const before = await done.count();
  await send(page, text);
  await expect(done).toHaveCount(before + 1, { timeout: 30_000 });
  return done.last();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('once Claude answers, its steps fold away; Show Steps opens them, and Hide Steps folds them again', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  const card = await answer(page, 'run the tests please');
  // The answer stands on its own: no steps, no "Done in 2m".
  await expect(card.getByRole('list', { name: "The agent's steps" })).toHaveCount(0);
  await expect(card).not.toContainText(/Done in|steps ·/);
  await card.hover();
  await card.getByRole('button', { name: 'Show Steps' }).click();
  const steps = card.getByRole('list', { name: "The agent's steps" });
  await expect(steps).toBeVisible();
  await card.hover();
  await card.getByRole('button', { name: 'Hide Steps' }).click();
  await expect(steps).toHaveCount(0);
});

test('a Bash step opens to show its command and output, and thinking opens to show the thinking', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  const card = await answer(page, 'run the tests please');
  await card.hover();
  await card.getByRole('button', { name: 'Show Steps' }).click();
  const steps = lastSteps(page);
  // Shown again, its steps are read back (the whole record): then the earlier ones open.
  const earlier = steps.getByRole('button', { name: /earlier step/ });
  await expect(earlier).toBeVisible();
  await earlier.click();

  const bash = steps.locator('[data-step-kind="bash"]').last();
  // In words, never the tool's name.
  await expect(bash).toContainText('Ran npm test');
  const head = bash.getByRole('button', { name: /npm test/ });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  // Keyboard: Return opens it, like any button.
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  const detail = bash.locator('[data-step-detail="bash"]');
  await expect(detail.getByText('$ npm test')).toBeVisible();
  await expect(detail.getByText(/24 passed/)).toBeVisible();
  // The output's colours survive (green for passed).
  await expect(detail.locator('span', { hasText: '24 passed' }).first()).toHaveCSS('color', /rgb/);

  const thinking = steps.locator('[data-step-kind="thinking"]').first();
  await expect(thinking).toContainText(/Thought/);
  await thinking.getByRole('button').first().click();
  await expect(thinking.locator('[data-step-detail="thinking"]')).toContainText('They asked');
});

/**
 * Notes every step row seen part way through closing or opening: its opacity between none and
 * full, or an animation running on it (caught on any frame of it, even when frames are few).
 */
async function watchSlides(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { slid: string[] };
    w.slid = [];
    const look = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-slot]')) {
        const op = Number.parseFloat(getComputedStyle(el).opacity);
        const moving = (op > 0.02 && op < 0.98) || el.getAnimations().some((a) => a.playState === 'running');
        if (moving && !w.slid.includes(el.dataset.slot!)) w.slid.push(el.dataset.slot!);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

/** The oldest row shown below the fold, and the fold's count, read together. */
const tail = (page: Page) =>
  lastSteps(page).evaluate((list) => ({
    oldest: list.querySelector<HTMLElement>('[data-slot]')?.dataset.slot ?? '',
    count: Number(list.querySelector('[data-folded-count]')?.getAttribute('data-folded-count') ?? 0),
  }));
const slid = (page: Page) => page.evaluate(() => (window as unknown as { slid: string[] }).slid);
const foldedCount = async (page: Page): Promise<number> => Number(await lastSteps(page).getByRole('button', { name: /^Show \d+ earlier steps/ }).getAttribute('data-folded-count'));

test('while Claude works, a finished step closes up into the fold, whose count ticks up; the fold opens and closes again', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'deep dive into the webhook code, take your time');
  const steps = lastSteps(page);
  const fold = steps.getByRole('button', { name: /^Show \d+ earlier steps/ });
  await expect(fold).toBeVisible({ timeout: 20_000 });
  await watchSlides(page);
  const before = await tail(page);
  expect(before.oldest).not.toBe('');
  // The next step finishing pushes the oldest shown one into the fold: it leaves the last few
  // (fading and closing as it goes), and the fold's count ticks up.
  await expect(steps.locator(`[data-slot="${before.oldest}"]`)).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => foldedCount(page), { timeout: 3000 }).toBeGreaterThan(before.count);
  const counter = fold.locator('[class*="countNow"]');
  await expect.poll(async () => Number(await counter.textContent()), { timeout: 3000 }).toBeGreaterThan(before.count);
  expect(await slid(page)).toContain(before.oldest);
  const went = [before.oldest];
  // The last few rows are all still in sight: two finished ones and the one Claude is on.
  await expect(steps.locator('[data-current="true"]')).toHaveCount(1);
  // Open the fold: every step shows, and it closes again.
  await fold.click();
  const hide = steps.getByRole('button', { name: /^Hide \d+ earlier steps/ });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  for (const id of went) await expect(steps.locator(`[data-slot="${id}"]`)).toHaveCount(1);
  await hide.click();
  await expect(steps.getByRole('button', { name: /^Show \d+ earlier steps/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
});

test('with reduced motion, steps go into the fold at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'deep dive into the webhook code, take your time');
  await expect(lastSteps(page).getByRole('button', { name: /^Show \d+ earlier steps/ })).toBeVisible({ timeout: 20_000 });
  await watchSlides(page);
  const before = await foldedCount(page);
  await expect.poll(() => foldedCount(page), { timeout: 10_000 }).toBeGreaterThan(before);
  // (Past where a slide would have been.)
  await page.waitForTimeout(500);
  expect(await slid(page)).toEqual([]);
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
});

test('with reduced motion, the step Claude is on reads as plain text in light and dark', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'deep dive into the webhook code, take your time');
  const words = lastSteps(page).locator('[data-current="true"] [class*="shimmer"]').first();
  await expect(words).toBeVisible({ timeout: 20_000 });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    // No gradient left behind without its clip (that paints a box over the words), and the words keep a colour.
    const look = await words.evaluate((el) => {
      const css = getComputedStyle(el);
      return { image: css.backgroundImage, clip: css.backgroundClip || css.webkitBackgroundClip, color: css.color };
    });
    expect(look.image === 'none' || look.clip === 'text', `${colorScheme}: ${JSON.stringify(look)}`).toBe(true);
    expect(look.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
});

test('a sent message flies from the box into the chat and lands in place', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  // The turn the test before stopped is over first: a message said during one lands above it, in place.
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 30_000 });
  await countFlights(page);
  await send(page, 'Summarize the hero section copy');
  const row = page.locator('[data-mine="true"]', { hasText: 'Summarize the hero section copy' }).last();
  await expect(row).toHaveAttribute('data-flown', 'true');
  await expect(row).toBeVisible();
  expect(await flights(page)).toBeGreaterThanOrEqual(1);
  // The copy is gone once it landed.
  await expect(page.locator('[data-send-flight]')).toHaveCount(0);
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
});

test('with reduced motion, a sent message just appears', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkspace(page, 'new-hero', 'landing');
  await countFlights(page);
  await send(page, 'What does the hero say now?');
  const row = page.locator('[data-mine="true"]', { hasText: 'What does the hero say now?' }).last();
  // No copy flies: it appears (or, landing above a live turn's rows, fades in where it goes).
  await expect(row).toHaveAttribute('data-flown', /^(instant|in-place)$/);
  expect(await flights(page)).toBe(0);
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
});

test('while Claude works, a sent message flies into the queue above the box', async ({ page }) => {
  await openWorkspace(page, 'new-hero', 'landing');
  await send(page, 'deep dive into the webhook code, take your time');
  await expect(page.locator('[data-working]').last()).toBeVisible();
  await countFlights(page);
  await send(page, 'then list the riskiest parts');
  const queued = page.getByRole('region', { name: 'Queued messages' }).locator('li', { hasText: 'then list the riskiest parts' });
  await expect(queued).toHaveAttribute('data-flown', 'true');
  expect(await flights(page)).toBeGreaterThanOrEqual(1);
  // It waits above the box, not in the chat (BLG-317).
  await expect(page.locator('[data-index]', { hasText: 'then list the riskiest parts' })).toHaveCount(0);
  await page.screenshot({ path: '../../.beluga/scratch/01-queued-above-the-box.png' });
  // Stop: the queued message comes back to the box.
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
  await expect(composer(page)).toHaveValue(/then list the riskiest parts/);
  await composer(page).fill('');
});
