import { useState } from 'react';
import { type AgentRef, CLAUDE_AGENT } from '@beluga/protocol.js';
import type { AppState } from '@beluga/core/store.js';
import { type CardWindow, type FriendRoom, type ProviderCard, friendRooms, providerCards, shortTokens, tokenDetail, tokenTotal, withLocalUsage } from '@beluga/ui/usage-cards.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, IconButton, cx } from '../../components/ui.js';
import { toast, useApi, useBeluga } from '../../lib/beluga.js';
import { Card, Meter } from './parts.js';
import { ago, resetsAt } from './usage-model.js';
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
      <Meter pct={w.pct} label={`${w.label}: ${w.pct}% used`} />
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

/** What runs the agent, by name: Claude Code, Codex, OpenCode, Copilot, Grok Build, or a local model. */
const runtimeName = (runtime: string): string => (runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime === 'opencode' ? 'OpenCode' : runtime === 'copilot' ? 'Copilot' : runtime === 'grok' ? 'Grok Build' : 'Local model');

function ProviderBox({ card, now }: { card: ProviderCard; now: number }) {
  const [details, setDetails] = useState(false);
  return (
    <Card label={`${card.agent.label} usage`}>
      <header className={s.providerHead}>
        <h2 className={s.cardTitle}>
          <span className={s.agentTitle}>
            <Icon name={agentMark(card.agent)} size={13} />
            {card.agent.label}
          </span>
        </h2>
        <span className={s.providerBadges}>
          {card.plan ? <span className={s.planBadge}>{card.plan}</span> : null}
          <DefaultChip card={card} />
        </span>
        <span className={s.providerMore}>
          <IconButton icon="more" label={details ? 'Hide details' : 'Details'} active={details} onClick={() => setDetails(!details)} />
        </span>
      </header>
      {!card.signedIn ? (
        <p className={s.quiet}>Not signed in. Sign in to {card.agent.label} on {thisComputer()} to use it.</p>
      ) : card.shape === 'quota' ? (
        <div className={s.windows}>
          {card.windows.map((w) => (
            <WindowMeter key={w.label} w={w} now={now} />
          ))}
        </div>
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
export function PlanCard({ state, now }: { state: AppState; now: number }) {
  const selfId = state.self?.peerId ?? state.selfId;
  const me = state.peers.find((p) => p.peerId === selfId) ?? state.self;
  // Your setting (unset: Claude) answers at once; the peer card friends see follows it.
  const cards = withLocalUsage(providerCards(me, state.prefs.defaultAgent), {
    projects: state.projects,
    runtimes: state.runtimes,
    defaultRuntime: state.prefs.defaultAgent?.runtime ?? 'claude',
    ...(state.prefs.projectAgents ? { projectAgents: state.prefs.projectAgents } : {}),
  });
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
