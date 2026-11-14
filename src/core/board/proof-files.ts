import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { decodeImage } from '../../image/decode.js';
import type { Proof } from './model.js';

/**
 * Proof files outlive the worktree they were made in: a screenshot or file attached to a task is
 * copied into ~/.beluga/proof/<task id>/ at once, and the proof points at the copy (`from` says
 * where it came from). Proofs saved before that (still pointing into a worktree) are copied over
 * while their file is there (on start, and before a worktree is archived or deleted); one whose
 * file went before it could be is marked `gone`, so screens say so calmly instead of failing.
 */

export const PROOF_FOLDER = 'proof';
/** Bigger files stay where they are (a proof is a screenshot or a log, not a build). */
const MAX_BYTES = 200 * 1024 * 1024;

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether `file` is `folder` or somewhere inside it (links resolved). */
export function isInside(file: string, folder: string): boolean {
  const f = real(file);
  const d = real(folder);
  return f === d || f.startsWith(d + path.sep);
}

/** Where a task's proof files are kept. */
export const proofFolder = (home: string, issueId: string): string => path.join(home, PROOF_FOLDER, issueId);

/** The copy of one proof's file: its id first, so two files of the same name don't meet. */
export const keptPath = (home: string, issueId: string, proof: Pick<Proof, 'id'>, file: string): string => path.join(proofFolder(home, issueId), `${proof.id}-${path.basename(file)}`);

const hasFile = (proof: Proof): proof is Proof & { readonly path: string } => Boolean(proof.path) && (proof.kind === 'image' || proof.kind === 'file');

/** Each home's proof folder with its links resolved (asked once: it doesn't move while Beluga runs). */
const realFolders = new Map<string, string>();

/**
 * Whether a proof's file is one Beluga keeps (in ~/.beluga/proof). A path written under that
 * folder is (Beluga writes the copies there itself): only any other is resolved on disk. Every
 * task's proofs are checked on start, so this was a few calls on disk per proof (BLG-942).
 */
export const isKept = (home: string, file: string): boolean => {
  const folder = path.join(home, PROOF_FOLDER);
  if (file.startsWith(folder + path.sep)) return true;
  let d = realFolders.get(folder);
  if (d === undefined) realFolders.set(folder, (d = real(folder)));
  const f = real(file);
  return f === d || f.startsWith(d + path.sep);
};

/**
 * The proof with its file kept: copied into the task's folder when it's a file that's there (and
 * not too big), pointing at an earlier copy when there is one, and marked `gone` when its file is
 * nowhere. Returns the same object when nothing changed.
 */
export function keepProofFile(proof: Proof, issueId: string, home: string): Proof {
  if (!hasFile(proof)) return proof;
  const mark = (p: Proof, gone: boolean): Proof => {
    if (Boolean(p.gone) === gone) return p;
    const { gone: _, ...rest } = p;
    return gone ? { ...rest, gone: true } : rest;
  };
  if (isKept(home, proof.path)) return mark(proof, !existsSync(proof.path));
  const to = keptPath(home, issueId, proof, proof.path);
  const moved = (): Proof => mark({ ...proof, path: to, from: proof.from ?? proof.path }, false);
  if (existsSync(to)) return moved();
  let size: number;
  try {
    const st = statSync(proof.path);
    if (!st.isFile()) return mark(proof, false);
    size = st.size;
  } catch {
    return mark(proof, true);
  }
  if (size > MAX_BYTES) return mark(proof, false);
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(proof.path, to);
  } catch {
    // Can't copy (a full disk): it stays where it is, for now.
    return mark(proof, false);
  }
  return moved();
}

/**
 * A task's proof list with its files kept (see keepProofFile); `within`: only those whose file is
 * in this folder (a worktree about to go). The same array when nothing changed.
 */
export function keepProofFiles(list: readonly Proof[], issueId: string, home: string, within?: string): readonly Proof[] {
  let changed = false;
  const next = list.map((p) => {
    if (within && !(p.path && isInside(p.path, within))) return p;
    const kept = keepProofFile(p, issueId, home);
    if (kept !== p) changed = true;
    return kept;
  });
  return changed ? next : list;
}

/** Throw away a kept copy (its proof was removed); files elsewhere are never touched. */
export function dropKeptFile(home: string, file: string | undefined): void {
  if (!file || !isKept(home, file)) return;
  rmSync(file, { force: true });
}

/** An archived task's screenshots shrink to this longest side, as a JPEG of this quality: a few KB each. */
export const THUMB_SIDE = 480;
const THUMB_QUALITY = 55;

/**
 * Let go of a proof's kept file (its task went to the Archive): an image becomes a small JPEG
 * beside where it was (`thumb`), any other file goes (`gone`); both keep how big it was. Files
 * Beluga doesn't keep are never touched. Returns the same object when nothing changed.
 */
export function letGoProofFile(proof: Proof, home: string): Proof {
  if (!hasFile(proof) || proof.thumb || proof.gone || !isKept(home, proof.path)) return proof;
  let bytes: Buffer;
  try {
    bytes = readFileSync(proof.path);
  } catch {
    const { path: _, ...rest } = proof;
    return { ...rest, gone: true };
  }
  const size = bytes.length;
  if (proof.kind === 'image') {
    try {
      const small = decodeImage(new Uint8Array(bytes), proof.path, THUMB_SIDE);
      const to = path.join(path.dirname(proof.path), `${path.parse(proof.path).name}-thumb.jpg`);
      writeFileSync(to, jpeg.encode({ width: small.width, height: small.height, data: Buffer.from(small.data.buffer, small.data.byteOffset, small.data.byteLength) }, THUMB_QUALITY).data);
      if (to !== proof.path) rmSync(proof.path, { force: true });
      return { ...proof, path: to, thumb: true, bytes: size };
    } catch {
      // Not an image Beluga can read: let go of it like any other file.
    }
  }
  rmSync(proof.path, { force: true });
  const { path: _, ...rest } = proof;
  return { ...rest, gone: true, bytes: size };
}

/** Throw away a task's kept files (the task was deleted). */
export function dropProofFolder(home: string, issueId: string): void {
  rmSync(proofFolder(home, issueId), { recursive: true, force: true });
}
