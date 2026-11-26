/**
 * How Claude takes what you send: right away, planning first (Claude Code's plan mode, which you
 * approve), or planning with tasks (a plan of milestones and tasks that goes on the board when you
 * approve it; see core/plans).
 */

export type ComposeMode = 'act' | 'plan' | 'tasks';

export const MODE_INFO: Readonly<Record<ComposeMode, { readonly label: string; readonly hint: string; readonly banner: string }>> = {
  act: { label: 'Act', hint: 'Your agent starts right away', banner: '' },
  plan: { label: 'Plan First', hint: 'Your agent proposes a plan and starts once you approve it', banner: 'Your agent proposes a plan before changing anything' },
  // Bigger work (BLG-1023: was "Plan with Tasks"): a plan of milestones whose tasks run in parallel worktrees.
  tasks: { label: 'Advanced Planning', hint: 'For bigger work: milestones and tasks that run side by side, each in its own worktree', banner: 'Your agent splits this into milestones and tasks that run side by side' },
};

/** ⇧⇥: acting ↔ planning first, as in Claude Code. (Plan with Tasks makes a plan: it's picked from the menu, never a keystroke away.) */
export function nextMode(mode: ComposeMode): ComposeMode {
  return mode === 'act' ? 'plan' : 'act';
}
