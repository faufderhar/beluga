import { YOUR_COMPUTER } from './assistant.js';
/**
 * Speaking instead of typing (the phone's Ask sheet, BLG-139): which models write down speech,
 * where they run (on the phone through whisper.rn, on the Mac through whisper.node on its GPU), the
 * presets Settings › Voice offers, and the one Beluga suggests. Data only: the Mac's daemon and the
 * phone app both import it. No imports, runs anywhere.
 */

export type VoiceWhere = 'phone' | 'mac';
export const VOICE_MODEL_IDS = ['whisper-base', 'whisper-turbo', 'parakeet'] as const;
export type VoiceModelId = (typeof VOICE_MODEL_IDS)[number];

export interface VoiceFile {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
}

export interface VoiceModel {
  readonly id: VoiceModelId;
  readonly label: string;
  /** Whisper or Parakeet: they take different options and load differently. */
  readonly kind: 'whisper' | 'parakeet';
  /** The languages it knows ('all': Whisper's ~100, and it tells which one you speak). */
  readonly languages: 'all' | readonly string[];
  /** The file for each place it runs (the Mac takes a larger, more exact one). */
  readonly files: Readonly<Partial<Record<VoiceWhere, VoiceFile>>>;
}

const HF = 'https://huggingface.co';
/** Parakeet TDT 0.6B v3: English and 24 European languages (no Turkish, no Asian languages). */
export const PARAKEET_LANGUAGES = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'] as const;

export const VOICE_MODELS: Readonly<Record<VoiceModelId, VoiceModel>> = {
  'whisper-base': {
    id: 'whisper-base',
    label: 'Whisper Base',
    kind: 'whisper',
    languages: 'all',
    files: { phone: { name: 'ggml-base-q5_1.bin', url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin`, bytes: 59_707_625 } },
  },
  'whisper-turbo': {
    id: 'whisper-turbo',
    label: 'Whisper Turbo',
    kind: 'whisper',
    languages: 'all',
    files: {
      phone: { name: 'ggml-large-v3-turbo-q5_0.bin', url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`, bytes: 574_041_195 },
      mac: { name: 'ggml-large-v3-turbo-q8_0.bin', url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin`, bytes: 874_188_075 },
    },
  },
  parakeet: {
    id: 'parakeet',
    label: 'Parakeet',
    kind: 'parakeet',
    languages: PARAKEET_LANGUAGES,
    files: {
      phone: { name: 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin', url: `${HF}/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_0.bin`, bytes: 355_615_679 },
      mac: { name: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin', url: `${HF}/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`, bytes: 668_757_119 },
    },
  },
};

/** A size in words: "57 MB", "1.2 GB" (MiB, as phones show them). */
export function voiceSize(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The languages Settings offers ('auto': the model tells). Whisper knows many more. */
export const VOICE_LANGUAGES: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
  { code: 'auto', label: 'Any (it tells)' },
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];

/** The model knows this language ('auto' always: Parakeet then guesses among its own). */
export function voiceKnows(model: VoiceModelId, language: string): boolean {
  const l = VOICE_MODELS[model].languages;
  return l === 'all' || language === 'auto' || l.includes(language);
}

export interface VoiceChoice {
  readonly where: VoiceWhere;
  readonly model: VoiceModelId;
  /** A language code, or 'auto'. */
  readonly language: string;
}

export const VOICE_PRESET_IDS = ['quick', 'best-phone', 'mac', 'mac-fast'] as const;
export type VoicePresetId = (typeof VOICE_PRESET_IDS)[number];

export interface VoicePreset {
  readonly id: VoicePresetId;
  readonly label: string;
  readonly where: VoiceWhere;
  readonly model: VoiceModelId;
  /** One line: what it costs and what it's good at. */
  readonly sub: string;
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: 'quick', label: 'Quick, on this phone', where: 'phone', model: 'whisper-base', sub: `Whisper Base · ${voiceSize(VOICE_MODELS['whisper-base'].files.phone!.bytes)}` },
  { id: 'best-phone', label: 'Best, on this phone', where: 'phone', model: 'whisper-turbo', sub: `Whisper Turbo · ${voiceSize(VOICE_MODELS['whisper-turbo'].files.phone!.bytes)}` },
  { id: 'mac', label: `Best, on ${YOUR_COMPUTER}`, where: 'mac', model: 'whisper-turbo', sub: 'Whisper Turbo' },
  { id: 'mac-fast', label: `Fastest, on ${YOUR_COMPUTER}`, where: 'mac', model: 'parakeet', sub: 'Parakeet · no Turkish' },
];

/** What Beluga knows when it suggests a preset. */
export interface VoiceSituation {
  /** The Mac can write down speech (it has SINCE.voice). */
  readonly macVoice: boolean;
  /** The phone's memory, in GB (unknown: undefined). */
  readonly phoneGB?: number | undefined;
  /** The language you speak ('auto': not said). */
  readonly language: string;
}

/** Phones with this much memory run Whisper Turbo comfortably (it holds about 1 GB while it writes). */
export const TURBO_PHONE_GB = 8;

/**
 * The suggestion: the Mac when it can (its GPU does the most exact model in a moment, and the
 * phone downloads nothing), Parakeet there when you speak English (as exact, and faster); without
 * the Mac, Whisper Turbo on a phone with memory to spare, Whisper Base on others. Parakeet is never
 * suggested for a language it doesn't know, nor for 'auto' (it might be Turkish).
 */
export function suggestVoice(s: VoiceSituation): VoicePresetId {
  if (s.macVoice) return s.language === 'en' ? 'mac-fast' : 'mac';
  return (s.phoneGB ?? 0) >= TURBO_PHONE_GB ? 'best-phone' : 'quick';
}

/** What you set: follow the suggestion, a preset, or your own where/model/language. */
export type VoiceSetting = { readonly preset: 'suggested' | VoicePresetId; readonly language: string } | { readonly preset: 'custom'; readonly where: VoiceWhere; readonly model: VoiceModelId; readonly language: string };
export const DEFAULT_VOICE: VoiceSetting = { preset: 'suggested', language: 'auto' };

/** What the setting means now; a model that doesn't run there, or doesn't know the language, falls back to Whisper. */
export function resolveVoice(set: VoiceSetting, s: Omit<VoiceSituation, 'language'>): VoiceChoice {
  const language = set.language || 'auto';
  const pick = set.preset === 'custom' ? set : VOICE_PRESETS.find((p) => p.id === (set.preset === 'suggested' ? suggestVoice({ ...s, language }) : set.preset))!;
  const where = pick.where;
  let model = pick.model;
  if (!VOICE_MODELS[model].files[where]) model = 'whisper-turbo';
  if (!voiceKnows(model, language)) model = where === 'mac' ? 'whisper-turbo' : 'whisper-base';
  return { where, model, language };
}

/** Coerce what was stored (an older or broken value) to a setting. */
export function coerceVoice(v: unknown): VoiceSetting {
  if (!v || typeof v !== 'object') return DEFAULT_VOICE;
  const o = v as Record<string, unknown>;
  const language = typeof o.language === 'string' && /^(auto|[a-z]{2,3})$/.test(o.language) ? o.language : 'auto';
  if (o.preset === 'custom' && (o.where === 'phone' || o.where === 'mac') && VOICE_MODEL_IDS.includes(o.model as VoiceModelId)) return { preset: 'custom', where: o.where, model: o.model as VoiceModelId, language };
  if (o.preset === 'suggested' || VOICE_PRESET_IDS.includes(o.preset as VoicePresetId)) return { preset: o.preset as 'suggested' | VoicePresetId, language };
  return { ...DEFAULT_VOICE, language };
}
