import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundAgents, PromptQueue, TurnRouter, startedPrompt } from '../src/agent/live-run.js';
import type { AgentRunInput, FollowUp, RoomBridge, Steer } from '../src/agent/types.js';
import { endProcess } from '../src/agent/claude-process.js';
import { spawn } from 'node:child_process';

/** A scripted Claude Code: for each prompt it reads, it yields the next scripted turn (a promise in it: waited for). */
type Turn = (prompt: string) => Array<object | Promise<object>>;
const script: { turns: Turn[]; extra: object[][]; prompts: string[]; options?: Options; interrupt?: () => void; queue?: unknown; exitAfter?: string; models: Array<{ model: string | undefined; afterPrompts: number }> } = { turns: [], extra: [], prompts: [], models: [] };

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string } }>; options: Options }) =>
    Object.assign(
      (async function* () {
        script.options = options;
        script.queue = prompt;
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        let turn = 0;
        for await (const msg of prompt) {
          script.prompts.push(msg.message.content);
          for (const m of script.turns[turn++]?.(msg.message.content) ?? []) yield await m;
          // Turns Claude starts by itself once a background agent is done.
          for (const extra of script.extra.splice(0)) for (const m of extra) yield m;
        }
        if (script.exitAfter) throw new Error(script.exitAfter);
      })(),
      {
        interrupt: async () => script.interrupt?.(),
        // Recorded with how many prompts Claude Code had read by then: a switch must come before the message it is for.
        setModel: async (model?: string) => void script.models.push({ model, afterPrompts: script.prompts.length }),
      },
    ),
}));

const { createClaudeBackend } = await import('../src/agent/runner.js');

const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string) => ({ type: 'result', subtype: 'success', result: r, session_id: 's1', modelUsage: {}, total_cost_usd: 0 });
const tasks = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'job' })) });

const bridge = { selfName: () => 'kay', reportUsage: () => undefined } as unknown as RoomBridge;

function runInput(over: Partial<AgentRunInput> = {}): AgentRunInput & { events: string[] } {
  const events: string[] = [];
  return {
    prompt: 'build it',
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: (kind, t) => void (kind === 'text' && events.push(t)),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    events,
    ...over,
  };
}

describe('PromptQueue', () => {
  it('yields pushed prompts in order and ends once closed', async () => {
    const q = new PromptQueue();
    q.push('a');
    const seen: string[] = [];
    const reading = (async () => {
      for await (const m of q) seen.push(m.message.content as string);
    })();
    q.push('b');
    await new Promise((r) => setTimeout(r, 5));
    q.close();
    await reading;
    expect(seen).toEqual(['a', 'b']);
    expect(q.push('c')).toBe(false);
  });

  it('a prompt taken back before Claude Code got it never goes (Cancel on a steered message)', async () => {
    const q = new PromptQueue();
    q.push('a', { uuid: 'u-a' });
    q.push('b', { uuid: 'u-b', steer: true });
    expect(q.remove('u-b')).toBe(true);
    expect(q.remove('u-b')).toBe(false);
    q.close();
    const seen: string[] = [];
    for await (const m of q) seen.push(m.message.content as string);
    expect(seen).toEqual(['a']);
    expect(q.remove('u-a')).toBe(false);
  });
});

describe('BackgroundAgents', () => {
  it('follows the level signal, ignoring ambient watchers', () => {
    const bg = new BackgroundAgents();
    bg.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'local_agent', ambient: true }] });
    expect(bg.busy).toBe(false);
    bg.observe(tasks('a'));
    expect(bg).toMatchObject({ busy: true, agents: true });
    bg.observe(tasks());
    expect(bg.busy).toBe(false);
    bg.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'sh2', task_type: 'local_bash', parent_task_id: 'a' }] });
    expect(bg).toMatchObject({ busy: true, agents: true }); // an agent's own shell: the agent will come back for it
  });

  it('keeps a run open for a command the main conversation left running (its end wakes Claude), as a shell', () => {
    const bg = new BackgroundAgents();
    bg.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'e2e', task_type: 'local_bash' }] });
    expect(bg).toMatchObject({ busy: true, agents: false });
    bg.observe({ type: 'system', subtype: 'task_notification', task_id: 'e2e', status: 'completed' });
    expect(bg.busy).toBe(false);
  });

  it('falls back to start/finish edges', () => {
    const bg = new BackgroundAgents();
    bg.observe({ type: 'system', subtype: 'task_started', task_id: 'a', task_type: 'local_agent' });
    expect(bg.busy).toBe(true);
    bg.observe({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' });
    expect(bg.busy).toBe(false);
  });
});

describe('TurnRouter', () => {
  it('gives follow-ups the next turns and self-started turns to the original', () => {
    const got: string[] = [];
    const route = (name: string) => ({ onEvent: () => undefined, onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });
    const original = { onEvent: () => undefined };
    const turns = new TurnRouter(original);
    expect(turns.current()).toBe(original);
    turns.end(true, 'first');
    const a = route('a');
    turns.queue(a);
    expect(turns.waiting).toBe(true);
    expect(turns.current()).toBe(a);
    turns.end(true, 'for a');
    expect(turns.current()).toBe(original); // a background agent finished; Claude reports on its own
    turns.end(true, 'agents done');
    turns.queue(route('b'));
    turns.failPending('closed');
    expect(got).toEqual(['a:for a', 'b!closed']);
    expect(turns.answers).toEqual(['first', 'agents done']);
  });
});

describe('live runs', () => {
  it('ends right after answering when nothing runs in the background', async () => {
    script.turns = [() => [text('hi'), result('hi')]];
    script.prompts = [];
    const offers: unknown[] = [];
    const out = await createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ onFollowUps: (s) => void offers.push(s) }));
    expect(out).toBe('hi');
    expect(offers).toEqual([]);
  });

  it('stays open while background agents work, takes follow-ups, and ends when they finish', async () => {
    let send: ((f: FollowUp) => boolean) | undefined;
    const replies: string[] = [];
    script.prompts = [];
    script.turns = [
      () => [tasks('job'), text('started 1 job'), result('started 1 job')],
      () => {
        // The job finishes while Claude answers the follow-up; it then reports on its own.
        script.extra.push([tasks(), text('job finished'), result('job finished')]);
        return [text('sure'), result('sure')];
      },
    ];
    const input = runInput({ onFollowUps: (s) => void (send = s) });
    const done = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    await vi.waitFor(() => expect(send).toBeDefined());
    const followUp = { prompt: 'also this', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t: string) => void replies.push(t), onError: (r: string) => void replies.push(`error: ${r}`) };
    expect(send!(followUp)).toBe(true);
    expect(await done).toBe('started 1 job\n\njob finished');
    expect(replies).toEqual(['sure']);
    expect(input.events).toEqual(['started 1 job', 'job finished']);
    expect(script.prompts[1]).toContain('also this');
    expect(send).toBeUndefined(); // closed again
  });

  it('a follow-up for another model switches Claude Code to it before it reads the message; the same model, nothing', async () => {
    let send: ((f: FollowUp) => boolean) | undefined;
    script.prompts = [];
    script.models = [];
    script.turns = [
      () => [tasks('job'), text('started'), result('started')],
      () => [text('still here'), result('still here')],
      () => {
        script.extra.push([tasks(), text('job finished'), result('job finished')]);
        return [text('on opus'), result('on opus')];
      },
    ];
    const input = runInput({ model: 'sonnet', onFollowUps: (s) => void (send = s) });
    const done = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    await vi.waitFor(() => expect(send).toBeDefined());
    const followUp = (prompt: string, model: string) => ({ prompt, model, requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: () => undefined, onError: () => undefined });
    // The conversation still uses the model the run started on: no switch.
    expect(send!(followUp('same', 'sonnet'))).toBe(true);
    await vi.waitFor(() => expect(script.prompts).toHaveLength(2));
    expect(script.models).toEqual([]);
    // Opus was picked meanwhile: switched, and before the message went in.
    expect(send!(followUp('now opus', 'opus'))).toBe(true);
    expect(await done).toBe('started\n\njob finished');
    expect(script.models).toEqual([{ model: 'opus', afterPrompts: 2 }]);
    expect(script.prompts[2]).toContain('now opus');
  });
});

describe('how long a run stays open for background work', () => {
  const MINUTE = 60_000;
  const init = { type: 'system', subtype: 'init', session_id: 's1' };
  const shells = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: 'job' })) });
  const closed = (): boolean => (script.queue as PromptQueue).closed;
  // Only these two: the polling below runs on real setImmediate.
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => void vi.useRealTimers());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const until = async (met: () => boolean): Promise<void> => {
    while (!met()) await new Promise((r) => setImmediate(r));
  };

  /** A run whose scripted Claude Code says each batch (up to three messages) when told to. */
  function start(batches: number, turns: Turn[] = []) {
    const gates = Array.from({ length: batches }, () => deferred<object[]>());
    script.prompts = [];
    script.extra = [];
    const seen = { usage: 0, inits: 0, offers: [] as boolean[] };
    let send: ((f: FollowUp) => boolean) | undefined;
    const heard: string[] = [];
    script.turns = [
      () => gates.flatMap(({ promise }) => [0, 1, 2].map((i) => promise.then((messages) => messages[i] ?? { type: 'system', subtype: 'status' }))),
      ...turns,
    ];
    const input = runInput({
      onEvent: (kind, t) => {
        if (kind === 'usage') seen.usage++;
        if (kind === 'text') heard.push(t);
      },
      // The run's first init, then each later one.
      onHarness: () => void seen.inits++,
      onFollowUps: (s) => {
        seen.offers.push(Boolean(s));
        send = s;
      },
    });
    const done = createClaudeBackend({ cwd: process.cwd(), autoEdit: false, additionalDirectories: [], bridge }).run(input);
    let next = 0;
    return {
      done,
      seen,
      send: (f: FollowUp) => send!(f),
      /** A turn that ends (its `usage` and what settles after it happen in one go). */
      async turn(...messages: object[]) {
        const before = seen.usage;
        gates[next++]!.resolve(messages);
        await until(() => seen.usage > before);
      },
      /** Messages up to a text in a turn that goes on. */
      async open(...messages: object[]) {
        const before = heard.length;
        gates[next++]!.resolve(messages);
        await until(() => heard.length > before);
      },
      /** Claude Code began a turn (its init), and said nothing in it yet. */
      async began() {
        const before = seen.inits;
        gates[next++]!.resolve([init]);
        await until(() => seen.inits > before);
      },
    };
  }

  it('counts 45 minutes from the last turn that left a command running, not the first', async () => {
    const run = start(2);
    await run.turn(shells('a'), text('one'), result('one'));
    vi.advanceTimersByTime(40 * MINUTE);
    await run.turn(shells('b'), text('two'), result('two'));
    vi.advanceTimersByTime(44 * MINUTE);
    expect(closed()).toBe(false);
    // Offered once, however often it's kept open again.
    expect(run.seen.offers).toEqual([true]);
    // A command that never ends (a dev server) still ends the run.
    vi.advanceTimersByTime(MINUTE);
    expect(closed()).toBe(true);
    expect(run.seen.offers).toEqual([true, false]);
    expect(await run.done).toBe('one\n\ntwo');
  });

  it('never closes the run in the middle of a turn; the limit counts again from its end', async () => {
    const run = start(3);
    await run.turn(shells('a'), text('one'), result('one'));
    vi.advanceTimersByTime(44 * MINUTE);
    await run.open(text('two'));
    vi.advanceTimersByTime(4 * 60 * MINUTE);
    expect(closed()).toBe(false);
    await run.turn(result('two'));
    vi.advanceTimersByTime(44 * MINUTE);
    expect(closed()).toBe(false);
    vi.advanceTimersByTime(MINUTE);
    expect(closed()).toBe(true);
    await run.done;
  });

  it('takes the limit of the work that is live at the last turn', async () => {
    const run = start(2);
    await run.turn(tasks('agent'), text('one'), result('one'));
    vi.advanceTimersByTime(60 * MINUTE);
    expect(closed()).toBe(false);
    await run.turn(shells('server'), text('two'), result('two'));
    vi.advanceTimersByTime(45 * MINUTE);
    expect(closed()).toBe(true);
    await run.done;

    const other = start(2);
    await other.turn(shells('server'), text('one'), result('one'));
    await other.turn(tasks('agent'), text('two'), result('two'));
    vi.advanceTimersByTime(179 * MINUTE);
    expect(closed()).toBe(false);
    vi.advanceTimersByTime(MINUTE);
    expect(closed()).toBe(true);
    await other.done;
  });

  it('does not close on a turn Claude Code began but has said nothing in yet', async () => {
    const run = start(3);
    await run.turn(shells('a', 'server'), text('one'), result('one'));
    vi.advanceTimersByTime(44 * MINUTE);
    await run.began();
    vi.advanceTimersByTime(5 * MINUTE);
    expect(closed()).toBe(false);
    await run.turn(shells('server'), text('two'), result('two'));
    vi.advanceTimersByTime(45 * MINUTE);
    expect(closed()).toBe(true);
    await run.done;
  });

  it('does not close on a message sent between turns that Claude has not started on yet', async () => {
    const reply = deferred<object>();
    const run = start(1, [() => [reply.promise, result('reply')]]);
    await run.turn(shells('server'), text('one'), result('one'));
    vi.advanceTimersByTime(44 * MINUTE);
    const errors: string[] = [];
    const answered = deferred<string>();
    expect(run.send({ prompt: 'and this?', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: answered.resolve, onError: (e: string) => void errors.push(e) })).toBe(true);
    vi.advanceTimersByTime(5 * MINUTE);
    expect(closed()).toBe(false);
    reply.resolve(text('reply'));
    expect(await answered.promise).toBe('reply');
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(45 * MINUTE);
    expect(closed()).toBe(true);
    await run.done;
  });
});

describe('steering', () => {
  const route = (got: string[], name: string) => ({ onEvent: () => undefined, onStart: () => void got.push(`${name} started`), onFolded: () => void got.push(`${name} folded`), onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });

  it('tags prompts with ids, and steered ones to be taken in at the next step', async () => {
    const q = new PromptQueue();
    const first = q.push('a');
    const steered = q.push('b', { steer: true });
    q.close();
    const seen: Array<{ uuid?: string; priority?: string }> = [];
    for await (const m of q) seen.push({ uuid: m.uuid, priority: m.priority });
    expect(seen).toEqual([{ uuid: first, priority: undefined }, { uuid: steered, priority: 'next' }]);
  });

  it('a message the turn took in gets no turn of its own; one it did not, the next', () => {
    const got: string[] = [];
    const turns = new TurnRouter({ onEvent: () => undefined });
    turns.current();
    turns.queue(route(got, 'a'), 'ua', true);
    turns.queue(route(got, 'b'), 'ub', true);
    turns.end(true, 'did it', ['u0', 'ua']);
    expect(got).toEqual(['a folded']);
    expect(turns.waiting).toBe(true);
    turns.current();
    turns.end(true, 'for b', ['ub']);
    expect(got).toEqual(['a folded', 'b started', 'b:for b']);
    expect(turns.waiting).toBe(false);
  });

  it('without word from Claude Code, steered messages count as taken in (follow-ups still get turns)', () => {
    const got: string[] = [];
    const turns = new TurnRouter({ onEvent: () => undefined });
    turns.current();
    turns.queue(route(got, 'a'), 'ua', true);
    turns.queue(route(got, 'f'), 'uf', false);
    turns.end(true, 'did it');
    expect(got).toEqual(['a folded']);
    turns.current();
    expect(got).toEqual(['a folded', 'f started']);
  });

  it('a steered message is read once Claude Code lists it mid-turn, not only when the turn ends', () => {
    const got: string[] = [];
    const turns = new TurnRouter({ onEvent: () => undefined });
    turns.current();
    turns.queue(route(got, 'a'), 'ua', true);
    turns.queue(route(got, 'b'), 'ub', true);
    turns.queue(route(got, 'n'), 'un', false);
    turns.read(['u0', 'ua', 'un']);
    // Only steered messages: one sent to be its own turn (Send now) never reads as folded in early.
    expect(got).toEqual(['a folded']);
    turns.end(true, 'did it', ['u0', 'ua', 'ub']);
    expect(got).toEqual(['a folded', 'b folded']);
  });

  it('a long turn says a steered message was read at the step that took it in', async () => {
    let steer: ((f: FollowUp) => boolean) | undefined;
    const got: string[] = [];
    let release!: () => void;
    const held = new Promise<object>((r) => (release = () => r(result('all done'))));
    script.prompts = [];
    script.turns = [
      () => {
        expect(steer!({ prompt: 'use pnpm', promptId: 'p-steer', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'steer') })).toBe(true);
        return [text('working'), { ...text('switching to pnpm'), user_message_uuids: ['p-first', 'p-steer'] }, held];
      },
    ];
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ promptId: 'p-first', onSteer: (s) => void (steer = s) }));
    await vi.waitFor(() => expect(got).toEqual(['steer folded']));
    release();
    expect(await running).toBe('all done');
    expect(got).toEqual(['steer folded']);
  });

  it('a turn you started says a steered message was read when Claude Code takes it off its queue', async () => {
    let steer: ((f: FollowUp) => boolean) | undefined;
    const got: string[] = [];
    let release!: () => void;
    const held = new Promise<object>((r) => (release = () => r({ ...result('all done'), user_message_uuids: ['p-first', 'p-steer'] })));
    const lifecycle = (command_uuid: string, state: string) => ({ type: 'command_lifecycle', command_uuid, state, session_id: 's1' });
    script.prompts = [];
    script.turns = [
      () => {
        expect(steer!({ prompt: 'use pnpm', promptId: 'p-steer', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'steer') })).toBe(true);
        // As Claude Code sends it: later assistant frames of this turn never name the steered message.
        return [lifecycle('p-first', 'started'), { ...text('working'), user_message_uuids: ['p-first'] }, lifecycle('p-steer', 'queued'), text('still working'), lifecycle('p-steer', 'started'), text('switching to pnpm'), held];
      },
    ];
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ promptId: 'p-first', onSteer: (s) => void (steer = s) }));
    await vi.waitFor(() => expect(got).toEqual(['steer folded']));
    release();
    expect(await running).toBe('all done');
    expect(got).toEqual(['steer folded']);
  });

  it('a message steered in and taken off the queue between turns is a turn of its own, not read early', () => {
    const got: string[] = [];
    const turns = new TurnRouter({ onEvent: () => undefined });
    turns.current();
    turns.queue(route(got, 's'), 'us', true);
    turns.end(true, 'done', ['u0']);
    turns.read(['us']);
    turns.current();
    expect(got).toEqual(['s started']);
  });

  it('reads only a started command_lifecycle frame', () => {
    expect(startedPrompt({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })).toBe('u1');
    expect(startedPrompt({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' })).toBeUndefined();
    expect(startedPrompt({ type: 'command_lifecycle', state: 'started' })).toBeUndefined();
    expect(startedPrompt({ type: 'assistant', command_uuid: 'u1', state: 'started' })).toBeUndefined();
    expect(startedPrompt(null)).toBeUndefined();
  });

  it('offers steering while the run works, without stopping the turn', async () => {
    let steer: ((f: FollowUp) => boolean) | undefined;
    const got: string[] = [];
    script.prompts = [];
    script.turns = [
      () => {
        // Sent while Claude works; Claude Code says the turn took nothing of ours in, so it gets a turn next.
        expect(steer!({ prompt: 'use pnpm', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'steer') })).toBe(true);
        return [text('done'), { ...result('done'), user_message_uuids: [] }];
      },
      () => [text('switched to pnpm'), result('switched to pnpm')],
    ];
    const out = await createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ onSteer: (s) => void (steer = s) }));
    expect(out).toBe('done');
    expect(got).toEqual(['steer started', 'steer:switched to pnpm']);
    expect(script.prompts[1]).toContain('use pnpm');
    expect(steer).toBeUndefined(); // withdrawn once the run ended
  });
});

describe('interrupting a long tool for a message', () => {
  const route = (got: string[], name: string) => ({ onEvent: () => undefined, onStart: () => void got.push(`${name} started`), onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });
  it('stops the turn (it ends saying why) and answers the message in the next turn', async () => {
    let steer: Steer | undefined;
    const got: string[] = [];
    script.prompts = [];
    script.turns = [
      () => [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npx playwright test' } }] } },
        // The command runs until Claude Code is interrupted.
        new Promise<object>((resolve) => (script.interrupt = () => resolve({ ...result(''), subtype: 'error_during_execution' }))),
      ],
      () => [text('stopped the tests'), result('stopped the tests')],
    ];
    const input = runInput({ onSteer: (s) => void (steer = s) });
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    for (let i = 0; i < 50 && !steer?.status?.().tool; i++) await new Promise((r) => setTimeout(r, 5));
    expect(steer!.status!()).toMatchObject({ tool: { label: 'npx playwright test' }, between: false });
    const note = 'Interrupted: npx playwright test (12m) to read your message';
    expect(await steer!.interrupt!({ prompt: 'stop the tests', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'f') }, note)).toBe(true);
    expect(await running).toBe(note);
    expect(input.events).toContain(note);
    expect(got).toEqual(['f started', 'f:stopped the tests']);
    expect(script.prompts[1]).toContain('stop the tests');
    script.interrupt = undefined;
  });
});

describe('Send now: a steered message Claude hasn’t read yet, answered at once (BLG-54)', () => {
  const route = (got: string[], name: string) => ({ onEvent: () => undefined, onStart: () => void got.push(`${name} started`), onFolded: () => void got.push(`${name} folded`), onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });

  it('a message sent to be answered in its own turn isn’t taken as folded in when Claude Code doesn’t say', () => {
    const got: string[] = [];
    const turns = new TurnRouter({ onEvent: () => undefined });
    turns.current();
    turns.queue(route(got, 'a'), 'ua', true);
    expect(turns.unsteer('ua')).toBe(true);
    expect(turns.unsteer('nope')).toBe(false);
    turns.end(true, 'interrupted');
    expect(got).toEqual([]);
    turns.current();
    expect(got).toEqual(['a started']);
  });

  it('stops the step; the message, still in Claude Code’s queue, is the next turn, its own', async () => {
    let steer: Steer | undefined;
    const got: string[] = [];
    script.prompts = [];
    script.turns = [
      () => [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run test:all' } }] } },
        // The suite runs until Claude Code is interrupted; the turn took nothing of ours in.
        new Promise<object>((resolve) => (script.interrupt = () => resolve({ ...result(''), subtype: 'error_during_execution', user_message_uuids: [] }))),
      ],
      () => [text('looked at the retries'), result('looked at the retries')],
    ];
    const input = runInput({ onSteer: (s) => void (steer = s) });
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    for (let i = 0; i < 50 && !steer?.status?.().tool; i++) await new Promise((r) => setTimeout(r, 5));
    const followUp = { prompt: 'look at the retries first', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'f') };
    // Steered in: it waits for Claude's next step.
    expect(steer!(followUp)).toBe(true);
    const note = 'Interrupted: npm run test:all to read your message';
    expect(await steer!.force!(followUp, note)).toBe(true);
    expect(await running).toBe(note);
    expect(input.events).toContain(note);
    expect(got).toEqual(['f started', 'f:looked at the retries']);
    // Sent once: the message Claude reads next is the one already in its queue.
    expect(script.prompts).toHaveLength(2);
    expect(script.prompts[1]).toContain('look at the retries first');
    script.interrupt = undefined;
  });

  it('Claude Code took it in before it stopped: not taken as read, sent again and answered; exit 1 once let go is no crash', async () => {
    let steer: Steer | undefined;
    const got: string[] = [];
    script.prompts = [];
    const items = (): Array<{ uuid: string }> => (script.queue as { items: Array<{ uuid: string }> }).items;
    script.turns = [
      () => [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }] } },
        // Claude Code had read the steered message off its input; the stopped turn lists it.
        new Promise<object>((resolve) => (script.interrupt = () => resolve({ ...result(''), subtype: 'error_during_execution', user_message_uuids: items().splice(0).map((i) => i.uuid) }))),
      ],
      () => [text('on it'), result('on it')],
    ];
    // As Claude Code does when its last turn was stopped: exit 1 once its input ends.
    script.exitAfter = 'Claude Code process exited with code 1';
    const input = runInput({ onSteer: (s) => void (steer = s) });
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    for (let i = 0; i < 50 && !steer?.status?.().tool; i++) await new Promise((r) => setTimeout(r, 5));
    const followUp = { prompt: 'do the docs too', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'f') };
    expect(steer!(followUp)).toBe(true);
    const note = 'Interrupted: npm run build to read your message';
    expect(await steer!.force!(followUp, note)).toBe(true);
    expect(await running).toBe(note);
    expect(got).toEqual(['f started', 'f:on it']);
    expect(script.prompts[1]).toContain('do the docs too');
    script.interrupt = undefined;
    script.exitAfter = undefined;
  });

  it('nothing to force for a message the run never took as a steer', async () => {
    let steer: Steer | undefined;
    script.prompts = [];
    let end: (() => void) | undefined;
    script.turns = [() => [new Promise<object>((resolve) => (end = () => resolve(result('done'))))]];
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ onSteer: (s) => void (steer = s) }));
    for (let i = 0; i < 50 && !end; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await steer!.force!({ prompt: 'x', requesterName: 'kay', viaAgent: false, context: [], ...route([], 'x') }, 'n')).toBe(false);
    end!();
    expect(await running).toBe('done');
  });
});

describe('interrupting: the interrupted turn’s result comes late', () => {
  const route = (got: string[], name: string) => ({ onEvent: () => undefined, onStart: () => void got.push(`${name} started`), onFolded: () => void got.push(`${name} folded`), onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });
  /** The ids of the prompts sent but not read yet (what Claude Code could list in the result). */
  const unread = (): string[] => (script.queue as { items: Array<{ uuid: string }> }).items.map((i) => i.uuid);

  it('after the message was sent, even listing it: the message is still answered in its own turn', async () => {
    let steer: Steer | undefined;
    const got: string[] = [];
    script.prompts = [];
    script.turns = [
      () => [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
        // The interrupt returns at once; the turn's result only arrives once the message is in, and lists it.
        new Promise<object>((resolve) => (script.interrupt = () => void setTimeout(() => resolve({ ...result(''), subtype: 'error_during_execution', user_message_uuids: unread() }), 20))),
      ],
      () => [text('reading it now'), result('reading it now')],
    ];
    const input = runInput({ onSteer: (s) => void (steer = s) });
    const running = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    for (let i = 0; i < 50 && !steer?.status?.().tool; i++) await new Promise((r) => setTimeout(r, 5));
    const note = 'Interrupted: npm test (3m) to read your message';
    expect(await steer!.interrupt!({ prompt: 'stop that', requesterName: 'kay', viaAgent: false, context: [], ...route(got, 'f') }, note)).toBe(true);
    expect(unread()).toHaveLength(1);
    expect(await running).toBe(note);
    expect(got).toEqual(['f started', 'f:reading it now']);
    expect(script.prompts[1]).toContain('stop that');
    script.interrupt = undefined;
  });
});

describe('what a steer sees of the run', () => {
  it('says when Claude’s last word was thinking', async () => {
    let steer: Steer | undefined;
    const seen: object[] = [];
    // Looked at once Claude Code has said what came before.
    const later = (then: () => object, ms = 10): Promise<object> => new Promise((r) => setTimeout(r, ms)).then(then);
    script.turns = [
      () => [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
        later(() => (seen.push(steer!.status!()), text('ok'))),
        later(() => (seen.push(steer!.status!()), result('ok')), 20),
      ],
    ];
    await createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ onSteer: (s) => void (s && (steer = s)) }));
    expect(seen[0]).toMatchObject({ thinking: true });
    expect(seen[1]).not.toHaveProperty('thinking');
  });

  // Not on Windows: Windows has no signals to ignore: a kill is final.
  it.skipIf(process.platform === 'win32')('ends Claude Code for sure: SIGTERM, then SIGKILL when it ignores that', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000); console.log('up')"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => child.stdout.once('data', r));
    const t0 = Date.now();
    await endProcess(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await endProcess(child, 200); // already gone: nothing to do
  });
});

describe('sub-agents get a scratch folder of their own', () => {
  const preToolUse = (): HookCallback => script.options!.hooks!.PreToolUse![0]!.hooks[0]!;
  const call = async (tool_name: string, tool_input: object): Promise<unknown> => preToolUse()({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_01xyz0123456789', session_id: 's1', transcript_path: '', cwd: '' } as never, 'toolu_01xyz0123456789', { signal: new AbortController().signal });

  it('adds it to each launch’s prompt (and makes it), only when the run has a scratch folder', async () => {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-run-')));
    try {
      script.turns = [() => [text('ok'), result('ok')]];
      await createClaudeBackend({ cwd, autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ scratchDir: '.beluga/scratch' }));
      const out = (await call('Agent', { description: 'Check the UI', prompt: 'Look at it.' })) as { hookSpecificOutput: { permissionDecision: string; updatedInput: { prompt: string; description: string } } };
      const dir = path.join(cwd, '.beluga/scratch/agents/0123456789');
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(out.hookSpecificOutput.updatedInput.prompt).toContain(`Look at it.`);
      expect(out.hookSpecificOutput.updatedInput.prompt).toContain(`${dir}/`);
      expect(out.hookSpecificOutput.updatedInput.description).toBe('Check the UI');
      expect(existsSync(dir)).toBe(true);
      // Other tools go on as before.
      expect(((await call('TodoWrite', {})) as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();

      script.turns = [() => [text('ok'), result('ok')]];
      await createClaudeBackend({ cwd, autoEdit: false, additionalDirectories: [], bridge }).run(runInput());
      const plain = (await call('Agent', { description: 'x', prompt: 'Look.' })) as { hookSpecificOutput: { updatedInput?: unknown } };
      expect(plain.hookSpecificOutput.updatedInput).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
