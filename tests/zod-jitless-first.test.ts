import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * zod's `new Function` probe is a CSP violation in the app and the web port, and a bundled chunk
 * can make schemas before src/lib/zod-jitless.ts runs. So packages/mac/public/zod-jitless.js, a
 * classic script that runs before every module, turns jitless on through zod's global config.
 */
const mac = path.resolve(import.meta.dirname, '../packages/mac');
const WINDOWS = ['index.html', 'call.html', 'overlay.html', 'popup.html'];

describe('zod is jitless before any module runs', () => {
  it.each(WINDOWS)('%s loads /zod-jitless.js as a classic script before its module script', (file) => {
    const html = readFileSync(path.join(mac, file), 'utf8');
    const early = html.indexOf('<script src="/zod-jitless.js"></script>');
    const module = html.indexOf('<script type="module"');
    expect(early).toBeGreaterThan(-1);
    expect(module).toBeGreaterThan(early);
  });

  it('the script sets jitless on the global config, keeping what was there', () => {
    const script = readFileSync(path.join(mac, 'public/zod-jitless.js'), 'utf8');
    const sandbox: { globalThis?: unknown; __zod_globalConfig?: Record<string, unknown> } = { __zod_globalConfig: { locale: 'x' } };
    sandbox.globalThis = sandbox;
    runInNewContext(script, sandbox);
    expect(sandbox.__zod_globalConfig).toEqual({ locale: 'x', jitless: true });
  });

  it('zod reads its config from globalThis.__zod_globalConfig, as the script assumes', async () => {
    const z = await import('zod');
    const global = (globalThis as { __zod_globalConfig?: Record<string, unknown> }).__zod_globalConfig;
    expect(global).toBeDefined();
    expect(z.config()).toBe(global);
  });
});
