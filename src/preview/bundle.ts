import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildContext, Message, Plugin } from 'esbuild';
import { isSecretPath } from '../core/shares.js';
import type { PreviewProblem } from '../shared/preview/opened.js';
import { OUTSIDE, buildProblem } from './problems.js';
import { nextPlugin, sveltePlugin, tailwindPlugin, vuePlugin } from './plugins.js';
import { REACT_NATIVE_DEFINE, WEB_FIRST_EXTENSIONS, browserPlugin, reactNativePlugin, reactNativeWebOf } from './react-native.js';
import type { Framework } from '../shared/preview/components.js';

/**
 * A component file built for its preview frame with esbuild, against the project's own React:
 * one script (the component, what it imports, React) and its CSS, kept in memory. The context
 * stays, so a change rebuilds only what changed (tens of milliseconds for most components).
 * esbuild is loaded the first time a preview is built, never at the daemon's start.
 */

export interface Bundle {
  readonly js: string;
  readonly css: string;
  /** The project's files it read (not node_modules), absolute: watched for changes. */
  readonly inputs: readonly string[];
}

export type BuildResult = { readonly ok: true; readonly bundle: Bundle } | { readonly ok: false; readonly problem: PreviewProblem };

export interface Bundler {
  build(): Promise<BuildResult>;
  dispose(): Promise<void>;
}

/** Files a component may import that aren't code: drawn inline, so the frame needs nothing else. */
const ASSETS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mp3', '.wav'] as const;

/** What a preview's entry brings together (bundle.ts entryOf). */
export interface EntryOptions {
  readonly framework: Framework;
  /** The export to draw (React: a name, or 'default'). */
  readonly pick?: string;
  /** Stylesheets to bundle with it: one named in the block, the project's Tailwind one. */
  readonly css?: readonly string[];
  /** The project's preview wrapper (its providers), default-exported: React only. */
  readonly wrapper?: string;
  /** Storybook's preview file, whose decorators wrap every story: React only. */
  readonly storybook?: string;
  /** Svelte's major version (4 mounts with `new`, 5 with mount()). */
  readonly svelte?: number;
}

/**
 * The script that mounts the component (preview/runtime.ts's __belugaPreview): React's with the
 * project's wrapper and decorators, or a Vue or Svelte one through a small adapter that draws,
 * updates and takes the component away.
 */
export function entryOf(file: string, o: EntryOptions): string {
  const css = (o.css ?? []).map((c) => `import ${JSON.stringify(c)};`);
  if (o.framework === 'vue') {
    return [
      `import Comp from ${JSON.stringify(file)};`,
      ...css,
      `import { createApp, h, reactive } from 'vue';`,
      `window.__belugaPreview.mount({ kind: 'custom', Mod: { default: Comp }, pick: null, render(el, C, props, fail) {`,
      `  const state = reactive({ props });`,
      `  const app = createApp({ render: () => h(C, state.props) });`,
      `  app.config.errorHandler = (e) => fail(e);`,
      `  app.mount(el);`,
      `  return { update(p) { state.props = p; }, unmount() { app.unmount(); } };`,
      `} });`,
    ].join('\n');
  }
  if (o.framework === 'svelte') {
    const v5 = (o.svelte ?? 5) >= 5;
    return [
      `import Comp from ${JSON.stringify(file)};`,
      ...css,
      // Svelte 5: drawn inside a small host whose props are state, so new props change it in place.
      ...(v5 ? [`import { mount, unmount } from 'svelte';`, `import Host from 'beluga-svelte-host/Host.svelte';`, `import { makeHost } from 'beluga-svelte-host/state.svelte.js';`] : []),
      `window.__belugaPreview.mount({ kind: 'custom', Mod: { default: Comp }, pick: null, render(el, C, props) {`,
      ...(v5
        ? [`  const host = makeHost(props);`, `  const inst = mount(Host, { target: el, props: { C, host } });`, `  return { update(p) { host.props = p; }, unmount() { unmount(inst); } };`]
        : [`  const inst = new C({ target: el, props });`, `  return { update(p) { inst.$set(p); }, unmount() { inst.$destroy(); } };`]),
      `} });`,
    ].join('\n');
  }
  return [
    `import * as Mod from ${JSON.stringify(file)};`,
    ...css,
    `import * as React from 'react';`,
    `import * as ReactDOM from 'react-dom/client';`,
    ...(o.wrapper ? [`import Wrapper from ${JSON.stringify(o.wrapper)};`] : []),
    ...(o.storybook ? [`import * as Story from ${JSON.stringify(o.storybook)};`] : []),
    `window.__belugaPreview.mount({ kind: 'react', Mod, React, ReactDOM, pick: ${JSON.stringify(o.pick ?? null)}${o.wrapper ? ', Wrapper' : ''}${o.storybook ? ', decorators: (Story.default && Story.default.decorators) || Story.decorators || []' : ''} });`,
  ].join('\n');
}

/** Whether a worktree has its packages: node_modules there or in a folder above (a monorepo). */
export function hasPackages(root: string, from: string): boolean {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules'))) return true;
    if (dir === root || path.dirname(dir) === dir) return false;
    dir = path.dirname(dir);
  }
}

const isFailure = (err: unknown): err is { errors: Message[] } => Boolean(err && typeof err === 'object' && Array.isArray((err as { errors?: unknown }).errors));

type Esbuild = typeof import('esbuild');
let loaded: Esbuild | undefined;

/** esbuild, loaded on the first build (its helper process starts with it). */
async function loadEsbuild(): Promise<Esbuild> {
  loaded ??= await import('esbuild');
  return loaded;
}

/** esbuild's helper process stopped (when no preview is left); it starts again with the next build. */
export async function stopEsbuild(): Promise<void> {
  const e = loaded;
  if (!e) return;
  await Promise.resolve(e.stop()).catch(() => undefined);
}

/**
 * What a preview's build may read: files of the worktree and installed packages (a node_modules
 * folder anywhere, for monorepos and linked installs), never a secret. A component's own imports
 * can't reach the rest of the disk (a key file in your home folder, say) and carry it into a page
 * that could send it on.
 */
export function fencePlugin(root: string): Plugin {
  const base = realpathSync(root);
  return {
    name: 'beluga-preview-fence',
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace !== 'file') return undefined;
        let real: string;
        try {
          real = realpathSync(args.path);
        } catch {
          return undefined;
        }
        const rel = path.relative(base, real);
        const inside = Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
        const installed = real.split(path.sep).includes('node_modules');
        if ((inside || installed) && !isSecretPath(inside ? rel : path.basename(real))) return undefined;
        return { errors: [{ text: `${OUTSIDE}: ${args.path}` }] };
      });
    },
  };
}

/**
 * `root`: the worktree (paths in messages are relative to it). `file`: the component, absolute.
 * `rel`: its path in the worktree. `entry`: what the entry brings with it (EntryOptions).
 */
export async function makeBundler(root: string, file: string, rel: string, entry: EntryOptions): Promise<Bundler> {
  const esbuild = await loadEsbuild();
  const loader = Object.fromEntries(ASSETS.map((ext) => [ext, 'dataurl' as const]));
  // A React Native component is built as its own web build would (react-native-web).
  const native = entry.framework === 'react' && reactNativeWebOf(file) !== undefined;
  // The context as it's made: a dispose during its making waits for it, so none is left behind.
  let ctx: Promise<BuildContext<{ write: false; metafile: true }>> | undefined;
  let disposed = false;
  const context = async (): Promise<BuildContext<{ write: false; metafile: true }>> =>
    (ctx ??= esbuild.context({
      stdin: { contents: entryOf(file, entry), resolveDir: path.dirname(file), sourcefile: 'beluga-preview.tsx', loader: 'tsx' },
      absWorkingDir: root,
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      target: ['safari16', 'chrome110'],
      jsx: 'automatic',
      jsxDev: false,
      // React's production build: a fifth of the size and faster to start; whitespace and syntax
      // minified, names kept so a failure's stack still says where.
      minifyWhitespace: true,
      minifySyntax: true,
      outfile: path.join(os.tmpdir(), 'beluga-preview', 'bundle.js'),
      loader: { ...loader, '.js': 'jsx' },
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', ...(native ? REACT_NATIVE_DEFINE : {}) },
      ...(native ? { resolveExtensions: WEB_FIRST_EXTENSIONS } : {}),
      // Svelte libraries publish their components under the "svelte" condition.
      conditions: entry.framework === 'svelte' ? ['svelte', 'browser', 'module'] : ['browser', 'module'],
      ...(entry.framework === 'svelte' ? { mainFields: ['svelte', 'browser', 'module', 'main'] } : {}),
      logLevel: 'silent',
      legalComments: 'none',
      charset: 'utf8',
      // The fence first: nothing outside the worktree is read by the others either.
      plugins: [fencePlugin(root), browserPlugin(), ...(native ? [reactNativePlugin()] : []), tailwindPlugin(root), nextPlugin(), ...(entry.framework === 'vue' ? [vuePlugin(root)] : []), ...(entry.framework === 'svelte' ? [sveltePlugin(root, entry.svelte ?? 5)] : [])],
    }));
  return {
    async build(): Promise<BuildResult> {
      // Let go of: never a new context (it would outlive its preview).
      if (disposed) return { ok: false, problem: buildProblem([{ text: 'The preview closed' }], rel, true) };
      try {
        const out = await (await context()).rebuild();
        const js = out.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
        const cssOut = out.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
        const inputs = Object.keys(out.metafile.inputs)
          .filter((p) => !p.includes('node_modules') && !p.startsWith('<') && path.basename(p) !== 'beluga-preview.tsx')
          .map((p) => path.resolve(root, p));
        return { ok: true, bundle: { js, css: cssOut, inputs } };
      } catch (err) {
        const messages = isFailure(err) ? err.errors : [{ text: err instanceof Error ? err.message : String(err), location: null }];
        return { ok: false, problem: buildProblem(messages, rel, hasPackages(root, path.dirname(file))) };
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      const c = ctx;
      ctx = undefined;
      await c?.then((made) => made.dispose()).catch(() => undefined);
    },
  };
}
