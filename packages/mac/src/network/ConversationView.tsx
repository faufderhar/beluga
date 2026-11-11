import { type ReactElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FriendView, GroupView, MessageView } from '@beluga/net/mesh/views.js';
import type { MentionWorld } from '../chat/mentions.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar, Button, Empty, claudeColor, cx, personColor } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { TaskCard } from '../gateway/TaskCard.js';
import { Attention } from '../chat/Attention.js';
import { type TaskView, isFinal, targetLabel } from '@beluga/core/gateway/model.js';
import { type WaitingItem, offlineNote, waitingLabel } from '@beluga/core/chat-people.js';
import { usePrefs } from '../lib/prefs.js';
import { Markdown } from '../chat/Markdown.js';
import { plainText } from '../chat/message-menu.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { ASK_EVENT, NetComposer, type Outgoing, QUOTE_EVENT, useChannelTasks } from './NetComposer.js';
import { MessageFiles } from './ChatFiles.js';
import { ReactButton, ReactionChips, useNetReact } from './Reactions.js';
import r from './reactions.module.css';
import { ChatTabs } from './ChatTabs.js';
import { CallRoom } from '../call/CallRoom.js';
import { NotesBox } from '../call/NotesBox.js';
import { MissedCall } from '../call/MissedCall.js';
import type { CallNotesView, MissedCallView } from '@beluga/shared/calls.js';
import { addBlobs, addPaths } from './attachments.js';
import { type RunPlace, askedLine, authorLabel, channelName, channelWorld, isMain, liveIn, liveLine, runPlaces } from './chat-model.js';
import { conversationOf, dayLabel, keepsFollowing, membersLine, mergeMessages, presenceLine, sameDay, shownState, unreadLine, unreadSince } from './net-model.js';
import { showWaiting, useChatPeople } from './use-chat-people.js';
import { openNet } from './net-sheets.js';
import { errorText, quietly, useNetwork, useSay } from './use-net.js';
import { inApp } from '../lib/boot.js';
import chat from '../chat/chat.module.css';
import { agentBadge, useMyAgent } from '../lib/agent-words.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { PersonButton } from './PersonProfile.js';
import s from './network.module.css';
import { computerTitle, thisComputer, yourComputer } from '../lib/os-words.js';

/** Messages the shared state keeps per conversation; with that many, there may be earlier ones. */
const KEPT = 200;
const PAGE = 100;

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fullTime = (ts: number): string => new Date(ts).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function messageItems(m: MessageView, ctx: { say: (t: string) => void; mark: ActionItem['icon']; resend?: () => void; edit?: () => void; remove?: () => void }): ActionItem[] {
  if (m.status === 'locked') return ctx.remove ? [{ label: 'Delete…', icon: 'trash', danger: true, onSelect: ctx.remove }] : [];
  const copy = (text: string, what: string): void => void copyText(text).then(() => ctx.say(`Copied ${what}`));
  const quote = (): void => void document.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: m.text }));
  return [
    ...(ctx.resend ? [{ label: 'Send Again', icon: 'refresh' as const, onSelect: ctx.resend }] : []),
    ...(m.text.trim()
      ? [
          { label: 'Copy', icon: 'copy' as const, separate: Boolean(ctx.resend), onSelect: () => copy(plainText(m.text), 'the message') },
          { label: 'Copy as Markdown', onSelect: () => copy(m.text, 'as Markdown') },
          { label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: quote },
          {
            label: 'Ask Your Agent About This',
            icon: ctx.mark,
            onSelect: () => {
              quote();
              document.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { kind: 'me' } }));
            },
          },
        ]
      : []),
    ...(ctx.edit ? [{ label: 'Edit', icon: 'pencil' as const, separate: true, onSelect: ctx.edit }] : []),
    ...(ctx.remove ? [{ label: 'Delete…', icon: 'trash' as const, danger: true, separate: !ctx.edit, onSelect: ctx.remove }] : []),
  ];
}

/** Your message's words in place of its bubble: Return saves, Esc puts it back. */
function EditBubble({ m, done }: { m: MessageView; done: () => void }) {
  const { client } = useBeluga();
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const save = (): void => {
    const next = text.trim();
    if (!next || next === m.text.trim()) return done();
    setBusy(true);
    client.api.network['messages.edit'](m.conversation, m.id, next).then(done, (err: unknown) => {
      setBusy(false);
      client.store.dispatch({ type: 'toast', text: `Couldn’t edit it: ${errorText(err)}`, level: 'error' });
    });
  };
  return (
    <div className={cx(s.bubble, s.bubbleMine, s.editBubble)}>
      <textarea
        className={s.editText}
        value={text}
        disabled={busy}
        autoFocus
        aria-label="Edit message"
        rows={Math.min(8, text.split('\n').length)}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            done();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className={s.editHint}>
        <button type="button" onClick={done}>
          Cancel
        </button>
        <button type="button" className={s.editSave} disabled={busy || !text.trim()} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

/** A person's colour as a CSS variable, for their bubble's pastel (the same colour as their avatar and their Claude). */
const tintOf = (peerId: string): React.CSSProperties => ({ ['--person' as string]: personColor(peerId) });

/**
 * One message, as a messaging app (BLG-210): your own words in a bubble of your colour on the right,
 * a friend's in a bubble of theirs on the left (their name above a run, their picture at its end),
 * and a Claude's answer full width under "<owner>'s Claude". `place`: where it sits in its run.
 */
const Message = memo(function Message({ m, place, dm, last, resend, me, nameOf, world, offer }: { m: MessageView; place: RunPlace; dm: boolean; last: boolean; resend: (m: MessageView) => void; me?: { name: string; peerId: string }; nameOf: (peerId: string) => string; world: MentionWorld; offer?: boolean }) {
  const prefs = usePrefs();
  const say = useSay();
  const [editing, setEditing] = useState(false);
  const locked = m.status === 'locked';
  const expired = m.mine && m.status === 'expired';
  const asked = askedLine(m, nameOf, me?.peerId);
  const author = m.mine && me ? me.peerId : m.from;
  const myAgent = useMyAgent();
  // Only your own agent asked: its mark; anyone else's (whose runtime isn't known here): the agent glyph.
  const askedMark = m.ask?.to !== 'all' && m.ask?.to.length === 1 && m.ask.to[0] === me?.peerId ? agentMark(myAgent) : 'claude';
  const deliveryState =
    m.mine && m.status === 'waiting' ? (
      <div className={s.state}>
        <Icon name="clock" size={11} />
        Waiting to be delivered
      </div>
    ) : expired ? (
      <div className={cx(s.state, s.stateExpired)}>
        <Icon name="alert" size={11} />
        Not delivered.
        <button type="button" onClick={() => resend(m)}>
          Send Again
        </button>
      </div>
    ) : null;
  const askedChip = asked ? (
    <div className={s.asked}>
      <Icon name={askedMark} size={11} />
      {asked}
    </div>
  ) : null;
  // Direct messages can be deleted (yours from their Mac too) and your own words edited (BLG-425).
  const editable = dm && m.mine && !m.claude && !m.task && !locked && Boolean(m.text.trim());
  const items = () =>
    messageItems(m, {
      say,
      mark: agentMark(myAgent),
      ...(expired ? { resend: () => resend(m) } : {}),
      ...(editable ? { edit: () => setEditing(true) } : {}),
      ...(dm ? { remove: () => openNet({ kind: 'delete_message', conversation: m.conversation, id: m.id, mine: m.mine }) } : {}),
    });
  const edited = m.edited ? <span title={`Edited ${fullTime(m.edited)}`}>Edited</span> : null;
  // Emoji reactions (BLG-702): the chips under it, and the button a hover shows (on the bubble's top corner, `on`).
  const react = useNetReact(m);
  const chips = <ReactionChips reactions={m.reactions} nameOf={nameOf} mine={m.mine && !m.claude} me={me?.peerId} onReact={react} />;
  const reactButton = (on?: 'start' | 'end') => <ReactButton reactions={m.reactions} me={me?.peerId} onReact={react} {...(on ? { on } : {})} />;
  // Your own words (not your Claude's): your colour, on the right; the time (and Delivered) under the run.
  if (m.mine && !m.claude && !locked)
    return (
      <ActionsContext items={items}>
        <div className={cx(s.row, s.rowMine, r.reactable, !place.first && s.rowCont, m.status === 'waiting' && s.waiting)} data-message={m.id} data-mine="true" style={tintOf(author)}>
          <div className={s.stack} title={fullTime(m.ts)}>
            <div className={r.onMessage}>
              {editing ? (
                <EditBubble m={m} done={() => setEditing(false)} />
              ) : m.text.trim() ? (
                <div className={cx(s.bubble, s.bubbleMine, place.last && s.tailMine)}>
                  <Markdown text={m.text} mentions={world} />
                </div>
              ) : null}
              {m.files?.length ? <MessageFiles files={m.files} conversation={m.conversation} mine /> : null}
              {editing ? null : reactButton('start')}
            </div>
            {chips}
            {askedChip}
            {deliveryState ??
              (place.last || edited ? (
                <div className={s.under}>
                  {[edited, place.last ? time(m.ts) : null, place.last && dm && last && m.status === 'seen' ? 'Seen' : place.last && dm && last && m.status === 'delivered' ? 'Delivered' : null]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i}>
                        {i ? ' · ' : ''}
                        {part}
                      </span>
                    ))}
                </div>
              ) : null)}
          </div>
        </div>
      </ActionsContext>
    );
  // A friend's words: their colour, on the left; their name above the run, their picture at its end.
  if (!m.claude && !locked)
    return (
      <ActionsContext items={items}>
        <div className={cx(s.row, s.rowTheirs, r.reactable, !place.first && s.rowCont, m.status === 'waiting' && s.waiting)} data-message={m.id} style={tintOf(author)}>
          <div className={s.side}>
            {place.last ? (
              <PersonButton peerId={m.from} name={m.name}>
                <Avatar name={m.name} id={m.from} size={28} />
              </PersonButton>
            ) : null}
          </div>
          <div className={s.stack} title={fullTime(m.ts)}>
            {place.first ? (
              <div className={s.runName}>
                <PersonButton peerId={m.from} name={m.name}>
                  <span className={s.runAuthor}>{m.name}</span>
                </PersonButton>
                {prefs.timestamps ? <span className={s.runTime}>{time(m.ts)}</span> : null}
              </div>
            ) : null}
            <div className={r.onMessage}>
              {m.text.trim() ? (
                <div className={cx(s.bubble, s.bubbleTheirs, place.last && s.tailTheirs)}>
                  <Markdown text={m.text} mentions={world} />
                </div>
              ) : null}
              {m.files?.length ? <MessageFiles files={m.files} conversation={m.conversation} mine={false} /> : null}
              {reactButton('end')}
            </div>
            {chips}
            {edited ? <div className={s.under}>{edited}</div> : null}
            {m.via ? <div className={s.under} data-sent-by={m.via.id}>Sent by {m.via.name}</div> : null}
            {askedChip}
          </div>
        </div>
      </ActionsContext>
    );
  // A Claude (yours or a friend's), or a message this Mac can't read: full width, under its name.
  return (
    <ActionsContext items={items}>
      <div className={cx(s.row, s.rowClaude, !locked && r.reactable, !place.first && s.rowCont, m.status === 'waiting' && s.waiting)} data-message={m.id} data-claude={m.claude ? 'true' : undefined}>
        {locked ? null : reactButton()}
        <div className={s.side}>{place.first ? <Avatar name={m.mine && me ? me.name : m.name} id={author} size={28} claude={Boolean(m.claude)} agent={m.claude?.agent} /> : null}</div>
        <div className={s.claudeBody} title={fullTime(m.ts)}>
          {place.first ? (
            <div className={s.runName}>
              <span className={cx(s.runAuthor, m.claude && s.claudeAuthor)} style={m.claude ? { color: claudeColor(author) } : undefined}>
                {authorLabel(m)}
              </span>
              {m.claude && agentBadge(m.claude.agent) ? (
                <span className={chat.agentBadge}>
                  <Icon name={agentMark(m.claude.agent)} size={10} />
                  {agentBadge(m.claude.agent)}
                </span>
              ) : null}
              {m.claude ? <span className={s.claudeTag}>on {m.mine ? yourComputer() : `${m.name}’s computer`}</span> : null}
              {prefs.timestamps ? <span className={s.runTime}>{time(m.ts)}</span> : null}
            </div>
          ) : null}
          {locked ? (
            <div className={s.locked}>
              <Icon name="lock" size={12} />
              Can’t be read on {thisComputer()}
            </div>
          ) : (
            <>
              {m.text.trim() ? <Markdown text={m.text} mentions={world} /> : null}
              {m.files?.length ? <MessageFiles files={m.files} conversation={m.conversation} mine={m.mine} /> : null}
              {chips}
              {askedChip}
              {offer ? <RequestOffer m={m} /> : null}
            </>
          )}
          {deliveryState}
        </div>
      </div>
    </ActionsContext>
  );
});

/**
 * A task between two people's Claudes in the chat (BLG-208), placed as a Claude's message: under
 * "<owner>'s Claude · asked Ata's Mac", full width, with its card (the approval is answered there).
 */
function TaskRow({ task, me }: { task: TaskView; me?: { name: string; peerId: string } }) {
  const sent = task.direction === 'sent';
  const agent = task.by === 'agent';
  const myAgent = useMyAgent();
  const owner = sent ? (me?.peerId ?? 'me') : task.peerId;
  const ownerName = sent ? (me?.name ?? 'You') : task.peerName;
  const label = agent ? (sent ? 'Your agent' : `${task.peerName}’s agent`) : sent ? 'You' : task.peerName;
  const asked = sent ? `asked ${targetLabel(task)}` : `asked ${task.kind === 'ask' ? 'your agent' : yourComputer()}`;
  return (
    <div className={cx(s.row, s.rowClaude)} data-task-row={task.id}>
      <div className={s.side}>
        <Avatar name={ownerName} id={owner} size={28} claude={agent} agent={agent && sent ? myAgent : undefined} />
      </div>
      <div className={s.claudeBody}>
        <div className={s.runName}>
          <span className={cx(s.runAuthor, agent && s.claudeAuthor)} style={agent ? { color: claudeColor(owner) } : undefined}>
            {label}
          </span>
          <span className={s.claudeTag}>{asked}</span>
        </div>
        <TaskCard task={task} inChat />
      </div>
    </div>
  );
}

/** Answers sent as requests before tasks said so themselves (message id → task id): read only. */
const SENT_KEY = 'beluga.chat-requests';
const sentRequests = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

/**
 * A friend's Claude can't touch their Mac from a chat; when what you asked needs it, its answer
 * carries the real thing: a request to their Claude on their Mac (the gateway), which their trust
 * settings let in or they approve. Your Mac sends it at once (BLG-353), and its card follows here;
 * the button is only for one that couldn't go (their Mac didn't take requests then).
 */
function RequestOffer({ m }: { m: MessageView }) {
  const { client } = useBeluga();
  const say = useSay();
  const [sending, setSending] = useState(false);
  const [taskId, setTaskId] = useState<string | undefined>(() => sentRequests()[m.id]);
  const task = useApp((st) => st.gateway.tasks.find((t) => (taskId ? t.id === taskId : t.answer === m.id)));
  const request = m.claude?.request;
  if (!request) return null;
  if (task) return <TaskCard task={task} inChat />;
  if (taskId) return <div className={s.asked}>Sent as a request to {m.name}’s computer</div>;
  const send = (): void => {
    setSending(true);
    void client.api.gateway
      .ask(m.from, request.ask, { ...(request.needs?.length ? { needs: [...request.needs] } : {}), answer: { conversation: m.conversation, id: m.id } })
      .then((t) => setTaskId(t.id))
      .catch((err: unknown) => say(`Couldn’t send it: ${errorText(err)}`))
      .finally(() => setSending(false));
  };
  return (
    <div className={s.requestOffer}>
      <span className={s.requestAsk}>
        <Icon name="send" size={11} />
        {request.ask}
      </span>
      <Button size="small" variant="primary" disabled={sending} onClick={send}>
        {sending ? 'Sending…' : `Ask on ${m.name}’s computer`}
      </Button>
    </div>
  );
}

/**
 * A task between two people's Claudes (BLG-208): both of them see its card here, drawn from their
 * own Mac's task book, so it moves along (sent, waiting for approval, working, the result). Someone
 * else in the channel has no such task: they see the message's words, the request's summary.
 */
function TaskMessage({ id, plain, me }: { id: string; plain: ReactElement; me?: { name: string; peerId: string } }) {
  const task = useApp((st) => st.gateway.tasks.find((t) => t.id === id));
  return task ? <TaskRow task={task} {...(me ? { me } : {})} /> : plain;
}

/**
 * What waits, under the header (BLG-210): "Waiting on you: …" (yours to answer here) and
 * "Waiting on Ata: …" (your requests they haven't taken yet). Each one scrolls to its card.
 */
function WaitingBand({ waiting }: { waiting: readonly WaitingItem[] }) {
  if (!waiting.length) return null;
  return (
    <div className={s.waitBand} role="region" aria-label="Waiting">
      {waiting.slice(0, 4).map((w) => (
        <button key={`${w.target.kind}:${w.target.id}`} type="button" className={cx(s.waitItem, w.on === 'you' && s.waitYou, w.kind === 'secret' && s.waitSecret)} title={waitingLabel(w)} onClick={() => showWaiting(w)}>
          <Icon name={w.on === 'you' ? (w.kind === 'secret' ? 'lock' : 'alert') : 'clock'} size={12} />
          <span>{waitingLabel(w)}</span>
        </button>
      ))}
      {waiting.length > 4 ? <span className={s.waitMore}>+{waiting.length - 4} more</span> : null}
    </div>
  );
}

/** The start of a conversation: who it's with, and that it stays between you. */
function Intro({ friend, group }: { friend?: FriendView; group?: GroupView }) {
  const net = useNetwork();
  if (friend) {
    return (
      <div className={s.intro}>
        <PersonAvatar name={friend.name} id={friend.peerId} state={shownState(friend)} size={64} />
        <div className={s.introName}>{friend.name}</div>
        <div className={s.introLine}>{presenceLine(friend)}</div>
        <div className={s.introPrivacy}>
          <Icon name="lock" size={12} />
          End-to-end encrypted, straight to {friend.name}’s computer
        </div>
      </div>
    );
  }
  if (!group) return null;
  return (
    <div className={s.intro}>
      <GroupAvatar name={group.name} id={group.id} size={64} />
      <div className={s.introName}>{channelName(net, group)}</div>
      <div className={s.introLine}>{isMain(net, group) ? `Your main channel: all your friends, and everyone you add later · ${membersLine(group.members)}` : membersLine(group.members)}</div>
      <div className={s.introPrivacy}>
        <Icon name="lock" size={12} />
        End-to-end encrypted, kept on each member’s computer
      </div>
      <div className={s.introHint}>
        Drop files here to share them straight from {yourComputer()}. Your agent answers only when you ask: type <b>@claude</b> (whichever agent you run), or click <b>Ask: your agent</b> under the message box.
      </div>
      {group.admin && group.active ? (
        <div className={s.introActions}>
          <Button icon="plus" onClick={() => openNet({ kind: 'add_people', groupId: group.id })}>
            Add People…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Keeps the log at the bottom while you're there; leaves it alone while you read further up.
 * Opening a conversation starts at the bottom, and stays there while what's drawn after the first
 * paint (pictures, code, task cards, the log's own height) grows under it. Only scrolling up lets
 * go: what grows under the bottom moves no scroll position, so it never reads as you leaving it.
 */
function useStickToBottom(dep: unknown, key: string) {
  const [log, ref] = useState<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const shown = useRef(key);
  const top = useRef(0);
  const toBottom = (el: HTMLDivElement): void => {
    el.scrollTop = el.scrollHeight;
    top.current = el.scrollTop;
  };
  useLayoutEffect(() => {
    // A new conversation starts at the bottom (reset here, before scrolling, not in a later effect).
    if (shown.current !== key) {
      shown.current = key;
      stick.current = true;
    }
    if (log && stick.current) toBottom(log);
  }, [dep, key, log]);
  useEffect(() => {
    if (!log || typeof ResizeObserver === 'undefined') return;
    const pin = (): void => {
      if (stick.current) toBottom(log);
    };
    const sizes = new ResizeObserver(pin);
    sizes.observe(log);
    for (const child of Array.from(log.children)) sizes.observe(child);
    const added = new MutationObserver((changes) => {
      for (const change of changes) for (const node of Array.from(change.addedNodes)) if (node instanceof Element) sizes.observe(node);
    });
    added.observe(log, { childList: true });
    return () => {
      sizes.disconnect();
      added.disconnect();
    };
  }, [log]);
  const onScroll = (): void => {
    if (!log) return;
    stick.current = keepsFollowing(stick.current, top.current, { top: log.scrollTop, height: log.scrollHeight, client: log.clientHeight });
    top.current = log.scrollTop;
  };
  return { ref, onScroll };
}

/** Claudes answering right now: "bob’s Claude is answering…" with the typing dots. */
function LiveRow({ id, me }: { id: string; me?: string }) {
  const net = useNetwork();
  const myAgent = useMyAgent();
  const [, tick] = useState(0);
  const live = liveIn(net, id);
  // Stale ones drop out by themselves (a Claude that went quiet).
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [live.length]);
  if (!live.length) return null;
  return (
    <div className={s.live} role="status" aria-live="polite">
      <span className={s.liveAvatars}>
        {live.slice(0, 3).map((l) => (
          <Avatar key={`${l.peerId}:${l.for}`} name={l.name} id={l.peerId} size={18} claude agent={l.agent ?? (l.peerId === me ? myAgent : undefined)} />
        ))}
      </span>
      <span>{liveLine(live, me)}</span>
      <span className={s.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** Files dropped anywhere on the conversation go in the message box (Finder files by path; a browser's by bytes). */
function useFileDrop(id: string, enabled: boolean) {
  const { client } = useBeluga();
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!inApp() || !enabled) return;
    let off: (() => void) | undefined;
    let alive = true;
    const inside = (x: number, y: number): boolean => {
      const r = ref.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!r && x / scale >= r.left && x / scale <= r.right && y / scale >= r.top && y / scale <= r.bottom;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'leave') return setOver(false);
        const here = inside(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setOver(false);
          if (here && p.paths.length) void addPaths(client, id, p.paths);
        } else setOver(here);
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [id, enabled]);
  const html = {
    onDragOver: (e: React.DragEvent) => {
      if (inApp() || !enabled || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (inApp() || !enabled) return;
      e.preventDefault();
      setOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) void addBlobs(client, id, files);
    },
  };
  return { ref, over, html };
}

/** A conversation with a friend (`dm:<peerId>`) or a group (`group:<id>`), with the chat tabs above it. */
export function ConversationView({ id }: { id: string }) {
  const net = useNetwork();
  if (!net.enabled) return <Conversation id={id} />;
  return (
    <div className={s.chatArea}>
      <ChatTabs shown={id} />
      {/* Its call (BLG-706): the strip on top and, while someone shares, their screen beside this same chat. */}
      <CallRoom id={id}>
        <Conversation id={id} />
      </CallRoom>
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const { client } = useBeluga();
  const net = useNetwork();
  const target = conversationOf(id);
  const friend = target?.kind === 'dm' ? net.friends.find((f) => f.peerId === target.peerId) : undefined;
  const group = target?.kind === 'group' ? net.groups.find((g) => g.id === target.groupId) : undefined;
  const latest = net.messages[id] ?? [];
  const [earlier, setEarlier] = useState<{ id: string; list: readonly MessageView[]; more: boolean }>({ id, list: [], more: true });
  const older = earlier.id === id ? earlier : { id, list: [], more: true };
  // A message deleted or the chat cleared: earlier pages loaded here may hold it, so they go (BLG-425).
  const count = useRef(latest.length);
  useEffect(() => {
    if (latest.length < count.current && earlier.list.length) setEarlier({ id, list: [], more: true });
    count.current = latest.length;
  }, [latest.length]);
  const messages = useMemo(() => mergeMessages(older.list, latest), [older.list, latest]);
  const more = latest.length >= KEPT && older.more;
  // What was new when you came in, kept from the first look: the count goes to 0 as soon as the
  // daemon sees this conversation shown (BLG-573).
  const unreadNow = friend ? friend.unread : group?.active ? group.unread : 0;
  const [entry, setEntry] = useState({ id, count: unreadNow, upTo: latest.at(-1)?.id });
  if (entry.id !== id) setEntry({ id, count: unreadNow, upTo: latest.at(-1)?.id });
  const unread = useMemo(() => (entry.id === id ? unreadSince(messages, entry.count, entry.upTo) : new Set<string>()), [messages, entry, id]);
  const { ref, onScroll } = useStickToBottom(messages, id);
  const writable = Boolean(friend || group?.active);
  const drop = useFileDrop(id, writable);
  const me = useMemo(() => (net.self ? { peerId: net.self.peerId, name: net.self.name } : undefined), [net.self?.peerId, net.self?.name]);
  // Who's here besides you: the friend, or the channel's members (for the Claude button, @ and the pills).
  const people = useMemo(
    () => (friend ? [{ peerId: friend.peerId, name: friend.name }] : (group?.members.filter((m) => !m.self).map((m) => ({ peerId: m.peerId, name: m.name })) ?? [])),
    [friend?.peerId, friend?.name, group?.members],
  );
  const sharedTasks = useChannelTasks(people);
  const world = useMemo(() => channelWorld(me, people, sharedTasks), [me, people, sharedTasks]);
  // Your Claude, asked here, waits for your OK to ask someone ("Ask Alice's Claude?"), or asked
  // someone whose card is in your DM with them (not in this channel): shown here until it's over.
  const tasks = useApp((st) => st.gateway.tasks);
  const asking = useMemo(() => tasks.filter((t) => t.direction === 'sent' && t.conversation === id && t.chat !== id && !isFinal(t.state)), [tasks, id]);
  const places = useMemo(() => runPlaces(messages), [messages]);
  // Calls' notes (BLG-715) sit in the timeline where each call ended.
  const callNotes = useApp((st) => st.network.callNotes?.[id]);
  const notesBefore = (ts: number, after: number | undefined): readonly CallNotesView[] => (callNotes ?? []).filter((n) => n.endedAt <= ts && (after === undefined || n.endedAt > after));
  // Calls you missed sit where they rang.
  const missedCalls = useApp((st) => st.network.missedCalls?.[id]);
  const missedBefore = (ts: number, after: number | undefined): readonly MissedCallView[] => (missedCalls ?? []).filter((m) => m.at <= ts && (after === undefined || m.at > after));
  const { people: here, waiting } = useChatPeople(id);

  if (!net.enabled) {
    return (
      <Empty
        icon="people"
        title="Talking with friends is off"
        detail="Turn it on to see your friends and groups."
        action={
          <Button variant="primary" onClick={() => void client.api.network.setEnabled(true)}>
            Turn On
          </Button>
        }
      />
    );
  }
  if (!target || (!friend && !group)) {
    return <Empty icon="people" title={target?.kind === 'group' ? 'This channel isn’t here any more' : 'Not a friend any more'} detail={`Its messages stay on ${thisComputer()}, but you can’t write here.`} />;
  }

  const loadEarlier = async (): Promise<void> => {
    const first = messages[0];
    if (!first) return;
    try {
      const page = target.kind === 'dm' ? await quietly(client, client.api.network['dm.history'](target.peerId, { before: first.ts, limit: PAGE })) : await quietly(client, client.api.network['groups.history'](target.groupId, { before: first.ts, limit: PAGE }));
      setEarlier({ id, list: [...page, ...older.list], more: page.length >= PAGE });
    } catch (err) {
      client.store.dispatch({ type: 'toast', text: `Couldn’t load earlier messages: ${errorText(err)}`, level: 'error' });
    }
  };
  const send = (out: Outgoing): Promise<unknown> => client.api.network.post(id, { text: out.text, ...(out.files.length ? { files: [...out.files] } : {}), ...(out.ask ? { ask: out.ask === 'all' ? 'all' : [...out.ask] } : {}) });
  const resend = (m: MessageView): void => void send({ text: m.text, files: m.files ?? [] }).catch(() => undefined);
  const lastMine = [...messages].reverse().find((m) => m.mine)?.id;
  // A friend's Claude answering you can offer to do it on their Mac (RequestOffer).
  const mineIds = new Set(messages.filter((m) => m.mine).map((m) => m.id));
  // A request sent from a friend's Claude's answer (RequestOffer) has its card under that answer:
  // its own message would be the same card again, so it isn't drawn twice.
  const offered = new Set([...Object.values(sentRequests()), ...tasks.filter((t) => t.answer).map((t) => t.id)]);
  const nameOf = (peerId: string): string => net.friends.find((f) => f.peerId === peerId)?.name ?? group?.members.find((m) => m.peerId === peerId)?.name ?? 'someone';
  const title = group ? channelName(net, group) : (friend?.name ?? '');
  const note = offlineNote(here);
  const firstUnread = messages.find((m) => unread.has(m.id))?.id;
  const lastUnread = messages.findLast((m) => unread.has(m.id))?.id;

  return (
    <div ref={drop.ref} className={cx(s.conversation, drop.over && s.dropping)} {...drop.html}>
      <WaitingBand waiting={waiting} />
      <div ref={ref} className={s.log} onScroll={onScroll} role="log" aria-label={friend ? `Conversation with ${friend.name}` : `Channel ${title}`}>
        {more ? (
          <div className={s.earlier}>
            <button type="button" onClick={() => void loadEarlier()}>
              Show Earlier Messages
            </button>
          </div>
        ) : (
          <Intro {...(friend ? { friend } : {})} {...(group ? { group } : {})} />
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.ts, m.ts);
          const place = places[i] ?? { first: true, last: true };
          const plain = <Message m={m} place={place} dm={target.kind === 'dm'} last={m.id === lastMine} resend={resend} nameOf={nameOf} world={world} offer={Boolean(m.claude?.request && !m.mine && mineIds.has(m.claude.for))} {...(me ? { me } : {})} />;
          return (
            <div key={m.id}>
              {notesBefore(m.ts, prev?.ts).map((n) => (
                <NotesBox key={n.id} notes={n} place={group ? `#${title}` : `your chat with ${title}`} />
              ))}
              {missedBefore(m.ts, prev?.ts).map((x) => (
                <MissedCall key={`missed-${x.id}`} missed={x} />
              ))}
              {newDay ? <div className={s.day}>{dayLabel(m.ts)}</div> : null}
              {m.id === firstUnread ? <div className={s.unreadLine}>{unreadLine(unread.size)}</div> : null}
              <div className={cx(unread.has(m.id) && s.unread, m.id === lastUnread && s.unreadEnd)}>{m.task ? offered.has(m.task.id) ? null : <TaskMessage id={m.task.id} plain={plain} {...(me ? { me } : {})} /> : plain}</div>
            </div>
          );
        })}
        {(callNotes ?? [])
          .filter((n) => !messages.length || n.endedAt > messages[messages.length - 1]!.ts)
          .map((n) => (
            <NotesBox key={n.id} notes={n} place={group ? `#${title}` : `your chat with ${title}`} />
          ))}
        {(missedCalls ?? [])
          .filter((x) => !messages.length || x.at > messages[messages.length - 1]!.ts)
          .map((x) => (
            <MissedCall key={`missed-${x.id}`} missed={x} />
          ))}
        {asking.filter((t) => !offered.has(t.id)).map((t) => (
          <TaskRow key={t.id} task={t} {...(me ? { me } : {})} />
        ))}
        <LiveRow id={id} {...(me ? { me: me.peerId } : {})} />
      </div>
      {drop.over ? (
        <div className={s.dropHint} aria-hidden="true">
          <Icon name="clip" size={18} />
          Drop to send to {title}
        </div>
      ) : null}
      {group && !group.active ? (
        <div className={s.closed}>
          <div className={s.closedBox}>
            <Icon name="lock" size={13} />
            <span>You’re no longer in {group.name}. Its messages stay here, read-only.</span>
            <Button size="small" onClick={() => openNet({ kind: 'delete_group', groupId: group.id })}>
              Delete from This {computerTitle()}…
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* What holds up your Claude working here: its tool approvals and questions (BLG-207). */}
          <div data-attention="">
            <Attention channel={id} />
          </div>
          <NetComposer id={id} placeholder={friend ? `Message ${friend.name}` : `Message ${title}`} people={people} send={send} {...(note ? { note } : {})} {...(me ? { me } : {})} {...(group?.admin ? { addPeople: () => openNet({ kind: 'add_people', groupId: group.id }) } : {})} />
        </>
      )}
    </div>
  );
}
