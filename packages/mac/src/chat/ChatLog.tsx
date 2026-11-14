import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { asChatRow } from '../lib/said.js';
import type { LogItem } from '@beluga/core/store.js';
import { type TaskView, tasksIn } from '@beluga/core/gateway/model.js';
import { LogTaskCard } from '../gateway/TaskCard.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Empty, Working, cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { agentName, useMyAgent } from '../lib/agent-words.js';
import { keepSameLists, sameItems } from '../lib/stable.js';
import { FindBar } from './FindBar.js';
import { AgentCard, ChatRow, ShellCard, SystemRow } from './Items.js';
import { CompactDivider } from './CompactDivider.js';
import { isCompactItem } from './context-model.js';
import { MergedDivider, ShippedDivider } from './ShippedDivider.js';
import { isMergedItem, isShippedItem, withoutDoubleMerge } from './merged-model.js';
import { DialogueCard, isDialogueItem } from './DialogueCard.js';
import { useClaudeStarting } from './flight.js';
import { lastMineIn } from './starting-model.js';
import { withLiveTails } from './live-tail.js';
import { JUMP_LOST_TEXT, JUMP_MARK_MS, JUMP_TTL_MS, chatJumpState } from '@beluga/ui/chat-jump.js';
import { asSent, steeredMessages } from '@beluga/shared/claude-notices.js';
import { inYourQueue } from '@beluga/ui/compose.js';
import { type ThreadStart, threadStarts } from '../threads/threads-model.js';
import { StartedByLine, ThreadStartLine } from '../threads/ThreadLines.js';
import { sameDeep } from '../lib/stable.js';
import s from './chat.module.css';
import f from './flight.module.css';

const GROUP_GAP_MS = 3 * 60_000;

/** A task your Claude sent from this conversation (to another person's Claude), drawn where it was asked. */
type TaskRow = { readonly type: 'task'; readonly id: string; readonly ts: number; readonly task: TaskView };
/** A thread this conversation started, drawn when it started. */
type ThreadRow = { readonly type: 'thread_start'; readonly id: string; readonly ts: number; readonly thread: ThreadStart };
type Row = LogItem | TaskRow | ThreadRow;

/**
 * Tasks your Claude sent during one of its turns belong to that turn: drawn inside its card,
 * after its steps and before its answer (you asked → their Claude worked → your Claude's answer,
 * last). Others (sent by you, or outside a turn) are rows of their own, in time order.
 */
export function placeTasks(items: readonly LogItem[], tasks: readonly TaskView[]): { rows: readonly Row[]; inTurn: ReadonlyMap<string, readonly TaskView[]> } {
  const inTurn = new Map<string, TaskView[]>();
  if (!tasks.length) return { rows: items, inTurn };
  const loose: TaskView[] = [];
  const turns = items.filter((l): l is Extract<LogItem, { type: 'agent' }> => l.type === 'agent');
  for (const task of tasks) {
    const turn = task.by === 'agent' ? turns.filter((t) => t.ts <= task.createdAt && (t.endTs === undefined || t.endTs >= task.createdAt)).at(-1) : undefined;
    if (turn) inTurn.set(turn.id, [...(inTurn.get(turn.id) ?? []), task]);
    else loose.push(task);
  }
  return { rows: withTasks(items, loose), inTurn };
}

function withTasks(items: readonly LogItem[], tasks: readonly TaskView[]): readonly Row[] {
  if (!tasks.length) return items;
  const rows: Row[] = [...items];
  for (const task of tasks) {
    const at = rows.findIndex((r) => r.ts > task.createdAt);
    rows.splice(at < 0 ? rows.length : at, 0, { type: 'task', id: `task:${task.id}`, ts: task.createdAt, task });
  }
  return rows;
}

function withThreadStarts(items: readonly Row[], starts: readonly ThreadStart[]): readonly Row[] {
  if (!starts.length) return items;
  const rows: Row[] = [...items];
  for (const thread of starts) {
    const at = rows.findIndex((r) => r.ts > thread.ts);
    rows.splice(at < 0 ? rows.length : at, 0, { type: 'thread_start', id: `thread:${thread.id}`, ts: thread.ts, thread });
  }
  return rows;
}

/** A shared workspace's earlier message (a system line) as the chat row it's drawn as: the same row each time, so its memo holds. */
const chatRows = new WeakMap<LogItem, LogItem>();
function chatRowOf(item: LogItem): LogItem {
  if (item.type !== 'system' || !item.said) return item;
  let row = chatRows.get(item);
  if (!row) chatRows.set(item, (row = asChatRow(item)));
  return row;
}

/** The newest Claude card of a conversation's items. */
export function latestCard(items: readonly LogItem[]): string | undefined {
  return items.findLast((l) => l.type === 'agent')?.id;
}

/**
 * A conversation: virtualized (a long one stays fast), anchored to the bottom while you're at
 * the bottom, and left alone while you read further up (with a way back down).
 */
/** Near the top of the list: time to bring the page before it. */
const EARLIER_PX = 400;

/**
 * A friend's worktree shared with you: its whole conversation comes a page at a time as you
 * scroll back (BLG-259). Near the top, the page before it is asked for; when it lands above,
 * the list stays where you were reading instead of jumping.
 */
function useEarlier(channel: string, parent: React.RefObject<HTMLDivElement | null>, firstId: string | undefined) {
  const api = useApi();
  const ws = useApp((st) => (channel.startsWith('ws:') ? st.shared.find((w) => w.id === channel.slice(3) && w.via === 'mesh') : undefined));
  const asking = useRef<{ height: number; top: number; at: number } | undefined>(undefined);
  const more = Boolean(ws?.earlier);
  const ask = (): void => {
    const el = parent.current;
    if (!ws || !more || !el || el.scrollTop > EARLIER_PX) return;
    if (asking.current && Date.now() - asking.current.at < 5000) return;
    asking.current = { height: el.scrollHeight, top: el.scrollTop, at: Date.now() };
    void api.sharing.earlier(ws.owner, ws.id).catch(() => undefined);
  };
  // The page landed above: keep what you were reading in the same place.
  useLayoutEffect(() => {
    const el = parent.current;
    const was = asking.current;
    if (!el || !was) return;
    asking.current = undefined;
    el.scrollTop = el.scrollHeight - was.height + was.top;
  }, [firstId]);
  // A short conversation doesn't scroll: bring the next page while the top is in sight.
  useEffect(ask, [more, firstId]);
  return ask;
}

interface ChatLogProps {
  readonly channel: string;
  readonly empty?: React.ReactNode;
  /** What you said here that Beluga's daemon hasn't drawn yet (a worktree being made): shown at once, after its items. */
  readonly ahead?: readonly LogItem[];
  /** "Claude is starting…" under the last row whatever was sent from here (its agent starts once the worktree is made). */
  readonly starting?: boolean;
}

export function ChatLog({ channel, empty, ahead, starting: startingHere = false }: ChatLogProps) {
  // Only this conversation's items and tasks: another one streaming doesn't draw this one again (KLD-48).
  const logged = useApp((st) => st.log.filter((l) => l.channel === channel), sameItems);
  const mine = useMemo(() => (ahead?.length ? [...logged, ...ahead] : logged), [logged, ahead]);
  const selfId = useApp((st) => st.selfId);
  // The agent this conversation runs on: a worktree's own pick, else yours.
  const myAgent = useMyAgent();
  const ownAgent = useApp(
    (st) => (channel.startsWith('ws:') ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(3))?.agent : undefined),
    (a, b) => a?.runtime === b?.runtime && a?.label === b?.label,
  );
  const agentRef = ownAgent ?? myAgent;
  const agent = agentName(agentRef);
  // A shared workspace's earlier messages arrive as system lines; drawn here as normal messages.
  const items = useMemo(() => withoutDoubleMerge(mine.map(chatRowOf)), [mine]);
  // What waits its turn is in the queue above the box; once it runs, it's drawn where it ran (BLG-317).
  const sent = useMemo(() => asSent(items, (card) => inYourQueue(card, selfId)), [items, selfId]);
  // A message you steered in shows itself whether Claude has read it (BLG-54): its note card isn't drawn.
  const steered = useMemo(() => steeredMessages(sent), [sent]);
  const drawn = useMemo(() => (steered.notes.size ? sent.filter((l) => !steered.notes.has(l.id)) : sent), [sent, steered]);
  const tasks = useApp((st) => tasksIn(st, channel), sameItems);
  const placed = useMemo(() => placeTasks(drawn, tasks), [drawn, tasks]);
  // A card's tasks stay the same list while they're the same tasks, so its memo holds.
  const turnTasks = useRef<ReadonlyMap<string, readonly TaskView[]>>(undefined);
  const inTurn = useMemo(() => (turnTasks.current = keepSameLists(turnTasks.current, placed.inTurn)), [placed]);
  // A turn you spoke during goes on below what you said: its live part is the chat's last row (BLG-22).
  const starts = useApp((st) => threadStarts(st, channel), sameDeep);
  const shown = useMemo(() => withLiveTails(withThreadStarts(placed.rows, starts)), [placed, starts]);
  const rows = useMemo(() => shown.map((x) => x.row), [shown]);
  const latest = useMemo(() => latestCard(items), [items]);
  const parent = useRef<HTMLDivElement>(null);
  const askEarlier = useEarlier(channel, parent, rows[0]?.id);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const height = useRef(0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i]?.type === 'agent' ? 140 : rows[i]?.type === 'task' ? 160 : rows[i]?.type === 'system' ? 28 : 52),
    overscan: 8,
    getItemKey: (i) => shown[i]?.key ?? i,
    // A row that grows or shrinks (a new step under Claude, its answer streaming in) moves the
    // rows below it and the list's height in the same frame, straight from the resize: waiting
    // for a React render painted one frame with the old layout (the new line overlapping the
    // next row, or below the bottom and then jumping up), which flickered.
    directDomUpdates: true,
    // In that same frame, stay at the bottom if that's where you were.
    onChange: (v) => {
      const total = v.getTotalSize();
      if (total === height.current) return;
      height.current = total;
      const el = parent.current;
      if (stick.current && el) el.scrollTop = el.scrollHeight;
    },
  });

  // Until Claude's card for the message you just sent appears.
  const cards = useMemo(() => items.filter((l) => l.type === 'agent').length, [items]);
  // ...and only once the message you sent is in the chat: it shows first, the line under it (BLG-949).
  const lastMine = useMemo(() => lastMineIn(mine, selfId), [mine, selfId]);
  const sentStarting = useClaudeStarting(channel, cards, lastMine);
  const starting = sentStarting || (startingHere && cards === 0);

  // New messages (and Claude's streaming text) keep you at the bottom if that's where you were.
  useLayoutEffect(() => {
    if (stick.current && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows, virtualizer]);
  useLayoutEffect(() => {
    const el = parent.current;
    if (starting && stick.current && el) el.scrollTop = el.scrollHeight;
  }, [starting]);
  // You sent a message: back to the newest, where it lands (see flight.ts).
  useEffect(() => {
    const toBottom = (): void => {
      stick.current = true;
      setAtBottom(true);
      if (rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    };
    document.addEventListener('beluga:chat-bottom', toBottom);
    return () => document.removeEventListener('beluga:chat-bottom', toBottom);
  }, [rows.length, virtualizer]);
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [channel]);

  // A search hit opened: to its message, marked for a moment, once its history is here. After the
  // effect above, which sends a conversation that just opened to the bottom.
  const { client, ui } = useBeluga();
  const jump = useUi((u) => u.chatJump);
  const [marked, setMarked] = useState<React.Key | undefined>(undefined);
  const [waited, setWaited] = useState(0);
  // Which part of a split turn each row is: a hit on a turn goes to its answer, in the tail.
  const jumpRows = useMemo(() => shown.map((x) => ({ id: x.row.id, ts: x.row.ts, side: x.part?.side })), [shown]);
  useEffect(() => {
    const next = chatJumpState(jump, channel, jumpRows, Date.now());
    if (next.state === 'none') return;
    if (next.state === 'wait') {
      // No row comes to run this again when the history never lands.
      const t = setTimeout(() => setWaited((n) => n + 1), JUMP_TTL_MS + 1);
      return () => clearTimeout(t);
    }
    ui.patch({ chatJump: undefined });
    if (next.state === 'lost') toast(client, JUMP_LOST_TEXT);
    if (next.state !== 'go') return;
    stick.current = false;
    virtualizer.scrollToIndex(next.index, { align: 'center' });
    setMarked(shown[next.index]?.key ?? next.index);
  }, [jump, channel, jumpRows, shown, virtualizer, ui, client, waited]);
  useEffect(() => {
    if (marked === undefined) return;
    const t = setTimeout(() => setMarked(undefined), JUMP_MARK_MS);
    return () => clearTimeout(t);
  }, [marked]);

  // Only you scrolling (wheel, trackpad, keys, the scroll bar) leaves the bottom; the list moving
  // itself (a tall row measured, a graph laid out) doesn't.
  const youScrolled = useRef(0);
  const markScroll = (): void => {
    youScrolled.current = Date.now();
  };
  const onScroll = (): void => {
    const el = parent.current;
    if (!el) return;
    askEarlier();
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (!bottom && stick.current && Date.now() - youScrolled.current > 400) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  if (!rows.length) {
    return (
      <div className={s.logWrap}>
        <FindBar items={items} logRef={parent} onGo={() => undefined} />
        <StartedByLine channel={channel} />
        <div className={s.logEmpty}>{empty ?? <Empty icon="chat" title="Nothing here yet" detail="Say something below." />}</div>
      </div>
    );
  }

  const continued = (i: number): boolean => {
    const a = rows[i - 1];
    const b = rows[i];
    return Boolean(a && b && a.type === 'chat' && b.type === 'chat' && a.from === b.from && a.byAgent === b.byAgent && a.via?.id === b.via?.id && b.ts - a.ts < GROUP_GAP_MS);
  };

  const go = (index: number): void => {
    stick.current = false;
    const id = items[index]?.id;
    virtualizer.scrollToIndex(Math.max(0, rows.findIndex((r) => r.id === id)), { align: 'center' });
  };

  return (
    <div className={s.logWrap} data-flight-layer="">
      <FindBar items={items} logRef={parent} onGo={go} />
      <StartedByLine channel={channel} />
      <div ref={parent} className={s.log} onScroll={onScroll} onWheel={markScroll} onTouchMove={markScroll} onPointerDown={markScroll} onKeyDown={markScroll}>
        {/* The virtualizer sets the list's height and each row's position itself (see above). */}
        <div ref={virtualizer.containerRef} className={s.logInner}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = rows[v.index] as Row;
            const part = shown[v.index]?.part;
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={cx(s.logRow, v.key === marked && s.logRowMarked)} data-jumped={v.key === marked ? 'true' : undefined}>
                {item.type === 'task' ? (
                  <LogTaskCard task={item.task} />
                ) : item.type === 'thread_start' ? (
                  <ThreadStartLine thread={item.thread} />
                ) : item.type === 'chat' ? (
                  <ChatRow item={item} continued={continued(v.index)} ends={!continued(v.index + 1)} mine={item.from === selfId} steer={steered.waiting.get(item.id)} />
                ) : item.type === 'agent' ? (
                  <AgentCard item={item} tasks={part?.side === 'head' || part?.side === 'live' ? undefined : inTurn.get(item.id)} latest={item.id === latest} part={part} working={shown[v.index]?.working} subs={shown[v.index]?.subs} />
                ) : item.type === 'shell' ? (
                  <ShellCard item={item} />
                ) : isCompactItem(item) ? (
                  <CompactDivider item={item} />
                ) : isShippedItem(item) ? (
                  <ShippedDivider item={item} />
                ) : isMergedItem(item) ? (
                  <MergedDivider item={item} />
                ) : isDialogueItem(item) ? (
                  <DialogueCard item={item} />
                ) : (
                  <SystemRow item={item} />
                )}
              </div>
            );
          })}
        </div>
        {starting ? (
          <div className={f.starting} data-claude-starting="true" role="status">
            <span className={f.startingAvatar}>
              <Avatar name={agent} id={selfId} agent={agentRef} size={22} />
            </span>
            <Working />
            <span>{agent} is starting…</span>
          </div>
        ) : null}
      </div>
      {atBottom ? null : (
        <button
          type="button"
          className={s.jump}
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
          }}
        >
          <Icon name="chevronDown" size={12} />
          Latest
        </button>
      )}
    </div>
  );
}
