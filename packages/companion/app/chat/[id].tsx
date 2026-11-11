import { useLocalSearchParams } from 'expo-router';
import { KeyboardLift } from '../../components/KeyboardLift';
import { ArrowLeftRight, Clock, Eraser, Lock, Pencil, SquareTerminal, Trash2, TriangleAlert, X } from 'lucide-react-native';
import { AskClaudePicker, type AskTarget, askTargets } from '../../components/AskClaudePicker';
import { agentBadge, agentLabel } from '../../../../src/shared/agent-label';
import { type AgentMark, AgentMarkIcon, agentMark, modelMark } from '../../components/AgentMark';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet as RNStyleSheet, TextInput, View } from 'react-native';
import Animated, { LinearTransition, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../components/Composer';
import { SendStatus } from '../../components/SendStatus';
import { Thumb } from '../../components/Outputs';
import { TaskWords } from '../../components/render/TaskChip';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Options } from '../../components/Options';
import { QuickReactions, ReactionChips } from '../../components/Reactions';
import { Sheet } from '../../components/Sheet';
import { Avatar, Button, More, Press, T, haptic, hueOf, toneBg, toneInk } from '../../components/ui';
import { ago, useSupports, useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { ChatMemberView, ChatMessageView, ChatView, OutputView, Topic } from '../../lib/link/protocol';
import { upload } from '../../lib/pick';
import { runOf } from '../../lib/chat-runs';
import { useUnreadOnOpen } from '../../lib/chat-unread';
import { unreadLine } from '../../../../src/shared/unread';
import { sends, useSends } from '../../lib/sends';
import { store } from '../../lib/store';
import { color, ink, tint } from '../../lib/theme';

/**
 * A chat with friends, as a messaging app (BLG-210): your words on the right in your pastel, a
 * friend's on the left in theirs (their name above a run, their picture at its end), a Claude's
 * answer and a task's card full width under "<owner>'s Claude". Above: each person and their
 * Claude, and what waits on whom.
 */
export default function Chat() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `chat:${decodeURIComponent(id ?? '')}` as Topic;
  const view = useView<ChatView>(topic);
  const c = view?.data;
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  /** Where each task's card sits in the list (for the waiting band to scroll to it). */
  const cards = useRef<Record<string, number>>({});
  const [ask, setAsk] = useState<AskTarget | undefined>();
  const [picking, setPicking] = useState(false);
  /** What you sent that the Mac's view doesn't show yet. */
  const pending = useSends(topic);
  const targets = askTargets(c?.members, c?.kind ?? 'dm', c?.name ?? '');
  const pics: OutputView[] = c?.messages.flatMap((m) => (m.files ?? []).filter((f) => f.kind === 'image')) ?? [];
  const meName = c?.members?.find((m) => m.me)?.name;
  // 1.30 (BLG-429): in a direct chat, long-press a message to delete it (or edit your own); Clear chat in the •••.
  const changes = useSupports('chatEdits') && c?.kind === 'dm';
  // 1.41 (BLG-702): long-press a message for the quick reactions; a chip under it adds or takes back yours.
  const reacts = useSupports('reactions');
  const react = (m: ChatMessageView, emoji: string, on: boolean): void => act(calls.react(topic, m.id, emoji, on));
  const [acting, setActing] = useState<ChatMessageView | undefined>();
  const [editing, setEditing] = useState<ChatMessageView | undefined>();
  const [menu, setMenu] = useState(false);
  const [clearing, setClearing] = useState(false);
  const act = (call: Parameters<typeof store.call>[0]): void => void store.call(call, { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));

  // What came in since you last read it is marked (BLG-574), so it's read only once that's known.
  const { unread, ready } = useUnreadOnOpen(topic, view);
  const firstUnread = c?.messages.find((m) => unread.has(m.id))?.id;
  const lastUnread = c?.messages.findLast((m) => unread.has(m.id))?.id;
  /** The first scroll to the end jumps (the chat opens at the bottom); later ones glide. */
  const landed = useRef(false);

  useEffect(() => {
    if (c && ready) void store.call(calls.read(topic), { queue: false }).catch(() => undefined);
  }, [c?.messages.length, ready]);

  return (
    <Screen>
      <Header
        scrolled={scrolled}
        back
        title={c?.name ?? 'Chat'}
        eyebrow={c?.kind === 'group' ? 'Channel' : c?.live.length ? 'Here now' : 'Direct message'}
        at={view?.at}
        right={changes ? <More onPress={() => setMenu(true)} label="Chat options" /> : undefined}
      />
      {c?.members?.some((m) => m.claude) ? <People members={c.members} /> : null}
      {c?.waiting?.length ? <Waiting items={c.waiting} onPick={(task) => task && cards.current[task] !== undefined && scroll.current?.scrollTo({ y: Math.max(0, cards.current[task]! - 24), animated: true })} /> : null}
      <KeyboardLift>
        <ScrollView onScroll={onScroll} scrollEventThrottle={32} ref={scroll} onContentSizeChange={() => {
            scroll.current?.scrollToEnd({ animated: landed.current });
            landed.current = true;
          }} contentContainerStyle={{ padding: 14, gap: 4 }}>
          {c?.messages.map((m, i) => {
            const run = runOf(c.messages, i);
            return (
              <Fragment key={m.id}>
                {m.id === firstUnread ? <UnreadLine count={unread.size} /> : null}
                <Animated.View
                  entering={i > c.messages.length - 3 ? FadeIn.duration(180) : undefined}
                  onLayout={m.task ? (e) => (cards.current[m.task!.id] = e.nativeEvent.layout.y) : undefined}
                  style={unread.has(m.id) ? unreadBand(m.id === firstUnread, m.id === lastUnread) : undefined}
                >
                  <Press onLongPress={changes || reacts ? () => (haptic.commit(), setActing(m)) : undefined} disabled={!changes && !reacts} haptics={false}>
                    <Bubble
                      m={m}
                      first={run.first}
                      last={run.last}
                      group={c.kind === 'group'}
                      pics={pics}
                      me={meName}
                      chips={m.reactions?.length ? <ReactionChips reactions={m.reactions} mine={m.mine && !m.claude && !m.task} onToggle={(e, on) => react(m, e, on)} onWho={(text) => store.toast({ text, tone: 'info' })} /> : null}
                    />
                  </Press>
                </Animated.View>
              </Fragment>
            );
          })}
          {pending.map((p) => (
            <Animated.View key={p.id} entering={FadeIn.duration(180)} style={{ alignItems: 'flex-end', marginTop: 6 }}>
              <View style={{ maxWidth: '78%', paddingVertical: 9, paddingHorizontal: 13, borderRadius: 19, borderBottomRightRadius: 6, backgroundColor: color.sunken, opacity: p.state === 'failed' ? 1 : 0.6, borderWidth: p.state === 'failed' ? 1 : 0, borderColor: color.error }}>
                <T v="body" c={color.text} style={{ fontSize: 15.5 }}>
                  {p.text || 'Photo'}
                </T>
              </View>
              <SendStatus s={p} />
            </Animated.View>
          ))}
        </ScrollView>
        {ask ? (
          <Animated.View entering={FadeIn.duration(180)} style={{ flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 2 }}>
            <Press onPress={() => setPicking(true)} accessibilityLabel={`Ask: ${ask.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 15, backgroundColor: tint.peach }}>
              <SquareTerminal color={ink.peach} size={14} />
              <T v="caption" c={ink.peach} style={{ fontWeight: '700' }}>
                Ask: {ask.label}
              </T>
              <Press onPress={() => setAsk(undefined)} accessibilityLabel="Don't ask an agent" hitSlop={8} style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
                <X color={ink.peach} size={14} />
              </Press>
            </Press>
          </Animated.View>
        ) : null}
        {c?.note ? (
          <T v="caption" c={color.text3} style={{ textAlign: 'right', paddingHorizontal: 18, paddingBottom: 2, fontSize: 12 }} numberOfLines={1}>
            {c.note}
          </T>
        ) : null}
        <Composer
          placeholder={ask ? `Ask ${ask.label}…` : `Message ${c?.name ?? ''}`}
          bottom={insets.bottom}
          photos
          onSend={(text, photos) => {
            const opts = ask ? { ask: ask.ask } : {};
            // Photos go up first (`put`), then the message names them (lib/sends.ts); shown at once as yours.
            if (photos.length) sends.message(topic, text, async () => calls.chat(topic, text, { ...opts, files: await Promise.all(photos.map(upload)) }), { photo: true });
            else sends.message(topic, text, calls.chat(topic, text, opts));
            setAsk(undefined);
          }}
          // Behind the + with the photo; who's asked shows in the pill above. The Claude mark, as on the Mac.
          more={[{ Icon: SquareTerminal, label: 'Ask: your agent', sub: 'An agent here answers in the chat', tone: 'peach', onPress: () => setPicking(true) }]}
        />
      </KeyboardLift>
      <Options
        visible={Boolean(acting)}
        onClose={() => setActing(undefined)}
        head={
          reacts && acting && !acting.task ? (
            <QuickReactions
              quick={c?.quick}
              reactions={acting.reactions}
              onPick={(e, on) => {
                const m = acting;
                setActing(undefined);
                react(m, e, on);
              }}
            />
          ) : undefined
        }
        options={[
          { Icon: Pencil, label: 'Edit', sub: `${c?.name ?? 'They'} sees it marked edited`, tone: 'sky', hidden: !changes || !acting?.editable, onPress: () => setEditing(acting) },
          { Icon: Trash2, label: 'Delete for everyone', sub: `From your Mac and ${c?.name ?? 'theirs'}’s`, tone: 'rose', hidden: !changes || !acting?.mine, onPress: () => acting && act(calls.deleteMessage(topic, acting.id, true)) },
          { Icon: Trash2, label: 'Delete for you', sub: acting?.mine ? 'From your Mac only' : `${c?.name ?? 'They'} still has it`, tone: 'rose', hidden: !changes, onPress: () => acting && act(calls.deleteMessage(topic, acting.id, false)) },
        ]}
      />
      <EditMessage m={editing} topic={topic} onClose={() => setEditing(undefined)} />
      <Options visible={menu} onClose={() => setMenu(false)} title={c?.name} options={[{ Icon: Eraser, label: 'Clear chat', sub: 'Every message goes from your Mac', tone: 'rose', onPress: () => setClearing(true) }]} />
      <Options
        visible={clearing}
        onClose={() => setClearing(false)}
        title="This can’t be undone"
        options={[{ Icon: Eraser, label: 'Clear chat', sub: `${c?.name ?? 'Your friend'} keeps their copy`, tone: 'rose', onPress: () => act(calls.clearChat(topic)) }]}
      />
      <AskClaudePicker visible={picking} onClose={() => setPicking(false)} targets={targets} chosen={ask} onPick={setAsk} members={c?.members} />
    </Screen>
  );
}

/** Your message, opened to change its words: your friend sees it marked edited. */
function EditMessage({ m, topic, onClose }: { m: ChatMessageView | undefined; topic: Topic; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (m) setText(m.text);
  }, [m?.id]);
  const save = async (): Promise<void> => {
    if (!m || busy || !text.trim()) return;
    if (text.trim() === m.text.trim()) return onClose();
    haptic.commit();
    setBusy(true);
    try {
      await store.call(calls.editMessage(topic, m.id, text.trim()), { queue: false });
      onClose();
    } catch (e) {
      store.toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={Boolean(m)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <T v="title" style={{ fontSize: 20 }}>
            Edit your message
          </T>
        </View>
      }
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}>
        <TextInput
          autoFocus
          value={text}
          onChangeText={setText}
          multiline
          editable={!busy}
          accessibilityLabel="Edit your message"
          placeholderTextColor={color.text3}
          style={{ color: color.text, fontSize: 17, lineHeight: 24, minHeight: 72, maxHeight: 220, textAlignVertical: 'top', padding: 12, borderRadius: 14, backgroundColor: color.sunken, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
        />
        <Button label={busy ? 'Saving…' : 'Save'} Icon={Pencil} disabled={busy || !text.trim()} onPress={() => void save()} />
      </View>
    </Sheet>
  );
}

/** Each person here and what their Claude is doing: "You · working", "ata · offline · 1.1". */
function People({ members }: { members: readonly ChatMemberView[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, backgroundColor: color.bg }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
      {members.slice(0, 12).map((m) => (
        <View key={m.peerId} accessibilityLabel={`${m.me ? 'You' : m.name}: ${m.presence ?? ''}, agent ${m.claude ?? ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingLeft: 3, paddingRight: 10, borderRadius: 14, backgroundColor: color.card, borderWidth: 0.5, borderColor: color.hairline }}>
          <Avatar name={m.name} size={22} {...(m.presence ? { presence: m.presence } : {})} />
          <T v="caption" c={color.text} style={{ fontWeight: '700' }}>
            {m.me ? 'You' : m.name}
          </T>
          {m.claude === 'working' || m.claude === 'idle' ? <SquareTerminal color={toneInk(hueOf(m.name))} size={12} /> : m.claude && /update/.test(m.claude) ? <TriangleAlert color={color.warn} size={12} /> : null}
          {m.claude ? (
            <T v="caption" c={m.claude.startsWith('offline') ? color.text3 : color.text2} style={{ fontSize: 12 }}>
              {m.claude}
            </T>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

/** What waits here, under the header: on you (butter), on someone else (plain); a tap goes to its card. */
function Waiting({ items, onPick }: { items: NonNullable<ChatView['waiting']>; onPick: (task: string | undefined) => void }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6, backgroundColor: color.bg, borderBottomWidth: 0.5, borderBottomColor: color.hairline }}>
      {items.slice(0, 3).map((w, i) => {
        const Icon = w.you ? TriangleAlert : Clock;
        return (
          <Press key={`${w.task ?? i}:${w.text}`} onPress={() => onPick(w.task)} accessibilityLabel={w.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 12, borderRadius: 10, backgroundColor: w.you ? tint.butter : color.card }}>
            <Icon color={w.you ? ink.butter : color.text2} size={14} />
            <T v="caption" c={w.you ? ink.butter : color.text2} style={{ flex: 1, fontWeight: '600' }} numberOfLines={1}>
              {w.text}
            </T>
          </Press>
        );
      })}
    </View>
  );
}

const TONE = { claude: 'claude', ok: 'ok', warn: 'warn', error: 'error', info: 'info' } as const;

/** A task between two people's Claudes (BLG-208): who asks whom, where it is, and what came back. A secret's card is soft red. */
function TaskCard({ task }: { task: NonNullable<ChatMessageView['task']> }) {
  const tone = TONE[task.tone as keyof typeof TONE] ?? 'info';
  return (
    <View style={{ padding: 12, gap: 6, borderRadius: 18, backgroundColor: task.secret ? tint.rose : color.card, borderWidth: task.secret ? 1 : 0.5, borderColor: task.secret ? color.error : color.hairline }}>
      {task.secret ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Lock color={color.error} size={13} />
          <T v="caption" c={color.error}>
            A secret · approved on its own, each time
          </T>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ArrowLeftRight color={color.claude} size={15} />
        <T v="caption" c={color.text} style={{ fontWeight: '700', flex: 1 }} numberOfLines={1}>
          {task.title}
        </T>
        <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, backgroundColor: tint[tone] }}>
          <T v="caption" c={color[tone]} style={{ fontSize: 11, fontWeight: '700' }} numberOfLines={1}>
            {task.state}
          </T>
        </View>
      </View>
      <T v="body" c={color.text2} style={{ fontSize: 14 }} numberOfLines={3}>
        {task.ask}
      </T>
      {task.summary ? (
        <T v="body" c={color.text} style={{ fontSize: 14 }} numberOfLines={6}>
          {task.summary}
        </T>
      ) : null}
      {task.files?.length ? (
        <T v="caption" c={color.text2}>
          {task.files.join(' · ')}
        </T>
      ) : null}
    </View>
  );
}

/**
 * Full width under "<owner>'s Codex": an agent's answer, or a task's card. The avatar wears the
 * agent's mark (BLG-497), the badge its model maker's beside the model's name.
 */
function ClaudeRow({ owner, label, badge, mark, badgeMark, first, children }: { owner: string; label: string; badge?: string | undefined; mark?: AgentMark | undefined; badgeMark?: AgentMark | undefined; first: boolean; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: first ? 12 : 0 }}>
      <View style={{ width: 30 }}>{first ? <Avatar name={owner} size={30} claude {...(mark ? { mark } : {})} owner={owner} /> : null}</View>
      <View style={{ flex: 1, gap: 4 }}>
        {first ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T v="caption" c={toneInk(hueOf(owner))} style={{ fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
              {label}
            </T>
            {/* Which runtime and model answered ("GPT-5"), as on the Mac: a quiet pill. */}
            {badge ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderRadius: 8, backgroundColor: color.card, borderWidth: 0.5, borderColor: color.hairline }}>
                {badgeMark ? <AgentMarkIcon mark={badgeMark} size={10} color={color.text2} /> : null}
                <T v="caption" c={color.text2} style={{ fontSize: 11 }}>
                  {badge}
                </T>
              </View>
            ) : null}
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

/** Where what came in since you last read starts (BLG-574), as on the Mac: the accent, quiet. */
function UnreadLine({ count }: { count: number }) {
  const rule = { flex: 1, height: 1, backgroundColor: `${color.info}59` } as const;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, marginBottom: 2 }} accessibilityRole="text">
      <View style={rule} />
      <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
        {unreadLine(count)}
      </T>
      <View style={rule} />
    </View>
  );
}

/** The soft band under unread messages, edge to edge and unbroken by the list's gaps. */
const unreadBand = (first: boolean, last: boolean) => ({ backgroundColor: `${color.info}12`, marginHorizontal: -14, paddingHorizontal: 14, ...(first ? { paddingTop: 4 } : {}), ...(last ? { paddingBottom: 8 } : { paddingBottom: 4, marginBottom: -4 }) });

function Bubble({ m, first, last, group, pics, me, chips }: { m: ChatMessageView; first: boolean; last: boolean; group: boolean; pics: OutputView[]; me?: string | undefined; chips?: React.ReactNode }) {
  const mine = m.mine;
  const files = m.files ?? [];
  if (m.task) {
    return (
      <ClaudeRow owner={m.from} label={m.task.who ?? m.from} first>
        <TaskCard task={m.task} />
      </ClaudeRow>
    );
  }
  if (m.claude) {
    // An older Mac names it "mia’s Claude"; now "mia’s Codex" too: the owner is before the ’s.
    const owner = m.from.replace(/['’]s [^’']+$/, '');
    return (
      <ClaudeRow owner={mine && me ? me : owner} label={agentLabel(m.agent, owner, mine, { capital: mine })} badge={agentBadge(m.agent)} mark={agentMark(m.agent)} badgeMark={m.agent?.model ? modelMark(m.agent.model, m.agent.runtime) : undefined} first={first}>
        {files.map((f) => (
          <Thumb key={f.ref} o={f} group={pics} w={f.kind === 'image' ? 220 : 200} h={f.kind === 'image' ? 170 : 92} style={{ borderRadius: 18 }} />
        ))}
        {m.text ? (
          <T v="body" c={color.text} style={{ fontSize: 15.5 }}>
            {m.text}
          </T>
        ) : null}
        {m.offer ? <Offer offer={m.offer} name={owner} /> : null}
        {chips}
      </ClaudeRow>
    );
  }
  // Theirs on a card with a hairline, yours a quiet grey: told apart by side and tone, not a hue each.
  const bg = mine ? color.sunken : color.card;
  return (
    <View style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 8, marginTop: first ? 10 : 0 }}>
      {!mine ? <View style={{ width: 30 }}>{last ? <Avatar name={m.from} size={30} /> : null}</View> : null}
      <View style={{ maxWidth: '78%', alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
        {!mine && first && group ? (
          <T v="caption" c={color.text2} style={{ fontWeight: '700', marginLeft: 4 }}>
            {m.from}
          </T>
        ) : null}
        {files.map((f) => (
          <Thumb key={f.ref} o={f} group={pics} w={f.kind === 'image' ? 220 : 200} h={f.kind === 'image' ? 170 : 92} style={{ borderRadius: 18 }} />
        ))}
        {m.text ? (
          <View
            style={{
              paddingVertical: 9,
              paddingHorizontal: 13,
              borderRadius: 19,
              borderBottomRightRadius: mine ? (last ? 5 : 8) : 19,
              borderBottomLeftRadius: mine ? 19 : last ? 5 : 8,
              backgroundColor: bg,
              ...(mine ? {} : { borderWidth: RNStyleSheet.hairlineWidth, borderColor: color.hairlineStrong }),
            }}
          >
            <T v="body" c={color.text} style={{ fontSize: 15.5 }}>
              {/* Task keys as chips in your own messages only: a friend's key may be on their board (BLG-109). */}
              {mine ? <TaskWords text={m.text} /> : m.text}
            </T>
          </View>
        ) : null}
        {chips}
        {last || m.edited || m.sentBy ? (
          <T v="caption" style={{ marginHorizontal: 4, fontSize: 11 }}>
            {[m.sentBy ? `Sent by ${m.sentBy}` : '', m.edited ? 'Edited' : '', last ? ago(m.ts) : '', last && m.delivery ? (m.delivery === 'seen' ? 'Seen' : 'Delivered') : ''].filter(Boolean).join(' · ')}
          </T>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A friend's Claude can't touch their Mac from the chat: what it offers to do there instead, as a
 * request to their Claude (their trust settings let it in, or they approve it). Requests shows how it goes.
 */
function Offer({ offer, name }: { offer: NonNullable<ChatMessageView['offer']>; name: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const send = (): void => {
    setState('sending');
    store
      .call(calls.request(offer.to, offer.ask, offer.needs), { queue: false })
      .then(() => setState('sent'))
      .catch(() => setState('failed'));
  };
  return (
    <View style={{ gap: 6, padding: 10, borderRadius: 16, backgroundColor: tint.peach }}>
      <T v="caption" c={ink.peach}>
        {offer.ask}
      </T>
      {state === 'sent' ? (
        <T v="caption" c={ink.peach} style={{ fontWeight: '700' }}>
          Sent to {name}’s Mac
        </T>
      ) : (
        <Press onPress={send} disabled={state === 'sending'} style={{ alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 12, backgroundColor: color.card }}>
          <T v="caption" c={color.text} style={{ fontWeight: '700' }}>
            {state === 'sending' ? 'Sending…' : state === 'failed' ? 'Couldn’t send. Try again' : `Ask on ${name}’s Mac`}
          </T>
        </Press>
      )}
    </View>
  );
}
