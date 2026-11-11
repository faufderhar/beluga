import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Intent } from '@beluga/core/intents.js';
import { type CallView, type ShareMode, type StageMessage, CLIP_PART, HEARTBEAT_MS, SHARE_KBPS, parseStage, shareChildren, shareTreeBy, sharerOf } from '@beluga/shared/calls.js';
import { inApp } from '../lib/boot.js';
import { Levels } from './levels.js';
import { type CameraSize, type LineState, Peer } from './peer.js';
import { demoCamera, demoPointer, demoScreen, demoVoice } from './demo-media.js';
import { NoiseFilter } from './noise-filter.js';
import { repeat } from './repeat.js';
import { wakeSound } from './ringtone.js';
import { type NotePhrase, Scribe, type Words, demoPhrases, scribeModels } from './scribe.js';
import { type ScribeStatus, bestModel, pickScribe } from '@beluga/shared/scribe-plan.js';
import type { LanguageCount } from '@beluga/shared/call-language.js';
import type { VoiceModelId } from '@beluga/shared/voice-models.js';

/**
 * Your side of a call, made in this window (BLG-706). The daemon says who's in the call
 * (`network.calls`); this keeps one `Peer` per person in it, your microphone going to all of them,
 * and the screen share going down the tree (`shareTree`): from the sharer to the first viewers,
 * and from each viewer on to the next ones, so nobody's upload grows with the size of the call.
 *
 * Screens read what they draw from here (`useCall`); the speaking rings read `level()` directly
 * on each frame. Mute and Share go through the daemon (`calls.set`), so the phone's buttons do the
 * same, and this follows what the shared state says.
 */

export interface CallLive {
  /** The call this window is making (you're in it). */
  readonly conversation?: string;
  readonly call?: string;
  /** Who's talking now (peer ids, yours too). */
  readonly speaking: ReadonlySet<string>;
  /** Each line's state, and how long a round trip takes. */
  readonly lines: Readonly<Record<string, { readonly state: LineState; readonly rtt?: number }>>;
  /** The screen on the stage: whose it is, and the picture (yours too, when you share). */
  readonly stage?: { readonly by: string; readonly stream: MediaStream };
  /** The microphone couldn't be opened (why), or sharing failed. */
  readonly problem?: string;
  /** Asks to Claude about the share in this call (message ids), newest last. */
  readonly asks: readonly string[];
  /** Cameras that are on, by peer id (yours too: your own preview). */
  readonly cameras: Readonly<Record<string, MediaStream>>;
  /** How the screen on the stage is sent (the sharer picks). */
  readonly mode: ShareMode;
  /** How you want it sent to you, watching someone else's (BLG-743); undefined: as they send it. */
  readonly want?: ShareMode;
  /** The sharer whose overlay macOS puts in the picture: their screen shows everyone's pointers, so this window doesn't draw them again. */
  readonly overlayBy?: string;
  /** The stage fills the whole display. */
  readonly theater: boolean;
  /** Face to face: cameras over the whole window (theirs big, yours in a corner; a group as a collage). */
  readonly faces: boolean;
  /** Background noise out of your voice (BLG-744): off unless you turned it on (kept on this Mac); `none`: this window can't. */
  readonly quiet: 'on' | 'off' | 'none';
  /** Your words go in the call's notes (`off`: you paused it; `none`: nobody in the call has a voice model). */
  readonly notes: 'on' | 'off' | 'none';
  /** Who writes the notes down with which model (peer ids, yours too), and the call's language once it settled (BLG-738). */
  readonly scribing: { readonly writers: Readonly<Record<string, VoiceModelId>>; readonly language?: string };
}

const EMPTY: CallLive = { speaking: new Set(), lines: {}, asks: [], cameras: {}, mode: 'sharp', theater: false, faces: false, quiet: 'off', notes: 'none', scribing: { writers: {} } };

/** How long a line may take to connect before the strip says it can't reach them. */
const LINE_PATIENCE_MS = 12_000;

/** A picture from someone: its track, and whether frames are coming. */
interface Incoming {
  readonly track: MediaStreamTrack;
  readonly live: boolean;
}

type StageListener = (m: StageMessage) => void;

export class CallEngine {
  private live: CallLive = EMPTY;
  private readonly subs = new Set<() => void>();
  private readonly stageSubs = new Set<StageListener>();
  private readonly peers = new Map<string, Peer>();
  private readonly audio = new Map<string, HTMLAudioElement>();
  /** Pictures from each person, by the stream they belong to. */
  private readonly incoming = new Map<string, Map<string, Incoming>>();
  /** Which of each person's streams is their camera and which a screen (they say so on the stage). */
  private readonly kinds = new Map<string, { readonly cam?: string; readonly screen?: string }>();
  /** How each viewer wants the screen sent to them (they say so); the rest get the sharer's mode. */
  private readonly wants = new Map<string, ShareMode>();
  /** Your overlay is in the picture you share now (you said so to the others). */
  private overlayMine = false;
  /** Your camera, while it's on. */
  private cam: MediaStream | undefined;
  /** How each person shows your camera (they say so), and how you show theirs. */
  private readonly viewsOf = new Map<string, { readonly big: ReadonlySet<string>; readonly visible: boolean }>();
  private myView: { big: readonly string[]; visible: boolean } = { big: [], visible: false };
  /** What this Mac can send, by WebRTC's estimates (kbit/s), as last told to the others. */
  private uplink: number | undefined;
  private uplinkSaid: number | undefined;
  /** Writing down your words for the call's notes (BLG-715), and what was written before a pause. */
  private scribe: Scribe | undefined;
  private written: NotePhrase[] = [];
  /** How each Mac in the call does as a scribe (they say so every few seconds, BLG-718). */
  private readonly scribes = new Map<string, ScribeStatus>();
  /** Your phrases out at other Macs, waiting for their words; others' phrases arriving in parts. */
  private readonly clipsOut = new Map<string, (words: Words | undefined) => void>();
  private readonly clipsIn = new Map<string, { parts: string[]; seconds: number; lang?: string }>();
  private stopScribeTalk: (() => void) | undefined;
  /** The call whose notes have begun: only once someone else is in it (a call nobody picked up has none). */
  private notesFor: string | undefined;
  /** The demo's friends whose made-up voices are playing. */
  private readonly demoVoices = new Set<string>();
  /** A demo friend pointing at the shared screen (as the network would bring it: a few times a second). */
  private stopDemoPointer: (() => void) | undefined;
  /** What the call sends of your voice: the noise filter's output, or the microphone itself. */
  private mic: MediaStream | undefined;
  /** The microphone itself, and the filter over it (call/noise-filter.ts). */
  private raw: MediaStream | undefined;
  private filter: NoiseFilter | undefined;
  /** The microphone and speaker you picked (BLG-737), remembered on this Mac; undefined: macOS's own. */
  private micId: string | undefined = readPref(MIC_PREF);
  private speakerId: string | undefined = readPref(SPEAKER_PREF);
  /**
   * Noise Removal, as you left it on this Mac (off at first). Its voice is made by Web Audio, and
   * since it went on in every call (#362) friends stopped hearing each other: the line sends the
   * microphone itself unless you turn it on.
   */
  private quietWanted = readPref(QUIET_PREF) === 'on';
  /** When each line started, and whether the strip says it can't reach someone now. */
  private readonly lineSince = new Map<string, number>();
  private unreachableSaid = false;
  private micAsked: Promise<MediaStream | undefined> | undefined;
  /** Bumped when a call ends: a microphone that opens after that is stopped at once, not kept. */
  private micToken = 0;
  private screen: MediaStream | undefined;
  private view: CallView | undefined;
  private readonly levels = new Levels((who) => this.patch({ speaking: who }));
  private stopBeat: (() => void) | undefined;
  private stopStats: (() => void) | undefined;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly client: SocketClient) {
    this.offs.push(
      client.store.subscribe(() => this.follow()),
      client.onIntent((i) => this.onIntent(i)),
    );
    this.follow();
  }

  // ---- for screens

  get = (): CallLive => this.live;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };

  /** How loud someone is (0…1), for the speaking ring. */
  level(peerId: string): number {
    return this.levels.level(peerId);
  }

  private get me(): string {
    return this.client.store.getState().network.self?.peerId ?? '';
  }

  /** The microphones and speakers on this Mac, and which ones the call uses (BLG-737). */
  async devices(): Promise<AudioDevices> {
    const all = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
    const named = (kind: MediaDeviceKind): AudioDevice[] =>
      all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || (kind === 'audioinput' ? `Microphone ${i + 1}` : `Speaker ${i + 1}`) }));
    return {
      mics: named('audioinput'),
      speakers: named('audiooutput'),
      ...(this.micId ? { mic: this.micId } : {}),
      ...(this.speakerId ? { speaker: this.speakerId } : {}),
      canPickSpeaker: typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function',
    };
  }

  /** Background noise out of your voice, or not, from now on (this Mac remembers): every line switches at once. */
  async setQuiet(on: boolean): Promise<void> {
    if (this.live.quiet === 'none') return;
    this.quietWanted = on;
    writePref(QUIET_PREF, on ? 'on' : undefined);
    this.patch({ quiet: on ? 'on' : 'off' });
    const raw = this.raw;
    if (!raw || !this.view) return;
    if (!on) {
      const old = this.filter;
      this.filter = undefined;
      this.useVoice(raw);
      old?.stop();
      return;
    }
    if (this.filter) return;
    const filter = await this.startFilter(raw);
    // Turned off again, or another microphone picked, while the filter started.
    if (!filter || raw !== this.raw || !this.quietWanted || this.filter) return filter?.stop();
    this.filter = filter;
    this.useVoice(filter.stream);
  }

  /** The noise filter over this microphone when you want it (undefined: you don't, or it can't run here). */
  private async startFilter(raw: MediaStream): Promise<NoiseFilter | undefined> {
    if (!this.quietWanted) return undefined;
    const filter = await NoiseFilter.start(raw, () => this.filterBroke(filter));
    if (!filter) this.patch({ quiet: 'none' });
    return filter;
  }

  /** The filter stopped working mid-call: your voice goes on, unfiltered, rather than going silent. */
  private filterBroke(which: NoiseFilter | undefined): void {
    if (!which || which !== this.filter || !this.raw) return;
    this.filter = undefined;
    which.stop();
    this.useVoice(this.raw);
    this.patch({ quiet: 'none' });
  }

  /** Your voice is this stream from now on: every line, the speaking ring and the notes follow. */
  private useVoice(stream: MediaStream): void {
    this.mic = stream;
    this.micAsked = Promise.resolve(stream);
    if (this.view) this.applyMute(this.view);
    const track = stream.getAudioTracks()[0];
    for (const p of this.peers.values()) void p.setMic(track);
    if (this.view) this.levels.watch(this.me, stream);
    this.scribe?.listen(stream);
  }

  /** Use this microphone (undefined: macOS's own) from now on; in a call, the others hear it at once. */
  async pickMic(id: string | undefined): Promise<void> {
    this.micId = id;
    writePref(MIC_PREF, id);
    if (!this.view || this.view.demo || !this.mic) return;
    const token = this.micToken;
    try {
      const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) });
      const filter = await this.startFilter(raw);
      if (token !== this.micToken || !this.view) {
        filter?.stop();
        raw.getTracks().forEach((t) => t.stop());
        return;
      }
      const [oldRaw, oldFilter] = [this.raw, this.filter];
      this.raw = raw;
      this.filter = filter;
      this.useVoice(filter?.stream ?? raw);
      oldFilter?.stop();
      oldRaw?.getTracks().forEach((t) => t.stop());
    } catch {
      this.patch({ problem: 'Couldn’t switch to that microphone. Check it’s plugged in, then pick it again.' });
    }
  }

  /** Play everyone's voices on this speaker (undefined: macOS's own). */
  pickSpeaker(id: string | undefined): void {
    this.speakerId = id;
    writePref(SPEAKER_PREF, id);
    // Back to macOS's own is the only time the default is asked for by name.
    for (const el of this.audio.values()) sink(el, id ?? '');
  }

  /** Start a call here, leaving any other one first. */
  async start(conversation: string): Promise<void> {
    // Still inside the click: the sound wakes now, so the ringback is heard.
    wakeSound();
    await this.leaveOthers(conversation);
    void this.openMic();
    await this.client.api.calls.start(conversation).catch((err: unknown) => this.failed(err));
  }

  async join(conversation: string): Promise<void> {
    wakeSound();
    await this.leaveOthers(conversation);
    void this.openMic();
    await this.client.api.calls.join(conversation).catch((err: unknown) => this.failed(err));
  }

  /** Starting or joining didn't work: the microphone opened for it closes again. */
  private failed(err: unknown): never {
    if (!this.view) this.closeMic();
    throw err;
  }

  async leave(): Promise<void> {
    const c = this.live.conversation;
    if (c) await this.client.api.calls.leave(c);
  }

  async mute(muted: boolean): Promise<void> {
    const c = this.live.conversation;
    if (c) await this.client.api.calls.set(c, { muted });
  }

  /** Share a window or a screen (macOS asks which), tuned for text: sharp before smooth. */
  async share(): Promise<void> {
    const c = this.live.conversation;
    if (!c) return;
    try {
      // The one you share now keeps going until you pick another (a cancelled picker changes nothing).
      const next = this.view?.demo ? demoScreen('you') : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
      this.screen?.getTracks().forEach((t) => t.stop());
      this.screen = next;
      const track = this.screen.getVideoTracks()[0];
      if (track) {
        this.tune(track);
        track.onended = () => void this.stopSharing();
      }
      await this.client.api.calls.set(c, { sharing: true });
      this.stageSend({ k: 'mode', by: this.me, mode: this.live.mode });
      this.reconcile();
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'NotAllowedError' && name !== 'AbortError') this.patch({ problem: 'Couldn’t share your screen. Check Screen Recording in System Settings › Privacy & Security.' });
    }
  }

  async stopSharing(): Promise<void> {
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = undefined;
    const c = this.live.conversation;
    if (c) await this.client.api.calls.set(c, { sharing: false }).catch(() => undefined);
    this.reconcile();
  }

  /** Sharp for text, Smooth for motion: your capture and everyone passing it on follow (but viewers who chose their own). */
  setShareMode(mode: ShareMode): void {
    this.patch({ mode });
    const track = this.screen?.getVideoTracks()[0];
    if (track) this.tune(track);
    this.stageSend({ k: 'mode', by: this.me, mode });
    this.reconcile();
  }

  /**
   * Watching someone's screen: how you want it sent to you (undefined: as they send it). Whoever
   * feeds you sends it so; passed on through someone else, it can't be sharper than what they get.
   */
  setWant(mode: ShareMode | undefined): void {
    this.patch({ want: mode });
    this.stageSend({ k: 'want', by: this.me, ...(mode ? { mode } : {}) });
  }

  /** The sharer's overlay is in the picture now (call/overlay.ts says so as it changes): the others hear it. */
  setOverlayInPicture(on: boolean): void {
    if (on === this.overlayMine) return;
    this.overlayMine = on;
    this.stageSend({ k: 'overlay', by: this.me, inPicture: on });
  }

  /** Your capture: tuned for the mode you send in, and every frame when someone watching wants Smooth. */
  private tune(track: MediaStreamTrack): void {
    const mode = this.live.mode;
    const smooth = mode === 'smooth' || [...this.wants.values()].includes('smooth');
    track.contentHint = mode === 'sharp' ? 'text' : 'motion';
    void track.applyConstraints({ frameRate: smooth ? { ideal: 60, max: 60 } : { ideal: 24, max: 30 } }).catch(() => undefined);
  }

  /** The stage over the whole display (the window goes full screen too), or back. */
  async setTheater(on: boolean): Promise<void> {
    this.patch({ theater: on });
    try {
      if (inApp()) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setFullscreen(on);
      } else if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Full screen refused (a browser without a click behind it): the stage still fills the window.
    }
  }

  /** Your words in the call's notes, or not (others' phrases are still written down here if they need this Mac). */
  async notes(on: boolean): Promise<void> {
    if (!this.view || this.live.notes === 'none') return;
    if (this.scribe) this.scribe.paused = !on;
    this.patch({ notes: on ? 'on' : 'off' });
  }

  /** Notes are possible when someone in the call (you too) has a voice model; paused stays paused. */
  private notesState(): void {
    if (!this.view || this.view.demo) return;
    const others = new Set(this.view.people.filter((p) => !p.me).map((p) => p.peerId));
    // Who writes with what (BLG-738): each Mac's best model for the call's language, for the Notes button to say.
    const language = this.scribe?.language();
    const lang = language ?? 'auto';
    const writers: Record<string, VoiceModelId> = {};
    if (this.scribe) {
      const mine = bestModel(this.scribe.models, lang)?.model;
      if (mine) writers[this.me] = mine;
    }
    for (const st of this.scribes.values()) {
      const theirs = st.ready && others.has(st.by) ? (st.models ? bestModel(st.models, lang)?.model : 'whisper-turbo') : undefined;
      if (theirs) writers[st.by] = theirs;
    }
    const scribing = { writers, ...(language ? { language } : {}) };
    if (JSON.stringify(scribing) !== JSON.stringify(this.live.scribing)) this.patch({ scribing });
    if (this.live.notes === 'off') return;
    const next = Object.keys(writers).length ? 'on' : 'none';
    if (next !== this.live.notes) this.patch({ notes: next });
  }

  /** Who writes down a phrase of yours in `lang`: 'me', another Mac in the call, or nobody (BLG-718, BLG-738). */
  private route = (seconds: number, lang: string): string | undefined => {
    const view = this.view;
    if (!view) return undefined;
    const here = new Set(view.people.filter((p) => !p.me).map((p) => p.peerId));
    const statuses = [...(this.scribe ? [this.scribe.status(this.me)] : []), ...[...this.scribes.values()].filter((st) => here.has(st.by) && this.peers.has(st.by))];
    const who = pickScribe(this.me, statuses, seconds, lang);
    return who === this.me ? 'me' : who;
  };

  /** Send a phrase to the Mac that writes it down; its words come back (or nothing, after a while). */
  private delegate = (to: string, clip: { readonly id: string; readonly wav: string; readonly seconds: number; readonly lang: string }): Promise<Words | undefined> => {
    const peer = this.peers.get(to);
    if (!peer) return Promise.resolve(undefined);
    const parts = Math.ceil(clip.wav.length / CLIP_PART);
    for (let i = 0; i < parts; i++) peer.sendStage(JSON.stringify({ k: 'clip', by: this.me, id: clip.id, part: i, parts, seconds: clip.seconds, lang: clip.lang, b64: clip.wav.slice(i * CLIP_PART, (i + 1) * CLIP_PART) }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.clipsOut.delete(`${to}:${clip.id}`);
        resolve(undefined);
      }, 90_000);
      this.clipsOut.set(`${to}:${clip.id}`, (words) => {
        clearTimeout(timer);
        this.clipsOut.delete(`${to}:${clip.id}`);
        resolve(words?.text ? words : undefined);
      });
    });
  };

  /** Words this Mac wrote down for another's phrase go back to it, with the language they came out in. */
  private giveBack = (to: string, id: string, words: Words): void => {
    this.peers.get(to)?.sendStage(JSON.stringify({ k: 'clip-text', by: this.me, id, text: words.text, ...(words.lang ? { lang: words.lang } : {}) }));
  };

  /** What the other Macs in the call heard, by language (for the call's language, shared/call-language.ts). */
  private heard = (): LanguageCount[] => {
    const here = new Set(this.view?.people.filter((p) => !p.me).map((p) => p.peerId) ?? []);
    return [...this.scribes.values()].filter((st) => here.has(st.by) && st.langs).map((st) => st.langs!);
  };

  /** A part of someone's phrase: once all are here, it waits to be written down (or goes back empty with no model). */
  private clipPart(from: string, m: Extract<StageMessage, { k: 'clip' }>): void {
    const key = `${from}:${m.id}`;
    const got = this.clipsIn.get(key) ?? { parts: new Array<string>(m.parts).fill(''), seconds: m.seconds, ...(m.lang ? { lang: m.lang } : {}) };
    got.parts[m.part] = m.b64;
    this.clipsIn.set(key, got);
    if (got.parts.some((p) => !p)) return;
    this.clipsIn.delete(key);
    if (!this.scribe?.ready) return this.giveBack(from, m.id, { text: '' });
    this.scribe.serve(from, m.id, got.parts.join(''), got.seconds, got.lang);
  }

  /** Start the scribe for a call: it records your words, and writes down yours and others' when it's the Mac for it. */
  private async startScribe(call: CallView, mic: MediaStream | undefined): Promise<void> {
    const models = await scribeModels(this.client);
    if (this.view?.id !== call.id) return;
    this.scribe = new Scribe(this.client, { route: this.route, delegate: this.delegate, giveBack: this.giveBack, heard: this.heard }, models);
    this.scribe.start(mic);
    // Every few seconds, each Mac says how it does as a scribe: the others route their phrases by it.
    const say = (): void => {
      if (this.scribe) this.stageSend({ k: 'scribe', ...this.scribe.status(this.me) });
      this.notesState();
    };
    say();
    this.stopScribeTalk = repeat(say, 4_000);
    this.notesState();
  }

  /** Face to face over the whole window, or back to the chat. */
  setFaces(on: boolean): void {
    this.patch({ faces: on });
  }

  /** The screen you share now, if you share one (the overlay covers it, call/overlay.ts). */
  sharedTrack(): MediaStreamTrack | undefined {
    return this.screen?.getVideoTracks()[0];
  }

  /** Your camera on or off (macOS asks the first time). */
  async camera(on: boolean): Promise<void> {
    const c = this.live.conversation;
    if (!c) return;
    if (!on) {
      this.cam?.getTracks().forEach((t) => t.stop());
      this.cam = undefined;
      await this.client.api.calls.set(c, { camera: false }).catch(() => undefined);
      this.reconcile();
      return;
    }
    try {
      this.cam = this.view?.demo ? demoCamera('You') : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' } });
      for (const t of this.cam.getVideoTracks()) t.contentHint = 'motion';
      await this.client.api.calls.set(c, { camera: true });
      this.reconcile();
    } catch {
      this.cam = undefined;
      this.patch({ problem: 'Beluga can’t use your camera. Allow it in System Settings › Privacy & Security › Camera.' });
    }
  }

  /** Something on the stage everyone in the call sees (ink, the laser, an ask). */
  stageSend(m: StageMessage): void {
    const text = JSON.stringify(m);
    for (const p of this.peers.values()) p.sendStage(text);
    if (m.k === 'asked') this.patch({ asks: [...this.live.asks, m.ask].slice(-8) });
    for (const fn of this.stageSubs) fn(m);
  }

  /** Where your pointer is, for everyone (often: on the fast channel where there is one). */
  pointerSend(m: Extract<StageMessage, { k: 'laser' }>): void {
    const text = JSON.stringify(m);
    // Stopping must arrive: it goes the sure way.
    for (const p of this.peers.values()) (m.x < 0 ? p.sendStage(text) : p.sendPointer(text));
    for (const fn of this.stageSubs) fn(m);
  }

  onStage(fn: StageListener): () => void {
    this.stageSubs.add(fn);
    return () => void this.stageSubs.delete(fn);
  }

  stop(): void {
    for (const off of this.offs) off();
    this.end();
  }

  // ---- inside

  private patch(p: Partial<CallLive>): void {
    this.live = { ...this.live, ...p };
    for (const fn of [...this.subs]) fn();
  }

  private async leaveOthers(conversation: string): Promise<void> {
    const calls = this.client.store.getState().network.calls ?? {};
    await Promise.all(
      Object.values(calls)
        .filter((c) => c.mine === 'in' && c.conversation !== conversation)
        .map((c) => this.client.api.calls.leave(c.conversation).catch(() => undefined)),
    );
  }

  private openMic(): Promise<MediaStream | undefined> {
    const token = this.micToken;
    this.micAsked ??= navigator.mediaDevices
      .getUserMedia({ audio: micConstraints(this.micId) })
      .then(async (raw) => {
        const filter = await this.startFilter(raw);
        // The call ended while macOS asked: this microphone isn't wanted any more.
        if (token !== this.micToken) {
          filter?.stop();
          raw.getTracks().forEach((t) => t.stop());
          return undefined;
        }
        this.raw = raw;
        this.filter = filter;
        const s = filter?.stream ?? raw;
        this.mic = s;
        if (this.view) this.applyMute(this.view);
        // Lines made while it opened carry it from now on.
        const track = s.getAudioTracks()[0];
        for (const p of this.peers.values()) void p.setMic(track);
        return s;
      })
      .catch(() => {
        this.micAsked = undefined;
        this.patch({ problem: 'Beluga can’t hear your microphone. Allow it in System Settings › Privacy & Security › Microphone.' });
        return undefined;
      });
    return this.micAsked;
  }

  /** The shared state changed: follow the call you're in. */
  private follow(): void {
    const calls = this.client.store.getState().network.calls ?? {};
    const mine = Object.values(calls).find((c) => c.mine === 'in');
    if (!mine) {
      if (this.view) this.end();
      return;
    }
    if (this.view && (this.view.id !== mine.id || this.view.conversation !== mine.conversation)) this.end();
    const first = !this.view;
    this.view = mine;
    if (first) void this.begin(mine);
    else this.reconcile();
  }

  private async begin(call: CallView): Promise<void> {
    this.patch({ ...EMPTY, want: undefined, overlayBy: undefined, quiet: this.quietWanted ? 'on' : 'off', conversation: call.conversation, call: call.id });
    // This window makes your side of the call: say so now, and every few seconds while it does.
    const keep = (): void => {
      const c = this.live.conversation;
      if (c) void this.client.api.calls.set(c, {}).catch(() => undefined);
    };
    keep();
    this.stopBeat = repeat(keep, HEARTBEAT_MS - 2_000);
    this.stopStats = repeat(() => void this.measure(), 2_000);
    const mic = await this.openMic();
    if (this.view?.id !== call.id) return;
    if (mic) this.levels.watch(this.me, mic);
    // The microphone opened before the call's state was fresh: say again whether the filter runs.
    if (mic) this.patch({ quiet: this.filter ? 'on' : this.quietWanted ? 'none' : 'off' });
    this.reconcile();
  }

  /**
   * Notes begin once someone else is in the call: your own words, written down by whichever Mac in
   * it is soonest (BLG-718). While it only rings, nothing is written down.
   */
  private async beginNotes(call: CallView): Promise<void> {
    if (this.notesFor === call.id || !call.people.some((p) => !p.me)) return;
    this.notesFor = call.id;
    if (call.demo) return this.patch({ notes: 'on' });
    const mic = await this.openMic();
    if (this.view?.id === call.id) await this.startScribe(call, mic);
  }

  /** The call is over for you: what you said goes to the others who were in it (an empty part says you're done). */
  private sendNotes(call: CallView): void {
    const scribe = this.scribe;
    const before = this.written;
    const demo = call.demo && this.live.notes === 'on';
    this.scribe = undefined;
    this.written = [];
    this.stopScribeTalk?.();
    this.stopScribeTalk = undefined;
    if (!demo && !scribe) return;
    void (async () => {
      const said = demo ? demoPhrases(call.startedAt) : [...before, ...((await scribe?.finish()) ?? [])];
      await this.client.api.calls.notes(call.id, said.slice(0, 3_000)).catch(() => undefined);
    })();
  }

  private end(): void {
    if (this.view) this.sendNotes(this.view);
    this.notesFor = undefined;
    this.stopBeat?.();
    this.stopStats?.();
    this.stopBeat = this.stopStats = undefined;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.lineSince.clear();
    this.unreachableSaid = false;
    for (const a of this.audio.values()) {
      a.srcObject = null;
      a.remove();
    }
    this.audio.clear();
    this.incoming.clear();
    this.kinds.clear();
    this.wants.clear();
    this.overlayMine = false;
    this.viewsOf.clear();
    this.scribes.clear();
    this.clipsIn.clear();
    for (const done of [...this.clipsOut.values()]) done(undefined);
    this.sharingTo = new Set();
    this.myView = { big: [], visible: false };
    this.uplink = this.uplinkSaid = undefined;
    this.demoVoices.clear();
    this.stopDemoPointer?.();
    this.stopDemoPointer = undefined;
    this.cam?.getTracks().forEach((t) => t.stop());
    this.cam = undefined;
    if (this.live.theater) void this.setTheater(false);
    this.levels.stop();
    this.closeMic();
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = undefined;
    this.view = undefined;
    this.patch({ ...EMPTY, want: undefined, overlayBy: undefined });
  }

  private closeMic(): void {
    this.micToken++;
    this.filter?.stop();
    this.filter = undefined;
    this.raw?.getTracks().forEach((t) => t.stop());
    this.raw = undefined;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = undefined;
    this.micAsked = undefined;
  }

  private applyMute(call: CallView): void {
    const muted = call.people.find((p) => p.me)?.muted ?? false;
    // Muted at the microphone itself too: nothing of you reaches the filter, the ring or the notes.
    for (const t of [...(this.raw?.getAudioTracks() ?? []), ...(this.mic?.getAudioTracks() ?? [])]) t.enabled = !muted;
  }

  /** Make the lines match the call: one per person, the share going where the tree says. */
  private reconcile(): void {
    const call = this.view;
    if (!call) return;
    void this.beginNotes(call);
    this.applyMute(call);
    const me = this.me;
    const others = call.people.filter((p) => !p.me);
    if (call.demo) return this.reconcileDemo(call);
    const ids = new Set(others.map((p) => p.peerId));
    for (const [id, peer] of this.peers) {
      if (ids.has(id)) continue;
      peer.close();
      this.peers.delete(id);
      this.lineSince.delete(id);
      this.dropAudio(id);
      this.incoming.delete(id);
      this.kinds.delete(id);
      this.wants.delete(id);
      this.levels.forget(id);
    }
    for (const p of others) if (!this.peers.has(p.peerId)) this.peers.set(p.peerId, this.line(call, p.peerId));
    this.reconcileCameras(call, others.length + 1);
    // The share: who has the stage, who feeds whom.
    const sharer = sharerOf(call);
    // The overlay in the picture was that sharer's: another share has its own.
    if (this.live.overlayBy && this.live.overlayBy !== sharer?.peerId) this.patch({ overlayBy: undefined });
    // Someone shared after you: they have the stage now, and your capture stops.
    if (this.screen && sharer && !sharer.me) void this.stopSharing();
    if (!sharer || (sharer.me && !this.screen)) {
      for (const peer of this.peers.values()) void peer.setVideo(undefined);
      if (this.live.stage) this.patch({ stage: undefined });
      return;
    }
    // The best uploads closest to the sharer (each Mac says what it can send), so a call of ten stays sharp.
    const viewers = call.people.filter((p) => p.peerId !== sharer.peerId);
    const tree = shareTreeBy(sharer, viewers);
    this.sharingTo = new Set(shareChildren(tree, me));
    const outgoing = sharer.me ? this.screen?.getVideoTracks()[0] : this.picture(tree.get(me) ?? '', 'screen');
    const children = this.sharingTo;
    // Each viewer gets it the way they asked for, else the sharer's way.
    for (const [id, peer] of this.peers) void peer.setVideo(children.has(id) ? outgoing : undefined, this.wants.get(id) ?? this.live.mode);
    const stream = sharer.me ? this.screen : outgoing ? new MediaStream([outgoing]) : undefined;
    const was = this.live.stage;
    if (!stream) {
      if (was) this.patch({ stage: undefined });
    } else if (was?.by !== sharer.peerId || was.stream.getVideoTracks()[0] !== stream.getVideoTracks()[0]) this.patch({ stage: { by: sharer.peerId, stream } });
  }

  /** How this person shows your camera, as they last said (small until they say). */
  private sizeFor(peerId: string): CameraSize {
    const v = this.viewsOf.get(peerId);
    if (!v) return 'small';
    if (!v.visible) return 'none';
    return v.big.has(this.me) ? 'big' : 'small';
  }

  /** Whether you pass the screen share on to this person now. */
  private passesShareTo(peerId: string): boolean {
    return this.sharingTo.has(peerId);
  }
  private sharingTo = new Set<string>();

  /**
   * Whose cameras you show big and whether you show any (the face view, the band, the filmstrip
   * say): everyone sends you theirs at that size, nothing for what you don't see.
   */
  setCameraView(big: readonly string[], visible: boolean): void {
    const same = visible === this.myView.visible && big.length === this.myView.big.length && big.every((b, i) => b === this.myView.big[i]);
    if (same) return;
    this.myView = { big: [...big], visible };
    this.stageSend({ k: 'view', by: this.me, big, visible });
  }

  /** Someone's camera or the screen they send, while frames come. */
  private picture(peerId: string, kind: 'cam' | 'screen'): MediaStreamTrack | undefined {
    const id = this.kinds.get(peerId)?.[kind];
    const got = id ? this.incoming.get(peerId)?.get(id) : undefined;
    return got?.live ? got.track : undefined;
  }

  /** Your camera to everyone (smaller as the call grows), and everyone's cameras to draw. */
  private reconcileCameras(call: CallView, people: number): void {
    const mine = call.people.find((p) => p.me)?.camera ? this.cam?.getVideoTracks()[0] : undefined;
    // Each person gets your camera as big as they show it; your upload is split by what's asked
    // (a big picture counts four small ones), after the screen you share or pass on.
    const sizes = new Map<string, CameraSize>([...this.peers.keys()].map((id) => [id, this.sizeFor(id)]));
    const weight = [...sizes.values()].reduce((n, s) => n + (s === 'big' ? 4 : s === 'small' ? 1 : 0), 0);
    const sharing = this.screen || [...this.peers.keys()].some((id) => this.passesShareTo(id)) ? SHARE_KBPS : 0;
    const room = this.uplink !== undefined ? Math.max(300, this.uplink * 0.75 - sharing) : undefined;
    for (const [id, peer] of this.peers) {
      const size = sizes.get(id)!;
      const share = room !== undefined && weight ? (room * (size === 'big' ? 4 : 1)) / weight : undefined;
      void peer.setCamera(mine, size, share);
    }
    void people;
    const cameras: Record<string, MediaStream> = {};
    for (const p of call.people) {
      if (!p.camera) continue;
      if (p.me) {
        if (this.cam) cameras[p.peerId] = this.cam;
        continue;
      }
      const track = this.picture(p.peerId, 'cam');
      if (track) cameras[p.peerId] = this.live.cameras[p.peerId]?.getVideoTracks()[0] === track ? this.live.cameras[p.peerId]! : new MediaStream([track]);
    }
    if (!sameKeys(cameras, this.live.cameras)) this.patch({ cameras });
  }

  private line(call: CallView, peerId: string): Peer {
    const conversation = call.conversation;
    const mic = this.mic?.getAudioTracks()[0];
    this.lineSince.set(peerId, Date.now());
    return new Peer(
      {
        me: this.me,
        polite: this.me > peerId,
        send: (data) => void this.client.api.calls.signal(conversation, peerId, data).catch(() => undefined),
        onAudio: (stream) => {
          this.playAudio(peerId, stream);
          this.levels.watch(peerId, stream);
        },
        onVideo: (track, streamId, live) => {
          const theirs = this.incoming.get(peerId) ?? new Map<string, Incoming>();
          theirs.set(streamId, { track, live });
          this.incoming.set(peerId, theirs);
          this.reconcile();
        },
        onStage: (text) => {
          const m = parseStage(text);
          if (!m || m.by !== peerId) return;
          if (m.k === 'streams') {
            this.kinds.set(peerId, { ...(m.cam ? { cam: m.cam } : {}), ...(m.screen ? { screen: m.screen } : {}) });
            const line = this.peers.get(peerId);
            if (line) line.pointersOk = Boolean(m.pointers);
            return this.reconcile();
          }
          if (m.k === 'view') {
            this.viewsOf.set(peerId, { big: new Set(m.big), visible: m.visible });
            return this.reconcile();
          }
          if (m.k === 'scribe') {
            const { k: _k, ...status } = m;
            this.scribes.set(peerId, status);
            return this.notesState();
          }
          if (m.k === 'clip') return this.clipPart(peerId, m);
          if (m.k === 'clip-text') return this.clipsOut.get(`${peerId}:${m.id}`)?.({ text: m.text, ...(m.lang ? { lang: m.lang } : {}) });
          if (m.k === 'want') {
            if (m.mode) this.wants.set(peerId, m.mode);
            else this.wants.delete(peerId);
            const track = this.screen?.getVideoTracks()[0];
            if (track) this.tune(track);
            return this.reconcile();
          }
          if (m.k === 'overlay') {
            if (this.view && sharerOf(this.view)?.peerId === peerId) this.patch({ overlayBy: m.inPicture ? peerId : undefined });
            return;
          }
          if (m.k === 'mode') {
            // Only the sharer's word counts; the relays follow it too.
            if (this.view && sharerOf(this.view)?.peerId === peerId) this.patch({ mode: m.mode });
            return this.reconcile();
          }
          if (m.k === 'asked') this.patch({ asks: [...this.live.asks, m.ask].slice(-8) });
          for (const fn of this.stageSubs) fn(m);
        },
        onState: (state) => {
          this.patch({ lines: { ...this.live.lines, [peerId]: { ...this.live.lines[peerId], state } } });
          // Connected: it's fine. Dropped later: patience again from now.
          if (state === 'connected') this.lineSince.delete(peerId);
          else if (!this.lineSince.has(peerId)) this.lineSince.set(peerId, Date.now());
          if (state === 'connected' && this.unreachableSaid) this.watchLines();
          // Someone who just joined hears how your screen is sent, and how you show their camera.
          if (state === 'connected' && this.screen) this.peers.get(peerId)?.sendStage(JSON.stringify({ k: 'mode', by: this.me, mode: this.live.mode }));
          if (state === 'connected') this.peers.get(peerId)?.sendStage(JSON.stringify({ k: 'view', by: this.me, big: this.myView.big, visible: this.myView.visible }));
          if (state === 'connected' && this.live.want) this.peers.get(peerId)?.sendStage(JSON.stringify({ k: 'want', by: this.me, mode: this.live.want }));
          if (state === 'connected' && this.overlayMine) this.peers.get(peerId)?.sendStage(JSON.stringify({ k: 'overlay', by: this.me, inPicture: true }));
        },
      },
      mic,
    );
  }

  private onIntent(i: Intent): void {
    if (i.type !== 'call_signal' || i.call !== this.view?.id) return;
    let peer = this.peers.get(i.from);
    // Their offer can come before the roster says they're in: their line starts now.
    if (!peer && this.view.people.some((p) => p.peerId === i.from)) {
      peer = this.line(this.view, i.from);
      this.peers.set(i.from, peer);
    }
    void peer?.receive(i.data);
  }

  private playAudio(peerId: string, stream: MediaStream): void {
    let el = this.audio.get(peerId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.dataset['callVoice'] = peerId;
      el.style.display = 'none';
      document.body.append(el);
      this.audio.set(peerId, el);
    }
    el.srcObject = stream;
    // A voice plays where macOS plays sound, as before speakers could be picked (BLG-737), unless you picked one.
    if (this.speakerId) sink(el, this.speakerId);
    const voice = el;
    void voice.play().catch(() => {
      // Refused without a click: it plays on your next click or key in this window.
      const retry = (): void => void voice.play().catch(() => undefined);
      document.addEventListener('pointerdown', retry, { once: true, capture: true });
      document.addEventListener('keydown', retry, { once: true, capture: true });
    });
  }

  private dropAudio(peerId: string): void {
    const el = this.audio.get(peerId);
    if (!el) return;
    el.srcObject = null;
    el.remove();
    this.audio.delete(peerId);
  }

  /**
   * A line that doesn't connect is a call where nobody hears anything, while the notes still come
   * (they go between the daemons): the strip says so, by name, until it connects.
   */
  private watchLines(): void {
    const now = Date.now();
    const stuck = [...this.peers.keys()].filter((id) => now - (this.lineSince.get(id) ?? now) > LINE_PATIENCE_MS);
    const said = this.unreachableSaid && this.live.problem;
    if (!stuck.length) {
      if (said) this.patch({ problem: undefined });
      this.unreachableSaid = false;
      return;
    }
    if (this.live.problem && !said) return;
    const names = stuck.map((id) => this.view?.people.find((p) => p.peerId === id)?.name ?? 'them');
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const problem = `Can’t reach ${who} for sound: your Macs can’t connect directly. A VPN like Cloudflare WARP can block calls.`;
    this.unreachableSaid = true;
    if (problem !== this.live.problem) this.patch({ problem });
  }

  private async measure(): Promise<void> {
    this.watchLines();
    const entries = await Promise.all([...this.peers].map(async ([id, p]) => [id, await p.health()] as const));
    let changed = false;
    const lines = { ...this.live.lines };
    let best: number | undefined;
    for (const [id, h] of entries) {
      if (h.send !== undefined) best = Math.max(best ?? 0, h.send);
      if (h.rtt === undefined || lines[id]?.rtt === h.rtt) continue;
      lines[id] = { state: lines[id]?.state ?? 'connected', rtt: h.rtt };
      changed = true;
    }
    if (changed) this.patch({ lines });
    // What you can send (the best line's estimate, smoothed), told to the others when it moves by a fifth.
    if (best !== undefined) {
      this.uplink = this.uplink === undefined ? best : Math.round(this.uplink * 0.7 + best * 0.3);
      const said = this.uplinkSaid;
      const c = this.live.conversation;
      if (c && (said === undefined || Math.abs(this.uplink - said) > said * 0.2)) {
        this.uplinkSaid = this.uplink;
        void this.client.api.calls.set(c, { uplink: this.uplink }).catch(() => undefined);
      }
      this.reconcile();
    }
  }

  /** The demo's friends make no sound of their own: their voices and screens are played here. */
  private reconcileDemo(call: CallView): void {
    const lines: Record<string, { state: LineState; rtt?: number }> = {};
    for (const p of call.people.filter((x) => !x.me)) {
      lines[p.peerId] = { state: 'connected', rtt: 18 + (p.peerId.charCodeAt(0) % 20) };
      if (!this.demoVoices.has(p.peerId)) {
        this.levels.pretend(p.peerId, demoVoice(p.peerId));
        this.demoVoices.add(p.peerId);
      }
    }
    const cameras: Record<string, MediaStream> = {};
    for (const p of call.people) {
      if (!p.camera) continue;
      if (p.me) {
        if (this.cam) cameras[p.peerId] = this.cam;
      } else cameras[p.peerId] = this.live.cameras[p.peerId] ?? demoCamera(p.name);
    }
    if (!sameKeys(cameras, this.live.cameras)) this.patch({ cameras });
    const sharer = sharerOf(call);
    let stage = this.live.stage;
    if (!sharer) stage = undefined;
    else if (sharer.me) stage = this.screen ? { by: sharer.peerId, stream: this.screen } : undefined;
    else if (stage?.by !== sharer.peerId) stage = { by: sharer.peerId, stream: demoScreen(sharer.name) };
    if (JSON.stringify(lines) !== JSON.stringify(this.live.lines) || stage !== this.live.stage) this.patch({ lines, stage });
    // Someone who isn't sharing points at it, the way pointers come over a real network.
    const pointer = stage ? call.people.find((p) => !p.me && !p.sharing) : undefined;
    if (pointer && !this.stopDemoPointer) {
      this.stopDemoPointer = repeat(() => {
        const [x, y] = demoPointer(performance.now());
        for (const fn of this.stageSubs) fn({ k: 'laser', by: pointer.peerId, x, y });
      }, 60);
    } else if (!pointer && this.stopDemoPointer) {
      this.stopDemoPointer();
      this.stopDemoPointer = undefined;
    }
  }
}

/** The same people with the same streams (so screens draw again only when cameras change). */
function sameKeys(a: Readonly<Record<string, MediaStream>>, b: Readonly<Record<string, MediaStream>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** A microphone or speaker on this Mac. */
export interface AudioDevice {
  readonly id: string;
  readonly label: string;
}

export interface AudioDevices {
  readonly mics: readonly AudioDevice[];
  readonly speakers: readonly AudioDevice[];
  /** The ones in use (undefined: macOS's own). */
  readonly mic?: string;
  readonly speaker?: string;
  /** WebKit can send sound to a speaker other than macOS's own. */
  readonly canPickSpeaker: boolean;
}

const MIC_PREF = 'beluga.call.mic';
const SPEAKER_PREF = 'beluga.call.speaker';
const QUIET_PREF = 'beluga.call.quiet';

function readPref(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePref(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private storage off: the choice lasts until Beluga restarts.
  }
}

/**
 * Your voice from the microphone you picked (if it's gone, macOS's own). WebKit takes only echo
 * cancellation from these (macOS's voice processing): background noise is taken out after, by the
 * call's own filter (call/noise-filter.ts, BLG-744). The rest is for other browsers.
 */
function micConstraints(id: string | undefined): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000, ...(id ? { deviceId: { ideal: id } } : {}) };
}

/** Send a voice to a speaker ('' : macOS's own), where WebKit allows it. */
function sink(el: HTMLMediaElement, id: string): void {
  const media = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof media.setSinkId === 'function') void media.setSinkId(id).catch(() => undefined);
}

let engine: CallEngine | undefined;

/** This window's call engine (made once, by the call layer). */
export function callEngine(client: SocketClient): CallEngine {
  engine ??= new CallEngine(client);
  return engine;
}

export const existingEngine = (): CallEngine | undefined => engine;
