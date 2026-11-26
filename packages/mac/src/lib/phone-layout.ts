import { useSyncExternalStore } from 'react';
import type { UiPrefs } from './prefs.js';

/**
 * The app in a phone's browser (BLG-6: Beluga on a server, opened from a phone). At this width or
 * narrower the window is one column: the page fills it, the sidebar is a drawer over it and the
 * panel a sheet (layout/PhoneFrame.tsx). The app's own window is never this narrow (tauri.conf.json:
 * 860px at least), so only a browser gets here.
 */
export const PHONE_MAX_WIDTH = 700;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export const isPhoneWidth = (width: number): boolean => width <= PHONE_MAX_WIDTH;

/**
 * Coming in to the phone layout: the page first, the drawer and the sheet closed until asked for,
 * and the sheet's terminal group folded to its tabs (half a phone's sheet is too much for it: a
 * diff gets the room, the terminal is a tap away).
 */
export function phoneEntryPrefs(prefs: UiPrefs): Partial<UiPrefs> {
  return { ...(prefs.sidebar ? { sidebar: false } : {}), ...(prefs.inspector ? { inspector: false } : {}), ...(prefs.bottomOpen ? { bottomOpen: false } : {}) };
}

/** Back to a wider window: its sidebar shows again (the panel stays as you left it). */
export function phoneExitPrefs(prefs: UiPrefs): Partial<UiPrefs> {
  return prefs.sidebar ? {} : { sidebar: true };
}

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/** The window is phone-wide now (and again whenever that changes: a turned tablet, a narrowed browser). */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}
