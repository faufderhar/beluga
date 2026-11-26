import type { AppState } from '../../../../../src/core/store.js';
import { type BoardState, type Issue, isArchived, isOpen, showsOn } from '../../../../../src/core/board/model.js';
import { activityOf } from '../../../../../src/ui/workspace-models.js';
import { worktreeOrigin } from '../../../../../src/workspaces/origin.js';
import type { Project, ProjectSync, Workspace } from '../../../../../src/workspaces/types.js';

/**
 * What a project's home shows (ProjectHome.tsx draws it): how its main folder compares with
 * origin, its worktrees, the questions asked in main, and what was put away. Pure, so it's
 * tested on its own (tests/mac-project-home.test.ts).
 */

export type Tone = 'ok' | 'warn' | 'info' | 'muted';

export interface MainLine {
  /** "Up to date with origin/main", "3 behind origin/main"… */
  readonly label: string;
  readonly tone: Tone;
  /** "4 uncommitted changes in main" (they were made outside Beluga). */
  readonly dirty?: string;
  /** The default branch the line is about ("main" or "master"). */
  readonly branch?: string;
  /** "The main folder is on feat/panel-first": it isn't on the default branch. */
  readonly elsewhere?: string;
  /** Update main can do something: new commits on the remote (or the branch only exists there). */
  readonly canUpdate?: boolean;
  /** Push main can do something: commits of its own the remote doesn't have (Straight to main's). */
  readonly canPush?: boolean;
}

export interface HomeModel {
  readonly project: Project;
  /** The main checkout (its branch and status). */
  readonly main?: Workspace;
  readonly mainLine: MainLine;
  /** Worktrees Beluga made, still around: the most recently active first. */
  readonly worktrees: readonly Workspace[];
  /** Questions asked in the main folder (ask-only chats), the most recent first. */
  readonly asks: readonly Workspace[];
  /** Archived worktrees and chats, the newest first. */
  readonly archived: readonly Workspace[];
  readonly stats: { readonly active: number; readonly ready: number; readonly archived: number };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * main against origin in plain words: commits of its own are "not pushed" (Straight to main puts
 * them there, and Push main sends them), new ones there are "behind".
 */
function aheadBehind(ahead: number, behind: number, up: string): string {
  if (ahead && behind) return `${plural(ahead, 'commit')} not pushed · ${behind} behind ${up}`;
  return ahead ? `${plural(ahead, 'commit')} not pushed to ${up}` : `${behind} behind ${up}`;
}

/**
 * How the project's default branch (main or master) compares with its remote, as of the last
 * fetch, and where the main folder is when it's on another branch.
 */
export function defaultLineOf(sync: ProjectSync): MainLine {
  const where = sync.onDefault ? 'main' : 'the main folder';
  const dirty = sync.dirty ? `${plural(sync.dirty, 'uncommitted change')} in ${where}` : undefined;
  const extra = { branch: sync.branch, ...(dirty ? { dirty } : {}), ...(sync.onDefault ? {} : { elsewhere: `The main folder is on ${sync.current ?? 'a detached HEAD'}` }) };
  const up = sync.upstream;
  if (!up) return { label: 'Not tracking a remote branch', tone: 'muted', ...extra };
  if (!sync.local) return { label: `Only on ${up} so far`, tone: 'info', canUpdate: true, ...extra };
  if (!sync.ahead && !sync.behind) return { label: `Up to date with ${up}`, tone: 'ok', ...extra };
  return { label: aheadBehind(sync.ahead, sync.behind, up), tone: 'info', ...(sync.behind ? { canUpdate: true } : {}), ...(sync.ahead ? { canPush: true } : {}), ...extra };
}

/** How the main checkout compares with the branch it tracks (as of the last fetch). */
export function mainLineOf(main: Workspace | undefined, sync?: ProjectSync): MainLine {
  if (sync) return defaultLineOf(sync);
  const st = main?.status;
  const dirty = st?.changed ? `${plural(st.changed, 'uncommitted change')} in main` : undefined;
  const extra = dirty ? { dirty } : {};
  const up = st?.upstream;
  if (!st) return { label: 'Main folder', tone: 'muted', ...extra };
  if (!up) return { label: 'Not tracking a remote branch', tone: 'muted', ...extra };
  if (!up.ahead && !up.behind) return { label: `Up to date with ${up.name}`, tone: 'ok', ...extra };
  return { label: aheadBehind(up.ahead, up.behind, up.name), tone: 'info', ...extra };
}

/** When something last happened in a workspace: its last message, else when it was made. */
export const lastActive = (state: Pick<AppState, 'log'>, ws: Workspace): number => activityOf(state.log, `ws:${ws.id}`).lastTs ?? ws.createdAt;

/**
 * Committed work not in its base yet, nothing uncommitted, no conflict, Claude not working, and
 * no PR that's already merged or closed (its work is done with, even if main hasn't caught up).
 */
export function isReady(state: Pick<AppState, 'log' | 'conflicts' | 'prs'>, ws: Workspace): boolean {
  const pr = state.prs[ws.id];
  if (pr && pr.state !== 'OPEN') return false;
  return ws.kind === 'worktree' && !ws.archived && !state.conflicts[ws.id]?.length && !activityOf(state.log, `ws:${ws.id}`).running && !ws.status?.changed && (ws.status?.ahead ?? 0) > 0;
}

export function homeModel(state: Pick<AppState, 'log' | 'conflicts' | 'prs'>, project: Project): HomeModel {
  const recent = (a: Workspace, b: Workspace): number => lastActive(state, b) - lastActive(state, a);
  const live = project.workspaces.filter((w) => !w.archived);
  const main = project.workspaces.find((w) => w.kind === 'main');
  const worktrees = live.filter((w) => w.kind === 'worktree' && worktreeOrigin(w) === 'beluga').sort(recent);
  // Questions asked in the main folder: its chats (the main checkout itself is no conversation, BLG-70).
  const asks = live.filter((w) => w.askOnly && w.kind === 'chat').sort(recent);
  const archived = project.workspaces.filter((w) => w.archived).sort((a, b) => b.createdAt - a.createdAt);
  return {
    project,
    ...(main ? { main } : {}),
    mainLine: mainLineOf(main, project.sync),
    worktrees,
    asks,
    archived,
    stats: { active: worktrees.length, ready: worktrees.filter((w) => isReady(state, w)).length, archived: archived.length },
  };
}

export interface HomeTasks {
  /** A few open tasks, the most recently moved first. */
  readonly shown: readonly Issue[];
  /** How many are open. */
  readonly open: number;
  /** The board has any task for this repo at all (archived ones too): without, the section stays away. */
  readonly any: boolean;
}

/**
 * The project's board at a glance: the open tasks its repo's board shows (tasks from other boards
 * that run here too), the most recently moved first, and how many are open.
 */
export function homeTasks(board: Pick<BoardState, 'issues'>, projectId: string, limit: number): HomeTasks {
  const here = board.issues.filter((i) => showsOn(i, projectId));
  const open = here.filter((i) => isOpen(i.status) && !isArchived(i)).sort((a, b) => b.updatedAt - a.updatedAt);
  return { shown: open.slice(0, limit), open: open.length, any: here.length > 0 };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
