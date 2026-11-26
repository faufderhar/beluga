import type { DeletePlan } from '../../../../../src/workspaces/types.js';
import type { OverviewItem } from './overview-model.js';

/**
 * Picking several Overview rows to delete them at once, like a Finder list: ⌘-click adds or
 * takes one away, Shift-click picks every row from the last one clicked, ⌘A picks every row
 * shown. A plain click still opens a row (and drops the pick). Pure, so it's tested on its own
 * (tests/mac-overview-selection.test.ts); Overview.tsx only draws it.
 */

export interface OverviewPick {
  /** The picked rows, in the order they're drawn. */
  readonly ids: readonly string[];
  /** Where the next Shift-click range starts: the last row clicked. */
  readonly anchor?: string;
}

export const NO_PICK: OverviewPick = { ids: [] };

/**
 * What can be deleted from the Overview: a worktree or chat of Beluga's, live or archived. Not a
 * plan (its row stands for its tasks too), not one being made, and not a worktree another tool
 * made (those are removed on the Worktrees page, their branch kept).
 */
export const pickable = (item: OverviewItem): boolean => !item.plan && !item.ws.pending && !item.ws.external && item.ws.kind !== 'main';

const inOrder = (order: readonly string[], ids: ReadonlySet<string>): string[] => order.filter((id) => ids.has(id));

/** ⌘-click: add the row, or take it away when it's picked. It becomes the anchor either way. */
export function togglePick(pick: OverviewPick, order: readonly string[], can: ReadonlySet<string>, id: string): OverviewPick {
  if (!order.includes(id)) return pick;
  if (pick.ids.includes(id)) return { anchor: id, ids: pick.ids.filter((x) => x !== id) };
  if (!can.has(id)) return { ...pick, anchor: id };
  return { anchor: id, ids: inOrder(order, new Set([...pick.ids, id])) };
}

/**
 * Shift-click: every pickable row from the anchor to this one, added to what's picked. With no
 * anchor (or one that's gone), the row on its own.
 */
export function rangePick(pick: OverviewPick, order: readonly string[], can: ReadonlySet<string>, id: string, from?: string): OverviewPick {
  const end = order.indexOf(id);
  if (end < 0) return pick;
  const anchor = pick.anchor ?? from;
  const start = anchor === undefined ? -1 : order.indexOf(anchor);
  const span = start < 0 ? [id] : order.slice(Math.min(start, end), Math.max(start, end) + 1);
  return { anchor: start < 0 ? id : anchor!, ids: inOrder(order, new Set([...pick.ids, ...span.filter((x) => can.has(x))])) };
}

/** ⌘A: every pickable row shown. */
export const pickAll = (order: readonly string[], can: ReadonlySet<string>): OverviewPick => ({ ids: order.filter((id) => can.has(id)) });

/** Rows that left the list (deleted, filtered or searched away) are no longer picked. */
export function keepShown(pick: OverviewPick, order: readonly string[]): OverviewPick {
  const ids = pick.ids.filter((id) => order.includes(id));
  const anchor = pick.anchor !== undefined && order.includes(pick.anchor) ? pick.anchor : undefined;
  if (ids.length === pick.ids.length && anchor === pick.anchor) return pick;
  return anchor === undefined ? { ids } : { anchor, ids };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 worktrees", "2 chats", "1 worktree and 2 chats": what's picked, by kind. */
export function pickedWords(items: readonly OverviewItem[]): string {
  const worktrees = items.filter((i) => i.ws.kind === 'worktree').length;
  const chats = items.length - worktrees;
  if (!worktrees) return plural(chats, 'chat');
  if (!chats) return plural(worktrees, 'worktree');
  return `${plural(worktrees, 'worktree')} and ${plural(chats, 'chat')}`;
}

/** What deleting them all takes with it, in a sentence. */
export function deleteWords(items: readonly OverviewItem[]): string {
  const live = items.filter((i) => i.ws.kind === 'worktree' && !i.archived).length;
  const branches = items.filter((i) => i.ws.kind === 'worktree' && i.ws.branch).length;
  const saved = items.filter((i) => i.archived && i.ws.archive).length;
  const one = items.length === 1;
  const parts = [
    ...(live ? [live === 1 ? 'the worktree folder (with any uncommitted work)' : `${live} worktree folders (with any uncommitted work)`] : []),
    ...(saved ? [saved === 1 ? 'an archive of kept work' : `${saved} archives of kept work`] : []),
    ...(branches ? [branches === 1 ? 'its branch' : `${branches} branches`] : []),
  ];
  const conversations = one ? 'the conversation' : 'their conversations';
  if (!parts.length) return `This deletes ${conversations} and removes ${one ? 'it' : 'them'} from Beluga.`;
  return `This deletes ${parts.join(', ')} and ${conversations}.`;
}

/** A picked worktree whose branch has commits that were never pushed or merged: deleting loses them. */
export interface UnpushedLoss {
  readonly id: string;
  readonly name: string;
  readonly plan: DeletePlan;
}

/** The picked worktrees that would lose commits, from what each one's check said (unasked or nothing: none). */
export function unpushedLosses(items: readonly OverviewItem[], plans: ReadonlyMap<string, DeletePlan | null>): UnpushedLoss[] {
  return items.flatMap((i) => {
    const plan = plans.get(i.ws.id);
    return plan && plan.unpushed > 0 ? [{ id: i.ws.id, name: i.ws.name, plan }] : [];
  });
}

/** The picked rows whose branch is worth checking for unpushed commits before they go. */
export const needsUnpushedCheck = (item: OverviewItem): boolean => item.ws.kind === 'worktree' && !item.ws.external && Boolean(item.ws.branch);
