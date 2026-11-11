import { describe, expect, it } from 'vitest';
import { boxLabel, boxedWorktrees, plainWorktrees, toBox, worktreeOf } from '../packages/mac/src/chat/worktree-box.js';

const names = new Map([
  ['wt-1a2b3c4d5e6f', 'release-3-1-0-tests'],
  ['wt-aaaaaaaaaaaa', 'Fix login'],
]);

describe('a worktree link is written short in the message box (BLG-887)', () => {
  it('a pasted link becomes its name in brackets, as wide as its chip', () => {
    expect(toBox('see worktree:wt-1a2b3c4d5e6f and', names)).toBe('see [\u2007release-3-1-0-tests] and');
    // Spaces in a name never break, so the chip never wraps.
    expect(toBox('worktree:wt-aaaaaaaaaaaa', names)).toBe('[\u2007Fix\u00a0login]');
  });

  it('leaves links to worktrees it does not know, and links in code, as they are', () => {
    expect(toBox('worktree:wt-ffffffffffff', names)).toBe('worktree:wt-ffffffffffff');
    expect(toBox('see https://x.dev/worktree:wt-1a2b3c4d5e6f', names)).toBe('see https://x.dev/worktree:wt-1a2b3c4d5e6f');
  });

  it('goes out as the whole link again', () => {
    const boxed = toBox('see worktree:wt-1a2b3c4d5e6f and worktree:wt-aaaaaaaaaaaa', names);
    expect(plainWorktrees(boxed, names)).toBe('see worktree:wt-1a2b3c4d5e6f and worktree:wt-aaaaaaaaaaaa');
  });

  it('finds where each short link is', () => {
    expect(boxedWorktrees('see [\u2007release-3-1-0-tests] and', names)).toEqual([{ start: 4, end: 26, id: 'wt-1a2b3c4d5e6f', label: 'release-3-1-0-tests' }]);
    // Not an image's ("[1\u2007name]"), nor a name it doesn't know.
    expect(boxedWorktrees('[1\u2007release-3-1-0-tests] [\u2007nothing]', names)).toEqual([]);
  });

  it('two worktrees with one name: the one last pasted', () => {
    const twins = new Map([...names, ['wt-bbbbbbbbbbbb', 'release-3-1-0-tests']]);
    toBox('worktree:wt-bbbbbbbbbbbb', twins);
    expect(worktreeOf('release-3-1-0-tests', twins)).toBe('wt-bbbbbbbbbbbb');
    toBox('worktree:wt-1a2b3c4d5e6f', twins);
    expect(worktreeOf('release-3-1-0-tests', twins)).toBe('wt-1a2b3c4d5e6f');
  });

  it('writes a name with nothing that would end it early', () => {
    expect(boxLabel(' a]b\nc ')).toBe('a\u00a0b\u00a0c');
  });
});
