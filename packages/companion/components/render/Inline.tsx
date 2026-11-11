import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ArrowDownRight, ArrowRight, ArrowUpRight, GitBranch, Shield, Workflow } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { useSupports, useView } from '../../lib/hooks';
import type { PlansView, SentinelsView, WorkView } from '../../lib/link/protocol';
import { type InlineElement, parseColor, readInline, relative, toneOf } from '../../lib/render';
import { store } from '../../lib/store';
import { color, ink, tint, type } from '../../lib/theme';
import { haptic, Press, type Tone, toneBg, toneInk } from '../ui';
import { TaskChip } from './TaskChip';

/**
 * The inline elements of docs/views.md, inside a sentence: an inline code span the Mac draws as
 * something (a color, a badge, key caps, progress, a change, a sparkline, a time, a task, a
 * worktree or a plan Your Mac started, a sentinel) is drawn
 * as it here, read by the same model (src/shared/render/inline-model.ts). Anything else stays code.
 */

/** A badge's pastel from its words, as the Mac reads them (shared toneOf). */
export const badgeTone = (text: string): Tone => ({ good: 'mint', critical: 'rose', warning: 'butter', info: 'sky', neutral: 'plain' } as const)[toneOf(text)];

export function Spark({ values, w = 54, h = 16, c = color.info }: { readonly values: readonly number[]; readonly w?: number; readonly h?: number; readonly c?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`).join(' ');
  return (
    <Svg width={w} height={h}>
      <Polyline points={pts} fill="none" stroke={c} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

export function Swatch({ value, size = 12 }: { readonly value: string; readonly size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 3, backgroundColor: value, borderWidth: 1, borderColor: color.hairlineStrong }} />;
}

const pill = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: 6, borderRadius: 7, height: 22, alignSelf: 'center' as const };

/** One inline element (drawn inside a line of text). */
export function InlineThing({ el }: { readonly el: InlineElement }) {
  switch (el.kind) {
    case 'color':
      return (
        <Press haptics={false} onPress={() => (haptic.tap(), void Clipboard.setStringAsync(el.value), store.toast({ text: `Copied ${el.value}`, tone: 'ok' }))} style={[pill, { backgroundColor: color.code }]}>
          <Swatch value={parseColor(el.value) ? el.value : '#000'} />
          <Text style={[type.mono, { color: color.text, fontSize: 12.5 }]}>{el.value}</Text>
        </Press>
      );
    case 'colors':
      return (
        <View style={[pill, { backgroundColor: color.code, gap: 2 }]}>
          {el.values.map((v, i) => (
            <Swatch key={i} value={v} size={14} />
          ))}
        </View>
      );
    case 'badge': {
      const t = badgeTone(el.text);
      return (
        <View style={[pill, { backgroundColor: toneBg(t) }]}>
          <Text style={{ ...type.caption, color: toneInk(t), fontWeight: '700' }}>{el.text}</Text>
        </View>
      );
    }
    case 'kbd':
      return (
        <View style={{ flexDirection: 'row', gap: 3, alignSelf: 'center' }}>
          {el.keys.map((k, i) => (
            <View key={i} style={{ minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, borderWidth: 1, borderBottomWidth: 2, borderColor: color.hairlineStrong }}>
              <Text style={{ ...type.caption, color: color.text, fontWeight: '600' }}>{k}</Text>
            </View>
          ))}
        </View>
      );
    case 'progress':
      return (
        <View style={[pill, { backgroundColor: color.code, gap: 6 }]}>
          <View style={{ width: 46, height: 5, borderRadius: 3, backgroundColor: color.hairline, overflow: 'hidden' }}>
            <View style={{ width: `${el.ratio * 100}%`, height: 5, borderRadius: 3, backgroundColor: el.ratio >= 1 ? color.ok : color.info }} />
          </View>
          <Text style={{ ...type.caption, color: color.text2, fontVariant: ['tabular-nums'] }}>{el.label}</Text>
        </View>
      );
    case 'delta': {
      const good = el.good;
      const c = good === undefined ? color.text2 : good ? color.ok : color.error;
      const Arrow = el.dir > 0 ? ArrowUpRight : el.dir < 0 ? ArrowDownRight : ArrowRight;
      return (
        <View style={[pill, { backgroundColor: good === undefined ? color.code : good ? tint.ok : tint.error }]}>
          <Arrow color={c} size={13} strokeWidth={1.9} />
          <Text style={{ ...type.caption, color: c, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{el.text}</Text>
        </View>
      );
    }
    case 'spark':
      return (
        <Press haptics={false} onPress={() => store.toast({ text: el.values.join(', '), tone: 'info' })} style={[pill, { backgroundColor: color.code }]}>
          <Spark values={el.values} />
        </Press>
      );
    case 'time':
      return (
        <Press haptics={false} onPress={() => store.toast({ text: new Date(el.at).toLocaleString(), tone: 'info' })} style={[pill, { backgroundColor: color.code }]}>
          <Text style={{ ...type.caption, color: color.text, fontWeight: '600' }}>{el.dateOnly ? new Date(el.at).toLocaleDateString() : relative(el.at)}</Text>
        </Press>
      );
    case 'task':
      return <TaskChip k={el.key} />;
    case 'worktree':
      return <WorktreeChip id={el.id} />;
    case 'plan':
      return <PlanChip id={el.id} />;
    case 'sentinel':
      return <SentinelChip id={el.id} />;
  }
}

/**
 * The worktrees Work knows, by id (`on`: only then, so other screens don't ask for Work): a pasted
 * "worktree:wt-…" naming one is drawn as its chip (BLG-878).
 */
export function useWorktreeIds(on: boolean): ReadonlySet<string> {
  const work = useView<WorkView>(on ? 'work' : undefined);
  return useMemo(() => new Set(work?.data.projects.flatMap((p) => p.conversations.flatMap((c) => (c.topic.startsWith('conv:ws:') ? [c.topic.slice('conv:ws:'.length)] : []))) ?? []), [work]);
}

/** A worktree Your Mac started (`worktree:<id>`): its name from Work (live); a tap opens its conversation. */
function WorktreeChip({ id }: { readonly id: string }) {
  const work = useView<WorkView>('work');
  const topic = `conv:ws:${id}`;
  const found = work?.data.projects.flatMap((p) => p.conversations.map((c) => ({ c, project: p.name }))).find((x) => x.c.topic === topic);
  return (
    <Press haptics={false} onPress={() => router.push(`/conv/${encodeURIComponent(`ws:${id}`)}`)} style={[pill, { backgroundColor: tint.mint }]}>
      <GitBranch color={ink.mint} size={12} strokeWidth={1.9} />
      <Text numberOfLines={1} style={{ ...type.caption, color: ink.mint, fontWeight: '700', maxWidth: 180 }}>
        {found ? `${found.project} · ${found.c.title}` : 'New worktree'}
      </Text>
    </Press>
  );
}

/** A plan Your Mac started (`plan:<id>`): its name from Plans (live); a tap opens it. */
function PlanChip({ id }: { readonly id: string }) {
  const plans = useView<PlansView>('plans');
  const plan = plans?.data.plans.find((p) => p.id === id);
  return (
    <Press haptics={false} onPress={() => router.push(`/plan/${encodeURIComponent(id)}`)} style={[pill, { backgroundColor: tint.butter }]}>
      <Workflow color={ink.butter} size={12} strokeWidth={1.9} />
      <Text numberOfLines={1} style={{ ...type.caption, color: ink.butter, fontWeight: '700', maxWidth: 180 }}>
        {plan?.title ?? 'Plan'}
      </Text>
    </Press>
  );
}

/** A sentinel Claude set up or names (`sentinel:<id>`, 1.21): its name from Sentinel (live); a tap opens it. */
function SentinelChip({ id }: { readonly id: string }) {
  const on = useSupports('sentinel');
  const list = useView<SentinelsView>(on ? 'sentinels' : undefined);
  const s = list?.data.sentinels.find((x) => x.id === id);
  return (
    <Press haptics={false} disabled={!on} onPress={() => router.push(`/sentinel/${encodeURIComponent(id)}`)} style={[pill, { backgroundColor: tint.sky }]}>
      <Shield color={ink.sky} size={12} strokeWidth={1.9} />
      <Text numberOfLines={1} style={{ ...type.caption, color: ink.sky, fontWeight: '700', maxWidth: 180 }}>
        {s?.name ?? 'Sentinel'}
      </Text>
    </Press>
  );
}

/** An inline code span: an element when it reads as one, else code. */
export function inlineOf(raw: string): InlineElement | undefined {
  return readInline(raw);
}
