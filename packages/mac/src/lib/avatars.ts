import { useEffect, useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { useMaybeApp, useMaybeBeluga } from './beluga.js';

/**
 * Profile pictures (net/mesh/avatars.ts): the network says each person's by checksum, the bytes
 * come once through `network.avatar.get` and are kept here as data URLs for every avatar that
 * shows them (a picture never changes under its checksum, so nothing here goes stale).
 */

type Network = AppState['network'];

const byNetwork = new WeakMap<object, ReadonlyMap<string, string>>();

/** Who has which picture: you, your friends, the people in your groups. */
function avatarsOf(network: Network): ReadonlyMap<string, string> {
  const known = byNetwork.get(network);
  if (known) return known;
  const map = new Map<string, string>();
  for (const g of network.groups) for (const m of g.members) if (m.avatar) map.set(m.peerId, m.avatar);
  for (const f of network.friends) if (f.avatar) map.set(f.peerId, f.avatar);
  if (network.self?.avatar) map.set(network.self.peerId, network.self.avatar);
  byNetwork.set(network, map);
  return map;
}

const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | undefined>>();

/** A picture's bytes, once, as a data URL (shared by everyone asking for the same checksum). */
function loadAvatar(client: SocketClient, sha: string): Promise<string | undefined> {
  const have = urls.get(sha);
  if (have) return Promise.resolve(have);
  let load = loading.get(sha);
  if (!load) {
    load = client.api.network['avatar.get'](sha).then(
      (p) => {
        if (!p) return undefined;
        const data = `data:${p.mime};base64,${p.b64}`;
        urls.set(sha, data);
        return data;
      },
      () => undefined,
    );
    void load.finally(() => loading.delete(sha));
    loading.set(sha, load);
  }
  return load;
}

/**
 * Someone's picture outside React (the sharer's overlay, call/overlay.ts): what's here already,
 * or undefined while it comes (`ready` is called once it has).
 */
export function avatarNow(client: SocketClient, peerId: string, ready: () => void): string | undefined {
  const sha = avatarsOf(client.store.getState().network).get(peerId);
  if (!sha) return undefined;
  const have = urls.get(sha);
  if (!have) void loadAvatar(client, sha).then((data) => data && ready());
  return have;
}

/** Someone's profile picture as a URL to draw, once it's here (undefined: show their initial). */
export function useAvatarUrl(peerId: string, skip = false): string | undefined {
  const beluga = useMaybeBeluga();
  const sha = useMaybeApp((s) => (skip ? undefined : avatarsOf(s.network).get(peerId)), undefined);
  const [url, setUrl] = useState(() => (sha ? urls.get(sha) : undefined));
  useEffect(() => {
    if (!sha || !beluga) return setUrl(undefined);
    const have = urls.get(sha);
    if (have) return setUrl(have);
    let alive = true;
    void loadAvatar(beluga.client, sha).then((data) => alive && setUrl(data));
    return () => {
      alive = false;
    };
  }, [sha, beluga]);
  return sha ? url : undefined;
}
