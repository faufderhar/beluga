import { splitWorktreeRefs, worktreeRef } from '../../../../src/shared/worktree-refs.js';

/**
 * A worktree's link in the message box (BLG-887), written short as an image's is: "[\u2007name]",
 * a figure space and its name in brackets (nothing that breaks, so it never wraps). The chip is drawn
 * over exactly the room those characters take, and the brackets and space pay for its icon and
 * padding, so the chip is as wide as its name and the words after it follow right on. Out it goes
 * as "worktree:wt-…" again. A bare "worktree:wt-…" in the box (⌘⇧V, a draft from before) still
 * shows as a chip, over its longer room. Pure.
 */

const GAP = '\u2007';

/** "[\u2007name]": no digit before the space (that's an image's, "[1\u2007name]"). */
export const WORKTREE_BOX = /\[\u2007([^\]\n\u2007]{1,80})\]/g;

/** A name as the box writes it: spaces that never break, nothing that would end it early. */
export const boxLabel = (name: string): string =>
  name
    .replace(/[\]\n\u2007]/g, ' ')
    .trim()
    .replace(/\s+/g, '\u00a0')
    .slice(0, 80);

export const boxWorktree = (name: string): string => `[${GAP}${boxLabel(name)}]`;

/** Each worktree you have, by id, with its name. */
export type WorktreeNames = ReadonlyMap<string, string>;

/** The worktree last written under a label in a box, for two with the same name. */
const lastPut = new Map<string, string>();

/** The worktree a short link in the box is: the one last put there under that name, or the one with it. */
export function worktreeOf(label: string, names: WorktreeNames): string | undefined {
  const last = lastPut.get(label);
  if (last && names.has(last)) return last;
  for (const [id, name] of names) if (boxLabel(name) === label) return id;
  return undefined;
}

/** Words with each bare link to a worktree you have written short, for the box. */
export function toBox(text: string, names: WorktreeNames): string {
  if (!names.size || !text.includes('worktree:')) return text;
  return splitWorktreeRefs(text, (id) => names.has(id))
    .map((p) => {
      if (!('id' in p)) return p.text;
      const label = boxLabel(names.get(p.id)!);
      if (!label) return p.raw;
      lastPut.set(label, p.id);
      return boxWorktree(label);
    })
    .join('');
}

/** A short link in the words: where it is, and the worktree it is. */
export interface BoxedWorktree {
  readonly start: number;
  readonly end: number;
  readonly id: string;
  readonly label: string;
}

export function boxedWorktrees(text: string, names: WorktreeNames): BoxedWorktree[] {
  if (!names.size || !text.includes(GAP)) return [];
  return [...text.matchAll(WORKTREE_BOX)].flatMap((m) => {
    const id = worktreeOf(m[1]!, names);
    return id ? [{ start: m.index, end: m.index + m[0].length, id, label: m[1]! }] : [];
  });
}

/** The words as they go out: every short link back to "worktree:wt-…". */
export function plainWorktrees(text: string, names: WorktreeNames): string {
  const found = boxedWorktrees(text, names);
  if (!found.length) return text;
  let out = '';
  let at = 0;
  for (const w of found) {
    out += text.slice(at, w.start) + worktreeRef(w.id);
    at = w.end;
  }
  return out + text.slice(at);
}

/** Each worktree you have (not a chat or a main folder), by id, with its name. */
export function worktreeNamesOf(projects: readonly { readonly workspaces: readonly { readonly id: string; readonly kind: string; readonly name: string }[] }[]): Map<string, string> {
  return new Map(projects.flatMap((p) => p.workspaces.filter((w) => w.kind === 'worktree').map((w) => [w.id, w.name] as const)));
}
