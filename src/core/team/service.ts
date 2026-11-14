import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { type BelugaInfo, type Feature, TEAM_FEATURES, cannotTake } from '../../net/mesh/features.js';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { GitHubRepo } from '../../workspaces/github.js';
import { Courier } from '../friend-share/courier.js';
import type { NoticeEvent } from '../notify.js';
import type { Action, Store } from '../store.js';
import { fingerprint, pairKey, repoKey, repoLabel } from './fingerprint.js';
import type { ProjectTeam, TeamOffer, TeamState } from './model.js';
import { type TeamMsg, parseTeamFrame } from './protocol.js';
import { type Member, TeamRosters } from './roster.js';

/**
 * Team boards (docs/tasks-and-plans.md, "Sharing with friends — phase 3"). Friends who each have
 * the same GitHub repository as a project on their own Mac can work on it as a team without
 * sharing the project: once both said yes, the two projects keep one board between them (tasks,
 * briefs, status, comments, who's on which issue), and plan drafts can be shared for review.
 * Chats and worktrees never travel (a conversation can be shared on purpose: friend-share).
 *
 * This part finds teammates and keeps who's in a team (BLG-221):
 * - On every link to a friend, each side sends fingerprints of its GitHub projects keyed for that
 *   pair (fingerprint.ts). A match is an offer on both Macs ("Ata also works on acme/api").
 * - Saying yes sends an invite; the team forms only when both said yes (an `accept`, or two
 *   invites crossing, which settle on the smaller link id). Either can leave; Not Now hides the
 *   offer until they ask.
 * - Teaming up is done in pairs, but a team is the group those pairs join (BLG-510): a friend of
 *   Ata's who teams up with Ata is on your team too. Every Mac keeps the group's roster
 *   (roster.ts, passed on over the links like the board), so anyone on the team sees everyone,
 *   any of them can invite a friend with the repository, and Leave Team leaves it for everyone.
 *   Changes reach everyone (board-sync.ts passes on what it hasn't seen).
 *
 * Files: `teams.json` (links and offers), `team-roster.json` (who's on each team),
 * `team-outbox.json` (what waits for a teammate's Mac).
 */

/** What the service needs from the mesh node (net/mesh/mesh.ts). */
export interface TeamMesh {
  readonly peerId: string;
  isFriend(peerId: string): boolean;
  isLinked(peerId: string): boolean;
  nameFor(peerId: string): string;
  belugaOf(peerId: string): BelugaInfo | undefined;
  sendTeam(peerId: string, payload: unknown): boolean;
  /** Mail what still waits before this Mac leaves the network. */
  onLeaving?(fn: () => Promise<unknown>): () => void;
  /** Leave a frame in their mailbox (BLG-272; none: no mailbox). */
  mail?(peerId: string, t: 'team', payload: unknown): Promise<boolean>;
  /** How long a frame waits for their link before it's mailed (undefined: no mailbox). */
  readonly mailAfterMs?: number | undefined;
  offer(features: readonly Feature[], on: boolean): void;
  /** A one-time friend invitation only `for` can use (a friend request to a teammate, BLG-510). */
  createInvite?(opts: { ttlMs?: number; for?: string }): Promise<{ readonly id: string; readonly link: string; readonly expiresAt: number }>;
  on(event: 'team', fn: (from: string, payload: unknown) => void): unknown;
  on(event: 'link', fn: (peerId: string) => void): unknown;
  off(event: 'team', fn: (from: string, payload: unknown) => void): unknown;
  off(event: 'link', fn: (peerId: string) => void): unknown;
}

export interface TeamDeps {
  readonly store: Store;
  readonly mesh: TeamMesh;
  /** Where its files live (normally ~/.beluga); null: memory only (tests). */
  readonly dir: string | null;
  /** A project's GitHub repository, from its origin remote. */
  readonly repoOf: (projectId: string) => Promise<GitHubRepo | undefined>;
  readonly notify?: (e: NoticeEvent) => void;
  readonly toast?: (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;
  /** Someone on a team of yours asked to be friends (BLG-510): shown like a friend request from a room. */
  readonly onFriendAsk?: (ask: { readonly from: string; readonly name: string; readonly link: string; readonly expiresAt: number; readonly via: string }) => void;
  readonly now?: () => number;
}

/** How long a friend request to a teammate lasts (as one from a room). */
const BEFRIEND_TTL_MS = 24 * 60 * 60_000;

/** One pair of teammates on one project: the id both Macs use for it. */
export interface TeamLink {
  readonly id: string;
  readonly peerId: string;
  readonly projectId: string;
  /** Their project's name on their Mac (their Claude's requests name it). */
  readonly theirProject: string;
  readonly since: number;
}

interface OfferRec {
  readonly peerId: string;
  readonly projectId: string;
  readonly state: TeamOffer['state'];
  readonly at: number;
  /** Asked (yours) or invited (theirs): the link id it would become. */
  readonly link?: string;
  readonly theirProject?: string;
  /** Not now: hidden until they ask. */
  readonly dismissed?: boolean;
  /** Who their invite said is on the team already. */
  readonly team?: readonly string[];
  /** Two friends already on one team, linked by themselves (never shown as an offer). */
  readonly auto?: boolean;
}

/** What other parts of team boards add to the state, and hear about links (board-sync.ts, plan-share.ts). */
export interface TeamPart {
  /** A link formed (or was there at start): catch up with that teammate. */
  joined?(link: TeamLink, fresh: boolean): void;
  /** A link went (someone left). */
  left?(link: TeamLink): void;
  /** A teammate's Mac came online. */
  linkUp?(peerId: string): void;
  /** A message this part handles; true when it took it. */
  receive?(from: string, m: TeamMsg): boolean;
  /** Its share of the state screens see. */
  view?(): Partial<TeamState>;
  onAction?(action: Action): void;
  stop?(): void;
}

const REPOS_GAP_MS = 5_000;
/** Left links remembered, so a late invite or accept for one can't make that team again. */
const MAX_LEFT_LINKS = 500;
const keyOf = (peerId: string, projectId: string): string => `${peerId}|${projectId}`;
const newLink = (): string => `tl_${randomBytes(9).toString('base64url')}`;

export class TeamBoards {
  readonly courier: Courier<TeamMsg>;
  private links: Record<string, TeamLink> = {};
  /** Links you or they left (newest last): an invite or accept for one, come late, is turned down. */
  private readonly left = new Set<string>();
  private offers: Record<string, OfferRec> = {};
  /** Project id → its repository (key and label), as its remote says. */
  private repos = new Map<string, { readonly key: string; readonly label: string }>();
  /** What each friend's Mac sent: fingerprints of its repositories (for the two of you). */
  private readonly theirs = new Map<string, Set<string>>();
  private readonly reposSent = new Map<string, number>();
  private readonly parts: TeamPart[] = [];
  private readonly offs: Array<() => void> = [];
  private reposTimer: NodeJS.Timeout | undefined;
  /** Friend requests already passed on (each goes through a Mac once). */
  private readonly befriended = new Set<string>();
  private stopped = false;
  readonly now: () => number;
  /** Who's on each team (BLG-510). */
  readonly rosters: TeamRosters;

  constructor(readonly deps: TeamDeps) {
    this.now = deps.now ?? Date.now;
    this.rosters = new TeamRosters(deps.dir);
    const { mesh } = deps;
    this.courier = new Courier<TeamMsg>(
      { isLinked: (p) => mesh.isLinked(p), send: (p, payload) => mesh.sendTeam(p, payload), parse: parseTeamFrame, mail: (p, payload) => mesh.mail?.(p, 'team', payload) ?? Promise.resolve(false), mailAfterMs: () => mesh.mailAfterMs },
      deps.dir ? path.join(deps.dir, 'team-outbox.json') : undefined,
      // Who has which change shows on the tasks (BLG-273).
      () => this.publish(),
    );
    this.courier.onMailed = () => this.publish();
  }

  get self(): string {
    return this.deps.mesh.peerId;
  }

  /** Add a part (before start). */
  use(part: TeamPart): void {
    this.parts.push(part);
  }

  /** The part of a kind (TeamAssign, TeamPlans…), for the API. */
  part<T extends TeamPart>(kind: abstract new (...args: never[]) => T): T {
    const found = this.parts.find((p): p is T => p instanceof kind);
    if (!found) throw new Error('That part of team boards isn’t running');
    return found;
  }

  async start(): Promise<void> {
    this.load();
    const { mesh, store } = this.deps;
    const onTeam = (from: string, payload: unknown): void => this.onFrame(from, payload);
    const onLink = (peerId: string): void => this.linkUp(peerId);
    mesh.on('team', onTeam);
    mesh.on('link', onLink);
    this.offs.push(() => {
      mesh.off('team', onTeam);
      mesh.off('link', onLink);
    });
    this.offs.push(store.onAction((action) => this.onAction(action)));
    mesh.offer(TEAM_FEATURES, true);
    this.offs.push(() => mesh.offer(TEAM_FEATURES, false));
    if (mesh.onLeaving) this.offs.push(mesh.onLeaving(() => this.courier.mailAll()));
    this.courier.start();
    // Teams from before rosters: they start from your own links.
    for (const link of Object.values(this.links)) this.onRoster(link, link.since);
    for (const link of Object.values(this.links)) for (const p of this.parts) p.joined?.(link, false);
    this.publish();
    await this.refreshRepos();
    for (const peer of this.linkedFriends()) this.sendRepos(peer, true);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reposTimer);
    this.courier.stop();
    for (const off of this.offs.splice(0)) off();
    for (const p of this.parts) p.stop?.();
    this.deps.store.dispatch({ type: 'team_off' });
  }

  // ------------------------------------------------------------------ reading

  /** Every link (pair of teammates on a project). */
  allLinks(): readonly TeamLink[] {
    return Object.values(this.links).filter((l) => this.deps.mesh.isFriend(l.peerId));
  }

  linkById(id: string): TeamLink | undefined {
    const link = this.links[id];
    return link && this.deps.mesh.isFriend(link.peerId) ? link : undefined;
  }

  /** The links of one project. */
  linksOf(projectId: string): readonly TeamLink[] {
    return this.allLinks().filter((l) => l.projectId === projectId);
  }

  /** Whether a project is worked on as a team. */
  teamed(projectId: string): boolean {
    return this.linksOf(projectId).length > 0;
  }

  nameOf(peerId: string): string {
    if (peerId === this.self) return this.selfName();
    // One on the team through others isn't a friend: the name the team knows them by.
    for (const projectId of Object.keys(this.links).map((id) => this.links[id]!.projectId)) {
      const m = this.rosters.of(projectId)[peerId];
      if (m && !this.deps.mesh.isFriend(peerId)) return m.name;
    }
    return this.deps.mesh.nameFor(peerId);
  }

  private selfName(): string {
    return this.deps.store.getState().network.self?.name ?? this.deps.mesh.nameFor(this.self);
  }

  /** The names of who's on a project's team (not me). */
  teamNames(projectId: string): string[] {
    return this.rosters.members(projectId, this.self).map((m) => (this.deps.mesh.isFriend(m.peerId) ? this.deps.mesh.nameFor(m.peerId) : m.name));
  }

  /** Why a teammate's Beluga can't take this (said the cannotTake way), or undefined. */
  cannot(peerId: string, feature: Feature): string | undefined {
    const { mesh } = this.deps;
    return cannotTake(mesh.nameFor(peerId), mesh.belugaOf(peerId), feature, mesh.isLinked(peerId));
  }

  /** A message for a teammate that must arrive (it waits for their Mac). */
  send(to: string, m: TeamMsg, key?: string): void {
    this.courier.send(to, m, { reliable: true, ...(key ? { key } : {}) });
  }

  // ------------------------------------------------------------------ teaming up

  /** Team Up (yes) or Not Now (no) on an offer. */
  answer(peerId: string, projectId: string, yes: boolean): void {
    const rec = this.offers[keyOf(peerId, projectId)];
    const repo = this.repos.get(projectId);
    if (!rec || !repo) throw new Error('That offer isn’t here any more');
    const print = this.printFor(peerId, projectId);
    if (!yes) {
      // Not now to their invite, or taking yours back: they hear it either way.
      if (rec.state === 'invited' || rec.state === 'asked') this.send(peerId, { k: 'decline', print });
      this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { ...rec, state: 'found', dismissed: true, link: undefined } };
      this.save();
      this.publish();
      return;
    }
    const { mesh } = this.deps;
    if (!mesh.isFriend(peerId)) throw new Error('Add them as a friend first');
    const why = this.cannot(peerId, 'team.board');
    if (why) throw new Error(why);
    const project = this.projectName(projectId);
    if (rec.state === 'invited' && rec.link) {
      this.send(peerId, { k: 'accept', print, link: rec.link, project });
      this.join(peerId, projectId, rec.link, rec.theirProject ?? '');
      return;
    }
    const link = rec.state === 'asked' && rec.link ? rec.link : newLink();
    this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { ...rec, state: 'asked', link, at: this.now(), dismissed: false } };
    this.save();
    this.publish();
    const team = this.teamNames(projectId);
    this.send(peerId, { k: 'invite', print, link, project, ...(team.length ? { team: [this.selfName(), ...team].slice(0, 50) } : {}) });
    this.deps.toast?.(`Asked ${mesh.nameFor(peerId)} to team up on ${repo.label}`, 'success');
  }

  /** Leave a project's team (one teammate, or all of them). Your tasks stay on your board. */
  leave(projectId: string, peerId?: string): void {
    const gone = this.linksOf(projectId).filter((l) => !peerId || l.peerId === peerId);
    if (!gone.length) return;
    // All of them (or the last ones you had): you're off the team for everyone, not only off these links (BLG-510).
    const all = gone.length === this.linksOf(projectId).length;
    for (const link of gone) {
      this.send(link.peerId, { k: 'leave', link: link.id, ...(all ? { all: true as const } : {}) });
      this.drop(link);
    }
    // A teammate's link still on its way (asked, not yet accepted) goes too: its late accept gets a
    // leave back instead of putting you on the team you just left.
    if (all) this.withdrawAsked(projectId);
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    this.deps.toast?.(gone.length === 1 ? `You left the team with ${this.nameOf(gone[0]!.peerId)} on ${repo}` : `You left the team on ${repo}`, 'success');
  }

  /**
   * Ask someone on a project's team who isn't your friend to be friends (BLG-510): a one-time
   * invitation only they can use, passed on by teammates until it reaches them. Nothing changes
   * unless they accept.
   */
  async befriend(projectId: string, peerId: string): Promise<{ name: string }> {
    const { mesh, store } = this.deps;
    const member = this.rosters.members(projectId, this.self).find((m) => m.peerId === peerId);
    if (!member) throw new Error('They aren’t on this project’s team');
    if (mesh.isFriend(peerId)) throw new Error(`${member.name} is already your friend`);
    if (!mesh.createInvite || !this.linksOf(projectId).length) throw new Error('Turn on talking with friends first');
    const invite = await mesh.createInvite({ ttlMs: BEFRIEND_TTL_MS, for: peerId });
    const id = randomBytes(9).toString('base64url');
    this.befriended.add(id);
    for (const link of this.linksOf(projectId)) this.send(link.peerId, { k: 'befriend', link: link.id, id, from: this.self, to: peerId, name: this.selfName().slice(0, 80), invite: invite.link, expiresAt: invite.expiresAt });
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    store.dispatch({ type: 'net_offer', offer: { peerId, name: member.name.slice(0, 64), dir: 'out', at: this.now(), expiresAt: invite.expiresAt, via: repo } });
    return { name: member.name };
  }

  /** A friend request on its way through the team: theirs to keep, or passed on to the rest (once). */
  private onBefriend(link: TeamLink, m: Extract<TeamMsg, { k: 'befriend' }>): void {
    if (this.befriended.has(m.id) || m.expiresAt <= this.now()) return;
    this.befriended.add(m.id);
    if (this.befriended.size > 500) this.befriended.delete(this.befriended.values().next().value!);
    const roster = this.rosters.of(link.projectId);
    if (m.to === this.self) {
      if (!roster[m.from]?.on) return;
      this.deps.onFriendAsk?.({ from: m.from, name: m.name, link: m.invite, expiresAt: m.expiresAt, via: this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId) });
      return;
    }
    // Only between people on this team.
    if (!roster[m.from]?.on || !roster[m.to]?.on) return;
    for (const l of this.linksOf(link.projectId)) if (l.peerId !== link.peerId) this.send(l.peerId, { ...m, link: l.id });
  }

  /** `quiet`: two friends already on the team, linked by themselves (nothing new to tell). */
  private join(peerId: string, projectId: string, id: string, theirProject: string, quiet = false): void {
    const already = Object.values(this.links).find((l) => l.peerId === peerId && l.projectId === projectId);
    if (already) return;
    const link: TeamLink = { id, peerId, projectId, theirProject: theirProject.slice(0, 200), since: this.now() };
    this.links = { ...this.links, [id]: link };
    const { [keyOf(peerId, projectId)]: _done, ...rest } = this.offers;
    this.offers = rest;
    this.save();
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    const others = this.teamNames(projectId).filter((n) => n !== this.nameOf(peerId));
    this.onRoster(link, link.since);
    if (!quiet) this.deps.notify?.({ kind: 'people', tag: 'joined', title: others.length ? `${this.nameOf(peerId)} is on the ${repo} team with you` : `You and ${this.nameOf(peerId)} are a team on ${repo}`, body: 'Your tasks for it stay in step from now on. Chats stay on your own Mac.', key: `team:${id}` });
    for (const p of this.parts) p.joined?.(link, true);
    this.publish();
  }

  // ------------------------------------------------------------------ the roster (BLG-510)

  /** A link is there: me and them on the roster (if not already), and the group's roster to everyone. */
  private onRoster(link: TeamLink, at: number): void {
    const { projectId, peerId } = link;
    const roster = this.rosters.of(projectId);
    const mine = roster[this.self];
    let changed = false;
    if (!mine?.on) changed = this.rosters.put(projectId, { peerId: this.self, name: this.selfName(), since: at, on: true, at: Math.max(at, (mine?.at ?? 0) + 1) }) || changed;
    else if (mine.name !== this.selfName()) changed = this.rosters.put(projectId, { ...mine, name: this.selfName(), at: Math.max(this.now(), mine.at + 1) }) || changed;
    const theirs = roster[peerId];
    if (!theirs?.on) changed = this.rosters.put(projectId, { peerId, name: this.deps.mesh.nameFor(peerId), since: at, on: true, at: Math.max(at, (theirs?.at ?? 0) + 1) }) || changed;
    if (changed) this.shareRoster(projectId);
    else this.sendRoster(link);
  }

  private sendRoster(link: TeamLink): void {
    const members = Object.values(this.rosters.of(link.projectId)).slice(0, 200);
    if (members.length) this.send(link.peerId, { k: 'roster', link: link.id, members }, `roster:${link.id}`);
  }

  /** The roster changed here: to every teammate linked to me (but who it came from). */
  private shareRoster(projectId: string, except?: string): void {
    for (const link of this.linksOf(projectId)) if (link.peerId !== except) this.sendRoster(link);
    this.publish();
  }

  private takeRoster(link: TeamLink, members: readonly Member[]): void {
    const mineSince = this.rosters.of(link.projectId)[this.self]?.since ?? 0;
    const won = this.rosters.merge(link.projectId, members, this.self);
    if (!won.length) return;
    // A friend of mine turned out to be on the team: link up with them (findOffers).
    if (won.some((m) => m.on && this.deps.mesh.isFriend(m.peerId))) queueMicrotask(() => this.findOffers());
    const repo = this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId);
    for (const m of won) {
      // Who joined after you, through someone else (not the friend you teamed up with: you heard).
      if (!m.on || m.since <= mineSince || this.linksOf(link.projectId).some((l) => l.peerId === m.peerId)) continue;
      this.deps.notify?.({ kind: 'people', tag: 'joined', title: `${m.name} joined the ${repo} team`, body: `${this.nameOf(link.peerId)} passed it on: their tasks for it stay in step with yours.`, key: `team-member:${link.projectId}:${m.peerId}:${m.since}` });
    }
    this.shareRoster(link.projectId, link.peerId);
  }

  /** Invites of mine to a project's team that wait for an answer: not offered again by themselves. */
  private withdrawAsked(projectId: string): void {
    const asked = Object.entries(this.offers).filter(([, o]) => o.projectId === projectId && o.state === 'asked');
    if (!asked.length) return;
    this.offers = { ...this.offers, ...Object.fromEntries(asked.map(([key, o]) => [key, { peerId: o.peerId, projectId, state: 'found' as const, at: this.now(), dismissed: true }])) };
    this.save();
    this.publish();
  }

  private drop(link: TeamLink): void {
    const { [link.id]: _gone, ...rest } = this.links;
    this.links = rest;
    this.left.add(link.id);
    if (this.left.size > MAX_LEFT_LINKS) this.left.delete(this.left.values().next().value!);
    // Not offered again by itself: it waits until either of you asks.
    this.offers = { ...this.offers, [keyOf(link.peerId, link.projectId)]: { peerId: link.peerId, projectId: link.projectId, state: 'found', at: this.now(), dismissed: true } };
    this.save();
    // Off the team altogether: who was on it isn't yours to keep.
    if (!this.linksOf(link.projectId).length) this.rosters.forget(link.projectId);
    for (const p of this.parts) p.left?.(link);
    this.publish();
  }

  // ------------------------------------------------------------------ the link

  private linkedFriends(): string[] {
    const { mesh, store } = this.deps;
    return store
      .getState()
      .network.friends.map((f) => f.peerId)
      .filter((p) => mesh.isFriend(p) && mesh.isLinked(p));
  }

  private linkUp(peerId: string): void {
    if (!this.deps.mesh.isFriend(peerId)) return;
    this.sendRepos(peerId, true);
    // Who's on the team may have changed while we were apart.
    for (const link of this.allLinks()) if (link.peerId === peerId) this.sendRoster(link);
    this.courier.flush(peerId, true);
    for (const p of this.parts) p.linkUp?.(peerId);
  }

  /** My repositories' fingerprints for this friend (only friends; nothing for Macs that aren't). */
  private sendRepos(peerId: string, force = false): void {
    const last = this.reposSent.get(peerId) ?? 0;
    if (!force && this.now() - last < REPOS_GAP_MS) return;
    const key = pairKey(this.self, peerId);
    const prints = [...new Set([...this.repos.values()].map((r) => fingerprint(key, r.key)))].slice(0, 500);
    if (this.deps.mesh.isLinked(peerId) && this.courier.send(peerId, { k: 'repos', prints }, { reliable: false })) this.reposSent.set(peerId, this.now());
  }

  private printFor(peerId: string, projectId: string): string {
    const repo = this.repos.get(projectId);
    if (!repo) throw new Error('That project isn’t on GitHub');
    return fingerprint(pairKey(this.self, peerId), repo.key);
  }

  /** My project whose repository has this fingerprint for this friend (one not teamed with them first). */
  private projectForPrint(peerId: string, print: string): string | undefined {
    const key = pairKey(this.self, peerId);
    const hits = [...this.repos.entries()].filter(([, r]) => fingerprint(key, r.key) === print).map(([id]) => id);
    return hits.find((id) => !this.linksOf(id).some((l) => l.peerId === peerId)) ?? hits[0];
  }

  private onFrame(from: string, payload: unknown): void {
    if (this.stopped || !this.deps.mesh.isFriend(from)) return;
    const got = this.courier.receive(from, payload);
    if (!got) return;
    const { m } = got;
    switch (m.k) {
      case 'repos':
        return this.onRepos(from, m.prints);
      case 'invite':
        return this.onInvite(from, m.print, m.link, m.project, m.team);
      case 'accept':
        return this.onAccept(from, m.print, m.link, m.project);
      case 'decline':
        return this.onDecline(from, m.print);
      case 'leave': {
        const link = this.links[m.link];
        if (!link || link.peerId !== from) return;
        const name = this.nameOf(from);
        this.drop(link);
        // They left the whole team: off the roster for everyone still on it.
        if (m.all && this.linksOf(link.projectId).length) {
          const was = this.rosters.of(link.projectId)[from];
          if (this.rosters.put(link.projectId, { peerId: from, name, since: was?.since ?? link.since, on: false, at: Math.max(this.now(), (was?.at ?? 0) + 1) })) this.shareRoster(link.projectId);
        }
        this.deps.toast?.(`${name} left the team on ${this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId)}`, 'info');
        return;
      }
      case 'roster': {
        const link = this.links[m.link];
        if (!link || link.peerId !== from) return;
        return this.takeRoster(link, m.members);
      }
      case 'befriend': {
        const link = this.links[m.link];
        if (!link || link.peerId !== from) return;
        return this.onBefriend(link, m);
      }
      default:
        for (const p of this.parts) if (p.receive?.(from, m)) return;
    }
  }

  private onRepos(from: string, prints: readonly string[]): void {
    this.theirs.set(from, new Set(prints));
    // They may not have mine yet (their link came up first): say it back, not too often.
    this.sendRepos(from);
    this.findOffers();
  }

  /** Friends with one of my repositories that we aren't a team on yet: an offer each (once). */
  private findOffers(): void {
    let changed = false;
    for (const [peerId, prints] of this.theirs) {
      if (!this.deps.mesh.isFriend(peerId)) continue;
      const key = pairKey(this.self, peerId);
      for (const [projectId, repo] of this.repos) {
        if (!prints.has(fingerprint(key, repo.key))) continue;
        if (this.linksOf(projectId).some((l) => l.peerId === peerId)) continue;
        // Friends who are on the team already (through others): linked without asking, so knocking
        // and sharing a chat work between them too (BLG-510).
        if (this.rosters.of(projectId)[peerId]?.on && this.linksOf(projectId).length) {
          const rec = this.offers[keyOf(peerId, projectId)];
          if (rec?.state === 'asked' && rec.auto) continue;
          const link = newLink();
          this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { peerId, projectId, state: 'asked', at: this.now(), link, auto: true } };
          this.send(peerId, { k: 'invite', print: fingerprint(key, repo.key), link, project: this.projectName(projectId) });
          changed = true;
          continue;
        }
        if (this.offers[keyOf(peerId, projectId)]) continue;
        this.offers = { ...this.offers, [keyOf(peerId, projectId)]: { peerId, projectId, state: 'found', at: this.now() } };
        changed = true;
        this.deps.notify?.({ kind: 'people', tag: 'invited', title: `${this.nameOf(peerId)} also works on ${repo.label}`, body: 'Team up to keep your tasks for it in step. Nothing is shared until you both say yes.', need: `team:${peerId}:${projectId}`, key: `team-offer:${peerId}:${projectId}` });
      }
    }
    if (changed) {
      this.save();
      this.publish();
    }
  }

  private onInvite(from: string, print: string, link: string, theirProject: string, team?: readonly string[]): void {
    const projectId = this.projectForPrint(from, print);
    // An invite for a team that's since been left, come late (a retry): it was answered back then.
    if (!projectId || this.left.has(link)) return;
    const joined = this.linksOf(projectId).find((l) => l.peerId === from);
    if (joined) {
      // Already a team (an accept of ours got lost): say it again.
      this.send(from, { k: 'accept', print, link: joined.id, project: this.projectName(projectId) });
      return;
    }
    const rec = this.offers[keyOf(from, projectId)];
    if (rec?.state === 'asked' && rec.link) {
      // Both said yes at once: the smaller id is the team's.
      const id = rec.link < link ? rec.link : link;
      this.send(from, { k: 'accept', print, link: id, project: this.projectName(projectId) });
      this.join(from, projectId, id, theirProject, rec.auto);
      return;
    }
    // A friend already on this team with me (through others): yes without asking (BLG-510).
    if (this.rosters.of(projectId)[from]?.on && this.linksOf(projectId).length) {
      this.send(from, { k: 'accept', print, link, project: this.projectName(projectId) });
      this.join(from, projectId, link, theirProject, true);
      return;
    }
    this.offers = { ...this.offers, [keyOf(from, projectId)]: { peerId: from, projectId, state: 'invited', at: this.now(), link, theirProject: theirProject.slice(0, 200), ...(team?.length ? { team: team.slice(0, 50) } : {}) } };
    this.save();
    this.publish();
    const repo = this.repos.get(projectId)?.label ?? this.projectName(projectId);
    const others = (team ?? []).filter((n) => n !== this.nameOf(from));
    this.deps.notify?.({ kind: 'needsYou', tag: 'invited', title: others.length ? `${this.nameOf(from)} invited you to the ${repo} team` : `${this.nameOf(from)} wants to team up on ${repo}`, body: 'Your tasks for it would stay in step. Chats stay on your own Mac.', need: `team:${from}:${projectId}`, key: `team-invite:${link}` });
  }

  private onAccept(from: string, print: string, link: string, theirProject: string): void {
    const projectId = this.projectForPrint(from, print);
    if (!projectId) return;
    if (this.linksOf(projectId).some((l) => l.peerId === from)) return;
    const rec = this.offers[keyOf(from, projectId)];
    // An accept for a team that's since been left, come late while you ask again (BLG-721): not that team again.
    if (rec?.state !== 'asked' || this.left.has(link)) {
      // We'd left (or never asked): they hear so.
      this.send(from, { k: 'leave', link });
      return;
    }
    this.join(from, projectId, link, theirProject, rec.auto);
  }

  private onDecline(from: string, print: string): void {
    const projectId = this.projectForPrint(from, print);
    if (!projectId) return;
    const rec = this.offers[keyOf(from, projectId)];
    if (rec?.state === 'invited') {
      // They took their invite back: it's a plain offer again.
      this.offers = { ...this.offers, [keyOf(from, projectId)]: { ...rec, state: 'found', link: undefined } };
      this.save();
      this.publish();
      return;
    }
    if (rec?.state !== 'asked') return;
    this.offers = { ...this.offers, [keyOf(from, projectId)]: { ...rec, state: 'found', link: undefined, dismissed: true } };
    this.save();
    this.publish();
    this.deps.toast?.(`${this.nameOf(from)} said not now to teaming up on ${this.repos.get(projectId)?.label ?? this.projectName(projectId)}`, 'info');
  }

  // ------------------------------------------------------------------ projects and their repositories

  private projectName(projectId: string): string {
    return this.deps.store.getState().projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  /** Which projects are on GitHub, and where (asked again when projects change). */
  async refreshRepos(): Promise<void> {
    const projects = this.deps.store.getState().projects.filter((p) => p.root);
    const next = new Map<string, { key: string; label: string }>();
    for (const p of projects) {
      const repo = await this.deps.repoOf(p.id).catch(() => undefined);
      if (repo) next.set(p.id, { key: repoKey(repo), label: repoLabel(repo) });
    }
    if (this.stopped) return;
    const same = next.size === this.repos.size && [...next].every(([id, r]) => this.repos.get(id)?.key === r.key);
    this.repos = next;
    if (same) return;
    for (const peer of this.linkedFriends()) this.sendRepos(peer, true);
    this.findOffers();
    this.publish();
  }

  private onAction(action: Action): void {
    if (action.type === 'projects') {
      clearTimeout(this.reposTimer);
      this.reposTimer = setTimeout(() => void this.refreshRepos(), 500);
      this.reposTimer.unref?.();
    }
    if (action.type === 'net_summary') this.publish();
    for (const p of this.parts) p.onAction?.(action);
  }

  // ------------------------------------------------------------------ state and files

  /** Tell every screen (and the phone) what's what now. */
  publish(): void {
    if (this.stopped) return;
    const { mesh } = this.deps;
    const projects = new Set(this.deps.store.getState().projects.map((p) => p.id));
    const offers: TeamOffer[] = Object.values(this.offers)
      .filter((o) => !o.dismissed && !o.auto && projects.has(o.projectId) && mesh.isFriend(o.peerId) && this.repos.has(o.projectId))
      .map((o) => {
        // Invited: who's on their team. Otherwise: who's on yours (you'd bring them in).
        const team = o.state === 'invited' ? o.team : this.teamNames(o.projectId);
        return { peerId: o.peerId, name: mesh.nameFor(o.peerId), projectId: o.projectId, repo: this.repos.get(o.projectId)!.label, state: o.state, at: o.at, ...(team?.length ? { team } : {}) };
      });
    // A team is the whole group (BLG-510): your own links, and whoever the roster says is on it through them.
    const teams: Record<string, ProjectTeam> = {};
    for (const link of this.allLinks()) {
      const t = teams[link.projectId] ?? { projectId: link.projectId, repo: this.repos.get(link.projectId)?.label ?? this.projectName(link.projectId), mates: [] };
      teams[link.projectId] = { ...t, mates: [...t.mates, { peerId: link.peerId, name: mesh.nameFor(link.peerId), since: link.since }] };
    }
    for (const t of Object.values(teams)) {
      const direct = new Set(t.mates.map((m) => m.peerId));
      const through = this.rosters.members(t.projectId, this.self).filter((m) => !direct.has(m.peerId));
      const all = [...t.mates, ...through.map((m) => ({ peerId: m.peerId, name: mesh.isFriend(m.peerId) ? mesh.nameFor(m.peerId) : m.name, since: m.since, indirect: true as const }))].sort((a, b) => a.since - b.since);
      const invitable = this.invitable(t.projectId, new Set(all.map((m) => m.peerId)));
      teams[t.projectId] = { ...t, mates: all, ...(invitable.length ? { invitable } : {}) };
    }
    let state: TeamState = { enabled: true, offers, teams, working: {}, waiting: {}, assigned: [], plans: [], planShares: {}, knocks: [], myKnocks: [] };
    for (const p of this.parts) state = { ...state, ...p.view?.() };
    const before = this.deps.store.getState().team;
    if (JSON.stringify(before) !== JSON.stringify(state)) this.deps.store.dispatch({ type: 'team_state', state });
  }

  /** Friends whose Mac has this project's repository and who aren't on its team (an invite you sent: asked). */
  private invitable(projectId: string, on: ReadonlySet<string>): Array<{ peerId: string; name: string; state?: TeamOffer['state'] }> {
    const repo = this.repos.get(projectId);
    if (!repo) return [];
    const out: Array<{ peerId: string; name: string; state?: TeamOffer['state'] }> = [];
    for (const [peerId, prints] of this.theirs) {
      if (on.has(peerId) || !this.deps.mesh.isFriend(peerId) || !prints.has(fingerprint(pairKey(this.self, peerId), repo.key))) continue;
      const rec = this.offers[keyOf(peerId, projectId)];
      out.push({ peerId, name: this.deps.mesh.nameFor(peerId), ...(rec?.state === 'asked' ? { state: 'asked' as const } : {}) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'teams.json')) as { links?: unknown; offers?: unknown } | undefined;
    if (!saved || typeof saved !== 'object') return;
    const links = Array.isArray(saved.links) ? (saved.links as TeamLink[]).filter((l) => l && typeof l.id === 'string' && typeof l.peerId === 'string' && typeof l.projectId === 'string') : [];
    this.links = Object.fromEntries(links.map((l) => [l.id, { ...l, theirProject: typeof l.theirProject === 'string' ? l.theirProject : '' }]));
    const offers = Array.isArray(saved.offers) ? (saved.offers as OfferRec[]).filter((o) => o && typeof o.peerId === 'string' && typeof o.projectId === 'string') : [];
    this.offers = Object.fromEntries(offers.map((o) => [keyOf(o.peerId, o.projectId), o]));
  }

  private save(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'teams.json'), { links: Object.values(this.links), offers: Object.values(this.offers) });
    } catch {
      // Best effort: it's in memory, and written again on the next change.
    }
  }
}
