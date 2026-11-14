import type { AgentBackend } from '../agent/types.js';
import { type ObserveDeps, observedBackend } from './observe.js';

/**
 * Where the session's backends meet usage statistics. The session makes its backends before the
 * daemon starts the telemetry service (and the demo, tests and builds without a release config
 * never start one), so each backend is wrapped once and asks the service of the moment: none, and
 * every run goes straight through (level off).
 */

let current: ObserveDeps | undefined;

/** The daemon's telemetry service (src/telemetry/launch.ts); undefined when it stops. */
export function attachObserver(deps: ObserveDeps | undefined): void {
  current = deps;
}

const live: ObserveDeps = {
  level: () => current?.level() ?? 'off',
  turn: (f) => current?.turn(f),
  excluded: (input) => current?.excluded?.(input) ?? false,
  env: (runtime) => current?.env?.(runtime),
  calls: (session, from, to) => current?.calls?.(session, from, to) ?? [],
};

/** A runtime's backend whose turns usage statistics hear about (passes straight through while off). */
export function observeRuntime(backend: AgentBackend, runtime: string): AgentBackend {
  return observedBackend(backend, runtime, live);
}
