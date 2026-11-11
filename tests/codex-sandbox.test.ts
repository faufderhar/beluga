import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CodexConnect, findCodex, spawnAppServer } from '../src/agent/runtime/codex/app-server.js';
import { codexComplete } from '../src/agent/runtime/codex/complete.js';
import { CODEX_TRUST_TABLE, PROFILE, codexConfinement, originOf, readsUndeniable, sideCallConfinement, trustRow, trustTableMarkdown, withoutReadDenials } from '../src/agent/runtime/codex/sandbox.js';

/** A JSON value as TOML (inline tables), for `codex -c key=value`. */
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')}}`;
}

/** `sh -c script` in `cwd` under Codex's own sandbox, with the run's permissions profile. */
function inCodexSandbox(bin: string, config: Record<string, unknown>, cwd: string, script: string): string {
  const flags = ['default_permissions', `permissions.${PROFILE}`].flatMap((k) => ['-c', `${k}=${toml(config[k])}`]);
  const r = spawnSync(bin, ['sandbox', ...flags, '--', 'sh', '-c', script], { cwd, encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout}${r.stderr}`;
  expect(r.error).toBeUndefined();
  expect(r.status, out).toBe(0);
  return out;
}

describe('the Codex trust table', () => {
  it('says whose run it is', () => {
    expect(originOf({ viaAgent: false })).toBe('own');
    expect(originOf({ viaAgent: true })).toBe('friend');
    expect(originOf({ viaAgent: false, vetTool: () => undefined })).toBe('friend');
    expect(originOf({ guest: true, viaAgent: true })).toBe('guest');
  });

  it('picks a row per origin and reach', () => {
    expect(trustRow('own', 'folder')).toMatchObject({ approval: 'on-request', network: true, yourTools: true });
    expect(trustRow('friend', 'folder')).toMatchObject({ home: 'denied', network: false, approval: 'never', yourTools: false });
    expect(trustRow('friend', 'full')).toMatchObject({ home: 'read', network: false, approval: 'never' });
    expect(trustRow('guest', 'full').sandbox).toBe('refused');
  });

  it('is the table docs/security.md shows', () => {
    const doc = readFileSync(path.resolve(__dirname, '../docs/security.md'), 'utf8');
    const table = /<!-- codex-trust-table -->\n([\s\S]*?)\n<!-- \/codex-trust-table -->/.exec(doc)?.[1];
    expect(table).toBe(trustTableMarkdown());
    expect(CODEX_TRUST_TABLE.length).toBe(table!.split('\n').length - 2);
  });

  it('a main folder is read only, a fix-up worktree in it still writable', () => {
    const c = codexConfinement('own', 'full', { cwd: '/p/main', folders: ['/p/fix'], writable: ['/p/fix'], home: '/h', belugaHome: '/h/.beluga' });
    const profile = c.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string> };
    expect(profile.extends).toBe(':read-only');
    // Keyed by the platform's own paths (D:\p\main on Windows), as Codex there reads them.
    const main = path.resolve('/p/main');
    expect(profile.filesystem).toMatchObject({ [main]: 'read', [path.resolve('/p/fix')]: 'write', '/h/.beluga': 'deny', [path.join('/h', '.ssh')]: 'deny', [`${main}/**/.env*`]: 'deny' });
  });

  it.skipIf(process.platform !== 'linux')('starts with system-tool reads and explicit shared folders, keeping credentials inside them blocked', () => {
    const c = codexConfinement('friend', 'folder', { cwd: '/h/work', folders: ['/h/.config'], writable: ['/h/work'], home: '/h', belugaHome: '/h/.beluga' });
    const p = c.config[`permissions.${PROFILE}`] as { filesystem: Record<string, string> };
    expect(p.filesystem[':minimal']).toBe('read');
    expect(p.filesystem['/h']).toBeUndefined();
    expect(p.filesystem['/h/.config']).toBe('read');
    expect(p.filesystem['/h/.config/gh']).toBe('deny');
    expect(p.filesystem['/h/work/**/.env*']).toBe('deny');
  });

  it.skipIf(process.platform !== 'linux')('keeps a denied ancestor when a broader shared folder would expose its private siblings', () => {
    const c = codexConfinement('friend', 'folder', { cwd: '/h/.beluga/work', folders: ['/h'], writable: [], home: '/h', belugaHome: '/h/.beluga' });
    const p = c.config[`permissions.${PROFILE}`] as { filesystem: Record<string, string> };
    expect(p.filesystem['/h']).toBe('read');
    expect(p.filesystem['/h/.beluga']).toBe('deny');
    expect(p.filesystem['/h/.beluga/work']).toBe('read');
  });
});

describe("Codex's unelevated Windows sandbox, which can't deny reads (#425)", () => {
  const place = { cwd: '/p/wt', folders: ['/p/share'], writable: ['/p/wt'], home: '/h', belugaHome: '/h/.beluga' };

  it("knows codex-cli's refusal when it sees it", () => {
    expect(readsUndeniable(new Error('failed to prepare fs sandbox: windows unelevated restricted-token sandbox cannot enforce deny-read restrictions directly; refusing to run unsandboxed'))).toBe(true);
    expect(readsUndeniable(new Error('windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed'))).toBe(true);
    expect(readsUndeniable(new Error('no rollout found'))).toBe(false);
    expect(readsUndeniable('cannot enforce deny-read restrictions')).toBe(false);
  });

  it('your own run keeps every folder and its write fence, with nothing denied', () => {
    const loose = withoutReadDenials(codexConfinement('own', 'full', place))!;
    const profile = loose.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string>; network: { enabled: boolean } };
    expect(profile.extends).toBe(':workspace');
    expect(profile.filesystem).toEqual({ [path.resolve('/p/wt')]: 'write', [path.resolve('/p/share')]: 'read' });
    expect(profile.network.enabled).toBe(true);
  });

  it("anyone else's run gets none", () => {
    expect(withoutReadDenials(codexConfinement('friend', 'full', place))).toBeUndefined();
    expect(withoutReadDenials(codexConfinement('friend', 'folder', place))).toBeUndefined();
    expect(withoutReadDenials(codexConfinement('agent', 'folder', place))).toBeUndefined();
  });
});

const found = findCodex();
// Installed and actually runs (an npm install whose native binary is missing is a shim that can't start).
const codex = found && spawnSync(found, ['--version'], { timeout: 15_000 }).status === 0 ? found : undefined;
describe.skipIf(!codex || !['darwin', 'linux'].includes(process.platform))("Codex's own sandbox, as Beluga sets it (the real codex binary)", () => {
  let dir: string;
  let work: string;
  beforeAll(() => {
    // Inside your home on either platform; skipped suites never create fixtures.
    dir = realpathSync(mkdtempSync(path.join(os.homedir(), '.beluga-codex-sandbox-')));
    work = path.join(dir, 'work');
    mkdirSync(path.join(work, 'sub'), { recursive: true });
    writeFileSync(path.join(work, '.env'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'sub', '.env.local'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'beside.txt'), 'x');
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const script = 'cat notes.txt; if cat .env >/dev/null 2>&1; then echo env-readable; else echo env-denied; fi; if cat sub/.env.local >/dev/null 2>&1; then echo nested-env-readable; else echo nested-env-denied; fi; if echo made > made.txt; then echo wrote; else echo write-denied; fi; if cat ../beside.txt >/dev/null 2>&1; then echo read-beside; else echo beside-denied; fi';

  it.each([
    ['ask me each time / trusted', 'folder'],
    ['full trust', 'full'],
  ] as const)("a friend's task (%s) can't read .env, and works in its folder", (_label, scope) => {
    const c = codexConfinement('friend', scope, { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('hello');
    expect(out).toContain('env-denied');
    expect(out).toContain('nested-env-denied');
    expect(out).not.toContain('env-readable');
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('wrote');
    expect(out).toContain(scope === 'folder' ? 'beside-denied' : 'read-beside');
  });

  it("your own run can't read .env without asking either", () => {
    const c = codexConfinement('own', 'full', { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('env-denied');
    expect(out).not.toContain('env-readable');
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('read-beside');
  });

  it('your own read-only run cannot write in its folder', () => {
    const c = codexConfinement('own', 'folder', { cwd: work, folders: [], writable: [] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('hello');
    expect(out).toContain('write-denied');
    expect(out).not.toContain('wrote');
    expect(out).toContain('env-denied');
  });

  it('an external agent below full trust works without reading the rest of home', () => {
    const c = codexConfinement('agent', 'folder', { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('hello');
    expect(out).toContain('wrote');
    expect(out).toContain('env-denied');
    expect(out).toContain('beside-denied');
  });

  it.each([
    ['with Read', ['Read'], 'hello'],
    ['with no tools', [], 'notes-denied'],
  ] as const)('a read-only side call %s starts and stays confined', (_label, tools, expected) => {
    writeFileSync(path.join(work, 'made.txt'), 'host file unchanged');
    const c = sideCallConfinement(work, { tools });
    const out = inCodexSandbox(codex!, c.config, work, 'cat notes.txt 2>/dev/null || echo notes-denied; if echo made > made.txt; then echo wrote; else echo write-denied; fi; if cat .env >/dev/null 2>&1; then echo env-readable; else echo env-denied; fi; if cat ../beside.txt >/dev/null 2>&1; then echo read-beside; else echo beside-denied; fi');
    expect(out).toContain(expected);
    // A minimal Linux view can write to its private tmpfs; it must never change the host file.
    expect(readFileSync(path.join(work, 'made.txt'), 'utf8')).toBe('host file unchanged');
    expect(out).toContain('env-denied');
    expect(out).toContain('beside-denied');
    expect(out).not.toContain('env-readable');
  });

  it.skipIf(process.platform !== 'linux')('a tool-free side call initializes without reading project instructions or requesting inference', async () => {
    writeFileSync(path.join(work, 'AGENTS.md'), 'Synthetic project instructions.');
    let initialized = false;
    const connect: CodexConnect = async (opts) => {
      const conn = await spawnAppServer(opts);
      const request = conn.rpc.request.bind(conn.rpc);
      // Keep real thread initialization, stopping only at the external inference boundary.
      conn.rpc.request = <T>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> => {
        if (method === 'turn/start') {
          initialized = true;
          return Promise.reject(new Error('No inference in this local startup check'));
        }
        return request<T>(method, params, timeoutMs);
      };
      return conn;
    };
    await codexComplete({ cwd: work, system: 'Name the task.', prompt: 'Synthetic startup check.', signal: AbortSignal.timeout(15_000) }, { connect }).catch(() => undefined);
    expect(initialized, 'The side call failed before its thread initialized').toBe(true);
  });

  it('a read-only worktree below Beluga home stays readable while its identity stays hidden', () => {
    const home = path.join(dir, 'worktree-home');
    const belugaHome = path.join(home, '.beluga');
    const readonly = path.join(belugaHome, 'workspaces', 'task');
    mkdirSync(readonly, { recursive: true });
    writeFileSync(path.join(readonly, 'notes.txt'), 'worktree-notes');
    writeFileSync(path.join(belugaHome, 'identity.json'), 'synthetic-identity');
    const c = codexConfinement('friend', 'folder', { cwd: readonly, folders: [], writable: [], home, belugaHome });
    const out = inCodexSandbox(codex!, c.config, readonly, `cat notes.txt; if cat '${belugaHome}/identity.json' >/dev/null 2>&1; then echo identity-readable; else echo identity-denied; fi`);
    expect(out).toContain('worktree-notes');
    expect(out).toContain('identity-denied');
    expect(out).not.toContain('identity-readable');
  });

  it('a shared config folder does not expose credentials inside it or other private home files', () => {
    const home = path.join(dir, 'private-home');
    const shared = path.join(home, '.config');
    const belugaHome = path.join(home, '.beluga');
    mkdirSync(path.join(shared, 'gh'), { recursive: true });
    mkdirSync(belugaHome);
    writeFileSync(path.join(shared, 'notes.txt'), 'shared-notes');
    writeFileSync(path.join(shared, 'gh', 'hosts.yml'), 'synthetic-credential');
    writeFileSync(path.join(home, '.bash_history'), 'synthetic-history');
    writeFileSync(path.join(home, '.gitconfig'), '# synthetic-gitconfig');
    writeFileSync(path.join(belugaHome, 'identity.json'), 'synthetic-identity');
    const c = codexConfinement('friend', 'folder', { cwd: work, folders: [shared], writable: [work], home, belugaHome });
    const out = inCodexSandbox(codex!, c.config, work, `cat '${shared}/notes.txt'; for file in '${shared}/gh/hosts.yml' '${home}/.bash_history' '${belugaHome}/identity.json'; do if cat "$file" >/dev/null 2>&1; then echo private-readable; else echo private-denied; fi; done; cat '${home}/.gitconfig'`);
    expect(out).toContain('shared-notes');
    expect(out).toContain('# synthetic-gitconfig');
    expect(out.match(/private-denied/g)).toHaveLength(3);
    expect(out).not.toContain('private-readable');
  });
});

describe('a side call on Codex', () => {
  const home = '/Users/someone';
  const cwd = path.resolve('/Users/someone/project');
  const profileOf = (c: ReturnType<typeof sideCallConfinement>) => c.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string>; network: { enabled: boolean } };

  it('is read only, never asks, keeps your home and secret files out, and offline', () => {
    const c = sideCallConfinement(cwd, { home, belugaHome: `${home}/.beluga`, yourServers: ['mine'] });
    const p = profileOf(c);
    expect(c.approval).toBe('never');
    expect(p.network.enabled).toBe(false);
    if (process.platform === 'linux') {
      expect(p.extends).toBeUndefined();
      expect(p.filesystem[':minimal']).toBe('read');
      expect(p.filesystem[home]).toBeUndefined();
    } else {
      expect(p.extends).toBe(':read-only');
      expect(p.filesystem[home]).toBe('deny');
      expect(p.filesystem[`${cwd}/**/.env*`]).toBe('deny');
    }
    expect(c.config['mcp_servers.mine.enabled']).toBe(false);
  });

  it('given no tools, cannot read the folder either; given Bash, has the network', () => {
    expect(profileOf(sideCallConfinement(cwd, { home })).filesystem[cwd]).toBe('deny');
    expect(profileOf(sideCallConfinement(cwd, { home, tools: ['Read'] })).filesystem[cwd]).toBe('read');
    expect(profileOf(sideCallConfinement(cwd, { home, tools: ['Read', 'Bash'] })).network.enabled).toBe(true);
  });
});
