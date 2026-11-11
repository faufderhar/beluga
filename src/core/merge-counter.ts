/**
 * Counting the work made in Beluga that got merged: worktrees Beluga made (never another tool's)
 * whose branch was merged here (Merge into main), through a GitHub pull request (the workbench
 * follows those), or by git some other way (a merge in a terminal, a pull request merged after the
 * worktree was archived). Each branch counts once, kept in ~/.beluga/support.json, so the ask in
 * core/support-store.ts comes at the right merge and only once. Nothing here leaves this computer.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isAncestor, tryGit } from '../workspaces/git.js';
import { fetchStars } from './github-stars.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { belugaHome } from './home.js';
import type { Action, Store } from './store.js';
import { EMPTY_SUPPORT, STAR_AT, type SupportAnswer, type SupportAsk, type SupportRecord, answerAsk, mergeKey, supportView } from './support-store.js';
import type { WorkspaceController, WorktreeEvent } from './workspace-controller.js';

const AnsweredSchema = z.object({ merges: z.number().int().min(0), answer: z.enum(['yes', 'later', 'never']), times: z.number().int().min(1), at: z.number() });
export const SupportFileSchema = z.object({ counted: z.array(z.string()).default([]), star: AnsweredSchema.optional() });

export const supportPath = (): string => path.join(belugaHome(), 'support.json');

export function loadSupportFile(file: string = supportPath()): SupportRecord {
  try {
    const parsed = SupportFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : EMPTY_SUPPORT;
  } catch {
    return EMPTY_SUPPORT;
  }
}

function saveSupportFile(data: SupportRecord, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A worktree Beluga made, with a branch: the only kind that counts. */
const ours = (ws: Workspace | undefined): ws is Workspace & { branch: string } => Boolean(ws && ws.kind === 'worktree' && !ws.external && !ws.pending && ws.branch && ws.projectRoot);

/**
 * Whether git says work from `branch` reached one of `bases`. Only a branch someone committed on
 * counts (its reflog says "commit": one only ever moved along main has nothing to merge), and then
 * its last commit made there, or its tip (rebased before merging), is in the base. Squashed merges
 * don't show this way; their pull request counts them instead.
 */
export async function mergedByGit(root: string, branch: string, bases: readonly string[]): Promise<boolean> {
  const log = (await tryGit(root, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`])) ?? '';
  const lines = log.split('\n').filter(Boolean);
  const hash = (line: string): string => line.slice(0, line.indexOf(' '));
  // Newest first.
  const made = lines.filter((line) => /^\S+ (commit( \([a-z]+\))?|cherry-pick):/.test(line)).map(hash);
  const tip = lines[0] && hash(lines[0]);
  if (!made[0] || !tip) return false;
  for (const base of bases) {
    for (const at of new Set([made[0], tip])) if (await isAncestor(root, at, base)) return true;
  }
  return false;
}

/** Where a worktree's work would be merged: origin's default branch, the local one, and the base it started from. */
export function basesOf(ws: Workspace, project: Project | undefined): string[] {
  const sync = project?.sync;
  return [...new Set([sync?.upstream, sync?.local ? sync.branch : undefined, ws.base].filter((b): b is string => Boolean(b) && b !== 'HEAD'))];
}

export interface MergeCounterDeps {
  readonly store: Store;
  /** Where the record is kept; null: only in memory (the demo, tests). */
  readonly file?: string | null;
  /** The record to start from when there's no file (the demo). */
  readonly seed?: SupportRecord;
  readonly controller?: Pick<WorkspaceController, 'onWorktree' | 'onWorktreeGoing'>;
  /** Asks git whether a worktree's branch is merged (tests answer for it). */
  readonly mergedByGit?: (root: string, branch: string, bases: readonly string[]) => Promise<boolean>;
  /** How often to look for work merged outside Beluga's own buttons (0: only when asked). */
  readonly sweepMs?: number;
  readonly now?: () => number;
  /** How many people starred Beluga, for the Star sheet (core/github-stars.ts); none: no number. */
  readonly stars?: () => Promise<number | undefined>;
}

/** Looking for merges git knows of: soon after start, then every half hour. */
const SWEEP_FIRST_MS = 45_000;
const SWEEP_MS = 30 * 60_000;
/** Looking up Beluga's star count: once a day. */
const STARS_MS = 24 * 60 * 60_000;

export class MergeCounter {
  private record: SupportRecord;
  private readonly offs: Array<() => void> = [];
  private sweeping?: Promise<void>;
  private stars?: number;

  constructor(private readonly deps: MergeCounterDeps) {
    this.record = deps.file === null ? (deps.seed ?? EMPTY_SUPPORT) : loadSupportFile(deps.file);
    this.publish();
    if (deps.controller) {
      this.offs.push(deps.controller.onWorktree((e) => this.onWorktree(e)));
      // Deleting a worktree deletes its branch: ask git while it's still there.
      this.offs.push(deps.controller.onWorktreeGoing((ws) => void this.checkGit(ws)));
    }
    // After the action has reached everyone (never inside its dispatch).
    this.offs.push(deps.store.onAction((a) => queueMicrotask(() => this.onAction(a))));
  }

  get merges(): number {
    return this.record.counted.length;
  }

  /** Count one merged worktree (a no-op for one already counted, or one Beluga didn't make). → whether it counted now. */
  count(ws: Workspace | undefined): boolean {
    if (!ours(ws)) return false;
    const key = mergeKey(ws.projectRoot, ws.branch);
    if (this.record.counted.includes(key)) return false;
    this.record = { ...this.record, counted: [...this.record.counted, key] };
    this.save();
    this.publish();
    return true;
  }

  /** You answered an ask (the sheet's buttons). */
  answer(ask: SupportAsk, answer: SupportAnswer): void {
    this.record = answerAsk(this.record, ask, answer, this.deps.now?.() ?? Date.now());
    this.save();
    this.publish();
  }

  /** Ask git about a worktree not counted yet. → whether it counted now. */
  async checkGit(ws: Workspace): Promise<boolean> {
    if (!ours(ws) || this.record.counted.includes(mergeKey(ws.projectRoot, ws.branch))) return false;
    const project = this.deps.store.getState().projects.find((p) => p.root === ws.projectRoot);
    const bases = basesOf(ws, project);
    if (!bases.length) return false;
    const merged = await (this.deps.mergedByGit ?? mergedByGit)(ws.projectRoot, ws.branch, bases).catch(() => false);
    return merged && this.count(ws);
  }

  /** Every worktree Beluga made (archived ones too): merged pull requests the workbench saw, then git. → how many counted. */
  async sweep(): Promise<number> {
    if (this.sweeping) await this.sweeping;
    let counted = 0;
    const run = (async () => {
      const state = this.deps.store.getState();
      for (const ws of state.projects.flatMap((p) => p.workspaces)) {
        if (state.prs[ws.id]?.state === 'MERGED' ? this.count(ws) : await this.checkGit(ws)) counted++;
      }
    })();
    this.sweeping = run;
    try {
      await run;
    } finally {
      if (this.sweeping === run) this.sweeping = undefined;
    }
    return counted;
  }

  /** Look up the star count again (the daily timer, tests). */
  async refreshStars(): Promise<void> {
    const stars = await this.deps.stars?.().catch(() => undefined);
    if (stars === undefined || stars === this.stars) return;
    this.stars = stars;
    this.publish();
  }

  start(): void {
    if (this.deps.stars) {
      void this.refreshStars();
      const daily = setInterval(() => void this.refreshStars(), STARS_MS);
      daily.unref?.();
      this.offs.push(() => clearInterval(daily));
    }
    const every = this.deps.sweepMs ?? SWEEP_MS;
    if (every <= 0) return;
    const first = setTimeout(() => void this.sweep(), Math.min(SWEEP_FIRST_MS, every));
    const timer = setInterval(() => void this.sweep(), every);
    first.unref?.();
    timer.unref?.();
    this.offs.push(() => {
      clearTimeout(first);
      clearInterval(timer);
    });
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private find(id: string): Workspace | undefined {
    for (const p of this.deps.store.getState().projects) {
      const ws = p.workspaces.find((w) => w.id === id);
      if (ws) return ws;
    }
    return undefined;
  }

  private onWorktree(event: WorktreeEvent): void {
    if (event.kind === 'merged') this.count(this.find(event.id));
  }

  private onAction(action: Action): void {
    if (action.type === 'pr' && action.pr?.state === 'MERGED') this.count(this.find(action.id));
  }

  private save(): void {
    if (this.deps.file === null) return;
    try {
      saveSupportFile(this.record, this.deps.file ?? supportPath());
    } catch {
      // A full disk shouldn't stop a merge; it counts again next time.
    }
  }

  private publish(): void {
    this.deps.store.dispatch({ type: 'support', support: supportView(this.record, this.stars) });
  }
}

const counters = new WeakMap<object, MergeCounter>();

export const attachSupport = (session: object, counter: MergeCounter): void => void counters.set(session, counter);

/** The merge counter of this session, or a clear error where there's none (no daemon running it, e.g. tests). */
export function supportOf(session: object): MergeCounter {
  const counter = counters.get(session);
  if (!counter) throw new Error('Supporting Beluga lives in the Beluga app for Mac (its daemon).');
  return counter;
}

/**
 * Start counting for the daemon. The demo keeps its record in memory with the star already answered
 * (so its pretend merges never ask a pretend you for anything), unless BELUGA_DEMO_ASKS is `star`:
 * then it's due right away (screenshots of the sheet).
 */
export function launchSupport(host: { readonly session: { readonly workspaces?: WorkspaceController }; readonly store: Store; readonly demo: boolean; readonly asks?: string }): () => void {
  const fake = (n: number): string[] => Array.from({ length: n }, (_, i) => mergeKey('/demo', `demo-${i + 1}`));
  const done = { merges: 0, answer: 'never', times: 1, at: 0 } as const;
  const seed: SupportRecord = host.asks === 'star' ? { counted: fake(STAR_AT) } : { counted: [], star: done };
  const counter = new MergeCounter({
    store: host.store,
    ...(host.demo ? { file: null, seed, stars: async () => 491 } : { stars: () => fetchStars() }),
    ...(host.session.workspaces ? { controller: host.session.workspaces } : {}),
  });
  attachSupport(host.session, counter);
  counter.start();
  return () => counter.stop();
}
