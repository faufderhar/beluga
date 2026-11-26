import type { Issue } from '../board/model.js';
import type { PlanBody, PlanStatus } from '../plans/model.js';
import { COMPUTER_WORD } from '../../shared/assistant.js';

/**
 * Team boards in the shared state (core/team, docs/tasks-and-plans.md "Sharing with friends —
 * phase 3"): friends who have the same GitHub repository as a project on their own Macs, and said
 * yes to working on it as a team, keep one board between them. What screens see: the offers
 * waiting for an answer, each project's teammates, who's working on which task, tasks a teammate
 * gave you, plan drafts teammates shared with you, and the reviews of the plans you shared.
 * Never a repository's name for a friend who doesn't have it, never keys. Browser-safe: the Mac app
 * and the phone run it.
 */

/**
 * An offer to team up on a project. `found`: Beluga saw a friend has the same repository (nobody
 * said yes yet). `asked`: you said yes and wait for them. `invited`: they said yes; it's yours.
 */
export type TeamOfferState = 'found' | 'asked' | 'invited';

export interface TeamOffer {
  readonly peerId: string;
  readonly name: string;
  /** Your project with that repository. */
  readonly projectId: string;
  /** "acme/api", from your own project's remote. */
  readonly repo: string;
  readonly state: TeamOfferState;
  readonly at: number;
  /** Who's on their team already (their invite said so, BLG-510), or on yours (you'd bring them in). */
  readonly team?: readonly string[];
}

export interface Teammate {
  readonly peerId: string;
  readonly name: string;
  readonly since: number;
  /**
   * On the team through others (BLG-510): you two didn't team up yourselves, and may not be friends.
   * Tasks and their changes reach them all the same; a chat or a worktree can only be shared with a friend.
   */
  readonly indirect?: true;
}

/** A project of yours worked on as a team. */
export interface ProjectTeam {
  readonly projectId: string;
  readonly repo: string;
  /** Everyone on the team but you: those you teamed up with, and those on it through them (BLG-510). */
  readonly mates: readonly Teammate[];
  /** Friends of yours with the repository who aren't on the team: anyone on it can invite them (BLG-510). */
  readonly invitable?: ReadonlyArray<{ readonly peerId: string; readonly name: string; readonly state?: TeamOfferState }>;
}

/** A teammate gave you a task (or your Claude): it waits in your inbox until you've seen it. */
export interface TeamAssignment {
  readonly issueId: string;
  readonly key: string;
  readonly title: string;
  readonly projectId: string;
  readonly byId: string;
  readonly by: string;
  /** Given to your Claude (their Mac sent it as a request), rather than to you. */
  readonly claude?: boolean;
  readonly at: number;
}

export type PlanReviewKind = 'comment' | 'approve' | 'suggest';

/** A teammate's word on a shared plan draft: a comment, an approval, or changes they suggest. */
export interface PlanReview {
  readonly id: string;
  readonly by: string;
  readonly name: string;
  readonly kind: PlanReviewKind;
  readonly text?: string;
  /** Suggested changes, as the plan's own edit ops (plans.edit): the owner applies them in one click. */
  readonly ops?: readonly unknown[];
  /** The draft's revision it was about. */
  readonly rev: number;
  readonly at: number;
  /** The owner applied it (a suggestion) or set it aside. */
  readonly settled?: 'applied' | 'dismissed';
}

/** A plan draft a teammate shared with you: read-only here, with everyone's reviews. */
export interface SharedPlan {
  readonly owner: string;
  readonly ownerName: string;
  readonly id: string;
  /** Your project it's about. */
  readonly projectId: string;
  readonly title: string;
  readonly body: PlanBody;
  readonly rev: number;
  readonly status: PlanStatus;
  readonly reviews: readonly PlanReview[];
  readonly updatedAt: number;
}

/** One of your plans shared with your teammates, and what they said. */
export interface MyPlanShare {
  readonly planId: string;
  readonly peers: readonly string[];
  readonly reviews: readonly PlanReview[];
}

/** A teammate whose Mac hasn't taken a task's latest change yet. */
export interface TeamWaiting {
  readonly peerId: string;
  readonly name: string;
  /** When the oldest change they don't have was made. */
  readonly since: number;
  /** It's in their mailbox (they'll get it when their Mac is next on, even if yours isn't). */
  readonly mailed: boolean;
}

/**
 * A teammate knocking on one of your worktrees (BLG-416): they see you're on a task and ask to
 * join the worktree doing it. You let them in as a viewer or an editor, or say not now.
 */
export interface TeamKnock {
  readonly id: string;
  readonly peerId: string;
  readonly name: string;
  readonly issueId: string;
  readonly key: string;
  readonly title: string;
  readonly projectId: string;
  /** Your worktree doing the task. */
  readonly workspaceId: string;
  readonly worktree: string;
  /** A few words they sent with it. */
  readonly note?: string;
  readonly at: number;
}

/** How a knock of yours stands: waiting for them, let in (as `role`, into `workspaceId`), not now, or the worktree went. */
export type MyKnockState = 'waiting' | 'in' | 'declined' | 'gone';

/** A knock of yours on a teammate's worktree. */
export interface MyKnock {
  readonly id: string;
  readonly issueId: string;
  readonly peerId: string;
  readonly name: string;
  readonly state: MyKnockState;
  readonly role?: 'view' | 'contribute';
  readonly workspaceId?: string;
  readonly at: number;
  /** When they answered. */
  readonly answeredAt?: number;
}

export interface TeamState {
  /** Team boards run (the daemon, while the network is on). */
  readonly enabled: boolean;
  readonly offers: readonly TeamOffer[];
  /** Project id → its team. */
  readonly teams: Readonly<Record<string, ProjectTeam>>;
  /** Task id → teammates working on it now ("Ata is working on this"); `running`: their Claude is at work there. */
  readonly working: Readonly<Record<string, ReadonlyArray<{ readonly peerId: string; readonly name: string; readonly running?: true }>>>;
  /** Task id → teammates who don't have its latest change yet (BLG-273); a task everyone has isn't here. */
  readonly waiting: Readonly<Record<string, readonly TeamWaiting[]>>;
  readonly assigned: readonly TeamAssignment[];
  readonly plans: readonly SharedPlan[];
  /** Plan id → who it's shared with and their reviews. */
  readonly planShares: Readonly<Record<string, MyPlanShare>>;
  /** Teammates knocking on your worktrees, oldest first (BLG-416). */
  readonly knocks?: readonly TeamKnock[];
  /** Your knocks on teammates' worktrees, newest first. */
  readonly myKnocks?: readonly MyKnock[];
}

export interface TeamSlice {
  readonly team: TeamState;
}

export const NO_TEAM: TeamState = { enabled: false, offers: [], teams: {}, working: {}, waiting: {}, assigned: [], plans: [], planShares: {}, knocks: [], myKnocks: [] };
export const initialTeam: TeamSlice = { team: NO_TEAM };

export type TeamAction = { type: 'team_state'; state: TeamState } | { type: 'team_off' };

export function reduceTeam(state: TeamSlice, action: TeamAction): TeamSlice {
  switch (action.type) {
    case 'team_state':
      return { team: action.state };
    case 'team_off':
      return { team: NO_TEAM };
  }
}

// ---- for screens

/** A project's teammates (none: it isn't worked on as a team). */
export const teammatesOf = (team: TeamState, projectId: string): readonly Teammate[] => team.teams[projectId]?.mates ?? [];

/**
 * Whether a project's task can be given to someone (BLG-299): you, or a teammate on that project.
 * Friends you haven't teamed up with on it can't have its tasks; no one (unassigned) always can.
 */
export const canAssign = (team: TeamState, projectId: string, self: string, peerId: string | undefined): boolean => !peerId || peerId === self || teammatesOf(team, projectId).some((m) => m.peerId === peerId);

/** Teammates working on a task now. */
export const workingOn = (team: TeamState, issueId: string): ReadonlyArray<{ readonly peerId: string; readonly name: string; readonly running?: true }> => team.working[issueId] ?? [];

/** Teammates who don't have a task's latest change yet. */
export const waitingOn = (team: TeamState, issueId: string): readonly TeamWaiting[] => team.waiting?.[issueId] ?? [];

/** "Ata doesn't have the latest yet", "Ata and Mia don't have…"; undefined when everyone does. */
export function waitingWords(people: readonly Pick<TeamWaiting, 'name'>[]): string | undefined {
  if (!people.length) return undefined;
  const names = people.map((p) => p.name);
  const who = names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${who} ${names.length === 1 ? 'doesn’t' : 'don’t'} have the latest yet`;
}

/** How one teammate's copy stands: "In Ata's mailbox: they'll get it when they're back", "Waiting for Ata to come online". */
export const waitingDetail = (w: Pick<TeamWaiting, 'name' | 'mailed'>): string => (w.mailed ? `In ${w.name}’s mailbox: their Mac gets it when it’s next on` : `Waiting for ${w.name}’s Mac to come online`);

/** "Ata is working on this", "Ata and Mia are working on this". */
export function workingWords(names: readonly string[]): string | undefined {
  if (!names.length) return undefined;
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${who} ${names.length === 1 ? 'is' : 'are'} working on this`;
}

/** "Ata also works on acme/api" / "Ata wants to team up on acme/api": what an offer says. */
export function offerWords(offer: Pick<TeamOffer, 'name' | 'repo' | 'state' | 'team'>): string {
  const others = offer.team?.filter((n) => n !== offer.name) ?? [];
  if (offer.state === 'invited') return others.length ? `${offer.name} invited you to the ${offer.repo} team, with ${andNames(others)}` : `${offer.name} wants to team up on ${offer.repo}`;
  if (offer.state === 'asked') return `Waiting for ${offer.name} to join the ${offer.repo} team`;
  return others.length ? `${offer.name} also works on ${offer.repo}: invite them to the team` : `${offer.name} also works on ${offer.repo}`;
}

/** "Ata", "Ata and Mia", "Ata, Mia and 2 others". */
export function andNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/** The plain words under an offer: what teaming up shares, and what it doesn't. */
export const OFFER_DETAIL = `Tasks, who is on which issue and the plans you choose to share stay in step. Chats and worktrees stay on your own ${COMPUTER_WORD}.`;

/** A teammate on a task: one of their worktrees does it, or it's theirs (or their Claude's). */
export interface TeammateOn {
  readonly peerId: string;
  readonly name: string;
  /** "Ata is investigating #48", "Ata's Claude is fixing #48", "Ata is working on this". */
  readonly words: string;
}

/** Who of your teammates is on a task (BLG-224): what an issue's row says, and what starting it asks about. */
export function teammateOn(team: TeamState, issue: Pick<Issue, 'id' | 'projectId' | 'assignee' | 'github'>, self: string): TeammateOn | undefined {
  const mates = teammatesOf(team, issue.projectId);
  const what = issue.github ? `${issue.github.step === 'fix' ? 'fixing' : issue.github.step === 'investigate' ? 'investigating' : 'working on'} #${issue.github.number}` : 'working on this';
  const doing = workingOn(team, issue.id).find((p) => p.peerId !== self);
  if (doing) return { peerId: doing.peerId, name: doing.name, words: `${doing.name} is ${what}` };
  const a = issue.assignee;
  if (a && a.id !== self && mates.some((m) => m.peerId === a.id)) return { peerId: a.id, name: a.name, words: `${a.name} has it${issue.github ? ` (#${issue.github.number})` : ''}` };
  return undefined;
}

/** A teammate's knock on one of your worktrees, by its id. */
export const knockOf = (team: TeamState, id: string): TeamKnock | undefined => team.knocks?.find((k) => k.id === id);

/** Knocks waiting on one of your worktrees. */
export const knocksOn = (team: TeamState, workspaceId: string): readonly TeamKnock[] => (team.knocks ?? []).filter((k) => k.workspaceId === workspaceId);

/** Your latest knock on a task (for one teammate, or anyone). */
export const myKnockOn = (team: TeamState, issueId: string, peerId?: string): MyKnock | undefined => (team.myKnocks ?? []).find((k) => k.issueId === issueId && (!peerId || k.peerId === peerId));

/** What a knock of yours says on the task: "Waiting for Ata to let you in", "Ata let you in as an editor"… */
export function myKnockWords(k: Pick<MyKnock, 'name' | 'state' | 'role'>): string {
  switch (k.state) {
    case 'waiting':
      return `Knocked. Waiting for ${k.name} to let you in`;
    case 'in':
      return `${k.name} let you in ${k.role === 'contribute' ? 'as an editor' : 'to follow along'}`;
    case 'declined':
      return `${k.name} said not now`;
    case 'gone':
      return `${k.name}’s worktree for this isn’t there any more`;
  }
}

/** What a knock on your worktree says: "Ata is knocking: they’d like to join add-rate-limiting". */
export const knockWords = (k: Pick<TeamKnock, 'name' | 'worktree'>): string => `${k.name} is knocking: they’d like to join ${k.worktree}`;

/**
 * A conversation's "Share with Team" (BLG-226): each teammate and whether this worktree is shared
 * with them now (friend-share's members). Conversations are private until you pick someone.
 */
export function teamShareChoices(team: TeamState, members: Readonly<Record<string, unknown>> | undefined, projectId: string): { readonly mates: ReadonlyArray<Teammate & { readonly shared: boolean }>; readonly sharedWith: readonly string[] } {
  // Only friends: a conversation is shared over your own link (one on the team through others can't be).
  const mates = teammatesOf(team, projectId).filter((m) => !m.indirect).map((m) => ({ ...m, shared: Boolean(members?.[m.peerId]) }));
  return { mates, sharedWith: mates.filter((m) => m.shared).map((m) => m.peerId) };
}
