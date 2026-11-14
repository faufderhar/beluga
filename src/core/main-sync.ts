import { syncForkPrompt, syncMainPrompt, syncWorktreePrompt } from '../agent/sync-main.js';
import { conflictedFiles } from '../workspaces/git.js';
import { type ForkOf, type GhRunner, type GitHubInfo, type GitHubRepo, fetchFork, fetchGitHubInfo, ghHosts, mergeUpstream, parseGitHubRemote, runGh } from '../workspaces/github.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import * as sync from '../workspaces/sync.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { FETCH_EVERY_DEFAULT } from '../shared/background-fetch.js';
import { pace } from './power-saver.js';

/**
 * Keeping each project's main folder current, for the project home's Update main / Fetch: a
 * quiet fetch as often as Settings › Workspaces says (every 15 minutes unless you chose otherwise;
 * never, if you turned it off), and when you open a project, fast-forwarding
 * the default branch, setting uncommitted changes aside or into a worktree, and handing anything
 * harder to Claude: in a worktree of its own, or (for what's stuck in the main folder's own files)
 * in a run there that may only sync git. Never pushes; never discards.
 */

export interface MainSyncDeps {
  readonly manager: WorkspaceManager;
  /** Re-scan projects (git status) and publish them. */
  readonly refresh: () => Promise<void>;
  /** Publish what the manager knows now, without a re-scan (a fetch starting or failing). */
  readonly publish: () => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** A questions-only chat in the project's main folder, opened (undefined: it couldn't be made). */
  readonly newChat: (projectId: string, title: string) => Promise<Workspace | undefined>;
  /** A new worktree (from `base`, else the latest origin), opened (undefined: it couldn't be made). */
  readonly newWorktree: (projectId: string, name: string, opts: { base?: string }) => Promise<Workspace | undefined>;
  /** Let the next run in this conversation sync git (see controller.place). */
  readonly armSync: (wsId: string, target: { branch: string; upstream: string }) => void;
  readonly askClaude: (prompt: string, channel: string) => void;
  /** Open a workspace's conversation. */
  readonly open: (wsId: string) => void;
  readonly gh?: GhRunner;
  /** Low Power mode is saving now (BLG-621): the background fetches come less often. */
  readonly saving?: () => boolean;
  /** Minutes between background fetches, as chosen now (0: never on its own); default: every 15. */
  readonly fetchEvery?: () => number;
  /** Hosts gh is signed in to (enterprise GitHub under any name); default: gh's hosts.yml. */
  readonly ghHosts?: () => string[];
  readonly now?: () => number;
}

/** How often the background pass looks for a project whose fetch is due (looking runs no git). */
export const FETCH_TICK_MS = 60_000;
/** The first background pass, once Beluga has settled. */
const FIRST_PASS_MS = 20_000;
/** Opening a project fetches when the last fetch is older than this (at the default pace or faster). */
export const STALE_FETCH_MS = 2 * 60_000;
/** After git said "sign in", background fetches leave that project alone this long. */
const AUTH_BACKOFF_MS = 60 * 60_000;
/** GitHub's numbers are good for an hour. */
export const GITHUB_TTL_MS = 60 * 60_000;

export type FetchOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: sync.FetchProblem; readonly message: string };

export type GitHubState =
  /** Not a GitHub remote (or no remote). */
  | { readonly kind: 'none' }
  /** On GitHub; `info` when gh could tell (unset: gh missing, signed out, or no access). */
  | { readonly kind: 'github'; readonly repo: GitHubRepo; readonly info?: GitHubInfo; readonly gh: boolean };

/**
 * How Sync fork went: GitHub brought the original's commits into the fork (`how`: nothing new, a
 * fast-forward, or a merge commit for a fork with commits of its own) and Update main ran here; or
 * GitHub stopped on conflicts (nothing changed); or it couldn't.
 */
export type ForkSyncOutcome =
  | { readonly kind: 'synced'; readonly how: 'none' | 'fast-forward' | 'merge'; readonly update: sync.UpdateOutcome }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export class MainSync {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private readonly running = new Map<string, Promise<FetchOutcome>>();
  /** When each project last tried a fetch (by id), and when git last said it needs a sign-in. */
  private readonly tried = new Map<string, number>();
  private readonly authFailed = new Map<string, number>();
  private readonly github = new Map<string, GitHubState & { at: number; url: string }>();
  /** What each project's origin was forked from as gh last said (null: not a fork), for which remote, and when. */
  private readonly forks = new Map<string, { url: string; at: number; fork: ForkOf | null }>();
  private passing = false;
  /** Projects with an update, stash, move or switch running (one at a time per project). */
  private readonly exclusive = new Set<string>();

  constructor(private readonly deps: MainSyncDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Minutes between background fetches as chosen now (0: never on its own). */
  private get every(): number {
    return this.deps.fetchEvery?.() ?? FETCH_EVERY_DEFAULT;
  }

  /**
   * Start the background fetches (the first pass shortly after start). The timer only looks once a
   * minute for a project whose fetch is due, so a new choice in Settings applies at once.
   */
  start(): void {
    if (this.timer) return;
    this.first = setTimeout(() => void this.backgroundPass(), FIRST_PASS_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.backgroundPass(), FETCH_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private project(projectId: string): Project {
    return this.deps.manager.repoProject(projectId);
  }

  /** Run one change to a project's main folder at a time (a double click, or two windows, wait their turn: no). */
  private async alone<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    if (this.exclusive.has(projectId)) throw new Error('Beluga is already updating this project’s main folder');
    this.exclusive.add(projectId);
    try {
      return await job();
    } finally {
      this.exclusive.delete(projectId);
    }
  }

  /**
   * Fetch a project's remote. `quiet`: no toast when it fails (the project home shows it).
   * Two fetches of one project never overlap: the second waits for the first.
   */
  fetch(projectId: string, opts: { quiet?: boolean } = {}): Promise<FetchOutcome> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    const job = this.doFetch(projectId, opts).finally(() => this.running.delete(projectId));
    this.running.set(projectId, job);
    return job;
  }

  private async doFetch(projectId: string, opts: { quiet?: boolean }): Promise<FetchOutcome> {
    const project = this.project(projectId);
    const remote = project.sync?.remote ?? 'origin';
    this.tried.set(projectId, this.now);
    this.deps.manager.setFetchState(projectId, { fetching: true });
    this.deps.publish();
    const result = await sync.fetchRemote(project.root, remote);
    if (result.ok) {
      this.authFailed.delete(projectId);
      if (result.remoteDefault) this.deps.manager.learnRemoteDefault(projectId, result.remoteDefault);
      this.deps.manager.setFetchState(projectId, {});
      await this.deps.refresh();
      // A fork: how far behind the original it is now (for Sync fork). Never in the way of the fetch.
      void this.learnFork(projectId).catch(() => undefined);
      return { ok: true };
    }
    if (result.reason === 'auth') this.authFailed.set(projectId, this.now);
    this.deps.manager.setFetchState(projectId, { fetchError: { reason: result.reason, message: result.message, at: this.now } });
    this.deps.publish();
    if (!opts.quiet) this.deps.toast(result.message, result.reason === 'auth' ? 'warn' : 'error');
    return { ok: false, reason: result.reason, message: result.message };
  }

  /** Opening a project home: fetch if the last try is a while ago (quietly), unless you turned Beluga's own fetches off. */
  async fetchIfStale(projectId: string): Promise<FetchOutcome | undefined> {
    const every = this.every;
    if (!every) return undefined;
    const project = this.deps.manager.list.find((p) => p.id === projectId && p.root);
    if (!project?.sync?.upstream) return undefined;
    const last = Math.max(this.tried.get(projectId) ?? 0, project.sync.fetchedAt ?? 0);
    if (this.now - last < staleAfterMs(every)) return undefined;
    if (this.now - (this.authFailed.get(projectId) ?? 0) < AUTH_BACKOFF_MS) return undefined;
    return this.fetch(projectId, { quiet: true });
  }

  /**
   * Fetch each project with a remote whose last fetch is older than the chosen pace (four times
   * that while Low Power mode saves), one at a time, without a word (failures show on its home).
   * Off: nothing.
   */
  async backgroundPass(): Promise<void> {
    const every = this.every;
    if (this.passing || !every) return;
    const due = pace(every * 60_000, this.deps.saving?.() ?? false) - FETCH_TICK_MS / 2;
    this.passing = true;
    try {
      for (const p of this.deps.manager.list.filter((x) => x.root && x.sync?.upstream)) {
        if (this.now - (this.authFailed.get(p.id) ?? 0) < AUTH_BACKOFF_MS) continue;
        if (this.now - Math.max(this.tried.get(p.id) ?? 0, p.sync?.fetchedAt ?? 0) < due) continue;
        await this.fetch(p.id, { quiet: true }).catch(() => undefined);
      }
    } finally {
      this.passing = false;
    }
  }

  /** "Update main": fetch and fast-forward the default branch. Anything else comes back to decide about. */
  update(projectId: string): Promise<sync.UpdateOutcome> {
    return this.alone(projectId, () => this.doUpdate(projectId));
  }

  private async doUpdate(projectId: string, extra = ''): Promise<sync.UpdateOutcome> {
    const project = this.project(projectId);
    this.deps.manager.setFetchState(projectId, { fetching: true });
    this.deps.publish();
    const outcome = await sync.updateDefault(project.root, project.base).catch((err: unknown): sync.UpdateOutcome => ({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }));
    this.tried.set(projectId, this.now);
    this.deps.manager.setFetchState(projectId, outcome.kind === 'fetch_failed' ? { fetchError: { reason: outcome.reason, message: outcome.message, at: this.now } } : {});
    await this.deps.refresh();
    this.report(outcome, extra);
    return outcome;
  }

  /** Say how an update went, for the outcomes that need no decision. */
  private report(outcome: sync.UpdateOutcome, extra = ''): void {
    if (outcome.kind === 'updated') this.deps.toast(`${outcome.branch} is up to date${outcome.commits ? ` (${plural(outcome.commits, 'new commit')})` : ''}${extra}`, 'success');
    else if (outcome.kind === 'up_to_date') this.deps.toast(`${outcome.branch} is already up to date with ${outcome.upstream}${outcome.ahead ? ` (and ${outcome.ahead} ahead)` : ''}${extra}`, 'info');
    else if (outcome.kind === 'fetch_failed') this.deps.toast(outcome.message, outcome.reason === 'auth' ? 'warn' : 'error');
    else if (outcome.kind === 'no_upstream') this.deps.toast(`${outcome.branch} doesn’t track a remote branch, so there’s nothing to update from`, 'info');
  }

  /** "Stash, update, and put them back". */
  async stashAndUpdate(projectId: string): Promise<sync.StashUpdateOutcome> {
    const project = this.project(projectId);
    const outcome = await this.alone(projectId, () => sync.stashAndUpdate(project.root, project.base));
    await this.deps.refresh();
    if (outcome.restored) this.report(outcome, outcome.kind === 'updated' || outcome.kind === 'up_to_date' ? ' · your changes are back' : '');
    return outcome;
  }

  /** "Move my changes to a new worktree", then update main. The new worktree opens. */
  async moveAndUpdate(projectId: string, name?: string): Promise<{ wsId: string; outcome: sync.UpdateOutcome }> {
    const { ws, outcome } = await this.alone(projectId, () => this.deps.manager.moveChangesToWorktree(projectId, name));
    await this.deps.refresh();
    this.report(outcome, ` · your changes are in ${ws.name}`);
    if (outcome.kind !== 'updated' && outcome.kind !== 'up_to_date') this.deps.toast(`Your changes are in the worktree ${ws.name}`, 'success');
    return { wsId: ws.id, outcome };
  }

  /**
   * Put the main folder back on the default branch. `clean`: just switch (refused when changes
   * are in the way); `stash`: carry the changes along; `move`: the branch and its changes go to
   * a worktree of their own.
   */
  async switchToDefault(projectId: string, mode: 'clean' | 'stash' | 'move'): Promise<{ kind: 'switched' | 'dirty' | 'failed' | 'conflicts'; files?: readonly string[]; message?: string; wsId?: string }> {
    const project = this.project(projectId);
    if (mode === 'move') {
      const { ws, branch } = await this.alone(projectId, () => this.deps.manager.moveBranchToWorktree(projectId));
      await this.deps.refresh();
      this.deps.toast(`The main folder is on ${branch}; ${ws.branch ?? ws.name} and its changes are in the worktree ${ws.name}`, 'success');
      return { kind: 'switched', wsId: ws.id };
    }
    if (mode === 'stash') {
      const out = await this.alone(projectId, () => sync.stashAndSwitch(project.root, project.base));
      await this.deps.refresh();
      if (out.kind !== 'switched' && !out.restored) return { kind: 'conflicts', files: out.conflicts ?? [], message: `Couldn’t switch to ${project.sync?.branch ?? 'the default branch'}, and putting your changes back conflicted. They’re safe in the stash “${out.stash?.message}”.` };
      if (out.kind === 'switched' && !out.restored) return { kind: 'conflicts', files: out.conflicts ?? [], message: `Switched to ${out.branch}, but your changes conflicted with it. They’re kept in the stash “${out.stash?.message}”.` };
      if (out.kind === 'switched') this.deps.toast(`The main folder is on ${out.branch}, with your changes`, 'success');
      return out;
    }
    const out = await this.alone(projectId, () => sync.switchToDefault(project.root, project.base));
    await this.deps.refresh();
    if (out.kind === 'switched') this.deps.toast(`The main folder is on ${out.branch}`, 'success');
    return out;
  }

  /**
   * "Let Claude handle it". What's stuck in the main folder's own files (a merge or rebase stopped
   * halfway, conflict markers from putting changes back) gets a conversation there whose run may
   * sync git, and only that. Anything else (a fetch that fails, diverged or rewritten history) gets
   * a worktree of its own, where Claude can do what it takes. → the conversation's workspace id.
   */
  async askClaude(projectId: string, situation?: string): Promise<string | undefined> {
    const project = this.project(projectId);
    const line = await sync.defaultBranch(project.root, project.base);
    if (!line.upstream) {
      this.deps.toast(`${line.branch} doesn’t track a remote branch, so there’s nothing to update from`, 'info');
      return undefined;
    }
    const files = line.dirty ? await sync.dirtyFiles(project.root) : [];
    const said = situation?.trim() ? `${situation.trim()} (${describe(line)})` : describe(line);
    const inMain = Boolean(line.operation) || (await conflictedFiles(project.root)).length > 0;
    if (!inMain) {
      // From local main when it has commits of its own, so they come along; else the latest origin.
      const fromLocal = line.local && line.ahead > 0;
      const ws = await this.deps.newWorktree(projectId, `update-${line.branch}`, fromLocal ? { base: line.branch } : {});
      if (!ws) return undefined;
      this.deps.manager.markPurpose(ws.id, 'sync_main');
      this.deps.askClaude(syncWorktreePrompt({ branch: line.branch, upstream: line.upstream, situation: said, mainFolder: project.root, onDefault: line.onDefault, fromLocal, dirty: files }), `ws:${ws.id}`);
      await this.deps.refresh();
      return ws.id;
    }
    const ws = await this.deps.newChat(projectId, `Update ${line.branch}`);
    if (!ws) return undefined;
    this.deps.manager.markPurpose(ws.id, 'sync_main');
    this.deps.armSync(ws.id, { branch: line.branch, upstream: line.upstream });
    this.deps.askClaude(syncMainPrompt({ branch: line.branch, upstream: line.upstream, situation: said, dirty: files }), `ws:${ws.id}`);
    await this.deps.refresh();
    return ws.id;
  }

  /** The project's origin on GitHub, when gh may be asked about its host (github.com, or one gh is signed in to). */
  private async ghOrigin(projectId: string): Promise<{ url: string; repo?: GitHubRepo }> {
    const url = (await this.deps.manager.remoteOf(projectId)) ?? '';
    const hosts = this.deps.ghHosts?.() ?? ghHosts();
    const repo = url ? parseGitHubRemote(url, hosts) : undefined;
    return { url, ...(repo && (repo.host === 'github.com' || hosts.includes(repo.host)) ? { repo } : {}) };
  }

  /**
   * Whether the project's origin is a GitHub fork, of what, and how far behind the original it is
   * (asked after each fetch; "not a fork" is believed for an hour). What gh couldn't tell keeps
   * what was known.
   */
  async learnFork(projectId: string): Promise<ForkOf | undefined> {
    const { url, repo } = await this.ghOrigin(projectId);
    const had = this.forks.get(projectId);
    if (!repo) {
      if (had) {
        this.forks.delete(projectId);
        this.deps.manager.setFork(projectId, undefined);
        this.deps.publish();
      }
      return undefined;
    }
    if (had?.url === url && had.fork === null && this.now - had.at < GITHUB_TTL_MS) return undefined;
    const fork = await fetchFork(repo, this.deps.gh ?? runGh).catch(() => undefined);
    if (fork === undefined) return had?.url === url ? (had.fork ?? undefined) : undefined;
    this.forks.set(projectId, { url, at: this.now, fork });
    this.deps.manager.setFork(projectId, fork ?? undefined);
    this.deps.publish();
    return fork ?? undefined;
  }

  /**
   * "Sync fork": the original's new commits come into the fork's default branch on GitHub (as
   * GitHub's own Sync fork button does: a fast-forward, or a merge commit when the fork has commits
   * of its own), then Update main brings them here. A conflict changes nothing and comes back
   * (syncForkWithClaude resolves it in a worktree).
   */
  async syncFork(projectId: string): Promise<ForkSyncOutcome> {
    const { url, repo } = await this.ghOrigin(projectId);
    const fork = this.project(projectId).fork ?? (await this.learnFork(projectId));
    if (!repo || !fork) return { kind: 'failed', message: 'This project’s origin isn’t a fork on GitHub' };
    const original = `${fork.owner}/${fork.repo}`;
    const merged = await mergeUpstream(repo, fork.forkBranch, this.deps.gh ?? runGh);
    if (merged.kind === 'conflict') return { kind: 'conflict', message: `Your fork’s ${fork.forkBranch} and ${original}’s ${fork.branch} change the same lines, so GitHub couldn’t sync them.` };
    if (merged.kind === 'failed') {
      this.deps.toast(`Couldn’t sync with ${original}: ${merged.message}`, 'error');
      return { kind: 'failed', message: merged.message };
    }
    this.forks.set(projectId, { url, at: this.now, fork: { ...fork, behind: 0 } });
    this.deps.manager.setFork(projectId, { ...fork, behind: 0 });
    const said = merged.kind === 'none' ? ` · your fork already had everything from ${original}` : merged.kind === 'merge' ? ` · synced with ${original} (a merge commit on your fork)` : ` · synced with ${original}`;
    const update = await this.alone(projectId, () => this.doUpdate(projectId, said));
    if (update.kind !== 'updated' && update.kind !== 'up_to_date' && merged.kind !== 'none') this.deps.toast(`Your fork on GitHub has ${original}’s new commits`, 'success');
    return { kind: 'synced', how: merged.kind, update };
  }

  /** Sync fork stopped on conflicts: Claude merges the original in, in a worktree from the fork's branch, and opens a PR into it. → the worktree's id. */
  async syncForkWithClaude(projectId: string, situation?: string): Promise<string | undefined> {
    const fork = this.project(projectId).fork ?? (await this.learnFork(projectId));
    if (!fork) {
      this.deps.toast('This project’s origin isn’t a fork on GitHub', 'warn');
      return undefined;
    }
    const ws = await this.deps.newWorktree(projectId, `sync-${fork.owner}`, {});
    if (!ws) return undefined;
    this.deps.askClaude(syncForkPrompt({ original: `${fork.owner}/${fork.repo}`, originalUrl: fork.url, originalBranch: fork.branch, forkBranch: fork.forkBranch, ...(situation ? { situation } : {}) }), `ws:${ws.id}`);
    await this.deps.refresh();
    return ws.id;
  }

  /** Just where the project is on GitHub, from its remote (no gh, no network): for menus. */
  async githubRepo(projectId: string): Promise<GitHubRepo | undefined> {
    const url = await this.deps.manager.remoteOf(projectId);
    return url ? parseGitHubRemote(url, this.deps.ghHosts?.() ?? ghHosts()) : undefined;
  }

  /** The project's GitHub repository and what gh says about it (cached an hour per remote; `force` asks again). */
  async githubInfo(projectId: string, force = false): Promise<GitHubState> {
    const url = (await this.deps.manager.remoteOf(projectId)) ?? '';
    const cached = this.github.get(projectId);
    if (cached && !force && cached.url === url && this.now - cached.at < GITHUB_TTL_MS) return strip(cached);
    const repo = url ? parseGitHubRemote(url, this.deps.ghHosts?.() ?? ghHosts()) : undefined;
    if (!repo) {
      this.github.set(projectId, { kind: 'none', at: this.now, url });
      return { kind: 'none' };
    }
    // gh is only asked about github.com and hosts it's signed in to (a token never goes to a look-alike host).
    const known = repo.host === 'github.com' || (this.deps.ghHosts?.() ?? ghHosts()).includes(repo.host);
    const info = known ? await fetchGitHubInfo(repo, this.deps.gh ?? runGh, this.now).catch(() => undefined) : undefined;
    const state: GitHubState = { kind: 'github', repo, gh: Boolean(info), ...(info ? { info } : {}) };
    this.github.set(projectId, { ...state, at: this.now, url });
    return state;
  }
}

/**
 * Opening a project fetches when its last fetch is older than this: two minutes at the default
 * pace or faster; at a slower one you chose, half of it (so fewer fetches mean fewer from opening too).
 */
export function staleAfterMs(everyMinutes: number): number {
  return everyMinutes <= FETCH_EVERY_DEFAULT ? STALE_FETCH_MS : (everyMinutes * 60_000) / 2;
}

const strip = (s: GitHubState & { at: number; url: string }): GitHubState => {
  const { at: _at, url: _url, ...rest } = s;
  return rest;
};

/** What Beluga sees, in a sentence, for Claude's task. */
export function describe(line: sync.DefaultBranch): string {
  const parts = [
    line.operation ? `a ${line.operation} is stopped halfway in the main folder` : '',
    !line.onDefault ? `the main folder is on ${line.current ?? 'a detached HEAD'}, not ${line.branch}` : '',
    line.ahead && line.behind ? `${line.branch} has ${plural(line.ahead, 'commit')} that ${line.ahead === 1 ? 'isn’t' : 'aren’t'} on ${line.upstream}, and ${line.upstream} has ${plural(line.behind, 'new commit')}` : '',
    !line.ahead && line.behind ? `${line.branch} is ${line.behind} behind ${line.upstream}` : '',
    line.ahead && !line.behind ? `${line.branch} is ${line.ahead} ahead of ${line.upstream}` : '',
    line.dirty ? `there ${line.dirty === 1 ? 'is 1 uncommitted change' : `are ${line.dirty} uncommitted changes`} in the main folder` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}.` : `${line.branch} looks up to date with ${line.upstream}; check anyway.`;
}
