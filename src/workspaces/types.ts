import type { AgentRef } from '../protocol.js';
import type { Effort } from '../shared/settings-schema.js';
import type { ThreadRecord } from '../shared/threads.js';
import type { Status } from './git.js';
import type { ForkOf } from './github.js';
import type { DefaultBranch, FetchProblem } from './sync.js';
import type { ProjectScripts, ResolvedScripts } from './scripts.js';

/** Claude usage in one workspace, summed over every run. */
export interface WorkspaceUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Estimated cost in USD (what the SDK reports; not a bill). */
  readonly cost: number;
  readonly runs: number;
  /** A local or bring-your-own model (BLG-450): no plan, no cost; how fast its last turn wrote, in tokens a second. */
  readonly local?: { readonly tps?: number };
  /** The SDK reports running totals per conversation; remembered to add only what's new. */
  readonly lastSession?: string;
  readonly last?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cost: number };
  /** What each local day ("2026-10-18") added, the last few weeks (see usage-days.ts). */
  readonly days?: Readonly<Record<string, UsageDay>>;
  /** When Claude last reported usage here (epoch ms). */
  readonly lastAt?: number;
}

/** Claude usage on one day: tokens (input, output and cache writes) and estimated cost in USD. */
export interface UsageDay {
  readonly tokens: number;
  readonly cost: number;
}

export type WorkspaceKind = 'main' | 'worktree' | 'chat';

/** What checking a pull request out in a worktree needs to know about it (BLG-633). */
export interface PullHead {
  readonly number: number;
  /** Its head branch (headRefName). */
  readonly branch: string;
  /** For the worktree's name. */
  readonly title?: string;
  /** The branch it merges into: the worktree is compared with it. */
  readonly base?: string;
  /** Its branch is on a fork: fetched from GitHub's pull ref. */
  readonly fork?: boolean;
}

/** What renaming a workspace did: its name, and a worktree's branch (`branchKept`: why it kept its name). */
export interface RenameResult {
  readonly name: string;
  readonly branch?: string;
  readonly branchKept?: 'pushed';
}

/** What we remember about a workspace between runs. */
export interface WorkspaceRecord {
  readonly id: string;
  readonly projectRoot: string;
  readonly name: string;
  /** The user set this name. Automatic titles must preserve it. */
  readonly nameSetByUser?: boolean;
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly branch?: string;
  readonly base?: string;
  readonly createdAt: number;
  readonly archived?: boolean;
  /** Archived smartly: how much space it freed, what it kept, and what makes the rest again. */
  readonly archive?: { readonly freedBytes: number; readonly keptBytes: number; readonly remake: readonly string[]; readonly at: number };
  /** The conversation to resume in this workspace (its runtime's own id: see sessionRuntime). */
  readonly sessionId?: string;
  /** The runtime sessionId and forkFromSession belong to (unset: 'claude'); another runtime never resumes them. */
  readonly sessionRuntime?: string;
  /** The agent picked for this workspace (unset: your default). */
  readonly agent?: AgentRef;
  /** Switched quietly from this agent (its name, BLG-592): the recent conversation goes with your next message, then this clears. */
  readonly carryFrom?: string;
  /** Set on forks until their first run, so Claude branches the parent's conversation. */
  readonly forkFromSession?: string;
  readonly forkedFrom?: string;
  /** Brought in from a Claude Code conversation that ran outside Beluga (its session id, BLG-321). */
  readonly importedSession?: string;
  /** Hashes of env files copied into this worktree at creation, to detect changes later. */
  readonly envSnapshot?: Readonly<Record<string, string>>;
  /** Env files changed here that you said stay in this worktree (by their hash then): not asked again until they change. */
  readonly envKept?: Readonly<Record<string, string>>;
  /** Model picked for this conversation (unset: your default). */
  readonly model?: string;
  /** Thinking effort for this conversation (the chat’s meter, or a Sentinel step; unset: Settings'). */
  readonly effort?: Effort;
  readonly usage?: WorkspaceUsage;
  /** Handed off to a friend (their name), who continues it on their computer. */
  readonly handedTo?: string;
  /** Came from a friend's handoff (their name). */
  readonly handedFrom?: string;
  /** Continued on another computer of yours (its name, BLG-808): archived here once it ran there. */
  readonly continuedOn?: string;
  /** Continued here from another computer of yours (its name). */
  readonly continuedFrom?: string;
  /** Another agent started this chat through the thread tools (core/threads). Its harness stays in `agent`. */
  readonly thread?: ThreadRecord;
  /** A conversation started for one job: 'sync_main' is Claude bringing the main folder up to date. */
  readonly purpose?: 'sync_main';
  /** You carried on after this PR merged (Continue After Merge): it and older ones are done, so the branch can have a new one. */
  readonly prDone?: number;
  /**
   * That PR (Continue After Merge): Claude is told its earlier work shipped in it, and that what's new goes in a new one.
   * `head`: the commit it merged at, so Delete warns only about commits made after it (BLG-831).
   */
  readonly prShipped?: { readonly number: number; readonly url?: string; readonly into: string; readonly head?: string };
  /** The PR whose merge this chat already shows (its merged line): said once, across restarts too. */
  readonly mergeSaid?: number;
  /** The commit its pull request merged at, as GitHub last said (BLG-833): only commits after it count as pushed nowhere. */
  readonly mergedHead?: string;
  /**
   * Merge When Ready: Beluga merges PR `number` itself once its checks pass (and stops, saying why,
   * if they fail or it conflicts). Not GitHub's auto-merge: that merges at once when no check is required.
   */
  readonly mergeWhenReady?: MergeWait;
  /**
   * Remind Me Later from before BLG-770 (epoch ms): read once at start, carried into triage.json
   * (core/triage/service.ts, which keeps Remind Me Later now, per person), then cleared.
   */
  readonly remindAt?: number;
  /**
   * A project's main checkout only: the chat its conversation from before became (BLG-70). The main
   * checkout is no conversation of its own; opening it opens that chat, or the project's home.
   */
  readonly movedTo?: string;
}

export interface MergeWait {
  readonly number: number;
  readonly method: 'squash' | 'merge' | 'rebase';
  /** When you asked (a PR with no checks yet gets a moment for them to show up). */
  readonly since: number;
  readonly deleteBranch?: boolean;
  /** The commit it pushed before waiting (BLG-840): until GitHub's PR has it, what GitHub says is about an older one. */
  readonly head?: string;
}

/** What deleting a worktree would throw away that archiving keeps (BLG-617): commits only its branch has. */
export interface DeletePlan {
  readonly branch: string;
  /** What "not merged" means: its base ("main"). */
  readonly into: string;
  /** Commits on neither `into` nor any remote. */
  readonly unpushed: number;
  /** The newest of them (subjects, at most 5). */
  readonly subjects: readonly string[];
}

/** A workspace as shown in the UI: record + live git status. */
export interface Workspace extends WorkspaceRecord {
  readonly projectId: string;
  /** A worktree that exists in git but wasn't created by Beluga (e.g. by another tool). */
  readonly external: boolean;
  readonly status?: Status;
  /**
   * A project's main folder (its main checkout, or a chat there): questions only. Claude can read
   * and answer but changes nothing; work moves to a new worktree.
   */
  readonly askOnly?: boolean;
  /** Being made: its row and page show at once, while git makes the folder (see core/optimistic.ts). */
  readonly pending?: boolean;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly base: string;
  readonly workspaces: readonly Workspace[];
  readonly error?: string;
  /** Setup and run commands that apply to this project. */
  readonly scripts?: ResolvedScripts;
  /** The default branch (main or master) against its remote, and fetching it (see sync.ts). */
  readonly sync?: ProjectSync;
  /** Origin is a GitHub fork: the original repository, and how far behind it the fork is (learned with gh after a fetch). */
  readonly fork?: ForkOf;
}

/** How a project's default branch stands, plus Beluga's fetching of it. */
export interface ProjectSync extends DefaultBranch {
  /** A fetch is running now. */
  readonly fetching?: boolean;
  /** The last fetch failed (cleared by the next one that works). */
  readonly fetchError?: { readonly reason: FetchProblem; readonly message: string; readonly at: number };
}

export interface ProjectGroup {
  readonly name: string;
  /** Project roots in this group. */
  readonly projects: readonly string[];
}

export interface ProjectsConfig {
  /** Parent folders scanned for git projects. */
  readonly roots: readonly string[];
  /** Individually added projects. */
  readonly projects: readonly string[];
  /** Projects you chose to hide. */
  readonly hidden: readonly string[];
  /**
   * Projects you removed from Beluga (Delete Project) that a scanned root would otherwise find
   * again. Unlike hidden ones they aren't offered back; adding the project again clears it.
   */
  readonly removed?: readonly string[];
  /** Your own grouping of projects in the sidebar. */
  readonly groups?: readonly ProjectGroup[];
  /**
   * The sidebar's top level in the order you arranged it: project roots and `group:<name>`.
   * Missing until you arrange something (then: projects alphabetically, then groups).
   */
  readonly order?: readonly string[];
  /** Setup / run commands you set per project (by project root), over beluga.json and guesses. */
  readonly scripts?: Readonly<Record<string, ProjectScripts>>;
  /** Setup commands from a project's own beluga.json/conductor.json you allowed to run (by root → command hashes). */
  readonly approvedScripts?: Readonly<Record<string, readonly string[]>>;
}
