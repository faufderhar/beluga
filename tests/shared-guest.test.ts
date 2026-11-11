import { describe, expect, it } from 'vitest';
import { sharedAskTarget, sharedWorktreeBrief } from '../src/core/shared-guest.js';
import { guestMayDo } from '../src/core/shared-diff.js';

describe('a guest in a friend’s worktree', () => {
  it('"@claude" asks your own agent; anything else, and "@claude:<owner>", the owner’s', () => {
    expect(sharedAskTarget('@claude what does auth.ts do?', 'Kayra')).toEqual({ to: 'self', prompt: 'what does auth.ts do?' });
    expect(sharedAskTarget('@Claude  look\nat this', 'Kayra')).toEqual({ to: 'self', prompt: 'look\nat this' });
    expect(sharedAskTarget('@claude:kayra add a test', 'Kayra')).toEqual({ to: 'owner', prompt: 'add a test' });
    expect(sharedAskTarget('@claude:MiaChen fix it', 'Mia Chen')).toEqual({ to: 'owner', prompt: 'fix it' });
    expect(sharedAskTarget('add a test', 'Kayra')).toEqual({ to: 'owner', prompt: 'add a test' });
    // Someone else's agent stays in the words, for the owner's agent to reach.
    expect(sharedAskTarget('@claude:ata review it', 'Kayra')).toEqual({ to: 'owner', prompt: '@claude:ata review it' });
    // "@claude" alone asks nothing: it's a line for the owner's agent, as before.
    expect(sharedAskTarget('@claude', 'Kayra')).toEqual({ to: 'owner', prompt: '@claude' });
  });

  it('tells your agent whose worktree it is and how to read it', () => {
    const brief = sharedWorktreeBrief({ name: 'add-auth', project: 'api', branch: 'feat/auth', share: 'ws-123' }, 'Kayra');
    expect(brief).toContain('Kayra’s worktree "add-auth"');
    expect(brief).toContain('peer "Kayra", share "ws-123"');
    expect(brief).toContain('@claude:Kayra');
  });

  it('a guest invited by link may send their own agent’s answers into a worktree, never the room', () => {
    const shares = { isPrivate: () => true };
    const event = { kind: 'agent_event', requestId: 'r', requester: 'g', event: 'done', text: 'hi' } as const;
    expect(guestMayDo({ ...event, channel: 'ws:abc' }, shares)).toBe(true);
    expect(guestMayDo({ ...event, channel: 'room' }, shares)).toBe(false);
  });
});
