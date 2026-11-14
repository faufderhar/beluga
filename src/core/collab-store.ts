import type { AgentRef, ClaudeQuestion, GuestCan, WsRole } from '../protocol.js';

/** Claude (yours or a friend's) is waiting for an answer from you. */
export interface PendingQuestion {
  readonly qid: string;
  readonly requestId: string;
  /** Whose Claude is asking. */
  readonly owner: string;
  readonly channel: string;
  readonly question: ClaudeQuestion;
  /** Answers picked so far, for multi-question prompts (question text → answer). */
  readonly picked: Readonly<Record<string, string>>;
}

/** A workspace someone shared with you. */
export interface SharedWorkspace {
  readonly owner: string;
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly branch?: string;
  readonly role: WsRole;
  /** Invited by link: what you may do there. */
  readonly can?: GuestCan;
  /** The owner's share for its folder. */
  readonly share: string;
  /** Shared over the network by a friend (core/friend-share), not through today's room: it stays while the room is gone. */
  readonly via?: 'mesh';
  /** Over the network: the owner's project it belongs to. */
  readonly projectId?: string;
  /** Over the network: there's earlier conversation to scroll back to (BLG-259). */
  readonly earlier?: boolean;
  /** The owner's agent that runs there (BLG-448): theirs, never yours. Unset: an older Mac's, Claude. */
  readonly agent?: AgentRef;
  /** Over the network: a plain chat of the owner's (no project folder): only its conversation and Scratch. */
  readonly chat?: true;
}

export interface RosterEntry {
  readonly peerId: string;
  readonly role: WsRole;
}

/** A folder someone shared with just you (or a few people). */
export interface Offer {
  readonly owner: string;
  readonly name: string;
  readonly writable: boolean;
}

/** A link you made that lets someone into one project (or the whole room). Its secret stays in ProjectInvites. */
export interface ProjectLink {
  readonly id: string;
  /** A project id, or 'room' for everything. */
  readonly scope: string;
  /** "bob-api", or "everything". */
  readonly label: string;
  readonly can: GuestCan;
  /** People wait at the door until you let them in. */
  readonly knock: boolean;
  readonly singleUse: boolean;
  readonly expiresAt?: number;
  readonly createdAt: number;
  /** How many people came to the door with it. */
  readonly used: number;
}

/** Someone who came in with a link: what they were invited to and what they can do. */
export interface Guest {
  readonly peerId: string;
  readonly name: string;
  /** Project ids they're in. */
  readonly projects: readonly string[];
  /** Invited to everything: the room chat and what you share, like any member. */
  readonly room: boolean;
  readonly can: GuestCan;
}

/** Someone at the door with one of your links. */
export interface Knock {
  readonly peerId: string;
  readonly linkId: string;
  readonly ts: number;
}

/** One line of the virtual shell's output; `open` makes it clickable (a folder or file path in the share). */
export interface ShellLine {
  readonly text: string;
  readonly tone?: 'dir' | 'file' | 'error' | 'muted' | 'match';
  readonly open?: string;
  readonly dir?: boolean;
}

export interface ShellEntry {
  readonly id: number;
  readonly cwd: string;
  readonly cmd: string;
  readonly out: readonly ShellLine[];
}

/** A guest's read-only shell over a shared workspace's files. */
export interface ShellState {
  readonly cwd: string;
  readonly entries: readonly ShellEntry[];
  readonly busy: boolean;
}

export interface CollabState {
  /** Links you made for projects (owner side). */
  readonly links: readonly ProjectLink[];
  /** People who came in with a link (owner side). */
  readonly guests: Readonly<Record<string, Guest>>;
  /** People waiting at the door (owner side). */
  readonly knocks: readonly Knock[];
  /** Virtual shells per shared workspace (guest side). */
  readonly shells: Readonly<Record<string, ShellState>>;
  /** Folders shared only with you. */
  readonly offers: readonly Offer[];
  readonly questions: readonly PendingQuestion[];
  /** Whether the room you host takes new people. */
  readonly roomOpen: boolean;
  /** Workspaces others shared with you. */
  readonly shared: readonly SharedWorkspace[];
  /** Your workspaces' members (workspace id → peer → role). */
  readonly members: Readonly<Record<string, Readonly<Record<string, WsRole>>>>;
  /** Who's in a workspace shared with you (as told by its owner). */
  readonly roster: Readonly<Record<string, readonly RosterEntry[]>>;
  /** Channels where the next request to Claude plans first. */
  readonly planMode: Readonly<Record<string, boolean>>;
  /** New people you haven't picked a trust level for yet (shown as a one-click card). */
  readonly trustPrompts: readonly string[];
  /** How much each friend trusts you (as they told you; their side enforces it). */
  readonly granted: Readonly<Record<string, { level: 'blocked' | 'ask' | 'trusted' | 'full'; reach: 'folder' | 'full' }>>;
}

export type CollabAction =
  | { type: 'question_add'; question: PendingQuestion }
  | { type: 'question_pick'; qid: string; question: string; answer: string }
  | { type: 'question_remove'; qid: string; unanswered?: true }
  | { type: 'room_open'; open: boolean }
  | { type: 'shared_add'; ws: SharedWorkspace }
  | { type: 'shared_remove'; owner: string; id: string }
  | { type: 'member_set'; id: string; peerId: string; role?: WsRole }
  | { type: 'roster'; id: string; members: readonly RosterEntry[] }
  | { type: 'plan_mode'; channel: string; on: boolean }
  | { type: 'peer_gone'; peerIds: readonly string[] }
  /** You left the room: everything shared with you in it goes (what friends shared over the network stays). */
  | { type: 'shared_clear' }
  | { type: 'offer'; offer: Offer; active: boolean }
  | { type: 'trust_prompt'; peerId: string; show: boolean }
  | { type: 'granted'; peerId: string; grant: CollabState['granted'][string] }
  | { type: 'link_set'; link: ProjectLink }
  | { type: 'link_remove'; id: string }
  | { type: 'guest_set'; peerId: string; guest?: Guest }
  | { type: 'knock'; knock: Knock; show: boolean }
  | { type: 'guest_shell'; id: string; shell?: ShellState };

export const initialCollab: CollabState = { links: [], guests: {}, knocks: [], shells: {}, offers: [], questions: [], roomOpen: true, shared: [], members: {}, roster: {}, planMode: {}, trustPrompts: [], granted: {} };

const MAX_QUESTIONS = 20;

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export function reduceCollab(state: CollabState, action: CollabAction): CollabState {
  switch (action.type) {
    case 'question_add':
      if (state.questions.some((q) => q.qid === action.question.qid)) return state;
      return { ...state, questions: [...state.questions, action.question].slice(-MAX_QUESTIONS) };
    case 'question_pick':
      return { ...state, questions: state.questions.map((q) => (q.qid === action.qid ? { ...q, picked: { ...q.picked, [action.question]: action.answer } } : q)) };
    case 'question_remove':
      return { ...state, questions: state.questions.filter((q) => q.qid !== action.qid) };
    case 'room_open':
      return { ...state, roomOpen: action.open };
    case 'shared_add':
      return { ...state, shared: [...state.shared.filter((w) => !(w.owner === action.ws.owner && w.id === action.ws.id)), action.ws] };
    case 'shared_remove':
      return { ...state, shared: state.shared.filter((w) => !(w.owner === action.owner && w.id === action.id)), roster: without(state.roster, action.id) };
    case 'member_set': {
      const current = state.members[action.id] ?? {};
      const next = action.role ? { ...current, [action.peerId]: action.role } : without(current, action.peerId);
      return { ...state, members: Object.keys(next).length ? { ...state.members, [action.id]: next } : without(state.members, action.id) };
    }
    case 'roster':
      return { ...state, roster: { ...state.roster, [action.id]: action.members } };
    case 'plan_mode':
      return { ...state, planMode: action.on ? { ...state.planMode, [action.channel]: true } : without(state.planMode, action.channel) };
    case 'shared_clear': {
      const kept = state.shared.filter((w) => w.via === 'mesh');
      const roster = Object.fromEntries(Object.entries(state.roster).filter(([id]) => kept.some((w) => w.id === id)));
      return { ...state, shared: kept, roster, questions: [], offers: [], shells: {} };
    }
    case 'offer': {
      const rest = state.offers.filter((o) => !(o.owner === action.offer.owner && o.name === action.offer.name));
      return { ...state, offers: action.active ? [...rest, action.offer] : rest };
    }
    case 'peer_gone': {
      // Connections drop and come back (same identity), so seats and shares stay; their questions can't be answered.
      const gone = new Set(action.peerIds);
      return { ...state, questions: state.questions.filter((q) => !gone.has(q.owner)), trustPrompts: state.trustPrompts.filter((p) => !gone.has(p)), knocks: state.knocks.filter((k) => !gone.has(k.peerId)) };
    }
    case 'link_set':
      return { ...state, links: [...state.links.filter((l) => l.id !== action.link.id), action.link] };
    case 'link_remove':
      return { ...state, links: state.links.filter((l) => l.id !== action.id) };
    case 'guest_set':
      return { ...state, guests: action.guest ? { ...state.guests, [action.peerId]: action.guest } : without(state.guests, action.peerId) };
    case 'knock': {
      const rest = state.knocks.filter((k) => k.peerId !== action.knock.peerId);
      return { ...state, knocks: action.show ? [...rest, action.knock] : rest };
    }
    case 'guest_shell':
      return { ...state, shells: action.shell ? { ...state.shells, [action.id]: action.shell } : without(state.shells, action.id) };
    case 'trust_prompt': {
      const rest = state.trustPrompts.filter((p) => p !== action.peerId);
      return { ...state, trustPrompts: action.show ? [...rest, action.peerId] : rest };
    }
    case 'granted': {
      const old = state.granted[action.peerId];
      if (old && old.level === action.grant.level && old.reach === action.grant.reach) return state;
      return { ...state, granted: { ...state.granted, [action.peerId]: action.grant } };
    }
  }
}
