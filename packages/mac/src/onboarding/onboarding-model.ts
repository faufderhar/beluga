/**
 * The first time Beluga opens: a welcome, your agents found and one picked as yours (BLG-507), a short tour (Sentinel's two steps among it, BLG-362), a look (and another terminal's, BLG-212), a few settings, the macOS permissions
 * (each optional), notifications, the phone app, then the app. It shows
 * once per Mac. Updating the app never brings it back (the mark is kept with this window's own
 * storage, which an update leaves alone), and someone who used Beluga before it existed never
 * sees it either. File › Onboard Again (or Help › Welcome to Beluga, or the palette) shows it again.
 * Quit halfway (macOS's "Quit & Reopen" after a permission, say) and it opens where it was left.
 */

import { keyPlatform } from '../lib/shortcuts-model.js';

/** Where the mark that you've been through it is kept. */
export const DONE_KEY = 'beluga.onboarding.v1';
/** The step it was on, so reopening Beluga (macOS's "Quit & Reopen" after a permission) comes back to it. */
export const PLACE_KEY = 'beluga.onboarding.place.v1';
/** How long after leaving a permission step in a replay reopening still comes back to it. */
export const RESUME_MS = 15 * 60 * 1000;
/** Beluga's own window preferences (lib/prefs.ts): there only once someone has used the app. */
export const PREFS_KEY = 'beluga.prefs.v1';
/** `?welcome` in the address shows it whatever the mark says (screenshots, development). */
export const FORCE_PARAM = 'welcome';
/** The document event File › Onboard Again, Help › Welcome to Beluga and the palette send to show it again. */
export const SHOW_WELCOME = 'beluga:welcome';

const ALL_STEPS = ['hello', 'yourAgents', 'parallel', 'agents', 'tables', 'machines', 'friends', 'sentinel', 'uses', 'earnings', 'archive', 'look', 'terminal', 'fire', 'setup', 'screen', 'accessibility', 'disk', 'automation', 'popups', 'phone', 'share', 'ready'] as const;
export type Step = (typeof ALL_STEPS)[number];

/** The steps on this computer: the macOS permissions only on a Mac (Linux and Windows don't ask). */
export const STEPS: readonly Step[] = keyPlatform() === 'mac' ? ALL_STEPS : ALL_STEPS.filter((s) => !['screen', 'accessibility', 'disk', 'automation'].includes(s));

/** The last step before the app (its button says Finish). */
export const LAST_SETTING: Step = 'share';

/**
 * The steps this build shows: usage statistics (`share`, BLG-922) only in a build that can send
 * them (Beluga's own releases), so one built from source looks as it always did.
 */
export const stepsFor = (share: boolean): readonly Step[] => (share ? STEPS : STEPS.filter((st) => st !== 'share'));

/** The last setting of these steps (its button says Finish). */
export const lastSettingOf = (steps: readonly Step[]): Step => steps[steps.length - 2] ?? LAST_SETTING;

/** The tour: what Beluga does, one idea a step (Skip Tour goes past all of them). */
export const TOUR: readonly Step[] = ['parallel', 'agents', 'tables', 'machines', 'friends', 'sentinel', 'uses', 'earnings', 'archive'];

/**
 * The macOS permissions, one a step, every one optional (Skip Permissions goes past all of them).
 * Notifications are asked for on the step after (`popups`).
 */
export const ACCESS = ['screen', 'accessibility', 'disk', 'automation'] as const;
export type AccessStep = (typeof ACCESS)[number];

export interface DoneMark {
  /** The app's version when you finished (or skipped). */
  readonly version: string;
  readonly at: number;
  /** Finished every step, left early, or still in it (quit halfway: it shows again). */
  readonly how: 'finished' | 'skipped' | 'started';
}

/** What `shouldShow` reads: a localStorage, or a stand-in for one in a test. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function readMark(raw: string | null): DoneMark | undefined {
  if (raw === null) return undefined;
  try {
    const mark = JSON.parse(raw) as Partial<DoneMark>;
    return mark.how === 'finished' || mark.how === 'skipped' || mark.how === 'started' ? (mark as DoneMark) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether to show it now: asked for, or never finished it. Someone with preferences but no mark
 * used Beluga before the onboarding existed, and isn't shown it. (Picking a theme in it writes
 * preferences too, so it marks itself `started` first: quit halfway and it's back next time.)
 */
export function shouldShow(store: Store, search = '', now = Date.now()): boolean {
  if (new URLSearchParams(search).has(FORCE_PARAM)) return true;
  if (resumeAt(store, now)) return true;
  try {
    const raw = store.getItem(DONE_KEY);
    const mark = readMark(raw);
    if (mark) return mark.how === 'started';
    // A mark that can't be read: treat it as done rather than showing it on every launch.
    if (raw !== null) return false;
    return store.getItem(PREFS_KEY) === null;
  } catch {
    // No storage to read: showing it every launch would be worse than not at all.
    return false;
  }
}

export function saveMark(store: Store, version: string, how: DoneMark['how'], now = Date.now()): DoneMark {
  const mark: DoneMark = { version, at: now, how };
  try {
    store.setItem(DONE_KEY, JSON.stringify(mark));
  } catch {
    // Storage full or off: it shows again next time, which is the lesser problem.
  }
  return mark;
}

/** Whether it was finished or skipped before (a replay then leaves that mark alone). */
export function wasDone(store: Store): boolean {
  try {
    const mark = readMark(store.getItem(DONE_KEY));
    return mark !== undefined && mark.how !== 'started';
  } catch {
    return false;
  }
}

/** Keep the step it's on (every step), so a quit and reopen comes back to it. */
export function savePlace(store: Store, step: Step, now = Date.now()): void {
  try {
    store.setItem(PLACE_KEY, JSON.stringify({ step, at: now }));
  } catch {
    // It starts from the welcome next time instead.
  }
}

/** Finished or skipped: nothing to come back to. */
export function clearPlace(store: Store): void {
  try {
    store.removeItem?.(PLACE_KEY);
  } catch {
    // Left behind, it's only read while the welcome would show anyway (or for a few minutes).
  }
}

/**
 * Where to pick up on launch. The first time through, wherever it was left. In a replay (the mark
 * says finished or skipped), only a permission step left a few minutes ago: that's macOS's
 * "Quit & Reopen", and anything else is someone who closed the replay on purpose.
 */
export function resumeAt(store: Store, now = Date.now()): Step | undefined {
  try {
    const raw = store.getItem(PLACE_KEY);
    if (raw === null) return undefined;
    const place = JSON.parse(raw) as { step?: unknown; at?: unknown };
    const step = STEPS.find((st) => st === place.step);
    if (!step || step === 'hello' || typeof place.at !== 'number') return undefined;
    if (!wasDone(store)) return step;
    return inAccess(step) && now - place.at >= 0 && now - place.at < RESUME_MS ? step : undefined;
  } catch {
    return undefined;
  }
}

export const stepIndex = (step: Step, steps: readonly Step[] = STEPS): number => steps.indexOf(step);

/** The step `by` places along (clamped to the first and last); a step not in `steps` counts from its place in all of them. */
export function stepBy(step: Step, by: number, steps: readonly Step[] = STEPS): Step {
  const at = steps.indexOf(step);
  const from = at >= 0 ? at : steps.findIndex((st) => STEPS.indexOf(st) > STEPS.indexOf(step)) - (by > 0 ? 1 : 0);
  const i = Math.min(steps.length - 1, Math.max(0, from + by));
  return steps[i]!;
}

/** From inside the tour (or the welcome), Skip Tour goes straight to the settings. */
export const afterTour = (): Step => 'look';

export const inTour = (step: Step): boolean => TOUR.includes(step);

export const inAccess = (step: Step): step is AccessStep => (ACCESS as readonly Step[]).includes(step);

/** From any permission step, Skip Permissions goes on to notifications. */
export const afterAccess = (): Step => 'popups';

/** "2 of 6" for the tour's steps; nothing for the others. */
export function tourPlace(step: Step): { readonly at: number; readonly of: number } | undefined {
  const i = TOUR.indexOf(step);
  return i < 0 ? undefined : { at: i + 1, of: TOUR.length };
}

/** "1 of 4" for the permission steps; nothing for the others. */
export function accessPlace(step: Step): { readonly at: number; readonly of: number } | undefined {
  const i = (ACCESS as readonly Step[]).indexOf(step);
  return i < 0 ? undefined : { at: i + 1, of: ACCESS.length };
}

/** Which group a step's dot sits in (the dots leave a little room between groups). */
export function groupOf(step: Step): 'tour' | 'access' | 'other' {
  return inTour(step) ? 'tour' : inAccess(step) ? 'access' : 'other';
}
