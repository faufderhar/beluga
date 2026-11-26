import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fencePlugin } from '../src/preview/bundle.js';
import { buildProblem } from '../src/preview/problems.js';
import { aliasesOf, resolveImport } from '../src/preview/project.js';
import { kitLibOf, svelteKitPlugin } from '../src/preview/sveltekit.js';

/**
 * SvelteKit components in a preview (#641): `$lib` is the app's src/lib, and `$app/*` and
 * `$env/*` stand in as small modules, as Next.js's do, so a Kit component draws on its own.
 */

let root: string;
let app: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-kit-')));
  // A monorepo: the Kit app is in apps/web, with its own svelte.config.js.
  app = path.join(root, 'apps', 'web');
  mkdirSync(path.join(app, 'src', 'lib', 'ui'), { recursive: true });
  writeFileSync(path.join(app, 'svelte.config.js'), 'export default { kit: {} };\n');
  writeFileSync(path.join(app, 'src', 'lib', 'format.ts'), 'export const shout = (s: string): string => s.toUpperCase();\n');
  writeFileSync(path.join(app, 'src', 'lib', 'index.ts'), "export const NAME = 'kit';\n");
  writeFileSync(path.join(app, 'src', 'lib', 'ui', 'Nav.ts'), [
    "import { goto, invalidateAll, beforeNavigate } from '$app/navigation';",
    "import { page as pageState, navigating } from '$app/state';",
    "import { page } from '$app/stores';",
    "import { browser, dev, building } from '$app/environment';",
    "import { base, resolve } from '$app/paths';",
    "import { enhance } from '$app/forms';",
    "import { PUBLIC_SITE } from '$env/static/public';",
    "import { env } from '$env/dynamic/public';",
    "import { shout } from '$lib/format';",
    "import { NAME } from '$lib';",
    'beforeNavigate(() => undefined);',
    'let fromStore = "";',
    'page.subscribe((p) => { fromStore = p.url.pathname; })();',
    'const form = enhance({} as HTMLFormElement);',
    'export const out = { title: shout("hi"), name: NAME, path: pageState.url.pathname, fromStore, navigating: navigating.type, browser, dev, building, base, to: resolve("/blog/[slug]", { slug: "a" }), site: PUBLIC_SITE, env, destroy: typeof form.destroy };',
    "export const go = () => (goto('/next'), invalidateAll());",
  ].join('\n'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function bundle(entry: string): Promise<string> {
  const out = await build({
    stdin: { contents: `import * as M from ${JSON.stringify(entry)}; globalThis.M = M;`, resolveDir: path.dirname(entry), loader: 'ts' },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', absWorkingDir: root,
    plugins: [fencePlugin(root), svelteKitPlugin(root)],
  });
  return out.outputFiles[0]!.text;
}

describe('SvelteKit’s modules in a preview', () => {
  it('finds the Kit app’s src/lib from the nearest svelte.config', () => {
    expect(kitLibOf(root, path.join(app, 'src', 'lib', 'ui', 'Nav.ts'))).toBe(path.join(app, 'src', 'lib'));
    expect(kitLibOf(root, path.join(root, 'elsewhere.ts'))).toBeUndefined();
  });

  it('builds a component that uses $app, $env and $lib, and stands them in', async () => {
    const js = await bundle(path.join(app, 'src', 'lib', 'ui', 'Nav.ts'));
    const notes: Array<[string, string]> = [];
    const ctx: Record<string, unknown> = { window: { __belugaPreview: { note: (what: string, to: string) => notes.push([what, to]) } }, URL, URLSearchParams };
    ctx.globalThis = ctx;
    vm.runInNewContext(js, ctx);
    const M = ctx.M as { out: Record<string, unknown>; go: () => Promise<void> };
    expect(M.out).toEqual({ title: 'HI', name: 'kit', path: '/', fromStore: '/', navigating: null, browser: true, dev: false, building: false, base: '', to: '/blog/a', site: '', env: {}, destroy: 'function' });
    await M.go();
    expect(notes).toEqual([['navigate', '/next'], ['refresh', '']]);
  });

  it('never stands in $env’s private values: a component can’t read them', async () => {
    writeFileSync(path.join(app, 'src', 'lib', 'Secret.ts'), "import { API_KEY } from '$env/static/private';\nexport const k = API_KEY;\n");
    await expect(bundle(path.join(app, 'src', 'lib', 'Secret.ts'))).rejects.toThrow(/server/i);
  });

  it('reads $lib types for the props, and calls a missing $lib file a missing file', () => {
    expect(aliasesOf(app).map((a) => a.prefix)).toContain('$lib/');
    expect(resolveImport(app, path.join(app, 'src', 'Card.svelte'), '$lib/format')).toBe(path.join(app, 'src', 'lib', 'format.ts'));
    const p = buildProblem([{ text: 'Could not resolve "$lib/gone"' }], 'src/Card.svelte', true);
    expect(p).toMatchObject({ kind: 'missing-import' });
  });
});
