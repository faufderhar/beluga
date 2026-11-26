import { Masker } from './mask.js';

/**
 * A failure's words as they may leave this computer, at every level (BLG-1029): its first line, cut
 * short, with what could be someone's content or a secret taken out. What stays is the sentence
 * Beluga or the runtime wrote ("There's no milestone … in the approved plan"), so failures can be
 * told apart; what goes is anything quoted (titles, names, what was typed), paths, links, emails,
 * task keys, ids, long numbers and keys by their shapes. Over-stripping is fine; under-stripping isn't.
 * Pure and synchronous; every pattern is linear on a short input.
 */

/** At most this many characters of a failure leave (after stripping). */
export const ERROR_TEXT_MAX = 160;
/** Only the start of a failure is read: what it is shows in its first line. */
const READ_MAX = 2_000;
const GAP = '…';

/** Keys by shape, URL passwords, emails, home folders (no saved values: none are known here). */
const shapes = new Masker();

/** Text in quotes of any kind: a title, a name, what someone typed. */
const QUOTED = /“[^”\n]{0,400}”|‘[^’\n]{0,400}’|"[^"\n]{0,400}"|`[^`\n]{0,400}`|'[^'\s][^'\n]{0,398}'(?=[\s.,:;)\]]|$)/g;
const URL = /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S{1,2000}/gi;
/** A path: two or more segments, or one from a root or home (`/x`, `~/x`, `C:\x`). */
const PATH = /(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/:"'`,;()]{1,200}){2,}[\\/]?|(?:^|(?<=\s))(?:~|\.{1,2})?[\\/][^\s\\/:"'`,;()]{1,200}/g;
/** A board task's key ("BLG-12"): a person's work, by name. */
const TASK_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
/** Ids and hashes: hex or base64-looking runs, uuids. */
const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{16,200}\b/gi;
const LONG_NUMBER = /\b\d{7,}\b/g;

/** A failed call's or run's words, safe to send (undefined: nothing left worth sending). */
export function safeErrorText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = validationLine(text) ?? firstLine(text.slice(0, READ_MAX));
  const stripped = shapes
    .mask(line)
    .replace(URL, '<url>')
    .replace(QUOTED, GAP)
    .replace(PATH, '<path>')
    .replace(TASK_KEY, '<task>')
    .replace(ID, '<id>')
    .replace(LONG_NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped === GAP) return undefined;
  return stripped.length > ERROR_TEXT_MAX ? `${stripped.slice(0, ERROR_TEXT_MAX - 1).trimEnd()}${GAP}` : stripped;
}

const firstLine = (text: string): string => text.trim().split('\n').find((l) => l.trim())?.trim() ?? '';

/**
 * An MCP input validation error (`MCP error -32602: Input validation error: Invalid arguments for
 * tool plan_gate: [{…zod issues…}]`) as one line naming each bad field and why, never its value.
 */
function validationLine(text: string): string | undefined {
  const at = text.indexOf('Invalid arguments for tool ');
  if (at < 0) return undefined;
  const head = /^Invalid arguments for tool ([\w-]{1,80}):?\s*/.exec(text.slice(at));
  const tool = head?.[1];
  if (!tool) return undefined;
  const rest = text.slice(at + head[0].length, at + head[0].length + READ_MAX * 4);
  // The MCP SDK's own words: one issue a line, "Too big: expected string to have <=8000 characters at notes".
  if (!rest.startsWith('[')) {
    const issues = rest.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
    return `Invalid arguments for tool ${tool}${issues.length ? `: ${issues.join('; ')}` : ''}`;
  }
  const body = rest;
  let issues: ReadonlyArray<{ readonly path?: unknown; readonly code?: unknown }>;
  try {
    const parsed = JSON.parse(body) as unknown;
    issues = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Cut short: each issue's path and code, as they come.
    const paths = [...body.matchAll(/"path":\s*\[([^\]]{0,200})\]/g)].map((m) => m[1]!.split(',').map((p) => p.trim().replace(/^"|"$/g, '')).filter(Boolean));
    const codes = [...body.matchAll(/"code":\s*"([a-z_]{1,40})"/g)].map((m) => m[1]);
    issues = paths.map((path, i) => ({ path, code: codes[i] }));
  }
  const said = issues
    .slice(0, 4)
    .map((i) => `${Array.isArray(i.path) && i.path.length ? i.path.map(String).join('.') : '(arguments)'}: ${typeof i.code === 'string' ? i.code : 'invalid'}`)
    .join('; ');
  return `Invalid arguments for tool ${tool}${said ? `: ${said}` : ''}`;
}
