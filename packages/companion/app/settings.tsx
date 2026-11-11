import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { ArrowDownToLine, AtSign, Bell, Cable, RefreshCw, Search, TriangleAlert, ChevronDown, ChevronUp, CircleCheck, Download, Hand, HardDrive, Info, LogOut, Mic, Monitor, MonitorSmartphone, Moon, MoonStar, Network, ShieldCheck, SlidersHorizontal, Smartphone, Sun } from 'lucide-react-native';
import { Segments } from '../components/Segments';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, haptic, Pill, Row, T } from '../components/ui';
import { appearance, type Choice } from '../lib/appearance';
import { useLink, useSupports, useView } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { HomeView } from '../lib/link/protocol';
import { COMPANION_PROTO } from '../lib/link/protocol';
import { type NotifyPrefs, permission, prefs, setPrefs } from '../lib/notifications';
import { pathLabel } from '../lib/link/diagnose';
import { sizeOf } from '../components/Outputs';
import { useSaved } from '../lib/saved';
import { totalBytes } from '../lib/saved-list';
import { store } from '../lib/store';
import { askBatteryUnrestricted, batteryUnrestricted, setStay, stayAvailable, stayOn } from '../lib/stay';
import { accessibilityOn, addonInstalled, onAccessibilityChange, openAccessibilitySettings, phoneAllowed, phoneControlAvailable, setPhoneAllowed } from '../lib/phone';
import { color, ink } from '../lib/theme';
import { voiceAvailable, voiceChoice, voiceSetting } from '../lib/voice';
import { UpdateSheet } from '../components/Update';
import { appUpdate } from '../modules/app-update';
import { appVersion, autoOn, checkForUpdate, checkOn, setAuto, setCheck, updatesAvailable, useUpdate } from '../lib/update';
import { VOICE_MODELS } from '../../../src/shared/voice-models';

/**
 * The phone's own settings. On top: your Mac, notifications on or off, Storage, sign out. Everything else
 * (each kind of notification, the demo's switches, versions). Appearance sits with the basics under Advanced.
 * Voice (BLG-142) opens its own page: where the microphone's words are written down, and by which model.
 */
type KeepAwake = NonNullable<HomeView['mac']['keepAwake']>;

export default function Settings() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const link = useLink();
  const supportsAgents = useSupports('externalAgents');
  const [p, setP] = useState<NotifyPrefs>(prefs());
  const [perm, setPerm] = useState<string>('');
  const [asleep, setAsleep] = useState(store.demo?.sleeping ?? false);
  const [confirm, setConfirm] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [look, setLook] = useState<Choice>(appearance.get());
  const saved = useSaved();
  const home = useView<HomeView>('home');
  const [stay, setStayOn] = useState(stayOn());
  const [unrestricted, setUnrestricted] = useState(true);
  useEffect(() => setUnrestricted(batteryUnrestricted()), [stay]);
  // Let your Mac use this phone (BLG-150): the phone's own switch, and whether Accessibility is on.
  const canControl = link.mode === 'bare' && phoneControlAvailable();
  const [control, setControl] = useState(phoneAllowed());
  const [acc, setAcc] = useState(accessibilityOn());
  const [addon, setAddon] = useState(addonInstalled());
  // Updates (BLG-426): the phone app's own, as the Mac's Settings › General › Updates.
  const update = useUpdate();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [canInstall, setCanInstall] = useState(appUpdate.canInstall());
  // Back from Android's settings (notifications, battery, accessibility): show what's true now.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void permission(false).then(setPerm);
      setUnrestricted(batteryUnrestricted());
      setAcc(accessibilityOn());
      setAddon(addonInstalled());
      setCanInstall(appUpdate.canInstall());
    });
    return () => sub.remove();
  }, []);
  // Beluga Link answers a moment after the app binds it: show its Accessibility as soon as it does.
  useEffect(
    () =>
      onAccessibilityChange(() => {
        setAcc(accessibilityOn());
        setAddon(addonInstalled());
      }),
    [],
  );
  const toggleControl = () => {
    haptic.tap();
    const next = !control;
    setPhoneAllowed(next);
    setControl(next);
    // Control needs the link up in the background, so turn Stay connected on with it.
    if (next && !stay) {
      setStay(true);
      setStayOn(true);
      if (perm !== 'granted') void permission(true).then(setPerm);
      if (!batteryUnrestricted()) askBatteryUnrestricted();
    }
    store.staySet();
    store.controlSet(next);
    // Without Beluga Link there's nothing to turn on yet: the guide says how to get it (BLG-390).
    if (next && !accessibilityOn()) {
      if (addonInstalled()) openAccessibilitySettings();
      else router.push('/link');
    }
  };
  const toggleStay = () => {
    haptic.tap();
    const next = !stay;
    setStay(next);
    setStayOn(next);
    store.staySet();
    if (!next) return;
    if (perm !== 'granted') void permission(true).then(setPerm);
    // Without it, Android's battery saver may still cut the link off after a while.
    if (!batteryUnrestricted()) askBatteryUnrestricted();
  };
  const canKeepAwake = useSupports('keepAwake');
  const [awake, setAwake] = useState<KeepAwake | undefined>(undefined);
  const keepAwake = awake ?? home?.data.mac.keepAwake ?? 'off';
  const chooseAwake = (mode: KeepAwake) => {
    haptic.tap();
    setAwake(mode);
    void store.call(calls.keepAwake(mode), { queue: false }).catch(() => {
      setAwake(undefined);
      store.toast({ text: 'Your Mac is away: change this when it’s linked.', tone: 'warn' });
    });
  };
  useEffect(() => {
    void permission(false).then(setPerm);
  }, []);

  const save = (next: NotifyPrefs) => {
    haptic.tap();
    setP(next);
    setPrefs(next);
    if ((next.needsYou || next.done || next.mentions) && perm !== 'granted') void permission(true).then(setPerm);
  };
  const all = p.needsYou || p.done || p.mentions;
  const toggle = (on: boolean, onChange: () => void) => (
    <View pointerEvents="none">
      <Switch value={on} onValueChange={onChange} trackColor={{ true: ink.mint, false: color.hairlineStrong }} thumbColor={color.white} {...(Platform.OS === 'web' ? ({ activeThumbColor: color.white } as object) : {})} />
    </View>
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Settings" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}>
        <Animated.View entering={FadeIn.duration(300)}>
          <Card>
            <Row first Icon={Monitor} tone="mint" label={link.mac?.name ?? link.pairing?.macName ?? 'Your Mac'} sub={link.mode === 'demo' ? 'Demo Mac' : `Beluga ${link.mac?.version ?? ''}`} right={<Pill label={link.phase === 'open' ? 'Linked' : link.phase === 'asleep' ? 'Asleep' : 'Away'} tone={link.phase === 'open' ? 'mint' : 'sky'} />} />
            <Row
              Icon={Bell}
              tone="butter"
              label="Notifications"
              sub={perm === 'denied' ? 'Off in Android settings: tap to turn them on' : undefined}
              right={toggle(all && perm !== 'denied', () => {})}
              // Off in Android: the switch takes you there (lib/notifications.ts), whatever the app's own choice.
              onPress={() => (perm === 'denied' ? void permission(true).then(setPerm) : save({ needsYou: !all, done: !all, mentions: !all }))}
              chevron={false}
            />
            {link.mode === 'bare' && stayAvailable() ? (
              <Row
                Icon={Cable}
                tone="lavender"
                label="Stay connected"
                sub={stay ? 'Tells you when your agent finishes or needs you, screen off too' : 'Notifications with the app closed. Uses a little battery'}
                right={toggle(stay, () => {})}
                onPress={toggleStay}
                chevron={false}
              />
            ) : null}
            {stay && !unrestricted ? (
              <Row
                Icon={TriangleAlert}
                tone="butter"
                label="Let it run in the background"
                sub="Android’s battery saver may cut the link off. Allow Beluga to fix it."
                onPress={askBatteryUnrestricted}
              />
            ) : null}
            {Platform.OS !== 'web' && voiceAvailable() ? <VoiceRow /> : null}
            {canControl ? (
              <Row
                Icon={MonitorSmartphone}
                tone="sky"
                label="Let your Mac use this phone"
                sub={control ? 'Your agent on your Mac can look at this phone and tap, type and open apps when you ask' : 'Ask your agent on your Mac to do things here: screenshots, taps, open apps, install a build'}
                right={toggle(control, () => {})}
                onPress={toggleControl}
                chevron={false}
              />
            ) : null}
            {canControl && control && !acc && !addon ? (
              <Row
                Icon={Download}
                tone="peach"
                label="Get Beluga Link"
                sub="The small app your Mac taps and types with. How to install it"
                onPress={() => router.push('/link')}
              />
            ) : null}
            {canControl && control && !acc && addon ? (
              <Row
                Icon={ShieldCheck}
                tone="peach"
                label="Turn on Beluga Link"
                sub="Android › Accessibility › Beluga Link. A downloaded app first needs “Allow restricted settings” from its App info ⋮ menu."
                onPress={openAccessibilitySettings}
              />
            ) : null}
            {update.release && update.phase !== 'current' ? (
              <Row Icon={ArrowDownToLine} tone="mint" label={`Update to Beluga ${update.release.version}`} sub={update.phase === 'downloading' ? `Downloading ${Math.round((update.progress ?? 0) * 100)}%` : update.phase === 'ready' ? 'Ready to install' : 'See what’s new'} onPress={() => setUpdateOpen(true)} />
            ) : null}
            {supportsAgents ? <Row Icon={Cable} tone="lavender" label="External agents" sub="What they did, and stopping them" onPress={() => router.push('/agents')} /> : null}
            <Row Icon={HardDrive} tone="sky" label="Storage" sub={saved.length ? `${saved.length} saved · ${sizeOf(totalBytes(saved))}` : 'What Beluga keeps on this phone'} onPress={() => router.push('/storage')} />
            <Row
              Icon={LogOut}
              tone="rose"
              label={confirm ? 'Tap again to sign out' : link.mode === 'demo' ? 'Leave the demo' : 'Sign out'}
              onPress={async () => {
                if (!confirm) {
                  haptic.warn();
                  setConfirm(true);
                  return;
                }
                const r = await store.signOut();
                if (link.mode === 'bare' && !r.onMac) store.toast({ text: 'Signed out here. Your Mac was away: remove this phone there too (Settings › Phone).', tone: 'warn' });
                router.replace('/pair');
              }}
              chevron={false}
            />
          </Card>
        </Animated.View>

            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Appearance
              </T>
              <Segments
                value={look}
                onChange={(c: Choice) => {
                  setLook(c);
                  appearance.set(c);
                }}
                options={[
                  { key: 'system', label: 'System', Icon: Smartphone },
                  { key: 'light', label: 'Light', Icon: Sun },
                  { key: 'dark', label: 'Dark', Icon: Moon },
                ]}
              />
            </View>

        <Card>
          <Row first Icon={SlidersHorizontal} tone="lavender" label="Advanced" onPress={() => setAdvanced((a) => !a)} chevron={false} right={advanced ? <ChevronUp color={color.text3} size={18} /> : <ChevronDown color={color.text3} size={18} />} />
        </Card>

        {advanced ? (
          <Animated.View entering={FadeIn.duration(250)} style={{ gap: 20 }}>
            {link.mode === 'bare' ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Connection
                </T>
                <Card>
                  <Row
                    first
                    Icon={Network}
                    tone={link.path === 'relay' ? 'lavender' : 'mint'}
                    label={link.phase === 'open' && link.path ? pathLabel(link.path) : link.diagnosis?.title ?? 'Not linked right now'}
                    sub={link.phase === 'open' && link.path === 'relay' ? 'A direct connection didn’t work on this network; the relay carries only encrypted bytes.' : undefined}
                    chevron={false}
                  />
                </Card>
              </View>
            ) : null}
            {link.mode !== 'demo' && canKeepAwake ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Keep your Mac awake
                </T>
                <Segments
                  value={keepAwake}
                  onChange={chooseAwake}
                  options={[
                    { key: 'off', label: 'Never' },
                    { key: 'power', label: 'On power' },
                    { key: 'always', label: 'Always' },
                  ]}
                />
                <T v="caption" c={color.text3} style={{ paddingHorizontal: 6 }}>
                  A sleeping Mac can’t be reached or woken from here, so Beluga keeps it from sleeping. Its display still sleeps; closing the lid still sleeps it.
                </T>
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Notify me about
              </T>
              <Card>
                <Row first Icon={Hand} tone="peach" label="Needs you" right={toggle(p.needsYou, () => {})} onPress={() => save({ ...p, needsYou: !p.needsYou })} chevron={false} />
                <Row Icon={CircleCheck} tone="mint" label="Done" sub={stay ? 'When your agent finishes' : 'Things you asked from the phone'} right={toggle(p.done, () => {})} onPress={() => save({ ...p, done: !p.done })} chevron={false} />
                <Row Icon={AtSign} tone="sky" label="Mentions" right={toggle(p.mentions, () => {})} onPress={() => save({ ...p, mentions: !p.mentions })} chevron={false} />
              </Card>
            </View>

            {link.mode === 'demo' ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Demo
                </T>
                <Card>
                  <Row
                    first
                    Icon={MoonStar}
                    tone="sky"
                    label="Mac asleep"
                    sub="See the phone without its Mac"
                    right={toggle(asleep, () => {})}
                    chevron={false}
                    onPress={() => {
                      setAsleep(!asleep);
                      store.setDemoAsleep(!asleep);
                    }}
                  />
                </Card>
              </View>
            ) : null}

            {updatesAvailable() ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Updates
                </T>
                <Card>
                  <Row
                    first
                    Icon={ArrowDownToLine}
                    tone="mint"
                    label="Update automatically"
                    sub={autoOn() ? 'Installs once you leave the app' : 'You choose when, from the pill on Home'}
                    right={toggle(autoOn(), () => {})}
                    onPress={() => {
                      haptic.tap();
                      setAuto(!autoOn());
                    }}
                    chevron={false}
                  />
                  {autoOn() && !canInstall ? (
                    <Row Icon={ShieldCheck} tone="butter" label="Let Beluga install its updates" sub="Android › Install unknown apps › Beluga. Then they go in without asking." onPress={appUpdate.allowInstalls} />
                  ) : null}
                  <Row
                    Icon={Search}
                    tone="sky"
                    label="Check for updates"
                    sub={checkOn() ? 'At launch and every 4 hours' : 'Only when you tap Check Now'}
                    right={toggle(checkOn(), () => {})}
                    onPress={() => {
                      haptic.tap();
                      setCheck(!checkOn());
                    }}
                    chevron={false}
                  />
                  <Row
                    Icon={RefreshCw}
                    tone="plain"
                    label={update.phase === 'checking' ? 'Checking…' : 'Check Now'}
                    sub={update.checkedAt ? `Last looked ${new Date(update.checkedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${update.phase === 'current' ? ' · up to date' : ''}` : undefined}
                    onPress={() => void checkForUpdate(true)}
                    chevron={false}
                  />
                </Card>
              </View>
            ) : null}

            <Card>
              <Row first Icon={Info} tone="plain" label="About" sub={`App ${appVersion() ?? (Constants.expoConfig?.version ?? '')} · link ${COMPANION_PROTO.major}.${COMPANION_PROTO.minor}${link.mac ? ` · Mac ${link.mac.version}` : ''}`} />
            </Card>
          </Animated.View>
        ) : null}
      </ScrollView>
      <UpdateSheet visible={updateOpen} onClose={() => setUpdateOpen(false)} />
    </Screen>
  );
}

/** Settings' Voice row: what the microphone does now (it changes on the Voice page). */
function VoiceRow() {
  useSupports('voice');
  // Back from the Voice page: what was chosen there.
  const [, again] = useState(0);
  useFocusEffect(useCallback(() => again((n) => n + 1), []));
  const c = voiceChoice();
  const suggested = voiceSetting().preset === 'suggested';
  return <Row Icon={Mic} tone="peach" label="Voice" sub={`${c.where === 'mac' ? 'On your Mac' : 'On this phone'} · ${VOICE_MODELS[c.model].label}${suggested ? ' (suggested)' : ''}`} onPress={() => router.push('/voice')} />;
}
