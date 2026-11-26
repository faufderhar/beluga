import { router, useLocalSearchParams } from 'expo-router';
import { Bot, Check, ChevronDown, ChevronRight, Eye, Gauge, Hand, Monitor, Rocket, User } from 'lucide-react-native';
import { Options } from '../../components/Options';
import { AgentMarkIcon, markIcon, runtimeMark } from '../../components/AgentMark';
import { AgentChoiceSheet, agentOfRow } from '../../components/AgentPicker';
import { agentName } from '../../../../src/shared/agent-label';
import { openOnMac } from '../../lib/mac';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { LinearTransition, FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { convHref } from '../../components/Conv';
import { answer, NeedButtons, NeedFace } from '../../components/Needs';
import { MilestoneMap, PlanChat, PlanDrafting } from '../../components/PlanParts';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Card, More, Pill, Press, T, toneBg, toneInk, toneOf } from '../../components/ui';
import { ago, useSupports, useView, useVisibleNeeds } from '../../lib/hooks';
import type { ConvView, PlanView, Topic } from '../../lib/link/protocol';
import { color } from '../../lib/theme';
import { calls } from '../../lib/link/calls';
import { store } from '../../lib/store';

/** How a plan runs (src/core/plans/model.ts AUTONOMY_INFO), as the Mac says it. */
const AUTONOMY = {
  step: { label: 'Step by Step', sub: 'You start each task', Icon: Hand },
  gated: { label: 'Check-ins', sub: 'Runs, then waits for you at each milestone', Icon: Gauge },
  autopilot: { label: 'Autopilot', sub: 'Runs to the end, stops only if something fails', Icon: Rocket },
} as const;
type Autonomy = keyof typeof AUTONOMY;
/** 1.58 (BLG-981): Autopilot all the way, as the Mac's FULL_AUTOPILOT_INFO says it. */
const FULL = { label: 'Full Autopilot', sub: 'Never waits for you: a stand-in agent answers', Icon: Bot } as const;
/** 1.58 (BLG-982): the parts a plan's agents play, as the Mac's PLAN_ROLE_INFO says them. */
const ROLES = { planner: 'Plans with', builder: 'Builds with', checker: 'Checks with' } as const;
type Role = keyof typeof ROLES;

/** Who plays each part, in one line (1.58, BLG-982): one agent for all, or each part's; a Mac before it: who works it. */
function agentsSentence(roles: boolean, words: (role: Role) => string): string {
  if (!roles) return `Worked by ${words('builder')}`;
  const [planner, builder, checker] = (['planner', 'builder', 'checker'] as const).map(words);
  return planner === builder && checker === builder ? `Planned, built and checked by ${builder}` : `Planned by ${planner} · built by ${builder} · checked by ${checker}`;
}

/**
 * A plan (Advanced Planning) as it's designed and run: its goal, decisions waiting on you (Approve
 * or Discard a draft, pass a milestone), how it runs (Step by Step, Check-ins, Autopilot), and the
 * milestones as a vertical timeline: their criteria, what each waits on, their tasks with what
 * they wait on and what done means, and which run side by side now. The plan's shape is edited on
 * the Mac (or by asking its Claude in its conversation).
 */
export default function Plan() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `plan:${id}` as Topic;
  const view = useView<PlanView>(topic);
  const p = view?.data;
  const needs = useVisibleNeeds(p?.needsYou);
  const insets = useSafeAreaInsets();
  const tasks = p?.milestones.flatMap((m) => m.tasks) ?? [];
  const done = tasks.filter((t) => t.state === 'done').length;
  const [menu, setMenu] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [picking, setPicking] = useState<Role | undefined>();
  // Who plans, builds and checks it (1.58, BLG-982; a Mac before it: who works it, 1.35): its own pick, else your default; changed from ⋯.
  const roles = useSupports('planRoles');
  const fullOk = useSupports('autopilot');
  const defaultGroup = p?.agents?.groups.find((g) => g.isDefault);
  const yours = defaultGroup ? `Your agent (${defaultGroup.label})` : 'Your agent';
  const roleRef = (role: Role) => (role === 'planner' ? (p?.planner ?? p?.agent) : role === 'checker' ? (p?.checker ?? p?.agent) : p?.agent);
  const roleWords = (role: Role): string => {
    const ref = roleRef(role);
    return ref ? agentName(ref, { model: true }) : yours;
  };
  const setAgent = (role: Role, agent: { runtime: string; label: string; model?: string } | null, label: string): void => {
    const call = roles ? calls.setPlanRole(id ?? '', role, agent, label) : calls.setPlanAgent(id ?? '', agent, label);
    void store.call<string>(call).then(
      (said) => store.toast({ text: typeof said === 'string' ? said : `${label} works this plan`, tone: 'ok' }),
      (e: Error) => store.toast({ text: e.message, tone: 'error' }),
    );
  };
  const how = p?.fullAuto ? FULL : p?.autonomy && p.autonomy in AUTONOMY ? AUTONOMY[p.autonomy as Autonomy] : undefined;
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const milestoneTitles = new Map((p?.milestones ?? []).map((m) => [m.id, m.title]));
  const blocked = tasks.filter((t) => t.state === 'blocked').length;
  // Claude is still writing the first plan: its chat and one placeholder, nothing to run or approve yet.
  const drafting = p?.state === 'draft' && !p.milestones.length;
  const writing = Boolean(useView<ConvView>(drafting ? p?.topic : undefined)?.data.working);
  // The map's tap: scroll the timeline to that milestone and open it.
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const tops = useRef(new Map<string, number>());
  const listTop = useRef(0);
  const [picked, setPicked] = useState<{ id: string; n: number } | undefined>();
  const pick = (mid: string) => {
    setPicked((was) => ({ id: mid, n: (was?.n ?? 0) + 1 }));
    const y = tops.current.get(mid);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, listTop.current + y - 80), animated: true });
  };

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow="Plan" title={p?.title ?? 'Plan'} at={view?.at} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {p ? <Pill label={p.state === 'running' ? 'Running' : p.state} tone={toneOf(p.state)} /> : null}
            <More onPress={() => setMenu(true)} label="Plan options" />
          </View>
        } />
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={p?.title}
        options={[
          ...(roles ? (Object.keys(ROLES) as Role[]) : (['builder'] as Role[])).map((role) => ({
            Icon: markIcon(runtimeMark(roleRef(role)?.runtime ?? defaultGroup?.runtime)),
            label: roles ? ROLES[role] : 'Agent for its work',
            sub: roleWords(role),
            tone: 'lavender' as const,
            hidden: !p?.agents,
            onPress: () => setPicking(role),
          })),
          { Icon: Monitor, label: 'Open on your Mac', sub: 'Its graph, outline and conversation', tone: 'plain', onPress: () => void openOnMac({ topic }) },
        ]}
      />
      <AgentChoiceSheet
        title={picking && roles ? ROLES[picking] : 'Agent for its work'}
        caption={picking === 'planner' ? 'Plans with you in the plan’s conversation' : picking === 'checker' ? 'Checks each milestone, and reviews drafts' : p?.running ? 'For what starts next: milestones at work keep their agent' : 'Works its milestones and tasks'}
        picker={p?.agents}
        visible={picking !== undefined}
        onClose={() => setPicking(undefined)}
        yours={{ on: !roleRef(picking ?? 'builder'), onPick: () => setAgent(picking ?? 'builder', null, 'Your agent') }}
        onPick={(g, value, label) => setAgent(picking ?? 'builder', agentOfRow(g, value), value ? `${g.label} · ${label}` : g.label)}
      />
      <Options
        visible={howOpen}
        onClose={() => setHowOpen(false)}
        title="How it runs"
        options={[
          ...(Object.keys(AUTONOMY) as Autonomy[]).map((a) => ({
            Icon: AUTONOMY[a].Icon,
            label: AUTONOMY[a].label,
            sub: AUTONOMY[a].sub,
            tone: a === p?.autonomy && !p?.fullAuto ? ('lavender' as const) : ('plain' as const),
            // From Full Autopilot, Autopilot keeps it on Autopilot and sends questions to you again (skipped after the Autopilot wait in Settings).
            onPress: () => void store.call(p?.fullAuto && a === 'autopilot' ? calls.setFullAuto(id ?? '', false) : calls.setAutonomy(id ?? '', a, AUTONOMY[a].label)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' })),
          })),
          { Icon: FULL.Icon, label: FULL.label, sub: FULL.sub, tone: p?.fullAuto ? ('lavender' as const) : ('plain' as const), hidden: !fullOk, onPress: () => void store.call(calls.setFullAuto(id ?? '', true)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' })) },
        ]}
      />
      <ScrollView ref={scroll} onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {p ? (
          <>
            <View style={{ paddingHorizontal: 20, paddingTop: 6, gap: 12 }}>
              {p.goal ? <T v="callout" style={{ fontSize: 15, lineHeight: 21 }}>{p.goal}</T> : null}
              {drafting ? null : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
                  <View style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%`, height: 6, borderRadius: 3, backgroundColor: color.ok, opacity: 0.5 }} />
                </View>
                <T v="caption" c={color.text2}>
                  {done} of {tasks.length} tasks
                </T>
              </View>}
              {p.running || blocked ? (
                <T v="caption" c={color.text2}>
                  {[p.running ? `${p.running} running side by side${p.parallel ? ` (up to ${p.parallel})` : ''}` : '', blocked ? `${blocked} waiting on others` : ''].filter(Boolean).join(' · ')}
                </T>
              ) : null}
              {how && !drafting ? (
                <Press onPress={() => setHowOpen(true)} accessibilityLabel={`How it runs: ${how.label}`} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: toneBg('lavender') }}>
                  <how.Icon color={toneInk('lavender')} size={15} strokeWidth={1.9} />
                  <T v="caption" c={toneInk('lavender')} style={{ fontWeight: '700' }}>
                    {how.label}
                    {p.paused ? ' · paused' : ''}
                  </T>
                  <ChevronDown color={toneInk('lavender')} size={14} />
                </Press>
              ) : null}
              {p.agent || p.agents ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AgentMarkIcon mark={runtimeMark(roleRef('builder')?.runtime ?? defaultGroup?.runtime)} size={14} color={color.text2} />
                  <T v="caption" c={color.text2} style={{ flexShrink: 1 }}>
                    {agentsSentence(roles, roleWords)}
                  </T>
                </View>
              ) : null}
              {/* A fresh agent reads the draft before you approve it (1.45, BLG-772); what it finds waits on you below. */}
              {p.review?.state === 'reviewing' ? <Verifying review={p.review} /> : null}
              {p.topic ? <PlanChat topic={p.topic} drafting={drafting} /> : null}
            </View>

            {/* The plan as a small graph, first thing under its chat: what runs after what, at a glance. */}
            {!drafting && p.milestones.length > 1 ? (
              <View style={{ marginTop: 24, gap: 12 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 20 }}>
                  Map
                </T>
                <MilestoneMap milestones={p.milestones} onPick={pick} />
              </View>
            ) : null}
            {needs.length ? (
              <View style={{ marginTop: 20, gap: 10 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 20 }}>
                  Waiting on you
                </T>
                {needs.map((n) => (
                  <Animated.View key={n.id} entering={FadeIn.duration(180)} layout={LinearTransition.duration(180)}>
                    <Card style={{ marginHorizontal: 16, padding: 16, gap: 14 }}>
                      <NeedFace item={n} more />
                      <NeedButtons item={n} onAnswer={(t) => answer(n, t)} />
                    </Card>
                  </Animated.View>
                ))}
              </View>
            ) : null}

            {/* What the plan has decided (1.47): a replaced decision stays, crossed out. */}
            {p.decisions?.length ? (
              <View style={{ marginTop: 22, paddingHorizontal: 20, gap: 8 }}>
                <T v="eyebrow">Decisions</T>
                {p.decisions.map((d, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
                    <Check color={d.replaced ? color.text3 : color.ok} size={14} strokeWidth={2} style={{ marginTop: 3 }} />
                    <T v="callout" c={d.replaced ? color.text3 : color.text} style={{ flex: 1, ...(d.replaced ? { textDecorationLine: 'line-through' as const } : {}) }}>
                      {d.text}
                    </T>
                  </View>
                ))}
              </View>
            ) : null}

            {drafting ? (
              <View style={{ marginTop: 26, paddingHorizontal: 16 }}>
                <PlanDrafting working={writing} />
              </View>
            ) : (
              <>
                <View style={{ marginTop: 26, paddingHorizontal: 16 }} onLayout={(e) => (listTop.current = e.nativeEvent.layout.y)}>
                  <T v="eyebrow" style={{ paddingHorizontal: 4, marginBottom: 14 }}>
                    Milestones
                  </T>
                  {p.milestones.map((m, i) => (
                    <View key={m.id} onLayout={(e) => tops.current.set(m.id, e.nativeEvent.layout.y)}>
                      <Milestone m={m} last={i === p.milestones.length - 1} i={i} draft={p.state === 'draft'} titles={titles} after={(m.dependsOn ?? []).map((d) => milestoneTitles.get(d) ?? d)} picked={picked?.id === m.id ? picked.n : 0} />
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        ) : (
          <T v="callout" style={{ padding: 20 }}>
            Opening the plan…
          </T>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * A fresh agent verifying the plan (1.45, BLG-772): a breathing dot, how many of its four checks are
 * behind it, and its latest line (each new one fading in), so it never looks stuck.
 */
function Verifying({ review }: { review: NonNullable<PlanView['review']> }) {
  const breath = useSharedValue(0.35);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!reduced) breath.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
  }, [breath, reduced]);
  const dot = useAnimatedStyle(() => ({ opacity: breath.value }));
  const done = review.checksDone ?? 0;
  return (
    <View style={{ gap: 6, padding: 12, borderRadius: 14, backgroundColor: toneBg('lavender') }} accessibilityRole="summary" accessibilityLabel={`Verifying the plan: ${done} of 4 checks done`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneInk('lavender') }, dot]} />
        <T v="caption" c={toneInk('lavender')} style={{ fontWeight: '700', flex: 1 }}>
          Verifying the plan
        </T>
        <T v="caption" c={toneInk('lavender')}>
          {done} of 4 checks
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: toneInk('lavender'), opacity: i < done ? 0.8 : i === done ? 0.4 : 0.15 }} />
        ))}
      </View>
      {review.now ? (
        <Animated.View key={review.now} entering={FadeIn.duration(220)}>
          <T v="caption" c={color.text2} numberOfLines={2}>
            {review.now}
          </T>
        </Animated.View>
      ) : null}
    </View>
  );
}

function Milestone({ m, last, i, draft, titles, after, picked }: { m: PlanView['milestones'][number]; last: boolean; i: number; draft: boolean; titles: ReadonlyMap<string, string>; after: readonly string[]; picked: number }) {
  // A draft reads whole (you approve it from here); a running plan opens where the work is.
  const [open, setOpen] = useState(draft || m.state === 'running' || m.state === 'waiting' || m.state === 'gate');
  // Tapped on the map: open (each tap, though you closed it since).
  useEffect(() => {
    if (picked) setOpen(true);
  }, [picked]);
  const [task, setTask] = useState<string | undefined>();
  const tone = toneOf(m.state);
  const running = m.state === 'running';
  const done = m.state === 'done';
  const n = m.tasks.filter((t) => t.state === 'done').length;
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 26, alignItems: 'center' }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
          {done ? <Check color={toneInk(tone)} size={15} strokeWidth={2.2} /> : <T v="caption" c={toneInk(tone)} style={{ fontWeight: '800' }}>{i + 1}</T>}
        </View>
        {!last ? <View style={{ width: 2, flex: 1, marginVertical: 4, borderRadius: 1, backgroundColor: done ? toneBg('mint') : color.hairlineStrong }} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 18 }}>
        <Press scaleTo={0.985} onPress={() => setOpen((o) => !o)} haptics>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 }}>
            <T v="heading" style={{ flex: 1, color: done ? color.text2 : color.text }}>
              {m.title}
            </T>
            <T v="caption">
              {n}/{m.tasks.length}
            </T>
          </View>
          <T v="caption" c={toneInk(tone)} style={{ fontWeight: "600", marginTop: 2, textTransform: "capitalize" }}>
            {m.state === 'gate' ? 'Waiting for you to pass it' : m.state}
          </T>
          {m.agentNow ? (
            // Its agent at work right now, even between tasks (1.40): a tap opens its conversation.
            <Press scaleTo={0.98} onPress={() => (m.agentNow!.topic ? router.push(convHref(m.agentNow!.topic)) : setOpen(true))}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: (m.agentNow.asking ? color.warn : color.claude) }} />
                <T v="caption" c={(m.agentNow.asking ? color.warn : color.claude)} numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
                  {m.agentNow.text}
                </T>
                {m.agentNow.topic ? <ChevronRight color={color.text3} size={13} /> : null}
              </View>
            </Press>
          ) : null}
          {after.length ? (
            <T v="caption" c={color.text3} numberOfLines={2} style={{ marginTop: 2 }}>
              After {after.join(', ')}
            </T>
          ) : m.dependsOn && i > 0 ? (
            <T v="caption" c={color.text3} style={{ marginTop: 2 }}>
              Runs alongside the others
            </T>
          ) : null}
        </Press>
        {open ? (
          <Animated.View entering={FadeIn.duration(180)} style={{ marginTop: 10, gap: 8 }}>
            {m.criteria.length ? (
              <View style={{ gap: 3, marginBottom: 2 }}>
                {m.criteria.map((c) => (
                  <T key={c} v="caption" c={color.text2}>
                    ◦ {c}
                  </T>
                ))}
              </View>
            ) : null}
            <Card r={16}>
              {m.tasks.map((t, ti) => {
                const tt = toneOf(t.state);
                const waits = (t.blockedBy ?? []).map((b) => titles.get(b) ?? b);
                const shown = task === t.id;
                const row = (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderTopWidth: ti ? 0.5 : 0, borderTopColor: color.hairline }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tt === 'plain' ? color.hairlineStrong : toneInk(tt) }} />
                    <View style={{ flex: 1 }}>
                      <T v="callout" c={t.state === 'done' ? color.text2 : color.text} numberOfLines={shown ? undefined : 2}>
                        {t.title}
                      </T>
                      {waits.length ? (
                        <T v="caption" c={color.text3} numberOfLines={shown ? undefined : 1}>
                          Waits on {waits.join(', ')}
                        </T>
                      ) : null}
                      {shown && t.goal ? (
                        <T v="caption" c={color.text2} style={{ marginTop: 4 }}>
                          {t.goal}
                        </T>
                      ) : null}
                      {shown && t.acceptance?.length ? (
                        <View style={{ marginTop: 4, gap: 2 }}>
                          {t.acceptance.map((a) => (
                            <T key={a} v="caption" c={color.text2}>
                              ◦ {a}
                            </T>
                          ))}
                        </View>
                      ) : null}
                      {t.updatedAt && t.state !== 'later' ? (
                        <T v="caption" c={color.text3} numberOfLines={1}>
                          Updated {ago(t.updatedAt) === 'now' ? 'just now' : `${ago(t.updatedAt)} ago`}
                        </T>
                      ) : null}
                      {shown && t.why ? (
                        <T v="caption" c={color.text3} style={{ marginTop: 4 }}>
                          {t.why}
                        </T>
                      ) : null}
                    </View>
                    {t.mine ? <User color={color.info} size={13} /> : null}
                    <T v="caption" c={toneInk(tt)} style={{ fontWeight: "600" }}>
                      {t.state}
                    </T>
                    {t.topic ? <ChevronRight color={color.text3} size={15} /> : null}
                  </View>
                );
                // Its worktree's conversation once it has one; until then a tap shows what it's for.
                return (
                  <Press key={t.id} scaleTo={0.98} onPress={() => (t.topic ? router.push(convHref(t.topic)) : setTask(shown ? undefined : t.id))}>
                    {row}
                  </Press>
                );
              })}
            </Card>
            {m.checker ? (
              // Its checker (a Claude of its own, off the Mac's sidebar): watched live, or read once it said (1.39).
              <Press scaleTo={0.98} onPress={() => router.push(convHref(m.checker!))}>
                <Card r={16}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12 }}>
                    <Eye color={toneInk('lavender')} size={15} />
                    <T v="callout" style={{ flex: 1 }}>
                      {m.state === 'checking' ? 'Watch the check' : 'Open the check'}
                    </T>
                    <ChevronRight color={color.text3} size={15} />
                  </View>
                </Card>
              </Press>
            ) : null}
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );
}
