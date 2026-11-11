import { afterEach, describe, expect, it } from 'vitest';
import { MAC_SHORTCUTS_FOR_TESTS, OFF_MAC_KEYS, type Bindings, chordLabel, chordsOf, clashes, heldLabel, keysOn, menuAccel, primaryKey, refusal, setKeyPlatform, shortcutFor } from '../packages/mac/src/lib/shortcuts-model.js';

const press = (key: string, code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

afterEach(() => setKeyPlatform('mac'));

describe('shortcuts on Linux and Windows (BLG-525)', () => {
  it('reads Ctrl as the main modifier, and the Windows key where a Mac has ⌃', () => {
    setKeyPlatform('windows');
    expect(chordsOf(press('k', 'KeyK', { ctrlKey: true }))[0]).toBe('Cmd+K');
    expect(chordsOf(press('k', 'KeyK', { metaKey: true }))[0]).toBe('Ctrl+K');
    expect(primaryKey({ metaKey: false, ctrlKey: true })).toBe(true);
    setKeyPlatform('mac');
    expect(chordsOf(press('k', 'KeyK', { metaKey: true }))[0]).toBe('Cmd+K');
    expect(primaryKey({ metaKey: false, ctrlKey: true })).toBe(false);
  });

  it('leaves Ctrl+V to paste on a Windows Dvorak keyboard, where V sits on the "." key', () => {
    setKeyPlatform('windows');
    const b: Bindings = { 'conv-stop': ['Cmd+.'] };
    expect(shortcutFor(b, press('v', 'Period', { ctrlKey: true }), ['conv-stop'])).toBeUndefined();
    expect(shortcutFor(b, press('.', 'KeyE', { ctrlKey: true }), ['conv-stop'])).toBe('conv-stop');
  });

  it('shows keys in words there, and glyphs on a Mac', () => {
    expect(chordLabel('Shift+Cmd+F')).toBe('⇧⌘F');
    setKeyPlatform('windows');
    expect(chordLabel('Shift+Cmd+F')).toBe('Ctrl+Shift+F');
    expect(chordLabel('Alt+Cmd+Up')).toBe('Ctrl+Alt+↑');
    expect(chordLabel('Ctrl+Escape')).toBe('Win+Esc');
    expect(heldLabel({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+');
    setKeyPlatform('linux');
    expect(chordLabel('Ctrl+Cmd+S')).toBe('Ctrl+Super+S');
    expect(menuAccel('Ctrl+Cmd+S')).toBe('Super+CmdOrCtrl+S');
    expect(refusal('ws-commit', 'K')).toBe('K would type: add Ctrl or Alt');
  });

  it('gives the defaults that use ⌃ keys of their own, with no clash between them', () => {
    expect(keysOn('toggle-sidebar', ['Ctrl+Cmd+S'], 'mac')).toEqual(['Ctrl+Cmd+S']);
    expect(keysOn('toggle-sidebar', ['Ctrl+Cmd+S'], 'linux')).toEqual(['Cmd+B']);
    const offMac: Bindings = Object.fromEntries(MAC_SHORTCUTS_FOR_TESTS.map((d) => [d.id, keysOn(d.id, d.keys, 'windows')]));
    expect(clashes(offMac)).toEqual([]);
    // Nothing off the Mac still leans on ⌃ (the Windows key) out of the box.
    for (const d of MAC_SHORTCUTS_FOR_TESTS) for (const k of keysOn(d.id, d.keys, 'linux')) expect(k.startsWith('Ctrl+'), `${d.id} ${k}`).toBe(false);
    expect(Object.keys(OFF_MAC_KEYS).every((id) => MAC_SHORTCUTS_FOR_TESTS.some((d) => d.id === id))).toBe(true);
  });
});
