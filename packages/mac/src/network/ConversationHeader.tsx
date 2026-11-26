import type { ReactNode } from 'react';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, claudeColor } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { type ChatPerson, claudePill } from '@beluga/core/chat-people.js';
import { Icon } from '../components/Icon.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { useChatPeople } from './use-chat-people.js';
import { MembersButton } from './GroupInfo.js';
import { STATE_LABEL, conversationOf, openGroupInvitation } from './net-model.js';
import { openNet } from './net-sheets.js';
import { useSay } from './use-net.js';
import { channelName } from './chat-model.js';
import { CallButton } from '../call/CallStrip.js';
import s from './network.module.css';

export interface HeaderParts {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly right?: ReactNode;
}

/** How many people get a pill before the rest fold into "+3" (the members button lists them all). */
const PILLS = 4;

/** One person in the header (BLG-210): their picture with presence, their name, what their Claude is doing. */
function PersonPill({ p }: { p: ChatPerson }) {
  const words = claudePill(p);
  const tip = `${p.me ? 'You' : p.name} · ${STATE_LABEL[p.presence]} · ${p.me ? 'your' : 'their'} agent ${p.claude === 'working' && p.doing ? `is on: ${p.doing}` : words}`;
  return (
    <Tip label={tip}>
      <span className={s.pill} data-claude={p.claude} aria-label={tip}>
        <PersonAvatar name={p.name} id={p.peerId} state={p.presence} size={18} />
        <span className={s.pillName}>{p.me ? 'You' : p.name}</span>
        <span className={s.pillState}>
          {p.claude === 'working' || p.claude === 'idle' ? <Icon name="claude" size={11} style={{ color: claudeColor(p.peerId) }} /> : p.claude === 'update' ? <Icon name="alert" size={11} /> : null}
          {words}
        </span>
      </span>
    </Tip>
  );
}

/** Everyone in the conversation as pills, you first. */
function PeoplePills({ id }: { id: string }) {
  const { people } = useChatPeople(id);
  if (!people.length) return null;
  const shown = people.slice(0, PILLS);
  return (
    <span className={s.pills} role="list" aria-label="People here">
      {shown.map((p) => (
        <span key={p.peerId} role="listitem">
          <PersonPill p={p} />
        </span>
      ))}
      {people.length > PILLS ? <span className={s.pillMore}>+{people.length - PILLS}</span> : null}
    </span>
  );
}

/** The toolbar of a conversation with friends: its name, each person and their Claude as a pill, a ⋯ menu. */
export function useConversationHeader(id: string): HeaderParts {
  const { client } = useBeluga();
  const say = useSay();
  const net = useApp((st) => st.network);
  const target = conversationOf(id);
  if (target?.kind === 'dm') {
    const f = net.friends.find((x) => x.peerId === target.peerId);
    if (!f) return { title: 'Conversation' };
    const items: ActionItem[] = [
      { label: `New Channel with ${f.name}…`, icon: 'people', onSelect: () => openNet({ kind: 'new_group', with: [f.peerId] }) },
      { label: 'Copy Name', icon: 'copy', onSelect: () => void copyText(f.name).then(() => say(`Copied “${f.name}”`)) },
      { label: 'Clear Chat…', icon: 'x', separate: true, disabled: !net.messages[id]?.length, onSelect: () => openNet({ kind: 'clear_dm', peerId: f.peerId }) },
      { label: `Remove ${f.name}…`, danger: true, separate: true, onSelect: () => openNet({ kind: 'remove_friend', peerId: f.peerId }) },
    ];
    return {
      title: (
        <span className={s.titleRow} title={f.via === 'relay' && f.online ? 'Through another member’s computer' : undefined}>
          <Icon name="person" size={15} />
          <span className={s.titleName}>{f.name}</span>
          <PeoplePills id={id} />
        </span>
      ),
      right: (
        <>
          <CallButton id={id} label={f.name} />
          <ActionsDropdown items={items}>
            <IconButton size="small" icon="more" label={`More for ${f.name}`} />
          </ActionsDropdown>
        </>
      ),
    };
  }
  if (target?.kind === 'group') {
    const g = net.groups.find((x) => x.id === target.groupId);
    if (!g) return { title: 'Channel' };
    const copyLink = async (): Promise<void> => {
      const open = openGroupInvitation(net.invitations, g.id) ?? (await client.api.network['groups.invite'](g.id));
      await copyText(open.link);
      say(`Copied the invite link to ${g.name}`);
    };
    const items: ActionItem[] = g.active
      ? [
          { label: 'Channel Info', icon: 'people', onSelect: () => openNet({ kind: 'group_info', groupId: g.id }) },
          ...(g.admin
            ? [
                { label: 'Add People…', icon: 'plus' as const, onSelect: () => openNet({ kind: 'add_people', groupId: g.id }) },
                { label: 'Copy Invite Link', icon: 'link' as const, onSelect: () => void copyLink().catch(() => undefined) },
              ]
            : []),
          { label: 'Leave Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'leave_group', groupId: g.id }) },
        ]
      : [
          { label: 'Channel Info', icon: 'people', onSelect: () => openNet({ kind: 'group_info', groupId: g.id }) },
          { label: 'Delete Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'delete_group', groupId: g.id }) },
        ];
    return {
      title: (
        <span className={s.titleRow}>
          {g.active ? <Icon name="people" size={15} /> : <GroupAvatar name={g.name} id={g.id} size={20} muted />}
          <span className={s.titleName}>{channelName(net, g)}</span>
          {g.active ? <PeoplePills id={id} /> : null}
        </span>
      ),
      ...(g.active ? {} : { subtitle: <span>You’re no longer in this channel</span> }),
      right: (
        <>
          {g.active ? <CallButton id={id} label={`#${g.name}`} /> : null}
          <MembersButton g={g} />
          <ActionsDropdown items={items}>
            <IconButton size="small" icon="more" label={`More for ${g.name}`} />
          </ActionsDropdown>
        </>
      ),
    };
  }
  return { title: 'Conversation' };
}
