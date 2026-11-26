import { useEffect, useState } from 'react';
import type { VoiceMacView } from '@beluga/companion/protocol.js';
import { VOICE_LANGUAGES, VOICE_MODELS, voiceKnows, voiceSize } from '@beluga/shared/voice-models.js';
import { Button, Kbd } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { accelLabel, accelOf, DEFAULT_SHORTCUT, microphonesOf, parseAccel, type Microphone } from '../lib/dictation-model.js';
import { voiceModelOf } from '../lib/dictation.js';
import { inApp } from '../lib/boot.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import s from './settings.module.css';
import { chordLabel, keyPlatform } from '../lib/shortcuts-model.js';
import { microphoneSettings, osName, systemSettingsName, thisComputer, yourComputer } from '../lib/os-words.js';

/**
 * Settings › Voice (BLG-146): speaking instead of typing. The microphone it listens to (BLG-766),
 * which model writes it down (the one Beluga suggests for your language, or yours), the language, the talk shortcut (recorded by
 * pressing it), whether it works from any app, whether it's sent at once, and the models on this Mac.
 */
export function VoiceSettings() {
  const api = useApi();
  const prefs = usePrefs();
  const [models, setModels] = useState<VoiceMacView | undefined>();
  const [recording, setRecording] = useState(false);
  const [bad, setBad] = useState<string | undefined>();
  const using = voiceModelOf(prefs);
  const suggested = voiceModelOf({ voiceModel: 'suggested', voiceLanguage: prefs.voiceLanguage });
  const mics = useMicrophones();

  // The models here, and how far one coming is (every 1.5 s while one comes).
  const coming = models?.models.some((m) => m.progress !== undefined) ?? false;
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = (): void =>
      void api.voice.models().then(
        (v) => {
          if (!alive) return;
          setModels(v as VoiceMacView);
          // While one comes, look again in a moment (the pane is open, so you're looking).
          if (coming) t = setTimeout(look, 1500);
        },
        () => undefined,
      );
    look();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, [coming]);

  // The recorder: the next keys pressed (with at least one of ⌘⌃⌥ for a letter, digit or Space) become the shortcut.
  useEffect(() => {
    if (!recording) return;
    const down = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRecording(false);
      const accel = accelOf(e);
      if (!accel) return;
      if (!parseAccel(accel)) return setBad(`${accelLabel(accel)} would type: add ${keyPlatform() === 'mac' ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'}`);
      setBad(undefined);
      setPrefs({ voiceShortcut: accel });
      setRecording(false);
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [recording]);

  const label = (id: 'whisper-turbo' | 'parakeet'): string => (id === 'parakeet' ? 'Parakeet: fastest' : 'Whisper Turbo: every language');
  const keys = prefs.voiceShortcut ? accelLabel(prefs.voiceShortcut) : undefined;
  return (
    <>
      <Group title="Writing it down">
        <MicrophoneRow mics={mics} />
        <Row
          label="Model"
          detail={
            prefs.voiceModel === 'suggested'
              ? `Suggested for ${prefs.voiceLanguage === 'en' ? 'English' : 'your language'}: ${VOICE_MODELS[suggested].label}. ${suggested === 'parakeet' ? 'As exact as Whisper in English, and faster.' : 'Knows every language, Turkish too, and tells which you speak.'}`
              : using !== prefs.voiceModel
                ? `Parakeet doesn’t know that language: Whisper Turbo writes it instead.`
                : using === 'parakeet'
                  ? 'English and 24 European languages (no Turkish). The fastest.'
                  : 'Every language. A moment slower than Parakeet.'
          }
        >
          <Select
            label="Model"
            value={prefs.voiceModel}
            onChange={(v) => setPrefs({ voiceModel: v })}
            options={[
              { value: 'suggested', label: `Suggested (${VOICE_MODELS[suggested].label})` },
              { value: 'whisper-turbo', label: label('whisper-turbo') },
              { value: 'parakeet', label: label('parakeet') },
            ]}
          />
        </Row>
        <Row label="Language" detail={prefs.voiceLanguage === 'auto' ? 'The model tells which you speak.' : 'Only this one: a little more exact.'}>
          <Select label="Language" value={prefs.voiceLanguage} onChange={(v) => setPrefs({ voiceLanguage: v })} options={VOICE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
        </Row>
        {(models?.models ?? []).map((m) => (
          <Row
            key={m.model}
            label={VOICE_MODELS[m.model].label}
            detail={
              m.ready
                ? `On ${thisComputer()} · ${voiceSize(m.bytes)}${m.model === using ? ' · in use' : ''}`
                : m.progress !== undefined
                  ? `Getting it · ${Math.round(m.progress * 100)}% of ${voiceSize(m.bytes)}`
                  : (m.error ?? `${voiceSize(m.bytes)}, once. It comes by itself the first time you speak${m.model === using ? '' : ' with it'}.`)
            }
          >
            {m.ready ? null : m.progress !== undefined ? null : (
              <Button disabled={!voiceKnows(m.model, prefs.voiceLanguage) && m.model === 'parakeet'} onClick={() => void api.voice.prepare(m.model).then((v) => setModels(v as VoiceMacView), () => undefined)}>
                Get Now
              </Button>
            )}
          </Row>
        ))}
      </Group>

      <Group title="Talk shortcut">
        <Row
          label="Shortcut"
          detail={
            bad ??
            (recording ? (
              'Press the keys you want (esc to stop)'
            ) : keys ? (
              <>
                Hold <Kbd>{keys}</Kbd> and talk, let go to write it in. Or tap it, talk, and press <Kbd>↩</Kbd>. <Kbd>esc</Kbd> throws it away.
              </>
            ) : (
              'None: use the microphone beside Send.'
            ))
          }
        >
          <Button onClick={() => (setBad(undefined), setRecording((r) => !r))}>{recording ? 'Press Keys…' : (keys ?? 'Set…')}</Button>
          {prefs.voiceShortcut && !recording ? (
            <Button variant="quiet" onClick={() => setPrefs({ voiceShortcut: '' })}>
              Clear
            </Button>
          ) : null}
          {!prefs.voiceShortcut && !recording ? (
            <Button variant="quiet" onClick={() => setPrefs({ voiceShortcut: DEFAULT_SHORTCUT })}>
              {accelLabel(DEFAULT_SHORTCUT)}
            </Button>
          ) : null}
        </Row>
        {inApp() ? (
          <Row label="From any app" detail="The shortcut brings Beluga forward and listens, wherever you are. It writes into the chat you were last in.">
            <Switch label="From any app" on={prefs.voiceAnyApp} onChange={(v) => setPrefs({ voiceAnyApp: v })} />
          </Row>
        ) : null}
        <Row label="Send right away" detail={prefs.voiceSend ? 'Written down, it’s sent. Your words don’t wait in the box.' : `Written down, it waits in the box to read over. ${chordLabel('Cmd+Enter')} sends it at once.`}>
          <Switch label="Send right away" on={prefs.voiceSend} onChange={(v) => setPrefs({ voiceSend: v })} />
        </Row>
      </Group>
      <p className={s.note}>What you say is written down on {thisComputer()}, on its GPU, and the recording is deleted at once. Nothing leaves {yourComputer()}. Your phone uses the same models when it’s set to run on {yourComputer()}.</p>
    </>
  );
}

interface Microphones {
  readonly list: readonly Microphone[];
  /** WebKit names them only once Beluga may use the microphone. */
  readonly named: boolean;
  /** Ask for the microphone once, so they show by name. */
  readonly reveal: () => Promise<void>;
  readonly error?: string;
}

/** The microphones on this computer, following ones plugged in or taken out while Settings is open. */
function useMicrophones(): Microphones {
  const [all, setAll] = useState<readonly MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | undefined>();
  const load = (): Promise<void> =>
    (navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([])).then(
      (d) => setAll(d),
      () => setAll([]),
    );
  useEffect(() => {
    void load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, []);
  const reveal = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      setError(undefined);
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setError(denied ? `Beluga can’t use the microphone: allow it in ${microphoneSettings()}` : 'Couldn’t list the microphones');
    }
    await load();
  };
  const list = microphonesOf(all);
  return { list, named: all.some((d) => d.kind === 'audioinput' && d.label), reveal, ...(error ? { error } : {}) };
}

/** Settings › Voice › Microphone: the one dictation listens to (calls keep their own, beside Mute). */
function MicrophoneRow({ mics }: { readonly mics: Microphones }) {
  const prefs = usePrefs();
  const picked = prefs.voiceMic;
  const gone = Boolean(picked) && mics.named && !mics.list.some((m) => m.id === picked);
  const detail =
    mics.error ??
    (!mics.named
      ? `Show them by name to pick one. Until then, it listens to the one ${osName()} uses.`
      : gone
        ? `The one you picked isn’t plugged in: it listens to the one ${osName()} uses until it’s back.`
        : picked
          ? 'Dictation listens to this one. Calls pick their own, beside Mute.'
          : `The one set in ${systemSettingsName()} › Sound. Calls pick their own, beside Mute.`);
  return (
    <Row label="Microphone" detail={detail}>
      {mics.named ? (
        <Select
          label="Microphone"
          value={gone ? '' : picked}
          onChange={(v) => setPrefs({ voiceMic: v })}
          options={[{ value: '', label: `Same as ${osName()}` }, ...mics.list.map((m) => ({ value: m.id, label: m.label }))]}
        />
      ) : (
        <Button onClick={() => void mics.reveal()}>Show Microphones</Button>
      )}
    </Row>
  );
}
