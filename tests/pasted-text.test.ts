import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PASTE_CHARS as CORE_MAX, savePastedText } from '../src/core/attachments.js';
import { sentFiles, withSentFiles } from '../src/core/sent-files.js';
import {
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  MAX_PASTE_CHARS,
  PREVIEW_LINES,
  fenceFor,
  isLongPaste,
  lineCount,
  pastedInline,
  pastedLabel,
  pastedWords,
  previewOf,
  sizeWords,
} from '../packages/mac/src/chat/pasted-text.js';

const lines = (n: number, each = 'a line of the conversation'): string => Array.from({ length: n }, (_, i) => `${i + 1}: ${each}`).join('\n');

/** A very long paste goes as a file: a chip in the box, its first lines and its path in the message (BLG-988). */
describe('a long paste', () => {
  it('counts lines, a last newline starting none', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('one')).toBe(1);
    expect(lineCount('one\ntwo')).toBe(2);
    expect(lineCount('one\ntwo\n')).toBe(2);
  });

  it('is long from enough characters or enough lines, and a short one stays words', () => {
    expect(isLongPaste('hello')).toBe(false);
    expect(isLongPaste('x'.repeat(LONG_PASTE_CHARS - 1))).toBe(false);
    expect(isLongPaste('x'.repeat(LONG_PASTE_CHARS))).toBe(true);
    expect(isLongPaste('\n'.repeat(LONG_PASTE_LINES - 1) + 'x')).toBe(true);
    expect(isLongPaste(lines(LONG_PASTE_LINES - 1, 'x'))).toBe(false);
  });

  it('says what it is on its chip', () => {
    expect(pastedLabel(1)).toBe('Pasted text · 1 line');
    expect(pastedLabel(1412)).toBe('Pasted text · 1,412 lines');
    expect(sizeWords(812)).toBe('812 B');
    expect(sizeWords(38 * 1024)).toBe('38 KB');
    expect(sizeWords(1.4 * 1024 * 1024)).toBe('1.4 MB');
  });

  it('keeps the same longest size as Beluga does', () => {
    expect(MAX_PASTE_CHARS).toBe(CORE_MAX);
  });

  it('shows its first lines, each cut short', () => {
    const text = `\n${lines(50)}`;
    expect(previewOf(text).split('\n')).toHaveLength(PREVIEW_LINES);
    expect(previewOf(text).startsWith('1: ')).toBe(true);
    const wide = previewOf('y'.repeat(10_000));
    expect(wide.length).toBeLessThan(300);
    expect(wide.endsWith('…')).toBe(true);
  });

  it('goes as its first lines and its file, the file on a line of its own so it is copied into scratch', () => {
    const text = lines(400);
    const words = pastedWords(text, '/Users/me/.beluga/attachments/pastes/pasted-1.txt');
    expect(words).toContain('400 lines');
    expect(words).toContain('1: a line');
    expect(words).toContain('5: a line');
    expect(words).not.toContain('6: a line');
    expect(words.split('\n').at(-1)).toBe('`/Users/me/.beluga/attachments/pastes/pasted-1.txt`');
    expect(words.length).toBeLessThan(600);
  });

  it('keeps its preview one block even with backticks in it', () => {
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor('```js\nx\n```')).toBe('````');
    const words = pastedInline('```js\nconsole.log(1)\n```');
    expect(words.startsWith('Pasted text:\n````text\n')).toBe(true);
    expect(words.endsWith('\n````')).toBe(true);
  });
});

describe('a long paste kept by Beluga', () => {
  let dir: string;
  let ws: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-paste-')));
    ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-paste-ws-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it('is saved as a text file and copied into the chat’s scratch folder when it goes', async () => {
    const text = `${lines(300)}\nünïcödé`;
    const saved = await savePastedText(text, path.join(dir, 'pastes'));
    expect(saved.kind).toBe('file');
    expect(saved.image).toBe(false);
    expect(saved.name).toMatch(/^pasted-.+\.txt$/);
    expect(saved.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(readFileSync(saved.path, 'utf8')).toBe(text);

    const message = `Summarize this\n\n${pastedWords(text, saved.path)}`;
    expect(sentFiles(message, 'me', dir).map((f) => f.src)).toEqual([saved.path]);
    const prompt = withSentFiles(message, 'me', ws, '.beluga/scratch/sent', dir);
    expect(prompt).toContain(`.beluga/scratch/sent/${saved.name}`);
    expect(readFileSync(path.join(ws, '.beluga/scratch/sent', saved.name), 'utf8')).toBe(text);
  });

  it('refuses one too long to keep', async () => {
    await expect(savePastedText('x'.repeat(CORE_MAX + 1), dir)).rejects.toThrow(/too long/);
  });
});
