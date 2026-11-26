import type { ITerminalOptions } from '@xterm/xterm';
import type { UiPrefs } from './prefs.js';
import { colorsFor, xtermColors } from './terminal-import-model.js';
import { keyPlatform } from './shortcuts-model.js';
import { TERMINAL_PRESETS } from './terminal-themes.js';
import { themeFor } from './themes.js';

export { SCROLLBACK_CHOICES } from './terminal-import-model.js';

/** How the terminal looks: fonts to offer, and the xterm options for your choices. */

/**
 * Monospace fonts worth offering when the daemon hasn't listed what's installed (it reads the
 * font folders: a web view can't list local fonts); only the installed ones show (SF Mono and Menlo always do on a Mac).
 */
export const TERMINAL_FONTS: readonly string[] = ['Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono', 'Source Code Pro', 'Hack', 'Iosevka', 'Berkeley Mono', 'Geist Mono', 'Courier New'];

/** The system's monospace (SF Mono on a Mac, where web views only reach it as ui-monospace; Cascadia Mono or Consolas on Windows; DejaVu Sans Mono on Linux). */
const SYSTEM = 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

/** The CSS font stack for a family, falling back to the system's monospace if it's missing. */
export const fontStack = (family: string): string => (family ? `"${family.replace(/"/g, '')}", ${SYSTEM}` : SYSTEM);

const installed = new Map<string, boolean>();

/**
 * Whether a font is installed: text drawn in it measures differently from the fallbacks.
 * (document.fonts.check can't tell for local fonts: it says yes to anything.)
 */
export function hasFont(family: string): boolean {
  const known = installed.get(family);
  if (known !== undefined) return known;
  let found = false;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      const sample = 'mmmmmmmmmlli10OO@#';
      found = ['monospace', 'serif', 'sans-serif'].some((fallback) => {
        ctx.font = `72px ${fallback}`;
        const plain = ctx.measureText(sample).width;
        ctx.font = `72px "${family}", ${fallback}`;
        return ctx.measureText(sample).width !== plain;
      });
    }
  } catch {
    found = false;
  }
  installed.set(family, found);
  return found;
}

/**
 * The fonts to offer: the monospace ones the daemon found installed (any of them, Nerd Fonts
 * too, #547), or the ones above when it hasn't said (an older daemon); only those this window
 * can draw, plus the one you picked even if it's gone (so the menu shows it).
 */
export function fontChoices(picked: string, installed: readonly string[] = [], has: (family: string) => boolean = hasFont): Array<{ value: string; label: string }> {
  const mac = keyPlatform() === 'mac';
  // Menlo is always on a Mac; elsewhere only what's really installed.
  const fonts = (installed.length ? installed : TERMINAL_FONTS).filter((f) => (mac && f === 'Menlo') || has(f));
  const extra = picked && !fonts.includes(picked) ? [{ value: picked, label: has(picked) ? picked : `${picked} (not installed)` }] : [];
  return [{ value: '', label: mac ? 'SF Mono (system)' : 'System monospace' }, ...fonts.map((f) => ({ value: f, label: f })), ...extra];
}

/** xterm's options for your terminal look. */
export const terminalOptions = (p: UiPrefs): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'cursorStyle' | 'cursorBlink' | 'scrollback' | 'cursorInactiveStyle' | 'macOptionIsMeta'> => ({
  fontFamily: fontStack(p.termFont),
  fontSize: p.termFontSize,
  lineHeight: p.termLineHeight,
  cursorStyle: p.termCursor,
  cursorInactiveStyle: 'outline',
  cursorBlink: p.termCursorBlink,
  scrollback: p.termScrollback,
  macOptionIsMeta: p.termOptionMeta,
});

/** Whether the window looks dark right now (prefs.ts puts it on the document). */
export const looksDark = (): boolean => document.documentElement.dataset.theme === 'dark';

/** The colours a terminal draws besides its background and text (those follow the window's). */
const ANSI_ONLY = new Set(['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground']);

/** The terminal colours that go with the window's theme (Dracula's in Dracula), or undefined for one without. */
export function windowThemeColors(p: UiPrefs, dark: boolean = looksDark()): Record<string, string> | undefined {
  const name = themeFor(dark ? 'dark' : 'light', p).term;
  const all = xtermColors(colorsFor(TERMINAL_PRESETS.find((t) => t.name === name), dark));
  return all ? Object.fromEntries(Object.entries(all).filter(([k]) => !ANSI_ONLY.has(k))) : undefined;
}

/**
 * The colours you brought from another terminal (Settings › Terminal › Import from…), as xterm
 * wants them; with Beluga's own, the window theme's (which follow the window's appearance), if any.
 */
export const importedTheme = (p: UiPrefs, dark: boolean = looksDark()): Record<string, string> | undefined => xtermColors(colorsFor(p.termTheme, dark)) ?? windowThemeColors(p, dark);
