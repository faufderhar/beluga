import { z } from 'zod';

/**
 * What a fork brings besides its commits, Scratch and conversation (BLG-1017; core/friend-share/carry.ts
 * does the files): what the owner picks, what a preview shows, what came and what stayed behind, and
 * those in words for the chat on both Macs. Browser-safe: the Mac app's What Forks Bring sheet uses it.
 */

/** All picked files together stay under this (the pack itself caps at MAX_DOWNLOAD_BYTES). */
export const CARRY_MAX = 150 * 1024 * 1024;
/** One file bigger than this stays behind. */
export const CARRY_FILE_MAX = 50 * 1024 * 1024;
/** A pick (or all of them) this big gets a warning before it goes. */
export const CARRY_WARN = 20 * 1024 * 1024;
export const CARRY_FILES = 5000;
/** How many files a preview lists, and how many candidates it offers. */
export const LISTED = 400;
export const CANDIDATES = 60;
/** A note lists at most this many of each. */
export const NOTED = 100;

/** What git ignores that the setup makes again, and Beluga's own and git's folders: never offered. */
export const REGENERATED = new Set(['node_modules', '.git', '.beluga', '.klaud', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.svelte-kit', '.expo', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', '.gradle', 'DerivedData', 'Pods', '.DS_Store', '.vercel', '.wrangler']);
/**
 * Never carried from or into, whatever a pack says (lower case: a Mac's disk ignores case): git's and
 * Beluga's own folders, installed packages, and folders whose files an editor or agent runs on its own.
 */
export const NEVER_INTO = new Set(['.git', '.beluga', '.klaud', 'node_modules', '.claude', '.codex', '.vscode', '.idea', '.husky', '.githooks', '.direnv']);
/** No line breaks or other control characters: what a pack says is shown and put in an agent's instructions. */
const PLAIN = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;

export const relPath = z
  .string()
  .min(1)
  .max(500)
  // A folder may end in "/"; nothing absolute, no "..", nothing in git's or Beluga's own folders.
  .refine((p) => {
    const segs = p.replace(/\/+$/, '').split(/[\\/]/);
    return PLAIN.test(p) && !/^([\\/]|[a-z]:)/i.test(p) && !segs.some((s) => s === '..' || s === '' || s === '.' || NEVER_INTO.has(s.toLowerCase()));
  }, 'Pick a path inside the worktree');

export const CarryPicks = z.object({ paths: z.array(relPath).max(CANDIDATES), secrets: z.array(relPath).max(500) });
export type CarryPicks = z.infer<typeof CarryPicks>;
export const NO_PICKS: CarryPicks = { paths: [], secrets: [] };

/** Why a file stayed behind: a secret nobody ticked, too big, over the limit, or git-ignored and not picked. */
export const LeftWhy = z.enum(['secret', 'big', 'limit', 'ignored', 'there', 'unplaced']);
export type LeftWhy = z.infer<typeof LeftWhy>;

/** What came along and what stayed behind, as the pack's meta and the fork's `.beluga/fork.json` say it. */
const notePath = z.string().max(500).regex(PLAIN);
export const CarryNote = z.object({
  sent: z.array(z.object({ path: notePath, files: z.number().int().min(0), bytes: z.number().int().min(0) })).max(NOTED),
  secrets: z.array(notePath).max(NOTED),
  left: z.array(z.object({ path: notePath, why: LeftWhy })).max(NOTED),
});
export type CarryNote = z.infer<typeof CarryNote>;

/** The fork's own note in its worktree: whose it was, and what came. */
export const ForkNote = CarryNote.extend({ owner: z.string().max(120).regex(PLAIN), from: z.string().max(200).regex(PLAIN), at: z.number().int().min(0), scratch: z.number().int().min(0) });

/** A name from another Mac as one plain line (no line breaks or control characters), at most `max` long. */
export const plainLine = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
export type ForkNote = z.infer<typeof ForkNote>;
export const FORK_NOTE = '.beluga/fork.json';

export interface CarryFile {
  readonly path: string;
  readonly bytes: number;
  readonly secret?: true;
  /** Goes with the next fork. */
  readonly goes: boolean;
  readonly why?: LeftWhy;
}

export interface CarryCandidate {
  /** From the worktree's root; a folder ends in `/`. */
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly secrets: number;
  readonly picked: boolean;
  /** Bigger than CARRY_WARN. */
  readonly large?: true;
}

/** What the owner sees before anything goes: what git ignores here, the picks, their files and what they add up to. */
export interface CarryPreview {
  readonly scratch: { readonly files: number; readonly bytes: number };
  readonly candidates: readonly CarryCandidate[];
  readonly files: readonly CarryFile[];
  /** Files of the picks not listed in `files`. */
  readonly more: number;
  /** What goes, in bytes and files (Scratch not counted). */
  readonly bytes: number;
  readonly count: number;
  readonly limit: number;
  readonly warn: number;
  readonly warnings: readonly string[];
}

/** What came along and what stayed behind, in words. */

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;
const listed = (paths: readonly string[], max = 4): string => (paths.length > max ? `${paths.slice(0, max).join(', ')} and ${paths.length - max} more` : paths.join(', '));

/** What came along, one phrase per pick (and the secrets ticked to go): `.context/ (22 files)`. */
export function carriedWords(note: CarryNote | undefined): string[] {
  if (!note) return [];
  return [...note.sent.map((s) => `${s.path} (${files(s.files)})`), ...(note.secrets.length ? [`${note.secrets.length === 1 ? 'a secret' : `${note.secrets.length} secrets`} ticked to go (${listed(note.secrets)})`] : [])];
}

/** What stayed behind, grouped by why, or '' when nothing did. `owner`: said to the owner (who picks), else to the friend. */
export function leftWords(note: CarryNote | undefined, owner: boolean): string {
  if (!note) return '';
  const of = (why: LeftWhy): string[] => note.left.filter((l) => l.why === why).map((l) => l.path);
  return [
    of('secret').length ? `${listed(of('secret'))} (${of('secret').length === 1 ? 'a secret' : 'secrets'}${owner ? ', not ticked' : ''})` : '',
    of('ignored').length ? `${listed(of('ignored'))} (git-ignored${owner ? ', not picked' : ''})` : '',
    of('big').length ? `${files(of('big').length)} over the size limit` : '',
    of('limit').length ? `${files(of('limit').length)} past the total limit` : '',
    !owner && of('unplaced').length ? `${files(of('unplaced').length)} that couldn’t be placed here` : '',
    !owner && of('there').length ? `${listed(of('there'))} (you already had ${of('there').length === 1 ? 'it' : 'them'}: yours stayed)` : '',
  ]
    .filter(Boolean)
    .join('; ');
}
