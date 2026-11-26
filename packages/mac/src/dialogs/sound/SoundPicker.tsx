import { useState } from 'react';
import type { SoundChoice } from '../../../../../src/shared/notify-sound.js';
import { Icon } from '../../components/Icon.js';
import { Button, Segmented, cx } from '../../components/ui.js';
import { CHIP_CHOICES, FAMILY_LABELS, MAC_CHOICES, type SoundFamily, choiceKey, familiesHere, soundName } from '../../lib/sounds/catalog.js';
import { keyPlatform } from '../../lib/shortcuts-model.js';
import { generatedName, randomSeed } from '../../lib/sounds/generated.js';
import { playSound } from '../../lib/sounds/player.js';
import s from './sound.module.css';

const FAMILIES = familiesHere(keyPlatform() === 'mac');

const FAMILY_HINTS: Readonly<Record<SoundFamily, string>> = {
  chip: 'Short 8-bit sounds, made by Beluga',
  gen: 'Soft sounds generated just for you',
  // computer-wording: mac (this family is offered only on a Mac)
  mac: 'The sounds that come with your Mac',
  none: 'Notifications stay silent',
};

export interface PickerProps {
  /** The sound being chosen (for "Same for all", or one kind). */
  readonly value: SoundChoice;
  readonly volume: number;
  /** Generated sounds you kept. */
  readonly made: readonly number[];
  readonly onPick: (choice: SoundChoice) => void;
  /** Keep a generated sound (and pick it). */
  readonly onKeep: (seed: number) => void;
  /** Whose sound this is, when it's one kind's ("Claude needs you"). */
  readonly kindLabel?: string;
}

/** A play button for one sound. */
export function PlayButton({ choice, volume, label }: { choice: SoundChoice; volume: number; label: string }) {
  if (choice.kind === 'none') return null;
  return (
    <button type="button" className={s.play} aria-label={`Play ${label}`} title={`Play ${label}`} onClick={() => void playSound(choice, volume).catch(() => undefined)}>
      <Icon name="play" size={11} />
    </button>
  );
}

/** One sound to pick: its name (picks and plays it) and a ▶ (plays it only). */
function Tile({ choice, on, volume, onPick }: { choice: SoundChoice; on: boolean; volume: number; onPick: (c: SoundChoice) => void }) {
  const name = soundName(choice);
  const pick = (): void => {
    onPick(choice);
    void playSound(choice, volume).catch(() => undefined);
  };
  return (
    <div className={cx(s.tile, on && s.tileOn)}>
      <button type="button" role="radio" aria-checked={on} className={s.tileName} onClick={pick}>
        {on ? <Icon name="check" size={12} /> : null}
        <span>{name}</span>
      </button>
      <PlayButton choice={choice} volume={volume} label={name} />
    </div>
  );
}

/** Shuffle through generated sounds; keep the ones you like. */
function Generator({ volume, onKeep }: { volume: number; onKeep: (seed: number) => void }) {
  const [seed, setSeed] = useState(randomSeed);
  const candidate: SoundChoice = { kind: 'gen', seed };
  const shuffle = (): void => {
    const next = randomSeed();
    setSeed(next);
    void playSound({ kind: 'gen', seed: next }, volume).catch(() => undefined);
  };
  return (
    <div className={s.generator} role="group" aria-label="Make a new sound">
      <div className={s.genText}>
        <span className={s.genName} data-seed={seed}>
          {generatedName(seed)}
        </span>
        <span className={s.genSeed}>#{seed.toString(16).padStart(8, '0')}</span>
      </div>
      <PlayButton choice={candidate} volume={volume} label={generatedName(seed)} />
      <Button size="small" icon="refresh" onClick={shuffle}>
        Shuffle
      </Button>
      <Button size="small" variant="primary" onClick={() => onKeep(seed)}>
        Keep
      </Button>
    </div>
  );
}

/** Every sound you can choose, by where it comes from, each with a ▶ to hear it first. */
export function SoundPicker({ value, volume, made, onPick, onKeep, kindLabel }: PickerProps) {
  // A Mac sound off the Mac (the default) plays as Beluga's chime: opened on the 8-bit ones.
  const [family, setFamily] = useState<SoundFamily>(FAMILIES.includes(value.kind) ? value.kind : 'chip');
  const current = choiceKey(value);
  const tiles = (choices: readonly SoundChoice[]) => (
    <div className={s.tiles} role="radiogroup" aria-label={`${FAMILY_LABELS[family]} sounds`}>
      {choices.map((c) => (
        <Tile key={choiceKey(c)} choice={c} on={choiceKey(c) === current} volume={volume} onPick={onPick} />
      ))}
    </div>
  );
  const kept: SoundChoice[] = [...new Set([...(value.kind === 'gen' ? [value.seed] : []), ...made])].map((seed) => ({ kind: 'gen', seed }));
  return (
    <div className={s.picker}>
      {kindLabel ? <div className={s.pickerFor}>Sound for “{kindLabel}”</div> : null}
      <Segmented<SoundFamily> label="Kind of sound" value={family} onChange={setFamily} options={FAMILIES.map((f) => ({ value: f, label: FAMILY_LABELS[f], hint: FAMILY_HINTS[f] }))} />
      <p className={s.hint}>{FAMILY_HINTS[family]}</p>
      {family === 'chip' ? tiles(CHIP_CHOICES) : null}
      {family === 'mac' ? tiles(MAC_CHOICES) : null}
      {family === 'gen' ? (
        <>
          <Generator volume={volume} onKeep={onKeep} />
          {kept.length ? tiles(kept) : <p className={s.hint}>Shuffle until you hear one you like, then Keep it. Kept sounds are listed here.</p>}
        </>
      ) : null}
      {family === 'none' ? tiles([{ kind: 'none' }]) : null}
    </div>
  );
}
