import { type ReactNode, useEffect, useState } from 'react';
import type { NotifySettings } from '../../../../../src/shared/settings-schema.js';
import { type SoundChoice, type SoundGroup, SOUND_GROUPS, coerceSound, soundFor, volumeOf } from '../../../../../src/shared/notify-sound.js';
import { Segmented, cx } from '../../components/ui.js';
import { belugaMade, soundTitle } from '../../lib/sounds/catalog.js';
import { syncSounds } from '../../lib/sounds/native.js';
import { playSound } from '../../lib/sounds/player.js';
import { Group, Row } from '../settings-controls.js';
import st from '../settings.module.css';
import { PlayButton, SoundPicker } from './SoundPicker.js';
import s from './sound.module.css';
import { keyPlatform } from '../../lib/shortcuts-model.js';

const GROUP_LABELS: Readonly<Record<SoundGroup, string>> = {
  needsYou: 'Your agent needs you',
  done: 'Your agent finished',
  mentions: 'Messages and mentions',
  people: 'People come and go',
  background: 'Background tasks',
};

/** Whose sound the picker is choosing: everything's, or one kind's. */
type Target = 'all' | SoundGroup;

const MAX_MADE = 12;

export interface SoundSettingsProps {
  readonly n: NotifySettings;
  readonly save: (patch: Partial<NotifySettings>) => void;
  /** Rows right under the sound (Send Test Notification), above the picker. */
  readonly test?: ReactNode;
}

/** Settings › Notifications › Sound: which sound, per kind if you like, and how loud. */
export function SoundSettings({ n, save, test }: SoundSettingsProps) {
  const perKind = n.perKind !== null && n.perKind !== undefined;
  const [target, setTarget] = useState<Target>(perKind ? 'needsYou' : 'all');
  const [volume, setVolume] = useState(volumeOf(n));
  const editing = target === 'all' || !perKind ? 'all' : target;
  const value: SoundChoice = editing === 'all' ? coerceSound(n.sound) : soundFor(n, editing);

  // The volume slider saves once you let go of it for a moment.
  useEffect(() => setVolume(volumeOf(n)), [n.soundVolume]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (Math.abs(volume - volumeOf(n)) < 0.005) return;
    const t = setTimeout(() => save({ soundVolume: volume }), 350);
    return () => clearTimeout(t);
  }, [volume]); // eslint-disable-line react-hooks/exhaustive-deps

  // Beluga's sounds go to ~/Library/Sounds ahead of the next notification (old ones are removed).
  const inUse = JSON.stringify([n.sound, n.perKind, n.soundVolume]);
  useEffect(() => {
    const t = setTimeout(() => void syncSounds(n).catch(() => undefined), 800);
    return () => clearTimeout(t);
  }, [inUse]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (choice: SoundChoice): void => {
    if (editing === 'all') save({ sound: choice });
    else save({ perKind: { ...n.perKind, [editing]: choice } });
  };
  const keep = (seed: number): void => {
    const made = [seed, ...n.madeSounds.filter((m) => m !== seed)].slice(0, MAX_MADE);
    const choice: SoundChoice = { kind: 'gen', seed };
    save(editing === 'all' ? { madeSounds: made, sound: choice } : { madeSounds: made, perKind: { ...n.perKind, [editing]: choice } });
  };
  const setMode = (mode: 'same' | 'kind'): void => {
    if (mode === 'kind') {
      const all = coerceSound(n.sound);
      save({ perKind: Object.fromEntries(SOUND_GROUPS.map((g) => [g, all])) });
      setTarget('needsYou');
    } else {
      save({ perKind: null });
      setTarget('all');
    }
  };

  return (
    <Group title="Sound">
      <Row label="Sounds" detail={perKind ? 'Pick a kind below, then its sound.' : 'One sound for every notification.'}>
        <Segmented<'same' | 'kind'>
          label="Sounds"
          value={perKind ? 'kind' : 'same'}
          onChange={setMode}
          options={[
            { value: 'same', label: 'Same for all' },
            { value: 'kind', label: 'Per kind' },
          ]}
        />
      </Row>
      {perKind ? (
        <div className={s.kinds} role="radiogroup" aria-label="Kind of notification">
          {SOUND_GROUPS.map((g) => {
            const choice = soundFor(n, g);
            const on = editing === g;
            return (
              <div key={g} className={cx(st.row, s.kind, on && s.kindOn)}>
                <button type="button" role="radio" aria-checked={on} className={s.kindPick} onClick={() => setTarget(g)}>
                  <span className={st.rowLabel}>{GROUP_LABELS[g]}</span>
                  <span className={s.kindSound}>{soundTitle(choice)}</span>
                </button>
                <PlayButton choice={choice} volume={volume} label={`${GROUP_LABELS[g]}: ${soundTitle(choice)}`} />
              </div>
            );
          })}
        </div>
      ) : (
        <Row label="Notification sound" detail={/* computer-wording: mac (System Settings only on a Mac) */ `Plays with each banner. ${keyPlatform() === 'mac' ? 'Focus and System Settings' : 'Do Not Disturb and Settings'} can still silence it.`}>
          <span className={s.current}>{soundTitle(value)}</span>
          <PlayButton choice={value} volume={volume} label={soundTitle(value)} />
        </Row>
      )}
      {test}
      <SoundPicker key={editing} value={value} volume={volume} made={n.madeSounds} onPick={pick} onKeep={keep} {...(editing === 'all' ? {} : { kindLabel: GROUP_LABELS[editing] })} />
      <Row label="Volume" detail="For Beluga’s own sounds (8-bit and generated). Mac sounds play at your alert volume.">
        <input
          className={st.slider}
          aria-label="Volume of Beluga’s sounds"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          onPointerUp={() => belugaMade(value) && void playSound(value, volume).catch(() => undefined)}
        />
      </Row>
    </Group>
  );
}
