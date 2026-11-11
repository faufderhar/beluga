/**
 * A worktree named in words (BLG-878): `worktree:wt-…` is what Copy Link puts on the clipboard,
 * what Claude writes after starting one, and what both screens draw as the worktree's chip. Pasted
 * into another chat it stays a chip, and the Claude reading it is told which worktree it is.
 * Browser-safe.
 */

const PREFIX = 'worktree:';

/** The reference to a worktree, as Copy Link copies it ("worktree:wt-1a2b3c4d5e6f"). */
export const worktreeRef = (id: string): string => `${PREFIX}${id}`;

/** A ref standing on its own (not inside a word, a path or a URL), with its id (as inline-model's REF_ID). */
const BARE = String.raw`(^|[^\w/:.@-])worktree:([\w-]{3,80})(?![\w-])`;

/** In one line: inline code and links (left as they are), or a bare ref. */
const LINE_PIECE = new RegExp(String.raw`(\`+)[^\`]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+|${BARE}`, 'g');

/** Each line outside fenced code, through `edit`. */
function outsideFences(markdown: string, edit: (line: string) => string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      return fence || fenced ? line : edit(line);
    })
    .join('\n');
}

/**
 * Markdown with each bare ref to a worktree you have ("worktree:wt-…", pasted without its ticks) put
 * in inline code, so it's drawn as the chip `worktree:wt-…` already is. Code and links are left alone,
 * and so is any id `has` doesn't know.
 */
export function codeWorktreeRefs(markdown: string, has: (id: string) => boolean): string {
  if (!markdown.includes(PREFIX)) return markdown;
  return outsideFences(markdown, (line) =>
    line.replace(LINE_PIECE, (whole, _ticks: string | undefined, lead: string | undefined, id: string | undefined) => (id && has(id) ? `${lead ?? ''}\`${PREFIX}${id}\`` : whole)),
  );
}

/** A piece of a line: its words, or a bare ref (`raw` as typed). */
export type WorktreeRefPiece = { readonly text: string } | { readonly raw: string; readonly id: string };

/**
 * Words cut into plain text and the bare refs in them that `has` knows ("worktree:wt-…"): what the
 * message box draws as a chip over the ref, as it does a pasted image.
 */
export function splitWorktreeRefs(text: string, has: (id: string) => boolean): WorktreeRefPiece[] {
  if (!text.includes(PREFIX)) return text ? [{ text }] : [];
  const out: WorktreeRefPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(BARE, 'gm'))) {
    const id = m[2]!;
    if (!has(id)) continue;
    const start = (m.index ?? 0) + m[1]!.length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ raw: `${PREFIX}${id}`, id });
    last = start + PREFIX.length + id.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** What Claude is told a worktree is. */
export interface WorktreeFacts {
  readonly name: string;
  readonly project?: string | undefined;
  readonly branch?: string | undefined;
  readonly path: string;
  readonly archived?: boolean | undefined;
}

/** A ref, bare or in ticks, not already explained. */
const MENTIONED = /(^|[^\w/:.@-])(`?)worktree:([\w-]{3,80})\2(?![\w-])(?! \(worktree “)/g;

/**
 * What Claude reads for a message naming worktrees: each ref stays as written, followed by what it
 * is ("worktree:wt-… (worktree “Fix login” in Beluga, branch beluga/fix-login, folder /…)"), so
 * Claude knows which one is meant and where its files are. Code blocks and unknown ids are left alone.
 */
export function explainWorktreeRefs(prompt: string, find: (id: string) => WorktreeFacts | undefined): string {
  if (!prompt.includes(PREFIX)) return prompt;
  return outsideFences(prompt, (line) =>
    line.replace(MENTIONED, (whole, lead: string, tick: string, id: string) => {
      const w = find(id);
      if (!w) return whole;
      const said = [`worktree “${w.name.replace(/\s+/g, ' ').trim()}”${w.project ? ` in ${w.project}` : ''}`, ...(w.branch ? [`branch ${w.branch}`] : []), `folder ${w.path}`, ...(w.archived ? ['archived'] : [])];
      return `${lead}${tick}${PREFIX}${id}${tick} (${said.join(', ')})`;
    }),
  );
}
