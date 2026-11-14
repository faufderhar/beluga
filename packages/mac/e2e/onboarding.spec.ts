import { expect, test } from './fixtures.js';

/** The first-run welcome (src/onboarding): it shows once, its settings apply, and it stays gone. */

test.use({ storageState: { cookies: [], origins: [] } });

test('a fresh install walks through the welcome, picks a look, and never sees it again', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await expect(welcome).toBeVisible();
  // The beluga opens the welcome, and comes back on the last step.
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  // Your agents (BLG-507, its own spec: onboarding-agents.spec.ts), then the tour.
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Work on everything at once.' })).toBeVisible();

  // Skip Tour goes straight to the look.
  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  await welcome.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // A theme for the look (BLG-696): the dark ones show, and one picked repaints the window at once.
  const themes = welcome.getByRole('radiogroup', { name: 'Dark theme' });
  await expect(themes.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');
  await themes.getByRole('radio', { name: 'OLED Black' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'oled');
  await expect(welcome.getByText('OLED Black', { exact: true })).toBeVisible();
  if (process.env.THEME_SHOTS) await page.waitForTimeout(1200);
  if (process.env.THEME_SHOTS) await page.screenshot({ path: `${process.env.THEME_SHOTS}/03-onboarding-oled.png` });
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // Another terminal's look (BLG-212): skippable, Beluga's own until you pick one.
  await expect(welcome.getByRole('heading', { name: 'Coming from another terminal?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The fire: it starts on Arcade, a box to try it in, and None is right there.
  const fire = (): Promise<{ preset: string; show: string; typing: string }> => page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').maxFire);
  await expect(welcome.getByRole('heading', { name: 'Set your words on fire.' })).toBeVisible();
  await expect(welcome.getByRole('radio', { name: 'Arcade' })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('textbox', { name: 'Try the fire' }).fill('Hello');
  await welcome.getByRole('radio', { name: 'Ghost' }).click();
  await expect.poll(async () => (await fire()).preset).toBe('ghost');
  await welcome.getByRole('radio', { name: 'None' }).click();
  await expect.poll(async () => (await fire()).show).toBe('off');
  await expect(welcome.getByRole('radio', { name: 'Everywhere' })).toHaveCount(0);
  await welcome.getByRole('radio', { name: 'Arcade' }).click();
  await expect.poll(async () => (await fire()).typing).toBe('pixels');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The settings apply as they're changed.
  await welcome.getByRole('radio', { name: '⌘ Return' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').sendWith)).toBe('cmd-enter');
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The permissions (BLG-101): one a step, each optional; the button opens its pane.
  await expect(welcome.getByRole('heading', { name: 'Let your agent see your screen.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Allow in System Settings' }).click();
  await expect.poll(() => page.evaluate(() => window.__BELUGA_PRIVACY_CALLS__ ?? [])).toEqual(['screen']);
  await welcome.getByRole('button', { name: 'Not Now', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Let your agent use your other apps.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Skip Permissions' }).click();

  // On-screen popups (BLG-9): a sample shows on the pop-up, and notifications are asked for.
  await expect(welcome.getByRole('heading', { name: 'Never miss it when your agent needs you.' })).toBeVisible();
  await expect(welcome.getByRole('switch', { name: 'Show on-screen popups when something needs me' })).toHaveAttribute('aria-checked', 'true');
  const popup = await page.context().newPage();
  await popup.goto('/popup.html');
  await page.bringToFront();
  await welcome.getByRole('button', { name: 'Show Me a Sample' }).click();
  await expect(popup.getByTestId('request-popup-card')).toHaveCount(2, { timeout: 10_000 });
  await popup.close();
  await welcome.getByRole('button', { name: 'Allow Notifications' }).click();
  await expect(welcome.getByRole('button', { name: 'Asked' })).toBeDisabled();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // The phone app: Android for now, and the real Pair a Phone….
  await expect(welcome.getByRole('heading', { name: 'Your agent in your pocket.' })).toBeVisible();
  await expect(welcome.getByText('Android only for now')).toBeVisible();
  await expect(welcome.getByRole('button', { name: /Pair a Phone/ })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // Usage statistics (BLG-922), the last setting: Limited picked, and Finish keeps it.
  await expect(welcome.getByRole('heading', { name: 'Help make Beluga better.' })).toBeVisible();
  await expect(welcome.getByRole('radio', { name: /Limited/ })).toBeChecked();
  await welcome.getByRole('radio', { name: /^On/ }).check();
  await expect(welcome.getByRole('radio', { name: /^On/ })).toBeChecked();
  await welcome.getByRole('radio', { name: /Limited/ }).check();
  await welcome.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();

  await welcome.getByRole('button', { name: /Open Beluga|Look Around First/ }).click();
  await expect(welcome).toHaveCount(0);
  const mark = await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.onboarding.v1') ?? '{}').how);
  expect(mark).toBe('finished');

  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test('Skip Setup leaves at once, and the palette brings the welcome back', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: 'Skip Setup' }).click();
  await expect(welcome).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.onboarding.v1') ?? '{}').how)).toBe('skipped');

  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Onboard Again');
  await page.keyboard.press('Enter');
  await expect(welcome).toBeVisible();
});

test('a permission macOS already allows shows as allowed, and the tour shows a real table', async ({ page }) => {
  await page.addInitScript(() => (window.__BELUGA_PRIVACY__ = { screen: 'granted' }));
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  // Your agents, then the tour's first two.
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  // The table weave: Claude picks Postgres, connects, and the answer is a table that sorts.
  await expect(welcome.getByRole('heading', { name: 'Answers you can sort, not just read.' })).toBeVisible();
  const table = welcome.getByRole('table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await table.getByRole('button', { name: 'MRR' }).click();
  await expect(table.locator('tbody tr').first()).toContainText('Globex');

  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  // The look, another terminal's look, the fire, the defaults.
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Set your words on fire.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByText('Allowed', { exact: true })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});

test('the tour explains Sentinel: a sentence becomes a sentinel, then real ones at work', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  for (const heading of ['Work on everything at once.', 'See every agent work. Steer any of them.', 'Answers you can sort, not just read.', 'Your app here. The work on any computer.', 'Your agent, and your friends’ agents.']) {
    await expect(welcome.getByRole('heading', { name: heading })).toBeVisible();
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  }

  // A sentence becomes a sentinel: its trigger, its steps, its access; the names pick another.
  await expect(welcome.getByRole('heading', { name: 'Say when. Say what. Beluga keeps watch.' })).toBeVisible();
  await expect(welcome.getByText('Every day at 7:00')).toBeVisible();
  await welcome.getByRole('tab', { name: 'Site watch' }).click();
  await expect(welcome.getByText('When example.com stops answering')).toBeVisible();
  await expect(welcome.getByText('Run a script')).toBeVisible();
  await expect(welcome.getByText('Call a service')).toBeVisible();
  await expect(welcome.getByText('Back up', { exact: true })).toBeVisible({ timeout: 10_000 });
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // Sentinel at work: its page's films, each with the sentence that sets it up.
  await expect(welcome.getByRole('heading', { name: 'Real work, done while you sleep.' })).toBeVisible();
  await welcome.getByRole('tab', { name: 'Failing tests' }).click();
  await expect(welcome.getByText('When the tests break, your agent fixes them and asks you to merge')).toBeVisible();
  await expect(welcome.getByText(/When the tests fail on GitHub for one of my projects/)).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Know what every project earns.' })).toBeVisible();
});

test('the tour’s table opens in a full window over the welcome, and Continue still goes on after it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Get Started/ }).click();
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  // Your agents, then the tour's first two steps, then the table.
  for (let i = 0; i < 3; i++) await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  const table = welcome.getByRole('figure', { name: /Churned last month/ });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await table.hover();
  await table.getByRole('button', { name: 'Open in Full Window' }).click();
  // Over the welcome, not hidden under it (where its modal took every click, Continue's too).
  const full = page.getByRole('dialog', { name: 'Churned last month' });
  await expect(full).toBeVisible();
  // (Under it, it's hidden yet still takes the clicks: Continue's spot lands on the hidden table.)
  const z = async (el: typeof full): Promise<number> => Number(await el.evaluate((e) => getComputedStyle(e).zIndex));
  expect(await z(full)).toBeGreaterThan(await z(page.locator('[data-welcome]')));
  await full.getByRole('button', { name: 'Close' }).click();
  await expect(full).toHaveCount(0);
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(table).toHaveCount(0);
});
