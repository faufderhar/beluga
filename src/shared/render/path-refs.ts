/**
 * Files and folders a message names (BLG-752), so the chat can make them links: "src/app.ts:12",
 * `.beluga/scratch/01-login.png`, "~/notes/", "/Users/me/Desktop/a.txt". Pure and browser-safe
 * (the screens import it; tested in tests/path-refs.test.ts).
 *
 * What counts: a full path from a folder a computer really starts at (/Users, /tmp, C:\…), one
 * from home (~/…), or a relative one that reads as a path ("./x", a dot-folder like ".beluga/x",
 * a folder ending in "/", or a file with an extension). Not a web address, a route like
 * "/api/login", a package ("@scope/pkg/x.js"), a glob, or words like "and/or".
 */

import { SCRATCH_DIR } from '../scratch-dir.js';

export interface PathRef {
  /** As written, without its line ("src/app.ts", "~/notes/", "/tmp/a b.png"). */
  readonly path: string;
  readonly line?: number;
  /** Written as a folder (ends with a separator). */
  readonly dir: boolean;
  /** Relative to the worktree (neither from a root nor from home). */
  readonly relative: boolean;
}

/** The scheme the chat links a path with: `beluga-path:<path, encoded>[#line]`. */
export const PATH_LINK_SCHEME = 'beluga-path:';

/** Top folders of a Mac, Linux or a container: a "/…" path starting elsewhere is a route, not a file. */
const ROOTS = new Set(['Users', 'home', 'tmp', 'private', 'var', 'opt', 'etc', 'Applications', 'Library', 'System', 'Volumes', 'usr', 'mnt', 'srv', 'root', 'workspace', 'workspaces', 'data']);

const LINE = /^(.+?)(?::(\d{1,7})(?::\d{1,5})?|#L(\d{1,7})(?:-L?\d{1,7})?)$/;
/** What never appears in a path someone means: globs, markup, quotes, a shell's pieces. */
const NOT_PATH = /[*?{}[\]<>|"'`$\n\t]/;
const NOT_PATH_SPACED = /[*?{}[\]<>|"`$\n\t]/;
const SEGMENT = /^[\w@.+,=~-]+$/;
const SEGMENT_SPACED = /^[\w@.+,=~ ()&'-]+$/;
const EXT = /\.[A-Za-z][\w-]{0,9}$/;
const WINDOWS = /^[A-Za-z]:[\\/]/;

function segmentsOk(parts: readonly string[], spaces: boolean): boolean {
  const ok = spaces ? SEGMENT_SPACED : SEGMENT;
  return parts.every((p) => ok.test(p) && p.trim() === p);
}

/**
 * The path a piece of text is, when it is one. `spaces`: the whole text is the path (an inline
 * code span), so a full path may have spaces in it ("/Users/me/My Files/a.png").
 */
export function readPath(raw: string, { spaces = false }: { spaces?: boolean } = {}): PathRef | undefined {
  const text = raw.trim();
  if (text.length < 2 || text.length > 1024 || text.includes('://') || text.startsWith('//')) return undefined;
  const m = LINE.exec(text);
  const path = m ? m[1]! : text;
  const n = m ? Number(m[2] ?? m[3]) : 0;
  const ref = (relative: boolean): PathRef => ({ path, ...(n > 0 ? { line: n } : {}), dir: /[\\/]$/.test(path), relative });
  if (WINDOWS.test(path)) {
    const parts = path.slice(3).split(/[\\/]/).filter(Boolean);
    return !/[*?"<>|\n\t]/.test(path) && segmentsOk(parts, spaces) ? ref(false) : undefined;
  }
  // A path with spaces may have an apostrophe in it too ("/Users/me/Kay's Notes/").
  if ((spaces ? NOT_PATH_SPACED : NOT_PATH).test(path) || path.includes('\\')) return undefined;
  const hasSpace = path.includes(' ');
  if (path === '~/' || /^~\/./.test(path)) {
    const parts = path.slice(2).split('/').filter(Boolean);
    return segmentsOk(parts, spaces) ? ref(false) : undefined;
  }
  if (path.startsWith('/')) {
    const parts = path.split('/').filter(Boolean);
    return parts.length && ROOTS.has(parts[0]!) && segmentsOk(parts, spaces) ? ref(false) : undefined;
  }
  // Relative: never with spaces (a sentence with a slash in it isn't a path).
  if (hasSpace || path.startsWith('@') || path.startsWith('-')) return undefined;
  const parts = path.split('/');
  const named = parts.filter(Boolean);
  if (!named.length || !segmentsOk(named, false) || parts.slice(0, -1).some((p) => !p)) return undefined;
  if (/^\.{1,2}\/./.test(path)) return ref(true);
  if (parts.length < 2) return undefined;
  const first = named[0]!;
  const last = parts.at(-1)!;
  // "example.com/a.png" is a web address with its scheme left off.
  if (first.includes('.') && !first.startsWith('.')) return undefined;
  if (/^\.\w/.test(first) || !last || EXT.test(last)) return ref(true);
  return undefined;
}

export function pathHref(ref: PathRef): string {
  return `${PATH_LINK_SCHEME}${encodeURIComponent(ref.path)}${ref.line ? `#${ref.line}` : ''}`;
}

/** The folder in a worktree where Beluga keeps an agent's scratch and reports. */
const BELUGA_DIR = '.beluga';

/**
 * Where a relative path may be in a worktree, in order: from its root, then from its .beluga
 * folder, since an agent that says "files are in .beluga/" often names them from there
 * ("scratch/pr-498/" for .beluga/scratch/pr-498/). Without the leading "./" or trailing "/".
 */
export function relativeCandidates(path: string): readonly string[] {
  const rel = path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (rel.startsWith('../') || rel === BELUGA_DIR || rel.startsWith(`${BELUGA_DIR}/`)) return [rel];
  return [rel, `${BELUGA_DIR}/${rel}`];
}

/** Folders Beluga keeps in scratch itself: never a checkout an agent made. */
const OWN_SCRATCH_FOLDERS = new Set(['sent', 'agents']);

/**
 * Where else a relative path may be when it isn't in the worktree: in a checkout an agent made in its
 * scratch folder (`.beluga/scratch/land-492/`, to land or review a PR), named from that checkout's
 * root (BLG-956). `folders` are the names directly under the scratch folder, in the order to look.
 */
export function scratchCandidates(path: string, folders: readonly string[]): readonly string[] {
  const rel = path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (rel.startsWith('../') || rel === BELUGA_DIR || rel.startsWith(`${BELUGA_DIR}/`)) return [];
  return folders.filter((f) => /^[^./\\][^/\\]*$/.test(f) && !OWN_SCRATCH_FOLDERS.has(f)).map((f) => `${SCRATCH_DIR}/${f}/${rel}`);
}

/** A path link back (from pathHref), or undefined for any other link. */
export function parsePathHref(href: string): PathRef | undefined {
  if (!href.startsWith(PATH_LINK_SCHEME)) return undefined;
  const [raw = '', line] = href.slice(PATH_LINK_SCHEME.length).split('#');
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  const n = Number(line);
  const relative = !path.startsWith('/') && !/^~(?=$|[\\/])/.test(path) && !WINDOWS.test(path);
  return { path, ...(n > 0 ? { line: n } : {}), dir: /[\\/]$/.test(path), relative };
}

/** Pieces of a line left alone: an inline code span (looked at on its own), a link, an autolink, a web address. */
const SKIP = /(\[[^\]\n]*\]\((?:<[^>\n]*>|[^)\n]*)\))|(`+)([^`\n]*?[^`\n]|[^`\n])\2(?!`)|(<[a-z][\w+.-]*:[^>\s]*>)|(\bhttps?:\/\/\S+|\bwww\.\S+)/gi;
/** A run of text that could be a path: after a space, a bracket, a quote or emphasis. */
const TOKEN = /(^|[\s(“‘"'*>])((?:[A-Za-z]:\\|[~./\w@+-])[^\s()<>[\]{}"'`*|]*)/g;
/** What ends a sentence rather than the path. */
const TRAIL = /[.,;:!?…]+$/;

function linkText(text: string, relative: boolean): string {
  return text.replace(TOKEN, (whole, lead: string, token: string) => {
    const tail = TRAIL.exec(token)?.[0] ?? '';
    const body = token.slice(0, token.length - tail.length);
    const ref = readPath(body);
    if (!ref || (ref.relative && !relative)) return whole;
    return `${lead}[${body}](${pathHref(ref)})${tail}`;
  });
}

function linkLine(line: string, relative: boolean): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(SKIP)) {
    const at = m.index ?? 0;
    out += linkText(line.slice(last, at), relative);
    const code = m[3];
    const ref = code !== undefined ? readPath(code, { spaces: true }) : undefined;
    // A path in backticks: the code span itself becomes the link.
    out += ref && !(ref.relative && !relative) ? `[${m[0]}](${pathHref(ref)})` : m[0];
    last = at + m[0].length;
  }
  return out + linkText(line.slice(last), relative);
}

/**
 * Markdown with the paths it names made links (PATH_LINK_SCHEME), in its words and in inline code.
 * Code blocks, links and web addresses stay as they are. `relative`: link paths relative to a
 * worktree too (only where there's one to open them in).
 */
export function linkPaths(text: string, { relative }: { relative: boolean }): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (open && (!fence || open.startsWith(fence))) {
        fence = fence ? undefined : open;
        return line;
      }
      return fence ? line : linkLine(line, relative);
    })
    .join('\n');
}
