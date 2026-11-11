import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropAppImageEnv } from '../src/core/appimage-env.js';
import { sshRemoteOf } from '../src/shared/git-trouble.js';

/**
 * A friend on the Linux AppImage who only uses SSH got "remote helper 'https' aborted session"
 * from Fetch: the AppImage's libraries broke git's https helper, and an https origin had no other
 * way in. The daemon now drops those library paths, and when https can't get into a GitHub,
 * GitLab or Bitbucket origin, fetch and push go over SSH (and every command reaching that remote
 * after them). Here git's https helper crashes the way it did there, and "SSH" is a stand-in that
 * serves bare repositories from this computer: nothing leaves the machine.
 */

const base = mkdtempSync(path.join(os.tmpdir(), 'fetch-ssh-'));
const sshLog = path.join(base, 'ssh.log');

/**
 * The stand-ins (a crashing https helper, an "ssh" that serves from here) are shell scripts, which
 * Git for Windows doesn't run in their place: there git would really go to github.com. So the
 * end-to-end part runs on macOS and Linux; the rest (words, routes, the AppImage's paths) everywhere.
 */
const STAND_INS = process.platform !== 'win32';

if (STAND_INS) {
  // A copy of git's own programs whose https helper dies like the AppImage's did.
  const realExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const execDir = path.join(base, 'git-core');
  mkdirSync(execDir);
  for (const name of readdirSync(realExec)) if (!/^git-remote-https?$/.test(name)) symlinkSync(path.join(realExec, name), path.join(execDir, name));
  for (const name of ['git-remote-https', 'git-remote-http']) {
    writeFileSync(path.join(execDir, name), `#!/bin/sh\necho "$0: symbol lookup error: /lib/x86_64-linux-gnu/libcurl.so.4: undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation" >&2\nexit 127\n`);
    chmodSync(path.join(execDir, name), 0o755);
  }
  // git runs: <ssh> [-o SendEnv=GIT_PROTOCOL] git@github.com "git-upload-pack 'me/app.git'": serve it from `base`.
  const fakeSsh = path.join(base, 'fake-ssh');
  writeFileSync(fakeSsh, `#!/bin/sh\nfor last; do :; done\necho "$*" >> '${sshLog}'\ncd '${base}' && exec sh -c "$last"\n`);
  chmodSync(fakeSsh, 0o755);
  // git.ts reads them once, as it loads: set before it's imported below.
  process.env.GIT_SSH_COMMAND = fakeSsh;
  process.env.GIT_EXEC_PATH = execDir;
}

let sync: typeof import('../src/workspaces/sync.js');
let routes: typeof import('../src/workspaces/ssh-routes.js');
let pr: typeof import('../src/workspaces/pr.js');
let gitTs: typeof import('../src/workspaces/git.js');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();
const sshCalls = (): number => (existsSync(sshLog) ? readFileSync(sshLog, 'utf8').split('\n').filter(Boolean).length : 0);
const bare = path.join(base, 'me', 'app.git');
const seed = path.join(base, 'seed');

/** A clone whose origin is `url`, of the bare repository at base/me/app.git. */
function cloneWithOrigin(name: string, url: string): string {
  const dir = path.join(base, name);
  git(base, 'clone', '-q', bare, dir);
  git(dir, 'remote', 'set-url', 'origin', url);
  git(dir, 'remote', 'set-head', 'origin', '--delete');
  return dir;
}

function seedCommits(file: string): string {
  writeFileSync(path.join(seed, file), `${file}\n`);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', file);
  git(seed, 'push', '-q', bare, 'main');
  return git(seed, 'rev-parse', 'HEAD').trim();
}

beforeAll(async () => {
  [sync, routes, pr, gitTs] = await Promise.all([import('../src/workspaces/sync.js'), import('../src/workspaces/ssh-routes.js'), import('../src/workspaces/pr.js'), import('../src/workspaces/git.js')]);
  if (!STAND_INS) return;
  mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  git(base, 'init', '-q', '-b', 'main', seed);
  seedCommits('a');
});

beforeEach(() => routes.clearSshRoutes());

describe.skipIf(!STAND_INS)('https broken, SSH working', () => {
  it('fetch goes over SSH, the remote stays as it was, and what reaches GitHub next goes over SSH too', async () => {
    const dir = cloneWithOrigin('friend', 'https://github.com/me/app.git');
    const tip = seedCommits('b');
    const fetched = await sync.fetchRemote(dir);
    expect(fetched.ok).toBe(true);
    expect(git(dir, 'rev-parse', 'origin/main').trim()).toBe(tip);
    expect(readFileSync(sshLog, 'utf8')).toMatch(/git@github\.com .*git-upload-pack 'me\/app\.git'/);
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe('https://github.com/me/app.git');
    // Newer git sets origin/HEAD while fetching; older git: Beluga asks the remote, over SSH too.
    const learned = fetched.ok && fetched.remoteDefault ? fetched.remoteDefault : git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim().replace(/^origin\//, '');
    expect(learned).toBe('main');

    // The helper is broken for the whole host: Beluga's other git (a quiet fetch, ls-remote) goes over SSH straight away.
    const before = sshCalls();
    await gitTs.git(dir, ['fetch', 'origin', '--prune']);
    expect(sshCalls()).toBeGreaterThan(before);
    // Commands that don't reach a remote are left alone.
    expect(routes.withSshRoutes(['status'])).toEqual(['status']);
    expect(routes.withSshRoutes(['-c', 'x=y', 'push', 'origin'])[1]).toBe('url.git@github.com:.insteadOf=https://github.com/');
  });

  it('push for a pull request goes over SSH when https can’t, and lands on the remote', async () => {
    const dir = cloneWithOrigin('pusher', 'https://github.com/me/app.git');
    git(dir, 'checkout', '-q', '-b', 'feat');
    writeFileSync(path.join(dir, 'f'), 'f\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'feat');
    expect(await pr.pushForPr(dir, 'feat')).toBe('pushed');
    expect(git(bare, 'rev-parse', 'feat').trim()).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(routes.routedOverSsh('https://github.com/me/app.git')).toBe(true);
  });

  it('says why in plain words when SSH doesn’t get in either, and stops routing that way', async () => {
    routes.rememberSshRoute('https://github.com/someone/else.git', true);
    const dir = cloneWithOrigin('nokey', 'https://github.com/someone/else.git');
    const fetched = await sync.fetchRemote(dir);
    expect(fetched.ok === false && fetched.reason).toBe('https_broken');
    expect(fetched.ok === false && fetched.message).toMatch(/can’t use https on this computer/);
    expect(routes.routedOverSsh('https://github.com/someone/else.git')).toBe(false);
  });

  it('leaves other hosts on https', async () => {
    const before = sshCalls();
    const dir = cloneWithOrigin('elsewhere', 'https://git.example.com/me/app.git');
    const fetched = await sync.fetchRemote(dir);
    expect(fetched.ok === false && fetched.reason).toBe('https_broken');
    expect(sshCalls()).toBe(before);
  });
});

describe('SSH addresses for https remotes', () => {
  it.each([
    ['https://github.com/me/app.git', 'git@github.com:me/app.git', 'https://github.com/'],
    ['https://token@GitHub.com/me/app', 'git@github.com:me/app', 'https://token@GitHub.com/'],
    ['https://gitlab.com/group/sub/app.git', 'git@gitlab.com:group/sub/app.git', 'https://gitlab.com/'],
  ])('%s → %s', (url, ssh, prefix) => {
    expect(sshRemoteOf(url)).toEqual({ url: ssh, host: { https: prefix, ssh: ssh.slice(0, ssh.indexOf(':') + 1) } });
  });

  it.each(['git@github.com:me/app.git', 'https://git.example.com/me/app.git', '/Users/me/app.git'])('%s has none', (url) => {
    expect(sshRemoteOf(url)).toBeUndefined();
  });

  it('routes one repository, or a whole host when its https is broken', () => {
    routes.rememberSshRoute('https://github.com/me/app.git', false);
    expect(routes.routedOverSsh('https://github.com/me/app.git')).toBe(true);
    expect(routes.routedOverSsh('https://github.com/me/other.git')).toBe(false);
    expect(routes.sshRouteArgs()).toEqual(['-c', 'url.git@github.com:me/app.git.insteadOf=https://github.com/me/app.git']);
    routes.rememberSshRoute('https://gitlab.com/x/y.git', true);
    expect(routes.routedOverSsh('https://gitlab.com/any/thing')).toBe(true);
  });
});

describe('a broken https helper in words', () => {
  it.each([
    "fatal: remote helper 'https' aborted session",
    'git-remote-https: symbol lookup error: /lib/x86_64-linux-gnu/libcurl.so.4: undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation',
    '/usr/lib/git-core/git-remote-https: error while loading shared libraries: libcurl-gnutls.so.4',
  ])('%s', (raw) => {
    const failure = sync.classifyFetchError(raw);
    expect(failure.reason).toBe('https_broken');
    expect(failure.message).toMatch(/https helper fails[^]*SSH/);
  });
});

describe('the Linux AppImage’s library paths', () => {
  it('are dropped from what the daemon starts, keeping the user’s own', () => {
    const env: NodeJS.ProcessEnv = {
      APPDIR: '/tmp/.mount_BelugaX/',
      LD_LIBRARY_PATH: '/tmp/.mount_BelugaX/usr/lib:/opt/mine/lib',
      GIO_MODULE_DIR: '/tmp/.mount_BelugaX/usr/lib/gio/modules',
      XDG_DATA_DIRS: '/tmp/.mount_BelugaX/usr/share:/usr/local/share:/usr/share',
      LD_PRELOAD: '/tmp/.mount_BelugaXY/lib.so',
      PATH: '/tmp/.mount_BelugaX/usr/bin:/usr/bin',
    };
    expect(dropAppImageEnv(env).sort()).toEqual(['GIO_MODULE_DIR', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS']);
    expect(env).toEqual({
      APPDIR: '/tmp/.mount_BelugaX/',
      LD_LIBRARY_PATH: '/opt/mine/lib',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      // Another folder that only starts the same, and PATH, stay.
      LD_PRELOAD: '/tmp/.mount_BelugaXY/lib.so',
      PATH: '/tmp/.mount_BelugaX/usr/bin:/usr/bin',
    });
  });

  it('change nothing outside an AppImage', () => {
    const env: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: '/opt/mine/lib' };
    expect(dropAppImageEnv(env)).toEqual([]);
    expect(env).toEqual({ LD_LIBRARY_PATH: '/opt/mine/lib' });
  });

  it('the daemon drops them as it starts', () => {
    expect(readFileSync('src/daemon/main.ts', 'utf8')).toMatch(/runDaemon[^]*?\{\n[^]*?dropAppImageEnv\(\);/);
  });
});
