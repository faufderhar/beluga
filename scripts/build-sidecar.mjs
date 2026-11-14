#!/usr/bin/env node
// Everything the desktop app needs to run Beluga by itself (no Node or Beluga installed):
//   packages/mac/src-tauri/resources/daemon/   Beluga compiled (dist/) + its production node_modules
//   packages/mac/src-tauri/binaries/node-<target>   an official Node binary (pinned below; beluga-node-<target> on Linux)
// Usage: node scripts/build-sidecar.mjs [--os darwin|linux|win32] [--arch arm64|x64] [--out <dir>] [--node-out <file>]
// (os and arch default to this computer's; native modules come prebuilt for the one asked for;
// --out and --node-out put the engine and Node elsewhere: scripts/build-server.mjs's bundle)
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One place for the Node version: native modules' prebuilds must match its ABI. */
export const NODE_VERSION = '24.22.0';

const root = path.resolve(import.meta.dirname, '..');
const tauri = path.join(root, 'packages/mac/src-tauri');
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const arch = flag('--arch', process.arch);
const platform = flag('--os', process.platform);

/** Rust's name for the target: Tauri looks for binaries/node-<triple>. */
export function tripleOf(os, cpu) {
  const machine = cpu === 'arm64' ? 'aarch64' : 'x86_64';
  if (os === 'darwin') return `${machine}-apple-darwin`;
  if (os === 'linux') return `${machine}-unknown-linux-gnu`;
  if (os === 'win32') return `${machine}-pc-windows-msvc`;
  throw new Error(`No desktop app for ${os}`);
}
const triple = tripleOf(platform, arch);
const exe = platform === 'win32' ? '.exe' : '';
// npm is npm.cmd on Windows, and a .cmd only runs through a shell there.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...opts });

// 1. Beluga itself.
run('npm', ['run', 'build'], { cwd: root });
const out = path.resolve(flag('--out', path.join(tauri, 'resources/daemon')));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(out, 'package-lock.json'));

// 2. Its production dependencies, installed for this architecture (prebuilt native modules).
// Linux builds are for glibc (Ubuntu, Debian, Fedora): said outright, so a build made on a Mac (whose
// npm knows no libc) doesn't skip the glibc-only packages, such as @resvg/resvg-js-linux-arm64-gnu.
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', `--cpu=${arch}`, `--os=${platform}`, ...(platform === 'linux' ? ['--libc=glibc'] : [])], { cwd: out, env: { ...process.env, npm_config_arch: arch } });
// Claude Code's binary (239 MB, half the app) isn't bundled: the app downloads this exact package on
// first launch and checks it against the integrity pinned here (src/agent/claude-code.ts, BLG-384).
{
  const lock = JSON.parse(readFileSync(path.join(out, 'package-lock.json'), 'utf8'));
  const name = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.resolved || !entry?.integrity) throw new Error(`${name} isn't in package-lock.json`);
  writeFileSync(path.join(out, 'claude-code.json'), JSON.stringify({ version: entry.version, url: entry.resolved, integrity: entry.integrity }, null, 2) + '\n');
  rmSync(path.join(out, 'node_modules', name), { recursive: true, force: true });
}
rmSync(path.join(out, 'package-lock.json'), { force: true });
// Usage statistics: only a release built with BELUGA_TELEMETRY_URL and BELUGA_TELEMETRY_KEY set can
// send them (an ingest-only Ratel key: it adds data to one project and reads nothing). A build from
// source has no such file, so it never asks and never sends (src/telemetry/config.ts).
{
  const url = process.env.BELUGA_TELEMETRY_URL;
  const key = process.env.BELUGA_TELEMETRY_KEY;
  const file = path.join(out, 'telemetry-release.json');
  rmSync(file, { force: true });
  if (url && key) writeFileSync(file, JSON.stringify({ url, key }) + '\n', { mode: 0o644 });
}
// Nothing loads these at run time (BLG-383): cloudflared's binary (downloaded to ~/.beluga/bin when
// the relay fallback first needs it), mathjax's es5 build (math-svg.ts uses mathjax-full/js), and
// whisper's C++ sources and wasm fallback (the native build is there).
for (const dir of ['cloudflared/bin', 'mathjax-full/es5', '@fugood/whisper.node/src', '@fugood/node-whisper-wasm']) rmSync(path.join(out, 'node_modules', dir), { recursive: true, force: true });
// Nor whisper's GPU builds (CUDA, Vulkan, Snapdragon): voice.ts loads its default build. On Linux
// they're most of the app's size, and the CUDA one needs NVIDIA's libcudart, which the AppImage can't find.
{
  const fugood = path.join(out, 'node_modules', '@fugood');
  if (existsSync(fugood)) for (const name of readdirSync(fugood)) if (/^node-whisper-.+-(cuda|vulkan|snapdragon)$/.test(name)) rmSync(path.join(fugood, name), { recursive: true, force: true });
}
// Nor type declarations, source maps, TypeScript sources or docs (licenses stay).
const junk = /\.(d\.[cm]?ts|[cm]?ts|map|md|markdown)$/i;
const strip = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) strip(p);
    else if (junk.test(e.name) && !/^licen[cs]e/i.test(e.name)) rmSync(p, { force: true });
  }
};
strip(path.join(out, 'node_modules'));
// Prebuilt binaries for other systems aren't needed in this one's app.
const prune = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === 'prebuilds') {
      // Musl builds (Alpine) aren't for this app, which runs on glibc: linuxdeploy can't even read them.
      for (const plat of readdirSync(p)) if ((!plat.startsWith(`${platform}-${arch}`) && plat !== platform) || plat.includes('musl')) rmSync(path.join(p, plat), { recursive: true, force: true });
    } else prune(p);
  }
};
prune(path.join(out, 'node_modules'));
// node-pty's helper must stay executable (some copies drop the bit).
const helper = path.join(out, `node_modules/@lydell/node-pty-${platform}-${arch}/prebuilds/${platform}-${arch}/spawn-helper`);
if (existsSync(helper)) chmodSync(helper, 0o755);

// 3. Node.
// On Linux it's beluga-node: the .deb and .rpm put it in /usr/bin, where a distro's own node lives.
const bin = path.resolve(flag('--node-out', path.join(tauri, 'binaries', `${platform === 'linux' ? 'beluga-node' : 'node'}-${triple}${exe}`)));
mkdirSync(path.dirname(bin), { recursive: true });
rmSync(bin, { force: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'klaud-node-'));
// nodejs.org names Windows "win", and ships it as a zip with node.exe at the top.
const name = `node-v${NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`;
const archive = platform === 'win32' ? 'node.zip' : 'node.tar.gz';
const inside = platform === 'win32' ? `${name}/node.exe` : `${name}/bin/node`;
run('curl', ['-fsSL', '-o', path.join(tmp, archive), `https://nodejs.org/dist/v${NODE_VERSION}/${name}${platform === 'win32' ? '.zip' : '.tar.gz'}`]);
// bsdtar (macOS, Windows 10 and later) reads zips too. On Windows, its own (System32's): Git Bash's
// GNU tar, when it comes first on PATH, takes C:\ for a remote host.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
run(tar, ['-xf', path.join(tmp, archive), '-C', tmp, inside]);
copyFileSync(path.join(tmp, inside), bin);
chmodSync(bin, 0o755);
rmSync(tmp, { recursive: true, force: true });
writeFileSync(path.join(out, 'NODE_VERSION'), NODE_VERSION);

// The daemon reports its package.json version, and the app restarts a kept-alive daemon whose
// version isn't the one it bundles (after an update). Beluga's own version doesn't change with
// every Mac release, so the bundled copy carries the app's too: 0.4.0+mac.0.5.1 ("mac" is the
// desktop app's, on Linux and Windows too: friends' Beluga reads the app's version after it).
{
  const appVersion = JSON.parse(readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8')).version;
  const pkgFile = path.join(out, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.version = `${String(pkg.version).split('+')[0]}+mac.${appVersion}`;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`\nBeluga sidecar ready for ${triple} (Node ${NODE_VERSION})`);
