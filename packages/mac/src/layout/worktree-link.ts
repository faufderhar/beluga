import type { Workspace } from '@beluga/workspaces/types.js';
import { worktreeRef } from '@beluga/shared/worktree-refs.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { toast, type useBeluga } from '../lib/beluga.js';

/**
 * Copy Link on a worktree (BLG-878): its ref ("worktree:wt-…") on the clipboard, to paste in another
 * chat, where it shows as the worktree's chip and its Claude is told which worktree it is.
 * None for a chat or a main folder (the chip is a worktree's).
 */
export function copyLinkItems(ws: Workspace, client: ReturnType<typeof useBeluga>['client']): ActionItem[] {
  if (ws.kind !== 'worktree') return [];
  const ref = worktreeRef(ws.id);
  return [
    {
      label: 'Copy Link',
      icon: 'copy',
      separate: true,
      onSelect: () =>
        void copyText(ref).then(
          () => toast(client, `Copied a link to ${ws.name}. Paste it in any chat to mention it.`, 'success'),
          () => toast(client, 'Cannot copy the link', 'error'),
        ),
    },
  ];
}
