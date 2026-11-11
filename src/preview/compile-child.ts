/**
 * What runs in a preview's compiler process (preview/compilers.ts): the project's own Tailwind,
 * Vue and Svelte compilers, which run the project's code (a tailwind.config, a Tailwind plugin),
 * so never in the daemon. The process starts with Node's permission model: it reads only the
 * worktree and its packages, writes nothing, starts nothing, and exits once idle. Plain ESM
 * JavaScript, as text (run with `node -e`, so it needs no file of its own).
 *
 * Requests over IPC: { id, kind: 'tailwind' | 'vue' | 'svelte' | 'svelte-host', root, file, … };
 * answers { id, contents, loader } or { id, errors: [{ text, location? }] }.
 */

export const COMPILE_CHILD = String.raw`
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import nodeModule, { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Tailwind 4.1 registers an import hook as it loads (to re-import a changed plugin), and import
// hooks run on a worker this process may not start. Every compile here is fresh, so it does without.
nodeModule.register = () => undefined;
syncBuiltinESMExports();

const IDLE_MS = 60000;
let idle = setTimeout(() => process.exit(0), IDLE_MS);

async function load(root, name, from) {
  return (await tryLoad(root, name, from)).mod;
}
async function tryLoad(root, name, from) {
  let error;
  for (const base of [root, ...(from ? [from] : [])]) {
    try {
      const file = createRequire(path.join(base, 'package.json')).resolve(name);
      const mod = await import(pathToFileURL(file).href);
      const inner = mod.default && typeof mod.default === 'object' ? mod.default : undefined;
      return { mod: inner ? { ...inner, ...mod } : mod };
    } catch (err) { error ??= err; }
  }
  return { error };
}
// A part of Tailwind it has but can't load: said as that, never as Tailwind not being installed.
async function need(root, name, from) {
  const { mod, error } = await tryLoad(root, name, from);
  if (mod) return mod;
  throw new Error('Tailwind couldn’t start for the preview: ' + name + ' didn’t load (' + (error?.message ?? String(error)) + ')');
}
const dirOf = (root, pkg) => {
  try { return path.dirname(createRequire(path.join(root, 'package.json')).resolve(pkg + '/package.json')); } catch { return undefined; }
};

async function tailwind(root, file, major) {
  const css = readFileSync(file, 'utf8');
  if (major >= 4) {
    const via = dirOf(root, '@tailwindcss/vite') ?? dirOf(root, '@tailwindcss/postcss');
    const node = await need(root, '@tailwindcss/node', via);
    const oxide = await need(root, '@tailwindcss/oxide', via);
    const compiler = await node.compile(css, { base: path.dirname(file), from: file, onDependency: () => undefined });
    const start = compiler.root === 'none' ? [] : compiler.root === null ? [{ base: root, pattern: '**/*', negated: false }] : [{ ...compiler.root, negated: false }];
    const scanner = new oxide.Scanner({ sources: [...start, ...compiler.sources] });
    return compiler.build(scanner.scan());
  }
  const postcss = await need(root, 'postcss');
  const tw = await need(root, 'tailwindcss');
  const config = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs'].map((n) => path.join(root, n)).find((p) => existsSync(p));
  const run = postcss.default ?? postcss;
  const plugin = tw.default ?? tw;
  return (await run([plugin(config ? { config } : {})]).process(css, { from: file })).css;
}

// CSS a compiled component brings: one <style> per file, replaced (never added to) by a new build.
const injectCss = (key, css) => css.trim() ? '\n{ document.querySelectorAll(' + JSON.stringify('style[data-beluga-css="' + key + '"]') + ').forEach((n) => n.remove()); const s = document.createElement("style"); s.setAttribute("data-beluga-css", ' + JSON.stringify(key) + '); s.textContent = ' + JSON.stringify(css) + '; document.head.appendChild(s); }\n' : '';
const keyOf = (file) => createHash('sha256').update(file).digest('hex').slice(0, 8);

async function vue(root, file) {
  const sfc = await load(root, 'vue/compiler-sfc');
  if (!sfc) return { errors: [{ text: 'Could not resolve "vue"' }] };
  const { descriptor, errors } = sfc.parse(readFileSync(file, 'utf8'), { filename: file });
  if (errors.length) return { errors: [{ text: String(errors[0].message ?? errors[0]), location: { file } }] };
  const id = keyOf(file);
  const scoped = descriptor.styles.some((s) => s.scoped);
  let code = 'const __sfc__ = {};';
  if (descriptor.script || descriptor.scriptSetup) {
    const script = sfc.compileScript(descriptor, { id, inlineTemplate: Boolean(descriptor.scriptSetup), genDefaultAs: '__sfc__' });
    code = /\bconst\s+__sfc__\s*=/.test(script.content) ? script.content : script.content.replace(/\bexport\s+default\b/, 'const __sfc__ =');
  }
  if (!descriptor.scriptSetup && descriptor.template) {
    const template = sfc.compileTemplate({ source: descriptor.template.content, filename: file, id, scoped });
    code += '\n' + template.code.replace(/\bexport\s+function\s+render\b/, 'function render') + '\n__sfc__.render = render;';
  }
  if (scoped) code += '\n__sfc__.__scopeId = "data-v-' + id + '";';
  code += injectCss(id, descriptor.styles.map((s) => sfc.compileStyle({ source: s.content, filename: file, id: 'data-v-' + id, scoped: Boolean(s.scoped) }).code).join('\n'));
  code += '\nexport default __sfc__;';
  const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang;
  return { contents: code, loader: lang === 'ts' || lang === 'tsx' ? 'ts' : 'js' };
}

async function svelte(root, file, major, source) {
  const compiler = await load(root, 'svelte/compiler');
  if (!compiler) return { errors: [{ text: 'Could not resolve "svelte"' }] };
  try {
    const text = source ?? readFileSync(file, 'utf8');
    if (file.endsWith('.svelte.js')) return { contents: compiler.compileModule(text, { filename: file, generate: 'client', dev: false }).js.code, loader: 'js' };
    const options = major >= 5 ? { filename: file, generate: 'client', css: 'external', dev: false } : { filename: file, generate: 'dom', css: 'external', dev: false };
    const out = compiler.compile(text, options);
    return { contents: out.js.code + injectCss(keyOf(file), out.css?.code ?? ''), loader: 'js' };
  } catch (err) {
    return { errors: [{ text: err?.message ?? String(err), ...(err?.start ? { location: { file, line: err.start.line, column: err.start.column } } : {}) }] };
  }
}

// What Svelte 5 draws a component inside, so new props change it in place (its state kept).
const HOST = '<script>let { C, host } = $props();</script>\n<C {...host.props} />\n';
const STATE = 'export function makeHost(props) { const host = $state({ props }); return host; }\n';

process.on('message', async (msg) => {
  clearTimeout(idle);
  let answer;
  try {
    if (msg.kind === 'tailwind') {
      const out = await tailwind(msg.root, msg.file, msg.major);
      answer = out === undefined ? { skip: true } : { contents: out, loader: 'css' };
    } else if (msg.kind === 'vue') answer = await vue(msg.root, msg.file);
    else if (msg.kind === 'svelte') answer = await svelte(msg.root, msg.file, msg.major);
    else if (msg.kind === 'svelte-host') answer = await svelte(msg.root, msg.file, 5, msg.file.endsWith('.svelte.js') ? STATE : HOST);
    else answer = { errors: [{ text: 'Unknown request' }] };
  } catch (err) {
    answer = { errors: [{ text: err?.message ?? String(err) }] };
  }
  process.send({ id: msg.id, ...answer });
  idle = setTimeout(() => process.exit(0), IDLE_MS);
});
process.on('disconnect', () => process.exit(0));
`;
