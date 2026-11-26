import { isImeComposing } from './ime.js';

/**
 * Enter that picks an input method's words (Chinese, Japanese, Korean…), and Tab, Escape and the
 * arrows pressed while it composes (they move through its candidates), never reach the app's own
 * key handlers, so no box sends, submits, closes, completes or moves on them (IME_KEYS; letters are
 * left alone, so shortcuts are too). WebKit, the Mac app's webview, ends the composition before
 * keydown fires for that Enter, so `isComposing` is already false there and only keyCode 229 tells
 * (lib/ime.ts). Most boxes checked `isComposing` alone, some nothing at all.
 *
 * One place instead of a check in every box: a keydown listener on the window, capture phase,
 * installed first thing in main.tsx (lib/install-ime-guard.ts). It runs before React (whose
 * listeners sit on the root) and before every other window listener (dictation's ↩, the sheets'),
 * and only stops the event's propagation: never preventDefault, which would also drop the
 * characters the IME is committing.
 *
 * Left alone: the terminal (xterm reads keyCode 229 itself to pick up what the IME typed). The IME
 * itself never sees the difference: it handles its keys before the page does.
 */
export interface GuardedKey {
  readonly key: string;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly target?: EventTarget | null;
}

/** The keys the boxes act on that an IME uses while it composes. */
export const IME_KEYS: ReadonlySet<string> = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Is this keydown the IME's (Enter picking its words, or a key that moves through them), outside the terminal? */
export function swallowsImeEnter(e: GuardedKey): boolean {
  if (!IME_KEYS.has(e.key) || !isImeComposing(e)) return false;
  const el = e.target as { closest?: (sel: string) => unknown } | null | undefined;
  return !(typeof el?.closest === 'function' && el.closest('.xterm'));
}

/** Install once, first thing (main.tsx). Returns how to take it off (tests). */
export function installImeGuard(win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const guard = (e: KeyboardEvent): void => {
    if (swallowsImeEnter(e)) e.stopImmediatePropagation();
  };
  win.addEventListener('keydown', guard, true);
  return () => win.removeEventListener('keydown', guard, true);
}
