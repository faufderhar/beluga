import { describe, expect, it } from 'vitest';
import { approvalHere, approvalsHere, waitingElsewhere } from '../packages/mac/src/chat/waiting-here.js';

/** What a chat shows above its box (packages/mac/src/chat/waiting-here.ts): only what it asked, and a line to the others (BLG-966). */

const opens = (channel: string): boolean => channel !== 'ext:agent';
const approval = (id: string, channel?: string) => ({ id, ...(channel ? { channel } : {}) });

describe('a chat shows only its own approvals', () => {
  it("keeps another chat's approval out of this one", () => {
    const all = [approval('a', 'ws:auth'), approval('b', 'ws:hooks'), approval('c', 'ws:auth')];
    expect(approvalsHere(all, 'ws:auth', opens).map((a) => a.id)).toEqual(['a', 'c']);
    expect(approvalsHere(all, 'ws:hooks', opens).map((a) => a.id)).toEqual(['b']);
    expect(approvalsHere(all, 'room', opens)).toEqual([]);
  });

  it('shows everywhere what no chat can open: the room, a friend’s request, an external agent', () => {
    expect(approvalHere(approval('a'), 'ws:auth', opens)).toBe(true);
    expect(approvalHere(approval('b', 'ext:agent'), 'ws:auth', opens)).toBe(true);
  });
});

describe('the other chats waiting on you', () => {
  it('lists each other chat once, approvals first, never this one', () => {
    const approvals = [approval('a', 'ws:hooks'), approval('b', 'ws:auth'), approval('c', 'ws:hooks'), approval('d')];
    const questions = [{ channel: 'mac:assistant:1' }, { channel: 'ws:hooks' }];
    expect(waitingElsewhere(approvals, questions, 'ws:auth', opens)).toEqual(['ws:hooks', 'mac:assistant:1']);
  });

  it('leaves out what is shown here anyway (no chat, or one that cannot be opened)', () => {
    expect(waitingElsewhere([approval('a'), approval('b', 'ext:agent')], [], 'ws:auth', opens)).toEqual([]);
  });
});
