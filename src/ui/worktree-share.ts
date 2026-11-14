import type { WsRole } from '../protocol.js';
import type { AppState } from '../core/store.js';
import { cannotTake } from '../net/mesh/features.js';

/**
 * Who a worktree's Share sheet lists (BLG-340): your friends, who get it over the Beluga network
 * with nobody in a room, and anyone in your room who isn't a friend. Each with what they have here.
 */

export type ShareAccess = WsRole | 'none';

export interface WorktreeShareRow {
  readonly peerId: string;
  readonly name: string;
  readonly access: ShareAccess;
  /** How a change reaches them: over your friends' network, or through the room you're both in. */
  readonly via: 'network' | 'room';
  /** They have the whole project (every worktree), not just this one. */
  readonly wholeProject: boolean;
  readonly guest?: boolean;
}

type ShareState = Pick<AppState, 'peers' | 'self' | 'members' | 'network' | 'projectShares' | 'projects'>;

/** What a friend has of this worktree through a project grant. */
function grantFor(state: ShareState, projectId: string | undefined, wsId: string, peerId: string): { role: WsRole; whole: boolean } | undefined {
  const g = projectId ? state.projectShares[projectId]?.[peerId] : undefined;
  if (!g || (g.only && !g.only.includes(wsId))) return undefined;
  return { role: g.role, whole: !g.only };
}

export function worktreeShareRows(state: ShareState, wsId: string): WorktreeShareRow[] {
  const projectId = state.projects.find((p) => p.workspaces.some((w) => w.id === wsId))?.id;
  const members = state.members[wsId] ?? {};
  const selfId = state.self?.peerId;
  const network = state.network.enabled;
  const rows: WorktreeShareRow[] = [];
  for (const f of state.network.friends) {
    if (f.peerId === selfId) continue;
    const grant = grantFor(state, projectId, wsId, f.peerId);
    const room = members[f.peerId];
    // Shared over the network, it's changed and taken back there (it makes them a member too, BLG-623);
    // a friend already in it only through the room stays on the room's way until they're removed.
    const via = grant ? 'network' : room || !network ? 'room' : 'network';
    rows.push({ peerId: f.peerId, name: f.name, access: room ?? grant?.role ?? 'none', via, wholeProject: Boolean(grant?.whole) });
  }
  for (const p of state.peers) {
    if (p.peerId === selfId || rows.some((r) => r.peerId === p.peerId)) continue;
    rows.push({ peerId: p.peerId, name: p.name, access: members[p.peerId] ?? 'none', via: 'room', wholeProject: false, ...(p.guest ? { guest: true } : {}) });
  }
  return rows;
}

/** Someone a worktree of yours is shared with, for its mark in the sidebar. */
export interface SharedWithPerson {
  readonly peerId: string;
  readonly name: string;
  readonly role: WsRole;
}

/**
 * Who has this worktree now: friends it's shared with over the network (on its own or with its whole
 * project), people from your room you let in, and anyone else still in its members. Empty: only you.
 */
export function worktreeSharedWith(state: ShareState, wsId: string): readonly SharedWithPerson[] {
  const people: SharedWithPerson[] = worktreeShareRows(state, wsId).flatMap((r) => (r.access === 'none' ? [] : [{ peerId: r.peerId, name: r.name, role: r.access }]));
  for (const [peerId, role] of Object.entries(state.members[wsId] ?? {})) {
    if (peerId !== state.self?.peerId && !people.some((p) => p.peerId === peerId)) people.push({ peerId, name: 'someone', role });
  }
  return people;
}

/** What a shared worktree's mark says: "Shared with Bran", "Shared with Bran and Mia", "Shared with Bran and 2 others". */
export function sharedWithWords(people: readonly Pick<SharedWithPerson, 'name'>[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 2) return `Shared with ${names.join(' and ')}`;
  return `Shared with ${names[0]} and ${names.length - 1} others`;
}

/** What one row's line under the name says, about a worktree's sheet or a chat's (`what`). */
export function shareRowDetail(row: WorktreeShareRow, inRoom: boolean, what: 'worktree' | 'chat' = 'worktree'): string {
  if (row.access === 'contribute') return row.wholeProject ? 'Works with your agent across the whole project' : 'Chats and asks your agent here';
  if (row.access === 'view') return row.wholeProject ? 'Follows the whole project, read-only' : 'Follows along, read-only';
  if (row.guest) return 'Guest';
  return inRoom ? `In your room, not in this ${what}` : `Not in this ${what}`;
}

/** Someone a worktree can be handed to (BLG-341): in your room with their Claude, or a friend over the network. */
export interface HandoffPerson {
  readonly peerId: string;
  readonly name: string;
  readonly via: 'room' | 'network';
  readonly online: boolean;
  /** Why it can't go to them (their Beluga is too old); undefined when it can. */
  readonly why?: string;
}

export function handoffPeople(state: Pick<AppState, 'peers' | 'self' | 'network'>): HandoffPerson[] {
  const selfId = state.self?.peerId;
  const room: HandoffPerson[] = state.peers.filter((p) => p.peerId !== selfId && p.agent).map((p) => ({ peerId: p.peerId, name: p.name, via: 'room', online: true }));
  if (!state.network.enabled) return room;
  const friends: HandoffPerson[] = state.network.friends
    .filter((f) => f.peerId !== selfId && !state.peers.some((p) => p.peerId === f.peerId))
    .map((f) => {
      const why = cannotTake(f.name, f.beluga, 'share.handoff', f.online);
      return { peerId: f.peerId, name: f.name, via: 'network', online: f.online, ...(why ? { why } : {}) };
    });
  return [...room, ...friends];
}
