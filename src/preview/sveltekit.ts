import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import { namedImports } from './plugins.js';
import { SVELTE_CONFIGS } from './project.js';

/**
 * SvelteKit components in a preview, as Next.js's are (plugins.ts nextPlugin): `$lib` is the Kit
 * app's src/lib, found from the nearest svelte.config (a monorepo's apps/web too), and `$app/*`
 * and `$env/*` are small stand-ins, so a Kit component draws on its own without Kit's server.
 * Navigation is noted under the frame, as a link's is. `$env`'s private values and `$app/server`
 * are the server's alone: never stood in, the build says so (no .env file is ever read).
 */

/** The Kit app's src/lib for a file: from the nearest folder up (to the worktree) with a svelte.config. */
export function kitLibOf(root: string, from: string): string | undefined {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    if (SVELTE_CONFIGS.some((c) => existsSync(path.join(dir, c)))) return path.join(dir, 'src', 'lib');
    if (dir === root || path.dirname(dir) === dir) return undefined;
  }
}

const NOTE = `const note = (what, to) => window.__belugaPreview && window.__belugaPreview.note(what, to === undefined ? '' : String(to));`;
// A store as Svelte's contract has it (subscribe calls back at once, returns how to stop): no import of svelte/store needed.
const READABLE = `const readable = (value) => ({ subscribe(fn) { fn(value); return () => undefined; } });`;
const PAGE = `const page = { url: new URL('http://localhost/'), params: {}, route: { id: '/' }, status: 200, error: null, data: {}, form: null, state: {} };`;
// A route id with its params filled in: [slug], [...rest] and [[optional]]; (group) segments go.
const FILL = `const fill = (id, params = {}) => (String(id).replace(/\\/\\([^)]+\\)/g, '').replace(/\\[\\[?(?:\\.\\.\\.)?(\\w+)(?:=\\w+)?\\]?\\]/g, (_, k) => params[k] ?? '').replace(/\\/+/g, '/').replace(/(.)\\/$/, '$1')) || '/';`;

const KIT: Readonly<Record<string, string>> = {
  '$app/environment': `export const browser = true;\nexport const dev = false;\nexport const building = false;\nexport const version = '';`,
  '$app/navigation': `${NOTE}
export const goto = async (to) => note('navigate', to);
export const invalidate = async () => note('refresh');
export const invalidateAll = async () => note('refresh');
export const refreshAll = async () => note('refresh');
export const preloadData = async () => ({ type: 'loaded', status: 200, data: {} });
export const preloadCode = async () => undefined;
export const beforeNavigate = () => undefined;
export const afterNavigate = () => undefined;
export const onNavigate = () => undefined;
export const disableScrollHandling = () => undefined;
export const pushState = (to) => note('navigate', to);
export const replaceState = (to) => note('navigate', to);`,
  '$app/state': `${PAGE}
export { page };
export const navigating = { from: null, to: null, type: null, willUnload: null, delta: null, complete: null };
export const updated = { current: false, check: async () => false };`,
  '$app/stores': `${READABLE}
${PAGE}
const store = readable(page);
export { store as page };
export const navigating = readable(null);
export const updated = { ...readable(false), check: async () => false };
export const getStores = () => ({ page: store, navigating, updated });`,
  '$app/paths': `${FILL}
export const base = '';
export const assets = '';
export const resolveRoute = fill;
export const resolve = fill;
export const asset = (file) => file;`,
  '$app/forms': `export const enhance = () => ({ destroy() {} });
export const applyAction = async () => undefined;
export const deserialize = (text) => JSON.parse(text);`,
  '$env/dynamic/public': 'export const env = {};',
};

/** What can't be stood in: the server's alone. */
const SERVER_ONLY = /^\$(env\/(static|dynamic)\/private|app\/server)$/;

export function svelteKitPlugin(root: string): Plugin {
  return {
    name: 'beluga-sveltekit',
    setup(build) {
      // $lib from the Kit app the importing file is in; left to esbuild (and its words) when it isn't there.
      build.onResolve({ filter: /^\$lib(\/|$)/ }, async (args) => {
        const lib = kitLibOf(root, args.importer) ?? path.join(root, 'src', 'lib');
        const rest = args.path.slice('$lib'.length).replace(/^\//, '');
        const found = await build.resolve(rest ? `./${rest}` : '.', { kind: args.kind, resolveDir: lib, importer: args.importer });
        return found.errors.length ? undefined : found;
      });
      build.onResolve({ filter: /^\$(app|env)\/[\w/]+$/ }, (args) => ({ path: args.path, namespace: 'beluga-sveltekit', pluginData: { importer: args.importer } }));
      build.onLoad({ filter: /.*/, namespace: 'beluga-sveltekit' }, (args) => {
        if (SERVER_ONLY.test(args.path)) return { errors: [{ text: `${args.path} is only on the server: a component in a preview can't read it` }] };
        if (args.path === '$env/static/public') {
          const importer = (args.pluginData as { importer?: string } | undefined)?.importer ?? '';
          return { contents: namedImports(importer, args.path).map((n) => `export const ${n} = '';`).join('\n') || 'export {};', loader: 'js' };
        }
        return { contents: KIT[args.path] ?? 'export default {};', loader: 'js' };
      });
    },
  };
}
