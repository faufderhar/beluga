import { describe, expect, it } from 'vitest';
import { wordsOf } from '../packages/mac/src/onboarding/fx.js';

/**
 * The welcome's headlines resolve word by word (fx.tsx, Words). The spaces sit between the words as
 * real text, never inside them, so the line breaks the same while it animates and once it settles
 * (BLG-989: on an Intel Mac a title showed on three lines, then jumped to two).
 */
describe('a headline’s words', () => {
  it('splits English at its spaces, a space after every word but the last', () => {
    expect(wordsOf('Work on everything at once.', 'Work on everything at once.')).toEqual([
      { word: 'Work', space: true },
      { word: 'on', space: true },
      { word: 'everything', space: true },
      { word: 'at', space: true },
      { word: 'once.', space: false },
    ]);
  });

  it('never keeps a space inside a word', () => {
    for (const { word } of wordsOf('Run  several tasks ', 'Run  several tasks ')) expect(word).toBe(word.trim());
  });

  it('splits a translation into phrases at its punctuation, spaced only where it was', () => {
    expect(wordsOf('Pick a fire.', '选一种火焰，试试看。')).toEqual([
      { word: '选一种火焰，', space: false },
      { word: '试试看。', space: false },
    ]);
  });
});
