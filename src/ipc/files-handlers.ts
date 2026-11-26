import type { Session } from '../core/session.js';
import { type ContentResults, type NameResults, formatWithPrettier, formatterFor, searchContents, searchNames, writeWorkspaceFile } from '../core/workspace-files.js';
import type { Args } from './api.js';
import { THIS_COMPUTER } from '../shared/assistant.js';

/** What each method in files-api.ts does: on your own workspaces' folders, on this Mac. */

type FilesEditMethod = 'files.searchContent' | 'files.searchNames' | 'files.save' | 'files.formatter' | 'files.format';
type FilesEditHandlers = { readonly [M in FilesEditMethod]: (s: Session, ...args: Args<M>) => unknown };

/** The workspace's folder, and its project's main folder (where Prettier may be installed instead). */
function foldersOf(s: Session, wsId: string): { root: string; more: string[] } {
  const ws = s.workspaces?.manager.find(wsId);
  if (!ws?.path || ws.archived) throw new Error(`That workspace isn’t on ${THIS_COMPUTER}`);
  return { root: ws.path, more: ws.projectRoot && ws.projectRoot !== ws.path ? [ws.projectRoot] : [] };
}

/** Searches running now, by session and slot: a newer one in the same slot stops the older. */
const running = new WeakMap<Session, Map<string, AbortController>>();

/** Run a search in its slot: a newer one in the same slot (by session) aborts it. */
async function inSlot<T>(s: Session, slot: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const slots = running.get(s) ?? new Map<string, AbortController>();
  running.set(s, slots);
  slots.get(slot)?.abort();
  const ctl = new AbortController();
  slots.set(slot, ctl);
  try {
    return await run(ctl.signal);
  } finally {
    if (slots.get(slot) === ctl) slots.delete(slot);
  }
}

const flagsOf = (opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } | undefined) => ({ regex: opts?.regex ?? false, caseSensitive: opts?.caseSensitive ?? false, wholeWord: opts?.wholeWord ?? false });

export const FILES_EDIT_HANDLERS = {
  'files.searchContent': (s, wsId, query, opts): Promise<ContentResults> => {
    const { root } = foldersOf(s, wsId);
    return inSlot(s, `${wsId}\0${opts?.slot ?? ''}`, (signal) => searchContents(root, query, flagsOf(opts), signal));
  },
  'files.searchNames': (s, wsId, query, opts): Promise<NameResults> => {
    const { root } = foldersOf(s, wsId);
    return inSlot(s, `${wsId}\0names\0${opts?.slot ?? ''}`, (signal) => searchNames(root, query, flagsOf(opts), signal));
  },
  'files.save': (s, wsId, rel, content, opts) => writeWorkspaceFile(foldersOf(s, wsId).root, rel, content, opts ?? {}),
  'files.formatter': (s, wsId, rel) => {
    const { root, more } = foldersOf(s, wsId);
    return formatterFor(root, rel, more);
  },
  'files.format': (s, wsId, rel, content) => {
    const { root, more } = foldersOf(s, wsId);
    return formatWithPrettier(root, rel, content, more);
  },
} satisfies FilesEditHandlers;
