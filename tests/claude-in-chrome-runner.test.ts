import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { CHROME_DECLINED, CHROME_OFF } from '../src/agent/chrome.js';
import { createClaudeBackend } from '../src/agent/runtime/claude/runner.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { room } from './runtime-conformance.js';

/**
 * BLG-932 in the Claude runner: a run with Chrome starts Claude Code with --chrome, and its
 * PreToolUse hook judges each Chrome step (as usual, asked once, or refused).
 */

const STEP = 'mcp__claude-in-chrome__navigate';

// Claude Code behind a scripted `query`: it tries two Chrome steps and says what the hook decided.
const sdk = vi.hoisted(() => ({ options: [] as Options[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    sdk.options.push(options);
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) {
        const said: string[] = [];
        for (const id of ['t1', 't2']) {
          const out = (await hook({ hook_event_name: 'PreToolUse', tool_name: STEP, tool_input: { url: 'https://github.com' }, tool_use_id: id, session_id: 's1', transcript_path: '', cwd: '' } as never, id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
          said.push(out.hookSpecificOutput ? `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason}` : 'usual');
        }
        const result = said.join(' | ');
        yield { type: 'result', subtype: 'success', is_error: false, result, modelUsage: {}, total_cost_usd: 0, session_id: 's1' };
      }
    }
    return Object.assign(run(), { interrupt: async () => undefined, setModel: async () => undefined, setPermissionMode: async () => undefined, close: () => undefined });
  },
}));
vi.mock('../src/agent/claude-code.js', async (original) => ({ ...(await original<object>()), claudeCodeReady: async () => undefined }));

const input = (extra: Partial<AgentRunInput>): AgentRunInput => ({
  prompt: 'look at my pull requests',
  requesterName: 'kay',
  viaAgent: false,
  context: [],
  scope: 'full',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onFileTouched: () => undefined,
  canUseTool: async () => true,
  ...extra,
});

const backend = () => createClaudeBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room });

describe('Chrome steps in a Claude run', () => {
  it('a run you sent: --chrome, and its steps go by the usual rules', async () => {
    const canUseTool = vi.fn(async () => true);
    const answer = await backend().run(input({ chrome: {}, canUseTool }));
    expect(sdk.options.at(-1)?.extraArgs).toMatchObject({ chrome: null });
    // Beluga's own rules: an MCP tool asks, and your own Claude's approver answers.
    expect(canUseTool).toHaveBeenCalledWith(STEP, { url: 'https://github.com' });
    expect(answer).toContain('allow');
  });

  it('a run that asks: one card for the request, then every step runs', async () => {
    const ask = vi.fn(async () => true);
    const canUseTool = vi.fn(async () => true);
    const answer = await backend().run(input({ chrome: { ask }, canUseTool }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(answer).toBe('allow: Approved by the machine owner. | allow: Approved by the machine owner.');
  });

  it('a no refuses the rest of the request', async () => {
    const ask = vi.fn(async () => false);
    const answer = await backend().run(input({ chrome: { ask } }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(answer).toBe(`deny: ${CHROME_DECLINED} | deny: ${CHROME_DECLINED}`);
  });

  it('a run without Chrome never connects it, and refuses its steps', async () => {
    const answer = await backend().run(input({ launchArgs: { claude: ['--chrome'] } }));
    expect(sdk.options.at(-1)?.extraArgs ?? {}).not.toHaveProperty('chrome');
    expect(answer).toBe(`deny: ${CHROME_OFF} | deny: ${CHROME_OFF}`);
  });
});
