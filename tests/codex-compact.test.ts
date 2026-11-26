import { describe, expect, it } from 'vitest';
import { CodexEvents } from '../src/agent/runtime/codex/events.js';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { createCodexBackend, isCompact } from '../src/agent/runtime/codex/runner.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { fallbackFor } from '../src/shared/runtime-fallbacks.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

const cwd = process.cwd();

function input(prompt: string): AgentRunInput & { events: Array<[string, string]> } {
  const events: Array<[string, string]> = [];
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onFileTouched: () => undefined, canUseTool: async () => true, events };
}

const backend = (codex: FakeCodex) => createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect });
const compacts = (events: Array<[string, string]>) => events.filter(([k]) => k === 'compact').map(([, t]) => JSON.parse(t) as Record<string, unknown>);

describe('compacting a Codex conversation', () => {
  it('Compact is on for Codex: no fallback reason, the capability set', () => {
    expect(CODEX_CAPABILITIES.hasCompaction).toBe(true);
    expect(fallbackFor('codex', 'compact')).toBeUndefined();
    expect(isCompact('/compact')).toBe(true);
    expect(isCompact('  /compact keep the API notes')).toBe(true);
    expect(isCompact('/compactor')).toBe(false);
    expect(isCompact('please /compact')).toBe(false);
  });

  it('/compact runs thread/compact/start on the conversation’s thread, and ends with the divider', async () => {
    const codex = new FakeCodex();
    const b = backend(codex);
    await b.run(input('hello'));
    const thread = codex.sent('thread/start')[0];
    expect(thread).toBeDefined();
    const run = input('/compact keep the API notes');
    expect(await b.run(run)).toBe('');
    const asked = codex.sent('thread/compact/start');
    expect(asked).toHaveLength(1);
    // The thread the first run opened, resumed: never a turn of words.
    expect(codex.sent('thread/resume').at(-1)?.threadId).toBe(asked[0]!.threadId);
    expect(codex.sent('turn/start')).toHaveLength(1);
    // One divider (its item and the deprecated notice are the same compaction), before and after.
    expect(compacts(run.events)).toEqual([{ pre: 0, post: 8, trigger: 'manual', window: 258400 }]);
  });

  it('Codex compacting by itself mid-turn draws the same divider, said auto, with how full it was before', async () => {
    const codex = new FakeCodex();
    const run = input('long story');
    expect(await backend(codex).run(run)).toBe('echo: long story');
    expect(compacts(run.events)).toEqual([{ pre: 240_000, post: 8, trigger: 'auto', window: 258400 }]);
    expect(run.events.some(([k, t]) => k === 'progress' && /Compacted/.test(t))).toBe(false);
    // The meter follows: its last number is what's in the window after the compaction.
    const contexts = run.events.filter(([k]) => k === 'context').map(([, t]) => JSON.parse(t) as { used: number });
    expect(contexts.map((c) => c.used)).toContain(8);
  });

  it('a compaction asked for that never happened (stopped) draws no divider; a lone deprecated notice still does', () => {
    const events: Array<[string, string]> = [];
    const sink = { onEvent: (k: string, t: string) => void events.push([k, t]) };
    const ev = new CodexEvents(cwd, sink);
    ev.beginTurn(sink);
    ev.compactionAsked();
    expect(ev.endTurn(false).compactions).toBe(0);
    expect(compacts(events)).toEqual([]);
    // An older Codex: only thread/compacted, then its count.
    ev.beginTurn(sink);
    ev.handle('thread/compacted', { threadId: 't', turnId: 'u' });
    ev.handle('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 50, inputTokens: 50, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } } });
    expect(ev.endTurn().compactions).toBe(1);
    expect(compacts(events)).toEqual([{ pre: 0, post: 50, trigger: 'auto', window: 200_000 }]);
  });
});
