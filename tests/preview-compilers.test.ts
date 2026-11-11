import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileIn, compilersRunning, readable, stopCompilers } from '../src/preview/compilers.js';

/**
 * The project's compilers run the project's code (a Tailwind config, a plugin), so they run in a
 * process of their own that may read the worktree and its packages and nothing else, and may not
 * write or start anything (BLG-826 review). A fake Tailwind 3 here tries both.
 */

const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-compilers-'));
const outside = path.join(os.tmpdir(), `beluga-compilers-outside-${process.pid}.txt`);
afterAll(() => {
  stopCompilers();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

const pkg = (name: string, main: string, version = '3.4.0'): void => {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs' }));
  writeFileSync(path.join(dir, 'index.cjs'), main);
};

// A PostCSS that runs its one plugin, and a "Tailwind" whose plugin does what a hostile config might.
pkg('postcss', 'module.exports = (plugins) => ({ process: async (css) => ({ css: await plugins[0](css) }) });', '8.4.0');
pkg(
  'tailwindcss',
  `module.exports = () => async () => {
    const tried = [];
    try { require('fs').writeFileSync(${JSON.stringify(outside)}, 'x'); tried.push('wrote'); } catch (e) { tried.push('write ' + e.code); }
    try { require('child_process').execSync('true'); tried.push('ran'); } catch (e) { tried.push('run ' + e.code); }
    try { require('fs').readFileSync('/etc/hosts'); tried.push('read outside'); } catch (e) { tried.push('read ' + e.code); }
    return '/* ' + tried.join(', ') + ' */';
  };`,
);
writeFileSync(path.join(root, 'index.css'), '@tailwind utilities;');

describe('the compilers’ process', () => {
  it('may read only the worktree and its packages', () => {
    expect(readable(root).every((p) => p.includes('beluga-compilers-'))).toBe(true);
  });

  it('runs the project’s code with no way to write, start a program, or read elsewhere', async () => {
    const out = await compileIn(root, { kind: 'tailwind', file: path.join(root, 'index.css'), major: 3 });
    expect(out.contents).toBe('/* write ERR_ACCESS_DENIED, run ERR_ACCESS_DENIED, read ERR_ACCESS_DENIED */');
    expect(existsSync(outside)).toBe(false);
    expect(compilersRunning()).toBe(1);
  });

  it('runs Tailwind 4, which registers an import hook (a worker the process may not start) as it loads', async () => {
    const v4 = path.join(root, 'v4');
    const v4pkg = (name: string, main: string): void => {
      const dir = path.join(v4, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '4.1.17', main: 'index.cjs' }));
      writeFileSync(path.join(dir, 'index.cjs'), main);
    };
    v4pkg('@tailwindcss/node', "require('node:module').register?.(require('node:url').pathToFileURL(__filename));\nexports.compile = async () => ({ root: 'none', sources: [], build: () => '/* tailwind 4 */' });");
    v4pkg('@tailwindcss/oxide', 'exports.Scanner = class { scan() { return []; } };');
    writeFileSync(path.join(v4, 'index.css'), '@import "tailwindcss";');
    const out = await compileIn(v4, { kind: 'tailwind', file: path.join(v4, 'index.css'), major: 4 });
    expect(out.errors).toBeUndefined();
    expect(out.contents).toBe('/* tailwind 4 */');
  });

  it('says why when Tailwind is there but can’t be loaded, never that it isn’t installed', async () => {
    const broken = path.join(root, 'broken');
    mkdirSync(path.join(broken, 'node_modules', '@tailwindcss', 'node'), { recursive: true });
    writeFileSync(path.join(broken, 'node_modules', '@tailwindcss', 'node', 'package.json'), JSON.stringify({ name: '@tailwindcss/node', version: '4.1.17', main: 'index.cjs' }));
    writeFileSync(path.join(broken, 'node_modules', '@tailwindcss', 'node', 'index.cjs'), "throw new Error('boom');");
    writeFileSync(path.join(broken, 'index.css'), '@import "tailwindcss";');
    const out = await compileIn(broken, { kind: 'tailwind', file: path.join(broken, 'index.css'), major: 4 });
    expect(out.skip).toBeUndefined();
    expect(out.errors?.[0]?.text).toMatch(/Tailwind.*@tailwindcss\/node.*boom/);
  });

  it('stops when told (no preview left)', () => {
    stopCompilers();
    expect(compilersRunning()).toBe(0);
  });
});
