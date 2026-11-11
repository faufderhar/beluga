import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  TALK_ID,
  accelOfChord,
  assign,
  bindingsOf,
  chordLabel,
  chordOf,
  chordOfAccel,
  chordsOf,
  clashes,
  clashesWith,
  menuAccel,
  menuKeys,
  normalChord,
  overridesOf,
  parseChord,
  pressed,
  refusal,
  resetOne,
  searchShortcuts,
  shortcutFor,
  unassign,
} from '../packages/mac/src/lib/shortcuts-model.js';
import { parseAccel } from '../packages/mac/src/lib/dictation-model.js';

/** Keyboard shortcuts you can change (BLG-289): chords, matching, clashes, assigning. */
const press = (key: string, code: string, m: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ key, code, metaKey: Boolean(m.meta), ctrlKey: Boolean(m.ctrl), altKey: Boolean(m.alt), shiftKey: Boolean(m.shift) });

describe('the shortcuts', () => {
  it('have one id each, keys written one way, and no clash out of the box', () => {
    const ids = SHORTCUTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of SHORTCUTS) for (const k of d.keys) expect(normalChord(k), `${d.id} ${k}`).toBe(k);
    expect(clashes(bindingsOf({}))).toEqual([]);
  });

  it('each default can be pressed: none is refused', () => {
    for (const d of SHORTCUTS) for (const k of d.keys) expect(refusal(d.id, k), `${d.id} ${k}`).toBeUndefined();
  });

  it('the menu bar gets every menu item’s key as Tauri writes it', () => {
    const keys = menuKeys(bindingsOf({}));
    expect(keys['conv-stop']).toBe('CmdOrCtrl+.');
    expect(keys['ws-prev']).toBe('Alt+CmdOrCtrl+Up');
    expect(keys['toggle-sidebar']).toBe('Ctrl+CmdOrCtrl+S');
    expect(keys['go-issues']).toBeNull();
    expect(keys['go-search']).toBe('CmdOrCtrl+4');
    // The room's Chat is no place any more (BLG-871): ⌘3 is free.
    expect(keys['go-room']).toBeUndefined();
    expect(menuAccel('Cmd+Ç')).toBeUndefined();
  });
});

describe('chords', () => {
  it('read and write back, "+" too', () => {
    expect(parseChord('Shift+Cmd+K')).toEqual({ ctrl: false, alt: false, shift: true, cmd: true, key: 'K' });
    expect(parseChord('Cmd++')).toMatchObject({ cmd: true, key: '+' });
    expect(normalChord('cmd+shift+k')).toBe('Shift+Cmd+K');
    expect(parseChord('Hyper+K')).toBeUndefined();
  });

  it('show as a Mac does', () => {
    expect(chordLabel('Ctrl+Alt+Shift+Cmd+K')).toBe('⌃⌥⇧⌘K');
    expect(chordLabel('Alt+Cmd+Up')).toBe('⌥⌘↑');
    expect(chordLabel('Alt+Enter')).toBe('⌥↩');
    expect(chordLabel('Cmd+-')).toBe('⌘−');
  });

  it('a key press reads by its character without ⌥ or ⇧, and by the key with them', () => {
    // ⌘. on a Turkish keyboard: the "." sits where a US keyboard has "/".
    expect(chordOf(press('.', 'Slash', { meta: true }))).toBe('Cmd+.');
    expect(chordsOf(press('.', 'Slash', { meta: true }))).toEqual(['Cmd+.', 'Cmd+/']);
    // ⌥P types π: it's still ⌥⌘P.
    expect(chordOf(press('π', 'KeyP', { meta: true, alt: true }))).toBe('Alt+Cmd+P');
    // ⇧⌘= types +: it's ⇧⌘=.
    expect(chordOf(press('+', 'Equal', { meta: true, shift: true }))).toBe('Shift+Cmd+=');
    expect(chordOf(press('ç', 'Semicolon', { ctrl: true }))).toBe('Ctrl+Ç');
    expect(chordOf(press('ArrowDown', 'ArrowDown', { meta: true, alt: true }))).toBe('Alt+Cmd+Down');
    expect(chordOf(press('Meta', 'MetaLeft', { meta: true }))).toBeUndefined();
  });

  it('the talk shortcut goes between its accelerator and a chord', () => {
    expect(chordOfAccel('Alt+Space')).toBe('Alt+Space');
    expect(chordOfAccel('CommandOrControl+Shift+D')).toBe('Shift+Cmd+D');
    expect(accelOfChord('Shift+Cmd+.')).toBe('CommandOrControl+Shift+Period');
    expect(parseAccel(accelOfChord('Ctrl+Alt+1')!)).toMatchObject({ ctrl: true, alt: true, code: 'Digit1' });
    expect(parseAccel(accelOfChord('Alt+Cmd+Up')!)).toMatchObject({ code: 'ArrowUp' });
  });
});

describe('pressing them', () => {
  const b = bindingsOf({});
  it('finds the shortcut a press is', () => {
    expect(pressed(b, 'conv-stop', press('.', 'Period', { meta: true }))).toBe(true);
    expect(pressed(b, 'conv-stop', press('.', 'Slash', { meta: true }))).toBe(true);
    expect(pressed(b, 'zoom-in', press('+', 'Equal', { meta: true, shift: true }))).toBe(true);
    expect(pressed(b, 'ws-commit', press('C', 'KeyC', { meta: true, shift: true }))).toBe(true);
    expect(pressed(b, 'ws-commit', press('c', 'KeyC', { meta: true }))).toBe(false);
    expect(shortcutFor(b, press('π', 'KeyP', { meta: true, alt: true }), ['conv-plan', 'ws-pr'])).toBe('conv-plan');
  });

  it('the other reading never steals a key the first reading has', () => {
    // A layout whose "/" key prints ".": ⌘. is Stop, even though its key is where ⌘/ lives.
    expect(shortcutFor(b, press('.', 'Slash', { meta: true }), ['help-keys', 'conv-stop'])).toBe('conv-stop');
    expect(pressed(b, 'help-keys', press('.', 'Slash', { meta: true }))).toBe(false);
  });

  it('never reads a letter you typed as another key: Dvorak ⌘V pastes, it doesn’t Stop', () => {
    // On Dvorak the V key is where "." is on a US keyboard.
    const paste = press('v', 'Period', { meta: true });
    expect(pressed(b, 'conv-stop', paste)).toBe(false);
    expect(shortcutFor(b, paste, ['conv-stop', 'help-keys'])).toBeUndefined();
    // ⌘X there is where ⌘B is: still Cut, even with ⌘B given to something.
    const mine = bindingsOf({ 'ws-run': ['Cmd+B'] });
    expect(shortcutFor(mine, press('x', 'KeyB', { meta: true }), ['ws-run'])).toBeUndefined();
    expect(pressed(mine, 'ws-run', press('x', 'KeyB', { meta: true }))).toBe(false);
  });

  it('still finds shortcuts by their key on a layout that types other letters', () => {
    // Russian: ⌘. is on the "ю" key, where "." is on a US keyboard.
    expect(pressed(b, 'conv-stop', press('ю', 'Period', { meta: true }))).toBe(true);
    // Russian ⌘S types "ы": still the key it is.
    expect(pressed(bindingsOf({ 'ws-run': ['Cmd+S'] }), 'ws-run', press('ы', 'KeyS', { meta: true }))).toBe(true);
    // AZERTY: ⌘1 types "&".
    expect(shortcutFor(b, press('&', 'Digit1', { meta: true }), ['go-overview'])).toBe('go-overview');
  });

  it('follows your keys', () => {
    const mine = bindingsOf({ 'ws-run': ['Cmd+E'] });
    expect(pressed(mine, 'ws-run', press('e', 'KeyE', { meta: true }))).toBe(true);
    expect(pressed(mine, 'ws-run', press('r', 'KeyR', { meta: true }))).toBe(false);
  });
});

describe('changing them', () => {
  it('refuses what macOS keeps and what would type', () => {
    expect(refusal('ws-run', 'Cmd+Q')).toMatch(/Quit Beluga/);
    expect(refusal('ws-run', 'Cmd+C')).toMatch(/Copy/);
    expect(refusal('ws-run', 'K')).toMatch(/would type/);
    expect(refusal('ws-run', 'Shift+K')).toMatch(/would type/);
    expect(refusal('ws-run', 'F5')).toBeUndefined();
    // ⌥ and a character key types on many keyboards (⌥3 is # on a British Mac): never a shortcut.
    expect(refusal('go-search', 'Alt+3')).toMatch(/types a character/);
    expect(refusal('go-search', 'Alt+Shift+L')).toMatch(/types a character/);
    expect(refusal('go-search', 'Alt+Cmd+3')).toBeUndefined();
    expect(refusal('go-search', 'Alt+Up')).toBeUndefined();
    expect(refusal('ws-run', 'Escape')).toMatch(/esc/);
    // A page's own key may be a letter alone (C makes a task outside a field).
    expect(refusal('page-new', 'T')).toBeUndefined();
    expect(refusal('composer-mode', 'Shift+Tab')).toBeUndefined();
    expect(refusal(TALK_ID, 'Alt+Enter')).toMatch(/pick another/);
  });

  it('knows what a key would clash with, where both work', () => {
    const b = bindingsOf({});
    expect(clashesWith(b, 'ws-run', 'Shift+Cmd+P')).toEqual(['ws-pr']);
    // A page's New wins over New Chat on purpose; the message box and a request don't meet.
    expect(clashesWith(b, 'page-new', 'Cmd+N')).toEqual([]);
    expect(clashesWith(b, 'composer-steer', 'Ctrl+Y')).toEqual([]);
    // The talk shortcut counts.
    expect(clashesWith(b, 'ws-run', 'Alt+Space')).toEqual([TALK_ID]);
  });

  it('takes a key from what had it, or swaps them', () => {
    const b = bindingsOf({});
    const taken = assign({}, b, 'ws-run', 0, 'Shift+Cmd+P', 'replace');
    expect(taken).toEqual({ 'ws-run': ['Shift+Cmd+P'], 'ws-pr': [] });
    const swapped = assign({}, b, 'ws-run', 0, 'Shift+Cmd+P', 'swap');
    expect(swapped).toEqual({ 'ws-run': ['Shift+Cmd+P'], 'ws-pr': ['Cmd+R'] });
    expect(clashes(bindingsOf(swapped))).toEqual([]);
  });

  it('adds another key, takes one away, and goes back', () => {
    const b = bindingsOf({});
    const two = assign({}, b, 'ws-run', 1, 'F5');
    expect(bindingsOf(two)['ws-run']).toEqual(['Cmd+R', 'F5']);
    const none = unassign(two, bindingsOf(two), 'ws-run', 0);
    expect(bindingsOf(none)['ws-run']).toEqual(['F5']);
    expect(resetOne(none, 'ws-run')).toEqual({});
    // Back to its key, it takes it from whatever had it since.
    const moved = assign({}, b, 'ws-merge', 0, 'Cmd+R');
    expect(bindingsOf(resetOne(moved, 'ws-run'))['ws-run']).toEqual(['Cmd+R']);
    expect(bindingsOf(resetOne(moved, 'ws-run'))['ws-merge']).not.toContain('Cmd+R');
  });

  it('keeps the talk shortcut out of the saved overrides, for Settings › Voice', () => {
    const b = bindingsOf({});
    expect(assign({}, b, TALK_ID, 0, 'Ctrl+Space')).toEqual({ [TALK_ID]: ['Ctrl+Space'] });
    expect(overridesOf({ [TALK_ID]: ['Ctrl+Space'], 'ws-run': ['cmd+e'], nope: ['Cmd+X'], 'ws-pr': 'Cmd+P' })).toEqual({ 'ws-run': ['Cmd+E'] });
  });

  it('search finds by name, section or keys', () => {
    const b = bindingsOf({});
    expect(searchShortcuts(b, 'commit').map((d) => d.id)).toEqual(['ws-commit']);
    expect(searchShortcuts(b, '⌥⌘↑').map((d) => d.id)).toContain('ws-prev');
  });
});
