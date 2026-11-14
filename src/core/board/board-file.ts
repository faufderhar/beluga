import { FOLD_MIN_BYTES, JournalFile } from '../journal-file.js';
import type { BoardProject, BriefRevision, Issue } from './model.js';

/**
 * How the board is kept on disk (BLG-942): `board.json` and a journal of what changed since,
 * `board.log` (core/journal-file.ts). A change writes only the tasks it touched (a line each, a
 * few KB), not the whole board: a busy board is thousands of tasks and megabytes, most of them done
 * or archived, and rewriting all of it a few times a second was most of what saving cost.
 *
 * A brief's history keeps each version's text before and after the change. "After" is nearly
 * always the next version's "before" (or the brief as it is now), so it's written only when it
 * isn't, and filled back in when read: the same history, a fraction of the bytes.
 */

export interface BoardSaved {
  readonly worktreeTasks: boolean;
  readonly projects: Readonly<Record<string, BoardProject>>;
  readonly issues: readonly Issue[];
}

export { FOLD_MIN_BYTES };

export class BoardFile {
  private readonly journal: JournalFile<Issue>;

  constructor(dir: string, state: () => BoardSaved, delayMs = 300, foldMinBytes = FOLD_MIN_BYTES) {
    this.journal = new JournalFile<Issue>(
      dir,
      'board',
      {
        records: () => state().issues.map((i) => [i.id, i] as const),
        meta: () => {
          const s = state();
          return { worktreeTasks: s.worktreeTasks, projects: s.projects };
        },
        pack: (i) => pack(i),
        keyOf: (w) => (w && typeof w === 'object' && typeof (w as { id?: unknown }).id === 'string' ? (w as { id: string }).id : undefined),
        toSnapshot: (meta, issues, seq) => ({ version: 1, seq, ...(meta as object), issues }),
        fromSnapshot: (raw) => {
          const { seq, issues, ...rest } = raw;
          return { meta: rest, records: Array.isArray(issues) ? issues : [], seq: typeof seq === 'number' ? seq : 0 };
        },
      },
      delayMs,
      foldMinBytes,
    );
  }

  /**
   * The board as it was left, as a board.json would hold it (for the board to check), and whether
   * it has names from before the rename. undefined: nothing saved yet; `raw` undefined: a
   * board.json is there but can't be read.
   */
  read(): { readonly raw: unknown; readonly oldNames: boolean } | undefined {
    const read = this.journal.read('"klaud"');
    if (!read) return undefined;
    if (!read.raw) return { raw: undefined, oldNames: read.flagged };
    const { seq: _seq, issues: _issues, ...kept } = read.raw;
    const meta = (read.meta && typeof read.meta === 'object' ? read.meta : {}) as Record<string, unknown>;
    return { raw: { version: 1, worktreeTasks: false, projects: {}, ...kept, ...meta, issues: read.records.map((r) => unpack(r as Record<string, unknown>)) }, oldNames: read.flagged };
  }

  /** What the board holds now is what's on disk (after reading it): only changes from here are written. */
  baseline(): void {
    this.journal.baseline();
  }

  /** Something changed: its tasks are written soon (once for every change meanwhile). */
  changed(): void {
    this.journal.changed();
  }

  /** Quitting: the whole board, in one snapshot, now; the journal goes. */
  flush(): void {
    this.journal.flush();
  }

  /** Set aside with the board.json that couldn't be read: its journal can't be read without it. */
  setAside(suffix: string): void {
    this.journal.setAside(suffix);
  }
}

/** What "after" a version of a section would be if it isn't written: the next version's "before", or the brief now. */
function expectedAfter(revisions: readonly BriefRevision[], n: number, brief: Readonly<Record<string, string | undefined>>): string {
  const r = revisions[n]!;
  for (let k = n + 1; k < revisions.length; k++) if (revisions[k]!.section === r.section) return revisions[k]!.before;
  return brief[r.section] ?? '';
}

/** A task as written: a version's "after" only where it isn't the next one's "before". */
export function pack(issue: Issue): Record<string, unknown> {
  if (!issue.revisions?.length) return issue as unknown as Record<string, unknown>;
  const brief = (issue.brief ?? {}) as Readonly<Record<string, string | undefined>>;
  const revisions = issue.revisions.map((r, n) => {
    if (r.after !== expectedAfter(issue.revisions, n, brief)) return r;
    const { after: _after, ...rest } = r;
    return rest;
  });
  return { ...issue, revisions };
}

/** A task as read: every version's "after" back. */
export function unpack(raw: Record<string, unknown>): Record<string, unknown> {
  const revisions = raw.revisions;
  if (!Array.isArray(revisions) || !revisions.some((r) => r && typeof r === 'object' && !('after' in r))) return raw;
  const list = revisions as BriefRevision[];
  const brief = (raw.brief && typeof raw.brief === 'object' ? raw.brief : {}) as Readonly<Record<string, string | undefined>>;
  // Each "after" comes from the next version's "before" (always written) or the brief.
  const out = list.map((r, n) => (r && typeof r === 'object' && !Object.hasOwn(r, 'after') ? { ...r, after: expectedAfter(list, n, brief) } : r));
  return { ...raw, revisions: out };
}
