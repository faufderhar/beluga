import { describe, expect, it } from 'vitest';
import { permissionRank } from '../src/core/chat-links/permission.js';

/** How far a chat's run can act on its own (BLG-304): a message may not ask a chat to go further than its sender can. */

const edits = { askOnly: false, autoEdit: true };
const asks = { askOnly: false, autoEdit: false };

describe('permissionRank', () => {
  it('plan mode, a look-only chat and a chat with no place only look', () => {
    expect(permissionRank({ planMode: true, place: edits, runtime: 'claude', flags: { claude: ['--dangerously-skip-permissions'] } })).toBe(0);
    expect(permissionRank({ planMode: false, place: { askOnly: true, autoEdit: true }, runtime: 'claude', flags: { claude: [] } })).toBe(0);
    expect(permissionRank({ planMode: false, runtime: 'claude', flags: {} })).toBe(0);
  });

  it('with no flags: a chat that edits is above a chat that asks before it edits', () => {
    expect(permissionRank({ planMode: false, place: asks, runtime: 'claude', flags: { claude: [] } })).toBe(1);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'claude', flags: { claude: [] } })).toBe(2);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: [] } })).toBe(2);
  });

  it('Claude flags that skip every ask put the chat above one that edits', () => {
    expect(permissionRank({ planMode: false, place: asks, runtime: 'claude', flags: { claude: ['--dangerously-skip-permissions'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: asks, runtime: 'claude', flags: { claude: ['--permission-mode', 'bypassPermissions'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: asks, runtime: 'claude', flags: { claude: ['--permission-mode=bypassPermissions'] } })).toBe(3);
  });

  it('a Claude flag that accepts edits makes a chat that asks a chat that edits; a plan flag makes it look only', () => {
    expect(permissionRank({ planMode: false, place: asks, runtime: 'claude', flags: { claude: ['--permission-mode', 'acceptEdits'] } })).toBe(2);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'claude', flags: { claude: ['--permission-mode', 'plan'] } })).toBe(0);
  });

  it('a Codex approval mode or sandbox that never asks puts the chat above one that edits', () => {
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['--dangerously-bypass-approvals-and-sandbox'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['--yolo'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['-a', 'never'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['--ask-for-approval=never'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['--sandbox', 'danger-full-access'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['-c', 'sandbox_mode="danger-full-access"'] } })).toBe(3);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { codex: ['-c', 'approval_policy=never'] } })).toBe(3);
  });

  it('only the flags of the chat’s own runtime count', () => {
    expect(permissionRank({ planMode: false, place: edits, runtime: 'codex', flags: { claude: ['--dangerously-skip-permissions'] } })).toBe(2);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'claude', flags: { codex: ['--yolo'] } })).toBe(2);
    expect(permissionRank({ planMode: false, place: edits, runtime: 'gemini', flags: { claude: ['--dangerously-skip-permissions'], codex: ['--yolo'] } })).toBe(2);
  });
});
