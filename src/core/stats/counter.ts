/**
 * Your stats (BLG-755), counted by the daemon as things happen: prompts you send, how long your
 * agent works, workspaces made and archived, tokens spent, pastes and dictation (the Mac tells it).
 * The first start backfills what Beluga already knew (workspace records, chat histories, pull
 * requests on GitHub), in the background, one file or one gh call at a time. Kept in
 * ~/.beluga/stats.json, written a few seconds after a change; the Usage tab asks for it, so
 * nothing is sent while nobody looks. Nothing here leaves this computer.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StatsSnapshot } from '../../shared/stats.js';
import { hasGh, runGh } from '../../workspaces/pr.js';
import type { Project, Workspace } from '../../workspaces/types.js';
import { belugaHome } from '../home.js';
import { chosenAgent } from '../settings.js';
import type { Action, DomainState, LogItem, Store } from '../store.js';
import { usagesOf } from '../../agent/usage.js';
import { demoStats, sparseDemoStats } from './demo.js';
import { type StatsFile, emptyStats, loadStats, saveStats, snapshotOf, statsPath } from './file.js';
import { GH_PR_FIELDS, type PlanReading, addStats, belugaBranches, count, countPrompt, fromHistory, observePlan, observeWorkspaces, parseGhPrs, withPrs } from './tally.js';

/** What the Mac reports (it alone sees the composer and the microphone). */
export type StatsNote = { readonly kind: 'paste'; readonly chars: number; readonly channel?: string } | { readonly kind: 'dictation'; readonly ms: number; readonly channel?: string };

export interface StatsCounterDeps {
  readonly store: Store;
  /** Where the stats are kept; null: only in memory (the demo, tests). */
  readonly file?: string | null;
  /** Made-up stats to start from once the projects are known (the demo). */
  readonly seed?: (projects: readonly Project[], now: number) => Pick<StatsFile, 'days' | 'hours' | 'prs' | 'plan'>;
  /** Where chat histories are (unset: ~/.beluga/history; null: none to read). */
  readonly historyDir?: string | null;
  /** A project's newest `limit` pull requests as gh lists them (JSON); unset: gh itself; null: never ask. */
  readonly listPrs?: ((root: string, limit: number) => Promise<string>) | null;
  readonly now?: () => number;
  /** Say there's no GitHub CLI without asking (the sparse demo). */
  readonly noGitHub?: boolean;
}

/** Write a few seconds after a change, so a busy minute is one write. */
const SAVE_MS = 4000;
/** Workspaces change often (git status): looked at once in a while. */
const OBSERVE_MS = 3000;
/** The backfill waits for the app to settle after start. */
const BACKFILL_AFTER_MS = 60_000;
/** Pull requests are asked of GitHub at most this often per project. */
const PRS_EVERY_MS = 6 * 3_600_000;
/** The first time a project is asked: all of them (the newest come first, and a busy repo has hundreds). */
const PR_FIRST_LIMIT = 3000;
/** Later: the newest only (what was read before stays). */
const PR_LIMIT = 300;
/** A PR seen merging is asked about this soon after (GitHub has the merge by then). */
const AFTER_MERGE_MS = 5000;

const defaultListPrs = (root: string, limit: number): Promise<string> =>
  runGh(['pr', 'list', '--state', 'all', '--author', '@me', '--limit', String(limit), '--json', GH_PR_FIELDS], root, limit > PR_LIMIT ? 180_000 : 60_000);

export class StatsCounter {
  private data: StatsFile;
  private readonly offs: Array<() => void> = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private observeTimer?: ReturnType<typeof setTimeout>;
  /** Runs started and not finished: requestId → when. */
  private readonly running = new Map<string, number>();
  private backfilling = false;
  /** Projects with a pull request seen merging, asked about again soon (not in a few hours). */
  private readonly mergedIn = new Set<string>();
  private mergeTimer?: ReturnType<typeof setTimeout>;
  /** gh isn't installed or signed in here (learned at the last backfill). */
  private noGitHub: boolean;
  private seeded = false;
  private stopped = false;

  constructor(private readonly deps: StatsCounterDeps) {
    this.noGitHub = Boolean(deps.noGitHub);
    const now = this.now();
    this.data = deps.file === null ? emptyStats(now) : loadStats(deps.file ?? statsPath(), now);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    this.offs.push(this.deps.store.onAction((a) => queueMicrotask(() => this.onAction(a))));
    this.observeSoon();
    this.later(BACKFILL_AFTER_MS, () => void this.backfill());
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.observeTimer) clearTimeout(this.observeTimer);
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveNow();
    }
  }

  /** What the Usage tab shows. */
  snapshot(): StatsSnapshot {
    const snap = snapshotOf(this.data, this.backfilling);
    return this.noGitHub ? { ...snap, noGitHub: true } : snap;
  }

  /** A paste or a dictation the Mac saw. */
  note(n: StatsNote): void {
    const { root, agent } = this.whereOf(n.channel);
    this.change(count(this.data, this.now(), root, agent, n.kind === 'paste' ? { pasted: n.chars } : { dictationMs: n.ms }));
  }

  // ---------------------------------------------------------------- live

  /**
   * You sent a prompt (the composer, on the Mac or the phone: see ipc/handlers.ts). Counted where
   * you typed it, never from the chat log: Beluga writes there for you too (handoffs, switches).
   */
  prompt(channel: string | undefined, text: string, agent?: string): void {
    if (this.stopped || !text.trim() || text.startsWith('/')) return;
    const where = this.whereOf(channel);
    if (!where.root && !channel?.startsWith('ws:')) return;
    this.change(countPrompt(this.data, this.now(), where.root, agent ?? where.agent, text.length));
  }

  private onAction(a: Action): void {
    if (this.stopped) return;
    // Workspaces, and your plan usage (it comes with your own card).
    if (a.type === 'projects' || a.type === 'peers' || a.type === 'welcome') return this.observeSoon();
    // A worktree's pull request merged (from Beluga or on GitHub): its lines count now, not at the next refresh.
    if (a.type === 'pr' && a.pr?.state === 'MERGED') return this.mergedSoon(a.id, a.pr.number);
    const self = this.deps.store.getState().selfId;
    // Your agent's runs for you (a friend's requests run on your Mac too: not your time).
    if (a.type === 'agent_event' && a.owner === self && a.requester === self) {
      if (a.event === 'started') this.running.set(a.requestId, a.ts);
      if (a.event !== 'done' && a.event !== 'error' && a.event !== 'denied') return;
      const began = this.running.get(a.requestId);
      this.running.delete(a.requestId);
      if (began === undefined || a.ts <= began) return;
      const { root, agent } = this.whereOf(a.channel);
      this.change(count(this.data, a.ts, root, a.agent?.runtime ?? agent, { agentMs: a.ts - began, runs: 1 }));
    }
  }

  /** The project and agent of a channel ("ws:<id>", or a project's new chat or worktree page); none for anything else. */
  private whereOf(channel: string | undefined): { root: string; agent: string } {
    const state = this.deps.store.getState();
    const id = channel?.startsWith('ws:') ? channel.slice(3) : undefined;
    for (const p of state.projects) {
      const w = id ? p.workspaces.find((x) => x.id === id) : undefined;
      if (w) return { root: p.root, agent: this.agentOf(w, p) };
    }
    const draft = /^new-(?:chat|worktree):(.+)$/.exec(channel ?? '')?.[1];
    const p = draft ? state.projects.find((x) => x.id === draft) : undefined;
    return p ? { root: p.root, agent: chosenAgent(state.prefs, p.name).runtime } : { root: '', agent: '' };
  }

  private readonly agentOf = (w: Workspace, p: Project): string => w.agent?.runtime ?? chosenAgent(this.deps.store.getState().prefs, p.name).runtime;

  private observeSoon(): void {
    if (this.observeTimer || this.stopped) return;
    this.observeTimer = setTimeout(() => {
      this.observeTimer = undefined;
      const state = this.deps.store.getState();
      let next = observePlan(this.data, planReadings(state), this.now());
      const projects = state.projects;
      if (projects.length) {
        if (this.deps.seed && !this.seeded) {
          this.seeded = true;
          const seed = this.deps.seed(projects, this.now());
          next = { ...addStats(next, seed), prs: { ...seed.prs, ...next.prs }, plan: [...seed.plan, ...next.plan] };
        }
        next = observeWorkspaces(next, projects, this.agentOf, this.now());
      }
      if (next !== this.data) this.change(next);
    }, OBSERVE_MS);
    this.observeTimer.unref?.();
  }

  private mergedSoon(workspaceId: string, number: number): void {
    const p = this.deps.store.getState().projects.find((x) => x.workspaces.some((w) => w.id === workspaceId));
    if (!p?.root || this.data.prs[`${p.root}#${number}`]?.merged !== undefined) return;
    this.mergedIn.add(p.root);
    this.askMergedSoon();
  }

  private askMergedSoon(): void {
    if (this.mergeTimer || this.stopped) return;
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = undefined;
      // The backfill is asking already: after it.
      if (this.backfilling) return this.askMergedSoon();
      const roots = new Set(this.mergedIn);
      this.mergedIn.clear();
      void this.readPrs(roots);
    }, AFTER_MERGE_MS);
    this.mergeTimer.unref?.();
  }

  // ---------------------------------------------------------------- backfill

  /** Chat histories once (prompts and agent time from before), then each project's pull requests, then again every few hours. */
  async backfill(): Promise<void> {
    if (this.backfilling || this.stopped) return;
    this.backfilling = true;
    try {
      if (!this.data.history) await this.readHistories();
      await this.readPrs();
    } finally {
      this.backfilling = false;
    }
    if (!this.stopped) this.later(PRS_EVERY_MS, () => void this.backfill());
  }

  private async readHistories(): Promise<void> {
    const dir = this.deps.historyDir === undefined ? path.join(belugaHome(), 'history') : this.deps.historyDir;
    const state = this.deps.store.getState();
    // Not yet who you are or what your projects are (just started): read next time, not marked read with nothing found.
    if (!state.selfId || !state.projects.length) return;
    // Counted on its own, then added: live counting goes on while the files are read.
    let found = emptyStats(this.data.startedAt);
    if (dir) {
      for (const p of state.projects) {
        for (const w of p.workspaces) {
          if (this.stopped) return;
          const items = await readItems(path.join(dir, `${w.id.replace(/[^\w.-]/g, '_')}.json`));
          if (items.length) found = fromHistory(found, items, state.selfId, p.root, this.agentOf(w, p), this.data.startedAt);
        }
      }
    }
    this.change({ ...addStats(this.data, found), history: true });
  }

  /** Each project's pull requests, at most every few hours; `only`: just these projects, now. */
  private async readPrs(only?: ReadonlySet<string>): Promise<void> {
    if (this.deps.listPrs === null) return;
    // No GitHub CLI signed in: nothing to ask (the Usage tab says why its pull requests are empty).
    this.noGitHub = !this.deps.listPrs && !(await hasGh());
    if (this.noGitHub) return;
    const list = this.deps.listPrs ?? defaultListPrs;
    for (const p of this.deps.store.getState().projects) {
      if (this.stopped) return;
      // Chats (always listed first) has no folder and no pull requests: skipped, never the end of the list.
      if (!p.root) continue;
      if (only ? !only.has(p.root) : this.now() - (this.data.prsAt[p.root] ?? 0) < PRS_EVERY_MS) continue;
      const branches = belugaBranches(p, this.agentOf);
      try {
        const prs = parseGhPrs(await list(p.root, this.data.prsAt[p.root] === undefined ? PR_FIRST_LIMIT : PR_LIMIT));
        this.change(withPrs(this.data, p, prs, branches, chosenAgent(this.deps.store.getState().prefs, p.name).runtime, this.now()));
      } catch {
        // No GitHub here (no remote, not signed in): asked again next time.
        this.change({ ...this.data, prsAt: { ...this.data.prsAt, [p.root]: this.now() } });
      }
    }
  }

  // ---------------------------------------------------------------- keeping

  private change(next: StatsFile): void {
    if (this.stopped) return;
    this.data = next;
    if (this.deps.file === null || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_MS);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    if (this.deps.file === null) return;
    try {
      saveStats(this.data, this.deps.file ?? statsPath());
    } catch {
      // A full disk or a locked folder: kept in memory, written with the next change.
    }
  }

  private later(ms: number, run: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) run();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }
}

/** Your providers' plan windows as your own card says now. */
function planReadings(state: DomainState): PlanReading[] {
  const me = state.peers.find((p) => p.peerId === state.selfId) ?? state.self;
  return usagesOf(me).flatMap((u) => [
    ...(u.fiveHour ? [{ runtime: u.agent.runtime, kind: 'session' as const, pct: u.fiveHour.pct, ...(u.fiveHour.resetsAt ? { resetsAt: u.fiveHour.resetsAt } : {}) }] : []),
    ...(u.week ? [{ runtime: u.agent.runtime, kind: 'week' as const, pct: u.week.pct, ...(u.week.resetsAt ? { resetsAt: u.week.resetsAt } : {}) }] : []),
  ]);
}

async function readItems(file: string): Promise<LogItem[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as LogItem[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- the daemon

const counters = new WeakMap<object, StatsCounter>();

/** The stats counter of this session, or a clear error where there's none (no daemon running it, e.g. tests). */
/** The counter, where the daemon runs one (none in tests or a plain terminal session). */
export const maybeStatsOf = (session: object): StatsCounter | undefined => counters.get(session);

export function statsOf(session: object): StatsCounter {
  const counter = counters.get(session);
  if (!counter) throw new Error('Your stats live in the Beluga app for Mac (its daemon).');
  return counter;
}

/** Start counting for the daemon. The demo keeps made-up stats in memory and never reads files or asks GitHub. */
export function launchStats(host: { readonly session: object; readonly store: Store; readonly demo: boolean; readonly sparse?: boolean }): () => void {
  const seed = host.sparse ? sparseDemoStats : demoStats;
  const counter = new StatsCounter({ store: host.store, ...(host.demo ? { file: null, historyDir: null, listPrs: null, seed, ...(host.sparse ? { noGitHub: true } : {}) } : {}) });
  counters.set(host.session, counter);
  counter.start();
  return () => counter.stop();
}
