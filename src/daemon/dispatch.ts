import { performance } from 'node:perf_hooks';
import { blackbox } from '../core/blackbox/recorder.js';
import { runAsClient } from '../core/client-context.js';
import type { Session } from '../core/session.js';
import { isMethod, parseArgs } from '../ipc/api.js';
import { HANDLERS } from '../ipc/handlers.js';
import { routeToAlwaysOn } from '../machines/friends.js';
import { featureCounter } from '../telemetry/features.js';

export type CallOutcome = { readonly ok: true; readonly value?: unknown } | { readonly ok: false; readonly error: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One API call, the way every screen's goes: the method must exist, its arguments are checked
 * against its zod tuple (api.ts), and its handler runs as that client (so what it asks a screen
 * to do goes back to that screen). The daemon's socket (server.ts) and the phone's link
 * (companion/host.ts) both call through here.
 */
export async function dispatchCall(session: Session, clientId: string, method: string, raw: readonly unknown[]): Promise<CallOutcome> {
  if (!isMethod(method)) return { ok: false, error: `Unknown method ${method}` };
  const began = performance.now();
  try {
    // JSON has no undefined: a left-out argument arrives as null.
    const args = parseArgs(method, raw.map((v) => (v === null ? undefined : v)));
    // Your friends network on your Always On (BLG-797): its calls go there, checked here first.
    const routed = routeToAlwaysOn(session, method, args as readonly unknown[], clientId);
    if (routed) return await routed;
    const handler = HANDLERS[method] as (s: Session, ...a: unknown[]) => unknown;
    const value = await runAsClient(clientId, () => handler(session, ...(args as unknown[])));
    blackbox.call(method, performance.now() - began);
    featureCounter.call(method, performance.now() - began, true);
    return { ok: true, ...(value === undefined ? {} : { value }) };
  } catch (err) {
    // The black box keeps the method and the error, never the arguments (they're people's words and files).
    blackbox.call(method, performance.now() - began, errorText(err));
    featureCounter.call(method, performance.now() - began, false);
    return { ok: false, error: errorText(err) };
  }
}
