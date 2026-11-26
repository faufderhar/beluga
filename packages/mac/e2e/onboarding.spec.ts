import { expect, test } from './fixtures.js';

/** The first-run welcome (src/onboarding): it shows once, its settings apply, and it stays gone. */

test.use({ storageState: { cookies: [], origins: [] } });

test('a fresh install walks through the welcome, picks a look, and never sees it again', async ({ page }) => {
  // The whole welcome, then a reload. The 45s default runs out on a busy CI Mac before the sidebar is back.
  test.setTimeout(90_000);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await expect(welcome).toBeVisible();
  // At launch it covers the window from its first frame: no fade-in for the app to show through.
  expect(await welcome.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // The beluga opens the welcome, and comes back on the last step.
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();
  await welcome.getByRole('button', { name: /Set Up Beluga/ }).click();
  // Your agents (BLG-507, its own spec: onboarding-agents.spec.ts), then the tour.
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Run several tasks at the same time.' })).toBeVisible();

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

  // The fire (BLG-989): the pixel fire and the flame side by side, the default (Flame) picked,
  // typing in a box picks it, the switch turns it off, and Settings › Fire & Confetti is a click away.
  const fire = (): Promise<{ preset: string; show: string; typing: string }> => page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').maxFire);
  await expect(welcome.getByRole('heading', { name: 'Pick a fire for your message box.' })).toBeVisible();
  await expect(welcome.getByRole('radio', { name: /^Flame/ })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('textbox', { name: 'Try the Pixel fire' }).fill('Hello');
  await expect.poll(async () => (await fire()).preset).toBe('arcade');
  await expect(welcome.getByRole('radio', { name: /^Pixel/ })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('switch', { name: 'Fire around the message box' }).click();
  await expect.poll(async () => (await fire()).show).toBe('off');
  await expect(welcome.getByRole('radio', { name: 'Always' })).toHaveCount(0);
  await welcome.getByRole('radio', { name: /^Pixel/ }).click();
  await expect.poll(async () => (await fire()).typing).toBe('pixels');
  // While Typing: the same fire, burning only as you type (BLG-989).
  await welcome.getByRole('radio', { name: 'While Typing' }).click();
  await expect.poll(async () => (await fire()).show).toBe('typing');
  await expect(welcome.getByRole('radio', { name: /^Pixel/ })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('radio', { name: /^Flame/ }).click();
  await expect.poll(async () => (await fire()).preset).toBe('hades');
  await expect.poll(async () => (await fire()).show).toBe('typing');
  await welcome.getByRole('radio', { name: 'On Max Only' }).click();
  await expect.poll(async () => (await fire()).show).toBe('always');
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
  await expect(welcome.getByRole('heading', { name: 'Know when your agent needs you.' })).toBeVisible();
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
  await expect(welcome.getByRole('heading', { name: 'Follow your agents from your phone.' })).toBeVisible();
  await expect(welcome.getByText('Android only for now')).toBeVisible();
  await expect(welcome.getByRole('button', { name: /Pair a Phone/ })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();

  // Usage statistics (BLG-922), the last setting, with a privacy notice. It shows the level chosen before, and none
  // for an install that never chose (Finish with none is Off). The demo has chosen Essential unless BELUGA_DEMO_ASKS=telemetry.
  await expect(welcome.getByRole('heading', { name: 'Help make Beluga better.' })).toBeVisible();
  const unchosen = process.env.BELUGA_DEMO_ASKS === 'telemetry';
  for (const level of [/^Off/, /^On/]) await expect(welcome.getByRole('radio', { name: level })).not.toBeChecked();
  await expect(welcome.getByRole('radio', { name: /Essential/ })).toBeChecked({ checked: !unchosen });
  await expect(welcome.getByRole('button', { name: 'Privacy notice' })).toBeVisible();
  await welcome.getByRole('radio', { name: /^On/ }).check();
  await expect(welcome.getByRole('radio', { name: /^On/ })).toBeChecked();
  await welcome.getByRole('radio', { name: /Essential/ }).check();
  await welcome.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(welcome.getByRole('img', { name: 'Beluga' })).toBeVisible();

  await welcome.getByRole('button', { name: /Open Beluga|Look Around First/ }).click();
  await expect(welcome).toHaveCount(0);
  const mark = await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.onboarding.v1') ?? '{}').how);
  expect(mark).toBe('finished');

  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(welcome).toHaveCount(0);

  // The level picked in the welcome stands after it closes: closing sends Off only when nothing was picked here.
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Search settings' }).fill('usage statistics');
  await page.keyboard.press('Enter');
  await expect(settings.getByRole('combobox', { name: 'Share usage statistics' })).toContainText('Essential');
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
  await welcome.getByRole('button', { name: /Set Up Beluga/ }).click();
  // Your agents, then the tour's first two (worktrees, Scratch).
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  // The table weave: Claude picks Postgres, connects, and the answer is a table that sorts.
  await expect(welcome.getByRole('heading', { name: 'Ask about your data and get a table back.' })).toBeVisible();
  const table = welcome.getByRole('table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await table.getByRole('button', { name: 'MRR' }).click();
  await expect(table.locator('tbody tr').first()).toContainText('Globex');

  await welcome.getByRole('button', { name: 'Skip Tour' }).click();
  // The look, another terminal's look, the fire, the defaults.
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Pick a fire for your message box.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByText('Allowed', { exact: true })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});

test('the tour can be played with: Scratch, a friend’s agent, a shared session and Sentinel (BLG-989)', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Set Up Beluga/ }).click();
  await expect(welcome.getByRole('heading', { name: 'Which agent is yours?' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  const next = (): Promise<void> => welcome.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(welcome.getByRole('heading', { name: 'Run several tasks at the same time.' })).toBeVisible();
  await next();

  // Scratch: files land while the agent works, and one opens.
  await expect(welcome.getByRole('heading', { name: 'Watch screenshots and logs arrive as your agent works.' })).toBeVisible();
  await welcome.getByRole('radio', { name: 'Run the tests' }).click();
  await welcome.getByRole('button', { name: 'Open test-run.log' }).click();
  await expect(welcome.getByText('27 passed, 1 failed').last()).toBeVisible();
  await welcome.getByRole('button', { name: 'Close' }).click();
  await next();
  await expect(welcome.getByRole('heading', { name: 'Ask about your data and get a table back.' })).toBeVisible();
  await next();
  await expect(welcome.getByRole('heading', { name: 'Run tasks on your other computers.' })).toBeVisible();
  await next();

  // A friend's agent: pick the errand, Allow as Ada, the result comes back.
  await expect(welcome.getByRole('heading', { name: 'Your agent can ask a friend’s agent.' })).toBeVisible();
  await welcome.getByRole('radio', { name: 'A page Ada is signed in to' }).click();
  await welcome.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(welcome.getByText('staging-dashboard.png')).toBeVisible({ timeout: 10_000 });
  await next();

  // A shared session: Share, Follow, Invite; Ada joins to follow along.
  await expect(welcome.getByRole('heading', { name: 'Invite a friend into your session.' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Share' }).click();
  await welcome.getByRole('radio', { name: /^Follow/ }).click();
  await welcome.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(welcome.getByText('Ada joined to follow along')).toBeVisible();
  await next();

  // Sentinel, once: pick a use case and its run plays to a report.
  await expect(welcome.getByRole('heading', { name: 'Start work every morning, or when tests fail.' })).toBeVisible();
  await welcome.getByRole('radio', { name: /Site watch/ }).click();
  await expect(welcome.getByText('When example.com stops answering')).toBeVisible();
  await expect(welcome.getByText('Back up', { exact: true })).toBeVisible({ timeout: 10_000 });
  await next();
  await expect(welcome.getByRole('heading', { name: 'See what each project earns.' })).toBeVisible();
});

test('the tour’s table opens in a full window over the welcome, and Continue still goes on after it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Beluga' });
  await welcome.getByRole('button', { name: /Set Up Beluga/ }).click();
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
