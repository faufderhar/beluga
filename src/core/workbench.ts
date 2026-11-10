import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type PtyProcess, type TerminalManager, defaultShell, listShells, scriptShell } from '../terminal/index.js';
import { type ShellChoice, commandArgs, shellArgs } from '../shared/shells.js';
import type { EnvPlace } from './env-vars.js';
import { systemOpen } from './os-open.js';
import { editorCommand } from './editor-command.js';
import { tilde } from './paths.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { formatBytes, measureAll } from '../workspaces/disk.js';
import { contentIn, fetchRemote, resetTo } from '../workspaces/git.js';
import { type MergeOptions, type MergeProblem, type PrStepKind, buildPrPrompt, catchUpPrompt, commitSubjects, createPr, disableAutoMerge, prFromCommits, titleOfBranch, resolvePrConflictsPrompt, customPrPrompt, deleteRemoteBranch, ensurePrPromptFile, explainMergeError, findPr, fixChecksPrompt, forgetGh, ghState, gitSetup, hasGh, headCarries, listPrs, useHttpsRemote, mergePr, mergeToBase, prStep, pushForPr, remoteRef, rerunFailed, resetPrPrompt, setPrTarget, unpushedCommits } from '../workspaces/pr.js';
import { prTargetOf, pullOfBranch } from '../workspaces/github.js';
import { failedRunIds, prOnOriginal } from './branch-state.js';
import { PROJECT_FILES, type ProjectScripts, checkSetup, projectFileName, scriptEnv } from '../workspaces/scripts.js';
import { clonedSetup } from '../workspaces/setup-clone.js';
import type { ScriptFix, SetupFix, WorkedOutScripts } from '../agent/setup-fixer.js';
import type { SetupTools } from '../agent/types.js';
import { buildSetupAppend } from '../agent/prompt.js';
import { claudeCodeCommand } from '../agent/claude-code.js';
import { CONTINUE_PROMPT } from '../shared/run-failure.js';
import type { NoticeEvent } from './notify.js';
import { type SearchSource, searchConversations } from './search.js';
import { type LogItem, type MergedMark, type Prefs, type Store, mergedText, shippedText } from './store.js';
import { lastLogAt } from './triage/facts.js';
import { triageKey } from './triage/model.js';
import { addTemplate, loadTemplates, removeTemplate } from './templates.js';
import type { ModelChoice, PrConversation, PrThread, PullRequest } from './work-store.js';
import type { RuntimeStatus } from '../agent/runtime/types.js';
import { type PrPost, addressCommentsPrompt, postOnPr, prConversation } from '../workspaces/pr-review.js';
import { type Excerpt, readExcerpt } from '../workspaces/excerpt.js';
import { openCode } from '../workspaces/open-code.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { Intent } from './intents.js';
import { agentName } from '../shared/agent-label.js';
import type { Effort } from '../shared/settings-schema.js';
import { sentinelChatOf } from './sentinel/model.js';
import { ASSISTANT_TITLE, assistantChatOf, assistantChatTitle, isAssistant } from '../shared/assistant.js';
import { type AgentRef, defaultAgentOf } from '../protocol.js';
import type { RuntimeChoice } from '../shared/agent-runtimes.js';
import type { HandoffMode } from '../shared/agent-handoff.js';
import { type GitFixId, type GitSetup, type GitTrouble, explainGitTrouble, httpsRemoteOf, troubleLine } from '../shared/git-trouble.js';

export interface WorkbenchDeps {
  readonly store: Store;
  readonly controller: WorkspaceController;
  /** Shell sessions for the Terminal tab (omitted where there's no terminal, e.g. tests). */
  readonly terminals?: TerminalManager;
  readonly notify: (event: NoticeEvent) => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask the screen to go somewhere, open a dialog or close a tab (see core/intents.ts). */
  readonly intend: (intent: Intent) => void;
  /** Ask your Claude in a workspace conversation. */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** What Your Mac's chats outside `loaded` said, read from disk for a search (unset: there is no Your Mac). */
  readonly savedChats?: (loaded: ReadonlySet<string>) => ReadonlyArray<{ readonly channel: string; readonly items: readonly LogItem[] }>;
  /** Bring a Your Mac chat with nothing in the log back from disk, before opening it. */
  readonly loadSavedChat?: (id: string) => void;
  readonly setPrefs: (prefs: Partial<Prefs>) => void;
  /** Ask you before something runs by itself the first time (e.g. a repo's own setup command). */
  readonly confirm?: (title: string, detail: string) => Promise<'yes' | 'no' | 'always'>;
  /** Open a URL or a file with the system's default app. */
  readonly open?: (target: string) => void;
  /** Models your Claude Code offers (asked once). */
  readonly listModels?: () => Promise<readonly ModelChoice[] | undefined>;
  /** Another runtime on a live conversation hands it off (core/agent-switch.ts, BLG-447); unset: a plain switch. */
  readonly switchAgent?: (channel: string, agent: AgentRef | undefined, mode?: HandoffMode) => Promise<unknown>;
  /** The agent picker's runtimes: which run on this Mac, and why the others don't (BLG-446). */
  readonly listRuntimes?: () => readonly RuntimeChoice[];
  /** Whether each runtime that can say so is ready here (Codex: installed, signed in) and its models (BLG-455). */
  readonly runtimeStatus?: () => Promise<ReadonlyArray<{ readonly id: string } & RuntimeStatus>>;
  /** How to sign in to a runtime, as a command for Terminal (BLG-507); undefined: it has none. */
  readonly signInCommand?: (id: string) => Promise<readonly string[] | undefined>;
  /** Look for a pull request (injected in tests). */
  readonly findPr?: (dir: string, branch: string) => Promise<PullRequest | undefined>;
  /** A repository's recent PRs by branch, in one call (injected in tests; without it, with an injected findPr, PRs are looked up one by one). */
  readonly listPrs?: (dir: string) => Promise<{ prs: ReadonlyMap<string, PullRequest>; full: boolean }>;
  /** Merge a PR on GitHub (injected in tests; throws gh's error). */
  readonly mergePr?: (dir: string, number: number, opts: MergeOptions) => Promise<void>;
  /** How many commits here the branch on GitHub doesn't have yet (injected in tests). */
  readonly unpushedCommits?: (dir: string, branch: string) => Promise<number>;
  /** Whether a PR's head holds every commit HEAD has (injected in tests; see pr.ts headCarries). */
  readonly headCarries?: typeof headCarries;
  /** Delete a merged branch on GitHub (injected in tests). */
  readonly deleteRemoteBranch?: (dir: string, branch: string) => Promise<void>;
  /** A PR's one-click step on GitHub (injected in tests; throws gh's error). */
  readonly prStep?: (dir: string, number: number, step: PrStepKind) => Promise<void>;
  /** A PR's comments, reviews and threads, and posting on it (injected in tests). */
  readonly prConversation?: (dir: string, number: number) => Promise<PrConversation>;
  readonly postOnPr?: (dir: string, number: number, post: PrPost) => Promise<void>;
  /** Push and open a pull request without Claude (tests stand in for gh). */
  readonly createPr?: typeof createPr;
  readonly mergeToBase?: typeof mergeToBase;
  readonly pushForPr?: typeof pushForPr;
  /** Re-run a workflow run's failed jobs (tests stand in for gh). */
  readonly rerunFailed?: typeof rerunFailed;
  readonly disableAutoMerge?: (dir: string, number: number) => Promise<void>;
  /** Where a branch was last pushed to (its remote-tracking ref), to notice pushes. */
  readonly remoteRef?: (dir: string, branch: string) => string | undefined;
  /** The clock (injected in tests). */
  readonly now?: () => number;
  readonly hasGh?: () => Promise<boolean>;
  /** This Mac's way to GitHub from a folder: gh, Homebrew, the remote (injected in tests). */
  readonly gitSetup?: (dir: string) => Promise<GitSetup>;
  /** Switch a project's origin to HTTPS (injected in tests). */
  readonly useHttpsRemote?: (dir: string) => Promise<{ from: string; to: string }>;
  readonly measure?: (dir: string) => Promise<number | undefined>;
  /** Your environment variables for something starting there (see env-vars.ts). */
  readonly envFor?: (where: EnvPlace) => Record<string, string>;
  /** The shells you can pick (injected in tests). */
  readonly listShells?: () => ShellChoice[];
  /** What a project's setup should be after it failed in `dir` (a small model looks). */
  readonly fixSetup?: (dir: string, failed: string, output: string) => Promise<SetupFix | undefined>;
  /** What a project's run command should be after it failed in `dir` (a model looks). */
  readonly fixRun?: (dir: string, failed: string, output: string) => Promise<ScriptFix | undefined>;
  /** A project's setup and/or run worked out from its files (a model looks); undefined when no Claude can. */
  readonly workOutScripts?: (dir: string, want: { setup: boolean; run: boolean; system?: string }) => Promise<WorkedOutScripts | undefined> | undefined;
  /** Whether your Claude is on (it can be asked to fix a setup or run that failed). */
  readonly hasClaude?: () => boolean;
}

/**
 * The picker's runtimes with what each said about itself: ready (its models), or greyed with why
 * and what to do. A runtime that lists no models of its own (Claude: they come from Claude Code,
 * the state's `models`) keeps whatever the list had.
 */
export function withRuntimeStatus(runtimes: readonly RuntimeChoice[], found: ReadonlyArray<{ readonly id: string } & RuntimeStatus>): RuntimeChoice[] {
  return runtimes.map((r) => {
    const st = found.find((f) => f.id === r.id);
    if (!st) return r;
    const models = st.models.length ? st.models : r.models;
    if (st.state === 'ready') return { id: r.id, label: r.label, available: true, ...(models ? { models } : {}), state: 'ready' };
    return { id: r.id, label: r.label, available: false, why: [st.state === 'missing' ? `${r.label} isn't installed on this Mac` : `${r.label} isn't signed in`, st.fix].filter(Boolean).join(': '), state: st.state, ...(st.fix ? { fix: st.fix } : {}) };
  });
}

/** An agent that isn't ready yet (Codex not signed in) is asked about again this often. */
const RUNTIME_RECHECK_MS = 60_000;
const DISK_EVERY_MS = 5 * 60_000;
/** How often to see which PRs are due a look (cheap: no gh unless one is). */
const PR_TICK_MS = 5_000;
/** PRs with checks running, or a branch just pushed. */
export const PR_FAST_MS = 15_000;
/** Other open PRs, and worktrees with commits but no PR yet. */
export const PR_SLOW_MS = 60_000;
/** Checks can take a moment to show up after a push: with none at all, Merge When Ready merges only after this long. */
export const NO_CHECKS_GRACE_MS = 90_000;
/** Merge When Ready after a push (BLG-840): how long GitHub's PR may go on without the pushed commits before it stops waiting and says so. */
export const PUSHED_HEAD_WAIT_MS = 15 * 60_000;
/** A push keeps its PR on the fast cadence this long (CI starts, a PR gets opened). */
const PR_PUSHED_FOR_MS = 3 * 60_000;
/** Coming back to the window refreshes PRs not looked at in this long. */
const PR_FOCUS_FRESH_MS = 5_000;
/** gh calls at once. */
const PR_CONCURRENCY = 3;
/** Terminal size until the Terminal tab is shown (it resizes to fit). */
const START_SIZE = { cols: 120, rows: 30 };
/** How much of a failed setup or run's output the "fix it?" question shows, and Claude gets. */
const FAIL_TAIL_CHARS = 1200;
const FIX_OUTPUT_CHARS = 6000;
/** Exit codes of a process stopped by a signal (^C, kill, a closed terminal): you stopped it, it didn't fail. */
const STOPPED_CODES = new Set([129, 130, 137, 143]);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** What your Claude gets when you say yes to "Do you want me to fix it?". */
export function fixFailedPrompt(kind: 'setup' | 'run', command: string, code: number | null, output: string): string {
  const what = kind === 'run' ? "This worktree's Run command (what Beluga's Run button starts)" : "This worktree's setup (what Beluga runs once in every new worktree)";
  const tail = output.replace(ANSI, '').trimEnd().slice(-FIX_OUTPUT_CHARS);
  return [
    `${what} didn't work: \`${command}\` stopped with exit code ${code ?? '?'}.`,
    tail ? `The end of its output:\n\n\`\`\`\n${tail}\n\`\`\`` : '',
    `Find out why and fix it, so \`${command}\` works here. If the command itself is wrong, say which one is right: it can be set in the project's ⋯ menu (Setup and run commands), or in its beluga.json under "scripts" for everyone.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export { shellId, setupId, runId, githubId, globalShellId, isGlobalShell, globalShellNumber, globalShellDir } from '../shared/terminal-keys.js';
import { agentTermId, githubId, runId, setupId, shellId, isGlobalShell, globalShellNumber, cleanTerminalName } from '../shared/terminal-keys.js';
import { pace, paced } from './power-saver.js';

/** How soon cmd ends when it couldn't find your editor (Windows). */
const EDITOR_MISSING_MS = 3000;

/**
 * What changed about a pull request that's worth telling you. A PR showing up is only news
 * when you asked Claude for it (`asked`); otherwise it already existed and isn't.
 */
export function prNews(name: string, channel: string, before: PullRequest | undefined, pr: PullRequest, asked = false): NoticeEvent[] {
  if (!before) return asked && pr.state === 'OPEN' ? [{ kind: 'pr', title: `Pull request #${pr.number} is open for ${name}`, body: pr.title, channel }] : [];
  const out: NoticeEvent[] = [];
  if (before.checks !== pr.checks && (pr.checks === 'passing' || pr.checks === 'failing')) out.push({ kind: pr.checks === 'failing' ? 'problems' : 'pr', title: `Checks ${pr.checks} on PR #${pr.number}`, body: `${name} · ${pr.title}`, channel });
  if (before.state !== 'MERGED' && pr.state === 'MERGED') out.push({ kind: 'pr', title: `PR #${pr.number} was merged`, body: name, channel });
  if (before.state === 'OPEN' && pr.state === 'CLOSED') out.push({ kind: 'pr', title: `PR #${pr.number} was closed without merging`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'CHANGES_REQUESTED') out.push({ kind: 'pr', title: `Changes requested on PR #${pr.number}`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'APPROVED') out.push({ kind: 'pr', title: `PR #${pr.number} was approved`, body: name, channel });
  return out;
}

/**
 * Whether a worktree's chat should now get the line saying its PR merged. Once per PR (`said`: the
 * one it already shows). Seen merging (open last time, `quiet` off): yes. Otherwise (merged while
 * Beluga was closed, or between two looks) only when nothing was said in the chat since it merged
 * (`lastAt`), so everything above the line really is what merged.
 */
export function mergedLineDue(pr: PullRequest | undefined, before: PullRequest | undefined, quiet: boolean, said: number | undefined, lastAt: number | undefined): boolean {
  if (pr?.state !== 'MERGED' || said === pr.number) return false;
  if (!quiet && before?.number === pr.number && before.state === 'OPEN') return true;
  return pr.mergedAt !== undefined && lastAt !== undefined && lastAt <= pr.mergedAt;
}

/**
 * How long until a worktree's PR is worth asking gh about again; undefined: not by itself
 * (merged or closed). `pushedAt`: when its branch was last pushed.
 */
export function prCadence(pr: PullRequest | undefined, pushedAt: number | undefined, now: number): number | undefined {
  if (pushedAt !== undefined && now - pushedAt < PR_PUSHED_FOR_MS) return PR_FAST_MS;
  if (!pr) return PR_SLOW_MS;
  if (pr.state !== 'OPEN') return undefined;
  return pr.checks === 'pending' ? PR_FAST_MS : PR_SLOW_MS;
}

/**
 * How a merge on GitHub went: `merged` now, or `queued` (auto-merge is on, or the repository's
 * merge queue took it); else why not, in words you can act on.
 */
export type MergeOutcome = { readonly ok: true; readonly result: 'merged' | 'queued'; readonly message: string } | { readonly ok: false; readonly reason: MergeProblem | 'no_pr' | 'busy' | 'unpushed' | 'github'; readonly message: string; readonly trouble?: GitTrouble };

/** How a GitHub step went; `trouble`: it couldn't reach GitHub, and what can fix that (the Mac shows it as a card). */
export interface GitHubOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly trouble?: GitTrouble;
}

/** What to do again once a fix worked: Create PR (as a draft), Merge into its base, or nothing (say it's fixed). */
export type GitRetry = 'pr' | 'pr_draft' | 'pr_original' | 'merge_base' | 'none';

/** How long a terminal step (installing gh, logging in) may take before Beluga stops waiting for it. */
const GITHUB_STEP_MS = 15 * 60_000;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run `tasks`, at most `limit` at a time. */
async function inPool(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/** "Your Mac › plan my trip": where a hit in one of Your Mac's chats was said. */
const macChatPlace = (channel: string, items: readonly LogItem[]): string => `${ASSISTANT_TITLE} › ${assistantChatTitle(channel, items)}`;

const samePr = (a: PullRequest | undefined, b: PullRequest | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
/** "https://github.com/kay/app/pull/12" → "https://github.com/kay/app": which repository a PR is on. */
const repoOfPr = (url: string): string => url.replace(/\/pull\/\d+.*$/, '').toLowerCase();

/** All an error said (a push's whole output, not just its line). */
const rawOf = (err: unknown): string => (err && typeof err === 'object' && 'raw' in err && typeof err.raw === 'string' ? err.raw : err instanceof Error ? err.message : String(err));
/** An error's first line ("no reason given" when it has none). */
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n').find((l) => l.trim())?.trim() ?? 'no reason given';
/** Variables as text in one order, to tell whether they changed (kept only in memory, on this Mac). */
const envText = (vars: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));


/**
 * Everything around a workspace besides talking to Claude: its terminal, setup and run
 * scripts, pull requests, models, how much space and usage it takes, search, templates.
 */
export class Workbench {
  /** This Mac's agent by name ("Claude", "Codex"). */
  private agent(): string {
    return agentName(defaultAgentOf(this.deps.store.getState().self));
  }
  private diskTimer?: NodeJS.Timeout;
  /** The round of measuring under way: a second ask joins it rather than walking every folder again. */
  private measuring?: Promise<void>;
  private prTimer?: NodeJS.Timeout;
  private runtimeTimer?: NodeJS.Timeout;
  /** What the runtimes last said about themselves, kept so a new list (a local endpoint answering) doesn't wipe it. */
  private runtimeFound: ReadonlyArray<{ readonly id: string } & RuntimeStatus> = [];
  private runtimeCheck?: Promise<void>;
  private readonly watchers = new Map<string, () => void>();
  /**
   * What each terminal started with: where (for its variables now) and the variables as text.
   * A program's variables are fixed when it starts, so after you change
   * them (Settings › Environment) the ones still running are marked for a restart.
   */
  private readonly started = new Map<string, { place: EnvPlace; env: string }>();
  private prsSeeded = false;
  /** Worktrees you asked Claude to open a PR for: their PR appearing is worth a notification. */
  private readonly prAsked = new Set<string>();
  /** Worktrees whose PR Create PR is opening right now (pressed twice opens one). */
  private readonly creatingPr = new Set<string>();
  /** When each worktree's PR was last asked about. */
  private readonly prChecked = new Map<string, number>();
  /** When each worktree's branch was last seen pushed, and the remote ref it was at. */
  private readonly pushedAt = new Map<string, number>();
  private readonly remoteSeen = new Map<string, string | undefined>();
  /** PRs already announced as merged or closed ("<ws>#<number>:<state>"), so that's said once. */
  private readonly prEnded = new Set<string>();
  private polling = false;
  /** Focus and push looks asked for while a look ran (or before the first): they run right after, never dropped. */
  private pollQueue: Array<{ reason: 'focus' | 'push'; id?: string }> = [];
  /** The last trouble reaching GitHub per worktree (what a fix that went through the terminal retries with). */
  private readonly troubles = new Map<string, GitTrouble>();
  /** Worktrees waiting on a GitHub step in the terminal (installing gh, logging in). */
  private readonly githubSteps = new Map<string, () => void>();
  /** Worktrees whose PR is being merged right now. */
  private readonly merging = new Set<string>();
  /** Merge When Ready being looked at (refreshes overlap; it awaits git): one at a time per worktree. */
  private readonly settling = new Set<string>();
  /** Projects Claude is working out the commands of right now (one look each, shared by the worktrees waiting on it). */
  private readonly workingOut = new Map<string, Promise<void>>();
  /** "Run this setup by itself?" questions waiting, by project and command. */
  private readonly askingSetup = new Map<string, Promise<'yes' | 'no' | 'always'>>();
  /** Runs you stopped (so their ending isn't a failure). */
  private readonly stopping = new Set<string>();
  /** Worktrees asked "do you want me to fix it?" right now, by `<ws>:<setup|run>` (one question at a time). */
  private readonly offered = new Set<string>();

  constructor(private readonly deps: WorkbenchDeps) {}

  private get manager(): WorkspaceManager {
    return this.deps.controller.manager;
  }

  get terminals(): TerminalManager | undefined {
    return this.deps.terminals;
  }

  start(): void {
    this.deps.store.dispatch({ type: 'templates', templates: loadTemplates() });
    this.deps.store.dispatch({ type: 'pr_custom', custom: Boolean(customPrPrompt()) });
    this.deps.store.dispatch({ type: 'shell_choices', shells: (this.deps.listShells ?? listShells)() });
    void (this.deps.hasGh ?? hasGh)().then((ok) => {
      this.deps.store.dispatch({ type: 'gh', ok });
      if (ok) void this.refreshPrs();
    });
    const runtimes = this.deps.listRuntimes?.();
    if (runtimes) this.deps.store.dispatch({ type: 'runtimes', runtimes });
    void this.deps.listModels?.().then((models) => models && this.deps.store.dispatch({ type: 'models', models }), () => undefined);
    void this.checkRuntimes();
    setTimeout(() => void this.measureDisk(), 3000).unref();
    this.diskTimer = setInterval(paced(DISK_EVERY_MS, () => this.deps.store.getState().powerSaving, () => void this.measureDisk()), DISK_EVERY_MS);
    this.diskTimer.unref();
    this.prTimer = setInterval(() => void this.pollPrs(), PR_TICK_MS);
    this.prTimer.unref();
  }

  stop(): void {
    clearInterval(this.diskTimer);
    clearInterval(this.prTimer);
    clearTimeout(this.runtimeTimer);
    for (const off of this.watchers.values()) off();
    this.deps.terminals?.closeAll();
  }

  // ------------------------------------------------------------------ models

  /** Pick the model for a conversation; `channel` undefined sets the default for new ones. */
  setModel(channel: string | undefined, value: string): void {
    const label = this.deps.store.getState().models.find((m) => m.value === value)?.label ?? (value || 'Default');
    const id = channel?.startsWith('ws:') ? channel.slice(3) : undefined;
    if (id && this.manager.find(id)) {
      this.manager.setModel(id, value || undefined);
      void this.deps.controller.refresh();
      this.deps.toast(`${label} in this conversation from the next message`, 'success');
      return;
    }
    this.deps.setPrefs({ model: value || undefined });
    this.deps.toast(`New conversations use ${label}`, 'success');
  }

  /** Pick how hard one conversation thinks. Unset: Settings apply again. A channel with no conversation sets the default. */
  setEffort(channel: string, effort: Effort | undefined): void {
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (id && this.manager.find(id)) {
      this.manager.setEffort(id, effort);
      void this.deps.controller.refresh();
      const word = effort === 'xhigh' ? 'Extra High' : effort ? `${effort[0]!.toUpperCase()}${effort.slice(1)}` : undefined;
      this.deps.toast(word ? `${word} thinking in this conversation, from the next message` : 'This conversation follows the effort in Settings', 'success');
      return;
    }
    this.deps.setPrefs({ effort });
  }

  /**
   * Pick the agent for one conversation (undefined: your default); every run from there uses it.
   * `mode`: when the new agent can't read the session, switch quietly or have the old one write a note (BLG-592).
   */
  setAgent(channel: string, agent: AgentRef | undefined, mode?: HandoffMode): boolean {
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (!id || !this.manager.find(id)) return false;
    // Another runtime on a live conversation is a handoff (a note, or the recent conversation with your next message), never a silent swap.
    if (this.deps.switchAgent) void this.deps.switchAgent(channel, agent, mode).finally(() => void this.deps.controller.refresh());
    else {
      this.manager.setAgent(id, agent);
      void this.deps.controller.refresh();
    }
    return true;
  }

  // ----------------------------------------------------------- pull requests

  private worktree(id: string): Workspace | undefined {
    const ws = this.manager.find(id);
    if (!ws || ws.kind !== 'worktree' || !ws.branch) {
      this.deps.toast('Pull requests are for worktrees (a branch of their own)', 'warn');
      return undefined;
    }
    return ws;
  }

  /** Claude commits what belongs to the work, pushes and opens a PR with a short description. */
  createPr(id: string, extra = ''): void {
    const ws = this.worktree(id);
    if (!ws?.branch) return;
    if (this.deps.store.getState().gh === false) {
      this.deps.toast('Install the GitHub CLI first: brew install gh, then gh auth login', 'warn');
      return;
    }
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    const prompt = buildPrPrompt({ branch: ws.branch, base: ws.base ?? project?.base ?? 'origin/main', project: project?.name ?? '', projectPrompt: project?.scripts?.prPrompt, extra });
    if (!this.deps.store.getState().prs[ws.id]) this.prAsked.add(ws.id);
    this.deps.controller.open(ws.id);
    const ask = (): void => this.deps.askClaude(prompt, `ws:${ws.id}`);
    // Its last PR went to a fork's original: this one goes to the fork, as the menu says (before the run reads where gh points).
    if (prTargetOf(ws.path, ws.branch)) void setPrTarget(ws.path, ws.branch, undefined).catch(() => undefined).finally(ask);
    else ask();
    this.deps.toast(`${this.agent()} is preparing the pull request…`);
  }

  /**
   * Create PR, straight away and without Claude: commits anything left (as the branch's name),
   * pushes, and opens a pull request titled from the commits (`gh pr create`).
   */
  async quickPr(id: string, opts: { readonly draft?: boolean; readonly https?: boolean; readonly original?: boolean } = {}): Promise<GitHubOutcome> {
    const fail = (message: string): { ok: false; message: string } => {
      this.deps.toast(message, 'error');
      return { ok: false, message };
    };
    const ws = this.worktree(id);
    if (!ws?.branch) return { ok: false, message: 'Pull requests are for worktrees (a branch of their own)' };
    if (this.deps.store.getState().gh === false) {
      // Maybe it was installed or logged in to since: ask again before saying it isn't.
      forgetGh();
      const state = this.deps.hasGh ? ((await this.deps.hasGh()) ? 'ok' : 'logged_out') : await ghState();
      if (state !== 'ok') return this.troubleOr(ws, new Error(state === 'missing' ? 'The GitHub CLI (gh) isn’t installed' : 'The GitHub CLI isn’t logged in: gh auth login'), 'GitHub didn’t open the pull request');
      this.deps.store.dispatch({ type: 'gh', ok: true });
    }
    // Create PR on the original (BLG-727): into the repository the project's origin was forked from.
    const fork = opts.original ? this.manager.list.find((p) => p.id === ws.projectId)?.fork : undefined;
    if (opts.original && !fork) return fail('This project’s origin isn’t a fork on GitHub, so there’s no original to open it on');
    if (this.creatingPr.has(id)) return { ok: false, message: 'The pull request is already being opened' };
    this.creatingPr.add(id);
    const branch = ws.branch;
    try {
      this.deps.toast(`Opening a pull request for ${branch}${fork ? ` on ${fork.owner}/${fork.repo}` : ''}…`);
      try {
        if ((ws.status?.changed ?? 0) > 0) await this.manager.commitAll(id, titleOfBranch(branch));
      } catch (err) {
        return fail(`Couldn’t commit what’s left: ${firstLine(err)}`);
      }
      const base = this.prBase(ws);
      const subjects = await commitSubjects(ws.path, `origin/${base}`).catch(() => []);
      const text = prFromCommits(branch, subjects);
      let pr: PullRequest;
      try {
        pr = await (this.deps.createPr ?? createPr)(ws.path, { base: fork?.branch ?? base, head: branch, ...text, ...(opts.draft ? { draft: true } : {}), ...(opts.https ? { https: true } : {}), ...(fork ? { to: fork } : {}) });
      } catch (err) {
        return this.troubleOr(ws, err, 'GitHub didn’t open the pull request');
      }
      this.troubles.delete(id);
      this.pushedAt.set(id, this.now());
      this.deps.store.dispatch({ type: 'pr', id, pr });
      void this.deps.controller.refresh();
      const message = `Opened PR #${pr.number}${fork ? ` on ${fork.owner}/${fork.repo}` : ''}${opts.draft ? ' as a draft' : ''}: ${pr.title || text.title}`;
      this.deps.toast(message, 'success');
      return { ok: true, message };
    } finally {
      this.creatingPr.delete(id);
    }
  }

  /**
   * Merge into its base, with no pull request: commits anything left (as the branch's name), then
   * lands the branch on origin/<base> (fast-forward, or a merge commit) and pushes it there.
   * Nothing in the main folder changes. Conflicts or a base that moved meanwhile push nothing.
   */
  async mergeToBase(id: string, opts: { readonly https?: boolean } = {}): Promise<GitHubOutcome> {
    const ws = this.worktree(id);
    if (!ws?.branch) return { ok: false, message: 'Only a worktree (a branch of its own) can merge' };
    if (this.creatingPr.has(id)) return { ok: false, message: 'It’s already being pushed' };
    this.creatingPr.add(id);
    const branch = ws.branch;
    const base = this.prBase(ws);
    const warn = (message: string): GitHubOutcome => {
      this.deps.toast(message, 'warn');
      return { ok: false, message };
    };
    try {
      this.deps.toast(`Merging ${branch} into origin/${base}…`);
      try {
        if ((ws.status?.changed ?? 0) > 0) await this.manager.commitAll(id, titleOfBranch(branch));
      } catch (err) {
        return warn(`Couldn’t commit what’s left: ${firstLine(err)}`);
      }
      let result: Awaited<ReturnType<typeof mergeToBase>>;
      try {
        result = await (this.deps.mergeToBase ?? mergeToBase)(ws.path, branch, base, opts);
      } catch (err) {
        return this.troubleOr(ws, err, `Couldn’t merge into origin/${base}`);
      }
      this.troubles.delete(id);
      if (!result.ok) {
        if (result.reason === 'moved') return warn(`Someone pushed to ${base} just now: nothing was pushed, try again`);
        const files = result.files.slice(0, 3).join(', ') + (result.files.length > 3 ? '…' : '');
        return warn(`${branch} conflicts with origin/${base} (${files}): nothing was pushed. Create a PR, or ask your agent to bring ${base} in first`);
      }
      this.sayMerged(id, { into: base });
      void this.deps.controller.refresh();
      void this.refreshPrs(id);
      const message = `Merged ${branch} into ${base} on GitHub${result.how === 'fast_forward' ? '' : ' (a merge commit)'}`;
      this.deps.toast(message, 'success');
      return { ok: true, message };
    } finally {
      this.creatingPr.delete(id);
    }
  }

  /** A GitHub step's error as trouble reaching GitHub (with the fixes this Mac can use), if it is that. */
  private async troubleOf(ws: Workspace, err: unknown): Promise<GitTrouble | undefined> {
    const raw = rawOf(err);
    // Most errors aren't (a conflict, a rule): only then is the setup looked at.
    if (!explainGitTrouble(raw)) return undefined;
    const setup = await (this.deps.gitSetup ?? gitSetup)(ws.path).catch((): GitSetup => ({ gh: 'unknown' }));
    const trouble = explainGitTrouble(raw, setup);
    if (trouble) this.troubles.set(ws.id, trouble);
    return trouble;
  }

  /** Fail with the trouble's plain words and its fixes, or else "<what>: <git's line>". Toasts either way. */
  private async troubleOr(ws: Workspace, err: unknown, what: string): Promise<GitHubOutcome> {
    const trouble = await this.troubleOf(ws, err);
    if (trouble) {
      // The toast is the title (the Mac shows the card too); the phone gets the line.
      this.deps.toast(trouble.title, 'warn');
      return { ok: false, message: troubleLine(trouble), trouble };
    }
    const message = `${what}: ${firstLine(err)}`;
    this.deps.toast(message, 'error');
    return { ok: false, message };
  }

  /**
   * One of the fixes a GitHub trouble card offers (see shared/git-trouble.ts), then `retry`.
   * Push over HTTPS pushes this once with gh's login; Always Use HTTPS (the Mac asks first) changes
   * origin; installing gh, logging in and the SSH steps run in the worktree's GitHub terminal, where
   * you see and answer them, and once they finish well it's tried again.
   */
  async gitFix(id: string, fix: GitFixId, retry: GitRetry = 'pr'): Promise<GitHubOutcome> {
    const ws = this.worktree(id);
    if (!ws?.branch) return { ok: false, message: 'Pull requests are for worktrees (a branch of their own)' };
    const draft = retry === 'pr_draft';
    const again = (https = false): Promise<GitHubOutcome> => {
      if (retry === 'merge_base') return this.mergeToBase(id, https ? { https: true } : {});
      if (retry !== 'none') return this.quickPr(id, { ...(draft ? { draft: true } : {}), ...(retry === 'pr_original' ? { original: true } : {}), ...(https ? { https: true } : {}) });
      const message = 'GitHub is set up: try it again';
      this.deps.toast(message, 'success');
      return Promise.resolve({ ok: true, message });
    };
    switch (fix) {
      case 'retry':
        return again();
      case 'push_https':
        return again(true);
      case 'use_https': {
        try {
          const { from, to } = await (this.deps.useHttpsRemote ?? useHttpsRemote)(ws.path);
          this.deps.toast(`origin is ${to} now (it was ${from})`, 'success');
        } catch (err) {
          const message = `Couldn’t switch origin to HTTPS: ${firstLine(err)}`;
          this.deps.toast(message, 'error');
          return { ok: false, message };
        }
        return again();
      }
      case 'link':
        return { ok: false, message: 'Links open on the Mac' };
      case 'install_gh':
      case 'gh_login':
      case 'add_ssh_key':
      case 'check_host':
        return this.githubStep(ws, fix, again);
    }
  }

  /** Run a fix's command in the worktree's GitHub terminal; when it ends well, try again. */
  private async githubStep(ws: Workspace, fix: GitFixId, again: (https?: boolean) => Promise<GitHubOutcome>): Promise<GitHubOutcome> {
    const setup = await (this.deps.gitSetup ?? gitSetup)(ws.path).catch((): GitSetup => ({ gh: 'unknown' }));
    // The card's own command, worked out again for this Mac now (gh may have been installed since).
    const trouble = this.troubles.get(ws.id);
    const command = explainGitTrouble(trouble?.raw ?? '', setup)?.fixes.find((f) => f.id === fix)?.command ?? trouble?.fixes.find((f) => f.id === fix)?.command;
    if (!command) return { ok: false, message: 'There’s nothing to run for that here' };
    const key = githubId(ws.id);
    this.githubSteps.get(ws.id)?.();
    this.closeTerminal(key);
    const session = this.openSession(key, ws, command);
    if (!session) return { ok: false, message: 'There’s no terminal here to run it in' };
    this.deps.toast(fix === 'install_gh' ? 'Installing the GitHub CLI in the terminal…' : fix === 'gh_login' ? 'Log in to GitHub in the terminal and your browser…' : 'Follow the steps in the terminal…');
    const code = await new Promise<number | null | 'stopped'>((resolve) => {
      const timer = setTimeout(() => resolve('stopped'), GITHUB_STEP_MS);
      timer.unref?.();
      const done = (c: number | null | 'stopped'): void => {
        clearTimeout(timer);
        this.githubSteps.delete(ws.id);
        resolve(c);
      };
      this.githubSteps.set(ws.id, () => done('stopped'));
      this.watchExit(key, session, done);
    });
    if (code !== 0) {
      const message = code === 'stopped' ? 'Stopped waiting for the GitHub step in the terminal' : `The GitHub step in the terminal didn’t finish (exit ${code ?? '?'}): have a look there`;
      this.deps.toast(message, 'warn');
      return { ok: false, message, ...(trouble ? { trouble } : {}) };
    }
    forgetGh();
    const ok = await (this.deps.hasGh ?? hasGh)();
    this.deps.store.dispatch({ type: 'gh', ok });
    if (ok) void this.refreshPrs(ws.id);
    // The SSH key was the trouble and gh is logged in now: push over HTTPS with that login (origin unchanged).
    const sshTrouble = trouble && (trouble.kind === 'ssh_denied' || trouble.kind === 'host_key');
    const https = Boolean(ok && sshTrouble && (fix === 'gh_login' || fix === 'install_gh') && httpsRemoteOf(setup.remote));
    return again(https);
  }

  /**
   * Claude Code isn't signed in on this Mac: `claude auth login` in one of your shells (`key`, a
   * global shell the screen picked, so it shows it), and once it ends well the Claude that stopped
   * in `channel` goes on where it left off. `how`: a Claude subscription (the default) or an
   * Anthropic Console account, the first two of Claude Code's own /login choices.
   */
  async signInClaude(key: string, channel: string, how: 'claudeai' | 'console' = 'claudeai'): Promise<{ ok: boolean; message: string }> {
    if (!isGlobalShell(key)) return { ok: false, message: 'That isn’t one of your shells' };
    const ws = channel.startsWith('ws:') ? this.manager.find(channel.slice(3)) : undefined;
    this.closeTerminal(key);
    const session = this.openSession(key, { path: ws?.path ?? os.homedir() }, `${shQuote(claudeCodeCommand())} auth login --${how}`);
    if (!session) return { ok: false, message: 'There’s no terminal here to run it in' };
    this.deps.store.dispatch({ type: 'terminal_name', id: key, name: 'Claude sign-in' });
    this.deps.toast('Sign in to Claude in your browser…');
    const code = await new Promise<number | null | 'stopped'>((resolve) => {
      const timer = setTimeout(() => resolve('stopped'), GITHUB_STEP_MS);
      timer.unref?.();
      this.watchExit(key, session, (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    if (code !== 0) {
      const message = code === 'stopped' ? 'Stopped waiting for Claude’s sign-in in the terminal' : `Claude’s sign-in didn’t finish (exit ${code ?? '?'}): have a look in the terminal`;
      this.deps.toast(message, 'warn');
      return { ok: false, message };
    }
    this.deps.askClaude(CONTINUE_PROMPT, channel);
    const message = 'Signed in: Claude goes on where it left off';
    this.deps.toast(message, 'success');
    return { ok: true, message };
  }

  /** The branch a worktree's PRs go into ("main"): its base on origin (a PR on a fork's original says its own in createPr). */
  private prBase(ws: Workspace): string {
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    const base = (ws.base ?? project?.base ?? 'origin/main').replace(/^origin\//, '');
    return base === 'HEAD' ? (project?.sync?.branch ?? 'main') : base;
  }

  /** GitHub says the PR conflicts with its base: Claude merges the base in here, resolves it and pushes. */
  resolvePrConflicts(id: string): void {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr) return;
    this.deps.controller.open(id);
    const fork = prOnOriginal(this.manager.list.find((p) => p.id === ws.projectId)?.fork, pr);
    this.deps.askClaude(resolvePrConflictsPrompt(pr, this.prBase(ws), fork ? { url: fork.url, branch: fork.branch } : undefined), `ws:${id}`);
    this.deps.toast(`${this.agent()} is resolving PR #${pr.number}’s conflicts…`);
  }

  /**
   * A line across a worktree's chat: what's above it merged (in a PR, on GitHub, or into the main
   * folder), so you see it there even when it merged outside Beluga. Its saved conversation is
   * loaded first, so the line lands after it and is saved with it.
   */
  private sayMerged(id: string, mark: MergedMark): void {
    this.deps.controller.ensureLoaded(id);
    this.deps.store.dispatch({ type: 'system', channel: `ws:${id}`, text: mergedText(mark), merged: mark });
  }

  /**
   * Keep working in a worktree whose PR merged: its PR is done (the next change opens a new one),
   * and the branch starts again from the base. When everything on it is already in the base it
   * just moves there; when it has work since, Claude merges the base in so nothing is lost.
   */
  async continueAfterMerge(id: string): Promise<void> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws?.branch) return;
    if (!pr || pr.state !== 'MERGED') return this.deps.toast('Continue After Merge is for a worktree whose pull request merged', 'info');
    if ((ws.status?.changed ?? 0) > 0) return this.deps.toast(`${ws.name} has uncommitted changes: commit them first`, 'warn');
    const base = this.prBase(ws);
    const target = `origin/${base}`;
    try {
      await fetchRemote(ws.path);
    } catch (err) {
      return this.deps.toast(`Couldn’t fetch ${target}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    const done = await contentIn(ws.path, 'HEAD', target);
    this.manager.setPrDone(id, pr.number, { url: pr.url, into: base, ...(pr.head ? { head: pr.head } : {}) });
    this.deps.store.dispatch({ type: 'pr', id, pr: undefined });
    // A line across the chat: what's above went out in this PR, what's below is the next one.
    this.deps.store.dispatch({ type: 'system', channel: `ws:${id}`, text: shippedText(pr.number, base), shipped: { number: pr.number, url: pr.url, into: base } });
    if (done) {
      try {
        await resetTo(ws.path, target);
      } catch (err) {
        return this.deps.toast(`Couldn’t move ${ws.branch} to ${target}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
      await this.deps.controller.refresh();
      this.deps.toast(`PR #${pr.number} is done. ${ws.branch} now starts from the latest ${base}: the next change gets a new pull request`, 'success');
      return;
    }
    await this.deps.controller.refresh();
    this.deps.controller.open(id);
    this.deps.askClaude(catchUpPrompt(pr, base), `ws:${id}`);
    this.deps.toast(`${ws.branch} has work since PR #${pr.number}: ${this.agent()} is bringing in the latest ${base}`);
  }

  fixChecks(id: string): void {
    const pr = this.deps.store.getState().prs[id];
    if (!pr) return;
    this.deps.controller.open(id);
    this.deps.askClaude(fixChecksPrompt(pr), `ws:${id}`);
  }

  /**
   * Merge a worktree's PR on GitHub (gh pr merge), or with `auto` once its checks and reviews pass;
   * then look at it again at once, so it shows Merged. GitHub's "no" comes back as a reason and a
   * sentence (a review is required, it conflicts…).
   */
  async mergePr(id: string, opts: MergeOptions): Promise<MergeOutcome> {
    return this.mergeOnGitHub(id, opts, false);
  }

  /**
   * Never a merge without the work it should carry (BLG-840): commits here that the PR doesn't have
   * are pushed first, and GitHub merges only the head that has them (--match-head-commit). `fromWait`:
   * Merge When Ready's own merge, which waits again for the checks of anything it had to push.
   */
  private async mergeOnGitHub(id: string, opts: MergeOptions, fromWait: boolean): Promise<MergeOutcome> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    const fail = (reason: Extract<MergeOutcome, { ok: false }>['reason'], message: string): MergeOutcome => {
      this.deps.toast(message, reason === 'busy' ? 'info' : 'error');
      return { ok: false, reason, message };
    };
    if (!ws?.branch || !pr) return fail('no_pr', 'This worktree has no pull request to merge yet');
    if (pr.state !== 'OPEN') return fail('closed', pr.state === 'MERGED' ? `PR #${pr.number} is already merged` : `PR #${pr.number} is closed`);
    if (this.merging.has(id)) return fail('busy', `PR #${pr.number} is already being merged`);
    this.merging.add(id);
    try {
      // GitHub merges what it has: commits made here since the last push would be left behind, and lost with the worktree. Push them first.
      const unpushed = await (this.deps.unpushedCommits ?? unpushedCommits)(ws.path, ws.branch);
      // The PR's own head too: origin/<branch> can be stale, or not the PR's branch at all.
      const here = await (this.deps.headCarries ?? headCarries)(ws.path, pr.head);
      // GitHub merges exactly the head that was checked here, or nothing if it moved since.
      let matchHead = here.carries ? pr.head : undefined;
      if (unpushed > 0 || here.carries === false) {
        // Counted as the chip counts them (status.unpushed: main merged in here isn't more work).
        const n = ws.status?.unpushed || unpushed;
        const commits = n === 0 ? 'the latest commits' : n === 1 ? '1 commit' : `${n} commits`;
        const them = n === 1 ? 'it' : 'them';
        // A fork's pull request checked out here (BLG-756): Beluga can't push to it, so merging would leave them out.
        if (pullOfBranch(ws.path, ws.branch) !== undefined) return fail('unpushed', `PR #${pr.number} is from someone’s fork, so Beluga can’t push ${commits} here to it, and merging it would leave ${them} out. Suggest ${them} on the PR, or open a PR of your own`);
        this.deps.toast(`Pushing ${commits} to ${ws.branch} before merging PR #${pr.number}…`);
        try {
          await (this.deps.pushForPr ?? pushForPr)(ws.path, ws.branch);
        } catch (err) {
          const trouble = await this.troubleOf(ws, err);
          if (trouble) {
            this.deps.toast(trouble.title, 'warn');
            return { ok: false, reason: 'github', message: troubleLine(trouble), trouble };
          }
          return fail('unpushed', `Couldn’t push ${commits} in ${ws.name}, so PR #${pr.number} isn’t merged (it would leave ${them} out): ${firstLine(err)}`);
        }
        this.troubles.delete(id);
        this.pushedAt.set(id, this.now());
        matchHead = here.head;
        // Merge When Ready: what was just pushed has checks of its own, so it waits for those too.
        if (fromWait) {
          this.manager.setMergeWait(ws.id, { number: pr.number, method: opts.method, since: this.now(), ...(opts.deleteBranch ? { deleteBranch: true } : {}), ...(here.head ? { head: here.head } : {}) });
          await this.deps.controller.refresh();
          const message = `Pushed ${commits} to PR #${pr.number}: it merges once their checks pass`;
          this.deps.toast(message, 'success');
          return { ok: true, result: 'queued', message };
        }
      }
      if (opts.auto) return await this.mergeWhenReady(ws, pr, opts, matchHead !== pr.head ? matchHead : undefined);
      try {
        await (this.deps.mergePr ?? mergePr)(ws.path, pr.number, matchHead && !opts.matchHead ? { ...opts, matchHead } : opts);
      } catch (err) {
        const trouble = await this.troubleOf(ws, err);
        if (trouble) {
          this.deps.toast(trouble.title, 'warn');
          return { ok: false, reason: 'github', message: troubleLine(trouble), trouble };
        }
        const problem = explainMergeError(err instanceof Error ? err.message : String(err), opts.method);
        // GitHub may know more now (a conflict, a review): show it.
        await this.refreshPrs(id);
        // Skipping the checks is an admin's right: without it GitHub says forbidden or blocked.
        if (opts.admin && (problem.reason === 'permission' || problem.reason === 'blocked')) return fail(problem.reason, 'Merging past the checks needs admin rights on this repository. Wait for the checks, or use “Merge When Checks Pass”.');
        return fail(problem.reason, problem.message);
      }
      // You merged it: no "was merged" notification on top.
      this.prEnded.add(`${id}#${pr.number}:MERGED`);
      await this.refreshPrs(id);
      const merged = this.deps.store.getState().prs[id]?.state === 'MERGED';
      if (merged && opts.deleteBranch) {
        await (this.deps.deleteRemoteBranch ?? deleteRemoteBranch)(ws.path, ws.branch).catch((err: unknown) => this.deps.toast(`Merged, but the branch on GitHub wasn’t deleted: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
      }
      const message = merged ? `Merged PR #${pr.number}` : opts.auto ? `PR #${pr.number} merges when its checks pass` : `PR #${pr.number} is queued to merge`;
      this.deps.toast(message, 'success');
      return { ok: true, result: merged ? 'merged' : 'queued', message };
    } finally {
      this.merging.delete(id);
    }
  }

  /**
   * Merge When Ready: Beluga waits for the PR's checks itself and merges once they pass (see
   * settleMergeWait). Not GitHub's `--auto`, which merges at once when the repository requires no check.
   */
  private async mergeWhenReady(ws: Workspace, pr: PullRequest, opts: MergeOptions, pushed?: string): Promise<MergeOutcome> {
    this.manager.setMergeWait(ws.id, { number: pr.number, method: opts.method, since: this.now(), ...(opts.deleteBranch ? { deleteBranch: true } : {}), ...(pushed ? { head: pushed } : {}) });
    await this.deps.controller.refresh();
    const message = `PR #${pr.number} merges once its checks pass`;
    this.deps.toast(message, 'success');
    // Maybe they already have: look now.
    await this.refreshPrs(ws.id);
    return { ok: true, result: 'queued', message };
  }

  /** Stop waiting to merge (and turn off GitHub's own auto-merge if it's on). */
  async cancelMergeWhenReady(id: string): Promise<{ ok: boolean; message: string }> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws) return { ok: false, message: 'Pull requests are for worktrees' };
    const waiting = Boolean(ws.mergeWhenReady);
    if (waiting) this.manager.setMergeWait(id, undefined);
    if (pr?.state === 'OPEN' && pr.autoMerge) {
      try {
        await (this.deps.disableAutoMerge ?? disableAutoMerge)(ws.path, pr.number);
      } catch (err) {
        const message = `GitHub didn’t turn off auto-merge: ${firstLine(err)}`;
        this.deps.toast(message, 'error');
        return { ok: false, message };
      }
      await this.refreshPrs(id);
    }
    await this.deps.controller.refresh();
    const message = pr ? `PR #${pr.number} won’t merge by itself` : 'Not waiting to merge anymore';
    this.deps.toast(message, 'success');
    return { ok: true, message };
  }

  /**
   * What Merge When Ready does with a PR's latest state: merge once its checks pass (none at all:
   * after they've had a moment to show up), keep waiting while they run or a review is due, and stop
   * with a notice when they fail, it conflicts, or it was closed.
   */
  private async settleMergeWait(ws: Workspace, pr: PullRequest | undefined): Promise<void> {
    if (this.settling.has(ws.id)) return;
    this.settling.add(ws.id);
    try {
      await this.settleMergeWaitNow(ws, pr);
    } finally {
      this.settling.delete(ws.id);
    }
  }

  private async settleMergeWaitNow(ws: Workspace, pr: PullRequest | undefined): Promise<void> {
    const wait = this.manager.find(ws.id)?.mergeWhenReady;
    if (!wait || this.merging.has(ws.id)) return;
    const channel = `ws:${ws.id}`;
    const done = async (): Promise<void> => {
      this.manager.setMergeWait(ws.id, undefined);
      await this.deps.controller.refresh();
    };
    const stop = async (title: string): Promise<void> => {
      await done();
      this.deps.notify({ kind: 'problems', title, body: `${ws.name} · Merge When Ready stopped`, channel });
      this.deps.toast(title, 'warn');
    };
    // Merged or closed some other way (GitHub says so on its own), or a newer PR: nothing to wait for.
    if (!pr || pr.number !== wait.number || pr.state !== 'OPEN') return done();
    // Just pushed (BLG-840): until GitHub's PR has that commit, its checks and conflicts are an older one's.
    // A head it can't place (someone pushed on top) isn't waited on: the merge itself checks again.
    if (wait.head && pr.head && pr.head !== wait.head && (await (this.deps.headCarries ?? headCarries)(ws.path, pr.head)).carries === false) {
      if (this.now() - wait.since < PUSHED_HEAD_WAIT_MS) return;
      return stop(`PR #${pr.number} still doesn’t have the commits pushed for it: not merging it`);
    }
    if (pr.conflicts) return stop(`PR #${pr.number} conflicts with its base: not merging it`);
    if (pr.checks === 'failing') return stop(`Checks failed on PR #${pr.number}: not merging it`);
    if (pr.review === 'CHANGES_REQUESTED') return stop(`Changes were requested on PR #${pr.number}: not merging it`);
    if (pr.draft) return stop(`PR #${pr.number} is a draft: mark it ready, then merge`);
    if (pr.checks === 'pending') return;
    if (pr.checks === 'none' && this.now() - wait.since < NO_CHECKS_GRACE_MS) return;
    // Waiting on a review, or the branch's rules: those can pass later.
    if (pr.review === 'REVIEW_REQUIRED' || pr.mergeState === 'blocked' || pr.mergeState === 'behind') return;
    await done();
    const out = await this.mergeOnGitHub(ws.id, { method: wait.method, ...(wait.deleteBranch ? { deleteBranch: true } : {}) }, true);
    // It pushed commits that weren't on the PR first, and waits for their checks now.
    if (out.ok && out.result === 'queued') return;
    if (out.ok) this.deps.notify({ kind: 'pr', title: `PR #${pr.number} merged: its checks passed`, body: ws.name, channel });
    else this.deps.notify({ kind: 'problems', title: `PR #${pr.number} didn’t merge`, body: out.message, channel });
  }

  /** A PR's one-click step on GitHub (update its branch from the base, or mark a draft ready), then its state again. */
  async prStep(id: string, step: PrStepKind): Promise<GitHubOutcome> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr || pr.state !== 'OPEN') {
      this.deps.toast('This worktree has no open pull request', 'error');
      return { ok: false, message: 'This worktree has no open pull request' };
    }
    try {
      await (this.deps.prStep ?? prStep)(ws.path, pr.number, step);
    } catch (err) {
      return this.troubleOr(ws, err, `GitHub didn’t ${step === 'ready' ? 'mark it ready' : 'update the branch'}`);
    }
    if (step === 'update_branch') this.pushedAt.set(id, this.now());
    await this.refreshPrs(id);
    const message = step === 'ready' ? `PR #${pr.number} is ready for review` : `PR #${pr.number} has the latest ${(ws.base ?? 'base').replace(/^origin\//, '')} now`;
    this.deps.toast(message, 'success');
    return { ok: true, message };
  }

  /**
   * Push a worktree's commits to its open PR, no Claude in between: what GitHub said (failing
   * checks, conflicts) was about an older commit, and pushing runs its checks again. Then its
   * status and the PR are looked at again, so the toolbar moves on.
   */
  async pushPr(id: string): Promise<GitHubOutcome> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws?.branch) return { ok: false, message: 'Only a worktree (a branch of its own) can push' };
    if (this.creatingPr.has(id)) return { ok: false, message: 'It’s already being pushed' };
    // A fork's pull request checked out here (BLG-756): its branch lives on the fork, so pushing to
    // origin wouldn't reach the PR, and would stop the branch following refs/pull/<n>/head.
    const pull = pullOfBranch(ws.path, ws.branch);
    if (pull !== undefined) {
      const message = `PR #${pull} is from someone’s fork: Beluga can’t push to it, so your commits stay here. Suggest them on the PR, or open a PR of your own`;
      this.deps.toast(message, 'info');
      return { ok: false, message };
    }
    this.creatingPr.add(id);
    try {
      await (this.deps.pushForPr ?? pushForPr)(ws.path, ws.branch);
    } catch (err) {
      return this.troubleOr(ws, err, `Couldn’t push ${ws.branch}`);
    } finally {
      this.creatingPr.delete(id);
    }
    this.troubles.delete(id);
    this.pushedAt.set(id, this.now());
    await this.deps.controller.refresh();
    await this.refreshPrs(id);
    const message = pr?.state === 'OPEN' ? `Pushed ${ws.branch}: PR #${pr.number}’s checks run again` : `Pushed ${ws.branch}`;
    this.deps.toast(message, 'success');
    return { ok: true, message };
  }

  /** Run a PR's failed Actions jobs again on the same commit (a flaky test): `gh run rerun <id> --failed` for each run. */
  async rerunChecks(id: string): Promise<GitHubOutcome> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr || pr.state !== 'OPEN') return { ok: false, message: 'This worktree has no open pull request' };
    const runs = failedRunIds(pr);
    if (!runs.length) {
      const message = `None of PR #${pr.number}’s failed checks are GitHub Actions runs Beluga can start again: open the PR to re-run them`;
      this.deps.toast(message, 'info');
      return { ok: false, message };
    }
    try {
      for (const run of runs) await (this.deps.rerunFailed ?? rerunFailed)(ws.path, run);
    } catch (err) {
      return this.troubleOr(ws, err, 'GitHub didn’t re-run the checks');
    }
    // Looked at often again, as after a push: the checks show as running soon.
    this.pushedAt.set(id, this.now());
    await this.refreshPrs(id);
    const message = `PR #${pr.number}’s failed checks are running again`;
    this.deps.toast(message, 'success');
    return { ok: true, message };
  }

  openPr(id: string): void {
    const pr = this.deps.store.getState().prs[id];
    if (pr) (this.deps.open ?? systemOpen)(pr.url);
  }

  /** Everything said on a worktree's PR: its comments, reviews and threads on lines. */
  async prConversation(id: string): Promise<{ readonly ok: true; readonly conversation: PrConversation } | (GitHubOutcome & { readonly ok: false })> {
    const ws = this.manager.find(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr) return { ok: false, message: 'This worktree has no pull request' };
    try {
      return { ok: true, conversation: await (this.deps.prConversation ?? prConversation)(ws.path, pr.number) };
    } catch (err) {
      const trouble = await this.troubleOf(ws, err);
      return { ok: false, message: trouble ? troubleLine(trouble) : `GitHub didn’t give the comments: ${firstLine(err)}`, ...(trouble ? { trouble } : {}) };
    }
  }

  /** Say something on a worktree's PR as you: a comment, a reply in a thread, or a thread resolved or opened again. */
  async prPost(id: string, post: PrPost): Promise<GitHubOutcome> {
    const ws = this.manager.find(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr) return { ok: false, message: 'This worktree has no pull request' };
    try {
      await (this.deps.postOnPr ?? postOnPr)(ws.path, pr.number, post);
    } catch (err) {
      return this.troubleOr(ws, err, post.kind === 'resolve' ? 'GitHub didn’t resolve it' : post.kind === 'unresolve' ? 'GitHub didn’t open it again' : 'GitHub didn’t post it');
    }
    const message = post.kind === 'resolve' ? 'Resolved' : post.kind === 'unresolve' ? 'Opened again' : post.kind === 'reply' ? 'Replied on GitHub' : `Commented on PR #${pr.number}`;
    return { ok: true, message };
  }

  /** Claude works through the PR's review comments in the chat (all open threads, or one). */
  async addressPrComments(id: string, threadId?: string): Promise<void> {
    const pr = this.deps.store.getState().prs[id];
    if (!pr) return;
    let thread: PrThread | undefined;
    if (threadId) {
      const got = await this.prConversation(id);
      thread = got.ok ? got.conversation.threads.find((t) => t.id === threadId) : undefined;
      if (!thread) {
        this.deps.toast('That comment isn’t on GitHub anymore', 'warn');
        return;
      }
    }
    this.deps.controller.open(id);
    this.deps.askClaude(addressCommentsPrompt(pr, thread), `ws:${id}`);
  }

  /** A workspace's file in your editor at a line. */
  async openCode(id: string, file: string, line?: number): Promise<{ readonly ok: boolean; readonly message?: string }> {
    const ws = this.manager.find(id);
    if (!ws) return { ok: false, message: 'That workspace is gone' };
    try {
      await openCode(ws.path, file, line, (full) => (this.deps.open ?? systemOpen)(full));
      return { ok: true };
    } catch (err) {
      this.deps.toast(firstLine(err), 'warn');
      return { ok: false, message: firstLine(err) };
    }
  }

  /** Where a workspace's folder is (a live preview builds from it), or undefined when it's gone. */
  folderOf(id: string): string | undefined {
    return this.manager.find(id)?.path;
  }

  /** Lines of a file in a workspace, for a code block in chat (never outside it, never a secret). */
  async excerpt(id: string, file: string, from?: number, to?: number): Promise<{ readonly ok: true; readonly excerpt: Excerpt } | { readonly ok: false; readonly message: string }> {
    const ws = this.manager.find(id);
    if (!ws) return { ok: false, message: 'That workspace is gone' };
    try {
      return { ok: true, excerpt: await readExcerpt(ws.path, file, from, to) };
    } catch (err) {
      return { ok: false, message: firstLine(err) };
    }
  }

  /**
   * Look up PRs for your worktrees with commits (and notice when one you asked for opens, or
   * checks finish). Worktrees other tools made (Claude Code sub-agents, Conductor…) are theirs to watch.
   */
  async refreshPrs(only?: string, recheckGh = false): Promise<void> {
    if (this.deps.store.getState().gh === false) {
      // "Check Again" (the Mac's Connect GitHub sheet): maybe gh was installed or signed in to since.
      if (!recheckGh) return;
      forgetGh();
      if (!(await (this.deps.hasGh ?? hasGh)())) return;
      this.deps.store.dispatch({ type: 'gh', ok: true });
    }
    // The first look after starting only learns what exists; news is what changes after that.
    const quiet = !this.prsSeeded && !only;
    for (const ws of this.prWorktrees(only)) this.pushed(ws);
    await this.lookUpPrs(this.prWorktrees(only), quiet);
    if (!only) {
      this.prsSeeded = true;
      await this.runQueuedPolls();
    }
  }

  /**
   * Look again at the PRs that are due (see prCadence), and right away at a branch that was just
   * pushed. Runs every few seconds; `focus`: you came back to the window, so anything not looked
   * at in the last few seconds is; `push`: a branch was pushed (`id`, or any).
   */
  async pollPrs(reason: 'tick' | 'focus' | 'push' = 'tick', id?: string): Promise<void> {
    if (this.deps.store.getState().gh !== true) return;
    if (!this.prsSeeded || this.polling) {
      // Another tick comes in a few seconds; focus and push are asked once, so they wait their turn.
      if (reason !== 'tick' && !this.pollQueue.some((q) => q.reason === reason && q.id === id)) this.pollQueue.push({ reason, ...(id ? { id } : {}) });
      return;
    }
    this.polling = true;
    try {
      const now = this.now();
      const prs = this.deps.store.getState().prs;
      const due = this.prWorktrees().filter((ws) => {
        const pushed = this.pushed(ws) || (reason === 'push' && ws.id === id);
        if (pushed) this.pushedAt.set(ws.id, now);
        // Merge When Ready waits on it: looked at often, so it merges soon after its checks pass.
        const every = ws.mergeWhenReady && prs[ws.id]?.state === 'OPEN' ? PR_FAST_MS : prCadence(prs[ws.id], this.pushedAt.get(ws.id), now);
        if (every === undefined) return false;
        // Low Power mode (BLG-621): looked at less often, unless you came back to the window or pushed.
        return pushed || now - (this.prChecked.get(ws.id) ?? 0) >= (reason === 'focus' ? PR_FOCUS_FRESH_MS : pace(every, this.deps.store.getState().powerSaving));
      });
      if (due.length) await this.lookUpPrs(due, false);
    } finally {
      this.polling = false;
    }
    await this.runQueuedPolls();
  }

  /** Run the focus and push looks that were asked for while another look ran. */
  private async runQueuedPolls(): Promise<void> {
    for (const q of this.pollQueue.splice(0)) await this.pollPrs(q.reason, q.id);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Your worktrees whose PRs are watched: with commits, or a PR already (or just `only`). Other tools' worktrees are theirs to watch. */
  private prWorktrees(only?: string): Workspace[] {
    const prs = this.deps.store.getState().prs;
    return this.manager.list.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && w.branch && !w.archived && worktreeOrigin(w) === 'beluga' && (only ? w.id === only : (w.status?.ahead ?? 0) > 0 || prs[w.id]));
  }

  /** Whether the branch moved on origin since last time (pushed, or fetched after someone pushed). */
  private pushed(ws: Workspace): boolean {
    const ref = (this.deps.remoteRef ?? remoteRef)(ws.path, ws.branch!);
    const known = this.remoteSeen.has(ws.id);
    const before = this.remoteSeen.get(ws.id);
    this.remoteSeen.set(ws.id, ref);
    if (!known || !ref || ref === before) return false;
    this.pushedAt.set(ws.id, this.now());
    return true;
  }

  /**
   * Ask gh about these worktrees' PRs, three calls at a time: one `gh pr list` for a project
   * with several, `gh pr view` for the rest.
   */
  private async lookUpPrs(list: readonly Workspace[], quiet: boolean): Promise<void> {
    const find = this.deps.findPr ?? findPr;
    const listAll = this.deps.listPrs ?? (this.deps.findPr ? undefined : listPrs);
    const now = this.now();
    for (const ws of list) this.prChecked.set(ws.id, now);
    const one = async (ws: Workspace): Promise<void> => {
      try {
        this.gotPr(ws, await find(ws.path, ws.branch!), quiet);
      } catch {
        // gh couldn't tell this time: keep what we knew
      }
    };
    const byProject = new Map<string, Workspace[]>();
    for (const ws of list) byProject.set(ws.projectId, [...(byProject.get(ws.projectId) ?? []), ws]);
    const later: Workspace[] = [];
    const tasks: Array<() => Promise<void>> = [];
    for (const all of byProject.values()) {
      // A PR on a fork's original isn't in origin's list: asked about by itself (gh pr view owner:branch there).
      // Nor is a fork's PR checked out here by its branch name: asked about by its number.
      const group = all.filter((ws) => !prTargetOf(ws.path, ws.branch) && pullOfBranch(ws.path, ws.branch!) === undefined);
      tasks.push(...all.filter((ws) => !group.includes(ws)).map((ws) => () => one(ws)));
      if (!listAll || group.length < 2) {
        tasks.push(...group.map((ws) => () => one(ws)));
        continue;
      }
      tasks.push(async () => {
        let found: Awaited<ReturnType<typeof listAll>>;
        try {
          found = await listAll(group[0]!.path);
        } catch {
          return; // gh couldn't tell this time
        }
        for (const ws of group) {
          const pr = found.prs.get(ws.branch!);
          // Not in a full page: maybe just older than what came back, so asked about by itself.
          if (pr || (!found.full && !this.deps.store.getState().prs[ws.id])) this.gotPr(ws, pr, quiet);
          else later.push(ws);
        }
      });
    }
    await inPool(tasks, PR_CONCURRENCY);
    await inPool(later.map((ws) => () => one(ws)), PR_CONCURRENCY);
  }

  /** gh's answer for a worktree's branch: keep it, and tell you what changed. */
  private gotPr(ws: Workspace, found: PullRequest | undefined, quiet: boolean): void {
    // A PR you carried on after (Continue After Merge) is done: the branch waits for its next one.
    // Numbers only compare within one repository (a fork's and its original's both have a #5).
    const sameRepo = !ws.prShipped?.url || !found || repoOfPr(ws.prShipped.url) === repoOfPr(found.url);
    const pr = found && ws.prDone !== undefined && sameRepo && found.number <= ws.prDone ? undefined : found;
    const before = this.deps.store.getState().prs[ws.id];
    if (!samePr(before, pr)) this.deps.store.dispatch({ type: 'pr', id: ws.id, pr });
    // Merged at that commit: what's in it is on GitHub, so the Delete step stops counting it as unpushed (BLG-833).
    if (pr?.state === 'MERGED' && pr.head && this.manager.setMergedHead(ws.id, pr.head)) void this.deps.controller.refreshWorkspace(ws.path).catch(() => undefined);
    void this.settleMergeWait(ws, pr);
    const state = this.deps.store.getState();
    const key = triageKey(state, `ws:${ws.id}`);
    const lastAt = (key ? state.triage[key]?.lastAt : undefined) ?? lastLogAt(state.log, `ws:${ws.id}`);
    if (pr && mergedLineDue(pr, before, quiet, this.manager.find(ws.id)?.mergeSaid, lastAt)) {
      this.manager.setMergeSaid(ws.id, pr.number);
      this.sayMerged(ws.id, { into: this.prBase(ws), number: pr.number, url: pr.url });
    }
    if (!pr || quiet) return;
    const asked = this.prAsked.delete(ws.id);
    // Merged or closed is said once, even if gh's answers flicker.
    const ended = `${ws.id}#${pr.number}:${pr.state}`;
    const told = pr.state !== 'OPEN' && this.prEnded.has(ended);
    if (pr.state !== 'OPEN') this.prEnded.add(ended);
    for (const e of prNews(ws.name, `ws:${ws.id}`, told && before ? { ...before, state: pr.state } : before, pr, asked)) this.deps.notify(e);
  }

  /** Open your PR instructions in your editor (created with the built-in text the first time). */
  editPrPrompt(): void {
    const file = ensurePrPromptFile();
    const opened = (): void => {
      this.deps.store.dispatch({ type: 'pr_custom', custom: true });
      this.deps.toast(`Opened ${tilde(file)}. Save it; the next PR uses it`, 'success');
    };
    // The system's own way to open it: when there's no editor to start, or yours didn't start.
    const openHere = (): void => {
      (this.deps.open ?? systemOpen)(file);
      opened();
    };
    const editor = process.env.VISUAL ?? '';
    if (/\b(code|cursor|subl|zed|mate|gedit|kate)\b/.test(editor)) {
      const how = editorCommand(editor, file);
      const child = spawn(how.command, [...how.args], { stdio: 'ignore', detached: true, shell: how.shell, windowsHide: true });
      child.once('spawn', opened);
      child.once('error', openHere);
      // Through cmd (Windows) it always starts: cmd ending at once with an error means the editor
      // wasn't found, so the system opens it. (An editor run with --wait ends much later.)
      if (how.shell) {
        const started = Date.now();
        child.once('exit', (code) => {
          if (code !== 0 && Date.now() - started < EDITOR_MISSING_MS) (this.deps.open ?? systemOpen)(file);
        });
      }
      child.unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-t', file], { stdio: 'ignore', detached: true })
        .once('spawn', opened)
        .once('error', openHere)
        .unref();
    } else openHere();
  }

  resetPrPrompt(): void {
    resetPrPrompt();
    this.deps.store.dispatch({ type: 'pr_custom', custom: false });
    this.deps.toast('Pull requests use the built-in instructions again', 'success');
  }

  // ------------------------------------------------------- terminal & scripts

  private openSession(key: string, ws: Workspace | { path: string }, command?: string, size = START_SIZE): PtyProcess | undefined {
    const terminals = this.deps.terminals;
    if (!terminals) return undefined;
    const prefs = this.deps.store.getState().prefs;
    // Commands are written for sh, so they run in an sh-like shell even if yours is fish or nu.
    const shell = command ? scriptShell(prefs.shell) : prefs.shell;
    const place: EnvPlace = 'id' in ws ? { workspaceId: ws.id } : { dir: ws.path };
    const vars = this.deps.envFor?.(place) ?? {};
    const env = { ...vars, ...('projectRoot' in ws ? scriptEnv(ws) : {}) };
    const session = terminals.open(key, {
      cwd: ws.path,
      cols: size.cols,
      rows: size.rows,
      env,
      ...(shell ? { shell } : {}),
      // PowerShell and cmd (Windows) take neither -l nor -c: each shell gets the arguments it knows.
      ...(command ? { args: commandArgs(shell ?? defaultShell(), command), title: command } : { args: shellArgs({ login: prefs.shellLogin, extra: prefs.shellArgs, shell: shell ?? defaultShell() }) }),
    });
    this.deps.store.dispatch({ type: 'terminal', id: key, title: session.title });
    // A setup is over in a moment: only shells and the run command are worth a restart later.
    if (!key.endsWith(':setup') && !key.endsWith(':github')) this.started.set(key, { place, env: envText(vars) });
    this.envChanged();
    // Every screen sees when it ends (the tab shows its exit code; clicking starts it again).
    const report = (code: number | null): void => {
      if (this.deps.terminals?.get(key) !== session) return;
      this.deps.store.dispatch({ type: 'terminal_exit', id: key, code });
      this.envChanged();
    };
    if (session.exited) report(session.exited.code);
    else session.onExit((exit) => report(exit.code));
    return session;
  }

  /** The workspace's shell (started on first use). */
  shell(wsId: string, size?: { cols: number; rows: number }): PtyProcess | undefined {
    const ws = this.manager.find(wsId);
    if (!ws || ws.archived) return undefined;
    const existing = this.deps.terminals?.get(shellId(wsId));
    if (existing?.running) return existing;
    if (existing) this.deps.terminals?.close(shellId(wsId));
    return this.openSession(shellId(wsId), ws, undefined, size);
  }

  /**
   * A shell of the global Terminal tab (`key` from globalShellId), started in `dir`.
   * A running one is kept; an exited one starts again.
   */
  globalShell(key: string, dir: string, size?: { cols: number; rows: number }): PtyProcess | undefined {
    const existing = this.deps.terminals?.get(key);
    if (existing?.running) return existing;
    if (existing) this.deps.terminals?.close(key);
    return this.openSession(key, { path: dir }, undefined, size);
  }

  /**
   * A program in a workspace's folder as one of its terminals, not your shell: the agent's own
   * terminal app (BLG-534). Your variables and the worktree's, the program's own over them. One
   * already there under `key` is closed first.
   */
  openProgram(key: string, ws: Workspace, program: { readonly file: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly title: string }, size = START_SIZE): PtyProcess | undefined {
    const terminals = this.deps.terminals;
    if (!terminals) return undefined;
    if (terminals.get(key)) this.closeTerminal(key);
    const vars = this.deps.envFor?.({ workspaceId: ws.id }) ?? {};
    const session = terminals.open(key, { cwd: ws.path, cols: size.cols, rows: size.rows, env: { ...vars, ...scriptEnv(ws), ...program.env }, shell: program.file, args: [...program.args], title: program.title });
    this.deps.store.dispatch({ type: 'terminal', id: key, title: session.title });
    const report = (code: number | null): void => {
      if (this.deps.terminals?.get(key) === session) this.deps.store.dispatch({ type: 'terminal_exit', id: key, code });
    };
    if (session.exited) report(session.exited.code);
    else session.onExit((exit) => report(exit.code));
    return session;
  }

  /** The global Terminal tab's shells, in the order they were opened. */
  globalShells(): string[] {
    return (this.deps.terminals?.list() ?? []).map((s) => s.id).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  }

  /** Name a terminal for every screen (an empty name goes back to Shell N). Kept until it's closed. */
  renameTerminal(key: string, name: string): void {
    if (!(key in this.deps.store.getState().terminals)) return;
    const clean = cleanTerminalName(name);
    this.deps.store.dispatch({ type: 'terminal_name', id: key, ...(clean ? { name: clean } : {}) });
  }

  /**
   * Your variables changed (Settings › Environment, /env): mark the terminals still running with
   * the ones they started with. Claude and new terminals already get the new ones.
   */
  envChanged(): void {
    const stale = [...this.started]
      .filter(([key, s]) => this.deps.terminals?.get(key)?.running && envText(this.deps.envFor?.(s.place) ?? {}) !== s.env)
      .map(([key]) => key)
      .sort();
    this.deps.store.dispatch({ type: 'terminal_env_stale', ids: stale });
  }

  /** Start a shell or the run command again, so it has your variables as they are now (its name stays). */
  restartTerminal(key: string): PtyProcess | undefined {
    const was = this.started.get(key);
    const name = this.deps.store.getState().termNames[key];
    const keepName = (session: PtyProcess | undefined): PtyProcess | undefined => {
      if (session && name) this.deps.store.dispatch({ type: 'terminal_name', id: key, name });
      return session;
    };
    if (isGlobalShell(key)) {
      if (!was?.place.dir) return undefined;
      this.closeTerminal(key);
      return keepName(this.globalShell(key, was.place.dir));
    }
    if (key.endsWith(':setup') || key.endsWith(':github')) return undefined;
    if (key.endsWith(':run')) {
      const wsId = key.slice(0, -':run'.length);
      this.closeTerminal(key);
      return this.run(wsId);
    }
    this.closeTerminal(key);
    return keepName(this.shell(key));
  }

  /** Close a terminal session (shell, setup or run). */
  closeTerminal(key: string): void {
    this.watchers.get(key)?.();
    this.watchers.delete(key);
    this.deps.terminals?.close(key);
    this.deps.store.dispatch({ type: 'terminal', id: key });
    if (this.started.delete(key)) this.envChanged();
    // A setup that was closed before it finished isn't "setting up" anymore.
    const wsId = key.endsWith(':setup') ? key.slice(0, -':setup'.length) : undefined;
    if (wsId && this.deps.store.getState().setup[wsId]?.status === 'running') this.deps.store.dispatch({ type: 'setup', id: wsId });
  }

  /** Stop a workspace's shell, setup and run terminals (it's being archived or deleted). */
  closeTerminals(wsId: string): void {
    for (const key of [shellId(wsId), setupId(wsId), runId(wsId), githubId(wsId), agentTermId(wsId)]) if (this.deps.terminals?.get(key)) this.closeTerminal(key);
    // Shells split beside the agent's terminal.
    for (const s of this.deps.terminals?.list() ?? []) if (s.id.startsWith(`${wsId}:pane:`)) this.closeTerminal(s.id);
  }

  private watchExit(key: string, session: PtyProcess, onExit: (code: number | null) => void): void {
    this.watchers.get(key)?.();
    if (session.exited) return onExit(session.exited.code);
    const off = session.onExit((exited) => {
      off();
      this.watchers.delete(key);
      onExit(exited.code);
    });
    this.watchers.set(key, off);
  }

  /**
   * Run the project's setup in a new worktree (visible in its Terminal tab). A command that comes
   * from the repository itself (beluga.json / conductor.json) asks you the first time it would
   * run by itself, and again whenever it changes. A command that doesn't fit the project (an
   * install with no package.json, the wrong package manager) is skipped or corrected, and remembered.
   */
  runSetup(wsId: string, auto = false, known?: Workspace): void {
    // `known`: the worktree just made, in case the list is between refreshes and doesn't show it yet.
    const ws = this.manager.find(wsId) ?? known;
    const project = ws ? this.manager.list.find((p) => p.id === ws.projectId) : undefined;
    // Read now, not from the last refresh: what Claude just worked out counts.
    const setup = project ? this.manager.scripts(project.id).setup : undefined;
    const command = setup?.command;
    if (!ws || !project || !command) {
      if (!auto) this.deps.toast('This project has no setup command. Set one in its ⋯ menu', 'warn');
      return;
    }
    if (!this.deps.terminals) return;
    const fit = checkSetup(ws.path, command);
    if (fit.kind === 'skip') {
      this.learnSetup(project.id, { none: true }, `No setup for ${project.name}: ${fit.reason}. New worktrees skip it from now on`);
      return;
    }
    if (fit.kind === 'swap') {
      this.learnSetup(project.id, { command: fit.command }, `Setup for ${project.name} is now \`${fit.command}\`: ${fit.reason}`);
      return this.startSetup(ws, fit.command);
    }
    const fromRepo = setup.source === 'beluga.json' || setup.source === 'klaud.json' || setup.source === 'conductor.json';
    // Claude worked it out from what's in the repository, so it asks the same way.
    const byClaude = setup.source === 'claude';
    if (auto && (fromRepo || byClaude) && !this.manager.isScriptApproved(project.id, command)) {
      if (!this.deps.confirm) return;
      const [title, from] = byClaude ? [`${this.agent()} worked out ${project.name}'s setup for new worktrees`, `${this.agent()} read it from the repository`] : [`${project.name}'s ${setup.source} wants to run its setup in new worktrees`, 'This comes from the repository'];
      // Worktrees made together share one question.
      const key = `${project.id}\n${command}`;
      let asking = this.askingSetup.get(key);
      if (!asking) {
        asking = this.deps.confirm(title, `${command}\n\n${from}. Allow it if you trust what's in it. "Always" remembers this exact command.`).finally(() => this.askingSetup.delete(key));
        this.askingSetup.set(key, asking);
      }
      void asking.then((answer) => {
        if (answer === 'no') return void this.deps.toast('Setup skipped. Run it any time from the Terminal tab');
        if (answer === 'always') this.manager.approveScript(project.id, command);
        this.startSetup(ws, command);
      });
      return;
    }
    this.startSetup(ws, command);
  }

  /** Remember a project's setup for you (a command, or none), so the next worktree gets it right. */
  private learnSetup(projectId: string, fix: SetupFix, note: string): void {
    try {
      this.manager.setScripts(projectId, 'none' in fix ? { setup: undefined, skipSetup: true } : { setup: fix.command, skipSetup: undefined });
      void this.deps.controller.refresh();
      this.deps.toast(note, 'success');
    } catch (err) {
      this.deps.toast(`Couldn't remember the setup: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** `learn`: if it fails, a small model works out the right setup once, and that runs instead. */
  private startSetup(ws: Workspace, command: string, learn = true): void {
    const wsId = ws.id;
    this.closeTerminal(setupId(wsId));
    // Its npm installs copied from a checkout that already has them (BLG-366): not from one still setting up.
    const setups = this.deps.store.getState().setup;
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    const sources = project ? [project.root, ...project.workspaces.filter((w) => w.id !== wsId && !w.pending && setups[w.id]?.status !== 'running').map((w) => w.path)] : [];
    const session = this.openSession(setupId(wsId), ws, clonedSetup(command, ws.path, sources) ?? command);
    if (!session) return;
    this.deps.store.dispatch({ type: 'setup', id: wsId, run: { status: 'running', command } });
    this.deps.toast(`Setting up ${ws.name}: ${command}`);
    this.watchExit(setupId(wsId), session, (code) => {
      if (code === 0) {
        this.deps.store.dispatch({ type: 'setup', id: wsId, run: { status: 'done', command } });
        this.deps.toast(`${ws.name} is set up`, 'success');
        return;
      }
      if (learn && this.deps.fixSetup) return void this.retrySetup(ws, command, code, session.backlog());
      this.setupFailed(ws, command, code, session.backlog());
    });
  }

  private setupFailed(ws: Workspace, command: string, code: number | null, output = ''): void {
    this.deps.store.dispatch({ type: 'setup', id: ws.id, run: { status: 'failed', command, detail: `exit code ${code ?? '?'}` } });
    this.deps.notify({ kind: 'problems', title: `Setup failed in ${ws.name}`, body: `${command} (exit code ${code ?? '?'}). See its Terminal tab`, channel: `ws:${ws.id}` });
    this.offerFix(ws, 'setup', command, code, output);
  }

  /**
   * Setup or Run failed: "The run didn't work. Do you want me to fix it?" Yes: for a run, a model
   * first sees whether the command is wrong (a better one is remembered and started); otherwise
   * (and for a setup, whose command a model already had a go at) your Claude in that worktree
   * gets the failure and fixes the project.
   */
  private offerFix(ws: Workspace, kind: 'setup' | 'run', command: string, code: number | null, output: string): void {
    const key = `${ws.id}:${kind}`;
    if (!this.deps.confirm || !this.deps.hasClaude?.() || this.offered.has(key)) return;
    this.offered.add(key);
    const what = kind === 'run' ? 'The run' : 'The setup';
    const tail = output.replace(ANSI, '').trimEnd().slice(-FAIL_TAIL_CHARS);
    void this.deps
      .confirm(`${what} didn't work in ${ws.name}. Do you want me to fix it?`, `${command}\nstopped with exit code ${code ?? '?'}.${tail ? `\n\n${tail}` : ''}`)
      .then((answer) => {
        this.offered.delete(key);
        if (answer !== 'no') return this.fixFailed(ws, kind, command, code, output);
      })
      .catch(() => this.offered.delete(key));
  }

  private async fixFailed(ws: Workspace, kind: 'setup' | 'run', command: string, code: number | null, output: string): Promise<void> {
    if (!this.manager.find(ws.id)) return;
    if (kind === 'run' && this.deps.fixRun) {
      this.deps.toast(`Looking at why the run failed in ${ws.name}…`);
      const fix = await this.deps.fixRun(ws.path, command, output);
      const project = this.manager.find(ws.id) && this.manager.list.find((p) => p.id === ws.projectId);
      if (!project) return;
      if (fix && 'command' in fix && fix.command !== command) {
        this.remember(project.id, { run: fix.command }, ['run']);
        this.deps.toast(`Run for ${project.name} is now \`${fix.command}\` (\`${command}\` failed)`, 'success');
        this.closeTerminal(runId(ws.id));
        this.run(ws.id);
        return;
      }
    }
    // The command is right; what it runs is broken: Claude fixes it, right there.
    this.deps.askClaude(fixFailedPrompt(kind, command, code, output), `ws:${ws.id}`);
  }

  /** Keep commands for you, marked as Claude's (`byClaude`), and show them. */
  private remember(projectId: string, scripts: ProjectScripts, byClaude: ReadonlyArray<'setup' | 'run'>): void {
    const had = this.manager.yourScripts(projectId).byClaude ?? [];
    const marked = [...new Set([...had, ...byClaude])];
    this.manager.setScripts(projectId, { ...scripts, ...(marked.length ? { byClaude: marked } : {}) });
    void this.deps.controller.refresh();
  }

  /** Setup failed: ask what it should be, remember the answer, and run that (once). */
  private async retrySetup(ws: Workspace, command: string, code: number | null, output: string): Promise<void> {
    this.deps.toast(`Setup failed in ${ws.name}. Looking for the right one…`);
    const fix = await this.deps.fixSetup!(ws.path, command, output);
    const project = this.manager.find(ws.id) && this.manager.list.find((p) => p.id === ws.projectId);
    if (!project || !fix || ('command' in fix && fix.command === command)) return this.setupFailed(ws, command, code, output);
    if ('none' in fix) {
      this.deps.store.dispatch({ type: 'setup', id: ws.id });
      return this.learnSetup(project.id, fix, `${project.name} needs no setup. New worktrees skip it from now on`);
    }
    this.learnSetup(project.id, fix, `Setup for ${project.name} is now \`${fix.command}\` (\`${command}\` failed)`);
    this.startSetup(ws, fix.command, false);
  }

  /**
   * New worktrees (and forks, handoffs) get the project's setup when that's switched on. The first
   * one of a project whose files and tooling don't say how to set it up or run it has Claude work
   * that out first (once: it's remembered for the next ones).
   */
  onWorktreeCreated(ws: Workspace): void {
    // Still there (not deleted while Claude looked): the list, or its folder if the list is mid-refresh.
    const setup = (): void => {
      if (this.deps.store.getState().prefs.autoSetup && (this.manager.find(ws.id) || existsSync(ws.path))) this.runSetup(ws.id, true, ws);
    };
    const looking = this.workOut(ws);
    if (looking) void looking.then(setup);
    else setup();
  }

  /**
   * Claude looks at a project once, in a worktree of it, for what its own files and tooling
   * (beluga.json, a Makefile, a lockfile, package.json…) don't say: its setup, its run command.
   * What it says is kept as yours, marked as Claude's. Undefined when there's nothing to look at.
   */
  private workOut(ws: Workspace): Promise<void> | undefined {
    return this.workOutIn(ws.projectId, ws.path);
  }

  /**
   * A project just made ready on this computer (BLG-787): its setup worked out for this system
   * (`system`, said to the setup agent) in its main folder and kept here, like a first worktree's.
   * → the setup new worktrees run here (none: it needs none, or it couldn't be told).
   */
  async workOutFor(projectId: string, system: string): Promise<string | undefined> {
    const project = this.manager.list.find((p) => p.id === projectId);
    if (project?.root) await this.workOutIn(projectId, project.root, system);
    return this.manager.yourScripts(projectId).skipSetup ? undefined : this.manager.scripts(projectId).setup?.command;
  }

  private workOutIn(projectId: string, dir: string, system?: string): Promise<void> | undefined {
    const project = this.manager.list.find((p) => p.id === projectId);
    if (!project?.root || !this.deps.workOutScripts) return undefined;
    const pending = this.workingOut.get(project.id);
    if (pending) return pending;
    const yours = this.manager.yourScripts(project.id);
    if (yours.looked) return undefined;
    const now = this.manager.scripts(project.id);
    // A setup guessed from lockfiles (`npm install`) can miss part of the project: Claude checks it too.
    // A Makefile or justfile target is the project's own word, not a guess.
    const guessed = now.setup?.source === 'detected' && !/^(make|just) /.test(now.setup.command) ? now.setup.command : undefined;
    const want = { setup: (!now.setup || Boolean(guessed)) && !yours.skipSetup, run: !now.run };
    if (!want.setup && !want.run) return undefined;
    const asked = this.deps.workOutScripts(dir, { ...want, ...(system ? { system } : {}) });
    if (!asked) return undefined;
    this.deps.toast(`Working out how to ${want.setup && want.run ? 'set up and run' : want.setup ? 'set up' : 'run'} ${project.name}…`);
    const done = asked
      .then((found) => {
        // No answer (Claude couldn't): the next new worktree tries again.
        if (!found || !this.manager.list.some((p) => p.id === project.id)) return;
        const learned: { -readonly [K in keyof ProjectScripts]: ProjectScripts[K] } = { looked: true };
        const mine: Array<'setup' | 'run'> = [];
        const said: string[] = [];
        // Checking a guess: the same command, or "none" where the files say there's something to
        // install, keeps the guess (it runs without asking); only a different command is kept.
        const setup = guessed && found.setup && ('none' in found.setup || found.setup.command === guessed) ? undefined : found.setup;
        if (setup && 'none' in setup) {
          learned.skipSetup = true;
          said.push('no setup needed');
        } else if (setup) {
          learned.setup = setup.command;
          mine.push('setup');
          said.push(`setup \`${setup.command}\``);
        }
        if (found.run && 'command' in found.run) {
          learned.run = found.run.command;
          mine.push('run');
          said.push(`run \`${found.run.command}\``);
        } else if (found.run) said.push('nothing to run');
        this.remember(project.id, learned, mine);
        if (said.length) this.deps.toast(`${project.name}: ${said.join(', ')}. Change them in its ⋯ menu (Setup and run commands)`, 'success');
      })
      .catch(() => undefined)
      .finally(() => this.workingOut.delete(project.id));
    this.workingOut.set(project.id, done);
    return done;
  }

  /**
   * An archived worktree is back: its dependencies and builds were thrown away, so the project's
   * setup makes them again; without one, say what to run.
   */
  onWorktreeRestored(ws: Workspace, remake: readonly string[]): void {
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    if (project?.scripts?.setup?.command) return this.runSetup(ws.id, true);
    if (remake.length) this.deps.toast(`Restored. Its dependencies and builds were cleared when it was archived: run ${remake.map((r) => `\`${r}\``).join(', then ')} to make them again`, 'info');
  }

  /**
   * Start (or restart) the project's run command, e.g. its dev server. With none yet, Claude works
   * one out first (when it hasn't already). If it stops with an error, you're asked whether Claude
   * should fix it.
   */
  run(wsId: string): PtyProcess | undefined {
    const ws = this.manager.find(wsId);
    const project = ws ? this.manager.list.find((p) => p.id === ws.projectId) : undefined;
    const command = project ? this.manager.scripts(project.id).run?.command : undefined;
    if (!ws || !command) {
      const looking = ws ? this.workOut(ws) : undefined;
      if (looking && ws) {
        void looking.then(() => {
          if (this.manager.find(wsId) && project && this.manager.scripts(project.id).run) this.run(wsId);
          else this.deps.toast(`${this.agent()} couldn't find a way to run this project. Set one in its ⋯ menu (Setup and run commands)`, 'warn');
        });
        return undefined;
      }
      this.deps.toast("This project has no run command. Set one in its ⋯ menu (Setup and run commands)", 'warn');
      return undefined;
    }
    const current = this.deps.terminals?.get(runId(wsId));
    if (current?.running) return current;
    this.closeTerminal(runId(wsId));
    this.stopping.delete(wsId);
    const session = this.openSession(runId(wsId), ws, command);
    if (session)
      this.watchExit(runId(wsId), session, (code) => {
        // Stopped by you (Stop, ^C, closing it) or ended fine: not a failure.
        if (this.stopping.delete(wsId) || code === null || code === 0 || STOPPED_CODES.has(code)) return;
        this.offerFix(ws, 'run', command, code, session.backlog());
      });
    return session;
  }

  stopRun(wsId: string): void {
    const session = this.deps.terminals?.get(runId(wsId));
    if (session?.running) this.stopping.add(wsId);
    session?.kill();
  }

  /**
   * Set a project's setup or run command for you, or (`team`) in its beluga.json so everyone on
   * the project gets it; then your own one for it is dropped, so the shared one applies.
   */
  setScript(projectId: string, kind: 'setup' | 'run', command: string, team = false): void {
    try {
      const value = command.trim() || undefined;
      // Choosing a setup yourself overrides one learned as unneeded; either one is no longer Claude's.
      const claudes = (this.manager.yourScripts(projectId).byClaude ?? []).filter((k) => k !== kind);
      const learned = { ...(kind === 'setup' ? { skipSetup: undefined } : {}), byClaude: claudes.length ? claudes : undefined };
      if (team) {
        this.manager.setScripts(projectId, { [kind]: value }, { inRepo: true });
        this.manager.setScripts(projectId, { [kind]: undefined, ...learned });
      } else this.manager.setScripts(projectId, { [kind]: value, ...learned });
      void this.deps.controller.refresh();
      const label = kind === 'setup' ? 'Setup' : 'Run';
      const root = this.manager.list.find((x) => x.id === projectId)?.root;
      this.deps.toast(value ? `${label}: ${value}${team ? ` (saved to ${root ? projectFileName(root) : PROJECT_FILES[0]})` : ''}` : `${label} command cleared`, 'success');
    } catch (err) {
      this.deps.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /**
   * A run of your own Claude in a worktree: what the project's setup is, and a way for Claude to
   * change it when it finds it incomplete (it had to install something the setup didn't). What it
   * sets is kept as yours, marked as Claude's, so the next worktree asks you once before running it.
   */
  setupForRun(wsId: string): SetupTools | undefined {
    const ws = this.manager.find(wsId);
    const project = ws ? this.manager.list.find((p) => p.id === ws.projectId) : undefined;
    if (!ws || ws.kind === 'main' || !project?.root) return undefined;
    const now = this.manager.scripts(project.id).setup;
    return {
      brief: buildSetupAppend(project.name, now?.command, now?.source),
      set: (command, why) => {
        const value = command.trim();
        if (!value) return 'Give the whole setup command.';
        if (!this.manager.list.some((p) => p.id === project.id)) return 'That project is gone.';
        if (value === this.manager.scripts(project.id).setup?.command) return `The setup is already \`${value}\`.`;
        this.remember(project.id, { setup: value, skipSetup: undefined }, ['setup']);
        this.deps.toast(`Setup for ${project.name} is now \`${value}\`: ${why}`, 'success');
        return `Saved: new worktrees of ${project.name} run \`${value}\` (the owner approves it once the first time it runs by itself).`;
      },
    };
  }

  /** Put your commands in the project's beluga.json (or its older klaud.json) so teammates get them. */
  shareScripts(projectId: string): void {
    const p = this.manager.list.find((x) => x.id === projectId);
    if (!p?.scripts) return;
    this.manager.setScripts(projectId, { setup: p.scripts.setup?.command, run: p.scripts.run?.command }, { inRepo: true });
    void this.deps.controller.refresh();
    this.deps.toast(`Saved to ${p.name}/${projectFileName(p.root)}. Commit it to share it`, 'success');
  }

  // ------------------------------------------------------- usage & space

  /** Claude reported tokens and cost for a run in a workspace. */
  onUsage(channel: string, json: string): void {
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (!id) return;
    try {
      const u = JSON.parse(json) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; session?: string; free?: boolean; tps?: number };
      const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
      this.manager.addUsage(id, { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), cost: num(u.cost), session: typeof u.session === 'string' ? u.session : undefined, ...(u.free === true ? { free: true, ...(num(u.tps) ? { tps: num(u.tps) } : {}) } : {}) });
      void this.deps.controller.refresh();
    } catch {
      // Not usage we understand.
    }
  }

  /** How much disk each worktree and chat folder takes. */
  /**
   * The picker's runtimes made true: one that can say whether it's ready here (Codex: installed,
   * signed in) is greyed with what to do until it is, then lists its models. Asked again a while
   * later until every one is (you may sign in meanwhile).
   */
  private checkRuntimes(): Promise<void> {
    // One look at a time (onboarding, Settings and the timer may ask together: Codex's costs a process).
    this.runtimeCheck ??= this.lookAtRuntimes().finally(() => (this.runtimeCheck = undefined));
    return this.runtimeCheck;
  }

  private async lookAtRuntimes(): Promise<void> {
    const found = await this.deps.runtimeStatus?.().catch(() => undefined);
    if (!found?.length) return;
    // Merged over what was found before: a runtime that didn't answer this time keeps its last word.
    this.runtimeFound = [...found, ...this.runtimeFound.filter((old) => !found.some((f) => f.id === old.id))];
    this.runtimesChanged();
    clearTimeout(this.runtimeTimer);
    if (found.some((r) => r.state !== 'ready')) {
      this.runtimeTimer = setTimeout(() => void this.checkRuntimes(), RUNTIME_RECHECK_MS);
      this.runtimeTimer.unref();
    }
  }

  /**
   * The runtimes' list changed (a local endpoint started or stopped answering): listed again, with
   * what each said about itself last kept, so Codex doesn't lose its sign-in state and models.
   */
  runtimesChanged(): void {
    const listed = this.deps.listRuntimes?.() ?? this.deps.store.getState().runtimes;
    this.deps.store.dispatch({ type: 'runtimes', runtimes: withRuntimeStatus(listed, this.runtimeFound) });
  }

  /** Check Again (onboarding, Settings › Agent): every runtime asked now → the runtimes as the pickers have them. */
  async checkAgents(): Promise<readonly RuntimeChoice[]> {
    await this.checkRuntimes();
    return this.deps.store.getState().runtimes;
  }

  /**
   * Sign in to a runtime (Claude Code, Codex): its own sign-in, in Terminal, since it asks there
   * (a browser page, then back). A `.command` file Terminal opens; Check Again sees the result.
   */
  async agentSignIn(id: string): Promise<boolean> {
    const command = await this.deps.signInCommand?.(id);
    if (!command || !this.deps.open) {
      this.deps.toast('Signing in from here isn’t available. Run its sign-in in Terminal.', 'warn');
      return false;
    }
    const file = path.join(os.tmpdir(), `beluga-sign-in-${id.replace(/[^\w-]/g, '')}.command`);
    const quote = (arg: string): string => (/^[\w./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
    await writeFile(file, `#!/bin/sh\nclear\n${command.map(quote).join(' ')}\necho\necho 'Done? Go back to Beluga and press Check Again.'\n`, { mode: 0o700 });
    await chmod(file, 0o700);
    this.deps.open(file);
    return true;
  }

  measureDisk(): Promise<void> {
    return (this.measuring ??= this.measureRound().finally(() => (this.measuring = undefined)));
  }

  /** Every folder, one at a time, worktrees before main folders (a main folder's node_modules can take the whole time budget); each size shows as soon as it's known. */
  private async measureRound(): Promise<void> {
    const dirs = this.manager.list
      .flatMap((p) => p.workspaces)
      .filter((w) => !w.archived && (w.kind === 'worktree' || w.kind === 'main' || (w.kind === 'chat' && !w.projectRoot)))
      .sort((a, b) => Number(a.kind === 'main') - Number(b.kind === 'main'))
      .map((w) => ({ id: w.id, path: w.path }));
    await measureAll(dirs, this.deps.measure, (id, size) => this.deps.store.dispatch({ type: 'disk', sizes: { [id]: size } }));
  }

  /** "1.2 GB · 340k tokens" for a workspace. */
  describe(wsId: string): string {
    const state = this.deps.store.getState();
    const ws = this.manager.find(wsId);
    const disk = state.disk[wsId];
    const tokens = ws?.usage ? ws.usage.input + ws.usage.output + ws.usage.cacheWrite : 0;
    return [disk !== undefined ? formatBytes(disk) : '', tokens ? `${Math.round(tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------------ search

  /** Search every conversation: open ones, saved ones and archived ones. */
  search(query: string): void {
    const state = this.deps.store.getState();
    const loaded = new Set(state.log.map((l) => l.channel));
    const sources: SearchSource[] = [];
    const placeOf = (w: Workspace): string => {
      const p = this.manager.list.find((x) => x.id === w.projectId);
      return p?.root ? `${p.name} › ${w.name}` : w.name;
    };
    for (const channel of loaded) {
      if (channel === 'draft') continue;
      const ws = channel.startsWith('ws:') ? this.manager.find(channel.slice(3)) : undefined;
      const shared = channel.startsWith('ws:') ? state.shared.find((w) => w.id === channel.slice(3)) : undefined;
      // A workspace that's gone (deleted, its project removed): nothing to open, so nothing to find.
      if (channel.startsWith('ws:') && !ws && !shared) continue;
      const items = state.log.filter((l) => l.channel === channel);
      sources.push({ channel, place: ws ? placeOf(ws) : shared ? shared.name : channel === 'room' ? (state.peers.length > 1 ? 'Group chat' : 'Chat') : isAssistant(channel) ? macChatPlace(channel, items) : channel, items, archived: ws?.archived });
    }
    for (const ws of this.manager.list.flatMap((p) => p.workspaces)) {
      const channel = `ws:${ws.id}`;
      if (loaded.has(channel)) continue;
      const items = this.manager.loadHistory<LogItem>(ws.id);
      if (items.length) sources.push({ channel, place: placeOf(ws), items, archived: ws.archived });
    }
    for (const { channel, items } of this.deps.savedChats?.(loaded) ?? []) {
      if (items.length) sources.push({ channel, place: macChatPlace(channel, items), items });
    }
    const hits = searchConversations(query, sources);
    this.deps.store.dispatch({ type: 'search', search: { query, hits, searched: sources.length } });
  }

  /** Open a search hit's conversation. */
  openHit(index: number): void {
    const state = this.deps.store.getState();
    const hit = state.search.hits[index];
    if (!hit) return;
    if (hit.channel === 'room') {
      this.deps.intend({ type: 'navigate', view: { kind: 'room' } });
      return;
    }
    const chat = assistantChatOf(hit.channel);
    if (chat) {
      this.deps.loadSavedChat?.(chat);
      this.deps.intend({ type: 'navigate', view: { kind: 'assistant', chat } });
      return;
    }
    const sentinelChat = sentinelChatOf(hit.channel);
    if (sentinelChat) {
      this.deps.intend({ type: 'navigate', view: { kind: 'sentinel_chat', chat: sentinelChat } });
      return;
    }
    // A chat with a friend or a group: its channel is the conversation's id (the Mac adds its tab).
    if (hit.channel.startsWith('dm:') || hit.channel.startsWith('group:')) {
      this.deps.intend({ type: 'navigate', view: { kind: 'conversation', id: hit.channel } });
      return;
    }
    if (!hit.channel.startsWith('ws:')) return;
    const id = hit.channel.slice(3);
    const shared = state.shared.find((w) => w.id === id);
    if (shared) this.deps.intend({ type: 'navigate', view: { kind: 'shared', owner: shared.owner, id, tab: 'chat' } });
    else this.deps.controller.open(id);
  }

  // --------------------------------------------------------------- templates

  /** "/template save Fix CI: find out why CI fails…" */
  saveTemplate(text: string, plan = false): void {
    const at = text.indexOf(':');
    const name = at > 0 ? text.slice(0, at).trim() : text.trim().split(/\s+/).slice(0, 4).join(' ');
    const prompt = at > 0 ? text.slice(at + 1).trim() : text.trim();
    if (!name || !prompt) {
      this.deps.toast('Usage: /template save <name>: <what the agent should do>', 'warn');
      return;
    }
    this.deps.store.dispatch({ type: 'templates', templates: addTemplate(name, prompt, plan) });
    this.deps.toast(`Template "${name}" saved. It shows up when you start a worktree or chat`, 'success');
  }

  removeTemplate(id: string): void {
    this.deps.store.dispatch({ type: 'templates', templates: removeTemplate(id) });
    this.deps.toast('Template removed', 'success');
  }

}
