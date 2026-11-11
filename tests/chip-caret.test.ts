import { describe, expect, it } from 'vitest';
import { boxRange, chipToDelete, snapToChips } from '../packages/mac/src/chat/chip-caret.js';

// "see worktree:wt-abc123 here": the chip's words are 4–22.
const chip = { start: 4, end: 22 };
const spans = [chip];
const caret = (at: number) => ({ anchor: at, focus: at });

describe('the words under a chip in the message box are one piece (BLG-887)', () => {
  it('a click inside a chip puts the caret at its nearer edge', () => {
    expect(snapToChips(spans, caret(6))).toEqual(caret(4));
    expect(snapToChips(spans, caret(20))).toEqual(caret(22));
  });

  it('the arrows step over it, the way they were going', () => {
    expect(snapToChips(spans, caret(5), 4)).toEqual(caret(22));
    expect(snapToChips(spans, caret(21), 22)).toEqual(caret(4));
  });

  it('leaves a caret at its edges or outside it alone', () => {
    for (const at of [0, 4, 22, 25]) expect(snapToChips(spans, caret(at), at - 1)).toEqual(caret(at));
    expect(snapToChips([], caret(6))).toEqual(caret(6));
  });

  it('a selection that cuts into a chip grows to take all of it', () => {
    expect(snapToChips(spans, { anchor: 0, focus: 8 })).toEqual({ anchor: 0, focus: 22 });
    expect(snapToChips(spans, { anchor: 25, focus: 10 })).toEqual({ anchor: 25, focus: 4 });
    // A double click on a word inside it.
    expect(snapToChips(spans, { anchor: 13, focus: 16 })).toEqual({ anchor: 4, focus: 22 });
  });

  it('shift and an arrow can take a chip and give it back', () => {
    expect(snapToChips(spans, { anchor: 2, focus: 5 }, 4)).toEqual({ anchor: 2, focus: 22 });
    expect(snapToChips(spans, { anchor: 2, focus: 21 }, 22)).toEqual({ anchor: 2, focus: 4 });
  });

  it('Backspace after a chip, or Delete before it, takes it whole', () => {
    expect(chipToDelete(spans, 22, 22, 'Backspace')).toEqual(chip);
    expect(chipToDelete(spans, 4, 4, 'Delete')).toEqual(chip);
    expect(chipToDelete(spans, 4, 4, 'Backspace')).toBeUndefined();
    expect(chipToDelete(spans, 22, 22, 'Delete')).toBeUndefined();
    // A selection deletes as it is (it has already grown to whole chips).
    expect(chipToDelete(spans, 0, 22, 'Backspace')).toBeUndefined();
  });

  it('keeps which way a selection runs', () => {
    expect(boxRange({ anchor: 22, focus: 4 })).toEqual({ start: 4, end: 22, direction: 'backward' });
    expect(boxRange({ anchor: 4, focus: 22 })).toEqual({ start: 4, end: 22, direction: 'forward' });
  });
});
