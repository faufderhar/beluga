import { mkdtempSync, promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { antigravityExtension } from '../src/agent/runtime/antigravity/extension.js';
import { rulesFreeArgs } from '../src/agent/runtime/antigravity/rules-free.js';

/** Antigravity in Beluga goes by your project's rules: its own Gemini folder, ~/.gemini linked in but the global rules. */

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const folder = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-rules-')));
  made.push(dir);
  return dir;
};
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

// Links on Windows need rights a user may not have: there agy reads ~/.gemini as it is.
describe.skipIf(process.platform === 'win32')('agy’s Gemini folder without your global rules', () => {
  const gemini = async () => {
    const root = folder();
    const real = path.join(root, '.gemini');
    const dir = path.join(root, 'beluga', 'agy-gemini');
    await write(path.join(real, 'GEMINI.md'), 'Always end with 1111.');
    await write(path.join(real, 'AGENTS.md'), 'global');
    await write(path.join(real, 'settings.json'), '{"a":1}');
    await write(path.join(real, 'antigravity-cli', 'brain', 's1', 'plan.md'), 'plan');
    await write(path.join(real, 'config', 'AGENTS.md'), 'global too');
    await write(path.join(real, 'config', 'rules', 'common', 'style.md'), 'rule');
    await write(path.join(real, 'config', 'mcp_config.json'), '{}');
    await fs.mkdir(path.join(real, 'config', 'skills', 'review'), { recursive: true });
    return { real, dir };
  };

  it('links everything in but the global rules, and names it as agy’s folder', async () => {
    const { real, dir } = await gemini();
    expect(await rulesFreeArgs({ real, dir, platform: 'darwin' })).toEqual([`--gemini-dir=${dir}`]);
    expect((await fs.readdir(dir)).sort()).toEqual(['antigravity-cli', 'config', 'settings.json']);
    expect((await fs.readdir(path.join(dir, 'config'))).sort()).toEqual(['mcp_config.json', 'skills']);
    expect(await fs.readFile(path.join(dir, 'antigravity-cli', 'brain', 's1', 'plan.md'), 'utf8')).toBe('plan');
    expect((await fs.lstat(path.join(dir, 'config'))).isSymbolicLink()).toBe(false);
  });

  it('puts a file agy saved over a link back where it belongs, and links it again', async () => {
    const { real, dir } = await gemini();
    await rulesFreeArgs({ real, dir, platform: 'darwin' });
    // agy saves settings.json by renaming a new file over it: in its folder, over the link.
    await fs.rm(path.join(dir, 'settings.json'));
    await fs.writeFile(path.join(dir, 'settings.json'), '{"a":2}');
    await fs.writeFile(path.join(dir, 'state.json'), '{"new":true}');
    await rulesFreeArgs({ real, dir, platform: 'darwin' });
    expect(await fs.readFile(path.join(real, 'settings.json'), 'utf8')).toBe('{"a":2}');
    expect(await fs.readFile(path.join(real, 'state.json'), 'utf8')).toBe('{"new":true}');
    expect((await fs.lstat(path.join(dir, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(dir, 'state.json'))).isSymbolicLink()).toBe(true);
  });

  it('follows what’s in ~/.gemini now: new things in, global rules added later and things gone out', async () => {
    const { real, dir } = await gemini();
    await rulesFreeArgs({ real, dir, platform: 'darwin' });
    await fs.rm(path.join(real, 'settings.json'));
    await write(path.join(real, 'history', 'x.json'), '{}');
    await write(path.join(real, 'rules', 'old.md'), 'old place');
    await rulesFreeArgs({ real, dir, platform: 'darwin' });
    expect((await fs.readdir(dir)).sort()).toEqual(['antigravity-cli', 'config', 'history']);
  });

  it('needs no folder of its own when there are no global rules, nor on Windows', async () => {
    const root = folder();
    const real = path.join(root, '.gemini');
    await write(path.join(real, 'settings.json'), '{}');
    expect(await rulesFreeArgs({ real, dir: path.join(root, 'mine'), platform: 'darwin' })).toEqual([]);
    const { real: withRules, dir } = await gemini();
    expect(await rulesFreeArgs({ real: withRules, dir, platform: 'win32' })).toEqual([]);
  });
});

describe('Antigravity’s own notes', () => {
  it('are its own by either path to its folder', () => {
    const root = folder();
    const ext = antigravityExtension({ dataDir: path.join(root, '.gemini', 'antigravity-cli') });
    expect(ext.ownNote?.('s1', path.join(root, '.gemini', 'antigravity-cli', 'brain', 's1', 'plan.md'))).toBe(true);
    expect(ext.ownNote?.('s1', path.join(root, 'elsewhere', 'plan.md'))).toBe(false);
  });
});
