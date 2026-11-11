import fs, { mkdtempSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// GitHub's Windows runners name the temp folder the short 8.3 way (C:\Users\RUNNER~1\…), while git
// and Beluga see it by its long name: use the long one, so the folders the tests make match.
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = realpathSync.native(os.tmpdir());
// A shell or git that just ended still holds its folder for a moment on Windows, and anywhere a write
// still landing can refill a folder being removed (ENOTEMPTY): a test's cleanup tries again rather
// than failing the test it follows.
const rm = fs.rmSync;
fs.rmSync = ((p, o) => rm(p, o?.recursive ? { maxRetries: 10, retryDelay: 100, ...o } : o)) as typeof fs.rmSync;
syncBuiltinESMExports();

// Never read or write the developer's real ~/.beluga (or an old ~/.klaud) during tests.
process.env.BELUGA_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-test-home-'));
// Nor the old name, for a test that clears BELUGA_HOME (an inherited KLAUD_HOME is real data).
delete process.env.KLAUD_HOME;
// Nor the developer's Codex sessions (deleting a worktree forgets the ones that ran there).
process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-test-codex-'));

// The tests are a Mac's wherever they run ("Your Mac"; shared/assistant.ts).
process.env.BELUGA_COMPUTER ??= 'mac';
