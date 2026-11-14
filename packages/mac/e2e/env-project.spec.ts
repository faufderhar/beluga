import { expect, test, type Page } from './fixtures.js';

/**
 * A project's environment, from the project itself (BLG-369): its main folder's .env shows under its
 * own variables, typing over one sets it in Beluga, and a worktree that changed its .env is asked
 * about on the project's page (Copy to Main Folder, or Keep Here).
 */

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __envDaemon?: Promise<unknown> };
      w.__envDaemon ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__envDaemon;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test("a project's Environment… shows its .env, and typing over a value sets it in Beluga", async ({ page }) => {
  const { writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const root = await daemon<string>(page, `(c) => c.store.getState().projects.find((p) => p.name === 'bob-api').root`, null);
  writeFileSync(path.join(root, '.env'), 'API_URL=https://api.example.com\nSTRIPE_KEY=sk_test_123\n');

  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Environment…' }).click();
  const sheet = page.getByRole('dialog', { name: 'bob-api Settings' });
  await expect(sheet.getByText('Use the main folder’s .env')).toBeVisible();
  await expect(sheet.getByRole('switch', { name: "Use the main folder's .env" })).toHaveAttribute('aria-checked', 'true');
  const fromFile = sheet.getByLabel(/^Value of API_URL \(from \.env/);
  await expect(fromFile).toHaveValue('https://api.example.com');
  await expect(fromFile).toHaveClass(/masked/);
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-sheet-from-dotenv.png` });

  // Typing over it: now Beluga's, and it wins over the file.
  await fromFile.focus();
  await fromFile.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type('/v2');
  const own = sheet.getByLabel('Value of API_URL', { exact: true });
  await expect(own).toHaveValue('https://api.example.com/v2');
  await expect(own).toBeFocused();
  await sheet.getByRole('button', { name: 'Show values', exact: true }).click();
  await sheet.getByLabel('Name', { exact: true }).first().click();
  await expect(sheet.getByRole('status').getByText('Saved')).toBeVisible();
  // Marked changed, with the way back to the file's value beside it (no sentence under every row).
  await expect(sheet.getByRole('button', { name: 'Use .env for API_URL' })).toBeVisible();
  // It stayed where it was: still the first row.
  await expect(sheet.getByLabel('Name', { exact: true }).first()).toHaveValue('API_URL');
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-sheet-override.png` });

  // Keep a copy in Beluga: the rest comes in too.
  await sheet.getByRole('button', { name: 'Keep a Copy in Beluga' }).click();
  await expect(sheet.getByLabel('Value of STRIPE_KEY', { exact: true })).toHaveValue('sk_test_123');
  // The arrow takes the override back; a copy kept with the same value has no arrow, only its tag.
  await expect(sheet.getByRole('button', { name: 'Use .env for STRIPE_KEY' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Use .env for API_URL' }).click();
  await expect(sheet.getByLabel(/^Value of API_URL \(from \.env/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
});

test('a worktree’s new key goes to the main folder on its own; a changed value is asked about and saved in Beluga', async ({ page }) => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const { root, projectId } = await daemon<{ root: string; projectId: string }>(page, `(c) => { const p = c.store.getState().projects.find((p) => p.name === 'bob-api'); return { root: p.root, projectId: p.id }; }`, null);
  writeFileSync(path.join(root, '.env'), 'API_URL=https://api.example.com\n');
  const ws = await daemon<{ id: string; path: string; name: string }>(page, `async (c, projectId) => {
    const id = await c.api.workspaces.newWorktree(projectId, 'env-ask');
    for (let i = 0; i < 100; i++) {
      const ws = c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id && w.path);
      if (ws) return { id: ws.id, path: ws.path, name: ws.name };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no worktree');
  }`, projectId);
  writeFileSync(path.join(ws.path, '.env'), 'API_URL=https://staging.example.com\nNEW_FLAG=1\n');
  await daemon(page, `(c, id) => c.api.workspaces.checkEnv(id)`, projectId);

  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click();
  const ask = page.getByRole('status', { name: 'Env changes in this worktree' }).filter({ hasText: ws.name });
  await expect(ask).toBeVisible();
  // NEW_FLAG is new: it went to the main folder by itself. The changed API_URL is asked about.
  await expect(ask.getByText('~API_URL')).toBeVisible();
  await expect(ask.getByText('+NEW_FLAG')).toHaveCount(0);
  expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('NEW_FLAG=1');
  if (process.env.SHOTS) await page.getByRole('region', { name: 'Environment' }).screenshot({ path: `${process.env.SHOTS}/env-ask-project-page.png` });
  await ask.getByRole('button', { name: 'Save in Beluga' }).click();
  await expect(ask).toHaveCount(0);
  // Now Beluga's: the project's sheet shows it changed over the file, which is left as it was.
  await page.getByRole('button', { name: /^Environment/ }).click();
  const sheet = page.getByRole('dialog', { name: 'bob-api Settings' });
  await expect(sheet.getByLabel('Value of API_URL', { exact: true })).toHaveValue('https://staging.example.com');
  expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('API_URL=https://api.example.com');
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-sheet-saved-from-worktree.png` });
});

test('a worktree sets its own variables, .env.example gets placeholders, and archiving carries them to the project', async ({ page }) => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const { root, projectId } = await daemon<{ root: string; projectId: string }>(page, `(c) => { const p = c.store.getState().projects.find((p) => p.name === 'bob-api'); return { root: p.root, projectId: p.id }; }`, null);
  writeFileSync(path.join(root, '.env'), 'PORT=3000\nPAYMENTS_KEY=sk_live_abcdefgh12345678\n');
  writeFileSync(path.join(root, '.env.example'), 'PORT=\nRESEND_KEY=\n');
  const ws = await daemon<{ id: string; name: string; path: string }>(page, `async (c, projectId) => {
    const id = await c.api.workspaces.newWorktree(projectId, 'env-own');
    for (let i = 0; i < 100; i++) {
      const ws = c.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id && w.path);
      if (ws) return { id: ws.id, name: ws.name, path: ws.path };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no worktree');
  }`, projectId);

  // The project page says what .env.example asks for; what it doesn't list is the worktrees' to mend, not yours.
  await sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().click();
  const section = page.getByRole('region', { name: 'Environment' });
  await expect(section.getByText('1 variable .env.example asks for isn’t set')).toBeVisible();
  await expect(section.getByText('RESEND_KEY')).toBeVisible();
  await expect(section.getByText(/doesn’t list/)).toHaveCount(0);
  // The new worktree came with its own .env.example listing the .env's names (placeholders, never the value); the main folder's is left alone.
  await expect.poll(() => readFileSync(path.join(ws.path, '.env.example'), 'utf8')).toContain('PAYMENTS_KEY=sk_live_…\n');
  expect(readFileSync(path.join(ws.path, '.env.example'), 'utf8')).not.toContain('abcdefgh12345678');
  expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toBe('PORT=\nRESEND_KEY=\n');
  if (process.env.SHOTS) await section.screenshot({ path: `${process.env.SHOTS}/env-section.png` });

  // The worktree's own: set from its ••• › Environment…, over the project's.
  await sidebar.getByRole('button', { name: ws.name }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Environment…' }).click();
  const sheet = page.getByRole('dialog', { name: `Environment for ${ws.name}` });
  await expect(sheet.getByLabel(/^Value of PORT \(from \.env/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Add variable' }).click();
  // The new row goes above what comes from below, its name field focused.
  await expect(sheet.getByPlaceholder('NAME')).toBeFocused();
  await page.keyboard.type('FEATURE_FLAG');
  await sheet.getByLabel('Value of FEATURE_FLAG').fill('on');
  await sheet.getByLabel('Value of FEATURE_FLAG').blur();
  await expect(sheet.getByRole('status').getByText('Saved')).toBeVisible();
  if (process.env.SHOTS) await sheet.screenshot({ path: `${process.env.SHOTS}/env-worktree-sheet.png` });
  await sheet.getByRole('button', { name: 'Done' }).first().click();

  // Archiving asks to carry it to the project (on), and the project has it after.
  await daemon(page, `(c, id) => c.api.workspaces.prepareRemoval(id)`, ws.id);
  await sidebar.getByRole('button', { name: ws.name }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert.getByText('Carry its variable to bob-api')).toBeVisible();
  if (process.env.SHOTS) await alert.screenshot({ path: `${process.env.SHOTS}/env-archive-carry.png` });
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect.poll(() => daemon<string[]>(page, `async (c, id) => (await c.api.env.get(id)).vars.map((v) => v.key)`, projectId)).toContain('FEATURE_FLAG');
});
