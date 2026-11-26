/**
 * Keeps an eye on an ACP agent's line from both ends, so a run that goes quiet is said (once a
 * turn) and one that's stuck ends with why, instead of waiting forever. It reads frames and never
 * changes them. Time is passed in (`now`), so the rules are tested on fixed numbers.
 *
 * What it counts as the agent working: anything it says about a turn (its words, its thinking, a
 * step, its plan). Quiet is never stuck while a step runs (a long build, a test run) or while you
 * decide on a step it asked about: those wait for you. A turn ends here only when nothing runs,
 * nobody is asked, and it has said nothing for `stuck`. A request that isn't a turn (initialize,
 * session/new, session/load, setting an option) ends when the agent's whole line has been silent
 * for `setup`. Nothing is ever sent again on its own.
 */

/** How long, in ms. */
export interface AcpLimits {
  /** A request that isn't a turn, with nothing at all heard from the agent: it's gone. */
  readonly setup: number;
  /** A turn with nothing said: you're told once that it's quiet. */
  readonly quiet: number;
  /** A turn with nothing said, no step running and nobody asked: it's stuck. */
  readonly stuck: number;
  /** Ticks this far apart: the computer slept (its clocks are moved on, not counted). */
  readonly slept: number;
}

export const ACP_LIMITS: AcpLimits = { setup: 90_000, quiet: 30_000, stuck: 15 * 60_000, slept: 10_000 };

/** What a tick found: a note for the chat, or why the run ends. */
export interface AcpVerdict {
  readonly notice?: string;
  readonly end?: string;
}

type Id = string | number;
type Frame = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown; readonly [field: string]: unknown };

/** Updates that are the agent working on a turn. The rest (its commands, its options, its mode) is state. */
const WORK = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
const DONE = new Set(['completed', 'failed', 'cancelled']);

const idOf = (f: Frame): Id | undefined => (typeof f.id === 'string' || typeof f.id === 'number' ? f.id : undefined);
const fields = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class AcpWatch {
  /** Our requests not answered yet, other than turns: what each was. */
  private readonly asks = new Map<Id, string>();
  /** Turns running (session/prompt not answered yet), by request id. */
  private readonly turns = new Set<Id>();
  /** Steps running, by tool call id: `own` while it belongs to a running turn; one that outlived its turn runs on its own. */
  private readonly steps = new Map<string, { own: boolean }>();
  /** Steps it asked about that nobody has answered yet, by the request's id. */
  private readonly asked = new Set<Id>();
  /** Sessions being loaded: their history comes in until the next turn, and isn't work. */
  private readonly loading = new Set<string>();
  /** Steps seen only in a history: what's said of them later isn't work either. */
  private readonly past = new Set<string>();
  /** When the agent last said anything at all, and last worked on a turn. */
  private heard: number;
  private worked: number;
  private told = false;
  private ticked: number;

  constructor(
    private readonly label: string,
    now: number,
    private readonly limits: AcpLimits = ACP_LIMITS,
  ) {
    this.heard = this.worked = this.ticked = now;
  }

  /** A frame we sent. */
  sent(frame: Frame, now: number): void {
    const id = idOf(frame);
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    const sid = fields(frame.params).sessionId;
    if (!method) {
      // Our answer to its request: a step you decided on.
      if (id !== undefined && this.asked.delete(id)) this.worked = now;
      return;
    }
    if (method === 'session/load' && typeof sid === 'string') this.loading.add(sid);
    if (id === undefined) return;
    if (method === 'session/prompt') {
      if (typeof sid === 'string') this.loading.delete(sid);
      if (!this.turns.size) this.told = false;
      this.turns.add(id);
      this.worked = now;
    } else this.asks.set(id, method);
  }

  /** A frame the agent sent. */
  got(frame: Frame, now: number): void {
    this.heard = now;
    const id = idOf(frame);
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    if (!method) {
      if (id === undefined) return;
      this.asks.delete(id);
      if (this.turns.delete(id)) {
        this.worked = now;
        // What still runs when its turn ended is its own now (a server it left up): it no longer keeps a turn from being stuck.
        for (const step of this.steps.values()) step.own = false;
      }
      return;
    }
    const params = fields(frame.params);
    if (method === 'session/request_permission' && id !== undefined) {
      this.asked.add(id);
      this.worked = now;
      return;
    }
    if (method !== 'session/update') return;
    const update = fields(params.update);
    const kind = String(update.sessionUpdate);
    const call = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    const loading = typeof params.sessionId === 'string' && this.loading.has(params.sessionId);
    // A step announced anew is new, even under a history's id (an agent that counts its ids per process).
    if (!loading && call && kind === 'tool_call') this.past.delete(call);
    if (loading || (call && this.past.has(call))) {
      if (call) this.past.add(call);
      return;
    }
    if (!WORK.has(kind)) return;
    this.worked = now;
    if (!call) return;
    if (typeof update.status === 'string' && DONE.has(update.status)) this.steps.delete(call);
    else if (!this.steps.has(call)) this.steps.set(call, { own: this.turns.size > 0 });
  }

  /** Every second or so: a note to show, or why it ends. */
  tick(now: number): AcpVerdict {
    const gap = now - this.ticked;
    this.ticked = now;
    // Asleep (or stopped in a debugger): that time isn't the agent's silence.
    if (gap > this.limits.slept) {
      this.heard += gap;
      this.worked += gap;
    }
    const pending = [...this.asks.values()][0];
    if (pending && now - this.heard >= this.limits.setup) return { end: `${this.label} didn’t answer ${pending} and said nothing for ${secs(this.limits.setup)}, so Beluga stopped it.` };
    if (!this.turns.size || this.asked.size) return {};
    const quiet = now - this.worked;
    const running = [...this.steps.values()].some((s) => s.own);
    if (!running && quiet >= this.limits.stuck) return { end: `${this.label} said nothing for ${secs(this.limits.stuck)} with no step running, so Beluga stopped it. Nothing was sent again.` };
    if (!this.told && quiet >= this.limits.quiet) {
      this.told = true;
      return { notice: running ? `${this.label} is still running a step and hasn’t said anything for ${secs(quiet)}. Stop ends it.` : `${this.label} hasn’t said anything for ${secs(quiet)}. It may still be thinking; Stop ends it.` };
    }
    return {};
  }
}

const secs = (ms: number): string => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
