import { inApp } from '../lib/boot.js';
import { loadLocale } from './index.js';
import { translatePage } from './dom.js';

/**
 * Every window's first step (main.tsx, popup/, callfloat/, calloverlay/): load its language's
 * catalog, start translating the page, and (from the main window) give the native menus the same
 * language. Resolves when the window can draw; English resolves at once.
 */
export async function startI18n(opts: { readonly native?: boolean } = {}): Promise<void> {
  const locale = await loadLocale();
  if (locale !== 'en') translatePage();
  if (opts.native && inApp()) {
    // Awaited: the menu bar is redrawn before this window sends its menus' state and keys.
    // A failure (the language can't be saved for next launch, a menu can't be redrawn) doesn't stop
    // the window: it still draws in its language, and says why the menus may not match.
    await import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_ui_language', { locale }))
      .catch((e: unknown) => console.warn('[i18n] the native menus may not be in this language:', e));
  }
}
