import { dashboardConv } from './render-demo';
import { JOB_DOCS } from './dashboard';
import type { AgentRefView, ChatMessageView, ConvSummary, ConvView, MergeView, NeedsYou, OutputView, PeopleView, PlanView, TaskPageView, Topic, TurnView, UsageView } from '../protocol';
import { DEMO_IMAGES, type DemoImage } from './images.generated';
import { stripCode } from '../../render';
import { agentLabel, agentName } from '../../../../../src/shared/agent-label';

/** Your own agent in the demo: Claude, said the way the Mac says it ("Claude", "Your Claude"). */
export const MY_AGENT_NAME = agentName(undefined);
export const MY_AGENT_LABEL = agentLabel(undefined, undefined, true, { capital: true });

/**
 * The demo Mac's world: two projects, a conversation at work with sub-agents taking screenshots
 * and running tests, a plan being run, something of every kind waiting for you, friends and their
 * chats. Everything is shaped exactly as src/companion/views.ts sends it (protocol.ts), so the
 * screens can't tell it from a real Mac.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A file the demo Mac can hand out. */
export interface DemoFile {
  readonly view: OutputView;
  readonly mime: string;
  /** Pictures: base64 JPEG. Text: the text (it may grow: logs). */
  image?: DemoImage;
  /** A picture sent from the phone (base64). */
  b64?: string;
  text?: string;
}

export interface DemoWorld {
  readonly t0: number;
  usage: UsageView[];
  needs: NeedsYou[];
  convs: Map<string, ConvView>;
  /** What a real Mac adds to Work's rows (1.47): each chat's mark, and the chat a child sits under. */
  threadRows: Readonly<Record<string, Partial<Pick<ConvSummary, 'harness' | 'parent'>>>>;
  projects: { id: string; name: string; convs: string[] }[];
  files: Map<string, DemoFile>;
  plans: PlanView[];
  chats: Map<string, { name: string; kind: 'dm' | 'group'; messages: ChatMessageView[]; unread: number; peer?: string }>;
  people: PeopleView['people'];
  /** The board's tasks, as views.ts sends a task's page. */
  tasks: TaskPageView[];
  /** Projects' icons (small SVGs), by project id, with their checksums. */
  icons: Record<string, { sum: string; svg: string }>;
  /** Merges started from the phone, by conversation. */
  merges: Map<string, MergeView>;
  /** Chats you settled or snoozed, by conversation; the others are Active, or Working while they work. */
  triage: Map<string, { snoozedUntil?: number; settledWhy?: NonNullable<ConvSummary['settledWhy']>; back?: true }>;
}

/** The demo projects' icons: small SVG marks (what companion.icon hands out, by checksum). */
const ICONS: DemoWorld['icons'] = {
  beluga: {
    sum: 'b0e1a9a0d1e2f3a4b5c6d7e8f9a0b1c2',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2C31"/><stop offset="1" stop-color="#0F1013"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M14 38c0-10 9-17 20-17 8 0 14 4 16 9 3-1 5 0 6 2-2 1-4 1-6 1-1 8-9 13-18 13-10 0-18-3-18-8z" fill="#F5F5F7"/><circle cx="41" cy="31" r="1.8" fill="#2A2C31"/></svg>',
  },
  'pixel-weather': {
    sum: 'a7c3e5f1b2d4c6e8a0b2c4d6e8f0a1b3',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#CFE3FA"/><circle cx="25" cy="25" r="9" fill="#F6C453"/><path d="M20 46h26a8 8 0 0 0 0-16 11 11 0 0 0-21 3 7 7 0 0 0-5 13z" fill="#FFFFFF"/></svg>',
  },
};

let seq = 0;
export const ref = (slug: string): string => `out:${slug.replace(/[^\w-]/g, '-').slice(0, 40)}-${(++seq).toString(36).padStart(4, '0')}`;

const E2E_HEAD = [
  '> beluga@0.6.2 test:e2e',
  '> playwright test --project=phone',
  '',
  'Running 215 tests using 4 workers',
  '',
];
export function e2eLine(n: number): string {
  const suites = ['pairing', 'home', 'needs-you', 'conversation', 'outputs', 'plans', 'chats', 'people', 'ask'];
  const suite = suites[n % suites.length];
  const ms = 80 + ((n * 137) % 900);
  const ok = n % 53 !== 0;
  return `  ${ok ? '✓' : '✘'}  ${String(n).padStart(3)} [phone] › ${suite}.spec.ts:${(n * 7) % 180 + 12} › ${ok ? 'renders' : 'swipes'} ${suite} ${['on a small screen', 'offline', 'with a long title', 'after a reconnect'][n % 4]} (${ms}ms)`;
}

const UNIT_LOG = ` RUN  v5.0.5 /Users/you/beluga

 ✓ tests/companion-protocol.test.ts (24 tests) 41ms
 ✓ tests/companion-views.test.ts (38 tests) 212ms
 ✓ tests/companion-coverage.test.ts (3 tests) 9ms
 ✓ tests/companion-files.test.ts (17 tests) 88ms
 ✓ tests/companion-pairing.test.ts (12 tests) 1302ms
 ✓ tests/boundaries.test.ts (6 tests) 640ms
 ✓ tests/browser-safe.test.ts (4 tests) 118ms

 Test Files  7 passed (7)
      Tests  104 passed (104)
   Start at  10:41:07
   Duration  4.21s (transform 610ms, setup 0ms, collect 1.9s, tests 2.4s)
`;

const CONTRAST_MD = `# Contrast check · phone, dark

Checked every text style on the glass cards against the backdrop at its brightest fold.

| Style | Ratio | WCAG |
|---|---|---|
| Body on glass | 13.9 : 1 | AAA |
| Secondary | 7.2 : 1 | AAA |
| Tertiary (captions) | 4.1 : 1 | AA large |
| Copper on glass | 5.6 : 1 | AA |

## What I changed

- Captions went from #6a6a70 to #75757c (now 4.1 : 1).
- The tab bar's inactive icons use text-2, not text-3.

## Left alone

The hairlines are decoration (1.3 : 1); nothing reads through them.
`;

const TIMINGS_JSON = JSON.stringify(
  { run: 'e2e phone', at: '2026-10-23T10:44:12Z', suites: { pairing: { now: 9.2, last: 12.8 }, views: { now: 6.1, last: 6.4 }, link: { now: 4.8, last: 7.9 }, outputs: { now: 3.3, last: 3.1 }, push: { now: 2.4, last: 2.6 } }, slowest: ['pairing.spec.ts › dials the temporary key', 'link.spec.ts › reconnects after the grace'] },
  null,
  2,
);

const RADAR_NOTES = `Radar flicker: notes

The tiles flicker when you pinch because each zoom level swaps every tile at once.
Now the old level stays drawn until the new one has loaded, then cross-fades (180 ms).

Tested on: Pixel 7 (Chrome), iPhone 15 (Safari), the Mac (Safari 19).
Frame time while zooming: 6.1 ms → 4.4 ms median, no dropped frames over 30 s of pinching.
`;

export function makeWorld(now = Date.now()): DemoWorld {
  seq = 0;
  const files = new Map<string, DemoFile>();
  const img = (name: string, image: DemoImage, by?: string, ago = 0): OutputView => {
    const view: OutputView = { ref: ref(name), name, kind: 'image', size: Math.round((DEMO_IMAGES[image].b64.length * 3) / 4), ts: now - ago, ...(by ? { by } : {}) };
    files.set(view.ref, { view, mime: 'image/jpeg', image });
    return view;
  };
  const txt = (name: string, kind: OutputView['kind'], text: string, by?: string, ago = 0): OutputView => {
    const view: OutputView = { ref: ref(name), name, kind, size: text.length, ts: now - ago, ...(by ? { by } : {}) };
    files.set(view.ref, { view, mime: kind === 'json' ? 'application/json' : kind === 'markdown' ? 'text/markdown' : 'text/plain', text });
    return view;
  };

  // Last jobs' documents (the dashboard's typed table, BLG-386).
  for (const d of JOB_DOCS) files.set(d.ref, { view: { ref: d.ref, name: d.name, kind: d.text ? 'text' : 'file' }, mime: d.mime, ...(d.text !== undefined ? { text: d.text } : {}), ...(d.b64 ? { b64: d.b64 } : {}) });

  // ---- the conversation at work: polishing the phone's onboarding
  const shotPair = img('pair-screen.png', 'pairScreen', 'a-shots', 6 * MIN);
  const shotConfirm = img('pair-confirm.png', 'confirmScreen', 'a-shots', 5 * MIN);
  const contrastPng = img('contrast.png', 'contrast', 'a-contrast', 9 * MIN);
  const contrastMd = txt('contrast-report.md', 'markdown', CONTRAST_MD, 'a-contrast', 9 * MIN);
  const e2eText = [...E2E_HEAD, ...Array.from({ length: 137 }, (_, i) => e2eLine(i + 1))].join('\n') + '\n';
  const e2eLog = txt('e2e-phone.log', 'text', e2eText, 'a-e2e', 0);
  const unitLog = txt('unit-tests.txt', 'text', UNIT_LOG, undefined, 14 * MIN);
  const timings = txt('timings.json', 'json', TIMINGS_JSON, 'a-e2e', 2 * MIN);
  const timingsPng = img('slowest-suites.png', 'timings', undefined, 2 * MIN);

  const onboarding: ConvView = {
    topic: 'conv:beluga.onboarding',
    title: 'Make pairing feel like the Mac',
    project: 'beluga',
    more: true,
    canSend: true,
    working: true,
    needsYou: [],
    // Its branch, as a real Mac's views.ts sends it: shipped nowhere yet, Create PR next.
    branch: {
      kind: 'unshipped',
      label: '2 commits · no PR',
      tone: 'info',
      detail: '2 commits on beluga/pairing-feel not in main yet',
      branch: 'beluga/pairing-feel',
      into: 'main',
      next: { id: 'pr', label: 'Create PR' },
      steps: [
        { id: 'pr', label: 'Create PR', hint: 'Pushes beluga/pairing-feel and opens a pull request into main, titled from its commits' },
        { id: 'pr_claude', label: 'Create PR with Your Agent', hint: 'Your agent commits what belongs, then writes the title and description: what, why, how to test', claude: true },
        { id: 'pr_draft', label: 'Create Draft PR', hint: 'Like Create PR, as a draft: it can’t merge until it’s marked ready' },
        { id: 'archive', label: 'Archive', hint: 'Keeps the branch and the conversation, frees the folder' },
        { id: 'delete', label: 'Delete…', hint: 'The branch and the conversation go for good', danger: true },
      ],
      threads: { archive: { count: 3, running: 2 }, delete: { count: 3, running: 2 } },
    },
    threadFamily: {
      chat: 'onboarding',
      children: [
        { id: 'pair-android', topic: 'conv:beluga.pair-android', title: 'Check pairing on Android', state: 'running', working: true, harness: { runtime: 'codex', label: 'Codex' } },
        { id: 'pair-e2e', topic: 'conv:beluga.pair-e2e', title: 'Write the pairing e2e', state: 'done', working: false, harness: { runtime: 'claude', label: 'Claude Code' } },
      ],
      agents: [
        { id: 'sa-explore', title: 'Find the pairing screens', state: 'running', startedAt: now - 6 * MIN, harness: { runtime: 'claude', label: 'Claude Code' } },
        { id: 'sa-fonts', title: 'Check the font licenses', state: 'done', startedAt: now - 20 * MIN, harness: { runtime: 'claude', label: 'Claude Code' } },
      ],
      stoppable: ['pair-fonts', 'pair-android'],
    },
    turns: [
      {
        id: 't1',
        who: 'you',
        name: 'You',
        ts: now - 31 * MIN,
        prose: { text: 'The phone\'s pairing screen should feel like the Mac\'s onboarding: the mark, the glow, the springs. Take screenshots of each step when you\'re done, and run the phone e2e suite.', code: [] },
      },
      {
        id: 't2',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 30 * MIN,
        endTs: now - 15 * MIN,
        status: 'done',
        steps: 23,
        trail: [
          { tool: 'read', text: 'Read pair.tsx' },
          { tool: 'read', text: 'Read onboarding.tsx' },
          { tool: 'search', text: 'Searched for spring' },
          { tool: 'edit', text: 'Edited theme.ts' },
          { tool: 'edit', text: 'Edited pair.tsx' },
          { tool: 'write', text: 'Wrote Mark.tsx' },
          { tool: 'edit', text: 'Edited CodeBoxes.tsx' },
          { tool: 'test', text: 'Checked the types' },
          { tool: 'test', text: 'Ran the tests' },
        ],
        prose: {
          text: 'Done with the first pass. The pairing screen now rises out of the dark like the Mac\'s welcome: the tile comes up, the beluga leaps in, and the glow settles.\n\n**What changed**\n- The backdrop is the same silk shader, ported to Skia\n- Every press springs (320 / 32), and commits tick a haptic\n- The fingerprint step shows four emoji, big, with the Mac\'s name\n\nThe spring settings live in one place:\n\n[[code:0]]\n\nAnd the scanner now accepts `beluga://` links:\n\n[[code:1]]\n\nI ran the unit tests too: 104 passed.',
          code: [{ lang: 'ts', lines: 24 }, { lang: 'ts', lines: 9 }],
        },
        outputs: [unitLog],
      },
      {
        id: 't3',
        who: 'you',
        name: 'You',
        ts: now - 12 * MIN,
        prose: { text: 'Lovely. Check the contrast on the glass cards, then the screenshots and the e2e run please.', code: [] },
      },
      {
        id: 't4',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 11 * MIN,
        status: 'working',
        step: 'Running the tests · 137/215',
        steps: 31,
        prose: { text: 'On it. I\'ve split it three ways so it goes faster: one agent checks the contrast, one takes the screenshots, one runs the e2e suite.', code: [] },
        // What views.ts sends since 1.3: the step it's on, and its steps in words with their tools.
        live: { phase: 'step', words: 'Running the tests', tool: 'test', progress: '137/215', since: now - 95_000, agents: 1 },
        trail: [
          { tool: 'read', text: 'Read theme.ts' },
          { tool: 'search', text: 'Searched for glass' },
          { tool: 'agent', text: 'Started a sub-agent: Check the contrast on glass' },
          { tool: 'agent', text: 'Started a sub-agent: Screenshot each pairing step' },
          { tool: 'edit', text: 'Edited pair.tsx' },
          { tool: 'edit', text: 'Edited onboarding.tsx' },
          { tool: 'agent', text: 'Started a sub-agent: Run the phone e2e suite' },
          { tool: 'test', text: 'Ran the tests' },
        ],
        subagents: [
          { id: 'a-contrast', title: 'Check the contrast on glass', status: 'done', type: 'general-purpose', count: 5, startedAt: now - 10 * MIN, endTs: now - 9 * MIN, steps: ['Read the theme tokens', 'Rendered every text style on the brightest fold', 'Measured 14 pairs', 'Raised the captions to #75757c', 'Wrote contrast-report.md'], trail: [{ tool: 'read', text: 'Read theme.ts' }, { tool: 'run', text: 'Ran node scripts/contrast.mjs' }, { tool: 'tool', text: 'Measured 14 pairs' }, { tool: 'edit', text: 'Edited theme.ts' }, { tool: 'write', text: 'Wrote contrast-report.md' }], outputs: [contrastPng, contrastMd] },
          { id: 'a-shots', title: 'Screenshot each pairing step', status: 'done', type: 'general-purpose', count: 5, startedAt: now - 10 * MIN, endTs: now - 5 * MIN, steps: ['Started the app in the emulator', 'Opened Pair', 'Took pair-screen.png', 'Scanned the test code', 'Took pair-confirm.png'], trail: [{ tool: 'run', text: 'Ran npm run web' }, { tool: 'web', text: 'Read a page on localhost:8081' }, { tool: 'tool', text: 'Used screenshot' }, { tool: 'tool', text: 'Used screenshot' }, { tool: 'write', text: 'Wrote pair-confirm.png' }], outputs: [shotPair, shotConfirm] },
          { id: 'a-e2e', title: 'Run the phone e2e suite', status: 'running', type: 'test-runner', count: 3, startedAt: now - 8 * MIN, step: 'Running the tests', tool: 'test', steps: ['Built the web bundle', 'Started 4 workers', 'Running 215 tests · 137 done'], trail: [{ tool: 'run', text: 'Built it' }, { tool: 'run', text: 'Ran npx playwright' }, { tool: 'test', text: 'Ran the tests' }], outputs: [e2eLog, timings] },
          { id: 'a-flaky', title: 'Look into the flaky swipe test', status: 'running', type: 'Explore', count: 2, startedAt: now - 3 * MIN, step: 'Reading needs-you.spec.ts', tool: 'read', steps: ['Searched for swipes', 'Read Needs.tsx'], trail: [{ tool: 'search', text: 'Searched for swipes' }, { tool: 'read', text: 'Read Needs.tsx' }], outputs: [] },
        ],
        outputs: [timingsPng],
      },
    ],
  };

  onboarding.queue = [{ id: 'q-notes', text: 'Then write the release notes for the phone build' }];

  const push: ConvView = {
    topic: 'conv:beluga.push',
    title: 'Beluga Push relay',
    project: 'beluga',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'p1', who: 'you', name: 'You', ts: now - 48 * MIN, prose: { text: 'Write the push relay as a Cloudflare Worker and deploy it to staging.', code: [] } },
      {
        id: 'p2',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 47 * MIN,
        status: 'working',
        step: 'Waiting for you: deploy to staging?',
        steps: 12,
        prose: { text: 'The Worker is written and its tests pass. It only ever sees a token and ciphertext:\n\n[[code:0]]\n\nI\'d like to deploy it to staging now.', code: [{ lang: 'ts', lines: 58 }] },
      },
    ],
  };

  const radar: ConvView = {
    topic: 'conv:weather.radar',
    title: 'Radar tiles flicker on zoom',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'r1', who: 'you', name: 'You', via: 'GrokBot', ts: now - 3 * HOUR, prose: { text: 'The radar flickers when I pinch. Fix it and show me.', code: [] } },
      {
        id: 'r2',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 3 * HOUR + 2 * MIN,
        endTs: now - 2.6 * HOUR,
        status: 'done',
        steps: 17,
        prose: { text: 'Fixed: the old zoom level now stays drawn until the new tiles have loaded, then they cross-fade. Here it is mid-pinch, and my notes.\n\n[[code:0]]', code: [{ lang: 'ts', lines: 31 }] },
        outputs: [img('radar-zoom.png', 'radar', undefined, 2.6 * HOUR), txt('radar-notes.txt', 'text', RADAR_NOTES, undefined, 2.6 * HOUR)],
      },
    ],
  };

  const flaky: ConvView = {
    topic: 'conv:weather.ci',
    title: 'CI is red on main',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'c1', who: 'you', name: 'You', ts: now - 26 * HOUR, prose: { text: 'Why is CI red?', code: [] } },
      { id: 'c2', who: 'claude', name: MY_AGENT_NAME, ts: now - 26 * HOUR, endTs: now - 25.8 * HOUR, status: 'failed', steps: 6, prose: { text: 'The forecast API\'s sandbox is down (503 since 09:12), so the contract tests fail. Nothing in the code changed. I stopped there.', code: [] } },
    ],
  };

  // ---- Your Mac (1.5): your Claude for the whole Mac. A screenshot sent back, and a worktree it started.
  const screen = img('screen-2026-10-24-09-41.png', 'desktop', undefined, 3 * MIN);
  const loginBug: ConvView = {
    topic: 'conv:ws:wt-login-bug',
    title: 'login-redirect-bug',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: true,
    needsYou: [],
    turns: [
      { id: 'lb1', who: 'you', name: 'You', ts: now - 2 * MIN, prose: { text: 'Signing in from the widget lands on a blank page instead of the forecast. Find out why the redirect drops the deep link, fix it, and add a test.', code: [] } },
      { id: 'lb2', who: 'claude', name: MY_AGENT_NAME, ts: now - 2 * MIN, status: 'working', step: 'Reading src/auth/redirect.ts', steps: 3, live: { phase: 'step', words: 'Reading src/auth/redirect.ts', tool: 'read', since: now - 20_000 }, trail: [{ tool: 'search', text: 'Searched for "returnTo"' }, { tool: 'read', text: 'Read src/widget/open.ts' }], prose: { text: '', code: [] } },
    ],
  };
  // A plan Claude is still writing: its chat works, the plan has no milestones yet (nothing to approve).
  const widgetPlanning: ConvView = {
    topic: 'conv:weather.widget',
    title: 'Plan: Home screen widget',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: true,
    needsYou: [],
    turns: [
      { id: 'wp1', who: 'you', name: 'You', ts: now - 3 * MIN, prose: { text: 'Plan a home screen widget: today’s forecast, the radar thumbnail, tap opens the app at that city.', code: [] } },
      { id: 'wp2', who: 'claude', name: MY_AGENT_NAME, ts: now - 3 * MIN, status: 'working', step: 'Reading src/forecast/store.ts', steps: 7, live: { phase: 'step', words: 'Reading src/forecast/store.ts', tool: 'read', since: now - 15_000 }, trail: [{ tool: 'search', text: 'Searched for "WidgetKit"' }, { tool: 'read', text: 'Read src/radar/tiles.ts' }], prose: { text: 'Looking at how the forecast is cached and how radar tiles are made, so the widget can reuse both. I’ll split it into milestones next.', code: [] } },
    ],
  };
  const assistant: ConvView = {
    topic: 'conv:mac:assistant',
    title: 'Your Mac',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'a1', who: 'you', name: 'You', ts: now - 4 * MIN, prose: { text: 'Take a screenshot and send it to me', code: [] } },
      { id: 'a2', who: 'claude', name: MY_AGENT_NAME, ts: now - 4 * MIN, endTs: now - 3 * MIN, status: 'done', steps: 1, trail: [{ tool: 'tool', text: 'Took a screenshot of the main display' }], outputs: [screen], prose: { text: 'Here’s your screen: Xcode on the left, the radar build running in the Simulator on the right.', code: [] } },
      { id: 'a3', who: 'you', name: 'You', ts: now - 2 * MIN, prose: { text: 'Start a worktree in pixel-weather for the login bug', code: [] } },
      { id: 'a4', who: 'claude', name: MY_AGENT_NAME, ts: now - 2 * MIN, endTs: now - 2 * MIN + 9000, status: 'done', steps: 2, trail: [{ tool: 'tool', text: 'Listed your projects' }, { tool: 'tool', text: 'Started a worktree' }], prose: { text: 'Started `worktree:wt-login-bug` in pixel-weather. Its agent is reading the redirect code now; I’ll leave it to it.', code: [] } },
    ],
  };

  // ---- the Sentinel chat (1.23, docs/sentinel.md §12): a question about the week, and Claude's answer
  const sentinelChat: ConvView = {
    topic: 'conv:sentinel-chat:main',
    title: 'Sentinel chat',
    project: 'Sentinel',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'sc1', who: 'you', name: 'You', ts: now - 50 * MIN, prose: { text: 'What did my sentinels find this week?', code: [] } },
      {
        id: 'sc2',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 50 * MIN,
        endTs: now - 49 * MIN,
        status: 'done',
        steps: 2,
        trail: [{ tool: 'tool', text: 'Listed your sentinels' }, { tool: 'tool', text: 'Read the numbers they keep' }],
        prose: { text: 'A good week, with one thing to look at:\n\n- **Revenue** is up: $3,412 yesterday, the best day this week, and 6 new subscriptions.\n- **Site speed** slowed to about 610 ms for a day after Tuesday’s deploy, and is back near 380 ms.\n- **Nightly tests** is paused after three failures in a row: the checkout test times out on CI only.\n\nWant me to put the open pull requests on the Ops dashboard too?', code: [] },
      },
    ],
  };

  // ---- tables Claude wrote as text, and an answer with many outputs (BLG-71)
  const forecastAnswer = [
    'October is tracking your Sept 30 forecast almost exactly: **$24,480** against **$24,500** (-0.1%). The first two weeks ran ahead; the third dipped when two annual plans renewed later than expected.',
    '',
    '┌──────────────┬────────────┬────────────┬──────────┐',
    '│ Week         │ Forecast   │ Actual     │ Diff     │',
    '├──────────────┼────────────┼────────────┼──────────┤',
    '│ Oct 1–7      │ $6,900     │ $7,240     │ +4.9%    │',
    '│ Oct 8–14     │ $7,100     │ $7,380     │ +3.9%    │',
    '│ Oct 15–21    │ $7,300     │ $6,810     │ -6.7%    │',
    '│ Oct 22–24    │ $3,200     │ $3,050     │ -4.7%    │',
    '├──────────────┼────────────┼────────────┼──────────┤',
    '│ October      │ $24,500    │ $24,480    │ -0.1%    │',
    '└──────────────┴────────────┴────────────┴──────────┘',
    '',
    'By plan, from the Stripe export:',
    '',
    '```',
    'Plan        Forecast   Actual    Customers   Churned   Net new',
    '----------  ---------  --------  ----------  --------  --------',
    'Starter     $5,320     $5,510    290         9         +14',
    'Team        $13,680    $13,410   114         3         +5',
    'Business    $5,500     $5,560    11          0         +1',
    '```',
    '',
    'The charts, the export and my notes are below. November’s forecast holds if the two renewals land this week.',
  ].join('\n');
  const forecast: ConvView = {
    topic: 'conv:shop.forecast',
    title: 'revenue-forecast-from-stripe',
    project: 'shop',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'rf1', who: 'you', name: 'You', ts: now - 50 * MIN, prose: { text: 'How does October compare with my Sept 30 forecast?', code: [] } },
      {
        id: 'rf2',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 50 * MIN,
        endTs: now - 44 * MIN,
        status: 'done',
        steps: 9,
        trail: [{ tool: 'run', text: 'Ran stripe' }, { tool: 'read', text: 'Read forecast-2026-09-30.csv' }, { tool: 'write', text: 'Wrote october-vs-forecast.md' }],
        prose: stripCode(forecastAnswer),
        outputs: [
          img('october-by-week.png', 'timings', undefined, 45 * MIN),
          img('forecast-vs-actual.png', 'radar', undefined, 45 * MIN),
          img('mrr-by-plan.png', 'contrast', undefined, 45 * MIN),
          txt('october-vs-forecast.md', 'markdown', '# October vs the Sept 30 forecast\n\n$24,480 against $24,500 (-0.1%).', undefined, 45 * MIN),
          txt('stripe-charges-october.json', 'json', '{"count": 415, "total": 2448000}', undefined, 46 * MIN),
          txt('forecast-2026-09-30.csv', 'text', 'week,forecast\nOct 1-7,6900\nOct 8-14,7100\nOct 15-21,7300\nOct 22-31,3200', undefined, 47 * MIN),
          txt('stripe-export.log', 'text', 'Fetched 415 charges in 3 pages', undefined, 48 * MIN),
        ],
      },
      { id: 'rf3', who: 'you', name: 'You', ts: now - 30 * MIN, prose: { text: 'What does Team get that Starter doesn’t?', code: [] } },
      {
        // A comparison with an empty corner, as Claude writes one: a table, never its pipes.
        id: 'rf4',
        who: 'claude',
        name: MY_AGENT_NAME,
        ts: now - 30 * MIN,
        endTs: now - 29 * MIN,
        status: 'done',
        steps: 1,
        trail: [{ tool: 'read', text: 'Read plans.ts' }],
        prose: stripCode(
          [
            'Team is Starter with room for a whole company, plus the reports your finance people ask for.',
            '',
            '| | Starter | Team |',
            '|---|---|---|',
            '| **Seats** | Up to 5 | Unlimited, billed per seat after 10 |',
            '| **Reports** | Monthly revenue only | Revenue, churn and cohorts, exported to CSV or Sheets every Monday |',
            '| **Support** | Email, within two days | Chat and email, within four hours on weekdays |',
            '| **Price** | $19 a month | $120 a month |',
          ].join('\n'),
        ),
      },
    ],
  };

  // ---- child threads of the onboarding work (1.47): one still at work with its own child, one done.
  const child = (topic: Topic, title: string, working: boolean, text: string, threadFamily: ConvView['threadFamily']): ConvView => ({
    topic,
    title,
    project: 'beluga',
    more: false,
    canSend: true,
    working,
    needsYou: [],
    threadFamily,
    turns: [{ id: `${topic}-t1`, who: 'claude', name: MY_AGENT_NAME, ts: now - 4 * MIN, ...(working ? { status: 'working' as const, step: text } : { status: 'done' as const, endTs: now - 2 * MIN }), prose: { text: working ? '' : text, code: [] } }],
  });
  const startedBy = (title: string, topic: Topic) => ({ title, topic, state: 'running', gone: false });
  const threads = [
    child('conv:beluga.pair-android', 'Check pairing on Android', true, 'Running the emulator', {
      parent: startedBy('Make pairing feel like the Mac', 'conv:beluga.onboarding'),
      children: [{ id: 'pair-fonts', topic: 'conv:beluga.pair-fonts', title: 'Compare the fonts', state: 'running', working: true, harness: { runtime: 'claude', label: 'Claude Code' } }],
      chat: 'pair-android',
      stoppable: ['pair-fonts'],
    }),
    child('conv:beluga.pair-fonts', 'Compare the fonts', true, 'Reading the screenshots', { parent: startedBy('Check pairing on Android', 'conv:beluga.pair-android'), children: [], chat: 'pair-fonts', stoppable: [] }),
    child('conv:beluga.pair-e2e', 'Write the pairing e2e', false, 'The test covers the code, the fingerprint and a wrong code.', { parent: { title: 'Make pairing feel like the Mac', topic: 'conv:beluga.onboarding', state: 'running', gone: false }, children: [], chat: 'pair-e2e', stoppable: [] }),
  ];
  const threadRows: DemoWorld['threadRows'] = {
    'conv:beluga.onboarding': { harness: { runtime: 'claude', label: 'Claude Code' } },
    'conv:beluga.pair-android': { harness: { runtime: 'codex', label: 'Codex' }, parent: 'conv:beluga.onboarding' },
    'conv:beluga.pair-fonts': { harness: { runtime: 'claude', label: 'Claude Code' }, parent: 'conv:beluga.pair-android' },
    'conv:beluga.pair-e2e': { harness: { runtime: 'claude', label: 'Claude Code' }, parent: 'conv:beluga.onboarding' },
    'conv:beluga.push': { harness: { runtime: 'opencode', label: 'OpenCode' } },
  };
  const convs = new Map<string, ConvView>([...threads, onboarding, push, radar, flaky, dashboardConv(now), loginBug, widgetPlanning, assistant, forecast, sentinelChat].map((c) => [c.topic, c]));

  // ---- what needs you, one of each kind (and one this phone doesn't know)
  // Shaped exactly as src/companion/views.ts makes them (the same methods, args and templates).
  const EMPTY_Q = 'What should Home show when nothing is running?';
  const CHECKS_Q = 'Which checks should run before the phone build ships?';
  const PLAN_Q = 'Ship notifications before iOS?';
  const LONG_Q = 'The release signing key for the Android app expires in nine days and the Play Console needs a new upload certificate. What should I do about it before we ship the companion to testers next week?';
  const needs: NeedsYou[] = [
    {
      id: 'n-deploy',
      kind: 'approval',
      title: 'Deploy the push relay to staging?',
      detail: 'Your agent wants to run: wrangler deploy --env staging\n\nIn beluga · Beluga Push relay',
      from: MY_AGENT_LABEL,
      topic: 'conv:beluga.push',
      askedAt: now - 4 * MIN,
      actions: [
        { label: 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', 'ap-deploy'] },
        { label: 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', 'ap-deploy'] },
        { label: 'Always', tone: 'plain', method: 'host.answerApproval', args: ['always', 'ap-deploy'] },
      ],
    },
    {
      // A long question with many options (as views.ts sends one with more than three: no buttons
      // per option, the template takes the pick).
      id: 'n-long',
      kind: 'question',
      title: LONG_Q,
      detail: 'Your MacBook Pro runs the release pipeline for the phone app. The signing key expires in nine days, the Play Console wants a new upload certificate before the next release, and the CI cache for Gradle is 14 GB. I can rotate the key now, schedule it for after the release, or hand it to someone else.',
      from: MY_AGENT_LABEL,
      topic: 'conv:beluga.push',
      askedAt: now - 3 * MIN,
      choices: ['Rotate the signing key now, before the release', 'After the release, on Monday', 'Ask Mia to do it from her Mac', 'Only clear the Gradle cache for now', 'Do both now and tell me when done', 'Write a plan for it first', 'Leave it, I will do it myself'].map((label) => ({ label })),
      multi: false,
      freeText: true,
      actions: [{ label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q-long', { kind: 'skip' }] }],
      answer: { method: 'questions.answer', args: ['q-long', { kind: 'answers', answers: { [LONG_Q]: '' } }], slot: [1, 'answers', LONG_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      // A single question with a few options: a button each, Skip, and the template for your own words.
      id: 'n-empty',
      kind: 'question',
      title: EMPTY_Q,
      detail: "Your agent is drawing the empty state of the phone's Home.",
      from: MY_AGENT_LABEL,
      topic: 'conv:beluga.onboarding',
      askedAt: now - 7 * MIN,
      choices: [
        { label: 'The Mac, breathing', description: 'Just the mark and your allowance.' },
        { label: 'Recent outputs', description: 'The last pictures and files, big.' },
        { label: 'A prompt to ask', description: '"Ask your Mac…" front and center.' },
      ],
      multi: false,
      freeText: true,
      actions: [
        ...['The Mac, breathing', 'Recent outputs', 'A prompt to ask'].map((label) => ({ label, tone: 'plain' as const, method: 'questions.answer', args: ['q-empty', { kind: 'answers', answers: { [EMPTY_Q]: label } }] })),
        { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q-empty', { kind: 'skip' }] },
      ],
      answer: { method: 'questions.answer', args: ['q-empty', { kind: 'answers', answers: { [EMPTY_Q]: '' } }], slot: [1, 'answers', EMPTY_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      // Several picks: no per-option buttons; the phone sends them joined through the template.
      id: 'n-checks',
      kind: 'question',
      title: CHECKS_Q,
      from: MY_AGENT_LABEL,
      topic: 'conv:beluga.onboarding',
      askedAt: now - 9 * MIN,
      choices: [{ label: 'Unit tests' }, { label: 'Phone e2e' }, { label: 'Contrast check' }, { label: 'APK size' }],
      multi: true,
      freeText: true,
      actions: [{ label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q-checks', { kind: 'skip' }] }],
      answer: { method: 'questions.answer', args: ['q-checks', { kind: 'answers', answers: { [CHECKS_Q]: '' } }], slot: [1, 'answers', CHECKS_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      id: 'n-mia',
      kind: 'request',
      title: "Mia's Codex would like a screenshot of your desktop",
      detail: '"Mia asked me to check how the radar looks on your big screen."',
      from: "Mia's Codex",
      askedAt: now - 12 * MIN,
      actions: [
        { label: 'Approve', tone: 'main', method: 'gateway.decide', args: ['gw-mia', { answer: 'yes' }] },
        { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: ['gw-mia', { answer: 'no' }] },
        { label: 'Always', tone: 'plain', method: 'gateway.decide', args: ['gw-mia', { answer: 'always' }] },
      ],
    },
    {
      // A plan's decision is one of Claude's questions with a `decide:` id.
      id: 'n-plan',
      kind: 'decision',
      title: PLAN_Q,
      detail: 'Milestone 4 can start now, or wait for the iOS port so both platforms get push together.',
      from: 'the plan “Beluga for phones”',
      topic: 'plan:phones',
      askedAt: now - 22 * MIN,
      choices: [{ label: 'Notifications first' }, { label: 'Wait for iOS' }],
      multi: false,
      freeText: true,
      actions: [
        ...['Notifications first', 'Wait for iOS'].map((label) => ({ label, tone: 'plain' as const, method: 'questions.answer', args: ['decide:phones:m4', { kind: 'answers', answers: { [PLAN_Q]: label } }] })),
        { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['decide:phones:m4', { kind: 'skip' }] },
      ],
      answer: { method: 'questions.answer', args: ['decide:phones:m4', { kind: 'answers', answers: { [PLAN_Q]: '' } }], slot: [1, 'answers', PLAN_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      // A milestone done and checked: pass it, check again, or send it back with what to change.
      id: 'n-review',
      kind: 'decision',
      title: 'The contract is done. Pass it?',
      detail: 'All criteria met: protocol.ts, coverage.ts.',
      from: 'the plan “Beluga for phones”',
      topic: 'plan:phones',
      askedAt: now - 30 * MIN,
      actions: [
        { label: 'Pass', tone: 'main', method: 'plans.pass', args: ['phones', 'm1'] },
        { label: 'Check again', tone: 'plain', method: 'plans.recheck', args: ['phones', 'm1'] },
      ],
      answer: { method: 'plans.sendBack', args: ['phones', 'm1', ''], slot: [2], text: true, picks: false, label: 'Send back' },
    },
    {
      id: 'n-theo',
      kind: 'request',
      title: 'Theo is knocking on your room',
      detail: 'He used your invite link from the group chat.',
      from: 'Theo',
      askedAt: now - 35 * MIN,
      actions: [
        { label: 'Let in', tone: 'main', method: 'invites.letIn', args: ['theo'] },
        { label: 'Turn away', tone: 'danger', method: 'invites.decline', args: ['theo'] },
      ],
    },
    {
      id: 'n-join',
      kind: 'request',
      title: 'Ada asks to join beluga-dev',
      from: 'Ada',
      askedAt: now - 42 * MIN,
      actions: [
        { label: 'Let in', tone: 'main', method: 'network.groups.approve', args: ['beluga-dev', 'ada'] },
        { label: 'Decline', tone: 'danger', method: 'network.groups.decline', args: ['beluga-dev', 'ada'] },
      ],
    },
    {
      id: 'friend:theo',
      kind: 'request',
      title: 'Theo wants to add you as a friend',
      detail: 'You’re in the same room. As friends you can talk, share and ask each other’s agents, with nobody hosting',
      from: 'Theo',
      askedAt: now - 46 * MIN,
      actions: [
        { label: 'Accept', tone: 'main', method: 'network.friends.answerOffer', args: ['theo', true] },
        { label: 'Not now', tone: 'danger', method: 'network.friends.answerOffer', args: ['theo', false] },
      ],
    },
    {
      id: 'n-handoff',
      kind: 'handoff',
      title: 'Sam wants to hand you "Offline maps"',
      detail: 'A worktree with 14 changes, waiting on your Mac.',
      from: 'Sam',
      askedAt: now - 50 * MIN,
      actions: [],
    },
  ];

  // ---- a plan being run
  const plan: PlanView = {
    id: 'phones',
    title: 'Beluga for phones',
    goal: 'A companion app for one person: what the Mac is doing, what needs you, and asking it anything, from the phone.',
    state: 'running',
    topic: 'conv:beluga.onboarding',
    needsYou: [],
    autonomy: 'gated',
    parallel: 3,
    running: 2,
    milestones: [
      { id: 'm1', title: 'The contract', state: 'done', criteria: ['protocol.ts with frames, topics and views', 'coverage.ts classifies every API method'], tasks: [
        { id: 'k1', title: 'Frames and topics', state: 'done' },
        { id: 'k2', title: 'Views for every screen', state: 'done' },
        { id: 'k3', title: 'Coverage of the API', state: 'done' },
      ] },
      { id: 'm2', title: 'The Mac side', state: 'running', criteria: ['Pair a phone from Settings', 'Only paired link keys get through'], tasks: [
        { id: 'k4', title: 'Pairing and the device certificate', state: 'done' },
        { id: 'k5', title: 'CompanionHost and the firewall', state: 'running', topic: 'conv:beluga.push' },
        { id: 'k6', title: 'The footer\'s phone mark', state: 'blocked', blockedBy: ['k5'], why: 'Waits on CompanionHost and the firewall' },
      ], dependsOn: ['m1'] },
      { id: 'm3', title: 'The app', state: 'running', criteria: ['Every screen against a demo Mac', 'Pairing feels like the Mac\'s onboarding'], tasks: [
        { id: 'k7', title: 'Home, Work and a conversation', state: 'done' },
        { id: 'k8', title: 'Make pairing feel like the Mac', state: 'running', mine: true, topic: 'conv:beluga.onboarding' },
        { id: 'k9', title: 'Outputs viewer', state: 'review' },
        { id: 'k10', title: 'The link worklet', state: 'ready', goal: 'hyperdht and the Noise link in a Bare worklet, so the app reaches the Mac on any network.', acceptance: ['Links over the LAN and over the internet', 'Closes 15 s after the app goes to the background'] },
      ], dependsOn: ['m1'] },
      { id: 'm4', title: 'Notifications', state: 'waiting', criteria: ['Beluga Push relay', 'Approve from the notification'], tasks: [
        { id: 'k11', title: 'The Worker', state: 'blocked', blockedBy: ['k5'] },
        { id: 'k12', title: 'Notification actions', state: 'blocked', blockedBy: ['k11', 'k10'] },
      ], dependsOn: ['m2', 'm3'] },
      { id: 'm5', title: 'iOS', state: 'todo', criteria: ['Keychain, APNs, the service extension'], tasks: [{ id: 'k13', title: 'Port the link to iOS', state: 'later', blockedBy: ['k10'] }], dependsOn: ['m3'] },
    ],
  };
  const widgetPlan: PlanView = {
    id: 'widget',
    title: 'Home screen widget',
    state: 'draft',
    topic: 'conv:weather.widget',
    milestones: [],
    needsYou: [],
  };
  const docsPlan: PlanView = {
    id: 'docs',
    title: 'Docs for the network',
    state: 'done',
    milestones: [{ id: 'd1', title: 'Write it up', state: 'done', criteria: [], tasks: [{ id: 'd1a', title: 'How it works', state: 'done' }, { id: 'd1b', title: 'Pictures', state: 'done' }] }],
    needsYou: [],
  };
  const radarPlan: PlanView = {
    id: 'weather-v2',
    title: 'Pixel Weather v2',
    goal: 'Smooth radar, offline maps, a widget.',
    state: 'draft',
    milestones: [
      { id: 'w1', title: 'Smooth radar', state: 'todo', criteria: ['No flicker on zoom'], tasks: [{ id: 'w1a', title: 'Cross-fade tiles', state: 'todo' }] },
      { id: 'w2', title: 'Offline maps', state: 'todo', criteria: [], tasks: [{ id: 'w2a', title: 'Tile cache', state: 'todo' }, { id: 'w2b', title: 'Download a region', state: 'todo' }] },
    ],
    needsYou: [],
  };

  // ---- friends and chats
  const sunset = img('IMG_2041.jpg', 'sunset', undefined, 40 * MIN);
  const desktop = img('mia-desktop.png', 'desktop', undefined, 2 * HOUR);
  const chats: DemoWorld['chats'] = new Map([
    [
      'chat:dm:mia',
      {
        name: 'Mia',
        kind: 'dm' as const,
        peer: 'mia',
        unread: 2,
        messages: [
          { id: 'm1', from: 'Mia', mine: false, text: 'is the phone app real?? 👀', ts: now - 3 * HOUR },
          { id: 'm2', from: 'You', mine: true, editable: true, text: 'getting there. I\'m approving deploys from the couch', ts: now - 3 * HOUR + 2 * MIN },
          { id: 'm3', from: 'Mia\'s Codex', mine: false, claude: true, agent: { runtime: 'codex', model: 'gpt-5', label: 'Codex' }, text: 'Here\'s Mia\'s desktop, as you asked: the radar build is open on the left.', ts: now - 2 * HOUR, files: [desktop] },
          { id: 'm4', from: 'Mia', mine: false, text: 'view from the office today', ts: now - 41 * MIN, files: [sunset], reactions: [{ emoji: '😍', count: 1, mine: true, who: ['You'] }] },
          { id: 'm5', from: 'Mia', mine: false, text: 'also my Codex wants a look at your screen for the radar thing, ok?', ts: now - 12 * MIN },
        ],
      },
    ],
    [
      'chat:dm:theo',
      {
        name: 'Theo',
        kind: 'dm' as const,
        peer: 'theo',
        unread: 0,
        messages: [
          { id: 't1', from: 'Theo', mine: false, text: 'sent you a join request for the room', ts: now - 36 * MIN },
          { id: 't2', from: 'You', mine: true, text: '👍 will let you in in a sec', ts: now - 30 * MIN },
        ],
      },
    ],
    [
      'chat:group:beluga-dev',
      {
        name: 'beluga-dev',
        kind: 'group' as const,
        unread: 5,
        messages: [
          { id: 'g1', from: 'Sam', mine: false, text: 'offline maps branch is ready for someone to take over', ts: now - 55 * MIN },
          { id: 'g2', from: 'Ada', mine: false, text: 'push relay: are we doing FCM data messages only?', ts: now - 25 * MIN },
          { id: 'g3', from: 'You', mine: true, text: 'yes, sealed to the phone\'s box key, the relay only sees ciphertext', ts: now - 24 * MIN, reactions: [{ emoji: '👍', count: 2, mine: false, who: ['Ada', 'Sam'] }, { emoji: '🎉', count: 1, mine: false, who: ['Ada'] }] },
          { id: 'g4', from: 'Ada', mine: false, text: 'nice. the e2e numbers from my run:', ts: now - 9 * MIN, files: [txt('ada-e2e.txt', 'text', 'pairing 9.4s\nviews 6.0s\nlink 5.1s\n', undefined, 9 * MIN)] },
          { id: 'g5', from: 'Theo', mine: false, text: 'can someone let me into the room 🙏', ts: now - 3 * MIN },
        ],
      },
    ],
  ]);

  const people: PeopleView['people'] = [
    { peerId: 'mia', name: 'Mia', presence: 'online', note: 'radar all day', offers: ['screen', 'commands', 'files'], chat: 'chat:dm:mia', usage: { provider: 'Claude Code', plan: 'Max', windows: [{ label: '5 hours', pct: 41, resetsAt: now + 2.2 * HOUR }, { label: 'Week', pct: 77, resetsAt: now + 2.5 * 24 * HOUR }], updatedAt: now - 5 * MIN } },
    { peerId: 'theo', name: 'Theo', presence: 'away', note: 'in a meeting', offers: ['files'], chat: 'chat:dm:theo', usage: { provider: 'Claude Code', plan: 'Pro', windows: [{ label: '5 hours', pct: 8 }, { label: 'Week', pct: 34 }], updatedAt: now - 30 * MIN } },
    { peerId: 'ada', name: 'Ada', presence: 'dnd', offers: ['screen', 'commands'], usage: { provider: 'Claude Code', plan: 'Max', windows: [{ label: '5 hours', pct: 88 }, { label: 'Week', pct: 51 }], updatedAt: now - 9 * MIN } },
    { peerId: 'sam', name: 'Sam', presence: 'offline', note: 'back Monday', offers: [] },
  ];

  const usage: UsageView[] = [
    {
      provider: 'Claude Code',
      plan: 'Max',
      windows: [
        { label: '5 hours', pct: 18, resetsAt: now + 3.4 * HOUR },
        { label: 'Week', pct: 62, resetsAt: now + 3 * 24 * HOUR + 5 * HOUR },
      ],
      updatedAt: now - MIN,
      runtime: 'claude',
      isDefault: true,
    },
    { provider: 'Codex', plan: 'Plus', windows: [{ label: 'Weekly', pct: 24, resetsAt: now + 4 * 24 * HOUR }], updatedAt: now - 2 * MIN, runtime: 'codex', isDefault: false },
    { provider: 'Local', windows: [], tokens: { input: 182_000, output: 41_500 }, tokensPerSec: 38, updatedAt: now - 3 * MIN, runtime: 'local', isDefault: false },
  ];

  return {
    t0: now,
    usage,
    needs,
    convs,
    threadRows,
    projects: [
      { id: 'beluga', name: 'beluga', convs: ['conv:beluga.onboarding', 'conv:beluga.pair-android', 'conv:beluga.pair-fonts', 'conv:beluga.pair-e2e', 'conv:beluga.push'] },
      { id: 'pixel-weather', name: 'pixel-weather', convs: ['conv:ws:wt-login-bug', 'conv:weather.widget', 'conv:weather.radar', 'conv:weather.ci'] },
      { id: 'shop', name: 'shop', convs: ['conv:shop.forecast', 'conv:shop.dashboard'] },
      { id: 'asked', name: 'Asked of friends', convs: [] },
    ],
    files,
    plans: [plan, widgetPlan, radarPlan, docsPlan],
    chats,
    people,
    tasks: demoTasks(now),
    icons: ICONS,
    merges: new Map(),
    triage: new Map([
      ['conv:weather.ci', { settledWhy: 'pr_merged' }],
      ['conv:shop.dashboard', { snoozedUntil: now + 3 * 60 * MIN }],
    ]),
  };
}

/** The board: a few tasks in each state, shaped as views.ts sends a task's page. */
function demoTasks(now: number): TaskPageView[] {
  const moves = (status: string) => ['todo', 'in_progress', 'in_review', 'done', 'backlog', 'canceled'].filter((s) => s !== status).map((s) => ({ status: s, label: ({ todo: 'Ready', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', backlog: 'Backlog', canceled: 'Canceled' } as Record<string, string>)[s]! }));
  const task = (t: Partial<TaskPageView> & Pick<TaskPageView, 'id' | 'key' | 'title' | 'status' | 'projectId' | 'project'>): TaskPageView => ({
    topic: `task:${t.id}`,
    priority: 'medium',
    updatedAt: now - 20 * MIN,
    acceptance: [],
    activity: [{ id: `${t.id}-a1`, at: now - 3 * HOUR, who: 'You', text: 'created this' }],
    moves: moves(t.status),
    ...(t.projectId === 'beluga' || t.projectId === 'pixel-weather' ? { icon: ICONS[t.projectId]!.sum } : {}),
    ...t,
  });
  const goal = (text: string) => ({ text, code: [] });
  return [
    task({
      id: 'iss-pair',
      key: 'BLG-38',
      title: 'Make pairing feel like the Mac',
      status: 'in_progress',
      priority: 'high',
      assignee: 'you',
      projectId: 'beluga',
      project: 'beluga',
      conv: 'conv:beluga.onboarding',
      worktree: 'beluga-pairing',
      checks: { done: 2, total: 4 },
      goal: goal('The phone’s pairing screen should feel like the Mac’s onboarding: the mark, the springs, the fingerprint step big and calm.'),
      acceptance: [
        { text: 'The pairing screen uses the Mac’s mark and springs', state: 'done' },
        { text: 'Captions pass AA contrast on the glass cards', state: 'done' },
        { text: 'Screenshots of each step', state: 'open' },
        { text: 'The phone e2e suite passes', state: 'deferred', reason: 'it runs at the end of the plan' },
      ],
      activity: [
        { id: 'p1', at: now - 3 * HOUR, who: 'You', text: 'created this' },
        { id: 'p2', at: now - 31 * MIN, who: 'Beluga', text: 'its work is being done in worktree beluga-pairing' },
        { id: 'p3', at: now - 30 * MIN, who: MY_AGENT_LABEL, text: 'moved this from Ready to In Progress' },
        { id: 'p4', at: now - 9 * MIN, who: MY_AGENT_LABEL, text: 'commented', body: 'Contrast is fixed: captions went to 4.1 : 1. Screenshots and the e2e run are next.', comment: true },
      ],
    }),
    task({
      id: 'iss-push',
      key: 'BLG-39',
      title: 'Beluga Push relay on Cloudflare',
      status: 'in_review',
      priority: 'urgent',
      assignee: 'you',
      projectId: 'beluga',
      project: 'beluga',
      conv: 'conv:beluga.push',
      worktree: 'beluga-push-relay',
      checks: { done: 3, total: 3 },
      pr: { number: 142, state: 'OPEN', title: 'Beluga Push: a blind relay for phone notifications', checks: 'passing' },
      goal: goal('A stateless relay so the Mac can wake the phone: it sees a token and ciphertext, nothing else.'),
      acceptance: [
        { text: 'Seals to the phone’s box key', state: 'done' },
        { text: 'Signed with the relay key', state: 'done' },
        { text: 'Deployed to staging', state: 'done' },
      ],
    }),
    task({ id: 'iss-ios', key: 'BLG-47', title: 'Port the link worklet to iOS', status: 'todo', priority: 'medium', projectId: 'beluga', project: 'beluga', goal: goal('The same app on iOS: Keychain, APNs and the service extension.') }),
    task({ id: 'iss-widget', key: 'BLG-51', title: 'A home-screen widget for usage', status: 'backlog', priority: 'low', projectId: 'beluga', project: 'beluga' }),
    task({ id: 'iss-docs', key: 'BLG-30', title: 'Docs for the companion protocol', status: 'done', priority: 'medium', assignee: 'you', projectId: 'beluga', project: 'beluga', updatedAt: now - 26 * HOUR }),
    task({ id: 'iss-radar', key: 'PXW-12', title: 'Radar tiles flicker on zoom', status: 'in_review', priority: 'high', assignee: 'you', projectId: 'pixel-weather', project: 'pixel-weather', conv: 'conv:weather.radar', checks: { done: 1, total: 1 }, acceptance: [{ text: 'No flicker while pinching', state: 'done' }] }),
    task({ id: 'iss-offline', key: 'PXW-14', title: 'Offline maps for a region', status: 'todo', priority: 'high', assignee: 'Mia', projectId: 'pixel-weather', project: 'pixel-weather' }),
  ];
}

/** A new turn helper for the live parts. */
/** Whose agent is what in the demo: Mia runs Codex; you and everyone else run Claude (Opus). */
export const CODEX_AGENT: AgentRefView = { runtime: 'codex', model: 'gpt-5', label: 'Codex' };
export const CLAUDE_AGENT: AgentRefView = { runtime: 'claude', model: 'opus', label: MY_AGENT_NAME };
export const demoAgent = (name: string): AgentRefView => (name.toLowerCase() === 'mia' ? CODEX_AGENT : CLAUDE_AGENT);
/** A friend's agent by name, as the Mac says it: "Mia's Codex", "Ada's Claude". */
export const agentOf = (name: string): string => `${name}'s ${demoAgent(name).label}`;

export const turn = (t: Partial<TurnView> & Pick<TurnView, 'id' | 'who' | 'name'>, text: string, now = Date.now()): TurnView => ({ ts: now, prose: { text, code: [] }, ...t });
