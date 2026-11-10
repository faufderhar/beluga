import { Check, Gauge } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { until, useSupports } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { HomeView, UsageView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, ink } from '../lib/theme';
import { AgentMarkIcon, runtimeMark } from './AgentMark';
import { Sheet } from './Sheet';
import { Card, IconBadge, Pill, Press, T } from './ui';

/**
 * Your allowance, one provider each: a pastel bar per plan window (5 hours, week) with its percent
 * and when it resets, or a local model's tokens and speed. The card shows your default agent's;
 * tap it for every provider, each with the chip that makes it your default (1.32). A provider that
 * says its runtime leads with that agent's mark (BLG-497).
 */
const toneOf = (pct: number): 'mint' | 'butter' | 'rose' => (pct >= 90 ? 'rose' : pct >= 70 ? 'butter' : 'mint');

function Bar({ pct }: { pct: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(pct / 100, { duration: 700, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [pct]);
  const fill = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  const t = toneOf(pct);
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: color.sunken, overflow: 'hidden' }}>
      <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: ink[t], opacity: 0.5 }, fill]} />
    </View>
  );
}

/** "1.2M", "84k", "512" tokens. */
const shortTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** A provider without a plan (a local model): what it used, and how fast it answers. */
function TokenFigures({ usage, hideSpeed }: { readonly usage: UsageView; readonly hideSpeed?: boolean }) {
  const figure = (label: string, value: string, sub: string) => (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="caption">{label}</T>
      <T v="heading" style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </T>
      <T v="caption">{sub}</T>
    </View>
  );
  const t = usage.tokens;
  return (
    <View style={{ flexDirection: 'row', gap: 16 }}>
      {figure('Tokens', t ? shortTokens(t.input + t.output) : '–', t ? `${shortTokens(t.input)} in · ${shortTokens(t.output)} out` : 'since your Mac started')}
      {hideSpeed ? null : figure('Speed', usage.tokensPerSec !== undefined ? `${Math.round(usage.tokensPerSec)} tok/s` : '–', 'over its last run')}
    </View>
  );
}

export function UsageBars({ usage }: { readonly usage: UsageView }) {
  if (usage.signedIn === false) return <T v="caption">Not signed in on your Mac.</T>;
  if (usage.note && !usage.windows.length && !usage.tokens) return <T v="caption">{usage.note}</T>;
  if (!usage.windows.length)
    return (
      <View style={{ gap: 8 }}>
        <TokenFigures usage={usage} hideSpeed={Boolean(usage.note) && usage.tokensPerSec === undefined} />
        {usage.note ? <T v="caption">{usage.note}</T> : null}
      </View>
    );
  return (
    <View style={{ gap: 12 }}>
      {usage.windows.map((w) => (
        <View key={w.label} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <T v="callout" c={color.text} style={{ fontWeight: '500' }}>
              {w.label}
            </T>
            <T v="caption" style={{ flex: 1 }}>
              {w.resetsAt ? `resets in ${until(w.resetsAt)}` : ''}
            </T>
            <T v="callout" c={color.text} style={{ fontWeight: '700', fontVariant: ['tabular-nums'] }}>
              {Math.round(w.pct)}%
            </T>
          </View>
          <Bar pct={w.pct} />
        </View>
      ))}
    </View>
  );
}

/** The allowance at a glance; tapping it opens every provider (`onOpen`: the screen shows the `UsageSheet`, at its own level). */
export function UsageCard({ usage, title = 'Allowance', onOpen }: { readonly usage: readonly UsageView[]; readonly title?: string; readonly onOpen: () => void }) {
  const main = usage[0];
  if (!main) return null;
  return (
    <>
      <Press scaleTo={0.985} onPress={onOpen} accessibilityLabel={`${title}: all providers`} style={{ marginHorizontal: 16 }}>
        <Card style={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconBadge Icon={Gauge} tone="mint" size={30} />
            <T v="heading" style={{ flex: 1 }}>
              {title}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {main.runtime ? <AgentMarkIcon mark={runtimeMark(main.runtime)} size={13} color={color.text2} /> : null}
              <T v="caption">
                {main.provider}
                {usage.length > 1 ? ` +${usage.length - 1}` : ''}
              </T>
            </View>
          </View>
          <UsageBars usage={main} />
        </Card>
      </Press>
    </>
  );
}

/** Says which provider is your default, or makes this one it (from a Mac that has it, 1.32). */
function DefaultChip({ usage }: { readonly usage: UsageView }) {
  const can = useSupports('providers');
  const [busy, setBusy] = useState(false);
  if (usage.isDefault) return <Pill label="Default" Icon={Check} />;
  if (!can || !usage.runtime || usage.isDefault === undefined) return null;
  const make = () => {
    setBusy(true);
    void store
      .call(calls.defaultAgent(usage.runtime!), { queue: false })
      .catch(() => store.toast({ text: 'Your Mac is away: change this when it’s linked.', tone: 'warn' }))
      .finally(() => setBusy(false));
  };
  return (
    <Press onPress={make} disabled={busy} accessibilityLabel={`Make ${usage.provider} your default agent`} hitSlop={6}>
      <Pill label={busy ? 'Making default…' : 'Make default'} />
    </Press>
  );
}

function CacheSection({ cache }: { readonly cache: NonNullable<HomeView['cache']> }) {
  const sessions = cache.filter((r) => r.scope === 'session');
  const models = cache.filter((r) => r.scope === 'model');
  const block = (title: string, rows: typeof sessions) => (
    <View style={{ gap: 6 }}>
      <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
        {title}
      </T>
      {rows.length ? (
        rows.map((r) => (
          <View key={`${r.scope}:${r.label}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <T v="caption" style={{ flex: 1 }} numberOfLines={1}>
              {r.label}
            </T>
            <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
              {Math.round(r.pct)}%
            </T>
          </View>
        ))
      ) : (
        <T v="caption">No cache measurements yet.</T>
      )}
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <T v="heading">Cache</T>
      {cache.length ? (
        <>
          <T v="caption">By session is this conversation. By model counts each one under the model it uses now.</T>
          {block('By session', sessions)}
          {block('By model', models)}
        </>
      ) : (
        <T v="caption">No cache measurements yet.</T>
      )}
    </View>
  );
}

export function UsageSheet({ usage, cache, visible, onClose }: { readonly usage: readonly UsageView[]; readonly cache?: HomeView['cache']; readonly visible: boolean; readonly onClose: () => void }) {
  return (
    <Sheet window visible={visible} onDismiss={onClose}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 22 }}>
        {usage.map((u) => (
          <View key={u.runtime ?? u.provider} style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {u.runtime ? <AgentMarkIcon mark={runtimeMark(u.runtime)} size={18} color={color.text2} /> : null}
              <T v="heading" style={{ flex: 1 }}>
                {u.provider}
                {u.plan ? <T v="callout"> · {u.plan}</T> : null}
              </T>
              <DefaultChip usage={u} />
            </View>
            <UsageBars usage={u} />
          </View>
        ))}
        {cache ? <CacheSection cache={cache} /> : null}
      </View>
    </Sheet>
  );
}
