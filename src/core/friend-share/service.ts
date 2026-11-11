import { defaultAgentOf } from '../../protocol.js';
import { placeAgent } from '../../shared/agent-picker.js';
import { randomBytes } from 'node:crypto';
import { agentLabel } from '../../shared/agent-label.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BelugaInfo, type Feature, SHARE_FEATURES, cannotTake } from '../../net/mesh/features.js';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { Body, type BodyInput, MAX_DOWNLOAD_BYTES, type WsRole } from '../../protocol.js';
import { shareNameOf } from '../../shared/share-names.js';
import type { Project } from '../../workspaces/types.js';
import { fetchBytes } from '../downloads.js';
import type { FriendFolder, ProjectGrant, SharedCopy, SharedFork, SharedProject } from '../friend-share-store.js';
import { readProjectIcon } from '../project-icons.js';
import { outboxDir, safeRef } from '../remote-work.js';
import { git } from '../../workspaces/git.js';
import type { Session } from '../session.js';
import type { Action, LogItem, Store } from '../store.js';
import { clean, peerName } from '../store.js';
import { trustOf } from '../trust.js';
import { type FriendShareInput, type FriendSharing, historyFor, saidBy } from '../workspace-sharing.js';
import { COPY_TTL_MS, cloneFrom, cloneFromBundle, cloneUrl, copiesHome, copyTarget, packProject } from './copy.js';
import { ShareCourier, type ShareMesh } from './courier.js';
import { type ForkHistory, fetchFork, haveOf, packFork, placeFork, unpackFork } from './fork.js';
import { HISTORY_TEXT, HISTORY_TEXT_LONG, type ShareMsg, historyPageOf } from './protocol.js';

/**
 * Sharing with friends over the network, with nobody hosting (docs/network.md, "Sharing with
 * friends"). A project you share shows in your friend's Projects as one row with your avatar, its
 * worktrees under it; it stays there while either of you is offline. In a shared worktree everyone
 * talks to its Claude: what's said and what that Claude does go to everyone in it, and what's said
 * while its owner's Mac is offline waits and goes when it's back. Folders you share go the same way.
 *
 * Underneath it's today's room protocol for a shared worktree (`chat`, `agent_request`,
 * `agent_event`, the files' `fs_*`), carried over the friends' Noise link instead of a room and
 * checked as it would be there (Session.meshRoute / receiveFromFriend), plus the few messages of
 * protocol.ts that say what's shared.
 *
 * Files: `project-shares.json` (what you share, with whom), `shared-projects.json` (what friends
 * share with you, and each worktree's recent conversation), `share-outbox.json` (what waits).
 */

/** What the service needs from the mesh node (net/mesh/mesh.ts); its mailbox comes through ShareMesh. */
export interface FriendMesh extends Pick<ShareMesh, 'mail' | 'mailAfterMs' | 'onLeaving'> {
  readonly peerId: string;
  isFriend(peerId: string): boolean;
  isLinked(peerId: string): boolean;
  nameFor(peerId: string): string;
  belugaOf(peerId: string): BelugaInfo | undefined;
  sendShare(peerId: string, payload: unknown): boolean;
  offer(features: readonly Feature[], on: boolean): void;
  on(event: 'share', fn: (from: string, payload: unknown) => void): unknown;
  on(event: 'link', fn: (peerId: string) => void): unknown;
  off(event: 'share', fn: (from: string, payload: unknown) => void): unknown;
  off(event: 'link', fn: (peerId: string) => void): unknown;
}

type HistoryItem = { readonly from: string; readonly text: string; readonly ts: number; readonly byAgent: boolean };

/** A project a friend shared with you, as kept on disk: with each worktree's recent conversation. */
interface Received extends SharedProject {
  readonly history: Readonly<Record<string, readonly HistoryItem[]>>;
  /** Worktrees whose earlier conversation hasn't all come yet. */
  readonly more?: Readonly<Record<string, boolean>>;
  /** Shared whole (you get a copy), and where to clone it from. */
  readonly whole?: boolean;
  readonly url?: string;
}

/** What one friend has of one of your projects: its last state and the worktrees whose history went. */
interface Sent {
  readonly sig: string;
  readonly ws: readonly string[];
}

/** A folder of yours shared with friends. */
interface FolderGrant {
  readonly label: string;
  readonly writable: boolean;
  readonly peers: readonly string[];
}

/** Room messages that may travel over a friend's link, and only about what you share. */
const KINDS = new Set<Body['kind']>(['chat', 'chat_react', 'agent_request', 'agent_event', 'agent_question', 'agent_answer', 'fs_list', 'fs_read', 'fs_fetch', 'fs_search', 'ws_diff', 'fs_list_result', 'fs_read_result', 'fs_chunk', 'fs_search_result', 'ws_diff_result', 'fs_changed', 'ws_roster', 'ws_leave', 'ws_handoff', 'ws_handoff_result', 'ws_handoff_check', 'ws_handoff_check_result']);
const RESULTS = new Set<Body['kind']>(['fs_list_result', 'fs_read_result', 'fs_chunk', 'fs_search_result', 'ws_diff_result']);
/** A Claude's steps as they stream only go to who's linked now; these wait for an offline Mac. */
const KEPT_EVENTS = new Set(['queued', 'awaiting_approval', 'started', 'done', 'error', 'denied', 'answered']);
const INBOUND_KEPT = 500;
/** How long a "do you have this repository?" before a handoff waits for its answer. */
const CHECK_TTL_MS = 60_000;
/** A friend's worktree's conversation kept on your Mac (the pages you scrolled back to, and what's said since). */
const HISTORY_KEPT = 2000;
/** How long each message of a fork's conversation may be. */
const FORK_TEXT = HISTORY_TEXT_LONG;
/** A fork's progress as it comes over goes to the screens at most this often. */
const FORK_PROGRESS_MS = 250;
const ICON_MAX = 120_000;

const wsOf = (channel: string | undefined): string | undefined => (channel?.startsWith('ws:') ? channel.slice(3) : undefined);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const keyOf = (owner: string, id: string): string => `${owner}/${id}`;
/** A repository's address as people say it: github.com/owner/repo. */
const bareUrl = (url: string | undefined): string => (url ?? 'Its repository').replace(/^https:\/\//, '');
const liveWorktrees = (p: Project) => p.workspaces.filter((w) => !w.archived && !w.pending && !w.external && w.kind !== 'main');

export interface FriendSharesOptions {
  readonly session: Session;
  readonly store: Store;
  readonly mesh: FriendMesh;
  /** Where its files live (normally ~/.beluga). */
  readonly dir: string;
  /** Where copies of projects shared whole go (normally ~/Beluga). */
  readonly copies?: string;
}

export class FriendShares implements FriendSharing {
  private readonly courier: ShareCourier;
  private grants: Record<string, Record<string, ProjectGrant>> = {};
  private sent: Record<string, Record<string, Sent>> = {};
  private folders: Record<string, FolderGrant> = {};
  private received: Record<string, Received> = {};
  private friendFolders: Record<string, FriendFolder> = {};
  /** Requests that came over the network (`from:reqId`): their answers go back the same way. */
  private readonly inbound = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private saveTimer: NodeJS.Timeout | undefined;
  /** Each project's https address to clone from (null: none), looked up once (BLG-258). */
  private repos: Record<string, string | null> = {};
  private readonly lookingUp = new Set<string>();
  /** Bundles of your projects waiting for a friend to fetch them (share name → that friend). */
  private readonly outgoing = new Map<string, string>();
  /** Bundles of friends' projects you're fetching (share name → its owner). */
  private readonly incoming = new Map<string, string>();
  /** Worktrees you offered a friend outside your room to take over, waiting for their answer (hid → them, BLG-341). */
  private readonly handoffsOut = new Map<string, string>();
  /** Handoffs a friend offered you over the network, to answer them the same way (hid → them). */
  private readonly handoffsIn = new Map<string, string>();
  /** "Do you have this repository?" asked of a friend outside your room before a handoff, and asked of you (reqId → them, BLG-614). */
  private readonly checksOut = new Map<string, string>();
  private readonly checksIn = new Map<string, string>();
  /** The names you gave forks you asked for (their worktree's id → name). */
  private readonly forkNames = new Map<string, string>();
  /** Forks waiting for their project to be on this Mac first (their worktree's id → the project's key). */
  private readonly forksWaiting = new Map<string, string>();

  constructor(private readonly opts: FriendSharesOptions) {
    this.courier = new ShareCourier(opts.mesh, path.join(opts.dir, 'share-outbox.json'), (to, m) => this.acked(to, m));
  }

  private get state() {
    return this.opts.store.getState();
  }

  private get dispatch() {
    return this.opts.store.dispatch;
  }

  start(): void {
    this.load();
    const { mesh, session, store } = this.opts;
    const onShare = (from: string, payload: unknown): void => this.onFrame(from, payload);
    const onLink = (peerId: string): void => this.courier.flush(peerId, true);
    mesh.on('share', onShare);
    mesh.on('link', onLink);
    this.offs.push(() => {
      mesh.off('share', onShare);
      mesh.off('link', onLink);
    });
    this.offs.push(store.onAction((action) => this.onAction(action)));
    session.meshRoute = (to, body) => this.route(to, body);
    session.sharing.friends = this;
    this.offs.push(() => {
      if (session.meshRoute) session.meshRoute = undefined;
      if (session.sharing.friends === this) session.sharing.friends = undefined;
    });
    mesh.offer(SHARE_FEATURES, true);
    this.offs.push(() => mesh.offer(SHARE_FEATURES, false));
    if (mesh.onLeaving) this.offs.push(mesh.onLeaving(() => this.courier.mailAll()));
    this.courier.start();
    this.publishGrants();
    this.publishReceived(true);
    this.publishFolders();
    this.resync();
    this.syncFolders();
  }

  stop(): void {
    this.courier.stop();
    for (const off of this.offs.splice(0)) off();
    if (this.saveTimer) this.saveNow();
  }

  // ------------------------------------------------------------------ owner side

  shareWithFriend(share: FriendShareInput): void {
    const { peerId, role } = share;
    const name = this.friendName(peerId);
    const project = this.projectFor(share);
    const grant = this.grants[project.id]?.[peerId];
    // A worktree (`workspaceId`, with or without its project's id) adds it to what they have; the whole project stays the whole project.
    const only = share.workspaceId ? (grant && !grant.only ? undefined : [...new Set([...(grant?.only ?? []), share.workspaceId])]) : undefined;
    this.grants = { ...this.grants, [project.id]: { ...this.grants[project.id], [peerId]: { role, ...(only ? { only } : {}) } } };
    this.saveOwn();
    this.publishGrants();
    this.resync();
    const what = only?.length === 1 ? (project.workspaces.find((w) => w.id === only[0])?.name ?? project.name) : project.name;
    this.opts.session.toast(`${name} ${role === 'contribute' ? 'can now work with you' : 'can now follow along'} in ${what}`, 'success');
  }

  unshareFriend(share: Omit<FriendShareInput, 'role'>): void {
    const project = this.projectFor(share, false);
    const grant = this.grants[project.id]?.[share.peerId];
    if (!grant) return;
    if (share.workspaceId) {
      const only = (grant.only ?? liveWorktrees(project).map((w) => w.id)).filter((id) => id !== share.workspaceId);
      if (only.length) {
        this.grants = { ...this.grants, [project.id]: { ...this.grants[project.id], [share.peerId]: { ...grant, only } } };
        this.saveOwn();
        this.publishGrants();
        this.resync();
        return;
      }
    }
    this.dropGrant(project.id, share.peerId, true);
    this.opts.session.toast(`Stopped sharing ${project.name} with ${this.opts.mesh.nameFor(share.peerId)}`, 'success');
  }

  /**
   * Your folders shared with only some people (Share a Folder's "Only…") go to those of them who are
   * friends over the network too, so no room is needed; stop sharing (or untick them) and it goes.
   */
  private syncFolders(): void {
    const { mesh } = this.opts;
    const next: Record<string, FolderGrant> = {};
    for (const share of this.state.myShares) {
      // A one-off pack for one friend (a copy, a fork, a handoff's branch) isn't a folder you share.
      if (this.isOutbox(share.root)) continue;
      const peers = share.private ? (share.allowed ?? []).filter((p) => mesh.isFriend(p) && !cannotTake('', mesh.belugaOf(p), 'share.folder', mesh.isLinked(p))) : [];
      if (peers.length) next[share.name] = { label: share.root.split(/[\\/]/).filter(Boolean).pop() ?? share.name, writable: Boolean(share.writable), peers };
    }
    if (JSON.stringify(next) === JSON.stringify(this.folders)) return;
    const msg = (name: string, g: FolderGrant, active: boolean): ShareMsg => ({ k: 'folder', name, label: g.label.slice(0, 200), writable: g.writable, active });
    for (const [name, g] of Object.entries(next)) {
      const had = this.folders[name];
      for (const p of g.peers) if (!had?.peers.includes(p) || had.label !== g.label || had.writable !== g.writable) this.courier.send(p, msg(name, g, true), { reliable: true, key: `folder:${name}` });
    }
    for (const [name, g] of Object.entries(this.folders)) for (const p of g.peers.filter((x) => !next[name]?.peers.includes(x))) this.courier.send(p, msg(name, g, false), { reliable: true, key: `folder:${name}` });
    this.folders = next;
    this.saveOwn();
  }

  /** The friends a project of yours is shared with. */
  grantsOf(projectId: string): Readonly<Record<string, ProjectGrant>> {
    return this.grants[projectId] ?? {};
  }

  private friendName(peerId: string, feature: Feature = 'share.project'): string {
    const { mesh } = this.opts;
    if (peerId === mesh.peerId) throw new Error('That’s you');
    if (!mesh.isFriend(peerId)) throw new Error('Add them as a friend first');
    const name = mesh.nameFor(peerId);
    const why = cannotTake(name, mesh.belugaOf(peerId), feature, mesh.isLinked(peerId));
    if (why) throw new Error(why);
    return name;
  }

  private projectFor(share: { projectId?: string; workspaceId?: string }, needRoot = true): Project {
    const projects = this.state.projects;
    const project = share.projectId ? projects.find((p) => p.id === share.projectId) : projects.find((p) => p.workspaces.some((w) => w.id === share.workspaceId));
    if (!project) throw new Error(share.projectId || share.workspaceId ? 'There’s no such project on this Mac' : 'Say which project or worktree to share');
    if (needRoot && !project.root) throw new Error('Chats aren’t part of a project, so they can’t be shared this way');
    return project;
  }

  private dropGrant(projectId: string, peerId: string, tell: boolean): void {
    const { [peerId]: _gone, ...rest } = this.grants[projectId] ?? {};
    this.grants = Object.keys(rest).length ? { ...this.grants, [projectId]: rest } : Object.fromEntries(Object.entries(this.grants).filter(([id]) => id !== projectId));
    for (const ws of this.sent[peerId]?.[projectId]?.ws ?? []) this.setMember(ws, peerId, undefined);
    if (this.sent[peerId]) {
      const { [projectId]: _was, ...left } = this.sent[peerId]!;
      this.sent = { ...this.sent, [peerId]: left };
    }
    if (tell) this.courier.send(peerId, { k: 'unshare', id: projectId }, { reliable: true, key: `project:${projectId}` });
    this.saveOwn();
    this.publishGrants();
    this.resync();
  }

  private setMember(wsId: string, peerId: string, role: WsRole | undefined): void {
    if (this.state.members[wsId]?.[peerId] === role) return;
    this.dispatch({ type: 'member_set', id: wsId, peerId, ...(role ? { role } : {}) });
    this.opts.session.sharing.syncShare(wsId);
  }

  /** Tell each friend what they have of your projects now, when it changed (worktrees came or went, a role, a name). */
  private resync(): void {
    let changed = false;
    for (const [projectId, byPeer] of Object.entries(this.grants)) {
      const project = this.state.projects.find((p) => p.id === projectId);
      if (!project) continue;
      const members = Object.entries(byPeer).map(([peerId, g]) => ({ peerId, name: this.opts.mesh.nameFor(peerId).slice(0, 80), role: g.role }));
      const icon = project.root ? readProjectIcon(project.root) : undefined;
      for (const [peerId, grant] of Object.entries(byPeer)) {
        const worktrees = liveWorktrees(project).filter((w) => !grant.only || grant.only.includes(w.id));
        const had = this.sent[peerId]?.[projectId];
        for (const w of worktrees) this.setMember(w.id, peerId, grant.role);
        for (const gone of (had?.ws ?? []).filter((id) => !worktrees.some((w) => w.id === id))) this.setMember(gone, peerId, undefined);
        const msg: ShareMsg = {
          k: 'project',
          id: projectId,
          name: project.name.slice(0, 200),
          ...(icon && icon.data.length <= ICON_MAX ? { icon } : {}),
          role: grant.role,
          // Each with the agent that runs it (BLG-448): yours for it, else your default.
          worktrees: worktrees.map((w) => ({ id: w.id, name: w.name.slice(0, 200), ...(w.branch ? { branch: w.branch.slice(0, 200) } : {}), agent: placeAgent(w, defaultAgentOf(this.state.self)) })),
          members,
          ...(grant.only ? this.repoFor(project) : this.copyFor(project)),
        };
        const sig = JSON.stringify(msg);
        const fresh = worktrees.filter((w) => !had?.ws.includes(w.id));
        if (had?.sig === sig && !fresh.length) continue;
        changed = true;
        if (had?.sig !== sig) this.courier.send(peerId, msg, { reliable: true, key: `project:${projectId}` });
        for (const w of fresh) this.courier.send(peerId, { k: 'history', ws: w.id, ...this.historyPage(w.id, peerId) }, { reliable: true });
        this.sent = { ...this.sent, [peerId]: { ...this.sent[peerId], [projectId]: { sig, ws: worktrees.map((w) => w.id) } } };
      }
    }
    if (changed) this.saveOwn();
  }

  /**
   * What a whole project's message says about copying it: where to clone it from, once that's
   * looked up (the message goes again when it is).
   */
  private copyFor(project: Project): Pick<Extract<ShareMsg, { k: 'project' }>, 'copy' | 'repo'> {
    const url = this.repoOf(project);
    return url !== undefined ? { copy: url ? { url } : {}, ...(url ? { repo: url } : {}) } : {};
  }

  /** Where to clone a project from, for a friend who has it a worktree at a time (a fork looks for it in theirs). */
  private repoFor(project: Project): Pick<Extract<ShareMsg, { k: 'project' }>, 'repo'> {
    const url = this.repoOf(project);
    return url ? { repo: url } : {};
  }

  /** The project's https address (null: none), or undefined while it's looked up (the message goes again when it is). */
  private repoOf(project: Project): string | null | undefined {
    const url = this.repos[project.id];
    if (url !== undefined) return url;
    const manager = this.opts.session.workspaces?.manager;
    if (manager && !this.lookingUp.has(project.id)) {
      this.lookingUp.add(project.id);
      void manager
        .remoteOf(project.id)
        .then((remote) => {
          this.repos = { ...this.repos, [project.id]: cloneUrl(remote) ?? null };
          this.resync();
        })
        .finally(() => this.lookingUp.delete(project.id));
    }
    return undefined;
  }

  /** A friend you share a project with whole couldn't clone it: pack it and offer them the bundle. */
  private async onCopyRequest(from: string, id: string): Promise<void> {
    const grant = this.grants[id]?.[from];
    const project = this.state.projects.find((p) => p.id === id);
    if (!grant || grant.only || !project?.root) return void this.courier.send(from, { k: 'copy_failed', id, error: 'That project isn’t shared with you whole' }, { reliable: true });
    const share = `copy-${randomBytes(8).toString('hex')}`;
    const dir = path.join(this.opts.dir, 'outbox', share);
    try {
      const { size } = await packProject(project.root, dir);
      this.opts.session.shareService.upsert({ name: share, root: dir, writable: false, private: true, allowed: [from] });
      this.outgoing.set(share, from);
      setTimeout(() => {
        this.outgoing.delete(share);
        this.opts.session.shareService.remove(share);
        void fs.rm(dir, { recursive: true, force: true });
      }, COPY_TTL_MS).unref();
      this.courier.send(from, { k: 'copy_ready', id, share, size }, { reliable: true });
    } catch (err) {
      void fs.rm(dir, { recursive: true, force: true });
      this.courier.send(from, { k: 'copy_failed', id, error: errorText(err).slice(0, 300) }, { reliable: true });
    }
  }

  /**
   * A page of a worktree's conversation, the newest before `before` (or the newest of all): from
   * what's saved on disk and what's said this session, so the whole of it can be scrolled back to.
   */
  private historyPage(wsId: string, to: string, before = Infinity): { items: HistoryItem[]; more: boolean } {
    // A Mac from before long messages refuses a page with one over 4,000 characters: cut them for it.
    const long = this.opts.mesh.belugaOf(to)?.can.includes('share.history.long') ?? false;
    return historyPageOf(this.historyOf(wsId, long ? HISTORY_TEXT_LONG : HISTORY_TEXT).filter((h) => h.ts < before));
  }

  /** All of a worktree's conversation, each message up to `max` characters. */
  private historyOf(wsId: string, max: number): HistoryItem[] {
    const state = this.state;
    const channel = `ws:${wsId}`;
    const live = state.log.filter((l) => l.channel === channel);
    let saved: LogItem[] = [];
    try {
      saved = this.opts.session.workspaces?.manager.loadHistory<LogItem>(wsId) ?? [];
    } catch {
      // Only what's on screen, then.
    }
    const ids = new Set(live.map((l) => l.id));
    return historyFor([...saved.filter((l) => !ids.has(l.id)), ...live], channel, (id) => peerName(state, id), Number.MAX_SAFE_INTEGER, max)
      .filter((h) => h.text.trim())
      .map((h) => ({ from: h.from.slice(0, 120), text: h.text.slice(0, max), ts: Math.max(0, Math.floor(h.ts)), byAgent: h.byAgent }));
  }

  /** Scrolling back in a friend's worktree: ask its owner for the page before what you have. */
  earlier(owner: string, wsId: string): boolean {
    const rec = this.receivedWs(wsId);
    if (!rec || rec.owner !== owner || !rec.more?.[wsId]) return false;
    if (cannotTake(rec.ownerName, this.opts.mesh.belugaOf(owner), 'share.history', this.opts.mesh.isLinked(owner))) return false;
    const first = rec.history[wsId]?.[0];
    return this.courier.send(owner, { k: 'history_request', ws: wsId, before: first?.ts ?? Date.now() }, { reliable: false });
  }

  // ---------------------------------------------------------------- the link

  /** Messages about what's shared between you and `to` go over their link (see Session.meshRoute). */
  route(to: string, body: BodyInput): boolean | undefined {
    const { mesh } = this.opts;
    // A folder shared with a friend over the network: its own `folder` message says so (see syncFolders).
    if (body.kind === 'share_offer') return mesh.isFriend(to) && (this.folders[body.name]?.peers.includes(to) || !this.state.peers.some((p) => p.peerId === to)) ? true : undefined;
    if (body.kind === 'ws_handoff' || body.kind === 'ws_handoff_result') return this.routeHandoff(to, body);
    if (body.kind === 'ws_handoff_check' || body.kind === 'ws_handoff_check_result') return this.routeHandoffCheck(to, body);
    if (!KINDS.has(body.kind) || !mesh.isFriend(to)) return undefined;
    if (!this.about(to, body)) return undefined;
    // Who's in a shared worktree goes with the project's own message.
    if (body.kind === 'ws_roster' || body.kind === 'ws_leave') return true;
    const ws = 'channel' in body ? wsOf(body.channel) : undefined;
    const theirs = ws ? this.receivedWs(ws) : undefined;
    // In a friend's worktree, its owner passes what you say on to the others.
    // A reaction to a message there (BLG-702) goes the same way.
    if ((body.kind === 'chat' || body.kind === 'chat_react') && theirs && theirs.owner !== to) return true;
    const reliable = body.kind === 'chat' || body.kind === 'chat_react' || body.kind === 'agent_request' || body.kind === 'agent_question' || body.kind === 'agent_answer' || (body.kind === 'agent_event' && KEPT_EVENTS.has(body.event));
    const went = this.courier.send(to, { k: 'body', b: body }, { reliable });
    if (body.kind === 'agent_request' && !went) this.dispatch({ type: 'fshare_delivery', id: body.requestId, state: 'waiting' });
    return reliable ? true : went;
  }

  /** In one of the outboxes where packs for one friend wait to be fetched. */
  private isOutbox(root: string): boolean {
    return [path.join(this.opts.dir, 'outbox'), outboxDir()].some((dir) => root.startsWith(dir + path.sep));
  }

  /**
   * Handing a worktree to a friend outside your room (BLG-341): the offer goes over their link, its
   * branch bundle is fetched like a fork's pack, and their answer comes back the same way. Someone in
   * your room gets it through the room, as before.
   */
  private routeHandoff(to: string, body: Extract<BodyInput, { kind: 'ws_handoff' | 'ws_handoff_result' }>): boolean | undefined {
    const { mesh } = this.opts;
    if (!mesh.isFriend(to)) return undefined;
    if (body.kind === 'ws_handoff_result') {
      if (this.handoffsIn.get(body.hid) !== to) return undefined;
      this.handoffsIn.delete(body.hid);
      return this.courier.send(to, { k: 'body', b: body }, { reliable: true });
    }
    if (this.state.peers.some((p) => p.peerId === to)) return undefined;
    if (cannotTake('', mesh.belugaOf(to), 'share.handoff', mesh.isLinked(to))) return false;
    this.handoffsOut.set(body.hid, to);
    if (body.bundle) this.outgoing.set(body.bundle.share, to);
    setTimeout(() => {
      this.handoffsOut.delete(body.hid);
      if (body.bundle) this.outgoing.delete(body.bundle.share);
    }, COPY_TTL_MS).unref();
    this.courier.send(to, { k: 'body', b: body }, { reliable: true });
    return true;
  }

  /** The quick "do you have this repository?" before a handoff goes the same way as the handoff would (BLG-614). */
  private routeHandoffCheck(to: string, body: Extract<BodyInput, { kind: 'ws_handoff_check' | 'ws_handoff_check_result' }>): boolean | undefined {
    const { mesh } = this.opts;
    if (!mesh.isFriend(to)) return undefined;
    if (body.kind === 'ws_handoff_check_result') {
      if (this.checksIn.get(body.reqId) !== to) return undefined;
      this.checksIn.delete(body.reqId);
      return this.courier.send(to, { k: 'body', b: body }, { reliable: false });
    }
    if (this.state.peers.some((p) => p.peerId === to)) return undefined;
    if (cannotTake('', mesh.belugaOf(to), 'share.handoff', mesh.isLinked(to))) return false;
    // Only asked of someone reachable now: an offline friend's handoff simply waits for them, as before.
    if (!this.courier.send(to, { k: 'body', b: body }, { reliable: false })) return false;
    this.remember(this.checksOut, body.reqId, to);
    return true;
  }

  /** Remember who a request went to (or came from) for a while, to match their answer. */
  private remember(map: Map<string, string>, key: string, peerId: string): void {
    map.set(key, peerId);
    setTimeout(() => map.delete(key), CHECK_TTL_MS).unref();
  }

  /** Is this message about something shared between you and `peerId` over the network? */
  private about(peerId: string, body: BodyInput): boolean {
    if ('channel' in body && body.channel !== undefined) {
      const ws = wsOf(body.channel);
      return Boolean(ws && (this.grantedTo(ws, peerId) || this.receivedWs(ws)?.owner === peerId));
    }
    if (body.kind === 'ws_diff') return this.grantedTo(body.id, peerId) || this.receivedWs(body.id)?.owner === peerId;
    if (RESULTS.has(body.kind)) return 'reqId' in body && this.inbound.has(`${peerId}:${body.reqId}`);
    if ('share' in body && typeof body.share === 'string') return this.shareBetween(body.share, peerId);
    if (body.kind === 'agent_answer') return !this.state.peers.some((p) => p.peerId === peerId) && this.related(peerId);
    return false;
  }

  /** One of your worktrees shared with them. */
  private grantedTo(wsId: string, peerId: string): boolean {
    return Object.values(this.sent[peerId] ?? {}).some((s) => s.ws.includes(wsId));
  }

  private receivedWs(wsId: string): Received | undefined {
    return Object.values(this.received).find((p) => p.worktrees.some((w) => w.id === wsId));
  }

  /** A folder (or a worktree's folder) shared between you and them over the network. */
  private shareBetween(share: string, peerId: string): boolean {
    if (this.folders[share]?.peers.includes(peerId)) return true;
    if (this.outgoing.get(share) === peerId || this.incoming.get(share) === peerId) return true;
    if (this.friendFolders[keyOf(peerId, share)]) return true;
    const ws = share.startsWith('ws-') ? Object.values(this.sent[peerId] ?? {}).some((s) => s.ws.some((id) => shareNameOf(id) === share)) : false;
    return ws || Object.values(this.received).some((p) => p.owner === peerId && p.worktrees.some((w) => shareNameOf(w.id) === share));
  }

  /** Is anything shared between you and them over the network (a project or a folder, either way)? */
  private related(peerId: string): boolean {
    return (
      Boolean(this.sent[peerId] && Object.keys(this.sent[peerId]!).length) ||
      Object.values(this.received).some((p) => p.owner === peerId) ||
      Object.values(this.friendFolders).some((f) => f.owner === peerId) ||
      Object.values(this.folders).some((f) => f.peers.includes(peerId)) ||
      [...this.outgoing.values(), ...this.incoming.values()].includes(peerId)
    );
  }

  private acked(_to: string, m: ShareMsg): void {
    if (m.k !== 'body') return;
    const b = m.b as BodyInput;
    if (b.kind === 'agent_request' && this.state.delivery[b.requestId] === 'waiting') this.dispatch({ type: 'fshare_delivery', id: b.requestId, state: 'delivered' });
  }

  /** Is a message for this request still waiting for the owner's Mac? */
  waiting(requestId: string): boolean {
    return this.state.delivery[requestId] === 'waiting';
  }

  private onFrame(from: string, payload: unknown): void {
    const got = this.courier.receive(from, payload);
    if (!got) return;
    const { m } = got;
    switch (m.k) {
      case 'project':
        return this.onProject(from, m);
      case 'unshare':
        return this.onUnshare(from, m.id);
      case 'leave':
        if (this.grants[m.id]?.[from]) this.dropGrant(m.id, from, false);
        return;
      case 'history':
        return this.onHistory(from, m);
      case 'history_request':
        if (this.grantedTo(m.ws, from)) this.courier.send(from, { k: 'history', ws: m.ws, before: m.before, ...this.historyPage(m.ws, from, m.before) }, { reliable: false });
        return;
      case 'body':
        return this.onBody(from, m, got.id);
      case 'folder':
        return this.onFolder(from, m);
      case 'copy_request':
        return void this.onCopyRequest(from, m.id);
      case 'copy_ready':
        return void this.onCopyReady(from, m);
      case 'copy_failed':
        return this.setCopy(from, m.id, { state: 'failed', error: clean(m.error) });
      case 'fork_request':
        return void this.onForkRequest(from, m.ws, m.have);
      case 'fork_ready':
        return void this.onForkReady(from, m);
      case 'fork_failed':
        if (this.receivedWs(m.ws)?.owner === from && this.state.forks[m.ws]?.state === 'asking') this.forkFailed(m.ws, clean(m.error));
        return;
    }
  }

  private onBody(from: string, m: Extract<ShareMsg, { k: 'body' }>, frameId: string): void {
    const parsed = Body.safeParse(m.b);
    if (!parsed.success || !KINDS.has(parsed.data.kind)) return;
    const body = parsed.data;
    const { session } = this.opts;
    const ws = 'channel' in body ? wsOf(body.channel) : body.kind === 'ws_diff' ? body.id : undefined;
    const mine = ws !== undefined && this.grantedTo(ws, from);
    const theirs = ws !== undefined && this.receivedWs(ws)?.owner === from;
    if ('channel' in body && body.channel !== undefined && !mine && !theirs) return;
    if (body.kind === 'ws_roster' || body.kind === 'ws_leave') return;
    if (body.kind === 'ws_handoff' && !this.tookHandoff(from, body)) return;
    if (body.kind === 'ws_handoff_check') {
      if (this.checksIn.has(body.reqId)) return;
      this.remember(this.checksIn, body.reqId, from);
    }
    if (body.kind === 'ws_handoff_check_result') {
      if (this.checksOut.get(body.reqId) !== from) return;
      this.checksOut.delete(body.reqId);
    }
    if (body.kind === 'ws_handoff_result') {
      if (this.handoffsOut.get(body.hid) !== from) return;
      this.handoffsOut.delete(body.hid);
    }
    let author = from;
    if (m.as) {
      // Only a worktree's owner passes on what others said in it (and what their own agents answered there).
      if ((body.kind !== 'chat' && body.kind !== 'chat_react' && body.kind !== 'agent_event') || !theirs || m.as === this.opts.mesh.peerId) return;
      author = m.as;
    }
    if (body.kind === 'agent_request' && (!mine || body.project)) return;
    if (body.kind === 'agent_question' && !theirs) return;
    // A contributor's own agent answering them in your worktree (their "@claude" there) writes in it too.
    const guestAgent = body.kind === 'agent_event' && mine && !m.as && session.sharing.agentMayWrite(from, body.channel, body.requester);
    if (body.kind === 'agent_event' && !theirs && !guestAgent) return;
    if (body.kind === 'fs_list' || body.kind === 'fs_read' || body.kind === 'fs_fetch' || body.kind === 'fs_search' || body.kind === 'ws_diff') {
      if (body.kind === 'ws_diff') {
        if (!mine) return;
      } else if (!this.shareBetween(body.share, from) || !session.shareService.isPrivate(body.share)) {
        // Only what's shared with them by name: never a folder you share with a room.
        return;
      }
      this.inbound.add(`${from}:${body.reqId}`);
      if (this.inbound.size > INBOUND_KEPT) this.inbound.delete(this.inbound.values().next().value!);
    }
    if (RESULTS.has(body.kind) && !this.related(from)) return;
    void session.receiveFromFriend(author, body, frameId);
    // What someone says in your worktree goes on to the others in it.
    // Reactions too (BLG-702), from anyone who sees it (viewers may react, not post).
    const passOn = body.kind === 'chat' ? session.sharing.canPost(from, body.channel ?? '') : body.kind === 'chat_react' && session.sharing.canSee(from, body.channel);
    if (passOn && mine && !m.as) {
      for (const peer of Object.keys(session.sharing.members(ws!))) if (peer !== from) this.courier.send(peer, { k: 'body', b: body, as: from }, { reliable: true });
    }
    // Its steps as they stream go to who's linked now, as the owner's own agent's do.
    if (guestAgent) {
      const reliable = KEPT_EVENTS.has(body.event);
      for (const peer of Object.keys(session.sharing.members(ws!))) if (peer !== from) this.courier.send(peer, { k: 'body', b: body, as: from }, { reliable });
    }
  }

  /** A friend offers you a worktree to take over: remember it to answer them, and its bundle to fetch. */
  private tookHandoff(from: string, body: Extract<Body, { kind: 'ws_handoff' }>): boolean {
    if (this.handoffsIn.has(body.hid) || (body.bundle && this.incoming.has(body.bundle.share))) return false;
    this.handoffsIn.set(body.hid, from);
    if (body.bundle) this.incoming.set(body.bundle.share, from);
    setTimeout(() => {
      this.handoffsIn.delete(body.hid);
      if (body.bundle) this.incoming.delete(body.bundle.share);
    }, COPY_TTL_MS).unref();
    return true;
  }

  // ---------------------------------------------------------------- receiver side

  private onProject(from: string, m: Extract<ShareMsg, { k: 'project' }>): void {
    const own = new Set(this.state.projects.flatMap((p) => p.workspaces.map((w) => w.id)));
    // Worktree ids are random; one that collides with yours or with someone else's share is left out.
    const worktrees = m.worktrees.filter((w) => !own.has(w.id) && !this.state.shared.some((s) => s.id === w.id && s.owner !== from)).map((w) => ({ id: w.id, name: clean(w.name), ...(w.branch ? { branch: clean(w.branch) } : {}) }));
    const key = keyOf(from, m.id);
    const before = this.received[key];
    const ownerName = this.opts.mesh.nameFor(from);
    const next: Received = {
      owner: from,
      ownerName,
      id: m.id,
      name: clean(m.name),
      ...(m.icon && /^image\/[\w.+-]+$/.test(m.icon.mime) && /^[A-Za-z0-9+/=]*$/.test(m.icon.data) ? { icon: m.icon } : {}),
      role: m.role,
      worktrees,
      members: m.members.map((x) => ({ peerId: x.peerId, name: clean(x.name), role: x.role })),
      updatedAt: Date.now(),
      ...(before?.copy ? { copy: before.copy } : {}),
      ...(m.copy ? { whole: true } : {}),
      ...(m.copy?.url || m.repo ? { url: (m.copy?.url ?? m.repo)! } : {}),
      history: Object.fromEntries(Object.entries(before?.history ?? {}).filter(([ws]) => worktrees.some((w) => w.id === ws))),
    };
    this.received = { ...this.received, [key]: next };
    for (const gone of (before?.worktrees ?? []).filter((w) => !worktrees.some((x) => x.id === w.id))) this.leaveWs(from, gone.id);
    this.saveReceived();
    this.publishReceived(false);
    if (!before) this.opts.session.toast(`${ownerName} shared ${next.name} with you${m.role === 'view' ? ' (to follow along)' : ''}. It's in Projects`, 'success');
    // Shared whole: you get your own copy of it, once (Get a Copy tries again after a failure).
    if (m.copy && !next.copy) void this.makeCopy(from, m.id);
  }

  // ---------------------------------------------------------------- your copy (BLG-258)

  /**
   * Make your own copy of a project a friend shares with you: the one you already have when its
   * repository is in your Projects, else a clone of it, else (shared whole) a bundle from their Mac.
   */
  async makeCopy(owner: string, id: string): Promise<void> {
    const rec = this.received[keyOf(owner, id)];
    // A copy you since took out of Projects is made again.
    const made = rec?.copy?.state === 'ready' && this.state.projects.some((p) => p.id === rec.copy?.projectId);
    if (!rec || !(rec.whole || rec.url) || rec.copy?.state === 'copying' || made) return;
    const manager = this.opts.session.workspaces?.manager;
    if (!manager) return this.setCopy(owner, id, { state: 'failed', error: 'Projects aren’t open on this Mac' });
    const have = rec.url ? await manager.projectForRemote(rec.url).catch(() => undefined) : undefined;
    if (have) return this.setCopy(owner, id, { state: 'ready', path: have.root, projectId: have.id });
    const dest = copyTarget(rec.ownerName, rec.name, this.opts.copies ?? copiesHome());
    this.setCopy(owner, id, { state: 'copying', path: dest });
    if (rec.url) {
      try {
        await cloneFrom(rec.url, dest);
        return void (await this.copied(owner, id, dest));
      } catch {
        // Not one you can read (private, or no access): their Mac sends it instead, when it's shared whole.
      }
    }
    // Shared a worktree at a time: their Mac only sends what they chose to share.
    if (!rec.whole) return this.setCopy(owner, id, { state: 'failed', error: `${bareUrl(rec.url)} couldn’t be cloned here (it may be private, or you don’t have access). Ask ${rec.ownerName} to share the whole project, and it’s copied from their Mac` });
    const why = cannotTake(rec.ownerName, this.opts.mesh.belugaOf(owner), 'share.copy', this.opts.mesh.isLinked(owner));
    if (why) return this.setCopy(owner, id, { state: 'failed', error: why });
    this.courier.send(owner, { k: 'copy_request', id }, { reliable: true });
  }

  private async onCopyReady(from: string, m: Extract<ShareMsg, { k: 'copy_ready' }>): Promise<void> {
    const rec = this.received[keyOf(from, m.id)];
    const dest = rec?.copy?.state === 'copying' ? rec.copy.path : undefined;
    if (!rec || !dest || m.size > MAX_DOWNLOAD_BYTES) return;
    this.incoming.set(m.share, from);
    try {
      const bytes = await fetchBytes({ owner: from, share: m.share, path: 'project.bundle' }, (to, b) => this.opts.session.files.request(to, b), MAX_DOWNLOAD_BYTES);
      await cloneFromBundle(bytes, dest, rec.url);
      await this.copied(from, m.id, dest);
    } catch (err) {
      this.setCopy(from, m.id, { state: 'failed', path: dest, error: errorText(err) });
    } finally {
      this.incoming.delete(m.share);
    }
  }

  /** The copy is made: into your Projects with it. */
  private async copied(owner: string, id: string, dest: string): Promise<void> {
    const ctl = this.opts.session.workspaces;
    const projectId = ctl?.manager.addProject(dest);
    await ctl?.refresh();
    this.setCopy(owner, id, { state: 'ready', path: dest, ...(projectId ? { projectId } : {}) });
    const rec = this.received[keyOf(owner, id)];
    if (rec) this.opts.session.toast(`Your copy of ${rec.name} is in ${dest.replace(/^\/Users\/[^/]+/, '~')}`, 'success');
  }

  /**
   * Say something in a friend's worktree, but to your own Claude in your copy (BLG-260): a
   * worktree of yours on the same branch (made the first time, the branch fetched when you
   * don't have it), opened, with the message sent there. Returns its id.
   */
  async runHere(owner: string, wsId: string, prompt: string): Promise<string> {
    const rec = this.receivedWs(wsId);
    const shared = rec?.worktrees.find((w) => w.id === wsId);
    if (!rec || rec.owner !== owner || !shared) throw new Error('That worktree isn’t shared with you');
    const ctl = this.opts.session.workspaces;
    const project = rec.copy?.state === 'ready' ? this.state.projects.find((p) => p.id === rec.copy?.projectId) : undefined;
    if (!ctl || !project?.root) throw new Error(`You don’t have a copy of ${rec.name} on this Mac yet`);
    const want = shared.branch && safeRef(shared.branch) ? shared.branch : undefined;
    let ws = want ? project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && w.branch === want) : undefined;
    if (!ws) {
      const has = async (b: string): Promise<boolean> => Boolean(await git(project.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).catch(() => ''));
      if (want && !(await has(want))) await git(project.root, ['fetch', '--quiet', 'origin', `${want}:${want}`], 120_000).catch(() => undefined);
      const current = (await git(project.root, ['branch', '--show-current']).catch(() => '')).trim();
      // Their branch, unless it's what your main folder has checked out (or it never came): a branch of your own from it.
      let branch = want && want !== current && (await has(want)) ? want : undefined;
      if (!branch) {
        branch = await ctl.manager.freeBranchName(project.root, shared.name);
        await git(project.root, ['branch', '--no-track', branch, want && (await has(want)) ? want : 'HEAD']);
      }
      // Their branch is their code: your .env files and the setup only come in if you fully trust them (as a handoff's).
      const full = trustOf(this.state, owner) === 'full';
      ws = await ctl.manager.createWorktreeOn(project.id, shared.name, branch, {}, { copyEnv: full });
      await ctl.refresh();
      if (full) this.opts.session.workbench?.onWorktreeCreated(ws);
    }
    ctl.open(ws.id);
    this.opts.session.submit(prompt, { channel: `ws:${ws.id}` });
    return ws.id;
  }

  // ---------------------------------------------------------------- forks (BLG-312)

  /**
   * Fork a friend's worktree to this Mac: their Mac packs it (fork.ts) and yours makes it a
   * worktree of yours in your copy of the project (or your own clone of it), with their
   * uncommitted work, its Scratch and its conversation, which your Claude remembers. `name`:
   * yours for it (else theirs). How far it got is in the state's `forks`.
   */
  async fork(owner: string, wsId: string, name?: string): Promise<void> {
    const rec = this.receivedWs(wsId);
    if (!rec || rec.owner !== owner || !rec.worktrees.some((w) => w.id === wsId)) throw new Error('That worktree isn’t shared with you');
    if (rec.role !== 'contribute') throw new Error(`${rec.ownerName} shared it for you to follow along: forking it needs “Can work here”`);
    const now = this.state.forks[wsId]?.state;
    if (now === 'preparing' || now === 'asking' || now === 'copying') return;
    const why = cannotTake(rec.ownerName, this.opts.mesh.belugaOf(owner), 'share.fork', this.opts.mesh.isLinked(owner));
    if (why) throw new Error(why);
    const project = await this.localProjectOf(rec);
    if (!project && !rec.url && !rec.whole) throw new Error(`Forking needs ${rec.name} on this Mac: ask ${rec.ownerName} to share the whole project, and it’s copied here`);
    if (name?.trim()) this.forkNames.set(wsId, name.trim());
    else this.forkNames.delete(wsId);
    if (project) return this.askFork(owner, wsId, project);
    // Not on this Mac yet: it's got first (a clone, or their Mac sends it when it's shared whole), then forked.
    this.forksWaiting.set(wsId, keyOf(owner, rec.id));
    this.setFork(wsId, { state: 'preparing' });
    void this.makeCopy(owner, rec.id);
  }

  private async askFork(owner: string, wsId: string, project: Project): Promise<void> {
    this.setFork(wsId, { state: 'asking' });
    this.courier.send(owner, { k: 'fork_request', ws: wsId, have: await haveOf(project.root) }, { reliable: true });
  }

  /** A project forks waited for is here (they go on), or couldn't come (they fail with why). */
  private resumeForks(key: string, copy: SharedCopy): void {
    if (copy.state === 'copying') return;
    const waiting = [...this.forksWaiting].filter(([, k]) => k === key).map(([wsId]) => wsId);
    for (const wsId of waiting) {
      this.forksWaiting.delete(wsId);
      if (copy.state === 'failed') {
        this.forkFailed(wsId, copy.error ?? `${this.received[key]?.name ?? 'The project'} couldn’t be copied here`);
        continue;
      }
      void this.forkNowHere(key, wsId).catch((err: unknown) => this.forkFailed(wsId, errorText(err)));
    }
  }

  private async forkNowHere(key: string, wsId: string): Promise<void> {
    const rec = this.received[key];
    if (!rec) return this.forkFailed(wsId, 'That worktree isn’t shared with you any more');
    const project = await this.localProjectOf(rec);
    if (!project) return this.forkFailed(wsId, `${rec.name} isn’t on this Mac`);
    await this.askFork(rec.owner, wsId, project);
  }

  /** Your own project for a friend's: your copy of it, else your clone of the same repository. */
  private async localProjectOf(rec: Received): Promise<Project | undefined> {
    const copy = rec.copy?.state === 'ready' ? this.state.projects.find((p) => p.id === rec.copy?.projectId && p.root) : undefined;
    if (copy) return copy;
    return rec.url ? this.opts.session.workspaces?.manager.projectForRemote(rec.url).catch(() => undefined) : undefined;
  }

  /** A friend who works in your worktree wants a fork of it: pack it (fork.ts) and offer it to them alone. */
  private async onForkRequest(from: string, wsId: string, have: readonly string[]): Promise<void> {
    const fail = (error: string): void => void this.courier.send(from, { k: 'fork_failed', ws: wsId, error: error.slice(0, 300) }, { reliable: true });
    const ws = this.opts.session.workspaces?.manager.find(wsId);
    if (!ws || !this.grantedTo(wsId, from)) return fail('That worktree isn’t shared with you');
    if (this.state.members[wsId]?.[from] !== 'contribute') return fail('Only people who work in it can fork it');
    if (ws.kind !== 'worktree' || !ws.branch || ws.archived) return fail('Only a worktree can be forked');
    const id = randomBytes(8).toString('hex');
    const share = `fork-${id}`;
    const dir = path.join(this.opts.dir, 'outbox', share);
    const name = this.opts.mesh.nameFor(from);
    try {
      const { size, meta } = await packFork({ id, dir: ws.path, name: ws.name, branch: ws.branch, ...(ws.sessionId ? { sessionId: ws.sessionId } : {}), history: this.historyOf(wsId, FORK_TEXT).slice(-HISTORY_KEPT), have, out: dir });
      this.opts.session.shareService.upsert({ name: share, root: dir, writable: false, private: true, allowed: [from] });
      this.outgoing.set(share, from);
      setTimeout(() => {
        this.outgoing.delete(share);
        this.opts.session.shareService.remove(share);
        void fs.rm(dir, { recursive: true, force: true });
      }, COPY_TTL_MS).unref();
      this.courier.send(from, { k: 'fork_ready', ws: wsId, share, size, files: meta.changed + meta.scratch }, { reliable: true });
      const what = [meta.changed ? `${meta.changed} uncommitted ${meta.changed === 1 ? 'file' : 'files'}` : '', meta.scratch ? 'Scratch' : '', 'the conversation'].filter(Boolean).join(', ');
      this.dispatch({ type: 'system', channel: `ws:${wsId}`, text: `${name} forked this worktree to their Mac (its commits, ${what}). This one stays as it is.` });
    } catch (err) {
      void fs.rm(dir, { recursive: true, force: true });
      fail(errorText(err));
    }
  }

  /** Your fork's pack is ready on the owner's Mac: fetch it and make it your worktree. */
  private async onForkReady(from: string, m: Extract<ShareMsg, { k: 'fork_ready' }>): Promise<void> {
    const rec = this.receivedWs(m.ws);
    const ctl = this.opts.session.workspaces;
    if (!rec || rec.owner !== from || !ctl || this.state.forks[m.ws]?.state !== 'asking' || m.size > MAX_DOWNLOAD_BYTES) return;
    const files = m.files !== undefined ? { files: m.files } : {};
    this.setFork(m.ws, { state: 'copying', received: 0, total: m.size, ...files });
    this.incoming.set(m.share, from);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beluga-fork-'));
    let made: { root: string; branch: string } | undefined;
    let shown = 0;
    const progress = (received: number, total: number): void => {
      const now = Date.now();
      if (received < total && now - shown < FORK_PROGRESS_MS) return;
      shown = now;
      this.setFork(m.ws, { state: 'copying', received, total, ...files });
    };
    try {
      const project = await this.localProjectOf(rec);
      if (!project) throw new Error(`${rec.name} isn’t on this Mac any more`);
      const bytes = await fetchBytes({ owner: from, share: m.share, path: 'fork.tgz' }, (to, b) => this.opts.session.files.request(to, b), MAX_DOWNLOAD_BYTES, progress);
      const got = await unpackFork(bytes, tmp);
      const name = this.forkNames.get(m.ws) || clean(got.meta.name) || 'fork';
      const branch = await ctl.manager.freeBranchName(project.root, name);
      await fetchFork(project.root, got, branch);
      made = { root: project.root, branch };
      // Their code: your .env files and the setup only come in if you fully trust them (as a handoff's).
      const full = trustOf(this.state, from) === 'full';
      const ws = await ctl.manager.createWorktreeOn(project.id, name, branch, got.meta.sessionId ? { forkFromSession: got.meta.sessionId } : {}, { copyEnv: full });
      await placeFork(ws.path, got);
      ctl.manager.saveHistory(ws.id, this.forkLog(rec, m.ws, ws.id, branch, got.meta, got.history, full));
      await ctl.refresh();
      ctl.open(ws.id);
      if (full) this.opts.session.workbench?.onWorktreeCreated(ws);
      this.setFork(m.ws, { state: 'ready', wsId: ws.id });
      this.forkNames.delete(m.ws);
      this.opts.session.toast(`Your fork of ${rec.ownerName}’s ${ws.name} is ready on ${branch}`, 'success');
    } catch (err) {
      // Don't leave a half-made branch behind.
      if (made && !ctl.manager.list.some((p) => p.workspaces.some((w) => w.branch === made!.branch))) await git(made.root, ['branch', '-D', '--', made.branch]).catch(() => undefined);
      this.forkFailed(m.ws, errorText(err));
    } finally {
      this.incoming.delete(m.share);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /** A fork's conversation, as its owner's worktree shows it, then where it came from. */
  private forkLog(rec: Received, theirWs: string, wsId: string, branch: string, meta: { changed: number; scratch: number; sessionId?: string | undefined }, history: ForkHistory, full: boolean): LogItem[] {
    const channel = `ws:${wsId}`;
    const state = this.state;
    const theirs = rec.worktrees.find((w) => w.id === theirWs)?.name ?? 'worktree';
    const came = [meta.changed ? `${meta.changed} uncommitted ${meta.changed === 1 ? 'file' : 'files'} (still uncommitted here)` : '', meta.scratch ? `${meta.scratch} ${meta.scratch === 1 ? 'file' : 'files'} in Scratch` : '', 'the conversation'].filter(Boolean).join(', ');
    const now = Date.now();
    return [
      ...history.map((h, i): LogItem => ({ id: `fk-${wsId}-${i}`, type: 'system', channel, text: `${clean(h.from)}: ${clean(h.text)}`, ts: h.ts, level: 'info', said: saidBy(state, rec.owner, h) })),
      { id: `fk-${wsId}-from`, type: 'system', channel, text: `Forked from ${rec.ownerName}’s ${theirs}, on your branch ${branch}: its commits, ${came}.${meta.sessionId ? ' Your agent remembers the conversation.' : ''} ${rec.ownerName}’s worktree goes on without this one.`, ts: now, level: 'info' },
      ...(full ? [] : [{ id: `fk-${wsId}-setup`, type: 'system' as const, channel, text: `Setup didn’t run and your .env files weren’t copied, because this came from ${rec.ownerName}. Look it over, then use Terminal → Run setup.`, ts: now, level: 'warn' as const }]),
    ];
  }

  private setFork(wsId: string, fork: SharedFork): void {
    this.dispatch({ type: 'fshare_fork', id: wsId, fork });
  }

  private forkFailed(wsId: string, error: string): void {
    this.setFork(wsId, { state: 'failed', error });
    this.opts.session.toast(`Couldn’t fork it: ${error}`, 'warn');
  }

  private setCopy(owner: string, id: string, copy: SharedCopy): void {
    const key = keyOf(owner, id);
    const rec = this.received[key];
    if (!rec) return;
    this.received = { ...this.received, [key]: { ...rec, copy } };
    this.saveReceived();
    this.publishReceived(false);
    // A fork waiting on it says so itself.
    const forking = [...this.forksWaiting.values()].includes(key);
    if (copy.state === 'failed' && !forking) this.opts.session.toast(`Couldn’t copy ${rec.name}: ${copy.error ?? 'it didn’t work'}`, 'warn');
    this.resumeForks(key, copy);
  }

  private onUnshare(from: string, id: string): void {
    const before = this.received[keyOf(from, id)];
    if (!before) return;
    this.forget(from, id);
    this.opts.session.toast(`${before.ownerName} stopped sharing ${before.name} with you`, 'warn');
  }

  private leaveWs(owner: string, id: string): void {
    this.dispatch({ type: 'shared_remove', owner, id });
    this.opts.session.intend({ type: 'close_tab', id });
  }

  /** Leave a project a friend shared with you (it goes from your Projects; they're told). */
  leave(owner: string, projectId: string): void {
    if (!this.received[keyOf(owner, projectId)]) return;
    this.courier.send(owner, { k: 'leave', id: projectId }, { reliable: true });
    this.forget(owner, projectId);
  }

  private forget(owner: string, id: string): void {
    const key = keyOf(owner, id);
    const before = this.received[key];
    if (!before) return;
    this.received = Object.fromEntries(Object.entries(this.received).filter(([k]) => k !== key));
    for (const w of before.worktrees) {
      this.forksWaiting.delete(w.id);
      this.leaveWs(owner, w.id);
    }
    this.saveReceived();
    this.publishReceived(false);
  }

  private onHistory(from: string, m: Extract<ShareMsg, { k: 'history' }>): void {
    const rec = this.receivedWs(m.ws);
    if (!rec || rec.owner !== from) return;
    const items = m.items.map((h) => ({ from: clean(h.from), text: clean(h.text), ts: h.ts, byAgent: h.byAgent }));
    const more = { ...rec.more, [m.ws]: Boolean(m.more) };
    if (m.before === undefined) {
      this.received = { ...this.received, [keyOf(rec.owner, rec.id)]: { ...rec, more, history: { ...rec.history, [m.ws]: items } } };
      this.saveReceived();
      this.publishReceived(false);
      return this.injectHistory(rec.owner, m.ws, items);
    }
    // A page from further back: before what you have, above what's on screen.
    const have = rec.history[m.ws] ?? [];
    const first = have[0]?.ts ?? Infinity;
    const older = items.filter((h) => h.ts < first);
    this.received = { ...this.received, [keyOf(rec.owner, rec.id)]: { ...rec, more, history: { ...rec.history, [m.ws]: [...older, ...have].slice(-HISTORY_KEPT) } } };
    this.saveReceived();
    this.publishReceived(false);
    const channel = `ws:${m.ws}`;
    const state = this.state;
    const lines: LogItem[] = older.map((h, i) => ({ id: `fh-${m.ws}-${h.ts}-${i}`, type: 'system', channel, text: `${h.from}: ${h.text}`, ts: h.ts, level: 'info', said: saidBy(state, rec.owner, h) }));
    this.dispatch({ type: 'history', channel, items: [...lines, ...state.log.filter((l) => l.channel === channel)] });
  }

  /** A worktree's earlier conversation, as lines of who said what (as a room invite brings it). */
  private injectHistory(owner: string, wsId: string, items: readonly HistoryItem[]): void {
    const channel = `ws:${wsId}`;
    this.dispatch({ type: 'clear', channel });
    const state = this.state;
    for (const h of items) this.dispatch({ type: 'system', text: `${h.from}: ${h.text}`, channel, said: saidBy(state, owner, h) });
  }

  private onFolder(from: string, m: Extract<ShareMsg, { k: 'folder' }>): void {
    const key = keyOf(from, m.name);
    if (m.active) {
      const isNew = !this.friendFolders[key];
      this.friendFolders = { ...this.friendFolders, [key]: { owner: from, ownerName: this.opts.mesh.nameFor(from), name: m.name, label: clean(m.label) || m.name, writable: m.writable, since: this.friendFolders[key]?.since ?? Date.now() } };
      if (isNew) this.opts.session.toast(`${this.opts.mesh.nameFor(from)} shared the folder ${clean(m.label) || m.name} with you. It's in Files`, 'success');
    } else this.friendFolders = Object.fromEntries(Object.entries(this.friendFolders).filter(([k]) => k !== key));
    this.saveReceived();
    this.publishFolders();
  }

  /** What's said in a friend's worktree is kept with it, so it's there after a restart too. */
  private onAction(action: Action): void {
    if (action.type === 'projects') return this.resync();
    if (action.type === 'my_shares') return this.syncFolders();
    const channel = action.type === 'chat' || action.type === 'agent_event' ? action.channel : undefined;
    const ws = wsOf(channel);
    const rec = ws ? this.receivedWs(ws) : undefined;
    if (!rec || !ws) return;
    let item: HistoryItem | undefined;
    if (action.type === 'chat') item = { from: peerName(this.state, action.from), text: action.text.slice(0, HISTORY_TEXT_LONG), ts: action.ts, byAgent: action.byAgent };
    if (action.type === 'agent_event' && action.event === 'done' && action.text.trim()) item = { from: agentLabel(action.agent, peerName(this.state, action.owner), false), text: action.text.slice(0, HISTORY_TEXT_LONG), ts: action.ts, byAgent: true };
    if (!item) return;
    const history = [...(rec.history[ws] ?? []), item].slice(-HISTORY_KEPT);
    this.received = { ...this.received, [keyOf(rec.owner, rec.id)]: { ...rec, history: { ...rec.history, [ws]: history } } };
    this.saveReceived();
  }

  // ---------------------------------------------------------------- state and files

  private publishGrants(): void {
    this.dispatch({ type: 'fshare_grants', grants: this.grants });
  }

  private publishFolders(): void {
    this.dispatch({ type: 'fshare_folders', folders: Object.values(this.friendFolders) });
  }

  /** Into the shared state: one row per project, and each worktree as a workspace shared with you. */
  private publishReceived(startup: boolean): void {
    const all = Object.values(this.received);
    this.dispatch({ type: 'fshare_projects', projects: all.map(({ history: _h, whole: _w, url: _u, more: _m, ...p }) => p) });
    for (const p of all) {
      for (const w of p.worktrees) {
        const known = this.state.shared.find((s) => s.id === w.id && s.owner === p.owner);
        const ws = { owner: p.owner, id: w.id, name: w.name, project: p.name, ...(w.branch ? { branch: w.branch } : {}), role: p.role, share: shareNameOf(w.id), via: 'mesh' as const, projectId: p.id, ...(p.more?.[w.id] ? { earlier: true } : {}), ...(w.agent ? { agent: w.agent } : {}) };
        if (!known || JSON.stringify(known) !== JSON.stringify(ws)) this.dispatch({ type: 'shared_add', ws });
        this.dispatch({ type: 'roster', id: w.id, members: p.members.map((m) => ({ peerId: m.peerId, role: m.role })) });
        const items = p.history[w.id];
        if (startup && items?.length && !this.state.log.some((l) => l.channel === `ws:${w.id}`)) this.injectHistory(p.owner, w.id, items);
      }
    }
  }

  private load(): void {
    const own = readJson(path.join(this.opts.dir, 'project-shares.json')) as { grants?: unknown; sent?: unknown; folders?: unknown } | undefined;
    if (own && typeof own === 'object') {
      this.grants = (own.grants && typeof own.grants === 'object' ? own.grants : {}) as typeof this.grants;
      this.sent = (own.sent && typeof own.sent === 'object' ? own.sent : {}) as typeof this.sent;
      this.folders = (own.folders && typeof own.folders === 'object' ? own.folders : {}) as typeof this.folders;
    }
    const theirs = readJson(path.join(this.opts.dir, 'shared-projects.json')) as { projects?: unknown; folders?: unknown } | undefined;
    if (theirs && typeof theirs === 'object') {
      const projects = Array.isArray(theirs.projects) ? (theirs.projects as Received[]).filter((p) => p && typeof p.owner === 'string' && typeof p.id === 'string' && Array.isArray(p.worktrees)) : [];
      this.received = Object.fromEntries(projects.map((p) => [keyOf(p.owner, p.id), { ...p, members: p.members ?? [], history: p.history ?? {} }]));
      const folders = Array.isArray(theirs.folders) ? (theirs.folders as FriendFolder[]).filter((f) => f && typeof f.owner === 'string' && typeof f.name === 'string') : [];
      this.friendFolders = Object.fromEntries(folders.map((f) => [keyOf(f.owner, f.name), f]));
    }
  }

  private saveOwn(): void {
    try {
      writeJson(path.join(this.opts.dir, 'project-shares.json'), { grants: this.grants, sent: this.sent, folders: this.folders });
    } catch {
      // Best effort: it's in memory, and said again on the next change.
    }
  }

  private saveReceived(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
    this.saveTimer.unref();
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      writeJson(path.join(this.opts.dir, 'shared-projects.json'), { projects: Object.values(this.received), folders: Object.values(this.friendFolders) });
    } catch {
      // Best effort.
    }
  }
}
