import { actingVia } from '../acting-agent.js';
import type { BoardTools, TaskDefinition } from '../../agent/types.js';
import { type DraftContext, type TaskDraft, firstLineTitle } from '../../agent/task-drafter.js';
import { personMentions } from '../person-mentions.js';
import { teammatesOf } from '../team/model.js';
import { slugify } from '../../agent/namer.js';
import { isSecretPath } from '../shares.js';
import { type Action, type LogItem, type Store, busyChannels } from '../store.js';
import type { Workspace } from '../../workspaces/types.js';
import type { WorkspaceController, WorktreeEvent } from '../workspace-controller.js';
import { Board, type IssuePatch, type NewIssue } from './board.js';
import type { IssuePr } from './model.js';
import { agentLabel, agentName } from '../../shared/agent-label.js';
import { type AgentRef, defaultAgentOf } from '../../protocol.js';
import { chosenAgent } from '../settings.js';
import { needsChecksText, unexplained } from './criteria.js';
import { inSet, labelsFor } from './labels.js';
import { aboutPrompt, alongPrompt, briefPrompt, boardNote, definePrompt, describeIssue, describeList, friendNote, gitHubLine, ownTaskPrompt, reposPrompt } from './prompt.js';
import { type Actor, type Assignee, BRIEF_SECTIONS, type ExternalActor, type BriefSection, type Issue, STATUS_INFO, boardName, boardOf, childrenOf, filterIssues, isArchived, isFinished, isOpen, isOwnBoard, isStartable, issueForWorkspace, reposOf, titleFromName, worktreeDoing, worktreeOf } from './model.js';

/** How a name is written after "@" (as the message box completes it: src/ui/suggest.ts friendMention). */
const handleOf = (name: string): string => `@${name.replace(/[^\p{L}\p{N}_.-]+/gu, '')}`;

/**
 * The board at work: tasks open with worktrees and follow their pull requests, a task can start
 * its own worktree (with Claude on it), and Claude's runs get the task they're doing (its brief
 * in the prompt, tools to keep it true).
 */

export interface BoardWorkDeps {
  readonly store: Store;
  readonly board: Board;
  readonly controller?: WorkspaceController;
  readonly selfId: () => string;
  readonly selfName: () => string;
  /** Ask your Claude in a conversation (`ws:<id>`); `shown`: what the conversation shows you asked, when not the prompt itself. */
  readonly askClaude: (prompt: string, channel: string, shown?: string) => void;
  /** Your Claude writes a task from a description (none: the first line is the title). */
  readonly draftTask?: (text: string, ctx: DraftContext) => Promise<TaskDraft | undefined>;
  /** Your Claude writes what a project is about from a quick look at its folder (none: people write it). */
  readonly describeProject?: (dir: string, project: string) => Promise<string | undefined>;
  /** A quiet word on screen (what Claude wrote in the background). */
  readonly toast?: (text: string) => void;
  /** A branch's pull request, asked of gh (none: tasks whose worktree went aren't looked after). Throws when gh can't tell. */
  readonly findPr?: (dir: string, branch: string) => Promise<IssuePr | undefined>;
  /** How often to look for merged pull requests of tasks nobody watches any more (0: only when asked). */
  readonly sweepMs?: number;
}

/** Looking for shipped work: soon after start, then every ten minutes. */
const SWEEP_FIRST_MS = 30_000;
const SWEEP_MS = 10 * 60_000;

const WS = 'ws:';

export class BoardWork {
  readonly board: Board;
  /** Tasks Claude defined while planning (plan mode), by conversation: they go on the board when you approve the plan. */
  private readonly pending = new Map<string, TaskDefinition>();
  /** Tasks made by approving a plan in a main folder's chat (by that chat's workspace id): the worktree it continues in does it. */
  private readonly carried = new Map<string, string>();
  /** Projects whose About This Project your Claude was asked to write this run. */
  private readonly described = new Set<string>();
  /** Worktrees being started for tasks (Start Worktree): the one that opens under that name belongs to that task. */
  private readonly expecting: Array<{ readonly projectId: string; readonly name: string; readonly issueId: string }> = [];
  private readonly names = new Map<string, string>();
  private readonly offs: Array<() => void> = [];
  /** More for a run doing a task (the plan it's part of): see setBriefExtra. */
  private briefExtra: (issue: Issue) => string = () => '';
  /** A run's own instructions (a plan milestone's worktree): see setRunBrief. */
  private runBrief: (channel: string) => { readonly brief: string; readonly current?: Issue } | undefined = () => undefined;
  /** Tasks Claude is writing from a description (by id): starting one waits for its words. */
  private readonly drafts = new Map<string, Promise<void>>();

  constructor(private readonly deps: BoardWorkDeps) {
    this.board = deps.board;
    if (deps.controller) this.offs.push(deps.controller.onWorktree((e) => this.onWorktree(e)));
    // An epic's worktree works in its sub-tasks' worktrees in other repos too (BLG-561).
    if (deps.controller?.setAlsoIn) this.offs.push(deps.controller.setAlsoIn((id) => this.alsoIn(id).map((w) => w.path)));
    // Proof made in a worktree outlives it: kept before its folder goes (proof-files.ts).
    if (deps.controller?.onWorktreeGoing) this.offs.push(deps.controller.onWorktreeGoing((ws) => void this.board.keepProofs(ws.path)));
    // After the action that caused it has reached everyone (never inside its dispatch).
    this.offs.push(
      deps.store.onAction((a) =>
        queueMicrotask(() => {
          try {
            this.onAction(a);
          } catch {
            // A task that went away meanwhile: nothing to follow.
          }
        }),
      ),
    );
    for (const ws of this.workspaces()) this.names.set(ws.id, ws.name);
    const every = deps.sweepMs ?? SWEEP_MS;
    if (deps.findPr && every > 0) {
      const first = setTimeout(() => void this.sweepShipped(), Math.min(SWEEP_FIRST_MS, every));
      const timer = setInterval(() => void this.sweepShipped(), every);
      first.unref?.();
      timer.unref?.();
      this.offs.push(() => {
        clearTimeout(first);
        clearInterval(timer);
      });
    }
  }

  /**
   * Tasks still open whose work went out on a branch nobody watches any more (its worktree archived
   * or gone, so the workbench stopped asking about its pull request): gh is asked, and a merged one
   * makes them Done. → how many moved.
   */
  async sweepShipped(): Promise<number> {
    const find = this.deps.findPr;
    if (!find) return 0;
    const live = new Set(this.workspaces().filter((w) => !w.archived).map((w) => w.id));
    const roots = new Map(this.deps.store.getState().projects.flatMap((p) => (p.root ? [[p.id, p.root] as const] : [])));
    const waiting = new Map<string, { readonly root: string; readonly branch: string; readonly ids: string[] }>();
    for (const issue of this.board.list()) {
      const via = issue.carriedBy ?? issue.worktrees.at(-1);
      const root = roots.get(issue.projectId);
      if (!issue.branch || !root || issue.archivedAt !== undefined || (via && live.has(via))) continue;
      // Held after its merge (BLG-952): already merged, waiting on its criteria, not on gh.
      if ((issue.status !== 'in_progress' && issue.status !== 'in_review') || issue.mergedHeld) continue;
      const key = `${root}\0${issue.branch}`;
      const group = waiting.get(key) ?? { root, branch: issue.branch, ids: [] };
      group.ids.push(issue.id);
      waiting.set(key, group);
    }
    let moved = 0;
    for (const { root, branch, ids } of waiting.values()) {
      let pr: IssuePr | undefined;
      try {
        pr = await find(root, branch);
      } catch {
        continue; // gh couldn't tell this time
      }
      if (pr?.state !== 'MERGED') continue;
      for (const id of ids) {
        try {
          if (this.board.branchShipped(id, pr).status === 'done') moved++;
        } catch {
          // Deleted meanwhile.
        }
      }
    }
    return moved;
  }

  /** Something to add to the instructions of a run doing a task (Plans adds the plan it's part of). */
  setBriefExtra(fn: (issue: Issue) => string): void {
    this.briefExtra = fn;
  }

  stop(): void {
    for (const off of this.offs) off();
    this.board.flush();
  }

  me(): Actor & Assignee {
    return { kind: 'person', id: this.deps.selfId(), name: this.deps.selfName() };
  }

  /** This Mac's agent by name ("Claude", "Codex"). */
  private agent(): string {
    return agentName(defaultAgentOf(this.deps.store.getState().self));
  }

  /**
   * Who works a task (BLG-498): `agent`, or your default (null). It takes effect at the task's next
   * start; a worktree already working it keeps the agent it opened with (switching an agent mid-run
   * would lose its session). → what happened, in words, for the screen to show.
   */
  setAgent(ref: string, agent: AgentRef | null): string {
    const issue = this.board.setAgent(ref, agent ?? undefined, this.me());
    const who = agent ? agentName(agent, { model: true }) : `${this.agent()} (your default)`;
    const doing = worktreeDoing(issue, (id) => this.workspaces().some((w) => w.id === id && !w.archived));
    const ws = doing ? this.workspaces().find((w) => w.id === doing) : undefined;
    return ws ? `${ws.name} keeps the agent it started with; ${who} works ${issue.key} from its next start` : `${who} works ${issue.key} when it starts`;
  }

  /**
   * Your agent, as the board records it (BLG-498: its activity shows the real agent's mark): the
   * one picked for `channel`'s conversation (`ws:<id>`), else your default.
   */
  myClaude(channel?: string): Extract<Actor, { kind: 'claude' }> {
    return { kind: 'claude', owner: this.deps.selfId(), ownerName: this.deps.selfName(), agent: this.agentIn(channel) };
  }

  /** The agent that runs in a conversation (`ws:<id>`): its workspace's pick, else its project's agent (agentFor), else your default. */
  private agentIn(channel: string | undefined): AgentRef {
    const ws = channel?.startsWith(WS) ? this.workspaces().find((w) => w.id === channel.slice(WS.length)) : undefined;
    if (ws?.agent) return ws.agent;
    const st = this.deps.store.getState();
    const project = ws ? st.projects.find((p) => p.id === ws.projectId)?.name : undefined;
    return project && st.prefs.projectAgents?.[project] ? chosenAgent(st.prefs, project) : defaultAgentOf(st.self);
  }

  /**
   * A task from a description: on the board at once under its first line, while your Claude writes
   * its title, goal, criteria and labels (from the project's set); they fill in when it's done.
   */
  /**
   * What your Claude writes for a task described in words, without adding it yet (the phone shows
   * the draft first, then adds it with addDraft). Without your Claude: the first line as the title.
   */
  async draft(place: string, describe: string, opts: { readonly several?: boolean } = {}): Promise<TaskDraft> {
    const { projectId, board } = this.placeOf(place);
    const text = describe.trim();
    if (!text) throw new Error('Say what the task is');
    const title = firstLineTitle(text);
    const plain: TaskDraft = { title, goal: text, acceptance: [], labels: [] };
    if (!this.deps.draftTask) return plain;
    // `several` (a phone that shows them all, BLG-322): the words may ask for several tasks, an epic, and who does each.
    return (await this.deps.draftTask(text, this.draftContext(projectId, text, undefined, opts.several, board)).catch(() => undefined)) ?? plain;
  }

  /**
   * Where a task goes from a board's or a repo's id (the phone lists boards): a repo's on its own
   * board; a board of its own runs it in its first repo.
   */
  private placeOf(id: string): { readonly projectId: string; readonly board: string } {
    if (!isOwnBoard(id)) return { projectId: id, board: id };
    const repo = reposOf(this.board.state(), id)[0];
    if (!repo) throw new Error('That board covers no repo');
    return { projectId: repo, board: id };
  }

  /**
   * What the describer knows besides the words: the project's name, what it's about (BLG-298), and
   * its labels; with `several` (BLG-319), who on its team a task can be for (you first); and who
   * the words' "@mia"s are, teammates and friends (BLG-342).
   */
  private draftContext(projectId: string, text: string, look?: string, several = false, boardId = projectId): DraftContext {
    const labels = labelsFor(this.board.state(), boardId).map((l) => l.name);
    const project = this.deps.store.getState().projects.find((p) => p.id === projectId)?.name;
    const about = this.board.state().projects[boardId]?.context?.text ?? this.board.state().projects[projectId]?.context?.text;
    const people = several ? this.people(projectId).map((p) => p.name) : [];
    const named = this.named(projectId, text);
    return {
      labels,
      ...(project ? { project } : {}),
      ...(about ? { about } : {}),
      ...(look ? { look } : {}),
      ...(several ? { several, ...(people.length > 1 ? { people } : {}) } : {}),
      ...(named.length ? { named } : {}),
    };
  }

  /** The people "@" names in the words: the project's teammates, then your other friends (never you). */
  private named(projectId: string, text: string): NonNullable<DraftContext['named']> {
    if (!text.includes('@')) return [];
    const team = this.people(projectId).filter((p) => p.id !== this.deps.selfId());
    const friends = (this.deps.store.getState().network?.friends ?? []).filter((f) => f.peerId !== this.deps.selfId() && !team.some((m) => m.id === f.peerId));
    const onTeam = new Set(team.map((m) => m.id));
    return personMentions(text, [...team.map((m) => ({ peerId: m.id, name: m.name })), ...friends]).map((p) => ({ handle: handleOf(p.name), name: p.name, team: onTeam.has(p.peerId) }));
  }

  /** Who a project's task can be for: you, then its teammates (BLG-299). */
  private people(projectId: string): Assignee[] {
    const mates = teammatesOf(this.deps.store.getState().team, projectId).map((m): Assignee => ({ kind: 'person', id: m.peerId, name: m.name }));
    return [this.me(), ...mates.filter((m) => m.id !== this.deps.selfId())];
  }

  /**
   * A draft (from draft, maybe changed) added as a task: its title, goal, criteria, labels and
   * priority, for whoever it names on the team; with `more`, those too (under it when `epic`). → the first (or the epic), then the rest.
   * `agent` (BLG-498): who works them when they start (none: your default).
   */
  addDraft(place: string, d: TaskDraft, agent?: AgentRef): Issue[] {
    const { projectId, board } = this.placeOf(place);
    const who = d.epic ? undefined : this.whom(projectId, d.for);
    const first = this.board.create({ projectId, board, title: d.title, labels: d.labels, ...(d.priority ? { priority: d.priority } : {}), ...(who ? { assignee: who } : {}), ...(agent ? { agent } : {}), brief: draftBrief(d) }, this.me());
    return [first, ...this.addMore(first, agent ? { agent } : {}, d)];
  }

  /** The person a draft names, if they're on the project's team (you or a teammate). */
  private whom(projectId: string, name: string | undefined): Assignee | undefined {
    return name ? this.people(projectId).find((p) => p.name === name) : undefined;
  }

  /**
   * `look`: a folder Claude may read first (the project's main folder), so the task also says where
   * the code is and what's likely behind it; it takes a minute or two rather than seconds.
   * `several` (New Task, BLG-319): the words may ask for several tasks, or an epic with its
   * sub-tasks, and say who each is for. The first (or the epic) fills in this task; the rest are
   * added beside it (or under it), in its column, each for whoever the words gave it to.
   */
  createDescribed(input: Omit<NewIssue, 'title' | 'brief' | 'drafting'>, describe: string, opts: { readonly look?: string; readonly origin?: Issue['origin']; readonly several?: boolean } = {}): Issue {
    const text = describe.trim();
    if (!text) throw new Error('Say what the task is');
    const draft = this.deps.draftTask;
    const title = firstLineTitle(text);
    // Without your Claude: the first line, and what was said as the goal if it says more.
    if (!draft) return this.board.create({ ...input, title, ...(text.replace(/\s+/g, ' ') !== title ? { brief: { goal: text } } : {}) }, this.me(), opts.origin);
    const issue = this.board.create({ ...input, title, drafting: true }, this.me(), opts.origin);
    const done = draft(text, this.draftContext(issue.projectId, text, opts.look, opts.several, boardOf(issue)))
      .catch(() => undefined)
      .then((d) => {
        try {
          this.board.finishDraft(issue.id, d, this.myClaude(), text);
          if (d && opts.several) this.addTheRest(issue, input, d);
        } catch {
          // Deleted meanwhile.
        }
      })
      .finally(() => this.drafts.delete(issue.id));
    this.drafts.set(issue.id, done);
    return issue;
  }

  /** The tasks after the first that one New Task message asked for, and who each is for (BLG-319). */
  private addTheRest(first: Issue, input: Omit<NewIssue, 'title' | 'brief' | 'drafting'>, d: TaskDraft): void {
    const now = this.board.need(first.id);
    // Words naming someone beat the sheet's Assignee; one changed by hand meanwhile stays.
    const named = d.epic ? undefined : this.whom(now.projectId, d.for);
    if (named && now.assignee?.id === input.assignee?.id && named.id !== now.assignee?.id) this.board.update(now.id, { assignee: named }, this.me());
    const made = this.addMore(now, input, d);
    if (!made.length) return;
    const list = andList(made.map((i) => i.key));
    this.deps.toast?.(d.epic ? `${now.key} is an epic: ${this.agent()} added ${list} under it` : `${this.agent()} also made ${list}, from what you wrote`);
  }

  /** A draft's `more`: beside the first (or under it, an epic), in its column, each for whom it names. */
  private addMore(first: Issue, input: Pick<NewIssue, 'labels' | 'priority' | 'assignee' | 'parent' | 'agent'>, d: TaskDraft): Issue[] {
    return (d.more ?? []).map((m) => {
      const who = this.whom(first.projectId, m.for) ?? input.assignee;
      return this.board.create(
        {
          projectId: first.projectId,
          board: boardOf(first),
          title: m.title,
          status: first.status,
          labels: [...new Set([...(input.labels ?? []), ...m.labels])],
          ...(m.priority ? { priority: m.priority } : input.priority ? { priority: input.priority } : {}),
          ...(who ? { assignee: who } : {}),
          ...(d.epic ? { parent: first.id } : input.parent ? { parent: input.parent } : {}),
          // One New Task message, one agent for all it made.
          ...(input.agent ? { agent: input.agent } : {}),
          // Asked for as private, the rest of them are too (BLG-501).
          ...(first.private ? { private: true } : {}),
          brief: draftBrief(m),
        },
        this.me(),
      );
    });
  }

  /**
   * Start a worktree for a task (from the latest origin, or `base`), named after it, and open it;
   * with `claude`, your Claude starts on the task there with its brief. → the workspace's id.
   * The worktree runs `opts.agent`, else the task's own agent, else your default (BLG-497).
   */
  async start(ref: string, opts: { /** Who started it from another screen: an external agent, with its own label. */ readonly by?: Actor; readonly claude?: boolean; readonly base?: string; readonly quiet?: boolean; readonly agent?: AgentRef; /** What your Claude is told instead of working the task through (it implies `claude`), and the line the conversation shows for it. */ readonly prompt?: (issue: Issue, ws: Workspace) => string; readonly shown?: string } = {}): Promise<string> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    // Claude still writing it: its worktree is named after, and Claude starts with, the real words.
    await this.drafts.get(this.board.need(ref).id);
    const issue = this.board.need(ref);
    // Finished (or canceled) work starts again only deliberately: reopened (back to Ready) first.
    if (isFinished(issue.status) || issue.status === 'canceled') throw new Error(`${issue.key} is ${STATUS_INFO[issue.status].label.toLowerCase()}: reopen it to start it again`);
    if (isArchived(issue)) throw new Error(`${issue.key} is in the Archive: restore it to start it`);
    // One worktree per task at a time: its own, or another carrying its work, is where to go.
    const doing = worktreeDoing(issue, (id) => this.workspaces().some((w) => w.id === id && !w.archived));
    const live = doing ? this.workspaces().find((w) => w.id === doing) : undefined;
    if (live) throw new Error(`${issue.key} is already being worked on in ${live.name}: open it there`);
    const name = slugify(`${issue.key} ${issue.title}`).slice(0, 48) || issue.key.toLowerCase();
    const ticket = { projectId: issue.projectId, name, issueId: issue.id };
    this.expecting.push(ticket);
    let ws: Workspace | undefined;
    try {
      const agent = opts.agent ?? issue.agent;
      ws = await controller.newWorktree(issue.projectId, name, { ...(opts.base ? { base: opts.base } : {}), ...(opts.quiet ? { quiet: true } : {}), ...(agent ? { agent } : {}) });
    } finally {
      const at = this.expecting.indexOf(ticket);
      if (at >= 0) this.expecting.splice(at, 1);
    }
    if (!ws) throw new Error('Couldn’t create the worktree');
    this.noteAgentStarted(ws.id);
    // (Linked as it opened; started here in case the event came from elsewhere.)
    if (!this.board.need(issue.id).worktrees.includes(ws.id)) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, opts.by ?? this.me());
    const now = this.board.need(issue.id);
    const patch: IssuePatch = {
      ...(now.status === 'backlog' || now.status === 'todo' ? { status: 'in_progress' as const } : {}),
      // You took it on (when it was nobody's): it's yours. Someone else's stays theirs; that you work on it shows on its own.
      // A plan's task stays no one's: the plan's Claude does it (one given to a person waits for them).
      ...((opts.claude || opts.prompt) && !now.assignee && !now.plan ? { assignee: this.me() } : {}),
    };
    if (Object.keys(patch).length) this.board.update(issue.id, patch, opts.by ?? this.me());
    // An epic whose sub-tasks run in other repos: a worktree in each, and this one's Claude works in all of them.
    const along = await this.startAlong(this.board.need(issue.id), name, opts.agent ?? issue.agent);
    if (opts.prompt) this.deps.askClaude(opts.prompt(this.board.need(issue.id), ws), `${WS}${ws.id}`, opts.shown);
    else if (opts.claude) this.deps.askClaude(startPrompt(this.board.need(issue.id), along.map((w) => this.repoName(w.projectId) ?? w.name)), `${WS}${ws.id}`);
    return ws.id;
  }

  /** A worktree an external agent's call opened stays that agent's, so what a plan asks there later keeps its level. */
  private noteAgentStarted(worktree: string): void {
    const via = actingVia();
    if (via) this.deps.controller?.manager.setStartedBy(worktree, { id: via.id, name: via.name });
  }

  /**
   * An epic across repos (BLG-561): for each other repo its unfinished sub-tasks run in, a worktree
   * there under the same name (quietly), linked to those sub-tasks, so its pull request moves them.
   * The epic's worktree works in them too (`alsoIn`). A repo whose worktree can't be made is said
   * and left out. → the worktrees made.
   */
  private async startAlong(epic: Issue, name: string, agent: AgentRef | undefined): Promise<Workspace[]> {
    const controller = this.deps.controller!;
    const live = (id: string): boolean => this.workspaces().some((w) => w.id === id && !w.archived);
    const kids = childrenOf(this.board.state(), epic).filter((k) => k.projectId !== epic.projectId && isStartable(k) && !worktreeDoing(k, live));
    const made: Workspace[] = [];
    for (const repo of [...new Set(kids.map((k) => k.projectId))]) {
      const [first, ...rest] = kids.filter((k) => k.projectId === repo);
      const ticket = { projectId: repo, name, issueId: first!.id };
      this.expecting.push(ticket);
      let ws: Workspace | undefined;
      try {
        ws = await controller.newWorktree(repo, name, { quiet: true, ...(agent ? { agent } : {}) });
      } catch (err) {
        this.deps.toast?.(`Couldn’t make ${epic.key}’s worktree in ${this.repoName(repo) ?? 'its repo'}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        const at = this.expecting.indexOf(ticket);
        if (at >= 0) this.expecting.splice(at, 1);
      }
      if (!ws) continue;
      if (this.board.need(first!.id).worktrees.at(-1) !== ws.id) this.board.linkWorktree(first!.id, ws.id, { branch: ws.branch, name: ws.name }, this.me());
      for (const kid of rest) this.linkShared(kid.id, ws);
      for (const kid of [first!, ...rest]) if (kid.status === 'backlog' || kid.status === 'todo') this.board.update(kid.id, { status: 'in_progress' }, this.me());
      made.push(ws);
    }
    return made;
  }

  /** What a run in an epic's worktree is told about its other repos' worktrees (BLG-561). */
  private alongNote(workspaceId: string, epic: Issue): string {
    const kids = childrenOf(this.board.state(), epic);
    return alongPrompt(
      epic.key,
      this.alsoIn(workspaceId).map((w) => ({ repo: this.repoName(w.projectId) ?? w.name, path: w.path, ...(w.branch ? { branch: w.branch } : {}), keys: kids.filter((k) => worktreeOf(k) === w.id).map((k) => k.key) })),
    );
  }

  /**
   * The other worktrees a worktree works in too (BLG-561): it does an epic, and these do its
   * unfinished sub-tasks in other repos.
   */
  alsoIn(workspaceId: string): Workspace[] {
    const state = this.board.state();
    const epic = issueForWorkspace(state, workspaceId);
    if (!epic || epic.worktrees.at(-1) !== workspaceId) return [];
    const theirs = new Set(childrenOf(state, epic).filter((k) => k.projectId !== epic.projectId && isOpen(k.status)).map(worktreeOf));
    return this.workspaces().filter((w) => w.id !== workspaceId && !w.archived && w.kind === 'worktree' && theirs.has(w.id));
  }

  /**
   * One worktree for several tasks (a plan milestone's one Claude does them in order): named
   * `name`, from the latest origin or `base`, linked to every task (the first goes In Progress,
   * all are your Claude's). Nobody is asked anything: the caller sends the brief. → the workspace.
   * `agent`: the agent it runs (a plan's own, BLG-497); none: your default.
   */
  async startShared(refs: readonly string[], name: string, opts: { readonly base?: string; readonly quiet?: boolean; readonly agent?: AgentRef } = {}): Promise<Workspace> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    if (!refs.length) throw new Error('No tasks to start');
    for (const ref of refs) await this.drafts.get(this.board.need(ref).id);
    const issues = refs.map((ref) => this.board.need(ref));
    for (const issue of issues) if (isFinished(issue.status)) throw new Error(`${issue.key} is ${STATUS_INFO[issue.status].label.toLowerCase()}: reopen it to start it again`);
    const first = issues[0]!;
    const slug = slugify(name).slice(0, 48) || first.key.toLowerCase();
    const ticket = { projectId: first.projectId, name: slug, issueId: first.id };
    this.expecting.push(ticket);
    let ws: Workspace | undefined;
    try {
      ws = await controller.newWorktree(first.projectId, slug, { ...(opts.base ? { base: opts.base } : {}), ...(opts.quiet ? { quiet: true } : {}), ...(opts.agent ? { agent: opts.agent } : {}) });
    } finally {
      const at = this.expecting.indexOf(ticket);
      if (at >= 0) this.expecting.splice(at, 1);
    }
    if (!ws) throw new Error('Couldn’t create the worktree');
    this.noteAgentStarted(ws.id);
    for (const issue of issues) this.linkShared(issue.id, ws);
    const now = this.board.need(first.id);
    if (now.status === 'backlog' || now.status === 'todo') this.board.update(first.id, { status: 'in_progress' }, this.me());
    return ws;
  }

  /** One more task for a worktree that does several (a milestone's Claude): linked, the others kept. */
  linkShared(ref: string, ws: Pick<Workspace, 'id' | 'branch' | 'name'>): Issue {
    const issue = this.board.need(ref);
    if (!issue.worktrees.includes(ws.id) || issue.worktrees.at(-1) !== ws.id) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name, shared: true }, this.me());
    return this.board.need(issue.id);
  }

  /** Instructions of their own for a run (a plan milestone's worktree): instead of the one task's brief. */
  setRunBrief(fn: (channel: string) => { readonly brief: string; readonly current?: Issue } | undefined): void {
    this.runBrief = fn;
  }

  /**
   * What one of Claude's runs gets: the task it's doing (in its prompt) and the task tools (your
   * own runs, and a friend's you let use the board: `friend`). Planning (plan mode), Claude defines
   * the task the plan is for; it goes on the board when you approve the plan (`planApproved`), never before.
   */
  forRun(channel: string, from: string, opts: { readonly plan?: boolean; readonly friend?: BoardFriend } = {}): RunBoard | undefined {
    if (from !== this.deps.selfId()) return opts.friend?.id === from ? this.forFriend(channel, opts.friend) : undefined;
    const own = opts.plan ? undefined : this.runBrief(channel);
    const issue = own ? own.current : channel.startsWith(WS) ? issueForWorkspace(this.board.state(), channel.slice(WS.length)) : undefined;
    const tools = this.toolsFor(channel, issue, Boolean(opts.plan));
    const parallel = this.parallelNote(channel, issue);
    const projectId = this.runProject(channel, issue);
    const boardId = issue ? boardOf(issue) : projectId;
    const about = projectId ? aboutPrompt(this.board.state(), projectId, boardId) : '';
    // A board of several repos: where its tasks go, so a task made here lands in the right one.
    const repos = projectId && boardId ? reposPrompt(this.board.state(), boardId, projectId, this.repoName) : '';
    const along = channel.startsWith(WS) && issue ? this.alongNote(channel.slice(WS.length), issue) : '';
    const decide = !own && !issue && !opts.plan && this.mayOpenOwnTask(channel) ? ownTaskPrompt() : '';
    const brief = (own ? own.brief : issue ? briefPrompt(this.board.state(), issue) + this.briefExtra(issue) : boardNote() + decide) + repos + along + about + parallel + (opts.plan ? definePrompt(Boolean(issue)) : '');
    if (!opts.plan) return { tools, brief };
    this.pending.delete(channel);
    return {
      tools,
      brief,
      // Asked once per run: a plan without its task defined goes back to Claude to define it first.
      needsDefinition: () => !this.pending.has(channel) && !issue,
      planApproved: () => this.applyDefinition(channel),
    };
  }

  /**
   * A friend's run (BLG-701): the board of the repo it works in, and nothing else. No task to
   * define (that's yours), no new boards, nobody's private tasks; what it changes shows in the
   * activity as your Claude's, for them.
   */
  private forFriend(channel: string, friend: BoardFriend, projectOf?: string): RunBoard | undefined {
    const issue = channel.startsWith(WS) ? issueForWorkspace(this.board.state(), channel.slice(WS.length)) : undefined;
    const projectId = projectOf ?? this.runProject(channel, issue);
    if (!projectId) return undefined;
    const boardId = issue ? boardOf(issue) : projectId;
    const home = { projectId, boardId, friend };
    const tools = this.toolsFor(channel, issue, false, home);
    const brief = (issue ? briefPrompt(this.board.state(), issue) : boardNote()) + friendNote(friend.name) + aboutPrompt(this.board.state(), projectId, boardId);
    return { tools, brief };
  }

  /** A friend's request by name of one of your projects (core/gateway): that repo's board, as in forFriend. */
  forFriendIn(project: string, friend: BoardFriend): RunBoard | undefined {
    const id = this.deps.store.getState().projects.find((p) => p.name === project)?.id;
    return id ? this.forFriend('', friend, id) : undefined;
  }

  /** The task a plan was for, on the board now (you approved the plan). */
  private applyDefinition(channel: string): void {
    const def = this.pending.get(channel);
    if (!def) return;
    this.pending.delete(channel);
    try {
      this.define(channel, def, issueForWorkspaceOf(this.board, channel));
    } catch {
      // The project went away meanwhile: nothing to put it on.
    }
  }

  /**
   * Make (or rewrite) the task a conversation is doing from Claude's definition. One Claude opens
   * on its own (not an approved plan) is private until you share it (BLG-683).
   */
  private define(channel: string, def: TaskDefinition, current: Issue | undefined, opts: { readonly private?: boolean } = {}): Issue {
    const by: Actor = this.myClaude(channel);
    const wsId = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
    const ws = wsId ? this.workspaces().find((w) => w.id === wsId) : undefined;
    const projectId = current?.projectId ?? ws?.projectId;
    if (!projectId || !this.deps.store.getState().projects.some((p) => p.id === projectId && p.root)) throw new Error('This conversation isn’t in a project, so its task has nowhere to go');
    const sections: Array<[BriefSection, string | undefined]> = [
      ['goal', def.goal],
      ['context', def.context],
      ['acceptance', checklistOf(def.acceptance)],
      ['decisions', listOf(def.decisions)],
      ['questions', listOf(def.questions)],
    ];
    const inWorktree = ws?.kind === 'worktree' && !ws.askOnly;
    let issue = current;
    if (!issue) {
      issue = this.board.create(
        {
          projectId,
          title: def.title,
          status: inWorktree ? 'in_progress' : 'todo',
          assignee: this.me(),
          ...(def.priority ? { priority: def.priority } : {}),
          ...(def.estimate ? { estimate: def.estimate } : {}),
          ...(def.labels?.length ? { labels: def.labels } : {}),
          ...(opts.private ? { private: true } : {}),
          brief: Object.fromEntries(sections.filter(([, v]) => v?.trim())),
        },
        by,
        'claude',
      );
      if (inWorktree) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, by);
      else if (wsId) this.carried.set(wsId, issue.id);
      return this.board.need(issue.id);
    }
    this.board.update(issue.id, { title: def.title, ...(def.priority ? { priority: def.priority } : {}), ...(def.estimate ? { estimate: def.estimate } : {}), ...(def.labels ? { labels: def.labels } : {}) }, by);
    for (const [section, text] of sections) if (text?.trim()) this.board.editBrief(issue.id, section, text, by, { reason: 'the plan' });
    return this.board.need(issue.id);
  }

  /** With a task per worktree on (BLG-683): a run in a worktree of a project here, doing no task, may open its own. */
  private mayOpenOwnTask(channel: string): boolean {
    if (!this.board.autoTasksOn || !channel.startsWith(WS)) return false;
    const ws = this.workspaces().find((w) => w.id === channel.slice(WS.length));
    return ws?.kind === 'worktree' && !ws.askOnly && this.deps.store.getState().projects.some((p) => p.id === ws.projectId && p.root);
  }

  /** The project a run is in: its task's, or its worktree's. */
  private runProject(channel: string, current: Issue | undefined): string | undefined {
    const wsId = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
    return current?.projectId ?? (wsId ? this.workspaces().find((w) => w.id === wsId)?.projectId : undefined);
  }

  /** Other tasks being worked on in this project right now: so Claudes working side by side know about each other. */
  private parallelNote(channel: string, current: Issue | undefined): string {
    const projectId = this.runProject(channel, current);
    if (!projectId) return '';
    const state = this.deps.store.getState();
    const busy = busyChannels(state.log);
    const others = this.board
      .list()
      .filter((i) => i.projectId === projectId && i.id !== current?.id && (i.status === 'in_progress' || i.status === 'in_review'))
      .flatMap((i) => {
        const w = i.worktrees.at(-1);
        const place = w ? this.workspaces().find((x) => x.id === w && !x.archived) : undefined;
        return place ? [{ issue: i, place, working: busy.has(`${WS}${place.id}`) }] : [];
      })
      .slice(0, 12);
    if (!others.length) return '';
    return [
      '',
      'Being worked on in this project right now, in other worktrees (coordinate: don’t redo their work, and leave a task_note on theirs if you must touch what they own):',
      ...others.map(({ issue, place, working }) => `- ${issue.key} “${issue.title}” (${issue.status === 'in_review' ? 'in review' : 'in progress'}) in worktree ${place.name}${place.branch ? ` on ${place.branch}` : ''}${working ? ', its agent is working now' : ''}`),
    ].join('\n');
  }

  // ------------------------------------------------------------------ following worktrees

  private onWorktree(event: WorktreeEvent): void {
    switch (event.kind) {
      case 'created':
        return this.opened(event.ws, event.from);
      case 'merged':
        return this.board.worktreeMerged(event.id);
      case 'archived':
        this.board.keepProofs();
        return this.board.worktreeGone(event.id, true, 'archived');
      case 'removed':
        this.board.keepProofs();
        return this.board.worktreeGone(event.id, true, 'deleted');
      case 'restored':
        return this.board.worktreeGone(event.id, false, 'restored');
    }
  }

  private opened(ws: Workspace, from: string | undefined): void {
    this.names.set(ws.id, ws.name);
    if (ws.kind !== 'worktree') return;
    void this.describeOnce(ws.projectId);
    const state = this.board.state();
    const linked = (id: string): Issue | undefined => issueForWorkspace(state, id);
    const beluga: Actor = { kind: 'beluga' };
    // Started from a task: the worktree opened under its name (perhaps with "-2" when taken).
    const at = this.expecting.findIndex((e) => e.projectId === ws.projectId && (ws.name === e.name || ws.name.startsWith(`${e.name}-`)));
    if (at >= 0) {
      const [expected] = this.expecting.splice(at, 1);
      this.board.linkWorktree(expected!.issueId, ws.id, { branch: ws.branch, name: ws.name }, this.me());
      return;
    }
    // A fork, or a conversation carried on: the same task, in its new worktree (also one approved in a main folder's chat).
    const carried = from ? this.carried.get(from) : undefined;
    const source = from ? (linked(from) ?? (carried ? this.board.get(carried) : undefined)) : undefined;
    if (source) {
      if (carried) this.carried.delete(from!);
      this.board.linkWorktree(source.id, ws.id, { branch: ws.branch, name: ws.name }, beluga);
      if (source.status === 'todo' || source.status === 'backlog') this.board.update(source.id, { status: 'in_progress' }, beluga);
    }
    // Otherwise no task yet: with a task per worktree on, its Claude decides whether the work is one (ownTaskPrompt, BLG-683).
  }

  /**
   * A project's first worktree here, and no one has written what it's about (BLG-298): your Claude
   * takes a quick look at its folder in the background and writes it. Never over one someone
   * wrote or cleared (a teammate's arriving meanwhile wins), and tried once per project per run.
   */
  async describeOnce(projectId: string): Promise<void> {
    const describe = this.deps.describeProject;
    if (!describe || this.described.has(projectId) || this.board.state().projects[projectId]?.context) return;
    const project = this.deps.store.getState().projects.find((p) => p.id === projectId && p.root);
    if (!project) return;
    this.described.add(projectId);
    const text = await describe(project.root, project.name).catch(() => undefined);
    if (!text || this.board.state().projects[projectId]?.context) return;
    try {
      this.board.setContext(projectId, text, agentLabel(defaultAgentOf(this.deps.store.getState().self), this.deps.selfName(), false));
    } catch {
      return; // The project went meanwhile.
    }
    this.deps.toast?.(`${this.agent()} wrote what ${project.name} is about: Tasks › ⋯ › About This Project`);
  }

  private onAction(action: Action): void {
    switch (action.type) {
      case 'pr':
        this.board.prChanged(action.id, action.pr);
        return;
      case 'system':
        // Continue After Merge's divider: the worktree's task carries on past its merged PR.
        if (action.shipped && action.channel?.startsWith(WS)) this.board.continuedAfterMerge(action.channel.slice(WS.length), action.shipped.number);
        return;
      case 'projects':
        this.renamed();
        return;
      default:
        return;
    }
  }

  /** Worktrees renamed (a small model named them): tasks titled after them follow. */
  private renamed(): void {
    for (const ws of this.workspaces()) {
      const before = this.names.get(ws.id);
      this.names.set(ws.id, ws.name);
      if (before === undefined || before === ws.name) continue;
      const issue = issueForWorkspace(this.board.state(), ws.id);
      if (issue?.autoTitle) this.board.retitle(issue.id, titleFromName(ws.name));
    }
  }

  /** This conversation's worktree carries a task Claude moved along here (when the task has no worktree of its own still there). */
  private carryHere(channel: string, issueId: string): void {
    const ws = channel.startsWith(WS) ? this.workspaces().find((w) => w.id === channel.slice(WS.length)) : undefined;
    if (ws?.kind !== 'worktree') return;
    this.board.carry(issueId, ws, (id) => this.workspaces().some((w) => w.id === id && !w.archived));
  }

  /** A repo's (project's) name, if it's here. */
  private readonly repoName = (projectId: string): string | undefined => this.deps.store.getState().projects.find((p) => p.id === projectId)?.name;

  private workspaces(): Workspace[] {
    return this.deps.store.getState().projects.flatMap((p) => p.workspaces);
  }

  // ------------------------------------------------------------------ Claude's tools

  /**
   * An external agent's task tools: its name in the history, and it sees only tasks in `visible`
   * repos. A private task is the user's alone, so an agent never sees one.
   */
  toolsForAgent(agent: ExternalActor, visible: (projectId: string) => boolean): BoardTools {
    return this.toolsFor('external', undefined, false, undefined, { by: this.agentActor(agent), name: agent.name, visible: (i) => !i.private && visible(i.projectId) });
  }

  /** An external agent as the board and plans record it. */
  agentActor(agent: ExternalActor): Actor {
    return { kind: 'claude', owner: this.deps.selfId(), ownerName: this.deps.selfName(), agent: this.agentIn(undefined), external: agent };
  }

  private toolsFor(channel: string, current: Issue | undefined, planning = false, home?: FriendHome, external?: { readonly by: Actor; readonly name: string; readonly visible: (issue: Issue) => boolean }): BoardTools {
    const board = this.board;
    const by = (): Actor => external?.by ?? (home ? { ...this.myClaude(channel), for: { id: home.friend.id, name: home.friend.name.slice(0, 64) } } : this.myClaude(channel));
    const state = (): ReturnType<Board['state']> => board.state();
    // A friend's run (BLG-701) reaches its repo's board only, and never a private task.
    const reachable = (issue: Issue): boolean => !home || (!issue.private && (boardOf(issue) === home.boardId || issue.projectId === home.projectId));
    const onlyHome = (what: string): never => {
      throw new Error(`${home?.friend.name ?? 'They'} may only use this repo's board through you: ${what}`);
    };
    const pick = (key: string | undefined): Issue => {
      const issue = key ? board.need(key) : current ? board.need(current.id) : undefined;
      if (!issue) throw new Error('Name a task (its key, like BOB-12): this conversation isn’t doing one');
      if (!reachable(issue)) onlyHome(`${issue.key} isn't on it`);
      return issue;
    };
    const wsProject = (): string | undefined => {
      const id = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
      return id ? this.workspaces().find((w) => w.id === id)?.projectId : undefined;
    };
    const projectByName = (name: string): string => {
      const p = this.deps.store.getState().projects.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
      if (!p) throw new Error(`There's no repo called ${name}`);
      return p.id;
    };
    /** A board by its name (a repo's board goes by the repo's) or its key prefix. */
    const boardByName = (name: string): string | undefined => {
      const want = name.trim().toLowerCase();
      const ids = Object.keys(state().projects);
      return ids.find((id) => boardName(state(), id, this.repoName).toLowerCase() === want) ?? ids.find((id) => state().projects[id]!.prefix.toLowerCase() === want);
    };
    const named = (repo: string | undefined): string => this.repoName(repo ?? '') ?? 'its repo';
    // Labels come from the board's set: what wasn't in it is said, with the set, so Claude picks again.
    const leftOut = (boardId: string, wanted: readonly string[] | undefined, had: readonly string[] = []): string => {
      const set = labelsFor(state(), boardId);
      const { unknown } = inSet(set, wanted ?? []);
      const dropped = unknown.filter((l) => !had.includes(l));
      return dropped.length ? `. Left out ${dropped.join(', ')}: labels come from the board's set (${set.map((l) => l.name).join(', ')}); people add new ones` : '';
    };
    // A task is for a person (BLG-278): "claude" (an older tool call) means the user's.
    const assign = (to: 'me' | 'claude' | 'nobody' | undefined): Assignee | null | undefined => (to === 'me' || to === 'claude' ? this.me() : to === 'nobody' ? null : undefined);
    const where = (issue: Issue): string | undefined => {
      const w = issue.worktrees.at(-1);
      const place = w ? this.workspaces().find((x) => x.id === w && !x.archived) : undefined;
      if (!place) return undefined;
      const working = busyChannels(this.deps.store.getState().log).has(`${WS}${place.id}`);
      return `worktree ${place.name}${place.branch ? ` (${place.branch})` : ''}${`${WS}${place.id}` === channel ? ', this conversation' : working ? ', its agent is working there now' : ''}`;
    };
    return {
      ...(current ? { current: current.key } : {}),
      define: (def) => {
        if (home) onlyHome('defining this conversation’s own task is the owner’s; open one with task_create');
        if (planning) {
          this.pending.set(channel, def);
          return `Saved “${def.title}”: it becomes ${current ? `the new brief of ${current.key}` : 'this work’s task in Tasks'} when the user approves your plan. Call ExitPlanMode now.`;
        }
        if (current) return `${this.define(channel, def, current).key} “${def.title}” is defined`;
        const issue = this.define(channel, def, undefined, { private: true });
        const which = issue.worktrees.length ? 'this worktree’s task' : 'a task for this work';
        return `Opened ${issue.key} “${issue.title}”, ${which}: private (only the user sees it, until they Share with Team) and assigned to them. Tell the user you opened it and that it’s private: \`task:${issue.key}\`.`;
      },
      get: (key) => {
        const issue = pick(key);
        const at = where(issue);
        return describeIssue(state(), issue, this.deps.selfId(), this.repoName) + (at ? `\n\nBeing worked on in ${at}.` : '');
      },
      list: (f) => {
        // open (the default): every unfinished task; mine: yours and your Claude's; all: recently finished too.
        // A board named: its tasks; a repo named: those running in it and on its board. Neither: this
        // task's board and this repo's tasks (a board may cover several repos, a repo be on several boards).
        const asBoard = f.project ? boardByName(f.project) : undefined;
        const repo = f.project ? (asBoard ? undefined : projectByName(f.project)) : (current?.projectId ?? wsProject());
        const onBoard = asBoard ?? (f.project ? repo : current ? boardOf(current) : repo);
        if (home && f.project && onBoard !== home.boardId && repo !== home.projectId) onlyHome(`not ${f.project}'s`);
        const found = filterIssues(state(), {
          scope: f.scope === 'mine' ? 'mine' : 'all',
          selfId: this.deps.selfId(),
          ...(f.query ? { query: f.query } : {}),
        })
          .filter((i) => (!onBoard && !repo) || boardOf(i) === onBoard || (repo !== undefined && i.projectId === repo))
          .filter(reachable)
          .filter((i) => external?.visible(i) ?? true);
        return describeList(f.scope === 'all' || f.scope === 'mine' ? found : found.filter((i) => isOpen(i.status)), state(), this.repoName);
      },
      create: (input) => {
        const parent = input.parent ? pick(input.parent) : undefined;
        const boardId = input.board ? boardByName(input.board) : undefined;
        if (input.board && !boardId) throw new Error(`There's no board called ${input.board}`);
        const projectId = input.project ? projectByName(input.project) : (parent?.projectId ?? current?.projectId ?? wsProject() ?? (boardId ? reposOf(state(), boardId)[0] : undefined));
        if (!projectId) throw new Error('Say which repo it runs in (project: its name)');
        if (home && (projectId !== home.projectId || (boardId !== undefined && boardId !== home.boardId))) onlyHome('a task for another repo or board');
        if (home && input.private) onlyHome('a private task is only the owner’s');
        if (home) input.blockedBy?.forEach(pick);
        // On this task's board when it covers the repo (a sub-task goes on its parent's), else the repo's own.
        const onBoard = boardId ?? (parent ? boardOf(parent) : current && reposOf(state(), boardOf(current)).includes(projectId) ? boardOf(current) : undefined);
        const covered = onBoard ? reposOf(state(), onBoard).includes(projectId) : true;
        const brief: Partial<Record<BriefSection, string>> = {
          ...(input.goal ? { goal: input.goal } : {}),
          ...(input.acceptance ? { acceptance: checklistOf(input.acceptance) } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.decisions ? { decisions: input.decisions } : {}),
          ...(input.questions ? { questions: input.questions } : {}),
        };
        const issue = board.create(
          {
            projectId,
            ...(onBoard ? { board: onBoard } : {}),
            title: input.title,
            status: input.status ?? 'todo',
            ...(input.priority ? { priority: input.priority } : {}),
            ...(input.estimate ? { estimate: input.estimate } : {}),
            ...(input.labels ? { labels: input.labels } : {}),
            ...(input.parent ? { parent: input.parent } : {}),
            ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
            ...(input.private ? { private: true } : {}),
            brief,
          },
          by(),
          'claude',
        );
        const repos = reposOf(state(), boardOf(issue));
        const where = repos.length > 1 ? ` on ${boardName(state(), boardOf(issue), this.repoName)}, running in ${named(issue.projectId)}${covered ? '' : ` (the board covers ${named(issue.projectId)} from now on)`}` : '';
        return `Created ${issue.key}: ${issue.title} (${issue.status}${issue.private ? ', private: only the user sees it' : ''})${where}${leftOut(boardOf(issue), input.labels)}`;
      },
      start: async (key) => {
        // Starting work runs an agent on this Mac: your own runs only, never a friend's or an outside agent's.
        if (home) onlyHome('starting work is the owner’s: ask them to Start it');
        if (external) throw new Error('Starting a task is for the owner’s own agent: ask them to Start it');
        const issue = pick(key);
        const wsId = await this.start(issue.id, { claude: true, by: by() });
        const started = this.workspaces().find((w) => w.id === wsId);
        const repos = reposOf(state(), boardOf(issue));
        const inRepo = repos.length > 1 || issue.projectId !== wsProject() ? ` in ${named(issue.projectId)}` : '';
        return `Started ${issue.key} in the worktree "${started?.name ?? wsId}"${inRepo}: its agent is working it from its brief now. Name both in your answer: \`task:${issue.key}\` and \`worktree:${wsId}\`.`;
      },
      createBoard: (input) => {
        if (home) onlyHome('making a new board is the owner’s');
        const repos = [...new Set(input.repos.map(projectByName))];
        const taken = boardByName(input.name);
        if (taken && isOwnBoard(taken)) throw new Error(`There's already a board called ${boardName(state(), taken, this.repoName)}: put tasks on it with task_create (board: its name), or pick another name`);
        const id = board.createBoard({ name: input.name, repos, ...(input.prefix ? { prefix: input.prefix } : {}) });
        const made = state().projects[id]!;
        this.deps.toast?.(`${external?.name ?? this.agent()} made the ${made.name} board: Tasks › the board switcher`);
        return `Made the board "${made.name}" (keys ${made.prefix}-…), covering ${repos.map(named).join(', ')}. Put tasks on it with task_create (board: "${made.name}"), each with project: the repo it runs in. Name it in your answer for the user.`;
      },
      update: (key, patch) => {
        const issue = pick(key);
        const assignee = assign(patch.assign);
        // To review only when every criterion is ticked or explained: its Claude is told which aren't.
        const open = patch.status === 'in_review' && issue.status !== 'in_review' ? unexplained(issue.brief.acceptance) : [];
        if (open.length) {
          board.holdForChecks(issue.id);
          throw new Error(needsChecksText(issue.key, open));
        }
        // Moved along from a worktree that isn't doing it: that worktree's pull request ships it (see Board.carry).
        if (patch.status === 'in_progress' || patch.status === 'in_review') this.carryHere(channel, issue.id);
        const repo = patch.project ? projectByName(patch.project) : undefined;
        if (home && repo && repo !== home.projectId) onlyHome('moving a task to another repo');
        const next = board.update(issue.id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.priority ? { priority: patch.priority } : {}), ...(patch.labels ? { labels: patch.labels } : {}), ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}), ...(assignee !== undefined ? { assignee } : {}), ...(repo ? { projectId: repo } : {}) }, by());
        return `${next.key} is now: ${next.title} · ${next.status} · priority ${next.priority}${next.estimate ? ` · ${next.estimate} points` : ''}${next.labels.length ? ` · labels ${next.labels.join(', ')}` : ''}${repo ? ` · runs in ${named(next.projectId)}` : ''}${leftOut(boardOf(next), patch.labels, issue.labels)}`;
      },
      editBrief: (key, section, content, reason, mode) => {
        if (!BRIEF_SECTIONS.includes(section)) throw new Error(`Sections: ${BRIEF_SECTIONS.join(', ')}`);
        const next = board.editBrief(pick(key).id, section, content, by(), { reason, mode });
        return `Updated the ${section} of ${next.key}`;
      },
      note: (key, text) => `Noted on ${board.comment(pick(key).id, text, by()).key}`,
      relate: (key, relation, other, remove) => {
        if (home) pick(other);
        const next = board.relate(pick(key).id, relation, other, !remove, by());
        return `${next.key} ${remove ? 'no longer' : 'now'} ${relation === 'blocked_by' ? 'waits on' : relation === 'blocks' ? 'blocks' : 'relates to'} ${board.need(other).key}`;
      },
      attachProof: (key, proof) => {
        // Secrets are never proof (boards are shared with friends later).
        if (proof.path && isSecretPath(proof.path)) throw new Error('That file holds secrets: it can’t be attached');
        const next = board.addProof(pick(key).id, proof, by());
        return `Attached “${proof.title}” to ${next.key}`;
      },
    };
  }
}

/** A friend whose run may use the board (BLG-701): who they are, for the activity. */
export interface BoardFriend {
  readonly id: string;
  readonly name: string;
}

/** Where a friend's run may reach: the repo it works in and that repo's board. */
interface FriendHome {
  readonly projectId: string;
  readonly boardId: string;
  readonly friend: BoardFriend;
}

/** What a run gets from the board (see BoardWork.forRun). */
export interface RunBoard {
  readonly tools?: BoardTools;
  readonly brief?: string;
  /** Planning: whether the plan's task still has to be defined (before Claude asks you to approve the plan). */
  readonly needsDefinition?: () => boolean;
  /** Planning: you approved the plan; its task goes on the board. */
  readonly planApproved?: () => void;
}

export { busyChannels };

const issueForWorkspaceOf = (board: Board, channel: string): Issue | undefined => (channel.startsWith(WS) ? issueForWorkspace(board.state(), channel.slice(WS.length)) : undefined);

/** A checklist from lines or text ("- [ ] …" each; ticks kept). */
export function checklistOf(input: string | readonly string[] | undefined): string | undefined {
  const items = (typeof input === 'string' ? input.split('\n') : [...(input ?? [])]).map((l) => l.trim()).filter(Boolean);
  if (!items.length) return undefined;
  return items.map((l) => (/^[-*]\s+\[[ xX]\]/.test(l) ? l : `- [ ] ${l.replace(/^[-*]\s+/, '')}`)).join('\n');
}

const listOf = (input: string | readonly string[] | undefined): string | undefined => {
  if (typeof input === 'string') return input.trim() || undefined;
  const items = [...(input ?? [])].map((l) => l.trim()).filter(Boolean);
  return items.length ? items.map((l) => (/^[-*]\s/.test(l) ? l : `- ${l}`)).join('\n') : undefined;
};

/** What Claude is told when a task starts its worktree with Claude on it (`along`: the other repos an epic's worktrees were made in). */
export function startPrompt(issue: Issue, along: readonly string[] = []): string {
  const lines = [`Work on ${issue.key}: ${issue.title}.`, `You're working on ${issue.key} in this worktree, on your own: carry it through to done.`];
  if (along.length) lines.push(`Its sub-tasks run in ${andList(along)} too: a worktree there was made with this one, and you work in it as well (your instructions say where).`);
  const part = (label: string, text: string | undefined): void => {
    if (text?.trim()) lines.push('', label, text.trim());
  };
  part('Goal:', issue.brief.goal);
  part('Done means:', issue.brief.acceptance);
  part('Context:', issue.brief.context);
  part('Decided already:', issue.brief.decisions);
  if (issue.github) lines.push('', gitHubLine(issue.github));
  lines.push('', `Its full brief is in your instructions. Keep ${issue.key} true as you go (decisions, sub-tasks, proof, notes for the next agent).`);
  return lines.join('\n');
}

/** "BLG-1", "BLG-1 and BLG-2", "BLG-1, BLG-2 and BLG-3". */
export const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A draft's goal and criteria as a task's brief. */
function draftBrief(d: TaskDraft): Partial<Record<BriefSection, string>> {
  const acceptance = d.acceptance.map((a) => `- [ ] ${a.replace(/\s+/g, ' ').trim()}`).join('\n');
  return { ...(d.goal.trim() ? { goal: d.goal.trim() } : {}), ...(d.context?.trim() ? { context: d.context.trim() } : {}), ...(acceptance ? { acceptance } : {}) };
}
