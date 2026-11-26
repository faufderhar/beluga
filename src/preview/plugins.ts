import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OnLoadResult, Plugin } from 'esbuild';
import { type CompileAnswer, compileIn } from './compilers.js';
import { isTailwindEntry, packageMajor } from './project.js';

/**
 * What a preview's build does beyond plain esbuild: Tailwind (its classes styled as the app styles
 * them), stand-ins for Next.js's framework modules (so a Next component draws on its own), and Vue
 * and Svelte single-file components. Tailwind, Vue and Svelte are the project's own compilers and
 * run in a locked-down process of their own (compilers.ts), never the daemon. A project without
 * them never starts any of it.
 */

/** A compiler's answer, as esbuild takes it. */
function asLoad(answer: CompileAnswer, resolveDir: string): OnLoadResult | undefined {
  if (answer.skip) return undefined;
  if (answer.errors?.length) return { errors: answer.errors.map((e) => ({ text: e.text, ...(e.location ? { location: { file: e.location.file, line: e.location.line ?? 1, column: e.location.column ?? 0 } } : {}) })) };
  return { contents: answer.contents ?? '', loader: answer.loader ?? 'js', resolveDir };
}

/** Stylesheets where Tailwind is set up, built with the project's Tailwind (others are left to esbuild). */
export function tailwindPlugin(root: string): Plugin {
  const major = packageMajor(root, 'tailwindcss');
  return {
    name: 'beluga-tailwind',
    setup(build) {
      if (!major) return;
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        if (!isTailwindEntry(readFileSync(args.path, 'utf8'))) return undefined;
        return asLoad(await compileIn(root, { kind: 'tailwind', file: args.path, major }), path.dirname(args.path));
      });
    },
  };
}

/** The names a file imports from a module (`import { Inter, Roboto } from 'next/font/google'`). */
export function namedImports(importer: string, spec: string): string[] {
  try {
    const src = readFileSync(importer, 'utf8');
    const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${spec.replace(/[/$]/g, '\\$&')}['"]`, 'g');
    return [...src.matchAll(re)].flatMap((m) => m[1]!.split(',').map((p) => p.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)));
  } catch {
    return [];
  }
}

/** Next.js's framework modules, as plain React: what a component uses them for, without Next's server. */
const NEXT: Readonly<Record<string, string>> = {
  'next/image': `import { createElement, forwardRef } from 'react';
const Image = forwardRef(function Image({ src, alt = '', width, height, fill, priority, placeholder, blurDataURL, quality, loader, unoptimized, sizes, style, ...rest }, ref) {
  const url = typeof src === 'object' && src ? src.src : src;
  const fit = fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } : {};
  return createElement('img', { ref, src: url, alt, width, height, sizes, style: { ...fit, ...style }, ...rest });
});
export default Image;`,
  'next/link': `import { createElement, forwardRef } from 'react';
const Link = forwardRef(function Link({ href, as, prefetch, replace, scroll, shallow, passHref, legacyBehavior, locale, onClick, children, ...rest }, ref) {
  const to = typeof href === 'string' ? href : (href && href.pathname) || '#';
  return createElement('a', { ref, href: to, ...rest, onClick: (e) => { e.preventDefault(); onClick && onClick(e); window.__belugaPreview && window.__belugaPreview.note('navigate', to); } }, children);
});
export default Link;`,
  'next/navigation': `const note = (what, to) => window.__belugaPreview && window.__belugaPreview.note(what, String(to ?? ''));
const router = { push: (to) => note('navigate', to), replace: (to) => note('navigate', to), back: () => note('back'), forward: () => note('forward'), refresh: () => note('refresh'), prefetch: () => undefined };
export const useRouter = () => router;
export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export const redirect = (to) => note('navigate', to);
export const permanentRedirect = redirect;
export const notFound = () => note('not found');`,
  'next/router': `const note = (what, to) => window.__belugaPreview && window.__belugaPreview.note(what, String(to ?? ''));
const router = { pathname: '/', route: '/', asPath: '/', query: {}, isReady: true, isFallback: false, basePath: '', locale: undefined, push: async (to) => (note('navigate', to), true), replace: async (to) => (note('navigate', to), true), back: () => note('back'), reload: () => note('refresh'), prefetch: async () => undefined, beforePopState: () => undefined, events: { on() {}, off() {}, emit() {} } };
export const useRouter = () => router;
export const withRouter = (C) => C;
export default router;`,
  'next/head': `export default function Head() { return null; }`,
  'next/script': `export default function Script() { return null; }`,
  'next/dynamic': `import { createElement, lazy, Suspense } from 'react';
export default function dynamic(loader, options = {}) {
  const L = lazy(() => (typeof loader === 'function' ? loader() : loader).then((m) => ({ default: m && m.default ? m.default : m })));
  const Loading = options.loading;
  return function Dynamic(props) { return createElement(Suspense, { fallback: Loading ? createElement(Loading) : null }, createElement(L, props)); };
}`,
};

/** A font from next/font: a class and a family, the system's own font standing in. */
const fontModule = (names: readonly string[]): string => {
  const font = (family: string): string => `(o = {}) => ({ className: '', variable: '', style: { fontFamily: ${JSON.stringify(`'${family}', system-ui, sans-serif`)} } })`;
  return [`export default ${font('Local')};`, ...names.map((n) => `export const ${n} = ${font(n.replace(/_/g, ' '))};`)].join('\n');
};

export function nextPlugin(): Plugin {
  return {
    name: 'beluga-next',
    setup(build) {
      // A font module is one per file that imports it (each file names its own fonts).
      build.onResolve({ filter: /^next\/(image|legacy\/image|link|navigation|router|head|script|dynamic|font\/.+)$/ }, (args) => ({ path: args.path.startsWith('next/font/') ? `${args.path}?from=${args.importer}` : args.path, namespace: 'beluga-next', pluginData: { importer: args.importer } }));
      build.onLoad({ filter: /.*/, namespace: 'beluga-next' }, (args) => {
        const importer = (args.pluginData as { importer?: string } | undefined)?.importer ?? '';
        if (args.path.startsWith('next/font/')) return { contents: fontModule(namedImports(importer, args.path.split('?')[0]!)), loader: 'js' };
        const shim = NEXT[args.path === 'next/legacy/image' ? 'next/image' : args.path];
        return { contents: shim ?? 'export default {};', loader: 'jsx', resolveDir: path.dirname(importer) || process.cwd() };
      });
    },
  };
}

/** Vue single-file components, compiled with the project's own vue/compiler-sfc. */
export function vuePlugin(root: string): Plugin {
  return {
    name: 'beluga-vue',
    setup(build) {
      build.onLoad({ filter: /\.vue$/ }, async (args) => asLoad(await compileIn(root, { kind: 'vue', file: args.path }), path.dirname(args.path)));
    },
  };
}

/**
 * Svelte components (and .svelte.js modules), compiled with the project's own svelte/compiler; and
 * for Svelte 5, the small host a preview draws a component in, so new props change it in place.
 */
export function sveltePlugin(root: string, major: number): Plugin {
  return {
    name: 'beluga-svelte',
    setup(build) {
      build.onResolve({ filter: /^beluga-svelte-host\/(Host\.svelte|state\.svelte\.js)$/ }, (args) => ({ path: path.join(root, '.beluga-preview', args.path.split('/')[1]!), namespace: 'beluga-svelte-host' }));
      build.onLoad({ filter: /.*/, namespace: 'beluga-svelte-host' }, async (args) => asLoad(await compileIn(root, { kind: 'svelte-host', file: args.path, major }), root));
      build.onLoad({ filter: /\.svelte(\.js)?$/ }, async (args) => asLoad(await compileIn(root, { kind: 'svelte', file: args.path, major }), path.dirname(args.path)));
    },
  };
}
