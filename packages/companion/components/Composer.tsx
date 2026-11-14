import { Image } from 'expo-image';
import { ArrowUp, Clock, ImagePlus, ListPlus, Navigation, Plus, Square, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { composerPlan, FIELD_LINE_HEIGHT, FIELD_PAD, fieldHeight, MAX_PHOTOS } from '../lib/composer';
import { useSupports } from '../lib/hooks';
import { pickPhoto } from '../lib/pick';
import { color, ink, spring, tint } from '../lib/theme';
import { appendSpoken } from '../lib/dictate';
import { useVoice, voiceAvailable } from '../lib/voice';
import { type Option, Options } from './Options';
import { InlineThing } from './render/Inline';
import { chatMentionsAsTitles, parseChatRef } from '../lib/render';
import { Card, haptic, Press, T } from './ui';
import { VoiceButton, VoiceNote, VoiceStage, voiceActive } from './Voice';
import { matchTags, withTag } from '../../../src/shared/agent-tags';
import { AgentMarkIcon, agentMark } from './AgentMark';
import type { ConvView } from '../lib/link/protocol';

/** The room's agent tags (BLG-520): "@codex", "@bob:codex", each with its mark. */
type Tag = NonNullable<ConvView['tags']>[number];

/** As you type "@" in the room: each agent by name with its mark, one tap puts it in the words. */
function TagChips({ tags, onPick }: { readonly tags: readonly Tag[]; readonly onPick: (tag: string) => void }) {
  if (!tags.length) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 4 }}>
        {tags.map((t) => (
          <Press key={t.tag} onPress={() => (haptic.tap(), onPick(t.tag))} accessibilityLabel={`${t.tag}: ${t.hint}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: tint.peach }}>
            <AgentMarkIcon mark={agentMark(t.agent)} size={14} color={ink.peach} />
            <T v="caption" c={ink.peach} style={{ fontWeight: '700' }}>
              {t.tag}
            </T>
          </Press>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

/**
 * Write to your Mac: a field that takes the width and grows with what you write (up to seven
 * lines, then it scrolls inside), a photo button that's there whatever you've written, and one
 * round button: Send, or Stop (rose, while Claude works and there's nothing to send). While Claude
 * works the button queues (after what it's doing, the Mac's ↩) and a long-press offers Steer (now,
 * the Mac's ⌥↩); what's queued shows above the field. Which does what: lib/composer.ts. More to
 * add than the photo (the chat's Ask Claude) folds with it into one + (a narrow phone's row fits).
 *
 * The microphone beside it (BLG-161): each pause is written down while you talk; ■ puts the words in
 * the field to edit, the round button sends them as you said them (queued, while Claude works).
 * While it listens, the + and photo step aside so the words have the width.
 */

/** A photo picked to go with the message (lib/pick.ts). */
export type Photo = NonNullable<Awaited<ReturnType<typeof pickPhoto>>>;

/** What waits for Claude here: your messages, and messages from your other chats with their source (1.46). Steer with one now, or take it out. */
export function QueueTray({ queue, onSteer, onRemove }: { readonly queue: readonly { id: string; text: string; waiting?: string; origin?: { ref: string; title: string; agent: string } }[]; readonly onSteer: (id: string) => void; readonly onRemove: (id: string) => void }) {
  if (!queue.length) return null;
  return (
    <Animated.View entering={FadeIn.duration(240)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(180)}>
      <Card r={20} style={{ paddingVertical: 6, paddingHorizontal: 6, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 2 }}>
          <Clock color={color.text3} size={13} />
          <T v="caption" style={{ fontWeight: '600', flex: 1 }}>
            Queued · {queue.length}
          </T>
          <T v="caption">{queue[0]?.waiting ? 'waiting for a free agent' : 'after what your agent is doing'}</T>
        </View>
        {queue[0]?.waiting ? (
          <View style={{ marginHorizontal: 6, marginBottom: 2, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: tint.sky }}>
            <T v="caption" c={ink.sky}>
              {queue[0].waiting}
            </T>
          </View>
        ) : null}
        {queue.map((q, i) => (
          <Animated.View key={q.id} entering={FadeIn.duration(220)} exiting={FadeOut.duration(140)} layout={LinearTransition.duration(180)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingVertical: 2 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              <T v="caption" style={{ fontSize: 11, fontWeight: '700' }}>
                {i + 1}
              </T>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T v="callout" c={color.text} numberOfLines={1}>
                {/* One line: a chat it names by its title, never its ref. */}
                {chatMentionsAsTitles(q.text)}
              </T>
              {q.origin ? <QueuedFrom origin={q.origin} /> : null}
            </View>
            <Press onPress={() => (haptic.commit(), onSteer(q.id))} accessibilityLabel="Steer with it now" style={{ height: 30, paddingHorizontal: 10, borderRadius: 15, justifyContent: 'center', backgroundColor: tint.sky }}>
              <T v="caption" c={ink.sky} style={{ fontWeight: '700' }}>
                Steer
              </T>
            </Press>
            <Press onPress={() => onRemove(q.id)} accessibilityLabel="Remove from the queue" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              <X color={color.text2} size={14} />
            </Press>
          </Animated.View>
        ))}
      </Card>
    </Animated.View>
  );
}

/** Who sent a queued message that isn't yours: the chat's chip, which opens it, and the agent. */
function QueuedFrom({ origin }: { readonly origin: { ref: string; title: string; agent: string } }) {
  const on = useSupports('chatLinks');
  const ref = parseChatRef(origin.ref);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <T v="caption">From</T>
      {/* An older Mac has no chip: the title, never the long ref. */}
      {on && ref ? <InlineThing el={{ kind: 'chat', ref }} /> : <T v="caption">{origin.title}</T>}
      <T v="caption">· {origin.agent}, an agent</T>
    </View>
  );
}

/** The photos going with the message, small, each with its ×. */
function PhotoStrip({ photos, onRemove }: { readonly photos: readonly Photo[]; readonly onRemove: (uri: string) => void }) {
  if (!photos.length) return null;
  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2 }}>
        {photos.map((p) => (
          <Animated.View key={p.uri} entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)} style={{ width: 64, height: 64 }}>
            <Image source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: color.sunken }} contentFit="cover" />
            <Press onPress={() => onRemove(p.uri)} accessibilityLabel="Remove photo" hitSlop={8} style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
              <X color={color.text2} size={13} strokeWidth={1.9} />
            </Press>
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

export function Composer({
  placeholder,
  onSend,
  onStop,
  onSteer,
  working,
  disabled,
  bottom = 0,
  more = [],
  above,
  photos: canAttach,
  tags = [],
  refill,
}: {
  readonly placeholder: string;
  /** Send (and, while Claude works, queue) what you wrote, with the photos you attached. */
  readonly onSend: (text: string, photos: readonly Photo[]) => void;
  readonly onStop?: () => void;
  /** While Claude works: Steer (now) is a long-press on the button, which then queues (after), as the Mac's composer. */
  readonly onSteer?: (text: string) => void;
  readonly working?: boolean;
  readonly disabled?: string;
  readonly bottom?: number;
  /** More to add beside the photo (the chat's Ask Claude): with it, behind one +. */
  readonly more?: readonly Option[];
  /** Above the field: what's queued. */
  readonly above?: React.ReactNode;
  /** Photos can go with a message: the photo button, there whatever you've written. */
  readonly photos?: boolean;
  /** The room's agent tags (BLG-520): offered as chips while "@…" is being typed. */
  readonly tags?: readonly Tag[];
  /** Words back in the box (a steered message you took back), ahead of what you're writing; a new `key` each time. */
  readonly refill?: { readonly text: string; readonly key: number };
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (refill?.text) setText((t) => [refill.text, t.trim()].filter(Boolean).join('\n'));
  }, [refill?.key]);
  const [h, setH] = useState(fieldHeight(0));
  const [pics, setPics] = useState<readonly Photo[]>([]);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  // What the long-press sheet sends, read when its row is tapped (after the sheet has closed).
  const now = useRef({ text: '', pics: [] as readonly Photo[] });
  now.current = { text, pics };
  const said = useRef<(words: string) => void>(() => {});
  const voice = useVoice({ text: (words) => setText((t) => appendSpoken(t, words)), send: (words) => said.current(words) });
  const speaking = voice.view.phase === 'listening' || voice.view.phase === 'writing';
  const plan = composerPlan({ working: Boolean(working), hasText: text.trim().length > 0 || speaking, photos: pics.length, canSteer: Boolean(onSteer), canStop: Boolean(onStop) });
  const live = plan.tap !== 'idle';
  const btn = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(live ? 1 : 0.9, spring.bouncy) }] }));
  if (disabled) {
    return (
      <View style={{ paddingHorizontal: 16, paddingBottom: bottom + 10, paddingTop: 8 }}>
        <Card r={22} style={{ padding: 14, alignItems: 'center' }}>
          <T v="callout">{disabled}</T>
        </Card>
      </View>
    );
  }
  const send = (how: 'send' | 'steer') => {
    const words = now.current.text.trim();
    const attached = now.current.pics;
    if (!words && !attached.length) return;
    haptic.commit();
    if (how === 'steer' && onSteer && words && !attached.length) onSteer(words);
    else onSend(words, attached);
    setText('');
    setPics([]);
    setH(fieldHeight(0));
  };
  // Said and written down: sent (or queued) with the photos, as the round button would.
  said.current = (spoken) => {
    const words = appendSpoken(now.current.text, spoken).trim();
    if (!words) return;
    onSend(words, now.current.pics);
    setText('');
    setPics([]);
    setH(fieldHeight(0));
  };
  const full = pics.length >= MAX_PHOTOS;
  const attach = async () => {
    if (full) return;
    const p = await pickPhoto().catch(() => undefined);
    if (p) setPics((l) => (l.some((x) => x.uri === p.uri) ? l : [...l, p].slice(0, MAX_PHOTOS)));
  };
  // What can go with the message: one is its own button, more are behind one +.
  const adds: readonly Option[] = [...(canAttach ? [{ Icon: ImagePlus, label: 'Add a photo', tone: 'sky' as const, hidden: full, onPress: () => void attach() }] : []), ...more];
  const One = adds.length === 1 ? adds[0]!.Icon : undefined;
  const recording = voiceActive(voice.view);
  // While Claude works, one quiet line says what the button does (no second button).
  const hint = plan.more.length ? 'Goes after what your agent is doing · hold ↑ to steer now' : working && plan.tap === 'queue' && pics.length ? 'Photos go after what your agent is doing' : undefined;
  return (
    <View style={{ paddingHorizontal: 10, paddingBottom: bottom + 8, paddingTop: 6, gap: 6 }}>
      {above}
      {hint ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14 }}>
          <Clock color={color.text3} size={12} />
          <T v="caption" numberOfLines={1} style={{ flex: 1 }}>
            {hint}
          </T>
        </Animated.View>
      ) : null}
      <TagChips tags={matchTags(text, tags)} onPick={(tag) => setText((t) => withTag(t, tag))} />
      <Card r={24} style={{ paddingHorizontal: 4, paddingVertical: 4, gap: 2 }}>
        {voiceAvailable() ? (
          <View style={{ paddingHorizontal: 10 }}>
            <VoiceNote voice={voice} />
          </View>
        ) : null}
        <PhotoStrip photos={pics} onRemove={(uri) => setPics((l) => l.filter((p) => p.uri !== uri))} />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
          {recording ? null : adds.length > 1 ? (
            <Press onPress={() => (Keyboard.dismiss(), setAdding(true))} accessibilityLabel="Add" accessibilityHint={adds.map((o) => o.label).join(', ')} hitSlop={4} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}>
              <Plus color={color.text2} size={22} />
            </Press>
          ) : One ? (
            <Press onPress={adds[0]!.onPress} disabled={canAttach && full} accessibilityLabel={adds[0]!.label} hitSlop={4} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', opacity: canAttach && full ? 0.4 : 1 }}>
              <One color={color.text2} size={21} />
            </Press>
          ) : null}
          {recording ? (
            // While it records, the stage is the field: the blob, and the words landing where they'll stay.
            <View style={{ flex: 1, minWidth: 0, paddingLeft: 10 }}>
              <VoiceStage voice={voice} before={text} box minHeight={fieldHeight(0)} />
            </View>
          ) : (
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={placeholder}
              placeholderTextColor={color.text3}
              multiline
              scrollEnabled
              onContentSizeChange={(e) => setH(fieldHeight(e.nativeEvent.contentSize.height))}
              style={{
                flex: 1,
                minWidth: 0,
                color: color.text,
                fontSize: 16.5,
                lineHeight: FIELD_LINE_HEIGHT,
                paddingTop: FIELD_PAD,
                paddingBottom: FIELD_PAD,
                paddingLeft: adds.length ? 4 : 12,
                paddingRight: 6,
                minHeight: fieldHeight(0),
                maxHeight: fieldHeight(Number.POSITIVE_INFINITY),
                height: Platform.OS === 'web' ? h : undefined,
                textAlignVertical: 'top',
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
              }}
              onKeyPress={(e) => {
                // On the web, Enter sends (Shift+Enter is a new line); ⌥↩ steers, as on the Mac.
                const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; altKey?: boolean };
                if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey) {
                  (e as unknown as { preventDefault(): void }).preventDefault();
                  if (plan.tap === 'stop' || plan.tap === 'idle') return;
                  send(ne.altKey === true && plan.more.includes('steer') ? 'steer' : 'send');
                }
              }}
            />
          )}
          {voiceAvailable() ? (
            <VoiceButton
              voice={voice}
              size={40}
              onPress={() => {
                const p = voice.view.phase;
                if (p === 'off') return void (haptic.tap(), voice.start());
                haptic.commit();
                if (p === 'listening') voice.finish('edit');
                else voice.cancel();
              }}
            />
          ) : null}
          <Animated.View style={btn}>
            {plan.tap === 'stop' ? (
              <Animated.View key="stop" entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)}>
                <Press onPress={() => (haptic.commit(), onStop?.())} accessibilityLabel="Stop" style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.rose }}>
                  <Square color={color.error} fill={color.error} size={13} />
                </Press>
              </Animated.View>
            ) : (
              <Animated.View key="send" entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)}>
                <Press
                  onPress={() => (speaking ? (haptic.commit(), voice.finish('send')) : send('send'))}
                  onLongPress={plan.more.length ? () => (haptic.commit(), Keyboard.dismiss(), setMenu(true)) : undefined}
                  delayLongPress={320}
                  disabled={!live}
                  accessibilityLabel={plan.tap === 'queue' ? 'Queue: after what your agent is doing' : 'Send'}
                  accessibilityHint={plan.more.length ? 'Hold to steer your agent now instead' : undefined}
                  style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: live ? color.primary : color.sunken }}
                >
                  <ArrowUp color={live ? color.onPrimary : color.text3} size={20} strokeWidth={2} />
                </Press>
              </Animated.View>
            )}
          </Animated.View>
        </View>
      </Card>
      {/* Opened from the composer, not the screen: in a window of its own, with the keyboard put away (in the composer's box it showed as a sliver, under the keyboard). */}
      <Options
        window
        visible={menu}
        onClose={() => setMenu(false)}
        title="While your agent works"
        options={[
          { Icon: Navigation, label: 'Steer now', sub: 'Your agent reads it at its next step', tone: 'sky', onPress: () => send('steer') },
          { Icon: ListPlus, label: 'Queue', sub: 'After what your agent is doing', tone: 'mint', onPress: () => send('send') },
        ]}
      />
      <Options window visible={adding} onClose={() => setAdding(false)} title="Add" options={adds} />
    </View>
  );
}
