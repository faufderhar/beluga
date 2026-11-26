import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The phone's bundler (Metro) only sees the folders packages/companion/metro.config.js watches.
// An import of any other repo file passes typecheck and vitest but fails `npm run apk`.
const repo = path.resolve(__dirname, '..');
const companion = path.join(repo, 'packages/companion');
const SCANNED = ['app', 'lib', 'components'].map((d) => path.join(companion, d));
const SKIP = new Set(['node_modules', 'android', 'ios', '.expo', 'dist']);

const watched = (): string[] => {
  const src = readFileSync(path.join(companion, 'metro.config.js'), 'utf8');
  const list = src.match(/const shared = \[([^\]]+)\]/);
  const items = list?.[1];
  if (!items) throw new Error('metro.config.js has no `const shared = [...]` list');
  return [...items.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [path.join(repo, m[1])] : []));
};

const sources = (dir: string): string[] => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
};

const IMPORT = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

describe('the phone app imports only what its bundler can see', () => {
  it('every relative import outside packages/companion lands in a watched folder', () => {
    const folders = watched();
    const outside: string[] = [];
    for (const file of SCANNED.flatMap(sources)) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        if (!spec) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (target.startsWith(companion + path.sep)) continue;
        if (!folders.some((f) => target === f || target.startsWith(f + path.sep))) {
          outside.push(`${path.relative(repo, file)} → ${spec}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it('finds the watched folders it checks against', () => {
    // As the repo writes them (Windows gives src\companion).
    expect(watched().map((f) => path.relative(repo, f).split(path.sep).join('/'))).toContain('src/companion');
  });
});
