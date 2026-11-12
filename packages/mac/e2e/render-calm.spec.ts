import { expect, test, type Page } from './fixtures.js';

/**
 * The window keeps up while many Claudes stream (KLD-48): eight chats run at once, and a streamed
 * event draws again only the card it's about (the chat's other cards, and a running card's
 * finished steps, stay as they were drawn), and clicking a sidebar row answers within 250 ms (the
 * median; none past 400 ms).
 * Rows count their renders into `window.__BELUGA_RENDERS__` (lib/render-count.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const NAMES = Array.from({ length: 8 }, (_, i) => `calm-${i + 1}`);

type Renders = Record<string, number>;
const renders = (page: Page): Promise<Renders> => page.evaluate(() => ({ ...window.__BELUGA_RENDERS__ }));

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __calm?: Promise<{ api: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>; store: { getState: () => unknown } }> };
      w.__calm ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__calm;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test('eight chats streaming: only the card an event is about draws again, and the sidebar answers within 250 ms', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => (window.__BELUGA_RENDERS__ = {}));
  // Without StrictMode's second render (development only): timed as the shipped app runs.
  await page.goto('/?nostrict');
  await expect(sidebar(page)).toBeVisible();
  const project = await daemon<string>(page, `(c) => c.store.getState().projects.find((p) => p.name === 'bob-api').id`, null);
  const ids = await daemon<string[]>(page, `async (c, { project, names }) => { const out = []; for (const n of names) out.push(await c.api.workspaces.newChat(project, n)); return out; }`, { project, names: NAMES });
  expect(ids.filter(Boolean)).toHaveLength(8);

  // calm-1 gets two finished answers first.
  const show = sidebar(page).getByRole('button', { name: /^Show what's in bob-api/ }).first();
  if (await show.isVisible()) await show.click();
  const first = sidebar(page).getByRole('button', { name: NAMES[0], exact: true });
  await first.click();
  await expect(page.locator('header').first()).toContainText(NAMES[0]!);
  const cards = page.locator('[data-turn]');
  for (const [i, text] of ['summarize the project', 'write up a summary'].entries()) {
    await composer(page).fill(text);
    await composer(page).press('Enter');
    await expect(cards).toHaveCount(i + 1, { timeout: 15_000 });
    await expect(cards.nth(i)).toHaveAttribute('data-turn', 'done', { timeout: 20_000 });
  }
  await page.waitForTimeout(500);
  const done = Object.keys(await renders(page)).filter((k) => k.startsWith('card:'));
  expect(done).toHaveLength(2);

  // All eight stream at once (12 steps each), calm-1 among them.
  await daemon(page, `async (c, ids) => { await Promise.all(ids.map((id) => c.api.session.submit('deep dive, take your time', { channel: 'ws:' + id }))); }`, ids);
  await expect(cards).toHaveCount(3, { timeout: 15_000 });
  const live = cards.nth(2);
  await expect(live.locator('[data-step]').nth(2)).toBeVisible({ timeout: 15_000 });

  // From here (the card above stopped being the newest once, when this one came), while eight stream:
  // a running card's finished steps don't draw again as its clock ticks or new steps arrive,
  const finishedSteps = await live.locator('[data-step]:not([data-current])').evaluateAll((els) => els.map((el) => el.getAttribute('data-step')!));
  expect(finishedSteps.length).toBeGreaterThan(0);
  const before = await renders(page);
  const mid = before;
  await page.waitForTimeout(2500);
  const after = await renders(page);
  for (const id of finishedSteps) expect(after[`step:${id}`], `finished step ${id}`).toBe(mid[`step:${id}`]);

  // and the finished cards aren't drawn again at all; the live one is.
  for (const key of done) expect(after[key], key).toBe(before[key]);
  const liveKey = Object.keys(after).find((k) => k.startsWith('card:') && !done.includes(k))!;
  expect(after[liveKey]).toBeGreaterThan(before[liveKey]!);

  // The sidebar answers at once: from the click to the painted frame that shows the other chat (its
  // name in the toolbar). Watched as the page changes (not once a frame), then that frame's paint
  // (a task posted from its animation frame runs after it): no idle frame interval of a headless,
  // busy browser counts, only what the click makes the window do.
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const name = NAMES[i % 2 === 0 ? 1 : 0]!;
    const row = await sidebar(page).getByRole('button', { name, exact: true }).elementHandle();
    const ms = await page.evaluate(
      ({ row, name }) =>
        new Promise<number>((resolve) => {
          const shown = (): boolean => (document.querySelector('header')?.textContent ?? '').includes(name);
          const painted = (): void =>
            requestAnimationFrame(() => {
              const ch = new MessageChannel();
              ch.port1.onmessage = () => resolve(performance.now() - start);
              ch.port2.postMessage(null);
            });
          const watch = new MutationObserver(() => {
            if (!shown()) return;
            watch.disconnect();
            painted();
          });
          watch.observe(document.body, { subtree: true, childList: true, characterData: true });
          const start = performance.now();
          (row as HTMLElement).click();
          if (shown()) {
            watch.disconnect();
            painted();
          }
        }),
      { row, name },
    );
    times.push(Math.round(ms));
    await page.waitForTimeout(300);
  }
  // CALM_CLICK_PROFILE=<file>: a CPU profile of six more sidebar switches (to see what a click still does).
  if (process.env.CALM_CLICK_PROFILE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    for (let i = 0; i < 6; i++) {
      const name = NAMES[i % 2 === 0 ? 1 : 0]!;
      const row = await sidebar(page).getByRole('button', { name, exact: true }).elementHandle();
      await page.evaluate((row) => (row as HTMLElement).click(), row);
      await expect(page.locator('header').first()).toContainText(name);
      await page.waitForTimeout(300);
    }
    (await import('node:fs')).writeFileSync(process.env.CALM_CLICK_PROFILE, JSON.stringify((await cdp.send('Profiler.stop')).profile));
  }
  if (process.env.CALM_TRACE) {
    const cdp = await page.context().newCDPSession(page);
    const out = [];
    for (let i = 0; i < 4; i++) {
      const name = NAMES[i % 2 === 0 ? 1 : 0]!;
      const events: unknown[] = [];
      cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
      const finished = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
      const row = await sidebar(page).getByRole('button', { name, exact: true }).elementHandle();
      await page.evaluate((row) => { performance.mark('calm-click'); (row as HTMLElement).click(); }, row);
      await expect(page.locator('header').first()).toContainText(name);
      await page.waitForTimeout(150);
      await cdp.send('Tracing.end');
      await finished;
      cdp.removeAllListeners('Tracing.dataCollected');
      out.push(events);
    }
    (await import('node:fs')).writeFileSync(process.env.CALM_TRACE, JSON.stringify(out));
  }
  // CALM_PROFILE=<file>: also save a 2 s CPU profile of the window while the eight stream (to see what still redraws).
  if (process.env.CALM_PROFILE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    await page.waitForTimeout(2000);
    const idle = (await cdp.send('Profiler.stop')).profile;
    (await import('node:fs')).writeFileSync(process.env.CALM_PROFILE, JSON.stringify(idle));
  }
  console.log(`[render-calm] sidebar click → shown (ms): ${times.join(', ')}`);
  // The first switch can load the chat's history (it gets 300 ms). The ones after it show the other
  // chat at once, without waiting on the daemon (ClientStore.openAhead): median under 250 ms, none
  // past 400. A fast Mac is well under that. The GitHub runner has 3 cores and this is a development
  // build: an alone re-run still lands around 150–190 ms median, with a worst sample around 230 ms,
  // and one switch can sit behind GC. The shipped app is faster.
  expect(times[0], `first switch: ${times[0]} ms`).toBeLessThan(300);
  const later = times.slice(1);
  const median = [...later].sort((a, b) => a - b)[Math.floor(later.length / 2)]!;
  expect(median, `median switch: ${median} ms (${later.join(', ')})`).toBeLessThan(250);
  expect(Math.max(...later), `worst switch: ${later.join(', ')} ms`).toBeLessThan(400);
});
