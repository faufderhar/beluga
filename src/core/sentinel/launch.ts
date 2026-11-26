import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { assistantOf } from '../assistant/registry.js';
import { busyChannels } from '../board/work.js';
import { assistantChannel, assistantChatOf } from '../../shared/assistant.js';
import { commandEnv, fetchSource } from '../views/sources.js';
import { ghRepoEnv } from '../../workspaces/github.js';
import type { Source } from '../../shared/view-spec.js';
import { gatewayOf } from '../gateway/registry.js';
import { isFinal } from '../gateway/model.js';
import { agentLabel } from '../../shared/agent-label.js';
import { defaultAgentOf } from '../../protocol.js';
import { networkOf } from '../network.js';
import { git, status } from '../../workspaces/git.js';
import { findPr, mergePr } from '../../workspaces/pr.js';
import type { PullRequest } from '../work-store.js';
import { runGhCli } from '../issues/gh.js';
import { loadStripeFile } from '../stripe-earnings.js';
import { openTunnel, waitUntilReachable } from '../../net/tunnel.js';
import { demoGitHub, demoServices, demoTriggers, seedDemoSentinel } from './demo.js';
import type { FetchLike, TriggerDeps, WebhookTunnel } from './triggers/types.js';
import { attachSentinel, detachSentinel } from './registry.js';
import type { PrLook, PrPlace, SentinelChat, SentinelClaude, SentinelFriends, SentinelGitHub, SentinelPlaces, SentinelWake } from './runner.js';
import { wakeRefusal } from './wake.js';
import { Sentinels } from './sentinels.js';
import { keepWidgetSnapshot } from './widgets.js';
import path from 'node:path';

/**
 * Start Sentinel for the daemon (the Mac app's Beluga): sentinels in ~/.beluga/sentinel.json,
 * their runs' folders in ~/.beluga/sentinel/runs. The demo's live in memory and start with four
 * sentinels and their history. → stop.
 */

export interface SentinelHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchSentinel(host: SentinelHost): () => void {
  const { session, store } = host;
  // The demo's history is made "in the past".
  let back = 0;
  const claude = ownClaude(session, store);
  const services = host.demo ? demoServices() : undefined;
  const sentinels = new Sentinels({
    store,
    dir: host.demo ? null : belugaHome(),
    now: () => Date.now() - back,
    selfId: () => session.selfId,
    claude,
    places: places(session),
    // A script step's gh works on origin's repository (a fork's own, not the original), as Beluga does.
    envFor: (cwd) => ({ ...ghRepoEnv(cwd), ...commandEnv(cwd) }),
    notify: (e) => session.notifier.notify(e),
    // The demo's pull requests open, pass and merge without GitHub.
    github: host.demo ? demoGitHub() : github(session, store),
    chat: chat(session, store),
    wake: wake(session, store),
    friends: friends(session),
    // The demo's GitHub, Stripe, Sentry, sites and tunnel answer without the network.
    triggers: host.demo ? demoTriggers(store) : triggers(session, store),
    fetchSource: sourceRows,
    ...(services ? { fetch: services.fetch } : {}),
    // The Stripe revenue recipe calls Stripe with the key Earnings keeps for the project.
    serviceEnv: (projectId) => {
      if (services) return services.env;
      const root = projectId ? store.getState().projects.find((p) => p.id === projectId)?.root : undefined;
      const key = root && !host.demo ? loadStripeFile().projects[root]?.key : undefined;
      return key ? { STRIPE_EARNINGS_KEY: key } : {};
    },
  });
  attachSentinel(session, sentinels);
  const stopSeed = host.demo && !sentinels.list().length ? seedDemoSentinel(store, sentinels, (ms) => (back = ms)) : () => undefined;
  // The boards' tiles for the Mac's desktop widgets (BLG-309): never the demo's.
  const stopWidgets = !host.demo && process.platform === 'darwin' ? keepWidgetSnapshot(store, path.join(belugaHome(), 'widgets'), (id) => store.getState().projects.find((p) => p.id === id)?.root) : () => undefined;
  return () => {
    stopWidgets();
    stopSeed();
    claude.close();
    detachSentinel(session);
    sentinels.stopAll();
    store.dispatch({ type: 'sentinel_off' });
  };
}

/**
 * A Keep the numbers step's source, run as views run theirs (your environment, the source's own
 * checks: never a credential file), fresh each run. It's your own sentinel's, so it doesn't wait for a
 * yes the way a command in a chat does; a change by your Claude to it pauses the sentinel instead.
 * Your Claude checking or testing one alone (`byClaude`: before saving, sentinel_test) runs what's
 * read-only by itself (a database, a file, an address without your variables); a command, or an
 * address that would carry one of your variables, waits for your yes (Run Now, or a view's Run).
 */
async function sourceRows(source: Source, cwd: string, _signal: AbortSignal, opts?: { readonly byClaude?: boolean }): Promise<{ readonly rows: readonly import('../../shared/view-spec.js').Row[]; readonly columns: readonly string[] } | { readonly needsYes: string } | string> {
  const got = await fetchSource(source, { offset: 0, limit: 5000 }, { cwd, confirm: !opts?.byClaude, fresh: true });
  if ('needsApproval' in got) return opts?.byClaude ? { needsYes: got.what } : `it needs your yes first: ${got.what}`;
  if ('notKept' in got) return 'nothing came back';
  return { rows: got.rows, columns: got.columns };
}

/** Where the event triggers look: gh, the web, Earnings' Stripe keys, your variables, a Cloudflare quick tunnel. */
function triggers(session: Session, store: Store): Omit<TriggerDeps, 'store' | 'selfId'> {
  const rootOf = (id: string | undefined): string | undefined => (id ? store.getState().projects.find((p) => p.id === id)?.root : undefined);
  return {
    gh: runGhCli,
    repoOf: async (id) => session.workspaces?.mainSync.githubRepo(id),
    fetch: globalThis.fetch as unknown as FetchLike,
    stripeKey: (id) => {
      const root = rootOf(id);
      return root ? loadStripeFile().projects[root]?.key : undefined;
    },
    env: (id) => commandEnv(rootOf(id)),
    tunnel: cloudflareTunnel,
    // The daemon's start replays tasks, pull requests and plans: none of that is news.
    warmupMs: 20_000,
  };
}

/** A Cloudflare quick tunnel to the webhook server, handed out once its name answers. */
const cloudflareTunnel: WebhookTunnel = async (port, onDied) => {
  const t = await openTunnel('cloudflared', port, { onDied });
  if (!t) throw new Error('no tunnel');
  if (!(await waitUntilReachable(t.publicUrl, 90_000))) {
    t.close();
    throw new Error('the tunnel never answered');
  }
  return { url: t.publicUrl, close: () => t.close() };
};

/** Your own Claude, asked in a conversation and waited for by its request (askAndWait's pattern, keyed by request). */
function ownClaude(session: Session, store: Store): SentinelClaude & { close(): void } {
  const waits = new Map<string, { readonly resolve: (text: string) => void; readonly reject: (err: Error) => void }>();
  const off = store.onAction((a) => {
    if (a.type !== 'agent_event') return;
    const w = waits.get(a.requestId);
    if (!w || !['done', 'error', 'denied'].includes(a.event)) return;
    waits.delete(a.requestId);
    if (a.event === 'done') w.resolve(a.text);
    else w.reject(new Error(a.text || a.event));
  });
  return {
    ask: (prompt, channel, shown) => session.askOwnClaude(prompt, channel, false, shown),
    wait: (requestId) => new Promise<string>((resolve, reject) => void waits.set(requestId, { resolve, reject })),
    // The wait stays until the request ends (its done or error event), so the run can wait for it
    // before archiving its worktree; one that never says so is let go after a while.
    cancel: (requestId, note) => {
      const letGo = (): void => {
        const w = waits.get(requestId);
        if (!w) return;
        waits.delete(requestId);
        w.reject(new Error('Stopped'));
      };
      // Not running (any more): nothing to wait for.
      if (!session.host.cancelRun(requestId, note)) return letGo();
      const timer = setTimeout(letGo, 15_000);
      timer.unref?.();
    },
    close: () => {
      off();
      for (const w of waits.values()) w.reject(new Error('Beluga closed'));
      waits.clear();
    },
  };
}

/** Where a run's Claude works: quiet chats and worktrees (the window stays where it is), Your Mac's chats. */
function places(session: Session): SentinelPlaces | undefined {
  const ctl = session.workspaces;
  if (!ctl) return undefined;
  return {
    projectChat: async (projectId, title) => {
      const ws = await ctl.newChat(projectId, title, undefined, { quiet: true });
      return ws ? { channel: `ws:${ws.id}`, workspaceId: ws.id } : undefined;
    },
    worktree: async (projectId, name) => {
      const ws = await ctl.startWorktree(projectId, '', (p) => session.nameTask(p), { quiet: true, name });
      return ws ? { channel: `ws:${ws.id}`, workspaceId: ws.id } : undefined;
    },
    macChat: (run) => {
      const mac = assistantOf(session);
      if (!mac) return undefined;
      // Beluga's own: never refused by your Open chats limit, never takes your tab (BLG-568); a run's on the agent its step chose.
      return { channel: assistantChannel(mac.newChat({ auto: true, ...(run?.agent ? { agent: run.agent } : {}) })) };
    },
    putAway: async (channel) => {
      if (channel.startsWith('ws:')) {
        const ws = ctl.manager.find(channel.slice(3));
        if (ws && !ws.archived && ws.kind === 'chat') await ctl.archive(ws.id, false, { quiet: true });
        return;
      }
      const mac = assistantOf(session);
      const id = assistantChatOf(channel);
      const chats = mac?.chats();
      // Only one of Beluga's own, and never the one you have open.
      if (mac && id && chats && chats.active !== id && chats.chats.some((c) => c.id === id && c.auto)) await mac.deleteChat(id);
    },
    deleteChat: async (channel) => {
      if (busyChannels(session.store.getState().log).has(channel)) session.host.stopRun(channel);
      if (channel.startsWith('ws:')) {
        const ws = ctl.manager.find(channel.slice(3));
        if (ws && ws.kind === 'chat') await ctl.remove(ws.id, { quiet: true });
        return;
      }
      const id = assistantChatOf(channel);
      if (id) await assistantOf(session)?.deleteChat(id);
    },
    madeChanges: async (workspaceId) => {
      const ws = ctl.manager.find(workspaceId);
      if (!ws || ws.archived) return undefined;
      const s = await status(ws.path, ws.base).catch(() => undefined);
      return s ? s.ahead > 0 || s.changed > 0 : undefined;
    },
    archive: (workspaceId) => ctl.archive(workspaceId, false, { quiet: true }),
    // A run's own chat or worktree (no one else's conversation): set outright, no handoff note.
    setAgent: (workspaceId, agent, effort) => {
      if (!ctl.manager.find(workspaceId)) return;
      ctl.manager.setAgent(workspaceId, agent);
      ctl.manager.setEffort(workspaceId, effort);
      void ctl.refresh();
    },
  };
}

const FAILED = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

/** A pull request as the merge gate reads it. */
export function prLook(pr: PullRequest): PrLook {
  const runs = pr.checkRuns ?? [];
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    conflicts: Boolean(pr.conflicts),
    checks: pr.checks,
    failed: runs.filter((c) => c.state === 'completed' && FAILED.has(c.conclusion ?? '')).map((c) => c.name),
    count: runs.length,
    ...(pr.head ? { head: pr.head } : {}),
  };
}

/** GitHub through the workbench (its PR steps, its toasts and state) and gh. */
function github(session: Session, store: Store): SentinelGitHub {
  const bench = session.workbench;
  const ctl = session.workspaces;
  const live = (id: string | undefined) => {
    const ws = id ? ctl?.manager.find(id) : undefined;
    return ws && !ws.archived ? ws : undefined;
  };
  /** Where gh runs for a pull request: its worktree, else the project's main folder. */
  const dirOf = (where: PrPlace): string | undefined => live(where.workspaceId)?.path ?? store.getState().projects.find((p) => p.id === where.projectId)?.root;
  return {
    openPr: async (workspaceId, opts) => {
      if (!bench) return 'pull requests need the Beluga app';
      const out = await bench.quickPr(workspaceId, opts.draft ? { draft: true } : {});
      const pr = store.getState().prs[workspaceId];
      if (!out.ok || !pr) return out.message || 'GitHub didn’t open the pull request';
      return { number: pr.number, url: pr.url };
    },
    look: async (where, number) => {
      const dir = dirOf(where);
      if (!dir) return 'its worktree and project are gone';
      const pr = await findPr(dir, String(number));
      return pr ? prLook(pr) : `GitHub has no pull request #${number} here (or gh isn’t set up: brew install gh, then gh auth login)`;
    },
    review: async (where, pr) => {
      const ws = live(where.workspaceId);
      if (!ws) return undefined;
      const project = store.getState().projects.find((p) => p.id === ws.projectId);
      const base = (ws.base ?? project?.base ?? 'main').replace(/^origin\//, '');
      const title = store.getState().prs[ws.id]?.title;
      // The commit the reviewer diffs (HEAD here): the gate holds when it isn't the pull request's head.
      const head = (await git(ws.path, ['rev-parse', 'HEAD'], 5000).catch(() => '')).trim();
      const review = await session.reviewPr({ dir: ws.path, number: pr.number, base, ...(title ? { title } : {}) });
      return review ? { ...review, ...(head ? { head } : {}) } : undefined;
    },
    merge: async (where, pr, method, head) => {
      const ws = live(where.workspaceId);
      if (bench && ws && store.getState().prs[ws.id]) {
        const out = await bench.mergePr(ws.id, { method, deleteBranch: true, matchHead: head });
        return out.ok ? true : out.message;
      }
      const dir = dirOf(where);
      if (!dir) return 'its worktree and project are gone';
      await mergePr(dir, pr.number, { method, matchHead: head });
      return true;
    },
  };
}

/** The Beluga network's chats, as you: an error in words while it's off. */
function chat(session: Session, store: Store): SentinelChat {
  const net = () => store.getState().network;
  return {
    post: (to, text) => void networkOf(session).post(to, text),
    nameOf: (to) => (to.startsWith('dm:') ? net().friends.find((f) => f.peerId === to.slice(3))?.name : to.startsWith('group:') ? net().groups.find((g) => g.id === to.slice(6))?.name : undefined),
    friends: () => net().friends,
    shares: (to, peerId) => networkOf(session).shares(to, peerId),
    tell: (peerId, note) => void networkOf(session).sendDm(peerId, note),
    me: () => store.getState().self?.name ?? net().self?.name ?? 'A friend',
  };
}

/** Your own chats, woken by a sentinel (BLG-397): yours alone. */
function wake(session: Session, store: Store): SentinelWake {
  return {
    refusal: (to) => wakeRefusal(store.getState(), to),
    deliver: async (input) => (await session.host.chatSends.deliverFromSentinel({ sentinel: input.sentinel, run: input.run, step: input.step, channel: input.to, text: input.text })).messageId,
    wait: (messageId, ms, signal) => session.host.chatSends.outcome(messageId, ms, signal),
  };
}

/** A friend's Claude through the gateway, asked as you (their trust applies). */
function friends(session: Session): SentinelFriends {
  const need = () => {
    const gw = gatewayOf(session);
    if (!gw) throw new Error('asking a friend’s agent needs the Beluga network: turn it on in Settings › Network');
    return gw;
  };
  return {
    ask: (input) => need().ask({ ...input, by: 'person' }).id,
    wait: async (id, ms) => {
      const t = await need().wait(id, Math.max(1, ms));
      return { state: t.state, final: isFinal(t.state), name: agentLabel(defaultAgentOf(session.store.getState().peers.find((p) => p.peerId === t.peerId)), t.peerName, false), ...(t.result?.summary ? { summary: t.result.summary } : {}), ...(t.result?.data !== undefined ? { data: t.result.data } : {}) };
    },
    cancel: (id) => {
      try {
        need().cancel(id);
      } catch {
        // It ended already.
      }
    },
  };
}
