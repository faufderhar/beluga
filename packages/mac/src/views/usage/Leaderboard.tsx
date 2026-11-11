import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { BOARD_METRICS, type BoardMetric, type BoardRange, type LeaderboardView } from '@beluga/shared/leaderboard.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, Segmented, cx } from '../../components/ui.js';
import { useApi } from '../../lib/beluga.js';
import { useClock } from '../../lib/window-active.js';
import { PersonAvatar } from '../../network/Avatars.js';
import { openNet } from '../../network/net-sheets.js';
import { BOARD_WORDS, type BoardRow, type BoardWords, FIGURES_SHOWN, type Race, POINTS_EACH, STANDINGS_SHOWN, boardRows, hasFriends, markKinds, racesOf, shortList, times } from './leaderboard-model.js';
import { Card, Chapter } from './parts.js';
import { duration } from './stats-model.js';
import { usePicked } from './use-stats.js';
import { compact } from './usage-model.js';
import s from './leaderboard.module.css';

const REFRESH_MS = 60_000;

/** How each number looks: its icon, colour (leaderboard.module.css: --b-*) and how it's written. */
interface BoardMetricDef extends BoardWords {
  readonly icon: IconName;
  readonly color: string;
  readonly format: (n: number) => string;
}

const BOARD_DEFS: Readonly<Record<BoardMetric, BoardMetricDef>> = {
  chars: { ...BOARD_WORDS.chars, icon: 'pencil', color: 'var(--b-chars)', format: compact },
  prs: { ...BOARD_WORDS.prs, icon: 'merge', color: 'var(--b-prs)', format: (n) => n.toLocaleString() },
  agentMs: { ...BOARD_WORDS.agentMs, icon: 'clock', color: 'var(--b-time)', format: duration },
};

const RANGES: ReadonlyArray<{ value: BoardRange; label: string; hint: string }> = [
  { value: 'week', label: 'Week', hint: 'The last 7 days' },
  { value: 'month', label: 'Month', hint: 'The last 30 days' },
  { value: 'year', label: 'Year', hint: 'The last 52 weeks' },
];

/** Everyone's numbers from the daemon, asked for when the tab opens and every minute while it's open. */
function useLeaderboard(): { view: LeaderboardView | undefined; at: number } {
  const api = useApi();
  const [got, setGot] = useState<{ view: LeaderboardView | undefined; at: number }>(() => ({ view: undefined, at: Date.now() }));
  const load = useCallback(() => {
    api.stats
      .leaderboard()
      .then((v) => setGot({ view: v as LeaderboardView, at: Date.now() }))
      .catch(() => setGot((prev) => ({ view: prev.view ?? { network: false, people: [] }, at: prev.at })));
  }, [api]);
  const tick = useClock(true, REFRESH_MS);
  useEffect(load, [load, tick]);
  return got;
}

/** True a frame after it mounts: bars and marks start at zero and move to where they belong. */
function useGrown(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return grown;
}

const nameOf = (row: { readonly person: { readonly me?: true; readonly name: string } }): string => (row.person.me ? 'You' : row.person.name);

/** "bob wrote 1.8× as much as you", for a figure's ratio. */
function vsWords(def: BoardMetricDef, name: string, vs: number): string {
  return vs >= 1 ? `${name} ${def.verb} ${times(vs)} ${def.as} you` : `You ${def.verb} ${times(1 / vs)} ${def.as} ${name}`;
}

/** One standings row: place, who, their points as a bar split by number, and the points. */
function StandingRow({ r, top, delay, grown }: { r: BoardRow; top: number; delay: number; grown: boolean }) {
  return (
    <li className={cx(s.row, r.person.me && s.rowMe)} aria-label={`${r.place}. ${nameOf(r)}, ${Math.round(r.points)} points`}>
      <span className={cx(s.place, r.place === 1 && s.placeFirst)}>{r.place}</span>
      <span className={s.who}>
        <PersonAvatar name={r.person.name} id={r.person.peerId} size={28} />
        <span className={s.name}>{nameOf(r)}</span>
      </span>
      <span className={s.bar} aria-hidden>
        <span className={s.barFill} style={{ width: `${(r.points / top) * 100}%`, transform: grown ? 'scaleX(1)' : 'scaleX(0)', transitionDelay: `${delay}ms` }}>
          {BOARD_METRICS.map((m) =>
            r.parts[m] > 0 ? <span key={m} className={s.part} style={{ flexGrow: r.parts[m], background: BOARD_DEFS[m].color }} title={`${BOARD_DEFS[m].label}: ${Math.round(r.parts[m])} points`} /> : null,
          )}
        </span>
      </span>
      <span className={s.points}>
        {Math.round(r.points)}
        <span className={s.pointsUnit}> pts</span>
      </span>
    </li>
  );
}

/** "ata, leo and 3 others". */
function someNames(names: readonly string[], most = 3): string {
  if (names.length <= most) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  const rest = names.length - most;
  return `${names.slice(0, most).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/**
 * The standings: a row each, most points first. Each bar is that person's points split by
 * where they came from (one colour a number), against the leader's. With many friends, the first
 * few and you, and Show All for the rest.
 */
function Standings({ rows }: { rows: readonly BoardRow[] }) {
  const grown = useGrown();
  const [all, setAll] = useState(false);
  const scored = rows.filter((r) => !r.waiting);
  const waiting = rows.filter((r) => r.waiting);
  const top = Math.max(1, ...scored.map((r) => r.points));
  const short = shortList(scored, STANDINGS_SHOWN);
  const shown = all ? scored : short.shown;
  const old = waiting.filter((r) => r.person.old).map((r) => r.person.name);
  const coming = waiting.filter((r) => !r.person.old).map((r) => r.person.name);
  return (
    <div className={s.standingsWrap}>
      <ol className={s.standings} aria-label="Standings">
        {shown.map((r, i) => (
          <Fragment key={r.person.peerId}>
            {!all && short.gap && i === shown.length - 1 ? <li className={s.gapRow} aria-hidden /> : null}
            <StandingRow r={r} top={top} delay={Math.min(i, 8) * 60} grown={grown} />
          </Fragment>
        ))}
      </ol>
      {short.hidden || coming.length || old.length ? (
        <div className={s.standingsFoot}>
          {coming.length ? <span className={s.note}>Numbers from {someNames(coming)} come the next time you’re both online.</span> : null}
          {old.length ? <span className={s.note}>{someNames(old)} need{old.length === 1 ? 's' : ''} a newer Beluga to join.</span> : null}
          {short.hidden ? (
            <Button size="small" className={s.more} onClick={() => setAll(!all)}>
              {all ? 'Show Fewer' : `Show All ${scored.length}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the colours in the bars are. */
function Legend() {
  return (
    <p className={s.legend}>
      {BOARD_METRICS.map((m) => (
        <span key={m} className={s.key}>
          <span className={s.swatch} style={{ background: BOARD_DEFS[m].color }} />
          {BOARD_DEFS[m].label}
        </span>
      ))}
      <span className={s.legendNote}>Up to {POINTS_EACH} points each, against whoever did the most</span>
    </p>
  );
}

/**
 * One number, head to head: who leads and by how much, everyone placed on one line from none to
 * the most (the gap between two marks is the difference; with a crowd, faces only where there's
 * room and dots for the rest), then the first few figures and yours.
 */
function Versus({ race }: { race: Race }) {
  const grown = useGrown();
  const def = BOARD_DEFS[race.metric];
  const kinds = useMemo(() => markKinds(race.lanes), [race.lanes]);
  const figures = shortList(race.lanes, FIGURES_SHOWN);
  return (
    <section className={s.versus} aria-label={def.label} style={{ '--b': def.color } as React.CSSProperties}>
      <span className={s.vLabel}>
        <Icon name={def.icon} size={13} />
        {def.label}
      </span>
      <p className={s.vHeadline}>{race.headline}</p>
      <div className={s.line} aria-hidden>
        <span className={s.lineTrack} />
        {[...race.lanes]
          .reverse()
          .sort((x, y) => (kinds.get(x.person.peerId) === 'dot' ? 0 : 1) - (kinds.get(y.person.peerId) === 'dot' ? 0 : 1))
          .map((lane) =>
            kinds.get(lane.person.peerId) === 'dot' ? (
              <span key={lane.person.peerId} className={s.dot} style={{ left: grown ? `${lane.of * 100}%` : '0%' }} title={`${nameOf(lane)}: ${def.format(lane.value)}`} />
            ) : (
              <span key={lane.person.peerId} className={cx(s.mark, lane.person.me && s.markMe)} style={{ left: grown ? `${lane.of * 100}%` : '0%' }} title={`${nameOf(lane)}: ${def.format(lane.value)}`}>
                <PersonAvatar name={lane.person.name} id={lane.person.peerId} size={22} />
              </span>
            ),
          )}
      </div>
      <ol className={s.figures}>
        {figures.shown.map((lane, i) => {
          const vs = lane.vsYou !== undefined && lane.value > 0 ? lane.vsYou : undefined;
          return (
            <Fragment key={lane.person.peerId}>
              {figures.gap && i === figures.shown.length - 1 ? <li className={s.figureGap} aria-hidden /> : null}
              <li className={cx(s.figure, lane.person.me && s.figureMe)}>
                <span className={s.fName}>{nameOf(lane)}</span>
                <span className={s.fValue} role="img" aria-label={`${nameOf(lane)}: ${def.format(lane.value)}`}>
                  {def.format(lane.value)}
                </span>
                <span className={s.fVs} title={vs !== undefined ? vsWords(def, lane.person.name, vs) : undefined}>
                  {vs !== undefined ? times(vs) : ''}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>
      {figures.hidden ? <p className={s.fMore}>and {figures.hidden} more</p> : null}
    </section>
  );
}

/** No friends yet: one line, and the way to add some. */
function NoFriends() {
  return (
    <Card className={s.empty}>
      <p className={s.emptyText}>Add friends to see them in the leaderboard.</p>
      <Button icon="plus" onClick={() => openNet({ kind: 'add_friend' })}>
        Add Friend…
      </Button>
    </Card>
  );
}

/**
 * The leaderboard (BLG-904): you and your friends on prompt characters, merged pull requests and
 * agent hours. Standings by points (up to 100 a number, against whoever did the most), then each
 * number head to head, with how many times more each one did than you. Friends swap these
 * numbers on their own (core/leaderboard); with none, it only says to add some.
 */
export function Leaderboard() {
  const { view, at } = useLeaderboard();
  const [range, setRange] = usePicked<BoardRange>('beluga.board.range', 'week', ['week', 'month', 'year']);
  const friends = Boolean(view && hasFriends(view));
  const rows = useMemo(() => (view && friends ? boardRows(view, range, at) : []), [view, friends, range, at]);
  const races = useMemo(() => (view && friends ? racesOf(view, range, at) : []), [view, friends, range, at]);
  return (
    <Chapter
      title="Leaderboard"
      label="Leaderboard"
      sub={friends ? 'You and your friends. Friends share these three numbers with each other, and nothing about their projects.' : undefined}
      aside={friends ? <Segmented label="Range" value={range} options={RANGES} onChange={setRange} /> : undefined}
    >
      {!view ? (
        <div className={s.wait} aria-hidden />
      ) : !friends ? (
        <NoFriends />
      ) : (
        <Card className={s.board} key={range}>
          <Standings rows={rows} />
          <Legend />
          <div className={s.versusFit}>
            <div className={s.versusRow}>
              {races.map((race) => (
                <Versus key={race.metric} race={race} />
              ))}
            </div>
          </div>
        </Card>
      )}
    </Chapter>
  );
}
