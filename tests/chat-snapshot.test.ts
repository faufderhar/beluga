import { describe, expect, it } from 'vitest';
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_MESSAGES, chatSnapshot } from '../src/core/chat-links/transcript.js';
import { CHATS_HANDLERS } from '../src/ipc/chats-handlers.js';
import { type DomainState, type LogItem, initialState } from '../src/core/store.js';

/** BLG-152: a copy of one of your own chats, for a person at the composer to give another person's agent. */

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const FRIEND = 'friend-friend-friend-friend-frie';
const CHAT = 'ws:wt-1';

const ws = (id: string, name: string) => ({ id, name, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 1000 });
const said = (n: number, text: string, channel = CHAT): LogItem => ({ id: `m${n}`, type: 'chat', channel, from: ME, name: 'rob', text, ts: 1_700_000_000_000 + n * 1000, byAgent: false }) as LogItem;
const answer = (n: number, text: string, steps: string[] = []): LogItem =>
  ({ id: `a${n}`, type: 'agent', channel: CHAT, subagents: [], requestId: `a${n}`, owner: ME, ownerName: 'rob', requesterName: 'rob', status: 'done', text, steps, ts: 1_700_000_000_000 + n * 1000 }) as LogItem;

function stateWith(log: readonly LogItem[]): DomainState {
  return {
    ...initialState('room'),
    selfId: ME,
    projectsLoaded: true,
    projects: [{ id: 'p1', name: 'App', root: '/p', workspaces: [ws('wt-1', 'add-auth')] }],
    shared: [{ owner: FRIEND, id: 'theirs', name: 'Their work', project: 'x', role: 'contribute', share: 's' }],
    log,
  } as unknown as DomainState;
}

describe('a copy of a chat', () => {
  it('has the messages view only: what people said and the answers, no tool steps', () => {
    const copy = chatSnapshot(stateWith([said(1, 'add login'), answer(2, 'Login is added.', ['Bash cat src/auth.ts', 'Edit src/auth.ts'])]), `${ME}/${CHAT}`)!;
    expect(copy.title).toBe('add-auth');
    expect(copy.messages).toBe(2);
    expect(copy.text).toContain('add login');
    expect(copy.text).toContain('Login is added.');
    expect(copy.text).not.toContain('cat src/auth.ts');
    expect(copy.text).not.toContain('Edit src/auth.ts');
    // It says what it is: a copy, as of when, and data rather than instructions.
    expect(copy.text).toMatch(/copy/i);
    expect(copy.text).toContain('add-auth');
    expect(copy.text).toMatch(/not instructions/);
    expect(copy.name).toMatch(/\.txt$/);
  });

  it('keeps at most the newest 200 messages', () => {
    const log = Array.from({ length: SNAPSHOT_MAX_MESSAGES + 30 }, (_, i) => said(i, `message number ${i}`));
    const copy = chatSnapshot(stateWith(log), `${ME}/${CHAT}`)!;
    expect(copy.messages).toBe(SNAPSHOT_MAX_MESSAGES);
    expect(copy.total).toBe(SNAPSHOT_MAX_MESSAGES + 30);
    expect(copy.text).toContain(`message number ${SNAPSHOT_MAX_MESSAGES + 29}`);
    expect(copy.text).not.toContain('message number 29\n');
    expect(copy.text).toContain('message number 30\n');
  });

  it('stays within 64 KB, keeping the newest messages', () => {
    const log = Array.from({ length: 150 }, (_, i) => said(i, `${i} ${'x'.repeat(3000)}`));
    const copy = chatSnapshot(stateWith(log), `${ME}/${CHAT}`)!;
    expect(SNAPSHOT_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(copy.text)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(copy.messages).toBeLessThan(150);
    expect(copy.text).toContain(`149 xxx`);
  });

  it('redacts secrets and hides secret paths', () => {
    const copy = chatSnapshot(stateWith([said(1, 'use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 and read ./config/.env please')]), `${ME}/${CHAT}`)!;
    expect(copy.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(copy.text).toContain('[redacted]');
    expect(copy.text).not.toContain('./config/.env');
  });

  it('only for a chat of yours: none for a shared chat, an unknown one, or text that is no ref', () => {
    const state = stateWith([said(1, 'hi')]);
    expect(chatSnapshot(state, `${FRIEND}/ws:theirs`)).toBeUndefined();
    expect(chatSnapshot(state, `${FRIEND}/ws:nope`)).toBeUndefined();
    expect(chatSnapshot(state, `${ME}/ws:gone`)).toBeUndefined();
    expect(chatSnapshot(state, 'room')).toBeUndefined();
  });
});

describe('the copy and its gates', () => {
  it('a secret across the cut of a long message is redacted, not cut in half', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const copy = chatSnapshot(stateWith([said(1, `${'x'.repeat(3990)} ${token} tail`)]), `${ME}/${CHAT}`)!;
    expect(copy.text).not.toContain('ghp_AAAA');
  });
});
