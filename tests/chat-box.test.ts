import { describe, expect, it } from 'vitest';
import { boxedChats, chatBox, plainChats, toChatBox } from '../packages/mac/src/chat/chat-box.js';

const OWNER = 'pK3-x_Q9aZ01bC2dE3fG4hI5jK6lM7nO';
const LOGIN = `${OWNER}/ws:wt-abc123`;
const NOTES = `${OWNER}/mac:assistant`;
const refs = new Map([
  ['Fix\u00a0login', LOGIN],
  ['Notes', NOTES],
]);
const refOf = (label: string): string | undefined => refs.get(label);

describe('a chat mention is written short in the message box', () => {
  it('a mention becomes its title in brackets, as wide as its chip, and the box learns its ref', () => {
    const learnt: Array<[string, string]> = [];
    const boxed = toChatBox(`see @Fix login (chat: ${LOGIN}) and`, (label, ref) => learnt.push([label, ref]));
    expect(boxed).toBe('see [@\u2007Fix\u00a0login] and');
    expect(learnt).toEqual([['Fix\u00a0login', LOGIN]]);
    expect(chatBox('Fix login')).toBe('[@\u2007Fix\u00a0login]');
  });

  it('leaves words with no chat mention as they are', () => {
    expect(toChatBox('plain @mia words', () => undefined)).toBe('plain @mia words');
    expect(toChatBox(`@Room (chat: ${OWNER}/room)`, () => undefined)).toBe(`@Room (chat: ${OWNER}/room)`);
  });

  it('goes out as the whole mention again, with its ref', () => {
    const boxed = toChatBox(`see @Fix login (chat: ${LOGIN}) and @Notes (chat: ${NOTES})`, () => undefined);
    expect(plainChats(boxed, refOf)).toBe(`see @Fix login (chat: ${LOGIN}) and @Notes (chat: ${NOTES})`);
  });

  it('finds where each short mention is, and which chat it is', () => {
    expect(boxedChats('see [@\u2007Notes] and', refOf)).toEqual([{ start: 4, end: 13, ref: NOTES, label: 'Notes' }]);
    // Not a worktree's ("[\u2007name]"), an image's ("[1\u2007name]"), or a title it doesn't know.
    expect(boxedChats('[\u2007Notes] [1\u2007Notes] [@\u2007Nothing]', refOf)).toEqual([]);
  });

  it('a short mention it can no longer name stays as written', () => {
    expect(plainChats('[@\u2007Nothing] here', refOf)).toBe('[@\u2007Nothing] here');
  });
});
