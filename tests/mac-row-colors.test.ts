import { describe, expect, it } from 'vitest';
import { colorVars, projectColor, rowColorsOf, swatchOf, tileHue, withColor, workspaceColor } from '../packages/mac/src/lib/row-colors.js';

describe('sidebar row colours', () => {
  it('leaves everything plain until you pick a colour', () => {
    expect(projectColor({}, 'p1')).toBeUndefined();
    expect(workspaceColor({}, 'w1', 'p1')).toBeUndefined();
    expect(workspaceColor({}, 'w1', undefined)).toBeUndefined();
  });

  it("gives a chat its project's colour when it has none of its own", () => {
    const colors = { 'project:p1': 'blue' } as const;
    expect(workspaceColor(colors, 'w1', 'p1')).toBe('blue');
    expect(workspaceColor(colors, 'w1', 'p2')).toBeUndefined();
  });

  it("puts a chat's own colour over its project's, and None keeps it plain", () => {
    const colors = { 'project:p1': 'blue', 'ws:w1': 'pink', 'ws:w2': 'none' } as const;
    expect(workspaceColor(colors, 'w1', 'p1')).toBe('pink');
    expect(workspaceColor(colors, 'w2', 'p1')).toBeUndefined();
  });

  it('colours a chat outside any project on its own', () => {
    expect(workspaceColor({ 'ws:w1': 'teal' }, 'w1', undefined)).toBe('teal');
  });

  it('changes one row without touching the rest, or the colours given', () => {
    const before = { 'project:p1': 'blue', 'ws:w1': 'pink' } as const;
    const after = withColor(before, 'ws:w1', 'green');
    expect(after).toEqual({ 'project:p1': 'blue', 'ws:w1': 'green' });
    expect(before).toEqual({ 'project:p1': 'blue', 'ws:w1': 'pink' });
  });

  it('forgets a row set back to its default', () => {
    expect(withColor({ 'ws:w1': 'pink' }, 'ws:w1', undefined)).toEqual({});
    // A project has no "None" of its own: plain is no entry at all.
    expect(withColor({ 'project:p1': 'blue' }, 'project:p1', 'none')).toEqual({});
    // A chat's None is kept: it stays plain in a coloured project.
    expect(withColor({}, 'ws:w1', 'none')).toEqual({ 'ws:w1': 'none' });
  });

  it('drops anything saved that is not a colour', () => {
    expect(rowColorsOf({ 'project:p1': 'blue', 'ws:w1': 'none', 'ws:w2': 'neon', other: 'red', 'ws:': 'red', 'ws:w3': 4 })).toEqual({ 'project:p1': 'blue', 'ws:w1': 'none' });
    expect(rowColorsOf(undefined)).toEqual({});
    expect(rowColorsOf('blue')).toEqual({});
  });

  it("draws from the board's label palette", () => {
    expect(colorVars('blue')).toEqual({ '--row-hue': '212', '--row-sat': '60%' });
    expect(swatchOf('blue')).toBe('hsl(212 60% 62%)');
    expect(tileHue('green')).toBe(142);
  });
});
