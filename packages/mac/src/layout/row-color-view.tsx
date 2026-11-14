import type { Workspace } from '@beluga/workspaces/types.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { useApp } from '../lib/beluga.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import {
  ROW_COLORS,
  type RowColor,
  type RowColorChoice,
  colorLabel,
  projectColor,
  projectColorKey,
  swatchOf,
  withColor,
  workspaceColor,
  workspaceColorKey,
} from '../lib/row-colors.js';

/** A row's colour in the sidebar: the hooks rows read it with, and the Color ▸ menu that picks it. */

function setRowColor(key: string, choice: RowColorChoice | undefined): void {
  setPrefs({ rowColors: withColor(getPrefs().rowColors, key, choice) });
}

/** The project a workspace is in, when it's a real one (the Chats bucket has no folder: nothing to inherit). */
function useProjectIdOf(ws: Workspace | undefined): string | undefined {
  return useApp((state) => (ws ? state.projects.find((p) => p.root && p.workspaces.some((w) => w.id === ws.id))?.id : undefined));
}

export function useProjectColor(projectId: string | undefined): RowColor | undefined {
  const colors = usePrefs().rowColors;
  return projectId ? projectColor(colors, projectId) : undefined;
}

/** A chat's or worktree's colour, and what its Color ▸ menu offers. */
export function useWorkspaceColor(ws: Workspace | undefined): { readonly color: RowColor | undefined; readonly item: ActionItem | undefined } {
  const colors = usePrefs().rowColors;
  const projectId = useProjectIdOf(ws);
  if (!ws || ws.kind === 'main') return { color: undefined, item: undefined };
  const key = workspaceColorKey(ws.id);
  const own = colors[key];
  const inherited = projectId ? projectColor(colors, projectId) : undefined;
  const color = workspaceColor(colors, ws.id, projectId);
  // In a coloured project, "None" keeps this one plain, and "Same as Project" follows the project again.
  const first: ActionItem[] = inherited
    ? [
        { label: `Same as Project (${colorLabel(inherited)})`, swatch: swatchOf(inherited), checked: own === undefined, onSelect: () => setRowColor(key, undefined) },
        { label: 'None', checked: own === 'none', onSelect: () => setRowColor(key, 'none') },
      ]
    : [{ label: 'None', checked: own === undefined || own === 'none', onSelect: () => setRowColor(key, undefined) }];
  return { color, item: colorMenu(first, own === 'none' ? undefined : own, (c) => setRowColor(key, c)) };
}

/** A project's Color ▸ menu: its chats and worktrees wear it too, unless one has its own. */
export function projectColorItem(projectId: string, current: RowColor | undefined): ActionItem {
  const key = projectColorKey(projectId);
  return colorMenu([{ label: 'None', checked: current === undefined, onSelect: () => setRowColor(key, undefined) }], current, (c) => setRowColor(key, c));
}

function colorMenu(first: readonly ActionItem[], picked: RowColorChoice | undefined, pick: (c: RowColor) => void): ActionItem {
  return {
    label: 'Color',
    icon: 'palette',
    submenu: [...first, ...ROW_COLORS.map((c, i) => ({ label: colorLabel(c), swatch: swatchOf(c), checked: picked === c, onSelect: () => pick(c), ...(i === 0 ? { separate: true } : {}) }))],
    onSelect: () => undefined,
  };
}
