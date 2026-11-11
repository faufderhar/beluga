import { router } from 'expo-router';
import { ChevronRight, Eye, Laptop, MessagesSquare, Settings, Workflow } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { LinearTransition, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConvCard, convHref, StepTicker } from '../../components/Conv';
import { MacChatsSheet } from '../../components/MacChats';
import { Mark } from '../../components/Mark';
import { NeedsStack } from '../../components/Needs';
import { NumbersHome } from '../../components/Dashboard';
import { SentinelHome } from '../../components/Sentinels';
import { AwayBand, Screen, StatusShade, useScrolled } from '../../components/Screen';
import { UpdatePill, UpdateSheet } from '../../components/Update';
import { UsageCard, UsageSheet } from '../../components/Usage';
import { Card, IconBadge, Pill, Press, Section, StatusDot, T } from '../../components/ui';
import { useLink, useSupports, useView, useAllNeeds } from '../../lib/hooks';
import type { ConvSummary, HomeView, PlansView } from '../../lib/link/protocol';
import { displayName } from '../../lib/names';
import { color, TAB_BAR_H } from '../../lib/theme';

/**
 * Home: your Mac and its state at the top, then what needs you (a stack of cards), what's running,
 * tasks waiting for your review, and your allowance (outputs live with their conversations).
 */
export default function Home() {
  const insets = useSafeAreaInsets();
  const { scrolled, onScroll } = useScrolled();
  const [usageOpen, setUsageOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const link = useLink();
  const home = useView<HomeView>('home');
  const plans = useView<PlansView>('plans');
  const sentinelOn = useSupports('sentinel');
  const h = home?.data;
  const needs = useAllNeeds(h?.needsYou);
  const running = plans?.data.plans.filter((p) => p.state === 'running') ?? [];
  const linked = link.phase === 'open';
  const asleep = link.phase === 'asleep';
  const hour = new Date().getHours();
  const name = displayName(h?.me.name);
  const greeting = hour < 5 ? 'Hi' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen>
      <StatusShade scrolled={scrolled} />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: TAB_BAR_H + insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Mark size={40} intro={false} />
            <View style={{ flex: 1 }}>
              <T v="heading" numberOfLines={1}>
                {h?.mac.name ?? link.mac?.name ?? link.pairing?.macName ?? 'Your Mac'}
              </T>
            </View>
            {/* The link's state as a dot and a word: green only while it's live. */}
            <View accessibilityLabel={linked ? 'Linked' : asleep ? 'Asleep' : 'Away'} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusDot c={linked ? color.ok : asleep ? color.text3 : link.phase === 'dialing' ? color.warn : color.text3} size={7} />
              <T v="caption" c={color.text2}>
                {linked ? 'Linked' : asleep ? 'Asleep' : link.phase === 'dialing' ? 'Linking' : 'Away'}
              </T>
            </View>
            <Press onPress={() => router.push('/settings')} accessibilityLabel="Settings" hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
              <Settings color={color.text2} size={19} />
            </Press>
          </View>
          <Animated.View entering={FadeIn.duration(180)} style={{ marginTop: 24 }}>
            <T v="hero">
              {name ? `${greeting}, ${name}` : 'Hi there'}
            </T>
            <T v="callout" style={{ marginTop: 4 }}>
              {needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'}
              {h?.running.length ? ` · ${h.running.filter((r) => r.status === 'working').length} working` : ''}
            </T>
          </Animated.View>
          <UpdatePill onPress={() => setUpdateOpen(true)} />
          <AwayBand at={home?.at} />
        </View>

        {!h ? (
          <Card style={{ margin: 16, marginTop: 28, padding: 20 }}>
            <T v="heading">Reaching your Mac…</T>
            <T v="callout" style={{ marginTop: 4 }}>
              What it shows will appear here.
            </T>
          </Card>
        ) : (
          <>
            {h.assistant ? <AskYourMac c={h.assistant} chats={h.macChats?.length ?? 0} onChats={() => setChatsOpen(true)} /> : null}

            <Section
              title="Needs you"
              right={
                needs.length > 1 ? (
                  <Press onPress={() => router.push('/needs')} hitSlop={10}>
                    {/* One string, so Android measures the whole label again when the count changes width. */}
                    <T v="callout" c={color.info} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 0 }}>
                      {`All ${needs.length}`}
                    </T>
                  </Press>
                ) : null
              }
            >
              <NeedsStack items={needs} />
            </Section>

            {h.running.length || running.length ? (
              <Section title="Running">
                <Animated.View layout={LinearTransition.duration(180)} style={{ gap: 10 }}>
                  {running.map((p) => (
                    <Press key={p.id} scaleTo={0.985} onPress={() => router.push(`/plan/${p.id}`)} style={{ marginHorizontal: 16 }}>
                      <Card style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <IconBadge Icon={Workflow} tone="butter" />
                        <View style={{ flex: 1 }}>
                          <T v="heading" numberOfLines={1}>
                            {p.title}
                          </T>
                          <T v="caption">
                            Plan · {p.done} of {p.total} done
                          </T>
                        </View>
                        <ChevronRight color={color.text3} size={18} />
                      </Card>
                    </Press>
                  ))}
                  {h.running.map((c) => (
                    <ConvCard key={c.topic} c={c} />
                  ))}
                </Animated.View>
              </Section>
            ) : null}

            {h.review?.count ? (
              <Section title="For your review">
                <Press scaleTo={0.985} onPress={() => router.push(h.review!.count === 1 && h.review!.first ? `/task/${encodeURIComponent(h.review!.first.topic.slice(5))}` : '/tasks')} style={{ marginHorizontal: 16 }}>
                  <Card style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <IconBadge Icon={Eye} tone="sky" />
                    <View style={{ flex: 1 }}>
                      <T v="heading" numberOfLines={1}>
                        {h.review.count === 1 && h.review.first ? h.review.first.title : `${h.review.count} tasks in review`}
                      </T>
                      <T v="caption" numberOfLines={1}>
                        {h.review.count === 1 && h.review.first ? `${h.review.first.key} · in review` : h.review.first ? `${h.review.first.key} and ${h.review.count - 1} more` : 'Tasks'}
                      </T>
                    </View>
                    <ChevronRight color={color.text3} size={18} />
                  </Card>
                </Press>
              </Section>
            ) : null}

            {sentinelOn ? <SentinelHome /> : null}
            {sentinelOn ? <NumbersHome /> : null}

            {h.usage.length ? (
              <Section title="Usage">
                <UsageCard usage={h.usage} onOpen={() => setUsageOpen(true)} />
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
      <UsageSheet usage={h?.usage ?? []} cache={h?.cache} visible={usageOpen} onClose={() => setUsageOpen(false)} />
      <MacChatsSheet window visible={chatsOpen} onClose={() => setChatsOpen(false)} />
      <UpdateSheet visible={updateOpen} onClose={() => setUpdateOpen(false)} />
    </Screen>
  );
}

/**
 * Your Mac (1.5): one compact row under the greeting, your Claude for the whole Mac. Its last
 * line (or what it's doing now); a tap opens the chat open on the Mac, with its composer ready.
 * Since 1.14 its chats button lists them all, with New chat (a long-press opens it too).
 */
function AskYourMac({ c, chats, onChats }: { readonly c: ConvSummary; readonly chats: number; readonly onChats: () => void }) {
  const working = c.status === 'working' || c.status === 'waiting';
  const many = useSupports('macChats');
  return (
    <Press scaleTo={0.985} onPress={() => router.push(convHref(c.topic) as never)} onLongPress={many ? onChats : undefined} accessibilityLabel="Ask your Mac" style={{ marginHorizontal: 16, marginTop: 18 }}>
      <Card style={{ paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconBadge Icon={Laptop} tone="sky" size={34} />
        <View style={{ flex: 1 }}>
          <T v="heading" numberOfLines={1} style={{ fontSize: 16 }}>
            Ask your Mac
          </T>
          {working ? (
            <StepTicker step={c.last ?? 'Working'} size={12.5} />
          ) : (
            <T v="caption" numberOfLines={1}>
              {c.last ?? 'Screenshots, what’s running, start a worktree'}
            </T>
          )}
        </View>
        {c.unread ? <Pill label={String(c.unread)} tone="sky" /> : null}
        {many ? (
          <Press onPress={onChats} accessibilityLabel={`Your Mac’s chats, ${chats}`} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10, borderRadius: 16, backgroundColor: color.sunken }}>
            <MessagesSquare color={color.text2} size={15} />
            {chats > 1 ? (
              <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
                {chats}
              </T>
            ) : null}
          </Press>
        ) : (
          <ChevronRight color={color.text3} size={18} />
        )}
      </Card>
    </Press>
  );
}
