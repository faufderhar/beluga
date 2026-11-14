import { type RuntimeChoice, runtimeChoices } from '../shared/agent-runtimes.js';
import type { NoticeKind, NoticeTag } from './notify.js';
import type { ArchivePhase } from '../workspaces/archive.js';
import type { Settings } from './settings.js';
import { type EnvKeys, NO_ENV_KEYS } from '../shared/env-vars.js';
import type { ShellChoice } from '../shared/shells.js';
import type { TermVisual } from '../shared/term-visuals.js';

/** Something that happened while you were looking elsewhere (the inbox). */
export interface Notice {
  readonly id: number;
  readonly kind: NoticeKind;
  /** What exactly happened, when the kind alone doesn't say (an approval, a plan, someone leaving…). */
  readonly tag?: NoticeTag;
  /** The approval or question it's about (answered: no longer unread). */
  readonly ref?: string;
  readonly title: string;
  readonly body: string;
  readonly channel?: string;
  /** The plan it's about (and its task there, by id): the bell groups a plan's quiet notices under it. */
  readonly plan?: string;
  readonly planTask?: string;
  /** What waits for you that it's about (see NoticeEvent.need). */
  readonly need?: string;
  /** What happened, once (see NoticeEvent.key). */
  readonly key?: string;
  readonly ts: number;
  readonly read: boolean;
}

/** A model you can pick for a conversation. */
export interface ModelChoice {
  /** Passed to Claude Code (an alias like "sonnet", or a full id); '' = Claude Code's default. */
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly efforts?: readonly string[];
}

/** One CI check on a pull request (a GitHub Actions job or an external status). */
export interface PrCheck {
  readonly name: string;
  /** The workflow it belongs to, when it's an Actions job. */
  readonly workflow?: string;
  readonly state: 'queued' | 'in_progress' | 'completed';
  /** How it ended (once completed): success, failure, cancelled, skipped, neutral, timed_out, error… */
  readonly conclusion?: string;
  readonly url?: string;
  /** ISO times from GitHub. */
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** One comment on a pull request: in its conversation, a review's summary, or in a thread on a line. */
export interface PrComment {
  /** GitHub's node id. */
  readonly id: string;
  readonly author: string;
  readonly body: string;
  /** ms since epoch. */
  readonly at: number;
  readonly url: string;
  /** It's yours (the account gh is logged in as). */
  readonly mine?: boolean;
}

/** A review's verdict, with what it said (a review with only line comments shows up as its threads). */
export interface PrReview extends PrComment {
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
}

/** A conversation on lines of code: where, the diff around it, and its comments, oldest first. */
export interface PrThread {
  readonly id: string;
  readonly path: string;
  /** The line it's on (the last of a range), in the file as the PR has it; missing once outdated. */
  readonly line?: number;
  readonly startLine?: number;
  /** Where it was when written (outdated threads keep only this). */
  readonly originalLine?: number;
  readonly originalStartLine?: number;
  /** The diff hunk GitHub shows above the first comment (ends at the commented line). */
  readonly diffHunk?: string;
  readonly resolved: boolean;
  /** The code it's on has changed since. */
  readonly outdated: boolean;
  readonly comments: readonly PrComment[];
}

/** Everyone's words on a pull request. */
export interface PrConversation {
  readonly number: number;
  readonly url: string;
  readonly comments: readonly PrComment[];
  readonly reviews: readonly PrReview[];
  readonly threads: readonly PrThread[];
  /** GitHub has more than were read (open it there for the rest). */
  readonly more?: boolean;
}

/** A pull request for a worktree's branch, as `gh` reports it. */
export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly title: string;
  readonly draft: boolean;
  /** Combined CI state. */
  readonly checks: 'passing' | 'failing' | 'pending' | 'none';
  /** Each check behind `checks` (missing in PRs saved before they were kept). */
  readonly checkRuns?: readonly PrCheck[];
  readonly review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  /** GitHub says it conflicts with its base (open PRs only). */
  readonly conflicts?: boolean;
  /** Auto-merge is on: GitHub merges it once its checks and reviews pass. */
  readonly autoMerge?: boolean;
  /** GitHub's merge state, when it stands in the way (open PRs only): behind its base (the base needs merging in first), or blocked by the base's rules. */
  readonly mergeState?: 'behind' | 'blocked';
  /** Its head commit (headRefOid). */
  readonly head?: string;
  /** When it merged (ms), merged PRs only. */
  readonly mergedAt?: number;
  /** Someone's fork's pull request, checked out here by its number (BLG-948). */
  readonly fork?: PrFork;
}

/** Where a fork's pull request lives, and whether its author lets the repository's maintainers push to it. */
export interface PrFork {
  readonly owner: string;
  readonly repo: string;
  /** Its branch on the fork. */
  readonly branch: string;
  /** "Allow edits by maintainers" is on: a push to the fork's branch updates the pull request. */
  readonly canPush: boolean;
}

export interface SetupRun {
  readonly status: 'running' | 'done' | 'failed';
  readonly command: string;
  readonly detail?: string;
}

export interface SearchHit {
  readonly channel: string;
  readonly place: string;
  readonly who: string;
  readonly text: string;
  /** Where the match starts in `text`. */
  readonly at: number;
  readonly ts: number;
  /** The item it was found in: the row a chat opens at, whatever time it draws that row at. */
  readonly id?: string;
  readonly archived?: boolean;
}

export interface SearchState {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly searched: number;
}

/** A saved way to start a task. */
export interface Template {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** Plan first. */
  readonly plan?: boolean;
  readonly builtIn?: boolean;
}

/** Who drives a conversation from its terminal (BLG-534). */
export interface AgentTermState {
  /** 'claude', 'codex' or 'local'. */
  readonly runtime: string;
  /** The agent, as people read it ("Claude", "Codex", a local model's name). */
  readonly label: string;
  readonly since: number;
}

/** Visuals kept per workspace for its terminal's links. */
export const MAX_TERM_VISUALS = 300;

export interface WorkState {
  readonly inbox: readonly Notice[];
  readonly models: readonly ModelChoice[];
  /** The agent picker's runtimes (BLG-446): which run on this Mac, and why the others don't. */
  readonly runtimes: readonly RuntimeChoice[];
  /** Folder size in bytes per workspace (worktrees and chats). */
  readonly disk: Readonly<Record<string, number>>;
  /** Worktrees being archived now, and how far along (see workspaces/archive.ts). */
  readonly archiving: Readonly<Record<string, ArchivePhase>>;
  readonly prs: Readonly<Record<string, PullRequest>>;
  readonly setup: Readonly<Record<string, SetupRun>>;
  readonly search: SearchState;
  readonly templates: readonly Template[];
  /** Terminal programs running or kept after they ended (id → its title). */
  readonly terminals: Readonly<Record<string, string>>;
  /** Terminal programs that ended (id → exit code; null: killed or couldn't start). */
  readonly termExits: Readonly<Record<string, number | null>>;
  /** Names you gave terminals (id → name), kept while the terminal is. */
  readonly termNames: Readonly<Record<string, string>>;
  /** Running terminals that started before you changed their variables (Settings › Environment): a restart gives them the new ones. */
  readonly termEnvStale: readonly string[];
  /** Conversations the agent's own terminal is driving now (workspace id → which agent, since when), BLG-534. */
  readonly agentTerms: Readonly<Record<string, AgentTermState>>;
  /** The visuals each workspace's terminal showed (links in it open them), newest last. */
  readonly termVisuals: Readonly<Record<string, readonly TermVisual[]>>;
  /** Shells installed on this computer, for picking the terminal's shell. */
  readonly shellChoices: readonly ShellChoice[];
  /** Names of the environment variables you set (never their values). */
  readonly envKeys: EnvKeys;
  /** You customized the pull request instructions. */
  readonly prCustom: boolean;
  /** The GitHub CLI is installed and signed in (undefined: not checked yet). */
  readonly gh?: boolean;
  /** People you picked a trust level for in earlier sessions. */
  readonly remembered: Settings['people'];
}

export type WorkAction =
  /** `ts` is stamped before reducing (see stampAction in store.ts). */
  | { type: 'notice_add'; notice: Omit<Notice, 'id' | 'ts' | 'read'>; ts?: number; read?: boolean }
  | { type: 'notice_read'; channel?: string; id?: number }
  /** Mark one notice unread again. */
  | { type: 'notice_unread'; id: number }
  /** Clear one notice, or all of them. */
  | { type: 'notice_clear'; id?: number }
  | { type: 'models'; models: readonly ModelChoice[] }
  | { type: 'runtimes'; runtimes: readonly RuntimeChoice[] }
  | { type: 'disk'; sizes: Readonly<Record<string, number>> }
  /** No phase: done (or it failed). */
  | { type: 'archiving'; id: string; phase?: ArchivePhase }
  | { type: 'pr'; id: string; pr?: PullRequest }
  | { type: 'setup'; id: string; run?: SetupRun }
  | { type: 'search'; search: Partial<SearchState> }
  | { type: 'templates'; templates: readonly Template[] }
  | { type: 'terminal'; id: string; title?: string }
  | { type: 'terminal_exit'; id: string; code: number | null }
  /** Name a terminal (no name: back to Shell N). */
  | { type: 'terminal_name'; id: string; name?: string }
  | { type: 'terminal_env_stale'; ids: readonly string[] }
  /** The agent's terminal opened on a conversation (state), or closed (none). */
  | { type: 'agent_term'; id: string; state?: AgentTermState }
  /** Visuals a workspace's terminal showed: these join the list (or replace it, with `all`). */
  | { type: 'term_visuals'; id: string; visuals: readonly TermVisual[]; all?: boolean }
  | { type: 'shell_choices'; shells: readonly ShellChoice[] }
  | { type: 'env_keys'; keys: EnvKeys }
  | { type: 'pr_custom'; custom: boolean }
  | { type: 'gh'; ok: boolean }
  | { type: 'remembered'; people: Settings['people'] };

export const FALLBACK_MODELS: readonly ModelChoice[] = [
  { value: '', label: 'Default', description: "Claude Code's choice" },
  { value: 'opus', label: 'Opus', description: 'most capable, for complex work' },
  { value: 'sonnet', label: 'Sonnet', description: 'fast and very capable' },
  { value: 'haiku', label: 'Haiku', description: 'fastest, for quick tasks' },
];

export const initialWork: WorkState = {
  inbox: [],
  models: FALLBACK_MODELS,
  runtimes: runtimeChoices((id) => (id === 'claude' ? {} : undefined)),
  disk: {},
  archiving: {},
  prs: {},
  setup: {},
  search: { query: '', hits: [], searched: 0 },
  templates: [],
  terminals: {},
  termExits: {},
  termNames: {},
  termEnvStale: [],
  agentTerms: {},
  termVisuals: {},
  shellChoices: [],
  envKeys: NO_ENV_KEYS,
  prCustom: false,
  remembered: {},
};

const INBOX_LIMIT = 100;

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export function reduceWork(state: WorkState, action: WorkAction): WorkState {
  switch (action.type) {
    case 'notice_add': {
      const id = (state.inbox[0]?.id ?? 0) + 1;
      return { ...state, inbox: [{ ...action.notice, id, ts: action.ts ?? 0, read: action.read ?? false }, ...state.inbox].slice(0, INBOX_LIMIT) };
    }
    case 'notice_read':
      return {
        ...state,
        inbox: state.inbox.map((n) => (n.read || (action.id !== undefined ? n.id !== action.id : action.channel !== undefined && n.channel !== action.channel) ? n : { ...n, read: true })),
      };
    case 'notice_unread':
      return state.inbox.some((n) => n.id === action.id && n.read) ? { ...state, inbox: state.inbox.map((n) => (n.id === action.id ? { ...n, read: false } : n)) } : state;
    case 'notice_clear':
      if (action.id === undefined) return state.inbox.length ? { ...state, inbox: [] } : state;
      return state.inbox.some((n) => n.id === action.id) ? { ...state, inbox: state.inbox.filter((n) => n.id !== action.id) } : state;
    case 'models':
      return { ...state, models: action.models.length ? action.models : FALLBACK_MODELS };
    case 'runtimes':
      return { ...state, runtimes: action.runtimes };
    case 'disk':
      return { ...state, disk: { ...state.disk, ...action.sizes } };
    case 'archiving':
      return { ...state, archiving: action.phase ? { ...state.archiving, [action.id]: action.phase } : without(state.archiving, action.id) };
    case 'pr':
      return { ...state, prs: action.pr ? { ...state.prs, [action.id]: action.pr } : without(state.prs, action.id) };
    case 'setup':
      return { ...state, setup: action.run ? { ...state.setup, [action.id]: action.run } : without(state.setup, action.id) };
    case 'search':
      return { ...state, search: { ...state.search, ...action.search } };
    case 'templates':
      return { ...state, templates: action.templates };
    case 'pr_custom':
      return { ...state, prCustom: action.custom };
    case 'gh':
      return { ...state, gh: action.ok };
    case 'remembered':
      return { ...state, remembered: action.people };
    case 'terminal': {
      if (action.title !== undefined && state.terminals[action.id] === action.title && !(action.id in state.termExits)) return state;
      const termExits = without(state.termExits, action.id);
      // A closed terminal forgets its name; one that starts again keeps it.
      if (action.title === undefined) return { ...state, termExits, terminals: without(state.terminals, action.id), termNames: without(state.termNames, action.id) };
      return { ...state, termExits, terminals: { ...state.terminals, [action.id]: action.title } };
    }
    case 'terminal_exit':
      return action.id in state.terminals ? { ...state, termExits: { ...state.termExits, [action.id]: action.code } } : state;
    case 'terminal_name':
      if (!(action.id in state.terminals)) return state;
      return { ...state, termNames: action.name ? { ...state.termNames, [action.id]: action.name } : without(state.termNames, action.id) };
    case 'terminal_env_stale':
      return action.ids.join('\0') === state.termEnvStale.join('\0') ? state : { ...state, termEnvStale: action.ids };
    case 'agent_term':
      return action.state ? { ...state, agentTerms: { ...state.agentTerms, [action.id]: action.state } } : action.id in state.agentTerms ? { ...state, agentTerms: without(state.agentTerms, action.id) } : state;
    case 'term_visuals': {
      const had = action.all ? [] : (state.termVisuals[action.id] ?? []);
      const fresh = new Set(action.visuals.map((v) => v.n));
      const visuals = [...had.filter((v) => !fresh.has(v.n)), ...action.visuals].slice(-MAX_TERM_VISUALS);
      return { ...state, termVisuals: { ...state.termVisuals, [action.id]: visuals } };
    }
    case 'shell_choices':
      return { ...state, shellChoices: action.shells };
    case 'env_keys':
      return { ...state, envKeys: action.keys };
  }
}

export const unreadCount = (state: WorkState): number => state.inbox.filter((n) => !n.read).length;
