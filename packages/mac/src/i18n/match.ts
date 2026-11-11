/**
 * Looking text up in a catalog: exact keys first, then templates ("Save {0}" matches "Save notes.md"),
 * with the spaces around the text kept as they were. Pure: no DOM, no storage (tests/i18n.test.ts).
 *
 * Much of what the window shows is put together from parts ("Name: what happened", "A · B · C",
 * "{0} sub-agent{1} at work"), and some of it is someone's words (a task's title, a sentinel's
 * name). So: a template's filled-in parts are looked up in turn, text joined with " · ", ": ", ", "
 * or ending in "(…)" is also read part by part, and of the readings the one with the fewest English
 * words left wins. A short template never wraps someone's plain words ("Merge the fix for #48?"
 * stays as it is rather than coming out half translated).
 */

interface Pattern {
  readonly re: RegExp;
  /** Which placeholder each capture group is, in order ("{1} of {0}" → [1, 0]). */
  readonly slots: readonly number[];
  readonly to: string;
  /** How much fixed text it has: the more, the more specific. */
  readonly weight: number;
  /** It counts something: "{0} jobs", "{0} days" (its first part is a number). */
  readonly counts: boolean;
  /** Its own words are one word ("Merge {0}?", "New {0}"): too few to be sure what fills it. */
  readonly bare: boolean;
  /** Placeholders that are someone's ("{0}’s chats"): a name there may be any word. */
  readonly owners: ReadonlySet<number>;
  /** Captures that are a word's ending ("conversation{1}"): "s", "es" or nothing. */
  readonly endings: ReadonlySet<number>;
  /** Written with {who}: what fills it is a name, kept as it is. */
  readonly named: boolean;
}

export interface Compiled {
  readonly exact: ReadonlyMap<string, string>;
  /** The same, by lower case: "In Review" finds "In review". */
  readonly folded: ReadonlyMap<string, string>;
  /** Templates by the first three characters they start with. */
  readonly byStart: ReadonlyMap<string, Pattern[]>;
  /** Templates that start with a placeholder, by the last three characters they end with. */
  readonly byEnd: ReadonlyMap<string, Pattern[]>;
  /** The rest: short fixed starts and ends, or a placeholder at both ends. */
  readonly loose: readonly Pattern[];
  readonly cache: Map<string, string | null>;
  /** Names people gave things (own.ts): left as they are, alone or filling a template. */
  own: ReadonlySet<string>;
}

const SLOT = /\{(\d+)\}/g;
/** Words too small to tell a template apart on their own ("{0} you"). */
const LITTLE = new Set(['you', 'for', 'the', 'and', 'are', 'was', 'its', 'his', 'her', 'our', 'out', 'off', 'not', 'yet', 'all']);
/** Below this much fixed text a template is short: it never wraps someone's plain words. */
const SHORT = 10;
/** How deep a filled-in part is translated in turn ("Your {0} here" with "2 projects are"). */
const DEPTH = 2;
/** Text longer than this is only looked up whole, never read as templates or parts. */
const LONGEST = 400;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** English words, as people count them (a file name is one). */
const words = (v: string): number => v.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w)).length;
/** English words left in a reading: the fewer, the better. */
const english = (s: string): number => (s.match(/[A-Za-z]{2,}/g) ?? []).length;

export function compile(entries: Readonly<Record<string, string>>): Compiled {
  const exact = new Map<string, string>();
  const folded = new Map<string, string>();
  const byStart = new Map<string, Pattern[]>();
  const byEnd = new Map<string, Pattern[]>();
  const loose: Pattern[] = [];
  const push = (map: Map<string, Pattern[]>, k: string, p: Pattern): void => {
    const list = map.get(k);
    if (list) list.push(p);
    else map.set(k, [p]);
  };
  for (const [rawKey, given] of Object.entries(entries)) {
    if (!given || rawKey.startsWith('//')) continue;
    // "{who} left": someone's name (one word, no digits), beside "{0} left" for "3 days left".
    const named = rawKey.includes('{who}');
    const key = norm(rawKey).replace(/\{who\}/g, '{0}');
    const to = given.replace(/\{who\}/g, '{0}');
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, to);
      const low = key.toLowerCase();
      // Only a label of a few words: a sentence that differs in case is another sentence.
      if (words(key) <= 4 && !folded.has(low)) folded.set(low, to);
      continue;
    }
    const fixed = key.split(SLOT).filter((_, i) => i % 2 === 0);
    const weight = fixed.join('').length;
    const letters = fixed.join('').replace(/[^A-Za-z]/g, '').length;
    // One that starts with a placeholder needs a word of its own ("{0} new"), never just a little one ("{0} you").
    const own = fixed.join(' ').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    const many = (key.match(SLOT) ?? []).length > 1;
    if (!named && (letters < 3 || (key.startsWith('{') && letters < 5 && (LITTLE.has(own) || (/\s/.test(own) && !many))))) continue;
    const slots: number[] = [];
    const endings = new Set<number>();
    let source = '^';
    let last = 0;
    for (const m of key.matchAll(SLOT)) {
      const before = key.slice(last, m.index);
      source += escape(before);
      const nextIsSlot = key.slice(m.index + m[0].length).startsWith('{');
      // Right after a letter it's an ending ("conversation{1}" → "s", "es" or nothing). Two slots
      // side by side ("on {0}{1}"): the first takes all it can, the second is what's left (often nothing).
      // (Or what a sentence adds there: "speak{1}." with " with it".)
      const atEnd = m.index + m[0].length === key.length;
      if (/[A-Za-z]$/.test(before)) endings.add(slots.length);
      source += /[A-Za-z]$/.test(before) ? '([a-z]{0,3}|[\\s,(].*?)' : atEnd ? '(.*)' : nextIsSlot ? '(.+)' : last > 0 && before === '' ? '(.*?)' : '(.+?)';
      slots.push(Number(m[1]));
      last = m.index + m[0].length;
    }
    source += escape(key.slice(last)) + '$';
    const owners = new Set([...key.matchAll(/\{(\d+)\}['’]s\b/g)].map((o) => Number(o[1])));
    const p: Pattern = { re: new RegExp(source, 's'), slots, to, weight, counts: !named && slots.length - endings.size === 1 && (/^\{\d+\} [a-z]+s\b/.test(key) || /^\{\d+\} ?[个台条次天项位张份]/.test(to)), owners, bare: words(fixed.join(' ')) <= 1, named, endings };
    const start = fixed[0] ?? '';
    const end = fixed[fixed.length - 1] ?? '';
    if (start.length >= 3) push(byStart, start.slice(0, 3), p);
    else if (end.length >= 3) push(byEnd, end.slice(-3), p);
    else loose.push(p);
  }
  const sort = (l: Pattern[]): Pattern[] => l.sort((a, b) => b.weight - a.weight);
  for (const l of byStart.values()) sort(l);
  for (const l of byEnd.values()) sort(l);
  sort(loose);
  return { exact, folded, byStart, byEnd, loose, cache: new Map(), own: new Set() };
}

function entry(c: Compiled, text: string): string | undefined {
  if (c.own.has(text)) return undefined;
  // Not one word in lower case: "main" is a branch, not "Main".
  return c.exact.get(text) ?? (/[A-Za-z]{2}/.test(text) && !/^[a-z]+$/.test(text) ? c.folded.get(text.toLowerCase()) : undefined);
}

/** A filled-in part in the catalog's language, or null when it has none (it stays as it is). */
function part(c: Compiled, v: string, depth: number): string | null {
  const core = norm(v);
  if (!core || c.own.has(core)) return null;
  // As written, or as a sentence starts ("The number is " + "conversations in Unread…").
  const hit = entry(c, core);
  if (hit !== undefined) return v.replace(core, hit);
  if (depth >= DEPTH) return null;
  const to = find(c, core, depth + 1) ?? (/^[a-z]/.test(core) && words(core) >= 3 ? find(c, core[0]!.toUpperCase() + core.slice(1), depth + 1) : null);
  return to === null ? null : v.replace(core, to);
}

/** Plain words, the kind a short template must not wrap ("subscriptions", "what changed"). */
const plain = (v: string): boolean => /^[a-z][a-z\s’']*$/.test(v.trim());

/** No space between two Chinese characters: "跟随 {0} 切换" with "你的 Mac" reads "跟随你的 Mac 切换". */
const CJK = /([㐀-鿿　-〿＀-￯“”‘’])[ \t]+(?=[㐀-鿿　-〿＀-￯“”‘’])/g;
const tidy = (s: string): string => s.replace(CJK, '$1');

function fill(c: Compiled, p: Pattern, m: RegExpExecArray, depth: number): string | null {
  if (p.named) {
    const who = (m[1] ?? '').trim();
    return who && !/[\d\s]/.test(who) ? p.to.replace(SLOT, who) : null;
  }
  const values: string[] = [];
  let left = 0;
  for (let i = 0; i < p.slots.length; i++) {
    const v = m[i + 1] ?? '';
    if (p.endings.has(i) && /^[a-z]{0,3}$/.test(v)) {
      values[p.slots[i]!] = v;
      continue;
    }
    const to = part(c, v, depth);
    values[p.slots[i]!] = to ?? v;
    const short = p.weight < SHORT && p.bare;
    // Someone's words that only read as another template ("Read what changed" isn't "Read {0} changed").
    if (to !== null && short && !c.exact.has(norm(v)) && words(v) >= 2 && /(^|\s)[a-z]/.test(v)) return null;
    // "{0} jobs" counts: "Last jobs" is a name, not a number of jobs.
    if (i === 0 && p.counts && p.weight < SHORT && !/\d/.test(v)) return null;
    if (to !== null || !v.trim()) continue;
    if (short) {
      // A short template around someone's words would leave them half translated.
      // Words of a sentence (any in lower case), or one plain word: someone's, not a name.
      if ((words(v) >= 2 && /(^|\s)[a-z]/.test(v)) || (plain(v) && !p.owners.has(p.slots[i]!))) return null;
    }
    if (words(v) >= 3) left += v.length;
  }
  // What stays English: a template that matched much more than it says isn't the right one.
  if (left > p.weight * 4) return null;
  return tidy(p.to.replace(SLOT, (_, n: string) => values[Number(n)] ?? ''));
}

/** The best template reading of the whole text, or null. */
function matchOne(c: Compiled, text: string, depth: number): string | null {
  const hit = entry(c, text);
  if (hit !== undefined) return hit;
  if (text.length < 3 || !/[A-Za-z]/.test(text)) return null;
  let best: string | null = null;
  let bestWeight = -1;
  for (const list of [c.byStart.get(text.slice(0, 3)), c.byEnd.get(text.slice(-3)), c.loose]) {
    for (const p of list ?? []) {
      if (p.weight <= bestWeight) break;
      const m = p.re.exec(text);
      if (!m) continue;
      const to = fill(c, p, m, depth);
      if (to === null) continue;
      if (best === null || english(to) < english(best) || (english(to) === english(best) && p.weight > bestWeight)) {
        best = to;
        bestWeight = p.weight;
      }
      break;
    }
  }
  return best;
}

/** Labels joined with " · " (a title and its key, a line of facts). */
const DOT = /\s*·\s*/;

/** Each part of `text` split by `sep` on its own, joined with `join`; null when none translates. */
function byParts(c: Compiled, text: string, sep: RegExp | string, join: string, depth: number): string | null {
  let any = false;
  const pieces = text.split(sep);
  if (pieces.length > 12) return null;
  const parts = pieces.map((piece) => {
    const to = /[A-Za-z]{2}/.test(piece) ? find(c, piece.trim(), depth + 1) : null;
    if (to === null) return piece.trim();
    any = true;
    return to;
  });
  return any ? parts.join(join).trim() : null;
}

function find(c: Compiled, text: string, depth = 0): string | null {
  if (c.own.has(text)) return null;
  const hit = entry(c, text);
  if (hit !== undefined) return hit;
  // Longer than any sentence of the app's own: someone's text, and too costly to try templates on.
  if (text.length > LONGEST) return null;
  const found: string[] = [];
  const whole = matchOne(c, text, depth);
  if (whole !== null) found.push(whole);
  if (depth < DEPTH) {
    // "Find it → Tell me": steps one after another.
    if (text.includes(' → ')) {
      const to = byParts(c, text, ' → ', ' → ', depth);
      if (to !== null) found.push(to);
    }
    // "Backlog 6": a label and its count.
    const count = /^(.*[^\d\s]) (\d+)$/.exec(text);
    if (count) {
      const head = find(c, count[1]!, depth + 1);
      if (head !== null) found.push(`${head} ${count[2]}`);
    }
    if (DOT.test(text)) {
      const to = byParts(c, text, DOT, ' · ', depth);
      if (to !== null) found.push(to);
    }
    // "Name: what happened": the name as it is, what happened in the catalog's words.
    const colon = text.indexOf(': ');
    if (colon > 0) {
      const rest = text.slice(colon + 2);
      const right = find(c, rest, depth + 1);
      const left = text.slice(0, colon);
      if (right !== null) found.push(`${find(c, left, depth + 1) ?? left}：${right}`);
      // "Failed: what the run said", "Now: chenshizhong": a label, then someone's words as they are.
      const label = right === null ? entry(c, left) : undefined;
      if (label !== undefined && words(left) <= 3) found.push(`${label}：${rest.trim()}`);
    }
    // "In Review, 2": an item and its count, as screen readers hear lists.
    if (text.includes(', ')) {
      const to = byParts(c, text, ', ', '，', depth);
      if (to !== null) found.push(to);
    }
    // "Info (⌥⌘4)": a label and its keys.
    const paren = /^(.*\S) (\([^()]*\))$/.exec(text);
    if (paren) {
      const head = find(c, paren[1]!, depth + 1);
      if (head !== null) found.push(`${head} ${paren[2]}`);
      else {
        // "api (read-only)": a name and what it is.
        const inner = entry(c, paren[2]!.slice(1, -1));
        if (inner !== undefined) found.push(`${paren[1]}（${inner}）`);
      }
    }
  }
  if (!found.length) return null;
  return found.reduce((best, s) => (english(s) < english(best) ? s : best));
}

/** The translation of `text` (its outer spaces kept), or undefined when the catalog has none. */
export function lookup(c: Compiled, text: string): string | undefined {
  const core = norm(text);
  if (!core) return undefined;
  let out = c.cache.get(core);
  if (out === undefined) {
    out = find(c, core);
    if (c.cache.size > 20_000) c.cache.clear();
    c.cache.set(core, out);
  }
  if (out === null) return undefined;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const trail = /\s*$/.exec(text)?.[0] ?? '';
  return lead + out + trail;
}
