import type { LandResult } from '../workspaces/land.js';
import type { Workspace } from '../workspaces/types.js';
import { titleOfBranch } from '../workspaces/pr.js';
import { type LogItem, type Store, isRunning, mergedText } from './store.js';

/**
 * Straight to main (WorkspaceRecord.landOnBase): when your agent's turn ends in such a worktree, its
 * work lands on its base in the main folder (workspaces/land.ts). It's the small-change path: a
 * worktree still keeps the agent off your main folder while it works, and you never handle a branch.
 */

const WS = 'ws:';
/** Only the newest cards are looked at: a turn that just ended is always among them. */
const RECENT = 200;

type AgentCard = Extract<LogItem, { type: 'agent' }>;

/**
 * Worktree conversations where a run of yours just finished well and nothing else runs or waits
 * there: its turn is over. A run that failed or was stopped lands nothing.
 */
export function turnsEnded(prev: readonly LogItem[], next: readonly LogItem[], selfId: string): string[] {
  if (prev === next || !selfId) return [];
  const before = new Map<string, AgentCard>();
  for (const l of prev.slice(-RECENT)) if (l.type === 'agent') before.set(l.id, l);
  const ended = new Set<string>();
  const busy = new Set<string>();
  for (const l of next.slice(-RECENT)) {
    if (l.type !== 'agent' || !l.channel?.startsWith(WS)) continue;
    if (isRunning(l.status)) busy.add(l.channel);
    const old = before.get(l.id);
    if (l.owner === selfId && l.status === 'done' && old && isRunning(old.status)) ended.add(l.channel);
  }
  return [...ended].filter((c) => !busy.has(c));
}

/** What landing says (a toast, and a line in the chat when it couldn't). */
export function landingWords(result: LandResult, into: string): { readonly text: string; readonly level: 'success' | 'warn' } | undefined {
  if (result.ok) return result.landed ? { text: `Committed to ${into} in the main folder · not pushed yet`, level: 'success' } : undefined;
  const some = (files: readonly string[]): string => files.slice(0, 3).join(', ') + (files.length > 3 ? '…' : '');
  if (result.reason === 'wrong_branch') return { text: `Didn’t land on ${into}: the main folder is on ${result.current}. Switch it to ${into}, then Land on ${into} again.`, level: 'warn' };
  if (result.reason === 'dirty') return { text: `Didn’t land on ${into}: you have your own changes in the main folder in ${some(result.files)}. Commit or stash them, then Land on ${into} again.`, level: 'warn' };
  return { text: `Didn’t land on ${into}: it changed since, in the same lines (${some(result.files)}).`, level: 'warn' };
}

/** What the agent is asked when its work conflicts with what landed on its base meanwhile (once in a row). */
export const rebasePrompt = (into: string, files: readonly string[]): string =>
  `Your work couldn't land on ${into}: ${into} changed since, in the same places (${files.join(', ')}). ` +
  `Rebase this branch onto ${into} (\`git rebase ${into}\`), resolve each conflict keeping both changes' intent, finish the rebase, ` +
  `and end your turn: Beluga lands it on ${into} again then.`;

export interface LanderDeps {
  readonly store: Store;
  readonly find: (id: string) => Workspace | undefined;
  /** Commit what's left (as `message`) and land (WorkspaceManager.land). */
  readonly land: (id: string, message: string) => Promise<LandResult>;
  /** The branch it lands on (WorkspaceManager.mergeTarget; undefined: whatever main is on). */
  readonly target: (ws: Workspace) => string | undefined;
  /** It has an open pull request: then the PR is how it ships, and nothing lands by itself. */
  readonly hasPr: (id: string) => boolean;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly askClaude: (prompt: string, channel: string) => void;
  /** Its chat is loaded (so a line said there is kept with its history). */
  readonly ensureLoaded: (id: string) => void;
  /** It landed: the screens refresh (and listeners hear of it, like a merge). */
  readonly landed: (id: string) => void;
}

export class Lander {
  private lastLog: readonly LogItem[];
  private readonly landing = new Set<string>();
  /** Worktrees whose agent was asked to rebase after a conflict: a second conflict in a row stops there. */
  private readonly askedToRebase = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: LanderDeps) {
    this.lastLog = deps.store.getState().log;
    this.unsubscribe = deps.store.subscribe(() => this.onChange());
  }

  stop(): void {
    this.unsubscribe();
  }

  private onChange(): void {
    const state = this.deps.store.getState();
    const prev = this.lastLog;
    this.lastLog = state.log;
    for (const channel of turnsEnded(prev, state.log, state.selfId)) {
      const ws = this.deps.find(channel.slice(WS.length));
      if (ws?.landOnBase && ws.kind === 'worktree' && !ws.archived && !this.deps.hasPr(ws.id)) void this.land(ws.id);
    }
  }

  /**
   * Land it now (its turn just ended, or you asked). A conflict asks its agent to rebase, once in a row.
   * → how it went; undefined when it couldn't be tried (a toast says why).
   */
  async land(id: string): Promise<LandResult | undefined> {
    const ws = this.deps.find(id);
    if (!ws?.branch || this.landing.has(id)) return undefined;
    const into = this.deps.target(ws) ?? 'main';
    this.landing.add(id);
    try {
      const result = await this.deps.land(id, titleOfBranch(ws.branch));
      this.say(ws, result, into);
      return result;
    } catch (err) {
      this.deps.toast(`Couldn’t land on ${into}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return undefined;
    } finally {
      this.landing.delete(id);
    }
  }

  private say(ws: Workspace, result: LandResult, into: string): void {
    const channel = `${WS}${ws.id}`;
    const words = landingWords(result, into);
    if (result.ok) {
      this.askedToRebase.delete(ws.id);
      if (!result.landed) return;
      this.deps.ensureLoaded(ws.id);
      const mark = { into };
      this.deps.store.dispatch({ type: 'system', channel, text: mergedText(mark), merged: mark });
      this.deps.landed(ws.id);
    }
    if (words) this.deps.toast(words.text, words.level);
    if (result.ok) return;
    // A conflict is the agent's to solve, in its own worktree: it lands again when that turn ends.
    if (result.reason === 'conflict' && !this.askedToRebase.has(ws.id)) {
      this.askedToRebase.add(ws.id);
      this.deps.askClaude(rebasePrompt(into, result.files), channel);
      return;
    }
    this.deps.ensureLoaded(ws.id);
    this.deps.store.dispatch({ type: 'system', channel, text: words?.text ?? `Didn’t land on ${into}`, level: 'warn' });
  }
}
