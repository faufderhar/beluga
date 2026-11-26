import path from 'node:path';
import type { AcpAgentSpec } from '../acp/spec.js';

export const AGY_MISSING = 'Install the Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash';
export const AGY_SIGN_IN = 'Run agy in Terminal once to sign in with your Google account';
export const AGY_MISSING_WORDS = (where = process.platform === 'darwin' ? 'Mac' : 'computer'): string => `The Antigravity CLI isn’t installed on this ${where}. Install it (curl -fsSL https://antigravity.google/cli/install.sh | bash), then try again.`;

/**
 * Antigravity as an ACP agent: the Antigravity CLI's own ACP server (`agy acp`), signed in with
 * your Google account. BELUGA_AGY_PATH, then PATH, then its install script's folder (~/.local/bin)
 * and Homebrew's.
 */
export const ANTIGRAVITY: AcpAgentSpec = {
  id: 'antigravity',
  label: 'Antigravity',
  command: 'agy',
  args: ['acp'],
  pathVar: 'BELUGA_AGY_PATH',
  searchDirs: (platform, home) => (platform === 'win32' ? [path.win32.join(home, '.local', 'bin')] : [path.posix.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']),
  addDirFlag: '--add-dir',
  missingWords: AGY_MISSING_WORDS,
  installFix: AGY_MISSING,
  signInFix: AGY_SIGN_IN,
};
