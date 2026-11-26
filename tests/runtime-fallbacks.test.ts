import { describe, expect, it } from 'vitest';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { type AppState, initialState } from '../src/core/store.js';
import { fallbackFor, runtimeHere } from '../src/shared/runtime-fallbacks.js';
import { workspaceButtons } from '../src/ui/workspace-models.js';
import type { Workspace } from '../src/workspaces/types.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

/** BLG-461: what a Codex conversation does instead, and that the screens say it. */
const cwd = process.cwd();

const stateWith = (self?: AppState['self']): AppState => {
  const base = initialState('test', 'ask') as unknown as AppState;
  return { ...base, context: { 'ws:wt-1': { used: 1000, window: 200_000 } }, ...(self ? { self } : {}) } as AppState;
};
const ws = (agent?: Workspace['agent']): Workspace => ({ id: 'wt-1', projectId: 'p', name: 'thing', path: cwd, kind: 'worktree', ...(agent ? { agent } : {}) }) as unknown as Workspace;
const button = (state: AppState, w: Workspace, action: string) => workspaceButtons(state, w).find((b) => b.action === action);

describe('runtime fallbacks', () => {
  it('a conversation runs on its own agent, else your default, else Claude', () => {
    expect(runtimeHere({ runtime: 'codex' }, { defaultAgent: { runtime: 'claude' } })).toBe('codex');
    expect(runtimeHere(undefined, { defaultAgent: { runtime: 'codex' } })).toBe('codex');
    expect(runtimeHere(undefined, { agents: [{ runtime: 'codex' }] })).toBe('codex');
    expect(runtimeHere(undefined)).toBe('claude');
    expect(fallbackFor('claude', 'compact')).toBeUndefined();
    expect(fallbackFor('local', 'fork')).toBeUndefined();
  });

  it('leaves Compact on for Codex and Claude, and greys it with its reason on an ACP agent', () => {
    expect(button(stateWith(), ws(), 'compact')?.disabled).toBeUndefined();
    expect(fallbackFor('codex', 'compact')).toBeUndefined();
    expect(button(stateWith(), ws({ runtime: 'codex', label: 'Codex' }), 'compact')?.disabled).toBeUndefined();
    // Your default is Codex and this worktree didn't pick another.
    const codexSelf = { id: 'me', name: 'kay', defaultAgent: { runtime: 'codex', label: 'Codex' } } as unknown as AppState['self'];
    expect(button(stateWith(codexSelf), ws(), 'compact')?.disabled).toBeUndefined();
    expect(button(stateWith(), ws({ runtime: 'cursor', label: 'Cursor' }), 'compact')).toMatchObject({ disabled: true, hint: fallbackFor('cursor', 'compact') });
  });

  it("says what a fork on Codex brings along", () => {
    expect(button(stateWith(), ws({ runtime: 'codex', label: 'Codex' }), 'fork')?.hint).toBe(fallbackFor('codex', 'fork'));
    expect(button(stateWith(), ws(), 'fork')?.hint).toMatch(/its conversation/);
  });

  it("a Codex fork starts its own thread instead of writing into the source's", async () => {
    const codex = new FakeCodex();
    const sessions: string[] = [];
    const events: Array<[string, string]> = [];
    const run = {
      prompt: 'hello',
      requesterName: 'kay',
      viaAgent: false,
      context: [],
      scope: 'full',
      signal: new AbortController().signal,
      onEvent: (k: string, t: string) => void events.push([k, t]),
      onFileTouched: () => undefined,
      canUseTool: async () => true,
      place: { cwd, additionalDirectories: [], autoEdit: true, resume: 'source-thread', forkSession: true, onSession: (id: string) => void sessions.push(id) },
    } as unknown as AgentRunInput;
    await createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect }).run(run);
    expect(codex.sent('thread/resume')).toHaveLength(0);
    expect(codex.sent('thread/start')).toHaveLength(1);
    expect(sessions[0]).not.toBe('source-thread');
    expect(events).toContainEqual(['progress', fallbackFor('codex', 'fork')]);
  });
});
