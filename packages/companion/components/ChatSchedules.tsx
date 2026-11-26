import { CalendarClock, Pause, Play } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { calls } from '../lib/link/calls';
import { scheduleSpent } from '../lib/schedules';
import type { ConvView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { whenWords } from '../lib/triage';
import { Sheet } from './Sheet';
import { haptic, IconBadge, Press, T, toneInk } from './ui';

/**
 * A chat's schedules (1.57, BLG-401): the sentinels that send into it, as the Mac's Info panel lists
 * them. Run now and Pause / Turn on only: the phone never makes or changes a schedule. One that
 * already ran its one time reads as done, with no Pause.
 */

type Schedules = NonNullable<ConvView['schedules']>;

export function SchedulesSheet({ schedules, visible, onClose }: { readonly schedules: Schedules | undefined; readonly visible: boolean; readonly onClose: () => void }) {
  const act = (call: ReturnType<typeof calls.sentinelRun>): void => {
    haptic.commit();
    void store.call(call, { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  return (
    <Sheet
      visible={visible && Boolean(schedules?.length)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={CalendarClock} tone="sky" size={32} />
          <View style={{ flex: 1 }}>
            <T v="title" style={{ fontSize: 20 }}>
              Schedules
            </T>
            <T v="caption">Sentinels that send into this chat. Make or change them on your Mac.</T>
          </View>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 2 }}>
        {(schedules ?? []).map((s) => {
          const spent = scheduleSpent(s);
          return (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.running ? toneInk('peach') : s.paused || spent ? color.text3 : toneInk('mint') }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
                  {s.name}
                </T>
                <T v="caption" numberOfLines={1}>
                  {[s.sentence, s.running ? 'running' : s.paused ? 'off' : s.nextAt !== undefined ? `next ${whenWords(s.nextAt)}` : spent ? 'done' : ''].filter(Boolean).join(' · ')}
                </T>
              </View>
              <Pill label="Run" Icon={Play} disabled={s.running} onPress={() => act(calls.sentinelRun(s.id, s.name))} accessibilityLabel={`Run ${s.name} now`} />
              {spent ? null : <Pill label={s.paused ? 'Turn on' : 'Pause'} Icon={s.paused ? Play : Pause} onPress={() => act(calls.sentinelPause(s.id, !s.paused, s.name))} accessibilityLabel={`${s.paused ? 'Turn on' : 'Pause'} ${s.name}`} />}
            </View>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

function Pill({ label, Icon, onPress, disabled, accessibilityLabel }: { label: string; Icon: typeof Play; onPress: () => void; disabled?: boolean; accessibilityLabel: string }) {
  return (
    <Press disabled={disabled} onPress={onPress} hitSlop={6} accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: color.sunken, opacity: disabled ? 0.5 : 1 }}>
      <Icon color={color.text2} size={12} />
      <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
        {label}
      </T>
    </Press>
  );
}
