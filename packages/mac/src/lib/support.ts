import { useSyncExternalStore } from 'react';

/**
 * Supporting Beluga: a star on GitHub and your feedback, nothing more (Beluga never asks for
 * money). The ask that comes with the third merge is the daemon's (the shared state's `support`,
 * core/support-store.ts); the Star sheet opened by hand (Settings › About, the palette) is the same
 * sheet, any time, telling the daemon nothing.
 */

export const GITHUB_URL = 'https://github.com/beluga-labs/beluga';

/** Where "Share feedback" goes: a new discussion in the repo's General category. */
export const FEEDBACK_URL = `${GITHUB_URL}/discussions/new?category=general`;

/** Who makes Beluga, shown as a GitHub chip (the avatar ships with the app: the window loads no remote images). */
export const MAINTAINER = { login: 'kayraucklnc', url: 'https://github.com/kayraucklnc' } as const;

// ---- the Star sheet opened by hand

let opened = false;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

export function openSupport(): void {
  opened = true;
  emit();
}

export function closeSupport(): void {
  if (!opened) return;
  opened = false;
  emit();
}

/** Whether you opened the Star sheet yourself. */
export const useOpenedSupport = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => opened,
  );
