import { describe, expect, it } from 'vitest';
import { DEFAULT_FIRE, PRESETS, STARTERS, type FireLook, presetOf, starterOf } from '../packages/mac/src/chat/fire-look.js';

/** The welcome's Fire step (BLG-989): the pixel fire and the flame side by side, and None. */
describe('the welcome’s fires', () => {
  const pick = (id: string, from: FireLook = DEFAULT_FIRE): FireLook => {
    const next = { ...from, ...STARTERS.find((x) => x.id === id)!.set };
    return { ...next, preset: presetOf(next) };
  };

  it('offers a pixel fire, a flame and None', () => {
    expect(STARTERS.map((x) => x.id)).toEqual(['pixel', 'flame', 'none']);
    expect(pick('pixel').style).toBe('pixel');
    expect(pick('flame').style).toBe('toon');
  });

  it('both fires burn before anyone types, so the step shows them at once', () => {
    for (const id of ['pixel', 'flame']) expect(pick(id).show).toBe('always');
  });

  it('recognises each once picked, and the two fires are presets Settings knows', () => {
    for (const x of STARTERS) expect(starterOf(pick(x.id))).toBe(x.id);
    expect(pick('pixel').preset).toBe('arcade');
    expect(pick('flame').preset).toBe('hades');
    for (const id of ['arcade', 'hades']) expect(PRESETS.some((p) => p.id === id)).toBe(true);
  });

  it('None turns everything off but keeps the look for later', () => {
    const none = pick('none', pick('pixel'));
    expect([none.show, none.typing, none.popDelete]).toEqual(['off', 'off', false]);
    expect(none.palette).toBe('red');
  });

  it('the app’s default fire is the flame', () => {
    expect(starterOf(DEFAULT_FIRE)).toBe('flame');
  });
});
