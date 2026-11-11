import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/** Plans (docs/tasks-and-plans.md): the demo's plan as a graph and an outline, a new plan drafted with Claude and approved onto the board, and the composer's Plan with Tasks. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function openPlans(page: Page): Promise<void> {
  await page.goto('/');
  await openWork(page, 'Plans');
  const project = page.getByRole('button', { name: /^Project: / });
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await project.click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('the demo’s plan: milestones as a living graph, a task’s details, the outline', async ({ page }) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  // The first milestone passed; the second runs; a task waits on another.
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Test-mode foundations' })).toContainText('Passed');
  const receipts = main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' });
  await expect(receipts).toContainText('Waiting');
  // Each milestone ends in its criteria, and a line runs from them to the milestones that wait on it (KLD-63).
  const criteria = main(page).locator('[data-criteria]');
  await expect(criteria).toHaveCount(3);
  await expect(main(page).locator('[data-criteria="foundations"]')).toContainText('Passed');
  // No criterion is ticked on its own (Claude's check judges them together): plain bullets, and one state on the node.
  // An unchecked milestone says "Not yet" and claims none of its criteria are met (KLD-67).
  const refunds = main(page).locator('[data-criteria="refunds"]');
  await expect(refunds).toHaveAttribute('aria-label', /: Not yet$/);
  await expect(refunds.locator('li')).toHaveCount(2);
  await expect(main(page).locator('[data-criteria] li svg, [data-criteria] li [aria-label="Met"]')).toHaveCount(0);
  // Every card's title shows whole lines (two at most, then an ellipsis), clear of its state line, and all of it in its tooltip.
  const titles = await main(page)
    .locator('.react-flow__node-task [class*="taskTitle"]')
    .evaluateAll((els) =>
      els.map((el) => {
        const line = parseFloat(getComputedStyle(el).lineHeight);
        const foot = el.nextElementSibling!.getBoundingClientRect();
        const zoom = el.getBoundingClientRect().height / el.clientHeight;
        return { full: el.getAttribute('title') === el.textContent, lines: el.clientHeight / line, clear: el.getBoundingClientRect().bottom <= foot.top + 0.5 * zoom };
      }),
    );
  expect(titles.length).toBeGreaterThan(5);
  for (const t of titles) {
    expect(t.full).toBe(true);
    expect([1, 2]).toContain(Math.round(t.lines));
    expect(Math.abs(t.lines - Math.round(t.lines))).toBeLessThan(0.1);
    expect(t.clear).toBe(true);
  }
  const next = main(page).getByRole('group', { name: '“Safe payments” leads to “Refunds and launch”', exact: true }).locator('[data-kind="next"]');
  await expect(next).toHaveAttribute('data-from', 'gate:safe-payments');
  await expect(next).toHaveAttribute('data-to', 'm:refunds');
  await main(page).locator('[data-criteria="safe-payments"]').click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('Passes when');
  await page.keyboard.press('Escape');
  await receipts.click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Waits on');
  await expect(details).toContainText('Idempotent webhook retries');
  await details.getByRole('button', { name: 'Close' }).click();
  // The outline: the same plan, milestone by milestone.
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  await expect(page.getByRole('region', { name: 'Safe payments' })).toContainText('Add auth to the payment routes');
  await expect(page.getByRole('region', { name: 'Refunds and launch' })).toContainText('Launch checklist');
  // Side by side only with room for a name and its tasks: never squeezed under 400 px, they wrap instead.
  for (const name of ['Test-mode foundations', 'Safe payments']) expect((await page.getByRole('region', { name }).boundingBox())!.width).toBeGreaterThanOrEqual(400);
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Canvas' }).click();
  // The conversation with the plan's Claude is beside it.
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
});

test('a milestone’s checker, off the sidebar, opens from its details and its ••• menu (BLG-634)', async ({ page }, info) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  // Its checker's chat is folded into the plan: never a row of its own in the sidebar.
  await expect(sidebar(page).getByText('Check: Test-mode foundations')).toHaveCount(0);
  // Passed, it's folded: unfolded first, then its criteria open its details.
  const fold = main(page).getByRole('button', { name: 'Fold Test-mode foundations' });
  if (!(await fold.isVisible())) await main(page).locator('[data-criteria="foundations"]').click();
  await expect(fold).toBeVisible();
  await main(page).locator('[data-criteria="foundations"]').click();
  const details = page.getByRole('complementary', { name: 'Details' });
  const open = details.getByRole('button', { name: 'Open the Check' });
  await expect(open).toBeVisible();
  const shot = info.outputPath('open-the-check.png');
  await details.screenshot({ path: shot });
  await info.attach('open the check', { path: shot, contentType: 'image/png' });
  await open.click();
  await expect(main(page)).toContainText('Both pass criteria hold', { timeout: 15_000 });
  const chat = info.outputPath('checker-chat.png');
  await page.screenshot({ path: chat });
  await info.attach('the checker’s chat', { path: chat, contentType: 'image/png' });
  // Its gate's state on the canvas opens it too.
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await main(page).locator('[data-criteria="foundations"]').getByRole('button', { name: 'Passed: Open the Check' }).click();
  await expect(main(page)).toContainText('Both pass criteria hold', { timeout: 15_000 });
  // The outline's ••• menu has it too.
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  await page.getByRole('button', { name: 'Test-mode foundations Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open the Check' })).toBeVisible();
  await page.keyboard.press('Escape');
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Canvas' }).click();
});

test('a milestone itself opens its details: its tasks in its agent’s order, each a click from its own (BLG-688)', async ({ page }, info) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const box = main(page).locator('.react-flow__node-milestone').filter({ hasText: 'Safe payments' });
  // Its header (not a card, not its gate) is the milestone.
  await box.getByText('Safe payments', { exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Safe payments');
  const tasks = details.getByRole('region', { name: 'Its tasks' });
  await expect(tasks).toContainText('Add auth to the payment routes');
  await expect(box.locator('[data-milestone="safe-payments"]')).toHaveClass(/msSelected/);
  await main(page).screenshot({ path: info.outputPath('milestone-picked.png') });
  await tasks.getByRole('button', { name: /Receipt emails sent once/ }).click();
  await expect(details).toContainText('Waits on');
  await details.getByRole('button', { name: 'Close' }).click();
});

test('opening a passed milestone opens its box in the same frame: never an open header in a folded box', async ({ page }, info) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const box = main(page).locator('.react-flow__node-milestone').filter({ hasText: 'Test-mode foundations' });
  const show = box.getByRole('button', { name: /passed\. Show its/ });
  await expect(show).toBeVisible();
  const folded = parseFloat((await box.evaluate((el) => (el as HTMLElement).style.height)) || '0');
  // Every frame from the click on: never the open header (its Fold button) in a box still one row tall.
  const frames = box.evaluate(
    (el) =>
      new Promise<Array<{ open: boolean; height: number }>>((done) => {
        const seen: Array<{ open: boolean; height: number }> = [];
        const look = (): void => {
          seen.push({ open: !!el.querySelector('[aria-expanded="true"]'), height: parseFloat((el as HTMLElement).style.height) });
          if (seen.length < 40) requestAnimationFrame(look);
          else done(seen);
        };
        el.querySelector<HTMLElement>('[aria-expanded="false"]')!.click();
        look();
      }),
  );
  const seen = await frames;
  expect(seen.some((f) => f.open)).toBe(true);
  expect(seen.filter((f) => f.open && f.height < folded + 100)).toEqual([]);
  // Settled: its task and its gate show whole.
  await expect(main(page).locator('.react-flow__node-task').filter({ hasText: 'Stripe test-mode fixtures' })).toBeVisible();
  const shot = info.outputPath('unfolded.png');
  await main(page).locator('.react-flow').screenshot({ path: shot });
  await info.attach('unfolded', { path: shot, contentType: 'image/png' });
});

test('folding a milestone moves its lines with it, every frame, and no box is stretched past its own gate', async ({ page }, info) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const box = main(page).locator('.react-flow__node-milestone').filter({ hasText: 'Test-mode foundations' });
  await expect(box.getByRole('button', { name: /passed\. Show its/ })).toBeVisible();
  // Opening it narrows its box, so the milestone beside it slides over. Each frame from the click: where
  // that one's line leaves (the path's first point) against the middle of its box's foot as drawn then.
  type Frame = { x: number; y: number; lineX: number; lineY: number };
  const frames = await box.evaluate(
    (el) =>
      new Promise<Frame[]>((done) => {
        const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="m:safe-payments"]')!;
        const line = (): SVGPathElement | null => document.querySelector('g[data-from="gate:safe-payments"] path.react-flow__edge-path');
        const seen: Frame[] = [];
        const look = (): void => {
          const css = getComputedStyle(node);
          const at = new DOMMatrix(css.transform);
          const start = /^M\s*([-\d.]+)[ ,]([-\d.]+)/.exec(line()?.getAttribute('d') ?? '');
          seen.push({ x: at.m41 + parseFloat(css.width) / 2, y: at.m42 + parseFloat(css.height), lineX: start ? parseFloat(start[1]!) : NaN, lineY: start ? parseFloat(start[2]!) : NaN });
          if (seen.length < 50) requestAnimationFrame(look);
          else done(seen);
        };
        el.querySelector<HTMLElement>('[aria-expanded="false"]')!.click();
        requestAnimationFrame(look);
      }),
  );
  // It moved (the glide ran), and its line stayed on its foot all the way (within the gate's inset), never
  // jumping ahead. Where a frame's read falls against the line's step and the box's transition varies, so
  // the line may show the box a frame early or late: it must sit between the box's frames either side.
  const first = frames[0]!;
  const last = frames.at(-1)!;
  expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(50);
  const within = (v: number, a: number, b: number): boolean => v >= Math.min(a, b) - 2 && v <= Math.max(a, b) + 2;
  const off = frames.slice(1, -1).filter((f, i) => !(within(f.lineX, frames[i]!.x, frames[i + 2]!.x) && within(f.lineY, frames[i]!.y - 10, frames[i + 2]!.y - 10)));
  expect(off).toEqual([]);
  // Settled: each open box only as tall as its tasks and gate (its gate right under its last card).
  await expect(main(page).locator('.react-flow__node-task').filter({ hasText: 'Stripe test-mode fixtures' })).toBeVisible();
  await page.waitForTimeout(700);
  const room = await main(page)
    .locator('.react-flow__node-milestone')
    .evaluateAll((els) =>
      els.flatMap((el) => {
        const id = el.getAttribute('data-id') ?? '';
        const gate = document.querySelector<HTMLElement>(`.react-flow__node[data-id="gate:${id.replace(/^m:/, '')}"]`);
        if (!gate || gate.getAttribute('aria-hidden') === 'true') return [];
        const top = gate.getBoundingClientRect().top;
        const cards = [...document.querySelectorAll<HTMLElement>('.react-flow__node-task')].filter((n) => {
          const r = n.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          return r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= top;
        });
        const last = Math.max(...cards.map((n) => n.getBoundingClientRect().bottom));
        return cards.length ? [{ id, gap: top - last }] : [];
      }),
    );
  expect(room.length).toBeGreaterThan(1);
  // MILESTONE.gateGap (16) on the canvas's zoom: never a stretch of empty room.
  for (const r of room) expect(r.gap, r.id).toBeLessThan(24);
  const shot = info.outputPath('opened.png');
  await main(page).locator('.react-flow').screenshot({ path: shot });
  await info.attach('opened', { path: shot, contentType: 'image/png' });
});

test('where the plan’s work goes, one click from the canvas: main, then each milestone; the chat keeps what you typed when hidden', async ({ page }, info) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await main(page).getByRole('button', { name: /^(Branch|plan\/)/ }).click();
  const flow = page.getByRole('complementary', { name: 'Where the work goes' });
  await expect(flow).toBeVisible();
  const steps = flow.getByRole('list', { name: 'Where the work goes' }).getByRole('listitem');
  await expect(steps.first()).toContainText('main');
  await expect(flow).toContainText('Test-mode foundations');
  await expect(flow).toContainText('Refunds and launch');
  // Each step's state is one word on one line, however long the name beside it.
  const tall = await steps.evaluateAll((items) => items.map((li) => li.querySelector('span > span > span:last-child')!).filter((s) => s.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(s).fontSize)).map((s) => s.textContent));
  expect(tall).toEqual([]);
  const shot = info.outputPath('branch-flow.png');
  await main(page).screenshot({ path: shot });
  await info.attach('where the work goes', { path: shot, contentType: 'image/png' });
  // Hidden and shown again: what you typed is still there.
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  if (!(await chat.isVisible())) await main(page).getByRole('button', { name: 'Open Orchestrator' }).click();
  const box = chat.getByRole('textbox').first();
  await box.fill('half a thought about refunds');
  await main(page).getByRole('button', { name: 'Hide Orchestrator' }).click();
  await expect(chat).toHaveCount(0);
  await main(page).getByRole('button', { name: 'Open Orchestrator' }).click();
  await expect(chat.getByRole('textbox').first()).toHaveValue('half a thought about refunds');
});

test('the plan’s chat shows what was said there when the plan opens, after a reload too, without sending anything (KLD-53)', async ({ page }) => {
  // The demo saved how its plan began without loading it, as a restarted daemon has it: only on disk.
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await expect(chat).toContainText('drafted the plan in three milestones', { timeout: 15_000 });
  await expect(chat).not.toContainText('Plan it together');
  // A fresh window (a reload opens on the Overview, as every reload does) loads it again from the daemon.
  await page.reload();
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch', { timeout: 20_000 });
  await expect(chat).toContainText('drafted the plan in three milestones', { timeout: 15_000 });
  await expect(chat.getByRole('textbox', { name: 'Message your agent about the plan' })).toHaveValue('');
});

test('a task’s panel keeps its head and Close in reach while its brief scrolls, and nothing runs off its edge (KLD-32)', async ({ page }, info) => {
  // Short enough that the brief has to scroll.
  await page.setViewportSize({ width: 1180, height: 560 });
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  // Only real lines: a gate leads to a milestone only when it waits on it, and no card is wired across milestones.
  const edge = (from: string, to: string) => main(page).getByRole('group', { name: `Edge from ${from} to ${to}`, exact: true });
  await expect(main(page).getByRole('group', { name: '“Safe payments” leads to “Refunds and launch”', exact: true })).toHaveCount(1);
  await expect(main(page).getByRole('group', { name: /^“Test-mode foundations” leads to/ })).toHaveCount(0);
  // Milestones that run side by side make the plan wide: room for it (the conversation folded away), all of it in view.
  await main(page).getByRole('button', { name: 'Hide Orchestrator' }).click();
  await main(page).getByRole('button', { name: 'Fit to View' }).click();
  // Fit frames every milestone tightly: 48 px above (the view switch sits there), and no more than that on the side that limits it (KLD-67).
  // Waited for, not slept on: the fit animates, so it's read until it frames them that way.
  const gapsOf = () =>
    main(page).evaluate((root) => {
      const pane = root.querySelector('.react-flow')!.getBoundingClientRect();
      const boxes = [...root.querySelectorAll('.react-flow__node-milestone')].map((n) => n.getBoundingClientRect());
      return { top: Math.min(...boxes.map((b) => b.top)) - pane.top, left: Math.min(...boxes.map((b) => b.left)) - pane.left, right: pane.right - Math.max(...boxes.map((b) => b.right)), bottom: pane.bottom - Math.max(...boxes.map((b) => b.bottom)) };
    });
  await expect
    .poll(async () => {
      const gaps = await gapsOf();
      return Object.values(gaps).every((gap) => gap >= -1) && gaps.top <= 49 && ((gaps.left <= 49 && gaps.right <= 49) || gaps.bottom <= 49);
    })
    .toBe(true);
  await main(page).locator('.react-flow__node').filter({ hasText: 'Refund endpoint' }).click();
  await expect(edge('t:retries', 't:refund-api')).toHaveCount(0);
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Idempotent webhook retries' }).locator('[data-linked="true"]')).toHaveCount(1);
  // The panel covers part of the plan: closed before picking another card.
  await page.keyboard.press('Escape');
  await main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' }).click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Waits on');
  const body = details.locator('header + div');
  const close = details.getByRole('button', { name: 'Close' });
  const sizes = () => body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, wide: el.scrollWidth, width: el.clientWidth }));
  expect((await sizes()).scroll).toBeGreaterThan((await sizes()).client);
  await expect(details.locator('header')).toHaveAttribute('data-scrolled', 'false');
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(details.locator('header')).toHaveAttribute('data-scrolled', 'true');
  // At the bottom: the key, the title, the state and Close are all still on screen.
  await expect(details.getByRole('heading', { name: 'Receipt emails sent once' })).toBeInViewport();
  await expect(close).toBeInViewport();
  await expect(details.getByText('src/webhooks/paid.ts').first()).toBeInViewport();
  // Nothing wider than the panel: paths and words wrap.
  const s = await sizes();
  expect(s.wide).toBeLessThanOrEqual(s.width);
  const shot = info.outputPath('panel-scrolled.png');
  await details.screenshot({ path: shot });
  await info.attach('panel scrolled to the bottom', { path: shot, contentType: 'image/png' });
  await close.click();
  await expect(details).toHaveCount(0);
  // Esc closes it too.
  await main(page).locator('.react-flow__node').filter({ hasText: 'Receipt emails sent once' }).click();
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
});

test('the plan stays sharp zoomed in, and its name never clips (KLD-25)', async ({ page }, info) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const name = page.getByRole('textbox', { name: 'Plan name' });
  const fits = () => name.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  // Descenders show whole: the box is as tall as its line.
  await name.fill('Typography query');
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue('Typography query');
  const one = await fits();
  expect(one.scroll).toBeLessThanOrEqual(one.client);
  expect(one.client).toBeGreaterThanOrEqual(Math.ceil(19 * 1.3));
  // A long name wraps onto a second line instead of being cut, and Enter still saves it.
  const long = 'Typography query for every plan page, pill, outline heading, and the sidebar groups that hold them all';
  await name.fill(long);
  await name.press('Enter');
  await expect(name).toHaveValue(long);
  const two = await fits();
  expect(two.scroll).toBeLessThanOrEqual(two.client);
  expect(two.client).toBeGreaterThan(one.client * 1.5);
  await name.fill('Card checkout for launch');
  await name.press('Enter');
  await expect(name).toHaveValue('Card checkout for launch');

  // Zoomed in, the view is redrawn once it settles, with nothing blurred inside it.
  const viewport = main(page).locator('.react-flow__viewport');
  const scale = async () => Number(/scale\(([\d.]+)\)/.exec((await viewport.getAttribute('style')) ?? '')?.[1] ?? 0);
  for (let i = 0; i < 12 && (await scale()) < 1.5; i++) {
    const before = await scale();
    await main(page).getByRole('button', { name: 'Zoom In' }).click();
    // Each zoom animates: the next click waits for it to settle (bigger, and no longer moving).
    let last = -1;
    await expect
      .poll(async () => {
        const now = await scale();
        const settled = now > before && now === last;
        last = now;
        return settled;
      }, { intervals: [100] })
      .toBe(true);
  }
  expect(await scale()).toBeGreaterThanOrEqual(1.5);
  // What matters once the zoom settles: the view was redrawn at its scale, and it's left a plain 2D
  // transform (no 3D layer kept around), whatever frames the zoom's own animation took (KLD-36).
  const settled = async () => {
    const style = (await viewport.getAttribute('style')) ?? '';
    return { sharpened: /^\d+$/.test((await viewport.getAttribute('data-sharpened')) ?? ''), nudged: style.includes('translateZ'), zoomed: (await scale()) >= 1.5 };
  };
  await expect.poll(settled, { timeout: 5_000 }).toEqual({ sharpened: true, nudged: false, zoomed: true });
  const blurred = await viewport.evaluate((root) =>
    [root, ...root.querySelectorAll('*')].filter((el) => {
      const css = getComputedStyle(el);
      return css.filter !== 'none' || (css.backdropFilter ?? 'none') !== 'none' || css.willChange !== 'auto';
    }).length,
  );
  expect(blurred).toBe(0);
  const shot = info.outputPath('zoomed-canvas.png');
  await main(page).locator('.react-flow').screenshot({ path: shot });
  await info.attach('zoomed canvas', { path: shot, contentType: 'image/png' });

  // At 200% and 300% too (KLD-70): once settled, the view keeps no layer hint, sits on whole device pixels,
  // and every title shows whole lines: its last shown line (descenders included) lies inside the box.
  for (const target of [2, 3]) {
    for (let i = 0; i < 12 && (await scale()) < target - 0.05; i++) {
      await main(page).getByRole('button', { name: 'Zoom In' }).click();
      await page.waitForTimeout(260);
    }
    expect(await scale()).toBeGreaterThanOrEqual(target - 0.05);
    await expect
      .poll(() =>
        viewport.evaluate((el) => {
          const css = getComputedStyle(el);
          const [x, y] = [...el.style.transform.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]) * devicePixelRatio);
          return { willChange: css.willChange, nudged: el.style.transform.includes('translateZ'), whole: Math.abs(x - Math.round(x)) < 0.01 && Math.abs(y - Math.round(y)) < 0.01 };
        }),
      )
      .toEqual({ willChange: 'auto', nudged: false, whole: true });
    const cut = await main(page)
      .locator('.react-flow__node-task [class*="taskTitle"]')
      .evaluateAll((els) =>
        els.flatMap((el) => {
          const box = el.getBoundingClientRect();
          const zoom = box.height / el.clientHeight;
          const line = parseFloat(getComputedStyle(el).lineHeight);
          const text = document.createRange();
          text.selectNodeContents(el);
          // One rect per line fragment (the glyphs' full height, ascent to descent); keep the lines it shows.
          const rects = [...text.getClientRects()].filter((r) => r.top < box.bottom - 1);
          const lines = new Set([...text.getClientRects()].map((r) => Math.round((r.top - box.top) / zoom / line))).size;
          const problems = [];
          if (Math.max(...rects.map((r) => r.bottom)) > box.bottom + 0.5) problems.push('last line cut');
          // Not cut by more than the clamp: as tall as its lines, two at most, whatever is hidden is whole lines.
          if (Math.abs(el.clientHeight - Math.min(lines, 2) * line) > 1) problems.push(`box ${el.clientHeight} for ${lines} lines`);
          if (el.scrollHeight > lines * line + 1) problems.push(`scroll ${el.scrollHeight} for ${lines} lines`);
          return problems.length ? [`${el.textContent}: ${problems.join(', ')}`] : [];
        }),
      );
    expect(cut).toEqual([]);
  }
});

test('New Plan with no project known (⌘K) asks which project, and the title follows it', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+K');
  await page.getByPlaceholder('Go to, do, or start anything…').fill('New Plan');
  await page.getByRole('option', { name: /^New Plan/ }).first().click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  const picker = sheet.getByRole('combobox', { name: 'Project' });
  await expect(picker).toBeVisible();
  await expect(sheet.getByRole('heading', { name: `Plan in ${(await picker.textContent())!.trim()}` })).toBeVisible();
  await expect(sheet.getByLabel('Goal')).toBeFocused();
  await expect(sheet.getByRole('button', { name: 'Plan with Your Agent' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('a new plan: Claude drafts it in its own conversation, nothing is on the board until it’s approved', async ({ page }) => {
  await openPlans(page);
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  // Opened from a project: it's in the title, and there's no picker.
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await expect(sheet.getByRole('combobox', { name: 'Project' })).toHaveCount(0);
  // How it runs: three cards you read without hovering; Check-ins to start with.
  const runs = sheet.getByRole('radiogroup', { name: 'How it runs' });
  await expect(runs.getByRole('radio')).toHaveCount(3);
  await expect(runs.getByRole('radio', { name: /Check-ins/ })).toHaveAttribute('aria-checked', 'true');
  await expect(runs).toContainText('Runs, then waits for you at each milestone');
  // The goal box starts six lines tall and grows with the text.
  const goal = sheet.getByLabel('Goal');
  const start = (await goal.boundingBox())!.height;
  expect(start).toBeGreaterThanOrEqual(100);
  await goal.fill(Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join('\n'));
  expect((await goal.boundingBox())!.height).toBeGreaterThan(start + 40);
  await goal.fill('Export orders as CSV for accounting');
  await runs.getByRole('radio', { name: /Step by Step/ }).click();
  await expect(runs.getByRole('radio', { name: /Step by Step/ })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  // Its page, then Claude's draft.
  const approve = page.getByRole('button', { name: 'Approve Plan' }).first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('a draft, not on the board yet')).toBeVisible();
  // A short name written for it, not the goal's first words (KLD-36).
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Export orders accounting');
  // Written, the canvas lays it out: never left on "Laying out…" (KLD-36).
  await expect(main(page).locator('[data-ready]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(main(page).getByText('Laying out…')).toHaveCount(0);
  await expect(main(page).locator('.react-flow__node').filter({ hasText: 'Data model and migration' })).toBeVisible({ timeout: 20_000 });
  // Talk it through: Claude changes the draft.
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).fill('rate limits on the export endpoint');
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).press('Enter');
  await expect(main(page).locator('.react-flow__node').filter({ hasText: /Rate limits on the export endpoint/i })).toBeVisible({ timeout: 20_000 });
  // Not on the board yet.
  await openWork(page, 'Tasks');
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('grid', { name: 'Tasks' })).not.toContainText('Data model and migration');
  await openWork(page, 'Plans');
  await main(page).getByRole('button', { name: /^Export orders accounting,/ }).click();
  await page.getByRole('button', { name: 'Approve Plan' }).first().click();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0);
  // On the board now, each with its plan.
  await openWork(page, 'Tasks');
  await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
  // The plan is an epic in Tasks (its milestones under it, their tasks under them), all tucked away until opened out.
  await page.getByRole('button', { name: 'Show All', exact: true }).click();
  await expect(page.getByRole('grid', { name: 'Tasks' })).toContainText('Data model and migration');
});

test('the composer: Plan with Tasks makes the conversation a plan once you send', async ({ page }) => {
  await page.goto('/');
  // The demo's chat in bob-api (unfold the project when it's folded).
  const chat = sidebar(page).getByRole('button', { name: 'How do deploys work?' });
  if (!(await chat.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await chat.click();
  await page.getByRole('button', { name: /^Mode: / }).click();
  await page.getByRole('menuitem', { name: /Plan with Tasks/ }).click();
  await expect(page.getByRole('button', { name: 'Mode: Plan with Tasks' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'nothing reaches the board until you approve' })).toBeVisible();
  // Nothing sent, nothing made: still an ordinary chat in the sidebar, and every mode a click away.
  await expect(chat).toBeVisible();
  await page.getByRole('button', { name: /^Mode: / }).click();
  await page.getByRole('menuitem', { name: /^Act/ }).click();
  await expect(page.getByRole('button', { name: 'Mode: Act' })).toBeVisible();
  // ⇧⇥ goes to Plan First and back.
  const box = page.locator('main textarea:not(.xterm-helper-textarea)').last();
  await box.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Plan First' })).toBeVisible();
  await box.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Act' })).toBeVisible();
  // Sent: now it's the plan's own conversation (the chip opens the plan, or throws the draft away).
  await page.getByRole('button', { name: /^Mode: / }).click();
  await page.getByRole('menuitem', { name: /Plan with Tasks/ }).click();
  await box.fill('Export orders to accounting');
  await box.press('Enter');
  await page.getByRole('button', { name: /^Mode: / }).click();
  await expect(page.getByRole('menuitem', { name: 'Open the Plan' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Act/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a running plan sits under Plans in the sidebar: progress, what it waits for, one click to it', async ({ page }) => {
  await page.goto('/');
  // The first row is the one under Plans (its project shows it again further down, KLD-23).
  const row = sidebar(page).getByRole('button', { name: 'Card checkout for launch', exact: true }).first();
  await expect(row).toBeVisible();
  // How far it got, and why it needs you, in the tooltip.
  await expect(row).toHaveAttribute('title', /^Card checkout for launch: .+ · \d+ of \d+ tasks done$/);
  await expect(row.locator('svg circle')).toHaveCount(2);
  await row.click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
  await expect(row).toHaveClass(/selected/);
});

test('Plans opens on the project you’re in, and says so when it has none', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('landing', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'landing' })).toBeVisible();
  await openWork(page, 'Plans');
  const project = page.getByRole('button', { name: 'Project: landing' });
  await expect(project).toBeVisible();
  await expect(project).toHaveAttribute('title', 'Switch Project');
  await expect(main(page).getByText('No plans in landing yet')).toBeVisible();
  await main(page).getByRole('button', { name: 'Plan in landing' }).click();
  await expect(page.getByRole('dialog', { name: /Plan/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Switching shows that project's plans.
  await project.click();
  await page.getByRole('menuitem', { name: /bob-api/ }).click();
  await expect(main(page).getByRole('button', { name: /^Card checkout for launch,/ })).toBeVisible();
});

test('the header says who the plan waits for; the run mode says what changes; the feed says what happened (KLD-22)', async ({ page }, info) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  const head = main(page).locator('header').filter({ has: page.getByRole('textbox', { name: 'Plan name' }) });
  // Everything the header ever says from here on, to prove it never claimed to wait for you while Claude checked.
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const read = () => {
      const text = [...document.querySelectorAll('main header')].find((h) => h.querySelector('[aria-label="Plan name"]'))?.textContent ?? '';
      if (w.__said.at(-1) !== text) w.__said.push(text);
    };
    read();
    new MutationObserver(read).observe(document.querySelector('main')!, { subtree: true, childList: true, characterData: true });
  });

  // The run mode is a button that says how it runs; Autopilot says in plain words what changes, then Cancel.
  await head.getByRole('button', { name: 'Runs on Step by Step' }).click();
  const sheet = page.getByRole('dialog', { name: 'How It Runs' });
  await sheet.getByRole('radio', { name: /Autopilot/ }).click();
  const changes = sheet.getByRole('status', { name: 'What changes' });
  await expect(changes).toContainText('From now on the agent passes milestones itself');
  await expect(changes).toContainText('It stops only if a check fails.');
  const shot = info.outputPath('mode-autopilot.png');
  await sheet.screenshot({ path: shot });
  await info.attach('switching to Autopilot', { path: shot, contentType: 'image/png' });
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Step by Step' })).toBeVisible();
  // Check-ins, applied at once and in the feed.
  await head.getByRole('button', { name: 'Runs on Step by Step' }).click();
  await sheet.getByRole('radio', { name: /Check-ins/ }).click();
  await expect(changes).toContainText('each milestone waits for you to pass it');
  await sheet.getByRole('button', { name: 'Switch to Check-ins' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Check-ins' })).toBeVisible();
  await main(page).getByRole('button', { name: 'What Happened', exact: true }).click();
  const feed = page.getByRole('complementary', { name: 'What happened' });
  await expect(feed.getByRole('list', { name: 'What happened' }).locator('li').first()).toContainText('switched the plan to Check-ins');

  await page.keyboard.press('Escape');
  await expect(feed).toHaveCount(0);

  // The gated check: every task of “Safe payments” finished (the other two move to the next milestone), Claude checks it.
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  const move = async (title: string, to: string) => {
    await main(page).getByRole('button', { name: new RegExp(`^${title},`) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to' }).click();
    await page.getByRole('menuitem', { name: to }).click();
    await expect(page.getByRole('region', { name: to })).toContainText(title);
  };
  await move('Receipt emails sent once', 'Refunds and launch');
  await move('Idempotent webhook retries', 'Refunds and launch');
  // Claude checked: now (and only now) it's yours to pass. Once the demo has run a while, KLD-37's
  // watchdog may have found a demo task that stopped again: resuming it outranks passing (progress.ts nextStep).
  await expect(head).toContainText(/You: (pass “Safe payments” — The agent checked all 3 criteria|resume BOB-\d+: its agent stopped again)/, { timeout: 20_000 });
  await head.getByRole('button', { name: /Show what happened$/ }).click();
  await expect(feed).toContainText('the agent is checking its pass criteria');
  await expect(feed).toContainText('checked “Safe payments”', { timeout: 20_000 });
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(said.filter((t) => t.includes('Waiting for you'))).toEqual([]);
  const shot2 = info.outputPath('header-pass.png');
  await main(page).screenshot({ path: shot2 });
  await info.attach('header after the check', { path: shot2, contentType: 'image/png' });

  // Put the demo back as it was: the tasks home again, step by step.
  await page.keyboard.press('Escape');
  await move('Idempotent webhook retries', 'Safe payments');
  await move('Receipt emails sent once', 'Safe payments');
  await head.getByRole('button', { name: 'Runs on Check-ins' }).click();
  await sheet.getByRole('radio', { name: /Step by Step/ }).click();
  await sheet.getByRole('button', { name: 'Switch to Step by Step' }).click();
  await expect(head.getByRole('button', { name: 'Runs on Step by Step' })).toBeVisible();
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'Canvas' }).click();
});
