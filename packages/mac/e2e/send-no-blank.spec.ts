import { expect, test, type Page } from './fixtures.js';

/**
 * Sending a message never blanks the chat: while its copy flies in from the box (flight.ts), the
 * list keeps its width and what you were reading stays in sight. The copy once took its room in
 * the chat's flex row (a row class placing it won over its `position: fixed`), squeezing the
 * list to 0px wide for the flight: every row went empty, a black flash in dark mode.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function openWorkspace(page: Page, name: string, project: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

interface Seen {
  /** Frames where the chat's list was narrower than it started, or had no row in sight. */
  bad: string[];
  /** Flying copies seen, and how each was placed. */
  flights: string[];
}

/** Every frame, after it's laid out: the chat list's width and its rows in sight. */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { seen: Seen };
    w.seen = { bad: [], flights: [] };
    const list = () => document.querySelector<HTMLElement>('[data-flight-layer] [data-index]')?.parentElement?.parentElement;
    const width = list()?.clientWidth ?? 0;
    const look = () => {
      const log = list();
      if (log) {
        const box = log.getBoundingClientRect();
        const inView = [...log.querySelectorAll<HTMLElement>('[data-index]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > box.top && r.top < box.bottom;
        }).length;
        if (log.clientWidth < width || !inView) w.seen.bad.push(`width ${log.clientWidth}/${width}, ${inView} rows in sight`);
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-send-flight]')) w.seen.flights.push(getComputedStyle(el).position);
      requestAnimationFrame(() => setTimeout(look));
    };
    requestAnimationFrame(() => setTimeout(look));
  });
}

test('sending a message keeps the chat in sight while its copy flies in', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  // Something in the chat to keep in sight first.
  await composer(page).fill('walk the codebase and tell me what is risky');
  await composer(page).press('Enter');
  await expect(page.locator('[data-working]')).toHaveCount(1);
  await expect(page.locator('[data-working]')).toHaveCount(0, { timeout: 60_000 });

  await watchFrames(page);
  await composer(page).fill('say hello to me');
  await composer(page).press('Enter');
  const row = page.locator('[data-mine="true"]', { hasText: 'say hello to me' }).last();
  await expect(row).toHaveAttribute('data-flown', 'true');
  await expect(page.locator('[data-send-flight]')).toHaveCount(0);
  const seen = await page.evaluate(() => (window as unknown as { seen: Seen }).seen);
  // It flew, over the page rather than in it, and the list never narrowed or emptied.
  expect(seen.flights.length).toBeGreaterThan(0);
  expect([...new Set(seen.flights)]).toEqual(['fixed']);
  expect(seen.bad).toEqual([]);
});
