// Codex installed through a version manager (mise, asdf), #548 / BLG-974: found even when the app's
// PATH doesn't have the manager's folders, and started as the real Codex, never as `mise` itself.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexExecutable, findCodex, spawnAppServer } from '../src/agent/runtime/codex/app-server.js';
import { versionManagerShimDirs } from '../src/agent/runtime/version-managers.js';

const only = (...files: string[]) => (file: string): boolean => files.includes(file);
const home = '/Users/me';

describe('where version managers keep their shims', () => {
  it('mise and asdf by default', () => {
    expect(versionManagerShimDirs({}, home)).toEqual(['/Users/me/.local/share/mise/shims', '/Users/me/.asdf/shims']);
  });

  it('their own folders when you moved them', () => {
    expect(versionManagerShimDirs({ MISE_DATA_DIR: '/opt/mise', ASDF_DATA_DIR: '/opt/asdf' }, home)).toEqual(['/opt/mise/shims', '/opt/asdf/shims']);
    expect(versionManagerShimDirs({ XDG_DATA_HOME: '/Users/me/data' }, home)[0]).toBe('/Users/me/data/mise/shims');
  });
});

describe('findCodex beyond the app’s PATH', () => {
  it('finds a mise shim the app’s PATH leaves out', () => {
    expect(findCodex({ PATH: '/usr/bin:/bin' }, 'darwin', only('/Users/me/.local/share/mise/shims/codex'), home)).toBe('/Users/me/.local/share/mise/shims/codex');
  });

  it('finds an asdf shim, and Homebrew’s and ~/.local/bin', () => {
    expect(findCodex({ PATH: '/usr/bin' }, 'linux', only('/Users/me/.asdf/shims/codex'), home)).toBe('/Users/me/.asdf/shims/codex');
    expect(findCodex({ PATH: '/usr/bin' }, 'darwin', only('/opt/homebrew/bin/codex'), home)).toBe('/opt/homebrew/bin/codex');
    expect(findCodex({ PATH: '/usr/bin' }, 'linux', only('/Users/me/.local/bin/codex'), home)).toBe('/Users/me/.local/bin/codex');
  });

  it('keeps PATH first: your own order wins over the shims', () => {
    expect(findCodex({ PATH: '/Users/me/.local/share/mise/installs/codex/1/bin' }, 'darwin', only('/Users/me/.local/share/mise/installs/codex/1/bin/codex', '/Users/me/.local/share/mise/shims/codex'), home)).toBe('/Users/me/.local/share/mise/installs/codex/1/bin/codex');
  });

  it('still says not installed when there is none', () => {
    expect(findCodex({ PATH: '/usr/bin' }, 'darwin', only(), home)).toBeUndefined();
  });
});

// A fake mise (a multi-call binary, as the real one: its shims are links to it, and it reads its
// name to know what to run) and a fake Codex that answers app-server's hello.
describe.skipIf(process.platform === 'win32')('a mise shim, started for real', () => {
  let dir: string;
  let shim: string;
  let real: string;
  let env: Record<string, string | undefined>;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-mise-')));
    const bin = path.join(dir, 'bin');
    const shims = path.join(dir, 'mise', 'shims');
    const installs = path.join(dir, 'mise', 'installs', 'github-openai-codex', 'rust-v0.167.0', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(shims, { recursive: true });
    mkdirSync(installs, { recursive: true });
    real = path.join(installs, 'codex');
    writeFileSync(real, `#!${process.execPath}\nrequire('node:readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n'); });\n`);
    const mise = path.join(bin, 'mise');
    writeFileSync(mise, `#!/bin/sh\nname=$(basename "$0")\nif [ "$name" = mise ]; then\n  if [ "$1" = which ] && [ "$2" = codex ]; then echo "${real}"; exit 0; fi\n  echo "mise: unknown command: $1" >&2; exit 1\nfi\nexec "${real}" "$@"\n`);
    chmodSync(real, 0o755);
    chmodSync(mise, 0o755);
    shim = path.join(shims, 'codex');
    symlinkSync(mise, shim);
    env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('runs the installed Codex, not mise', async () => {
    expect(await codexExecutable(shim, { cwd: dir, env })).toBe(real);
  });

  it('starts app-server through the shim', async () => {
    const conn = await spawnAppServer({ cwd: dir, env, bin: shim });
    await conn.proc.kill();
  });

  it('keeps an ordinary link resolved to its real file', async () => {
    const link = path.join(dir, 'bin', 'codex');
    symlinkSync(real, link);
    expect(await codexExecutable(link, { cwd: dir, env })).toBe(real);
  });
});
