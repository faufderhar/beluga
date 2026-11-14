import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockBackend } from './agent/mock.js';
import { seedMockContext } from './agent/mock-context.js';
import { ATTACHMENT_SCHEME, ATTACHMENT_SHARE, formatBytes } from './core/attachments.js';
import { DEMO_BADGES_TSX, DEMO_DOCS, DEMO_PRICE_TAG_TSX, DEMO_HERO_CSS, DEMO_HERO_TSX, DEMO_LANDING_SVG, DEMO_PAYMENTS_TS, DEMO_PLANS_JSON, DEMO_SERVER_WITH_AUTH } from './demo-docs.js';
import { seedBobPulls, seedLandingHistory } from './demo-history.js';
import { demoScreenshot } from './demo-image.js';
import { demoPdf } from './demo-pdf.js';
import { type ShellRunner, runShell } from './core/peer-run.js';
import { DEMO_AGENTS } from './core/demo-agents.js';
import { Session } from './core/session.js';
import { belugaEnv } from './core/beluga-env.js';
import { ShareService } from './core/shares.js';
import { Store, initialState } from './core/store.js';
import { type RoomKeys } from './net/crypto.js';
import { PeerClient } from './net/peer-client.js';
import { chatMessageId } from './protocol.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { WorkspaceStore } from './workspaces/store.js';
import { dropGitLocalEnv } from './core/git-env.js';

const SUNSET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d2440"/><stop offset="0.55" stop-color="#c8667a"/><stop offset="1" stop-color="#f3b07a"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b3f63"/><stop offset="1" stop-color="#14172a"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="url(#sky)"/>
  <circle cx="200" cy="112" r="30" fill="#ffd9a0"/>
  <path d="M0 120 L60 70 L105 105 L150 60 L210 118 L250 88 L320 125 L320 180 L0 180 Z" fill="#2b2d4a"/>
  <rect y="128" width="320" height="52" fill="url(#sea)"/>
  <rect x="170" y="134" width="60" height="3" fill="#ffd9a0" opacity="0.7"/>
  <rect x="182" y="144" width="36" height="2" fill="#ffd9a0" opacity="0.5"/>
  <rect x="190" y="154" width="20" height="2" fill="#ffd9a0" opacity="0.35"/>
</svg>
`;

const BOB_FILES: Record<string, string> = {
  'README.md':
    '# Bob API\n\nA tiny service that powers **bob\'s** side project. See [the docs](https://example.com).\n\n## Getting started\n\n1. `npm install`\n2. `npm run dev`\n3. Open http://localhost:3000\n\n## Status\n\n- Auth: *not started*\n- Payments: in progress\n- Deploy: done\n\n> Tip: ask kay\'s Claude to review the auth plan.\n',
  'NOTES.md': '# Notes\n\n- TODO: add auth\n- Stripe webhooks are flaky on retries\n',
  'src/server.ts': "import express from 'express';\n\nconst app = express();\n// TODO: add auth\napp.get('/api/health', (_req, res) => res.send('ok'));\n\napp.listen(3000);\n",
  'design/sunset.svg': SUNSET_SVG,
  'package.json': '{\n  "name": "bob-api",\n  "scripts": { "dev": "tsx src/server.ts", "test": "vitest" }\n}\n',
  'src/payments.ts': DEMO_PAYMENTS_TS,
  'data/plans.json': DEMO_PLANS_JSON,
  'design/landing.svg': DEMO_LANDING_SVG,
  ...DEMO_DOCS,
};

const YOUR_FILES: Record<string, string> = {
  'README.md': '# Landing page\n\nMarketing site for the launch. Built with Astro.\n\n- `npm run dev` to preview\n- Copy lives in `content/`\n',
  'content/hero.md': '# Ship together\n\nYour friends. Their Claude. One terminal.\n',
};

function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** Sample folders for the demo: yours and a pretend friend's. */
export function createDemoFolders(): { mine: string; bob: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-'));
  const mine = path.join(base, 'landing');
  const bob = path.join(base, 'api');
  writeTree(mine, YOUR_FILES);
  writeTree(bob, BOB_FILES);
  return { mine, bob };
}

const FRIENDS = {
  bob: { lines: ['hey! just pushed my API notes', 'can your Claude take a look at the auth plan?', 'nice, thanks!'], share: 'api', usage: 64, first: 1200 },
  mia: { lines: ['hi all, joining from the landing page side', 'my Claude is on the hero copy, yours on auth?', 'perfect, ship it'], share: 'notes', usage: 22, first: 2600 },
} as const;

/** Canned output for the commands the demo shows off; anything else really runs in the friend's (temporary) folder. */
export const demoShell: ShellRunner = async (command, cwd, timeoutMs) => {
  if (/\b(npm|pnpm|yarn)( run)? test\b|\bvitest\b/.test(command)) {
    await new Promise((r) => setTimeout(r, 1400));
    const output = [
      '> bob-api@1.0.0 test',
      '> vitest run',
      '',
      ' RUN  v2.1.4 ~/' + path.basename(cwd),
      '',
      ' ✓ src/health.test.ts (3 tests) 12ms',
      ' ✓ src/payments.test.ts (14 tests) 48ms',
      ' ✓ src/webhooks.test.ts (7 tests) 31ms',
      '',
      ' Test Files  3 passed (3)',
      '      Tests  24 passed (24)',
      '   Duration  612ms',
    ].join('\n');
    return { exitCode: 0, output, truncated: false, timedOut: false, ms: 1400 };
  }
  return runShell(command, cwd, timeoutMs);
};

/**
 * A pretend friend who joins the room, shares a folder, lets you use a (simulated)
 * Claude, and chats back. Lets you try every feature alone.
 */
export function startDemoFriend(url: string, keys: RoomKeys, folder: string, name: keyof typeof FRIENDS = 'bob'): Session {
  const friend = FRIENDS[name];
  const shares = new ShareService([{ name: friend.share, root: folder, writable: false }]);
  const store = new Store(initialState('demo', 'auto'));
  const client = new PeerClient({ url, keys, profile: { name, shares: shares.infos, agent: true, ...structuredClone(DEMO_AGENTS[name]) } });
  const session = new Session({ client, store, shares, agentCwd: folder, createAgent: (bridge) => createMockBackend(bridge), runShell: demoShell });
  // The pretend friend "clicks Yes" on what you ask of their computer, after a moment.
  const answered = new Set<string>();
  store.subscribe(() => {
    for (const a of store.getState().approvals) {
      if (answered.has(a.id)) continue;
      answered.add(a.id);
      setTimeout(() => session.answerApproval('yes', a.id), 2200);
    }
  });
  let said = 0;
  let reactedToYou = false;
  const say = (delay: number): void => {
    const line = friend.lines[said++];
    if (line) setTimeout(() => session.sendChat(line, false), delay);
  };
  client.once('welcome', () => {
    session.updateUsage({ plan: 'pro', fiveHour: { pct: friend.usage }, week: { pct: 41 } });
    // Their Codex shares its plan windows too, so the Usage tab shows whose agent has room left.
    const codex = DEMO_AGENTS[name].agents.find((a) => a.runtime === 'codex');
    if (codex) session.updateUsage({ plan: 'plus', fiveHour: { pct: name === 'mia' ? 71 : 18 }, week: { pct: name === 'mia' ? 46 : 9 } }, codex);
    say(friend.first);
    if (name === 'bob') setTimeout(() => shareDemoWorkspace(session, shares, folder), 1800);
    if (name === 'bob') setTimeout(() => sendDemoScreenshot(session), 4200);
  });
  client.on('message', (msg) => {
    // Answer you (not each other), one line per message you send.
    const fromYou = msg.from !== client.peerId && !store.getState().peers.find((p) => p.peerId === msg.from && (p.name === 'bob' || p.name === 'mia'));
    if (fromYou && msg.body.kind === 'chat' && !msg.body.byAgent && said < friend.lines.length) say(name === 'bob' ? 1500 : 2400);
    // Reactions (BLG-702): bob likes mia's lines in the group chat, and mia has a look at your first one.
    const body = msg.body;
    if (body.kind !== 'chat' || body.byAgent || body.channel !== 'room' || msg.from === client.peerId) return;
    const fromMia = store.getState().peers.find((p) => p.peerId === msg.from)?.name === 'mia';
    const emoji = name === 'bob' && fromMia ? '👍' : name === 'mia' && fromYou && !reactedToYou ? '👀' : undefined;
    if (!emoji) return;
    if (name === 'mia') reactedToYou = true;
    setTimeout(() => {
      try {
        session.reactChat('room', chatMessageId(msg.from, body.mid, msg.id), emoji);
      } catch {
        // Not in the log (yet): the demo goes without it.
      }
    }, 900);
  });
  if (name === 'bob') answerDemoDiff(session, client);
  session.start();
  return session;
}

const DEMO_WS = 'bob-payments';
const DEMO_WORK_WS = 'bob-refunds';
const DEMO_PATCH = `@@ -1,4 +1,9 @@
-export async function onWebhook(event: Event) {
+const seen = new Set<string>();
+
+export async function onWebhook(event: Event) {
+  // Stripe retries: charge once per event id.
+  if (seen.has(event.id)) return;
+  seen.add(event.id);
   await charge(event.customer, event.amount);
 }
`;

/**
 * bob's demo Beluga has no real worktree, so it answers the Diff tab with a small, fixed change.
 * It listens ahead of the session, so this answer arrives first.
 */
function answerDemoDiff(session: Session, client: PeerClient): void {
  client.prependListener('message', (msg) => {
    if (msg.body.kind !== 'ws_diff' || msg.body.id !== DEMO_WS) return;
    const { reqId, file } = msg.body;
    const review = { base: 'main', commits: [{ hash: 'c41e9a2', subject: 'Make webhook retries idempotent' }], files: [{ path: 'src/webhooks.ts', added: 6, removed: 1, state: 'modified' as const }] };
    session.send(file ? { kind: 'ws_diff_result', reqId, ok: true, patch: DEMO_PATCH } : { kind: 'ws_diff_result', reqId, ok: true, review }, { to: msg.from });
  });
}

/** bob lets you watch one of his workspaces, so you can try a guest's Files, Terminal and Diff tabs. */
function shareDemoWorkspace(session: Session, shares: ShareService, folder: string): void {
  const host = session.store.getState().peers.find((p) => p.host);
  if (!host) return;
  const share = 'ws-bob-payments';
  shares.upsert({ name: share, root: folder, writable: false, private: true, allowed: [host.peerId] });
  const history = [
    { from: 'bob', text: 'retries keep double-charging, can you look at the webhook handler?', ts: Date.now() - 120_000, byAgent: false },
    { from: "bob's Claude", text: 'The handler is not idempotent: it charges again on every retry. I added an idempotency key check.', ts: Date.now() - 60_000, byAgent: true },
  ];
  session.send({ kind: 'ws_invite', ws: { id: DEMO_WS, name: 'payments', project: 'bob-api', branch: 'fix-webhooks' }, role: 'view', can: 'watch', share, history }, { to: host.peerId });
  // And one you work in with him: a message there goes to his agent, so you can try sending into a friend's chat (BLG-152).
  const work = 'ws-bob-refunds';
  shares.upsert({ name: work, root: folder, writable: false, private: true, allowed: [host.peerId] });
  session.store.dispatch({ type: 'member_set', id: DEMO_WORK_WS, peerId: host.peerId, role: 'contribute' });
  session.send({ kind: 'ws_invite', ws: { id: DEMO_WORK_WS, name: 'refunds', project: 'bob-api', branch: 'partial-refunds' }, role: 'contribute', share: work, history: [] }, { to: host.peerId });
}

/** bob sends the room a screenshot (the way a pasted image goes out), so the demo shows images in the chat. */
function sendDemoScreenshot(session: Session): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-images-'));
  const file = 'checkout-error.png';
  const png = demoScreenshot();
  writeFileSync(path.join(dir, file), png);
  const others = session.store.getState().peers.filter((p) => p.peerId !== session.selfId).map((p) => p.peerId);
  session.serveFolder(ATTACHMENT_SHARE, dir, others);
  session.sendChat(`this is the checkout error on staging [📎 image 1 (png, ${formatBytes(png.byteLength)})](${ATTACHMENT_SCHEME}${session.selfId}/${file})`, false);
}

/** Someone who got your link to one project and knocks (the demo's Invite flow, from the other side). */
export function startDemoGuest(url: string, keys: RoomKeys, name = 'zoe'): Session {
  const store = new Store(initialState('demo', 'deny'));
  const shares = new ShareService([]);
  const client = new PeerClient({ url, keys, profile: { name, shares: [], agent: false } });
  const session = new Session({ client, store, shares, agentCwd: os.tmpdir() });
  session.start();
  return session;
}

// ---------------------------------------------------------------------------
// Demo projects: real git repos with worktrees, so every workspace feature works.
// ---------------------------------------------------------------------------


const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=demo@beluga.dev', '-c', 'user.name=Beluga demo', ...args], { cwd, stdio: 'ignore' });
};

function demoRepo(base: string, name: string, files: Record<string, string>): string {
  const origin = path.join(base, 'remotes', `${name}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  const dir = path.join(base, 'Projects', name);
  writeTree(dir, files);
  gitIn(dir, 'init', '-b', 'main');
  gitIn(dir, 'add', '.');
  // Two weeks back, so the demo's history reads like a real project's.
  const start = new Date(Date.now() - 14 * 86_400_000).toISOString();
  execFileSync('git', ['-c', 'user.email=demo@beluga.dev', '-c', 'user.name=Beluga demo', 'commit', '-q', '-m', 'Initial commit'], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: start, GIT_COMMITTER_DATE: start } });
  gitIn(dir, 'remote', 'add', 'origin', origin);
  gitIn(dir, 'push', '-u', 'origin', 'main');
  gitIn(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

/** Two sample projects with worktrees in different states, plus saved conversations. */
export async function createDemoWorkspaces(): Promise<WorkspaceManager> {
  // Its git must never reach a repository git pointed this process at (git-env.ts): `git init --bare` there made it bare.
  dropGitLocalEnv();
  const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-projects-'));
  demoRepo(base, 'bob-api', BOB_FILES);
  seedBobPulls(path.join(base, 'remotes', 'bob-api.git'), base);
  const landingDir = demoRepo(base, 'landing', YOUR_FILES);
  // History with several people and merged branches, and a teammate's push you haven't pulled yet.
  seedLandingHistory(landingDir, path.join(base, 'remotes', 'landing.git'), base);
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'Projects')], projects: [], hidden: [] });
  const mgr = new WorkspaceManager(store);
  await mgr.refresh();
  const api = mgr.list.find((p) => p.name === 'bob-api');
  const landing = mgr.list.find((p) => p.name === 'landing');
  if (api) {
    const auth = await mgr.createWorktree(api.id, 'add-auth');
    writeTree(auth.path, { 'src/auth.ts': "export function requireUser(req: { session?: string }) {\n  if (!req.session) throw new Error('unauthorized');\n}\n" });
    gitIn(auth.path, 'add', '.');
    gitIn(auth.path, 'commit', '-m', 'Add requireUser middleware');
    writeTree(auth.path, { 'src/server.ts': DEMO_SERVER_WITH_AUTH });
    gitIn(auth.path, 'add', '.');
    gitIn(auth.path, 'commit', '-m', 'Protect payments routes');
    // On GitHub already, as a branch with a pull request is: its PR's checks are for what's here.
    gitIn(auth.path, 'push', '-q', 'origin', 'HEAD');
    const tests = await mgr.createWorktree(api.id, 'webhook-retries');
    writeTree(tests.path, { 'src/webhooks.ts': '// retry with backoff\nexport const MAX_RETRIES = 5;\n' });
    // The demo plan's two tasks in progress, each in its own worktree (the sidebar shows the plan instead).
    const checkoutAuth = await mgr.createWorktree(api.id, 'checkout-auth');
    writeTree(checkoutAuth.path, { 'src/auth.ts': "export function requireUser(req: { session?: string }) {\n  if (!req.session) throw new Error('unauthorized');\n}\n" });
    gitIn(checkoutAuth.path, 'add', '.');
    gitIn(checkoutAuth.path, 'commit', '-m', 'Require a session on payment routes');
    const checkoutHooks = await mgr.createWorktree(api.id, 'checkout-events');
    writeTree(checkoutHooks.path, { 'src/webhooks.ts': '// handle each event once\nexport const MAX_RETRIES = 5;\n' });
    await mgr.createChat(api.id, 'How do deploys work?');
    // BELUGA_DEMO_SCENE=external (BLG-121): a chat an external agent started, with its label on the message.
    if (belugaEnv('DEMO_SCENE') === 'external') {
      const driven = await mgr.createWorktree(api.id, 'fix-rate-limit');
      const via = { id: 'demo0grokbot', name: 'GrokBot', creationSource: 'mcp' as const };
      mgr.setStartedBy(driven.id, { id: via.id, name: via.name });
      const line = (id: string, from: string, name: string, text: string, ts: number) => ({ id, type: 'chat', channel: `ws:${driven.id}`, from, name, text, ts, byAgent: false, via });
      store.saveHistory(driven.id, [
        line('demo-via-1', 'bob-demo-peer', 'kay', 'On a friend\'s Beluga, a message of an external agent says so too.', Date.now() - 120_000),
        line('demo-via-2', 'self', 'you', 'Find why the rate limit test fails on CI and fix it.', Date.now() - 60_000),
      ]);
    }
    // Worktrees Claude Code sub-agents leave behind (listed after the project's own worktrees).
    for (const id of ['a3f9c1e07b2d', 'a8b24d6e91c0']) gitIn(api.root, 'worktree', 'add', '-q', '-b', `agent-${id}`, path.join(api.root, '.claude', 'worktrees', `agent-${id}`));
  }
  if (landing) {
    const hero = await mgr.createWorktree(landing.id, 'new-hero');
    // Uncommitted: a new hero line, a README edit, a picture and a PDF (the Changes tab shows them as themselves).
    writeTree(hero.path, {
      'content/hero.md': '# Build together\n\nYou, your friends, and everyone\'s Claude.\n',
      'README.md': '# Landing page\n\nMarketing site for the launch. Built with Astro.\n\n## Develop\n\n- `npm run dev` to preview\n- Copy lives in `content/`\n- The brand brief is in `docs/brand-brief.pdf`\n\n| Page | Status |\n| --- | --- |\n| Hero | **new** |\n| Pricing | draft |\n',
      'public/hero-shot.png': demoScreenshot(),
      'docs/brand-brief.pdf': demoPdf(),
      // A component for live previews (Settings › Experimental), drawn with the Mac app's own React.
      'src/components/Hero.tsx': DEMO_HERO_TSX,
      'src/components/hero.css': DEMO_HERO_CSS,
      'src/components/Badges.tsx': DEMO_BADGES_TSX,
      'src/components/PriceTag.tsx': DEMO_PRICE_TAG_TSX,
    });
    const react = path.resolve(import.meta.dirname, '../packages/mac/node_modules');
    if (existsSync(path.join(react, 'react-dom'))) {
      symlinkSync(react, path.join(hero.path, 'node_modules'));
      // Installed packages aren't a change: the Changes tab leaves them out, as a project's .gitignore would.
      writeFileSync(path.join(landingDir, '.git', 'info', 'exclude'), 'node_modules\n', { flag: 'a' });
    }
  }
  await mgr.refresh();
  seedDemoUsage(mgr);
  return mgr;
}

/** Two weeks of (made-up) Claude runs, so the Usage screen has days, totals and costs to show. */
function seedDemoUsage(mgr: WorkspaceManager): void {
  const weight: Record<string, number> = { 'add-auth': 1, 'webhook-retries': 0.55, 'new-hero': 0.35, 'How do deploys work?': 0.12 };
  const all = mgr.list.flatMap((p) => p.workspaces).filter((w) => weight[w.name] !== undefined);
  const day = 86_400_000;
  for (let ago = 13; ago >= 0; ago--) {
    // A steady, repeatable rhythm: busier mid-week, quiet weekends.
    const pace = 0.35 + 0.65 * Math.abs(Math.sin((ago + 2) * 0.9));
    for (const w of all) {
      const share = weight[w.name]! * pace;
      if (share < 0.12) continue;
      const input = Math.round(42_000 * share);
      // A new id each day, so each run is added in full (the Usage chart stays the two-week sum).
      // The last day is the open session: the context meter shows that day's cache hit rate.
      mgr.addUsage(w.id, { input, output: Math.round(input * 0.18), cacheRead: input * 6, cacheWrite: Math.round(input * 0.3), cost: Math.round(input * 0.0000165 * 100) / 100, session: `demo-${w.id}-${ago}` }, Date.now() - ago * day);
    }
  }
}

/** How full the demo's conversations start (percent of 200k): calm, one getting full, one about to compact. */
const DEMO_CONTEXT: Readonly<Record<string, number>> = { 'add-auth': 48, 'webhook-retries': 72, 'new-hero': 31, 'How do deploys work?': 83 };

/** Give the demo's conversations a context meter to show (the demo's Claude continues from there). */
export function seedDemoContext(store: Store, tries = 40): void {
  const all = store.getState().projects.flatMap((p) => p.workspaces);
  // The projects arrive a moment after the daemon starts.
  if (!all.some((w) => DEMO_CONTEXT[w.name] !== undefined)) {
    if (tries > 0) setTimeout(() => seedDemoContext(store, tries - 1), 250).unref();
    return;
  }
  for (const ws of all) {
    const pct = DEMO_CONTEXT[ws.name];
    if (pct === undefined) continue;
    const used = Math.round(2_000 * pct);
    seedMockContext(ws.path, used);
    store.dispatch({ type: 'agent_event', owner: store.getState().selfId, requestId: `demo-context-${ws.id}`, requester: store.getState().selfId, event: 'context', text: JSON.stringify({ used, window: 200_000 }), ts: Date.now(), channel: `ws:${ws.id}` });
  }
}
