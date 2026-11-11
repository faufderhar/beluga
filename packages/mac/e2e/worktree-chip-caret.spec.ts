import { expect, test, type Page } from './fixtures.js';

/**
 * A pasted worktree link is a chip in the message box as wide as its name (BLG-887): the box holds
 * it short, "[\u2007name]", so the words after it follow right on, and it goes out as the whole link.
 * The words under a chip are one piece: a click inside it puts the caret at its edge, the arrows
 * step over it, and Backspace takes it whole (⌘Z brings it back).
 */

const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();
const caret = (page: Page) => composer(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
const paste = (page: Page, text: string) =>
  composer(page).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

async function demoWorktree(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(async () => {
    const boot = await import('/src/lib/boot.ts');
    const c = await boot.connect(boot.capabilities(() => ({ ok: true, message: '' })));
    const w = c.store.getState().projects.flatMap((p) => p.workspaces).find((x) => x.kind === 'worktree' && !x.archived)!;
    return { id: w.id, name: w.name };
  });
}

test('a pasted worktree link is a chip as wide as its name, and one piece', async ({ page }, info) => {
  await page.goto('/');
  const wt = await demoWorktree(page);
  await page.getByRole('navigation', { name: 'Sidebar' }).getByText('Your Mac', { exact: true }).click();
  const box = composer(page);
  await box.click();
  await page.keyboard.insertText('see ');
  await paste(page, `worktree:${wt.id}`);
  const short = `[\u2007${wt.name.replace(/\s+/g, '\u00a0')}]`;
  await expect(box).toHaveValue(`see ${short}`);
  await page.keyboard.insertText(' and');
  const start = 4;
  const end = start + short.length;

  // The chip takes the room its words do, no more: what follows starts right after it.
  const room = page.locator('mark[data-kind="worktree"]');
  const face = room.locator('[data-image-chip]');
  await expect(face).toContainText(wt.name);
  // All of its name shows (nothing cut off).
  expect(await face.locator('span').first().evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
  const [r, f] = [(await room.boundingBox())!, (await face.boundingBox())!];
  expect(Math.abs(f.x - r.x)).toBeLessThan(4);
  expect(Math.abs(f.x + f.width - (r.x + r.width))).toBeLessThan(4);
  await box.screenshot({ path: info.outputPath('worktree-chip.png') });

  // A click inside it lands at its nearer edge, never inside.
  await page.mouse.click(r.x + r.width * 0.2, r.y + r.height / 2);
  await expect.poll(() => caret(page)).toEqual([start, start]);
  await page.mouse.click(r.x + r.width * 0.85, r.y + r.height / 2);
  await expect.poll(() => caret(page)).toEqual([end, end]);

  // The arrows step over it.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => caret(page)).toEqual([start, start]);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => caret(page)).toEqual([end, end]);

  // Backspace takes it whole, and ⌘Z brings it back.
  await page.keyboard.press('Backspace');
  await expect(box).toHaveValue('see  and');
  await page.keyboard.press('Meta+z');
  await expect(box).toHaveValue(`see ${short} and`);

  // Sent, it's the whole link: the message shows the worktree's chip.
  await box.press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^Worktree ${wt.name} in `) }).first()).toBeVisible();
});

test('a bare worktree link from before is still one piece, its chip over all its room', async ({ page }) => {
  await page.goto('/');
  const wt = await demoWorktree(page);
  await page.getByRole('navigation', { name: 'Sidebar' }).getByText('Your Mac', { exact: true }).click();
  const box = composer(page);
  await box.click();
  const ref = `worktree:${wt.id}`;
  await page.keyboard.insertText(`see ${ref} and`);
  const room = page.locator('mark[data-kind="worktree"]');
  const face = room.locator('[data-image-chip]');
  await expect(face).toBeVisible();
  const [r, f] = [(await room.boundingBox())!, (await face.boundingBox())!];
  expect(Math.abs(f.x + f.width - (r.x + r.width))).toBeLessThan(2);
  await box.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), 4);
  await page.keyboard.press('Delete');
  await expect(box).toHaveValue('see  and');
});
