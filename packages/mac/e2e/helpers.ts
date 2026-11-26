import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Beluga's pop-up buttons (components/Select.tsx) aren't native <select>s, so Playwright's
 * selectOption and toHaveValue don't apply: click it, then the option; the value is `data-value`.
 */

type Scope = Page | Locator;
const pageOf = (scope: Scope): Page => ('goto' in scope ? scope : scope.page());

/**
 * One of Work's pages (BLG-197: Tasks, Issues, Actions and Plans are one sidebar row, Work, with a
 * switch over its lists): the Work row, then its tab.
 */
export async function openWork(page: Page, tab: 'Tasks' | 'Issues' | 'Actions' | 'Plans'): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: tab }).click();
}

/**
 * The room's group chat: the first of Channels in the sidebar while someone else is in the room (BLG-871).
 * The window opens on the Overview, so tests in the room's chat start here.
 */
export async function openGroupChat(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).locator('[data-room-chat]').click();
}

/** A person's row in the sidebar: "bob", or "bob Add bob as a friend" while you aren't friends yet. */
export const personRow = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}(?: Add ${name} as a friend)?$`) });

/** Open a person's card from their row: on the name, not its Add button. */
export async function openPersonCard(page: Page, name: string): Promise<Locator> {
  await personRow(page, name).getByText(name, { exact: true }).click();
  return page.getByRole('dialog', { name });
}

/** The pop-up button named `label` (its aria-label). */
export const popup = (scope: Scope, label: string | RegExp): Locator => scope.getByRole('combobox', { name: label });

/** The open menu (it's in a portal, outside any sheet). */
export const popupMenu = (page: Page): Locator => page.getByRole('listbox');

/** Opens the pop-up named `label` and picks `option` (a string matches the option's label exactly). */
export async function pick(scope: Scope, label: string | RegExp, option: string | RegExp): Promise<void> {
  const page = pageOf(scope);
  await popup(scope, label).click();
  await popupMenu(page)
    .getByRole('option', { name: option, exact: typeof option === 'string' })
    .click();
  await expect(popupMenu(page)).toHaveCount(0);
}

/** The pop-up shows this value (an option's value, not its label). */
export async function expectPicked(button: Locator, value: string | RegExp): Promise<void> {
  await expect(button).toHaveAttribute('data-value', value);
}

/** The labels of a pop-up's options, read by opening it (then closing it with Esc). */
export async function optionLabels(button: Locator): Promise<string[]> {
  const page = button.page();
  await button.click();
  const labels = await popupMenu(page).locator('[data-option-label]').allTextContents();
  await page.keyboard.press('Escape');
  await expect(popupMenu(page)).toHaveCount(0);
  return labels;
}

/** Plans: the sidebar's Work row (Tasks, Issues, Actions and Plans, BLG-197), then its Plans tab. */
export async function openPlans(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Work/ }).first().click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: /^Plans/ }).click();
}

/** A friend's workspace shared with you: under "<friend>’s conversations", in their project (unfolded first). */
export async function openSharedWorkspace(page: Page, project: string, friend: string, name: string | RegExp): Promise<void> {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const row = sidebar.getByRole('button', { name, exact: typeof name === 'string' }).first();
  if (!(await row.isVisible())) await sidebar.getByRole('button', { name: `${project}, shared by ${friend}` }).getByRole('button', { name: new RegExp(`^Show what's in ${project}`) }).click();
  await row.click();
}

/** Tasks: the sidebar's Work row, then its Tasks tab. */
export async function openTasks(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Work/ }).first().click();
  await page.getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: /^Tasks/ }).click();
}

type XtermLike = {
  element?: Element;
  options: { fontSize?: number };
  buffer: { active: { length: number; getLine: (y: number) => { translateToString: (trim: boolean) => string } | undefined } };
};

/** Each terminal drawn in `scope`: its text (all lines kept) and font size, read through the dev build's hook. */
const termsIn = (scope: Scope): Promise<Array<{ text: string; fontSize: number }>> =>
  scope.locator('.xterm').evaluateAll((els) => {
    const terms = Object.values((window as unknown as { __belugaTerms?: Record<string, XtermLike> }).__belugaTerms ?? {});
    return els.flatMap((el) => {
      const t = terms.find((x) => x.element === el);
      if (!t) return [];
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      return [{ text: lines.join('\n'), fontSize: t.options.fontSize ?? 0 }];
    });
  });

/**
 * What the terminals in `scope` show, as text. Terminals draw with the GPU (BLG-963), so there is
 * no text in the page to find: poll this instead, `expect.poll(() => termText(term)).toContain(…)`.
 */
export const termText = async (scope: Scope): Promise<string> => (await termsIn(scope)).map((t) => t.text).join('\n');

/** The font size the terminal in `scope` draws with. */
export const termFontSize = async (scope: Scope): Promise<number> => (await termsIn(scope))[0]?.fontSize ?? 0;
