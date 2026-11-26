import { useState } from 'react';
import type { DeviceView, PhoneUse } from '../../../../src/companion/protocol.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { QrCode } from '../network/QrCode.js';
import { errorText, quietly } from '../network/use-net.js';
import { Group, Row, Select } from '../dialogs/settings-controls.js';
import type { KeepAwake } from '@beluga/shared/settings-schema.js';
import { pathLabel } from '../../../../src/companion/diagnose.js';
import { leftText, seenText } from './phone-model.js';
import s from './phone.module.css';
import { computerWord, thisComputer, upFirst, yourComputer } from '../lib/os-words.js';

/**
 * Your phone on the Mac (docs/companion.md, "On the Mac"): a small mark in the sidebar's footer
 * while a phone is paired (lit with a dot while it's linked, outlined while it's away), its
 * popover with the phones and Pair a Phone…, and Settings › Phone with the same.
 */

/** A clock for "last seen 12 min ago" (it rests while you look away). */
const useMinute = (): number => useClock(true, 30_000);

const useDevices = (): readonly DeviceView[] => useApp((st) => st.companion.devices, sameDeep);
const usePairing = () => useApp((st) => st.companion.pairing, sameDeep);
const useRelay = () => useApp((st) => st.companion.relay);
const useAdb = () => useApp((st) => st.companion.adb, sameDeep);

/** How Claude may use this phone (BLG-150): the preset, the route it's reached by, and adb pairing. */
const USE_OPTIONS: ReadonlyArray<{ value: PhoneUse; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask each time' },
  { value: 'use', label: 'Use' },
  { value: 'full', label: 'Full (shell too)' },
];
const ROUTE_WORDS: Record<string, string> = { usb: 'over USB', wifi: 'Wireless debugging, straight over this Wi‑Fi', link: 'Wireless debugging, through Beluga’s encrypted link', accessibility: 'the Accessibility service' };

function PhoneClaude({ d }: { d: DeviceView }) {
  const { client } = useBeluga();
  const c = d.control;
  if (!c || d.platform === 'ios') return null;
  const route = c.routes[0];
  return (
    <div className={s.control}>
      <Row label="Let your agent use this phone" detail={route ? `Reached by ${ROUTE_WORDS[route] ?? route}.` : (c.note ?? 'Not reachable right now.')}>
        <Select label="Let your agent use this phone" value={c.use} onChange={(v) => void client.api.companion['phone.use'](d.id, v as PhoneUse)} options={USE_OPTIONS.map((o) => ({ ...o }))} />
      </Row>
      {c.use !== 'off' && c.accessibility !== true ? <BelugaLink id={d.id} reachable={c.usb === true || c.adb === 'connected' || c.adb === 'ready'} /> : null}
      {c.use !== 'off' && (c.usb || c.adb !== 'off') ? <OverWifi id={d.id} on={c.adb !== undefined && c.adb !== 'off'} cable={c.usb === true} path={c.wifiPath} /> : null}
      {c.use !== 'off' && c.adb === 'unpaired' ? (
        <Row label="Wireless debugging" detail="On the phone, open Wireless debugging › Pair device with pairing code, then type the six digits into Beluga’s notification.">
          <Button size="small" onClick={() => void quietly(client, client.api.companion['phone.pairAdb'](d.id))}>
            Connect
          </Button>
        </Row>
      ) : null}
    </div>
  );
}

/**
 * Beluga Link (BLG-391): the phone's small add-on app with the Accessibility service, which lets
 * Claude tap and type without a cable. Installed from here over adb, Play Protect doesn't block it
 * and it's turned on too.
 */
function BelugaLink({ id, reachable }: { id: string; reachable: boolean }) {
  const { client } = useBeluga();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const go = async (): Promise<void> => {
    setBusy(true);
    setSaid(undefined);
    try {
      setSaid(await client.api.companion['phone.setUpLink'](id));
    } catch (err) {
      setSaid(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const detail = reachable
    ? `Beluga Link is the small app on the phone that lets your agent tap and type there without a cable. It’s separate so Android’s Play Protect never blocks Beluga itself; set up from here, Link isn’t blocked either. ${upFirst(thisComputer())} installs it and turns it on.`
    : 'Beluga Link is the small app on the phone that lets your agent tap and type there without a cable. Downloaded on the phone, Android may block it (“App blocked to protect your device”); set up from here, it isn’t. Connect the phone with a USB cable first.';
  return (
    <Row label="Beluga Link" detail={said ?? detail}>
      <Button size="small" disabled={busy || !reachable} onClick={() => void go()}>
        {busy ? 'Setting Up…' : 'Set Up Beluga Link'}
      </Button>
    </Row>
  );
}

/**
 * Wireless debugging (BLG-187): on over the cable so Claude and the mirror carry on unplugged, or
 * off. It's only ever reached through Beluga's encrypted link, and goes off by itself when unused.
 */
function OverWifi({ id, on, cable, path }: { id: string; on: boolean; cable: boolean; path?: 'direct' | 'blocked' }) {
  const { client } = useBeluga();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const go = async (next: boolean): Promise<void> => {
    setBusy(true);
    setSaid(undefined);
    try {
      setSaid(await client.api.companion['phone.wifi'](id, next));
    } catch (err) {
      setSaid(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const way =
    path === 'blocked'
      ? `This Wi‑Fi keeps devices apart (dorms, campuses and cafés often do), so the ${computerWord()} reaches the phone through Beluga’s end-to-end encrypted link instead: a little slower. On another network it connects straight.`
      : path === 'direct'
        ? `On this Wi‑Fi the ${computerWord()} connects straight to the phone, once it proves it’s yours (a one-time code sent over Beluga’s encrypted link), so nobody else on the network can pass for it.`
        : 'Straight over the Wi‑Fi when the network lets devices reach each other and the phone proves it’s yours, else through Beluga’s end-to-end encrypted link.';
  const detail = on
    ? `Wireless debugging is on. ${way} While it’s on, the phone listens for debugging on its Wi‑Fi (only keys it allowed get in); Beluga turns it off after 15 minutes unused.`
    : `Keep using it when you unplug the cable: this turns on the phone’s Wireless debugging. ${way} Beluga turns it off after 15 minutes unused. Tap Allow on the phone when it asks (not “Always”).`;
  return (
    <Row label="Over Wi‑Fi" detail={said ?? detail}>
      {on ? (
        <Button size="small" disabled={busy} onClick={() => void go(false)}>
          {busy ? 'Turning Off…' : 'Turn Off'}
        </Button>
      ) : (
        <Button size="small" disabled={busy || !cable} onClick={() => void go(true)}>
          {busy ? 'Waiting for the phone…' : 'Use over Wi‑Fi'}
        </Button>
      )}
    </Row>
  );
}

/** How phones on other networks (a dorm's or a café's Wi-Fi, mobile data) reach this Mac, in a line (BLG-126). */
export function relayText(relay: 'ready' | 'starting' | 'off' | undefined): { readonly text: string; readonly ok: boolean } | undefined {
  if (relay === 'ready') return { text: `Ready: your phone reaches ${thisComputer()} from any network, end-to-end encrypted.`, ok: true };
  if (relay === 'starting') return { text: 'Starting the relay… Phones on a network that blocks direct connections connect in a moment, by themselves.', ok: false };
  if (relay === 'off') return { text: `Off: Remote access is set to direct only, so a phone on a network that blocks direct connections can’t reach ${thisComputer()}.`, ok: false };
  return undefined;
}

const KEEP_AWAKE_OPTIONS: ReadonlyArray<{ value: KeepAwake; label: string }> = [
  { value: 'off', label: 'Never' },
  { value: 'power', label: 'On power' },
  { value: 'always', label: 'Always' },
];

/** Whether phones reach this Mac from anywhere now, and keeping it awake for them. */
function Reaching() {
  const { client } = useBeluga();
  const relay = relayText(useRelay());
  const keepAwake = useApp((st) => st.prefs.keepAwake ?? 'off');
  return (
    <>
      {relay ? (
        <Row label="From other networks" detail={relay.text}>
          <span className={cx(s.relayDot, relay.ok && s.relayOk)} aria-label={relay.ok ? 'Ready' : 'Not ready'} />
        </Row>
      ) : null}
      <Row label={`Keep ${thisComputer()} awake`} detail={`A sleeping ${computerWord()} can’t be reached or woken from your phone, so Beluga keeps it from sleeping while a phone is paired. The display still sleeps; closing the lid still sleeps it. Your phone can change this too.`}>
        <Select label={`Keep ${thisComputer()} awake`} value={keepAwake} onChange={(v) => void client.api.session.setPrefs({ keepAwake: v })} options={KEEP_AWAKE_OPTIONS.map((o) => ({ ...o }))} />
      </Row>
    </>
  );
}

/** The phones you paired: each with how it is now, Remove, and (in Settings) how Claude may use it. */
function DeviceList({ now, control = false }: { now: number; control?: boolean }) {
  const { client } = useBeluga();
  const devices = useDevices();
  if (!devices.length) return <div className={s.empty}>No phone yet. Pair one to see what your agent is doing, answer and ask from anywhere.</div>;
  return (
    <ul className={s.devices} aria-label="Your phones">
      {devices.map((d) => (
        <li key={d.id} className={s.device}>
          <div className={s.deviceHead}>
            <span className={cx(s.deviceMark, d.linked && s.lit)} aria-hidden="true">
              <Icon name="phone" size={16} />
            </span>
            <span className={s.deviceText}>
              <span className={s.deviceName}>{d.name}</span>
              <span className={s.dim}>
                {d.platform === 'ios' ? 'iPhone' : 'Android'}
                {d.app ? ` · app ${d.app}` : ''} · {seenText(d, now)}
              </span>
              {d.path ? (
                <span className={s.path} title={d.note}>
                  {d.path === 'relay' ? (d.note ?? pathLabel(d.path)) : pathLabel(d.path)}
                </span>
              ) : null}
            </span>
            <Button size="small" variant="quiet" onClick={() => void client.api.companion['devices.remove'](d.id)}>
              Remove
            </Button>
          </div>
          {control ? <PhoneClaude d={d} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** Pair a Phone…: the QR and the code while a pairing is open, and "Pair this phone?" once one is waiting (also on the welcome's phone step). */
export function Pairing({ now }: { now: number }) {
  const { client } = useBeluga();
  const pairing = usePairing();
  const devices = useDevices();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.companion['pair.start']());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!pairing) {
    // While it opens it stays the same button, the same size (both labels take the room): a spinner and "Opening…", readable.
    return (
      <div className={s.pairRow}>
        {error ? <div className={s.error}>{error}</div> : null}
        <Button variant={devices.length ? 'plain' : 'primary'} className={cx(s.pairButton, busy && s.opening, busy && devices.length > 0 && s.openingPlain)} disabled={busy || devices.length >= 4} aria-busy={busy || undefined} onClick={() => void start()}>
          <span className={s.pairFace} data-shown={busy ? undefined : 'true'}>
            <Icon name="phone" size={14} />
            Pair a Phone…
          </span>
          <span className={s.pairFace} data-shown={busy ? 'true' : undefined}>
            <span className={s.spinner} aria-hidden="true" />
            Opening…
          </span>
        </Button>
      </div>
    );
  }
  if (pairing.waiting) {
    return (
      <div className={s.pairing}>
        <div className={s.pairTitle}>Pair “{pairing.waiting.name}”?</div>
        <div className={s.fingerprint} aria-label={`Fingerprint ${pairing.waiting.fingerprint}`}>
          {pairing.waiting.fingerprint}
        </div>
        <div className={s.dim}>Your phone shows the same four pictures. If it doesn’t, don’t pair.</div>
        <div className={s.buttons}>
          <Button onClick={() => void client.api.companion['pair.cancel']()}>Don’t Pair</Button>
          <Button variant="primary" onClick={() => void client.api.companion['pair.approve']()}>
            Pair
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={s.pairing}>
      <div className={s.qr}>
        <QrCode text={pairing.link} size={148} label="Scan with the Beluga app on your phone" />
      </div>
      <div className={s.dim}>Scan this with the Beluga app on your phone, or type the code:</div>
      <div className={s.code}>{pairing.code}</div>
      <div className={s.dim}>Works once, for {leftText(pairing.expiresAt, now)}.</div>
      <div className={s.buttons}>
        <Button onClick={() => void client.api.companion['pair.cancel']()}>Cancel</Button>
      </div>
    </div>
  );
}

/** Whether adb (Android platform-tools) is on this Mac — needed for Wireless debugging, screenshots and shell. */
function AdbLine() {
  const adb = useAdb();
  if (!adb) return null;
  const detail = adb.path
    ? `Found adb ${adb.version ?? ''} on ${thisComputer()}.`
    : adb.fetching
      ? 'Getting Android platform-tools…'
      : 'adb (Android platform-tools) isn’t installed. The Accessibility route still works without it; for Wireless debugging, shell and logs, install it.';
  return (
    <Row label={`adb on ${thisComputer()}`} detail={detail}>
      {adb.path ? <span className={cx(s.relayDot, s.relayOk)} aria-label="Found" /> : <span className={s.relayDot} aria-label="Not found" />}
    </Row>
  );
}

/**
 * A phone on this Mac's USB cable (BLG-190): what to switch on, said plainly (and shown on the phone
 * when its Beluga can), or pair it over the cable.
 */
function OnTheCable() {
  const { client } = useBeluga();
  const cable = useAdb()?.cable;
  const devices = useDevices();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  if (!cable) return null;
  const linked = devices.find((d) => d.platform !== 'ios' && d.linked);
  const run = async (work: () => Promise<string | void>): Promise<void> => {
    setBusy(true);
    setSaid(undefined);
    try {
      setSaid((await work()) || undefined);
    } catch (err) {
      setSaid(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  // Developer options, or About phone when they aren't on yet (tap Build number seven times there).
  const showOnPhone = (): Promise<string> =>
    client.api.companion['phone.settings'](linked!.id, 'developer').then(
      () => 'Developer options are open on the phone: turn on USB debugging.',
      () => client.api.companion['phone.settings'](linked!.id, 'about').then(() => 'About phone is open on the phone: tap Software information › Build number seven times, then Settings › Developer options › USB debugging.'),
    );
  const name = cable.name;
  if (cable.state === 'no-debugging')
    return (
      <Row label="On the cable" detail={said ?? `${name} is plugged in, but USB debugging is off, so your agent can’t use the cable yet. On the phone: Settings › About phone › Software information › tap Build number seven times; then Settings › Developer options › USB debugging.`}>
        {linked ? (
          <Button size="small" disabled={busy} onClick={() => void run(showOnPhone)}>
            Open on the Phone
          </Button>
        ) : (
          <span />
        )}
      </Row>
    );
  if (cable.state === 'unauthorized') return <Row label="On the cable" detail={`${name} is asking: unlock it and tap Allow on “Allow USB debugging?” (tick “Always allow from this computer” so it doesn’t ask again).`}><span /></Row>;
  if (cable.canPair)
    return (
      <Row label="On the cable" detail={said ?? `${name} has Beluga but isn’t paired with ${thisComputer()}. Pair it over the cable: its Beluga opens the pairing, and you check the four pictures match.`}>
        <Button size="small" disabled={busy} onClick={() => void run(() => client.api.companion['phone.pairCable']())}>
          {busy ? 'Opening…' : 'Pair over the Cable'}
        </Button>
      </Row>
    );
  return <Row label="On the cable" detail={`${name} is plugged in: your agent and the mirror use the cable, the fastest way.`}><span /></Row>;
}

/** Settings › Phone. */
export function PhoneSettings() {
  const now = useMinute();
  const cable = useAdb()?.cable;
  return (
    <>
      {cable ? (
        <Group title="On the cable">
          <OnTheCable />
        </Group>
      ) : null}
      <Group title="Your phones">
        <div className={s.inSettings}>
          <DeviceList now={now} />
        </div>
      </Group>
      {useDevices().some((d) => d.platform !== 'ios') ? (
        <Group title="Let your agent use your phone">
          <Row label="How it works" detail={`Ask your agent on ${thisComputer()} to do something on your phone — look at the screen, tap, type, open apps, install a build. It uses Wireless debugging when it can, or Beluga Link, the phone’s small add-on app. Off until you choose a level below; set it up on the phone in Beluga › Settings.`}>
            <span />
          </Row>
          <AdbLine />
          <div className={s.inSettings}>
            <DeviceList now={now} control />
          </div>
        </Group>
      ) : null}
      {useDevices().length ? (
        <Group title={`Reaching ${yourComputer()}`}>
          <Reaching />
        </Group>
      ) : null}
      <Group title="Pair a phone">
        <Row label="The Beluga app" detail={`Your phone gets its own key, signed by ${yourComputer()}: it shows what your agent is doing and lets you answer, ask and chat. It never sees code. Up to 4 phones; Remove cuts one off at once.`}>
          <span />
        </Row>
        <div className={s.inSettings}>
          <Pairing now={now} />
        </div>
      </Group>
    </>
  );
}
