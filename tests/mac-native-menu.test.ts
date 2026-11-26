import { describe, expect, it } from 'vitest';
import { keyEquivalentOf, nativeItems } from '../packages/mac/src/lib/native-menu-model.js';

describe('native menus (Mac)', () => {
  it('turns the app’s shortcuts into NSMenu key equivalents', () => {
    expect(keyEquivalentOf('⌘J')).toEqual({ key: 'j', modifiers: 1 });
    expect(keyEquivalentOf('⇧⌘C')).toEqual({ key: 'c', modifiers: 3 });
    expect(keyEquivalentOf('⌥⌘1')).toEqual({ key: '1', modifiers: 5 });
    expect(keyEquivalentOf('⌘↩')).toEqual({ key: '\r', modifiers: 1 });
    expect(keyEquivalentOf('⌘⌫')).toEqual({ key: '\b', modifiers: 1 });
    expect(keyEquivalentOf('⌃⌘,')).toEqual({ key: ',', modifiers: 9 });
    expect(keyEquivalentOf('⌘F5')).toEqual({ key: String.fromCharCode(0xf708), modifiers: 1 });
    expect(keyEquivalentOf('⌘↑')).toEqual({ key: '\uF700', modifiers: 1 });
  });

  it('shows no shortcut rather than a wrong one', () => {
    expect(keyEquivalentOf(undefined)).toBeUndefined();
    expect(keyEquivalentOf('')).toBeUndefined();
    // No modifier: a menu item's key equivalent would fire on the bare key.
    expect(keyEquivalentOf('↩')).toBeUndefined();
    expect(keyEquivalentOf('Space')).toBeUndefined();
    expect(keyEquivalentOf('⌘☃')).toBeUndefined();
    expect(keyEquivalentOf('Opens the project')).toBeUndefined();
  });

  it('builds the menu: groups, sections, hints, checkmarks, submenus, and an id for each action', async () => {
    const ran: string[] = [];
    const go = (name: string) => () => void ran.push(name);
    const picks: Array<() => void> = [];
    const items = await nativeItems(
      [
        { label: 'Rename', keys: '⌘R', icon: 'file', onSelect: go('rename') },
        { label: 'Make Private', hint: 'Only you', onSelect: go('private') },
        { label: 'Move to', submenu: [{ label: 'Work', checked: true, onSelect: go('work') }] },
        { label: 'Blue', header: 'Colour', swatch: '#00f', onSelect: go('blue') },
        { label: 'Trust', hint: 'Trusted', disabled: true },
        { label: 'Delete', danger: true, onSelect: go('delete') },
      ],
      (text) => `«${text}»`,
      async (p) => (p ? { png: [1], template: !('swatch' in p) } : undefined),
      picks,
    );
    expect(items).toEqual([
      { kind: 'item', id: 0, text: '«Rename»', enabled: true, key: 'r', modifiers: 1, icon: [1], template: true },
      { kind: 'item', id: 1, text: '«Make Private»', enabled: true, subtitle: '«Only you»' },
      { kind: 'item', text: '«Move to»', enabled: true, items: [{ kind: 'item', id: 2, text: '«Work»', enabled: true, checked: true }] },
      { kind: 'separator' },
      { kind: 'header', text: '«Colour»' },
      { kind: 'item', id: 3, text: '«Blue»', enabled: true, icon: [1], template: false },
      { kind: 'item', text: '«Trust»', enabled: false, subtitle: '«Trusted»' },
      { kind: 'separator' },
      { kind: 'item', id: 4, text: '«Delete»', enabled: true },
    ]);
    for (const pick of picks) pick();
    expect(ran).toEqual(['rename', 'private', 'work', 'blue', 'delete']);
  });
});
