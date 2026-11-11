import type { Session } from '../core/session.js';
import { leaderboardView } from '../core/leaderboard/launch.js';
import { statsOf } from '../core/stats/counter.js';
import { saveStatsImage } from '../core/stats/image.js';
import type { Args, Method } from './api.js';

/** What each `stats.*` method does (see stats-api.ts). */

type StatsMethod = Extract<Method, `stats.${string}`>;
type StatsHandlers = { readonly [M in StatsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const STATS_HANDLERS = {
  'stats.get': (s) => statsOf(s).snapshot(),
  'stats.leaderboard': (s) => leaderboardView(s, s.store),
  'stats.note': (s, note) => statsOf(s).note(note),
  'stats.saveImage': (_s, png, to) => saveStatsImage(png, to),
} satisfies StatsHandlers;
