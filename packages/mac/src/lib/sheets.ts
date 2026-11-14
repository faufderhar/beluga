import { useSyncExternalStore } from 'react';
import type { MenuKind } from '../../../../src/ui/menus.js';
import type { AskedWork } from './work-asked.js';

/**
 * Sheets and alerts this window opens for things the shared actions ask in the message box (a
 * name for a fork, a command for a friend's computer…) or don't ask at all (hiding a
 * project): here you get a proper form.
 */
export type NativeSheet =
  /** Copy a workspace under a new name. */
  | { readonly kind: 'fork'; readonly wsId: string }
  /** Carry a conversation (an ask chat in a main folder) into a new worktree and go on there. */
  | { readonly kind: 'continue_worktree'; readonly wsId: string }
  /** Fork a friend's shared worktree to this Mac: its changes, Scratch and conversation (BLG-312). */
  | { readonly kind: 'fork_to_mac'; readonly owner: string; readonly wsId: string }
  /** A command to run on a friend's computer (`peerId` unset: pick who). */
  | { readonly kind: 'peer_run'; readonly peerId?: string }
  /** A new template (Name, Prompt, Plan first). */
  | { readonly kind: 'template' }
  /** A worktree on a friend's computer, with the project already picked. */
  | { readonly kind: 'remote'; readonly peerId: string; readonly project?: string }
  /** "Are you sure?" before a menu option that removes something; Confirm picks it. */
  | { readonly kind: 'confirm_option'; readonly menu: MenuKind; readonly index: number; readonly id: string }
  /** "Are you sure?" for something that isn't a menu option (from the palette). */
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string; readonly confirm: string; readonly cancel?: string; readonly destructive?: boolean; readonly run: () => void }
  /** At Send, in a chat another person owns, when the words name chats of yours: give their agent a copy, or not (BLG-152). */
  | { readonly kind: 'share_copy'; readonly titles: readonly string[]; readonly person: string; readonly share: () => void; readonly without: () => void }
  /** What a workspace action that starts Claude or changes git will do, before it does (see work-confirm.ts). */
  | { readonly kind: 'work'; readonly wsId: string; readonly action: AskedWork }
  /** A project's worktrees made outside Beluga that can go, ticked, before removing them. */
  | { readonly kind: 'clean_up_worktrees'; readonly projectId: string }
  /** Import from Claude Code…: one had outside Beluga, continued in a new worktree (BLG-321). */
  | { readonly kind: 'import_conversation'; readonly projectId: string }
  /** Share with…: a project with friends over the network (pick who, and whether they work there or follow). */
  | { readonly kind: 'share_project'; readonly projectId: string }
  /** Delete Project…: out of Beluga with the worktrees it made (archived); the project's folder is never touched. */
  | { readonly kind: 'delete_project'; readonly projectId: string }
  /** A new task (in a project, a status, under a parent). */
  /** boardId: the board it goes on; projectId: the repo it runs in (both: the sheet's first pick). */
  | { readonly kind: 'new_task'; readonly boardId?: string; readonly projectId?: string; readonly status?: import('../../../../src/core/board/model.js').IssueStatus; readonly parent?: string }
  /** New Board (no boardId; repos ticked to start with), or a board's settings. */
  | { readonly kind: 'task_board'; readonly boardId?: string; readonly repos?: readonly string[] }
  /** A new label in a project's set (a name, an icon, a color), put on a task too when it's opened from one; and its own labels, to remove. */
  | { readonly kind: 'new_label'; readonly projectId: string; readonly issueId?: string }
  /** Sync a project's tasks with Linear: connect a key and a team, or see how it syncs. */
  | { readonly kind: 'task_sync'; readonly projectId: string }
  /** About This Project: what Claude reads when it writes a task there, shared with teammates (BLG-298). */
  | { readonly kind: 'project_context'; readonly projectId: string }
  /** Environment…: a project's settings on its Environment tab, its variables beside its main folder's .env (BLG-369, BLG-926); `tab` another of its tabs. */
  | { readonly kind: 'project_env'; readonly projectId: string; readonly tab?: 'general' | 'environment' | 'worktrees' }
  /** A worktree's own variables, over its project's (BLG-924). */
  | { readonly kind: 'worktree_env'; readonly workspaceId: string }
  /** A new plan with Claude: what it's for, the project (unset: pick one), how far it runs on its own. */
  | { readonly kind: 'new_plan'; readonly projectId?: string }
  /** A new sentinel (docs/sentinel.md §3): from a recipe, or built yourself; `projectId` 'mac' is Your Mac. */
  | { readonly kind: 'new_sentinel'; readonly projectId?: string; readonly way?: 'describe' | 'recipe' | 'build' }
  /** Add a Tile to a dashboard (docs/sentinel.md §10). */
  | { readonly kind: 'add_tile'; readonly dashboardId: string }
  /** A kept table's document or storage object, or a run's file, in Beluga's viewer (BLG-381); `name` is the storage cell for one from Storage; for a run's file (BLG-392), `metric` is the run and `name` its file. */
  | { readonly kind: 'sentinel_document'; readonly source: 'kept' | 'storage' | 'run'; readonly sentinelId: string; readonly metric: string; readonly column: string; readonly name: string }
  /** A sentinel's kept metric, its whole history, with Export and Show in Finder (BLG-392). */
  | { readonly kind: 'sentinel_data'; readonly sentinelId: string; readonly metric: string }
  /** Your planning style (how you like plans cut). */
  | { readonly kind: 'plan_style' }
  /** Not yet: what a milestone still needs, for the plan's head Claude. */
  | { readonly kind: 'plan_send_back'; readonly planId: string; readonly milestone: string }
  /** How a running plan runs (its mode), with what a change means from now on. */
  | { readonly kind: 'plan_mode'; readonly planId: string }
  /** A GitHub step couldn't reach GitHub: why, in plain words, and its fixes (see git-trouble.ts). */
  | { readonly kind: 'git_trouble'; readonly wsId: string; readonly trouble: import('../../../../src/shared/git-trouble.js').GitTrouble; readonly retry: import('./git-trouble.js').GitRetry };

type Listener = () => void;

let current: NativeSheet | undefined;
/** The computer whose page the sheet was opened from (BLG-784): its sheets draw with that computer's state. */
let currentMachine: string | undefined;
const listeners = new Set<Listener>();

/**
 * The computer's page you last clicked or typed in (none: this Mac's). A menu or dialog opened
 * from there (drawn outside it, in a portal) keeps it.
 */
let acting: string | undefined;
const ATTACHED = '[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"]';
function noteActing(e: Event): void {
  const el = e.target instanceof Element ? e.target : undefined;
  if (!el) return;
  const pane = el.closest('[data-machine-pane]');
  if (pane) acting = pane.getAttribute('data-machine-pane') ?? undefined;
  else if (!el.closest(ATTACHED)) acting = undefined;
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', noteActing, true);
  document.addEventListener('keydown', noteActing, true);
}

export function openSheet(sheet: NativeSheet): void {
  current = sheet;
  currentMachine = acting;
  for (const l of [...listeners]) l();
}

/** The sheet showing now, if any. */
export const currentSheet = (): NativeSheet | undefined => current;

export function closeSheet(): void {
  if (!current) return;
  current = undefined;
  currentMachine = undefined;
  for (const l of [...listeners]) l();
}

const subscribe = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The sheet showing now when it's of `machine`'s page (none: this Mac's). */
export function useSheet(machine?: string): NativeSheet | undefined {
  return useSyncExternalStore(subscribe, () => (currentMachine === machine ? current : undefined));
}
