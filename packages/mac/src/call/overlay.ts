import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { avatarNow } from '../lib/avatars.js';
import { inApp } from '../lib/boot.js';
import { callChat } from './call-chat.js';
import { type ChatPop, PopClock, popsNow } from './chat-pops.js';
import type { CallEngine } from './engine.js';
import { type Ink, NO_INK, applyInk, hasInk, tidyInk } from './ink.js';
import { CornerReader, NEW_PROBE, type ProbeState, judge, probeColor } from './leak-probe.js';
import { repeat } from './repeat.js';

/**
 * The sharer's overlay (BLG-717, src-tauri/src/call_overlay.rs): while you share your screen and
 * look at another app, you don't see Beluga, so it comes to you, over the screen you share. A soft
 * frame around it says it's on show; what the others draw and point at shows where they made it;
 * what they write in the chat pops up bottom right and dissolves. Sharing one window (not a whole
 * screen), there's no way to know where it sits, so only the chat shows. Back in Beluga, it goes:
 * the chat is right there. Sharing one window, the shell finds where that window is (by its size
 * and title, src-tauri/src/shared_window.rs) and the overlay covers just it, following it as it
 * moves; not found, only the chat shows (BLG-743). macOS is asked to leave the overlay out of what's shared; since macOS 15
 * it doesn't always, so the overlay first checks (call/leak-probe.ts). If it's in the picture, it
 * still shows (pointing at a screen its owner can't see is no use, BLG-743), and the others hear
 * so: they leave pointers to the picture instead of drawing their own over it, so nobody sees one
 * twice (BLG-736). Ink lands on the same spot either way.
 */

/** What the overlay draws: the frame, everyone's ink but yours, the chat, and this window's clock. */
export interface OverlayState {
  /** The sharer's clock (performance.now) when this was sent: the overlay lines its own up with it. */
  readonly now: number;
  /** Frame what's shared, and draw the ink over it (a whole screen, or the one window when it's found). */
  readonly frame: boolean;
  readonly ink?: Ink;
  /** The others' messages since you looked away, each with how long ago it came (ms). */
  readonly pops: ReadonlyArray<ChatPop & { readonly age: number }>;
  /** While checking whether the overlay is in the capture: the colour of the probe in its corner. */
  readonly probe?: string;
  /**
   * Whose pointer is whose: the others' names and pictures, for the marks beside their arrows
   * (BLG-912). Sent only when they change (and as the overlay shows): the overlay keeps them.
   */
  readonly faces?: Readonly<Record<string, OverlayFace>>;
}

export interface OverlayFace {
  readonly name: string;
  /** Their profile picture, as a data URL; none: their initial. */
  readonly picture?: string;
}

/** How long a probe colour stays up before the capture is read (the overlay draws it, then a frame is captured). */
const PROBE_SETTLE_MS = 600;

/** How often the overlay is brought up to date while something moves (a pointer, a stroke). */
const SEND_MS = 33;
/** The faces go along at least this often (see `faces` in OverlayState). */
const FACES_EVERY_MS = 3_000;
/** Sharing one window: how often its place is checked again, in case it moved. */
const FOLLOW_MS = 400;

/** Starts following the call for the overlay (once per call); returns a stop. */
export function startOverlay(engine: CallEngine, client: SocketClient, conversation: string): () => void {
  if (!inApp()) return () => undefined;
  const me = (): string => client.store.getState().network.self?.peerId ?? '';
  let ink: Ink = NO_INK;
  let dirty = false;
  let shown = false;
  let popKey = '';
  /** Whether the overlay is in what you share (macOS's behaviour: it holds for the whole call). */
  let probe: ProbeState = NEW_PROBE;
  let reader: { readonly track: MediaStreamTrack; readonly corner: CornerReader } | undefined;
  let probeAt = 0;
  /** What the others were last told: the overlay is in the picture now. */
  let inPicture = false;
  const say = (on: boolean): void => {
    if (on === inPicture) return;
    inPicture = on;
    engine.setOverlayInPicture(on);
  };
  const stopReader = (): void => {
    reader?.corner.stop();
    reader = undefined;
  };
  /** Set as you look away (what the chat had then, you had seen). */
  let clock: PopClock | undefined;
  let focused = document.hasFocus();
  const onFocus = (): void => {
    focused = true;
    dirty = true;
  };
  const onBlur = (): void => {
    focused = false;
    dirty = true;
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  const offStage = engine.onStage((m) => {
    // Your own pointer and drawing are under your own mouse: the overlay shows the others'.
    if (m.by === me()) return;
    ink = applyInk(ink, m, performance.now());
    dirty = true;
  });
  const offLive = engine.subscribe(() => (dirty = true));
  const send = async (state: OverlayState | null, width = 0, height = 0, surface?: string, label?: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_call_overlay', { state, width, height, surface: surface ?? null, label: label ?? null }).catch(() => undefined);
  };
  /** The faces the overlay was last given ('' once it's hidden: it gets them again as it shows). */
  let facesKey = '';
  let facesAt = 0;
  const faces = (): Record<string, OverlayFace> => {
    const out: Record<string, OverlayFace> = {};
    for (const p of engine.people()) {
      if (p.me) continue;
      const picture = avatarNow(client, p.peerId, () => (dirty = true));
      out[p.peerId] = picture ? { name: p.name, picture } : { name: p.name };
    }
    return out;
  };
  let followedAt = 0;
  const stop = repeat(() => {
    const now = performance.now();
    ink = tidyInk(ink, now);
    const shareTrack = engine.sharedTrack();
    if (!shareTrack || focused) {
      clock = undefined;
      say(false);
      if (shown) {
        shown = false;
        facesKey = '';
        void send(null);
      }
      return;
    }
    const chat = callChat(client.store.getState(), conversation);
    clock ??= new PopClock(chat);
    const wall = Date.now();
    const pops = popsNow(clock.stamp(chat, wall), wall);
    const key = pops.map((p) => p.id).join();
    if (key !== popKey) {
      popKey = key;
      dirty = true;
    }
    const settings = shareTrack.getSettings() as MediaTrackSettings & { displaySurface?: string };
    const wholeScreen = settings.displaySurface === undefined || settings.displaySurface === 'monitor';
    // A whole screen: first find out whether the overlay would be in the picture.
    if (wholeScreen && probe.verdict === 'unknown') {
      if (reader?.track !== shareTrack) {
        stopReader();
        reader = { track: shareTrack, corner: new CornerReader(shareTrack) };
        probeAt = now;
        dirty = true;
      } else if (shown && now - probeAt > PROBE_SETTLE_MS) {
        probe = judge(probe, reader.corner.read());
        probeAt = now;
        dirty = true;
        if (probe.verdict !== 'unknown') stopReader();
      }
    }
    // In the picture: the others draw no pointers of their own over it (said before it shows).
    say(wholeScreen && probe.verdict === 'leaks');
    // One window: its place is looked at again now and then (it may have moved).
    if (!wholeScreen && now - followedAt > FOLLOW_MS) {
      followedAt = now;
      dirty = true;
    }
    // Moving ink keeps it up to date; nothing new, nothing sent.
    if (!dirty && !hasInk(ink) && shown) return;
    dirty = false;
    shown = true;
    const checking = wholeScreen && probe.verdict === 'unknown';
    const who = checking ? undefined : faces();
    const faceKey = who ? Object.entries(who).map(([id, f]) => `${id}:${f.name}:${f.picture?.length ?? 0}`).join('|') : facesKey;
    // Again now and then too: an overlay window that opened after they went still needs them.
    const newFaces = who && (faceKey !== facesKey || now - facesAt > FACES_EVERY_MS) ? who : undefined;
    facesKey = faceKey;
    if (newFaces) facesAt = now;
    // One window's ink and frame go too: the shell drops them if it can't find the window.
    const state: OverlayState = {
      now,
      frame: true,
      ...(!checking ? { ink } : {}),
      ...(checking ? { probe: probeColor(probe) } : {}),
      pops: checking ? [] : pops.map((p) => ({ ...p, age: wall - p.at })),
      ...(newFaces ? { faces: newFaces } : {}),
    };
    void send(state, settings.width ?? 0, settings.height ?? 0, wholeScreen ? 'monitor' : 'window', shareTrack.label);
  }, SEND_MS);
  return () => {
    stop();
    stopReader();
    offStage();
    offLive();
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    say(false);
    if (shown) void send(null);
  };
}
