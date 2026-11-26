import { OFFER_DETAIL, andNames, knockOf, knockWords, myKnockOn, myKnockWords, offerWords, teamShareChoices, teammateOn, teammatesOf, waitingDetail, waitingOn, waitingWords, workingOn, workingWords } from '@beluga/core/team/model.js';
import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useState } from 'react';
import { useActions } from '../lib/actions.js';
import { ago } from '../tasks/tasks-model.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Avatar, Button, IconButton, Tip } from '../components/ui.js';
import { AvatarStack } from '../network/Avatars.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { offerSent, shownState } from '../network/net-model.js';
import { answerOffer } from '../network/use-net.js';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import s from './team.module.css';

/**
 * Team boards on the Mac (core/team): the offer to team up with a friend on the same GitHub
 * repository (one main action, Team Up; Not Now behind •••), the teammates' avatars on a project,
 * and who's working on a task.
 */

/** Say what went wrong in a toast. */
function useSay(): (p: Promise<unknown>) => void {
  const { client } = useBeluga();
  return (p) => void p.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
}

/** Offers to team up on this project waiting on you (or on them, quietly). */
export function TeamOffers({ projectId }: { projectId: string }) {
  const offers = useApp((st) => st.team.offers.filter((o) => o.projectId === projectId), sameDeep);
  const api = useApi();
  const say = useSay();
  if (!offers.length) return null;
  return (
    <div className={s.list}>
      {offers.map((o) => {
        const more: ActionItem[] = [{ label: o.state === 'asked' ? 'Take Back' : 'Not Now', onSelect: () => say(api.team.answer(o.peerId, o.projectId, false)) }];
        return (
          <section key={`${o.peerId}:${o.projectId}`} className={s.offer} aria-label={offerWords(o)}>
            <Avatar name={o.name} id={o.peerId} size={26} />
            <div className={s.offerText}>
              <span className={s.offerTitle}>{offerWords(o)}</span>
              <span className={s.offerDetail}>{o.state === 'asked' ? 'The team forms when they say yes too.' : OFFER_DETAIL}</span>
            </div>
            {o.state === 'asked' ? null : (
              <Button size="small" variant="primary" icon="people" onClick={() => say(api.team.answer(o.peerId, o.projectId, true))}>
                Team Up
              </Button>
            )}
            <ActionsDropdown items={more}>
              <IconButton size="small" icon="more" label="More" />
            </ActionsDropdown>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A project has teammates: one small people icon on its row, not a dot per person (they'd pile up).
 * A green dot on it when at least one of them is online; names in its tip.
 */
export function TeamBadge({ projectId }: { projectId: string }) {
  const team = useApp((st) => st.team.teams[projectId], sameDeep);
  const online = useApp((st) => (team ? team.mates.filter((m) => st.network.friends.some((f) => f.peerId === m.peerId && shownState(f) === 'online')).map((m) => m.name) : []), sameDeep);
  const [open, setOpen] = useState(false);
  if (!team?.mates.length) return null;
  const names = andNames(team.mates.map((m) => m.name));
  const tip = `Team on ${team.repo}: you and ${names}${online.length ? ` · ${online.join(', ')} online` : ''}`;
  // Click: who's on the team, and Add Friend for anyone on it who isn't a friend yet (BLG-510).
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip label={tip}>
        <Popover.Trigger asChild>
          <button type="button" className={s.badge} aria-label={tip} onClick={(e) => e.stopPropagation()}>
            <Icon name="people" size={12} />
            {online.length ? <span className={s.badgeOnline} /> : null}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className={s.teamCard} side="right" align="start" sideOffset={8} collisionPadding={12} aria-label={`Team on ${team.repo}`} onClick={(e) => e.stopPropagation()}>
          <TeamCard projectId={projectId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Everyone on a project's team: friends, and the rest with Add Friend (they're asked; added only if they accept). */
export function TeamCard({ projectId }: { projectId: string }) {
  const team = useApp((st) => st.team.teams[projectId], sameDeep);
  const friends = useApp((st) => st.network.friends.map((f) => f.peerId), sameDeep);
  const offers = useApp((st) => st.network.offers, sameDeep);
  const api = useApi();
  const { client } = useBeluga();
  const say = useSay();
  if (!team) return null;
  return (
    <div className={s.teamList}>
      <div className={s.teamHead}>
        <Icon name="people" size={13} />
        Team on {team.repo}
      </div>
      {team.mates.map((m) => {
        const friend = friends.includes(m.peerId);
        const asked = offerSent(offers, m.peerId);
        const theyAsked = (offers ?? []).some((o) => o.dir === 'in' && o.peerId === m.peerId);
        return (
          <div key={m.peerId} className={s.teamRow} aria-label={m.name}>
            <Avatar name={m.name} id={m.peerId} size={22} />
            <span className={s.teamWho}>
              <span className={s.teamName}>{m.name}</span>
              <span className={s.teamSub}>{friend ? 'Friend' : 'On the team, not a friend yet'}</span>
            </span>
            {friend ? null : theyAsked ? (
              <Button size="small" variant="primary" onClick={() => void answerOffer(client, m.peerId, m.name, true)}>
                Accept
              </Button>
            ) : (
              <Button size="small" disabled={asked} onClick={() => say(api.team.befriend(projectId, m.peerId).then(() => toast(client, `Asked ${m.name} to be friends`, 'success')))}>
                {asked ? 'Asked' : 'Add Friend'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A project's team in its menu (BLG-510): Invite to Team ▸ (friends with the repository who aren't
 * on it; anyone on the team can), and Leave Team (off it for everyone; your tasks stay yours).
 */
export function useTeamMenuItems(projectId: string): readonly ActionItem[] {
  const mates = useApp((st) => teammatesOf(st.team, projectId), sameDeep);
  const invitable = useApp((st) => st.team.teams[projectId]?.invitable ?? [], sameDeep);
  const api = useApi();
  const say = useSay();
  if (!mates.length) return [];
  const invite: ActionItem[] = invitable.length
    ? [
        {
          label: 'Invite to Team',
          icon: 'plus',
          separate: true,
          submenu: invitable.map((f) => ({ label: f.name, hint: f.state === 'asked' ? 'Invited' : 'Has this repository', disabled: f.state === 'asked', onSelect: () => say(api.team.answer(f.peerId, projectId, true)) })),
          onSelect: () => undefined,
        },
      ]
    : [];
  const leave: ActionItem = { label: mates.length === 1 ? `Leave Team with ${mates[0]!.name}` : 'Leave Team', icon: 'people', separate: !invite.length, hint: mates.length > 1 ? `Off it for ${andNames(mates.map((m) => m.name))}; your tasks stay` : undefined, onSelect: () => say(api.team.leave(projectId)) };
  return [...invite, leave];
}

/** "Ata is working on this" with their avatars, for a task, and Knock to Join on their worktree. */
export function WorkingOn({ issueId }: { issueId: string }) {
  const people = useApp((st) => workingOn(st.team, issueId), sameDeep);
  const knocked = useApp((st) => Boolean(myKnockOn(st.team, issueId)));
  const words = workingWords(people.map((p) => p.name));
  if (!words && !knocked) return null;
  return (
    <span className={s.working}>
      {words ? (
        <>
          <AvatarStack people={people} size={14} max={3} />
          {words}
        </>
      ) : null}
      <KnockToJoin issueId={issueId} />
    </span>
  );
}

/**
 * Knock to Join (BLG-416): a teammate's worktree is doing this task, so ask them to let you in.
 * Then it says how it stands: waiting (Take Back), let in (Open), or not now (Knock Again).
 */
export function KnockToJoin({ issueId }: { issueId: string }) {
  const people = useApp((st) => workingOn(st.team, issueId).filter((p) => p.peerId !== st.selfId), sameDeep);
  const mine = useApp((st) => myKnockOn(st.team, issueId), sameDeep);
  const there = useApp((st) => Boolean(mine?.workspaceId && st.shared.some((w) => w.id === mine.workspaceId && w.owner === mine.peerId)));
  const api = useApi();
  const say = useSay();
  const actions = useActions();
  if (!people.length && !mine) return null;
  const knock = (peerId: string): void => say(api.team.knock(issueId, peerId));
  const again = mine && (mine.state === 'declined' || mine.state === 'gone');
  const button = (label: string) =>
    people.length > 1 ? (
      <ActionsDropdown items={people.map((p) => ({ label: `${p.name}’s Worktree`, onSelect: () => knock(p.peerId) }))}>
        <Button size="small" icon="hand" className={s.knockButton}>
          {label}
        </Button>
      </ActionsDropdown>
    ) : people[0] ? (
      <Button size="small" icon="hand" className={s.knockButton} onClick={() => knock(people[0]!.peerId)}>
        {label}
      </Button>
    ) : null;
  if (!mine) return <span className={s.knock}>{button('Knock to Join')}</span>;
  return (
    <span className={s.knock}>
      <span className={mine.state === 'waiting' ? s.knockWaiting : s.knockWords}>{myKnockWords(mine)}</span>
      {mine.state === 'waiting' ? (
        <Button size="small" onClick={() => say(api.team.cancelKnock(mine.id))}>
          Take Back
        </Button>
      ) : mine.state === 'in' && there ? (
        <Button size="small" icon="arrowRight" className={s.knockButton} onClick={() => actions.run({ type: 'open_shared', owner: mine.peerId, id: mine.workspaceId!, tab: 'chat' })}>
          Open
        </Button>
      ) : again ? (
        button('Knock Again')
      ) : null}
    </span>
  );
}

/**
 * A teammate knocking on this worktree, in its chat (BLG-416): Let In as Editor, or as a viewer;
 * Not Now behind •••. Once answered it's the plain line it was.
 */
export function KnockCard({ id, text, children }: { id: string; text: string; children: ReactNode }) {
  const k = useApp((st) => (id ? knockOf(st.team, id) : undefined), sameDeep);
  const api = useApi();
  const say = useSay();
  if (!k) return <>{children}</>;
  const more: ActionItem[] = [{ label: 'Not Now', onSelect: () => say(api.team.answerKnock(k.id, 'decline')) }];
  return (
    <section className={s.offer} aria-label={knockWords(k)}>
      <Avatar name={k.name} id={k.peerId} size={26} />
      <div className={s.offerText}>
        <span className={s.offerTitle}>{knockWords(k)}</span>
        <span className={s.offerDetail}>{k.note ? `“${k.note}” · ` : ''}{k.key}: {k.title}. An editor can talk to your agent here; a viewer follows along.</span>
      </div>
      <Button size="small" variant="quiet" onClick={() => say(api.team.answerKnock(k.id, 'view'))}>
        Let In as Viewer
      </Button>
      <Button size="small" variant="primary" icon="people" onClick={() => say(api.team.answerKnock(k.id, 'contribute'))}>
        Let In as Editor
      </Button>
      <ActionsDropdown items={more}>
        <IconButton size="small" icon="more" label={`More for ${text.slice(0, 40)}`} />
      </ActionsDropdown>
    </section>
  );
}

/** A teammate working on a task, as their avatars only (a row in Tasks). */
export function WorkingMark({ issueId }: { issueId: string }) {
  const people = useApp((st) => workingOn(st.team, issueId), sameDeep);
  const words = workingWords(people.map((p) => p.name));
  if (!words) return null;
  return (
    <span className={s.badge} title={words} aria-label={words} role="img">
      <AvatarStack people={people} size={14} max={2} />
    </span>
  );
}

/**
 * A teammate doesn't have this task's latest change yet (BLG-273): a small clock on the card
 * and the row, nothing at all once everyone has it. Hover says who.
 */
export function WaitingMark({ issueId }: { issueId: string }) {
  const people = useApp((st) => waitingOn(st.team, issueId), sameDeep);
  const words = waitingWords(people);
  if (!words) return null;
  const mailed = people.every((p) => p.mailed);
  return (
    <Tip label={`${words}. ${mailed ? 'It’s in their mailbox.' : 'It goes when their computer is on.'}`}>
      <span className={s.waiting} aria-label={words} role="img">
        <Icon name="clock" size={12} />
        {people.length > 1 ? <span className={s.waitingCount}>{people.length}</span> : null}
      </span>
    </Tip>
  );
}

/** On a task's page: who doesn't have the latest yet, and where it is for each of them. */
export function WaitingFor({ issueId }: { issueId: string }) {
  const people = useApp((st) => waitingOn(st.team, issueId), sameDeep);
  const words = waitingWords(people);
  if (!words) return null;
  return (
    <details className={s.waitingFor}>
      <summary>
        <Icon name="clock" size={12} />
        {words}
      </summary>
      <ul>
        {people.map((p) => (
          <li key={p.peerId}>
            <Avatar name={p.name} id={p.peerId} size={16} />
            <span className={s.waitingWho}>{waitingDetail(p)}</span>
            <span className={s.waitingSince}>changed {ago(p.since)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A teammate gave you this task: a quiet strip with Got It, until you've seen it. */
export function AssignedToYou({ issueId }: { issueId: string }) {
  const a = useApp((st) => st.team.assigned.find((x) => x.issueId === issueId), sameDeep);
  const api = useApi();
  const say = useSay();
  if (!a) return null;
  return (
    <section className={s.offer} aria-label={`${a.by} gave you this task`}>
      <Avatar name={a.by} id={a.byId} size={22} />
      <div className={s.offerText}>
        <span className={s.offerTitle}>{a.by} gave you this task</span>
        <span className={s.offerDetail}>It’s in My Tasks. Start it when you’re ready.</span>
      </div>
      <Button size="small" variant="primary" onClick={() => say(api.team.ackAssignment(a.issueId))}>
        Got It
      </Button>
    </section>
  );
}

/** On an issue's row: the teammate on its team task ("Ata is investigating #48"), with their avatar. */
export function TeammateOnIssue({ projectId, number }: { projectId: string; number: number }) {
  const on = useApp((st) => {
    const task = st.board.issues.find((i) => i.projectId === projectId && i.github?.number === number && !i.archivedAt);
    return task ? teammateOn(st.team, task, st.selfId) : undefined;
  }, sameDeep);
  if (!on) return null;
  return (
    <span className={s.working} title={on.words}>
      <Avatar name={on.name} id={on.peerId} size={14} />
      {on.words}
    </span>
  );
}

/**
 * A conversation's "Share with Team ▸" (BLG-226): one teammate at a time (or everyone), live, with
 * the worktree sharing friends already have; Stop Sharing ends it. Nothing is shared until you pick.
 */
export function shareWithTeamItems(state: Pick<AppState, 'team' | 'members'>, client: SocketClient, wsId: string, projectId: string | undefined): readonly ActionItem[] {
  const choices = teamShareChoices(state.team, state.members[wsId], projectId ?? '');
  if (!projectId || !choices.mates.length) return [];
  const api = client.api;
  const say = (p: Promise<unknown>): void => void p.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  const share = (peerId: string): void => say(api.sharing.shareWithFriend({ peerId, workspaceId: wsId, role: 'contribute' }));
  const stop = (peerId: string): void => say(api.sharing.unshareFriend({ peerId, workspaceId: wsId }));
  const everyone = choices.mates.filter((m) => !m.shared);
  const submenu: ActionItem[] = [
    ...(choices.mates.length > 1 && everyone.length ? [{ label: 'Everyone on the Team', onSelect: () => everyone.forEach((m) => share(m.peerId)) }] : []),
    ...choices.mates.map((m) => ({ label: m.name, checked: m.shared, onSelect: () => (m.shared ? stop(m.peerId) : share(m.peerId)) })),
  ];
  return [
    { label: 'Share with Team', icon: 'people', separate: true, submenu, onSelect: () => undefined },
    ...(choices.sharedWith.length ? [{ label: 'Stop Sharing', icon: 'x' as const, onSelect: () => choices.sharedWith.forEach(stop) }] : []),
  ];
}

/** A team project's conversation nobody else can see: a quiet lock that says so. */
export function PrivateMark({ wsId, projectId }: { wsId: string; projectId: string | undefined }) {
  const choices = useApp((st) => teamShareChoices(st.team, st.members[wsId], projectId ?? ''), sameDeep);
  if (!projectId || !choices.mates.length || choices.sharedWith.length) return null;
  return (
    <Tip label="Only you can see this conversation. Your teammates see the board, not your chats. Use More › Share with Team to work on it together.">
      <span className={s.badge} aria-label="Only you can see this conversation" role="img">
        <Icon name="lock" size={12} />
      </span>
    </Tip>
  );
}
