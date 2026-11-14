import { looksLikeColor } from '../view-spec.js';
import { type ChatRef, parseChatRef } from '../chat-ref.js';
import { isTaskKey } from '../task-refs.js';

/**
 * Small elements inside a sentence (docs/views.md › Inline): what an inline code span stands for.
 * A color value on its own is the color; `badge:…`, `kbd:…`, `progress:…`, `delta:…`, `spark:…`,
 * `time:…`, `colors:…`, `task:…`, `worktree:…`, `plan:…`, `sentinel:…`, `call:…` and `chat:…` are the rest. Anything that doesn't read as one stays code. Pure
 * (tested in tests/mac-views.test.ts).
 */

export type InlineElement =
  | { readonly kind: 'color'; readonly value: string }
  | { readonly kind: 'colors'; readonly values: readonly string[] }
  | { readonly kind: 'badge'; readonly text: string }
  | { readonly kind: 'kbd'; readonly keys: readonly string[] }
  | { readonly kind: 'progress'; readonly ratio: number; readonly label: string }
  | { readonly kind: 'delta'; readonly text: string; readonly dir: 1 | -1 | 0; readonly good: boolean | undefined }
  | { readonly kind: 'spark'; readonly values: readonly number[] }
  | { readonly kind: 'time'; readonly at: number; readonly dateOnly: boolean }
  /** A board task by its key ("BLG-12"): the window reads the rest from the board. */
  | { readonly kind: 'task'; readonly key: string }
  /** A worktree or a plan by its id (what Your Mac started: core/assistant): a link to it on both screens. */
  | { readonly kind: 'worktree'; readonly id: string }
  | { readonly kind: 'plan'; readonly id: string }
  /** A sentinel by its id ("sn_…", docs/sentinel.md): Claude links one it set up; a click opens its page. */
  | { readonly kind: 'sentinel'; readonly id: string }
  /** A call's notes by the call's id (BLG-715): a chip that opens them beside their chat. */
  | { readonly kind: 'call'; readonly id: string }
  /** A chat by its address (shared/chat-ref.ts): a chip with its current title that opens it. */
  | { readonly kind: 'chat'; readonly ref: ChatRef };

/** A worktree's or a plan's id, as Beluga makes them ("wt-1a2b3c4d-5e6", "pl_0123456789ab"). */
const REF_ID = /^[\w-]{3,80}$/;

const PREFIX = /^(color|colors|palette|badge|status|kbd|key|keys|progress|delta|change|spark|sparkline|time|date|task|worktree|plan|sentinel|call|chat):\s*(.+)$/is;

export function readInline(raw: string): InlineElement | undefined {
  const text = raw.trim();
  if (!text || text.length > 400) return undefined;
  if (looksLikeColor(text)) return { kind: 'color', value: text };
  const m = PREFIX.exec(text);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase();
  const value = m[2]!.trim();
  switch (kind) {
    case 'color':
      return looksLikeColor(value) ? { kind: 'color', value } : undefined;
    case 'colors':
    case 'palette': {
      const values = value.split(/[\s,]+(?![^(]*\))/).map((v) => v.trim()).filter(Boolean);
      return values.length && values.length <= 24 && values.every(looksLikeColor) ? { kind: 'colors', values } : undefined;
    }
    case 'badge':
    case 'status':
      return value.length <= 40 ? { kind: 'badge', text: value } : undefined;
    case 'kbd':
    case 'key':
    case 'keys': {
      // "⌘K", "cmd+shift+p", "Ctrl C": one key cap each.
      const keys = value.includes('+') ? value.split('+') : /\s/.test(value) ? value.split(/\s+/) : /^[⌘⌥⇧⌃]+./.test(value) ? [...value.match(/[⌘⌥⇧⌃]|[^⌘⌥⇧⌃]+/g)!] : [value];
      return { kind: 'kbd', keys: keys.map((k) => KEY_NAMES[k.trim().toLowerCase()] ?? k.trim()).filter(Boolean) };
    }
    case 'progress': {
      const pm = /^(\d+(?:\.\d+)?)\s*(%|\/\s*(\d+(?:\.\d+)?))?$/.exec(value);
      if (!pm) return undefined;
      const n = Number(pm[1]);
      const ratio = pm[2] === '%' ? n / 100 : pm[3] ? n / Number(pm[3]) : n <= 1 ? n : n / 100;
      if (!Number.isFinite(ratio)) return undefined;
      const clamped = Math.max(0, Math.min(1, ratio));
      return { kind: 'progress', ratio: clamped, label: pm[3] ? `${pm[1]}/${pm[3]}` : `${Math.round(clamped * 100)}%` };
    }
    case 'delta':
    case 'change': {
      // "+12%", "-3 ms", "-0.4s good" / "+38ms bad": a word says which way is good.
      const dm = /^([+-−]?\s*\d[\d.,]*\s*[%\w]*)\s*(good|bad)?$/i.exec(value);
      if (!dm) return undefined;
      const t = dm[1]!.replace('−', '-').replace(/\s+/g, '');
      const dir = t.startsWith('-') ? -1 : /^\+?0*(\.0*)?\D*$/.test(t) ? 0 : 1;
      const said = dm[2]?.toLowerCase();
      return { kind: 'delta', text: dir > 0 && !t.startsWith('+') ? `+${t}` : t, dir, good: said ? said === 'good' : dir === 0 ? undefined : dir > 0 };
    }
    case 'spark':
    case 'sparkline': {
      const values = value.split(/[\s,]+/).map(Number);
      return values.length >= 2 && values.length <= 200 && values.every(Number.isFinite) ? { kind: 'spark', values } : undefined;
    }
    case 'time':
    case 'date': {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
      const at = /^\d{10,13}$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : new Date(dateOnly ? `${value}T00:00:00` : value).getTime();
      return Number.isFinite(at) ? { kind: 'time', at, dateOnly } : undefined;
    }
    case 'task':
      return isTaskKey(value) ? { kind: 'task', key: value.toUpperCase() } : undefined;
    case 'worktree':
    case 'plan':
    case 'sentinel':
      return REF_ID.test(value) ? { kind, id: value } : undefined;
    case 'call':
      return /^[0-9a-f]{16}$/.test(value) ? { kind: 'call', id: value } : undefined;
    case 'chat': {
      const ref = parseChatRef(value);
      return ref ? { kind: 'chat', ref } : undefined;
    }
  }
  return undefined;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  cmd: '⌘',
  command: '⌘',
  opt: '⌥',
  option: '⌥',
  alt: '⌥',
  shift: '⇧',
  ctrl: '⌃',
  control: '⌃',
  enter: '↩',
  return: '↩',
  esc: 'esc',
  escape: 'esc',
  tab: '⇥',
  delete: '⌫',
  backspace: '⌫',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'space',
};

/** "in 3 hours", "2 days ago": how far a time is from now. */
export function relative(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 2700) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 64_800) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 2_160_000) return rtf.format(Math.round(s / 86_400), 'day');
  if (abs < 26_000_000) return rtf.format(Math.round(s / 604_800), 'week');
  return rtf.format(Math.round(s / 2_629_800), 'month');
}
