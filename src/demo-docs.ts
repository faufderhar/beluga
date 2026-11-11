/**
 * The demo project's docs folder: a long guide that uses everything the Mac app's Markdown reader
 * shows (front matter, alerts, tables, task lists, code, math, diagrams, images, footnotes, links
 * to other files), a second page it links to, and a small diagram it shows as an image.
 */

const FLOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="120" viewBox="0 0 560 120" font-family="-apple-system, Helvetica, sans-serif" font-size="13">
  <defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 8 4 0 8z" fill="#8a8a93"/></marker></defs>
  <g fill="#f3f1ff" stroke="#7c6cf0" stroke-width="1.5">
    <rect x="10" y="38" width="120" height="44" rx="10"/><rect x="220" y="38" width="120" height="44" rx="10"/><rect x="430" y="38" width="120" height="44" rx="10"/>
  </g>
  <g fill="#2a2840" text-anchor="middle"><text x="70" y="65">Stripe</text><text x="280" y="65">/webhooks</text><text x="490" y="65">Ledger</text></g>
  <g stroke="#8a8a93" stroke-width="1.5" marker-end="url(#a)"><path d="M132 60h84"/><path d="M342 60h84"/></g>
  <g fill="#8a8a93" font-size="11" text-anchor="middle"><text x="174" y="52">event</text><text x="384" y="52">once per id</text></g>
</svg>
`;

const GUIDE = `---
title: bob-api guide
owner: bob
updated: 2026-10-12
tags: [payments, webhooks, auth]
---

# bob-api guide

Everything you need to run, change and ship **bob-api**: the small service behind bob's side
project. It takes payments with Stripe, keeps a ledger, and (soon) knows who you are. Start with
[Getting started](#getting-started), or jump to the [API reference](API.md#authentication).

> [!NOTE]
> This guide lives next to the code in \`docs/\`. Links to other files open them, and links to
> other pages, like [the API reference](./API.md), open in the reader.

## Getting started

You need Node 20 or newer and a Stripe test key. Then:

\`\`\`bash
npm install
cp .env.example .env   # add STRIPE_KEY=sk_test_…
npm run dev            # http://localhost:3000
\`\`\`

The server starts in [src/server.ts](../src/server.ts). The [README](../README.md) has the short
version of all this.

> [!TIP]
> \`npm run dev\` restarts on every save. Keep it open in a terminal next to the chat.

## What's where

| Path | What it does | Owner | Tests |
| :--- | :--- | :---: | ---: |
| \`src/server.ts\` | The HTTP server and its routes | bob | 3 |
| \`src/auth.ts\` | \`requireUser\`, the session check | kay | 0 |
| \`src/webhooks.ts\` | Stripe events, retried with backoff | bob | 7 |
| \`src/payments.ts\` | Charges and refunds | bob | 14 |
| \`docs/\` | This guide and the API reference | everyone | – |

## Roadmap

- [x] Health check
- [x] Payments in test mode
- [x] Webhooks that survive retries
- [ ] Sign in with a magic link
- [ ] Refunds from the dashboard
- [ ] ~~SOAP endpoint~~ (dropped, nobody asked)

## How a payment flows

Stripe sends an event; we record it once and update the ledger:

![The webhook flow](assets/flow.svg)

The same flow as a diagram the reader draws for you:

\`\`\`mermaid
sequenceDiagram
    participant S as Stripe
    participant W as /webhooks
    participant L as Ledger
    S->>W: charge.succeeded (evt_123)
    W->>W: seen evt_123 before?
    alt first time
        W->>L: add +$42.00
        W-->>S: 200 OK
    else retry
        W-->>S: 200 OK (skipped)
    end
\`\`\`

And where requests go:

\`\`\`mermaid
flowchart LR
    client([Browser]) --> api[bob-api]
    api -->|/api/payments| auth{requireUser}
    auth -->|ok| pay[payments.ts]
    auth -->|no session| e401[401]
    api -->|/webhooks| hooks[webhooks.ts]
    hooks --> ledger[(Ledger)]
\`\`\`

## Idempotency

Stripe retries an event until it gets a \`2xx\`, so the handler must charge **once per event id**:

\`\`\`ts
const seen = new Set<string>();

export async function onWebhook(event: Event): Promise<void> {
  // Stripe retries: charge once per event id.
  if (seen.has(event.id)) return;
  seen.add(event.id);
  await charge(event.customer, event.amount);
}
\`\`\`

> [!IMPORTANT]
> The \`Set\` lives in memory. Before we run more than one instance, it moves to the database
> (a unique index on \`event_id\`).

## Retries and backoff

Our own calls out (to the ledger, to email) retry with exponential backoff. Attempt $n$ waits
$t_n = t_0 \\cdot 2^{n}$ milliseconds, capped at $30\\,\\text{s}$, with a little jitter. Over
$N$ attempts the longest we wait in total is

$$
T_{\\max} = \\sum_{n=0}^{N-1} \\min\\left(t_0 \\cdot 2^{n},\\ 30000\\right)
$$

With $t_0 = 250$ and \`MAX_RETRIES = 5\` that's under eight seconds.[^backoff]

## Configuration

\`\`\`json
{
  "port": 3000,
  "stripe": { "mode": "test", "webhookSecret": "whsec_…" },
  "retries": { "max": 5, "baseMs": 250 }
}
\`\`\`

| Variable | Default | Meaning |
| --- | --- | --- |
| \`PORT\` | \`3000\` | Where the server listens |
| \`STRIPE_KEY\` | – | Your secret key (test mode locally) |
| \`STRIPE_WEBHOOK_SECRET\` | – | Checks that events really come from Stripe |
| \`LEDGER_URL\` | \`http://localhost:4000\` | The ledger service |
| \`LOG_LEVEL\` | \`info\` | \`debug\` shows every request with its headers, timing, and the body when it's small enough to print |

## Deploying

Merges to \`main\` deploy on their own. A deploy:

1. builds the image and runs the tests,
2. runs database migrations,
3. shifts traffic over in two steps (10%, then 100%), and
4. rolls back by itself if errors go above 1% for two minutes.

> [!WARNING]
> Migrations run before the new code takes traffic. Never drop a column the running version still
> reads: add first, deploy, then remove in a later change.

To ship by hand, press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>P</kbd> in Beluga and pick **Create PR**, or:

\`\`\`bash
git push origin HEAD
gh pr create --fill
\`\`\`

## Troubleshooting

<details>
<summary>Webhooks return 400 locally</summary>

The signing secret changes every time you run \`stripe listen\`. Copy the new \`whsec_…\` into
\`.env\` and restart the server.

</details>

<details>
<summary>Payments hang in test mode</summary>

Check that \`LEDGER_URL\` points at a running ledger. The payment waits for it (up to the retry
limit above) before it gives up.

</details>

> [!CAUTION]
> Never paste a live key (\`sk_live_…\`) in the chat or in an issue. Rotate it at once if you do.

## Changes in this release

\`\`\`diff
-export async function onWebhook(event: Event) {
+const seen = new Set<string>();
+
+export async function onWebhook(event: Event) {
+  if (seen.has(event.id)) return;
+  seen.add(event.id);
   await charge(event.customer, event.amount);
 }
\`\`\`

## FAQ

**Why not a queue?** We will, when there's more than one instance. Until then a \`Set\` and
Stripe's own retries are enough, and there's nothing else to run.

**Where do refunds go?** Through \`src/payments.ts\` too, as negative ledger entries, so the
balance is always the sum of the entries.

**Who do I ask?** bob for payments and deploys, kay for auth. Or ask either of our Claudes.

---

Made with care by bob and friends. See also: [NOTES.md](/NOTES.md) and https://stripe.com/docs/webhooks.

[^backoff]: $250 + 500 + 1000 + 2000 + 4000 = 7750$ ms, before jitter.
`;

const API = `# API reference

All endpoints answer JSON. Errors look like \`{ "error": "…" }\` with a matching status.

## Authentication

Send the session cookie you got from sign-in. Routes under \`/api/payments\` answer \`401\` without
one (see \`requireUser\` in [auth.ts](../src/auth.ts)).

## Endpoints

| Method | Path | Auth | Answers |
| --- | --- | :---: | --- |
| \`GET\` | \`/api/health\` | no | \`ok\` |
| \`POST\` | \`/api/payments\` | yes | the new payment |
| \`POST\` | \`/webhooks\` | Stripe signature | \`200\` |

### \`POST /api/payments\`

Charges a customer. The amount is in cents.

\`\`\`bash
curl -X POST localhost:3000/api/payments \\
  -H 'content-type: application/json' \\
  -d '{ "customer": "cus_123", "amount": 4200 }'
\`\`\`

\`\`\`json
{ "id": "pay_7f3a", "customer": "cus_123", "amount": 4200, "currency": "usd" }
\`\`\`

## Errors

| Status | When |
| --- | --- |
| \`400\` | The body is missing a field, or an amount isn't whole cents |
| \`401\` | No session |
| \`404\` | No such payment (refunds) |
| \`422\` | Over the limit |
| \`500\` | Something on our side; it's logged with the request id |

## Rate limits

Each session gets 60 requests a minute. Past that you get \`429\` with a \`Retry-After\` header,
in seconds. Webhooks from Stripe aren't limited.

## Webhooks

Stripe signs every event. We check the signature with \`STRIPE_WEBHOOK_SECRET\` before anything
else, answer \`400\` when it doesn't match, and \`200\` as soon as the event is recorded (even when
it's a retry we've seen before).

Back to the [guide](GUIDE.md#idempotency).
`;

export const DEMO_DOCS: Record<string, string> = {
  'docs/GUIDE.md': GUIDE,
  'docs/API.md': API,
  'docs/assets/flow.svg': FLOW_SVG,
};

/** A longer source file (payments), so the reader's code view has something to scroll. */
export const DEMO_PAYMENTS_TS = `import type { Request, Response } from 'express';

/** A charge or a refund, in cents. Refunds are negative. */
export interface Entry {
  readonly id: string;
  readonly customer: string;
  readonly amount: number;
  readonly currency: 'usd' | 'eur';
  readonly at: number;
  readonly note?: string;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MAX_AMOUNT = 1_000_000;
const ledger: Entry[] = [];

${Array.from({ length: 14 }, (_, i) => `/** Rule ${i + 1}: ${['amounts are whole cents', 'currencies match the account', 'customers exist', 'no charge over the limit', 'refunds never exceed the charge', 'ids are unique', 'timestamps only go forward', 'notes stay short', 'test keys stay in test mode', 'zero is not a payment', 'one currency per customer', 'retries reuse the id', 'the ledger is append-only', 'balances are sums'][i]}. */
export function check${i + 1}(entry: Entry): void {
  if (!Number.isInteger(entry.amount)) throw new PaymentError('Amounts are whole cents');
  if (Math.abs(entry.amount) > MAX_AMOUNT) throw new PaymentError('Too large', 422);
}
`).join('\n')}
export function balance(customer: string): number {
  return ledger.filter((e) => e.customer === customer).reduce((sum, e) => sum + e.amount, 0);
}

export async function charge(customer: string, amount: number, currency: Entry['currency'] = 'usd'): Promise<Entry> {
  const entry: Entry = { id: crypto.randomUUID(), customer, amount, currency, at: Date.now() };
  for (const check of [check1, check2, check3, check4]) check(entry);
  ledger.push(entry);
  return entry;
}

export async function refund(id: string, amount?: number): Promise<Entry> {
  const original = ledger.find((e) => e.id === id);
  if (!original) throw new PaymentError('No such charge', 404);
  const back = amount ?? original.amount;
  if (back > original.amount) throw new PaymentError('Refund is larger than the charge');
  return charge(original.customer, -back, original.currency);
}

export async function handle(req: Request, res: Response): Promise<void> {
  try {
    const { customer, amount } = req.body as { customer: string; amount: number };
    res.json(await charge(customer, amount));
  } catch (err) {
    const status = err instanceof PaymentError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
  }
}
`;

/** Plans and prices as data (a longer JSON file). */
export const DEMO_PLANS_JSON = `${JSON.stringify(
  {
    currency: 'usd',
    plans: ['starter', 'team', 'business', 'enterprise'].map((name, i) => ({
      id: `plan_${name}`,
      name: name[0]!.toUpperCase() + name.slice(1),
      monthly: [0, 1900, 4900, 19900][i],
      yearly: [0, 19000, 49000, 199000][i],
      seats: [1, 10, 50, null][i],
      features: ['Payments', 'Webhooks', 'Refunds', 'Dashboard', 'Exports', 'SSO', 'Audit log', 'Priority support'].slice(0, 3 + i * 2),
      limits: { requestsPerMinute: [60, 300, 1200, 6000][i], webhooksPerDay: [1000, 20000, 200000, null][i] },
    })),
    coupons: Array.from({ length: 12 }, (_, i) => ({ code: `LAUNCH${(i + 1) * 5}`, percentOff: (i + 1) * 5, expires: `2027-0${(i % 9) + 1}-01` })),
  },
  null,
  2,
)}\n`;

/** A tall image: the landing page, top to bottom, as one long mockup. */
export const DEMO_LANDING_SVG = (() => {
  const W = 480;
  const sections = ['#1d2440', '#f3f1ff', '#ffffff', '#f6f6f7', '#ffffff', '#f3f1ff', '#1d2440'];
  const H = 360;
  const blocks = sections
    .map((fill, i) => {
      const y = i * H;
      const dark = fill === '#1d2440';
      const ink = dark ? '#ffffff' : '#2a2840';
      return `<rect y="${y}" width="${W}" height="${H}" fill="${fill}"/>
  <rect x="48" y="${y + 70}" width="${200 + (i % 3) * 60}" height="22" rx="6" fill="${ink}" opacity="0.9"/>
  <rect x="48" y="${y + 110}" width="320" height="10" rx="5" fill="${ink}" opacity="0.35"/>
  <rect x="48" y="${y + 130}" width="280" height="10" rx="5" fill="${ink}" opacity="0.35"/>
  <rect x="48" y="${y + 170}" width="${W - 96}" height="140" rx="12" fill="${dark ? '#7c6cf0' : '#e4e0ff'}"/>
  <rect x="48" y="${y + 330}" width="96" height="10" rx="5" fill="#7c6cf0"/>`;
    })
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${sections.length * H}" viewBox="0 0 ${W} ${sections.length * H}">\n  ${blocks}\n</svg>\n`;
})();

/** The add-auth worktree's server.ts: every route, most of them behind requireUser (a long diff). */
export const DEMO_SERVER_WITH_AUTH = `import express from 'express';
import { requireUser } from './auth';

const app = express();
app.use(express.json());
app.use('/api/payments', requireUser);

app.get('/api/health', (_req, res) => res.send('ok'));

${['payments', 'refunds', 'customers', 'invoices', 'plans', 'coupons', 'exports', 'webhooks', 'events', 'sessions', 'teams', 'audit']
  .map(
    (r) => `// ${r[0]!.toUpperCase()}${r.slice(1)}
app.get('/api/${r}', requireUser, async (req, res) => {
  const page = Number(req.query.page ?? 1);
  res.json(await list('${r}', { page, user: req.session }));
});
app.get('/api/${r}/:id', requireUser, async (req, res) => {
  const item = await find('${r}', req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});
`,
  )
  .join('\n')}
app.listen(3000);
`;

/** The demo's landing hero, as a React component for live previews (Settings › Experimental). */
export const DEMO_HERO_TSX = `import './hero.css';

type Tone = 'lavender' | 'mint' | 'peach';

export interface HeroProps {
  /** The big line on top. */
  title: string;
  /** One sentence under it. */
  subtitle: string;
  /** The button's words. */
  cta: string;
  tone: Tone;
  /** People already in, shown as faces. */
  people: { name: string; avatarUrl: string }[];
  /** Weekly sign-ups, a bar each. */
  signups: number[];
  onStart: () => void;
}

export default function Hero({ title, subtitle, cta, tone = 'lavender', people, signups, onStart }: HeroProps) {
  const peak = Math.max(1, ...signups);
  return (
    <section className={\`hero hero-\${tone}\`}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <div className="hero-row">
        <button onClick={onStart}>{cta}</button>
        <div className="faces">
          {people.map((p) => (
            <img key={p.name} src={p.avatarUrl} alt={p.name} title={p.name} />
          ))}
        </div>
      </div>
      <div className="bars" aria-label="Sign-ups">
        {signups.map((n, i) => (
          <span key={i} style={{ height: \`\${(n / peak) * 100}%\` }} />
        ))}
      </div>
    </section>
  );
}
`;

export const DEMO_HERO_CSS = `.hero { font-family: -apple-system, system-ui, sans-serif; border-radius: 18px; padding: 28px; color: #2e2a3d; }
.hero-lavender { background: #efe9ff; }
.hero-mint { background: #dff5ea; }
.hero-peach { background: #ffe9dc; }
.hero h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
.hero p { margin: 0 0 18px; color: #5d5775; }
.hero-row { display: flex; align-items: center; gap: 16px; }
.hero button { border: 0; border-radius: 999px; padding: 9px 18px; background: #2e2a3d; color: #fff; font: inherit; font-weight: 600; cursor: pointer; transition: background .2s; }
.hero button:hover { background: #6a5acd; }
.faces { display: flex; }
.faces img { width: 30px; height: 30px; border-radius: 50%; border: 2px solid #fff; margin-left: -8px; }
.bars { display: flex; align-items: flex-end; gap: 6px; height: 56px; margin-top: 22px; }
.bars span { flex: 1; border-radius: 6px 6px 2px 2px; background: rgba(46, 42, 61, 0.16); }
`;

/** Two small components in one file, for a preview's component picker and All Components. */
export const DEMO_BADGES_TSX = `type Tone = 'lavender' | 'mint' | 'peach';

const colors: Record<Tone, string> = { lavender: '#efe9ff', mint: '#dff5ea', peach: '#ffe9dc' };

export function Badge({ label, tone = 'lavender' }: { label: string; tone?: Tone }) {
  return <span style={{ background: colors[tone], borderRadius: 999, padding: '4px 10px', font: '600 12px system-ui' }}>{label}</span>;
}

export function Stat({ value, caption }: { value: number; caption: string }) {
  return (
    <div style={{ font: '13px system-ui', color: '#5d5775' }}>
      <strong style={{ display: 'block', font: '700 26px system-ui', color: '#2e2a3d' }}>{value}</strong>
      {caption}
    </div>
  );
}
`;

/** A component whose import isn't there yet, for a preview that says why it can't draw. */
export const DEMO_PRICE_TAG_TSX = `import { formatPrice } from './format-price';

export function PriceTag({ cents }: { cents: number }) {
  return <strong>{formatPrice(cents)}</strong>;
}
`;
