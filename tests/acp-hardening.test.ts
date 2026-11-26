import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { spawnAcp } from '../src/agent/runtime/acp/connection.js';
import type { AcpExtension } from '../src/agent/runtime/acp/extension.js';
import { type GroupSignals, endGroup } from '../src/agent/runtime/acp/group.js';
import { createAcpBackend } from '../src/agent/runtime/acp/runner.js';
import type { AcpAgentSpec, AcpConnect } from '../src/agent/runtime/acp/spec.js';
import { ACP_LIMITS, AcpWatch } from '../src/agent/runtime/acp/watch.js';
import { ACP_MAX_LINE, acpWire, signInLine } from '../src/agent/runtime/acp/wire.js';
import { ScriptedAgy } from '../src/agent/runtime/antigravity/scripted.js';
import { agyDialect, belugaToolOf } from '../src/agent/runtime/antigravity/tools.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { compile, lookup } from '../packages/mac/src/i18n/match.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';

/** The ACP core's guard on an agent's line: the watch, the wire, the process group, and what the runner does with them. */

const prompt = (id: number, sessionId = 's') => ({ id, method: 'session/prompt', params: { sessionId } });
const update = (u: object, sessionId = 's') => ({ method: 'session/update', params: { sessionId, update: u } });

describe('the watch', () => {
  const { quiet, stuck, setup } = ACP_LIMITS;
  /** Ticks here jump far ahead: none of them is a sleep, but in the test that says so. */
  const L = { ...ACP_LIMITS, slept: Infinity };

  it('says once that a turn is quiet, and ends one stuck with nothing running', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent(prompt(1), 0);
    expect(w.tick(quiet - 1)).toEqual({});
    expect(w.tick(quiet).notice).toMatch(/^Toy hasn’t said anything for 30 s/);
    expect(w.tick(quiet + 1)).toEqual({});
    expect(w.tick(stuck).end).toMatch(/^Toy said nothing for 15 min with no step running/);
  });

  it('counts its words and steps as work, and the turn’s answer ends the watch on it', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent(prompt(1), 0);
    w.got(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }), stuck - 10);
    expect(w.tick(stuck)).toEqual({});
    w.got({ id: 1, result: { stopReason: 'end_turn' } }, stuck);
    expect(w.tick(stuck * 3)).toEqual({});
  });

  it('never ends a turn while a step runs or while you decide on one', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent(prompt(1), 0);
    w.got(update({ sessionUpdate: 'tool_call', toolCallId: 'build', status: 'in_progress' }), 0);
    expect(w.tick(quiet).notice).toMatch(/still running a step/);
    expect(w.tick(stuck * 2)).toEqual({});
    w.got(update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'completed' }), 10);
    w.got({ id: 'ask', method: 'session/request_permission', params: { sessionId: 's' } }, 20);
    expect(w.tick(stuck * 3)).toEqual({});
    // Your answer is work: the clock starts again from it.
    w.sent({ id: 'ask', result: {} }, stuck * 3);
    expect(w.tick(stuck * 4 - 1)).toEqual({});
    expect(w.tick(stuck * 4).end).toBeTruthy();
  });

  it('lets a step that outlived its turn run on its own, without keeping a later turn from being stuck', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent(prompt(1), 0);
    w.got(update({ sessionUpdate: 'tool_call', toolCallId: 'server', status: 'in_progress' }), 0);
    w.got({ id: 1, result: { stopReason: 'end_turn' } }, 1);
    w.sent(prompt(2), 100);
    expect(w.tick(100 + stuck).end).toBeTruthy();
  });

  it('ends a request that isn’t a turn only when the agent said nothing at all for a while', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent({ id: 1, method: 'session/load', params: { sessionId: 's' } }, 0);
    w.got(update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } }), setup - 1);
    expect(w.tick(setup)).toEqual({});
    expect(w.tick(setup * 2).end).toMatch(/^Toy didn’t answer session\/load/);
  });

  it('takes a loaded history for history, its steps too when spoken of later', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent({ id: 1, method: 'session/load', params: { sessionId: 's' } }, 0);
    w.got(update({ sessionUpdate: 'tool_call', toolCallId: 'old', status: 'in_progress' }), 1);
    w.got({ id: 1, result: {} }, 2);
    w.sent(prompt(2), 10);
    w.got(update({ sessionUpdate: 'tool_call_update', toolCallId: 'old', status: 'in_progress' }), 20);
    // "old" isn't a step of this turn: nothing runs, so the turn is stuck in time.
    expect(w.tick(10 + stuck).end).toBeTruthy();
  });

  it('takes a step announced anew under a history’s id for new', () => {
    const w = new AcpWatch('Toy', 0, L);
    w.sent({ id: 1, method: 'session/load', params: { sessionId: 's' } }, 0);
    w.got(update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'completed' }), 1);
    w.got({ id: 1, result: {} }, 2);
    w.sent(prompt(2), 10);
    w.got(update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'in_progress' }), 20);
    // A step runs: quiet is said, never stuck.
    expect(w.tick(20 + stuck * 2).end).toBeUndefined();
  });

  it('doesn’t count the time the computer slept', () => {
    const w = new AcpWatch('Toy', 0, { ...ACP_LIMITS, slept: quiet * 2 });
    w.sent(prompt(1), 0);
    expect(w.tick(1_000)).toEqual({});
    // A long sleep in one gap: the clocks move on by it.
    expect(w.tick(1_000 + stuck * 2)).toEqual({});
    expect(w.tick(1_000 + stuck * 2 + quiet).notice).toBeTruthy();
  });
});

describe('a process group’s end', () => {
  /** A group that is gone after `lives` probes; `refuse` makes the system say no to every signal. */
  const fake = (lives: number, refuse = false) => {
    let t = 0;
    const sent: Array<NodeJS.Signals | 0> = [];
    const g: GroupSignals = {
      signal: (sig) => {
        sent.push(sig);
        if (refuse) throw Object.assign(new Error('no'), { code: 'EPERM' });
        if (sig === 'SIGKILL') lives = 0;
        if (sig === 0 && lives-- <= 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
      wait: async (ms) => void (t += ms),
      now: () => t,
    };
    return { g, sent };
  };

  it('asks first, and kills only what is still there after the grace', async () => {
    const soon = fake(2);
    expect(await endGroup(soon.g, 1_000)).toBe(true);
    expect(soon.sent).not.toContain('SIGKILL');
    const stubborn = fake(Infinity);
    expect(await endGroup(stubborn.g, 1_000)).toBe(true);
    expect(stubborn.sent).toContain('SIGKILL');
  });

  it('gives up, bounded, when it may not signal the group', async () => {
    const no = fake(Infinity, true);
    expect(await endGroup(no.g, 1_000)).toBe(false);
    expect(no.sent.at(-1)).toBe('SIGKILL');
  });
});

describe('the wire', () => {
  const wired = (opts: { limits?: object; now?: () => number; every?: number } = {}) => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const ended: string[] = [];
    const wire = acpWire(stdout, stdin, { label: 'Toy', signInFix: 'Sign in to Toy', end: (why) => void ended.push(why), ...opts });
    const lines: string[] = [];
    let text = '';
    wire.fromAgent.setEncoding('utf8');
    wire.fromAgent.on('data', (chunk: string) => {
      text += chunk;
      const all = text.split('\n');
      text = all.pop() ?? '';
      lines.push(...all);
    });
    return { stdout, stdin, wire, ended, lines };
  };

  it('keeps a character split between two reads whole, and its last line without a newline', async () => {
    const { stdout, wire, lines } = wired();
    const frame = Buffer.from(`${JSON.stringify(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '白鲸 🐋' } }))}\n{"jsonrpc":"2.0","id":1,"result":{}}`);
    const cut = frame.indexOf(Buffer.from('鲸')) + 1;
    stdout.write(frame.subarray(0, cut));
    stdout.write(frame.subarray(cut));
    stdout.end();
    await waitFor(() => lines.length === 2);
    expect(lines[0]).toContain('白鲸 🐋');
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 1 });
    wire.stop();
  });

  it('ends a run on a sign-in printed on stdout, and never repeats its link', async () => {
    const { stdout, wire, ended } = wired();
    stdout.write('Open this link to sign in: https://accounts.example.test/auth?code=1\n');
    await waitFor(() => ended.length === 1);
    expect(wire.cause()).toBe('Toy is not signed in: it asked to sign in in a browser. Sign in to Toy.');
    expect(wire.cause()).not.toContain('https');
    expect(signInLine('compiled https://x.test in 2s')).toBe(false);
  });

  it('passes a stray log line on, and ends on a message too big', async () => {
    const { stdout, wire, ended, lines } = wired();
    stdout.write('warming up\n');
    await waitFor(() => lines.length === 1);
    expect(ended).toEqual([]);
    stdout.write('x'.repeat(ACP_MAX_LINE + 1));
    await waitFor(() => ended.length === 1);
    expect(wire.cause()).toMatch(/over 16 MB/);
  });

  it('ends a run the watch finds stuck, with why, and shows the watch what goes each way', async () => {
    let t = 0;
    const { stdout, stdin, wire, ended } = wired({ now: () => t, every: 5, limits: { slept: Infinity } });
    stdin.resume();
    wire.toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} })}\n`);
    t = ACP_LIMITS.setup;
    await waitFor(() => ended.length === 1);
    expect(wire.cause()).toMatch(/^Toy didn’t answer session\/new/);
    stdout.end();
  });
});

const TOY: AcpAgentSpec = {
  id: 'toy',
  label: 'Toy',
  command: 'toy',
  args: [path.join(__dirname, 'fixtures', 'acp-agent.mjs')],
  missingWords: (where) => `Toy isn’t installed on this ${where}.`,
  installFix: 'Install Toy',
  signInFix: 'Sign in to Toy',
};
const as = (mode: string) => ({ ...process.env, ACP_FIXTURE: mode });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe('an ACP agent’s own process', () => {
  // Process groups are macOS and Linux: Windows ends the one process, as before.
  it.skipIf(process.platform === 'win32')('takes what it started with it when it ends', async () => {
    const conn = await spawnAcp(TOY)({ cwd: process.cwd(), env: as('child'), bin: process.execPath });
    const { pid } = await conn.rpc.request<{ pid: number }>('fixture/child');
    expect(alive(pid)).toBe(true);
    await conn.proc.kill();
    // Starting and ending node is slow on a busy runner: this waits for it to be gone, with room.
    await waitFor(() => !alive(pid), 20_000);
  }, 60_000);

  it('says it isn’t signed in when it asks for a browser instead of answering', async () => {
    await expect(spawnAcp(TOY)({ cwd: process.cwd(), env: as('signin'), bin: process.execPath })).rejects.toThrow('Toy didn’t start: Toy is not signed in: it asked to sign in in a browser. Sign in to Toy.');
  });

  it('ends one that never answers, with why', async () => {
    const mute = { ...TOY, limits: { setup: 300 } };
    await expect(spawnAcp(mute)({ cwd: process.cwd(), env: as('mute'), bin: process.execPath })).rejects.toThrow(/Toy didn’t answer initialize/);
  });
});

describe('a run with the guard', () => {
  const bare: AcpExtension = { instructions: (text) => ({ toy: { instructions: text } }), tools: { dialect: agyDialect, belugaToolOf } };
  const input = (prompt: string, extra: Partial<AgentRunInput> = {}) => {
    const events: Array<[string, string]> = [];
    const value: AgentRunInput = {
      prompt,
      requesterName: 'kay',
      viaAgent: false,
      context: [],
      scope: 'folder',
      signal: new AbortController().signal,
      onEvent: (k, t) => void events.push([k, t]),
      onFileTouched: () => undefined,
      canUseTool: async () => true,
      ...extra,
    };
    return { value, events };
  };

  it('takes what comes in of a loaded history after it opened for history, not this run’s work', async () => {
    const agy = new ScriptedAgy({
      lateHistory: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'said before' } },
        { sessionUpdate: 'tool_call', toolCallId: 'old_call', title: 'Ran old thing', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'old thing' } },
      ],
    });
    const b = createAcpBackend({ ...TOY, args: ['acp'] }, bare, { cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room, connect: agy.connect });
    await b.run(input('hello').value);
    // The second run goes on with the conversation (session/load) on another model: its option is set before the turn.
    const second = input('again', { model: 'claude-sonnet-4-6' });
    const answer = await b.run(second.value);
    expect(agy.sent('session/load')).toHaveLength(1);
    expect(answer).toBe('echo: again');
    expect(second.events.map(([, t]) => t).join('\n')).not.toMatch(/said before|old thing/);
  });

  it('says why the agent went (its line knows), and puts its notes in the chat', async () => {
    let notice: ((note: string) => void) | undefined;
    let kill: (() => Promise<void>) | undefined;
    const agy = new ScriptedAgy({ onPrompt: () => (notice?.('Toy hasn’t said anything for 30 s.'), void kill?.()) });
    const connect: AcpConnect = async (o) => {
      const conn = await agy.connect(o);
      kill = conn.proc.kill;
      return { ...conn, onNotice: (fn) => void (notice = fn), cause: () => (conn.rpc.isClosed ? 'Toy said nothing for 15 min with no step running, so Beluga stopped it.' : undefined) };
    };
    const b = createAcpBackend({ ...TOY, args: ['acp'] }, bare, { cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room, connect });
    const run = input('hello');
    await expect(b.run(run.value)).rejects.toThrow(/said nothing for 15 min/);
    expect(run.events).toContainEqual(['progress', 'Toy hasn’t said anything for 30 s.']);
  });
});

describe('what the guard says, in Chinese', () => {
  const zh = compile(JSON.parse(readFileSync(path.join(__dirname, '..', 'packages', 'mac', 'src', 'i18n', 'zh-CN.json'), 'utf8')) as Record<string, string>);
  const L = { ...ACP_LIMITS, slept: Infinity };

  it('has each note and reason as the watch and the wire say it', async () => {
    const said: string[] = [];
    const quiet = new AcpWatch('Kiro', 0, L);
    quiet.sent(prompt(1), 0);
    said.push(quiet.tick(ACP_LIMITS.quiet).notice!, quiet.tick(ACP_LIMITS.stuck).end!);
    const busy = new AcpWatch('Kiro', 0, L);
    busy.sent(prompt(1), 0);
    busy.got(update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'in_progress' }), 0);
    said.push(busy.tick(ACP_LIMITS.quiet).notice!);
    const mute = new AcpWatch('Kiro', 0, L);
    mute.sent({ id: 1, method: 'initialize' }, 0);
    said.push(mute.tick(ACP_LIMITS.setup).end!);
    const stdout = new PassThrough();
    const wire = acpWire(stdout, new PassThrough(), { label: 'Kiro', signInFix: 'Run agy in Terminal once to sign in with your Google account', end: () => undefined });
    stdout.write('Open this link to sign in: https://x.test/auth\n');
    await waitFor(() => wire.cause());
    said.push(wire.cause()!, 'Kiro sent a message over 16 MB.', 'Kiro stopped reading what Beluga sent.', 'Kiro exited before the turn ended (exit code 3)', 'Kiro exited before the turn ended (stopped by SIGKILL)');
    wire.stop();
    for (const text of said) expect(lookup(zh, text), text).toMatch(/[\u4e00-\u9fff]/);
    expect(lookup(zh, said[0]!)).toBe('Kiro 已有 30 秒没有输出，可能仍在思考；点“停止”可结束。');
    expect(lookup(zh, said[4]!)).toBe('Kiro 未登录：它要求在浏览器中登录。在终端中运行一次 agy，用你的 Google 账户登录。');
  });
});
