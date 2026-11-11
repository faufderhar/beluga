/**
 * The window's language (docs/i18n.md). English is the source: the code keeps its English text, and
 * a catalog (`<locale>.json`) maps that text to another language, gettext style. Keys are the
 * English text exactly as it shows; `{0}`, `{1}`… stand for the parts a template fills in.
 *
 * Two ways in: `t()` for text that never reaches the page as DOM (notifications, native menus,
 * dialogs' titles), and `translatePage()` (dom.ts), which translates what the window draws as it
 * draws it. The choice is per window, kept in this window's storage, and applies on reload.
 */
import { compile, type Compiled, lookup } from './match.js';

export type Locale = 'en' | 'zh-CN';
export type LanguagePref = 'system' | Locale;

export const LOCALES: ReadonlyArray<{ readonly value: LanguagePref; readonly label: string }> = [
  { value: 'system', label: 'Match the System' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

const KEY = 'beluga.language';

/** The language picked in Settings › General (Match the System unless you chose). */
export function languagePref(): LanguagePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'zh-CN' || v === 'system') return v;
  } catch {
    // No storage in this window: the system decides.
  }
  return 'system';
}

/** The locale a preference means on this computer. */
export function resolveLocale(pref: LanguagePref, languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): Locale {
  if (pref !== 'system') return pref;
  for (const l of languages) {
    const low = l.toLowerCase();
    if (low === 'en' || low.startsWith('en-')) return 'en';
    // Simplified Chinese: zh, zh-CN, zh-SG, zh-Hans… (not zh-TW / zh-HK / zh-Hant, which have no catalog yet).
    if (low === 'zh' || low === 'zh-cn' || low === 'zh-sg' || low.startsWith('zh-hans')) return 'zh-CN';
  }
  return 'en';
}

let current: Locale = 'en';
let catalog: Compiled | null = null;

/** For dates the code writes out itself ("Fri 7:00"): the window's language, not the system's. */
export const dateLocale = (): string => (current === 'zh-CN' ? 'zh-CN' : 'en-US');

/** The locale this window shows. */
export function locale(): Locale {
  return current;
}

/** Loads the catalog this window's language needs (none for English). Call once, before the first render. */
export async function loadLocale(pref: LanguagePref = languagePref()): Promise<Locale> {
  current = resolveLocale(pref);
  document.documentElement.lang = current === 'en' ? 'en' : current;
  if (current === 'en') return current;
  try {
    const mod = (await import('./zh-CN.json')) as { default: Record<string, string> };
    catalog = compile(mod.default);
  } catch {
    // A catalog that can't load leaves the window in English rather than empty.
    current = 'en';
    document.documentElement.lang = 'en';
  }
  return current;
}

/** For tests and the native side: use this catalog now. */
export function useCatalog(next: Locale, entries: Record<string, string> | null): void {
  current = next;
  catalog = entries ? compile(entries) : null;
}

/**
 * The text in this window's language: `text` itself in English or when the catalog has no entry.
 * Templates: pass the filled-in English (`t(\`Save ${name}\`)`) and the catalog's "Save {0}" matches it.
 */
export function t(text: string): string {
  if (!catalog || !text) return text;
  return lookup(catalog, text) ?? text;
}

/** Names people gave things (own.ts): never translated. */
export function keepAsWritten(words: ReadonlySet<string>): void {
  if (!catalog) return;
  catalog.own = words;
  catalog.cache.clear();
}

/** Translated, or undefined when the catalog doesn't know it (dom.ts leaves those untouched). */
export function translated(text: string): string | undefined {
  return catalog ? lookup(catalog, text) : undefined;
}

/** Choose the language: saved for this Mac's windows, then the window reloads to show it. */
export function setLanguage(pref: LanguagePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Can't keep it: still switch for now.
  }
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_ui_language', { locale: resolveLocale(pref) }))
    .catch((e: unknown) => console.warn('[i18n] the native menus may not follow this language:', e))
    .finally(() => location.reload());
}
