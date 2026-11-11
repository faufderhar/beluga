import { useEffect, useState } from 'react';
import type { BelugaClient } from '@beluga/ipc/client.js';
import { inApp, webServed } from './boot.js';
import { useBeluga } from './beluga.js';
import { t } from '../i18n/index.js';

/** A project's icon as an image URL, or null when it has none (it gets its initial instead). */
type Icon = string | null;

// Read once per project per window; changing it (Change Icon…) reads it again.
const cache = new Map<string, Promise<Icon>>();
const listeners = new Set<(projectId: string) => void>();

function load(client: BelugaClient, key: string): Promise<Icon> {
  // No project (Your Mac's): no icon to ask for.
  if (!key) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    // "path:/…" is a folder that isn't a project yet.
    const read = key.startsWith('path:') ? client.api.projects.iconAt(key.slice(5)) : client.api.projects.icon(key);
    p = read.then(
      (icon) => (icon ? `data:${icon.mime};base64,${icon.data}` : null),
      () => null,
    );
    cache.set(key, p);
  }
  return p;
}

/** Forget a project's icon so it's read again everywhere it shows. */
export function reloadProjectIcon(projectId: string): void {
  cache.delete(projectId);
  for (const l of [...listeners]) l(projectId);
}

export function useProjectIcon(projectId: string): Icon | undefined {
  const { client } = useBeluga();
  const [icon, setIcon] = useState<Icon | undefined>(undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = (id: string): void => void (id === projectId && setVersion((v) => v + 1));
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    void load(client, projectId).then((i) => alive && setIcon(i));
    return () => {
      alive = false;
    };
  }, [client, projectId, version]);
  return icon;
}

/**
 * Choose folders with the Mac's own Open panel; in a page the web port served, the server's
 * folders in Beluga's own picker (undefined in a development browser, or when cancelled).
 */
export async function pickFolders(title: string, opts: { machine?: string | undefined } = {}): Promise<string[] | undefined> {
  // On a page of one of your computers (BLG-793): its folders, walked over its link, not this Mac's.
  if (opts.machine) {
    const [{ browseFolder }, { machineClientOf }, { currentMachines }] = await Promise.all([import('../dialogs/FolderBrowser.js'), import('../machines/pane-clients.js'), import('../machines/use-machines.js')]);
    const client = machineClientOf(opts.machine);
    if (!client) throw new Error('That computer can’t be reached right now');
    const name = currentMachines().find((m) => m.id === opts.machine)?.name ?? 'your computer';
    const picked = await browseFolder(title, { on: { name, browse: (dir) => client.api.local.browse(dir) } });
    return picked ? [picked] : undefined;
  }
  if (!inApp()) {
    if (!webServed()) return undefined;
    const { browseFolder } = await import('../dialogs/FolderBrowser.js');
    const picked = await browseFolder(title);
    return picked ? [picked] : undefined;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: true, title: t(title) });
  if (!picked) return undefined;
  return Array.isArray(picked) ? picked : [picked];
}

/** Choose an image file with the Open panel (in a served page: the browser's, uploaded to the server). */
export async function pickImage(title: string): Promise<string | undefined> {
  if (!inApp()) {
    if (!webServed()) return undefined;
    const { chooseLocalFiles, uploadFile } = await import('./web-files.js');
    const [file] = await chooseLocalFiles({ accept: 'image/png,image/svg+xml,image/jpeg,image/webp,image/x-icon' });
    return file ? (await uploadFile(file)).path : undefined;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, title: t(title), filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico'] }] });
  return typeof picked === 'string' ? picked : undefined;
}
