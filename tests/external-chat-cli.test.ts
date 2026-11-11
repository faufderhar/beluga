import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mentionsSecret } from '../src/agent/policy.js';
import { type CallTool, type ChatDeps, chatGrantPath, exitCodeOf, runChat } from '../src/cli/chat.js';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { externalConfigPath } from '../src/external/adapters/config-file.js';
import { grantFilePath } from '../src/external/adapters/grant-file.js';
import { needExternal } from '../src/external/registry.js';

type Answers = Record<string, Record<string, unknown> | Array<Record<string, unknown>>>;

/** The CLI over fake tools: what each call was, and what comes back. */
function fake(answers: Answers, opts: { stdin?: string } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const connected: Array<string | undefined> = [];
  const call: CallTool = async (name, args) => {
    calls.push([name, args]);
    const answer = answers[name];
    if (!answer) throw new Error(`No answer for ${name}`);
    return Array.isArray(answer) ? answer.shift()! : answer;
  };
  const deps: ChatDeps = {
    connect: async (project) => {
      connected.push(project);
      return { call, close: async () => undefined };
    },
    stdin: async () => opts.stdin ?? '',
    hereProject: () => 'here',
  };
  const run = async (...args: string[]): Promise<{ code: number; text: string }> => {
    let text = '';
    const code = await runChat(args, (t) => void (text += t), deps);
    return { code, text };
  };
  return { run, calls, connected };
}

const STARTED = { runId: 'r1', delivery: 'started' };
const said = (text: string) => ({ untrusted: true, text, truncated: false });

describe('exit codes', () => {
  it.each([
    [{ status: 'completed' }, 0],
    [{ status: 'idle' }, 0],
    [{ status: 'failed' }, 1],
    [{ status: 'cancelled' }, 1],
    [{ status: 'interrupted' }, 1],
    [{ status: 'running', hasPendingQuestion: true }, 2],
    [{ status: 'running', pendingApproval: { id: 'a' } }, 2],
  ])('%j exits %i', (wait, code) => {
    expect(exitCodeOf(wait)).toBe(code);
  });

  it('send --wait prints the reply and exits 0', async () => {
    const f = fake({ beluga_chat_send: STARTED, beluga_chat_wait: { status: 'completed', text: said('All done') } });
    expect(await f.run('send', 'c1', 'go', '--wait')).toEqual({ code: 0, text: 'All done\n' });
  });

  it('send --wait exits 1 when the run fails, and 2 when it waits for an answer in the app', async () => {
    const failed = fake({ beluga_chat_send: STARTED, beluga_chat_wait: { status: 'failed', text: said('It broke') } });
    expect((await failed.run('send', 'c1', 'go', '--wait')).code).toBe(1);
    const asking = fake({ beluga_chat_send: STARTED, beluga_chat_wait: { status: 'running', hasPendingQuestion: true } });
    expect(await asking.run('send', 'c1', 'go', '--wait')).toEqual({ code: 2, text: 'The run waits for your answer in Beluga.\n' });
    const approving = fake({ beluga_chat_send: STARTED, beluga_chat_wait: { status: 'running', pendingApproval: { id: 'a' } } });
    expect((await approving.run('send', 'c1', 'go', '--wait')).code).toBe(2);
  });

  it('a step of the wait that times out goes on waiting, for the same run', async () => {
    const f = fake({ beluga_chat_send: STARTED, beluga_chat_wait: [{ status: 'running', timedOut: true }, { status: 'completed', text: said('Done') }] });
    expect((await f.run('send', 'c1', 'go', '--wait')).text).toBe('Done\n');
    expect(f.calls.filter(([n]) => n === 'beluga_chat_wait').map(([, a]) => a.runId)).toEqual(['r1', 'r1']);
  });

  it('send never interrupts: its mode is auto', async () => {
    const f = fake({ beluga_chat_send: STARTED });
    expect(await f.run('send', 'c1', 'go')).toEqual({ code: 0, text: 'started\n' });
    expect(f.calls[0]).toEqual(['beluga_chat_send', { chat: 'c1', message: 'go', mode: 'auto' }]);
  });

  it('send - reads stdin, and --json prints JSON', async () => {
    const f = fake({ beluga_chat_send: STARTED, beluga_chat_wait: { status: 'completed', text: said('Done') } }, { stdin: 'from a pipe' });
    const { text } = await f.run('send', 'c1', '-', '--wait', '--json');
    expect(f.calls[0]![1].message).toBe('from a pipe');
    expect(JSON.parse(text)).toMatchObject({ status: 'completed' });
  });

  it('a refusal throws with its words', async () => {
    const f = fake({});
    await expect(f.run('send', 'c1', 'go')).rejects.toThrow(/No answer/);
    await expect(f.run('send', 'c1')).rejects.toThrow(/Say the chat/);
  });
});

describe('the commands', () => {
  it('start: root by default, a worktree with --worktree, . is this folder\'s project, and the grant must hold it', async () => {
    const f = fake({ beluga_chat_launch: { chatId: 'c9', ...STARTED } });
    expect(await f.run('start', 'api', 'fix', 'it')).toEqual({ code: 0, text: 'c9\n' });
    expect(f.calls[0]).toEqual(['beluga_chat_launch', { project: 'api', message: 'fix it', workspaceStrategy: 'root' }]);
    await f.run('start', '.', 'go', '--worktree', 'main');
    expect(f.calls[1]![1]).toEqual({ project: 'here', message: 'go', workspaceStrategy: 'worktree', baseRef: 'main' });
    expect(f.connected).toEqual(['api', 'here']);
  });

  it('show reads every page; list prints a line each', async () => {
    const f = fake({
      beluga_chat_read: [
        { messages: [{ author: said('you'), text: said('hello') }], nextPosition: 1, hasMore: true },
        { messages: [{ author: said('agent'), text: said('hi') }], nextPosition: 2, hasMore: false },
      ],
      beluga_chat_list: { chats: [{ id: 'c1', status: 'idle', title: said('A chat') }] },
    });
    expect((await f.run('show', 'c1')).text).toBe('you: hello\nagent: hi\n');
    expect(f.calls.map(([, a]) => a.afterPosition)).toEqual([0, 1]);
    expect((await f.run('list')).text).toBe('c1  idle  A chat\n');
  });

  it('a wrong command says how, and fails', async () => {
    const f = fake({});
    const wrong = await f.run('nope');
    expect(wrong.code).toBe(1);
    expect(wrong.text).toContain('Usage: beluga chat');
    expect((await f.run('--help')).code).toBe(0);
  });
});

describe('the file that holds its token', () => {
  it('an agent\'s shell command that names it counts as touching a secret', () => {
    expect(mentionsSecret(`cat ~/.beluga/${path.basename(chatGrantPath())}`)).toBe(true);
  });
});

describe('over the listener, with its own grant', () => {
  const running: RunningDaemon[] = [];
  afterEach(async () => {
    for (const d of running.splice(0)) await d.stop();
    clearDaemonInfo();
    rmSync(externalConfigPath(), { force: true });
    rmSync(grantFilePath(), { force: true });
    rmSync(chatGrantPath(), { force: true });
    vi.unstubAllEnvs();
  });

  it('its work shows in the audit log under the CLI\'s grant, and the file holding it is private', async () => {
    vi.stubEnv('BELUGA_EXTERNAL_PORT', '0');
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true });
    running.push(d);
    const service = needExternal(d.core.session);
    await service.setEnabled(true);
    vi.stubEnv('BELUGA_MCP_URL', service.status().url!);
    const { grant, token } = service.grants.create({ name: 'Beluga CLI', clientId: 'local-token', redirectHost: 'localhost', route: 'local', level: 'trusted', projects: [], expiresAt: Date.now() + 60_000 });
    writeFileSync(chatGrantPath(), JSON.stringify({ id: grant.id, token, projects: [] }), { mode: 0o600 });

    let text = '';
    expect(await runChat(['list'], (t) => void (text += t))).toBe(0);
    expect(text).toBe('No chats.\n');
    expect(service.activity({ agent: grant.id })).toEqual([expect.objectContaining({ agent: 'Beluga CLI', agentId: grant.id, tool: 'beluga_chat_list', result: 'ok' })]);
  });
});
