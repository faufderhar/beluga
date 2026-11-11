import { BOARD_METRICS, type BoardMetric, type BoardPerson, type BoardRange, type BoardTotals, type LeaderboardView, boardTotals } from '../../../../../src/shared/leaderboard.js';

/**
 * The leaderboard's sums (BLG-904): each person's three numbers over a range, who leads each one
 * and by how much, and points for the podium: up to 100 a number, against whoever did the most.
 */

/** How each number is said: its name, and the words for "bob wrote 2× as much as you". */
export interface BoardWords {
  readonly label: string;
  /** What someone did, as a verb: "wrote", "merged", "kept agents working". */
  readonly verb: string;
  /** "as much as", "as many as", "as long as". */
  readonly as: string;
}

export const BOARD_WORDS: Readonly<Record<BoardMetric, BoardWords>> = {
  chars: { label: 'Prompt characters', verb: 'wrote', as: 'as much as' },
  prs: { label: 'Pull requests merged', verb: 'merged', as: 'as many as' },
  agentMs: { label: 'Agent hours', verb: 'kept agents working', as: 'as long as' },
};

/** Points a number gives at most (the leader's). */
export const POINTS_EACH = 100;

export interface BoardRow {
  readonly person: BoardPerson;
  readonly totals: BoardTotals;
  /** Up to 100 per number, summed. */
  readonly points: number;
  /** Where the points came from: each number's (0–100). */
  readonly parts: BoardTotals;
  /** 1 for the most points (people level share a place). */
  readonly place: number;
  /** Nothing has come from them yet. */
  readonly waiting: boolean;
}

export interface Lane {
  readonly person: BoardPerson;
  readonly value: number;
  /** Of the leader's (0–1). */
  readonly of: number;
  /** Their number against yours ("2.4×"); undefined for you, or when you have none. */
  readonly vsYou?: number;
}

export interface Race {
  readonly metric: BoardMetric;
  readonly lanes: readonly Lane[];
  /** The line above the lanes: who leads and by how much. */
  readonly headline: string;
}

/** "2.4×", "12×", "1.1×". */
export function times(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return `${n >= 10 ? Math.round(n).toLocaleString() : n.toFixed(1).replace(/\.0$/, '')}×`;
}

const nameOf = (p: BoardPerson): string => (p.me ? 'You' : p.name);
const inSentence = (p: BoardPerson): string => (p.me ? 'you' : p.name);

/** Places from points, best first: people level share a place. */
function placed<T extends { readonly points: number }>(rows: readonly T[]): Array<T & { place: number }> {
  const sorted = [...rows].sort((a, b) => b.points - a.points);
  return sorted.map((r) => ({ ...r, place: sorted.findIndex((x) => Math.round(x.points) === Math.round(r.points)) + 1 }));
}

/** Everyone on the board over `range`, with points and places. */
export function boardRows(view: LeaderboardView, range: BoardRange, now: number): BoardRow[] {
  const sums = view.people.map((person) => ({ person, totals: boardTotals(person.days, range, now), waiting: !person.days }));
  const max = Object.fromEntries(BOARD_METRICS.map((m) => [m, Math.max(0, ...sums.map((s) => s.totals[m]))])) as Record<BoardMetric, number>;
  const scored = sums.map((s) => {
    const parts = Object.fromEntries(BOARD_METRICS.map((m) => [m, max[m] ? (s.totals[m] / max[m]) * POINTS_EACH : 0])) as Record<BoardMetric, number>;
    return { ...s, parts, points: parts.chars + parts.prs + parts.agentMs };
  });
  return placed(scored);
}

/** Who leads, in words: "bob wrote 2.4× as much as you", "You lead: 3× mia". */
export function headlineOf(metric: BoardMetric, lanes: readonly Lane[]): string {
  const [first, second] = lanes;
  if (!first || first.value <= 0) return 'Nobody yet in this stretch';
  if (!second || second.value <= 0) return first.person.me ? 'Only you so far' : `Only ${first.person.name} so far`;
  if (first.value === second.value) return `${nameOf(first.person)} and ${inSentence(second.person)} are level`;
  if (first.person.me) return `You lead: ${times(first.value / second.value)} ${second.person.name}`;
  const me = lanes.find((l) => l.person.me);
  if (me && me.value > 0) return `${first.person.name} ${BOARD_WORDS[metric].verb} ${times(first.value / me.value)} ${BOARD_WORDS[metric].as} you`;
  return `${first.person.name} leads: ${times(first.value / second.value)} ${inSentence(second.person)}`;
}

/** One race per number: everyone with something, most first. */
export function racesOf(view: LeaderboardView, range: BoardRange, now: number): Race[] {
  return BOARD_METRICS.map((metric) => {
    const values = view.people.filter((p) => p.days).map((person) => ({ person, value: boardTotals(person.days, range, now)[metric] }));
    const top = Math.max(0, ...values.map((v) => v.value));
    const mine = values.find((v) => v.person.me)?.value ?? 0;
    const lanes = values
      .sort((a, b) => b.value - a.value || (a.person.me ? -1 : b.person.me ? 1 : a.person.name.localeCompare(b.person.name)))
      .map(({ person, value }): Lane => ({ person, value, of: top > 0 ? value / top : 0, ...(!person.me && mine > 0 ? { vsYou: value / mine } : {}) }));
    return { metric, lanes, headline: headlineOf(metric, lanes) };
  });
}

// ---------------------------------------------------------------- many friends

/** Standings rows shown before "Show all". */
export const STANDINGS_SHOWN = 8;
/** Figures under each number before "and N more". */
export const FIGURES_SHOWN = 4;
/** How close two faces on the shared line may be (of its length) before the lower one becomes a dot. */
export const FACE_GAP = 0.12;
/** Faces on the shared line at most (the leader and you among them); the rest are dots. */
export const FACES_SHOWN = 5;

/**
 * Which rows a list shows: the first `limit`, and you after them when you're further down (so you
 * always see where you stand). `hidden`: how many aren't shown; `gap`: you come after a jump.
 */
export function shortList<T extends { readonly person: BoardPerson }>(items: readonly T[], limit: number): { shown: T[]; hidden: number; gap: boolean } {
  if (items.length <= limit) return { shown: [...items], hidden: 0, gap: false };
  const head = items.slice(0, limit - 1);
  const me = items.findIndex((x) => x.person.me);
  const tail = me >= limit - 1 ? items[me]! : items[limit - 1]!;
  return { shown: [...head, tail], hidden: items.length - limit, gap: me > limit - 1 };
}

/**
 * How each one shows on the shared line: a face for the leader, for you, and for the next with room
 * around them (five faces at most); a small dot for the rest, so a crowd never piles up into a heap.
 */
export function markKinds(lanes: readonly Lane[], gap = FACE_GAP, most = FACES_SHOWN): Map<string, 'face' | 'dot'> {
  const out = new Map<string, 'face' | 'dot'>();
  const faces: number[] = [];
  const me = lanes.find((l) => l.person.me);
  const take = (l: Lane): void => {
    out.set(l.person.peerId, 'face');
    faces.push(l.of);
  };
  if (lanes[0]) take(lanes[0]);
  if (me && !out.has(me.person.peerId)) take(me);
  for (const l of lanes) {
    if (out.has(l.person.peerId)) continue;
    if (faces.length < most && faces.every((f) => Math.abs(f - l.of) >= gap)) take(l);
    else out.set(l.person.peerId, 'dot');
  }
  return out;
}

/** Has anyone friends on the board (beside you)? */
export const hasFriends = (view: LeaderboardView): boolean => view.people.some((p) => !p.me);
