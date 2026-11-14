import * as Context from '@radix-ui/react-context-menu';
import { type ReactNode, useState } from 'react';
import { TRUST_INFO, canRunOn, trustOf } from '@beluga/core/trust.js';
import { defaultAgentOf } from '@beluga/protocol.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { ContextRoot } from '../../components/ContextRoot.js';
import { cx } from '../../components/ui.js';
import { befriend, openFriendCard } from '../../network/use-net.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { Alert, optionIndex } from './parts.js';
import { RunCommandSheet, addressTo } from './PeerSheets.js';
import { presetShareWith } from './ShareFolderSheet.js';
import m from '../../components/SpecMenu.module.css';
import p from './person.module.css';

interface Item {
  readonly label: string;
  readonly run: () => void;
  readonly danger?: boolean;
}

/**
 * Right-click on someone in your room: their trust (said, and changed in their friend card), then
 * what you can do with them. The same actions as their room card.
 */
export function PersonContextMenu({ index, children }: { index: number; children: ReactNode }) {
  const [removing, setRemoving] = useState<{ name: string; guest: boolean; run: () => void }>();
  const [running, setRunning] = useState(false);
  const peer = useApp((st) => st.peers[index]);
  return (
    <>
      <ContextRoot>
        <Context.Trigger asChild>{children}</Context.Trigger>
        <Context.Portal>
          <Context.Content className={m.menu} collisionPadding={8}>
            <Items index={index} onRemove={setRemoving} onRun={() => setRunning(true)} />
          </Context.Content>
        </Context.Portal>
      </ContextRoot>
      {running && peer ? <RunCommandSheet peer={peer} close={() => setRunning(false)} /> : null}
      {removing ? (
        <Alert
          title={`Remove ${removing.name}?`}
          message={removing.guest ? 'They are disconnected and lose access to everything you invited them to.' : `${removing.name} is disconnected and the room’s invite link changes, so the old one stops working.`}
          confirm="Remove"
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            setRemoving(undefined);
            removing.run();
          }}
        />
      ) : null}
    </>
  );
}

function Items({ index, onRemove, onRun }: { index: number; onRemove: (r: { name: string; guest: boolean; run: () => void }) => void; onRun: () => void }) {
  const api = useApi();
  const actions = useActions();
  const { client, ui } = useBeluga();
  const state = useApp((st) => st);
  const peer = state.peers[index];
  if (!peer) return null;
  const menu = { kind: 'person', index } as const;
  const pick = (id: string): void => {
    const i = optionIndex(client.store.getState(), menu, id);
    if (i >= 0) actions.pick(menu, i);
  };
  const me = peer.peerId === state.selfId;
  const guest = state.guests[peer.peerId];
  const grant = state.granted[peer.peerId];
  const items: Item[] = me
    ? [
        { label: `Ask My ${agentName(defaultAgentOf(peer))}`, run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: true, self: true }) },
        { label: 'Share a Folder…', run: () => pick('share-folder') },
        { label: 'Settings…', run: () => ui.patch({ settings: 'general' }) },
      ]
    : [
        { label: 'Message', run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: false }) },
        ...(peer.agent ? [{ label: `Ask ${peer.name}’s ${agentName(defaultAgentOf(peer))}`, run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: true }) }] : []),
        ...(!guest && canRunOn(grant?.level) ? [{ label: `Run a Command on ${peer.name}’s Computer…`, run: onRun }] : []),
        ...(guest ? [] : [{ label: state.follow === peer.peerId ? `Stop Following ${peer.name}` : `Follow ${peer.name}`, run: () => pick(state.follow === peer.peerId ? 'unfollow' : 'follow') }]),
        ...(!guest && peer.shares[0] ? [{ label: `Browse ${peer.name}’s Files`, run: () => pick('browse') }] : []),
        ...(guest ? [] : [{ label: 'Invite to a Workspace…', run: () => pick('person-invite-ws') }]),
        ...(guest ? [] : [{ label: `Share a Folder with ${peer.name}…`, run: () => (presetShareWith(peer.peerId), pick('person-share')) }]),
      ];
  const trust = trustOf(state, peer.peerId);
  const friend = state.network.friends.some((f) => f.peerId === peer.peerId);
  const host = state.self?.host === true;
  return (
    <>
      <Context.Item className={m.item} onSelect={() => ui.openMenu(menu)}>
        <span className={m.label}>{me ? 'Show My Card' : `Show ${peer.name}’s Card`}</span>
      </Context.Item>
      <Context.Separator className={m.separator} />
      {!me && !guest ? (
        <>
          {/* Trust is set in one place, their friend card (BLG-202): here it's only said. */}
          <Context.Item className={cx(m.item, p.subTrigger)} disabled>
            <span className={m.label}>Trust</span>
            <span className={p.subValue}>{TRUST_INFO[trust].label}</span>
          </Context.Item>
          {friend ? (
            <Context.Item className={m.item} onSelect={() => openFriendCard(client, peer.peerId)}>
              <span className={m.label}>Change in Their Card…</span>
            </Context.Item>
          ) : (
            <Context.Item className={m.item} onSelect={() => void befriend(client, peer.peerId, peer.name)}>
              <span className={m.label}>Add as Friend</span>
              <span className={m.hint}>Trust is set on a friend’s card</span>
            </Context.Item>
          )}
          <Context.Separator className={m.separator} />
        </>
      ) : null}
      {items.map((it) => (
        <Context.Item key={it.label} className={m.item} onSelect={it.run}>
          <span className={m.label}>{it.label}</span>
        </Context.Item>
      ))}
      {!me && (host || guest) ? (
        <>
          <Context.Separator className={m.separator} />
          <Context.Item className={cx(m.item, m.danger)} onSelect={() => onRemove({ name: peer.name, guest: Boolean(guest), run: () => (guest ? void api.invites.remove(peer.peerId) : pick('person-remove')) })}>
            <span className={m.label}>Remove {peer.name}…</span>
          </Context.Item>
        </>
      ) : null}
    </>
  );
}
