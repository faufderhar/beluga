import path from 'node:path';
import type { StepRecord } from '../../../shared/steps.js';
import { summarizeTool } from '../../prompt.js';
import { StepRecorder } from '../../step-recorder.js';
import type { SubAgentEvent } from '../../types.js';
import { toolCallOf, toolResultOf } from './events.js';
import type { CollabAgentToolCall, SubAgentActivity, Thread, ThreadItem, Turn } from './protocol.js';

/**
 * Codex's own sub-agents (its multi_agent, BLG-519) as Beluga's: the same 'sub' events and step
 * records Claude's Task/Agent sub-agents give (claude/subagents.ts), so the chat's sub-agent rows,
 * their steps, the phone's sub-agent sheet and the run staying open while they work need nothing
 * Codex-specific.
 *
 * What Codex sends (codex-cli 0.166's app-server protocol): the lead's `collabAgentToolCall` items
 * (`spawnAgent` names the new agent's thread in receiverThreadIds once it's spawned; `wait`,
 * `closeAgent`… carry each agent's last state and message in agentsStates), `subAgentActivity`
 * items (multi_agent_v2: started / completed / interrupted), `thread/started` for a spawned thread
 * (parentThreadId, agentNickname, agentRole), and the spawned thread's own `turn/*` and `item/*`
 * notifications under its threadId. A sub-agent is known by its thread id: its row, its steps'
 * parent, and the launch step whose result is its report.
 */

/** The states a lead reports for a sub-agent that has stopped working. */
const ENDED = new Set(['completed', 'errored', 'shutdown', 'interrupted', 'notFound']);

interface Agent {
  readonly id: string;
  nickname?: string;
  role?: string;
  prompt?: string;
  started: boolean;
  done: boolean;
  /** Its turn running now (what Stop interrupts). */
  turnId?: string;
  /** What it said last: its report when it ends. */
  said?: string;
  /** Its tools running now, by item. */
  readonly tools: Set<string>;
}

export interface SubAgentOutput {
  /** A 'sub' event (the card's sub-agent rows). */
  readonly onSub: (e: SubAgentEvent) => void;
  /** Its steps in detail, tagged with the sub-agent (the request that started the run). */
  readonly onStep?: (record: StepRecord) => void;
  readonly onFileTouched?: (abs: string) => void;
  readonly now?: () => number;
}

const firstLine = (s: string | undefined, max: number): string => {
  const line = (s ?? '').trim().split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A sub-agent's row title: "Darwin (explorer) · Look at the tests", Claude's "type · description" in Codex's words. */
export function subAgentTitle(a: { readonly nickname?: string; readonly role?: string; readonly prompt?: string }): string {
  const who = a.nickname && a.role ? `${a.nickname} (${a.role})` : a.nickname || a.role;
  return [who, firstLine(a.prompt, 80)].filter((x): x is string => Boolean(x)).join(' · ') || 'sub-agent';
}

/** Follows one run's sub-agents: every notification passes through `handle` first. */
export class CodexSubAgents {
  /** The run's own thread (its lead); every other thread on the app-server is one of its sub-agents. */
  lead: string | undefined;
  private readonly agents = new Map<string, Agent>();
  /** Their steps' own book: the lead's turns ending never ends a sub-agent's steps. */
  private readonly recorder: StepRecorder;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly cwd: string,
    private readonly out: SubAgentOutput,
  ) {
    this.recorder = new StepRecorder({ cwd, emit: (record) => out.onStep?.(record), ...(out.now ? { now: out.now } : {}) });
  }

  /** True when the notification was a sub-agent's (the lead's own events skip it). */
  handle(method: string, params: Record<string, unknown>): boolean {
    if (method === 'thread/started') {
      const thread = params.thread as Thread | undefined;
      if (!thread?.parentThreadId || thread.id === this.lead) return false;
      this.meet(thread);
      return true;
    }
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!this.lead || !thread) return false;
    const item = params.item as ThreadItem | undefined;
    if (thread !== this.lead) {
      this.child(thread, method, params, item);
      return true;
    }
    if ((method === 'item/started' || method === 'item/completed') && item) {
      if (item.type === 'collabAgentToolCall') return this.collab(item as CollabAgentToolCall, method === 'item/completed'), true;
      if (item.type === 'subAgentActivity') return this.activity(item as SubAgentActivity), true;
    }
    return false;
  }

  /** Some sub-agent is still working: the run stays open for it (as Claude's background agents keep theirs). */
  get busy(): boolean {
    for (const a of this.agents.values()) if ((a.started && !a.done) || a.turnId) return true;
    return false;
  }

  /** How many are working now. */
  get working(): number {
    let n = 0;
    for (const a of this.agents.values()) if ((a.started && !a.done) || a.turnId) n++;
    return n;
  }

  /** The turns sub-agents are running now (Stop interrupts each). */
  running(): Array<{ readonly threadId: string; readonly turnId: string }> {
    return [...this.agents.values()].flatMap((a) => (a.turnId ? [{ threadId: a.id, turnId: a.turnId }] : []));
  }

  /** Resolves at the next sub-agent starting, ending, or starting a turn. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The run ended: sub-agents still working were cut off with it, and their steps end. */
  finish(failed: boolean): void {
    for (const a of this.agents.values()) if (a.started && !a.done) this.end(a, true, a.said);
    this.recorder.finish(failed);
  }

  private agent(id: string): Agent {
    let a = this.agents.get(id);
    if (!a) this.agents.set(id, (a = { id, started: false, done: false, tools: new Set() }));
    return a;
  }

  private poke(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private meet(thread: Thread): void {
    const a = this.agent(thread.id);
    if (thread.agentNickname) a.nickname = thread.agentNickname;
    if (thread.agentRole) a.role = thread.agentRole;
    if (thread.preview && !a.prompt) a.prompt = thread.preview;
  }

  /** Its row, and the launch step (Claude's Agent call) its report comes back on. */
  private start(a: Agent): void {
    if (a.started) return;
    a.started = true;
    const title = subAgentTitle(a);
    this.out.onSub({ id: a.id, phase: 'start', title, kind: 'agent' });
    this.recorder.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: a.id, name: 'Agent', input: { description: title, ...(a.role ? { subagent_type: a.role } : {}), ...(a.prompt ? { prompt: a.prompt } : {}) } }] } });
    this.poke();
  }

  private end(a: Agent, failed: boolean, report: string | undefined): void {
    if (a.done) return;
    this.start(a);
    a.done = true;
    const said = report?.trim() || a.said;
    this.out.onSub({ id: a.id, phase: 'done', ...(failed ? { failed: true } : {}) });
    this.recorder.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: a.id, content: said || (failed ? 'Stopped before it finished' : ''), is_error: failed }] } });
    this.poke();
  }

  /** The lead's call to a sub-agent tool: a spawn starts one; any call says where its agents stand. */
  private collab(item: CollabAgentToolCall, completed: boolean): void {
    if (item.tool === 'spawnAgent' && completed) {
      for (const id of item.receiverThreadIds ?? []) {
        const a = this.agent(id);
        if (item.prompt && !a.prompt) a.prompt = item.prompt;
        this.start(a);
      }
    }
    if (!completed) return;
    for (const [id, state] of Object.entries(item.agentsStates ?? {})) {
      const a = this.agents.get(id);
      if (!state || !a?.started || a.done || a.turnId || !ENDED.has(state.status)) continue;
      this.end(a, state.status !== 'completed', state.message ?? undefined);
    }
  }

  private activity(item: SubAgentActivity): void {
    const a = this.agent(item.agentThreadId);
    if (!a.nickname && item.agentPath) a.nickname = item.agentPath.split('/').filter(Boolean).at(-1);
    if (item.kind === 'started' || item.kind === 'interacted') return this.start(a);
    if (item.kind === 'completed' || item.kind === 'interrupted') this.end(a, item.kind === 'interrupted', undefined);
  }

  /** A notification from a sub-agent's own thread. */
  private child(id: string, method: string, params: Record<string, unknown>, item: ThreadItem | undefined): void {
    const a = this.agent(id);
    if (method === 'turn/started') {
      a.turnId = (params.turn as Turn | undefined)?.id;
      this.start(a);
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn as Turn | undefined;
      a.turnId = undefined;
      // Its steps still open end with its turn.
      for (const tool of a.tools) this.recorder.observe({ type: 'user', parent_tool_use_id: id, message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'Stopped before it finished', is_error: true }] } });
      a.tools.clear();
      if (a.done) return this.poke();
      return this.end(a, turn?.status !== 'completed', turn?.status === 'failed' ? turn.error?.message : undefined);
    }
    if (method === 'thread/closed') {
      a.turnId = undefined;
      if (a.started) this.end(a, false, undefined);
      return this.poke();
    }
    if (!item?.id || (method !== 'item/started' && method !== 'item/completed')) return;
    if (item.type === 'collabAgentToolCall') return this.collab(item as CollabAgentToolCall, method === 'item/completed');
    this.start(a);
    if (item.type === 'agentMessage') {
      const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text?.trim();
      if (method === 'item/completed' && text) a.said = text;
      return;
    }
    const call = toolCallOf(item, this.cwd);
    if (!call) return;
    if (method === 'item/started' || !a.tools.has(item.id)) {
      if (a.tools.has(item.id)) return;
      a.tools.add(item.id);
      this.out.onSub({ id: a.id, phase: 'step', step: summarizeTool(call.name, call.input, this.cwd) });
      this.recorder.observe({ type: 'assistant', parent_tool_use_id: id, message: { content: [{ type: 'tool_use', id: item.id, name: call.name, input: call.input, native: item.type }] } });
      if (method === 'item/started') return;
    }
    a.tools.delete(item.id);
    if (item.type === 'fileChange') for (const change of (item as Extract<ThreadItem, { type: 'fileChange' }>).changes) this.out.onFileTouched?.(path.resolve(this.cwd, change.path));
    const { content, isError, exitCode } = toolResultOf(item);
    this.recorder.observe({ type: 'user', parent_tool_use_id: id, message: { content: [{ type: 'tool_result', tool_use_id: item.id, content, is_error: isError, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) }] } });
  }
}
