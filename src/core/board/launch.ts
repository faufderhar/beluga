import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import type { DraftContext } from '../../agent/task-drafter.js';
import { buildPrPrompt, findPr } from '../../workspaces/pr.js';
import { ghHosts } from '../../workspaces/github.js';
import { GitHubIssues } from '../issues/issues.js';
import { ghIssueSource, runGhCli } from '../issues/gh.js';
import { demoIssueSource, demoRepo } from '../issues/demo.js';
import { attachIssues, detachIssues } from '../issues/registry.js';
import { GitHubCi } from '../ci/ci.js';
import { ghCiSource } from '../ci/gh.js';
import { demoCiSource } from '../ci/demo.js';
import { attachCi, detachCi } from '../ci/registry.js';
import { Board } from './board.js';
import { seedDemoBoard } from './demo.js';
import { TaskSync, attachSync, detachSync } from './sync/sync.js';
import { demoLinear } from './sync/demo.js';
import { belugaEnv } from '../beluga-env.js';
import { attachBoard, detachBoard } from './registry.js';
import { BoardWork, busyChannels } from './work.js';
import { ReviewPr } from './review-pr.js';
import { Plans } from '../plans/plans.js';
import { PlansWork } from '../plans/work.js';
import { attachPlans, detachPlans } from '../plans/registry.js';
import { seedDemoPlan } from '../plans/demo.js';
import { PlanDecisions } from '../plans/decisions.js';
import { launchTeam } from '../team/launch.js';
import { BRAKE_WINDOW_MS, TeamBoardSync } from '../team/board-sync.js';
import { TeamAssign } from '../team/assign.js';
import { TeamContext } from '../team/context-share.js';
import { TeamKnocks } from '../team/knock.js';
import { TeamPlans } from '../team/plan-share.js';
import { blackbox } from '../blackbox/recorder.js';

/**
 * Start the board and plans for the daemon (the Mac app's Beluga): tasks in ~/.beluga/board.json,
 * moved by pull requests, kept true by Claude; plans in ~/.beluga/plans.json. The demo's board lives in a temporary
 * folder and starts with tasks to show.
 */

export interface BoardHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchBoard(host: BoardHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-board-')) : belugaHome();
  // The demo's tasks are made "in the past", so their history reads like a real one.
  let back = 0;
  const board = new Board({
    store,
    dir,
    projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name,
    now: () => Date.now() - back,
  });
  const work = new BoardWork({
    store,
    board,
    ...(session.workspaces ? { controller: session.workspaces } : {}),
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'You',
    askClaude: (prompt, channel, shown) => session.askOwnClaude(prompt, channel, false, shown ?? true),
    ...(session.draftsTasks ? { draftTask: (text: string, ctx: DraftContext) => session.draftTask(text, ctx) } : {}),
    ...(session.describesProjects ? { describeProject: (dir: string, project: string) => session.describeProject(dir, project) } : {}),
    toast: (text: string) => session.toast(text, 'info'),
    // Tasks whose worktree went before their pull request merged still go Done (the demo has no GitHub).
    ...(host.demo
      ? {}
      : {
          findPr: async (dir: string, branch: string) => {
            const pr = await findPr(dir, branch);
            return pr && { number: pr.number, url: pr.url, state: pr.state, title: pr.title, draft: pr.draft, checks: pr.checks, ...(pr.review ? { review: pr.review } : {}) };
          },
        }),
  });
  attachBoard(session, work);
  // A worktree's task reaching In Review opens its draft pull request, with the setting on (BLG-927).
  const reviewPr = new ReviewPr({ store, issues: () => board.list(), openPr: (id, extra) => session.workbench?.createPr(id, extra, { auto: true }) });
  // A project's GitHub issues, handed to Claude through tasks. The demo has a pretend GitHub (acme/<project>).
  const projectOf = (id: string) => store.getState().projects.find((p) => p.id === id);
  const issues = new GitHubIssues({
    store,
    work,
    repoOf: async (id) => (host.demo ? (projectOf(id) ? demoRepo(projectOf(id)!.name) : undefined) : session.workspaces?.mainSync.githubRepo(id)),
    ...(host.demo ? {} : { knownHost: (h: string) => h === 'github.com' || ghHosts().includes(h) }),
    ghReady: async (h) => host.demo || runGhCli(['auth', 'status', '--hostname', h]).then(() => true, () => false),
    source: host.demo ? demoIssueSource() : ghIssueSource(),
    askClaude: (prompt, channel, shown) => session.askOwnClaude(prompt, channel, false, shown ?? true),
    prPrompt: (ws) => {
      const project = projectOf(ws.projectId);
      return buildPrPrompt({ branch: ws.branch ?? ws.name, base: ws.base ?? project?.base ?? 'origin/main', project: project?.name ?? '', ...(project?.scripts?.prPrompt ? { projectPrompt: project.scripts.prPrompt } : {}) });
    },
  });
  attachIssues(session, issues);
  // A project's GitHub Actions: its runs as they go, and its workflows. The demo's play out live.
  const ci = new GitHubCi({
    store,
    repoOf: async (id) => (host.demo ? (projectOf(id) ? demoRepo(projectOf(id)!.name) : undefined) : session.workspaces?.mainSync.githubRepo(id)),
    ...(host.demo ? { localFiles: false } : { knownHost: (h: string) => h === 'github.com' || ghHosts().includes(h) }),
    ghReady: async (h) => host.demo || runGhCli(['auth', 'status', '--hostname', h]).then(() => true, () => false),
    source: host.demo ? demoCiSource() : ghCiSource(runGhCli),
  });
  attachCi(session, ci);
  // Two-way sync with Linear, per project. The demo has a pretend Linear and keeps keys in memory only;
  // BELUGA_LINEAR_API points the real one at a fake Linear.
  const linearBase = belugaEnv('LINEAR_API');
  const pretend = host.demo ? demoLinear() : undefined;
  const sync = new TaskSync({ store, board, ...(pretend ? { file: null, provider: () => pretend } : {}), ...(linearBase ? { linear: { base: linearBase } } : {}) });
  attachSync(session, sync);
  sync.start();
  // Plans: drafted in a conversation, approved onto the board, run milestone by milestone.
  const plans = new Plans({ store, dir, now: () => Date.now() - back });
  // Made after the plans' work (it moves the plan along), told by its forYou hook.
  let decisions: PlanDecisions | undefined;
  const planWork = new PlansWork({
    store,
    plans,
    board: work,
    ...(session.workspaces ? { controller: session.workspaces } : {}),
    askClaude: (prompt, channel, echo, chain) => session.askForPlan(prompt, channel, echo, chain),
    intend: (intent) => session.intend(intent),
    // A task whose Claude stopped: is its process there, and taking over to wake it.
    alive: (channel) => session.host.runningIn(channel),
    takeOver: (channel) => session.host.takeOver(channel),
    // The head Claude's steered messages go in the way Steer does, and stop a long command or a dead run (yours never do: see AgentHost.rush).
    promote: (requestId) => session.host.promote(requestId, { interrupt: true }),
    // A message to a task goes on in the chain of the plan's run, under the chat-links limits.
    sendOn: (chain) => session.host.chatSends.sendOn(chain),
    // The head Claude stopping a task's Claude (plan_stop_task).
    stopRun: (channel) => void session.host.stopRun(channel),
    // A milestone check you passed past: its run stops, so nothing the plan asks next waits behind it.
    cancel: (requestId) => void session.host.cancelRun(requestId, 'Stopped by Beluga: the milestone was passed without this check'),
    titlePlan: (goal) => session.titlePlan(goal),
    // Tasks only you can do came up: their decision cards (below) go up now.
    forYou: () => decisions?.sync(true),
    // The plan's conversation runs on the agent picked for its work, switched as its own picker switches it.
    followAgent: (channel, agent) => void session.workbench?.setAgent(channel, agent, 'quiet'),
  });
  attachPlans(session, planWork);
  // A plan task that's yours: a decision card in the plan's conversation, never a worktree.
  decisions = new PlanDecisions({
    store,
    plans,
    board: work,
    questions: session.questions,
    askClaude: (prompt, channel) => void session.askOwnClaude(prompt, channel, false, false),
    schedule: () => planWork.pilot.schedule(),
  });
  // Team boards: friends on the same GitHub repository keep one board (core/team), once both say yes.
  const stopTeam = launchTeam({
    session,
    store,
    dir: host.demo ? null : dir,
    repoOf: async (id) => (host.demo ? (projectOf(id) ? demoRepo(projectOf(id)!.name) : undefined) : session.workspaces?.mainSync.githubRepo(id)),
    notify: (e) => session.notifier.notify(e),
    toast: (text, level) => session.toast(text, level),
    parts: (team) => {
      const live = (id: string): boolean => store.getState().projects.some((p) => p.workspaces.some((w) => w.id === id && !w.archived));
      const teamDir = host.demo ? null : dir;
      // Whose Claude is at work where, worked out once per log.
      let busy: { log: unknown; set: Set<string> } | undefined;
      const running = (id: string): boolean => {
        const log = store.getState().log;
        if (busy?.log !== log) busy = { log, set: busyChannels(log) };
        return busy.set.has(`ws:${id}`);
      };
      // A task going round between Macs is held by the sync's brake (BLG-942): noted in the black box, once a minute.
      let braked = 0;
      const onBrake = (id: string, sends: number): void => {
        if (Date.now() - braked < 60_000) return;
        braked = Date.now();
        blackbox.record('log', `team board: ${board.get(id)?.key ?? id} was sent on ${sends} times in ${BRAKE_WINDOW_MS / 1000} s; held, then sent whole`);
      };
      const teamSync = new TeamBoardSync(team, { board, live, running, dir: teamDir, onBrake });
      // Plans you choose to share with the team: teammates review them, you apply what you like.
      const teamPlans = new TeamPlans(team, { edit: (id, ops) => void planWork.edit(id, ops), dir: teamDir });
      // What the project is about (for Claude writing tasks): one text for the whole team.
      // Knocking on a teammate's worktree: let in, it's shared with them the friend-share way (BLG-416).
      const knocks = new TeamKnocks(team, {
        board,
        store,
        live,
        letIn: (peerId, workspaceId, role) => session.sharing.shareWithFriend({ peerId, workspaceId, role }),
        intend: (intent) => session.intend(intent),
        dir: teamDir,
      });
      return [teamSync, new TeamAssign(team, { board, sync: teamSync, dir: teamDir }), teamPlans, new TeamContext(team, board), knocks];
    },
  });
  let stopSeed = (): void => undefined;
  if (host.demo && !board.list().length) {
    stopSeed = seedDemoBoard(store, work, (ms) => (back = ms), () => void seedDemoPlan(store, planWork, work, (ms) => (back = ms)).catch(() => undefined));
  }
  return () => {
    stopSeed();
    stopTeam();
    decisions?.stop();
    detachPlans(session);
    planWork.stop();
    detachIssues(session);
    detachCi(session);
    detachSync(session);
    sync.stop();
    detachBoard(session);
    reviewPr.stop();
    work.stop();
    store.dispatch({ type: 'plans_off' });
    store.dispatch({ type: 'board_off' });
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
