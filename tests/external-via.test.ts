import { describe, expect, it } from 'vitest';
import { convTurns } from '../src/companion/views.js';
import { approvalTitle } from '../src/core/gateway/model.js';
import { TaskRequest } from '../src/core/gateway/protocol.js';
import { initialState, reduce } from '../src/core/store.js';
import { AgentEventBody, ChatBody } from '../src/protocol.js';

const VIA = { id: 'abc123abc123', name: 'GrokBot', creationSource: 'mcp' as const };
const FRAME = { kind: 'chat', text: 'do the thing', byAgent: false, channel: 'ws:w1', via: VIA };

/** A Mac from before `via`: its schema knows the rest of the frame. */
const OldChatBody = ChatBody.omit({ via: true });

describe('the via label', () => {
  it('rides the chat frame and stays with the message', () => {
    expect(ChatBody.parse(FRAME).via).toEqual(VIA);
    const state = reduce(initialState('room', 'ask'), { type: 'chat', id: 'm1', from: 'kay', text: 'do the thing', ts: 1, byAgent: false, channel: 'ws:w1', via: VIA });
    expect(state.log[0]).toMatchObject({ type: 'chat', via: VIA, text: 'do the thing' });
  });

  it('an old client that does not know via still shows the message', () => {
    const old = OldChatBody.parse(FRAME);
    expect(old).toMatchObject({ kind: 'chat', text: 'do the thing', channel: 'ws:w1' });
    expect('via' in old).toBe(false);
  });

  it('a message with no via stays as it was', () => {
    const { via: _via, ...plain } = FRAME;
    expect(ChatBody.parse(plain).via).toBeUndefined();
  });

  it('refuses a name past the limit by dropping nothing silently', () => {
    expect(ChatBody.safeParse({ ...FRAME, via: { ...VIA, name: 'x'.repeat(81) } }).success).toBe(false);
  });

  it('reaches the phone on the message, and a message from it cannot be edited there', () => {
    let state = reduce(initialState('room', 'ask'), { type: 'welcome', self: { peerId: 'kay', name: 'kay', agent: true, shares: [] } });
    state = reduce(state, { type: 'chat', id: 'm1', from: 'kay', text: 'do the thing', ts: 1, byAgent: false, channel: 'ws:w1', via: VIA });
    const { turns } = convTurns(state, { refs: { mint: (x: string) => x } } as never, 'ws:w1');
    expect(turns[0]).toMatchObject({ who: 'you', via: 'GrokBot' });
    expect(turns[0]?.edit).toBeUndefined();
  });

  it('names the agent as the requester on a run card', () => {
    expect(AgentEventBody.parse({ kind: 'agent_event', requestId: 'r', requester: 'ext:abc123abc123', event: 'started', channel: 'ws:w1', via: VIA }).via).toEqual(VIA);
    const state = reduce(initialState('room', 'ask'), { type: 'agent_event', owner: 'kay', requestId: 'r', requester: 'ext:abc123abc123', event: 'started', text: '', ts: 1, channel: 'ws:w1', via: VIA });
    expect(state.log[0]).toMatchObject({ requesterName: 'GrokBot' });
  });

  it('rides a friend request and shows on their card', () => {
    const req = TaskRequest.parse({ t: 'task_request', id: 't_abcdefghijkl', from: 'a'.repeat(64), to: 'b'.repeat(64), ask: 'send the logs', by: 'agent', ts: 1, via: VIA });
    expect(req.via).toEqual(VIA);
    expect(approvalTitle({ peerName: 'kay', by: 'agent', ask: 'send the logs', via: 'GrokBot' })).toBe('kay\'s agent (via GrokBot) wants to: send the logs');
    expect(approvalTitle({ peerName: 'kay', by: 'agent', ask: 'send the logs' })).toBe('kay\'s agent wants to: send the logs');
  });
});
