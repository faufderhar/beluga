import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chmod, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { belugaHome } from '../core/home.js';

/**
 * Claude Code itself (BLG-384). The Agent SDK runs a native `claude` binary from its platform
 * package (@anthropic-ai/claude-agent-sdk-darwin-arm64, 239 MB), half of the Mac app's download.
 * The Mac app leaves that package out and fetches the exact same one once, into
 * ~/.beluga/claude-code/<version>/, checked against the integrity its build pinned
 * (claude-code.json beside the daemon's package.json, written by scripts/build-sidecar.mjs).
 * Without a pin (development, npm) the SDK's own copy runs and nothing downloads.
 */

/** What the build pinned: the platform package's version, its tarball and its npm integrity (sha512). */
export interface ClaudeCodePin {
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
}

/** How far the one-time download is, for a run that waits on it. */
export type ClaudeCodeProgress = { readonly got: number; readonly total?: number };

const MANIFEST = new URL('../../claude-code.json', import.meta.url);

/** The pin, in a build without the SDK's own binary (the Mac app); undefined otherwise. */
export function claudeCodePin(file: URL | string = MANIFEST): ClaudeCodePin | undefined {
  try {
    const pin = JSON.parse(readFileSync(file, 'utf8')) as Partial<ClaudeCodePin>;
    if (typeof pin.version === 'string' && typeof pin.url === 'string' && typeof pin.integrity === 'string' && pin.integrity.startsWith('sha512-')) return pin as ClaudeCodePin;
  } catch {
    // no pin: the SDK finds its own binary
  }
  return undefined;
}

export const claudeCodeDir = (home = belugaHome()): string => path.join(home, 'claude-code');

/** Where this pin's binary lives once downloaded. */
/** The binary's name in its package: claude, or claude.exe on Windows. */
const CLAUDE_EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

export const claudeCodeBinary = (pin: ClaudeCodePin, home = belugaHome()): string => path.join(claudeCodeDir(home), pin.version, CLAUDE_EXE);

/**
 * The path to hand the SDK (`pathToClaudeCodeExecutable`), known at once: the downloaded one in a
 * build that pinned it (which `claudeCodeReady` makes sure is there), else undefined: the SDK finds
 * its own.
 */
export function claudeCodePath(): string | undefined {
  const pin = claudeCodePin();
  return pin ? claudeCodeBinary(currentClaudeCode(pin) ?? pin) : undefined;
}

/**
 * What a call to the Agent SDK runs: `explicit` (BELUGA_CLAUDE_PATH), else the Claude Code that's
 * current now (claudeCodePath), asked at each call so a newer one is used from the next run on
 * without a restart; none: the SDK finds its own.
 */
export function claudeExecutable(explicit?: string): { readonly pathToClaudeCodeExecutable?: string } {
  const bin = explicit ?? claudeCodePath();
  return bin ? { pathToClaudeCodeExecutable: bin } : {};
}

/** Where the newer Claude Code Beluga moved to is written (its pin), and the versions that failed their check. */
const CURRENT_FILE = 'current.json';
const SKIPPED_FILE = 'skipped.json';

/** `a` newer than `b`, both `major.minor.patch`. */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Same release line as the build's pin (its major and minor): the SDK this build carries speaks to it. */
export const sameLine = (a: string, b: string): boolean => a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.');

/**
 * The newer Claude Code this Mac moved to (claude-code-updates.ts), when there is one: same line as
 * the build's pin, newer than it, downloaded and checked. Undefined: the pin's own.
 */
export function currentClaudeCode(pin: ClaudeCodePin, home = belugaHome()): ClaudeCodePin | undefined {
  try {
    const cur = JSON.parse(readFileSync(path.join(claudeCodeDir(home), CURRENT_FILE), 'utf8')) as Partial<ClaudeCodePin>;
    if (typeof cur.version !== 'string' || typeof cur.url !== 'string' || typeof cur.integrity !== 'string') return undefined;
    const it = cur as ClaudeCodePin;
    if (!sameLine(it.version, pin.version) || !newerVersion(it.version, pin.version) || skippedClaudeCode(home).includes(it.version)) return undefined;
    return existsSync(claudeCodeBinary(it, home)) ? it : undefined;
  } catch {
    return undefined;
  }
}

/** Versions that failed their check here: never tried again. */
export function skippedClaudeCode(home = belugaHome()): string[] {
  try {
    const list = JSON.parse(readFileSync(path.join(claudeCodeDir(home), SKIPPED_FILE), 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Move to `to` (checked), or remember a version that failed its check. */
export function recordClaudeCode(home: string, outcome: { readonly current: ClaudeCodePin } | { readonly skipped: string }): void {
  const dir = claudeCodeDir(home);
  mkdirSync(dir, { recursive: true });
  if ('current' in outcome) writeFileSync(path.join(dir, CURRENT_FILE), JSON.stringify(outcome.current), { mode: 0o600 });
  else writeFileSync(path.join(dir, SKIPPED_FILE), JSON.stringify([...new Set([...skippedClaudeCode(home), outcome.skipped])].slice(-20)), { mode: 0o600 });
}

/**
 * The `claude` Beluga runs, to start by hand (signing in): the downloaded one, else the SDK's own
 * platform package, else whichever is on PATH.
 */
export function claudeCodeCommand(): string {
  const pinned = claudeCodePath();
  if (pinned && existsSync(pinned)) return pinned;
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${CLAUDE_EXE}`);
  } catch {
    return 'claude';
  }
}

/** The base64 sha512 of a file, as npm's integrity writes it. */
async function sha512(file: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline(createReadStream(file), hash);
  return `sha512-${hash.digest('base64')}`;
}

/** The tarball from the web, counting bytes as they come. */
async function fetchTo(url: string, to: string, onBytes: (got: number, total?: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Couldn’t download Claude Code (${res.status})`);
  const total = Number(res.headers.get('content-length')) || undefined;
  let got = 0;
  const count = new Transform({
    transform(chunk: Buffer, _e, done) {
      got += chunk.length;
      onBytes(got, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(to, { mode: 0o600 }));
}

/**
 * Download, check and unpack a Claude Code; other versions are removed, but for `keep` (the build's
 * pin and the one in use, when this is a newer one being fetched).
 */
export async function installClaudeCode(pin: ClaudeCodePin, opts: { home?: string; onProgress?: (p: ClaudeCodeProgress) => void; download?: typeof fetchTo; keep?: readonly string[] } = {}): Promise<string> {
  const dir = claudeCodeDir(opts.home);
  const bin = claudeCodeBinary(pin, opts.home);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, `${pin.version}.tgz.part`);
  const unpack = path.join(dir, `${pin.version}.part`);
  try {
    await (opts.download ?? fetchTo)(pin.url, tgz, (got, total) => opts.onProgress?.({ got, ...(total ? { total } : {}) }));
    if ((await sha512(tgz)) !== pin.integrity) throw new Error('The Claude Code download didn’t match what this build expects');
    await rm(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true });
    await promisify(execFile)('tar', ['-xzf', tgz, '-C', unpack, '--strip-components=1', `package/${CLAUDE_EXE}`]);
    await chmod(path.join(unpack, CLAUDE_EXE), 0o755);
    await rm(path.dirname(bin), { recursive: true, force: true });
    await rename(unpack, path.dirname(bin));
  } finally {
    await rm(tgz, { force: true });
    await rm(unpack, { recursive: true, force: true });
  }
  const keep = new Set([pin.version, ...(opts.keep ?? []), CURRENT_FILE, SKIPPED_FILE]);
  for (const old of readdirSync(dir)) if (!keep.has(old)) await rm(path.join(dir, old), { recursive: true, force: true });
  return bin;
}

let pending: Promise<void> | undefined;
const watchers = new Set<(p: ClaudeCodeProgress) => void>();

/**
 * Resolves once Claude Code can run: at once without a pin or once it's downloaded,
 * else after the one download every caller shares. A failed download is tried again next time.
 */
export function claudeCodeReady(onProgress?: (p: ClaudeCodeProgress) => void): Promise<void> {
  const pin = claudeCodePin();
  if (!pin || existsSync(claudeCodeBinary(pin)) || currentClaudeCode(pin)) return Promise.resolve();
  if (onProgress) watchers.add(onProgress);
  pending ??= installClaudeCode(pin, { onProgress: (p) => watchers.forEach((w) => w(p)) })
    .then(() => undefined)
    .finally(() => {
      pending = undefined;
      watchers.clear();
    });
  return pending;
}
