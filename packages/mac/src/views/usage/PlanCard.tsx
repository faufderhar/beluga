import { Fragment, useEffect, useState } from 'react';
import { type AgentRef, CLAUDE_AGENT } from '@beluga/protocol.js';
import type { AppState } from '@beluga/core/store.js';
import { type CardWindow, type FriendRoom, type ProviderCard, friendRooms, providerCards, shortTokens, tokenDetail, tokenTotal, windowHeading, withLocalUsage } from '@beluga/ui/usage-cards.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { isFixedRuntime } from '@beluga/shared/agent-runtimes.js';
import type { StatsSnapshot } from '@beluga/shared/stats.js';
import { type AgentWeek, agentWeek } from '@beluga/ui/agent-week.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, IconButton, cx } from '../../components/ui.js';
import { toast, useApi, useBeluga } from '../../lib/beluga.js';
import { Card, Meter } from './parts.js';
import { ago, resetsAt } from './usage-model.js';
import { duration } from './stats-model.js';
import s from './usage.module.css';
import { thisComputer } from '../../lib/os-words.js';

function WindowMeter({ w, now }: { w: CardWindow; now: number }) {
  return (
    <div className={s.window}>
      <div className={s.windowHead}>
        <span className={s.windowTitle}>{w.label}</span>
        <span className={s.windowPct}>
          {w.pct}
          <small>%</small>
        </span>
      </div>
      <Meter pct={w.pct} label={`${[windowHeading(w), w.label].filter(Boolean).join(' ')}: ${w.pct}% used`} />
      <div className={s.windowFoot}>{w.resetsAt && w.resetsAt > now ? `Resets ${resetsAt(w.resetsAt, now)}` : `${100 - w.pct}% left`}</div>
    </div>
  );
}

/** A provider with no plan window: what it used. Speed only when a run actually reported it. */
function TokensFigures({ card }: { card: ProviderCard }) {
  const hideSpeed = Boolean(card.note) && card.tokensPerSec === undefined;
  return (
    <div className={s.windows}>
      <div className={s.window}>
        <div className={s.windowHead}>
          <span className={s.windowTitle}>Tokens</span>
          <span className={s.windowPct}>{card.tokens ? shortTokens(tokenTotal(card.tokens)) : '–'}</span>
        </div>
        <div className={s.windowFoot}>{card.tokens ? tokenDetail(card.tokens) : 'Since Beluga started'}</div>
      </div>
      {hideSpeed ? null : (
        <div className={s.window}>
          <div className={s.windowHead}>
            <span className={s.windowTitle}>Speed</span>
            <span className={s.windowPct}>
              {card.tokensPerSec !== undefined ? Math.round(card.tokensPerSec) : '–'}
              <small> tok/s</small>
            </span>
          </div>
          <div className={s.windowFoot}>Over its last run</div>
        </div>
      )}
    </div>
  );
}

/** "$4.10", "$12". */
const money = (usd: number): string => `$${usd >= 10 ? Math.round(usd) : usd.toFixed(2)}`;

/** "12 runs", "1 run". */
const runsOf = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`;

/**
 * An ACP agent's last 7 days under its quota (Antigravity): each part whole, the row wrapping
 * between parts when the card is narrow; each its own text, so each is translated.
 */
function WeekLine({ week }: { week: AgentWeek }) {
  if (!week.runs) return <p className={s.weekLine}>No runs in the last 7 days</p>;
  const parts = [runsOf(week.runs), duration(week.agentMs), ...(week.tokens ? [`${shortTokens(week.tokens)} tokens`] : []), ...(week.cost > 0 ? [money(week.cost)] : [])];
  return (
    <p className={s.weekLine}>
      <span className={s.weekLabel}>Last 7 days</span>
      {parts.map((p) => (
        <span key={p} className={s.weekPart}>
          {p}
        </span>
      ))}
    </p>
  );
}

/** The last 7 days' agent time, today darker. */
function WeekBars({ days }: { days: readonly number[] }) {
  const top = Math.max(...days, 1);
  return (
    <div className={s.weekBars} role="img" aria-label="Agent time on each of the last 7 days">
      {days.map((ms, i) => (
        <i key={i} className={i === days.length - 1 ? s.weekBarToday : undefined} style={{ height: `${Math.max(6, (ms / top) * 100)}%` }} />
      ))}
    </div>
  );
}

/** An ACP agent without a quota: its week, as figures and bars. */
function WeekFigures({ card, week }: { card: ProviderCard; week: AgentWeek }) {
  if (!week.runs) return <p className={s.quiet}>No runs in the last 7 days. Pick {card.agent.label} in the composer’s agent menu and its numbers show up here.</p>;
  const figure = (title: string, value: string) => (
    <div className={s.weekFigure}>
      <span className={s.windowTitle}>{title}</span>
      <span className={s.weekValue}>{value}</span>
    </div>
  );
  return (
    <>
      <div className={s.weekHead}>Last 7 days</div>
      <div className={s.weekGrid}>
        {figure('Runs', String(week.runs))}
        {figure('Agent time', duration(week.agentMs))}
        {figure('Tokens', week.tokens ? shortTokens(week.tokens) : '–')}
        {week.cost > 0 ? figure('Cost', money(week.cost)) : null}
      </div>
      <WeekBars days={week.days} />
    </>
  );
}

/** The chip on each card: says which one is your default, or makes this one it. */
function DefaultChip({ card }: { card: ProviderCard }) {
  const api = useApi();
  const { client } = useBeluga();
  if (card.isDefault)
    return (
      <span className={cx(s.defaultChip, s.defaultChipOn)}>
        <Icon name="check" size={12} />
        Default
      </span>
    );
  // Claude back as the default is "no default set" (null), like Settings › Agent.
  const agent: AgentRef | null = card.agent.runtime === CLAUDE_AGENT.runtime ? null : { runtime: card.agent.runtime, label: card.agent.label, ...(card.agent.model ? { model: card.agent.model } : {}) };
  const make = () =>
    void api.session.setPrefs({ defaultAgent: agent }).catch((err: unknown) => toast(client, `Couldn’t change your default agent: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
  return (
    <button type="button" className={s.defaultChip} onClick={make} aria-label={`Make ${card.agent.label} your default agent`}>
      Make default
    </button>
  );
}

/** What runs the agent, by name: Claude Code, Codex, OpenCode, Copilot, Grok Build, a local model, or ACP (Antigravity and the ACP agents you added). */
const runtimeName = (runtime: string): string => (runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime === 'opencode' ? 'OpenCode' : runtime === 'copilot' ? 'Copilot' : runtime === 'grok' ? 'Grok Build' : runtime === 'local' ? 'Local model' : 'ACP');

/** Where an ACP agent came from, in the card's details. */
const SOURCE: Readonly<Record<string, string>> = { builtin: 'built-in', registry: 'Registry', local: 'your command' };

function ProviderBox({ card, now }: { card: ProviderCard; now: number }) {
  const [details, setDetails] = useState(false);
  const api = useApi();
  const [source, setSource] = useState<string>();
  // An ACP agent's details say where it came from: asked once they're open.
  useEffect(() => {
    if (!details || isFixedRuntime(card.agent.runtime)) return;
    let live = true;
    void api.acp.agents().then(
      (r) => live && setSource(r.agents.find((a) => a.id === card.agent.runtime)?.source),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [details, card.agent.runtime]);
  return (
    <Card
      label={`${card.agent.label} usage`}
      title={
        <span className={s.agentTitle}>
          <Icon name={agentMark(card.agent)} size={13} />
          <span className={s.agentName} translate="no">
            {card.agent.label}
          </span>
        </span>
      }
      aside={
        <>
          {card.plan ? <span className={s.planBadge}>{card.plan}</span> : null}
          <DefaultChip card={card} />
          <IconButton size="small" icon="more" label={details ? 'Hide details' : 'Details'} active={details} onClick={() => setDetails(!details)} />
        </>
      }
    >
      {!card.signedIn ? (
        <p className={s.quiet}>Not signed in. Sign in to {card.agent.label} on {thisComputer()} to use it.</p>
      ) : card.shape === 'quota' ? (
        <>
          <div className={s.windows}>
            {card.windows.map((w, i) => (
              <Fragment key={`${windowHeading(w) ?? ''}:${w.label}`}>
                {windowHeading(w) && windowHeading(w) !== (i > 0 ? windowHeading(card.windows[i - 1]!) : undefined) ? <div className={s.windowGroup}>{windowHeading(w)}</div> : null}
                <WindowMeter w={w} now={now} />
              </Fragment>
            ))}
          </div>
          {card.week ? <WeekLine week={card.week} /> : null}
        </>
      ) : card.week ? (
        <WeekFigures card={card} week={card.week} />
      ) : card.shape === 'tokens' ? (
        <>
          <TokensFigures card={card} />
          {card.note ? <p className={s.quiet}>{card.note}</p> : null}
        </>
      ) : card.note ? (
        <p className={s.quiet}>{card.note}</p>
      ) : (
        <p className={s.quiet}>{card.agent.label}’s usage shows up here after its next run.</p>
      )}
      {details ? (
        <dl className={s.providerDetails}>
          <dt>Runtime</dt>
          <dd className={s.agentTitle}>
            <Icon name={agentMark(card.agent)} size={11} />
            {runtimeName(card.agent.runtime)}
            {source ? ` · ${SOURCE[source] ?? source}` : ''}
          </dd>
          {card.agent.model ? (
            <>
              <dt>Model</dt>
              <dd>{card.agent.model}</dd>
            </>
          ) : null}
          <dt>Updated</dt>
          <dd>{card.updatedAt ? ago(card.updatedAt, now) : 'not yet'}</dd>
        </dl>
      ) : null}
    </Card>
  );
}

function FriendWindow({ room, w }: { room: FriendRoom; w: CardWindow | undefined }) {
  if (!w) return <span />;
  return (
    <span className={s.friendMeter}>
      <span className={s.friendLabel}>{w.short}</span>
      <Meter pct={w.pct} size="mini" label={`${room.name}’s ${room.agent.label}: ${w.label} ${w.pct}% used`} />
      <span className={s.friendPct}>{w.pct}%</span>
    </span>
  );
}

function Friend({ room }: { room: FriendRoom }) {
  return (
    <li className={s.friend}>
      <span className={s.friendName}>
        <Avatar name={room.name} id={room.peerId} size={18} />
        {room.name}
        <span className={s.friendAgent}>{room.agent.label}</span>
      </span>
      <FriendWindow room={room} w={room.windows[0]} />
      <FriendWindow room={room} w={room.windows[1]} />
    </li>
  );
}

/** Whose agent has room left: every friend's providers that share plan windows. */
function FriendsCard({ rooms }: { rooms: FriendRoom[] }) {
  return (
    <Card label="Friends’ agents" title="Friends">
      <ul className={s.friendList} aria-label="Friends’ agent plan usage">
        {rooms.map((r) => (
          <Friend key={`${r.peerId}:${r.agent.runtime}`} room={r} />
        ))}
      </ul>
    </Card>
  );
}

/**
 * One card per provider you have: Claude's 5-hour and weekly windows, Codex's plan windows, a
 * local model's tokens and speed; each with the chip that makes it your default agent. Friends'
 * plans underneath.
 */
export function PlanCard({ state, now, stats }: { state: AppState; now: number; stats?: StatsSnapshot }) {
  const selfId = state.self?.peerId ?? state.selfId;
  const me = state.peers.find((p) => p.peerId === selfId) ?? state.self;
  // Your setting (unset: Claude) answers at once; the peer card friends see follows it. Only agents ready here have a card.
  // An ACP agent's card has its week from your stats (once they're here).
  const cards = withLocalUsage(
    providerCards(me, state.prefs.defaultAgent, state.runtimes, stats ? (runtime) => agentWeek(stats.days, runtime, now) : undefined),
    {
      projects: state.projects,
      runtimes: state.runtimes,
      defaultRuntime: state.prefs.defaultAgent?.runtime ?? 'claude',
      ...(state.prefs.projectAgents ? { projectAgents: state.prefs.projectAgents } : {}),
    },
  );
  const rooms = friendRooms(state.peers, selfId);
  return (
    <>
      {cards.map((c) => (
        <ProviderBox key={c.key} card={c} now={now} />
      ))}
      {rooms.length ? <FriendsCard rooms={rooms} /> : null}
    </>
  );
}
