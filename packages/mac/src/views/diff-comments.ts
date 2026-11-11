import type { DiffLine } from '../../../../src/shared/diff-lines.js';

/**
 * Comments on a diff's lines, for the chat. Each waits above its conversation's message box as a
 * card (where it is, what you said) until the message is sent; then it goes as text after your
 * words: where it is ("On `src/a.ts:12-14`:"), the lines (a ```diff block) and the comment.
 */

/** Lines of code quoted with a comment, at most (the rest is counted). */
const QUOTE_LINES = 40;

/** Which file's lines a comment is on: the new ones, or (only removed lines picked) the old ones. */
export interface CommentRange {
  readonly side: 'new' | 'old';
  readonly from: number;
  readonly to: number;
}

export interface DiffComment extends CommentRange {
  readonly id: string;
  readonly path: string;
  /** The lines it's on, each with its sign ("+", "-" or " "), at most QUOTE_LINES. */
  readonly code: readonly string[];
  /** Lines picked past those. */
  readonly more: number;
  readonly text: string;
}

const isCode = (l: DiffLine): boolean => l.kind === 'ctx' || l.kind === 'add' || l.kind === 'del';

/** The code rows between two picked rows (either order), hunk headings and notes left out. */
function pickedCode(lines: readonly DiffLine[], a: number, b: number): DiffLine[] {
  return lines.slice(Math.min(a, b), Math.max(a, b) + 1).filter(isCode);
}

/** The line numbers rows `a`…`b` cover: the new file's, or the old file's when only removed lines are picked. */
export function codeRange(lines: readonly DiffLine[], a: number, b: number): CommentRange | undefined {
  const code = pickedCode(lines, a, b);
  const news = code.flatMap((l) => (l.new !== undefined ? [l.new] : []));
  const nums = news.length ? news : code.flatMap((l) => (l.old !== undefined ? [l.old] : []));
  if (!nums.length) return undefined;
  return { side: news.length ? 'new' : 'old', from: Math.min(...nums), to: Math.max(...nums) };
}

let made = 0;

/** A comment on rows `a`…`b` of a file's diff (undefined when they hold no code or it says nothing). */
export function makeComment(path: string, lines: readonly DiffLine[], a: number, b: number, text: string): DiffComment | undefined {
  const range = codeRange(lines, a, b);
  const said = text.trim();
  if (!range || !said) return undefined;
  const code = pickedCode(lines, a, b);
  const sign = (l: DiffLine): string => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ');
  const shown = code.slice(0, QUOTE_LINES).map((l) => `${sign(l)}${l.text}`);
  return { id: `c${++made}`, path, ...range, code: shown, more: code.length - shown.length, text: said };
}

const span = (from: number, to: number): string => (to !== from ? `${from}-${to}` : `${from}`);

/** "README.md:2-4", or "README.md, removed line 7": where a comment is, in words. */
export function commentWhere(c: Pick<DiffComment, 'path' | 'side' | 'from' | 'to'>): string {
  if (c.side === 'new') return `${c.path}:${span(c.from, c.to)}`;
  return `${c.path}, removed line${c.to !== c.from ? 's' : ''} ${span(c.from, c.to)}`;
}

/** A fence longer than any run of backticks in the code, so the code can't close it. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A comment as it goes to the agent. */
export function commentText(c: DiffComment): string {
  const head = c.side === 'new' ? `On \`${commentWhere(c)}\`:` : `On \`${c.path}\`, removed line${c.to !== c.from ? 's' : ''} ${span(c.from, c.to)}:`;
  const body = [...c.code, ...(c.more > 0 ? [`… ${c.more} more lines`] : [])].join('\n');
  const fence = fenceFor(body);
  return [head, `${fence}diff`, body, fence, c.text].join('\n');
}

/** The message as sent: your words, then each comment after a blank line. */
export function withComments(words: string, comments: readonly DiffComment[]): string {
  return [words.trim(), ...comments.map(commentText)].filter(Boolean).join('\n\n');
}

/** The rows of `path`'s diff the comments are on (a change's removed lines with its new ones). */
export function commentedRows(comments: ReadonlyArray<Pick<DiffComment, 'path' | 'side' | 'from' | 'to'>>, path: string, lines: readonly DiffLine[]): ReadonlySet<number> {
  const rows = new Set<number>();
  for (const c of comments) {
    if (c.path !== path) continue;
    const hit = lines.flatMap((l, i) => {
      const n = c.side === 'new' ? l.new : l.kind === 'del' ? l.old : undefined;
      return n !== undefined && n >= c.from && n <= c.to ? [i] : [];
    });
    if (!hit.length) continue;
    const [first, last] = [hit[0]!, hit[hit.length - 1]!];
    lines.forEach((l, i) => {
      if (i >= first && i <= last && (l.kind === 'del' || hit.includes(i))) rows.add(i);
    });
  }
  return rows;
}

// The comments waiting, per conversation's box (as its images and files wait: chat/use-attachments.tsx).

const waiting = new Map<string, readonly DiffComment[]>();
const listeners = new Set<() => void>();
const NONE: readonly DiffComment[] = [];

const put = (box: string, list: readonly DiffComment[]): void => {
  if (list.length) waiting.set(box, list);
  else waiting.delete(box);
  for (const l of [...listeners]) l();
};

export const waitingComments = (box: string): readonly DiffComment[] => waiting.get(box) ?? NONE;

export function subscribeComments(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const addComment = (box: string, c: DiffComment): void => put(box, [...waitingComments(box), c]);

export const removeComment = (box: string, id: string): void => put(box, waitingComments(box).filter((c) => c.id !== id));

/** The box's comments, out of it as its message goes; `putBack` if the message couldn't go. */
export function takeComments(box: string): { readonly comments: readonly DiffComment[]; readonly putBack: () => void } {
  const comments = waitingComments(box);
  if (comments.length) put(box, NONE);
  return { comments, putBack: () => comments.length && put(box, [...comments, ...waitingComments(box)]) };
}
