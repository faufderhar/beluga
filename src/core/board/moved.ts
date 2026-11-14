import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Actor, type BoardState, type CarriedFile, type Issue, type Proof, findIssue } from './model.js';
import { keptPath } from './proof-files.js';

/**
 * A plan's tasks moving to another computer with it (BLG-806). On the old computer: each task as
 * it is, with its kept proof files (small enough to carry). On the new one: the same tasks, made
 * ready for that board. Each keeps its id and its key when they're free there; a key that's taken
 * there gets the board's next one, and the old key stays on the task as an alias, so links to it
 * still open it. Its worktrees stay behind (the plan starts new ones there), so a task that was
 * under way is ready again, and its branch came along with the plan.
 */

/** One proof file at most this big goes along; the rest stay behind (the proof says its file is gone). */
export const MAX_CARRIED_FILE = 4 * 1024 * 1024;
/** And all of a plan's proof files together. */
export const MAX_CARRIED_FILES = 32 * 1024 * 1024;

/** The proof files of these tasks that go along (by proof id), within the limits. */
export function carryProofFiles(issues: readonly Issue[]): Record<string, CarriedFile> {
  const out: Record<string, CarriedFile> = {};
  let total = 0;
  for (const p of issues.flatMap((i) => i.proof)) {
    if (!p.path || p.gone || (p.kind !== 'image' && p.kind !== 'file')) continue;
    try {
      const size = statSync(p.path).size;
      if (size > MAX_CARRIED_FILE || total + size > MAX_CARRIED_FILES) continue;
      out[p.id] = { name: path.basename(p.path), data: readFileSync(p.path).toString('base64') };
      total += size;
    } catch {
      // Not there any more: it arrives marked gone.
    }
  }
  return out;
}

export interface MovedTasks {
  readonly issues: readonly Issue[];
  /** Old id → id here (the same unless that id is taken here). */
  readonly ids: ReadonlyMap<string, string>;
}

export interface MoveTarget {
  /** The project here it runs in, and its board's prefix and next number. */
  readonly projectId: string;
  readonly prefix: string;
  readonly next: number;
  /** The computer it came from, in words. */
  readonly from: string;
  readonly by: Actor;
  readonly at: number;
}

const short = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** The tasks made ready for this board (nothing is changed here: the board puts them in). */
export function prepareMoved(board: BoardState, issues: readonly Issue[], target: MoveTarget): MovedTasks {
  // An id here that isn't the record of an earlier move away (moving back) is someone else's: a new one.
  const ids = new Map(issues.map((i) => {
    const there = board.issues.find((x) => x.id === i.id);
    return [i.id, there && !there.movedTo ? short('i') : i.id] as const;
  }));
  const keysTaken = new Set(board.issues.filter((x) => !x.movedTo || !ids.has(x.id)).flatMap((x) => [x.key, ...(x.aliases ?? [])]));
  let next = target.next;
  const out = issues.map((i): Issue => {
    const free = !keysTaken.has(i.key) && i.key.startsWith(`${target.prefix}-`);
    const key = free ? i.key : `${target.prefix}-${next}`;
    const number = free ? i.number : next++;
    keysTaken.add(key);
    const aliases = [...new Set([...(i.aliases ?? []), ...(free ? [] : [i.key])])].filter((k) => k !== key);
    const map = (id: string): string | undefined => ids.get(id) ?? (findIssue(board, id) && !ids.has(id) ? id : undefined);
    const { worktrees: _w, worktreeGone: _g, carriedBy: _c, board: _b, movedTo: _m, archivedAt: _a, needsChecks: _n, mergedHeld: _mh, link: _l, ...rest } = i;
    // Under way there: ready here again (the plan's next agent picks it up from its branch).
    const status = i.status === 'in_progress' ? 'todo' : i.status;
    const parent = i.parent ? map(i.parent) : undefined;
    return {
      ...rest,
      id: ids.get(i.id)!,
      key,
      number,
      projectId: target.projectId,
      status,
      ...(parent ? { parent } : {}),
      blockedBy: i.blockedBy.flatMap((b) => map(b) ?? []),
      related: i.related.flatMap((b) => map(b) ?? []),
      ...(aliases.length ? { aliases } : {}),
      worktrees: [],
      activity: [...i.activity, { id: short('a'), at: target.at, by: target.by, kind: 'plan', text: `moved here with its plan from ${target.from}${free ? '' : ` (it was ${i.key} there)`}` }],
      updatedAt: target.at,
    };
  });
  return { issues: out, ids };
}

/** The proof of a task here, with the files that came along written into its folder (else marked gone). */
export function landProof(proof: readonly Proof[], issueId: string, home: string | null, files: Readonly<Record<string, CarriedFile>>): Proof[] {
  return proof.map((p) => {
    if (!p.path || (p.kind !== 'image' && p.kind !== 'file')) return p;
    const f = files[p.id];
    if (!f || !home) return { ...p, gone: true };
    const to = keptPath(home, issueId, p, f.name);
    try {
      if (!existsSync(to)) {
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, Buffer.from(f.data, 'base64'), { mode: 0o600 });
      }
      const { gone: _g, ...rest } = p;
      return { ...rest, path: to };
    } catch {
      return { ...p, gone: true };
    }
  });
}
