import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { appUpdate } from '../modules/app-update';
import { kv } from './kv';
import { newer, type Release, releaseOf } from './release';
import { store } from './store';

/**
 * The phone app updating itself (BLG-426, docs/updates.md "The phone app"), like Beluga for Mac:
 * it looks at the latest GitHub release at launch (unless it looked less than an hour ago) and
 * every 4 hours while open. A newer `Beluga-X.apk` downloads by itself on Wi-Fi (on mobile data,
 * when you tap Update Now), is checked (Beluga, newer, the release's size and SHA-256), and goes to
 * Android's installer. With Update automatically on, it installs once you leave the app; Android
 * asks you once, then (Android 12+, installs allowed for Beluga) updates go in without asking.
 * Android only.
 */

const RELEASES = 'https://api.github.com/repos/beluga-labs/beluga/releases/latest';
const HOUR = 60 * 60 * 1000;
const EVERY = 4 * HOUR;

export type { Release };

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'found' | 'downloading' | 'ready' | 'installing' | 'confirm' | 'failed';

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly release?: Release;
  /** Downloaded, 0 to 1. */
  readonly progress?: number;
  readonly error?: string;
  readonly checkedAt?: number;
}

export const updatesAvailable = (): boolean => Platform.OS === 'android' && appUpdate.available;
/** The installed version (1.7.0), from Android itself. */
export const appVersion = (): string | undefined => appUpdate.version();

/** Update automatically (on unless you turned it off) and Check for updates (on), as on the Mac. */
export const autoOn = (): boolean => checkOn() && kv.get<boolean>('update.auto') !== false;
export const checkOn = (): boolean => kv.get<boolean>('update.check') !== false;
export function setAuto(on: boolean): void {
  kv.set('update.auto', on);
  // Updating by itself needs it to look; not looking can't update by itself.
  if (on) kv.set('update.check', true);
  set({});
}
export function setCheck(on: boolean): void {
  kv.set('update.check', on);
  if (!on) kv.set('update.auto', false);
  set({});
}

let state: UpdateState = { phase: 'idle', checkedAt: kv.get<number>('update.at') };
let path: string | undefined;
const subs = new Set<() => void>();
function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  emit();
}
function emit(): void {
  for (const s of subs) s();
}
const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
export const useUpdate = (): UpdateState => useSyncExternalStore(subscribe, () => state);
export const updateNow = (): UpdateState => state;

let busy = false;
/** The last look that failed, so a launch doesn't ask GitHub again at once. */
let tried = 0;

/** Look for a newer version (by hand from Check Now: it says what it found). */
export async function checkForUpdate(manual = false): Promise<void> {
  if (!updatesAvailable() || busy || ['downloading', 'installing', 'confirm'].includes(state.phase)) return;
  busy = true;
  set({ phase: state.phase === 'ready' ? 'ready' : 'checking', error: undefined });
  try {
    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub asks to wait a while' : `GitHub answered ${res.status}`);
    const release = releaseOf(await res.json());
    const at = Date.now();
    kv.set('update.at', at);
    const mine = appVersion() ?? '0.0.0';
    if (!release || !newer(release.version, mine)) {
      path = undefined;
      appUpdate.discard();
      set({ phase: 'current', release: undefined, checkedAt: at });
      if (manual) store.toast({ text: `Beluga ${mine} is the newest`, tone: 'ok' });
      return;
    }
    const same = state.release?.version === release.version && state.phase === 'ready';
    set({ phase: same ? 'ready' : 'found', release, checkedAt: at });
    // On Wi-Fi it downloads by itself, as the Mac does; mobile data waits for Update Now.
    if (!same && !appUpdate.metered()) void download();
  } catch (e) {
    tried = Date.now();
    set({ phase: state.release ? 'found' : 'failed', error: (e as Error).message });
    if (manual) store.toast({ text: `Couldn’t look for updates: ${(e as Error).message}`, tone: 'warn' });
  } finally {
    busy = false;
  }
}

async function download(): Promise<boolean> {
  const r = state.release;
  if (!r || state.phase === 'downloading') return false;
  set({ phase: 'downloading', progress: 0, error: undefined });
  try {
    path = await appUpdate.download(r.url, r.size, r.sha256, r.name);
    set({ phase: 'ready', progress: 1 });
    return true;
  } catch (e) {
    path = undefined;
    set({ phase: 'found', progress: undefined, error: (e as Error).message });
    return false;
  }
}

/** Update Now: download if it isn't yet, then Android's installer (the app closes as it goes in). */
export async function installUpdate(): Promise<void> {
  if (!state.release) return;
  if (state.phase !== 'ready' || !path) {
    if (!(await download())) {
      store.toast({ text: `The update didn’t download: ${state.error ?? 'try again'}`, tone: 'warn' });
      return;
    }
  }
  set({ phase: 'installing' });
  kv.set('update.from', appVersion());
  try {
    await appUpdate.install(path!);
  } catch (e) {
    set({ phase: 'failed', error: (e as Error).message });
  }
}

let started = false;

/** From the app's root: look now if it's due and every 4 hours, install by itself once you leave the app. */
export function startUpdates(): void {
  if (started || !updatesAvailable()) return;
  started = true;
  // Updated since last time: say so once, and drop the downloaded file.
  const from = kv.get<string>('update.from');
  const mine = appVersion();
  if (from && mine && newer(mine, from)) {
    kv.remove('update.from');
    appUpdate.discard();
    setTimeout(() => store.toast({ text: `Updated to Beluga ${mine}`, tone: 'ok' }), 1500);
  }
  appUpdate.onProgress((got, size) => {
    if (state.phase === 'downloading') set({ progress: size > 0 ? got / size : undefined });
  });
  appUpdate.onStatus((s) => {
    if (s.status === 'confirm') set({ phase: 'confirm' });
    else if (s.status === 'aborted') set({ phase: path ? 'ready' : 'found' });
    else if (s.status === 'failed') set({ phase: path ? 'ready' : 'found', error: s.message ?? 'Android didn’t install it' });
  });
  // At launch an hour is enough; while open, every 4 hours (a failed look tries again after an hour).
  const due = (gap: number): boolean => checkOn() && Date.now() - Math.max(kv.get<number>('update.at') ?? 0, tried) > gap;
  if (due(HOUR)) void checkForUpdate();
  setInterval(() => {
    if (AppState.currentState === 'active' && due(state.phase === 'failed' ? HOUR : EVERY)) void checkForUpdate();
  }, 10 * 60 * 1000);
  AppState.addEventListener('change', (s) => {
    appUpdate.front(s === 'active');
    if (s === 'active') {
      // Back from Android's confirmation without installing: the update is still here.
      if (state.phase === 'confirm' || state.phase === 'installing') set({ phase: path ? 'ready' : 'found' });
      if (due(state.phase === 'failed' ? HOUR : EVERY)) void checkForUpdate();
    } else if (s === 'background' && autoOn() && state.phase === 'ready' && appUpdate.quiet()) {
      // Away from the app, as the Mac waits for you to be idle: it goes in without asking.
      void installUpdate();
    }
  });
}
