import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { CompletionError, type CompletionRequest } from '../src/agent/runtime/types.js';
import { sideCalls } from '../src/agent/side-calls.js';
import type { DraftContext } from '../src/agent/task-drafter.js';

// Claude Code for claudeComplete: records what it was started with, answers as scripted.
const claude: { options?: Options; prompt?: unknown; result: object } = { result: {} };
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt, options }: { prompt: unknown; options: Options }) =>
    (async function* () {
      claude.options = options;
      claude.prompt = prompt;
      yield { type: 'result', session_id: 's', ...claude.result };
    })(),
}));
const { claudeComplete } = await import('../src/agent/runtime/claude/complete.js');

/** Another runtime: answers from a script, keeps every request. */
function fakeRuntime(answer: (req: CompletionRequest) => string | Error) {
  const asked: CompletionRequest[] = [];
  const complete = async (req: CompletionRequest): Promise<string> => {
    asked.push(req);
    const said = answer(req);
    if (said instanceof Error) throw said;
    return said;
  };
  return { asked, calls: sideCalls(complete, '/room', 'their-model') };
}

const draftCtx = { labels: ['bug', 'feature'], people: [] } as unknown as DraftContext;

describe('side calls on any runtime (a fake one here)', () => {
  it('names a worktree and a plan, with no tools', async () => {
    const { asked, calls } = fakeRuntime((req) => (req.system.includes('worktrees') ? 'Fix Login Redirect' : 'Card checkout for launch.'));
    expect(await calls.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect(await calls.titlePlan('take card payments')).toBe('Card checkout for launch');
    expect(asked.map((r) => [r.cwd, r.model, r.tools])).toEqual([
      ['/room', 'haiku', undefined],
      ['/room', 'haiku', undefined],
    ]);
  });

  it('falls back to the local name when the runtime fails', async () => {
    const { calls } = fakeRuntime(() => new CompletionError('failed'));
    expect(await calls.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect(await calls.titlePlan('x')).toBeUndefined();
  });

  it('drafts a task, reading the code only through its vetTool', async () => {
    const { asked, calls } = fakeRuntime(() => JSON.stringify({ title: 'Fix the login redirect', goal: 'Signing in lands on the page you came from.', labels: ['bug'] }));
    expect(await calls.draftTask('login redirect is broken', draftCtx)).toMatchObject({ title: 'Fix the login redirect', labels: ['bug'] });
    const { asked: looked, calls: looking } = fakeRuntime(() => JSON.stringify({ title: 'T', goal: 'G' }));
    await looking.draftTask('x', { ...draftCtx, look: '/repo' });
    expect(asked[0]?.tools).toBeUndefined();
    expect(looked[0]).toMatchObject({ cwd: '/repo', tools: ['Read', 'Grep', 'Glob'] });
    expect(looked[0]?.vetTool?.('Read', { file_path: '/repo/a.ts' }).allow).toBe(true);
    expect(looked[0]?.vetTool?.('Bash', { command: 'rm -rf /' }).allow).toBe(false);
  });

  it('works out a setup read-only, and says when it ran out of turns in a chat', async () => {
    const { asked, calls } = fakeRuntime(() => 'SETUP: npm ci');
    expect(await calls.fixSetup('/wt', 'npm i', 'boom')).toMatchObject({ command: 'npm ci' });
    expect(asked[0]).toMatchObject({ cwd: '/wt', tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 8 });
    const chat = fakeRuntime(() => new CompletionError('max_turns'));
    await expect(chat.calls.answerChat({ prompt: 'hi', system: 's', images: [], signal: new AbortController().signal } as never)).rejects.toThrow('Claude needed more than one turn');
    expect(chat.asked[0]).toMatchObject({ model: 'their-model', maxTurns: 1, images: [] });
  });
});

describe('claudeComplete', () => {
  it('starts Claude Code with no settings, no session and only the tools given', async () => {
    claude.result = { subtype: 'success', is_error: false, result: 'fix-it' };
    const said = await claudeComplete({ prompt: 'name it', system: 'You name.', cwd: '/x', model: 'haiku', tools: ['Read'], vetTool: (tool) => ({ allow: tool === 'Read', reason: tool === 'Read' ? 'Reading.' : 'No.' }), maxTurns: 3 }, '/bin/claude');
    expect(said).toBe('fix-it');
    expect(claude.prompt).toBe('name it');
    expect(claude.options).toMatchObject({ cwd: '/x', model: 'haiku', tools: ['Read'], maxTurns: 3, settingSources: [], persistSession: false, systemPrompt: 'You name.', pathToClaudeCodeExecutable: '/bin/claude' });
    const hook = claude.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(await hook?.({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never, 't', { signal: new AbortController().signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No.' } });
  });

  it('streams a prompt with images, and mounts suites strictly', async () => {
    claude.result = { subtype: 'success', result: 'ok' };
    await claudeComplete({ prompt: 'what is this', images: [{ mime: 'image/png', data: 'AAAA' }], system: 's', cwd: '/x', suites: { beluga_chat: { name: 'beluga_chat', version: '1', tools: [] } } });
    expect(typeof claude.prompt).not.toBe('string');
    expect(claude.options).toMatchObject({ strictMcpConfig: true, mcpServers: { beluga_chat: { type: 'sdk', name: 'beluga_chat' } }, tools: [], maxTurns: 1 });
  });

  it.each([
    'Failed to authenticate. OAuth session expired. Please log in again.',
    'API Error: 401 unauthorized',
    'Rate limit exceeded',
  ])('rejects a flagged error regardless of provider wording: %s', async (result) => {
    claude.result = { subtype: 'success', is_error: true, result };
    await expect(claudeComplete({ prompt: 'p', system: 's', cwd: '/x' })).rejects.toMatchObject({ kind: 'failed' });
  });

  it('accepts successful answers about authentication rather than filtering error words', async () => {
    claude.result = { subtype: 'success', is_error: false, result: 'fix-oauth-session-expired' };
    const calls = sideCalls(claudeComplete, '/room');
    expect(await calls.nameTask('fix the expired OAuth session')).toBe('fix-oauth-session-expired');
  });

  it('uses the local worktree name instead of an authentication error', async () => {
    claude.result = { subtype: 'success', is_error: true, result: 'Failed to authenticate. OAuth session expired. Please log in again.' };
    const calls = sideCalls(claudeComplete, '/room');
    expect(await calls.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect(await calls.nameTask('檢查並清理舊分支')).toMatch(/^task-[a-z0-9]{5}$/);
    expect(await calls.titlePlan('take card payments')).toBeUndefined();
    expect(await calls.titleChat('take card payments')).toBeUndefined();
  });

  it('says why there is no answer', async () => {
    claude.result = { subtype: 'error_max_turns' };
    await expect(claudeComplete({ prompt: 'p', system: 's', cwd: '/x' })).rejects.toMatchObject({ kind: 'max_turns' });
    claude.result = { subtype: 'error_during_execution' };
    await expect(claudeComplete({ prompt: 'p', system: 's', cwd: '/x' })).rejects.toMatchObject({ kind: 'failed' });
  });
});
