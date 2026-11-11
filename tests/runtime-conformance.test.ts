import { describe, expect, it, vi } from 'vitest';
import { claudeRuntime } from '../src/agent/runtime/claude/index.js';
import { createCodexRuntime } from '../src/agent/runtime/codex/index.js';
import { createOpenCodeRuntime } from '../src/agent/runtime/opencode/index.js';
import { ScriptedOpenCode } from '../src/agent/runtime/opencode/scripted.js';
import { createGrokRuntime } from '../src/agent/runtime/grok/index.js';
import { ScriptedGrok } from '../src/agent/runtime/grok/scripted.js';
import { createCopilotRuntime } from '../src/agent/runtime/copilot/index.js';
import { ScriptedCopilot } from '../src/agent/runtime/copilot/scripted.js';
import type { AgentRuntime, RuntimeCapabilities } from '../src/agent/runtime/types.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { FakeClaude } from './fake-claude.js';
import { FakeCodex } from './fake-codex.js';
import { createFakeRuntime } from './fake-runtime.js';
import { conformanceFailures, runtimeConformance } from './runtime-conformance.js';

// Claude Code behind a scripted Agent SDK `query` (fake-claude.ts): the real runner, hooks and all.
const claude = vi.hoisted(() => ({ query: undefined as unknown as (args: unknown) => unknown }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...(await original<object>()), query: (args: unknown) => claude.query(args) }));
claude.query = new FakeClaude().query as (args: unknown) => unknown;

// The same suite for every runtime: the in-memory reference, Claude through its SDK, Codex over
// a scripted app-server, OpenCode over a scripted `opencode acp` and Copilot over a scripted
// `copilot --acp`. Live runs (a signed-in Claude Code, Codex or Copilot, an installed OpenCode) are waived (BLG-475).
runtimeConformance('fake', createFakeRuntime);
runtimeConformance('claude', () => claudeRuntime);
const codex = new FakeCodex();
runtimeConformance('codex', () => createCodexRuntime({ connect: codex.connect }));
const opencode = new ScriptedOpenCode();
runtimeConformance('opencode', () => createOpenCodeRuntime({ connect: opencode.connect, resolve: async () => undefined }));
const grok = new ScriptedGrok();
runtimeConformance('grok', () => createGrokRuntime({ connect: grok.connect }));
const copilot = new ScriptedCopilot();
runtimeConformance('copilot', () => createCopilotRuntime({ connect: copilot.connect }));

/** The fake runtime, changed: its capabilities patched, and its runs' inputs or answers bent. */
function mutant(caps: Partial<RuntimeCapabilities>, bend: { input?: (i: AgentRunInput) => AgentRunInput; answer?: (a: string) => string } = {}): () => AgentRuntime {
  return () => {
    const rt = createFakeRuntime();
    return {
      ...rt,
      capabilities: { ...rt.capabilities, ...caps },
      create: (opts) => {
        const b = rt.create(opts);
        return { ...b, run: async (i: AgentRunInput) => (bend.answer ?? ((a) => a))(await b.run(bend.input ? bend.input(i) : i)) };
      },
    };
  };
}

describe('the conformance suite catches what no capability flag covers', () => {
  it('passes the reference runtime as it is', async () => {
    expect(await conformanceFailures(createFakeRuntime)).toEqual([]);
  });

  it.each([
    ['answers in other words', mutant({}, { answer: (a) => `${a}.` })],
    ['runs a command without asking', mutant({}, { input: (i) => ({ ...i, canUseTool: async () => true }) })],
    ['says it steers, but takes nothing in', mutant({ canSteer: true })],
    ['says it has no usage, but reports some', mutant({}, { input: (i) => ({ ...i, onEvent: (k, t) => (i.onEvent(k, t), k === 'text' && i.onEvent('usage', '{}')) }) })],
    ['says it has usage, but reports none', mutant({ hasUsage: true })],
    ["says it can't list models, but does", mutant({ hasModelList: false })],
    ['forgets the conversation it says it resumes', mutant({}, { input: (i) => (i.place ? { ...i, place: { ...i.place, resume: undefined } } : i) })],
  ])('fails a runtime that %s', async (_, make) => {
    expect((await conformanceFailures(make)).length).toBeGreaterThan(0);
  });
});
