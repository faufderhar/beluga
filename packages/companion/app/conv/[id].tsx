import { useLocalSearchParams } from 'expo-router';
import { resetWords } from '../../../../src/shared/run-failure';
import { KeyboardLift } from '../../components/KeyboardLift';
import { Activity, Bot, Camera, ChevronRight, Map as MapIcon, CircleCheck, CircleX, Clock, Cpu, FolderTree, GitMerge, History, Images, Laptop, MessagesSquare, Monitor, Network, OctagonX, Plus, Send, Square, SquareTerminal, Trash2, Undo2 } from 'lucide-react-native';
import { AgentList, Breathe, LivePanel, StepList, StepsFold, ToolBadge, TypingDots } from '../../components/Live';
import { ThreadsSheet, threadsSummary } from '../../components/ThreadsSheet';
import { BranchBand, MergeBand, MergeSheet } from '../../components/Merge';
import { ProjectMark } from '../../components/ProjectMark';
import { InlineThing } from '../../components/render/Inline';
import { chatMentionsAsTitles, parseChatRef } from '../../lib/render';
import { openOnMac } from '../../lib/mac';
import { useRef, useState } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, QueueTray } from '../../components/Composer';
import { AgentChips, Prose, StepTicker } from '../../components/Conv';
import { answer, NeedButtons, NeedFace } from '../../components/Needs';
import { Options } from '../../components/Options';
import { QuickReactions, ReactionChips } from '../../components/Reactions';
import { OutputGrid, OutputsTopic, TurnOutputs } from '../../components/Outputs';
import { DeleteMacChat, MacChatsSheet, newMacChat } from '../../components/MacChats';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { EditPromptSheet } from '../../components/EditPrompt';
import { AgentPickerSheet } from '../../components/AgentPicker';
import { agentMark, markIcon, markOfName, runtimeMark } from '../../components/AgentMark';
import { Avatar, Card, IconBadge, More, Pill, Press, T, type Tone, toneOf } from '../../components/ui';
import { ago, elapsed, useComputer, useSince, useSupports, useView, useVisibleNeeds } from '../../lib/hooks';
import { OnComputer, useOn } from '../../lib/scope';
import { calls } from '../../lib/link/calls';
import { convAbilities, scoped } from '../../lib/link/scoped';
import { type ConvView, type HomeView, type OutputView, type SubAgentView, type Topic, type TurnView, isMacTopic } from '../../lib/link/protocol';
import { type Send as Pending, sends, useSends, whereOf } from '../../lib/sends';
import { SendStatus } from '../../components/SendStatus';
import { AgentStrip, SubAgentSheet } from '../../components/SubAgents';
import { store } from '../../lib/store';
import { upload } from '../../lib/pick';
import { color } from '../../lib/theme';
import { router } from 'expo-router';

/**
 * One conversation: your messages, Claude's answers as cards (code folded into chips), the live
 * step, sub-agents as chips (tap: a sheet with their steps and outputs), what it waits on you for,
 * and a composer with Send and Stop.
 */

/** An empty Your Mac: three first things to ask, one tap each (the composer is there too). */
function MacStarters({ topic, on }: { readonly topic: Topic; readonly on?: string }) {
  const starters = [
    { label: 'Send me a screenshot', Icon: Camera, tone: 'sky' as Tone, text: 'Take a screenshot of my screen and send it to me.' },
    { label: 'What’s using my CPU?', Icon: Cpu, tone: 'peach' as Tone, text: 'What’s using my CPU and memory right now?' },
    { label: 'What’s running?', Icon: Activity, tone: 'mint' as Tone, text: 'What’s running in Beluga right now, across my projects?' },
  ];
  return (
    <Animated.View entering={FadeIn.duration(260)} style={{ alignItems: 'center', gap: 14, marginTop: 40 }}>
      <IconBadge Icon={Laptop} tone="sky" size={56} />
      <T v="heading">Ask your Mac</T>
      <T v="callout" style={{ textAlign: 'center', paddingHorizontal: 24 }}>
        Your agent for the whole Mac, not one project. The same conversation as on your Mac.
      </T>
      <View style={{ gap: 8, alignSelf: 'stretch', marginTop: 6 }}>
        {starters.map((s) => (
          <Press key={s.label} scaleTo={0.985} onPress={() => sends.message(topic, s.text, calls.send(topic, s.text), on ? { on } : {})}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 14 }}>
              <IconBadge Icon={s.Icon} tone={s.tone} size={30} />
              <T v="body">{s.label}</T>
            </Card>
          </Press>
        ))}
      </View>
    </Animated.View>
  );
}

/** A conversation, on your Mac or (`?on=`) on one of your computers, over its own link (BLG-810). */
export default function ConversationScreen() {
  const { on } = useLocalSearchParams<{ on?: string }>();
  return (
    <OnComputer.Provider value={on || undefined}>
      <Conversation />
    </OnComputer.Provider>
  );
}

function Conversation() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  // One of your computers': its calls go over its link, nothing waits for it, and what only your Mac does is left out.
  const on = useOn();
  const computer = useComputer(on);
  const away = on && computer?.phase !== 'open' ? `${computer?.computer.name ?? 'That computer'} is away: this is what your phone kept.` : undefined;
  const { call, where } = scoped(store, on);
  const topic = `conv:${decodeURIComponent(id ?? '')}` as Topic;
  const conv = useView<ConvView>(topic);
  const c = conv?.data;
  const needs = useVisibleNeeds(on ? store.placeNeeds(on, c?.needsYou) : c?.needsYou);
  /** What you sent that the Mac's view doesn't show yet (lib/sends.ts). */
  const pending = useSends(whereOf(topic, on));
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const atEnd = useRef(true);
  const [agent, setAgent] = useState<SubAgentView | undefined>();
  const [olderBusy, setOlderBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  /** A steered message of yours Claude hasn't read yet, long-pressed: its sheet offers Send now. */
  const [unread, setUnread] = useState<TurnView | undefined>();
  // A steered message you took back: its words, back in the box.
  const [refill, setRefill] = useState<{ text: string; key: number } | undefined>();
  /** Your message, long-pressed to edit it (1.28): Rewind Here or New Fork. */
  const [editing, setEditing] = useState<TurnView | undefined>();
  const [picking, setPicking] = useState(false);
  const canEdit = useSupports('editPrompt');
  // 1.41 (BLG-702): a person's message in the room's or a workspace's chat takes emoji reactions.
  const reacts = useSupports('reactions');
  const supportsCancel = useSupports('cancelSteer');
  const [reacting, setReacting] = useState<TurnView | undefined>();
  const react = (t: TurnView, emoji: string, on: boolean): void => void call(calls.reactTurn(topic, t.id, emoji, on), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  const chipsOf = (t: TurnView) => (reacts && t.reactions?.length ? <ReactionChips reactions={t.reactions} mine={t.who === 'you'} onToggle={(e, on) => react(t, e, on)} onWho={(text) => store.toast({ text, tone: 'info' })} /> : null);
  const reactPress = (t: TurnView) => (reacts && t.reactable ? () => setReacting(t) : undefined);
  const older = async () => {
    if (!c) return;
    setOlderBusy(true);
    await call(calls.older(topic, c.turns[0]?.id ?? '')).catch(() => undefined);
    setOlderBusy(false);
  };

  // Keep the newest in view while you're at the end; leave you be when you've scrolled up.
  const follow = () => {
    if (atEnd.current) scroll.current?.scrollToEnd({ animated: true });
  };
  const liveAgent = agent && c ? c.turns.flatMap((t) => t.subagents ?? []).find((a) => a.id === agent.id) ?? agent : agent;
  // The viewer swipes through this worktree's outputs (all of them, since 1.3; else the turns').
  const all: OutputView[] = c ? (c.outputs ?? c.turns.flatMap((t) => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)])) : [];
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  // What waits its turn is in the queue above the composer, not a turn of its own.
  const turns = c ? c.turns.filter((t) => !(c.queue && t.who === 'claude' && t.status === 'queued')) : [];
  // A worktree (or chat folder) of yours has files to read and terminals to share with the Mac (1.7).
  const can = convAbilities(scoped(store, on), { topic, agent: c?.agent, mergeable: c?.mergeable, branch: c?.branch, macTopic: isMacTopic(topic), askedTask: topic.startsWith('conv:task:') });
  const hasFolder = can.hasFolder;
  // Your Mac's chats (1.14): a list to switch between in the header, New chat and Delete under •••.
  const canChats = useSupports('macChats');
  const macChats = canChats && can.macChats;
  const home = useView<HomeView>(macChats ? 'home' : undefined);
  const chatCount = home?.data.macChats?.length ?? 0;
  const [chatsOpen, setChatsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** A request you asked of a friend's Claude: Stop cancels it (no run of yours to stop), Remove forgets it. */
  const askedTask = topic.startsWith('conv:task:') ? topic.slice('conv:task:'.length) : undefined;

  return (
    <OutputsTopic.Provider value={topic}>
      <Screen>
        <Header scrolled={scrolled} back eyebrow={c?.project} title={c?.title ?? 'Conversation'} at={conv?.at} lead={isMacTopic(topic) ? <IconBadge Icon={Laptop} tone="sky" size={30} /> : c?.project ? <ProjectMark name={c.project} icon={c.icon} size={30} /> : undefined} right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {c?.working && !all.length ? <Pill label="Working" tone="peach" /> : null}
              {all.length ? (
                <Press onPress={() => setOutputsOpen(true)} accessibilityLabel={`Outputs, ${all.length}`} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: color.sunken }}>
                  <Images color={color.text2} size={16} />
                  <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
                    {all.length}
                  </T>
                </Press>
              ) : null}
              {macChats ? (
                <Press onPress={() => setChatsOpen(true)} accessibilityLabel={`Your Mac’s chats, ${chatCount}`} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: color.sunken }}>
                  <MessagesSquare color={color.text2} size={16} />
                  {chatCount > 1 ? (
                    <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
                      {chatCount}
                    </T>
                  ) : null}
                </Press>
              ) : null}
              <More onPress={() => setMenu(true)} label="Conversation options" />
            </View>
          }
        />
        <KeyboardLift>
          {/* Where a merge stands stays in view while the conversation scrolls under it. */}
          {c?.merge ? (
            <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 }}>
              <MergeBand topic={topic} merge={c.merge} onCheck={() => setMergeOpen(true)} />
            </View>
          ) : c?.branch ? (
            // Where its branch stands (the Mac toolbar's state), unless a merge from here is under way.
            <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 }}>
              <BranchBand topic={topic} branch={c.branch} canMerge={can.branchMerge} onMerge={() => setMergeOpen(true)} />
            </View>
          ) : null}
          {/* The plan this chat writes and runs (1.15): its milestones and map are a tap away. */}
          {c?.plan ? (
            <View style={{ paddingHorizontal: 14, paddingBottom: 10, paddingTop: c.merge || c.branch ? 0 : 10 }}>
              <Press scaleTo={0.985} onPress={() => router.push(`/plan/${c.plan!.topic.slice('plan:'.length)}`)} accessibilityLabel={`Open the plan ${c.plan.title}`}>
                <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
                  <IconBadge Icon={MapIcon} tone="lavender" size={28} />
                  <View style={{ flex: 1 }}>
                    <T v="callout" c={color.text} numberOfLines={1} style={{ fontWeight: '700' }}>
                      {c.plan.title}
                    </T>
                    <T v="caption" numberOfLines={1}>
                      {c.plan.milestones ? `${c.plan.milestones} ${c.plan.milestones === 1 ? 'milestone' : 'milestones'} · ${c.plan.done} of ${c.plan.total} tasks` : 'Your agent is writing the plan'}
                    </T>
                  </View>
                  <Pill label={c.plan.state} tone={toneOf(c.plan.state)} />
                  <ChevronRight color={color.text3} size={16} />
                </Card>
              </Press>
            </View>
          ) : null}
          {/* Its sub-agents at work stay in view, wherever their turn is (BLG-110). */}
          <AgentStrip turns={turns} onOpen={setAgent} />
          <ScrollView
            ref={scroll}
            onContentSizeChange={follow}
            onScroll={(e) => {
              onScroll(e);
              const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
              atEnd.current = contentOffset.y + layoutMeasurement.height > contentSize.height - 80;
            }}
            scrollEventThrottle={64}
            contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 18, gap: 14 }}
            keyboardDismissMode="interactive"
          >
            {c?.more ? (
              <Press
                onPress={() => void older()}
                style={{ alignSelf: 'center', paddingHorizontal: 14, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: color.sunken }}
              >
                <T v="caption" c={color.text2}>
                  {olderBusy ? 'Loading…' : 'Earlier messages'}
                </T>
              </Press>
            ) : null}
            {!c ? <T v="callout" style={{ textAlign: 'center', marginTop: 40 }}>Opening the conversation…</T> : null}
            {c && isMacTopic(topic) && !turns.length && !pending.length ? <MacStarters topic={topic} {...where} /> : null}
            {turns.map((t, i) => (
              <Animated.View key={t.id} entering={i > turns.length - 3 ? FadeIn.duration(180) : undefined}>
                {t.dialogue ? (
                  <DialogueTurn d={t.dialogue} />
                ) : t.who === 'you' ? (
                  <YourTurn t={t} chatLinks={c?.chatLinks === true} chips={chipsOf(t)} onLongPress={t.steer?.waiting === 'next_step' ? () => setUnread(t) : t.edit && canEdit ? () => setEditing(t) : reactPress(t)} />
                ) : t.who === 'friend' && reactPress(t) ? (
                  <Press onLongPress={reactPress(t)} haptics={false} scaleTo={0.99}>
                    <ClaudeTurn t={t} all={all} onAgent={setAgent} topic={topic} runtime={c?.agent?.runtime} chatLinks={c?.chatLinks === true} chips={chipsOf(t)} />
                  </Press>
                ) : (
                  <ClaudeTurn t={t} all={all} onAgent={setAgent} topic={topic} runtime={c?.agent?.runtime} chatLinks={c?.chatLinks === true} chips={chipsOf(t)} />
                )}
              </Animated.View>
            ))}
            {pending.map((p) => (
              <Animated.View key={p.id} entering={FadeIn.duration(180)}>
                <PendingTurn s={p} />
              </Animated.View>
            ))}
            {needs.map((n) => (
              <Animated.View key={n.id} entering={FadeIn.duration(180)}>
                <Card style={{ padding: 16, gap: 14 }}>
                  <NeedFace item={n} more  />
                  <NeedButtons item={n} onAnswer={(t) => answer(n, t)} />
                </Card>
              </Animated.View>
            ))}
          </ScrollView>
          {c?.terminal ? <TerminalBand label={c.terminal.label} onTakeOver={() => void call(calls.takeOver(topic)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }))} /> : null}
          <Composer
            {...(refill ? { refill } : {})}
            placeholder={c?.waiting ?? (c?.working ? 'What’s next for your agent…' : 'Reply to your agent…')}
            working={c?.working}
            // The room: "@codex", "@bob:codex" as you type @ (BLG-520).
            {...(c?.tags?.length ? { tags: c.tags } : {})}
            disabled={away ?? (c?.terminal ? `${c.terminal.label}’s terminal on your Mac has this conversation: Take Over to write here.` : c && !c.canSend ? 'You can read this conversation, not write in it.' : undefined)}
            photos={!on}
            onSend={(text, photos) => {
              atEnd.current = true;
              // Photos go up first (`put`), then the message names them; on the Mac it waits its
              // turn while Claude works, as a queued message does.
              if (photos.length) return sends.message(topic, text, async () => calls.send(topic, text, await Promise.all(photos.map(upload))), { photo: true });
              // While Claude works, Send queues (after), as on the Mac; Steer is a long-press away.
              const msg = c?.working && !topic.startsWith('conv:task:') ? calls.queue(topic, text) : calls.send(topic, text);
              sends.message(topic, text, msg, where);
            }}
            onSteer={
              topic.startsWith('conv:task:')
                ? undefined
                : (text) => {
                    atEnd.current = true;
                    sends.message(topic, text, calls.steer(topic, text), where);
                  }
            }
            onStop={() => void call(askedTask ? calls.cancelTask(askedTask) : calls.stop(topic))}
            bottom={insets.bottom}
            above={
              c?.queue?.length ? (
                <QueueTray
                  queue={c.queue}
                  onSteer={(qid) => void call(calls.steerQueued(qid)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }))}
                  onRemove={(qid) => void call(calls.unqueue(qid)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }))}
                />
              ) : null
            }
          />
        </KeyboardLift>
        <SubAgentSheet topic={topic} turn={agent ? c?.turns.find((t) => t.subagents?.some((a) => a.id === agent.id))?.id : undefined} agent={liveAgent} onClose={() => setAgent(undefined)} />
        <Sheet
          visible={outputsOpen}
          onDismiss={() => setOutputsOpen(false)}
          header={
            <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconBadge Icon={Images} tone="sky" size={32} />
              <View style={{ flex: 1 }}>
                <T v="title" style={{ fontSize: 20 }}>
                  Outputs
                </T>
                <T v="caption">Screenshots, logs, reports and scratch files from this worktree</T>
              </View>
            </View>
          }
        >
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}>
            <OutputGrid items={all} cols={3} />
          </ScrollView>
        </Sheet>
        {c?.mergeable ? <MergeSheet topic={topic} visible={mergeOpen} onClose={() => setMergeOpen(false)} /> : null}
        <EditPromptSheet turn={editing} onClose={() => setEditing(undefined)} />
        <ThreadsSheet threadFamily={c?.threadFamily} visible={threadsOpen} onClose={() => setThreadsOpen(false)} />
        <Options
          visible={Boolean(reacting)}
          onClose={() => setReacting(undefined)}
          head={
            reacting ? (
              <QuickReactions
                quick={c?.quick}
                reactions={reacting.reactions}
                onPick={(e, on) => {
                  const t = reacting;
                  setReacting(undefined);
                  react(t, e, on);
                }}
              />
            ) : undefined
          }
          options={[]}
        />
        <AgentPickerSheet topic={topic} picker={c?.agent} visible={picking} onClose={() => setPicking(false)} />
        <Options
          visible={Boolean(unread)}
          onClose={() => setUnread(undefined)}
          title="Your agent hasn't read this yet"
          options={[
            {
              Icon: Send,
              label: 'Send now',
              sub: 'Stops your agent’s current step so it reads this next',
              tone: 'peach',
              onPress: () => {
                const request = unread?.steer?.request;
                if (request) void call(calls.steerNow(request)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
              },
            },
            {
              Icon: Undo2,
              label: 'Cancel',
              sub: 'Takes it back before your agent reads it; its words go back in the box',
              tone: 'rose',
              hidden: !supportsCancel,
              onPress: () => {
                const request = unread?.steer?.request;
                if (!request) return;
                void call(calls.cancelSteer(request))
                  .then((r) => {
                    const back = r as { cancelled?: boolean; prompt?: string } | undefined;
                    if (back?.cancelled && back.prompt) setRefill({ text: back.prompt, key: Date.now() });
                  })
                  .catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
              },
            },
          ]}
        />
        <Options
          visible={menu}
          onClose={() => setMenu(false)}
          title={c?.title}
          options={[
            { Icon: c?.agent ? markIcon(runtimeMark(c.agent.runtime)) : Bot, label: `Agent · ${c?.agent?.label ?? ''}`, sub: 'Pick the agent and model for this conversation', tone: 'lavender', hidden: !can.agentPicker, onPress: () => setPicking(true) },
            { Icon: Plus, label: 'New chat', sub: 'A fresh chat with your Mac, a new tab there too', tone: 'sky', hidden: !macChats, onPress: () => newMacChat((h) => router.replace(h as never)) },
            { Icon: Square, label: askedTask ? 'Stop asking' : 'Stop the agent', tone: 'rose', hidden: !c?.working, onPress: () => void call(askedTask ? calls.cancelTask(askedTask) : calls.stop(topic)) },
            { Icon: Network, label: 'Threads', sub: threadsSummary(c?.threadFamily), tone: 'lavender', hidden: !c?.threadFamily, onPress: () => setThreadsOpen(true) },
            { Icon: Images, label: 'Outputs', sub: all.length ? `${all.length} from this worktree` : 'Nothing yet', tone: 'sky', hidden: !all.length, onPress: () => setOutputsOpen(true) },
            { Icon: GitMerge, label: 'Merge…', sub: 'Into your main folder, checked first', tone: 'lavender', hidden: !can.merge, onPress: () => setMergeOpen(true) },
            { Icon: FolderTree, label: 'Files', sub: 'Browse and read this worktree, read only', tone: 'sky', hidden: !can.files, onPress: () => router.push({ pathname: '/files', params: { topic, name: c?.title ?? 'Worktree' } }) },
            { Icon: SquareTerminal, label: 'Terminal', sub: 'The same terminal as on your Mac', tone: 'lavender', hidden: !can.terminal, onPress: () => router.push({ pathname: '/terminal', params: { topic, title: c?.title ?? '' } }) },
            { Icon: History, label: 'Earlier messages', tone: 'sky', hidden: !c?.more, onPress: () => void older() },
            { Icon: Monitor, label: 'Open on your Mac', sub: 'Code, changes and the full history', tone: 'plain', hidden: !can.openOnMac, onPress: () => void openOnMac({ topic }) },
            { Icon: Trash2, label: 'Delete this chat', sub: 'For good, here and on your Mac', tone: 'rose', hidden: !macChats, onPress: () => setDeleting(true) },
            {
              Icon: Trash2,
              label: 'Remove',
              sub: c?.working ? 'Stops asking, then takes it off your lists' : 'Takes it off your lists, here and on your Mac',
              tone: 'rose',
              hidden: !can.forget,
              onPress: () => void call(calls.forgetTask(askedTask!)).then(() => (router.canGoBack() ? router.back() : router.replace('/' as never))),
            },
          ]}
        />
        {macChats ? (
          <>
            <MacChatsSheet visible={chatsOpen} onClose={() => setChatsOpen(false)} current={topic} />
            <DeleteMacChat topic={deleting ? topic : undefined} onClose={() => setDeleting(false)} after={() => (router.canGoBack() ? router.back() : router.replace('/' as never))} />
          </>
        ) : null}
      </Screen>
    </OutputsTopic.Provider>
  );
}

/** Your message. Steered into Claude's turn and not read yet: dimmed, with a clock (long-press: Send now, or Cancel from 1.43); else long-press edits it (1.28). */
function YourTurn({ t, chatLinks, onLongPress, chips }: { t: TurnView; chatLinks: boolean; onLongPress?: (() => void) | undefined; chips?: React.ReactNode }) {
  const waiting = t.steer?.waiting;
  // A chat you named is its chip, as on the Mac (BLG-306); an older Mac's words stay words. With the Mac's chat links off: its title, no chip.
  const chats = useSupports('chatLinks') && chatLinks;
  const prose = chats ? t.prose : { ...t.prose, text: chatMentionsAsTitles(t.prose.text) };
  return (
    <Press onLongPress={onLongPress} disabled={!onLongPress} scaleTo={0.99} style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
      {t.via ? (
        <T v="caption" style={{ marginBottom: 4, marginRight: 4 }}>
          {`Sent by ${t.via}`}
        </T>
      ) : null}
      <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14, opacity: waiting ? 0.6 : 1 }}>
        <Prose prose={prose} size={15} tasks chats={chats} />
      </View>
      {chips ? <View style={{ marginTop: 4 }}>{chips}</View> : null}
      {waiting ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, marginRight: 4 }}>
          <Clock color={color.text2} size={12} />
          <T v="caption">{waiting === 'stopping' ? 'Sent · your agent is stopping its step to read it' : 'Sent · your agent reads it after its current step'}</T>
        </View>
      ) : (
        <T v="caption" style={{ marginTop: 4, marginRight: 4 }}>
          {ago(t.ts)}
        </T>
      )}
    </Press>
  );
}

/** Yours, before the Mac's view has it: sending, waiting for the Mac, or not sent (Retry, Remove). */
function PendingTurn({ s }: { s: Pending }) {
  return (
    <View style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
      <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14, opacity: s.state === 'failed' ? 1 : 0.6, borderWidth: s.state === 'failed' ? 1 : 0, borderColor: color.error }}>
        <T v="body" style={{ fontSize: 15 }}>
          {s.text || 'Photo'}
        </T>
      </View>
      <SendStatus s={s} />
    </View>
  );
}

/** 1.34 (BLG-466): where a dialogue between agents begins: what it's about, how far it is, and Stop / Continue. */
function DialogueTurn({ d }: { d: NonNullable<TurnView['dialogue']> }) {
  const act = (call: ReturnType<typeof calls.dialogueStop>): void => void store.call(call).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  return (
    <Card style={{ padding: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <MessagesSquare color={color.text2} size={15} />
        <T v="caption" c={color.text} style={{ fontWeight: '700' }}>
          {d.mode}
        </T>
        <T v="caption" style={{ flex: 1 }} numberOfLines={1}>
          {d.who}
        </T>
      </View>
      <T v="callout" c={color.text}>
        {d.topic}
      </T>
      <T v="caption">{[d.progress, d.budget, d.status].filter(Boolean).join(' · ')}</T>
      {d.canStop || d.canContinue ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {d.canContinue ? (
            <Press onPress={() => act(calls.dialogueContinue(d.id))} style={{ paddingHorizontal: 14, height: 32, borderRadius: 16, justifyContent: 'center', backgroundColor: color.sunken }}>
              <T v="caption" c={color.text} style={{ fontWeight: '600' }}>
                Continue
              </T>
            </Press>
          ) : null}
          {d.canStop ? (
            <Press onPress={() => act(calls.dialogueStop(d.id))} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: color.sunken }}>
              <OctagonX color={color.text2} size={14} />
              <T v="caption" c={color.text} style={{ fontWeight: '600' }}>
                Stop
              </T>
            </Press>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** A message from an agent in another chat (1.45): a card with its source, never your bubble. */
function FromChatCard({ origin, topic, turn, chats }: { origin: NonNullable<TurnView['origin']>; topic: Topic; turn: string; chats: boolean }) {
  const on = useSupports('chatLinks');
  const ref = parseChatRef(origin.ref);
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.code }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <T v="caption" style={{ fontWeight: '600' }}>
          From
        </T>
        {on && ref ? <InlineThing el={{ kind: 'chat', ref }} /> : <T v="caption">{origin.title}</T>}
        <T v="caption">· {origin.agent}, an agent</T>
      </View>
      <Prose prose={origin.prose} at={{ topic, turn }} chats={chats} />
    </View>
  );
}

/** An agent's turn, under its name with its mark (BLG-498: the agent the Mac sends; an older Mac's, by the name, else the conversation's runtime). */
function ClaudeTurn({ t, all, onAgent, topic, runtime, chatLinks, chips }: { t: TurnView; all: OutputView[]; onAgent: (a: SubAgentView) => void; topic: Topic; runtime?: string | undefined; chatLinks: boolean; chips?: React.ReactNode }) {
  // A chat it names by its ref is the chat's chip, as on the Mac; with the Mac's chat links off, words as before.
  const chats = useSupports('chatLinks') && chatLinks;
  const working = t.status === 'working';
  const outs = t.outputs ?? [];
  const mins = t.endTs ? Math.max(1, Math.round((t.endTs - t.ts) / 60000)) : undefined;
  // No card around Claude's answer: it takes the screen's full width, your bubbles sit on the right.
  return (
    <View style={{ gap: 12, paddingTop: 2 }}>
      {t.origin ? <FromChatCard origin={t.origin} topic={topic} turn={t.id} chats={chats} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <Avatar name={t.name} size={26} {...(t.who === 'claude' ? { mark: t.agent ? agentMark(t.agent) : markOfName(t.name, runtime) } : {})} />
        <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
          {t.name}
        </T>
        <T v="caption" style={{ flex: 1 }} numberOfLines={1}>
          {t.via ? `Sent by ${t.via}${t.steps || mins ? ' · ' : ''}` : ''}
          {t.steps ? `${t.steps} ${t.steps === 1 ? 'step' : 'steps'}` : ''}
          {mins ? ` · ${mins} min` : ''}
        </T>
        <T v="caption">{ago(t.ts)}</T>
      </View>
      {t.prose.text ? <Prose prose={t.prose} at={{ topic, turn: t.id }} tasks chats={chats} /> : null}
      {chips}
      {working ? <LivePanel t={t} /> : <StepsFold t={t} />}
      {t.subagents?.length ? (
        working || t.subagents.length <= 3 ? (
          <AgentList agents={t.subagents} onOpen={onAgent} />
        ) : (
          <View style={{ gap: 8 }}>
            <T v="caption" style={{ fontWeight: '600' }}>
              {t.subagents.length} sub-agents
            </T>
            <AgentChips agents={t.subagents} onOpen={onAgent} />
          </View>
        )
      ) : null}
      {outs.length ? (
        <Animated.View entering={FadeIn}>
          <TurnOutputs items={outs} />
        </Animated.View>
      ) : null}
      {t.status === 'failed' || t.status === 'stopped' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {t.status === 'failed' ? <CircleX color={color.error} size={14} /> : <OctagonX color={color.text2} size={14} />}
          <T v="caption" c={t.status === 'failed' ? color.error : color.text2}>
            {t.status === 'failed' ? 'Failed' : 'Stopped'}
          </T>
        </View>
      ) : null}
      {t.resumesAt ? (
        // 1.42 (BLG-757): stopped on your usage limit; Beluga tells it to continue once the limit resets.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Clock color={color.text2} size={14} />
          <T v="caption" c={color.text2}>
            Continues on its own at {resetWords(t.resumesAt)}
          </T>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The Mac's terminal view drives this conversation (1.36, BLG-534): what you'd send here waits,
 * and Take Over gives it back to the chat (the terminal on the Mac closes, what was said there is here).
 */
function TerminalBand({ label, onTakeOver }: { readonly label: string; readonly onTakeOver: () => void }) {
  return (
    <Card tone="lavender" style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <IconBadge Icon={SquareTerminal} tone="lavender" size={30} />
      <T v="caption" style={{ flex: 1 }}>{`${label}’s terminal on your Mac is driving this conversation.`}</T>
      <Press onPress={onTakeOver} accessibilityRole="button" accessibilityLabel="Take over" style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: color.card }}>
        <T v="caption" style={{ fontWeight: '600' }}>Take Over</T>
      </Press>
    </Card>
  );
}
