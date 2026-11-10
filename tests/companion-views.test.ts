import { describe, expect, it } from 'vitest';
import { FileServer, RefTable } from '../src/companion/files.js';
import { ChatsView, ChatView, ConvView, DashboardView, HomeView, PeopleView, PlansView, PlanView, SentinelPageView, SentinelsView, TaskPageView, TasksView, type Topic, WidgetsView, WorkView, viewSchema } from '../src/companion/protocol.js';
import { type ViewContext, convTurns, homeView, needsYou, sentinelDone, viewOf } from '../src/companion/views.js';
import { NO_SENTINEL, type Sentinel, type SentinelState } from '../src/core/sentinel/model.js';
import { type Action, type DomainState, Store, initialState } from '../src/core/store.js';
import type { Plan } from '../src/core/plans/model.js';
import { createDialogue } from '../src/core/dialogues/model.js';
import type { Issue } from '../src/core/board/model.js';

/**
 * What the phone sees of a Mac in a known state: every view checked against its zod schema, and
 * snapshotted so a change to what the phone shows shows up in review (docs/companion.md,
 * "Staying in step"). There is no pure demo-state builder, so the state is built here the way the
 * daemon builds it: by dispatching actions.
 */

const ME = 'me0000000000000000000000000000me';
const BOB = 'bob00000000000000000000000000bob';
const ZOE = 'zoe00000000000000000000000000zoe';
const GROUP = 'c'.repeat(32);
const T0 = 1_760_000_000_000;

function workspace(id: string, name: string, root: string) {
  return { id, projectRoot: root, projectId: 'p1', name, path: `${root}/.worktrees/${id}`, kind: 'worktree', createdAt: T0, external: false };
}

const plan: Plan = {
  id: 'pl_auth',
  projectId: 'p1',
  home: 'ws:w1',
  status: 'draft',
  draft: {
    title: 'Add auth',
    goal: 'Protect the payment routes',
    milestones: [{ id: 'm1', title: 'Sessions', criteria: ['Logged-out users get 401'], tasks: [{ id: 't1', title: 'requireUser middleware', acceptance: ['tests pass'], blockedBy: [] }] }],
  },
  draftRev: 3,
  autonomy: 'gated',
  maxParallel: 2,
  testsAt: 'milestone',
  paused: false,
  runs: {},
  activity: [],
  createdAt: T0,
  updatedAt: T0 + 50,
} as unknown as Plan;

function issue(id: string, key: string, title: string, status: Issue['status'], extra: Partial<Issue> = {}): Issue {
  const by = { kind: 'person' as const, id: ME, name: 'kayra' };
  return {
    id,
    key,
    number: Number(key.split('-')[1]),
    projectId: 'p1',
    title,
    status,
    priority: 'medium',
    labels: [],
    blockedBy: [],
    related: [],
    rank: Number(key.split('-')[1]),
    brief: {
      goal: 'Only signed-in users pay:\n\n```ts\nrequireUser()\n```',
      acceptance: '- [x] Logged-out users get 401\n- [ ] The e2e passes — deferred: suites run at the end\n- [ ] Docs updated',
    },
    revisions: [],
    worktrees: [],
    proof: [],
    activity: [
      { id: `${id}-a1`, at: T0 + 1, by, kind: 'created', text: 'created this' },
      { id: `${id}-a2`, at: T0 + 2, by: { kind: 'claude', owner: ME, ownerName: 'kayra' }, kind: 'comment', text: 'commented', body: 'Done, see:\n```ts\nx()\n```' },
    ],
    createdAt: T0,
    updatedAt: T0 + 2,
    createdBy: by,
    origin: 'manual',
    ...extra,
  };
}

const sentinel = (id: string, name: string, extra: Partial<Sentinel> = {}): Sentinel => ({
  id,
  name,
  icon: 'calendar',
  projectId: 'p1',
  trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
  steps: [],
  access: 'look',
  limits: { minutes: 30, pauseAfter: 3 },
  notify: 'both',
  paused: false,
  failures: 0,
  createdAt: T0,
  updatedAt: T0,
  ...extra,
});

/** Sentinel (docs/sentinel.md): a morning brief that ran, and a fix waiting for your Merge. */
const SENTINELS: SentinelState = {
  ...NO_SENTINEL,
  enabled: true,
  items: [
    sentinel('sn_brief', 'Morning brief', { steps: [{ id: 's1', kind: 'claude', name: 'Read what changed', where: 'project', prompt: 'Write my brief' }, { id: 's2', kind: 'notify', name: 'Tell me', phone: true }] }),
    sentinel('sn_fix', 'Fix what broke', {
      icon: 'wrench',
      access: 'ship',
      trigger: { kind: 'manual' },
      steps: [
        { id: 'f1', kind: 'claude', name: 'Find and fix it', where: 'worktree', prompt: 'Fix it' },
        { id: 'f2', kind: 'pr', name: 'Open a pull request' },
        { id: 'f3', kind: 'merge', name: 'Merge if acceptable', require: { checks: true, approval: true }, method: 'squash' },
      ],
    }),
  ],
  runs: [
    { id: 'run_b1', sentinelId: 'sn_brief', by: 'schedule', trigger: { kind: 'schedule', summary: 'Every day at 7:00' }, state: 'done', startedAt: T0 + 50, endedAt: T0 + 60, headline: '3 commits landed, CI is **green**', steps: [{ id: 's1', state: 'done' }, { id: 's2', state: 'done' }], tasks: [], report: '/Users/k/.beluga/sentinel/runs/run_b1/report.md' },
    {
      id: 'run_f1',
      sentinelId: 'sn_fix',
      by: 'event',
      trigger: { kind: 'manual', summary: 'CI failed on main' },
      state: 'needs-you',
      startedAt: T0 + 70,
      headline: 'Merge the fix for #48?',
      steps: [{ id: 'f1', state: 'done' }, { id: 'f2', state: 'done' }, { id: 'f3', state: 'running', startedAt: T0 + 75, why: 'Checks passed · Claude’s review: ship, a two-line fix with a test' }],
      pr: { number: 53, url: 'https://github.com/acme/landing/pull/53' },
      tasks: [],
    },
  ],
  live: { run_f1: { stepId: 'f3', state: 'needs-you' } },
  nextAt: { sn_brief: T0 + 86_400_000 },
  // Numbers (§10): the brief keeps open issues; a deleted sentinel's tile says gone.
  metrics: {
    sn_brief: {
      issues: { sentinelId: 'sn_brief', name: 'issues', label: 'Open issues', unit: 'count', better: 'down', kind: 'number', points: [{ at: T0 - 7 * 86_400_000, value: 14, runId: 'run_b0' }, { at: T0 - 86_400_000, value: 12, runId: 'run_b0' }, { at: T0 + 60, value: 9, runId: 'run_b1' }] },
      revenue: { sentinelId: 'sn_brief', name: 'revenue', label: 'Revenue', unit: 'currency:USD', better: 'up', kind: 'number', points: [{ at: T0 + 60, value: 3400, runId: 'run_b1' }] },
      jobs: { sentinelId: 'sn_brief', name: 'jobs', label: 'Last jobs', unit: 'count', better: 'none', kind: 'rows', points: [{ at: T0 + 60, value: 2, runId: 'run_b1' }], rows: [{ who: 'lena', job: 'deploy' }, { who: 'bob', job: 'tests' }], columns: ['who', 'job'], rowsAt: T0 + 60 },
    },
  },
  dashboards: [
    {
      id: 'db_rev',
      name: 'Revenue',
      compare: 'previous',
      tiles: [
        { id: 't1', kind: 'number', width: 1, metric: { sentinelId: 'sn_brief', metric: 'issues' }, compare: 'week' },
        { id: 't2', kind: 'number', width: 1, metric: { sentinelId: 'sn_brief', metric: 'revenue' } },
        { id: 't3', kind: 'series', width: 3, chart: 'line', metrics: [{ sentinelId: 'sn_brief', metric: 'issues' }] },
        { id: 't4', kind: 'table', width: 3, metric: { sentinelId: 'sn_brief', metric: 'jobs' } },
        { id: 't5', kind: 'text', width: 2, sentinelId: 'sn_brief', text: 'headline' },
        { id: 't6', kind: 'number', width: 1, metric: { sentinelId: 'sn_gone', metric: 'x' } },
        { id: 't7', kind: 'divider', width: 3, title: 'Money' },
      ],
      createdAt: T0,
      updatedAt: T0,
    },
  ],
  refreshing: { db_rev: { done: 1, total: 2, sentinelId: 'sn_brief' } },
};

function demoState(): DomainState {
  const store = new Store(initialState('kayra’s room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'welcome', self: { peerId: ME, name: 'kayra', shares: [], agent: true, usage: { plan: 'max', fiveHour: { pct: 12, resetsAt: T0 + 3_600_000 }, week: { pct: 38 }, updatedAt: T0 } } });
  run({ type: 'projects', projects: [{ id: 'p1', name: 'landing', root: '/Users/k/landing', base: 'main', workspaces: [{ ...workspace('p1:main', 'landing', '/Users/k/landing'), kind: 'main', path: '/Users/k/landing', askOnly: true }, workspace('w1', 'auth', '/Users/k/landing'), workspace('w2', 'tests', '/Users/k/landing')] }] as never });
  // Your Mac (BLG-47): you asked for a screenshot and a worktree; its answer names what it started.
  run({ type: 'chat', id: 'ca1', from: ME, text: 'Take a screenshot and start a worktree in landing for the login bug', ts: T0 + 7, byAgent: false, channel: 'mac:assistant' });
  run({ type: 'agent_event', owner: ME, requestId: 'ra1', requester: ME, event: 'started', text: '', ts: T0 + 8, channel: 'mac:assistant', itemId: 'i-ra1' });
  run({ type: 'agent_event', owner: ME, requestId: 'ra1', requester: ME, event: 'tool', text: 'mcp__beluga_mac__screenshot', ts: T0 + 8, channel: 'mac:assistant', itemId: 'i-ra1' });
  run({ type: 'agent_event', owner: ME, requestId: 'ra1', requester: ME, event: 'done', text: 'Here’s your screen. I started `worktree:w1` for the login bug.', ts: T0 + 9, channel: 'mac:assistant', itemId: 'i-ra1' });
  // ws:w1: you asked, Claude answered with code in it.
  run({ type: 'chat', id: 'c1', from: ME, text: 'How do we protect the payment routes?', ts: T0 + 1, byAgent: false, channel: 'ws:w1' });
  const ev = (event: Extract<Action, { type: 'agent_event' }>['event'], text: string, ts: number, channel: string, requestId: string): void =>
    run({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts, channel, itemId: `i-${requestId}` });
  ev('started', '', T0 + 2, 'ws:w1', 'r1');
  ev('tool', 'Read src/server.ts', T0 + 3, 'ws:w1', 'r1');
  ev('tool', 'Edit src/auth.ts', T0 + 4, 'ws:w1', 'r1');
  ev('text', 'Add a middleware:\n\n```ts\nexport function requireUser() {}\n```\n\nThen protect `/api/payments`.', T0 + 5, 'ws:w1', 'r1');
  ev('done', '', T0 + 6, 'ws:w1', 'r1');
  // ws:w2: Claude is running the tests, with a sub-agent at work.
  ev('started', '', T0 + 10, 'ws:w2', 'r2');
  ev('sub', JSON.stringify({ id: 'sa1', phase: 'start', title: 'Check the webhooks' }), T0 + 11, 'ws:w2', 'r2');
  ev('sub', JSON.stringify({ id: 'sa1', phase: 'step', step: 'Grep "retry"' }), T0 + 12, 'ws:w2', 'r2');
  ev('tool', 'Bash npm test -- --run', T0 + 13, 'ws:w2', 'r2');
  ev('progress', '137/215', T0 + 14, 'ws:w2', 'r2');
  // A message of yours waits its turn behind that run.
  ev('queued', 'Then update the **docs**', T0 + 16, 'ws:w2', 'r3');
  // Claude Code watches w2's session: its sub-agent's live step, and a helper that sub-agent started.
  run({
    type: 'claude_code',
    sessions: [
      {
        id: 'ccs1',
        title: 'tests',
        cwd: '/Users/k/landing/.worktrees/w2',
        projectId: 'p1',
        workspaceId: 'w2',
        status: 'working',
        lastAt: T0 + 14,
        steps: 5,
        own: true,
        agents: [
          { id: 'ag1', toolUseId: 'sa1', description: 'Check the webhooks', type: 'general-purpose', background: false, status: 'running', startedAt: T0 + 11, lastAt: T0 + 13, step: 'Reading src/hooks/retry-queue.ts', steps: 4 },
          { id: 'ag2', description: 'Look at the retry queue', type: 'Explore', background: false, status: 'running', startedAt: T0 + 12, lastAt: T0 + 13, step: 'Running npx vitest run tests/retry.test.ts', steps: 2, parentAgentId: 'ag1' },
        ],
      },
    ],
  });
  // The board: tasks in two states, one with a worktree, a brief and a comment.
  run({ type: 'board_init', state: { enabled: true, autoTasks: false, projects: { p1: { prefix: 'LND', next: 3 } }, issues: [issue('i1', 'LND-1', 'Protect the payment routes', 'in_review', { worktrees: ['w1'] }), issue('i2', 'LND-2', 'Retry failed webhooks', 'todo', { priority: 'high', assignee: { kind: 'person', id: ME, name: 'kayra' } })] } });
  // What waits for you.
  run({ type: 'approval_add', approval: { id: 'ap1', kind: 'tool', title: 'Run rm -rf dist?', detail: 'Bash rm -rf dist', askedAt: T0 + 15, timeoutMs: 60_000, channel: 'ws:w2' } });
  run({
    type: 'question_add',
    question: { qid: 'q1', requestId: 'r1', owner: ME, channel: 'ws:w1', picked: {}, question: { kind: 'question', questions: [{ question: 'Which session store?', header: 'Store', options: [{ label: 'Redis', description: 'fast' }, { label: 'Postgres', description: 'already there' }], multiSelect: false }] } },
  });
  run({
    type: 'gw_init',
    state: {
      enabled: true,
      note: '',
      rules: [],
      capabilities: initialState('x').gateway.capabilities,
      cards: { [BOB]: { trust: 'trusted', offers: ['screen', 'shell'], projects: [], claude: true, at: T0 } },
      tasks: [
        { id: 't_confirm000001', direction: 'sent', peerId: BOB, peerName: 'bob', kind: 'ask', ask: 'Can you review the landing page?', needs: [], by: 'agent', conversation: 'ws:w1', state: 'confirm', steps: [], createdAt: T0 + 20, updatedAt: T0 + 20 },
        {
          id: 't_screen000001',
          direction: 'sent',
          peerId: BOB,
          peerName: 'bob',
          kind: 'ask',
          ask: 'Take a screenshot of your desktop',
          summary: 'take a screenshot of your desktop',
          needs: ['screen'],
          by: 'person',
          state: 'done',
          steps: ['mcp__beluga__screenshot'],
          result: { status: 'done', summary: 'Here it is.', files: [{ name: 'desktop.png', size: 4096, path: '/Users/k/.beluga/tasks/files/t_screen000001/desktop.png', image: true }], log: [] },
          createdAt: T0 + 22,
          updatedAt: T0 + 24,
          startedAt: T0 + 23,
          endedAt: T0 + 24,
        },
        { id: 't_request00001', direction: 'received', peerId: BOB, peerName: 'bob', kind: 'run', ask: 'Run the e2e suite', summary: 'run the e2e suite', needs: ['shell'], by: 'person', state: 'awaiting_approval', steps: [], createdAt: T0 + 21, updatedAt: T0 + 21 },
      ],
    },
  });
  run({
    type: 'question_add',
    question: {
      qid: 'q2',
      requestId: 'r2',
      owner: ME,
      channel: 'ws:w2',
      picked: { 'Which browsers?': 'Chrome' },
      question: {
        kind: 'question',
        questions: [
          { question: 'Which browsers?', header: 'Browsers', options: [{ label: 'Chrome', description: '' }], multiSelect: false },
          { question: 'Which checks?', header: 'Checks', options: [{ label: 'Lint', description: '' }, { label: 'Types', description: '' }], multiSelect: true },
        ],
      },
    },
  });
  run({ type: 'plan_put', plan });
  // Someone at the door with a link, and someone asking to join a channel you run.
  run({ type: 'knock', knock: { peerId: ZOE, linkId: 'l1', ts: T0 + 41 }, show: true });
  // Friends and chats.
  const presence = { state: 'online' as const };
  run({
    type: 'net_summary',
    summary: {
      enabled: true,
      self: { peerId: ME, name: 'kayra', address: 'a'.repeat(64), presence, appearOffline: false } as never,
      friends: [{ peerId: BOB, name: 'bob', online: true, presence: { state: 'away', note: 'lunch' }, addedAt: T0, unread: 2, last: { id: 'm1abcdefgh', conversation: `dm:${BOB}`, from: BOB, name: 'bob', text: 'see\n```js\nx()\n```\nhere', ts: T0 + 30, mine: false } }],
      groups: [{ id: GROUP, name: 'team', members: [], admin: true, active: true, unread: 0, requests: [{ peerId: ZOE, name: 'zoe', ts: T0 + 42 }], createdAt: T0 }],
      invitations: [],
      pendingJoins: [],
    },
  });
  run({ type: 'net_message', message: { id: 'm1abcdefgh', conversation: `dm:${BOB}`, from: BOB, name: 'bob', text: 'see\n```js\nx()\n```\nhere', ts: T0 + 30, mine: false } });
  run({ type: 'net_message', message: { id: 'm2abcdefgh', conversation: `dm:${BOB}`, from: ME, name: 'kayra', text: 'on it', ts: T0 + 31, mine: true } });
  run({ type: 'sentinel_init', state: SENTINELS });
  return store.getState();
}

function context(): ViewContext {
  let n = 0;
  const refs = new RefTable(() => `ref${String(n++).padStart(5, '0')}`);
  return {
    refs,
    mac: { name: 'Kayra’s Mac', version: '0.6.2' },
    icons: (id) => (id === 'p1' ? ICON : undefined),
    outputs: (channel) =>
      channel === 'mac:assistant'
        ? [{ path: '/Users/k/.beluga/assistant/work/.beluga/scratch/screens/screen-1.png', size: 4096, ts: T0 + 8, cwd: '/Users/k/.beluga/assistant/work' }]
        : channel === 'ws:w2'
        ? [
            { path: '/Users/k/landing/.worktrees/w2/.beluga/scratch/shot.png', size: 2048, ts: T0 + 12, by: 'sa1', cwd: '/Users/k/landing/.worktrees/w2' },
            { path: '/Users/k/landing/.worktrees/w2/test-results/run.log', size: 300, ts: T0 + 13, cwd: '/Users/k/landing/.worktrees/w2' },
            // Source code never becomes an output.
            { path: '/Users/k/landing/.worktrees/w2/src/app.ts', size: 30, ts: T0 + 13, cwd: '/Users/k/landing/.worktrees/w2' },
          ]
        : [],
  };
}

const ICON = 'abcdef0123456789abcdef01';
const TOPICS: Topic[] = ['home', 'work', 'plans', 'chats', 'people', 'tasks', 'conv:mac:assistant', 'conv:ws:w1', 'conv:ws:w2', 'plan:pl_auth', `chat:dm:${BOB}`, 'task:i1', 'sentinels', 'sentinel:sn_fix', 'dashboard:db_rev', 'widgets'];

describe('the views of a known Mac', () => {
  const state = demoState();
  const ctx = context();

  it('match their schemas', () => {
    for (const topic of TOPICS) {
      const view = viewOf(state, ctx, topic);
      const parsed = viewSchema(topic).safeParse(view);
      expect(parsed.success ? 'ok' : `${topic}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe('ok');
    }
  });

  it('home: you, your allowance, what needs you with its buttons, what runs, outputs', () => {
    const home = HomeView.parse(homeView(state, ctx));
    expect(home.usage).toEqual([{ provider: 'Claude Code', plan: 'max', windows: [{ label: '5 hours', pct: 12, resetsAt: T0 + 3_600_000 }, { label: 'Week', pct: 38 }], updatedAt: T0, runtime: 'claude', isDefault: true }]);
    expect(home.needsYou.map((n) => n.id)).toEqual(['approval:ap1', 'confirm:t_confirm000001', 'request:t_request00001', 'knock:' + ZOE, 'join:' + GROUP + ':' + ZOE, 'plan:pl_auth:approve:3', 'sentinel:run_f1', 'question:q1', 'question:q2']);
    const knock = home.needsYou.find((n) => n.id.startsWith('knock:'))!;
    expect(knock.actions.map((a) => [a.method, a.args])).toEqual([
      ['invites.letIn', [ZOE]],
      ['invites.decline', [ZOE]],
    ]);
    expect(home.needsYou.find((n) => n.id.startsWith('join:'))!.actions.map((a) => [a.method, a.args])).toEqual([
      ['network.groups.approve', [GROUP, ZOE]],
      ['network.groups.decline', [GROUP, ZOE]],
    ]);
    // The second question of a prompt: several picks joined, sent with every answer so far.
    expect(home.needsYou.find((n) => n.id === 'question:q2')!.answer).toEqual({ method: 'questions.answer', args: ['q2', { kind: 'answers', answers: { 'Which browsers?': 'Chrome', 'Which checks?': '' } }], slot: [1, 'answers', 'Which checks?'], join: ', ', text: true, picks: true, label: 'Send' });
    const question = home.needsYou.find((n) => n.kind === 'question')!;
    expect(question.actions).toEqual([
      { label: 'Redis', tone: 'plain', method: 'questions.answer', args: ['q1', { kind: 'answers', answers: { 'Which session store?': 'Redis' } }] },
      { label: 'Postgres', tone: 'plain', method: 'questions.answer', args: ['q1', { kind: 'answers', answers: { 'Which session store?': 'Postgres' } }] },
      { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q1', { kind: 'skip' }] },
    ]);
    // Both wait on you (an approval in w2, Claude's question in w1); w2's sub-agent is a dot.
    expect(home.running.filter((r) => !r.topic.startsWith('conv:task:')).map((r) => [r.topic, r.status, r.agents])).toEqual([
      ['conv:ws:w2', 'waiting', 1],
      ['conv:ws:w1', 'waiting', undefined],
    ]);
    // Outputs stay with their conversation: Home only hints at the new ones, per worktree.
    expect(home.outputs).toEqual([]);
    expect(home.running.find((r) => r.topic === 'conv:ws:w2')).toMatchObject({ fresh: 2, projectId: 'p1', icon: ICON });
    expect(home.review).toEqual({ count: 1, first: { topic: 'task:i1', key: 'LND-1', title: 'Protect the payment routes' } });
    expect(home.unread).toEqual({ work: expect.any(Number), chats: 2 });
  });

  it("a conversation of yours carries its agent picker (1.32), runtimes as groups", () => {
    const w1 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w1'));
    expect(w1.agent?.runtime).toBe('claude');
    expect(w1.agent?.groups.map((g) => [g.runtime, g.available])).toEqual([
      ['claude', true],
      ['codex', false],
      ['opencode', false],
      ['grok', false],
      ['local', false],
    ]);
    expect(w1.agent?.groups[1]?.why).toMatch(/Codex/);
  });

  it('a conversation: code folded, steps in words, sub-agents with their outputs', () => {
    const w1 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w1'));
    const answer = w1.turns.find((t) => t.who === 'claude')!;
    expect(answer.prose).toEqual({ text: 'Add a middleware:\n\n[[code:0]]\n\nThen protect `/api/payments`.', code: [{ lang: 'ts', lines: 1 }] });
    expect(w1.turns[0]).toMatchObject({ who: 'you', name: 'kayra' });
    const w2 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w2'));
    const live = w2.turns.find((t) => t.status === 'working')!;
    expect(live).toMatchObject({ status: 'working', step: 'Running the tests · 137/215' });
    expect(live.subagents?.[0]).toMatchObject({ id: 'sa1', title: 'Check the webhooks', status: 'running', steps: ['Searched for retry'] });
    expect(live.subagents?.[0]?.outputs.map((o) => o.name)).toEqual(['shot.png']);
    expect(live.outputs?.map((o) => o.name)).toEqual(['run.log']);
    expect(w2.needsYou.map((n) => n.id)).toEqual(['approval:ap1', 'question:q2']);
    expect(w2.working).toBe(true);
    expect(w2.canSend).toBe(true);
  });

  it('a running turn carries what it does now, its steps with their tools, and its sub-agents live', () => {
    const w2 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w2'));
    const live = w2.turns.find((t) => t.status === 'working')!;
    expect(live.live).toEqual({ phase: 'step', words: 'Running the tests', tool: 'test', progress: '137/215', since: T0 + 13, agents: 1 });
    expect(live.trail).toEqual([{ tool: 'test', text: 'Ran the tests' }]);
    // The sub-agent the run reported, with Claude Code's live words for it (no folders), its kind and start.
    expect(live.subagents?.[0]).toMatchObject({ trail: [{ tool: 'search', text: 'Searched for retry' }], step: 'Reading retry-queue.ts', tool: 'read', type: 'general-purpose', startedAt: T0 + 11, count: 4 });
    // The helper that sub-agent started (Claude Code saw it, no run event named it).
    expect(live.subagents?.[1]).toMatchObject({ id: 'ag2', title: 'Look at the retry queue', status: 'running', step: 'Running the tests', tool: 'test', type: 'Explore' });
    // Nothing of a command line or a path.
    expect(JSON.stringify(live)).not.toMatch(/vitest|--run|src\/hooks/);
  });

  it('a conversation has its worktree’s outputs, its icon, and your queued messages', () => {
    const w2 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w2'));
    expect(w2.outputs?.map((o) => o.name)).toEqual(['shot.png', 'run.log']);
    expect(w2).toMatchObject({ projectId: 'p1', icon: ICON });
    expect(w2.queue).toEqual([{ id: 'r3', text: 'Then update the docs' }]);
    expect(WorkView.parse(viewOf(state, ctx, 'work')).projects.find((p) => p.id === 'p1')?.icon).toBe(ICON);
  });

  it('BLG-840: commits a worktree’s open PR doesn’t have show on the phone as on the Mac, and its band offers no merge without them', () => {
    const behind = {
      ...state,
      projects: state.projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === 'w1' ? { ...w, branch: 'beluga/auth', status: { changed: 0, ahead: 11, behind: 0, unpushed: 3 } } : w)) })),
      prs: { ...state.prs, w1: { number: 398, url: 'https://github.com/o/r/pull/398', state: 'OPEN', title: 'Auth', draft: false, checks: 'passing' } },
    } as DomainState;
    const rows = WorkView.parse(viewOf(behind, ctx, 'work')).projects.flatMap((p) => p.conversations);
    expect(rows.find((c) => c.topic === 'conv:ws:w1')?.notOnPr).toEqual({ count: 3, pr: 398 });
    expect(rows.find((c) => c.topic === 'conv:ws:w2')?.notOnPr).toBeUndefined();
    const band = ConvView.parse(viewOf(behind, ctx, 'conv:ws:w1')).branch!;
    expect([band.kind, band.label, band.pr?.number]).toEqual(['not_pushed', '3 commits not on PR', 398]);
    expect(band.next).toMatchObject({ id: 'push', label: 'Push 3 Commits to PR #398' });
    expect(band.steps?.map((s) => s.id)).toEqual(['push', 'merge_auto', 'open_pr']);
    expect(band.steps?.find((s) => s.id === 'merge_auto')?.label).toBe('Push and Merge When Ready');
    // Pushed: no chip, and Squash and Merge is back.
    const pushed = { ...behind, projects: behind.projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === 'w1' ? { ...w, status: { changed: 0, ahead: 11, behind: 0 } } : w)) })) } as DomainState;
    expect(WorkView.parse(viewOf(pushed, ctx, 'work')).projects.flatMap((p) => p.conversations).find((c) => c.topic === 'conv:ws:w1')?.notOnPr).toBeUndefined();
    expect(ConvView.parse(viewOf(pushed, ctx, 'conv:ws:w1')).branch?.next?.id).toBe('merge_pr');
  });

  it('work lists a project with no conversations yet (one just added), last, and never Chats (BLG-675)', () => {
    const added = { ...state, projects: [...state.projects, { id: 'p9', name: 'notes', root: '/srv/notes', base: 'main', workspaces: [] }, { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [] }] } as DomainState;
    const work = WorkView.parse(viewOf(added, ctx, 'work'));
    expect(work.projects.at(-1)).toEqual({ id: 'p9', name: 'notes', conversations: [] });
    expect(work.projects.find((p) => p.id === 'p1')?.conversations.length).toBeGreaterThan(0);
    expect(work.projects.some((p) => p.id === 'chats' || p.name === 'Chats')).toBe(false);
  });

  it('tasks: by project and status, and one task’s page with its brief, ticks and activity', () => {
    const tasks = TasksView.parse(viewOf(state, ctx, 'tasks'));
    expect(tasks.projects.map((p) => [p.id, p.icon, p.groups.map((g) => [g.status, g.tasks.map((t) => t.key)])])).toEqual([
      ['p1', ICON, [['in_review', ['LND-1']], ['todo', ['LND-2']]]],
    ]);
    expect(tasks.projects[0]!.groups[1]!.tasks[0]).toMatchObject({ topic: 'task:i2', priority: 'high', assignee: 'you', checks: { done: 1, total: 3 } });
    const page = TaskPageView.parse(viewOf(state, ctx, 'task:i1'));
    expect(page).toMatchObject({ key: 'LND-1', status: 'in_review', conv: 'conv:ws:w1', worktree: 'auth', project: 'landing' });
    // BLG-569: a worktree on it: the agent running there, shown (it's changed in that conversation).
    expect(page.agent).toEqual({ runtime: 'claude', label: 'Claude' });
    expect(page.goal).toEqual({ text: 'Only signed-in users pay:\n\n[[code:0]]', code: [{ lang: 'ts', lines: 1 }] });
    expect(page.acceptance).toEqual([
      { text: 'Logged-out users get 401', state: 'done' },
      { text: 'The e2e passes', state: 'deferred', reason: 'suites run at the end' },
      { text: 'Docs updated', state: 'open' },
    ]);
    expect(page.activity.map((a) => [a.who, a.text, a.body, a.comment])).toEqual([
      ['You', 'created this', undefined, undefined],
      ['Your Claude', 'commented', 'Done, see:\n(code)', true],
    ]);
    // BLG-498: an agent's line says which agent (an entry from before agents were named: Claude); a person's says none.
    expect(page.activity.map((a) => a.agent)).toEqual([undefined, { runtime: 'claude', label: 'Claude' }]);
    expect(page.moves.map((m) => m.status)).toEqual(['todo', 'in_progress', 'done', 'backlog', 'canceled']);
    expect(viewOf(state, ctx, 'task:nope')).toBeUndefined();
  });

  it('tasks: a repo’s board also lists what runs in it from a board of several, saying which board (BLG-559)', () => {
    const launch = { prefix: 'LNC', next: 2, name: 'Launch', repos: ['p1'] };
    const more = { ...state, board: { ...state.board, projects: { ...state.board.projects, board_l: launch }, issues: [...state.board.issues, issue('v1', 'LNC-1', 'Hero copy', 'todo', { board: 'board_l' })] } };
    const tasks = TasksView.parse(viewOf(more, ctx, 'tasks'));
    const find = (board: string) => tasks.projects.find((p) => p.id === board)?.groups.flatMap((g) => g.tasks).find((t) => t.key === 'LNC-1');
    expect(find('p1')).toMatchObject({ onBoard: 'Launch' });
    expect(find('board_l')?.onBoard).toBeUndefined();
  });

  it('tasks: the ones the lists leave out go by key, title and status, so a key in words is a chip (BLG-109)', () => {
    expect(TasksView.parse(viewOf(state, ctx, 'tasks')).others).toBeUndefined();
    const old = (n: number): Issue => issue(`d${n}`, `LND-${10 + n}`, `Done long ago ${n}`, 'done', { updatedAt: T0 + n, closedAt: T0 + n } as Partial<Issue>);
    const more = { ...state, board: { ...state.board, issues: [...state.board.issues, ...Array.from({ length: 12 }, (_, n) => old(n)), issue('c1', 'LND-40', 'Dropped', 'canceled')] } };
    const tasks = TasksView.parse(viewOf(more, ctx, 'tasks'));
    const listed = tasks.projects.flatMap((p) => p.groups.flatMap((g) => g.tasks.map((t) => t.key)));
    // Done shows the latest 10; the two oldest and the canceled one come as others, newest first.
    expect(listed).toContain('LND-21');
    expect(tasks.others?.map((t) => [t.key, t.status])).toEqual([
      ['LND-40', 'canceled'],
      ['LND-11', 'done'],
      ['LND-10', 'done'],
    ]);
    expect(tasks.others?.[1]).toEqual({ id: 'd1', key: 'LND-11', title: 'Done long ago 1', status: 'done' });
  });

  it('a file written after the last answer ended shows with that answer (not nowhere)', () => {
    const late: ViewContext = { ...context(), outputs: (channel) => (channel === 'ws:w1' ? [{ path: '/Users/k/landing/.beluga/scratch/after.png', size: 10, ts: T0 + 1_000_000, cwd: '/Users/k/landing' }] : []) };
    const w1 = ConvView.parse(viewOf(state, late, 'conv:ws:w1'));
    const answers = w1.turns.filter((t) => t.who === 'claude');
    expect(answers.at(-1)!.outputs?.map((o) => o.name)).toEqual(['after.png']);
    expect(answers.slice(0, -1).flatMap((t) => t.outputs ?? [])).toEqual([]);
  });

  it('a friend’s Claude you asked reads as a conversation with its files', () => {
    const conv = ConvView.parse(viewOf(state, ctx, 'conv:task:t_screen000001'));
    expect(conv.turns.map((t) => [t.who, t.name, t.prose.text, t.status])).toEqual([
      ['you', 'kayra', 'Take a screenshot of your desktop', undefined],
      ['friend', "bob's agent", 'Here it is.', 'done'],
    ]);
    expect(conv.turns[1]!.outputs?.map((o) => [o.name, o.kind])).toEqual([['desktop.png', 'image']]);
    expect(conv.canSend).toBe(false);
    expect(WorkView.parse(viewOf(state, ctx, 'work')).projects.find((p) => p.id === 'asked')?.conversations.map((c) => c.topic)).toEqual(['conv:task:t_screen000001']);
  });

  it('the room’s turns carry their reactions and your quick row; a conversation with Claude has none (1.41, BLG-702, BLG-742)', () => {
    const store = new Store(state);
    store.dispatch({ type: 'chat', id: 'r1', from: BOB, text: 'shipped it', ts: T0 + 40, byAgent: false, channel: 'room' });
    store.dispatch({ type: 'chat_react', channel: 'room', id: 'r1', emoji: '🚀', by: BOB, on: true, at: 1 });
    store.dispatch({ type: 'chat_react', channel: 'room', id: 'r1', emoji: '🚀', by: ME, on: true, at: 2 });
    const room = ConvView.parse(viewOf(store.getState(), ctx, 'conv:room'));
    expect(room.turns.find((t) => t.id === 'r1')).toMatchObject({ reactable: true, reactions: [{ emoji: '🚀', count: 2, mine: true, who: ['bob', 'You'] }] });
    expect(room.quick).toEqual(['🚀', '👍', '❤️', '😂', '🎉', '👀']);
    // A workspace chat is a conversation with Claude: no emoji there, even one an older Mac put.
    store.dispatch({ type: 'chat_react', channel: 'ws:w1', id: 'c1', emoji: '🚀', by: BOB, on: true, at: 3 });
    const conv = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1'));
    expect(conv.turns.every((t) => !t.reactable && !t.reactions)).toBe(true);
    expect(conv.quick).toBeUndefined();
  });

  it('a message steered in that Claude hasn’t read yet says so on your turn, not as a turn of Claude’s (BLG-54)', () => {
    const store = new Store(state);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r9', requester: ME, event: 'started', text: '', ts: T0 + 20, channel: 'ws:w1' });
    store.dispatch({ type: 'chat', id: 'c9', from: ME, text: 'look at the retries first', ts: T0 + 21, byAgent: false, channel: 'ws:w1', request: 'r10', steer: true });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r10', requester: ME, event: 'text', text: 'Your agent reads this after its current step', ts: T0 + 21, channel: 'ws:w1' });
    const conv = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1'));
    expect(conv.turns.slice(-2).map((t) => [t.who, t.prose.text, t.steer])).toEqual([
      ['claude', '', undefined],
      ['you', 'look at the retries first', { request: 'r10', waiting: 'next_step' }],
    ]);
    // Read: your turn reads as any other.
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r10', requester: ME, event: 'done', text: 'Your agent read this while it worked; the answer above covers it.', ts: T0 + 22, channel: 'ws:w1' });
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.at(-1)).toMatchObject({ who: 'you', prose: { text: 'look at the retries first' } });
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.at(-1)?.steer).toBeUndefined();
  });

  it('your own message can be edited, where its words reach the phone whole (BLG-387)', () => {
    const store = new Store(state);
    store.dispatch({ type: 'chat', id: 'c20', from: ME, text: 'Use this:\n\n```ts\nconst x = 1;\n```', ts: T0 + 30, byAgent: false, channel: 'ws:w1' });
    store.dispatch({ type: 'chat', id: 'c21', from: BOB, text: 'and the tests', ts: T0 + 31, byAgent: false, channel: 'ws:w1' });
    const turns = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns;
    expect(turns.find((t) => t.id === 'c1')?.edit).toEqual({ ws: 'w1', kind: 'worktree' });
    // Code in it (folded away on the phone), someone else's words, or not a workspace: no Edit.
    expect(turns.find((t) => t.id === 'c20')?.edit).toBeUndefined();
    expect(turns.find((t) => t.id === 'c21')?.edit).toBeUndefined();
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:mac:assistant')).turns.find((t) => t.id === 'ca1')?.edit).toBeUndefined();
  });

  it('a merge shows in the conversation, though other info lines stay on the Mac', () => {
    const store = new Store(state);
    store.dispatch({ type: 'system', id: 'mg', channel: 'ws:w1', text: 'Above this line was merged into main in PR #4.', ts: T0 + 35, merged: { into: 'main', number: 4, url: 'u/4' } });
    store.dispatch({ type: 'system', id: 'sh', channel: 'ws:w1', text: 'Above this line went to PR #4, merged into main. New work starts here, for a new pull request.', ts: T0 + 36, shipped: { number: 4, into: 'main' } });
    store.dispatch({ type: 'system', id: 'nf', channel: 'ws:w1', text: 'Checked out PR #9', ts: T0 + 37 });
    const turns = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns;
    expect(turns.find((t) => t.id === 'mg')).toMatchObject({ who: 'system', name: 'Beluga' });
    expect(turns.find((t) => t.id === 'sh')).toMatchObject({ who: 'system' });
    expect(turns.find((t) => t.id === 'nf')).toBeUndefined();
  });

  it('a dialogue between agents shows its header with Stop, and its turns named for their agent (BLG-466)', () => {
    const store = new Store(state);
    const d = createDialogue({ id: 'dlg1', topic: 'Retries or a queue?', participants: [{ agent: { runtime: 'claude', label: 'Claude' } }, { agent: { runtime: 'codex', label: 'Codex' } }], turnCap: 6, channel: 'ws:w1' }, T0);
    store.dispatch({ type: 'dialogue_put', dialogue: d });
    store.dispatch({ type: 'system', id: 'dh', channel: 'ws:w1', level: 'info', text: 'Dialogue: Retries or a queue?', ts: T0 + 40, dialogue: { id: 'dlg1' } });
    store.dispatch({ type: 'chat', id: 'dt1', from: ME, text: 'A queue.', ts: T0 + 41, byAgent: true, agent: { runtime: 'codex', label: 'Codex' }, channel: 'ws:w1', dialogue: { id: 'dlg1', turn: 1 } });
    const turns = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns;
    expect(turns.find((t) => t.id === 'dh')?.dialogue).toMatchObject({ id: 'dlg1', mode: 'Talk', who: 'Claude and Codex', progress: 'Turn 1 of 6', canStop: true, canContinue: false });
    expect(turns.find((t) => t.id === 'dt1')).toMatchObject({ who: 'claude', name: expect.stringContaining('Codex'), agent: { runtime: 'codex', label: 'Codex' } });
    store.dispatch({ type: 'dialogue_put', dialogue: { ...d, status: 'stopped', note: 'Stopped by kayra' } });
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.find((t) => t.id === 'dh')?.dialogue).toMatchObject({ status: 'Stopped by kayra', canStop: false });
  });

  it('an agent’s turn says which agent answered, so the phone draws its mark (BLG-498)', () => {
    const store = new Store(state);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'rx1', requester: ME, event: 'started', text: '', ts: T0 + 50, channel: 'ws:w1', agent: { runtime: 'codex', label: 'Codex' } });
    const turn = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.find((t) => t.who === 'claude' && t.ts === T0 + 50);
    expect(turn).toMatchObject({ name: 'Codex', agent: { runtime: 'codex', label: 'Codex' } });
    // A run from before agents were named: Claude's.
    expect(ConvView.parse(viewOf(state, ctx, 'conv:ws:w1')).turns.filter((t) => t.who === 'claude').every((t) => t.agent?.runtime === 'claude')).toBe(true);
  });

  it('pages back through older turns', () => {
    const { turns } = convTurns(state, ctx, 'ws:w1');
    const older = convTurns(state, ctx, 'ws:w1', { before: turns.at(-1)!.id, limit: 1 });
    expect(older.turns.map((t) => t.id)).toEqual([turns.at(-2)!.id]);
    expect(older.more).toBe(false);
  });

  it('plans, chats and people', () => {
    expect(PlansView.parse(viewOf(state, ctx, 'plans')).plans).toEqual([{ id: 'pl_auth', title: 'Add auth', state: 'draft', topic: 'plan:pl_auth', done: 0, total: 1 }]);
    const page = PlanView.parse(viewOf(state, ctx, 'plan:pl_auth'));
    expect(page.needsYou.find((n) => n.kind === 'decision')?.actions.map((a) => a.method)).toEqual(['plans.approve', 'plans.verify', 'plans.discard']);
    // While Claude still writes it (no milestones yet), there's nothing to approve or discard.
    const writing = { ...state, plans: { ...state.plans, plans: [{ ...plan, draft: { title: 'Add auth', goal: '', milestones: [] } } as unknown as Plan] } };
    expect(PlanView.parse(viewOf(writing, ctx, 'plan:pl_auth')).needsYou.filter((n) => n.kind === 'decision')).toEqual([]);
    expect(needsYou(writing).some((n) => n.id.startsWith('plan:pl_auth:approve'))).toBe(false);
    const chat = ChatView.parse(viewOf(state, ctx, `chat:dm:${BOB}`));
    // Whose Claude a message can ask: you, then them.
    expect(chat.members?.map((m) => ({ peerId: m.peerId, name: m.name, me: m.me }))).toEqual([
      { peerId: ME, name: 'kayra', me: true },
      { peerId: BOB, name: 'bob', me: undefined },
    ]);
    expect(chat.messages.map((m) => [m.from, m.mine, m.text])).toEqual([
      ['bob', false, 'see\n[[code:0]]\nhere'],
      ['kayra', true, 'on it'],
    ]);
    // 1.30 (BLG-429): only your own words, whole on the phone, can be edited there.
    expect(chat.messages.map((m) => m.editable)).toEqual([undefined, true]);
    // 1.38 (BLG-574): what's unread, so the phone marks it when it opens; none, and it isn't said.
    expect(chat.unread).toBe(2);
    expect(ChatView.parse(viewOf({ ...state, network: { ...state.network, friends: state.network.friends.map((f) => ({ ...f, unread: 0 })) } }, ctx, `chat:dm:${BOB}`)).unread).toBeUndefined();
    expect(ChatsView.parse(viewOf(state, ctx, 'chats')).chats[0]).toMatchObject({ name: 'bob', kind: 'dm', unread: 2 });
    expect(PeopleView.parse(viewOf(state, ctx, 'people')).people[0]).toMatchObject({ name: 'bob', presence: 'away', note: 'lunch', offers: ['claude', 'screen', 'shell'] });
    expect(WorkView.parse(viewOf(state, ctx, 'work')).projects.find((p) => p.id === 'p1')?.conversations.map((c) => c.title)).toEqual(['tests', 'auth']);
  });

  it('a chat’s reactions and your quick row (1.41, BLG-702)', () => {
    const conv = `dm:${BOB}`;
    const list = state.network.messages[conv] ?? [];
    const [first, ...rest] = list;
    const reacted = { ...state, network: { ...state.network, messages: { ...state.network.messages, [conv]: [{ ...first!, reactions: [{ emoji: '🚀', by: [BOB, ME] }, { emoji: '👀', by: [BOB] }] }, ...rest] } } };
    const chat = ChatView.parse(viewOf(reacted, ctx, `chat:${conv}`));
    expect(chat.messages[0]?.reactions).toEqual([
      { emoji: '🚀', count: 2, mine: true, who: ['bob', 'You'] },
      { emoji: '👀', count: 1, mine: false, who: ['bob'] },
    ]);
    expect(chat.messages[1]?.reactions).toBeUndefined();
    // The one you use comes first in your row, then the defaults.
    expect(chat.quick).toEqual(['🚀', '👍', '❤️', '😂', '🎉', '👀']);
    expect(ChatView.parse(viewOf(state, ctx, `chat:${conv}`)).quick).toEqual(['👍', '❤️', '😂', '🎉', '👀', '✅']);
  });

  it('people are friends only: someone only in your room isn’t listed, and their friend request needs you (BLG-202)', () => {
    const RAE = 'r'.repeat(32);
    const withRoom: DomainState = {
      ...state,
      peers: [...state.peers, { peerId: RAE, name: 'rae', agent: true, shares: [] }],
      network: { ...state.network, offers: [{ peerId: RAE, name: 'rae', dir: 'in', at: T0 + 5, expiresAt: T0 + 86_400_000 }] },
    };
    const people = PeopleView.parse(viewOf(withRoom, ctx, 'people')).people;
    expect(people.map((p) => p.peerId)).toEqual(state.network.friends.map((f) => f.peerId));
    expect(people.some((p) => p.peerId === RAE)).toBe(false);
    const item = HomeView.parse(homeView(withRoom, ctx)).needsYou.find((n) => n.id === `friend:${RAE}`)!;
    expect(item).toMatchObject({ kind: 'request', title: 'rae wants to add you as a friend', from: 'rae' });
    expect(item.actions.map((a) => [a.label, a.method, a.args])).toEqual([
      ['Accept', 'network.friends.answerOffer', [RAE, true]],
      ['Not now', 'network.friends.answerOffer', [RAE, false]],
    ]);
  });

  it('a friend’s Claude answering you offers to do it on their Mac; answering someone else, it doesn’t', () => {
    const conv = `dm:${BOB}`;
    const answer = (id: string, asked: string) => ({ id, conversation: conv, from: BOB, name: 'bob', text: 'I can do that as a request.', ts: T0 + 40, mine: false, claude: { for: asked, request: { ask: 'Send me your wallpaper', needs: ['files' as const] } } });
    const list = state.network.messages[conv] ?? [];
    const withAnswers = { ...state, network: { ...state.network, messages: { ...state.network.messages, [conv]: [...list, answer('m3abcdefgh', 'm2abcdefgh'), answer('m4abcdefgh', 'm1abcdefgh')] } } };
    const chat = ChatView.parse(viewOf(withAnswers, ctx, `chat:dm:${BOB}`));
    expect(chat.messages.map((m) => m.offer)).toEqual([undefined, undefined, { to: BOB, ask: 'Send me your wallpaper', needs: ['files'] }, undefined]);
    // Your Mac sent it already (BLG-353): the phone doesn't offer it again.
    const sent = { id: 't_fromanswer01', direction: 'sent' as const, peerId: BOB, peerName: 'bob', kind: 'ask' as const, ask: 'Send me your wallpaper', needs: ['files' as const], by: 'person' as const, answer: 'm3abcdefgh', state: 'sent' as const, steps: [], createdAt: T0 + 41, updatedAt: T0 + 41 };
    const after = ChatView.parse(viewOf({ ...withAnswers, gateway: { ...withAnswers.gateway, tasks: [...withAnswers.gateway.tasks, sent] } }, ctx, `chat:dm:${BOB}`));
    expect(after.messages.map((m) => m.offer)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('a chat says who’s there, what their Claude does, what waits on whom and who gets it later (BLG-210)', () => {
    const conv = `dm:${BOB}`;
    const secret = { id: 't_secret000001', direction: 'received' as const, peerId: BOB, peerName: 'bob', kind: 'file' as const, ask: 'Send me your deploy key', path: '~/.ssh/id_ed25519', secret: { kind: 'ssh-key' as const, label: 'your private SSH key id_ed25519' }, needs: [], by: 'agent' as const, chat: conv, state: 'awaiting_approval' as const, steps: [], createdAt: T0 + 50, updatedAt: T0 + 50 };
    const sent = { id: 't_sent00000001', direction: 'sent' as const, peerId: BOB, peerName: 'bob', kind: 'ask' as const, ask: 'Run the tests in bob-api', needs: [], by: 'person' as const, chat: conv, state: 'sent' as const, steps: [], createdAt: T0 + 51, updatedAt: T0 + 51 };
    const card = { id: 'm5abcdefgh', conversation: conv, from: BOB, name: 'bob', text: "bob's Claude asked for a file", ts: T0 + 50, mine: false, task: { id: secret.id, role: 'request' as const } };
    const offline = {
      ...state,
      gateway: { ...state.gateway, tasks: [...state.gateway.tasks, secret, sent] },
      network: { ...state.network, friends: state.network.friends.map((f) => ({ ...f, online: false })), messages: { ...state.network.messages, [conv]: [...(state.network.messages[conv] ?? []), card] } },
    };
    const chat = ChatView.parse(viewOf(offline, ctx, `chat:${conv}`));
    expect(chat.members?.map((m) => [m.name, m.presence, m.claude])).toEqual([
      ['kayra', 'online', 'idle'],
      ['bob', 'offline', 'offline'],
    ]);
    expect(chat.waiting).toEqual([
      { text: 'Waiting on you: bob’s agent wants your private SSH key id_ed25519', you: true, task: secret.id },
      { text: 'Waiting on bob: Run the tests in bob-api', you: false, task: sent.id },
    ]);
    expect(chat.note).toBe('bob is offline: this waits for them');
    expect(chat.messages.at(-1)?.task).toMatchObject({ who: 'bob’s agent · asked your Mac', secret: true });
    // Nothing waiting, everyone online: no band, no note.
    const calm = ChatView.parse(viewOf(state, ctx, `chat:${conv}`));
    expect(calm.waiting).toBeUndefined();
    expect(calm.note).toBeUndefined();
  });

  it('sentinel: a merge waiting for you is a decision with Merge and Not Now', () => {
    const item = needsYou(state).find((n) => n.id === 'sentinel:run_f1')!;
    expect(item).toMatchObject({ kind: 'decision', title: 'Merge the fix for #48?', from: 'Fix what broke', topic: 'sentinel:sn_fix', askedAt: T0 + 75 });
    expect(item.detail).toBe('Checks passed · Claude’s review: ship, a two-line fix with a test\nPull request #53');
    expect(item.actions).toEqual([
      { label: 'Merge', tone: 'main', method: 'sentinel.decide', args: ['run_f1', 'merge'] },
      { label: 'Not Now', tone: 'danger', method: 'sentinel.decide', args: ['run_f1', 'skip'] },
    ]);
  });

  it('sentinel: the list with sentences and last runs, and a page with its runs and report', () => {
    const list = SentinelsView.parse(viewOf(state, ctx, 'sentinels'));
    expect(list.sentinels.map((x) => [x.name, x.sentence, x.last?.state, x.last?.headline, x.live, x.project])).toEqual([
      ['Morning brief', 'Every day at 7:00', 'done', '3 commits landed, CI is green', false, 'landing'],
      ['Fix what broke', 'Only when you press Run', 'needs-you', 'Merge the fix for #48?', true, 'landing'],
    ]);
    expect(list.sentinels[0]!.nextAt).toBe(T0 + 86_400_000);
    expect(list.recent).toEqual([{ id: 'run_b1', sentinelId: 'sn_brief', state: 'done', at: T0 + 60 }]);
    const brief = SentinelPageView.parse(viewOf(state, ctx, 'sentinel:sn_brief'));
    expect(brief.runs[0]).toMatchObject({ id: 'run_b1', by: 'schedule', state: 'done', report: { name: 'report.md', kind: 'markdown' } });
    const fix = SentinelPageView.parse(viewOf(state, ctx, 'sentinel:sn_fix'));
    expect(fix.runs[0]).toMatchObject({ by: 'CI failed on main', step: 'Merge if acceptable', pr: { number: 53 } });
    expect(fix.needsYou.map((n) => n.id)).toEqual(['sentinel:run_f1']);
    expect(fix.steps.map((x) => x.kind)).toEqual(['claude', 'pr', 'merge']);
    expect(viewOf(state, ctx, 'sentinel:nope')).toBeUndefined();
    // An event trigger that can't watch says why (BLG-239); a paused one doesn't.
    const troubled = { ...state, sentinel: { ...SENTINELS, troubles: { sn_brief: 'Sign in to GitHub first: run gh auth login in a terminal' } } };
    expect(SentinelsView.parse(viewOf(troubled, ctx, 'sentinels')).sentinels[0]!.trouble).toBe('Sign in to GitHub first: run gh auth login in a terminal');
    expect(SentinelPageView.parse(viewOf(troubled, ctx, 'sentinel:sn_brief')).trouble).toBe('Sign in to GitHub first: run gh auth login in a terminal');
    expect(list.sentinels[0]!.trouble).toBeUndefined();
  });

  it('dashboard: tiles worked out with every compare, quiet states, Refresh going; Home’s first three numbers', () => {
    const d = DashboardView.parse(viewOf(state, ctx, 'dashboard:db_rev'));
    expect(d).toMatchObject({ id: 'db_rev', name: 'Revenue', compare: 'previous', refreshing: { done: 1, total: 2, sentinel: 'Morning brief' }, dashboards: [{ id: 'db_rev', name: 'Revenue', topic: 'dashboard:db_rev' }] });
    const [issues, revenue, chart, table, text, gone, divider] = d.tiles;
    expect(issues).toMatchObject({ kind: 'number', title: 'Open issues', state: 'ok', value: '9', pinned: 'week', sentinel: 'Morning brief', topic: 'sentinel:sn_brief', trend: [14, 12, 9], runId: 'run_b1' });
    // Fewer open issues is good: green either way back.
    expect(issues!.deltas).toEqual({ previous: { change: '−3 (−25%)', tone: 'good' }, day: { change: '−3 (−25%)', tone: 'good' }, week: { change: '−5 (−35.7%)', tone: 'good' }, month: { tone: 'none' } });
    expect(revenue).toMatchObject({ value: '$3,400', deltas: { previous: { tone: 'none' } } });
    expect(chart!.chart).toEqual({ kind: 'line', unit: 'count', series: [{ label: 'Open issues', points: [[T0 - 7 * 86_400_000, 14], [T0 - 86_400_000, 12], [T0 + 60, 9]] }] });
    expect(table!.table).toEqual({ columns: ['who', 'job'], keys: ['who', 'job'], rows: [['lena', 'deploy'], ['bob', 'tests']], total: 2 });
    expect(text).toMatchObject({ title: 'Morning brief', text: '3 commits landed, CI is green', runId: 'run_b1' });
    expect(gone).toEqual({ id: 't6', kind: 'number', width: 1, title: 'x', state: 'gone' });
    expect(divider).toMatchObject({ kind: 'divider', title: 'Money', width: 3 });
    expect(viewOf(state, ctx, 'dashboard:nope')).toBeUndefined();
    const list = SentinelsView.parse(viewOf(state, ctx, 'sentinels'));
    expect(list.dashboards).toEqual([{ id: 'db_rev', name: 'Revenue', topic: 'dashboard:db_rev' }]);
    expect(list.numbers).toEqual({ dashboard: { id: 'db_rev', name: 'Revenue', topic: 'dashboard:db_rev' }, items: [{ label: 'Open issues', value: '9', change: '−5 (−35.7%)', tone: 'good' }, { label: 'Revenue', value: '$3,400', tone: 'none' }] });
  });

  it('dashboard: a typed table’s documents go as refs the phone streams, never a path; each column’s key, max and button (BLG-386)', async () => {
    const typed = { ...SENTINELS, metrics: { sn_brief: { ...SENTINELS.metrics!.sn_brief!, jobs: { ...SENTINELS.metrics!.sn_brief!.jobs!, rows: [{ who: 'lena@x.com', job: 'deploy', log: 'deploy.html', done: 40 }, { who: 'bob', job: 'tests', log: null, done: 100 }], columns: ['who', 'job', 'log', 'done'], columnTypes: [{ key: 'who', type: 'person' as const }, { key: 'log', type: 'html' as const, button: 'Open log' }, { key: 'done', type: 'progress' as const, max: 100, label: 'Done' }] } } } };
    const refs = new RefTable(() => 'docref0001');
    const docCtx: ViewContext = { ...ctx, refs };
    const d = DashboardView.parse(viewOf({ ...state, sentinel: typed }, docCtx, 'dashboard:db_rev'));
    const t = d.tiles.find((x) => x.kind === 'table')!.table!;
    expect(t.columns).toEqual(['who', 'job', 'log', 'Done']);
    expect(t.keys).toEqual(['who', 'job', 'log', 'done']);
    expect(t.metric).toEqual({ sentinelId: 'sn_brief', name: 'jobs' });
    expect(t.typed).toEqual([
      { col: 0, key: 'who', kind: 'person', values: ['lena@x.com', 'bob'] },
      { col: 2, key: 'log', kind: 'html', values: ['deploy.html', null], docs: [{ ref: 'out:docref0001', name: 'deploy.html', mime: 'text/html' }, null], button: 'Open log' },
      { col: 3, key: 'done', kind: 'progress', values: [null, null], max: 100 },
    ]);
    // The ref names the cell; the bytes come from Sentinel when the phone asks, text redacted.
    const files = new FileServer({ refs, thumbsDir: '/tmp/none', documents: async (doc) => (expect(doc).toEqual({ sentinelId: 'sn_brief', metric: 'jobs', column: 'log', value: 'deploy.html' }), { name: 'deploy.html', mime: 'text/html', bytes: new TextEncoder().encode('<p>token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789</p>') }) });
    const piece = await files.piece('out:docref0001', 'text', 0);
    expect(piece).toMatchObject({ off: 0, eof: true, mime: 'text/html' });
    expect(Buffer.from(piece.b64, 'base64').toString()).not.toContain('sk-ant-api03');
    await expect(files.piece('out:docref0001', 'full', 0)).rejects.toThrow(/redacted/);
    await expect(new FileServer({ refs, thumbsDir: '/tmp/none' }).piece('out:docref0001', 'text', 0)).rejects.toThrow('Documents open on the Mac');
    expect(JSON.stringify(d)).not.toMatch(/\/Users\//);
  });

  it('widgets: every tile but headings in words, as the Mac’s desktop widgets have them, its project’s icon as a checksum', () => {
    const w = WidgetsView.parse(viewOf(state, ctx, 'widgets'));
    expect(w.tiles.map((t) => t.id)).toEqual(['db_rev/t1', 'db_rev/t2', 'db_rev/t3', 'db_rev/t4', 'db_rev/t5', 'db_rev/t6']);
    const [issues, , chart, table, text, gone] = w.tiles;
    expect(issues).toMatchObject({ dashboard: 'db_rev', tile: 't1', board: 'Revenue', title: 'Open issues', kind: 'number', value: '9', change: '−5 (−35.7%)', tone: 'good', points: [14, 12, 9], icon: ICON });
    expect(issues!.tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(chart).toMatchObject({ kind: 'chart', points: [14, 12, 9] });
    expect(table).toMatchObject({ kind: 'text', value: '2 rows', text: 'lena · deploy\nbob · tests' });
    expect(text).toMatchObject({ kind: 'text', text: '3 commits landed, CI is **green**' });
    expect(gone).toMatchObject({ tile: 't6', note: 'gone' });
    // Never a source, a query or a path of the Mac's.
    expect(JSON.stringify(w)).not.toMatch(/\/Users\//);
    expect(WidgetsView.parse(viewOf({ ...state, sentinel: { ...SENTINELS, enabled: false } }, ctx, 'widgets'))).toEqual({ tiles: [] });
  });

  it('sentinel: a run that ended where the sentinel notifies the phone is told once', () => {
    const going = { ...SENTINELS, runs: [...SENTINELS.runs, { id: 'run_b2', sentinelId: 'sn_brief', by: 'you' as const, trigger: { kind: 'manual' as const, summary: 'You pressed Run' }, state: 'running' as const, startedAt: T0 + 90, headline: '', steps: [], tasks: [] }] };
    const before = { ...state, sentinel: going };
    const after = { ...state, sentinel: { ...going, runs: going.runs.map((r) => (r.id === 'run_b2' ? { ...r, state: 'done' as const, endedAt: T0 + 99, headline: 'Quiet day' } : r)) } };
    expect(sentinelDone(before, after)).toEqual([{ title: 'Morning brief', body: 'Quiet day', topic: 'sentinel:sn_brief', run: 'run_b2' }]);
    // Already ended before: nothing new; a sentinel that tells only the Mac: nothing for the phone.
    expect(sentinelDone(after, after)).toEqual([]);
    const macOnly = (st: DomainState): DomainState => ({ ...st, sentinel: { ...st.sentinel, items: st.sentinel.items.map((i) => ({ ...i, notify: 'mac' as const, steps: [] })) } });
    expect(sentinelDone(macOnly(before), macOnly(after))).toEqual([]);
  });

  it('every needs-you action is a call the phone may make', async () => {
    const { phoneMay } = await import('../src/companion/coverage.js');
    expect(needsYou(state).flatMap((n) => [...n.actions.map((a) => a.method), ...(n.answer ? [n.answer.method] : [])]).filter((m) => !phoneMay(m))).toEqual([]);
    // Nothing waits without a way to answer it from the phone.
    expect(needsYou(state).filter((n) => !n.actions.length && !n.answer)).toEqual([]);
  });

  it('snapshot', () => {
    const fresh = context();
    expect(Object.fromEntries(TOPICS.map((t) => [t, viewOf(state, fresh, t)]))).toMatchSnapshot();
  });
});
