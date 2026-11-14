import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { LogItem, Store } from '../store.js';
import type { WorktreeEvent } from '../workspace-controller.js';
import { TriageService } from './service.js';

/** Which triage service serves a session (the daemon's), so the API can reach it. */
const services = new WeakMap<object, TriageService>();

export interface TriageHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Start each chat's category and Remind Me Later for the daemon: ~/.beluga/triage.json; the demo's lives in a temporary folder. */
export function launchTriage(host: TriageHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-triage-')) : belugaHome();
  const service = new TriageService({
    store,
    file: path.join(dir, 'triage.json'),
    notify: (e) => session.notifier.notify(e),
    history: (id) => session.workspaces?.manager.loadHistory<LogItem>(id) ?? [],
    ...(session.workspaces ? { onWorktree: (listener: (event: WorktreeEvent) => void) => session.workspaces!.onWorktree(listener), forgetReminders: (ids: readonly string[]) => session.workspaces!.forgetReminders(ids), archive: (id: string) => session.workspaces!.archive(id, false, { quiet: true }) } : {}),
  });
  services.set(session, service);
  return () => {
    services.delete(session);
    service.stop();
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}

/** The session's triage service, or a clear error where there is none (the terminal on its own). */
export function needTriage(session: object): TriageService {
  const service = services.get(session);
  if (!service) throw new Error('Chat categories need the Beluga app (its daemon): they are not available here.');
  return service;
}

/** Runs `send`, a prompt Beluga sends in your name by itself, so the session's triage doesn't take it for your message. */
export function sendAutomatic<T>(session: object, send: () => T): T {
  const service = services.get(session);
  return service ? service.automatic(send) : send();
}
