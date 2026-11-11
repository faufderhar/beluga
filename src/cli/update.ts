import { spawn } from 'node:child_process';
import { belugaEnv } from '../core/beluga-env.js';
import type { Exit, Io } from './io.js';

/** The install script on the latest release: installing again is updating. */
export const INSTALL_URL = 'https://github.com/beluga-labs/beluga/releases/latest/download/install.sh';

/** The line people paste to install or update Beluga on a server. */
export const INSTALL_LINE = `curl -fsSL ${INSTALL_URL} | sh`;

/**
 * What `beluga update` runs: the install script fetched whole first, so a download that fails (a
 * 404, no network) fails the update instead of piping nothing into a `sh` that then "succeeds".
 */
export function updateScript(url = INSTALL_URL): string {
  return `s=$(curl -fsSL '${url}' 2>/dev/null || wget -qO- '${url}' 2>/dev/null) && [ -n "$s" ] || { echo "Couldn't download ${url}" >&2; exit 1; }; printf '%s\\n' "$s" | sh`;
}

/**
 * `beluga update`: the install script again, which replaces ~/.beluga/server in place and restarts
 * Beluga if it was running. Only for the server install; the Mac app updates itself.
 */
export async function update(io: Io, opts: { serverRoot?: string; run?: (script: string) => Promise<number> } = {}): Promise<Exit> {
  const root = opts.serverRoot ?? belugaEnv('SERVER_ROOT');
  if (!root) {
    io.err(`This Beluga didn't come from the server install, so \`beluga update\` can't update it: the desktop app updates itself, and a copy from source updates with git.\nTo switch to the server install: ${INSTALL_LINE}\n`);
    return 1;
  }
  const run = opts.run ?? ((script: string) => new Promise<number>((resolve) => spawn('sh', ['-c', script], { stdio: 'inherit' }).on('close', (code) => resolve(code ?? 1)).on('error', () => resolve(1))));
  const code = await run(updateScript());
  if (code === 0) return 0;
  io.err(`The update didn't finish (exit ${code}). Beluga is as it was; try again, or run: ${INSTALL_LINE}\n`);
  return 1;
}
