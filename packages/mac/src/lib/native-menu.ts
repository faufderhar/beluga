import { type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inApp } from './boot.js';
import { isMac } from './system.js';
import { t } from '../i18n/index.js';
import { iconShape } from '../components/Icon.js';
import { type Made, type NativeRow, type Picture, nativeItems } from './native-menu-model.js';

export type { NativeRow } from './native-menu-model.js';

/**
 * The Mac's own menus for the app's right-click menus, pull-downs and pop-up buttons
 * (components/SpecMenu.tsx, components/Select.tsx and the menus built on them).
 *
 * A menu the web view draws gives itself away: its blur, how a submenu opens, typing a letter to
 * jump to an item, how it goes away, and macOS's own look as it changes (macOS 26's glass). In
 * the app on a Mac, a menu is an NSMenu instead (src-tauri/src/native_menu.rs): names through
 * t(), a hint as the line under an item, shortcuts on the right, checkmarks, sections, submenus,
 * and the app's icons as template images the system tints. Browsers, Windows and Linux keep the
 * web menus.
 */

/**
 * Native menus here: off (BLG-1023). The Mac's NSMenus didn't look like the rest of Beluga (the mode
 * menu, the PR's •••), so every menu is the app's own again. The NSMenu path stays, behind this one switch.
 */
const NATIVE_MENUS = false;
export const nativeMenus = (): boolean => NATIVE_MENUS && inApp() && isMac();

const PX = 32; // 16 pt at 2×.
const pictures = new Map<string, Made>();

async function png(canvas: OffscreenCanvas): Promise<number[]> {
  return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
}

/** An SVG's markup drawn at 16 pt; a shape in currentColor only is a template the system tints. */
async function fromSvg(markup: string): Promise<Made | undefined> {
  const coloured = /(fill|stroke|stop-color)="(?!none|currentColor|transparent)[^"]+"|(fill|stroke|background|color):\s*(?!none|currentColor|transparent|inherit)[#a-z]/i.test(markup);
  let svg = markup.replace(/currentColor/g, '#000').replace(/\swidth="[^"]*"/, ` width="${PX}"`).replace(/\sheight="[^"]*"/, ` height="${PX}"`);
  if (!/xmlns=/.test(svg)) svg = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image(PX, PX);
    img.src = url;
    await img.decode();
    const canvas = new OffscreenCanvas(PX, PX);
    canvas.getContext('2d')?.drawImage(img, 0, 0, PX, PX);
    return { png: await png(canvas), template: !coloured };
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A row's picture as a PNG: the app's icon (a template), a colour dot, or a mark that's an SVG. */
export async function picture(p: Picture): Promise<Made | undefined> {
  if (!p) return undefined;
  if ('mark' in p) {
    if (!isValidElement(p.mark)) return undefined;
    // A mark that reads the app's context (a project's icon: useBeluga) can't be drawn outside the app's
    // tree: it throws here, and one such row must not take the whole menu with it. No picture then.
    let markup: string;
    try {
      markup = renderToStaticMarkup(p.mark as ReactElement).trim();
    } catch {
      return undefined;
    }
    if (!markup.startsWith('<svg')) return undefined;
    const kept = pictures.get(markup);
    if (kept) return kept;
    const made = await fromSvg(markup);
    if (made) pictures.set(markup, made);
    return made;
  }
  const key = 'icon' in p ? `icon:${p.icon}` : `swatch:${p.swatch}`;
  const kept = pictures.get(key);
  if (kept) return kept;
  const canvas = new OffscreenCanvas(PX, PX);
  const g = canvas.getContext('2d');
  if (!g) return undefined;
  let template = true;
  if ('icon' in p) {
    const shape = iconShape(p.icon);
    g.scale(PX / shape.grid, PX / shape.grid);
    const path = new Path2D(shape.d);
    if (shape.filled) {
      // An agent's logo in its own colour stays that colour; a plain one is tinted.
      template = !shape.color;
      g.fillStyle = shape.color ?? '#000';
      g.fill(path, shape.evenOdd ? 'evenodd' : 'nonzero');
    } else {
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke(path);
    }
  } else {
    template = false;
    g.fillStyle = p.swatch;
    g.beginPath();
    g.arc(PX / 2, PX / 2, PX * 0.3, 0, Math.PI * 2);
    g.fill();
  }
  const made = { png: await png(canvas), template };
  pictures.set(key, made);
  return made;
}

let showing = false;

export interface PopUpAt {
  /** The window's points from its top-left: the menu's top-left corner, or the chosen row's. */
  readonly x: number;
  readonly y: number;
  /** A pop-up button's chosen row (its index in `rows`), put at the point, over the button. */
  readonly selected?: number;
  /** A pull-down's button top edge: when the menu doesn't fit below the button, it opens above it. */
  readonly above?: number;
}

/**
 * Shows the rows as the Mac's own menu, at the pointer or at `at`, and runs what was picked once
 * it closes. False when it couldn't be shown: the caller opens nothing then (a press does nothing
 * rather than open two menus).
 */
export async function popUpNative(rows: readonly NativeRow[], at?: PopUpAt): Promise<boolean> {
  if (showing) return true;
  showing = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const picks: Array<() => void> = [];
    const list: readonly NativeRow[] = rows.length ? rows : [{ label: 'Nothing to do here', disabled: true }];
    const items = await nativeItems(list, t, picture, picks);
    // The chosen row's id is where its action went in `picks`.
    const chosen = at?.selected === undefined ? undefined : list[at.selected]?.onSelect;
    const selected = chosen && picks.includes(chosen) ? picks.indexOf(chosen) : null;
    const picked = await invoke<number | null>('native_menu', { items, x: at?.x ?? null, y: at?.y ?? null, selected, above: at?.above ?? null });
    if (picked != null) picks[picked]?.();
    return true;
  } catch (e) {
    console.warn('native menu failed:', e);
    return false;
  } finally {
    showing = false;
  }
}

/**
 * A right-click that opens the Mac's menu, ahead of a web menu's own (Radix's Trigger): this
 * calls preventDefault, which Radix's handler respects, so its menu stays shut. Elsewhere it
 * leaves the event alone.
 */
export function nativeContext(rows: () => readonly NativeRow[]) {
  return (e: MouseEvent): void => {
    if (e.defaultPrevented || !nativeMenus()) return;
    e.preventDefault();
    void popUpNative(rows());
  };
}

/**
 * A button's pull-down as the Mac's: it opens on the press (as a Mac's does, and Radix's), its top
 * edge just under the button, or with the chosen row over it for a pop-up button (`selected`).
 * Spread onto the trigger, ahead of the web menu's own handlers.
 */
export function nativeDropdown(rows: () => readonly NativeRow[], selected?: () => number | undefined, fallback?: () => void) {
  const open = (e: MouseEvent | KeyboardEvent): void => {
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = selected?.();
    // When the Mac's menu couldn't be shown, the web menu opens instead: a press never does nothing.
    void popUpNative(rows(), at === undefined || at < 0 ? { x: box.left, y: box.bottom + 4, above: box.top - 4 } : { x: box.left, y: box.top, selected: at }).then((shown) => {
      if (!shown) fallback?.();
    });
  };
  return {
    onPointerDown: (e: PointerEvent): void => {
      if (e.defaultPrevented || !nativeMenus() || e.button !== 0 || e.ctrlKey) return;
      open(e);
    },
    onKeyDown: (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !nativeMenus() || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
      open(e);
    },
  };
}
