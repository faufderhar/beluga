/**
 * Tasks Claude shows in an answer (BLG-26): `task:BLG-12` in inline code is a small chip, and a
 * fenced `beluga-tasks` block (keys one per line, or a JSON array) is a list of cards. Only keys:
 * the window reads each task from the live board, so what it says stays true. Browser-safe.
 */

export const TASKS_FENCE = 'beluga-tasks';

/** "BLG-12": a project's prefix and a number. */
const KEY = /^[A-Za-z][A-Za-z0-9]{0,11}-\d{1,6}$/;

export const isTaskKey = (text: string): boolean => KEY.test(text.trim());

/** At most this many cards in one block (more is a list for the Tasks view). */
export const MAX_TASK_CARDS = 30;

/**
 * The keys in a `beluga-tasks` block, upper-cased, each once, in order: a JSON array (of keys, or
 * of objects with a "key"), else the first key on each line ("BLG-12", "- task:BLG-12 the login").
 */
export function readTaskKeys(code: string): string[] {
  const found: string[] = [];
  const add = (raw: unknown): void => {
    const k = typeof raw === 'string' ? raw.trim().replace(/^task:\s*/i, '') : '';
    if (isTaskKey(k) && !found.includes(k.toUpperCase()) && found.length < MAX_TASK_CARDS) found.push(k.toUpperCase());
  };
  const text = code.trim();
  if (text.startsWith('[')) {
    try {
      const list: unknown = JSON.parse(text);
      if (Array.isArray(list)) {
        for (const item of list) add(typeof item === 'object' && item ? (item as { key?: unknown }).key : item);
        return found;
      }
    } catch {
      // Not JSON (yet, while it streams): read it as lines.
    }
  }
  for (const line of text.split('\n')) add(/\b[A-Za-z][A-Za-z0-9]{0,11}-\d{1,6}\b/.exec(line)?.[0]);
  return found;
}

/** The link a bare task key in an answer becomes (the window draws it as a small chip). */
export const TASK_LINK_SCHEME = 'beluga-task:';

/**
 * In one line: inline code and links (left as they are), or a bare upper-case key standing on its
 * own (not part of a word, a path, a URL or "task:BLG-12").
 */
const LINE_PIECE = /(`+)[^`]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+|(^|[^\w/:@.#-])([A-Z][A-Z0-9]{0,11}-\d{1,6})(?![\w/-]|\.\w)/g;

/**
 * Markdown with each bare task key the board has ("BLG-72", as Claude often writes it instead of
 * `task:BLG-72`) turned into a task link, so it shows as a chip too. Only exact, upper-case keys
 * the board knows: anything else ("UTF-8", "ISO-8601", a key on someone else's board) stays
 * text. Code blocks, inline code and existing links are left alone.
 */
export function linkTaskKeys(markdown: string, has: (key: string) => boolean, opts: { readonly mentions?: boolean } = {}): string {
  if (!(opts.mentions ? /[A-Za-z]-\d/ : /[A-Z]-\d/).test(markdown)) return markdown;
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      if (fence || fenced) return line;
      // "@BLG-24" first (any case, the @ goes into the chip), then the bare keys around it.
      const said = opts.mentions && line.includes('@') ? line.replace(MENTION_PIECE, (whole, _ticks: string | undefined, lead: string | undefined, key: string | undefined) => {
        const k = key?.toUpperCase();
        return k && has(k) ? `${lead ?? ''}[${k}](${TASK_LINK_SCHEME}${k})` : whole;
      }) : line;
      return said.replace(LINE_PIECE, (whole, _ticks: string | undefined, lead: string | undefined, key: string | undefined) =>
        key && has(key) ? `${lead ?? ''}[${key}](${TASK_LINK_SCHEME}${key})` : whole,
      );
    })
    .join('\n');
}

/** As LINE_PIECE, for "@BLG-24" standing on its own (as MENTIONED: not in an e-mail address). */
const MENTION_PIECE = /(`+)[^`]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+|(^|[\s({"'“])@([A-Za-z][A-Za-z0-9]{0,11}-\d{1,6})(?=$|[\s.,;:!?)\]}"'”])/g;

export type TaskKeyPiece = { readonly text: string } | { readonly key: string };

/**
 * A line of plain words (no Markdown: a chat message as the phone shows it) cut into words and the
 * task keys the board has, read as linkTaskKeys reads them (bare keys and, with `mentions`, "@BLG-24").
 */
export function splitTaskKeys(text: string, has: (key: string) => boolean, opts: { readonly mentions?: boolean } = {}): TaskKeyPiece[] {
  const linked = linkTaskKeys(text, has, opts);
  if (linked === text) return text ? [{ text }] : [];
  const out: TaskKeyPiece[] = [];
  const link = /\[([^\]\n]*)\]\(beluga-task:([^)\s]+)\)/g;
  let last = 0;
  for (const m of linked.matchAll(link)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: linked.slice(last, at) });
    out.push({ key: m[2]! });
    last = at + m[0].length;
  }
  if (last < linked.length) out.push({ text: linked.slice(last) });
  return out;
}

/**
 * Tasks named in a message (BLG-56): "@BLG-24" is a task the way "@mia" is a friend. Typing one
 * suggests tasks by key ("@BLG-2", and the near misses "@BLG24", "@blg-24", "@24") or by a word
 * of the title ("@login"); an exact key is the task even when it wasn't picked from the list.
 */
export interface TaskMention {
  /** "BLG-24". */
  readonly key: string;
  readonly title: string;
  /** Its status (an IssueStatus: 'todo', 'in_progress'…). */
  readonly status: string;
  /** Still to do (not Done or Canceled): ranked ahead of closed ones. */
  readonly open?: boolean;
  /**
   * The project it's in, when that isn't the one you're in ("Ratel"): the "@" list offers it only
   * on a closer match, at the very bottom, and asks before it goes in.
   */
  readonly elsewhere?: string;
}

/** How many tasks the "@" list offers at once. */
export const MAX_TASK_SUGGESTIONS = 6;

/** How many of other projects' tasks it offers, below everything else. */
export const MAX_ELSEWHERE_SUGGESTIONS = 3;

/** "BLG-24" → BLG and 24. */
function partsOf(key: string): { prefix: string; digits: string } {
  const dash = key.lastIndexOf('-');
  return { prefix: key.slice(0, dash).toUpperCase(), digits: key.slice(dash + 1) };
}

/** What a typed "@…" says of a key: "blg-24", "BLG24", "24", "BLG" (undefined: it isn't key-shaped). */
function typedKey(typed: string): { prefix: string; digits: string } | undefined {
  const dash = /^([A-Za-z][A-Za-z0-9]{0,11})-(\d{0,6})$/.exec(typed);
  if (dash) return { prefix: dash[1]!.toUpperCase(), digits: dash[2]! };
  const glued = /^([A-Za-z]{0,12})(\d{0,6})$/.exec(typed);
  return glued && typed ? { prefix: glued[1]!.toUpperCase(), digits: glued[2]! } : undefined;
}

/**
 * How well a task answers what's typed: 0 is the very key, larger is looser (undefined: not at all).
 * `strict` (another project's task): its whole prefix ("RAT-4", "rat12", "RAT"), or four letters
 * of a word of its title, never the first couple of letters.
 */
function rankOf(typed: string, task: TaskMention, strict = false): number | undefined {
  const want = typedKey(typed);
  const have = partsOf(task.key);
  if (strict) {
    if (want?.prefix === have.prefix && (!want.digits || have.digits.startsWith(want.digits))) return want.digits && want.digits === have.digits ? 0 : 2;
    if (typed.replace(/[^\p{L}\p{N}]/gu, '').length < 4) return undefined;
  }
  if (want) {
    const prefixHit = !want.prefix || have.prefix.startsWith(want.prefix);
    if (want.digits && prefixHit) {
      if (have.digits === want.digits) return want.prefix === have.prefix ? 0 : 1;
      if (have.digits.startsWith(want.digits)) return 2;
    } else if (!want.digits && want.prefix.length >= 2 && prefixHit) return 3;
  }
  return titleRank(typed, task.title);
}

/**
 * How well a title answers what's typed: a word of it ("@login", "@dark-mode"), else a piece of
 * three letters or more; never digits alone ("@24" is a key or nothing).
 */
export function titleRank(typed: string, of: string): 4 | 5 | undefined {
  if (typed.length < 2 || /^[\d-]+$/.test(typed)) return undefined;
  const words = typed.toLowerCase().replace(/[-_.]+/g, ' ').trim();
  // The same for the title: "@checkout-events" finds a chat with that very name.
  const title = of.toLowerCase().replace(/[-_.]+/g, ' ');
  if (!words) return undefined;
  if (title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(words)) || title.includes(` ${words}`) || title.startsWith(words)) return 4;
  if (words.length >= 3 && title.includes(words)) return 5;
  return undefined;
}

/**
 * Which tasks come first in the "@" list (BLG-575): Ready ones (to start), then the ones under way
 * (In Progress, In Review…), then the Backlog, then closed ones (Done, Canceled).
 */
function statusOrder(task: TaskMention): number {
  if (task.open === false || task.status === 'done' || task.status === 'canceled') return 3;
  if (task.status === 'todo') return 0;
  if (task.status === 'backlog') return 2;
  return 1;
}

/**
 * The tasks a typed "@…" (without the @) may mean, best first: the very key (and its near misses,
 * "BLG24", "24" → BLG-24), then the rest by status (Ready, under way, Backlog, closed), each of
 * those by how well it matches (keys it starts, "BLG-2" → BLG-21…, then title words) and number.
 */
export function matchTasks(typed: string, tasks: readonly TaskMention[], max = MAX_TASK_SUGGESTIONS, { strict = false }: { readonly strict?: boolean } = {}): TaskMention[] {
  if (!typed) return [];
  const num = (t: TaskMention): number => Number(partsOf(t.key).digits) || 0;
  // 0 the very key, 1 its near misses, 2 everything else (sorted by status first).
  const tier = (rank: number): number => Math.min(rank, 2);
  return tasks
    .flatMap((task) => {
      const rank = rankOf(typed, task, strict);
      return rank === undefined ? [] : [{ task, rank }];
    })
    .sort((a, b) => tier(a.rank) - tier(b.rank) || statusOrder(a.task) - statusOrder(b.task) || a.rank - b.rank || num(a.task) - num(b.task))
    .slice(0, max)
    .map((m) => m.task);
}

/** The task an exact "@BLG-24" names (any case), if there's one. */
export function taskByKey(token: string, tasks: readonly TaskMention[]): TaskMention | undefined {
  if (!isTaskKey(token)) return undefined;
  const k = token.trim().toUpperCase();
  return tasks.find((t) => t.key.toUpperCase() === k);
}

/** "@BLG-24" standing on its own in a prompt (not inside an e-mail address, not already explained). */
const MENTIONED = /(^|[\s({"'“])@([A-Za-z][A-Za-z0-9]{0,11}-\d{1,6})(?=$|[\s.,;:!?)\]}"'”])(?! \(task: )/g;

/**
 * What Claude reads for a message naming tasks: each "@BLG-24" stays as written, followed by what
 * it is ("@BLG-24 (task: Fix the login)"), so Claude knows it's a task on the board. Code blocks
 * are left alone, and so are keys the board doesn't have.
 */
export function explainTaskMentions(prompt: string, find: (key: string) => { readonly title: string } | undefined): string {
  if (!prompt.includes('@')) return prompt;
  let fenced = false;
  return prompt
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(MENTIONED, (whole, lead: string, key: string) => {
        const task = find(key.toUpperCase());
        return task ? `${lead}@${key} (task: ${task.title.replace(/\s+/g, ' ').trim()})` : whole;
      });
    })
    .join('\n');
}
