import { useSyncExternalStore } from 'react';
import { onPowerSaving, powerSaving } from './power.js';
import { DEFAULT_FIRE, type FireLook, fireLookOf } from '../chat/fire-look.js';
import { DEFAULT_MENU_BAR, type MenuBarLook, menuBarLookOf } from '../menubar/menubar-look.js';
import { type TermKeysPref, type TermThemePref, termKeysOf, themeOf } from './terminal-import-model.js';
import { type ConvoMode, clampBoth, isConvoMode } from './convo-mode.js';
import { type ShortcutOverrides, keyPlatform, overridesOf } from './shortcuts-model.js';
import { type ThemeBase, allThemesCss, isSolid, themeFor, themeIdOf, themePatch } from './themes.js';
import { DEFAULT_LAYOUT, DRAWER_DEFAULT, PANEL_DEFAULT, PANES_DEFAULT, type PanelLayout, type PanelTab, SPLIT_DEFAULT, type TerminalPlace, migratePrefs, normalizeLayout } from './panel-model.js';
import type { DuringTurnAction } from '../chat/send-action.js';
import { type RowColors, rowColorsOf } from './row-colors.js';

/**
 * How this window looks and behaves: kept on this Mac only (Beluga's shared settings, like the
 * model or notifications, live in the core and apply to every screen).
 */
export interface UiPrefs {
  readonly appearance: 'system' | 'light' | 'dark';
  /** The theme for light and the one for dark (lib/themes.ts): Match the System switches between them. */
  readonly lightTheme: string;
  readonly darkTheme: string;
  readonly accent: Accent;
  /** Text size: 12–16 px for body text. */
  readonly textSize: number;
  readonly density: 'compact' | 'comfortable';
  /** How wide the conversation can get (characters, roughly). */
  readonly chatWidth: 'narrow' | 'wide' | 'full';
  /** You picked chatWidth in Settings (before, Wide was saved as the default without you choosing it: BLG-697). */
  readonly chatWidthPicked: boolean;
  /** The right panel (Changes, Files, Terminal, Info) is showing. */
  readonly inspector: boolean;
  /** How wide the right panel is (px; never more than 60% of the window). */
  readonly panelWidth: number;
  /** The tab you last picked in the panel, per workspace ('ws:<id>') and for everything else ('app'); the bottom pane's end in '|bottom'. */
  readonly panelTabs: Readonly<Record<string, PanelTab>>;
  /** Which tabs are in the panel's top pane and which in its bottom one (drag a tab across to change it). */
  readonly panelLayout: PanelLayout;
  /** How much of the panel's height the top pane takes (0.18–0.75). */
  readonly paneSplit: number;
  /** The bottom pane is open (closed, it's just its tabs along the bottom). */
  readonly bottomOpen: boolean;
  /** In the Changes and Files tabs: how much of the height the list keeps above a diff or a preview (0.18–0.75). */
  readonly panelSplit: number;
  readonly sidebar: boolean;
  readonly sidebarWidth: number;
  /** Sidebar sections you've folded. */
  readonly folded: readonly string[];
  /** Your folds from before Sidebar categories went on: turning it off gives them back. */
  readonly foldedBeforeCategories: readonly string[];
  /** Projects you unfolded in the sidebar (by id): the rest start folded. */
  readonly openProjects: readonly string[];
  /** The sidebar's Unread section: conversations that finished or need you, at the top (only while there are some). */
  readonly unreadSection: boolean;
  /** Enter sends and Shift+Enter makes a new line, or the other way round with ⌘Enter. */
  readonly sendWith: 'enter' | 'cmd-enter';
  /** The main send action during a running turn. */
  readonly sendDuringTurn: DuringTurnAction;
  readonly timestamps: boolean;
  /** A finished answer's steps: folded away once Claude answers (one click shows them), or left showing. */
  readonly doneSteps: 'fold' | 'show';
  readonly reduceMotion: boolean;
  /** A solid window: no macOS blur behind the sidebar (lighter on slower Macs, BLG-409). macOS's own Reduce transparency does this too. */
  readonly reduceTransparency: boolean;
  /** Where ⌘J (and Run) show the terminal: the drawer under the chat, or the right panel's Terminal tab. */
  readonly termIn: TerminalPlace;
  /** The terminal drawer under the chat is open. */
  readonly drawer: boolean;
  /** How much of the window's height the drawer takes (0.18–0.75). */
  readonly drawerSize: number;
  /** The terminal's font family ('' : the system's monospace, SF Mono). */
  readonly termFont: string;
  readonly termFontSize: number;
  readonly termLineHeight: number;
  readonly termCursor: 'block' | 'bar' | 'underline';
  readonly termCursorBlink: boolean;
  /** Lines each terminal keeps to scroll back through. */
  readonly termScrollback: number;
  /** Colours brought from another terminal (Settings › Terminal › Import from…); null: Beluga's own. */
  readonly termTheme: TermThemePref | null;
  /** Option sends Meta (Esc+) in the terminal, instead of typing special characters. */
  readonly termOptionMeta: boolean;
  /** Keys brought from another terminal (Settings › Terminal › Import from…), over Beluga's terminal keys (BLG-537). */
  readonly termKeys: TermKeysPref | null;
  /** In the terminal view, the terminal's keys win over Beluga's shortcuts (⌘T, ⌘W, ⌘1…). */
  readonly termKeysFirst: boolean;
  /**
   * The terminal view is on (BLG-534): conversations can show as Claude Code's own terminal app, and
   * their header has Chat · Terminal · Both. Off (as for most people): every conversation is the chat.
   */
  readonly termView: boolean;
  /** How each conversation shows (BLG-534): the chat, the agent's own terminal, or both side by side (workspace id → mode). */
  readonly convoModes: Readonly<Record<string, ConvoMode>>;
  /** How a conversation you haven't switched opens: the terminal, until you pick otherwise (you turned the terminal view on for it). */
  readonly convoDefault: ConvoMode;
  /** You picked convoDefault in Settings (before, it was saved as the chat without you choosing it: BLG-553). */
  readonly convoDefaultPicked: boolean;
  /** In Both, the chat's share of the width beside the terminal (0.25–0.6). */
  readonly bothChat: number;
  /** The panel of visuals beside the terminal, in pixels. */
  readonly visualsWidth: number;
  /** A file open full size wraps its long lines (instead of scrolling sideways). */
  readonly readerWrap: boolean;
  /** Chats open as tabs above the conversation (`dm:<peerId>` / `group:<id>`; the main channel is always first). */
  readonly chatTabs: readonly string[];
  /** A changed file shows its diff, or the file as itself (Markdown formatted). Pictures and PDFs always as themselves. */
  readonly changeLook: 'diff' | 'file';
  /** The Changes tab lists its files under their folders (BLG-739), not as one list. */
  readonly changesByFolder: boolean;
  /** The panel has a Scratch tab: the workspace's .beluga/scratch/ folder, live. */
  readonly scratchTab: boolean;
  /** Your phone shows its live screen (BLG-196). Off: Claude still uses the phone, you just don't watch. */
  readonly phoneScreen: boolean;
  /** How Scratch lists its files: newest first, or pictures, videos, PDFs and web pages first (BLG-111). */
  readonly scratchSort: 'newest' | 'viewable';
  /** The icon you picked for each sidebar group (by name; unset: a folder). */
  readonly groupIcons: Readonly<Record<string, string>>;
  /** Colours you gave projects, chats and worktrees in the sidebar (lib/row-colors.ts; none: everything plain). */
  readonly rowColors: RowColors;
  /** Plans (by id) whose task chats you asked to see in the sidebar under them (a plan is one row otherwise). */
  readonly planTaskChats: readonly string[];
  /** How the message box burns on Max effort (Settings › Max Fire). */
  readonly maxFire: FireLook;
  /** The menu-bar whale: what its number counts and when it spouts (Settings › Menu Bar). */
  readonly menuBar: MenuBarLook;
  /** Settings › Voice (BLG-146): the model that writes down what you say ('suggested': Beluga picks for the language). */
  readonly voiceModel: 'suggested' | 'whisper-turbo' | 'parakeet';
  /** The language you speak ('auto': the model tells). */
  readonly voiceLanguage: string;
  /** The talk shortcut, as an accelerator ('Alt+Space'; '' : none). */
  readonly voiceShortcut: string;
  /** Written down, it's sent at once (⌘↩ always sends; otherwise it waits in the box to read over). */
  readonly voiceSend: boolean;
  /** The shortcut works from any app: Beluga comes forward and listens. */
  readonly voiceAnyApp: boolean;
  /** The microphone dictation listens to (a device id; '' : the one macOS uses). Calls pick their own. */
  readonly voiceMic: string;
  /** Settings › Keyboard (BLG-289): the shortcuts you gave other keys (the rest keep theirs). */
  readonly shortcuts: ShortcutOverrides;
}

export const ACCENTS = {
  system: 'AccentColor',
  /** The theme's own (lib/themes.ts), or the system's for a theme without one. */
  theme: 'var(--theme-accent, AccentColor)',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  rose: '#e11d48',
  amber: '#d97706',
  emerald: '#059669',
  teal: '#0d9488',
  graphite: '#6b7280',
} as const;
export type Accent = keyof typeof ACCENTS;

/** macOS's own default accent, for a web view that can't draw the system's (AccentColor). */
const ACCENT_FALLBACK = '#007aff';

/**
 * The CSS for an accent. `systemColor`: the web view draws CSS's AccentColor (WebKit does;
 * Chromium, as in WebView2 on Windows, does not, and `var(--accent)` would then be nothing).
 */
export function accentCss(accent: Accent, systemColor: boolean): string {
  const css: string = ACCENTS[accent];
  return systemColor ? css : css.replace('AccentColor', ACCENT_FALLBACK);
}

export const DEFAULT_PREFS: UiPrefs = {
  appearance: 'system',
  lightTheme: 'light',
  darkTheme: 'dark',
  accent: 'system',
  textSize: 13,
  density: 'comfortable',
  chatWidth: 'full',
  chatWidthPicked: false,
  inspector: true,
  panelWidth: PANEL_DEFAULT,
  panelTabs: {},
  panelLayout: DEFAULT_LAYOUT,
  paneSplit: PANES_DEFAULT,
  bottomOpen: true,
  panelSplit: SPLIT_DEFAULT,
  sidebar: true,
  sidebarWidth: 248,
  folded: [],
  foldedBeforeCategories: [],
  openProjects: [],
  unreadSection: true,
  sendWith: 'enter',
  sendDuringTurn: 'queue',
  timestamps: true,
  doneSteps: 'fold',
  reduceMotion: false,
  reduceTransparency: false,
  termIn: 'panel',
  drawer: false,
  drawerSize: DRAWER_DEFAULT,
  termFont: '',
  termFontSize: 12.5,
  termLineHeight: 1.18,
  termCursor: 'block',
  termCursorBlink: true,
  termScrollback: 5000,
  termTheme: null,
  termOptionMeta: true,
  termKeys: null,
  termKeysFirst: true,
  termView: false,
  convoModes: {},
  convoDefault: 'terminal',
  convoDefaultPicked: false,
  bothChat: 0.38,
  visualsWidth: 520,
  readerWrap: false,
  chatTabs: [],
  changeLook: 'diff',
  changesByFolder: false,
  scratchTab: true,
  phoneScreen: false,
  scratchSort: 'newest',
  groupIcons: {},
  rowColors: {},
  planTaskChats: [],
  maxFire: DEFAULT_FIRE,
  menuBar: DEFAULT_MENU_BAR,
  voiceModel: 'suggested',
  voiceLanguage: 'auto',
  voiceShortcut: 'Alt+Space',
  voiceSend: false,
  voiceAnyApp: false,
  voiceMic: '',
  shortcuts: {},
};

const KEY = 'beluga.prefs.v1';
const listeners = new Set<() => void>();

/** The width you chose; a Narrow is always a choice, a Wide only once picked (it used to be the default). */
export function chatWidthOf(saved: UiPrefs): UiPrefs['chatWidth'] {
  const w = saved.chatWidth;
  if (w === 'narrow' || w === 'full') return w;
  return w === 'wide' && saved.chatWidthPicked === true ? 'wide' : 'full';
}

function load(): UiPrefs {
  try {
    // Older versions docked the terminal beside or under the chat: see migratePrefs.
    const saved = { ...DEFAULT_PREFS, ...(migratePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>) as Partial<UiPrefs>) };
    return { ...saved, sendDuringTurn: saved.sendDuringTurn === 'steer' ? 'steer' : 'queue', panelLayout: normalizeLayout(saved.panelLayout), maxFire: fireLookOf(saved.maxFire), menuBar: menuBarLookOf(saved.menuBar), termTheme: themeOf(saved.termTheme), shortcuts: overridesOf(saved.shortcuts), convoModes: saved.convoModes && typeof saved.convoModes === 'object' ? saved.convoModes : {}, chatWidth: chatWidthOf(saved), convoDefault: saved.convoDefaultPicked === true && isConvoMode(saved.convoDefault) ? saved.convoDefault : 'terminal', bothChat: clampBoth(saved.bothChat), termKeys: termKeysOf(saved.termKeys), termKeysFirst: saved.termKeysFirst !== false, termView: saved.termView === true, lightTheme: themeIdOf(saved.lightTheme, 'light'), darkTheme: themeIdOf(saved.darkTheme, 'dark'), accent: saved.accent in ACCENTS ? saved.accent : 'system', rowColors: rowColorsOf(saved.rowColors) };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current = load();

/**
 * Low Power mode is saving now (the daemon says, BLG-621): motion and the window's blur are off
 * whatever's chosen. `getPrefs` gives what's in effect; Settings shows what you chose.
 */
const inEffect = (p: UiPrefs): UiPrefs => (powerSaving() ? { ...p, reduceMotion: true, reduceTransparency: true } : p);
let shown = inEffect(current);

export const getPrefs = (): UiPrefs => shown;
/** The choices as made, before Low Power mode (for Settings' own switches). */
export const getChosenPrefs = (): UiPrefs => current;

onPowerSaving(() => {
  shown = inEffect(current);
  apply(shown);
  for (const l of [...listeners]) l();
});

export function setPrefs(patch: Partial<UiPrefs>): void {
  current = { ...current, ...patch };
  shown = inEffect(current);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage full or unavailable: the change still applies until the app quits
  }
  apply(shown);
  for (const l of [...listeners]) l();
}

/** Hear about every change to the preferences (returns the way to stop). */
export function subscribePrefs(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function usePrefs(): UiPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}

export function useChosenPrefs(): UiPrefs {
  return useSyncExternalStore(subscribePrefs, getChosenPrefs);
}

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Light or dark, as the window shows it now. */
export const baseNow = (p: UiPrefs = shown): ThemeBase => (p.appearance === 'system' ? (dark() ? 'dark' : 'light') : p.appearance);

/** Pick a theme (Settings › Appearance, the palette): it shows at once, with its own accent if you had the system's. */
export function pickTheme(id: string): void {
  setPrefs(themePatch(id, current, baseNow(current)));
}

/** The themes' CSS, put on the page once (lib/themes.ts makes it from the same table Settings previews). */
function themeSheet(): void {
  if (document.getElementById('beluga-themes')) return;
  const style = document.createElement('style');
  style.id = 'beluga-themes';
  style.textContent = allThemesCss();
  document.head.append(style);
}

/** The window's blur, on or off, told to the app once per change (nothing outside the app). */
let vibrancyOn: boolean | undefined;
function vibrancy(on: boolean): void {
  if (vibrancyOn === on || !('__TAURI_INTERNALS__' in globalThis)) return;
  vibrancyOn = on;
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_vibrancy', { on })).catch(() => undefined);
}

/** Put the preferences on the document (CSS variables and data attributes do the rest). */
export function apply(p: UiPrefs = shown): void {
  const root = document.documentElement;
  const base = baseNow(p);
  const theme = themeFor(base, p);
  themeSheet();
  root.dataset.theme = base;
  root.dataset.palette = theme.id;
  root.dataset.edges = theme.lit ? 'lit' : 'soft';
  root.dataset.density = p.density;
  root.dataset.motion = p.reduceMotion ? 'reduce' : 'full';
  // Only a Mac's window blurs what's behind it: Linux and Windows get the solid look. A theme's own
  // sidebar is opaque (its colours, true black on OLED), so the blur under it would only cost.
  const blur = !p.reduceTransparency && keyPlatform() === 'mac' && !isSolid(theme);
  root.dataset.os = keyPlatform();
  root.dataset.transparency = blur ? 'full' : 'reduce';
  vibrancy(blur);
  root.style.setProperty('--accent', accentCss(p.accent, CSS.supports('color', 'AccentColor')));
  root.style.setProperty('--text-size', `${p.textSize}px`);
  root.style.setProperty('--sidebar-w', `${p.sidebarWidth}px`);
  root.style.setProperty('--panel-w', `${p.panelWidth}px`);
  root.style.setProperty('--chat-max', p.chatWidth === 'narrow' ? '42rem' : p.chatWidth === 'wide' ? '60rem' : '100%');
}

// (Not in tests, which load the pure parts of what imports this without a window.)
if (typeof window !== 'undefined') window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply());

/** ⌘+ / ⌘- / ⌘0: the window's text size. */
export function zoom(dir: 'in' | 'out' | 'reset'): { ok: boolean; message: string } {
  const size = dir === 'reset' ? DEFAULT_PREFS.textSize : Math.min(17, Math.max(11, current.textSize + (dir === 'in' ? 1 : -1)));
  setPrefs({ textSize: size });
  return { ok: true, message: `Text size ${size}` };
}
