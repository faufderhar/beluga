import type { AgentBackend, AgentRunInput, FollowUp, RoomBridge, ThreadTools } from './types.js';
import type { McpServerRow } from '../shared/mcp.js';
import { demoAnswerFromPrompt } from '../core/chat/demo-answers.js';
import { cleanPlanTitle, slugify } from './namer.js';
import { type DraftContext, MAX_TASKS, type TaskDraft, firstLineTitle, matchPerson } from './task-drafter.js';
import { MORE, MockStepper, splitLine } from './mock-steps.js';
import { MockContext, withGrowingContext } from './mock-context.js';
import { MOCK_GRAPH_ANSWER } from './mock-graphs.js';
import { mockTerminal } from './mock-terminal.js';
import { RunFailedError, classifyRun } from '../shared/run-failure.js';
import { MOCK_VIEWS_ANSWER } from './mock-views.js';

interface Script {
  readonly match: RegExp;
  readonly steps: readonly string[];
  readonly answer: string;
  /** How long each step takes (at pace 1); the default is quick. */
  readonly stepMs?: number;
  readonly report?: { title: string; markdown: string };
  /** Sub-agents launched in parallel, each with its own steps. */
  readonly subagents?: ReadonlyArray<{ title: string; steps: readonly string[]; kind?: 'agent' | 'background' }>;
  /** Steps after the sub-agents finished. */
  readonly after?: readonly string[];
  /** Takes what you say while it works into the turn at its next step, as Claude Code does (steering). */
  readonly steerable?: boolean;
  /** Doing a task: sections of its brief it writes (what an investigation found, say). */
  readonly brief?: ReadonlyArray<readonly ['context' | 'acceptance', string]>;
  /** One step that runs long: after it starts, the next step comes `ms` later (a steer waits; Send now stops it). */
  readonly slowStep?: { readonly step: string; readonly ms: number };
}

/** Canned, fast replies so the demo (and README recordings) never wait on real Claude calls. */
const SCRIPTS: readonly Script[] = [
  {
    // Issues › Investigate on the demo's headline bug (core/issues/prompts.ts): why, a reproduction, and the brief written.
    match: /^Investigate GitHub issue #48\b/,
    stepMs: 900,
    steps: ['Bash gh issue view 48 --repo acme/bob-api --comments', 'Grep "decodeURIComponent" src', 'Read src/users.ts', 'Read src/routes/login.ts', 'Write tests/login-plus-email.test.ts', 'Bash npm test -- login-plus-email'],
    brief: [
      [
        'context',
        [
          '**What happens:** `POST /login` with an address that has a `+` in it answers 500.',
          '',
          '**Why:** `findUser()` in `src/users.ts` runs `decodeURIComponent` on an email that was already decoded, so `+` becomes a space. No user is `lena test@acme.dev`, and `login()` in `src/routes/login.ts` reads `user.id` without checking, which throws.',
          '',
          '**How to reproduce:** `tests/login-plus-email.test.ts` signs in as `lena+test@acme.dev`; it fails with the 500 today.',
          '',
          '**Where the fix goes:** `findUser()` takes the email as it comes (no second decode), and `login()` answers 401 when there is no such user instead of throwing.',
        ].join('\n'),
      ],
      ['acceptance', '- [ ] An address with a `+` signs in (the new test passes)\n- [ ] An unknown address gets a 401, not a 500\n- [ ] The other login tests still pass'],
    ],
    answer: [
      '**What happens:** signing in with an address that has a `+` answers 500.',
      '',
      '**Why:** `findUser()` decodes the email a second time (`decodeURIComponent`), so `+` turns into a space and no user matches; `login()` then reads `user.id` of nothing and throws.',
      '',
      '**How to reproduce:** `npm test -- login-plus-email` (a new failing test, kept for the fix).',
      '',
      '**How to fix:** drop the second decode in `findUser()`, and answer 401 for an unknown user. Small and low risk: two lines and a test.',
      '',
      'Verdict: a real bug. It’s all in the task’s brief; say **Fix It** when you want it fixed.',
    ].join('\n'),
  },
  {
    // Investigate on any other demo issue.
    match: /^Investigate GitHub issue #\d+/,
    stepMs: 900,
    steps: ['Bash gh issue view --comments', 'Grep -n "TODO|FIXME" src', 'Read src/server.ts', 'Write tests/issue-repro.test.ts', 'Bash npm test -- issue-repro'],
    brief: [
      ['context', '**What happens:** as the report says; `tests/issue-repro.test.ts` shows it.\n\n**Why:** the code path in `src/server.ts` doesn’t handle the case the report describes.\n\n**Where the fix goes:** `src/server.ts`, with the new test kept.'],
      ['acceptance', '- [ ] The reproduction passes\n- [ ] Nothing else changes'],
    ],
    answer: '**What happens:** what the report says, reproduced by a new failing test.\n\n**Why:** `src/server.ts` doesn’t handle that case.\n\n**How to fix:** handle it there and keep the test. Small.\n\nVerdict: a real bug; it’s in the task’s brief.',
  },
  {
    // Fix It (after investigating, or straight away): the fix, its test, a commit. The demo has no GitHub, so no pull request.
    match: /^(Now fix|Fix) GitHub issue #\d+/,
    stepMs: 900,
    steps: ['Read tests/login-plus-email.test.ts', 'Edit src/users.ts', 'Edit src/routes/login.ts', 'Bash npm test', 'Bash git commit -am "Fix sign-in with a + in the email"'],
    answer: 'Fixed: `findUser()` no longer decodes the email twice, and an unknown user gets a 401. The new test passes, and so does the rest of the suite.\n\nThis is the demo, with no GitHub to push to, so there’s no pull request; on a real repository I’d open one that says “Fixes #48”.',
  },
  {
    // /visualize, or asking for a diagram: an interactive graph (docs/graphs.md).
    match: /visuali[sz]e|diagram|\bdraw (it|this|me)\b|map (it|this) out/i,
    steps: ['Glob src/**/*.ts', 'Read src/server.ts', 'Read src/payments.ts', 'Read src/webhooks.ts'],
    answer: MOCK_GRAPH_ANSWER,
  },
  {
    // Asking to see data: live tables, a chart, stats, code and colors (docs/views.md).
    match: /dashboard|show me the (data|numbers|metrics)|\bchart\b|\btable of\b/i,
    steps: ['Bash sqlite3 payments.db ".tables"', 'Read src/webhooks.ts'],
    answer: MOCK_VIEWS_ANSWER,
  },
  {
    // Asking about tasks: the demo board's tasks as chips and cards that open them (BLG-26).
    match: /where do (my |the )?tasks stand|task cards/i,
    steps: ['Read NOTES.md'],
    answer: [
      'Auth `task:BOB-3` is waiting on bob’s review, and the webhook retries `task:BOB-4` are under way. Here’s what’s open on the payments work:',
      '',
      '```beluga-tasks',
      'BOB-3',
      'BOB-4',
      'BOB-5',
      'BOB-6',
      'BOB-99',
      '```',
    ].join('\n'),
  },
  {
    // Asking what reviewers said: the PR's comments as cards, and the code they're about (BLG-514).
    match: /comments on (this|the) (pr|pull request)|what did (the )?reviewers? say/i,
    steps: ['Bash gh pr view --comments'],
    answer: [
      'One thread is still open: bob wants the refund routes registered next to their handlers. mia also asked to cover refunds.',
      '',
      '```beluga-pr-comments',
      'show: open',
      '```',
      '',
      'The check every route goes through is here:',
      '',
      '```beluga-code',
      'src/auth.ts:1-3',
      'highlight: 2',
      'note: requireUser throws without a session',
      '```',
    ].join('\n'),
  },
  {
    // A component that can't be built yet: the preview says why, in a short note.
    match: /\bprice ?tag\b/i,
    steps: ['Read src/components/PriceTag.tsx'],
    answer: ['PriceTag.tsx shows a price from cents:', '', '```beluga-preview', 'src/components/PriceTag.tsx', '```'].join('\n'),
  },
  {
    // Two components in one file: the preview's picker and All Components.
    match: /\bbadges?\b/i,
    steps: ['Read src/components/Badges.tsx'],
    answer: ['Badges.tsx has two small pieces, a Badge and a Stat:', '', '```beluga-preview', 'src/components/Badges.tsx', '```'].join('\n'),
  },
  {
    // A component drawn live in the answer (Settings › Experimental › Live previews).
    match: /\bpreview\b|show (me )?the hero/i,
    steps: ['Read src/components/Hero.tsx', 'Edit src/components/Hero.tsx'],
    answer: [
      'The new hero takes a tone, the faces of people already in, and weekly sign-ups as bars. Here it is, live:',
      '',
      '```beluga-preview',
      'src/components/Hero.tsx',
      'props: {"title": "Build together", "subtitle": "You, your friends, and everyone’s Claude.", "cta": "Start free"}',
      '```',
    ].join('\n'),
  },
  {
    // A long task, so you can try queueing messages (and sending one now) while Claude works.
    match: /deep dive|take your time/i,
    stepMs: 2500,
    steps: ['Glob **/*.ts', 'Read src/server.ts', 'Read src/payments.ts', 'Grep "TODO"', 'Read NOTES.md', 'Grep "session"', 'Read src/webhooks.ts', 'Bash npm test', 'Read package.json', 'Grep "retry"', 'Read README.md', 'Bash git log --oneline -20'],
    answer: 'Deep dive done. The riskiest parts are **webhook retries** (not idempotent) and **auth** (not started). Everything else is small and well tested.',
  },
  {
    // A long task you can talk to while it works: what you say goes into the turn (e2e/live-tail.spec.ts).
    match: /walk the codebase/i,
    stepMs: 1800,
    steerable: true,
    steps: ['Glob **/*.ts', 'Read src/server.ts', 'Read src/payments.ts', 'Grep "TODO"', 'Read NOTES.md', 'Grep "session"', 'Read src/webhooks.ts', 'Bash npm test', 'Read package.json', 'Grep "retry"'],
    answer: 'Walked the codebase, with your notes in mind. **Webhook retries** are the weak spot (not idempotent); the rest is small and well tested.',
  },
  {
    // A step that runs long while you steer: your message waits, sent but not read, until you Send it now (BLG-54).
    match: /full test suite/i,
    stepMs: 1200,
    steerable: true,
    slowStep: { step: 'Bash npm run test:all', ms: 45_000 },
    steps: ['Read package.json', 'Glob tests/**/*.test.ts', 'Bash npm run test:all', 'Read test-results/summary.txt'],
    answer: 'The full suite passes: **2,455 tests**, none flaky this run. The slowest are the webhook retry tests (about 40s).',
  },
  {
    // Background work with steps after it: once answered, it folds with the older steps (e2e/subagents.spec.ts).
    match: /keep (them )?watching/i,
    // The reading after it, slow enough to see the background row running, even on a busy machine.
    stepMs: 1500,
    steps: ['Read package.json', 'Bash npm test'],
    subagents: [{ title: 'npm test --watch', steps: ['24 passed', '24 passed'], kind: 'background' }],
    after: ['Read src/payments.ts', 'Grep "coverage"', 'Read README.md'],
    answer: 'All **24 tests** pass, and they keep running in the background. `payments.ts` is the least covered file.',
  },
  {
    match: /review|changes|check my work/i,
    steps: ['Bash git diff origin/main --stat'],
    subagents: [
      { title: 'code-reviewer · correctness', steps: ['Read src/auth.ts', 'Read src/server.ts', 'Grep "session"', 'Read src/payments.ts'] },
      { title: 'security-reviewer · auth flow', steps: ['Read src/auth.ts', 'Grep "cookie"', 'Grep "secret"'] },
      { title: 'test-runner · run tests', steps: ['Bash npm test', 'Bash npm test -- --coverage'] },
    ],
    answer:
      '**Looks good to merge.** 3 reviewers checked it.\n\n- `requireUser()` correctly rejects missing sessions\n- Cookie is `httpOnly` and `sameSite=lax`\n- All **27 tests** pass\n\n**One suggestion:** add a test for expired sessions.',
  },
  {
    match: /build|implement|add|create|make/i,
    steps: ['Read src/server.ts', 'Write src/auth.ts', 'Edit src/server.ts', 'Bash npm test'],
    subagents: [
      { title: 'Explore · find the right place', steps: ['Glob src/**/*.ts', 'Grep "app.get"', 'Read src/server.ts'] },
      { title: 'Plan · design the change', steps: ['Read README.md', 'Read content/hero.md'] },
    ],
    answer: 'Done. Added `src/auth.ts` with a `requireUser()` middleware and wired it into `/api/payments/*`. Run `npm test` to see the new tests.',
  },
  {
    match: /auth|login|security/i,
    steps: ['Read NOTES.md', 'Grep "auth" src/', 'Read src/server.ts'],
    answer:
      "Auth isn't wired up yet. `src/server.ts` has a `TODO: add auth` and no middleware.\n\n**Plan:**\n- Add a session check in `requireUser()`\n- Protect `/api/payments/*`\n- Cover it with 3 tests",
  },
  {
    match: /report|write up|summary|summarize/i,
    steps: ['Glob **/*.md', 'Read README.md', 'write_report Project overview'],
    answer: 'Wrote **Project overview** to `.beluga/reports/`. Open it from the files panel.',
    report: {
      title: 'Project overview',
      markdown: '# Project overview\n\n- **Stack:** Node + TypeScript\n- **Status:** payments in progress, auth not started\n- **Next:** add auth middleware, then deploy\n',
    },
  },
  {
    match: /test/i,
    steps: ['Read package.json', 'Bash npm test'],
    subagents: [{ title: 'npm test --watch', steps: ['24 passed', '24 passed'], kind: 'background' }],
    answer: 'All **24 tests** pass. Coverage is 87%; `payments.ts` is the least covered file.',
  },
];

/** A request to change something (the main folder can't, so it moves to a worktree). */
const WANTS_CHANGE = /\b(build|implement|add|create|make|fix|change|edit|refactor|rename|update|remove|delete|write(?! up)|commit)\b/i;

const FALLBACK: Script = {
  match: /.*/,
  steps: ['Read README.md', 'Glob src/**'],
  answer: 'This is a small TypeScript API. `README.md` covers setup and `NOTES.md` tracks open work. Ask me about auth, tests, or a written report.',
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

const MOCK_PLAN = `## Plan: add auth

1. Add \`src/auth.ts\` with a \`requireUser()\` middleware
2. Protect \`/api/payments/*\`
3. Cover it with 3 tests (missing, expired, valid session)

Nothing is changed until you approve.`;

async function mockPlan(input: AgentRunInput, pace: number): Promise<string> {
  for (const step of ['Read src/server.ts', 'Grep "app.get"', 'Read NOTES.md']) {
    await sleep(450 * pace, input.signal);
    input.onEvent('tool', step);
  }
  // The plan is for a task: written up in Claude's words (it goes on the board once approved).
  if (input.board && input.planTask?.needsDefinition()) {
    input.onEvent('tool', 'task_define Protect the payment routes');
    input.board.define({
      title: 'Protect the payment routes',
      goal: 'Only signed-in users can reach `/api/payments/*`; everyone else gets a 401.',
      context: '`src/server.ts` has a `TODO: add auth` and no middleware. Sessions are signed cookies set by the login route.',
      acceptance: ['`requireUser()` rejects a missing session with 401', 'Expired sessions are rejected too', 'Tests cover missing, expired and valid sessions'],
      decisions: ['Signed cookies, no server-side session store: the API runs on one box'],
      questions: ['Should admins bypass the check for support tools?'],
      estimate: 2,
      priority: 'high',
    });
  }
  input.onEvent('text', MOCK_PLAN);
  const answer = input.askUser ? await input.askUser({ kind: 'plan', plan: MOCK_PLAN }) : ({ kind: 'skip' } as const);
  if (answer.kind === 'plan' && answer.approve) input.planTask?.approved();
  if (answer.kind !== 'plan' || !answer.approve) return answer.kind === 'plan' && answer.feedback ? `Got it. I'll revise the plan: ${answer.feedback}` : 'Okay, I left everything as it was.';
  for (const step of ['Write src/auth.ts', 'Edit src/server.ts', 'Bash npm test']) {
    await sleep(450 * pace, input.signal);
    input.onEvent('tool', step);
  }
  return 'Done. `requireUser()` protects `/api/payments/*` and all **27 tests** pass.';
}

/** The demo's planner: a first plan from what you asked, a revision for what you say next, and milestone checks. */
async function mockPlanning(input: AgentRunInput, plan: NonNullable<AgentRunInput['planTools']>, pace: number): Promise<string> {
  // Verifying a draft (BLG-772): it reads the plan and finds one thing to fix (an empty plan: nothing).
  if (plan.review && /Review the draft|changed since your last review/.test(input.prompt)) {
    input.onEvent('tool', 'plan_get');
    const shown = plan.get();
    await sleep(900 * pace, input.signal);
    const ids = [...shown.matchAll(/- \[([\w-]+)\]/g)].map((m) => m[1]!);
    // Each check in turn, named as it starts (what the plan's page shows while it works).
    for (const line of [
      `Contradictions: reading every task against the plan’s goal and its decisions.`,
      `Duplicates: comparing the ${ids.length} tasks’ titles and goals, across milestones.`,
      'Stale: looking for text written for an idea the plan dropped.',
      'Order: checking what each task builds on, and which milestones run side by side.',
    ]) {
      input.onEvent('text', line);
      await sleep(1100 * pace, input.signal);
    }
    input.onEvent('tool', 'plan_review');
    if (ids.length < 2 || /Rate limits/i.test(shown) === false) {
      plan.review([]);
      return 'The plan holds together: nothing to fix.';
    }
    plan.review([{ kind: 'order', text: `“Rate limits on the export endpoint” changes the export route that [${ids[0]}] builds, in a milestone that runs beside it: make it wait on [${ids[0]}], or move it into the same milestone.`, ids: [ids[0]!] }]);
    return 'One thing to fix before it’s approved.';
  }
  const check = /milestone “([^”]+)” is finished/i.exec(input.prompt) ?? /Every task of milestone “([^”]+)”/i.exec(input.prompt);
  if (check) {
    for (const step of ['task_get', 'Bash git diff main...HEAD --stat', 'Bash npm test']) {
      await sleep(400 * pace, input.signal);
      input.onEvent('tool', step);
    }
    input.onEvent('tool', `plan_gate ${check[1]}`);
    plan.gate(check[1]!, 'pass', '1. ✓ Checked the tasks’ pull requests and handoffs.\n2. ✓ `npm test` passes (27 tests).');
    return `Checked **${check[1]}**: every pass criterion holds. ${/autopilot/i.test(plan.get()) ? 'Moving on.' : 'It’s yours to pass.'}`;
  }
  for (const step of ['Glob src/**/*.ts', 'Read src/server.ts', 'Read src/payments.ts', 'Grep "TODO"', 'task_list']) {
    await sleep(350 * pace, input.signal);
    input.onEvent('tool', step);
  }
  const empty = /The plan is empty|no milestones/i.test(plan.get()) || !/## 1\./.test(plan.get());
  if (empty) {
    const what = input.prompt.replace(/\s+/g, ' ').trim().replace(/[.!?]$/, '');
    input.onEvent('tool', 'plan_write');
    plan.write({
      // A name, as Claude would give it: never your message cut off.
      title: mockPlanTitle(what) ?? 'New plan',
      goal: `${what}. Shipped in small pull requests, each one tested.`,
      milestones: [
        {
          id: 'groundwork',
          title: 'Groundwork',
          goal: 'The pieces everything else builds on.',
          criteria: ['The new data model is migrated and tested', 'CI is green'],
          tasks: [
            { id: 'model', title: 'Data model and migration', goal: 'Store what the feature needs.', context: 'Postgres via `src/db.ts`.', acceptance: ['Migration runs up and down', 'Model has tests'], estimate: 2, touches: ['src/db', 'migrations'] },
            { id: 'api-shape', title: 'API shape', goal: 'Agree the endpoints and their errors.', acceptance: ['Routes and payloads written down in docs/api.md'], estimate: 1, touches: ['docs/api.md'] },
          ],
        },
        {
          id: 'build',
          title: 'Build it',
          goal: 'The feature works end to end.',
          criteria: ['The happy path works end to end in the demo', 'Errors are handled and tested'],
          tasks: [
            { id: 'endpoints', title: 'Endpoints', goal: 'The API from the agreed shape.', acceptance: ['Every route has tests', 'Errors match docs/api.md'], blockedBy: ['model', 'api-shape'], estimate: 3, touches: ['src/routes'] },
            { id: 'ui', title: 'Screens', goal: 'The admin screens for it.', acceptance: ['Works on narrow windows', 'Empty and error states'], blockedBy: ['api-shape'], estimate: 3, touches: ['admin'] },
            { id: 'e2e', title: 'End-to-end test', acceptance: ['One test walks the whole flow'], blockedBy: ['endpoints', 'ui'], estimate: 2, touches: ['e2e'] },
          ],
        },
        {
          id: 'ship',
          title: 'Ship',
          goal: 'Out to everyone, safely.',
          criteria: ['Docs updated', 'Released behind no flag'],
          tasks: [
            { id: 'docs', title: 'Docs and changelog', acceptance: ['README and CHANGELOG say what changed'], estimate: 1, touches: ['README.md', 'CHANGELOG.md'] },
            { id: 'release', title: 'Release', goal: 'Tag and deploy.', acceptance: ['Deployed', 'Smoke test passes'], assignee: 'me', estimate: 1 },
          ],
        },
      ],
    });
    return [
      'Here’s a plan in **3 milestones**:',
      '',
      '1. **Groundwork** — the data model and the API shape, side by side.',
      '2. **Build it** — endpoints and screens in parallel, then an end-to-end test.',
      '3. **Ship** — docs, then the release (yours).',
      '',
      '**Risk:** the migration touches a busy table; it runs before anything else. Approve it, or tell me what to change.',
    ].join('\n');
  }
  input.onEvent('tool', 'plan_update');
  const added = input.prompt.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Follow-up';
  const milestone = /\[id ([\w-]+)\][^\n]*(?:in progress|not started|draft)/.exec(plan.get())?.[1] ?? /\[id ([\w-]+)\]/.exec(plan.get())?.[1] ?? 'build';
  let result: string;
  try {
    result = plan.update([{ op: 'add_task', milestone, task: { title: added.charAt(0).toUpperCase() + added.slice(1), goal: input.prompt.trim().slice(0, 400), acceptance: ['Covered by a test'], estimate: 2 } }], 'what you asked for');
  } catch (err) {
    return `I couldn’t change the plan: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `Added **${added}** to the plan. ${result}`;
}

/** "run the tests on bob's computer" / "check my machine": whose computer, and which command. */
export function peerRunTarget(prompt: string, requester: string): { peer: string; command: string } | undefined {
  const named = /\bon (\w[\w.-]*)'s (computer|machine|laptop)\b/i.exec(prompt);
  const mine = /\b(on|check) my (computer|machine|laptop)\b/i.test(prompt);
  if (!named && !mine) return undefined;
  const quoted = /`([^`]+)`/.exec(prompt)?.[1];
  const command = quoted ?? (/\btests?\b/i.test(prompt) ? 'npm test' : 'ls');
  return { peer: named ? named[1]! : requester, command };
}

async function mockPeerRun(input: AgentRunInput, bridge: RoomBridge, target: { peer: string; command: string }, pace: number): Promise<string> {
  await sleep(450 * pace, input.signal);
  input.onEvent('tool', 'list_peers');
  input.onEvent('tool', `run_on_peer ${target.command}${MORE}${JSON.stringify({ peer: target.peer })}`);
  const result = await bridge.runOnPeer!(target.peer, target.command, { why: 'to check before I change anything' }).catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  const head = result.split('\n')[0] ?? '';
  if (/did not run|failed:/.test(head)) return `I couldn't run \`${target.command}\` on ${target.peer}'s computer: ${head.replace(/^.*?: /, '')}`;
  const passed = /(\d+) passed \(/.exec(result.split('\n').filter((l) => /Tests/.test(l)).join('\n'))?.[1];
  return `Ran \`${target.command}\` on ${target.peer}'s computer. ${head}.${passed ? ` **${passed} tests pass.**` : ''}`;
}

/** "ask bob to run the tests" / "ask mia's Claude whether …" / "@bob run the tests": whom to ask, and what. */
export function gatewayTarget(prompt: string): { person: string; ask: string } | undefined {
  // "@claude:bob run the tests": bob's Claude, said outright.
  const theirs = /(?:^|\s)@claude:(\w[\w.-]*)[,:]?\s+([\s\S]+)/i.exec(prompt.trim());
  if (theirs) return { person: theirs[1]!, ask: theirs[2]!.trim().replace(/[.?!]+$/, '') };
  // A task ("@BLG-24 (task: …)", see explainTaskMentions) is nobody to ask.
  const tagged = /(?:^|\s)@(?!claude)(?![A-Za-z][A-Za-z0-9]*-\d+ \(task: )(\w[\w.-]*)[,:]?\s+([\s\S]+)/i.exec(prompt.trim());
  if (tagged) return { person: tagged[1]!, ask: tagged[2]!.trim().replace(/[.?!]+$/, '') };
  const m = /\bask (\w[\w.-]*?)(?:['’]s claude)?(?: to)?\s+([\s\S]+)/i.exec(prompt.trim());
  if (!m || /^(me|you|claude|it|them|him|her)$/i.test(m[1]!)) return undefined;
  return { person: m[1]!, ask: m[2]!.trim().replace(/[.?!]+$/, '') };
}

const TEST_SCHEMA = { type: 'object', required: ['passed', 'failed'], properties: { passed: { type: 'integer' }, failed: { type: 'integer' }, skipped: { type: 'integer' } } };

/** What a result says, pulled out of the delimited block (the demo only shows it back). */
function readResult(text: string): { summary: string; data?: unknown } | undefined {
  const block = /<task_result[^>]*>\n([\s\S]*?)\n<\/task_result>/.exec(text)?.[1];
  if (!block) return undefined;
  const summary = /summary:\n([\s\S]*?)(?:\n\ndata \(JSON\):|\n\nfiles|$)/.exec(block)?.[1]?.trim() ?? '';
  const raw = /data \(JSON\):\n([\s\S]*?)(?:\n\n|$)/.exec(block)?.[1];
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { summary, ...(data !== undefined ? { data } : {}) };
}

function tableOf(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const rows = Object.entries(data as Record<string, unknown>);
  return rows.length ? `\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v)} |`).join('\n')}` : '';
}

/** The demo's Claude asks a friend's Claude (the gateway tools) and waits for the answer. */
async function mockAsk(input: AgentRunInput, bridge: RoomBridge, target: { person: string; ask: string }, pace: number): Promise<string> {
  const gw = bridge.gateway!;
  await sleep(400 * pace, input.signal);
  input.onEvent('tool', 'who_can');
  await sleep(300 * pace, input.signal);
  input.onEvent('tool', `ask_person ${target.person}${MORE}${JSON.stringify({ ask: target.ask })}`);
  let sent: string;
  try {
    sent = gw.askPerson({ person: target.person, ask: target.ask, summary: target.ask.length > 70 ? `${target.ask.slice(0, 69)}…` : target.ask, ...(/\btests?\b/i.test(target.ask) ? { expects: TEST_SCHEMA } : {}) });
  } catch (err) {
    return `I couldn't ask ${target.person}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const id = /Task (t_[\w-]+)/.exec(sent)?.[1];
  if (!id) return `I couldn't ask ${target.person}: ${sent}`;
  input.onEvent('tool', `wait_for ${id}`);
  const answer = await gw.waitFor(id, 120);
  const result = readResult(answer);
  if (!result) return `I asked ${target.person}; no answer yet. I'll pick it up here when it arrives.`;
  if (/^status: (declined|cancelled|failed)/m.test(answer)) return `${target.person} didn't do it: ${result.summary}`;
  return `${target.person}'s Claude says: ${result.summary}${tableOf(result.data)}`;
}

/** The demo's Claude bringing main up to date: the steps and the explanation, without touching git. */
async function mockSyncMain(input: AgentRunInput, target: { branch: string; upstream: string }, pace: number): Promise<string> {
  for (const step of ['git status', `git log --oneline --graph -15 ${target.branch} ${target.upstream}`, 'git stash push -u -m "before updating main"', `git merge ${target.upstream}`, 'git stash pop']) {
    await sleep(500 * pace, input.signal);
    input.onEvent('tool', `Bash ${step}`);
  }
  await sleep(400 * pace, input.signal);
  return `${target.branch} is up to date with ${target.upstream}. I set your uncommitted changes aside, merged the new commits (no conflicts), and put your changes back. Nothing was pushed.`;
}

/** The demo's Claude in a sentinel run (core/sentinel): a short brief whose first line is the run's headline. */
async function mockSentinel(input: AgentRunInput, pace: number): Promise<string> {
  const steps = /test/i.test(input.prompt)
    ? ['Bash npm test', 'Read src/webhooks.ts']
    : /issue/i.test(input.prompt)
      ? ['Bash gh issue list --json number,title,labels', 'mcp__beluga_board__task_list']
      : ['Bash git log --since="24 hours ago" --oneline', 'Bash gh pr list', 'Bash gh run list --limit 10', 'Read NOTES.md'];
  for (const step of steps) {
    await sleep(600 * pace, input.signal);
    input.onEvent('tool', step);
  }
  await sleep(500 * pace, input.signal);
  return [
    '3 commits landed, 1 review waits on you, CI is green',
    '',
    '**Needs you first**',
    '- bob asked for your review on the webhook retries `task:BOB-4`',
    '',
    '**What moved**',
    '- Sign-in with a `+` in the email is fixed (merged as #52)',
    '- Checkout now refuses expired sessions `task:BOB-3`',
    '- The landing hero has its new copy',
    '',
    '**Next**',
    '- Refunds from the admin are the last open part of the payments launch',
  ].join('\n');
}

/**
 * The demo's Claude in a sentinel run that keeps numbers (Stripe revenue): it reads what the step
 * before brought and keeps the numbers its brief names with sentinel_measure.
 */
async function mockMeasure(input: AgentRunInput, tools: NonNullable<AgentRunInput['dashboardTools']>, pace: number): Promise<string> {
  const keeps = /it keeps ([^.]+)\./.exec(input.sentinelBrief ?? '')?.[1] ?? '';
  const names = [...keeps.matchAll(/([a-z0-9-]+)(?: \(([^)]+)\))?/g)].map((m) => ({ name: m[1]!, unit: m[2] }));
  const seed = new Date().getDate();
  const value = (name: string): number => (/revenue/.test(name) ? 3_200 + ((seed * 37) % 400) : /fail/.test(name) ? seed % 3 : /sub/.test(name) ? 3 + (seed % 6) : 10 + (seed % 20));
  await sleep(700 * pace, input.signal);
  input.onEvent('tool', 'Read the events');
  const kept: string[] = [];
  for (const n of names.length ? names : [{ name: 'value', unit: undefined }]) {
    await sleep(350 * pace, input.signal);
    input.onEvent('tool', 'mcp__beluga_dashboard__sentinel_measure');
    tools.measure!(n.name, value(n.name), n.unit);
    kept.push(`${value(n.name).toLocaleString('en-US')} ${n.name.replace(/-/g, ' ')}`);
  }
  return `${kept.join(', ')}\n\nAdded up from the last day’s events.`;
}

/** The demo's Claude building a dashboard from words: a tile for each number the words name (or the first few), and a chart of the first. */
async function mockDashboardAsk(input: AgentRunInput, tools: NonNullable<AgentRunInput['dashboardTools']>, id: string, pace: number): Promise<string> {
  const said = input.prompt.toLowerCase();
  await sleep(600 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_dashboard__metric_list');
  // "Shop (id sn_x, on, …):" then "  - name: Label · …" lines.
  const found: Array<{ sentinel: string; metric: string; label: string }> = [];
  let sentinel = '';
  for (const line of tools.metricList().split('\n')) {
    const head = /\(id (sn_\w+),/.exec(line);
    if (head) sentinel = head[1]!;
    const m = /^\s+- ([a-z0-9-]+): ([^·]+?) · (?!rows)/.exec(line);
    if (m && sentinel) found.push({ sentinel, metric: m[1]!, label: m[2]!.trim() });
  }
  const wanted = found.filter((f) => said.split(/[^a-z]+/).some((w) => w.length > 3 && (f.label.toLowerCase().includes(w.replace(/s$/, '')) || f.metric.includes(w.replace(/s$/, '')))));
  // Something nothing keeps yet ("the open PR count"): a draft sentinel that fetches it, then its tile.
  const fetches = /\b(pr|prs|pull requests?|open issues?|count of|how many)\b/.test(said) && !wanted.length;
  if (fetches && input.sentinelTools) return mockFetchTile(input, input.sentinelTools, tools, id, pace);
  const tiles = (wanted.length ? wanted : found.slice(0, 3)).slice(0, 6);
  const compare = /last week|week/.test(said) ? ('week' as const) : /yesterday/.test(said) ? ('day' as const) : /month/.test(said) ? ('month' as const) : undefined;
  for (const t of tiles) {
    await sleep(400 * pace, input.signal);
    input.onEvent('tool', 'mcp__beluga_dashboard__dashboard_add_tile');
    tools.addTile(id, { kind: 'number', sentinel: t.sentinel, metric: t.metric, ...(compare ? { compare } : {}) });
  }
  if (tiles[0] && /chart|graph|over time|trend/.test(said)) {
    input.onEvent('tool', 'mcp__beluga_dashboard__dashboard_add_tile');
    tools.addTile(id, { kind: 'series', width: 3, metrics: [{ sentinel: tiles[0].sentinel, metric: tiles[0].metric }] });
  }
  await sleep(300 * pace, input.signal);
  return tiles.length ? `Added ${tiles.map((t) => t.label).join(', ')}${compare ? `, compared with ${compare === 'day' ? 'yesterday' : `last ${compare}`}` : ''}.` : 'There are no numbers kept yet: a sentinel with a Keep the numbers step keeps them.';
}

/**
 * The demo's Claude adding a tile for something no sentinel fetches yet: a draft sentinel that
 * counts the open pull requests every morning (paused until you turn it on), and its number tile.
 */
async function mockFetchTile(input: AgentRunInput, sentinels: NonNullable<AgentRunInput['sentinelTools']>, tools: NonNullable<AgentRunInput['dashboardTools']>, id: string, pace: number): Promise<string> {
  const issues = /issue/.test(input.prompt.toLowerCase());
  const what = issues ? { name: 'Open issues', metric: 'open-issues', label: 'Open issues', cmd: 'gh issue list --state open --json number --jq length' } : { name: 'Open pull requests', metric: 'open-prs', label: 'Open pull requests', cmd: 'gh pr list --state open --json number --jq length' };
  await sleep(500 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_list');
  await sleep(600 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_create');
  const made = await sentinels.create({
    name: what.name,
    trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'catch-up' },
    steps: [
      { kind: 'script', name: 'Count them', command: what.cmd, cwd: 'project', timeoutSec: 60 },
      { kind: 'measure', name: 'Keep the number', from: 'previous', metrics: [{ name: what.metric, label: what.label, unit: 'count', better: 'down' }] },
    ],
  } as unknown as Parameters<typeof sentinels.create>[0]);
  const sid = /`sentinel:([\w-]+)`/.exec(made)?.[1] ?? what.name;
  await sleep(400 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_dashboard__dashboard_add_tile');
  tools.addTile(id, { kind: 'number', sentinel: sid, metric: what.metric, title: what.label });
  await sleep(300 * pace, input.signal);
  return `Nothing kept ${what.label.toLowerCase()} yet, so I set up \`sentinel:${sid}\`: every day at 9:00 it counts them with gh and keeps the number. It’s a draft: turn it on and the tile fills in after its first run.`;
}

/**
 * The demo's Sentinel chat (docs/sentinel.md §12): it reads Sentinel as it is (sentinel_list), and
 * pauses, runs or deletes the sentinel the words name; a delete asks you first, as the real one does.
 */
async function mockSentinelChat(input: AgentRunInput, tools: NonNullable<AgentRunInput['sentinelTools']>, dash: AgentRunInput['dashboardTools'], pace: number): Promise<string> {
  const said = input.prompt.toLowerCase();
  await sleep(500 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_list');
  const list = tools.list();
  // "Morning brief · Every day at 7:00 · watching · Look · last run done: … · `sentinel:sn_x`"
  const items = list.split('\n').flatMap((l) => {
    const m = /^(.+?) · (.+?) · (.+?) · .*`sentinel:([\w-]+)`/.exec(l);
    return m ? [{ name: m[1]!, when: m[2]!, state: m[3]!, id: m[4]!, line: l }] : [];
  });
  const named = items.filter((x) => said.includes(x.name.toLowerCase()) || x.name.toLowerCase().split(/\s+/).some((w) => w.length > 4 && said.includes(w)));
  const target = named[0];
  if (/\b(delete|remove)\b/.test(said) && /dashboard/.test(said) && dash) {
    const boards = dash.list().split('\n').flatMap((l) => {
      const m = /^(.+?) \(id (db_\w+)\)/.exec(l);
      return m ? [{ name: m[1]!, id: m[2]! }] : [];
    });
    const d = boards.find((b) => said.includes(b.name.toLowerCase()));
    if (!d) return `Which dashboard? There are ${boards.map((b) => b.name).join(', ') || 'none'}.`;
    input.onEvent('tool', 'mcp__beluga_dashboard__dashboard_remove');
    if (!(await input.canUseTool('mcp__beluga_dashboard__dashboard_remove', { dashboard: d.id }))) return `You said no, so “${d.name}” stays.`;
    dash.remove(d.id);
    return `Deleted the dashboard “${d.name}”. Its numbers stay with their sentinels.`;
  }
  if (/\b(delete|remove)\b/.test(said)) {
    if (!target) return `Which one? You have ${items.map((x) => x.name).join(', ') || 'no sentinels yet'}.`;
    await sleep(400 * pace, input.signal);
    input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_remove');
    if (!(await input.canUseTool('mcp__beluga_sentinel__sentinel_remove', { id: target.id }))) return `You said no, so “${target.name}” keeps watching.`;
    tools.remove(target.id);
    return `Deleted “${target.name}”. It stopped watching; its runs’ reports go with the next clean-up.`;
  }
  if (/\bpause\b/.test(said) && target) {
    input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_pause');
    return tools.pause(target.id).replace(/^“/, 'Done: “');
  }
  if (/\brun\b/.test(said) && target) {
    input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_run');
    return `${tools.run(target.id)}. Its tiles update when it’s done.`;
  }
  await sleep(500 * pace, input.signal);
  if (dash) input.onEvent('tool', 'mcp__beluga_dashboard__metric_list');
  const on = items.filter((x) => x.state === 'watching');
  const off = items.filter((x) => x.state !== 'watching');
  return [
    `${on.length} of your ${items.length} sentinels are watching${off.length ? `; ${off.map((x) => x.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} paused` : ''}.`,
    '',
    ...on.slice(0, 6).map((x) => `- **${x.name}** · ${x.when.toLowerCase()} \`sentinel:${x.id}\``),
    '',
    'Ask me to change one, add a tile for something, or set up a new watcher.',
  ].join('\n');
}

/**
 * The demo's Claude setting a sentinel up from words (Describe it, the page's box): when it runs
 * from the time and days the words name, an Ask Claude step with them as its prompt, and a Notify.
 */
async function mockSentinelAsk(input: AgentRunInput, tools: NonNullable<AgentRunInput['sentinelTools']>, id: string, pace: number): Promise<string> {
  const words = input.prompt.trim();
  const said = words.toLowerCase();
  await sleep(700 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_get');
  await sleep(600 * pace, input.signal);
  input.onEvent('tool', 'Bash git log --oneline -5');
  // "at 8", "8am", "7:30": the hour it runs (7 in the morning when the words say none).
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(said) ?? /\bat\s+(\d{1,2})(?::(\d{2}))?\b/.exec(said) ?? /\b(\d{1,2}):(\d{2})\b/.exec(said);
  const h = time ? Number(time[1]) : /evening/.test(said) ? 18 : 7;
  const hour = time?.[3] === 'pm' && h < 12 ? h + 12 : time?.[3] === 'am' && h === 12 ? 0 : h;
  const at = `${String(Math.min(23, hour)).padStart(2, '0')}:${time?.[2] ?? '00'}`;
  const trigger = /weekday/.test(said)
    ? { kind: 'schedule' as const, every: 'week' as const, days: [1, 2, 3, 4, 5], at, missed: 'catch-up' as const }
    : /\bweek(ly)?\b|monday/.test(said)
      ? { kind: 'schedule' as const, every: 'week' as const, days: [1], at, missed: 'catch-up' as const }
      : /hour/.test(said)
        ? { kind: 'schedule' as const, every: 'hours' as const, hours: 3 as const, at: '00:00', missed: 'skip' as const }
        : /morning|daily|every day|night|evening/.test(said)
          ? { kind: 'schedule' as const, every: 'day' as const, at, missed: 'catch-up' as const }
          : { kind: 'manual' as const };
  const firstWords = words
    .replace(/^(every|each)\s+(other\s+)?(weekday|week|day|morning|evening|night|hour)s?(\s+(morning|evening|night))?,?\s*/i, '')
    .replace(/^(at|by|on)\s+[\w:]+(\s*(am|pm))?\s*,?\s*/i, '')
    .split(/[,.;]/)[0]!
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .replace(/(\s+(and|or|the|a|an|to|of|with|for))+$/i, '');
  const name = firstWords ? firstWords.charAt(0).toUpperCase() + firstWords.slice(1) : 'Watcher';
  const tasks = /task/.test(said);
  const steps = [
    { kind: 'claude' as const, name: 'Read what changed', where: /mac\b|disk|screen/.test(said) ? ('mac' as const) : ('project' as const), prompt: `${words}\n\nLook at what changed since the last run in {{project}} ({{date}}): commits, pull requests, issues, CI and these open tasks:\n{{tasks}}\n\nStart with what needs the user first.${tasks ? ' Make a task (task_create) for anything that looks urgent.' : ''} If nothing changed, say so in one line and stop.` },
    { kind: 'notify' as const, name: 'Tell me', phone: /phone/.test(said) },
  ];
  await sleep(800 * pace, input.signal);
  input.onEvent('tool', 'mcp__beluga_sentinel__sentinel_update');
  try {
    await tools.update(id, { name, trigger, steps });
  } catch (err) {
    return `I couldn’t change it: ${err instanceof Error ? err.message : String(err)}`;
  }
  await sleep(400 * pace, input.signal);
  const when = trigger.kind === 'manual' ? 'it runs when you press Run' : trigger.every === 'week' && trigger.days?.length === 5 ? `every weekday at ${at.replace(/^0/, '')}` : trigger.every === 'week' ? `every Monday at ${at.replace(/^0/, '')}` : trigger.every === 'hours' ? 'every 3 hours' : `every day at ${at.replace(/^0/, '')}`;
  return `Set it up: ${when}, Claude reads what changed and writes a brief${tasks ? ', with tasks for anything urgent' : ''}, then tells you${/phone/.test(said) ? ' on your phone' : ''}. It’s paused: Turn On when it looks right.`;
}

const FILLER = /^(?:(?:please|pls|can you|could you|we should|we need to|i want to|i'd like to|let's|lets|make it so)\s+)+/i;

/** The demo's About This Project (it reads no files). */
export function mockAbout(project: string): string {
  return [`${project} is a small web app and its API, for a team that ships every week.`, '', '- `src/`: the server (routes, then services, then the database)', '- `web/`: the app people use', '- `tests/`: one file per route'].join('\n');
}

/** The demo's task writer: a tidy title from the first line, a goal and criteria, labels the words name. */
export function mockDraft(text: string, ctx: DraftContext): TaskDraft {
  // New Task (BLG-319): a list makes one task per line ("for Ata" gives it to Ata), under an epic
  // when the words say so.
  const items = ctx.several ? text.split('\n').flatMap((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)/.exec(l)?.[1]?.trim() ?? []).slice(0, MAX_TASKS) : [];
  if (items.length > 1) {
    const tasks = items.map((item) => {
      const named = /\b(?:for|to)\s+([\p{L}][\p{L}'-]*)\s*[.!]?$/iu.exec(item);
      const who = matchPerson(named?.[1], ctx.people ?? []);
      const d = mockDraft(who ? item.slice(0, named!.index).trim() : item, { ...ctx, several: false });
      return who ? { ...d, for: who } : d;
    });
    const intro = text.split('\n').find((l) => l.trim() && !/^\s*(?:[-*•]|\d+[.)])\s/.test(l));
    if (intro && /\bepic\b/i.test(intro)) {
      const epic = mockDraft(intro.replace(/\b(?:an?\s+)?epic\b(?:\s+(?:for|to))?:?/i, '').replace(/[:,]\s*$/, ''), { ...ctx, several: false });
      return { title: epic.title, goal: epic.goal, acceptance: [], labels: [], more: tasks, epic: true };
    }
    const [first, ...rest] = tasks;
    return { ...first!, more: rest };
  }
  const words = firstLineTitle(text).replace(FILLER, '').replace(/[.!?]+$/, '').split(' ').slice(0, 8).join(' ');
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  const said = text.toLowerCase();
  const labels = ctx.labels.filter((l) => said.includes(l.toLowerCase()));
  const priority = /\b(urgent|asap|right now)\b/.test(said) ? 'urgent' : /\b(important|soon)\b/.test(said) ? 'high' : undefined;
  return {
    title,
    goal: `${title}, so it works the way it was described. Done when it does, and nothing around it changes.`,
    // After a look at the code (the demo reads none): where it is and what's likely behind it.
    ...(ctx.look
      ? {
          context: [
            'Looked at the code before writing this:',
            '- **Where it happens:** `src/routes/` and the handler it calls, the first place to check.',
            '- **How it works today:** the request goes straight through, without the step this needs.',
            '- **Likely fix:** add that step where the request comes in, with a test that reproduces the report first.',
          ].join('\n'),
        }
      : {}),
    acceptance: [`${title}: works as described`, 'Nothing else changes', 'Tests cover it'],
    labels,
    ...(priority ? { priority } : {}),
  };
}

const PLAN_TITLE_STOP = new Set(
  'about above after again also although among another anything around because been before being between both but can could couple does doing done each even every few for from front have here into its just keep like look looks make more most much need needs nothing now once only other our out over people really same should since some something such than that the their them then there these they thing things this those though through too under until very want was way were what when where which while who why claude will with without would yet you your'.split(' '),
);

/**
 * The demo's plan namer, as Haiku would name it: what the goal is about in at most three words (its
 * most-said words, in the order it says them), never its first words cut off. Undefined when the
 * goal says too little: the plan stays "New plan" until Claude's plan_write names it.
 */
function mockPlanTitle(goal: string): string | undefined {
  const words = (goal.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).filter((w) => w.length > 3 && !PLAN_TITLE_STOP.has(w));
  const seen = new Map<string, { n: number; at: number }>();
  words.forEach((w, at) => seen.set(w, { n: (seen.get(w)?.n ?? 0) + 1, at: seen.get(w)?.at ?? at }));
  const top = [...seen].sort(([, a], [, b]) => b.n - a.n || a.at - b.at).slice(0, 3);
  if (top.length < 2) return undefined;
  return cleanPlanTitle(top.sort(([, a], [, b]) => a.at - b.at).map(([w]) => w).join(' '));
}

/** The demo's MCP servers (Settings › Claude): one of each kind, two waiting for a sign-in. */
const DEMO_MCP: readonly McpServerRow[] = [
  { name: 'figma', label: 'figma', from: 'user', status: 'needs-auth', canSignIn: true },
  { name: 'plugin:context7:context7', label: 'context7', from: 'plugin', where: 'context7', status: 'connected', canSignIn: false },
  { name: 'linear', label: 'linear', from: 'project', where: 'bob-api', status: 'needs-auth', canSignIn: true },
  { name: 'plugin:ratel:ratel', label: 'ratel', from: 'plugin', where: 'ratel', status: 'failed', error: 'npx exited (code 1)', canSignIn: false },
  { name: 'claude.ai Gmail', label: 'Gmail', from: 'claude.ai', status: 'connected', canSignIn: false },
];

/** The demo's answer to a side question (/btw): short, about the work, as the real one would be. */
export function mockBtw(question: string): string {
  const q = question.trim().replace(/\?+$/, '');
  return `Short answer: yes. For “${q.slice(0, 80)}”, what I’ve done so far keeps the change inside \`src/core\`, and the tests I ran passed. I haven’t touched the phone app yet, so nothing there depends on it.`;
}

/** The demo's agent starting child threads through the real tools: `title=runtime:task`, split by semicolons. */
async function mockStartThreads(input: AgentRunInput, tools: ThreadTools, list: string, pace: number): Promise<string> {
  const answers: string[] = [];
  for (const item of list.split(';')) {
    const m = /^\s*(.+?)=(\w+):(.+?)\s*$/.exec(item);
    if (!m) continue;
    await sleep(200 * pace, input.signal);
    input.onEvent('tool', 'thread_start');
    answers.push(await tools.start({ title: m[1]!, agent: { runtime: m[2]! }, task: m[3]! }));
  }
  return answers.join('\n');
}

export function createMockBackend(bridge: RoomBridge, pace = 1): AgentBackend {
  const context = new MockContext();
  let mcp = DEMO_MCP;
  const signing = new Map<string, Promise<boolean>>();
  return {
    // The terminal view (BLG-534) on the demo's stand-in for Claude Code's terminal app.
    terminal: async (input, sink) => mockTerminal(input, sink),
    mcpServers: async () => {
      await new Promise((r) => setTimeout(r, 300 * pace));
      return mcp;
    },
    // The sign-in page is a stand-in; you're "back from the browser" a moment later.
    mcpSignIn: async (_projects, name) => {
      if (!mcp.some((m) => m.name === name && m.canSignIn)) return { error: `No MCP server named ${name}.` };
      signing.set(
        name,
        new Promise((r) => setTimeout(r, 1200 * pace)).then(() => {
          mcp = mcp.map((m) => (m.name === name ? { ...m, status: 'connected', canSignIn: false } : m));
          signing.delete(name);
          return true;
        }),
      );
      return { url: `https://example.com/oauth/${encodeURIComponent(name)}` };
    },
    mcpSignedIn: (name) => signing.get(name) ?? Promise.resolve(undefined),
    nameTask: async (prompt) => {
      await new Promise((r) => setTimeout(r, 600 * pace));
      return slugify(prompt);
    },
    draftTask: async (text, ctx) => {
      // "Take your time" in what you wrote: slow enough, at any pace, to watch the task being written (BLG-598).
      const watch = /take your time/i.test(text) ? 5000 : 0;
      await new Promise((r) => setTimeout(r, Math.max(watch, (ctx.look ? 6000 : 1500) * pace)));
      return mockDraft(text, ctx);
    },
    describeProject: async (_dir, project) => {
      await new Promise((r) => setTimeout(r, 4000 * pace));
      return mockAbout(project);
    },
    // A short name a moment later, as Haiku would give it.
    titlePlan: async (goal) => {
      await new Promise((r) => setTimeout(r, 400 * pace));
      return mockPlanTitle(goal);
    },
    titleChat: async (content) => {
      await new Promise((r) => setTimeout(r, 400 * pace));
      const latest = content.split('\n\n').filter((part) => part.startsWith('User: ')).at(-1);
      return cleanPlanTitle((latest ?? content).replace(/^User: /, ''));
    },
    // A side question: a beat of thinking, then the answer word by word, as Claude streams it.
    btw: async (req) => {
      await sleep(900 * pace, req.signal);
      const answer = mockBtw(req.question);
      let soFar = '';
      for (const word of answer.split(/(?<= )/)) {
        await sleep(35 * pace, req.signal);
        soFar += word;
        req.onText(soFar);
      }
      return answer;
    },
    answerChat: async (req) => {
      await sleep(1800 * pace, req.signal);
      return demoAnswerFromPrompt(req.system, req.prompt);
    },
    async run(original: AgentRunInput): Promise<string> {
      const stepper = original.onStep ? new MockStepper(original.prompt, original.onStep) : undefined;
      // The context window fills as Claude works (the meter moves live).
      const input = withGrowingContext(withSteps(original, stepper), context);
      try {
        return await runScript(input);
      } finally {
        stepper?.finish();
      }
    },
  };

  async function runScript(input: AgentRunInput): Promise<string> {
    const script = SCRIPTS.find((s) => s.match.test(input.prompt)) ?? FALLBACK;
    if (/^\/compact/.test(input.prompt.trim())) return context.compact(input, (ms) => sleep(ms * pace, input.signal));
    // Claude Code's sign-in ran out mid-run (BLG-589): the failed card offers Sign In's choices.
    if (/^sign-in expired$/i.test(input.prompt.trim())) throw new RunFailedError(classifyRun({ result: 'Failed to authenticate: Auth session expired and could not be refreshed', apiError: 'authentication_failed' }));
    // Your plan's usage limit (BLG-757): the card says when Beluga continues it, two hours from now. Also a child thread's task (its last line).
    if (/(^|\n)usage limit$/i.test(input.prompt.trim())) throw new RunFailedError({ kind: 'usage_limit', resetsAt: Date.now() + 2 * 60 * 60_000, detail: 'You’ve hit your limit' });
    // Updating main (the one thing a main-folder run may change): what real Claude would report.
    if (input.place?.syncMain) return mockSyncMain(input, input.place.syncMain, pace);
    // A sentinel's run (core/sentinel): its brief, before the main folder's "move it to a worktree".
    if (input.sentinelBrief && input.sentinelTools?.stop) return input.dashboardTools?.measure && /sentinel_measure/.test(input.sentinelBrief) ? mockMeasure(input, input.dashboardTools, pace) : mockSentinel(input, pace);
    // Building a dashboard (its Describe it): the numbers that match the words, as tiles.
    if (input.dashboardTools?.building) return mockDashboardAsk(input, input.dashboardTools, input.dashboardTools.building, pace);
    // The Sentinel chat: it reads Sentinel and acts on the sentinel the words name.
    if (input.sentinelTools && /You are the Sentinel chat/.test(input.sentinelBrief ?? '')) return mockSentinelChat(input, input.sentinelTools, input.dashboardTools, pace);
    // Changing a sentinel (sentinel.ask): it reads the words, fills the sentinel in with its tools.
    if (input.sentinelTools?.asking) return mockSentinelAsk(input, input.sentinelTools, input.sentinelTools.asking, pace);
    // A plan's conversation: Claude writes, revises and checks the plan with its tools.
    if (input.planTools && !/^\/compact/.test(input.prompt.trim())) return mockPlanning(input, input.planTools, pace);
    // A main folder is questions only: a change request moves to a new worktree, as real Claude is told to.
    if (input.place?.askOnly && WANTS_CHANGE.test(input.prompt)) {
      if (!input.continueInWorktree) return "This is the project's main folder, which is read-only. Ask the owner to continue in a new worktree.";
      await sleep(300 * pace, input.signal);
      input.onEvent('tool', 'continue_in_worktree');
      await input.continueInWorktree(input.prompt.trim());
      return 'Moving this to a new worktree; I’ll continue there.';
    }
    // The demo's agent as a parent: "start threads: Login tests=codex:finish; Docs=claude:keep working".
    const kids = /^start threads: (.+)$/im.exec(input.prompt);
    if (kids && input.threadTools) return mockStartThreads(input, input.threadTools, kids[1]!, pace);
    // A child told to keep working (a run with thread tools): it works until someone stops it.
    if (input.threadTools && /\bkeep working$/i.test(input.prompt.trim())) await sleep(3_600_000, input.signal);
    // Plan mode, and questions back to you, work in the demo too.
    if (input.plan) return mockPlan(input, pace);
    // A friend's Claude answered after this conversation's turn ended: carry on with it.
    if (/^\[(?:beluga|klaud)\] /.test(input.prompt)) {
      await sleep(500 * pace, input.signal);
      const result = readResult(input.prompt);
      return `Picking this back up: ${result?.summary ?? 'they answered.'}${tableOf(result?.data)}`;
    }
    // A friend's task: only what they asked (between <request> tags) can name someone to ask.
    const asked = /<request>\n([\s\S]*?)\n<\/request>/.exec(input.prompt)?.[1] ?? input.prompt;
    const gwTarget = bridge.gateway?.available() ? gatewayTarget(asked) : undefined;
    if (gwTarget) return mockAsk(input, bridge, gwTarget, pace);
    const remote = peerRunTarget(input.prompt, input.requesterName);
    if (remote && bridge.runOnPeer) return mockPeerRun(input, bridge, remote, pace);
    if (/\b(which|choose|pick)\b/i.test(input.prompt) && input.askUser) {
      await sleep(450 * pace, input.signal);
      input.onEvent('tool', 'Read src/server.ts');
      const answer = await input.askUser({
        kind: 'question',
        questions: [
          {
            question: 'Which session store should auth use?',
            header: 'Sessions',
            multiSelect: false,
            options: [
              { label: 'Signed cookies', description: 'no server state, simplest' },
              { label: 'Redis', description: 'shared across servers' },
              { label: 'Postgres', description: 'reuses the existing database' },
            ],
          },
        ],
      });
      const picked = answer.kind === 'answers' ? Object.values(answer.answers)[0] : undefined;
      return picked ? `Going with **${picked}**. I'll wire \`requireUser()\` to it next.` : "No preference, so I'll start with **signed cookies**: the simplest option.";
    }
    // What you said meanwhile: read at the next step, folded into this turn (its answer covers it).
    // Sent now (Steer.force): the step it's on stops and your message is the next turn, its own.
    // Cancelled (Steer.cancel) before that: never read.
    const said: FollowUp[] = [];
    let forced: { followUp: FollowUp; note: string } | undefined;
    let wake: (() => void) | undefined;
    const pause = (ms: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        wake = resolve;
        sleep(ms, input.signal).then(resolve, reject);
      });
    const force = async (followUp: FollowUp, note: string): Promise<boolean> => {
      const i = said.indexOf(followUp);
      if (i < 0 || forced) return false;
      said.splice(i, 1);
      forced = { followUp, note };
      wake?.();
      return true;
    };
    // Taken back (Steer.cancel): out of what it reads at its next step.
    const cancel = async (followUp: FollowUp): Promise<boolean> => {
      const i = said.indexOf(followUp);
      if (i < 0) return false;
      said.splice(i, 1);
      return true;
    };
    if (script.steerable) input.onSteer?.(Object.assign((followUp: FollowUp) => (said.push(followUp), true), { force, cancel }));
    let last: string | undefined;
    try {
      for (const step of script.steps) {
        await pause((last && last === script.slowStep?.step ? script.slowStep.ms : (script.stepMs ?? 450)) * pace);
        if (forced) break;
        for (const followUp of said.splice(0)) followUp.onFolded?.();
        input.onEvent('tool', step);
        last = step;
      }
      if (!forced) for (const followUp of said.splice(0)) followUp.onFolded?.();
      if (forced) {
        // The interrupted turn ends saying so; the conversation goes on from your message.
        input.onEvent('text', forced.note);
        const { followUp } = forced;
        followUp.onStart?.();
        await sleep(700 * pace, input.signal);
        followUp.onEvent('tool', 'Read src/webhooks.ts');
        await sleep(900 * pace, input.signal);
        followUp.onEvent('tool', 'Grep "retry"');
        await sleep(700 * pace, input.signal);
        for (const other of said.splice(0)) other.onFolded?.();
        const asked = followUp.prompt.trim().replace(/\s+/g, ' ');
        followUp.onDone(`Stopped the tests to look at that first (“${asked.length > 80 ? `${asked.slice(0, 80)}…` : asked}”). **Webhook retries** are the weak spot: they aren't idempotent. Say the word and I'll run the suite again.`);
        return forced.note;
      }
    } finally {
      if (script.steerable) input.onSteer?.(undefined);
      // The run stopped before Claude read them: back to the queue (see AgentHost.followUp).
      for (const followUp of said.splice(0)) followUp.onError('The agent finished before getting to this message');
    }
    const subs = (script.subagents ?? []).map((s, i) => ({ ...s, id: `sub-${Date.now()}-${i}` }));
    for (const s of subs) input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'start', title: s.title, kind: s.kind ?? 'agent' }));
    const longest = Math.max(0, ...subs.map((s) => s.steps.length));
    for (let i = 0; i < longest; i++) {
      await sleep(500 * pace, input.signal);
      for (const s of subs) {
        const step = s.steps[i];
        if (step) input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'step', step }));
        // Background work (a watcher) keeps going while Claude reads on: it ends with the turn, below.
        if (i === s.steps.length - 1 && s.kind !== 'background') input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'done' }));
      }
    }
    for (const step of script.after ?? []) {
      await sleep((script.stepMs ?? 450) * pace, input.signal);
      input.onEvent('tool', step);
    }
    for (const s of subs) if (s.kind === 'background') input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'done' }));
    if (script.report) await bridge.writeReport(script.report.title, script.report.markdown);
    // Doing a task: keep it true, as real Claude is told to (core/board/prompt.ts).
    if (input.board?.current) keepTaskTrue(input, script);
    await sleep(400 * pace, input.signal);
    const contextUsed = context.finish(input);
    input.onEvent('usage', JSON.stringify({ input: 18_000 + script.steps.length * 6_000, output: 2_400, cacheRead: contextUsed, cacheWrite: 9_000, cost: 0.21 + script.steps.length * 0.04 }));
    return script.answer;
  }
}

/** What the demo's Claude writes on the task its worktree is doing: a note, a decision, notes for the next agent. */
function keepTaskTrue(input: AgentRunInput, script: Script): void {
  const board = input.board!;
  const key = board.current!;
  const first = script.answer.replace(/\*\*/g, '').split(/(?<=\.)\s/)[0] ?? script.answer;
  try {
    for (const [section, text] of script.brief ?? []) {
      input.onEvent('tool', `task_brief_edit ${key} ${section}`);
      board.editBrief(undefined, section, text, 'what the investigation found');
    }
    input.onEvent('tool', `task_note ${key}`);
    board.note(undefined, first);
    if (script.match.test('implement')) {
      input.onEvent('tool', `task_brief_edit ${key} decisions`);
      board.editBrief(undefined, 'decisions', '- Put the check in a middleware (`requireUser()`), not in each route: one place to test.', 'how to wire it', 'append');
    }
    input.onEvent('tool', `task_brief_edit ${key} handoff`);
    board.editBrief(undefined, 'handoff', `${first} Next: cover the edge cases with tests, then open the pull request.`, 'end of the turn');
  } catch {
    // The task went away meanwhile: nothing to keep.
  }
}

/** The run's events, also recorded as steps in detail (tool calls and sub-agents' steps). */
function withSteps(input: AgentRunInput, stepper: MockStepper | undefined): AgentRunInput {
  const background = new Set<string>();
  return {
    ...input,
    onEvent: (kind, raw) => {
      // The extra input a line may carry (see mock-steps.ts) is for the step's record, not the chat.
      const { line: text, more } = kind === 'tool' ? splitLine(raw) : { line: raw, more: {} };
      if (!stepper) return input.onEvent(kind, text);
      if (kind === 'tool') stepper.step(text, undefined, more);
      if (kind === 'sub') {
        try {
          const e = JSON.parse(text) as { id?: string; phase?: string; step?: string; kind?: string };
          if (e.id && e.phase === 'start' && e.kind === 'background') background.add(e.id);
          if (e.id && !background.has(e.id) && e.phase === 'step' && e.step) stepper.step(e.step, e.id);
          if (e.id && e.phase === 'done') stepper.close(e.id);
        } catch {
          // Not a sub-agent event we know.
        }
      }
      input.onEvent(kind, text);
    },
  };
}
