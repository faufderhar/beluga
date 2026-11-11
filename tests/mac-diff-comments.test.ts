import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/shared/diff-lines.js';
import { addComment, codeRange, commentText, commentWhere, commentedRows, makeComment, removeComment, subscribeComments, takeComments, waitingComments, withComments } from '../packages/mac/src/views/diff-comments.js';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '-const c = 3;',
  '+const b = 20;',
  ' const d = 4;',
  ' const e = 5;',
].join('\n');
const lines = parseDiff(diff);
// 0 hunk · 1 ctx 10/10 · 2 del 11 · 3 del 12 · 4 add 11 · 5 ctx 13/12 · 6 ctx 14/13

const make = (a: number, b: number, text = 'note') => makeComment('src/a.ts', lines, a, b, text)!;

describe('a comment on a diff', () => {
  it('names the new lines a pick covers, and goes to the agent with the lines and their signs', () => {
    const c = make(1, 4, 'Why 20?');
    expect(commentWhere(c)).toBe('src/a.ts:10-11');
    expect(commentText(c)).toBe(['On `src/a.ts:10-11`:', '```diff', ' const a = 1;', '-const b = 2;', '-const c = 3;', '+const b = 20;', '```', 'Why 20?'].join('\n'));
  });

  it('names removed lines by their old numbers when only removed lines are picked', () => {
    expect(commentWhere(make(2, 3))).toBe('src/a.ts, removed lines 11-12');
    expect(commentText(make(2, 2)).split('\n')[0]).toBe('On `src/a.ts`, removed line 11:');
  });

  it('picks in either order, skips hunk headings, and says nothing for an empty comment', () => {
    expect(codeRange(lines, 4, 0)).toEqual({ side: 'new', from: 10, to: 11 });
    expect(make(4, 4, ' trimmed \n').text).toBe('trimmed');
    expect(makeComment('src/a.ts', lines, 1, 1, '  ')).toBeUndefined();
    expect(makeComment('src/a.ts', lines, 0, 0, 'a heading')).toBeUndefined();
  });

  it('uses a longer fence when the code holds one', () => {
    const fenced = parseDiff('@@ -1,1 +1,1 @@\n-a\n+```js');
    const text = commentText(makeComment('README.md', fenced, 0, 2, 'ok')!);
    expect(text).toContain('\n````diff\n');
    expect(text).toContain('\n````\nok');
  });

  it('cuts a long pick short', () => {
    const many = parseDiff(`@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, i) => `+l${i}`).join('\n')}`);
    const text = commentText(makeComment('x.ts', many, 1, 60, 'big')!);
    expect(text.split('\n').filter((l) => l.startsWith('+'))).toHaveLength(40);
    expect(text).toContain('… 20 more lines');
  });

  it('goes after your words, or on its own', () => {
    const c = make(4, 4, 'one');
    expect(withComments('Please look  ', [c])).toBe(`Please look\n\n${commentText(c)}`);
    expect(withComments('', [c])).toBe(commentText(c));
    expect(withComments('Just words', [])).toBe('Just words');
  });

  it('marks the rows it is on, a change’s removed lines with its new ones', () => {
    expect([...commentedRows([make(4, 5), make(3, 3)], 'src/a.ts', lines)].sort()).toEqual([3, 4, 5]);
    expect([...commentedRows([make(1, 4)], 'src/a.ts', lines)].sort()).toEqual([1, 2, 3, 4]);
    expect(commentedRows([make(1, 4)], 'src/b.ts', lines).size).toBe(0);
  });
});

describe('comments waiting above a message box', () => {
  it('wait per box, go when the message is taken, and come back if it could not go', () => {
    const seen: number[] = [];
    const stop = subscribeComments(() => seen.push(waitingComments('ws:a').length));
    const one = make(4, 4, 'one');
    const two = make(1, 1, 'two');
    addComment('ws:a', one);
    addComment('ws:a', two);
    expect(waitingComments('ws:b')).toEqual([]);
    removeComment('ws:a', one.id);
    expect(waitingComments('ws:a')).toEqual([two]);
    const taken = takeComments('ws:a');
    expect(taken.comments).toEqual([two]);
    expect(waitingComments('ws:a')).toEqual([]);
    taken.putBack();
    expect(waitingComments('ws:a')).toEqual([two]);
    takeComments('ws:a');
    stop();
    expect(seen).toEqual([1, 2, 1, 0, 1, 0]);
  });
});
