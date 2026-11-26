import { humanizeTool } from '../shared/step-titles.js';
import type { StepRecord } from '../shared/steps.js';

/**
 * Work Beluga does for a message before its agent can start on it (BLG-1013): making the worktree
 * it was written in. Its agent's card shows at once, under the message, with that work as its
 * first step (running, then done); the agent's own steps follow it on the same card, since they're
 * kept under the same request id. Stop on the card while it's there takes the message back.
 */

export interface BeforeRunDeps {
  /** Say something about the card (agent-host's emitAgent, as your own agent's events go). */
  readonly emit: (requestId: string, event: 'started' | 'tool' | 'error', text: string, channel: string) => void;
  /** Keep a step's record for the card (agent-host's step book, under the run's key). */
  readonly put: (requestId: string, record: StepRecord) => void;
  readonly now?: () => number;
}

/** A step a message's card does before its agent starts. */
export interface BeforeStep {
  /** The tool name its row is drawn as (an icon, words from shared/step-titles.ts). */
  readonly tool: string;
  readonly input: Readonly<Record<string, string>>;
}

export interface Preparing {
  /** The work is done: true when its agent should be asked now (false: it was stopped meanwhile). */
  readonly finish: () => boolean;
  /** The work failed: the card says why, and its agent isn't asked. */
  readonly fail: (why: string) => void;
}

interface Entry {
  readonly prompt: string;
  readonly record: StepRecord;
  stopped: boolean;
}

export class BeforeRuns {
  /** Messages whose work is under way, by conversation, then request id. */
  private readonly open = new Map<string, Map<string, Entry>>();

  constructor(private readonly deps: BeforeRunDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The card for `requestId` shows now, with `step` running as its first step. */
  start(channel: string, requestId: string, prompt: string, step: BeforeStep): Preparing {
    const words = humanizeTool(step.tool, step.input);
    const line = [step.tool, ...Object.values(step.input)].join(' ');
    const record: StepRecord = { id: `before:${requestId}`, kind: 'tool', tool: step.tool, title: line, label: words.done, doing: words.doing, status: 'running', startedAt: this.now(), input: step.input };
    const entry: Entry = { prompt, record, stopped: false };
    this.open.set(channel, new Map([...(this.open.get(channel) ?? []), [requestId, entry]]));
    this.deps.emit(requestId, 'started', '', channel);
    this.deps.put(requestId, record);
    this.deps.emit(requestId, 'tool', line, channel);
    const settle = (status: 'done' | 'error'): boolean => {
      if (entry.stopped || !this.close(channel, requestId)) return false;
      const endedAt = this.now();
      this.deps.put(requestId, { ...record, status, endedAt, durationMs: endedAt - record.startedAt });
      return true;
    };
    return {
      finish: () => settle('done'),
      fail: (why) => {
        if (settle('error')) this.deps.emit(requestId, 'error', why, channel);
      },
    };
  }

  /** Whether a message's work is under way in `channel`. */
  has(channel: string): boolean {
    return (this.open.get(channel)?.size ?? 0) > 0;
  }

  /**
   * Stop in `channel`: each message still waiting on its work is taken back (its card says so,
   * its agent is never asked). → their words, in the order they were written, for the box.
   */
  stop(channel: string): string[] {
    const entries = [...(this.open.get(channel)?.entries() ?? [])];
    this.open.delete(channel);
    const at = this.now();
    for (const [requestId, entry] of entries) {
      entry.stopped = true;
      this.deps.put(requestId, { ...entry.record, status: 'error', endedAt: at, durationMs: at - entry.record.startedAt });
      this.deps.emit(requestId, 'error', 'Stopped before it started: your message is back in the box', channel);
    }
    return entries.map(([, entry]) => entry.prompt);
  }

  private close(channel: string, requestId: string): boolean {
    const here = this.open.get(channel);
    if (!here?.has(requestId)) return false;
    const rest = new Map([...here].filter(([id]) => id !== requestId));
    if (rest.size) this.open.set(channel, rest);
    else this.open.delete(channel);
    return true;
  }
}
