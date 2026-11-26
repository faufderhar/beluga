import type { IconName } from '../components/Icon.js';

/** The pure part of lib/native-menu.ts: rows as the Mac's menu takes them, and their shortcuts. */

/** What a row of a native menu needs; components/SpecMenu.tsx's ActionItem fits it. */
export interface NativeRow {
  readonly label: string;
  /** A line under it (the menu item's subtitle). */
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly keys?: string;
  readonly icon?: IconName;
  /** A mark of its own (a computer's, a board's): drawn as the row's picture when it's an SVG. */
  readonly mark?: unknown;
  readonly separate?: boolean;
  readonly checked?: boolean;
  readonly swatch?: string;
  readonly submenu?: readonly NativeRow[];
  /** A section's title above this row (a pop-up button's sections). */
  readonly header?: string;
  readonly onSelect?: () => void;
}

/** A shortcut as NSMenu shows it on the right: its key equivalent and modifiers (1 ⌘, 2 ⇧, 4 ⌥, 8 ⌃). */
export interface KeyEquivalent {
  readonly key: string;
  readonly modifiers: number;
}

const MODIFIERS: Readonly<Record<string, number>> = { '⌘': 1, '⇧': 2, '⌥': 4, '⌃': 8 };
// AppKit's key equivalents for the keys that aren't a character (NSEvent's function keys).
const NAMED: Readonly<Record<string, string>> = {
  '↩': '\r', '⏎': '\r', '⌤': '\r', Enter: '\r', Return: '\r',
  '⌫': '\b', Delete: '\b', '⌦': '\u007f', '⎋': '\u001b', Esc: '\u001b', '⇥': '\t', Tab: '\t', Space: ' ',
  '↑': '', '↓': '', '←': '', '→': '',
};

/**
 * A shortcut as the app writes it (⇧⌘C, ⌘↩, ⌥⌘1, ⌘F5) as NSMenu's key equivalent, or undefined
 * when it isn't one (then the row shows none rather than a wrong one). A bare key isn't one: a
 * menu item's key equivalent would fire on it.
 */
export function keyEquivalentOf(keys: string | undefined): KeyEquivalent | undefined {
  if (!keys) return undefined;
  let rest = keys.trim();
  let modifiers = 0;
  while (rest.length > 1 && MODIFIERS[rest[0]!]) {
    modifiers |= MODIFIERS[rest[0]!]!;
    rest = rest.slice(1);
  }
  if (!modifiers) return undefined;
  const fn = /^F([1-9]|1[0-2])$/.exec(rest);
  const key = NAMED[rest] ?? (fn ? String.fromCharCode(0xf704 + Number(fn[1]) - 1) : /^[A-Za-z0-9,.\/;'\[\]\\`=-]$/.test(rest) ? rest.toLowerCase() : undefined);
  return key ? { key, modifiers } : undefined;
}

/** One row as the native menu command takes it (src-tauri/src/native_menu.rs: NativeItem). */
export type NativeItem =
  | { readonly kind: 'separator' }
  | { readonly kind: 'header'; readonly text: string }
  | {
      readonly kind: 'item';
      readonly id?: number;
      readonly text: string;
      readonly subtitle?: string;
      readonly enabled: boolean;
      readonly checked?: boolean;
      readonly key?: string;
      readonly modifiers?: number;
      readonly icon?: number[];
      readonly template?: boolean;
      readonly items?: NativeItem[];
    };

/** What a row's picture is: an icon, a colour dot or a mark, or none. */
export type Picture = { readonly icon: IconName } | { readonly swatch: string } | { readonly mark: unknown } | undefined;

/** A picture made for a row: a PNG, and whether the system tints it (a shape) or not (its own colours). */
export interface Made {
  readonly png: number[];
  readonly template: boolean;
}

/**
 * The rows as the native menu takes them, with a separator before each new group (as the web
 * menu draws them) and an id for each row that does something, its index in `picks`.
 */
export async function nativeItems(rows: readonly NativeRow[], translate: (text: string) => string, picture: (p: Picture) => Promise<Made | undefined>, picks: Array<() => void>): Promise<NativeItem[]> {
  const out: NativeItem[] = [];
  for (const [i, row] of rows.entries()) {
    if (i > 0 && (row.separate || row.header || (row.danger && !rows[i - 1]!.danger))) out.push({ kind: 'separator' });
    if (row.header) out.push({ kind: 'header', text: translate(row.header) });
    // NSMenu draws a checkmark in its own column, beside the picture.
    const pic = await picture(row.icon ? { icon: row.icon } : row.swatch ? { swatch: row.swatch } : row.mark != null ? { mark: row.mark } : undefined);
    const keys = row.submenu ? undefined : keyEquivalentOf(row.keys);
    const base = {
      kind: 'item' as const,
      text: translate(row.label),
      enabled: !row.disabled,
      ...(row.hint ? { subtitle: translate(row.hint) } : {}),
      ...(row.checked ? { checked: true } : {}),
      ...(keys ? { key: keys.key, modifiers: keys.modifiers } : {}),
      ...(pic ? { icon: pic.png, template: pic.template } : {}),
    };
    if (row.submenu) {
      out.push({ ...base, items: await nativeItems(row.submenu, translate, picture, picks) });
      continue;
    }
    if (row.onSelect && !row.disabled) {
      picks.push(row.onSelect);
      out.push({ ...base, id: picks.length - 1 });
    } else out.push(base);
  }
  return out;
}
