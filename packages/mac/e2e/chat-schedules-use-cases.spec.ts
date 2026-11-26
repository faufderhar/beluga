import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * The three use cases of "Chat schedules on Sentinel", in the app with the demo daemon:
 * (1) "Send XYZ every day at 9:00", (2) "Send XYZ in 5 hours" (the page's clock is fixed, so the
 * moment is known), (3) a woken chat that stops on the usage limit shows that Beluga continues it
 * when the limit resets. The firing at the moment, and the resume itself, run on a fake clock in
 * tests/sentinel-chat-auto-continue.test.ts. Screenshots go to .beluga/scratch/use-case-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

/** A picture for the proof, with the terminal masked: its prompt is the real shell's, with personal data. */
const shoot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `use-case-${name}.png`), mask: [page.locator('.xterm')] });

type Demo = { readonly endpoint: { readonly url: string; readonly token: string } };
const connect = (demo: Demo) => SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });

/** A new chat in bob-api. → its ref. */
async function newChat(demo: Demo, name: string): Promise<string> {
  const client = await connect(demo);
  const project = client.store.getState().projects.find((p) => p.name === 'bob-api')!.id;
  const ws = (await client.api.workspaces.newChat(project, name)) as string;
  const ref = `${client.store.getState().selfId}/ws:${ws}`;
  client.close();
  return ref;
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/');
  // The demo's project starts folded.
  await sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first().click();
  await sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
}

const box = (page: Page) => page.locator('[data-chat-box]').filter({ has: page.locator('textarea[data-composer]') });

/** '/schedule <prompt>' in the chat (BLG-1023): the box turns into a schedule, then When picks `when`. */
async function scheduleWhen(page: Page, prompt: string, when: RegExp): Promise<void> {
  await composer(page).fill('/schedule ');
  await expect(box(page)).toHaveAttribute('data-mode', 'schedule');
  await composer(page).fill(prompt);
  await box(page).getByRole('button', { name: /^When: / }).click();
  await page.getByRole('menuitem', { name: when }).click();
}

/** The same, through When › Custom…: the sheet, with the prompt filled in. */
async function scheduleSheet(page: Page, prompt: string) {
  await scheduleWhen(page, prompt, /Custom/);
  const sheet = page.getByRole('dialog', { name: 'Schedule a Message' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Message' })).toHaveValue(prompt);
  return sheet;
}

/** Whether the sentinel wakes the chat `ref`. */
const wakes = (x: { readonly steps: readonly unknown[] }, ref: string): boolean => x.steps.some((st) => (st as { kind: string; to?: string }).kind === 'chat' && (st as { to?: string }).to === ref);

/** The state of the newest run of the sentinel that wakes `ref`. */
async function runStateOf(demo: Demo, ref: string): Promise<string | undefined> {
  const client = await connect(demo);
  const st = client.store.getState();
  const id = st.sentinel.items.find((x) => wakes(x, ref))?.id;
  const state = st.sentinel.runs.filter((r) => r.sentinelId === id).at(-1)?.state;
  client.close();
  return state;
}

test.describe.configure({ mode: 'serial' });

test('use case 1: "Send XYZ every day at 9:00" wakes the chat and its agent answers', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const chat = 'Daily XYZ';
  const ref = await newChat(demo, chat);
  await openChat(page, chat);
  await scheduleWhen(page, 'Send XYZ', /Every morning/);
  await expect(box(page).getByRole('status')).toContainText('Sends this here every day at 9:00');
  await shoot(page, '1-mode');
  await box(page).getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(box(page)).not.toHaveAttribute('data-mode', 'schedule');

  const row = inspector(page).locator('[data-schedule]').filter({ hasText: 'Send XYZ' });
  await expect(row).toContainText(/Every day at 9:00 · next/, { timeout: 20_000 });
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(sidebar(page).locator('[data-scheduled="on"]')).toHaveCount(1);

  // Its 9:00 comes now: the prompt arrives in the chat from Sentinel and the agent's turn runs to its end.
  await row.getByRole('button', { name: /^Run .* now$/ }).click();
  const main = page.locator('main');
  await expect(main.getByText('Send XYZ', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText(/Sentinel/).first()).toBeVisible();
  await expect.poll(() => runStateOf(demo, ref), { timeout: 60_000 }).toBe('done');
  await shoot(page, '1-woken');
});

test('use case 2: "Send XYZ in 5 hours" makes a once schedule five hours from now', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const chat = 'Later XYZ';
  const ref = await newChat(demo, chat);
  // The page's clock: Thursday 14 January 2027, 08:00 here (later than the daemon's own now, so the moment is ahead).
  await page.clock.setFixedTime(new Date(2027, 0, 14, 8, 0));
  await openChat(page, chat);
  const sheet = await scheduleSheet(page, 'Send XYZ');
  await sheet.getByRole('radio', { name: 'In a few hours' }).click();
  await sheet.getByRole('textbox', { name: 'In how many hours' }).fill('5');
  await shoot(page, '2-sheet');
  await sheet.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(sheet).toBeHidden();

  const row = inspector(page).locator('[data-schedule]').filter({ hasText: 'Send XYZ' });
  await expect(row).toContainText('Once, Thu 14 Jan 13:00 · next', { timeout: 20_000 });
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await shoot(page, '2-made');

  // The daemon has it as a one-time trigger at that moment.
  const client = await connect(demo);
  const made = client.store.getState().sentinel.items.find((x) => wakes(x, ref));
  client.close();
  expect(made?.trigger).toMatchObject({ kind: 'once' });
  expect(Date.parse((made!.trigger as { at: string }).at)).toBe(new Date(2027, 0, 14, 13, 0).getTime());
});

test('use case 3: a woken chat that stops on the usage limit is continued when the limit resets', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const chat = 'Limited XYZ';
  const ref = await newChat(demo, chat);
  // The demo's agent stops on the usage limit at a prompt whose last line is "usage limit" (resets in two hours).
  const client = await connect(demo);
  const made = (await client.api.sentinel.create({ name: 'Keep going', trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' }, steps: [{ kind: 'chat', to: ref, text: 'Send XYZ\nusage limit' }] } as never)) as { id: string };
  await client.api.sentinel.pause(made.id, false);
  client.close();

  await openChat(page, chat);
  const row = inspector(page).locator('[data-schedule]').filter({ hasText: 'Keep going' });
  await expect(row).toContainText(/Every day at 9:00 · next/, { timeout: 20_000 });
  await row.getByRole('button', { name: 'Run Keep going now' }).click();

  // The woken turn stopped on the limit; the card says Beluga sends "continue" when it resets: auto-continue has it.
  const main = page.locator('main');
  await expect(main.getByText(/Sends “Continue where you left off\.” at .*, when your limit resets/)).toBeVisible({ timeout: 30_000 });
  await expect(main.getByRole('button', { name: 'Don’t Send' })).toBeVisible();
  await shoot(page, '3-limit');

  // Its guard still holds: Don't Send › Never in This Chat leaves it to you.
  await main.getByRole('button', { name: 'Don’t Send' }).click();
  await page.getByRole('menuitem', { name: 'Never in This Chat' }).click();
  await expect(main.getByText(/Sends “Continue where you left off\.”/)).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await shoot(page, '3-off');
});
