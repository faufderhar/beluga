import * as Popover from '@radix-ui/react-popover';
import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Tip, cx } from '../components/ui.js';
import { AvatarStack } from '../network/Avatars.js';
import { answerOffer, openFriendCard } from '../network/use-net.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { type BoardPerson, boardPeople, boardPeopleLabel, boardPersonLine } from './board-people.js';
import ts from '../team/team.module.css';
import s from './board-people.module.css';

/** How many faces the header shows before "+N". */
const SHOWN = 4;

/**
 * Who's on this board, beside Active and Backlog (BLG-906): a few faces, then +N. Click them for
 * everyone; click someone for their card, and Add Friend for a teammate who isn't one yet (asked
 * through the team you share; they're added only if they accept). Only when you work with others.
 */
export function BoardPeople({ repos }: { repos: readonly string[] }) {
  const teams = useApp((st) => Object.fromEntries(repos.map((r) => [r, st.team.teams[r]])), sameDeep);
  const friends = useApp((st) => st.network.friends.map((f) => ({ peerId: f.peerId })), sameDeep);
  const offers = useApp((st) => st.network.offers, sameDeep);
  const self = useApp((st) => ({ peerId: st.selfId, name: st.self?.name ?? st.network.self?.name ?? 'You' }), sameDeep);
  const people = useMemo(() => boardPeople({ teams, friends, offers, self }, repos), [teams, friends, offers, self, repos]);
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<string>();
  if (people.length < 2) return null;
  const label = boardPeopleLabel(people);
  const picked = card ? people.find((p) => p.peerId === card) : undefined;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setCard(undefined);
      }}
    >
      <Tip label={label}>
        <Popover.Trigger asChild>
          <button type="button" className={s.trigger} aria-label={label}>
            <AvatarStack people={people} size={20} max={SHOWN} />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className={ts.teamCard} align="start" sideOffset={6} collisionPadding={12} aria-label="People on this board">
          {picked ? <PersonCard person={picked} onBack={() => setCard(undefined)} onClose={() => setOpen(false)} /> : <PeopleList people={people} onPick={setCard} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PeopleList({ people, onPick }: { people: readonly BoardPerson[]; onPick: (peerId: string) => void }) {
  return (
    <div className={ts.teamList}>
      <div className={ts.teamHead}>
        <Icon name="people" size={13} />
        On this board
      </div>
      <ul className={s.list}>
        {people.map((p) => (
          <li key={p.peerId} className={ts.teamRow}>
            {p.you ? (
              <Who person={p} />
            ) : (
              <button type="button" className={s.rowButton} aria-label={`${p.name}: ${boardPersonLine(p)}`} onClick={() => onPick(p.peerId)}>
                <Who person={p} />
                <Icon name="chevronRight" size={11} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Who({ person }: { person: BoardPerson }) {
  return (
    <>
      <Avatar name={person.name} id={person.peerId} size={22} />
      <span className={ts.teamWho}>
        <span className={ts.teamName}>{person.you ? `${person.name} (you)` : person.name}</span>
        <span className={ts.teamSub}>{boardPersonLine(person)}</span>
      </span>
    </>
  );
}

/** Someone's card: who they are and the one thing to do (Add Friend, Accept, or their profile). */
function PersonCard({ person, onBack, onClose }: { person: BoardPerson; onBack: () => void; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const [busy, setBusy] = useState(false);
  const addFriend = (): void => {
    if (!person.projectId) return;
    setBusy(true);
    api.team.befriend(person.projectId, person.peerId).then(
      () => {
        setBusy(false);
        toast(client, `Asked ${person.name} to be friends. You’re friends once they accept`, 'success');
      },
      (err: unknown) => {
        setBusy(false);
        toast(client, err instanceof Error ? err.message : String(err), 'error');
      },
    );
  };
  const action = person.friend ? (
    <Button
      variant="primary"
      icon="person"
      onClick={() => {
        onClose();
        openFriendCard(client, person.peerId);
      }}
    >
      Open Profile
    </Button>
  ) : person.theyAsked ? (
    <Button variant="primary" onClick={() => void answerOffer(client, person.peerId, person.name, true)}>
      Accept
    </Button>
  ) : (
    <Button variant="primary" icon="plus" disabled={busy || person.asked || !person.projectId} onClick={addFriend}>
      {person.asked ? 'Asked' : 'Add Friend'}
    </Button>
  );
  return (
    <section className={s.card} aria-label={`${person.name}’s card`}>
      <button type="button" className={s.back} onClick={onBack}>
        <Icon name="back" size={11} />
        On this board
      </button>
      <Avatar name={person.name} id={person.peerId} size={48} />
      <strong className={s.name}>{person.name}</strong>
      <span className={cx(s.line, person.theyAsked && s.lineAsk)}>{boardPersonLine(person)}</span>
      {person.friend ? null : <span className={s.hint}>{person.theyAsked ? 'Accept to talk, share and ask each other’s agents.' : 'They get a friend request and can accept or decline it.'}</span>}
      {action}
    </section>
  );
}
