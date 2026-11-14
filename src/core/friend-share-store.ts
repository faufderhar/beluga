import type { AgentRef } from '../protocol.js';
import type { WsRole } from '../protocol.js';

/**
 * Sharing with friends over the network (core/friend-share) in the shared state: the projects
 * friends shared with you (one row per project in Projects, kept while they're offline), who you
 * shared your own projects with, the folders friends share with you, and messages waiting for a
 * friend's Mac. Browser-safe: the Mac app and the phone run it.
 */

/** One of a shared project's worktrees, as its owner said. */
export interface SharedWorktree {
  readonly id: string;
  readonly name: string;
  readonly branch?: string;
  /** The owner's agent that runs it (BLG-448). */
  readonly agent?: AgentRef;
}

/** A project a friend shared with you over the network (receiver side). */
export interface SharedProject {
  readonly owner: string;
  readonly ownerName: string;
  readonly id: string;
  readonly name: string;
  /** The project's icon (a small image, base64), when it has one. */
  readonly icon?: { readonly mime: string; readonly data: string };
  readonly role: WsRole;
  readonly worktrees: readonly SharedWorktree[];
  /** The others it's shared with (and their role), as the owner said. */
  readonly members: ReadonlyArray<{ readonly peerId: string; readonly name: string; readonly role: WsRole }>;
  readonly updatedAt: number;
  /** Shared whole: your own copy of it (BLG-258), while it's made and once it's in your Projects. */
  readonly copy?: SharedCopy;
  /** The owner's plain chats (no project folder), each shared on its own: no copy, no fork. */
  readonly chats?: true;
}

/** Your copy of a project a friend shared whole: where it goes, and how far it got. */
export interface SharedCopy {
  readonly state: 'copying' | 'ready' | 'failed';
  /** Its folder on this Mac. */
  readonly path?: string;
  /** Its id in your Projects, once it's there. */
  readonly projectId?: string;
  readonly error?: string;
}

/**
 * Your fork of a friend's worktree on this Mac (BLG-312): its project being got here first (a
 * clone, or a copy from their Mac), asked for, coming over, made (`wsId`, the worktree of yours it
 * became), or it failed (why).
 */
export interface SharedFork {
  readonly state: 'preparing' | 'asking' | 'copying' | 'ready' | 'failed';
  readonly wsId?: string;
  readonly error?: string;
  /** While copying: bytes of its pack here so far, of all of them (all here: it's being set up). */
  readonly received?: number;
  readonly total?: number;
  /** Files in the pack (uncommitted ones and Scratch), when their Mac said. */
  readonly files?: number;
}

/** Who one of your projects is shared with (owner side): `only` limits it to those worktrees. */
export interface ProjectGrant {
  readonly role: WsRole;
  readonly only?: readonly string[];
}

/** A folder a friend shares with you over the network. */
export interface FriendFolder {
  readonly owner: string;
  readonly ownerName: string;
  /** The owner's share name for it (what files are read from). */
  readonly name: string;
  /** What it's called (its folder's name). */
  readonly label: string;
  readonly writable: boolean;
  readonly since: number;
}

export interface FriendShareSlice {
  readonly sharedProjects: readonly SharedProject[];
  /** Your projects shared with friends: project id → friend → grant. */
  readonly projectShares: Readonly<Record<string, Readonly<Record<string, ProjectGrant>>>>;
  readonly friendFolders: readonly FriendFolder[];
  /** Messages for a friend's worktree, by request id: waiting for their Mac, or delivered after waiting. */
  readonly delivery: Readonly<Record<string, 'waiting' | 'delivered'>>;
  /** Forks of friends' worktrees, by their worktree's id. */
  readonly forks: Readonly<Record<string, SharedFork>>;
}

export const initialFriendShare: FriendShareSlice = { sharedProjects: [], projectShares: {}, friendFolders: [], delivery: {}, forks: {} };

export type FriendShareAction =
  | { type: 'fshare_projects'; projects: readonly SharedProject[] }
  | { type: 'fshare_grants'; grants: FriendShareSlice['projectShares'] }
  | { type: 'fshare_folders'; folders: readonly FriendFolder[] }
  | { type: 'fshare_delivery'; id: string; state: 'waiting' | 'delivered' }
  | { type: 'fshare_fork'; id: string; fork: SharedFork };

/** Delivery states kept (the oldest go first). */
const DELIVERY_KEPT = 200;

export function reduceFriendShare(state: FriendShareSlice, action: FriendShareAction): FriendShareSlice {
  switch (action.type) {
    case 'fshare_projects':
      return { ...state, sharedProjects: action.projects };
    case 'fshare_grants':
      return { ...state, projectShares: action.grants };
    case 'fshare_folders':
      return { ...state, friendFolders: action.folders };
    case 'fshare_fork':
      return { ...state, forks: { ...state.forks, [action.id]: action.fork } };
    case 'fshare_delivery': {
      if (state.delivery[action.id] === action.state) return state;
      const { [action.id]: _old, ...rest } = state.delivery;
      const entries = [...Object.entries(rest), [action.id, action.state] as const].slice(-DELIVERY_KEPT);
      return { ...state, delivery: Object.fromEntries(entries) };
    }
  }
}

/** The shared project a worktree belongs to (receiver side). */
export const sharedProjectOf = (state: Pick<FriendShareSlice, 'sharedProjects'>, wsId: string): SharedProject | undefined => state.sharedProjects.find((p) => p.worktrees.some((w) => w.id === wsId));
