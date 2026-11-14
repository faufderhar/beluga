import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { MachineView } from '@beluga/machines/machines.js';
import { everyWhileShown } from '../lib/window-active.js';

/**
 * Your computers as this Mac's daemon lists them (machines.list), shared by every view that names
 * one (a pane's tag, Runs on, the sidebar): asked again every so often while any of them shows,
 * and the last list kept for when this Mac's daemon can't say.
 */

const REFRESH_MS = 15_000;
let list: readonly MachineView[] = [];
let users = 0;
/** Stops the refresh beat (everyWhileShown: it rests while the window can't be seen). */
let stopRefresh: (() => void) | undefined;
let asking: SocketClient | undefined;
const listeners = new Set<() => void>();

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Your computers as last listed (for what starts work outside a view). */
export const currentMachines = (): readonly MachineView[] => list;

/** The listing on its way (a busy daemon's answer is waited for, not asked again behind it, BLG-942). */
let listing: SocketClient | undefined;

/** Ask this Mac's daemon now (unless it's already being asked). */
export function refreshMachines(home: SocketClient): void {
  if (listing === home) return;
  listing = home;
  const done = (): void => {
    if (listing === home) listing = undefined;
  };
  void home.call('machines.list').then(
    (next) => {
      done();
      list = next as readonly MachineView[];
      for (const l of [...listeners]) l();
    },
    done,
  );
}

/** Your computers (none paired: empty), kept fresh while shown. */
export function useMachines(home: SocketClient): readonly MachineView[] {
  useEffect(() => {
    users++;
    if (asking !== home || !stopRefresh) {
      stopRefresh?.();
      asking = home;
      refreshMachines(home);
      stopRefresh = everyWhileShown(() => refreshMachines(home), REFRESH_MS);
    }
    return () => {
      if (--users > 0) return;
      stopRefresh?.();
      stopRefresh = undefined;
    };
  }, [home]);
  return useSyncExternalStore(subscribe, () => list);
}

/** One computer by id, while it's listed. */
export function useMachineView(home: SocketClient, id: string): MachineView | undefined {
  return useMachines(home).find((m) => m.id === id);
}
