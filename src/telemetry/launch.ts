import { runtimeStatuses } from '../agent/runtime/registry.js';
import type { EnvVars } from '../core/env-vars.js';
import type { Store } from '../core/store.js';
import { installedVersion } from '../core/version.js';
import { releaseConfig } from './config.js';
import { attachObserver } from './hook.js';
import { TelemetryService } from './service.js';

/** The telemetry service of each session (the IPC handlers find it here). */
const services = new WeakMap<object, TelemetryService>();

/** This session's usage statistics, or a clear error where there are none (a session no daemon runs, e.g. tests). */
export function telemetryOf(session: object): TelemetryService {
  const s = services.get(session);
  if (!s) throw new Error('Usage statistics live in the Beluga app (its daemon).');
  return s;
}

/** The demo's stand-in for Ratel: every send "succeeds" here, and nothing goes over the network. */
const DEMO = { url: 'https://ratel.invalid', key: 'rtl_pub_demo' } as const;
const demoFetch: typeof fetch = async () => new Response(null, { status: 202 });

/**
 * Start usage statistics for the daemon. The demo never sends (its "Ratel" answers on this computer,
 * its record is in memory): it shows the ask when BELUGA_DEMO_ASKS is `telemetry` (screenshots of the
 * sheet), else it's answered.
 */
export function launchTelemetry(host: { readonly session: object & { readonly env: Pick<EnvVars, 'secretValues'> }; readonly store: Store; readonly demo: boolean; readonly asks?: string }): () => Promise<void> {
  const config = host.demo ? undefined : releaseConfig();
  let ready: readonly string[] = [];
  if (config)
    void runtimeStatuses()
      .then((all) => (ready = all.filter((r) => r.state === 'ready').map((r) => r.id)))
      .catch(() => undefined);
  const service = new TelemetryService({
    store: host.store,
    ...(config ? { config } : {}),
    version: installedVersion(),
    ...(host.demo ? { file: null, pretend: true, config: DEMO, fetch: demoFetch } : {}),
    secrets: () => host.session.env.secretValues(),
    runtimes: () => ready,
  });
  if (host.demo && host.asks !== 'telemetry') service.choose('limited', 'settings');
  services.set(host.session, service);
  attachObserver(service.observeDeps());
  service.start();
  return async () => {
    attachObserver(undefined);
    services.delete(host.session);
    await service.stop();
  };
}

