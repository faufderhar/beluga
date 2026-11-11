import path from 'node:path';
import { type BoardDays, type BoardPerson, type LeaderboardView, boardDaysOf } from '../../shared/leaderboard.js';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import { maybeStatsOf } from '../stats/counter.js';
import type { Store } from '../store.js';
import { belugaEnv } from '../beluga-env.js';
import { demoCrowd } from './demo.js';
import { meshBoardLinks } from './links.js';
import { Leaderboard } from './service.js';

/**
 * The leaderboard for the daemon (BLG-904), whenever the network is on: your days go to your
 * friends (from your stats, core/stats), theirs come back and are kept, and the Usage tab asks for
 * everyone's with `stats.leaderboard`.
 */

const boards = new WeakMap<object, Leaderboard>();
/** Sessions running the demo (BELUGA_DEMO_SCENE=crowd adds a crowd of made-up friends to the board). */
const demos = new WeakSet<object>();

/** Your days now, from your stats (none before the counter runs). */
function mineOf(session: object): BoardDays | undefined {
  const stats = maybeStatsOf(session)?.snapshot();
  return stats ? boardDaysOf(stats, Date.now()) : undefined;
}

export function launchLeaderboard(host: { readonly session: object; readonly store: Store; readonly demo: boolean }): () => void {
  const { session } = host;
  if (host.demo) demos.add(session);
  let current: Leaderboard | undefined;
  const off = watchNetwork(session, (service) => {
    current?.stop();
    boards.delete(session);
    current = undefined;
    if (!service) return;
    const board = new Leaderboard({ links: meshBoardLinks(service.mesh), mine: () => mineOf(session), file: host.demo ? null : path.join(belugaHome(), 'leaderboard.json') });
    board.start();
    current = board;
    boards.set(session, board);
  });
  return () => {
    off();
    current?.stop();
    boards.delete(session);
  };
}

/** You and each friend with their numbers, for the Usage tab. */
export function leaderboardView(session: object, store: Store): LeaderboardView {
  const board = boards.get(session);
  const { network } = store.getState();
  const self = network.self;
  const me: BoardPerson = { peerId: self?.peerId ?? 'me', name: self?.name ?? 'You', me: true, ...(mineOf(session) ? { days: mineOf(session)! } : {}) };
  if (!board || !network.enabled) return { network: Boolean(board), people: [me] };
  board.keepOnly(new Set(network.friends.map((f) => f.peerId)));
  const friends = network.friends.map((f): BoardPerson => {
    const theirs = board.of(f.peerId);
    const old = !theirs && f.beluga && !f.beluga.can.includes('stats.board');
    return { peerId: f.peerId, name: f.name, online: f.online, ...(theirs ? { days: theirs.days, at: theirs.at } : {}), ...(old ? { old: true as const } : {}) };
  });
  // BELUGA_DEMO_SCENE=crowd: a board with many friends (screenshots of how it holds up).
  const crowd = demos.has(session) && belugaEnv('DEMO_SCENE') === 'crowd' ? demoCrowd(Date.now()) : [];
  return { network: true, people: [me, ...friends, ...crowd] };
}
