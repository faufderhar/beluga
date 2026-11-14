import { useEffect, useRef } from 'react';
import type { CallView } from '@beluga/shared/calls.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { CallAvatar } from './CallAvatar.js';
import { CallControls, namesOf } from './CallStrip.js';
import { JOINED, LEFT, RING, RINGBACK, RINGBACK_EVERY_S, RING_EVERY_S, loop, playOnce, wakeSound } from './ringtone.js';
import { callLength } from '@beluga/shared/calls.js';
import { openCall, useCallEngine, useCallLive, useCallPlace, useMyCall, useRinging, useSecond, useShowing } from './use-call.js';
import { syncFloat } from './float.js';
import { startOverlay } from './overlay.js';
import c from './call.module.css';

/** Someone rings you: a card at the top of the window, wherever you are in Beluga. */
function Incoming({ call }: { call: CallView }) {
  const { client } = useBeluga();
  const engine = useCallEngine();
  const place = useCallPlace(call.conversation);
  const by = call.people.find((p) => p.peerId === call.ringBy) ?? call.people[0];
  const group = call.conversation.startsWith('group:');
  const others = call.people.filter((p) => p.peerId !== by?.peerId);
  const join = (): void => {
    openCall(client, call.conversation);
    void engine.join(call.conversation).catch(() => undefined);
  };
  return (
    <div className={c.incoming} role="alertdialog" aria-label={`${by?.name ?? 'Someone'} is calling`}>
      <button type="button" className={c.incomingWho} onClick={() => openCall(client, call.conversation)}>
        <span className={c.ripples} aria-hidden="true">
          <span />
          <span />
        </span>
        {by ? <CallAvatar peerId={by.peerId} name={by.name} size={36} speaking={false} /> : null}
        <span className={c.incomingText}>
          <strong>{by?.name ?? 'Someone'} is calling</strong>
          <span>{group ? `${place}${others.length ? ` · with ${namesOf(others)}` : ''}` : 'Voice call'}</span>
        </span>
      </button>
      <span className={c.incomingActions}>
        <button type="button" className={c.roundDecline} aria-label="Decline" onClick={() => void client.api.calls.decline(call.conversation)}>
          <Icon name="callEnd" size={17} />
        </button>
        <button type="button" className={c.roundJoin} aria-label="Join" onClick={join}>
          <Icon name="call" size={16} />
        </button>
      </span>
    </div>
  );
}

/** The call you're in, in the sidebar while you look at something else: back to it in one click. */
export function CallPill() {
  const { client } = useBeluga();
  const call = useMyCall();
  const live = useCallLive();
  const showing = useShowing(call?.conversation);
  const place = useCallPlace(call?.conversation);
  const now = useSecond();
  if (!call || showing) return null;
  const others = call.people.filter((p) => !p.me);
  const talking = others.find((p) => live.speaking.has(p.peerId));
  const sharing = call.people.some((p) => p.me && p.sharing);
  return (
    <div className={cx(c.pill, sharing && c.pillSharing)} role="region" aria-label={`Call in ${place}`}>
      <button type="button" className={c.pillMain} onClick={() => openCall(client, call.conversation)}>
        <span className={c.pillFaces}>
          {others.slice(0, 3).map((p) => (
            <CallAvatar key={p.peerId} peerId={p.peerId} name={p.name} size={20} speaking={live.speaking.has(p.peerId)} muted={p.muted} />
          ))}
        </span>
        <span className={c.pillText}>
          <strong>{place}</strong>
          <span>{sharing ? 'You’re sharing your screen' : talking ? `${talking.name} is talking` : others.length ? callLength(now - call.startedAt) : 'Ringing…'}</span>
        </span>
      </button>
      <CallControls call={call} compact />
    </div>
  );
}

/**
 * Calls for the whole window (BLG-706): starts this window's call engine, shows who rings you,
 * plays Beluga's ringtone (not while you're on Do Not Disturb), the soft bells as people come and
 * go, ⌘⇧M to mute, and the floating card while Beluga is behind other apps.
 */
export function CallLayer() {
  const { client } = useBeluga();
  const engine = useCallEngine();
  const ringing = useRinging();
  const mine = useMyCall();
  const quiet = useApp((st) => st.network.self?.presence.state === 'dnd');
  const live = useCallLive();

  // The window's sound wakes on your first click or key, so a ring that comes later is heard.
  useEffect(() => {
    const wake = (): void => wakeSound();
    window.addEventListener('pointerdown', wake, { capture: true });
    window.addEventListener('keydown', wake, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', wake, { capture: true });
      window.removeEventListener('keydown', wake, { capture: true });
    };
  }, []);

  // The ringtone, while anything rings for you (and you're not already in a call).
  const ringsNow = ringing.length > 0 && !mine && !quiet;
  useEffect(() => (ringsNow ? loop(RING, RING_EVERY_S) : undefined), [ringsNow]);

  // The caller hears it ring at the others' while nobody has picked up yet (through the call's
  // stream: the microphone is already open, and macOS turns down whatever else plays).
  const waiting = Boolean(mine && mine.people.length === 1 && mine.startedBy === mine.people[0]?.peerId);
  useEffect(() => (waiting ? loop(RINGBACK, RINGBACK_EVERY_S, { volume: 0.6, inCall: true }) : undefined), [waiting]);

  // People coming and going.
  const count = useRef<{ call?: string; n: number }>({ n: 0 });
  useEffect(() => {
    const n = mine?.people.length ?? 0;
    const was = count.current;
    if (mine && was.call === mine.id && n !== was.n) playOnce(n > was.n ? JOINED : LEFT, { volume: 0.6, inCall: true });
    else if (mine && was.call !== mine.id && n > 1) playOnce(JOINED, { volume: 0.6, inCall: true });
    count.current = { ...(mine ? { call: mine.id } : {}), n };
  }, [mine?.id, mine?.people.length]);

  // ⌘⇧M mutes and unmutes, wherever you are in Beluga.
  useEffect(() => {
    if (!mine) return;
    const muted = mine.people.find((p) => p.me)?.muted ?? false;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        void engine.mute(!muted);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, mine]);

  // The floating card over other apps (src-tauri/src/call_float.rs).
  useEffect(() => syncFloat(client, engine, mine, ringing, live.speaking), [client, engine, mine, ringing, live.speaking]);

  // While you share and look elsewhere: a frame, what the others point at and what they write, over your screen (call/overlay.ts).
  const inCall = mine?.conversation;
  useEffect(() => (inCall ? startOverlay(engine, client, inCall) : undefined), [inCall, engine, client]);

  const shown = ringing.filter((r) => r.conversation !== mine?.conversation).slice(0, 2);
  if (!shown.length) return null;
  return (
    <div className={cx(c.incomingStack)} aria-live="assertive">
      {shown.map((call) => (
        <Incoming key={call.id} call={call} />
      ))}
    </div>
  );
}
