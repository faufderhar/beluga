import * as Context from '@radix-ui/react-context-menu';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * The root of every right-click menu: one open at a time, and any press outside it closes it.
 *
 * Radix closes a menu on a `pointerdown` outside it, and only that. Windows' web view can stop
 * sending those after a right-click (a press while it believes a button is still down is a
 * "chorded" press: `mousedown` and `click`, no `pointerdown`), so a menu stayed open through every
 * click, and each right-click opened another on top of it (#467). Here a menu also closes on an
 * outside `mousedown`, a right-click elsewhere, or the window losing focus, as a native menu
 * does; and opening one closes the one before.
 *
 * The menus that stayed on Windows were closed, though: they never left the page, because
 * Radix waited for an exit animation that never came (#505). base.css takes them out at once.
 */

/** What a press can land in without closing the menu: the menu and its submenus. */
const MENU = '[role="menu"]';
const PRESSES = ['pointerdown', 'mousedown', 'contextmenu'] as const;

/** The right-click menu open now (its close), so the next one can close it. */
let openNow: (() => void) | undefined;

/** Keeps a right-click menu the only one open, and closes it on any press outside it. */
export function useOneMenu(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    if (openNow && openNow !== close) openNow();
    openNow = close;
    const outside = (e: Event): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(MENU)) close();
    };
    // Capture, on the window: a handler that stops the press on its way can't keep the menu open.
    for (const type of PRESSES) window.addEventListener(type, outside, true);
    window.addEventListener('blur', close);
    return () => {
      for (const type of PRESSES) window.removeEventListener(type, outside, true);
      window.removeEventListener('blur', close);
      if (openNow === close) openNow = undefined;
    };
  }, [open, close]);
}

/** A right-click menu's root (non-modal, like a Mac's menus): use it in place of Radix's own. */
export function ContextRoot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [close] = useState(() => () => setOpen(false));
  useOneMenu(open, close);
  return (
    <Context.Root modal={false} open={open} onOpenChange={setOpen}>
      {children}
    </Context.Root>
  );
}
