#!/usr/bin/env node
// Collects the English text the Mac app can show, for its translations (packages/mac/src/i18n).
//
//   node scripts/i18n-extract.mjs [--out file.json]      writes every candidate (default: i18n-source.json in the temp folder)
//   node scripts/i18n-extract.mjs --missing [--locale zh-CN]   lists what a catalog doesn't translate yet
//
// The app translates by the English text itself (gettext style), so English stays in the code where
// it is. A candidate is JSX text, and string or template literals that read like a sentence or a
// label (not ids, paths, CSS, commands or comparisons). Template literals become patterns:
// `On ${x}.` → "On {0}.". Over-collecting is harmless: the catalog decides what gets translated.
// No dependencies: a small scanner, good enough for this purpose.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const DIRS = ['packages/mac/src', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'i18n', 'tui']);
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

/** JSX attributes that never hold words people read. */
const CODE_ATTRS = /\b(className|class|id|key|style|href|src|type|role|name|value|htmlFor|rel|target|method|autoComplete|inputMode|kind|variant|size|tone|icon|side|align|mode|as|lang|dir|viewBox|d|fill|stroke|transform|path|xmlns|tab|shortcut|keys|accept|pattern|sandbox|allow|cursor|color|testId|slot|place|layout|data-[\w-]+)=\s*\{?\s*$/;
/** Calls whose string arguments are code. */
const CODE_CALLS = /\b(require|import|invoke|getItem|setItem|removeItem|querySelector|querySelectorAll|closest|addEventListener|removeEventListener|getPropertyValue|setProperty|startsWith|endsWith|includes|indexOf|split|join|replace|replaceAll|match|test|getAttribute|setAttribute|hasAttribute|removeAttribute|createElement|matchMedia|emit|listen|on|off|once|has|get|delete|log|debug|warn|trace|Symbol|RegExp|fetch|postMessage|execFile|execFileSync|spawn|git|run|read|readFile|writeFile|join|resolve|dirname|basename|env|toggle|add|remove|contains|cmd|z\.literal|literal|enum|describe|it|expect)\(\s*(?:[^()]*,\s*)?$/;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) files(p, out);
    } else if (/\.(tsx?|mts)$/.test(name) && !/\.d\.ts$|\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Reads like words for people: has letters, isn't an identifier, path, URL, CSS, key combo or code. */
export function wordy(s) {
  const t = s.trim();
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  if (/^[a-z0-9_.:/#@$*-]+$/.test(t)) return false; // ids, keys, paths, events
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CONSTANTS
  if (/^(https?:|file:|mailto:|data:|\.{0,2}\/|~\/|#|--)/.test(t)) return false;
  if (/[;{}]/.test(t) && /:\s*[\w#-]/.test(t)) return false; // CSS
  if (/^[\w$.]+\(.*\)$/.test(t)) return false; // calls
  if (/^(var|calc|rgba?|hsla?|url|translate\w*|scale|rotate|cubic-bezier)\(/.test(t)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return false; // camelCase identifiers
  if (/^(git|npm|npx|node|beluga|gh|cd|ssh|brew|curl|sudo|open|echo|export|cat|ls|rm|mkdir)\s/.test(t)) return false;
  if (/^\d+(\.\d+)?(px|ms|s|%|em|rem|vh|vw|fr|deg)?(\s+\d+(\.\d+)?(px|ms|s|%|em|rem)?)*$/.test(t)) return false;
  if (/^[\w-]+(\s+[\w-]+)*$/.test(t) && /[a-z]-[a-z]/.test(t) && !/[A-Z]/.test(t[0])) return false; // css-ish class lists
  if (/(=>|&&|\|\||===|!==|\bfunction\b|\breturn\b|\bconst\b)/.test(t)) return false;
  return /^[A-Z“"'‘(¿…·•✓]/.test(t) || /\s/.test(t);
}

/**
 * Splits TS/TSX source into code (strings, templates and comments blanked out) and the literals
 * found, each with the code right before it. Regex literals are recognised by what precedes a `/`.
 */
export function scan(src) {
  const lits = [];
  let code = '';
  let i = 0;
  const n = src.length;
  const before = () => code.slice(-160);
  const regexCan = () => /(^|[=(,:\[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse)\s*$/.test(code);
  function readTemplate() {
    // At the backtick. Returns { parts, exprs } and advances.
    i++;
    const parts = [''];
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        parts[parts.length - 1] += src[i + 1] === '`' || src[i + 1] === '$' || src[i + 1] === '\\' ? src[i + 1] : src[i + 1] === 'n' ? '\n' : '\\' + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return parts;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        depth = 1;
        const start = i;
        // Skip the expression, honouring nested strings and templates.
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === "'" || d === '"') {
            const q = d;
            i++;
            while (i < n && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
            i++;
          } else if (d === '`') {
            const inner = readTemplate();
            lits.push({ text: inner.join(''), parts: inner, before: '', nested: true });
          } else {
            if (d === '{') depth++;
            else if (d === '}') depth--;
            i++;
          }
        }
        const expr = src.slice(start, i - 1);
        parts.push('');
        parts.exprs = [...(parts.exprs ?? []), expr];
        continue;
      }
      parts[parts.length - 1] += c;
      i++;
    }
    return parts;
  }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      code += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      // In JSX text an apostrophe is just text: only a quote that starts a JS string counts.
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e;
          j += e === 'u' ? 6 : 2;
        } else s += src[j++];
      }
      if (src[j] !== c) {
        code += c;
        i++;
        continue;
      }
      lits.push({ text: s, before: before(), at: code.length });
      code += '""';
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const b = before();
      const parts = readTemplate();
      lits.push({ text: parts.join(''), parts, before: b, at: code.length });
      code += '``';
      continue;
    }
    if (c === '/' && regexCan() && d !== '>' ) {
      // A regex literal: skip it (with its classes).
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') (cls = true), j++;
        else if (src[j] === ']') (cls = false), j++;
        else if (src[j] === '/' && !cls) break;
        else j++;
      }
      if (src[j] === '/') {
        i = j + 1;
        while (/[a-z]/.test(src[i] ?? '')) i++;
        code += '/r/';
        continue;
      }
    }
    code += c;
    i++;
  }
  return { code, lits };
}

function patternOf(parts) {
  return parts.map((p, k) => (k === 0 ? p : `{${k - 1}}${p}`)).join('');
}

export function extract(src, file = '') {
  const found = new Map();
  const add = (s, where) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (wordy(t) && !found.has(t)) found.set(t, where);
  };
  const { code, lits } = scan(src);
  const lineAt = (at) => code.slice(0, at).split('\n').length;
  for (const l of lits) {
    const b = l.before;
    if (/\b(import|from|export \*)\s*$/.test(b) || /\bimport\(\s*$/.test(b)) continue;
    if (/(===|!==|==|!=|\bcase|\bin)\s*$/.test(b)) continue;
    if (/[{,]\s*$/.test(b) && !l.parts && /^\s*:/.test(code.slice(l.at + 2, l.at + 6))) continue; // object keys
    if (/\[\s*$/.test(b) && /^\s*\]/.test(code.slice(l.at + 2, l.at + 6)) && /\w\s*\[\s*$/.test(b)) continue; // obj['key']
    if (/:\s*$/.test(b) && /\b(type|interface)\b[^=]*$/.test(b.split('\n').pop())) continue; // types
    if (/\|\s*$/.test(b) && /\btype\s+\w+/.test(b)) continue; // union types
    if (CODE_ATTRS.test(b) || CODE_CALLS.test(b)) continue;
    if (/\bconsole\.\w+\([^)]*$/.test(b)) continue;
    const where = l.at === undefined ? file : `${file}:${lineAt(l.at)}`;
    if (l.parts && l.parts.length > 1) {
      const key = patternOf(l.parts);
      if (/[A-Za-z]{2}/.test(l.parts.join(''))) add(key, where);
    } else add(l.text, where);
  }
  if (file.endsWith('.tsx')) {
    // JSX text: what sits between a tag's `>` and the next `<` or `{`.
    for (const m of code.matchAll(/>([^<>{}]*)(?=[<{])/g)) {
      const t = m[1];
      if (!/[A-Za-z]{2}/.test(t) || /[;=()]|\b(const|let|return|if|else)\b|&&|\|\|/.test(t)) continue;
      add(t, `${file}:${lineAt(m.index)}`);
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = new Map();
  for (const dir of DIRS) {
    for (const f of files(path.join(root, dir))) {
      for (const [k, where] of extract(readFileSync(f, 'utf8'), path.relative(root, f))) if (!all.has(k)) all.set(k, where);
    }
  }
  const keys = [...all.keys()].sort();
  if (process.argv.includes('--missing')) {
    const locale = flag('--locale', 'zh-CN');
    const catalog = JSON.parse(readFileSync(path.join(root, `packages/mac/src/i18n/${locale}.json`), 'utf8'));
    const missing = keys.filter((k) => !(k in catalog));
    for (const k of missing) console.log(`${all.get(k)}\t${k}`);
    console.error(`${missing.length} of ${keys.length} not in ${locale}`);
  } else {
    const out = path.resolve(flag('--out', path.join(os.tmpdir(), 'i18n-source.json')));
    writeFileSync(out, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all.get(k)])), null, 1) + '\n');
    console.log(`${keys.length} strings → ${path.relative(root, out)}`);
  }
}
