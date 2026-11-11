import { useEffect, useRef, useState } from 'react';
import type { FriendOfferView, FriendView, GroupView } from '@beluga/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar, Badge, Button, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { groupChatOpen } from '../lib/group-chat.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { sameDeep } from '../lib/stable.js';
import { Row, Section } from '../layout/sidebar-parts.js';
import { optionIndex } from '../dialogs/native/parts.js';
import { openPerson } from '../dialogs/native/PersonPopover.js';
import { PersonContextMenu } from '../dialogs/native/PersonMenu.js';
import { PersonButton } from './PersonProfile.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { type RoomBits, type RoomPerson, dmId, groupId, incomingOffers, membersLine, notFriendsYet, offerSent, openGroupInvitation, presenceLine, roomBits, shownState, sortFriends, sortGroups } from './net-model.js';
import { openNet } from './net-sheets.js';
import { answerOffer, befriend, errorText, openDm, openFriendCard, openGroup, quietly, useNetwork, useSay } from './use-net.js';
import { channelName, isMain } from './chat-model.js';
import { openMain } from './ChatTabs.js';
import side from '../layout/Sidebar.module.css';
import s from './network.module.css';

/**
 * The sidebar's Friends and Groups: who's around (with their status), the groups you're in,
 * unread counts, and right-click menus. While the network is off, a short card turns it on.
 */

/** Turn on talking with friends: what it is in two lines, and one button. */
function Welcome() {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.network.setEnabled(true));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.welcome} role="group" aria-label="Talk with friends">
      <div className={s.welcomeArt} aria-hidden="true">
        <Avatar name="A" id="welcome-a" size={22} />
        <Avatar name="J" id="welcome-b" size={22} />
        <Avatar name="M" id="welcome-c" size={22} />
      </div>
      <div className={s.welcomeTitle}>Talk with friends directly</div>
      <div className={s.welcomeText}>Messages and groups go straight from computer to computer, end-to-end encrypted. No server, no account.</div>
      <div className={s.welcomeButtons}>
        <Button variant="primary" size="small" disabled={busy} onClick={() => void turnOn()}>
          {busy ? 'Turning On…' : 'Turn On'}
        </Button>
        <Button variant="quiet" size="small" onClick={() => setPrefs({ folded: [...prefs.folded.filter((f) => f !== 'friends'), 'friends'] })}>
          Not Now
        </Button>
      </div>
      {error ? (
        <div className={s.welcomeError} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** A friend who's in your room too: following their screen, and their room card (sharing, workspaces). */
interface RoomCtx {
  readonly bits: RoomBits;
  readonly follow: () => void;
  readonly roomCard: () => void;
}

function friendItems(f: FriendView, groups: readonly GroupView[], ctx: { open: () => void; card: () => void; say: (t: string) => void; addTo: (g: GroupView) => void; room?: RoomCtx | undefined }): ActionItem[] {
  const mine = sortGroups(groups).filter((g) => g.active && g.admin && !g.members.some((m) => m.peerId === f.peerId));
  return [
    { label: 'Message', icon: 'chat', onSelect: ctx.open },
    { label: `${f.name}’s Card…`, icon: 'person', onSelect: ctx.card },
    ...(ctx.room
      ? [
          { label: ctx.room.bits.following ? `Stop Following ${f.name}` : `Follow ${f.name}’s Screen`, icon: 'eye' as const, separate: true, onSelect: ctx.room.follow },
          { label: 'In This Room…', icon: 'people' as const, onSelect: ctx.room.roomCard },
        ]
      : []),
    {
      label: 'Add to Channel',
      icon: 'people',
      onSelect: () => undefined,
      submenu: [
        ...mine.map((g) => ({ label: g.name, onSelect: () => ctx.addTo(g) })),
        { label: `New Channel with ${f.name}…`, separate: mine.length > 0, onSelect: () => openNet({ kind: 'new_group', with: [f.peerId] }) },
      ],
    },
    { label: 'Copy Name', icon: 'copy', separate: true, onSelect: () => void copyText(f.name).then(() => ctx.say(`Copied “${f.name}”`)) },
    { label: `Remove ${f.name}…`, danger: true, separate: true, onSelect: () => openNet({ kind: 'remove_friend', peerId: f.peerId }) },
  ];
}

function FriendRow({ f, groups }: { f: FriendView; groups: readonly GroupView[] }) {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const say = useSay();
  const selected = useApp((st) => st.view.kind === 'conversation' && st.view.id === dmId(f.peerId));
  // In your room too: the room's bits join their friend row (there's no second list of people).
  const bits = useApp((st) => roomBits(st.peers, f.peerId, st.follow), sameDeep);
  const state = shownState(f);
  const note = state !== 'offline' ? f.presence.note?.trim() : undefined;
  const emoji = state !== 'offline' ? f.presence.emoji?.trim() : undefined;
  const addTo = (g: GroupView): void => {
    client.api.network['groups.addMember'](g.id, f.peerId).then(
      () => say(`Added ${f.name} to ${g.name}`),
      () => undefined,
    );
  };
  const room: RoomCtx | undefined = bits
    ? {
        bits,
        follow: () => {
          const menu = { kind: 'person', index: bits.index } as const;
          const i = optionIndex(client.store.getState(), menu, bits.following ? 'unfollow' : 'follow');
          if (i >= 0) actions.pick(menu, i);
        },
        roomCard: () => openPerson(ui, bits.index),
      }
    : undefined;
  const roomLine = bits ? ` · in your room${bits.claude ? ' · agent on' : ''}${bits.following ? ' · you follow their screen' : ''}` : '';
  return (
    <ActionsContext items={() => friendItems(f, groups, { open: () => openDm(client, f.peerId), card: () => openFriendCard(client, f.peerId), say, addTo, room })}>
      <Row
        data-friend-row={f.peerId}
        data-person-row={bits ? f.peerId : undefined}
        selected={selected}
        icon={
          <PersonButton peerId={f.peerId} name={f.name}>
            <PersonAvatar name={f.name} id={f.peerId} state={state} size={18} />
          </PersonButton>
        }
        aria-label={`${f.name}, ${presenceLine(f)}${f.unread ? `, ${f.unread} unread` : ''}`}
        label={
          <span className={s.who}>
            <span className={cx(s.whoName, f.unread > 0 && s.unreadName)}>{f.name}</span>
            {emoji ? (
              <span className={s.whoEmoji} aria-hidden>
                {emoji}
              </span>
            ) : null}
            {note ? <span className={s.whoNote}>{note}</span> : null}
          </span>
        }
        detail={`${f.name} · ${presenceLine(f)}${f.via === 'relay' ? ' · connected through another computer' : ''}${roomLine}`}
        onClick={() => openDm(client, f.peerId)}
        trailing={
          <>
            {bits?.following ? (
              <Tip label="Following their screen">
                <Icon name="eye" size={12} />
              </Tip>
            ) : null}
            {bits?.claude ? (
              <Tip label={`${f.name}’s agent is on in this room`}>
                <Icon name="claude" size={12} className={side.claudeMark} />
              </Tip>
            ) : null}
            {f.via === 'relay' && f.online ? (
              <Tip label="Connected through another member’s computer (still end-to-end encrypted)">
                <span className={s.relay}>
                  <Icon name="link" size={11} />
                </span>
              </Tip>
            ) : null}
            {f.unread ? <Badge count={f.unread} urgent /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}

/** Rename a group in place (Return keeps it, Esc puts it back). */
function RenameField({ g, done }: { g: GroupView; done: () => void }) {
  const { client } = useBeluga();
  const [name, setName] = useState(g.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = (): void => {
    const next = name.trim();
    done();
    if (next && next !== g.name) void client.api.network['groups.rename'](g.id, next);
  };
  return (
    <input
      ref={ref}
      className={s.rename}
      style={{ fontSize: 'inherit', textAlign: 'left', height: 22 }}
      aria-label={`New name for ${g.name}`}
      value={name}
      maxLength={64}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') done();
      }}
    />
  );
}

function groupItems(g: GroupView, ctx: { open: () => void; rename: () => void; copyLink: () => void; read: () => void }): ActionItem[] {
  return [
    { label: 'Open', icon: 'chat', onSelect: ctx.open },
    ...(g.unread ? [{ label: 'Mark as Read', icon: 'check' as const, onSelect: ctx.read }] : []),
    ...(g.active
      ? [
          { label: 'Rename…', icon: 'pencil' as const, separate: true, onSelect: ctx.rename },
          ...(g.admin
            ? [
                { label: 'Add People…', icon: 'plus' as const, onSelect: () => openNet({ kind: 'add_people', groupId: g.id }) },
                { label: 'Copy Invite Link', icon: 'link' as const, onSelect: ctx.copyLink },
              ]
            : []),
          { label: 'Leave Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'leave_group', groupId: g.id }) },
        ]
      : [{ label: 'Delete Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'delete_group', groupId: g.id }) }]),
  ];
}

function GroupRow({ g }: { g: GroupView }) {
  const { client } = useBeluga();
  const say = useSay();
  const net = useNetwork();
  const main = isMain(net, g);
  const invitations = useApp((st) => st.network.invitations);
  const selected = useApp((st) => st.view.kind === 'conversation' && st.view.id === groupId(g.id));
  const [renaming, setRenaming] = useState(false);
  const copyLink = async (): Promise<void> => {
    const open = openGroupInvitation(invitations, g.id) ?? (await client.api.network['groups.invite'](g.id));
    await copyText(open.link);
    say(`Copied the invite link to ${g.name}`);
  };
  const requests = g.admin ? g.requests.length : 0;
  return (
    <ActionsContext items={() => groupItems(g, { open: () => openGroup(client, g.id), rename: () => setRenaming(true), copyLink: () => void copyLink().catch(() => undefined), read: () => void client.api.network.read(groupId(g.id)) })}>
      <Row
        data-group-row={g.id}
        selected={selected}
        className={g.active ? undefined : s.left}
        icon={main ? <span className={s.mainIcon}><Icon name="people" size={12} /></span> : <GroupAvatar name={g.name} id={g.id} size={18} muted={!g.active} />}
        aria-label={`Channel ${channelName(net, g)}${g.unread ? `, ${g.unread} unread` : ''}`}
        label={renaming ? <RenameField g={g} done={() => setRenaming(false)} /> : <span className={cx(s.whoName, g.unread > 0 && g.active && s.unreadName)}>{channelName(net, g)}</span>}
        detail={main ? `Your main channel: all your friends · ${membersLine(g.members)}` : g.active ? `${g.name} · ${membersLine(g.members)}` : `${g.name} · you’re no longer in this channel`}
        onClick={() => (renaming ? undefined : openGroup(client, g.id))}
        onDoubleClick={() => g.active && !main && setRenaming(true)}
        trailing={
          <>
            {requests ? (
              <Tip label={`${requests} ${requests === 1 ? 'person asks' : 'people ask'} to join`}>
                <span className={s.requests}>{requests}</span>
              </Tip>
            ) : null}
            {g.unread && g.active ? <Badge count={g.unread} urgent /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}

/** Someone in your room asks to be friends: one main action (Accept); Not Now on right-click. */
function OfferRow({ o }: { o: FriendOfferView }) {
  const { client } = useBeluga();
  return (
    <ActionsContext
      items={() => [
        { label: 'Accept', icon: 'check', onSelect: () => void answerOffer(client, o.peerId, o.name, true) },
        { label: 'Not Now', icon: 'x', separate: true, onSelect: () => void answerOffer(client, o.peerId, o.name, false) },
      ]}
    >
      <Row
        data-offer-row={o.peerId}
        icon={<Avatar name={o.name} id={o.peerId} size={18} />}
        aria-label={o.via ? `${o.name} from the ${o.via} team wants to add you as a friend` : `${o.name} wants to add you as a friend`}
        label={<span className={s.whoName}>{o.name} wants to add you</span>}
        detail={o.via ? `${o.name} is on the ${o.via} team with you and asks to be friends on the Beluga network` : `${o.name} is in your room and asks to be friends on the Beluga network`}
        onClick={() => void answerOffer(client, o.peerId, o.name, true)}
        trailing={
          <Button size="small" variant="primary" onClick={(e) => (e.stopPropagation(), void answerOffer(client, o.peerId, o.name, true))}>
            Accept
          </Button>
        }
      />
    </ActionsContext>
  );
}

/** Someone in your room who isn't a friend yet: their room card on click, and one action, Add as Friend. */
function RoomPersonRow({ p, sent }: { p: RoomPerson & { index: number }; sent: boolean }) {
  const { client, ui } = useBeluga();
  return (
    <PersonContextMenu index={p.index}>
      <Row
        data-person-row={p.peerId}
        icon={<Avatar name={p.name} id={p.peerId} size={18} />}
        label={<span className={s.whoName}>{p.name}</span>}
        detail={`${p.name} · in your room${p.agent ? ' · agent on' : ''}${sent ? ' · friend request sent' : ''}`}
        onClick={() => openPerson(ui, p.index, document.querySelector<HTMLElement>(`[data-person-row="${CSS.escape(p.peerId)}"]`))}
        trailing={
          sent ? (
            <Tip label="Waiting for them to accept">
              <Icon name="clock" size={12} />
            </Tip>
          ) : (
            <Tip label={`Add ${p.name} as a friend`}>
              <Button size="small" variant="quiet" icon="plus" aria-label={`Add ${p.name} as a friend`} onClick={(e) => (e.stopPropagation(), void befriend(client, p.peerId, p.name))}>
                Add
              </Button>
            </Tip>
          )
        }
      />
    </PersonContextMenu>
  );
}

/** Friends: everyone you've added, with their status; or the card that turns the network on. Then people in your room who aren't friends yet. */
export function FriendsSection() {
  const net = useNetwork();
  const friends = sortFriends(net.friends);
  const offers = incomingOffers(net.offers);
  const strangers = useApp((st) => notFriendsYet(st.peers, { selfId: st.self?.peerId, friends: st.network.friends, guests: st.guests }), sameDeep);
  return (
    <Section id="friends" title="Friends" action={net.enabled ? <IconButton icon="plus" label="Add a friend" onClick={() => openNet({ kind: 'add_friend' })} /> : undefined}>
      <div className={s.sidebarList}>
        {offers.map((o) => (
          <OfferRow key={o.peerId} o={o} />
        ))}
        {!net.enabled ? (
          <Welcome />
        ) : (
          <>
            {friends.map((f) => (
              <FriendRow key={f.peerId} f={f} groups={net.groups} />
            ))}
            {friends.length || strangers.length ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="Add a friend…" detail="Send them a link or a code; they’re a friend once they use it" onClick={() => openNet({ kind: 'add_friend' })} />}
            {net.pendingJoins.map((p) => (
              <Row key={p.groupId} className={side.hintRow} icon={<Icon name="clock" size={13} />} label={`Asked to join ${p.name}`} detail="Waiting for an admin of the group to let you in" />
            ))}
          </>
        )}
        {strangers.length ? (
          <>
            <div className={s.subhead} role="presentation">
              Not friends yet
            </div>
            {strangers.map((p) => (
              <RoomPersonRow key={p.peerId} p={p} sent={offerSent(net.offers, p.peerId)} />
            ))}
          </>
        ) : null}
      </div>
    </Section>
  );
}

/** Your main channel before it exists: one click makes it, with all your friends. */
function MainRow() {
  const { client } = useBeluga();
  const say = useSay();
  return (
    <Row
      data-main-row
      icon={
        <span className={s.mainIcon}>
          <Icon name="people" size={12} />
        </span>
      }
      aria-label="Channel All Friends"
      label={<span className={s.whoName}>All Friends</span>}
      detail="Your main channel: everyone you’ve added, in one conversation"
      onClick={() => void openMain(client).catch((err) => say(errorText(err), 'error'))}
    />
  );
}

/**
 * The room's group chat (BLG-871): everyone in your room and their agents, and its call. Only
 * while someone else is in the room; alone, there's no one to chat with there.
 */
function RoomChatRow() {
  const actions = useActions();
  const { ui } = useBeluga();
  // Someone at the door: their card is in this chat (chat/Attention.tsx), so it counts here.
  const { room, people, unread, selected, host, door } = useApp(
    (st) => ({ room: st.room, people: st.peers.length, unread: st.unread.room ?? 0, selected: st.view.kind === 'room', host: st.isHost, door: st.knocks.some((k) => st.peers.some((p) => p.peerId === k.peerId)) }),
    sameDeep,
  );
  const count = unread + (door ? 1 : 0);
  const open = (): void => actions.run({ type: 'view', view: { kind: 'room' } });
  return (
    <ActionsContext
      items={() => [
        { label: 'Open', icon: 'chat', onSelect: open },
        { label: 'Clear the Group Chat…', icon: 'x', separate: true, onSelect: () => ui.openMenu({ kind: 'clear', channel: 'room', host }) },
      ]}
    >
      <Row
        data-room-chat
        selected={selected}
        icon={
          <span className={s.mainIcon}>
            <Icon name="chat" size={12} />
          </span>
        }
        aria-label={`Group chat${door ? ', someone at the door' : ''}${unread ? `, ${unread} unread` : ''}`}
        label={<span className={cx(s.whoName, count > 0 && s.unreadName)}>Group chat</span>}
        detail={door ? 'Someone is at the door: let them in from the chat' : `${room ? `${room} · ` : ''}${people} people in your room · everyone’s agent can join in`}
        onClick={open}
        trailing={count ? <Badge count={count} urgent /> : null}
      />
    </ActionsContext>
  );
}

/** Channels you're in (the room's group chat while there's one, then your main one; ones you left, dimmed, with their history). */
export function GroupsSection() {
  const net = useNetwork();
  const roomChat = useApp(groupChatOpen);
  if (!net.enabled) {
    return roomChat ? (
      <Section id="net-groups" title="Channels">
        <div className={s.sidebarList}>
          <RoomChatRow />
        </div>
      </Section>
    ) : null;
  }
  const groups = sortGroups(net.groups).filter((g) => g.id !== net.main);
  const main = net.main ? net.groups.find((g) => g.id === net.main) : undefined;
  return (
    <Section id="net-groups" title="Channels" action={<IconButton icon="plus" label="New channel" onClick={() => openNet({ kind: 'new_group' })} />}>
      <div className={s.sidebarList}>
        {roomChat ? <RoomChatRow /> : null}
        {main ? <GroupRow g={main} /> : <MainRow />}
        {groups.map((g) => (
          <GroupRow key={g.id} g={g} />
        ))}
        {groups.length ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="New channel…" detail="A conversation with several friends, kept on everyone’s computer" onClick={() => openNet({ kind: 'new_group' })} />}
      </div>
    </Section>
  );
}
