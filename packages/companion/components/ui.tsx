import * as Haptics from 'expo-haptics';
import { ChevronDown, ChevronRight, Ellipsis, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Platform, Pressable, type PressableProps, type StyleProp, StyleSheet, Text, type TextProps, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { color, elevation, ink, radius, scheme, stroke, tint, type, typeColor } from '../lib/theme';
import { type AgentMark, AgentMarkIcon, type IconLike } from './AgentMark';

/**
 * The app's small parts. One pattern everywhere: a line icon in one ink, one or two words, the
 * primary action on the surface, and everything else one tap away behind "•••". Color is for
 * meaning only (needs you, a problem, a link), never to tell icons apart.
 */

export const haptic = {
  tap: (): void => void (Platform.OS !== 'web' && Haptics.selectionAsync().catch(() => {})),
  commit: (): void => void (Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})),
  success: (): void => void (Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})),
  warn: (): void => void (Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})),
};

type Variant = keyof typeof type;
export function T({ v = 'body', c, style, ...rest }: TextProps & { readonly v?: Variant; readonly c?: string }) {
  return <Text {...rest} style={[type[v] as TextStyle, { color: c ?? typeColor(v) }, style]} />;
}

/** The pastel a meaning is drawn in. */
export type Tone = 'sky' | 'mint' | 'peach' | 'lavender' | 'butter' | 'rose' | 'plain';
export const toneBg = (t: Tone): string => (t === 'plain' ? color.sunken : tint[t]);
export const toneInk = (t: Tone): string => (t === 'plain' ? color.text2 : ink[t]);

/** A card: white (or slate) on the grey page, a hairline edge, and the faintest lift in light. */
export function Card({ children, style, tone, r = radius.l }: { readonly children?: ReactNode; readonly style?: StyleProp<ViewStyle>; readonly tone?: Tone; readonly r?: number }) {
  return (
    <View
      style={[
        {
          borderRadius: r,
          backgroundColor: tone && tone !== 'plain' ? tint[tone] : elevation.card.surface,
          // Tone and a hairline separate cards from the page; in light a soft shadow too.
          borderWidth: tone ? 0 : 1,
          borderColor: elevation.card.border,
          ...(scheme === 'light' && !tone ? shadow() : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
const shadow = (): ViewStyle =>
  Platform.select({
    web: { boxShadow: color.shadowCss } as ViewStyle,
    default: { shadowColor: color.shadowInk, shadowOpacity: 0.03, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 0 },
  })!;

/**
 * A press: it dims while held (on the UI thread), with a selection tick. No scaling or springing:
 * the app answers a touch, it doesn't perform. `scaleTo` is kept for callers and ignored.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function Press({ children, style, scaleTo: _scaleTo, onPress, haptics = true, ...rest }: Omit<PressableProps, 'style' | 'children'> & { readonly style?: StyleProp<ViewStyle>; readonly scaleTo?: number; readonly haptics?: boolean; readonly children?: ReactNode }) {
  const o = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <AnimatedPressable
      {...rest}
      style={[style, anim]}
      onPressIn={(e) => {
        o.value = withTiming(0.55, { duration: 60 });
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        o.value = withTiming(1, { duration: 160 });
        rest.onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptics) haptic.tap();
        onPress?.(e);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * An icon, the app's main visual unit: a line drawing in one ink. Small ones (rows, cards) stand
 * on their own; large ones (an empty state, a sheet's head) sit in a hairline ring. Only a tone
 * that means something (butter: needs you, rose: a problem) colors it.
 */
export function IconBadge({ Icon, tone, size = 36, square }: { readonly Icon: IconLike; readonly tone: Tone; readonly size?: number; readonly square?: boolean }) {
  const ringed = size >= 44;
  return (
    <View style={{ width: size, height: size, borderRadius: square ? size * 0.28 : size / 2, alignItems: 'center', justifyContent: 'center', ...(ringed ? { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: color.hairlineStrong } : {}) }}>
      <Icon color={toneInk(tone)} size={Math.round(size * (ringed ? 0.46 : 0.6))} strokeWidth={stroke} />
    </View>
  );
}

/**
 * A small label: an optional icon and a word or two, as quiet text in a hairline outline. A tone
 * that means something (butter, rose) inks it and gives it the faintest fill.
 */
export function Pill({ label, tone = 'plain', Icon, style }: { readonly label: string; readonly tone?: Tone; readonly Icon?: IconLike; readonly style?: ViewStyle }) {
  const meant = tone === 'butter' || tone === 'rose';
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 8, borderRadius: 6, backgroundColor: meant ? toneBg(tone) : 'transparent', borderWidth: meant ? 0 : StyleSheet.hairlineWidth * 2, borderColor: color.hairline }, style]}>
      {Icon ? <Icon color={toneInk(tone)} size={12} strokeWidth={stroke} /> : null}
      <Text style={{ ...type.caption, fontSize: 12, color: meant ? toneInk(tone) : color.text2, fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The "•••" button: where the advanced options of anything live. */
export function More({ onPress, label = 'More', size = 34 }: { readonly onPress: () => void; readonly label?: string; readonly size?: number }) {
  return (
    <Press onPress={onPress} accessibilityLabel={label} hitSlop={8} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
      <Ellipsis color={color.text2} size={18} strokeWidth={2} />
    </Press>
  );
}

/** A list row: icon badge, a label (and a quiet line under it), something on the right, a chevron. */
/**
 * A list row. `shared`: it's shared with someone (a worktree of yours, 1.55): a small green dot at
 * its icon's corner, named for screen readers ("Shared with 2 people").
 */
export function Row({ Icon, tone = 'plain', label, sub, right, onPress, onLongPress, chevron = true, first, shared }: { readonly Icon?: LucideIcon; readonly tone?: Tone; readonly label: string; readonly sub?: string; readonly right?: ReactNode; readonly onPress?: () => void; readonly onLongPress?: (() => void) | undefined; readonly chevron?: boolean; readonly first?: boolean; readonly shared?: string }) {
  const badge = Icon ? <IconBadge Icon={Icon} tone={tone} size={30} /> : null;
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
      {badge && shared ? (
        <View>
          {badge}
          <View accessible accessibilityLabel={shared} style={{ position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, borderRadius: 5, backgroundColor: color.ok, borderWidth: 2, borderColor: elevation.card.surface }} />
        </View>
      ) : (
        badge
      )}
      <View style={{ flex: 1, gap: 1 }}>
        <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
          {label}
        </T>
        {sub ? (
          <T v="caption" numberOfLines={1}>
            {sub}
          </T>
        ) : null}
      </View>
      {right}
      {onPress && chevron ? <ChevronRight color={color.text3} size={18} /> : null}
    </View>
  );
  return (
    <View>
      {!first ? <Hairline style={{ marginLeft: Icon ? 56 : 14 }} /> : null}
      {onPress ? (
        <Press onPress={onPress} {...(onLongPress ? { onLongPress, delayLongPress: 350 } : {})}>
          {body}
        </Press>
      ) : (
        body
      )}
    </View>
  );
}

/** A name's tone, kept for callers: people are told apart by their initial, so it is always neutral. */
export const hueOf = (_name: string): Tone => 'plain';
const PRESENCE: Record<string, () => string> = { online: () => color.ok, away: () => color.warn, dnd: () => color.error, offline: () => color.text3 };

/**
 * A person's initial on a neutral disc; their agent gets its mark (`mark`, BLG-497: Claude Code,
 * Codex, a local model; none said: Claude Code's, an older Mac's). `owner` kept for callers, BLG-210.
 */
export function Avatar({ name, size = 40, presence, claude, mark }: { readonly name: string; readonly size?: number; readonly presence?: string; readonly claude?: boolean; readonly mark?: AgentMark; readonly owner?: string }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline }}>
        {claude || mark ? <AgentMarkIcon mark={mark ?? 'claudeCode'} color={color.text2} size={Math.round(size * 0.5)} /> : <Text style={{ color: color.text2, fontSize: size * 0.4, fontWeight: '600' }}>{(name[0] ?? '?').toUpperCase()}</Text>}
      </View>
      {presence ? <View style={{ position: 'absolute', right: -1, bottom: -1, width: size * 0.3, height: size * 0.3, borderRadius: size, backgroundColor: PRESENCE[presence]?.() ?? color.text3, borderWidth: 2.5, borderColor: color.bg }} /> : null}
    </View>
  );
}

export function Section({ title, right, children, style }: { readonly title: string; readonly right?: ReactNode; readonly children?: ReactNode; readonly style?: ViewStyle }) {
  return (
    <View style={[{ marginTop: 28 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 10 }}>
        <T v="eyebrow">{title}</T>
        {right}
      </View>
      {children}
    </View>
  );
}

/**
 * A group's head that folds it: what it is (a project's mark and name), a quiet count while
 * folded, anything else on the right, and a chevron that turns. The whole head is the tap.
 */
export function FoldHead({ folded, onToggle, lead, label, count, right, big }: { readonly folded: boolean; readonly onToggle: () => void; readonly lead?: ReactNode; readonly label: string; readonly count?: number; readonly right?: ReactNode; readonly big?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 4 }}>
      <Press onPress={onToggle} haptics accessibilityRole="button" accessibilityState={{ expanded: !folded }} accessibilityLabel={`${label}, ${folded ? 'folded' : 'open'}`} hitSlop={6} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }}>
        {lead}
        <T v={big ? 'heading' : 'callout'} c={color.text} numberOfLines={1} style={{ flexShrink: 1, fontWeight: '600' }}>
          {label}
        </T>
        {folded && count ? (
          <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
            {count}
          </T>
        ) : null}
        <View style={{ flex: 1 }} />
        <View style={{ transform: [{ rotate: folded ? '-90deg' : '0deg' }] }}>
          <ChevronDown color={color.text3} size={17} />
        </View>
      </Press>
      {right}
    </View>
  );
}

export function StatusDot({ c, size = 8 }: { readonly c: string; readonly size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: c }} />;
}

/** The pastel for a state word (conversations, plans, tasks). */
export const toneOf = (s: string | undefined): Tone =>
  s === 'working' || s === 'running' ? 'peach' : s === 'waiting' || s === 'review' || s === 'blocked' ? 'butter' : s === 'failed' ? 'rose' : s === 'done' ? 'mint' : s === 'draft' ? 'lavender' : 'plain';

export const Hairline = ({ style }: { readonly style?: ViewStyle }) => <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: color.hairline }, style]} />;

/** The main button: ink on light, light on dark. `quiet` for the second choice. */
export function Button({ label, onPress, Icon, quiet, disabled, style, flex }: { readonly label: string; readonly onPress: () => void; readonly Icon?: LucideIcon; readonly quiet?: boolean; readonly disabled?: boolean; readonly style?: ViewStyle; readonly flex?: number }) {
  return (
    <Press disabled={disabled} onPress={onPress} style={[{ flex, height: 46, borderRadius: radius.m, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: quiet ? color.sunken : color.primary, opacity: disabled ? 0.4 : 1 }, style]}>
      {Icon ? <Icon color={quiet ? color.text : color.onPrimary} size={18} strokeWidth={stroke} /> : null}
      <T v="body" c={quiet ? color.text : color.onPrimary} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
        {label}
      </T>
    </Press>
  );
}
