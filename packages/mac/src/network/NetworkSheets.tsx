import { useState } from 'react';
import type { FriendView } from '@beluga/net/mesh/views.js';
import { Alert, Checkbox } from '../components/Alert.js';
import { Button } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { Sheet } from '../dialogs/native/parts.js';
import { AddFriendSheet, JoinGroupSheet } from './AddFriendSheet.js';
import { closeChat } from './ChatTabs.js';
import { PersonAvatar } from './Avatars.js';
import { addableFriends, groupId, presenceLine, shownState, sortFriends } from './net-model.js';
import { type NetSheet, closeNet, openNet, useNetSheet } from './net-sheets.js';
import { StatusSheet } from './StatusMenu.js';
import { errorText, openGroup, quietly, useSay, useShownConversation } from './use-net.js';
import s from './network.module.css';
import { thisComputer } from '../lib/os-words.js';

/** Friends with checkboxes (a new group, adding people). */
function FriendPicker({ friends, chosen, onChange }: { friends: readonly FriendView[]; chosen: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  if (!friends.length) return <div className={`${s.picker} ${s.pickEmpty}`}>No friends to add yet. Add a friend first, or invite people with the channel’s link.</div>;
  return (
    <div className={s.picker} role="group" aria-label="Friends">
      {friends.map((f) => (
        <label key={f.peerId} className={s.pick}>
          <input
            type="checkbox"
            checked={chosen.has(f.peerId)}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(f.peerId);
              else next.delete(f.peerId);
              onChange(next);
            }}
          />
          <PersonAvatar name={f.name} id={f.peerId} state={shownState(f)} size={26} />
          <span className={s.pickText}>
            <span>{f.name}</span>
            <span className={s.dim}>{presenceLine(f)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

const chosenLine = (n: number): string => (n ? `${n} friend${n === 1 ? '' : 's'} chosen` : 'You can add people later too');

/** New Group: a name, friends to start with, Create. */
function NewGroupSheet({ preset }: { preset: readonly string[] }) {
  const { client } = useBeluga();
  const friends = sortFriends(useApp((st) => st.network.friends));
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set(preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const g = await quietly(client, client.api.network['groups.create'](name.trim(), [...chosen]));
      closeNet();
      openGroup(client, g.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="New Channel"
      subtitle="A conversation with several friends, kept on everyone’s computer."
      icon="people"
      close={closeNet}
      onReturn={() => void create()}
      footer={
        <>
          <span className={s.chosen}>{error ? <span style={{ color: 'var(--error)' }}>{error}</span> : chosenLine(chosen.size)}</span>
          <Button onClick={closeNet}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className={s.formRow}>
        <label className={s.formLabel} htmlFor="new-group-name">
          Name
        </label>
        <input
          id="new-group-name"
          className={s.nameInput}
          value={name}
          maxLength={64}
          placeholder="Launch team"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create();
            }
          }}
        />
      </div>
      <div className={s.formRow}>
        <span className={s.formLabel}>People</span>
        <FriendPicker friends={friends} chosen={chosen} onChange={setChosen} />
      </div>
    </Sheet>
  );
}

/** Add People: friends who aren't in the group yet. */
function AddPeopleSheet({ groupId }: { groupId: string }) {
  const { client } = useBeluga();
  const group = useApp((st) => st.network.groups.find((g) => g.id === groupId));
  const friends = useApp((st) => st.network.friends);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!group) return null;
  const add = async (): Promise<void> => {
    if (!chosen.size || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const id of chosen) await quietly(client, client.api.network['groups.addMember'](group.id, id));
      closeNet();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={`Add People to ${group.name}`}
      subtitle="They can read what’s said from now on."
      icon="plus"
      close={closeNet}
      onReturn={() => void add()}
      footer={
        <>
          <span className={s.chosen}>{error ? <span style={{ color: 'var(--error)' }}>{error}</span> : chosen.size ? chosenLine(chosen.size) : ''}</span>
          <Button onClick={closeNet}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.size || busy} onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <div className={s.formRow}>
        <FriendPicker friends={addableFriends(friends, group)} chosen={chosen} onChange={setChosen} />
      </div>
    </Sheet>
  );
}

/** Leave a channel, and maybe delete what was said from this Mac in the same go. */
function LeaveGroupAlert({ groupId: id }: { groupId: string }) {
  const { client } = useBeluga();
  const g = useApp((st) => st.network.groups.find((x) => x.id === id));
  const shown = useShownConversation();
  const say = useSay();
  const [remove, setRemove] = useState(false);
  if (!g) return null;
  const api = client.api.network;
  const lastAdmin = g.admin && g.members.filter((m) => m.admin).length === 1 && g.members.length > 1;
  const leave = async (): Promise<void> => {
    if (remove) closeChat(client, groupId(g.id), shown);
    await api['groups.leave'](g.id);
    if (!remove) return;
    await api['groups.delete'](g.id);
    say(`Left ${g.name} and deleted it from ${thisComputer()}`);
  };
  return (
    <Alert
      title={`Leave ${g.name}?`}
      message={`You stop getting its messages.${remove ? '' : ` What was said stays on ${thisComputer()}, read-only.`}${lastAdmin ? ' You’re its only admin, so the person who’s been in it longest becomes admin.' : ''}`}
      tone="danger"
      icon="people"
      confirm={{
        label: remove ? 'Leave and Delete' : 'Leave',
        destructive: true,
        onClick: () => {
          closeNet();
          void leave().catch(() => undefined);
        },
      }}
      onCancel={closeNet}
    >
      <Checkbox checked={remove} onChange={setRemove} label={`Also delete its messages from ${thisComputer()}`} detail="The others keep their copies." />
    </Alert>
  );
}

/** Delete a channel you're no longer in from this Mac (the others keep theirs). */
function DeleteGroupAlert({ groupId: id }: { groupId: string }) {
  const { client } = useBeluga();
  const g = useApp((st) => st.network.groups.find((x) => x.id === id));
  const shown = useShownConversation();
  const say = useSay();
  if (!g) return null;
  return (
    <Alert
      title={`Delete ${g.name}?`}
      message={`Its messages are removed from ${thisComputer()}. The people still in ${g.name} keep their copies, and if someone adds you again it comes back.`}
      tone="danger"
      icon="people"
      confirm={{
        label: 'Delete',
        destructive: true,
        onClick: () => {
          closeNet();
          closeChat(client, groupId(g.id), shown);
          void client.api.network['groups.delete'](g.id).then(() => say(`Deleted ${g.name} from ${thisComputer()}`), () => undefined);
        },
      }}
      onCancel={closeNet}
    />
  );
}

/** Remove a friend, leave a group, remove someone from a group: an alert each. */
function Confirmations() {
  const { client } = useBeluga();
  const sheet = useNetSheet();
  const net = useApp((st) => st.network);
  const shown = useShownConversation();
  const api = client.api.network;
  const leaveView = (id: string): void => {
    if (shown === id) client.store.dispatch({ type: 'view', view: { kind: 'overview' } });
  };
  if (sheet?.kind === 'remove_friend') {
    const f = net.friends.find((x) => x.peerId === sheet.peerId);
    if (!f) return null;
    return (
      <Alert
        title={`Remove ${f.name}?`}
        message={`You won’t be connected any more, and your conversation with ${f.name} is removed from ${thisComputer()}. Channels you share stay.`}
        tone="danger"
        icon="person"
        confirm={{
          label: 'Remove',
          destructive: true,
          onClick: () => {
            closeNet();
            leaveView(`dm:${f.peerId}`);
            void api['friends.remove'](f.peerId);
          },
        }}
        onCancel={closeNet}
      />
    );
  }
  if (sheet?.kind === 'leave_group') return <LeaveGroupAlert groupId={sheet.groupId} />;
  if (sheet?.kind === 'delete_group') return <DeleteGroupAlert groupId={sheet.groupId} />;
  if (sheet?.kind === 'delete_message') return <DeleteMessageAlert conversation={sheet.conversation} id={sheet.id} mine={sheet.mine} />;
  if (sheet?.kind === 'clear_dm') {
    const f = net.friends.find((x) => x.peerId === sheet.peerId);
    if (!f) return null;
    return (
      <Alert
        title={`Clear your chat with ${f.name}?`}
        message={`Every message is removed from ${thisComputer()}. ${f.name} keeps their copy.`}
        tone="caution"
        icon="chat"
        confirm={{
          label: 'Clear',
          destructive: true,
          onClick: () => {
            closeNet();
            void api.clear(`dm:${f.peerId}`).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn’t clear the chat: ${errorText(err)}`, level: 'error' }));
          },
        }}
        onCancel={closeNet}
      />
    );
  }
  if (sheet?.kind === 'remove_member') {
    const g = net.groups.find((x) => x.id === sheet.groupId);
    const m = g?.members.find((x) => x.peerId === sheet.peerId);
    if (!g || !m) return null;
    return (
      <Alert
        title={`Remove ${m.name} from ${g.name}?`}
        message={`${m.name} stops getting new messages. What was said before stays on their computer.`}
        tone="danger"
        confirm={{
          label: 'Remove',
          destructive: true,
          onClick: () => {
            closeNet();
            void api['groups.removeMember'](g.id, m.peerId);
          },
        }}
        onCancel={() => openNet({ kind: 'group_info', groupId: g.id })}
      />
    );
  }
  return null;
}

/** Delete a message: from this Mac, and (one of yours, ticked) from your friend's too. */
function DeleteMessageAlert({ conversation, id, mine }: { conversation: string; id: string; mine: boolean }) {
  const { client } = useBeluga();
  const friend = useApp((st) => st.network.friends.find((f) => `dm:${f.peerId}` === conversation));
  const [everyone, setEveryone] = useState(mine);
  const name = friend?.name ?? 'your friend';
  return (
    <Alert
      title="Delete this message?"
      message={everyone ? `It’s removed from ${thisComputer()} and from ${name}’s.` : `It’s removed from ${thisComputer()}. ${name} still has it.`}
      tone="caution"
      icon="trash"
      confirm={{
        label: 'Delete',
        destructive: true,
        onClick: () => {
          closeNet();
          void client.api.network['messages.delete'](conversation, id, everyone ? { everyone: true } : {}).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn’t delete it: ${errorText(err)}`, level: 'error' }));
        },
      }}
      onCancel={closeNet}
    >
      {mine ? <Checkbox checked={everyone} onChange={setEveryone} label={`Delete for ${name} too`} detail="If they’re offline, it goes when they’re back" /> : null}
    </Alert>
  );
}

/** Talking with friends is off: say so and turn it on right here; the sheet that was asked for opens once it's on. */
function TurnOnSheet({ asked }: { asked: string }) {
  const { client, ui } = useBeluga();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turnOn = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.network.setEnabled(true));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Talking with friends is off"
      subtitle={`Turn it on to ${asked}.`}
      icon="people"
      close={closeNet}
      onReturn={() => void turnOn()}
      footer={
        <>
          <span className={s.chosen}>
            {error ? (
              <span style={{ color: 'var(--error)' }}>{error}</span>
            ) : (
              <button
                type="button"
                className={s.settingsLink}
                onClick={() => {
                  closeNet();
                  ui.patch({ settings: 'people' });
                }}
              >
                Open Settings › People & access
              </button>
            )}
          </span>
          <Button onClick={closeNet}>Not Now</Button>
          <Button variant="primary" autoFocus disabled={busy} onClick={() => void turnOn()}>
            {busy ? 'Turning On…' : 'Turn On'}
          </Button>
        </>
      }
    >
      <p className={s.halfText} style={{ margin: '2px 0 4px' }}>
        Messages, channels and files go straight from computer to computer, end-to-end encrypted. No server, no account. You can turn it off again in Settings.
      </p>
    </Sheet>
  );
}

/** What a sheet needs the network for, said for the Turn On sheet. */
const NEEDS: Partial<Record<NetSheet['kind'], string>> = {
  add_friend: 'add a friend',
  join_group: 'join this channel',
  new_group: 'start a channel',
  add_people: 'add people',
  status: 'set your status',
};

/** Whichever friends-and-groups sheet is open (the group info is drawn by its header). */
export function NetworkSheets() {
  const sheet = useNetSheet();
  const enabled = useApp((st) => st.network.enabled);
  if (!sheet) return null;
  const asked = NEEDS[sheet.kind];
  if (!enabled && asked) return <TurnOnSheet asked={asked} />;
  switch (sheet.kind) {
    case 'add_friend':
      return <AddFriendSheet {...(sheet.accept ? { accept: sheet.accept } : {})} />;
    case 'join_group':
      return <JoinGroupSheet accept={sheet.accept} />;
    case 'new_group':
      return <NewGroupSheet preset={sheet.with ?? []} />;
    case 'add_people':
      return <AddPeopleSheet groupId={sheet.groupId} />;
    case 'status':
      return <StatusSheet />;
    case 'group_info':
      return null;
    default:
      return <Confirmations />;
  }
}
