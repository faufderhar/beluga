/**
 * How Max effort's fire looks (Settings › Max Fire): a preset sets everything; the sliders and
 * colours fine-tune it (and make it your own). Kept on this Mac, with the window's other prefs.
 */

export type FlameStyle = 'toon' | 'pixel';
/** When it burns: whenever the box is showing, only while you type, or never. */
export type FireShow = 'always' | 'typing' | 'off';
/** Where the effects are on: only on Max effort (so they say you're on Max), or with every model and effort. */
export type FireWhere = 'max' | 'everywhere';
/** What typing throws from the caret. */
export type TypingFx = 'off' | 'confetti' | 'pixels';

export interface FirePalette {
  readonly id: string;
  readonly name: string;
  /** Edge, middle, core. */
  readonly colors: readonly [string, string, string];
}

export interface FireLook {
  readonly where: FireWhere;
  readonly show: FireShow;
  readonly style: FlameStyle;
  /** 0–1 each. Fuel: how many flames; height: how tall they climb; thickness: how fat; wildness: how much they lick and dance. */
  readonly fuel: number;
  readonly height: number;
  readonly thickness: number;
  readonly wildness: number;
  /** A palette's id (one of PALETTES or of `palettes`, your own). */
  readonly palette: string;
  /** The box's own rim and glow in the fire's colours (off: the box keeps its usual look). */
  readonly border: boolean;
  /** Typing fast makes it flare orange, like Hades losing his temper. */
  readonly temper: boolean;
  /** What typing throws from the caret: nothing, confetti, or pixels. */
  readonly typing: TypingFx;
  /** What you delete pops into pixels. */
  readonly popDelete: boolean;
  /** Only while typing: how long you type before it catches, and how long after your last key it goes out (seconds; see TIMING). */
  readonly catchAfter: number;
  readonly outAfter: number;
  /** The preset it matches, or 'custom' once you've changed something. */
  readonly preset: string;
  /** Colours you made and named. */
  readonly palettes: readonly FirePalette[];
}

export const PALETTES: readonly FirePalette[] = [
  { id: 'blue', name: 'Blue', colors: ['#2346c8', '#3fa2ff', '#d4f6ff'] },
  { id: 'red', name: 'Red', colors: ['#8f1022', '#e0293b', '#ff9a8a'] },
  { id: 'rose', name: 'Rose', colors: ['#b8336a', '#f27aa6', '#ffe1ec'] },
  { id: 'ember', name: 'Ember', colors: ['#c2261a', '#ff7a1f', '#ffd84a'] },
  { id: 'gold', name: 'Gold', colors: ['#b45309', '#f5b82e', '#fff3c4'] },
  { id: 'venom', name: 'Venom', colors: ['#166534', '#3fd47a', '#e0fbe9'] },
  { id: 'violet', name: 'Violet', colors: ['#5b21b6', '#a78bfa', '#efe9ff'] },
];

/** What typing fast flares to. */
export const TEMPER: readonly [string, string, string] = ['#d8361c', '#ff8a1f', '#ffe35a'];

type Tuning = Pick<FireLook, 'style' | 'fuel' | 'height' | 'thickness' | 'wildness' | 'palette' | 'temper'>;

export const PRESETS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly blurb: string; readonly look: Tuning }> = [
  { id: 'hades', name: 'Hades', blurb: 'Blue, lively, flares when you rush', look: { style: 'toon', fuel: 0.55, height: 0.5, thickness: 0.5, wildness: 0.55, palette: 'blue', temper: true } },
  { id: 'candle', name: 'Candle', blurb: 'A few calm, gold tips', look: { style: 'toon', fuel: 0.2, height: 0.3, thickness: 0.3, wildness: 0.15, palette: 'gold', temper: false } },
  { id: 'bonfire', name: 'Bonfire', blurb: 'Tall, thick and wild', look: { style: 'toon', fuel: 0.9, height: 0.9, thickness: 0.75, wildness: 0.75, palette: 'ember', temper: false } },
  { id: 'rose', name: 'Rose Garden', blurb: 'Soft pink, gently swaying', look: { style: 'toon', fuel: 0.45, height: 0.45, thickness: 0.6, wildness: 0.3, palette: 'rose', temper: false } },
  { id: 'arcade', name: 'Arcade', blurb: 'Pixel fire, like an old game', look: { style: 'pixel', fuel: 0.6, height: 0.55, thickness: 0.55, wildness: 0.5, palette: 'red', temper: true } },
  { id: 'ghost', name: 'Ghost', blurb: 'Tall violet pixels, calm and eerie', look: { style: 'pixel', fuel: 0.6, height: 0.75, thickness: 0.5, wildness: 0.35, palette: 'violet', temper: false } },
];

/** Only while typing, how quickly it catches and goes out: the most and least each can be (seconds), and the step its slider moves in. */
export const TIMING = {
  catchAfter: { min: 0, max: 2, step: 0.1 },
  // Less than a gap between two keys and it would flicker as you type.
  outAfter: { min: 0.2, max: 3, step: 0.1 },
} as const;

export const DEFAULT_FIRE: FireLook = { where: 'max', show: 'always', ...PRESETS[0]!.look, typing: 'confetti', border: true, popDelete: true, catchAfter: 0.6, outAfter: 0.4, preset: 'hades', palettes: [] };

/** A palette by id: yours first, then the built-in ones (Blue if it's gone). */
export const paletteOf = (look: Pick<FireLook, 'palette' | 'palettes'>): FirePalette => look.palettes.find((p) => p.id === look.palette) ?? PALETTES.find((p) => p.id === look.palette) ?? PALETTES[0]!;

/** The preset these settings are exactly, if any. */
export function presetOf(look: FireLook): string {
  const same = PRESETS.find((p) => (Object.keys(p.look) as Array<keyof Tuning>).every((k) => look[k] === p.look[k]));
  return same?.id ?? 'custom';
}

/** Saved settings, made whole (older or partial ones get the defaults). */
export function fireLookOf(saved: unknown): FireLook {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<FireLook>;
  const unit = (v: unknown, d: number): number => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
  const time = (key: keyof typeof TIMING): number => {
    const v = s[key];
    return typeof v === 'number' && v >= TIMING[key].min && v <= TIMING[key].max ? v : DEFAULT_FIRE[key];
  };
  return {
    where: s.where === 'everywhere' ? 'everywhere' : 'max',
    show: s.show === 'typing' || s.show === 'off' ? s.show : 'always',
    style: s.style === 'pixel' ? 'pixel' : 'toon',
    fuel: unit(s.fuel, DEFAULT_FIRE.fuel),
    height: unit(s.height, DEFAULT_FIRE.height),
    thickness: unit(s.thickness, DEFAULT_FIRE.thickness),
    wildness: unit(s.wildness, DEFAULT_FIRE.wildness),
    palette: typeof s.palette === 'string' ? s.palette : DEFAULT_FIRE.palette,
    border: typeof s.border === 'boolean' ? s.border : DEFAULT_FIRE.border,
    temper: typeof s.temper === 'boolean' ? s.temper : DEFAULT_FIRE.temper,
    // (Before there were pixels, typing's confetti was a switch.)
    typing: s.typing === 'off' || s.typing === 'confetti' || s.typing === 'pixels' ? s.typing : (s as { confetti?: unknown }).confetti === false ? 'off' : DEFAULT_FIRE.typing,
    popDelete: typeof s.popDelete === 'boolean' ? s.popDelete : DEFAULT_FIRE.popDelete,
    catchAfter: time('catchAfter'),
    outAfter: time('outAfter'),
    preset: typeof s.preset === 'string' ? s.preset : DEFAULT_FIRE.preset,
    palettes: Array.isArray(s.palettes) ? s.palettes.filter((p): p is FirePalette => Boolean(p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.colors) && p.colors.length === 3)) : [],
  };
}

/** How far the fire can reach above the box (CSS px), so it's never cut off. */
export const reachOf = (look: Pick<FireLook, 'height' | 'thickness'>): number => Math.round(48 + look.height * 120 + look.thickness * 24);

/** The look's colours as CSS variables (the rim, the send button and the Max tag use them). */
export const fireVars = (look: Pick<FireLook, 'palette' | 'palettes'>): Record<string, string> => {
  const [f0, f1, f2] = paletteOf(look).colors;
  return { '--f0': f0, '--f1': f1, '--f2': f2 };
};

/** One tap for what's on: the fire, what typing throws, deleting's pops (the look itself stays). */
export const SETUPS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly blurb: string; readonly set: Pick<FireLook, 'show' | 'typing' | 'popDelete'> }> = [
  { id: 'full', name: 'Full Fire', blurb: 'Flames, confetti and pops', set: { show: 'always', typing: 'confetti', popDelete: true } },
  { id: 'pixels', name: 'Just Pixels', blurb: 'No flames: pixels as you type and delete', set: { show: 'off', typing: 'pixels', popDelete: true } },
  { id: 'pops', name: 'Pops Only', blurb: 'Only what you delete pops', set: { show: 'off', typing: 'off', popDelete: true } },
  { id: 'off', name: 'Off', blurb: 'Nothing at all', set: { show: 'off', typing: 'off', popDelete: false } },
];

export const setupOf = (look: FireLook): string | undefined => SETUPS.find((x) => x.set.show === look.show && x.set.typing === look.typing && x.set.popDelete === look.popDelete)?.id;

/** Anything to show at all. */
export const anyEffect = (look: FireLook): boolean => look.show !== 'off' || look.typing !== 'off' || look.popDelete;

/** The effects are on here: on Max effort, or everywhere if you said so. */
export const effectsOn = (look: FireLook, effort: string | undefined): boolean => anyEffect(look) && (look.where === 'everywhere' || effort === 'max');

const tuningOf = (id: string): Tuning => PRESETS.find((p) => p.id === id)!.look;

/**
 * The welcome's three (onboarding › Fire): the two kinds of fire side by side, pixel and flame, and
 * none at all. Both fires burn from the start (never only while typing), so the step shows them
 * before anyone types. Flame is the app's default look. None keeps the look for later.
 */
export const STARTERS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly blurb: string; readonly set: Partial<FireLook> }> = [
  { id: 'pixel', name: 'Pixel', blurb: 'Blocky red fire, like an old arcade game. Pixels fly as you type.', set: { ...tuningOf('arcade'), preset: 'arcade', show: 'always', typing: 'pixels', popDelete: true, border: true } },
  { id: 'flame', name: 'Flame', blurb: 'Smooth blue flames that flare when you type fast. Confetti flies as you type.', set: { ...tuningOf('hades'), preset: 'hades', show: 'always', typing: 'confetti', popDelete: true, border: true } },
  { id: 'none', name: 'None', blurb: 'A plain box with no fire.', set: { show: 'off', typing: 'off', popDelete: false } },
];

/** Which of the welcome's three these settings are, if any. */
export const starterOf = (look: FireLook): string | undefined => STARTERS.find((x) => (Object.keys(x.set) as Array<keyof FireLook>).every((k) => look[k] === x.set[k]))?.id;
