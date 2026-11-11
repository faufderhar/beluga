import type { GitHubRepo } from '../../workspaces/github.js';
import type { IssueSource } from './gh.js';
import type { GhComment, GhIssueFull, GhIssueState, GhPull } from './model.js';

/**
 * The demo's pretend GitHub: each demo project is acme/<its name>, with a few issues to try
 * Investigate, Fix It and Make a Task on. Nothing goes online; comments stay in memory.
 */

export const demoRepo = (name: string): GitHubRepo => ({ host: 'github.com', owner: 'acme', repo: name, url: `https://github.com/acme/${name}` });

const H = 3600_000;
const D = 24 * H;

type Seed = Omit<GhIssueFull, 'url' | 'comments' | 'thread' | 'createdAt' | 'updatedAt' | 'closedAt' | 'assignees'> & {
  readonly ago: number;
  readonly assignees?: readonly string[];
  readonly said?: ReadonlyArray<readonly [string, string, number]>;
};

const BUG = { name: 'bug', color: 'd73a4a' };
const FEATURE = { name: 'enhancement', color: 'a2eeef' };
const DOCS = { name: 'documentation', color: '0075ca' };
const PAYMENTS = { name: 'payments', color: 'c5def5' };
const FIRST = { name: 'good first issue', color: '7057ff' };
const UI = { name: 'ui', color: 'fbca04' };

const SEEDS: Readonly<Record<string, readonly Seed[]>> = {
  'bob-api': [
    {
      number: 48,
      title: 'Login returns 500 when the email has a plus sign',
      state: 'open',
      author: 'lena-k',
      labels: [BUG],
      ago: 3 * H,
      body: 'Signing in with `lena+test@acme.dev` fails with a 500. Without the `+` it works.\n\n**Steps**\n1. `POST /login` with `{"email": "lena+test@acme.dev", "password": "…"}`\n2. See a 500 and `TypeError: Cannot read properties of undefined (reading \'id\')` in the logs\n\n**Expected:** signed in, like any other address.\n\nVersion: 2.4.1, Node 20.',
      said: [
        ['sam-r', 'Same here with `first.last+billing@`. Looks like the lookup URL-decodes the email, so `+` becomes a space?', 2 * H],
        ['bob', 'Probably `decodeURIComponent` on the query string in the user lookup. Good catch.', 90 * 60_000],
      ],
    },
    {
      number: 47,
      title: 'Webhook retries fire twice after a timeout',
      state: 'open',
      author: 'sam-r',
      labels: [BUG, PAYMENTS],
      ago: 26 * H,
      body: 'When a webhook delivery times out, we see **two** retries a few ms apart instead of one, so customers get duplicate `payment.succeeded` events.\n\nIt started after the move to the new queue (#39).',
      said: [['mia', 'Can confirm on staging, two deliveries 4 ms apart in the log.', 20 * H]],
    },
    {
      number: 45,
      title: 'Docs: the /refunds example still uses the old field names',
      state: 'open',
      author: 'dev-ana',
      labels: [DOCS, FIRST],
      ago: 3 * D,
      body: 'The README example for `POST /refunds` sends `charge_id` and `amount_cents`; the API wants `payment` and `amount` since 2.0.',
    },
    {
      number: 43,
      title: 'Let an API key be limited to read-only',
      state: 'open',
      author: 'jules',
      labels: [FEATURE],
      ago: 5 * D,
      // Pasted from a rich editor, as HTML (GitHub draws it, and so does the issue's page).
      body: '<html>\n<body>\n<!--StartFragment--><p><span>For our dashboards we want keys that can only </span><code><span>GET</span></code><span>. Today every key can create charges.</span></p><ul><li><p><strong><span>Read:</span></strong><span> list and fetch</span></p></li><li><p><strong><span>Write:</span></strong><span> everything else</span></p></li></ul><p><span>Something like a </span><code><span>scope: "read"</span></code><span> on the key would do.</span></p><!--EndFragment-->\n</body>\n</html>',
      said: [
        ['bob', 'Makes sense. Would you also want per-resource scopes, or is read/write enough?', 4 * D],
        ['jules', 'Read/write is plenty for now.', 4 * D - 2 * H],
      ],
    },
    {
      number: 41,
      title: 'Server crashes on start when PORT isn’t a number',
      state: 'open',
      author: 'kemal',
      labels: [BUG],
      ago: 8 * D,
      body: '`PORT=web npm start` crashes with `RangeError [ERR_SOCKET_BAD_PORT]`. A clear message saying PORT must be a number would be friendlier.',
    },
    { number: 40, title: 'Receipts are emailed twice', state: 'closed', reason: 'completed', author: 'mia', labels: [BUG, PAYMENTS], ago: 12 * D, body: 'Every receipt email arrives twice since Monday.' },
    { number: 36, title: 'Support Node 22', state: 'closed', reason: 'completed', author: 'kemal', labels: [FEATURE], ago: 20 * D, body: 'Node 22 is LTS now; the engines field still says 18–20.' },
    { number: 33, title: 'Allow negative amounts on charges', state: 'closed', reason: 'not_planned', author: 'guest-dev', labels: [FEATURE], ago: 30 * D, body: 'For refunds it would be handy to create a charge with a negative amount.', said: [['bob', 'Refunds have their own endpoint, so we won’t add this. Thanks though!', 29 * D]] },
  ],
  landing: [
    {
      number: 12,
      title: 'Pricing page jumps when the toggle switches to yearly',
      state: 'open',
      author: 'mia',
      labels: [BUG, UI],
      ago: 5 * H,
      body: 'Switching Monthly → Yearly on /pricing makes the cards jump down ~8px, because the "Save 20%" badge only renders on yearly.\n\nSafari and Chrome, desktop.',
    },
    { number: 11, title: 'Hero image is blurry on Retina screens', state: 'open', author: 'jules', labels: [UI], ago: 2 * D, body: 'The hero PNG is 1x only. A 2x (or an SVG) would look sharp.' },
    { number: 9, title: 'Typo in the footer: “Privcy”', state: 'closed', reason: 'completed', author: 'dev-ana', labels: [FIRST], ago: 9 * D, body: 'Footer says “Privcy policy”.' },
  ],
};

type PullSeed = Omit<GhPull, 'url' | 'createdAt' | 'updatedAt'> & { readonly ago: number };

/** Open pull requests: a teammate's, a bot's, and one on a demo worktree's branch (it opens that worktree). */
const PULL_SEEDS: Readonly<Record<string, readonly PullSeed[]>> = {
  'bob-api': [
    { number: 52, title: 'Retry webhooks with backoff', author: 'you', branch: 'beluga/webhook-retries', draft: false, checks: 'pending', ago: 40 * 60_000 },
    { number: 51, title: 'Decode emails safely in the user lookup', author: 'sam-r', branch: 'fix/plus-in-email', base: 'main', draft: false, checks: 'passing', review: 'APPROVED', ago: 2 * H },
    { number: 49, title: 'Read-only API keys', author: 'jules', branch: 'feat/read-only-keys', draft: true, checks: 'failing', ago: 2 * D },
    { number: 46, title: 'Bump express from 4.19.2 to 4.21.0', author: 'dependabot', branch: 'dependabot/npm_and_yarn/express-4.21.0', draft: false, checks: 'passing', review: 'REVIEW_REQUIRED', ago: 4 * D },
    { number: 44, title: 'Explain refunds in the README', author: 'dev-ana', branch: 'docs/refunds', fork: true, draft: false, checks: 'none', ago: 6 * D },
  ],
  landing: [{ number: 13, title: 'Keep the pricing cards still when switching to yearly', author: 'mia', branch: 'fix/pricing-jump', draft: false, checks: 'passing', ago: 3 * H }],
};

export function demoIssueSource(now: () => number = Date.now): IssueSource {
  const born = now();
  const extra = new Map<string, GhComment[]>();
  const keyOf = (repo: GitHubRepo, n: number): string => `${repo.repo}#${n}`;
  const full = (repo: GitHubRepo, s: Seed): GhIssueFull => {
    const url = `${repo.url}/issues/${s.number}`;
    const thread: GhComment[] = [...(s.said ?? []).map(([author, body, ago], i) => ({ author, body, createdAt: born - ago, url: `${url}#issuecomment-${s.number}0${i}` })), ...(extra.get(keyOf(repo, s.number)) ?? [])];
    const { ago, said: _said, assignees, ...rest } = s;
    const updated = Math.max(born - ago, ...thread.map((c) => c.createdAt));
    return { ...rest, url, assignees: assignees ?? [], comments: thread.length, thread, createdAt: born - ago, updatedAt: updated, ...(s.state === 'closed' ? { closedAt: born - ago + 3 * H } : {}) };
  };
  const seeds = (repo: GitHubRepo): readonly Seed[] => SEEDS[repo.repo] ?? [];
  return {
    async list(repo, state: GhIssueState, search) {
      const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const issues = seeds(repo)
        .filter((s) => s.state === state)
        .map((s) => full(repo, s))
        .filter((i) => words.every((w) => `${i.title} ${i.body} #${i.number} ${i.labels.map((l) => l.name).join(' ')}`.toLowerCase().includes(w.replace(/^label:/, ''))))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ body: _b, thread: _t, moreComments: _m, ...i }) => i);
      return { issues, more: false };
    },
    async get(repo, number) {
      const s = seeds(repo).find((x) => x.number === number);
      if (!s) throw new Error(`There's no issue #${number} in ${repo.owner}/${repo.repo}`);
      return full(repo, s);
    },
    async comment(repo, number, body) {
      const key = keyOf(repo, number);
      const list = extra.get(key) ?? [];
      const url = `${repo.url}/issues/${number}#issuecomment-demo${list.length + 1}`;
      extra.set(key, [...list, { author: 'you', body, createdAt: now(), url }]);
      return url;
    },
    async pulls(repo) {
      const pulls = (PULL_SEEDS[repo.repo] ?? []).map(({ ago, ...p }): GhPull => ({ ...p, url: `${repo.url}/pull/${p.number}`, createdAt: born - ago - H, updatedAt: born - ago }));
      return { pulls, total: pulls.length };
    },
  };
}
