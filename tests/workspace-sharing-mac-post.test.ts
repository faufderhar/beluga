import { describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceSharing } from '../src/core/workspace-sharing.js';

/**
 * BLG-393: your Mac chats (mac:assistant, mac:assistant:<id>) and the Sentinel chat (sentinel-chat:<id>)
 * are yours only. canPost gates every chat frame and agent request a room peer sends (session.ts,
 * agent-host.ts, friend-share), so a peer's frame into one of them must be refused there.
 */

const OWN_CHANNELS = ['mac:assistant', 'mac:assistant:c1', 'sentinel-chat:s1'];

function sharing(): WorkspaceSharing {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: 'me', isHost: true });
  return new WorkspaceSharing({ store, selfId: () => 'me', send: () => true, shares: new ShareService([]), toast: () => undefined, intend: () => undefined });
}

describe('posting into your own chats', () => {
  it.each(OWN_CHANNELS)("refuses a room peer's frame into %s", (channel) => {
    expect(sharing().canPost('bob', channel)).toBe(false);
  });

  it.each(OWN_CHANNELS)("accepts the owner's frame into %s", (channel) => {
    expect(sharing().canPost('me', channel)).toBe(true);
  });

  it('keeps the room open to everyone', () => {
    expect(sharing().canPost('bob', 'room')).toBe(true);
  });
});
