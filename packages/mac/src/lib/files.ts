import type { AppState, Location } from '@beluga/core/store.js';
import { peerName } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { dirName, joinPath } from '@beluga/shared/os-path.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inApp, webServed } from './boot.js';
import { runsWhenOpened } from './runs-when-opened.js';
import { openThere } from './remote-open.js';
import { t } from '../i18n/index.js';

/**
 * Files you see in Beluga, the Mac way: where one is on this Mac (to show it in Finder or copy
 * its path), and saving a friend's file where you choose with the standard Save panel.
 */

/** The file's place on this Mac, when it's yours (your shares and workspaces); otherwise undefined. */
export function localPathOf(state: AppState, at: Location): string | undefined {
  if (at.owner !== state.selfId) return undefined;
  const share = state.myShares.find((s) => s.name === at.share);
  if (share?.root) return joinPath(share.root, at.path);
  for (const p of state.projects) {
    const ws = p.workspaces.find((w) => shareNameOf(w.id) === at.share);
    if (ws) return joinPath(ws.path, at.path);
  }
  return undefined;
}

/** How to name a file in a message: its path in your own workspace, else "bob:share/path". */
export function mentionOf(state: AppState, at: Location): string {
  const ws = state.view.kind === 'workspace' ? state.view.id : undefined;
  if (ws && at.owner === state.selfId && at.share === shareNameOf(ws)) return at.path || '.';
  return `${peerName(state, at.owner)}:${at.share}/${at.path}`;
}

const parentOf = (p: string): string => dirName(p) || '/';

/**
 * In a page the web port served there's no Finder on this side: a file comes down as a download;
 * a folder's path is copied, and said.
 */
async function downloadOrSay(client: SocketClient, path: string): Promise<void> {
  const [info] = await client.api.local.statFiles([path]);
  if (info?.kind === 'file') {
    const { download } = await import('./web-files.js');
    await download(client, { path });
    return;
  }
  const { copyText } = await import('./copy.js');
  await copyText(path).catch(() => undefined);
  client.store.dispatch({ type: 'toast', text: `It's on the computer Beluga runs on: ${path} (copied)`, level: 'info' });
}

/** Show a file of yours selected in Finder (in development: open its folder; in a served page: download it). */
export async function revealInFinder(client: SocketClient, path: string): Promise<void> {
  if (webServed()) return downloadOrSay(client, path);
  // On a computer's page: downloaded, or its path copied (BLG-794).
  if (await openThere(client, path, 'reveal')) return;
  if (inApp()) {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
    return;
  }
  await client.api.local.openFolder(parentOf(path));
}

/** Open a file of yours the way Finder would (its default app, usually your editor). One that runs something shows in Finder instead. */
export async function openWithDefaultApp(client: SocketClient, path: string): Promise<void> {
  if (webServed()) return downloadOrSay(client, path);
  // On a computer's page: your editor over Remote-SSH, else as Show in Finder there (BLG-794).
  if (await openThere(client, path, 'open')) return;
  if (runsWhenOpened(path)) return revealInFinder(client, path);
  await client.api.local.openFolder(path);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Download a shared file: the Save panel picks where (starting in Downloads, with its name), then
 * Beluga fetches it there. Cancelling the panel does nothing. Outside the app it goes to ~/Downloads/Beluga.
 */
export async function saveFile(client: SocketClient, at: Location): Promise<void> {
  const name = at.path.split('/').pop() || 'download';
  try {
    if (webServed()) {
      const { download } = await import('./web-files.js');
      await download(client, { at });
      return;
    }
    if (!inApp()) {
      await client.api.files.download(at);
      return;
    }
    const [{ save }, { downloadDir }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/path')]);
    const dir = await downloadDir().catch(() => '');
    const to = await save({ title: t(`Save ${name}`), defaultPath: dir ? joinPath(dir, name) : name });
    if (to) await client.api.files.download(at, { to });
  } catch (err) {
    client.store.dispatch({ type: 'toast', text: `Couldn't save ${name}: ${errorText(err)}`, level: 'error' });
  }
}
