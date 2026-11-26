import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * A project's home in a narrow window (#527: Beluga snapped beside another app). The way to start
 * (New Worktree / Just Ask / New Plan) stays one line per tab, nothing in the box spills out or sits
 * on another control, and Create Worktree stays in reach.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

async function openHome(page: Page, project = 'bob-api'): Promise<void> {
  await sidebar(page).getByText(project, { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (l: Locator): Promise<Box> => (await l.boundingBox())!;
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
const apart = (a: Box, b: Box) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;

/** How many lines a tab's words take (its text, not the icon). */
const linesOf = (tab: Locator) =>
  tab.evaluate((el) => {
    const tops = new Set<number>();
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top));
    }
    return tops.size;
  });

// The narrowest window (860, what Windows Snap holds it to beside another app) and one a little wider; then
// the page itself narrower still, as a wide right panel beside it makes it (the page follows its own width).
const cases: Array<{ window: number; page?: number; text?: number; branch?: string }> = [
  // A wide page: the box stops at the column's width (60 of the text size), so it's the box's width that counts, at every text size.
  { window: 1900 },
  { window: 1900, text: 15 },
  { window: 1900, text: 17 },
  { window: 1440, text: 11 },
  // A long branch to start from: it gives way after the name, cut short, never over it.
  { window: 1900, branch: 'feat/live-topic-graph' },
  { window: 860 },
  { window: 960 },
  { window: 1440, page: 520 },
  { window: 1440, page: 420 },
  { window: 1440, page: 340 },
  { window: 1440, page: 300 },
];
for (const c of cases) {
  const what = (c.page ? `a ${c.page}px page` : `a ${c.window}px window`) + (c.text ? ` at ${c.text}px text` : '') + (c.branch ? ` based on ${c.branch}` : '');
  test(`the home's controls keep their shape in ${what} (#527)`, async ({ page }) => {
    await page.setViewportSize({ width: c.window, height: 820 });
    if (c.text) await page.addInitScript((size) => localStorage.setItem('beluga.prefs.v1', JSON.stringify({ textSize: size })), c.text);
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    await openHome(page);
    if (c.page) await page.addStyleTag({ content: `[aria-label="bob-api home"] { flex: 0 0 ${c.page}px !important; max-width: ${c.page}px; }` });
    const section = page.getByRole('region', { name: 'Start something' });
    // The demo's projects start from origin/main: the pop-up shows a longer name in its place.
    if (c.branch)
      await section.getByRole('combobox', { name: 'Based on' }).evaluate((el, name) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes('main')) n.textContent = name;
      }, c.branch);
    const page_ = await boxOf(page.getByRole('main'));
    const composer = await boxOf(section);

    // The tabs: each label on one line, the row inside the page.
    const tabs = section.getByRole('tablist', { name: 'How to start' });
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    expect(inside(await boxOf(tabs), composer)).toBe(true);
    for (const name of ['New Worktree', 'Just Ask', 'New Plan']) {
      const tab = tabs.getByRole('tab', { name });
      await expect(tab).toBeVisible();
      expect(await linesOf(tab), `${name} on one line`).toBe(1);
      expect((await boxOf(tab)).height).toBeLessThanOrEqual(26);
    }

    // The box's controls: in the box, none on top of another, Create Worktree in reach.
    const box = await boxOf(page.getByLabel('Task for the new worktree').locator('xpath=ancestor::div[contains(@class, "box")][1]'));
    const controls = [
      section.getByRole('combobox', { name: 'Based on' }),
      section.getByRole('textbox', { name: 'Worktree name' }),
      section.getByRole('combobox', { name: 'Then' }),
      section.getByRole('button', { name: 'Speak instead of typing' }),
      section.getByRole('button', { name: /^Create Worktree/ }),
    ];
    const boxes: Box[] = [];
    for (const c of controls) {
      await expect(c).toBeVisible();
      const b = await boxOf(c);
      expect(inside(b, box), `${await c.evaluate((el) => el.getAttribute('aria-label') ?? el.textContent)} inside the box`).toBe(true);
      expect(b.width).toBeGreaterThan(20);
      boxes.push(b);
    }
    // The fields' words (Based on, Name, Then) when they show: each beside its own control, never on another.
    for (const label of await section.locator('label > span:first-child').all()) {
      if (!(await label.isVisible())) continue;
      const b = await boxOf(label);
      expect(inside(b, box), `${await label.textContent()} inside the box`).toBe(true);
      boxes.push(b);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(apart(boxes[i]!, boxes[j]!), `controls ${i} and ${j} apart`).toBe(true);
    expect(inside(composer, page_)).toBe(true);

    // Just Ask and New Plan's lines too: the button stays in the box.
    for (const [tab, button] of [['Just Ask', /^Ask/], ['New Plan', /^Plan with/]] as const) {
      await tabs.getByRole('tab', { name: tab }).click();
      const b = await boxOf(section.getByRole('button', { name: button }));
      expect(inside(b, box), `${tab}'s button inside the box`).toBe(true);
      if (process.env.BELUGA_SHOTS) await section.screenshot({ path: `${process.env.BELUGA_SHOTS}/home-narrow-${c.page ?? c.window}-${tab.replace(' ', '-').toLowerCase()}.png` });
    }
    await tabs.getByRole('tab', { name: 'New Worktree' }).click();
    if (process.env.BELUGA_SHOTS) await section.screenshot({ path: `${process.env.BELUGA_SHOTS}/home-narrow-${c.page ?? c.window}${c.text ? `-${c.text}` : ''}${c.branch ? '-long-branch' : ''}.png` });
  });
}
