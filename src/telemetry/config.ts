import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { belugaEnv } from '../core/beluga-env.js';

/**
 * Where usage statistics go, if anywhere. Only Beluga's own releases carry it: scripts/build-sidecar.mjs
 * writes telemetry-release.json beside the daemon's package.json when the release is built with
 * BELUGA_TELEMETRY_URL and BELUGA_TELEMETRY_KEY set (the maintainer's machine, or the release
 * workflow's secrets). Its key is a Ratel ingest-only key: it can add data to one project and read
 * nothing, so it's safe inside an app. A build from source has no file: it never asks and never sends.
 *
 * BELUGA_TELEMETRY_URL and BELUGA_TELEMETRY_KEY in the daemon's own environment work too (your own
 * build sending to your own Ratel project); BELUGA_TELEMETRY=0 turns it all off whatever the file says.
 */

export const ReleaseConfig = z.object({
  /** Ratel's ingest base: `<url>/v1/traces` and `<url>/v1/logs`. */
  url: z.string().url().refine((u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u), 'https only (or this computer)'),
  key: z.string().min(8).max(400),
});
export type ReleaseConfig = z.infer<typeof ReleaseConfig>;

const MANIFEST = new URL('../../telemetry-release.json', import.meta.url);

/** This build's config, or undefined: nothing can be sent. */
export function releaseConfig(env: (name: string) => string | undefined = belugaEnv): ReleaseConfig | undefined {
  if (env('TELEMETRY') === '0') return undefined;
  const url = env('TELEMETRY_URL');
  const key = env('TELEMETRY_KEY');
  if (url && key) return parsed({ url, key });
  try {
    return parsed(JSON.parse(readFileSync(MANIFEST, 'utf8')));
  } catch {
    return undefined;
  }
}

function parsed(raw: unknown): ReleaseConfig | undefined {
  const r = ReleaseConfig.safeParse(raw);
  return r.success ? { url: r.data.url.replace(/\/+$/, ''), key: r.data.key } : undefined;
}
