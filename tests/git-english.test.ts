import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Beluga reads git's messages (changes in the way of an update, a branch not fully merged, why a
 * push failed), so it asks git for them in English whatever the computer's language. On a Mac set
 * to Chinese, git answered in Chinese, and Update Main said "failed" instead of offering to move
 * the changes. Where git has no translations installed, this passes either way.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'git-english-'));
execFileSync('git', ['init', '-q', dir]);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('git’s messages, for a user whose language isn’t English', () => {
  it('come in English', async () => {
    vi.stubEnv('LANGUAGE', 'zh_CN');
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
    vi.stubEnv('LANG', 'zh_CN.UTF-8');
    vi.resetModules();
    try {
      const { git } = await import('../src/workspaces/git.js');
      await expect(git(dir, ['branch', '-d', 'no-such-branch'])).rejects.toThrow(/branch 'no-such-branch' not found/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
