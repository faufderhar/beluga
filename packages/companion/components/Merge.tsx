import { router } from 'expo-router';
import { Archive as ArchiveIcon, ArrowRight, Check, CircleAlert, Clock, FileWarning, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Info, type LucideIcon, RefreshCw, Sparkles, Trash2, TriangleAlert, Upload, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { calls } from '../lib/link/calls';
import type { ThreadChildren } from '../../../src/shared/threads';
import type { BranchStepView, BranchView, MergeCheckView, MergeView, PhoneBranchStep, ThreadCountView, Topic } from '../lib/link/protocol';
import { openOnMac } from '../lib/mac';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { branchChildren, threadsQuestion } from '../lib/thread-rows';
import { Breathe, TypingDots } from './Live';
import { Options } from './Options';
import { Sheet } from './Sheet';
import { Button, Card, haptic, IconBadge, More, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * Merging a worktree from the phone (BLG-67), the Mac's own way: the sheet shows what would merge
 * and the Mac's checks before anything happens (merging is deliberate, so this sheet is the
 * confirmation); the band in the conversation follows it live: merging, the conflicting files (by
 * name), Claude resolving them, merged.
 */

const TONE: Record<string, { Icon: typeof Check; tone: Tone }> = { ok: { Icon: Check, tone: 'mint' }, info: { Icon: Info, tone: 'sky' }, block: { Icon: TriangleAlert, tone: 'butter' } };

export function MergeSheet({ topic, visible, onClose }: { readonly topic: Topic; readonly visible: boolean; readonly onClose: () => void }) {
  const [check, setCheck] = useState<MergeCheckView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const look = () => {
    setCheck(undefined);
    setError(undefined);
    store.call<MergeCheckView>(calls.mergeCheck(topic), { queue: false }).then(
      (c) => setCheck(c),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    if (visible) look();
  }, [visible]);
  const merge = async () => {
    if (!check?.canMerge || busy) return;
    haptic.commit();
    setBusy(true);
    await store.call(calls.merge(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
    setBusy(false);
    onClose();
  };
  const resolve = async () => {
    haptic.commit();
    await store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
    onClose();
  };
  const claudeFix = check?.checks.some((c) => c.fix === 'claude');
  return (
    <Sheet
      visible={visible}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={GitMerge} tone="lavender" size={34} />
          <T v="title" style={{ flex: 1, fontSize: 21 }}>
            Merge into {check?.into ?? 'main'}
          </T>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12, gap: 14 }}>
        {error ? (
          <T v="callout" c={color.error}>
            Couldn’t look at this branch: {error}
          </T>
        ) : !check ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 18 }}>
            <ActivityIndicator color={color.text3} />
            <T v="callout">Checking what would merge…</T>
          </View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Pill label={check.from} tone="lavender" />
              <ArrowRight color={color.text3} size={16} />
              <Pill label={check.into} tone="mint" />
            </View>
            {check.commits ? (
              <View style={{ gap: 4 }}>
                <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                  {check.commits} {check.commits === 1 ? 'commit' : 'commits'} · {check.files} {check.files === 1 ? 'file' : 'files'}
                </T>
                {check.subjects.map((s, i) => (
                  <T key={i} v="callout" numberOfLines={1}>
                    {s}
                  </T>
                ))}
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              {check.checks.map((c) => {
                const t = TONE[c.tone] ?? TONE.info!;
                return (
                  <View key={c.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(t.tone) }}>
                      <t.Icon color={toneInk(t.tone)} size={13} strokeWidth={1.9} />
                    </View>
                    <T v="callout" c={color.text} style={{ flex: 1 }}>
                      {c.text}
                    </T>
                  </View>
                );
              })}
            </View>
            {check.conflicts?.length ? <Files files={check.conflicts} /> : null}
            <T v="caption">A merge commit is made in your Mac’s main folder, so its files change. Nothing is pushed.</T>
          </Animated.View>
        )}
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 6, gap: 10 }}>
        {claudeFix ? <Button label="Ask your agent to resolve" Icon={Sparkles} onPress={() => void resolve()} /> : null}
        <Button label={busy ? 'Merging…' : (check?.confirm ?? 'Merge')} Icon={GitMerge} quiet={claudeFix} disabled={!check?.canMerge || busy} onPress={() => void merge()} />
      </View>
    </Sheet>
  );
}

/** Conflicting files, by name only. */
function Files({ files }: { readonly files: readonly string[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {files.slice(0, 12).map((f) => (
        <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: toneBg('rose') }}>
          <FileWarning color={toneInk('rose')} size={13} />
          <T v="caption" c={toneInk('rose')} numberOfLines={1} style={{ fontWeight: '600', maxWidth: 180 }}>
            {f}
          </T>
        </View>
      ))}
      {files.length > 12 ? <T v="caption">and {files.length - 12} more</T> : null}
    </View>
  );
}

const BAND: Record<string, { tone: Tone; Icon: typeof Check; title: (m: MergeView) => string }> = {
  merging: { tone: 'lavender', Icon: GitMerge, title: () => 'Merging…' },
  conflicts: { tone: 'rose', Icon: CircleAlert, title: (m) => `${m.conflicts?.length ?? 'Some'} ${m.conflicts?.length === 1 ? 'file conflicts' : 'files conflict'}` },
  resolving: { tone: 'lavender', Icon: Sparkles, title: () => 'Your agent is resolving the conflicts' },
  resolved: { tone: 'sky', Icon: Check, title: () => 'Your agent is done: check it and merge' },
  merged: { tone: 'mint', Icon: Check, title: () => 'Merged' },
  blocked: { tone: 'butter', Icon: TriangleAlert, title: () => 'Not merged yet' },
};

/** Where the merge stands, in the conversation, live; each step's next action is on it. */
export function MergeBand({ topic, merge, onCheck }: { readonly topic: Topic; readonly merge: MergeView; readonly onCheck: () => void }) {
  const b = BAND[merge.phase] ?? BAND.blocked!;
  const live = merge.phase === 'merging' || merge.phase === 'resolving';
  const resolve = () => {
    haptic.commit();
    void store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  return (
    <Animated.View key={merge.phase} entering={FadeIn.duration(260)}>
      <Card tone={b.tone} style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Breathe on={live}>
            <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
              <b.Icon color={toneInk(b.tone)} size={16} strokeWidth={1.9} />
            </View>
          </Breathe>
          <T v="callout" c={toneInk(b.tone)} style={{ fontWeight: '700', flex: 1 }}>
            {b.title(merge)}
          </T>
          {live ? <TypingDots tone={b.tone} /> : null}
        </View>
        {merge.why ? (
          <T v="callout" c={toneInk(b.tone)}>
            {merge.why}
          </T>
        ) : null}
        {merge.conflicts?.length && merge.phase !== 'merged' ? <Files files={merge.conflicts} /> : null}
        {merge.phase === 'conflicts' ? <Button label="Ask your agent to resolve" Icon={Sparkles} onPress={resolve} /> : null}
        {merge.phase === 'resolved' || merge.phase === 'blocked' ? (
          <Press onPress={onCheck} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: color.card }}>
            <RefreshCw color={color.text} size={14} />
            <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
              Check again
            </T>
          </Press>
        ) : null}
      </Card>
    </Animated.View>
  );
}

const BRANCH_TONE: Record<string, { tone: Tone; Icon: typeof Check }> = {
  merged: { tone: 'lavender', Icon: GitMerge },
  ok: { tone: 'mint', Icon: Check },
  error: { tone: 'rose', Icon: CircleAlert },
  warn: { tone: 'butter', Icon: TriangleAlert },
  wait: { tone: 'butter', Icon: Clock },
  info: { tone: 'sky', Icon: GitBranch },
  muted: { tone: 'plain', Icon: GitBranch },
};

/** Each step's icon (Claude's steps get Claude's sparkle). */
const STEP_ICON: Record<string, LucideIcon> = { merge_pr: GitMerge, merge_auto: Clock, cancel_auto: X, merge_admin: GitMerge, merge: GitMerge, update_branch: RefreshCw, mark_ready: Check, open_pr: GitPullRequest, pr: GitPullRequest, pr_draft: GitPullRequest, pr_original: GitPullRequest, pr_own: GitPullRequest, commit: GitCommitHorizontal, continue_after_merge: GitBranch, archive: ArchiveIcon, delete: Trash2, push: Upload, rerun_checks: RefreshCw };
const iconOf = (s: BranchStepView): LucideIcon => (s.claude ? Sparkles : (STEP_ICON[s.id] ?? GitBranch));
const toneOf = (s: BranchStepView): Tone => (s.danger ? 'rose' : s.claude ? 'peach' : s.id === 'archive' ? 'sky' : 'lavender');
const bare = (label: string): string => label.replace(/…$/, '');

/**
 * Where a worktree's branch stands, as the Mac's toolbar shows it, in one quiet line (BLG-104):
 * Merged (lavender), Ready to merge, Conflicts, checks… with why, and the one step it needs next
 * as a small pastel chip. Its other steps are under •••, as the Mac's chevron has them (tapping
 * the line opens them too). One place for all of it: the conversation's
 * ••• doesn't repeat them. Steps Claude does, and the ones that can't be undone, ask first.
 * An older Mac (before 1.8) only says the next step, besides merging and resolving here.
 */
export function BranchBand({ topic, branch, canMerge, onMerge }: { readonly topic: Topic; readonly branch: BranchView; readonly canMerge: boolean; readonly onMerge: () => void }) {
  const t = BRANCH_TONE[branch.tone] ?? BRANCH_TONE.muted!;
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState<BranchStepView | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [too, setToo] = useState(false);
  const familyOf = (step: BranchStepView | undefined): ThreadCountView | undefined => (step?.id === 'archive' ? branch.threads?.archive : step?.id === 'delete' ? branch.threads?.delete : undefined);
  const resolve = () => {
    haptic.commit();
    void store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  const steps = store.supports('branchSteps') ? (branch.steps ?? []).filter((s) => s.id !== 'merge' || canMerge) : [];
  const run = (step: BranchStepView, children?: ThreadChildren): void => {
    if (busy) return;
    if (step.id === 'merge') return onMerge();
    if (step.id === 'open_pr') return void (branch.pr?.url ? Linking.openURL(branch.pr.url) : openOnMac({ topic }));
    haptic.commit();
    setBusy(step.id);
    store
      .call<{ ok: boolean; message: string }>(calls.branchStep(topic, step.id as PhoneBranchStep, bare(step.label), children), { queue: false })
      .then(
        (r) => {
          if (r) store.toast({ text: r.message, tone: r.ok ? 'ok' : 'error' });
          // Archived or deleted: its conversation is gone from here too.
          if (r?.ok && (step.id === 'archive' || step.id === 'delete') && router.canGoBack()) router.back();
        },
        (e: Error) => store.toast({ text: e.message, tone: 'error' }),
      )
      .finally(() => setBusy(undefined));
  };
  // What Claude does, what can't be undone, and what would touch a chat's threads ask first (as on the Mac).
  const tap = (step: BranchStepView): void => {
    // Archive's default is to archive the threads too, delete's is to keep them (as on the Mac).
    setToo(step.id === 'archive');
    return step.claude || step.danger || familyOf(step)?.count ? setAsking(step) : run(step);
  };
  const [main, ...rest] = steps;
  const openPr: BranchStepView | undefined = branch.pr?.url && !steps.some((s) => s.id === 'open_pr') ? { id: 'open_pr', label: `Open PR #${branch.pr.number}`, hint: 'On GitHub' } : undefined;
  const others = [...rest, ...(openPr ? [openPr] : [])];
  // An older Mac: its next step in words, and merging or resolving here.
  const next = branch.next;
  const here = steps.length ? undefined : next?.id === 'merge' && canMerge ? 'merge' : next?.id === 'merge_claude' ? 'resolve' : undefined;
  // The one step it needs next, as a small pastel chip; an older Mac's merge or resolve the same way.
  const chip: { label: string; Icon: LucideIcon; tone: Tone; onPress: () => void } | undefined = main
    ? { label: busy ? 'Working…' : bare(main.label), Icon: iconOf(main), tone: toneOf(main), onPress: () => tap(main) }
    : here === 'merge'
      ? { label: bare(next!.label), Icon: GitMerge, tone: 'lavender', onPress: onMerge }
      : here === 'resolve'
        ? { label: 'Resolve', Icon: Sparkles, tone: 'peach', onPress: resolve }
        : undefined;
  const line = next && !here && !steps.length ? `Next, on your Mac: ${bare(next.label)}${next.claude ? ' (your agent does it)' : ''}` : branch.detail;
  // The row itself opens every step (the next one too), under the branch's state.
  const all = [...(main ? [main] : []), ...others];
  // Deleting asks with Archive first: it keeps the branch's commits and the conversation (BLG-617; the hint says what Delete loses).
  const keep = asking?.id === 'delete' ? steps.find((s) => s.id === 'archive') : undefined;
  const confirm = asking ? [...(keep ? [keep] : []), asking] : [];
  const family = familyOf(asking);
  const question = family?.count ? threadsQuestion(asking!.id === 'archive' ? 'archive' : 'delete', family) : undefined;
  // One answer for the sheet, Archive beside Delete included: the Mac's dialog has one box too.
  const children = branchChildren(store.supports('threads'), family, too);
  return (
    // No layout animation: on Android its snapshot drew as a black box, and a ghost of the old band under the chat.
    <Animated.View key={branch.kind} entering={FadeIn.duration(200)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}>
        <Press scaleTo={0.99} disabled={!all.length} onPress={() => setMore(true)} accessibilityLabel={`${branch.label}. ${line}`} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pill label={branch.pr ? `${branch.label} #${branch.pr.number}` : branch.label} tone={t.tone} Icon={t.Icon} style={{ height: 32, borderRadius: 16, paddingHorizontal: 12, flexShrink: 1 }} />
          {/* With a step beside it there's no room for the line: it's at the top of the ••• sheet. */}
          {chip ? null : (
            <T v="caption" c={color.text3} numberOfLines={1} style={{ flex: 1 }}>
              {line}
            </T>
          )}
        </Press>
        {chip ? (
          <Press
            disabled={Boolean(busy)}
            onPress={chip.onPress}
            accessibilityLabel={chip.label}
            hitSlop={6}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, maxWidth: 180, flexShrink: 1, paddingHorizontal: 14, borderRadius: 16, backgroundColor: toneBg(chip.tone), opacity: busy ? 0.6 : 1 }}
          >
            {busy ? <ActivityIndicator size="small" color={toneInk(chip.tone)} /> : <chip.Icon color={toneInk(chip.tone)} size={14} strokeWidth={1.9} />}
            <T v="caption" c={toneInk(chip.tone)} numberOfLines={1} style={{ fontWeight: '700', flexShrink: 1 }}>
              {chip.label}
            </T>
          </Press>
        ) : null}
        {/* ••• always fits: the chip and the line give way to it. */}
        {others.length ? (
          <View style={{ flexShrink: 0 }}>
            <More onPress={() => setMore(true)} label="Other steps" size={32} />
          </View>
        ) : null}
      </View>
      {/* The sheets open from inside the band, so in a window of their own: in the band's box they showed as a clipped sliver. */}
      <Options
        window
        visible={more}
        onClose={() => setMore(false)}
        title={`${branch.label} · ${branch.branch}`}
        head={
          line ? (
            <T v="callout" style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
              {line}
            </T>
          ) : undefined
        }
        options={all.map((s) => ({ Icon: iconOf(s), label: bare(s.label), sub: s.claude ? `Your agent · ${s.hint}` : s.hint, tone: toneOf(s), onPress: () => tap(s) }))}
      />
      <Options
        window
        visible={Boolean(asking)}
        onClose={() => setAsking(undefined)}
        title={asking?.danger ? 'This can’t be undone' : asking?.id === 'archive' ? 'Archive this chat' : 'Your agent does this in the conversation'}
        head={question ? <ThreadsBox question={question} on={too} onToggle={() => setToo(!too)} /> : undefined}
        options={confirm.map((s) => ({ Icon: iconOf(s), label: bare(s.label), sub: s.hint, tone: toneOf(s), onPress: () => run(s, children) }))}
      />
    </Animated.View>
  );
}

/** The one question about a chat's threads, inside its archive or delete sheet. */
function ThreadsBox({ question, on, onToggle }: { readonly question: { readonly label: string; readonly detail: string }; readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <Press onPress={onToggle} scaleTo={0.99} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={question.label} style={{ flexDirection: 'row', gap: 12, padding: 12, marginBottom: 6, borderRadius: 16, backgroundColor: color.sunken }}>
      <View style={{ width: 22, height: 22, marginTop: 1, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? toneBg('lavender') : color.card }}>
        {on ? <Check color={toneInk('lavender')} size={15} strokeWidth={2.4} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
          {question.label}
        </T>
        <T v="caption">{question.detail}</T>
      </View>
    </Press>
  );
}
