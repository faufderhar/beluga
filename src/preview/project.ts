import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isSecretPath } from '../core/shares.js';
import type { SourceLoader } from '../shared/preview/props.js';

/**
 * What a preview needs to know about the project it's in: where an import's file is (relative, or
 * through tsconfig's path aliases like `@/`), the wrapper that gives every preview its providers,
 * the stylesheet Tailwind is set up in, and which packages it has. Only files inside the worktree
 * are read, never a secret.
 */

const EXTENSIONS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const MAX_TYPES_FILE = 512 * 1024;

/** A file of the worktree, checked: inside it (links too), not a secret, a file. */
export function insideFile(root: string, file: string): string | undefined {
  try {
    const base = realpathSync(root);
    const real = realpathSync(file);
    const rel = path.relative(base, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('.git') || isSecretPath(rel)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON with comments and trailing commas (tsconfig.json) as plain JSON: comments and the commas
 * before a closing bracket go, never anything inside a string (an alias like "@/" with a star
 * after it, or a glob, stays as written).
 */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
    } else out += c;
  }
  return out;
}

function readJsonc(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type CompilerOptions = { baseUrl?: string; paths?: Record<string, string[]> };

/** A tsconfig's paths and where they're from, following `extends` (relative ones, a few deep). */
function pathsOf(file: string, depth = 0): { base: string; paths: Record<string, string[]> } | undefined {
  const config = readJsonc(file);
  if (!config) return undefined;
  const options = config.compilerOptions as CompilerOptions | undefined;
  if (options?.paths) return { base: path.resolve(path.dirname(file), options.baseUrl ?? '.'), paths: options.paths };
  const parent = typeof config.extends === 'string' && config.extends.startsWith('.') && depth < 4 ? path.resolve(path.dirname(file), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`) : undefined;
  return parent ? pathsOf(parent, depth + 1) : undefined;
}

/** A SvelteKit app's config files: the folder with one is the app. */
export const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts', 'svelte.config.cjs'] as const;

/** The project's import aliases (tsconfig compilerOptions.paths), each as a prefix and where it points. */
export function aliasesOf(root: string): Array<{ readonly prefix: string; readonly to: string }> {
  for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
    const found = pathsOf(path.join(root, name));
    if (!found) continue;
    return Object.entries(found.paths).flatMap(([key, targets]) => {
      const to = targets[0];
      if (!to) return [];
      return [{ prefix: key.replace(/\*$/, ''), to: path.resolve(found.base, to.replace(/\*$/, '')) }];
    });
  }
  // The common defaults when nothing says: @/ is src/, and a SvelteKit app's $lib is src/lib
  // (its own paths are in .svelte-kit/tsconfig.json, which only Kit's sync writes).
  const kit = SVELTE_CONFIGS.some((c) => existsSync(path.join(root, c))) && existsSync(path.join(root, 'src', 'lib'));
  return [...(existsSync(path.join(root, 'src')) ? [{ prefix: '@/', to: path.join(root, 'src') }] : []), ...(kit ? [{ prefix: '$lib/', to: path.join(root, 'src', 'lib') }] : [])];
}

/** Where `spec`, imported from `from`, is: a file of the worktree, or nothing (a package, or outside). */
export function resolveImport(root: string, from: string, spec: string, aliases = aliasesOf(root)): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else {
    const alias = aliases.find((a) => spec.startsWith(a.prefix));
    if (alias) base = path.join(alias.to, spec.slice(alias.prefix.length));
  }
  if (!base) return undefined;
  // `./types.js` in TypeScript means ./types.ts.
  const bases = /\.(m|c)?js$/.test(base) ? [base.replace(/\.(m|c)?js$/, ''), base] : [base];
  for (const b of bases) {
    for (const ext of EXTENSIONS) {
      const found = insideFile(root, b + ext);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Reads the files a component's types come from (props.ts SourceLoader), inside the worktree only.
 * One loader per preview opened: each file is read once (and the same answer is given for it, so
 * its parse is kept too), however many props and re-exports lead to it.
 */
export function sourceLoader(root: string, from: string, aliases = aliasesOf(root), files = new Map<string, ReturnType<SourceLoader>>()): SourceLoader {
  return (spec) => {
    const file = resolveImport(root, from, spec, aliases);
    if (!file) return undefined;
    if (files.has(file)) return files.get(file);
    let found: ReturnType<SourceLoader>;
    try {
      found = statSync(file).size > MAX_TYPES_FILE ? undefined : { src: readFileSync(file, 'utf8'), load: sourceLoader(root, file, aliases, files) };
    } catch {
      found = undefined;
    }
    files.set(file, found);
    return found;
  };
}

/** Where the project's packages are found from (a monorepo's too). */
const requireIn = (root: string): NodeJS.Require => createRequire(path.join(root, 'package.json'));

/** Where an installed package's module is, or nothing. */
export function packagePath(root: string, name: string): string | undefined {
  try {
    return requireIn(root).resolve(name);
  } catch {
    return undefined;
  }
}

/** An installed package's major version (tailwindcss 3 or 4), or nothing. */
export function packageMajor(root: string, name: string): number | undefined {
  try {
    const file = requireIn(root).resolve(`${name}/package.json`);
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version;
    const major = Number(version?.split('.')[0]);
    return Number.isFinite(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

/** Where the wrapper a project gives its previews is (its providers): the one named, else a preview-wrapper file. */
export const WRAPPERS = ['preview-wrapper.tsx', 'preview-wrapper.jsx', 'src/preview-wrapper.tsx', 'src/preview-wrapper.jsx', '.beluga/preview-wrapper.tsx', '.beluga/preview-wrapper.jsx'];

export function findWrapper(root: string, named?: string): string | undefined {
  if (named) return insideFile(root, path.resolve(root, named));
  for (const rel of WRAPPERS) {
    const found = insideFile(root, path.join(root, rel));
    if (found) return found;
  }
  return undefined;
}

/** Storybook's preview file, whose decorators (and parameters) every story is drawn inside. */
export function findStorybookPreview(root: string): string | undefined {
  for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
    const found = insideFile(root, path.join(root, '.storybook', `preview.${ext}`));
    if (found) return found;
  }
  return undefined;
}

/** Stylesheets apps keep their global styles in, by convention. */
const GLOBAL_CSS = ['src/index.css', 'src/app/globals.css', 'app/globals.css', 'src/styles/globals.css', 'styles/globals.css', 'src/globals.css', 'src/main.css', 'src/styles.css', 'src/style.css', 'src/App.css', 'src/assets/main.css', 'src/app.css', 'app/app.css', 'assets/css/main.css'];

/** Whether a stylesheet is where Tailwind is set up (v4's import, v3's directives). */
export const isTailwindEntry = (css: string): boolean => /@import\s+["']tailwindcss(\/[\w-]+)?["']|@tailwind\s+(base|components|utilities)/.test(css);

/** The project's Tailwind stylesheet, when it uses Tailwind: added to every preview so its classes are styled. */
export function tailwindEntry(root: string): string | undefined {
  if (!packageMajor(root, 'tailwindcss')) return undefined;
  for (const rel of GLOBAL_CSS) {
    const file = insideFile(root, path.join(root, rel));
    if (!file) continue;
    try {
      if (isTailwindEntry(readFileSync(file, 'utf8'))) return file;
    } catch {
      /* unreadable: the next one */
    }
  }
  return undefined;
}
