import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * The app in a phone's browser (BLG-6): one column, the sidebar a drawer, the panel a sheet, and
 * the main flows by touch at an iPhone's and an Android's size. PHONE_SHOTS=<dir> also keeps a
 * screenshot of each screen and what it measured (targets under 44px, anything cut off) there.
 */
const shots = process.env.PHONE_SHOTS;

const SIZES = [
  { name: 'iphone', width: 390, height: 844 },
  { name: 'android', width: 412, height: 915 },
] as const;

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Changes, files and info' });

/** The visible things you tap: how many, how many are under 44px, and how many run off the screen. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
      if (el.closest('[inert], [aria-hidden="true"]')) return false;
      const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
      return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
    };
    const targets = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="combobox"], input, textarea, select')].filter(seen);
    const size = (el: Element) => el.getBoundingClientRect();
    const inSideScroller = (el: Element): boolean => {
      for (let up = el.parentElement; up; up = up.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(up).overflowX) && up.scrollWidth > up.clientWidth) return true;
      }
      return false;
    };
    const small = targets.filter((el) => size(el).height < 43.5 || size(el).width < 43.5);
    return {
      targets: targets.length,
      under44: small.map((el) => `${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName} ${Math.round(size(el).width)}×${Math.round(size(el).height)}`),
      // Past the edge of a row that scrolls sideways (pills, Settings' panes) is meant: a swipe brings it in.
      cutOff: targets.filter((el) => size(el).right > vw + 1 && !inSideScroller(el)).length,
      pageWiderThanScreen: document.documentElement.scrollWidth > vw,
    };
  });
}

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    // A phone can't hover and points coarsely. Chromium's emulation still says it hovers (a real
    // iPhone's Safari showed what that hid: BLG-7), so it's told; WebKit's says so already.
    test.beforeEach(async ({ page, browserName }) => {
      if (browserName !== 'chromium') return;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
    });

    test('opens a worktree from the drawer, chats in it, reads its changes, a task and what waits for you', async ({ page }) => {
      test.setTimeout(90_000);
      const report: Record<string, unknown> = {};
      const shot = async (screen: string) => {
        if (!shots) return;
        mkdirSync(shots, { recursive: true });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(shots, `${size.name}-${screen}.png`) });
        report[screen] = await measure(page);
      };

      await page.goto('/');
      // The page fills the screen; the sidebar waits in its drawer.
      const center = page.locator('[data-layout="phone"] [data-region="center"]');
      await expect(center).toBeVisible();
      expect((await center.boundingBox())?.width).toBe(size.width);
      await expect(page.locator('header').first()).toContainText('Overview');
      await expect(sidebar(page)).not.toBeInViewport();
      await shot('01-overview');

      // The drawer: open, a project, a worktree; it closes on the page it opened.
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await expect(sidebar(page)).toBeInViewport();
      await shot('02-drawer');
      await sidebar(page).getByRole('button', { name: 'bob-api' }).first().tap();
      if (await sidebar(page).isHidden().catch(() => false)) await page.getByRole('button', { name: 'Show sidebar' }).tap();
      if (!(await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).isVisible())) await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).tap();
      await expect(sidebar(page)).not.toBeInViewport();
      await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
      await expect(composer(page)).toBeInViewport({ ratio: 1 });
      await shot('03-worktree');

      // Chat: type, send, Claude's run comes back.
      await composer(page).tap();
      await composer(page).fill('Add a health check endpoint');
      await composer(page).press('Enter');
      await expect(page.getByText('Add a health check endpoint').last()).toBeVisible();
      await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 30_000 });
      await shot('04-chat');

      // The panel is a sheet over the page: its changes, a file's diff, then Close.
      await page.getByRole('button', { name: /Show the panel/ }).tap();
      await expect(sheet(page)).toBeInViewport();
      const panel = page.getByRole('complementary', { name: 'Panel' });
      await panel.getByRole('tab', { name: 'Changes' }).tap();
      await panel.getByRole('option', { name: /auth\.ts/ }).tap();
      await expect(panel.getByRole('region', { name: 'Changes in auth.ts' }).getByText('requireUser').first()).toBeVisible();
      // A + on every line would cover the code: commenting on a line is the desktop's.
      await expect(panel.getByRole('button', { name: /^Comment on line/ }).first()).toBeHidden();
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
      await shot('05-diff');
      await sheet(page).getByRole('button', { name: 'Close the panel' }).tap();
      await expect(sheet(page)).not.toBeInViewport();

      // What waits for you (NeedsYou): the bell.
      await page.getByRole('button', { name: /^Notifications/ }).tap();
      await expect(page.getByRole('dialog', { name: 'Notifications' }).or(page.locator('[aria-label="Notifications"][role="dialog"], [aria-label="Notifications"]').last())).toBeVisible();
      await shot('06-needs-you');
      await page.keyboard.press('Escape');

      // A task's page, from Work.
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await sidebar(page).getByRole('button', { name: 'Work', exact: true }).tap();
      await expect(sidebar(page)).not.toBeInViewport();
      await shot('07-tasks');
      await page.getByRole('row').filter({ hasText: 'Rate-limit the login' }).first().tap();
      await expect(page.getByRole('region', { name: 'Goal' })).toBeVisible();
      await shot('08-task');

      // The room's chat.
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await sidebar(page).locator('[data-room-chat]').tap();
      await expect(page.getByText('hey! just pushed my API notes')).toBeVisible();
      await shot('09-group-chat');

      if (shots) writeFileSync(path.join(shots, `${size.name}-audit.json`), `${JSON.stringify(report, null, 2)}\n`);
    });

    // BLG-8: every other page fits the screen too, nothing you tap off its edge or under 44px.
    test('the other pages fit: Sentinel, Usage, a plan, Files, Search, Settings', async ({ page }) => {
      test.setTimeout(90_000);
      const report: Record<string, Awaited<ReturnType<typeof measure>>> = {};
      const check = async (screen: string) => {
        await page.waitForTimeout(600);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, `${size.name}-${screen}.png`) });
        }
        report[screen] = await measure(page);
      };
      const fromDrawer = async (name: string | RegExp) => {
        await page.getByRole('button', { name: 'Show sidebar' }).tap();
        await sidebar(page).getByRole('button', { name, exact: typeof name === 'string' }).first().tap();
        await expect(sidebar(page)).not.toBeInViewport();
      };

      await page.goto('/');
      await expect(page.locator('[data-layout="phone"]')).toBeVisible();

      await fromDrawer(/^Sentinel/);
      await check('10-sentinel');
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).tap();
      await expect(sidebar(page)).not.toBeInViewport();
      await check('11-usage');
      await fromDrawer(/^Card checkout for launch/);
      await check('12-plan');
      await fromDrawer(/^Files/);
      await check('13-files');
      await page.getByRole('button', { name: 'Search', exact: true }).first().tap();
      await page.keyboard.type('auth');
      await check('14-search');
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      await sidebar(page).getByRole('button', { name: 'Settings and menus' }).tap();
      await page.getByRole('menuitem', { name: /^Settings/ }).tap();
      await expect(page.getByRole('dialog').last()).toBeVisible();
      await check('15-settings');

      if (shots) writeFileSync(path.join(shots, `${size.name}-audit-more.json`), `${JSON.stringify(report, null, 2)}\n`);
      for (const [screen, m] of Object.entries(report)) {
        expect.soft(m.pageWiderThanScreen, `${screen}: the page is wider than the screen`).toBe(false);
        expect.soft(m.cutOff, `${screen}: targets run off the screen`).toBe(0);
        expect.soft(m.under44.filter((t) => !t.startsWith('Terminal input')), `${screen}: targets under 44px`).toEqual([]);
      }
    });
  });
}

test('a desktop-wide window keeps its three regions', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeInViewport();
  await expect(page.locator('[data-layout="phone"]')).toHaveCount(0);
  await expect(page.locator('[data-region="center"]')).toBeVisible();
  // The toolbar keeps back and forward (a phone leaves them to the browser).
  await expect(page.getByRole('group', { name: 'Back and forward' })).toBeVisible();
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-overview.png') });
});
