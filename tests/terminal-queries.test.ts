import { describe, expect, it } from 'vitest';
import { withoutQueries } from '../src/terminal/queries.js';

describe('withoutQueries', () => {
  it('drops the background colour and cursor position queries a shell would get answers to', () => {
    const out = 'Press Enter when it is done\r\n\x1b]11;?\x1b\\\x1b[6n$ ';
    expect(withoutQueries(out)).toBe('Press Enter when it is done\r\n$ ');
  });

  it('drops colour queries ended by BEL, palette and clipboard queries', () => {
    expect(withoutQueries('a\x1b]10;?\x07b\x1b]4;1;?\x07c\x1b]52;c;?\x07d')).toBe('abcd');
  });

  it('drops device attributes, status, mode, version, keyboard and window reports', () => {
    const q = ['\x1b[c', '\x1b[0c', '\x1b[>c', '\x1b[=c', '\x1b[5n', '\x1b[?6n', '\x1b[?2004$p', '\x1b[>0q', '\x1b[?u', '\x1b[14t', '\x1b[18t', '\x1bP$qm\x1b\\', '\x1bP+q544e\x1b\\'];
    expect(withoutQueries(`x${q.join('')}y`)).toBe('xy');
  });

  it('keeps what draws: colours, cursor moves, titles, cursor shape, title push and pop', () => {
    const draws = '\x1b[31mred\x1b[0m\x1b[2J\x1b[H\x1b]0;title\x07\x1b]11;#000000\x07\x1b[2 q\x1b[22;0t\x1b[23;0t\x1b[?2004h';
    expect(withoutQueries(draws)).toBe(draws);
  });

  it('leaves plain text alone', () => {
    expect(withoutQueries('hello world')).toBe('hello world');
  });
});
