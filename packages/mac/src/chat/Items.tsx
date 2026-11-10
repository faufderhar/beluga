import { type ReactNode, createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogItem, ShellItem } from '@beluga/core/store.js';
import { HIDDEN_STEPS, isRunning } from '@beluga/ui/format.js';
import { formatDuration } from '@beluga/shared/text.js';
import { splitImages } from '@beluga/shared/attachment-links.js';
import { READS_AFTER_STEP, STEERED_IN, STOPPING_FOR, type SteeredMessage, isLimitNotice } from '@beluga/shared/claude-notices.js';
import { CONTINUE_PROMPT, type RunFailure, decodeFailure, failureTitle, resetWords } from '@beluga/shared/run-failure.js';
import { autoContinueFor, chatsOff, limitResumeAt, sessionSkip } from '@beluga/shared/auto-continue.js';
import { sentinelOfChannel } from '@beluga/core/sentinel/model.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot, Tip, claudeColor, cx, personColor } from '../components/ui.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { openExternal } from '../lib/system.js';
import { type SignInHow, signInChoices } from './sign-in-choices.js';
import { cancelSteer, sendSteerNow, stopClaude } from '../lib/commands.js';
import { copyText } from '../lib/copy.js';
import { useActions } from '../lib/actions.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { usePrefs } from '../lib/prefs.js';
import { useClock } from '../lib/window-active.js';
import { countRender } from '../lib/render-count.js';
import { ImageGrid } from './ChatImages.js';
import { openLightbox } from './images.js';
import { agentBadge, agentName, useMyAgentName } from '../lib/agent-words.js';
import type { AgentRef } from '@beluga/protocol.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { brandText } from '../lib/brand.js';
import { messageItems } from './message-menu.js';
import { Markdown } from './Markdown.js';
import { AgentSteps, StepsFold, StepsToggle } from './steps/AgentSteps.js';
import { useDisclosure } from './steps/step-memory.js';
import { useFlightLanding } from './flight.js';
import { type TurnPart, workingPhase } from './live-tail.js';
import { Shimmer } from './steps/StepRow.js';
import { useMentionWorld } from './Mention.js';
import type { TaskView } from '@beluga/core/gateway/model.js';
import { TaskCard } from '../gateway/TaskCard.js';
import { SlotWaitNotice } from './SlotWait.js';
import { EditPrompt } from './EditPrompt.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { PersonButton } from '../network/PersonProfile.js';
import { KnockCard } from '../team/Team.js';
import { useChatReactions } from './ChatReactions.js';
import r from '../network/reactions.module.css';
import { threadSender } from '../threads/threads-model.js';
import l from '../threads/threads.module.css';
import s from './chat.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { revealTerminal } from '../lib/panel.js';
import { claimShell } from '../lib/ws-shells.js';
import { globalShellId, globalShellNumber, isGlobalShell } from '@beluga/shared/terminal-keys.js';

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;
type SystemItem = Extract<LogItem, { type: 'system' }>;

/** A clock that ticks while something is running (for "Working · 12s"), and you're looking at Beluga. */
export const useNow = useClock;

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What a message's right-click menu needs: the box to quote into, and how to reach Claude here. */
/** What runs the agent and its model, small and quiet beside its name ("Opus", "Codex · GPT-5"). */
function AgentBadge({ agent }: { agent: AgentRef | undefined }) {
  const text = agentBadge(agent);
  return text ? (
    <span className={s.agentBadge} title={`${agent!.label}: ${agent!.runtime}${agent!.model ? `, ${agent!.model}` : ''}`}>
      <Icon name={agentMark(agent)} size={10} />
      {text}
    </span>
  ) : null;
}

function useMenuContext() {
  const { ui, client } = useBeluga();
  // In a group room only a mention reaches Claude; elsewhere quoting already asks it.
  const group = useApp((st) => st.view.kind === 'room' && st.peers.length > 1);
  return { ui, ...(group ? { askPrefix: '@claude ' } : {}), toast: (text: string) => client.store.dispatch({ type: 'toast', text, level: 'success' }) };
}

/**
 * How a conversation shown beside something else (a plan's) reads: `fold`, a person's long message
 * shows its first lines with Show all; `quietWorking`, Claude's card doesn't repeat a status the
 * page already shows ("Working · 26s").
 */
export const PaneLook = createContext<{ readonly fold?: boolean; readonly quietWorking?: boolean }>({});

/** A long message folded to three lines until you open it (only where FoldLongMessages is on). */
function Folding({ children }: { children: ReactNode }) {
  const { fold } = useContext(PaneLook);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (fold && el && !open) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [fold, open, children]);
  if (!fold) return <>{children}</>;
  return (
    <>
      <div ref={box} className={cx(!open && s.folded)}>
        {children}
      </div>
      {long || open ? (
        <button type="button" className={s.showAll} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </>
  );
}

/**
 * Under a message you steered in that Claude hasn't read yet: sent, not read, and (while it waits
 * for Claude's next step) Send now or Cancel. Once Claude reads it the line goes and the message
 * reads as any other; cancelled, the message goes and its words are back in the box.
 */
function SteerWaiting({ steer, channel }: { steer: SteeredMessage; channel: string }) {
  const { client, ui } = useBeluga();
  const stopping = steer.waiting === 'stopping';
  const agent = useMyAgentName();
  return (
    <div className={s.steerWaiting} data-steer-waiting={steer.waiting} role="status">
      <Icon name="clock" size={11} />
      <span>{stopping ? `Sent · ${agent} is stopping its step to read it` : `Sent · ${agent} reads it after its current step`}</span>
      {stopping ? null : (
        <>
          <Tip label={`Stop ${agent}’s current step so it reads this now`} keys={shortcutKeys('composer-send-now')}>
            <button type="button" className={s.steerNow} onClick={() => sendSteerNow(client, steer.request)}>
              <Icon name="send" size={10} />
              Send now
            </button>
          </Tip>
          <Tip label={`Take it back before ${agent} reads it: its words go back in the box`}>
            <button type="button" className={s.steerNow} data-steer-cancel onClick={() => cancelSteer({ client, ui }, steer.request, channel)}>
              <Icon name="x" size={10} />
              Cancel
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}

/**
 * Under a message to a friend's worktree while their Mac was offline: it waits (and goes when it's
 * back), then says it was delivered. Nothing for messages that went at once.
 */
function Delivery({ request, channel }: { request: string; channel: string }) {
  const state = useApp((st) => st.delivery[request]);
  const owner = useApp((st) => {
    const w = st.shared.find((x) => `ws:${x.id}` === channel);
    return w ? (st.network.friends.find((f) => f.peerId === w.owner)?.name ?? 'their') : 'their';
  });
  if (!state) return null;
  return (
    <div className={s.steerWaiting} data-delivery={state} role="status">
      <Icon name={state === 'waiting' ? 'clock' : 'check'} size={11} />
      <span>{state === 'waiting' ? `Waiting for ${owner}'s computer · it goes when it's back` : 'Delivered'}</span>
    </div>
  );
}

/** A message from a person (or a Claude speaking in the chat). `continued`: same author, shortly after. `steer`: steered in, not read yet. */
export const ChatRow = memo(function ChatRow({ item, continued, ends = true, mine, steer }: { item: ChatItem; continued: boolean; ends?: boolean; mine: boolean; steer?: SteeredMessage | undefined }) {
  countRender(`chat:${item.id}`);
  const prefs = usePrefs();
  // Screenshots and other images sent with the message show as pictures, under its words.
  const { text, images } = useMemo(() => splitImages(item.text), [item.text]);
  const menu = useMenuContext();
  // "@BLG-24" in your own words is a task on your board (someone else's key may be theirs).
  const mentions = useMentionWorld(item.channel, { tasks: mine });
  // The message you just sent flies in from the box (see flight.ts).
  const row = useRef<HTMLDivElement>(null);
  const own = mine && !item.byAgent;
  useFlightLanding(row, item.channel, 'chat', item.text, own);
  // Your own message in one of your conversations can be edited (BLG-385): rewound to, or forked from.
  const wsId = own && item.channel.startsWith('ws:') ? item.channel.slice(3) : undefined;
  const kind = useApp((st) => (wsId ? findWorkspace(st.projects, wsId)?.kind : undefined));
  const editable = Boolean(wsId) && (kind === 'worktree' || kind === 'chat') && !steer;
  const [editing, setEditing] = useState(false);
  // Emoji reactions (BLG-702): the button a hover shows, and the chips under the message.
  const reactions = useChatReactions(item, own);
  // A task or a message from the agent that started this thread: its words, not yours and not this chat's agent's.
  const sender = useApp((st) => threadSender(st, item));
  // Your own words: a tinted bubble on the right, no name or picture (it's plainly you).
  if (own)
    return (
      <ActionsContext items={() => messageItems({ ...menu, text, images, openImage: (img) => openLightbox(images, images.indexOf(img)), ...(editable ? { lead: [{ label: 'Edit Message', icon: 'pencil', onSelect: () => setEditing(true) }] } : {}) })}>
        <div ref={row} className={cx(s.message, s.own, r.reactable, continued && s.continued, steer && s.unread)} data-mine="true" data-steer={steer ? 'waiting' : undefined} data-chat={item.id}>
          {editing ? null : reactions.button}
          <div className={s.body}>
            {editing && wsId ? (
              <EditPrompt wsId={wsId} lineId={item.id} text={item.text} worktree={kind === 'worktree'} onClose={() => setEditing(false)} />
            ) : text ? (
              <div className={s.bubbleRow}>
                {editable ? (
                  <span className={s.ownActions}>
                    <Tip label="Edit: rewind to here, or fork from here">
                      <Button size="small" variant="quiet" icon="pencil" aria-label="Edit message" onClick={() => setEditing(true)} />
                    </Tip>
                  </span>
                ) : null}
                <div className={s.bubble} title={time(item.ts)}>
                  <Folding>
                    <Markdown text={text} paths localImages mentions={mentions} tasks typed />
                  </Folding>
                </div>
              </div>
            ) : null}
            <ImageGrid images={images} />
            {reactions.chips}
            {steer ? <SteerWaiting steer={steer} channel={item.channel} /> : null}
            {item.request && item.channel ? <Delivery request={item.request} channel={item.channel} /> : null}
          </div>
        </div>
      </ActionsContext>
    );
  // A friend's words in a shared worktree (BLG-210): a bubble of their colour on the left, their name
  // above the run and their picture at its end, as in a chat with friends.
  if (!item.byAgent)
    return (
      <ActionsContext items={() => messageItems({ ...menu, text, images, openImage: (img) => openLightbox(images, images.indexOf(img)) })}>
        <div ref={row} className={cx(s.message, s.theirs, r.reactable, continued && s.continued, steer && s.unread)} data-steer={steer ? 'waiting' : undefined} data-chat={item.id} style={{ ['--person' as string]: personColor(item.from) }}>
          {reactions.button}
          <div className={cx(s.gutter, s.gutterEnd)}>{ends ? (
              <PersonButton peerId={item.from} name={item.name}>
                <Avatar name={item.name} id={item.from} size={26} />
              </PersonButton>
            ) : null}</div>
          <div className={cx(s.body, s.theirsBody)}>
            {continued ? null : (
              <div className={s.meta}>
                <PersonButton peerId={item.from} name={item.name}>
                  <span className={s.author}>{item.name}</span>
                </PersonButton>
                {prefs.timestamps ? <span className={s.time}>{time(item.ts)}</span> : null}
              </div>
            )}
            {text ? (
              <div className={cx(s.theirBubble, ends && s.theirTail)}>
                <Folding>
                  <Markdown text={text} paths={mine} localImages={mine} mentions={mentions} tasks={mine} typed />
                </Folding>
              </div>
            ) : null}
            <ImageGrid images={images} />
            {reactions.chips}
            {steer ? <SteerWaiting steer={steer} channel={item.channel} /> : null}
          </div>
        </div>
      </ActionsContext>
    );
  return (
    <ActionsContext items={() => messageItems({ ...menu, text, images, openImage: (img) => openLightbox(images, images.indexOf(img)) })}>
      <div ref={row} className={cx(s.message, r.reactable, continued && s.continued, steer && s.unread)} data-steer={steer ? 'waiting' : undefined} data-chat={item.id}>
        {reactions.button}
        <div className={s.gutter}>{continued ? null : sender ? <Icon name="up" size={15} /> : <Avatar name={item.name} id={item.from} claude={item.byAgent} agent={item.agent} size={26} />}</div>
        <div className={s.body}>
          {continued ? null : (
            <div className={s.meta}>
              {sender ? (
                <span className={l.sentBy} data-sent-by="">{`Sent by ${sender}’s agent`}</span>
              ) : (
                <>
                  <span className={cx(s.author, item.byAgent && s.claudeName)} style={item.byAgent && claudeColor(item.from) ? { color: claudeColor(item.from) } : undefined}>
                    {item.name}
                  </span>
                  {item.byAgent ? <AgentBadge agent={item.agent} /> : null}
                </>
              )}
              {prefs.timestamps ? <span className={s.time}>{time(item.ts)}</span> : null}
            </div>
          )}
          {text ? (
            item.byAgent ? (
              <Markdown text={text} paths={mine} localImages={mine} mentions={mentions} tasks={mine} />
            ) : (
              <Folding>
                <Markdown text={text} paths={mine} localImages={mine} mentions={mentions} tasks={mine} />
              </Folding>
            )
          ) : null}
          <ImageGrid images={images} />
          {reactions.chips}
          {steer ? <SteerWaiting steer={steer} channel={item.channel} /> : null}
        </div>
      </div>
    </ActionsContext>
  );
});

export const SystemRow = memo(function SystemRow({ item }: { item: SystemItem }) {
  const menu = useMenuContext();
  return (
    <ActionsContext items={() => messageItems({ ...menu, text: item.text })}>
        {/* A teammate knocking on this worktree (BLG-416): its card while it waits, then the line. */}
        <KnockCard id={item.id.startsWith('wt-knock-') ? item.id.slice('wt-knock-'.length) : ''} text={item.text}>
          <div className={cx(s.system, item.level === 'warn' && s.systemWarn, item.level === 'error' && s.systemError)}>
            {/* Core words ("beluga") in this app's; a line quoting what someone said stays as written. */}
            <Markdown text={item.said ? item.text : brandText(item.text)} />
          </div>
        </KnockCard>
    </ActionsContext>
  );
});

/** What a steered message's card says once Claude read it: the turn's answer comes after it (see live-tail.ts). */
const STEERED_BELOW = 'The agent read this while it worked; the answer below covers it.';

/** The card's header status, when there's one to say (working is said by the working line at the bottom). */
function statusOf(item: AgentItem): { label: string; tone: 'claude' | 'ok' | 'error' | 'warn' | 'muted' } {
  switch (item.status) {
    case 'awaiting_approval':
      return { label: `Waiting for ${item.ownerName} to approve`, tone: 'warn' };
    case 'queued':
      return { label: item.slotWait ? `Waiting for a free ${agentName(item.agent)}` : 'Queued', tone: 'muted' };
    case 'done':
      // The answer itself says it's done: no "Done in 3m" on every message.
      return { label: '', tone: 'ok' };
    case 'error':
      if (decodeFailure(item.text)?.kind === 'usage_limit') return { label: 'Paused', tone: 'warn' };
      // Stopping or taking a message back is something you did, not a problem.
      if (/^(Taken out of the queue|Cancelled before it started)/.test(item.text)) return { label: 'Not sent', tone: 'muted' };
      if (/^(Stopped by you|Interrupted by a newer message|Stopped by owner)/.test(item.text)) return { label: 'Stopped', tone: 'muted' };
      return { label: 'Stopped', tone: 'error' };
    case 'denied':
      return { label: 'Declined', tone: 'warn' };
    case 'interrupted':
      // Beluga stopped while it ran (quit, a crash): not a problem to flag, just where it was left.
      return { label: 'Interrupted', tone: 'muted' };
    default:
      return { label: '', tone: 'claude' };
  }
}

/**
 * The working line, the last thing in a turn Claude is on: what it's doing in a few words and
 * for how long. Its own clock, so the card isn't drawn again every second. `quiet`: the page
 * already says for how long (a plan's), so only what it's doing.
 */
function WorkingLine({ item, quiet }: { item: AgentItem; quiet: boolean }) {
  const now = useNow(true);
  const phase = workingPhase(item);
  if (phase === undefined) return null;
  return (
    <div className={s.working} data-working="true" title={phase ? `Working · ${phase}` : 'Working'}>
      <Dot tone="claude" live />
      <span className={s.workingWords}>
        <Shimmer>Working</Shimmer>
        {phase ? <span className={s.workingPhase}> · {phase}</span> : null}
      </span>
      {quiet ? null : <span className={s.workingTime}>{formatDuration(Math.max(0, now - item.ts))}</span>}
    </div>
  );
}

/**
 * Where a turn split by what was said during it began (see live-tail.ts): who, and the steps it
 * had finished by then; the rest (what it does now, its answer) is further down.
 */
function TurnHead({ item, part, mine }: { item: AgentItem; part: TurnPart; mine: boolean }) {
  const prefs = usePrefs();
  const steps = useDisclosure(`${item.channel}/${item.id}`);
  const running = isRunning(item.status) && item.status !== 'queued';
  const folded = item.status === 'done' && Boolean(item.text) && prefs.doneSteps === 'fold' && !steps.shown;
  // No step yet: a head would be a bare name over "continues below". Its tail says it all.
  if (!item.steps.some((x) => !HIDDEN_STEPS.test(x))) return null;
  return (
    <div className={cx(s.message, s.agent, s.turnHead)} data-turn={item.status} data-turn-part="head">
      <div className={s.gutter}>
        <Avatar name={agentName(item.agent)} id={item.owner} claude agent={item.agent} size={26} />
      </div>
      <div className={s.body}>
        <div className={s.meta}>
          <span className={cx(s.author, s.claudeName)} style={claudeColor(item.owner) ? { color: claudeColor(item.owner) } : undefined}>
            {mine ? agentName(item.agent) : `${item.ownerName}'s ${agentName(item.agent)}`}
          </span>
          <AgentBadge agent={item.agent} />
        </div>
        <StepsFold folded={folded}>
          <AgentSteps item={item} running={false} part={part} />
        </StepsFold>
        <div className={s.continues}>
          <Icon name="chevronDown" size={11} />
          {running ? 'Still working · continues below' : 'Continued below'}
        </div>
      </div>
    </div>
  );
}

/**
 * What a turn left running once another turn of its Claude took over (see live-tail.ts): its
 * sub-agents and background jobs still at work, at the very bottom with the working line.
 */
function LivePart({ item, working }: { item: AgentItem; working: AgentItem | undefined }) {
  const { quietWorking } = useContext(PaneLook);
  return (
    <div className={cx(s.message, s.agent, s.livePart)} data-turn={item.status} data-turn-part="live">
      <div className={s.gutter} />
      <div className={s.body}>
        <AgentSteps item={item} running part={{ side: 'live', cut: item.ts }} subs="running" />
        {working ? <WorkingLine item={working} quiet={Boolean(quietWorking)} /> : null}
      </div>
    </div>
  );
}

/** What Claude is doing (or did): its steps, sub-agents and background work, then its answer. */
export const AgentCard = memo(function AgentCard({
  item,
  tasks,
  latest = false,
  part,
  working,
  subs,
}: {
  item: AgentItem;
  tasks?: readonly TaskView[] | undefined;
  /** The newest Claude card in its conversation. */
  latest?: boolean;
  /** Drawn in parts, things having been said while it worked or another turn having taken over (see live-tail.ts). */
  part?: TurnPart | undefined;
  /** The working line at its end, for that turn (its Claude's one: see live-tail.ts). */
  working?: AgentItem | undefined;
  /** Which of its sub-agents and background work it draws (see live-tail.ts). */
  subs?: 'running' | 'settled' | undefined;
}) {
  countRender(`card:${item.id}`);
  const selfId = useApp((st) => st.selfId);
  if (part?.side === 'head') return <TurnHead item={item} part={part} mine={item.owner === selfId} />;
  if (part?.side === 'live') return <LivePart item={item} working={working} />;
  return <TurnCard item={item} tasks={tasks} latest={latest} part={part} selfId={selfId} working={working} subs={subs} />;
});

function TurnCard({
  item,
  tasks,
  latest,
  part,
  selfId,
  working,
  subs,
}: {
  item: AgentItem;
  tasks: readonly TaskView[] | undefined;
  latest: boolean;
  part: TurnPart | undefined;
  selfId: string;
  working: AgentItem | undefined;
  subs: 'running' | 'settled' | undefined;
}) {
  // A steered message's card waiting for Claude's next step (or for its step to stop) isn't a turn at work: a note.
  const waitingNote = item.text === READS_AFTER_STEP || item.text === STOPPING_FOR;
  const running = isRunning(item.status) && item.status !== 'queued' && !waitingNote;
  const st = statusOf(item);
  const { quietWorking } = useContext(PaneLook);
  const forSomeoneElse = item.requesterName !== item.ownerName;
  const mine = item.owner === selfId;
  const { client, ui } = useBeluga();
  const actions = useActions();
  const menu = useMenuContext();
  // Your own Claude, working now: it can be stopped from its card.
  const stoppable = mine && running && item.status !== 'awaiting_approval';
  const stop = (): void => stopClaude({ client, ui, actions }, item.channel);
  // Once it has answered, its steps fold away (Settings › Chat); Show Steps opens them again.
  const prefs = usePrefs();
  const steps = useDisclosure(`${item.channel}/${item.id}`);
  const answered = item.status === 'done' && Boolean(item.text);
  // A queued message Claude read mid-turn: its answer is the card above's.
  const steeredIn = (item.status === 'done' && item.text === STEERED_IN) || waitingNote;
  // Claude Code stopped at a plan limit: the newest card here (`latest`) offers to go on, in one click.
  const group = useApp((st) => st.peers.length > 1);
  // A run that failed on its own (a usage limit, a crash): what happened in words, and Continue.
  const failure = item.status === 'error' ? decodeFailure(item.text) : undefined;
  const limited = mine && latest && !running && (isLimitNotice(item.text) || Boolean(failure && failure.kind !== 'stopped'));
  // The same session goes on, ahead of what queued behind the failed turn (that follows, in order).
  const resume = (): void =>
    void client.api.session.submit(`${item.channel === 'room' && group ? '@claude ' : ''}${CONTINUE_PROMPT}`, { channel: item.channel, urgent: true }).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  // Claude Code isn't signed in (or its sign-in expired): Continue would fail the same way. Sign In
  // offers /login's choices; a Claude or Console account runs `claude auth login` in a shell you can
  // see (the worktree's own, else the Terminal's), and Claude goes on once it ends well.
  const signIn = (how: SignInHow): void => {
    const terminals = client.store.getState().terminals;
    const key = item.channel.startsWith('ws:') ? claimShell(item.channel.slice(3), terminals) : globalShellId(Math.max(0, ...Object.keys(terminals).filter(isGlobalShell).map(globalShellNumber)) + 1);
    ui.patch({ termKey: key });
    requestAnimationFrame(() => revealTerminal(client.store.getState(), true));
    void client.api.workbench.signInClaude(key, item.channel, how).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  };
  const hasSteps = item.steps.length > 0 || item.subagents.length > 0;
  const folded = answered && prefs.doneSteps === 'fold' && !steps.shown;
  const lead: ActionItem[] = stoppable
    ? [{ label: `Stop ${agentName(item.agent)}`, icon: 'stop', ...(shortcutKeys('conv-stop') ? { keys: shortcutKeys('conv-stop') } : {}), onSelect: stop }]
    : answered && hasSteps && prefs.doneSteps === 'fold'
      ? [{ label: steps.shown ? 'Hide Steps' : 'Show Steps', icon: 'rows', onSelect: () => steps.setShown(!steps.shown) }]
      : [];
  return (
    <ActionsContext items={() => messageItems({ ...menu, text: item.text, lead })}>
      <div className={cx(s.message, s.agent)} data-turn={item.status} data-turn-part={part ? 'tail' : undefined}>
        <div className={s.gutter}>
          <Avatar name={agentName(item.agent)} id={item.owner} claude agent={item.agent} size={26} />
        </div>
        <div className={s.body}>
          <div className={s.meta}>
            <span className={cx(s.author, s.claudeName)} style={claudeColor(item.owner) ? { color: claudeColor(item.owner) } : undefined}>
              {mine ? agentName(item.agent) : `${item.ownerName}'s ${agentName(item.agent)}`}
            </span>
            <AgentBadge agent={item.agent} />
            {forSomeoneElse ? <span className={s.time}>for {item.requesterName}</span> : null}
            {!running && item.text && item.status === 'done' && !steeredIn ? (
              <span className={s.hoverActions}>
                {/* Folded: anyone's steps show again; kept showing, only your own Claude's open further. */}
                {hasSteps && (prefs.doneSteps === 'fold' || (mine && item.steps.length > 0)) ? <StepsToggle item={item} /> : null}
                <Button size="small" variant="quiet" icon="copy" onClick={() => void copyText(item.text).then(() => menu.toast('Copied the answer'))}>
                  Copy
                </Button>
              </span>
            ) : stoppable ? (
              <span className={s.hoverActions}>
                <Button size="small" variant="quiet" icon="stop" onClick={stop} title={`Stop ${agentName(item.agent)} here${shortcutKeys('conv-stop') ? ` (${shortcutKeys('conv-stop')})` : ''}`}>
                  Stop
                </Button>
              </span>
            ) : null}
            {st.label && !(running && quietWorking) ? (
              <span className={cx(s.status, s[`tone_${st.tone}`])}>
                {running ? <Dot tone="claude" live /> : null}
                {st.label}
              </span>
            ) : null}
          </div>
          {/* Steps open to show what ran and what came back (see steps/AgentSteps.tsx). */}
          <StepsFold folded={folded}>
            <AgentSteps item={item} running={running} part={part} subs={subs} />
          </StepsFold>
          {/* What it asked other people's Claudes, before its answer (which comes last). */}
          {tasks?.map((t) => (
            <div key={t.id} className={s.turnTask}>
              <TaskCard task={t} />
            </div>
          ))}
          {steeredIn ? (
            <div className={s.idle}>{item.text === STEERED_IN ? STEERED_BELOW : item.text}</div>
          ) : failure ? (
            <FailureNotice failure={failure} />
          ) : item.text ? (
            <Markdown text={item.text} paths localImages={mine} live={running} tasks={mine} />
          ) : item.status === 'queued' && item.slotWait ? (
            // Nothing runs here: your Claude works in as many other conversations as it may at once.
            <SlotWaitNotice wait={item.slotWait} requestId={mine && item.requester === selfId ? item.requestId : undefined} />
          ) : item.status === 'queued' ? (
            // Sending it now, editing or moving it: the queue above the box.
            <div className={s.idle}>Starts when the current task finishes.</div>
          ) : null}
          {/* Sign In runs Claude Code's own login: only for a Claude run (Codex says how to sign in on its card). */}
          {limited && failure?.kind === 'signed_out' && (failure.runtime ?? 'claude') === 'claude' ? (
            <div className={s.limitActions}>
              <ActionsDropdown items={signInChoices(signIn, (url) => void openExternal(url))} align="start">
                <Button size="small" icon="person" title="Sign in to Claude Code again; then the run picks up where it stopped">
                  Sign In
                </Button>
              </ActionsDropdown>
            </div>
          ) : limited && failure?.kind === 'signed_out' && (failure.runtime === 'opencode' || failure.runtime === 'grok') ? (
            // OpenCode's model provider said no, or Grok Build isn't signed in: sign in in Terminal (`opencode auth login`, `grok login`), then Continue.
            <div className={s.limitActions}>
              <Button size="small" icon="person" onClick={() => void client.api.workbench.agentSignIn(failure.runtime!).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'))} title="Add or renew a model provider in Terminal (opencode auth login), then Continue">
                Sign In
              </Button>
              <Button size="small" icon="play" onClick={resume} title={`Send “continue”: ${agentName(item.agent)} picks up where it stopped`}>
                Continue
              </Button>
            </div>
          ) : limited && failure?.kind === 'usage_limit' ? (
            <LimitResume channel={item.channel} failure={failure} stoppedAt={item.endTs ?? item.lastAt ?? item.ts} agent={item.agent} onContinue={resume} />
          ) : limited ? (
            <div className={s.limitActions}>
              <Button size="small" icon="play" onClick={resume} title={`Send “continue”: ${agentName(item.agent)} picks up where it stopped`}>
                Continue
              </Button>
            </div>
          ) : null}
          {working ? <WorkingLine item={working} quiet={Boolean(quietWorking)} /> : null}
        </div>
      </div>
    </ActionsContext>
  );
}

/**
 * Under a run that stopped on your usage limit (BLG-757): when Beluga tells it to continue on its
 * own (shared/auto-continue.ts), and Don't Send for this chat, this session or everywhere. Off, it's
 * Continue as before, with a way to turn it back on for this chat or session.
 */
function LimitResume({ channel, failure, stoppedAt, agent, onContinue }: { channel: string; failure: RunFailure; stoppedAt: number; agent: AgentRef | undefined; onContinue: () => void }) {
  const { client } = useBeluga();
  const prefs = useApp((st) => st.prefs);
  const now = useNow(true, 15_000);
  const at = limitResumeAt(failure, stoppedAt);
  // A sentinel's run chat isn't continued: the sentinel runs again after the reset (core/auto-continue.ts sentinelRunChat).
  const sentinelRun = useApp((st) => Boolean(sentinelOfChannel(st.sentinel, channel)?.runId));
  const auto = sentinelRun ? ({ kind: 'off', why: 'sentinel', at } as const) : autoContinueFor(prefs, channel, at, now);
  const set = (patch: Parameters<typeof client.api.session.setPrefs>[0], said: string): void =>
    void client.api.session.setPrefs(patch).then(
      () => toast(client, said, 'success'),
      (err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'),
    );
  const when = resetWords(at, now);
  if (auto.kind === 'scheduled') {
    const dontSend: ActionItem[] = [
      { label: 'For This Session', icon: 'pause', hint: 'Every chat, until this limit resets', onSelect: () => set({ autoContinueSkip: sessionSkip(at) }, `Nothing continues on its own until ${when}`) },
      { label: 'Never in This Chat', icon: 'chat', onSelect: () => set({ autoContinueOff: chatsOff(prefs.autoContinueOff, channel, true) }, 'This chat waits for you to press Continue') },
      { label: 'Everywhere', icon: 'x', separate: true, hint: 'Settings › Agent › Usage limits', onSelect: () => set({ autoContinue: false }, 'Turned off: agents wait for you to press Continue') },
    ];
    return (
      <div className={cx(s.limitActions, s.limitResume)}>
        <Icon name="clock" size={13} />
        <span className={s.limitResumeText}>
          {now < at ? (
            <>
              Sends “{CONTINUE_PROMPT}” at {when}, when your limit resets
            </>
          ) : (
            <>Your limit reset: telling {agentName(agent)} to continue…</>
          )}
        </span>
        {now < at ? (
          // The limit lifted sooner (a plan change, more usage): go on now.
          <Button size="small" variant="quiet" icon="play" onClick={onContinue} title={`Send “continue” now: ${agentName(agent)} picks up where it stopped`}>
            Continue Now
          </Button>
        ) : null}
        <ActionsDropdown items={dontSend} align="start">
          <Button size="small" variant="quiet" title="Keep it from continuing on its own">
            Don’t Send
          </Button>
        </ActionsDropdown>
      </div>
    );
  }
  // Off for this chat or this session, and still ahead: one click puts it back.
  const undo =
    now < at && auto.why === 'chat'
      ? (): void => set({ autoContinueOff: chatsOff(prefs.autoContinueOff, channel, false) }, `Continues on its own at ${when}`)
      : now < at && auto.why === 'session'
        ? (): void => set({ autoContinueSkip: 0 }, `Continues on its own at ${when}`)
        : undefined;
  return (
    <div className={s.limitActions}>
      <Button size="small" icon="play" onClick={onContinue} title={`Send “continue”: ${agentName(agent)} picks up where it stopped`}>
        Continue
      </Button>
      {undo ? (
        <Button size="small" variant="quiet" icon="clock" onClick={undo} title="Beluga sends it on its own once your limit resets">
          Send at {when}
        </Button>
      ) : null}
    </div>
  );
}

/** A failed turn in plain words (“Claude hit your usage limit · resets at 15:00”), the raw error a click away. */
function FailureNotice({ failure }: { failure: RunFailure }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.failure}>
      <div className={s.failureTitle}>{failureTitle(failure)}</div>
      {failure.kind === 'stopped' ? null : (
        <button type="button" className={s.failureToggle} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide details' : 'Show details'}
        </button>
      )}
      {open ? <pre className={s.failureDetail}>{failure.detail}</pre> : null}
    </div>
  );
}

/** A command that ran (or waits to run) on someone's computer, with its output. */
export const ShellCard = memo(function ShellCard({ item }: { item: ShellItem }) {
  const running = item.status === 'running' || item.status === 'waiting';
  const now = useNow(running);
  const label =
    item.status === 'waiting'
      ? `Waiting for ${item.ownerName} to approve`
      : item.status === 'running'
        ? `Running on ${item.ownerName}'s computer · ${formatDuration(now - (item.startTs ?? item.ts))}`
        : item.status === 'declined'
          ? `${item.ownerName} declined`
          : item.status === 'failed'
            ? item.error ?? `Exit ${item.exitCode ?? '?'}`
            : `Exit ${item.exitCode ?? 0}${item.endTs && item.startTs ? ` · ${formatDuration(item.endTs - item.startTs)}` : ''}`;
  const tone = item.status === 'done' && (item.exitCode ?? 0) === 0 ? 'ok' : item.status === 'done' || item.status === 'failed' ? 'error' : item.status === 'declined' ? 'warn' : 'claude';
  const menu = useMenuContext();
  const copy = (text: string, what: string): void => void copyText(text).then(() => menu.toast(`Copied ${what}`));
  const items: ActionItem[] = [
    { label: 'Copy Command', icon: 'copy', onSelect: () => copy(item.command, 'the command') },
    ...(item.output ? [{ label: 'Copy Output', onSelect: () => copy(item.output ?? '', 'the output') }] : []),
  ];
  return (
    <ActionsContext items={items}>
      <div className={cx(s.message, s.shell)}>
        <div className={s.gutter}>
          <span className={s.shellIcon}>
            <Icon name="terminal" size={14} />
          </span>
        </div>
        <div className={s.body}>
          <div className={s.meta}>
            <span className={s.author}>{item.by}</span>
            <span className={s.time}>on {item.ownerName}'s computer{item.cwd ? ` · ${item.cwd}` : ''}</span>
            <span className={cx(s.status, s[`tone_${tone}`])}>
              {running ? <Dot tone="claude" live /> : null}
              {label}
            </span>
          </div>
          <pre className={`${s.shellOut} selectable`}>
            <span className={s.prompt}>$ </span>
            {item.command}
            {item.output ? `\n${item.output}` : ''}
            {item.truncated ? '\n…' : ''}
          </pre>
        </div>
      </div>
    </ActionsContext>
  );
});
