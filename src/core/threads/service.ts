import { randomUUID } from 'node:crypto';
import type { ThreadStartInput, ThreadTools } from '../../agent/types.js';
import type { AgentRef } from '../../protocol.js';
import { ASSISTANT_TITLE, isAssistant, THIS_COMPUTER } from '../../shared/assistant.js';
import { autoContinueFor, limitResumeAt } from '../../shared/auto-continue.js';
import { limitStops } from '../auto-continue.js';
import { LOCAL_RUNTIME } from '../../shared/local-endpoints.js';
import { decodeFailure } from '../../shared/run-failure.js';
import type { Effort } from '../../shared/settings-schema.js';
import { type ThreadRecord, type ThreadState } from '../../shared/threads.js';
import { CHATS_PROJECT } from '../../workspaces/manager.js';
import type { Project, Workspace } from '../../workspaces/types.js';
import { type Action, type Store, isRunning } from '../store.js';
import { ThreadDelivery, type ParentPlace } from './delivery.js';
import { type ThreadLive, type ThreadNode, capSummary, deriveThreadState, isDescendant, isReportable, stopOrder, subtree, threadEndOf, threadLimitProblem, threadMessagePrompt, threadTaskPrompt } from './model.js';

/**
 * Child threads: what the thread tools do, with limits, scope and harness choice enforced here.
 * Beluga supplies tools, state and views; the orchestrating chat makes every decision. The calling
 * chat comes from forRun (the run's own channel), never from a tool's argument.
 */

const WS = 'ws:';
/** A status wait goes on through these. */
const STILL_WORKING: readonly ThreadState[] = ['queued', 'running', 'waiting_limit'];
/** What a run that a person's Stop reached gets when it tries to do more. */
const RUN_STOPPED = 'A person stopped this chat, so this run cannot start threads or message them. Beluga did nothing. End your turn.';

export interface ThreadServiceDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly projects: () => readonly Project[];
  readonly find: (id: string) => Workspace | undefined;
  readonly setThread: (id: string, thread: ThreadRecord) => void;
  readonly newWorktree: (projectId: string, name: string, opts: { readonly base?: string; readonly agent?: AgentRef; readonly thread: ThreadRecord }) => Promise<Workspace | undefined>;
  readonly newChat: (projectId: string, title: string, opts: { readonly dir?: string; readonly thread: ThreadRecord }) => Promise<Workspace | undefined>;
  readonly setAgent: (id: string, agent: AgentRef) => void;
  readonly setEffort: (id: string, effort: Effort) => void;
  /** Send a prompt under `requestId`. The chat shows `shown` as sent by an agent. */
  readonly ask: (prompt: string, channel: string, requestId: string, opts: { readonly urgent: boolean; readonly shown: string }) => void;
  readonly stopRun: (channel: string) => void;
  readonly runsAgent: (agent: AgentRef) => boolean;
  /** Whether a runtime takes a message into a running turn (undefined: your default agent's). */
  readonly canSteer: (runtime: string | undefined) => boolean;
  /** Run a parent with its batch of results. The chat shows `line` first. */
  readonly wake: (channel: string, prompt: string, line: string, requestId: string) => void;
  /** Whether a Your Mac chat still exists. */
  readonly hasMacChat: (channel: string) => boolean;
  /** A person's agent terminal has this chat: a run there is refused until it closes. */
  readonly terminalDriving: (channel: string) => boolean;
  /** A person's archive or delete of this chat is under way: results wait to see how it ends. */
  readonly leaving?: (id: string) => boolean;
  readonly wakeMs?: number;
}

interface Waiter {
  readonly check: () => void;
  readonly end: () => void;
}

export class ThreadService {
  /** Requests sent in this process with no final event yet. After a restart this is empty: an owed turn is interrupted. */
  private readonly sent = new Set<string>();
  /** Starts with a key still making their chat: a repeat joins the same start. */
  private readonly starting = new Map<string, Promise<string>>();
  /** Slots held by starts still making their chat, by tree root. */
  private readonly reserved = new Map<string, number>();
  private readonly waiters = new Set<Waiter>();
  /** How many times a person's Stop reached each chat. A run compares it with the count at its start. */
  private readonly stopCounts = new Map<string, number>();
  private readonly offAction: () => void;
  private readonly delivery: ThreadDelivery;

  constructor(private readonly deps: ThreadServiceDeps) {
    this.delivery = new ThreadDelivery({
      selfId: deps.selfId,
      nodes: () => this.nodes(),
      place: (parent) => this.placeOf(parent),
      busy: (parent) => this.liveMap().has(parent),
      describe: (n) => {
        const ws = deps.find(n.id);
        return { title: ws?.name ?? n.id, agent: ws?.agent?.label ?? 'default agent' };
      },
      setThread: deps.setThread,
      owe: (parent, requestId) => this.owe(parent, requestId),
      wake: deps.wake,
      ...(deps.wakeMs !== undefined ? { wakeMs: deps.wakeMs } : {}),
    });
    this.offAction = deps.store.onAction((action) => this.onAction(action));
  }

  /** The tools for one run, bound to its chat. A parent is a workspace chat or a Your Mac chat: never the room or a chat with friends. */
  forRun(channel: string): ThreadTools | undefined {
    if (!channel.startsWith(WS) && !isAssistant(channel)) return undefined;
    const born = this.stopCounts.get(channel) ?? 0;
    const reached = (): boolean => (this.stopCounts.get(channel) ?? 0) !== born;
    return {
      start: async (input) => {
        if (reached()) throw new Error(RUN_STOPPED);
        return this.start(channel, input, reached);
      },
      status: (input) => this.status(channel, input),
      message: (input) => {
        if (reached()) throw new Error(RUN_STOPPED);
        return this.message(channel, input);
      },
      stop: (input) => this.stopThreads(channel, input),
    };
  }

  /**
   * A person's Stop on a chat: every thread under it stops, depth first, and nothing wakes a parent
   * for them. Every run it reached is refused more work, also when its call lands late. The chat's
   * own run stays with its caller (see stopChat). Answers how many threads stopped.
   */
  stopTree(channel: string): number {
    this.stopCounts.set(channel, (this.stopCounts.get(channel) ?? 0) + 1);
    return this.stopUnder(channel);
  }

  /** A person's Stop All Running: as stopTree, for the threads under the chat. The chat's own turn goes on, and can start more. */
  stopUnder(channel: string): number {
    const order = stopOrder(this.nodes(), channel);
    for (const n of order) this.stopCounts.set(n.channel, (this.stopCounts.get(n.channel) ?? 0) + 1);
    const { stopped } = this.stopNodes(order, 'person', 'Stopped by a person, with its parent chat.');
    // Results not yet delivered stay on the record: thread_status and the child's chat have them.
    for (const n of subtree(this.nodes(), channel)) this.claim(n);
    return stopped;
  }

  /**
   * Beluga's auto-continue told a thread waiting on your usage limit to go on (core/auto-continue.ts):
   * that turn is owed to the parent, as the one the limit stopped was.
   */
  limitContinued(channel: string, requestId: string): void {
    const n = this.nodes().find((x) => x.channel === channel);
    if (!n?.thread.limit) return;
    const { limit: _limit, ...thread } = n.thread;
    this.sent.add(requestId);
    this.deps.setThread(n.id, { ...thread, owed: [...thread.owed, requestId] });
  }

  /** A thread that a stop reached is not sent on after the limit resets. */
  skipsContinue(channel: string): boolean {
    return Boolean(this.nodes().find((x) => x.channel === channel)?.thread.stopped);
  }

  /**
   * After a restart: a turn that was owed has no run behind it now, so it is interrupted. Nothing
   * starts it again: the parent gets the report once and decides. Call it when the workspaces are loaded.
   */
  recover(): void {
    const live = this.liveMap();
    const at = Date.now();
    for (const n of this.nodes()) {
      if (!n.thread.owed.length || live.has(n.channel)) continue;
      this.deps.setThread(n.id, { ...n.thread, owed: [], outcome: { state: 'interrupted', summary: 'Beluga stopped during this turn, so the turn did not finish. Beluga did not start it again. Use thread_message to continue it.', at, delivered: Boolean(n.thread.stopped) } });
    }
    this.releaseLimits();
    this.delivery.recover();
  }

  stop(): void {
    this.offAction();
    this.delivery.stop();
    for (const w of [...this.waiters]) w.end();
  }

  // ------------------------------------------------------------------ thread_start

  private start(parent: string, input: ThreadStartInput, reached: () => boolean): Promise<string> {
    if (!input.key) return this.startNow(parent, input, reached);
    const existing = this.nodes().find((n) => n.thread.parent === parent && n.thread.key === input.key);
    if (existing) return Promise.resolve(`This key already has thread "${existing.id}". Beluga started no second run. Use thread_status to see its state.`);
    const slot = `${parent}\0${input.key}`;
    const running = this.starting.get(slot);
    if (running) return running;
    const job = this.startNow(parent, input, reached).finally(() => this.starting.delete(slot));
    this.starting.set(slot, job);
    return job;
  }

  private async startNow(parent: string, input: ThreadStartInput, reached: () => boolean): Promise<string> {
    const from = this.parentOf(parent);
    const agent = input.agent ? this.resolveAgent(input.agent.runtime, input.agent.model, input.agent.effort) : undefined;
    const plan = this.planFor(parent, input.plan);
    const where = this.resolveWhere(parent, from, input);
    this.checkLimits(from.root, from.depth + 1);
    const requestId = randomUUID();
    const thread: ThreadRecord = {
      parent,
      parentTitle: from.title,
      root: from.root,
      depth: from.depth + 1,
      task: input.task,
      by: requestId,
      startedAt: Date.now(),
      owed: [requestId],
      ...(input.key ? { key: input.key } : {}),
      ...(where.kind === 'read' ? { readOnly: true as const } : {}),
    };
    const title = input.title?.trim() || input.task.replace(/\s+/g, ' ').trim().slice(0, 60);
    this.reserved.set(from.root, (this.reserved.get(from.root) ?? 0) + 1);
    let child: Workspace | undefined;
    try {
      child = where.kind === 'read' ? await this.deps.newChat(where.projectId, title, { ...(where.dir ? { dir: where.dir } : {}), thread }) : await this.deps.newWorktree(where.projectId, title, { ...(input.base ? { base: input.base } : {}), ...(agent ? { agent } : {}), thread });
    } finally {
      this.reserved.set(from.root, (this.reserved.get(from.root) ?? 1) - 1);
    }
    if (!child) throw new Error(where.kind === 'read' ? 'Beluga could not make the chat. Try again.' : `Beluga could not make the worktree. Check that ${input.base ? `base "${input.base}"` : 'the project'} is correct, then try again.`);
    // A person's Stop landed while the chat was being made: the chat stays, with no work in it.
    if (reached()) {
      this.deps.setThread(child.id, { ...thread, owed: [], stopped: { by: 'person', at: Date.now() }, outcome: { state: 'stopped', summary: 'A person stopped the parent before this thread began.', at: Date.now(), delivered: true } });
      throw new Error(RUN_STOPPED);
    }
    if (agent && where.kind === 'read') this.deps.setAgent(child.id, agent);
    if (input.agent?.effort) this.deps.setEffort(child.id, input.agent.effort);
    const channel = `${WS}${child.id}`;
    if (plan) this.deps.store.dispatch({ type: 'plan_mode', channel, on: true });
    this.send(threadTaskPrompt(from.title, input.task), channel, requestId, false, input.task);
    const harness = agent?.label ?? 'your default agent';
    return `Started thread "${child.id}" (${harness}, ${where.kind === 'read' ? 'read-only chat' : `worktree ${child.branch ?? child.name}`}${plan ? ', plan mode' : ''}). Its result comes back to this chat when its turn ends. You can end your turn now.`;
  }

  private parentOf(channel: string): { readonly title: string; readonly root: string; readonly depth: number; readonly ws?: Workspace } {
    if (isAssistant(channel)) return { title: ASSISTANT_TITLE, root: channel, depth: 0 };
    const ws = this.deps.find(channel.slice(WS.length));
    if (!ws) throw new Error('This chat is not in Beluga any more. Start the thread from another chat.');
    return { title: ws.name, root: ws.thread?.root ?? channel, depth: ws.thread?.depth ?? 0, ws };
  }

  private resolveAgent(runtime: string, model?: string, effort?: Effort): AgentRef {
    const state = this.deps.store.getState();
    const available = state.runtimes.filter((r) => r.available).map((r) => r.id);
    const choice = state.runtimes.find((r) => r.id === runtime);
    if (!choice && state.runtimes.length) throw new Error(`There is no agent runtime "${runtime}". Use one of: ${available.join(', ')}.`);
    const agent: AgentRef = { runtime: runtime as AgentRef['runtime'], label: choice?.label ?? runtime, ...(model ? { model } : {}) };
    if (choice && !choice.available) throw new Error(`${choice.label} cannot run on ${THIS_COMPUTER}: ${choice.why ?? choice.fix ?? 'it is not set up'}. Use one of: ${available.join(', ')}.`);
    const models = this.modelsOf(runtime);
    const picked = models.find((m) => m.value === model);
    const usable = (): string => models.filter((m) => !m.why).map((m) => m.value).join(', ') || 'none now';
    // A local model has no default: its value names the endpoint it runs on.
    if (!model && runtime === LOCAL_RUNTIME) throw new Error(`${agent.label} needs a model. Use one of: ${usable()}.`);
    if (model && models.length && !picked) throw new Error(`${agent.label} has no model "${model}". Use one of: ${usable()}.`);
    if (picked?.why) throw new Error(`Model "${model}" cannot run now: ${picked.why}`);
    if (!this.deps.runsAgent(agent)) throw new Error(`${agent.label} cannot run on ${THIS_COMPUTER}${model ? ` with model "${model}"` : ''}. Use one of: ${available.join(', ')}.`);
    const efforts = picked?.efforts;
    if (effort && efforts?.length && !efforts.includes(effort)) throw new Error(`Model "${model}" has no effort "${effort}". Use one of: ${efforts.join(', ')}.`);
    return agent;
  }

  /** A runtime's models: its own list, or (Claude) the ones Claude Code gave. */
  private modelsOf(runtime: string): ReadonlyArray<{ readonly value: string; readonly why?: string; readonly efforts?: readonly string[] }> {
    const state = this.deps.store.getState();
    const own = state.runtimes.find((r) => r.id === runtime)?.models;
    return own ?? (runtime === 'claude' ? state.models : []);
  }

  private planFor(parent: string, asked: boolean | undefined): boolean {
    const parentPlans = this.deps.store.getState().planMode[parent] === true;
    if (parentPlans && asked === false) throw new Error('This chat is in plan mode, so its threads must also be in plan mode. Remove plan=false, or leave plan mode first.');
    return parentPlans || asked === true;
  }

  private resolveWhere(parent: string, from: { readonly ws?: Workspace }, input: ThreadStartInput): { readonly kind: 'worktree' | 'read'; readonly projectId: string; readonly dir?: string } {
    const kind = input.where ?? 'worktree';
    if (kind === 'read' && input.base) throw new Error('A read-only chat has no base. Remove base, or use where=worktree.');
    if (kind === 'worktree' && from.ws?.thread?.readOnly) throw new Error('This chat is a read-only thread, so it cannot start a worktree thread. Beluga started nothing. Use where=read to start a read-only thread.');
    const projects = this.deps.projects().filter((p) => p.root);
    const names = (): string => projects.map((p) => p.name).join(', ') || 'none';
    const named = input.project ? projects.find((p) => p.name === input.project || p.id === input.project) : undefined;
    if (input.project && !named) throw new Error(`There is no project "${input.project}". Use one of: ${names()}.`);
    if (named) return { kind, projectId: named.id, ...(kind === 'read' && from.ws?.projectId === named.id ? { dir: from.ws.path } : {}) };
    if (!from.ws) throw new Error(`A thread from ${ASSISTANT_TITLE} needs a project. Set project to one of: ${names()}.`);
    if (from.ws.projectId === CHATS_PROJECT && kind === 'worktree') throw new Error(`This chat has no project, so a worktree needs one. Set project to one of: ${names()}, or use where=read.`);
    return { kind, projectId: from.ws.projectId, ...(kind === 'read' ? { dir: from.ws.path } : {}) };
  }

  private checkLimits(root: string, childDepth: number): void {
    const nodes = this.nodes();
    const live = this.liveMap();
    const running = (n: ThreadNode): boolean => live.has(n.channel);
    const held = this.reserved.get(root) ?? 0;
    const allHeld = [...this.reserved.values()].reduce((a, b) => a + b, 0);
    const tree = nodes.filter((n) => n.thread.root === root);
    const problem = threadLimitProblem(
      {
        childDepth,
        treeRunning: tree.filter(running).length + held,
        treeLive: tree.filter((n) => !this.deps.find(n.id)?.archived).length + held,
        macRunning: nodes.filter(running).length + allHeld,
      },
      this.deps.store.getState().prefs.threadLimits,
    );
    if (problem) throw new Error(problem);
  }

  // ------------------------------------------------------------------ thread_status

  private async status(caller: string, input: { readonly id?: string; readonly waitSec?: number }): Promise<string> {
    const target = input.id ? this.need(caller, input.id) : undefined;
    let waited: 'ended' | 'timeout' | undefined;
    if (input.waitSec) waited = await this.waitFor(input.waitSec * 1000, () => (input.id ? this.waitOver(this.node(input.id)) : this.anyWaitOver(caller)));
    const claimed = new Set<string>();
    // A wait hands the results it found to the caller, so they are not delivered again.
    // So does a read while a person's terminal holds the parent: the reader is the one that has them now.
    for (const n of target ? [this.node(target.id)] : subtree(this.nodes(), caller)) if (n && (waited === 'ended' || this.deps.terminalDriving(n.thread.parent)) && this.claim(n)) claimed.add(n.id);
    if (target) return JSON.stringify({ ...this.view(this.node(target.id) ?? target, true), ...(waited ? { waited } : {}) });
    const live = this.liveMap();
    return JSON.stringify({
      threads: subtree(this.nodes(), caller).map((n) => this.view(n, claimed.has(n.id), live.get(n.channel))),
      agents: this.deps.store.getState().runtimes.filter((r) => r.available).map((r) => ({ runtime: r.id, label: r.label, models: this.modelsOf(r.id).filter((m) => !m.why).map((m) => m.value), canSteer: this.deps.canSteer(r.id) })),
      ...(waited ? { waited } : {}),
    });
  }

  private view(n: ThreadNode, withAnswer: boolean, live: ThreadLive | undefined = this.liveMap().get(n.channel)): Record<string, unknown> {
    const ws = this.deps.find(n.id);
    const answer = withAnswer && n.thread.outcome ? capSummary(n.thread.outcome.summary) : undefined;
    return {
      id: n.id,
      title: ws?.name ?? n.id,
      parent: n.thread.parent,
      depth: n.thread.depth,
      state: deriveThreadState(n.thread, live),
      agent: ws?.agent?.runtime ?? 'default',
      ...(ws?.model ? { model: ws.model } : {}),
      task: n.thread.task.slice(0, 400),
      startedAt: n.thread.startedAt,
      ...(n.thread.outcome ? { endedAt: n.thread.outcome.at } : {}),
      ...(ws?.archived ? { archived: true } : {}),
      ...(n.thread.readOnly ? { readOnly: true } : {}),
      ...(n.thread.limit ? { resumesAt: n.thread.limit.at } : {}),
      ...(answer ? { answer: answer.text, ...(answer.cut ? { answerCut: true } : {}) } : {}),
    };
  }

  private waitFor(ms: number, over: () => boolean): Promise<'ended' | 'timeout'> {
    return new Promise((resolve) => {
      if (over()) return resolve('ended');
      const finish = (how: 'ended' | 'timeout'): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(how);
      };
      const waiter: Waiter = { check: () => over() && finish('ended'), end: () => finish('timeout') };
      const timer = setTimeout(() => finish('timeout'), ms);
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  private waitOver(n: ThreadNode | undefined): boolean {
    return !n || !STILL_WORKING.includes(deriveThreadState(n.thread, this.liveMap().get(n.channel)));
  }

  /** A wait with no id ends on the first result not yet delivered, on needs_you, or when nothing is left working. */
  private anyWaitOver(caller: string): boolean {
    const live = this.liveMap();
    const under = subtree(this.nodes(), caller);
    if (!under.some((n) => live.has(n.channel))) return true;
    return under.some((n) => live.get(n.channel)?.needsYou || isReportable(n.thread));
  }

  private claim(n: ThreadNode): boolean {
    if (!isReportable(n.thread)) return false;
    this.deps.setThread(n.id, { ...n.thread, outcome: { ...n.thread.outcome!, delivered: true } });
    return true;
  }

  // ------------------------------------------------------------------ thread_message

  private message(caller: string, input: { readonly id: string; readonly text: string; readonly mode?: 'queue' | 'steer' }): string {
    const n = this.need(caller, input.id);
    const ws = this.deps.find(n.id);
    if (ws?.archived) throw new Error(`Thread "${n.id}" is archived. A person must restore it before it can take a message.`);
    const steer = input.mode === 'steer';
    if (steer && !this.deps.canSteer(ws?.agent?.runtime)) throw new Error(`${ws?.agent?.label ?? 'This agent'} cannot steer. Use mode "queue": it reads the message when its turn ends.`);
    const requestId = randomUUID();
    const { stopped: _stopped, ...thread } = n.thread;
    this.deps.setThread(n.id, { ...thread, owed: [...n.thread.owed, requestId] });
    this.send(threadMessagePrompt(n.thread.parentTitle, input.text, steer), n.channel, requestId, steer, input.text);
    return steer ? `Steered into thread "${n.id}": its agent gets the message now.` : `Queued for thread "${n.id}": its agent reads the message when its current turn ends. The result comes back to this chat.`;
  }

  // ------------------------------------------------------------------ thread_stop

  private stopThreads(caller: string, input: { readonly id: string; readonly reason?: string }): string {
    const target = this.need(caller, input.id);
    const { stopped, ended } = this.stopNodes([...stopOrder(this.nodes(), target.channel), target], 'agent', input.reason);
    return `Stopped ${stopped} thread${stopped === 1 ? '' : 's'}.${ended ? ` ${ended} already ended.` : ''} To continue one, use thread_message.`;
  }

  /** Stop each of `order`, each on its own: a failure on one does not end the walk. `by` already knows, so nothing is owed to it. */
  private stopNodes(order: readonly ThreadNode[], by: 'person' | 'agent', reason: string | undefined): { readonly stopped: number; readonly ended: number } {
    const live = this.liveMap();
    const who = by === 'agent' ? 'Stopped by the parent agent' : 'Stopped by a person, with its parent chat';
    const at = Date.now();
    let stopped = 0;
    let ended = 0;
    for (const n of order) {
      const running = live.has(n.channel);
      if (!running && !n.thread.owed.length && !n.thread.limit && deriveThreadState(n.thread) !== 'queued') {
        ended++;
        continue;
      }
      try {
        const { limit: _limit, ...rest } = n.thread;
        const mark = { ...rest, stopped: { by, at } };
        // Nothing is running, so no final event comes: the outcome is written now.
        this.deps.setThread(n.id, running ? mark : { ...mark, owed: [], outcome: { state: 'stopped', summary: reason ?? `${who}.`, at, delivered: true } });
        if (running) this.deps.stopRun(n.channel);
        this.deps.store.dispatch({ type: 'system', channel: n.channel, level: 'info', text: by === 'agent' && reason ? `${who}: ${reason.slice(0, 500)}` : `${who}.` });
        stopped++;
      } catch {
        // The next thread still stops. This one's state says what it is.
      }
    }
    return { stopped, ended };
  }

  // ------------------------------------------------------------------ helpers

  private send(prompt: string, channel: string, requestId: string, urgent: boolean, shown: string): void {
    this.sent.add(requestId);
    this.deps.ask(prompt, channel, requestId, { urgent, shown });
  }

  /** The thread `id`, if it is under `caller`. A chat reaches only the threads under it. */
  private need(caller: string, id: string): ThreadNode {
    const bare = id.startsWith(WS) ? id.slice(WS.length) : id;
    const nodes = this.nodes();
    const n = nodes.find((x) => x.id === bare);
    if (!n || !isDescendant(nodes, caller, bare)) throw new Error(`Thread "${id}" is not under this chat. A chat can reach only its own threads. Call thread_status with no id to list them.`);
    return n;
  }

  private node(id: string | undefined): ThreadNode | undefined {
    return this.nodes().find((n) => n.id === id);
  }

  private nodes(): ThreadNode[] {
    return this.deps.projects().flatMap((p) => p.workspaces.flatMap((w) => (w.thread ? [{ id: w.id, channel: `${WS}${w.id}`, thread: w.thread }] : [])));
  }

  /** The turns working now, by channel: from the log, or sent and not there yet. */
  private liveMap(): Map<string, ThreadLive> {
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    const live = new Map<string, ThreadLive>();
    for (const l of state.log) {
      if (l.type !== 'agent' || l.owner !== self || !isRunning(l.status)) continue;
      const needsYou = l.status === 'awaiting_approval' || state.approvals.some((a) => a.channel === l.channel) || state.questions.some((q) => q.channel === l.channel);
      live.set(l.channel, { run: l.status === 'queued' ? 'queued' : 'running', ...(needsYou ? { needsYou } : {}) });
    }
    for (const n of this.nodes()) if (!live.has(n.channel) && n.thread.owed.some((id) => this.sent.has(id))) live.set(n.channel, { run: 'queued' });
    return live;
  }

  private placeOf(parent: string): ParentPlace {
    // With agentThreads off, results wait on the child's record until the switch is on again.
    if (!this.deps.store.getState().prefs.agentThreads) return 'held';
    // A parent whose newest run stopped on your usage limit would hit it again: its next turn's end brings them.
    if (this.onLimit(parent)) return 'held';
    if (isAssistant(parent)) return this.deps.hasMacChat(parent) ? 'here' : 'gone';
    const ws = parent.startsWith(WS) ? this.deps.find(parent.slice(WS.length)) : undefined;
    if (!ws) return 'gone';
    // A thread that was stopped stays stopped: a child's result does not start it again.
    return ws.archived || ws.thread?.stopped || this.deps.leaving?.(ws.id) || this.deps.terminalDriving(parent) ? 'held' : 'here';
  }

  private onLimit(channel: string): boolean {
    const state = this.deps.store.getState();
    return limitStops(state.log.filter((l) => l.channel === channel), state.selfId).length > 0;
  }

  /** A wake of a parent that is a thread itself is an agent's turn, so its answer goes up the chain. */
  private owe(channel: string, requestId: string): void {
    const ws = channel.startsWith(WS) ? this.deps.find(channel.slice(WS.length)) : undefined;
    if (!ws?.thread) return;
    this.sent.add(requestId);
    this.deps.setThread(ws.id, { ...ws.thread, owed: [...ws.thread.owed, requestId] });
  }

  private onAction(action: Action): void {
    if (action.type === 'agent_event') this.settle(action);
    this.delivery.onAction(action);
    // agentThreads turned on: the results held while it was off go to their parents, in one wake each.
    if (action.type === 'prefs' && action.prefs.agentThreads) this.delivery.recover();
    // Auto-continue turned off for a waiting thread: its limit is the result now.
    if (action.type === 'prefs') this.releaseLimits();
    for (const w of [...this.waiters]) w.check();
  }

  /** A turn of yours ended in a thread's chat: its outcome goes on the record at once. */
  private settle(action: Extract<Action, { type: 'agent_event' }>): void {
    if (action.owner !== this.deps.selfId() || !action.channel?.startsWith(WS)) return;
    const end = threadEndOf(action.event, action.text);
    if (!end) return;
    this.sent.delete(action.requestId);
    const id = action.channel.slice(WS.length);
    const thread = this.deps.find(id)?.thread;
    if (!thread) return;
    // A thread waiting on the limit still owes its parent a result, whatever turn ends there next.
    const owedTurn = thread.owed.includes(action.requestId) || thread.limit !== undefined;
    const by = thread.stopped?.by;
    const { limit: _limit, ...open } = thread;
    const resumeAt = owedTurn && !by ? this.limitResume(action.channel, action.text, action.ts) : undefined;
    if (resumeAt !== undefined) {
      this.deps.setThread(id, { ...open, owed: thread.owed.filter((r) => r !== action.requestId), limit: { at: resumeAt, summary: end.summary } });
      return;
    }
    // Owed: the parent gets it, unless its side stopped it, or a person's Stop on the tree did (written before the final event, also when the turn just ended by itself). A person's turn: nothing new is owed, and a result on its way stays on its way.
    const delivered = owedTurn ? by === 'person' || (end.state === 'stopped' && by === 'agent') : (thread.outcome?.delivered ?? true);
    // A turn that ended on its own means someone carried the thread on: the old stop no longer holds.
    const { stopped: _stopped, ...rest } = open;
    const next: ThreadRecord = {
      ...(end.state === 'stopped' ? open : rest),
      owed: thread.owed.filter((r) => r !== action.requestId),
      outcome: { state: end.state, summary: end.summary, at: action.ts, delivered },
      ...(end.state === 'stopped' && !by ? { stopped: { by: 'person' as const, at: action.ts } } : {}),
    };
    this.deps.setThread(id, next);
    if (isReportable(next)) this.delivery.resultSaved(next.parent);
  }

  /** When a turn that stopped on your usage limit is sent on by the auto-continue: only with a known reset and the auto-continue on for that chat. */
  private limitResume(channel: string, text: string, stoppedAt: number): number | undefined {
    const failure = decodeFailure(text);
    if (failure?.kind !== 'usage_limit' || failure.resetsAt === undefined) return undefined;
    const at = limitResumeAt(failure, stoppedAt);
    return autoContinueFor(this.deps.store.getState().prefs, channel, at, Date.now()).kind === 'scheduled' ? at : undefined;
  }

  /** Threads waiting on the limit that the auto-continue will not send on any more (off, or too late): the limit is their result. */
  private releaseLimits(): void {
    const prefs = this.deps.store.getState().prefs;
    const now = Date.now();
    for (const n of this.nodes()) {
      const limit = n.thread.limit;
      if (!limit || autoContinueFor(prefs, n.channel, limit.at, now).kind === 'scheduled') continue;
      const { limit: _limit, ...thread } = n.thread;
      const next: ThreadRecord = { ...thread, outcome: { state: 'failed', summary: limit.summary, at: now, delivered: false } };
      this.deps.setThread(n.id, next);
      if (isReportable(next)) this.delivery.resultSaved(next.parent);
    }
  }
}
