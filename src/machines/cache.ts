import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Action, DomainState } from '../core/store.js';
import { replay } from '../ipc/state-compat.js';

/**
 * Each computer's last state on this Mac (BLG-792): what a screen of yours there last showed, kept
 * in step by replaying the computer's actions as they pass through the door, and saved now and then
 * (~/.beluga/cache/computer-state, beside the files' cache). A screen opened on it draws from this
 * at once, after a restart too, then catches up when the link says welcome. Offline, it stays
 * readable. A computer forgotten takes its state with it.
 */

/** How long after a change the state is saved (and at most how often). */
export const SAVE_MS = 5_000;
/** A state bigger than this isn't saved (it stays in memory). */
const MAX_SAVED_BYTES = 64 * 1024 * 1024;

export interface KeptState {
  readonly snapshot: DomainState;
  readonly seq: number;
  /** The computer's Beluga version, as its welcome said. */
  readonly version: string;
  /** When it last heard from the computer (ms). */
  readonly at: number;
}

export interface StateCacheOptions {
  /** Its folder; none: memory only. */
  readonly dir?: string;
  readonly saveMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const fileName = (machine: string): string => `${createHash('sha256').update(`computer\0${machine}`).digest('hex').slice(0, 24)}.json`;

export class StateCache {
  private readonly kept = new Map<string, KeptState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: StateCacheOptions = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The computer's last state: in memory, else as saved before this Mac's Beluga restarted. */
  get(machine: string): KeptState | undefined {
    const mem = this.kept.get(machine);
    if (mem || !this.opts.dir) return mem;
    try {
      const saved = JSON.parse(readFileSync(path.join(this.opts.dir, fileName(machine)), 'utf8')) as Partial<KeptState> & { machine?: string };
      if (saved.machine !== machine || !saved.snapshot || typeof saved.seq !== 'number' || typeof saved.at !== 'number') return undefined;
      const kept: KeptState = { snapshot: saved.snapshot, seq: saved.seq, version: saved.version ?? '', at: saved.at };
      this.kept.set(machine, kept);
      return kept;
    } catch {
      return undefined;
    }
  }

  /** The computer said its state whole (a welcome, a snapshot). */
  reset(machine: string, snapshot: DomainState, seq: number, version?: string): void {
    this.kept.set(machine, { snapshot, seq, version: version ?? this.kept.get(machine)?.version ?? '', at: this.now() });
    this.later(machine);
  }

  /** One of the computer's actions, in order; one out of order waits for the next snapshot. */
  apply(machine: string, seq: number, action: Action): void {
    const k = this.kept.get(machine);
    if (!k || seq !== k.seq + 1) return;
    // Its Beluga may be another version (state-compat.ts): an action this reducer throws on is left
    // out, and the next one, out of order, waits for its next snapshot.
    const { state, outcome } = replay(k.snapshot, action);
    if (outcome === 'failed') return;
    this.kept.set(machine, { ...k, snapshot: state, seq, at: this.now() });
    this.later(machine);
  }

  /** Everything kept for a computer goes (it was forgotten). */
  clear(machine: string): Promise<void> {
    this.kept.delete(machine);
    clearTimeout(this.timers.get(machine));
    this.timers.delete(machine);
    const dir = this.opts.dir;
    if (!dir) return Promise.resolve();
    return this.queue(() => fs.rm(path.join(dir, fileName(machine)), { force: true }));
  }

  /** Save what's waiting now (this Mac's Beluga stopping, tests). */
  flush(): Promise<void> {
    for (const [machine, timer] of this.timers) {
      clearTimeout(timer);
      this.save(machine);
    }
    this.timers.clear();
    return this.writes.then(() => undefined);
  }

  private later(machine: string): void {
    if (!this.opts.dir || this.timers.has(machine)) return;
    const timer = setTimeout(() => {
      this.timers.delete(machine);
      this.save(machine);
    }, this.opts.saveMs ?? SAVE_MS);
    timer.unref();
    this.timers.set(machine, timer);
  }

  private save(machine: string): void {
    const dir = this.opts.dir;
    const k = this.kept.get(machine);
    if (!dir || !k) return;
    void this.queue(async () => {
      const text = JSON.stringify({ machine, ...k });
      if (text.length > MAX_SAVED_BYTES) return;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, fileName(machine));
      // Written whole, then moved in: a crash midway never leaves half a state.
      await fs.writeFile(`${file}.tmp`, text, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
  }

  private queue(job: () => Promise<void>): Promise<void> {
    const run = this.writes.then(job).catch((err: unknown) => this.opts.log?.(`machines: state cache: ${err instanceof Error ? err.message : String(err)}`));
    this.writes = run;
    return run;
  }
}
