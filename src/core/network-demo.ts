import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentity } from '../net/crypto.js';
import { Mesh } from '../net/mesh/mesh.js';
import { dmConversation, groupConversation } from '../net/mesh/views.js';
import { type NetworkService, startNetwork } from './network.js';
import { demoPortrait, demoScreenshot } from '../demo-image.js';
import { ChatClaude } from './chat/claude.js';
import { demoAnswerFromPrompt } from './chat/demo-answers.js';
import { ChatFiles } from './chat/files.js';
import type { Store } from './store.js';
import { type AgentRef, defaultAgentOf } from '../protocol.js';
import { DEMO_AGENTS } from './demo-agents.js';
import { belugaEnv } from './beluga-env.js';
import { SHARE_FEATURES } from '../net/mesh/features.js';
import { demoCallers } from './calls/demo.js';
import { startDemoBoard } from './leaderboard/demo.js';

const CHECKLIST = `# Friday release

- [x] Staging green
- [x] Migrations dry-run
- [ ] Smoke test checkout
- [ ] Announce in #launch
`;

/** A demo friend's Mac shares files and answers when their Claude is asked, like a real one (with made-up answers). */
function demoChat(mesh: Mesh, dir: string, pace: number, agent: AgentRef): { files: ChatFiles; claude: ChatClaude } {
  const files = new ChatFiles({ mesh, dir: path.join(dir, 'chat-files') });
  const claude = new ChatClaude({
    mesh,
    files,
    answer: async (req) => {
      await new Promise((r) => setTimeout(r, (1800 + Math.random() * 1500) * pace));
      return demoAnswerFromPrompt(req.system, req.prompt);
    },
    agent: () => agent,
    policy: () => 'everyone',
    trustOf: () => 'trusted',
  });
  return { files, claude };
}

/** Wait (up to 20 s) for something to become true. */
async function until(ok: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * The demo's Beluga network: you, bob and mia as real mesh nodes on a private DHT inside this
 * process (nothing touches the internet or your ~/.beluga). bob and mia are your friends, the
 * three of you share a group, and they answer when you write to them.
 */
export async function startDemoNetwork(store: Store, name: string): Promise<NetworkService> {
  const createTestnet = (await import('hyperdht/testnet.js')).default;
  const { demoResponder } = await import('./gateway/demo.js');
  const testnet = await createTestnet(3, { host: '127.0.0.1' });
  const base = mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-network-'));
  const where = { bootstrap: testnet.bootstrap, host: '127.0.0.1' };
  const friend = (n: string): Promise<Mesh> => Mesh.start({ identity: generateIdentity(), name: n, dir: path.join(base, n), ...where });
  const [bob, mia] = await Promise.all([friend('bob'), friend('mia')]);
  // Their Macs say they open shared projects and worktrees, so the Share sheets can share with them.
  for (const m of [bob, mia]) m.offer(SHARE_FEATURES, true);
  const me = await startNetwork({ store, identity: generateIdentity(), name, dir: path.join(base, 'me'), ...where });
  const meId = me.mesh.peerId;
  await me.mesh.accept((await bob.createInvite()).link);
  await me.mesh.accept((await mia.createInvite()).link);
  await mia.accept((await bob.createInvite()).code);
  mia.setPresence({ state: 'away', note: 'in a meeting', emoji: '📅' });
  // mia has a profile picture (her card's avatar opens it large); bob keeps his initial.
  mia.setAvatar(demoPortrait());
  let stopped = false;
  const pace = Number(belugaEnv('DEMO_PACE')) || 1;
  // bob answers with Claude (Opus), mia with Codex: the chat shows whose agent said what.
  const chats = { bob: demoChat(bob, path.join(base, 'bob'), pace, defaultAgentOf(DEMO_AGENTS.bob)), mia: demoChat(mia, path.join(base, 'mia'), pace, defaultAgentOf(DEMO_AGENTS.mia)) };
  const group = bob.createGroup('launch', [meId, mia.peerId]);
  const morning = bob.sendGroup(group.id, 'Morning! Staging is green, ready when you are.');
  const launch = groupConversation(group.id);
  // bob shares the checklist and a screenshot: they come straight from his Mac.
  void (async () => {
    writeFileSync(path.join(base, 'release-checklist.md'), CHECKLIST);
    writeFileSync(path.join(base, 'checkout.png'), demoScreenshot());
    const shared = await chats.bob.files.share([path.join(base, 'release-checklist.md'), path.join(base, 'checkout.png')]);
    if (!stopped) bob.sendGroup(group.id, 'Checklist for Friday, and how checkout looks on staging.', { files: shared });
  })().catch(() => undefined);
  bob.sendDm(meId, 'Could you look at the deploy script later?');
  // mia writes once the group has reached her (in the background: the demo doesn't wait).
  void until(() => mia.summary().groups.some((g) => g.id === group.id && g.active)).then(async (ok) => {
    if (!ok || stopped) return;
    const copy = mia.sendGroup(group.id, 'Copy for the landing page is in. Can someone review?');
    // Reactions (BLG-702): mia cheers bob's morning note, and bob has a look at her copy.
    if (await until(() => mia.conversation(launch).some((m) => m.id === morning.id)) && !stopped) mia.react(launch, morning.id, '🎉');
    if (await until(() => bob.conversation(launch).some((m) => m.id === copy.id)) && !stopped) bob.react(launch, copy.id, '👀');
  }).catch(() => undefined);

  // Their Claudes answer your Claude's tasks (core/gateway/demo.ts). You trust bob; mia asks you each time.
  const responders = { bob: demoResponder(bob, 'bob', meId, base), mia: demoResponder(mia, 'mia', meId, base) };
  store.dispatch({ type: 'remembered', people: { ...store.getState().remembered, [bob.peerId]: { name: 'bob', trust: 'trusted' } } });

  // BELUGA_DEMO_SCENE=people (screenshots of BLG-210): a channel with someone offline and a secret waiting on you.
  let ata: Mesh | undefined;
  if (belugaEnv('DEMO_SCENE') === 'people') {
    void (async () => {
      ata = await friend('ata');
      await me.mesh.accept((await ata.createInvite()).link);
      await ata.accept((await bob.createInvite()).code);
      await until(() => bob.summary().friends.some((f) => f.peerId === ata!.peerId && f.online));
      const api = bob.createGroup('api-redesign', [meId, mia.peerId, ata.peerId]);
      const conv = groupConversation(api.id);
      const joined = await until(() => [ata!, mia].every((m) => m.summary().groups.some((g) => g.id === api.id && g.active)) && me.mesh.summary().groups.some((g) => g.id === api.id && g.active));
      if (!joined || stopped) return;
      me.mesh.sendGroup(api.id, '@ata what’s in the text files on your desktop? Need the API notes.');
      ata.sendGroup(api.id, 'Three endpoints to retire: /v1/session, /v1/token and /v1/me. And a todo to move auth to cookies.');
      await new Promise((r) => setTimeout(r, 400));
      bob.sendGroup(api.id, 'Yep, that’s the plan.');
      mia.sendGroup(api.id, 'Can my agent grab the deploy key to test against staging?');
      me.mesh.sendGroup(api.id, 'Sure, just this once.');
      // mia's Claude asks for a secret here: only you can allow it, each time.
      try {
        const t = responders.mia.gateway.ask({ person: meId, kind: 'file', path: '~/.ssh/id_ed25519', ask: 'Send me the deploy key so I can test against staging', summary: 'the deploy key', by: 'agent', conversation: conv });
        if (t.state === 'confirm') responders.mia.gateway.confirm(t.id, true);
      } catch {
        // Not linked yet: the scene goes without it.
      }
      // ata goes offline: messages to them wait.
      await new Promise((r) => setTimeout(r, 1500));
      await ata.close();
    })().catch(() => undefined);
  }

  // The leaderboard (BLG-904): bob writes and merges more than you, mia less, and her agents run long.
  const boards = [startDemoBoard(bob, { chars: 9_000, prs: 0.7, hours: 4.5, seed: 3 }), startDemoBoard(mia, { chars: 2_600, prs: 0.25, hours: 6, seed: 11 })];

  // Calls (BLG-706): bob and mia pick up when you call; BELUGA_DEMO_SCENE=call has bob ring you in #launch.
  const callers = demoCallers([bob, mia], pace);
  if (belugaEnv('DEMO_SCENE') === 'call') {
    void until(() => me.mesh.summary().groups.some((g) => g.id === group.id && g.active) && mia.summary().groups.some((g) => g.id === group.id && g.active)).then((ok) => {
      if (!ok || stopped) return;
      setTimeout(() => !stopped && callers.ring(bob, launch), 2500 * pace).unref();
      // bob's camera is on, as he would have it; mia keeps hers off.
      setTimeout(() => !stopped && callers.set(bob, launch, { camera: true }), 3500 * pace).unref();
    });
  }

  // BELUGA_DEMO_SCENE=team (BLG-417): bob teams up on bob-api, works on a task and knocks on your worktree.
  let stopTeam: (() => void) | undefined;
  if (belugaEnv('DEMO_SCENE') === 'team') void import('./team/demo.js').then(async (m) => (stopTeam = await m.startDemoTeam(bob, meId, path.join(base, 'bob')))).catch(() => undefined);

  // They answer you (mention Claude and their Claude asks yours something).
  bob.on('message', (m) => {
    // An edit comes as the same message again: he already answered it.
    if (m.mine || m.edited) return;
    if (m.conversation === dmConversation(meId)) setTimeout(() => !stopped && bob.sendDm(meId, `On it: “${m.text.slice(0, 60)}”`), 1200).unref();
    if (m.conversation === dmConversation(meId) && /claude|screenshot/i.test(m.text)) setTimeout(() => !stopped && responders.bob.askBack(/screenshot/i.test(m.text) ? 'screenshot' : 'question'), 2000).unref();
  });
  mia.on('message', (m) => {
    if (!m.mine && m.conversation === dmConversation(meId) && /claude|screenshot/i.test(m.text)) setTimeout(() => !stopped && responders.mia.askBack(/screenshot/i.test(m.text) ? 'screenshot' : 'question'), 1500).unref();
  });
  mia.on('message', (m) => {
    if (m.mine || m.from !== meId || m.conversation !== groupConversation(group.id)) return;
    setTimeout(() => !stopped && mia.sendGroup(group.id, 'Sounds good, see you there.'), 1500).unref();
  });

  return {
    mesh: me.mesh,
    stop: async () => {
      stopped = true;
      stopTeam?.();
      for (const off of boards) off();
      callers.stop();
      for (const c of Object.values(chats)) {
        c.claude.stop();
        c.files.stop();
      }
      responders.bob.stop();
      responders.mia.stop();
      await me.stop();
      await Promise.all([bob.close(), mia.close(), ata?.close().catch(() => undefined)]);
      await testnet.destroy();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
