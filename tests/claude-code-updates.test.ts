import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { latestClaudeCode, updateClaudeCode } from '../src/agent/claude-code-updates.js';
import { type ClaudeCodePin, claudeCodeBinary, claudeExecutable, currentClaudeCode, newerVersion, sameLine, skippedClaudeCode } from '../src/agent/claude-code.js';

/**
 * Claude Code kept current, quietly (BLG-873): a newer Claude Code in the build's line is fetched,
 * checked with the SDK, and used from the next run, so new models (a new Opus) show without a
 * Beluga update. The pin always stays as the fallback.
 */

const pinOf = (version: string): ClaudeCodePin => ({ version, url: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: `sha512-${version}` });
const PIN = pinOf('0.3.301');

/** An install that "downloads" a binary into the home, as installClaudeCode lays it out. */
const fakeInstall = vi.fn(async (pin: ClaudeCodePin, opts: { home?: string } = {}) => {
  const bin = claudeCodeBinary(pin, opts.home);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return bin;
});

const home = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-ccup-'));

describe('versions', () => {
  it('tells newer from older, and the build’s line from another', () => {
    expect(newerVersion('0.3.319', '0.3.301')).toBe(true);
    expect(newerVersion('0.3.301', '0.3.301')).toBe(false);
    expect(newerVersion('0.3.99', '0.3.301')).toBe(false);
    expect(newerVersion('0.4.0', '0.3.999')).toBe(true);
    expect(sameLine('0.3.319', '0.3.301')).toBe(true);
    expect(sameLine('0.4.0', '0.3.301')).toBe(false);
  });
});

describe('npm’s latest Claude Code', () => {
  it('reads its version, tarball and integrity, and takes nothing else', async () => {
    const meta = { version: '0.3.319', dist: { tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.319.tgz', integrity: 'sha512-abc' } };
    const asked: string[] = [];
    expect(await latestClaudeCode(async (url) => (asked.push(url), meta), 'darwin', 'arm64')).toEqual({ version: '0.3.319', url: meta.dist.tarball, integrity: 'sha512-abc' });
    expect(asked).toEqual(['https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk-darwin-arm64/latest']);
    // From anywhere but npm, without a sha512, or not a plain version: not taken.
    expect(await latestClaudeCode(async () => ({ ...meta, dist: { ...meta.dist, tarball: 'https://evil.example/x.tgz' } }))).toBeUndefined();
    expect(await latestClaudeCode(async () => ({ ...meta, dist: { ...meta.dist, integrity: 'sha1-abc' } }))).toBeUndefined();
    expect(await latestClaudeCode(async () => ({ ...meta, version: '0.4.0-beta.1' }))).toBeUndefined();
    expect(await latestClaudeCode(async () => Promise.reject(new Error('offline')))).toBeUndefined();
  });
});

describe('keeping Claude Code current', () => {
  it('moves to a newer one in the build’s line once it checks out, and uses it from then on', async () => {
    const h = home();
    const works = vi.fn(async () => true);
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: fakeInstall as never, works })).toBe('updated');
    expect(works).toHaveBeenCalledWith(claudeCodeBinary(pinOf('0.3.319'), h));
    expect(currentClaudeCode(PIN, h)?.version).toBe('0.3.319');
    // Nothing newer: stays.
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: fakeInstall as never, works })).toBe('current');
    // A later one replaces it; the one it moved on from goes, the pin's stays as the fallback.
    mkdirSync(path.dirname(claudeCodeBinary(PIN, h)), { recursive: true });
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.330'), install: fakeInstall as never, works })).toBe('updated');
    expect(currentClaudeCode(PIN, h)?.version).toBe('0.3.330');
    expect(existsSync(path.dirname(claudeCodeBinary(pinOf('0.3.319'), h)))).toBe(false);
    expect(existsSync(path.dirname(claudeCodeBinary(PIN, h)))).toBe(true);
  });

  it('never leaves the build’s line, and never goes back', async () => {
    const h = home();
    const works = vi.fn(async () => true);
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.4.0'), install: fakeInstall as never, works })).toBe('current');
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.200'), install: fakeInstall as never, works })).toBe('current');
    expect(works).not.toHaveBeenCalled();
    expect(currentClaudeCode(PIN, h)).toBeUndefined();
  });

  it('keeps the pin when a newer one doesn’t start with this build’s SDK, and never tries that one again', async () => {
    const h = home();
    const install = vi.fn(fakeInstall);
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: install as never, works: async () => false })).toBe('failed');
    expect(currentClaudeCode(PIN, h)).toBeUndefined();
    expect(skippedClaudeCode(h)).toEqual(['0.3.319']);
    expect(existsSync(path.dirname(claudeCodeBinary(pinOf('0.3.319'), h)))).toBe(false);
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: install as never, works: async () => true })).toBe('skipped');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('tries a download that failed again next time', async () => {
    const h = home();
    const broken = vi.fn(async () => Promise.reject(new Error('The Claude Code download didn’t match')));
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: broken as never, works: async () => true })).toBe('failed');
    expect(skippedClaudeCode(h)).toEqual([]);
    expect(await updateClaudeCode({ pin: PIN, home: h, latest: async () => pinOf('0.3.319'), install: fakeInstall as never, works: async () => true })).toBe('updated');
  });

  it('does nothing without a pin (development runs the SDK’s own)', async () => {
    expect(await updateClaudeCode({ home: home(), latest: async () => pinOf('9.9.9'), works: async () => true })).toBe('current');
  });

  it('hands each SDK call the Claude Code you named, else the current one', () => {
    expect(claudeExecutable('/x/claude')).toEqual({ pathToClaudeCodeExecutable: '/x/claude' });
  });
});
