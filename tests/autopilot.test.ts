import { describe, expect, it } from 'vitest';
import type { ClaudeAnswer, ClaudeQuestion } from '../src/protocol.js';
import { AutopilotStandIn } from '../src/core/autopilot/stand-in.js';
import { autopilotIn, jsonOf, readApproval, readPlan, readQuestion, standsInFor } from '../src/core/autopilot/model.js';
import type { Plan } from '../src/core/plans/model.js';
import { type Approval, Store, initialState } from '../src/core/store.js';
import { createMockBackend } from '../src/agent/mock.js';

/** BLG-981: Full Autopilot — a stand-in agent answers what your agent would ask you, so nothing waits on you. */

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ASKED: Extract<ClaudeQuestion, { kind: 'question' }> = {
  kind: 'question',
  questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: '' }, { label: 'Postgres (Recommended)', description: 'Scales' }] }],
};

function setup(reply: (prompt: string) => Promise<string> | string = () => '{}') {
  const store = new Store(initialState('room'));
  const answered: Array<{ qid: string; answer: ClaudeAnswer }> = [];
  const approvals: Array<{ id: string; answer: 'yes' | 'no' }> = [];
  const prompts: string[] = [];
  const approved: string[] = [];
  const told: string[] = [];
  const standIn = new AutopilotStandIn({
    store,
    selfId: () => 'me',
    ask: async ({ prompt }) => {
      prompts.push(prompt);
      return reply(prompt);
    },
    answerQuestion: (qid, answer) => {
      answered.push({ qid, answer });
      store.dispatch({ type: 'question_remove', qid });
    },
    answerApproval: (id, answer) => {
      approvals.push({ id, answer });
      store.dispatch({ type: 'approval_remove', id });
    },
    approvePlan: (id) => void approved.push(id),
    tell: (_c, text) => void told.push(text),
    delayMs: 0,
  });
  const ask = (channel: string, question: ClaudeQuestion = ASKED, owner = 'me', qid = `q-${Math.random()}`): string => {
    store.dispatch({ type: 'question_add', question: { qid, requestId: 'r', owner, channel, question, picked: {} } });
    return qid;
  };
  const approval = (a: Partial<Approval> & { id: string }): void => store.dispatch({ type: 'approval_add', approval: { kind: 'tool', title: 'Use the phone', detail: '', channel: 'ws:a', ...a } as Approval });
  const lines = (channel: string): string[] => store.getState().log.filter((l) => l.type === 'system' && l.channel === channel).map((l) => (l as { text: string }).text);
  return { store, standIn, answered, approvals, prompts, approved, told, ask, approval, lines };
}

describe('what the stand-in answers', () => {
  it('a question in a chat on Full Autopilot: the stand-in’s pick, and a line saying what and why', async () => {
    const t = setup(() => '```json\n{"answers": {"Which database?": "SQLite"}, "why": "The app is small and runs on one machine."}\n```');
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.store.dispatch({ type: 'chat', id: 'm1', channel: 'ws:a', from: 'me', text: 'Keep it tiny, one machine.', ts: 1, byAgent: false });
    const qid = t.ask('ws:a');
    await tick(5);
    expect(t.answered).toEqual([{ qid, answer: { kind: 'answers', answers: { 'Which database?': 'SQLite' } } }]);
    expect(t.prompts[0]).toContain('User: Keep it tiny, one machine.');
    expect(t.lines('ws:a').at(-1)).toBe('Autopilot answered “SQLite” for you. Why: The app is small and runs on one machine.');
    t.standIn.stop();
  });

  it('leaves a chat that isn’t on Full Autopilot alone, and a friend’s Claude’s question too', async () => {
    const t = setup();
    t.ask('ws:b');
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.ask('ws:a', ASKED, 'friend');
    await tick(5);
    expect(t.answered).toEqual([]);
    expect(t.prompts).toEqual([]);
    t.standIn.stop();
  });

  it('a plan to approve: approves it, or sends what to change', async () => {
    const t = setup((p) => (p.includes('rewrite everything') ? '{"approve": false, "changes": "Keep the old API", "why": "You said not to break clients."}' : '{"approve": true, "why": "It covers the goal."}'));
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    const ok = t.ask('ws:a', { kind: 'plan', plan: '1. add a column' });
    const no = t.ask('ws:a', { kind: 'plan', plan: '1. rewrite everything' });
    await tick(5);
    expect(t.answered).toContainEqual({ qid: ok, answer: { kind: 'plan', approve: true, feedback: '' } });
    expect(t.answered).toContainEqual({ qid: no, answer: { kind: 'plan', approve: false, feedback: 'Keep the old API' } });
    t.standIn.stop();
  });

  it('your own agent’s tool approval: allowed or declined as the stand-in says', async () => {
    const t = setup(() => '{"allow": true, "why": "It only reads the screen."}');
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.approval({ id: 'a1' });
    await tick(5);
    expect(t.approvals).toEqual([{ id: 'a1', answer: 'yes' }]);
    expect(t.lines('ws:a').at(-1)).toContain('Autopilot allowed “Use the phone” for you');
    t.standIn.stop();
  });

  it('a secret, a friend’s request or an outside agent’s ask still waits for you, and the chat says why once', async () => {
    const t = setup(() => '{"allow": true}');
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.approval({ id: 's1', kind: 'secret', title: 'Read .env' });
    t.approval({ id: 'f1', kind: 'request', title: 'Bob asks', peer: 'bob' });
    t.approval({ id: 'x1', kind: 'tool', title: 'Run', asker: 'Cursor' });
    await tick(5);
    t.standIn.look();
    expect(t.approvals).toEqual([]);
    expect(t.store.getState().approvals.map((a) => a.id)).toEqual(['s1', 'f1', 'x1']);
    const said = t.lines('ws:a');
    expect(said.filter((l) => l.includes('Read .env'))).toEqual(['Autopilot is waiting on you for “Read .env”: a secret is always yours to share.']);
    expect(said.some((l) => l.includes('a friend’s request is always yours'))).toBe(true);
    expect(said.some((l) => l.includes('Cursor is an outside agent'))).toBe(true);
    t.standIn.stop();
  });

  it('when the stand-in can’t answer, it still never stops: the agent’s own pick, and it says so', async () => {
    const t = setup(() => Promise.reject(new Error('no agent here could answer')));
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.ask('ws:a');
    t.approval({ id: 'a1' });
    t.approval({ id: 'c1', kind: 'chain', title: 'Limit reached' });
    await tick(5);
    expect(t.answered[0]!.answer).toEqual({ kind: 'answers', answers: { 'Which database?': 'Postgres (Recommended)' } });
    // A tool it couldn't judge is declined (the safe way); the agents' conversation goes on.
    expect(t.approvals).toEqual([
      { id: 'a1', answer: 'no' },
      { id: 'c1', answer: 'yes' },
    ]);
    expect(t.lines('ws:a').find((l) => l.includes('Postgres'))).toMatch(/^Autopilot couldn’t reach its stand-in \(no agent here could answer\), so it answered “Postgres \(Recommended\)”/);
    t.standIn.stop();
  });

  it('turned off while the stand-in thinks: its answer is dropped, the card stays for you', async () => {
    let answer!: (s: string) => void;
    const t = setup(() => new Promise((r) => (answer = r)));
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    const qid = t.ask('ws:a');
    await tick(5);
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: false });
    answer('{"answers": {"Which database?": "SQLite"}}');
    await tick(5);
    expect(t.answered).toEqual([]);
    expect(t.store.getState().questions.map((q) => q.qid)).toEqual([qid]);
    t.standIn.stop();
  });

  it('on a plan: answers a decision the plan wrote options for, and leaves a task only you can do to you', async () => {
    const t = setup(() => '{"answers": {}, "why": "Matches the goal."}');
    const body = {
      title: 'Payments',
      goal: 'Take payments',
      milestones: [
        {
          id: 'm1',
          title: 'Setup',
          criteria: [],
          tasks: [
            { id: 'keys', title: 'Add the live Stripe keys', acceptance: [], blockedBy: [], assignee: 'me' as const },
            { id: 'db', title: 'Pick the database', acceptance: [], blockedBy: [], assignee: 'me' as const, decision: { question: 'Which?', options: [{ label: 'Postgres (Recommended)' }, { label: 'SQLite' }] } },
          ],
        },
      ],
    };
    const plan = { id: 'p', projectId: 'x', home: 'ws:home', status: 'active', body, draftRev: 1, autonomy: 'autopilot', fullAuto: true, maxParallel: 2, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 0, updatedAt: 0 } as Plan;
    t.store.dispatch({ type: 'plans_init', state: { enabled: true, plans: [plan], style: '' } });
    const card = (task: string, label: string): Extract<ClaudeQuestion, { kind: 'question' }> => ({ kind: 'question', questions: [{ question: task, header: 'Your call', multiSelect: false, options: [{ label, description: '' }, { label: 'Not needed', description: '' }] }] });
    t.ask('ws:home', card('Add the live Stripe keys', 'Done'), 'me', 'decide:p:keys');
    t.ask('ws:home', card('Pick the database', 'Postgres (Recommended)'), 'me', 'decide:p:db');
    await tick(5);
    expect(t.answered.map((a) => a.qid)).toEqual(['decide:p:db']);
    expect(t.store.getState().questions.map((q) => q.qid)).toEqual(['decide:p:keys']);
    expect(t.lines('ws:home')).toContain('Autopilot is waiting on you for “Add the live Stripe keys”: a task only you can do is yours to finish.');
    t.standIn.stop();
  });

  it('the mock agent’s stand-in (the demo) goes with the recommended option', async () => {
    const agent = createMockBackend({} as never, 0);
    const t = setup(async (prompt) => agent.standIn!({ prompt, system: '' }));
    t.store.dispatch({ type: 'autopilot', channel: 'ws:a', on: true });
    t.ask('ws:a');
    await tick(20);
    expect(t.answered[0]!.answer).toEqual({ kind: 'answers', answers: { 'Which database?': 'Postgres (Recommended)' } });
    t.standIn.stop();
  });
});

describe('which conversations are on Full Autopilot', () => {
  const plan = (patch: Partial<Plan> = {}): Plan => ({ id: 'p', projectId: 'x', home: 'ws:home', status: 'active', draftRev: 1, autonomy: 'autopilot', fullAuto: true, maxParallel: 2, testsAt: 'milestone', paused: false, runs: { m1: { agent: { worktree: 'w1', at: 0, tasks: [] }, checker: 'chk' } }, review: { rev: 1, at: 0, state: 'done', findings: [], chat: 'rev' }, activity: [], createdAt: 0, updatedAt: 0, ...patch }) as Plan;
  const state = (plans: Plan[], autopilot: Record<string, boolean> = {}) => ({ plans: { enabled: true, plans, style: '' }, board: { enabled: true, issues: [{ id: 'i1', plan: { id: 'p', milestone: 'm1', task: 't' }, worktrees: ['tw'] }], projects: {}, autoTasks: false }, autopilot }) as never;

  it('a plan’s own conversation, its milestone worktrees, its checkers, its review and its tasks’ worktrees', () => {
    const s = state([plan()]);
    for (const c of ['ws:home', 'ws:w1', 'ws:chk', 'ws:rev', 'ws:tw']) expect(autopilotIn(s, c)?.plan?.id).toBe('p');
    expect(autopilotIn(s, 'ws:other')).toBeUndefined();
  });

  it('not a plan off Full Autopilot, a finished one, or one that moved away', () => {
    for (const p of [plan({ fullAuto: undefined }), plan({ status: 'done' }), plan({ movedTo: { name: 'Mini', at: 0 } })]) expect(autopilotIn(state([p]), 'ws:home')).toBeUndefined();
  });

  it('a chat turned on by itself', () => {
    expect(autopilotIn(state([], { 'ws:chat': true }), 'ws:chat')).toEqual({});
  });
});

describe('reading the stand-in', () => {
  it('finds the JSON in prose and fences, and nothing in nonsense', () => {
    expect(jsonOf('Sure!\n```json\n{"allow": true}\n```')).toEqual({ allow: true });
    expect(jsonOf('no idea')).toBeUndefined();
    expect(jsonOf('{bad json}')).toBeUndefined();
  });

  it('approves a plan unless it asks for changes in words', () => {
    expect(readPlan('{"approve": false}').answer).toEqual({ kind: 'plan', approve: true, feedback: '' });
    expect(readPlan(undefined).said).toBe('approved the plan');
  });

  it('fills a question it skipped with the agent’s recommended option', () => {
    const two: typeof ASKED = { kind: 'question', questions: [...ASKED.questions, { question: 'Port?', header: '', multiSelect: false, options: [] }] };
    expect(readQuestion('{"answers": {"Which database?": "SQLite"}}', two).answer).toEqual({ kind: 'answers', answers: { 'Which database?': 'SQLite', 'Port?': 'Use your best judgment and say what you assumed.' } });
  });

  it('only your own agent’s tool and chain asks are the stand-in’s', () => {
    const a = (p: Partial<Approval>): Approval => ({ id: 'x', kind: 'tool', title: 't', detail: '', ...p });
    expect(standsInFor(a({}), 'me')).toBe(true);
    expect(standsInFor(a({ kind: 'chain' }), 'me')).toBe(true);
    expect(standsInFor(a({ peer: 'me' }), 'me')).toBe(true);
    expect(standsInFor(a({ kind: 'secret' }), 'me')).toBe(false);
    expect(standsInFor(a({ kind: 'request' }), 'me')).toBe(false);
    expect(standsInFor(a({ peer: 'bob' }), 'me')).toBe(false);
    expect(standsInFor(a({ task: 't1' }), 'me')).toBe(false);
    expect(standsInFor(a({ asker: 'Cursor' }), 'me')).toBe(false);
    expect(readApproval('{}', a({})).answer).toBe('no');
    expect(readApproval('{}', a({ kind: 'chain' })).answer).toBe('yes');
  });
});
