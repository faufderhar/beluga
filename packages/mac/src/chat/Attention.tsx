import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { placeName } from '@beluga/core/notify.js';
import { currentQuestion } from '@beluga/ui/collab-actions.js';
import { isDecisionQid } from '@beluga/core/plans/decisions.js';
import { TRUST_INFO } from '@beluga/core/trust.js';
import { defaultAgentOf } from '@beluga/protocol.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { agentName } from '../lib/agent-words.js';
import { brandText } from '../lib/brand.js';
import { macNoticeTarget, openNoticeTarget } from '../lib/notices.js';
import { sameDeep, sameFields } from '../lib/stable.js';
import { hostToBefriend } from '../network/net-model.js';
import { befriend } from '../network/use-net.js';
import { Markdown } from './Markdown.js';
import { useNow } from './Items.js';
import { approvalsHere, waitingElsewhere } from './waiting-here.js';
import s from './attention.module.css';

/**
 * What needs you right now, just above the box you type in: an approval, Claude's question or
 * plan, someone at the door, a new person to choose a trust level for.
 */
export function Attention({ channel }: { channel?: string } = {}) {
  // People at the door and new people to trust belong to the room; approvals reach you anywhere.
  const inRoom = useApp((st) => st.view.kind === 'room');
  return (
    <div className={s.stack}>
      <Approvals {...(channel ? { channel } : {})} />
      <Question {...(channel ? { channel } : {})} />
      {channel ? null : <Elsewhere />}
      {inRoom ? <Knock /> : null}
      {inRoom ? <BefriendHost /> : null}
      {inRoom ? <TrustPrompt /> : null}
    </div>
  );
}

/**
 * Only what this conversation asked (BLG-966): another chat's approval is answered in that chat
 * (Elsewhere below takes you there). `channel`: in a friends' chat (BLG-207), only what holds up
 * your Claude there; a friend's request is answered on its card in the chat instead.
 */
function Approvals({ channel }: { channel?: string }) {
  const api = useApi();
  const all = useApp((st) => st.approvals);
  const view = useApp((st) => st.view);
  const opens = useOpens();
  const approvals = useMemo(() => (channel ? all.filter((a) => a.channel === channel && !a.task) : approvalsHere(all, channelOf(view), opens)), [all, channel, view, opens]);
  const first = approvals[0];
  const now = useNow(Boolean(first?.askedAt));
  const [showAll, setShowAll] = useState(false);
  if (!first) return null;
  const others = approvals.slice(1);
  const left = first.askedAt && first.timeoutMs ? Math.max(0, first.askedAt + first.timeoutMs - now) : undefined;
  return (
    <div className={`${s.card} ${s.urgent}`} role="alertdialog" aria-label="Approval needed">
      <div className={s.head}>
        <Dot tone="warn" />
        <span className={s.title}>{brandText(first.title)}</span>
        {others.length ? (
          <button type="button" className={s.moreButton} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show less' : `+${others.length} more`}
            <Icon name={showAll ? 'chevronUp' : 'chevronDown'} size={10} />
          </button>
        ) : null}
        {left !== undefined ? <span className={s.countdown}>{Math.ceil(left / 60_000)} min left</span> : null}
      </div>
      {first.detail ? <pre className={`${s.detail} selectable`}>{first.detail}</pre> : null}
      {first.kind === 'secret' ? (
        // A .env file: once, always for this project, or always (Settings › Environment takes it back).
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', first.id)}>
            Allow once
          </Button>
          {first.project ? (
            <Tip label="Your agent reads this project’s .env files without asking. Change it in Settings › Environment.">
              <Button size="small" onClick={() => void api.host.answerApproval('project', first.id)}>Always for {first.project}</Button>
            </Tip>
          ) : null}
          <Tip label="In every project. Change it in Settings › Environment.">
            <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('always', first.id)}>
              Always
            </Button>
          </Tip>
          <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', first.id)}>
            Don’t allow
          </Button>
        </div>
      ) : first.kind === 'chain' ? (
        // Agents hit a limit on messages to each other: go on with a new budget, or stop the chain.
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', first.id)}>
            Continue
          </Button>
          <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', first.id)}>
            Stop
          </Button>
        </div>
      ) : first.once ? (
        // A friend's request for a secret: asked each time, so there's no Always.
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', first.id)}>
            Allow once
          </Button>
          <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', first.id)}>
            Decline
          </Button>
        </div>
      ) : (
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', first.id)}>
            Allow
          </Button>
          <Button size="small" onClick={() => void api.host.answerApproval('always', first.id)}>Always allow</Button>
          <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', first.id)}>
            Deny
          </Button>
        </div>
      )}
      {showAll && others.length ? (
        <ul className={s.others} aria-label="Also waiting for you">
          {others.map((a) => (
            <li key={a.id} className={s.other}>
              <span className={s.otherText}>
                <span className={s.otherTitle}>{brandText(a.title)}</span>
                {a.detail ? <code className={s.otherDetail}>{a.detail}</code> : null}
              </span>
              <Button size="small" onClick={() => void api.host.answerApproval('yes', a.id)}>
                {a.kind === 'chain' ? 'Continue' : 'Allow'}
              </Button>
              <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', a.id)}>
                {a.kind === 'chain' ? 'Stop' : 'Deny'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Question({ channel }: { channel?: string }) {
  const actions = useActions();
  const { ui } = useBeluga();
  // Only the question shown and who asked, so other events don't draw the card again.
  const { q, owner, agent, selfId, builds } = useApp((st) => {
    const here = channel ?? channelOf(st.view);
    const q = st.questions.find((x) => x.channel === here);
    const peer = q ? st.peers.find((p) => p.peerId === q.owner) : undefined;
    // Picked in the mode menu (BLG-982): another agent builds it once you approve.
    const builder = q?.question.kind === 'plan' ? st.buildWith[q.channel] : undefined;
    // Your own conversation's question is asked by the agent at work there (Antigravity's ask_question), not by your default one.
    const working = q && here?.startsWith('ws:') && (!peer || q.owner === st.selfId) ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === here.slice(3))?.agent : undefined;
    return { q, owner: peer?.name, agent: agentName(working ?? (peer ? defaultAgentOf(peer) : defaultAgentOf(st.self))), selfId: st.selfId, builds: builder ? agentName(builder) : undefined };
  }, sameFields);
  // Read in full: the card grows up over the chat, the plan from its first line (no sheet on top of it).
  const full = useUi((u) => Boolean(q && u.planFull === q.qid));
  const planRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (planRef.current) planRef.current.scrollTop = 0;
  }, [full, q?.qid]);
  // Read in full only when there is more to read: a plan that fits the card has nothing to expand (#607).
  const planText = q?.question.kind === 'plan' ? q.question.plan : undefined;
  const tall = useOverflows(planRef, planText, full);
  if (!q) return null;
  if (q.question.kind === 'plan') {
    return (
      <div className={cx(s.card, full && s.cardFull)}>
        <div className={s.head}>
          <Icon name="wand" size={13} className={s.claude} />
          <span className={s.title}>{owner && q.owner !== selfId ? `${owner}'s ${agent}` : agent} has a plan</span>
          {tall || full ? (
            <Button size="small" variant="quiet" icon={full ? 'chevronDown' : 'chevronUp'} aria-expanded={full} onClick={() => ui.patch({ planFull: full ? undefined : q.qid })}>
              {full ? 'Show less' : 'Read in full'}
            </Button>
          ) : null}
        </div>
        <div ref={planRef} className={cx(s.plan, full && s.planFull, 'selectable')} role="region" aria-label="The plan">
          <Markdown text={q.question.plan} />
        </div>
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'approve' })}>
            Approve plan
          </Button>
          <span className={s.hint}>{builds ? `then ${builds} builds it, or type what to change below` : 'or type what to change below'}</span>
        </div>
      </div>
    );
  }
  const current = currentQuestion(q);
  if (!current) return null;
  const chosen = new Set((q.picked[`${current.question}#multi`] ?? '').split('\u0000').filter(Boolean));
  const total = q.question.questions.length;
  const index = q.question.questions.indexOf(current);
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="claude" size={13} className={s.claude} />
        <span className={s.title}>{current.header || `${agent} asks`}</span>
        {total > 1 ? <span className={s.more}>{index + 1} of {total}</span> : null}
        {/* A decision of yours in a plan waits until you answer it (core/plans/decisions.ts). */}
        {isDecisionQid(q.qid) ? null : (
          <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'skip' })}>
            Skip
          </Button>
        )}
      </div>
      <div className={`${s.question} selectable`}>
        <Markdown text={current.question} />
      </div>
      <div className={s.options}>
        {current.options.map((o, i) => (
          <button key={o.label} type="button" className={`${s.option} ${chosen.has(o.label) ? s.optionOn : ''}`} onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'option', label: o.label, question: current.question })}>
            <span className={s.optionKey}>{i + 1}</span>
            <span className={s.optionText}>
              <span className={s.optionLabel}>{o.label}</span>
              {o.description ? <span className={s.optionDesc}>{o.description}</span> : null}
            </span>
            {current.multiSelect ? <Icon name={chosen.has(o.label) ? 'check' : 'plus'} size={12} /> : null}
          </button>
        ))}
      </div>
      {current.multiSelect ? (
        <div className={s.actions}>
          <Button size="small" variant="primary" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'done', question: current.question })}>
            Done
          </Button>
        </div>
      ) : (
        <div className={s.hint}>Pick one, or type your own answer below.</div>
      )}
    </div>
  );
}

/** Whether a conversation can be opened in this window (one that can't is answered wherever you are). */
/**
 * The collapsed plan is taller than the card shows (it scrolls): measured while collapsed, again
 * when the plan or the card's width changes. While read in full it keeps what it found.
 */
function useOverflows(ref: React.RefObject<HTMLElement | null>, text: string | undefined, full: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const measure = (): void => setTall(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    if (el.firstElementChild) watch.observe(el.firstElementChild);
    return () => watch.disconnect();
  }, [ref, text, full]);
  return tall;
}

function useOpens(): (channel: string) => boolean {
  const places = useApp((st) => ({ projects: st.projects, shared: st.shared, network: st.network, plans: st.plans, board: st.board, prefs: st.prefs }), sameFields);
  return useMemo(() => (channel: string) => Boolean(macNoticeTarget(places, channel)), [places]);
}

/**
 * Another chat waits for you (an approval, a question, a plan): one line that names it and takes
 * you there, where you answer it. Never its Allow / Deny here, in a conversation it isn't about.
 */
function Elsewhere() {
  const { client } = useBeluga();
  const actions = useActions();
  const opens = useOpens();
  const { first, place, more } = useApp((st) => {
    const chats = waitingElsewhere(st.approvals, st.questions, channelOf(st.view), opens);
    const first = chats[0];
    return { first, place: first ? placeName(st, first) : undefined, more: Math.max(0, chats.length - 1) };
  }, sameFields);
  if (!first || !place) return null;
  const open = (): void => {
    const st = client.store.getState();
    const target = macNoticeTarget(st, first);
    if (target) openNoticeTarget(actions, target, (id) => client.store.dispatch({ type: 'view', view: { kind: 'conversation', id } }));
  };
  // The place as it's named ("webhook-retries", "your chat with Mia"): never capitalized, so it isn't first.
  return (
    <div className={s.elsewhere} role="status" data-testid="waiting-elsewhere">
      <Dot tone="warn" />
      <span className={s.elsewhereText}>
        Waiting for you in <strong>{place}</strong>
        {more ? ` and ${more} other ${more === 1 ? 'chat' : 'chats'}` : ''}
      </span>
      <Button size="small" onClick={open}>
        Open Chat
      </Button>
    </div>
  );
}

function Knock() {
  const actions = useActions();
  const { knock, who, link } = useApp((st) => {
    const knock = st.knocks.find((k) => st.peers.some((p) => p.peerId === k.peerId));
    if (!knock) return { knock, who: undefined, link: undefined };
    return { knock, who: st.peers.find((p) => p.peerId === knock.peerId)?.name ?? 'Someone', link: st.links.find((l) => l.id === knock.linkId) };
  }, sameFields);
  if (!knock) return null;
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="person" size={13} />
        <span className={s.title}>
          {who} wants to join {link ? link.label : 'the room'}
        </span>
      </div>
      <div className={s.actions}>
        <Button size="small" variant="primary" onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'in' })}>
          Let in
        </Button>
        <Button size="small" onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'watch' })}>Let in to watch</Button>
        <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'decline' })}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/** Hosts you said Not Now to ("Add kay as a friend?"), remembered on this Mac. */
const BEFRIEND_KEY = 'beluga.befriend.notNow';
const notNow = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(BEFRIEND_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

/**
 * You joined someone's room with an old room link: rooms fold into friends (BLG-202), so their
 * host is offered as a friend, once. The room itself works as before.
 */
function BefriendHost() {
  const { client } = useBeluga();
  const [dismissed, setDismissed] = useState(notNow);
  const host = useApp((st) => hostToBefriend({ peers: st.peers, selfId: st.self?.peerId, friends: st.network.friends, ...(st.network.offers ? { offers: st.network.offers } : {}), dismissed }), sameDeep);
  if (!host) return null;
  const later = (): void => {
    const next = new Set([...dismissed, host.peerId]);
    localStorage.setItem(BEFRIEND_KEY, JSON.stringify([...next].slice(-200)));
    setDismissed(next);
  };
  return (
    <div className={s.card} role="group" aria-label={`Add ${host.name} as a friend`}>
      <div className={s.head}>
        <Icon name="person" size={13} />
        <span className={s.title}>Add {host.name} as a friend?</span>
      </div>
      <div className={s.actions}>
        <Button size="small" variant="primary" onClick={() => void befriend(client, host.peerId, host.name)}>
          Add as Friend
        </Button>
        <Button size="small" variant="quiet" onClick={later}>
          Not Now
        </Button>
      </div>
    </div>
  );
}

function TrustPrompt() {
  const actions = useActions();
  const { peerId, who } = useApp((st) => {
    const peerId = st.trustPrompts.find((id) => st.peers.some((p) => p.peerId === id));
    return { peerId, who: peerId ? (st.peers.find((p) => p.peerId === peerId)?.name ?? 'Someone') : undefined };
  }, sameFields);
  if (!peerId) return null;
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="lock" size={13} />
        <span className={s.title}>How much do you trust {who}?</span>
        <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'trust_later', peerId })}>
          Later
        </Button>
      </div>
      <div className={s.trustRow}>
        {(['ask', 'trusted', 'full', 'blocked'] as const).map((level) => (
          <Tip key={level} label={TRUST_INFO[level].detail}>
            <button type="button" className={s.trust} onClick={() => actions.run({ type: 'trust', peerId, level })}>
              <span className={s.optionLabel}>{TRUST_INFO[level].label}</span>
            </button>
          </Tip>
        ))}
      </div>
    </div>
  );
}
