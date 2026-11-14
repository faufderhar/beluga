import { router } from 'expo-router';
import { ArrowUp, Check, Circle, CircleDashed, CircleDot, Eye, Layers, Lock, type LucideIcon, Plus, Sparkles, User, X, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useFolded, useSupports, useView } from '../lib/hooks';
import { agentPicksSupported } from '../lib/agent-picks';
import { type Call, calls } from '../lib/link/calls';
import type { TaskSummary, TasksView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, radius } from '../lib/theme';
import { AgentChoice, type PickedAgent } from './AgentChoice';
import { ProjectMark } from './ProjectMark';
import { Sheet } from './Sheet';
import { Button, Card, FoldHead, haptic, Hairline, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';
import type { TaskDraftResult } from '../../../src/companion/calls';

/**
 * Tasks (BLG-48): the board's tasks per project, grouped by status as the Mac's list groups them
 * (in progress, in review, ready, backlog, the latest done), each with its key, title, priority and
 * who has it. A new task can be described in a sentence: Claude drafts it, you see the draft, then
 * it's added. One message can ask for several tasks, or an epic with its parts, and who each is for
 * (BLG-322): you see them all, and Add makes them all.
 */

export const STATUS: Record<string, { Icon: LucideIcon; tone: Tone; label: string }> = {
  in_progress: { Icon: CircleDot, tone: 'peach', label: 'In Progress' },
  in_review: { Icon: Eye, tone: 'sky', label: 'In Review' },
  in_plan: { Icon: Eye, tone: 'sky', label: 'Merged into Plan' },
  todo: { Icon: Circle, tone: 'plain', label: 'Ready' },
  backlog: { Icon: CircleDashed, tone: 'plain', label: 'Backlog' },
  done: { Icon: Check, tone: 'mint', label: 'Done' },
  canceled: { Icon: XCircle, tone: 'plain', label: 'Canceled' },
};
export const statusOf = (s: string) => STATUS[s] ?? STATUS.todo!;
export const PRIORITY: Record<string, { label: string; tone: Tone }> = { urgent: { label: 'Urgent', tone: 'rose' }, high: { label: 'High', tone: 'butter' }, medium: { label: 'Medium', tone: 'plain' }, low: { label: 'Low', tone: 'plain' } };

export const taskHref = (t: { id: string }): string => `/task/${encodeURIComponent(t.id)}`;

export function TaskRow({ t, first }: { readonly t: TaskSummary; readonly first?: boolean }) {
  const st = statusOf(t.status);
  const pr = PRIORITY[t.priority];
  return (
    <View>
      {!first ? <Hairline style={{ marginLeft: 56 }} /> : null}
      <Press onPress={() => router.push(taskHref(t))} accessibilityLabel={`${t.key} ${t.title}${t.private ? ', private' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 14 }}>
        <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
          <st.Icon color={toneInk(st.tone)} size={18} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="body" numberOfLines={2} style={{ fontWeight: '500' }}>
            {t.title}
          </T>
          <T v="caption" numberOfLines={1}>
            <T v="caption" style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>
              {t.key}
            </T>
            {[t.epic ? (t.epic.total ? `Epic, ${t.epic.done}/${t.epic.total} done` : 'Epic') : undefined, t.epicKey ? `in ${t.epicKey}` : undefined, t.onBoard ? `on ${t.onBoard}` : undefined, t.repo, t.assignee, t.working, t.needsChecks ? 'Needs its checks' : undefined, t.checks ? `${t.checks.done}/${t.checks.total} checked` : undefined, t.pr ? `PR #${t.pr.number}` : undefined]
              .filter(Boolean)
              .map((x) => `  ·  ${x}`)
              .join('')}
          </T>
        </View>
        {t.private ? <Lock color={color.text3} size={14} /> : null}
        {pr && (t.priority === 'urgent' || t.priority === 'high') ? <Pill label={pr.label} tone={pr.tone} /> : null}
      </Press>
    </View>
  );
}

/** Every project's tasks by status (Work › Tasks, and /tasks). */
export function TasksList() {
  const tasksOn = useSupports('tasks');
  const drafts = useSupports('draftTask');
  const tasks = useView<TasksView>(tasksOn ? 'tasks' : undefined);
  const [adding, setAdding] = useState<{ id: string; name: string; icon?: string } | undefined>();
  const fold = useFolded('tasks');
  if (!tasksOn) {
    return (
      <Card style={{ marginHorizontal: 16, padding: 18 }}>
        <T v="heading">Tasks need a newer Beluga</T>
        <T v="callout" style={{ marginTop: 4 }}>
          Update Beluga on your Mac to see its tasks here.
        </T>
      </Card>
    );
  }
  const list = tasks?.data.projects ?? [];
  if (!tasks) return <T v="callout" style={{ paddingHorizontal: 20 }}>Loading tasks…</T>;
  return (
    <View style={{ gap: 24 }}>
      {!list.length ? (
        <Card style={{ marginHorizontal: 16, padding: 18 }}>
          <T v="heading">No tasks yet</T>
          <T v="callout" style={{ marginTop: 4 }}>
            Tasks your agent and you open on your Mac show up here.
          </T>
        </Card>
      ) : null}
      {list.map((p) => (
        <Animated.View key={p.id} entering={FadeIn.duration(180)} style={{ gap: 10 }}>
          <FoldHead
            big
            folded={fold.folded(p.id)}
            onToggle={() => fold.toggle(p.id)}
            lead={<ProjectMark name={p.name} icon={p.icon} size={24} />}
            label={p.name}
            count={p.groups.reduce((n, g) => n + g.tasks.length + (g.more ?? 0), 0)}
            right={
              drafts ? (
                <Press onPress={() => setAdding({ id: p.id, name: p.name, icon: p.icon })} accessibilityLabel={`New task in ${p.name}`} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 10, borderRadius: radius.s, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: color.hairline }}>
                  <Plus color={color.text2} size={14} />
                  <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
                    New
                  </T>
                </Press>
              ) : null
            }
          />
          {fold.folded(p.id) ? null : p.groups.map((g) => (
            <View key={g.status} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 22 }}>
                <T v="eyebrow">{g.label}</T>
                <T v="caption">{g.tasks.length + (g.more ?? 0)}</T>
              </View>
              <Card style={{ marginHorizontal: 16 }}>
                {g.tasks.map((t, i) => (
                  <TaskRow key={t.id} t={t} first={i === 0} />
                ))}
                {g.more ? (
                  <T v="caption" style={{ padding: 12, paddingLeft: 58 }}>
                    and {g.more} more on your Mac
                  </T>
                ) : null}
              </Card>
            </View>
          ))}
        </Animated.View>
      ))}
      <NewTaskSheet project={adding} onClose={() => setAdding(undefined)} />
    </View>
  );
}

/**
 * A new task by describing it: a sentence, then Claude's draft (title, goal, what done means,
 * labels), and Add. The draft is the Mac's own task drafter's; nothing is added until you say.
 */
export function NewTaskSheet({ project, onClose }: { readonly project?: { id: string; name: string; icon?: string }; readonly onClose: () => void }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<TaskDraftResult | undefined>();
  const [busy, setBusy] = useState<'draft' | 'add' | undefined>();
  // Who works it when it starts (BLG-498): none is your default agent.
  const [agent, setAgent] = useState<PickedAgent | undefined>();
  const [last, setLast] = useState(project);
  if (project && project !== last) setLast(project);
  const p = project ?? last;
  // A Mac with 1.24 drafts every task the words ask for (an older one, just one).
  const several = useSupports('severalTasks');
  const count = draft ? 1 + (draft.more?.length ?? 0) : 0;
  const close = () => {
    onClose();
    setTimeout(() => {
      setText('');
      setDraft(undefined);
      setBusy(undefined);
      setAgent(undefined);
    }, 250);
  };
  const ask = async () => {
    if (!p || !text.trim() || busy) return;
    haptic.commit();
    setBusy('draft');
    const d = await store.call<TaskDraftResult>(calls.draftTask(p.id, text.trim(), several), { queue: false }).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    setBusy(undefined);
    if (d) setDraft(d);
  };
  const add = async () => {
    if (!p || !draft || busy) return;
    haptic.success();
    setBusy('add');
    // The agent goes only to a Mac that takes it (1.35), and only when it isn't your default.
    const base = calls.addTask(p.id, draft);
    const call: Call = agent && agentPicksSupported() ? withAgent(base as Call<'companion.addTask'>, agent) : base;
    const r = await store.call<{ id: string; key: string; more?: Array<{ id: string; key: string }> }>(call, { queue: false }).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    setBusy(undefined);
    if (!r) return;
    store.toast({ text: `Added ${andList([r.key, ...(r.more ?? []).map((m) => m.key)])}`, tone: 'ok' });
    close();
    setTimeout(() => router.push(taskHref(r)), 300);
  };
  return (
    <Sheet visible={!!project} onDismiss={close} window>
      <View style={{ paddingHorizontal: 20, gap: 12, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {p ? <ProjectMark name={p.name} icon={p.icon} size={30} /> : null}
          <T v="title" style={{ flex: 1, fontSize: 21 }}>
            New task
          </T>
          <Press onPress={close} accessibilityLabel="Close" hitSlop={10} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
            <X color={color.text2} size={17} />
          </Press>
        </View>
        {!draft ? (
          <>
            <TextInput
              autoFocus
              value={text}
              onChangeText={setText}
              multiline
              placeholder={several ? 'Say what it is, or a few tasks and who does each' : 'Say what it is: your agent writes the rest'}
              placeholderTextColor={color.text3}
              style={{ color: color.text, fontSize: 18, lineHeight: 25, minHeight: 84, maxHeight: 180, textAlignVertical: 'top', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Sparkles color={color.claude} size={15} />
              <T v="caption" style={{ flex: 1 }}>
                {several ? 'Your agent drafts each task and who it’s for. You see them first.' : 'Your agent drafts the title, goal and checks. You see it first.'}
              </T>
              <Press disabled={!text.trim() || !!busy} onPress={() => void ask()} accessibilityLabel="Draft it" style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: text.trim() ? color.primary : color.sunken }}>
                {busy === 'draft' ? <ActivityIndicator color={color.onPrimary} /> : <ArrowUp color={text.trim() ? color.onPrimary : color.text3} size={22} strokeWidth={2} />}
              </Press>
            </View>
          </>
        ) : (
          <Animated.View entering={FadeIn.duration(220)} style={{ gap: 12 }}>
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
              {count > 1 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Sparkles color={color.claude} size={14} />
                  <T v="caption" c={color.claude} style={{ fontWeight: '700' }}>
                    {draft.epic ? `An epic and ${count - 1} sub-task${count === 2 ? '' : 's'}` : `${count} tasks`}
                  </T>
                </View>
              ) : null}
              <DraftCard draft={draft} epic={draft.epic} heading={count > 1 ? undefined : 'Your agent’s draft'} />
              {(draft.more ?? []).map((m, i) => (
                <View key={i} style={draft.epic ? { marginLeft: 14 } : undefined}>
                  <DraftCard draft={m} />
                </View>
              ))}
            </ScrollView>
            {agentPicksSupported() ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <T v="caption">Worked by</T>
                <AgentChoice value={agent} onChange={setAgent} />
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button label="Change" quiet flex={1} onPress={() => setDraft(undefined)} />
              <Button label={busy === 'add' ? 'Adding…' : count > 1 ? `Add ${count} tasks` : 'Add task'} Icon={Plus} flex={1.4} disabled={!!busy} onPress={() => void add()} />
            </View>
          </Animated.View>
        )}
      </View>
    </Sheet>
  );
}

/** One drafted task: its title, goal, checks and labels, how much it matters, and who it's for. */
function DraftCard({ draft, heading, epic }: { readonly draft: Omit<TaskDraftResult, 'more' | 'epic'>; readonly heading?: string; readonly epic?: boolean }) {
  const top = heading || epic || draft.priority || draft.for;
  return (
    <Card style={{ padding: 14, gap: 8, ...(epic ? { backgroundColor: toneBg('lavender') } : {}) }}>
      {top ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {heading ? (
            <>
              <Sparkles color={color.claude} size={14} />
              <T v="caption" c={color.claude} style={{ fontWeight: '700' }}>
                {heading}
              </T>
            </>
          ) : null}
          {epic ? (
            <>
              <Layers color={toneInk('lavender')} size={13} />
              <T v="caption" c={toneInk('lavender')} style={{ fontWeight: '700' }}>
                Epic
              </T>
            </>
          ) : null}
          <View style={{ flex: 1 }} />
          {draft.for ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <User color={color.text2} size={13} />
              <T v="caption">For {draft.for}</T>
            </View>
          ) : null}
          {draft.priority ? <Pill label={PRIORITY[draft.priority]?.label ?? draft.priority} tone={PRIORITY[draft.priority]?.tone ?? 'plain'} /> : null}
        </View>
      ) : null}
      <T v="heading">{draft.title}</T>
      {draft.goal ? <T v="callout">{draft.goal}</T> : null}
      {draft.acceptance.length ? (
        <View style={{ gap: 6, marginTop: 4 }}>
          {draft.acceptance.map((a) => (
            <View key={a} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <View style={{ width: 16, height: 16, borderRadius: 5, borderWidth: 1.5, borderColor: color.hairlineStrong, marginTop: 2 }} />
              <T v="callout" c={color.text} style={{ flex: 1 }}>
                {a}
              </T>
            </View>
          ))}
        </View>
      ) : null}
      {draft.labels.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {draft.labels.map((l) => (
            <Pill key={l} label={l} tone="lavender" />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

/** A new task's call with who works it (calls.addTask has no `agent` of its own). */
const withAgent = (c: Call<'companion.addTask'>, agent: PickedAgent): Call => ({ ...c, args: [{ ...c.args[0], agent }] }) as Call<'companion.addTask'> as unknown as Call;

/** "BLG-1", "BLG-1 and BLG-2", "BLG-1, BLG-2 and BLG-3". */
const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
