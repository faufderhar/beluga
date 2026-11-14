import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_DECLINED, CHROME_OFF, chromeCard, chromeGate, chromeOffByFlags, chromeStep, isChromeTool } from '../src/agent/chrome.js';
import { claudeLaunch } from '../src/agent/runtime/claude/launch-args.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { HAND_MS, byYourHand, outsideYourHand, takeYourHand } from '../src/core/by-hand.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

/**
 * BLG-932: every Claude run gets Claude in Chrome. What you sent yourself uses it as usual; any
 * other run (a Sentinel firing, a friend, an external agent, a thread, a dialogue) asks you once
 * per request before its first Chrome step.
 */

const NAVIGATE = 'mcp__claude-in-chrome__navigate';
const CLICK = 'mcp__claude-in-chrome__computer';

describe('the Chrome gate of one run', () => {
  it('knows Claude in Chrome’s tools by their server', () => {
    expect(isChromeTool(NAVIGATE)).toBe(true);
    expect(isChromeTool('mcp__beluga__send_chat')).toBe(false);
    expect(isChromeTool('Bash')).toBe(false);
  });

  it('refuses every step on a run without Chrome', async () => {
    expect(await chromeGate(undefined)(NAVIGATE, {})).toEqual({ kind: 'deny', reason: CHROME_OFF });
  });

  it('leaves your own run’s steps to the usual rules, asking nothing', async () => {
    expect(await chromeGate({})(NAVIGATE, { url: 'https://github.com' })).toEqual({ kind: 'usual' });
  });

  it('asks once per request: a yes covers the later steps', async () => {
    const asked: string[] = [];
    const gate = chromeGate({ ask: async (tool) => (asked.push(tool), true) });
    expect(await gate(NAVIGATE, { url: 'https://github.com' })).toEqual({ kind: 'allow' });
    expect(await gate(CLICK, { action: 'left_click' })).toEqual({ kind: 'allow' });
    expect(asked).toEqual([NAVIGATE]);
  });

  it('shows one card for steps asked at the same moment', async () => {
    let calls = 0;
    let answer: (yes: boolean) => void = () => undefined;
    const gate = chromeGate({ ask: () => (calls++, new Promise<boolean>((resolve) => (answer = resolve))) });
    const both = Promise.all([gate(NAVIGATE, {}), gate(CLICK, {})]);
    answer(true);
    expect(await both).toEqual([{ kind: 'allow' }, { kind: 'allow' }]);
    expect(calls).toBe(1);
  });

  it('after a no, refuses the rest of the request without asking again', async () => {
    let calls = 0;
    const gate = chromeGate({ ask: async () => (calls++, false) });
    expect(await gate(NAVIGATE, {})).toEqual({ kind: 'deny', reason: CHROME_DECLINED });
    expect(await gate(CLICK, {})).toEqual({ kind: 'deny', reason: CHROME_DECLINED });
    expect(calls).toBe(1);
  });

  it('takes a card that failed as a no', async () => {
    const gate = chromeGate({ ask: () => Promise.reject(new Error('gone')) });
    expect((await gate(NAVIGATE, {})).kind).toBe('deny');
  });

  it('says in a few words what the first step does', () => {
    expect(chromeStep(NAVIGATE, { url: 'https://github.com/pulls' })).toBe('open github.com/pulls');
    expect(chromeStep('mcp__claude-in-chrome__javascript_tool', {})).toBe('run JavaScript on a page');
    expect(chromeStep('mcp__claude-in-chrome__tabs_context_mcp', {})).toBe('look at and open tabs');
    const card = chromeCard('Your agent (in a Sentinel run)', NAVIGATE, { url: 'https://mail.google.com' });
    expect(card.title).toBe('Your agent (in a Sentinel run) wants to use your Chrome: open mail.google.com');
    expect(card.detail).toContain('rest of this request');
  });
});

describe('the launch flag', () => {
  it('passes --chrome to a run that has Chrome', () => {
    expect(claudeLaunch([], { plan: false, autoEdit: true, chrome: true }).extraArgs).toEqual({ chrome: null });
    expect(claudeLaunch([], { plan: false, autoEdit: true }).extraArgs).toEqual({});
  });

  it('never connects a run without it, whatever your flags asked', () => {
    expect(claudeLaunch(['--chrome'], { plan: false, autoEdit: true, chrome: false }).extraArgs).toEqual({});
  });

  it('keeps your --no-chrome', () => {
    expect(claudeLaunch(['--no-chrome'], { plan: false, autoEdit: true, chrome: true }).extraArgs).toEqual({ 'no-chrome': null });
    expect(chromeOffByFlags(['--model', 'opus', '--no-chrome'])).toBe(true);
    expect(chromeOffByFlags(['--chrome'])).toBe(false);
    expect(chromeOffByFlags(undefined)).toBe(false);
  });
});

describe('what you sent yourself', () => {
  it('marks the one request carrying your words, once', () => {
    byYourHand('@claude  fix the\ntest', () => {
      expect(takeYourHand('fix the test')).toBe(true);
      expect(takeYourHand('fix the test')).toBe(false);
    });
  });

  it('marks a command that wraps what you typed', () => {
    byYourHand('the login flow', () => expect(takeYourHand('Draw a diagram of: the login flow')).toBe(true));
  });

  it('never marks other words, a request outside your action, or one that comes too late', () => {
    byYourHand('fix the test', () => expect(takeYourHand('check the deploy')).toBe(false));
    expect(takeYourHand('fix the test')).toBe(false);
    const sent = Date.now();
    byYourHand('fix the test', () => expect(takeYourHand('fix the test', sent + HAND_MS + 1)).toBe(false), sent);
  });

  it('reaches a request after an await (a new worktree’s first message)', async () => {
    await byYourHand('add a page', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(takeYourHand('add a page')).toBe(true);
    });
  });

  it('never reaches into a run', () => {
    byYourHand('fix the test', () => outsideYourHand(() => expect(takeYourHand('fix the test')).toBe(false)));
  });
});

const ME = 'me';
const CHANNEL = 'ws:tree';
const SENTINEL = 'ws:sentinel-run';

function setup(opts: { claudeArgs?: string[] } = {}) {
  const store = new Store(initialState('room', 'auto'));
  if (opts.claudeArgs) store.dispatch({ type: 'prefs', prefs: { claudeArgs: opts.claudeArgs } });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-chrome-'));
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
  };
  const place = () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined });
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    sentinel: (channel) => ({ tools: {} as never, brief: 'watch', inRun: channel === SENTINEL }),
  });
  let n = 0;
  const ask = async (o: { typed?: boolean; channel?: string } = {}): Promise<AgentRunInput> => {
    const requestId = `r${++n}`;
    if (o.typed) host.markYours(requestId);
    const before = runs.length;
    await host.onAgentRequest(ME, { kind: 'agent_request', requestId, prompt: 'look at my pull requests', viaAgent: false, channel: o.channel ?? CHANNEL, urgent: false, plan: false });
    await waitFor(() => runs.length > before);
    return runs.at(-1)!;
  };
  return { ask, store, host };
}

describe('Chrome on your agent’s runs', () => {
  it('a message you sent yourself uses it as usual', async () => {
    const run = await setup().ask({ typed: true });
    expect(run.chrome).toEqual({});
  });

  it('one Beluga sent for you (a thread, a plan’s step, a follow-up) asks you first, with no Always', async () => {
    const { ask, store, host } = setup();
    const run = await ask();
    expect(run.chrome?.ask).toBeTypeOf('function');
    const answer = run.chrome!.ask!(NAVIGATE, { url: 'https://github.com/pulls' });
    await waitFor(() => store.getState().approvals.length > 0);
    const card = store.getState().approvals.at(-1)!;
    expect(card.title).toBe('Your agent wants to use your Chrome: open github.com/pulls');
    expect(card.once).toBe(true);
    host.answerApproval('yes', card.id);
    expect(await answer).toBe(true);
  });

  it('a Sentinel run asks you first, even one you started', async () => {
    const { ask, store, host } = setup();
    const run = await ask({ typed: true, channel: SENTINEL });
    const answer = run.chrome!.ask!(NAVIGATE, {});
    await waitFor(() => store.getState().approvals.length > 0);
    const card = store.getState().approvals.at(-1)!;
    expect(card.title).toContain('in a Sentinel run');
    host.answerApproval('no', card.id);
    expect(await answer).toBe(false);
  });

  it('none at all when your launch flags say --no-chrome', async () => {
    const run = await setup({ claudeArgs: ['--no-chrome'] }).ask({ typed: true });
    expect(run.chrome).toBeUndefined();
  });

  it('a dialogue’s turn asks you first', async () => {
    const { host } = setup();
    let got: AgentRunInput | undefined;
    const backend: AgentBackend = {
      async run(input) {
        got = input;
        return 'ok';
      },
    };
    await host.runDialogueTurn(CHANNEL, backend, { prompt: 'talk', signal: new AbortController().signal });
    expect(got?.chrome?.ask).toBeTypeOf('function');
  });
});
