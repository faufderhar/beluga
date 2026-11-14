import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';
import { openTasks } from './helpers.js';

/**
 * What Waits on What on a board as busy as a real one (BLG-931): about 440 tasks in 75 epics, a few
 * epics inside others, 230-odd blockers inside epics and between neighbouring ones. It draws only
 * what's in view, lighter once zoomed out, and Fit to View lands even right after a pinch.
 * (heavy-graph.spec.ts covers opening, staying live and the start view on a smaller board.)
 */

const SIZES = [14, 10, 8, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2];
const EPICS = 75;

test.describe.configure({ mode: 'serial' });

const viewport = (page: Page) => page.locator('main .react-flow__viewport');

async function zoomOf(page: Page): Promise<number> {
  const t = await viewport(page).evaluate((el) => (el as HTMLElement).style.transform);
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 'NaN');
}

/** The worst frame (ms) while `act` runs. */
async function worstFrame(page: Page, act: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(1);
  });
  return Math.round(Math.max(0, ...frames));
}

test('a real-sized board draws what is in view, lighter zoomed out, and Fit lands after a pinch', async ({ page, demo }) => {
  test.setTimeout(240_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e', timeoutMs: 10_000 });
  let total = 0;
  try {
    const deadline = Date.now() + 20_000;
    while (!client.store.getState().projects.some((p) => p.name === 'bob-api') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const projectId = client.store.getState().projects.find((p) => p.name === 'bob-api')!.id;
    const statuses = ['done', 'todo', 'done', 'in_progress', 'backlog', 'done', 'in_review', 'done'] as const;
    let n = 0;
    const epics: string[] = [];
    const kids: string[][] = [];
    for (let e = 0; e < EPICS; e++) {
      // Every tenth epic sits inside the one before it.
      const parent = e % 10 === 9 ? epics[e - 1] : undefined;
      const epic = await client.api.board.create({ projectId, title: `Epic ${e + 1}: a long piece of work with a name`, status: 'in_progress', ...(parent ? { parent } : {}) });
      epics.push(epic.id);
      const mine: string[] = [];
      for (let k = 0; k < SIZES[e % SIZES.length]!; k++) {
        const blockedBy = k > 0 && k % 2 === 0 ? [mine[k - 1]!] : [];
        const t = await client.api.board.create({ projectId, title: `Sub-task ${k + 1} of epic ${e + 1}: do the thing well`, parent: epic.id, status: statuses[n++ % statuses.length], blockedBy });
        mine.push(t.id);
      }
      kids.push(mine);
    }
    // Neighbouring epics wait on each other in pairs (a board is many small knots, not one long chain).
    for (let e = 1; e < EPICS; e += 2) await client.api.board.relate(kids[e]![0]!, 'blocked_by', kids[e - 1]!.at(-1)!, true);
    total = EPICS + kids.flat().length;

    await page.goto('/');
    await openTasks(page);
    await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'What Waits on What' }).click();
    const canvas = page.locator('main [data-mode="full"]');
    await expect(page.locator('main [data-ready="true"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(800);

    // Opens readable, in full detail, with only the cards in view drawn.
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(0.5);
    await expect(canvas).toHaveAttribute('data-detail', 'full');
    const drawn = await page.locator('main .react-flow__node').count();
    console.log(`[busy-graph] ${total} tasks, ${drawn} drawn at the start`);
    expect(drawn).toBeLessThan(total / 2);

    const box = (await page.locator('main .react-flow__pane').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const pinch = (dy: number, times: number) =>
      page.evaluate(
        ([x, y, d, k]) => {
          for (let i = 0; i < k; i++) document.querySelector('main .react-flow__pane')?.dispatchEvent(new WheelEvent('wheel', { deltaY: d, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        },
        [cx, cy, dy, times] as const,
      );

    // Pinched out past where words read: lighter, and every card in view is drawn.
    const out = await worstFrame(page, async () => {
      for (let i = 0; i < 30; i++) await pinch(10, 1);
      await page.waitForTimeout(300);
    });
    console.log(`[busy-graph] worst frame zooming out: ${out} ms, zoom ${(await zoomOf(page)).toFixed(3)}`);
    await expect(canvas).toHaveAttribute('data-detail', 'light');
    expect(await page.locator('main .react-flow__node').count()).toBeGreaterThan(drawn);

    // Fit to View right after a pinch goes all the way (settling used to stop it where it was).
    await canvas.focus();
    await pinch(-10, 3);
    await page.keyboard.press('0');
    await page.waitForTimeout(1200);
    const fitted = await zoomOf(page);
    await page.keyboard.press('0');
    await page.waitForTimeout(1200);
    expect(Math.abs((await zoomOf(page)) - fitted)).toBeLessThan(0.002);

    const pan = await worstFrame(page, async () => {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 30; i++) await page.mouse.wheel(14, 20);
      await page.waitForTimeout(300);
    });
    console.log(`[busy-graph] worst frame panning all of it: ${pan} ms`);

    // Back where words read: full detail again.
    for (let i = 0; i < 20 && (await zoomOf(page)) < 0.6; i++) {
      await page.keyboard.press('=');
      await page.waitForTimeout(500);
    }
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(0.6);
    await expect(canvas).toHaveAttribute('data-detail', 'full');
  } finally {
    client.close();
  }
});
