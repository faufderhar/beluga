// OpenCode installed with `npm i -g opencode-ai` showed "Not installed" (#568 / BLG-999): npm's global
// folder under a Node version manager (nvm, fnm, Volta, pnpm) or a prefix of your own isn't on the
// PATH the Mac app has when your shell's PATH couldn't be read in time, and an OpenCode that was
// found but couldn't list its models was called missing too.
import { describe, expect, it } from 'vitest';
import { findCodex } from '../src/agent/runtime/codex/app-server.js';
import { findCopilot } from '../src/agent/runtime/copilot/connection.js';
import { findOpenCode } from '../src/agent/runtime/opencode/connection.js';
import { openCodeStatus } from '../src/agent/runtime/opencode/status.js';
import { nodeGlobalBinDirs, type FolderReader } from '../src/agent/runtime/version-managers.js';

const home = '/Users/me';
const only = (...files: string[]) => (file: string): boolean => files.includes(file);

/** A disk with these folders (each one's entries). */
const disk = (folders: Readonly<Record<string, readonly string[]>> = {}): FolderReader => ({ list: (dir) => folders[dir] ?? [] });

describe('where npm puts global commands beyond the app’s PATH', () => {
  it('nvm’s versions, the newest first', () => {
    const fs = disk({ '/Users/me/.nvm/versions/node': ['v18.20.4', 'v22.11.0', 'v20.9.0', '.DS_Store'] });
    const dirs = nodeGlobalBinDirs({}, home, 'darwin', fs);
    const nvm = dirs.filter((d) => d.includes('.nvm'));
    expect(nvm).toEqual(['/Users/me/.nvm/versions/node/v22.11.0/bin', '/Users/me/.nvm/versions/node/v20.9.0/bin', '/Users/me/.nvm/versions/node/v18.20.4/bin']);
  });

  it('nvm moved with NVM_DIR', () => {
    const dirs = nodeGlobalBinDirs({ NVM_DIR: '/opt/nvm' }, home, 'darwin', disk({ '/opt/nvm/versions/node': ['v24.1.0'] }));
    expect(dirs).toContain('/opt/nvm/versions/node/v24.1.0/bin');
  });

  it('fnm’s versions, where it keeps them on a Mac', () => {
    const dirs = nodeGlobalBinDirs({}, home, 'darwin', disk({ '/Users/me/Library/Application Support/fnm/node-versions': ['v22.11.0'] }));
    expect(dirs).toContain('/Users/me/Library/Application Support/fnm/node-versions/v22.11.0/installation/bin');
  });

  it('Volta’s and pnpm’s own folders, and a prefix you set in the environment', () => {
    const dirs = nodeGlobalBinDirs({ NPM_CONFIG_PREFIX: '/Users/me/.npm-env' }, home, 'darwin', disk());
    expect(dirs).toEqual(expect.arrayContaining(['/Users/me/.volta/bin', '/Users/me/Library/pnpm', '/Users/me/.npm-global/bin', '/Users/me/.npm-env/bin']));
  });

  it('a folder it can’t read is no versions of its own, never an error', () => {
    const dirs = nodeGlobalBinDirs({}, home, 'linux', { list: () => { throw new Error('EACCES'); } });
    expect(dirs.some((d) => d.includes('.nvm/versions'))).toBe(false);
    expect(dirs).toContain('/Users/me/.npm-global/bin');
  });
});

describe('OpenCode installed with npm under a Node version manager', () => {
  it('is found under nvm when the app’s PATH is bare', () => {
    const fs = disk({ '/Users/me/.nvm/versions/node': ['v22.11.0'] });
    expect(findOpenCode({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, 'darwin', only('/Users/me/.nvm/versions/node/v22.11.0/bin/opencode'), home, fs)).toBe('/Users/me/.nvm/versions/node/v22.11.0/bin/opencode');
  });

  it('is found under Volta, fnm and an npm prefix of your own', () => {
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', only('/Users/me/.volta/bin/opencode'), home, disk())).toBe('/Users/me/.volta/bin/opencode');
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', only('/Users/me/.npm-global/bin/opencode'), home, disk())).toBe('/Users/me/.npm-global/bin/opencode');
    const fnm = disk({ '/Users/me/Library/Application Support/fnm/node-versions': ['v20.9.0'] });
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', only('/Users/me/Library/Application Support/fnm/node-versions/v20.9.0/installation/bin/opencode'), home, fnm)).toBe('/Users/me/Library/Application Support/fnm/node-versions/v20.9.0/installation/bin/opencode');
  });

  it('keeps PATH first: the one your shell runs wins', () => {
    const fs = disk({ '/Users/me/.nvm/versions/node': ['v22.11.0'] });
    expect(findOpenCode({ PATH: '/opt/homebrew/bin' }, 'darwin', only('/opt/homebrew/bin/opencode', '/Users/me/.nvm/versions/node/v22.11.0/bin/opencode'), home, fs)).toBe('/opt/homebrew/bin/opencode');
  });

  it('still says not installed when there is none', () => {
    expect(findOpenCode({ PATH: '/usr/bin' }, 'darwin', only(), home, disk({ '/Users/me/.nvm/versions/node': ['v22.11.0'] }))).toBeUndefined();
  });
});

describe('Codex and Copilot, also installed with npm', () => {
  it('are found under nvm too', () => {
    const fs = disk({ '/Users/me/.nvm/versions/node': ['v22.11.0'] });
    expect(findCodex({ PATH: '/usr/bin' }, 'darwin', only('/Users/me/.nvm/versions/node/v22.11.0/bin/codex'), home, fs)).toBe('/Users/me/.nvm/versions/node/v22.11.0/bin/codex');
    expect(findCopilot({ PATH: '/usr/bin' }, 'darwin', only('/Users/me/.nvm/versions/node/v22.11.0/bin/copilot'), home, fs)).toBe('/Users/me/.nvm/versions/node/v22.11.0/bin/copilot');
  });
});

describe('OpenCode found, but its models didn’t come', () => {
  it('is installed, never “Not installed”, and says what to try', async () => {
    const st = await openCodeStatus({ bin: '/Users/me/.nvm/versions/node/v22.11.0/bin/opencode', models: async () => undefined });
    expect(st.state).not.toBe('missing');
    expect(st.state).toBe('signed_out');
    expect(st.fix).toMatch(/opencode models/);
  });

  it('a listing that throws is the same', async () => {
    const st = await openCodeStatus({ bin: '/x/opencode', models: async () => { throw new Error('timed out'); } });
    expect(st.state).toBe('signed_out');
  });
});
