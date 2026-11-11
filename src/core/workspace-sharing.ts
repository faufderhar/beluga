import { defaultAgentOf, wsWireName } from '../protocol.js';
import { placeAgent } from '../shared/agent-picker.js';
import type { BodyInput, BodyOf, GuestCan, WsRole } from '../protocol.js';
import { agentLabel } from '../shared/agent-label.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { ShareService } from './shares.js';
import { type DomainState, type LogItem, type SaidBy, type Store, clean, peerName } from './store.js';
import { shareNameOf } from './workspace-controller.js';
import type { Intent } from './intents.js';

/** What to share with a friend: a project (all its worktrees, now and later), or one worktree (`workspaceId`; `projectId` may come with it). */
export interface FriendShareInput {
  readonly peerId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly role: WsRole;
}

/** What core/friend-share does for WorkspaceSharing. */
export interface FriendSharing {
  shareWithFriend(share: FriendShareInput): void;
  unshareFriend(share: Omit<FriendShareInput, 'role'>): void;
}

export interface SharingDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  readonly shares: ShareService;
  readonly workspaces?: WorkspaceManager;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask the screen to go somewhere, open a dialog or close a tab (see core/intents.ts). */
  readonly intend: (intent: Intent) => void;
}

const HISTORY_ITEMS = 60;
/** How long each message of a room invite's history may be (the room's ws_invite takes no more). */
const HISTORY_TEXT = 8000;
const wsIdOf = (channel: string): string | undefined => (channel.startsWith('ws:') ? channel.slice(3) : undefined);

/** A short, plain-text version of the recent conversation for someone joining: its last `limit` messages, each up to `max` characters. */
export function historyFor(log: readonly LogItem[], channel: string, nameOf: (id: string) => string, limit = HISTORY_ITEMS, max = HISTORY_TEXT): Array<{ from: string; text: string; ts: number; byAgent: boolean }> {
  return log
    .filter((l) => l.channel === channel && (l.type === 'chat' || (l.type === 'agent' && l.status === 'done')))
    .slice(-limit)
    .map((l) =>
      l.type === 'chat'
        ? { from: nameOf(l.from), text: l.text.slice(0, max), ts: l.ts, byAgent: l.byAgent }
        : { from: l.type === 'agent' ? agentLabel(l.agent, l.ownerName, false) : '', text: l.type === 'agent' ? l.text.slice(0, max) : '', ts: l.ts, byAgent: true },
    );
}

/**
 * Who wrote a line of the conversation someone shared with you, matched to who's in the room by
 * name (screens that draw it as their message use this; the line itself stays "bob: …").
 */
export function saidBy(state: DomainState, owner: string, h: BodyOf<'ws_invite'>['history'][number]): SaidBy {
  const name = clean(h.from).slice(0, 80);
  const person = h.byAgent ? name.replace(/'s .+$/, '') : name;
  const from = state.peers.find((p) => p.name === person)?.peerId ?? (person === peerName(state, owner) ? owner : `history:${person}`);
  return { from, name, text: clean(h.text), byAgent: h.byAgent, ts: h.ts };
}

/**
 * Share one workspace (its Claude conversation and folder) with people in the room.
 * "contribute" lets them talk to your Claude there (your approval rules still apply);
 * "view" lets them follow along and browse the files. You can remove anyone, any time.
 */
export class WorkspaceSharing {
  constructor(private readonly deps: SharingDeps) {}

  /** People in your workspace (owner side). */
  members(wsId: string): Readonly<Record<string, WsRole>> {
    return this.deps.store.getState().members[wsId] ?? {};
  }

  /** The workspace shared with you that a channel belongs to (member side). */
  sharedFor(channel: string) {
    const id = wsIdOf(channel);
    return id ? this.deps.store.getState().shared.find((w) => w.id === id) : undefined;
  }

  /** Everyone besides you who should receive a message in this channel. */
  recipients(channel: string): string[] {
    const id = wsIdOf(channel);
    if (!id) return [];
    const self = this.deps.selfId();
    const shared = this.sharedFor(channel);
    if (shared) return [shared.owner, ...(this.deps.store.getState().roster[id] ?? []).map((m) => m.peerId)].filter((p) => p !== self);
    return Object.keys(this.members(id));
  }

  /**
   * May `from`'s agent write this turn into this channel? The owner's always; a contributor's own
   * agent too, for its own asks (a guest's "@claude" in a friend's worktree), never for someone else's.
   */
  agentMayWrite(from: string, channel: string, requester: string): boolean {
    if (from === this.deps.selfId() || this.sharedFor(channel)?.owner === from) return true;
    return wsIdOf(channel) !== undefined && requester === from && this.canPost(from, channel);
  }

  /** May `from` post into (or ask Claude in) this channel? */
  canPost(from: string, channel: string): boolean {
    const id = wsIdOf(channel);
    if (!id) return true;
    if (from === this.deps.selfId()) return true;
    const shared = this.sharedFor(channel);
    if (shared) return from === shared.owner || (this.deps.store.getState().roster[id] ?? []).some((m) => m.peerId === from && m.role === 'contribute');
    return this.members(id)[from] === 'contribute';
  }

  /** May `from` see this channel's events at all? (viewers included) */
  canSee(from: string, channel: string): boolean {
    const id = wsIdOf(channel);
    if (!id || from === this.deps.selfId()) return true;
    const shared = this.sharedFor(channel);
    if (shared) return from === shared.owner || (this.deps.store.getState().roster[id] ?? []).some((m) => m.peerId === from);
    return this.members(id)[from] !== undefined;
  }

  // -------------------------------------------------------------- owner side

  /** `quiet` skips the toast (e.g. a whole project at once); `can` tells people invited by link what they may do. */
  invite(wsId: string, peerId: string, role: WsRole, opts: { quiet?: boolean; can?: GuestCan } = {}): boolean {
    const state = this.deps.store.getState();
    const ws = this.deps.workspaces?.find(wsId);
    const peer = state.peers.find((p) => p.peerId === peerId);
    if (!ws || !peer || peerId === this.deps.selfId()) return false;
    this.deps.store.dispatch({ type: 'member_set', id: wsId, peerId, role });
    this.syncShare(wsId);
    const project = state.projects.find((p) => p.id === ws.projectId)?.name ?? '';
    const history = historyFor(state.log, `ws:${wsId}`, (id) => peerName(state, id));
    this.deps.send({ kind: 'ws_invite', ws: { id: wsId, name: wsWireName(ws.name), project, ...(ws.branch ? { branch: ws.branch } : {}), agent: placeAgent(ws, defaultAgentOf(state.self)) }, role, ...(opts.can ? { can: opts.can } : {}), share: shareNameOf(wsId), history }, { to: peerId });
    this.broadcastRoster(wsId);
    this.onChange?.();
    if (!opts.quiet) this.deps.toast(`${peer.name} ${role === 'contribute' ? 'can now work with you' : 'can now follow along'} in ${ws.name}`, 'success');
    return true;
  }

  remove(wsId: string, peerId: string, quiet = false): void {
    if (!this.members(wsId)[peerId]) return;
    this.deps.store.dispatch({ type: 'member_set', id: wsId, peerId });
    this.syncShare(wsId);
    this.deps.send({ kind: 'ws_leave', id: wsId }, { to: peerId });
    this.broadcastRoster(wsId);
    this.onChange?.();
    if (!quiet) this.deps.toast(`${peerName(this.deps.store.getState(), peerId)} was removed from the workspace`, 'success');
  }

  /** Called when who's in your workspaces changes (guests' contacts follow it). */
  onChange?: () => void;

  /** Sharing with friends over the network (core/friend-share), while it runs. */
  friends?: FriendSharing;

  /**
   * Share a project (or one worktree) with a friend over the network: it shows in their Projects
   * with your avatar, its worktrees under it, and stays there while either of you is offline.
   */
  shareWithFriend(share: FriendShareInput): void {
    if (!this.friends) throw new Error('Sharing with friends needs the Beluga network: turn it on in Settings › Network');
    this.friends.shareWithFriend(share);
  }

  /** Stop sharing a project (or one worktree) with a friend. */
  unshareFriend(share: Omit<FriendShareInput, 'role'>): void {
    if (!this.friends) throw new Error('Sharing with friends needs the Beluga network: turn it on in Settings › Network');
    this.friends.unshareFriend(share);
  }

  /** Everyone leaves (e.g. the workspace was archived). */
  removeAll(wsId: string): void {
    for (const peerId of Object.keys(this.members(wsId))) this.remove(wsId, peerId);
  }

  /** Keep the workspace folder's share open to exactly its members. */
  syncShare(wsId: string): void {
    const name = shareNameOf(wsId);
    const share = this.deps.shares.configs.find((s) => s.name === name);
    if (share) this.deps.shares.upsert({ ...share, allowed: Object.keys(this.members(wsId)) });
  }

  private broadcastRoster(wsId: string): void {
    const members = Object.entries(this.members(wsId)).map(([peerId, role]) => ({ peerId, role }));
    for (const m of members) this.deps.send({ kind: 'ws_roster', id: wsId, members }, { to: m.peerId });
  }

  // ------------------------------------------------------------- member side

  onInvite(from: string, body: BodyOf<'ws_invite'>): void {
    const state = this.deps.store.getState();
    // Workspace ids are random; refuse one that collides with your own or with one someone else shared.
    if (this.deps.workspaces?.find(body.ws.id)) return;
    if (state.shared.some((w) => w.id === body.ws.id && w.owner !== from)) return;
    this.deps.store.dispatch({
      type: 'shared_add',
      ws: { owner: from, id: body.ws.id, name: clean(body.ws.name), project: clean(body.ws.project), branch: body.ws.branch ? clean(body.ws.branch) : undefined, role: body.role, ...(body.can ? { can: body.can } : {}), share: body.share, ...(body.ws.agent ? { agent: body.ws.agent } : {}) },
    });
    const channel = `ws:${body.ws.id}`;
    this.deps.store.dispatch({ type: 'clear', channel });
    for (const [i, h] of body.history.entries()) {
      this.deps.store.dispatch({ type: 'system', text: `${clean(h.from)}: ${clean(h.text)}`, channel, said: saidBy(state, from, h) });
      if (i > HISTORY_ITEMS) break;
    }
    // Came in with a link: go straight to the first workspace you were let into.
    if (this.deps.store.getState().self?.guest) this.deps.intend({ type: 'navigate', view: { kind: 'shared', owner: from, id: body.ws.id, tab: 'chat' }, unless: 'shared' });
    this.deps.toast(`${peerName(state, from)} invited you to ${clean(body.ws.name)}${body.role === 'view' ? ' (to follow along)' : ''}. It's in Projects`, 'success');
  }

  onRoster(from: string, body: BodyOf<'ws_roster'>): void {
    const shared = this.deps.store.getState().shared.find((w) => w.id === body.id && w.owner === from);
    if (!shared) return;
    this.deps.store.dispatch({ type: 'roster', id: body.id, members: body.members });
    const me = body.members.find((m) => m.peerId === this.deps.selfId());
    if (me && me.role !== shared.role) this.deps.store.dispatch({ type: 'shared_add', ws: { ...shared, role: me.role } });
  }

  onLeave(from: string, body: BodyOf<'ws_leave'>): void {
    const state = this.deps.store.getState();
    const shared = state.shared.find((w) => w.id === body.id && w.owner === from);
    if (shared) {
      this.deps.store.dispatch({ type: 'shared_remove', owner: from, id: body.id });
      this.deps.intend({ type: 'close_tab', id: body.id });
      this.deps.toast(`You're no longer in ${shared.name}`, 'warn');
      return;
    }
    // A member left one of your workspaces.
    if (this.members(body.id)[from]) {
      this.deps.store.dispatch({ type: 'member_set', id: body.id, peerId: from });
      this.syncShare(body.id);
      this.broadcastRoster(body.id);
      this.onChange?.();
    }
  }

  /** Leave a workspace someone shared with you. */
  leave(owner: string, id: string): void {
    this.deps.send({ kind: 'ws_leave', id }, { to: owner });
    this.deps.store.dispatch({ type: 'shared_remove', owner, id });
    this.deps.intend({ type: 'close_tab', id });
  }
}
