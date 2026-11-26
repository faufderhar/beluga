/**
 * A very long paste (a whole conversation, a big log) goes as a file, not as words (BLG-988): it
 * waits above the box as a chip, Beluga keeps it as a .txt, and the agent gets its first lines and
 * the file's path, so it reads the rest only when it needs to. The file's path goes on a line of
 * its own, in backticks, as any attached file's does, so it's copied into the chat's scratch folder
 * (`src/core/sent-files.ts`).
 */

/** From this many characters a paste goes as a file. */
export const LONG_PASTE_CHARS = 6_000;
/** Or from this many lines, however short they are. */
export const LONG_PASTE_LINES = 120;
/** Longest paste Beluga keeps (as `MAX_PASTE_CHARS` in core/attachments.ts). */
export const MAX_PASTE_CHARS = 2_000_000;
/** Lines of the paste that go with the message, so the agent knows what the file is. */
export const PREVIEW_LINES = 5;
/** Longest of those lines, in characters (one long line of JSON stays short). */
const PREVIEW_LINE_CHARS = 200;

/** How many lines `text` has (a last newline doesn't start one). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** A paste long enough to go as a file. */
export function isLongPaste(text: string): boolean {
  if (text.length >= LONG_PASTE_CHARS) return true;
  if (text.length < LONG_PASTE_LINES) return false;
  return lineCount(text) >= LONG_PASTE_LINES;
}

/** A size the way the chip says it: "812 B", "38 KB", "1.4 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Its size in UTF-8 (what the file will take). */
export const byteSize = (text: string): number => new TextEncoder().encode(text).byteLength;

/** What the chip says: "Pasted text · 412 lines". */
export function pastedLabel(lines: number): string {
  return `Pasted text · ${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`;
}

/** A code fence longer than any run of backticks in `text`, so it stays one block. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The first lines of the paste, each cut short. */
export function previewOf(text: string): string {
  return text
    .replace(/^\s*\n/, '')
    .split('\n', PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line))
    .join('\n')
    .trimEnd();
}

/** The paste in the message, kept as `file`: what it is, its first lines, and the file on a line of its own. */
export function pastedWords(text: string, file: string): string {
  const lines = lineCount(text);
  const head = previewOf(text);
  const fence = fenceFor(head);
  const shown = Math.min(lines, PREVIEW_LINES);
  const intro = lines > shown
    ? `Pasted text (${lines.toLocaleString('en-US')} lines, ${sizeWords(byteSize(text))}), in the file below. Its first ${shown} lines:`
    : `Pasted text (${sizeWords(byteSize(text))}), in the file below. It starts:`;
  return `${intro}\n${fence}text\n${head}\n${fence}\n\`${file}\``;
}

/** The paste in the message as its words (Beluga couldn't keep it as a file). */
export function pastedInline(text: string): string {
  const fence = fenceFor(text);
  return `Pasted text:\n${fence}text\n${text.trimEnd()}\n${fence}`;
}
