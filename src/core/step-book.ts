import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type StepPage, type StepRecord, sizeOf, summaryOf } from '../shared/steps.js';

/**
 * Where the details of Claude's steps live (see shared/steps.ts): beside the chat, never in it.
 * The chat item keeps its one-line steps as before; this keeps, per run, every step's record
 * (input, output, thinking), in memory for recent runs and on disk (bounded) so a card can be
 * opened again after Beluga restarts. Only ever read by screens on this computer
 * (`agent.steps`, `agent.step`); nothing here is sent to anyone.
 */

/** Steps kept per run (the oldest drop off). */
export const MAX_RUN_STEPS = 500;
/** Characters of details kept per run; past it the oldest steps lose their details (not their line). */
export const MAX_RUN_CHARS = 3_000_000;
/** Runs kept in memory. */
const MEMORY_RUNS = 40;
/**
 * Characters of details kept in memory across runs when they're saved to disk: past it the
 * least recently used runs are written and let go (read back from disk when a card opens them).
 */
export const MEMORY_CHARS = 12_000_000;
/** Runs kept on disk (the oldest files go). */
const DISK_RUNS = 300;
/** A run's file is written this long after its last change (and right away when it ends). */
const SAVE_DELAY_MS = 2_000;
/** Old runs' files are cleared out at most this often. */
const PRUNE_EVERY_MS = 60_000;

interface Run {
  readonly key: string;
  readonly order: string[];
  readonly records: Map<string, StepRecord>;
  chars: number;
  version: number;
  timer?: NodeJS.Timeout;
  /** The version its file has (none: not written yet). */
  saved?: number;
  /** A write in flight, and whether changes came after it started. */
  writing?: boolean;
  again?: boolean;
}

const fileName = (key: string): string => `${createHash('sha1').update(key).digest('hex')}.json`;

/** A write that wasn't kept, gone (Windows' virus scanner can hold a new file a moment: tried again). */
const dropTmp = (tmp: string): Promise<void> => rm(tmp, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);

export class StepBook {
  private readonly runs = new Map<string, Run>();

  /** `dir`: where runs are saved (none: memory only). */
  constructor(private readonly dir?: string) {}

  /** Add a step or replace it with a newer version of itself. */
  put(key: string, record: StepRecord): void {
    const run = this.run(key, true)!;
    const old = run.records.get(record.id);
    if (old) run.chars -= sizeOf(old);
    else run.order.push(record.id);
    run.records.set(record.id, record);
    run.chars += sizeOf(record);
    this.trim(run);
    run.version++;
    this.scheduleSave(run);
  }

  /** Replace a run's steps (a conversation imported from Claude Code). */
  putAll(key: string, records: readonly StepRecord[]): void {
    const run = this.run(key, true)!;
    run.order.splice(0);
    run.records.clear();
    run.chars = 0;
    for (const r of records) {
      run.order.push(r.id);
      run.records.set(r.id, r);
      run.chars += sizeOf(r);
    }
    this.trim(run);
    run.version++;
    this.scheduleSave(run);
  }

  has(key: string): boolean {
    return Boolean(this.run(key, false));
  }

  /** The run's steps, light. `after`: the version you have (unchanged: nothing is sent again). */
  page(key: string, after?: number): StepPage {
    const run = this.run(key, false);
    if (!run) return { steps: [], version: 0, missing: true };
    if (after !== undefined && after === run.version) return { steps: [], version: run.version, unchanged: true };
    return { steps: run.order.map((id) => summaryOf(run.records.get(id)!)), version: run.version };
  }

  /** One step with its details. */
  get(key: string, stepId: string): StepRecord | undefined {
    return this.run(key, false)?.records.get(stepId);
  }

  /** Write a run now (it ended). */
  flush(key: string): void {
    const run = this.runs.get(key);
    if (!run) return;
    clearTimeout(run.timer);
    run.timer = undefined;
    this.save(run);
  }

  /** Write everything waiting (Beluga is quitting). */
  flushAll(): void {
    for (const key of this.runs.keys()) this.flush(key);
  }

  private run(key: string, create: boolean): Run | undefined {
    let run = this.runs.get(key) ?? this.load(key);
    if (!run && create) run = { key, order: [], records: new Map(), chars: 0, version: 0 };
    if (!run) return undefined;
    // Most recently used last: the first one is the one to forget.
    this.runs.delete(key);
    this.runs.set(key, run);
    while (this.runs.size > MEMORY_RUNS || (this.dir && this.runs.size > 1 && this.memoryChars() > MEMORY_CHARS)) {
      const [oldest] = this.runs.values();
      if (!oldest) break;
      this.flush(oldest.key);
      this.runs.delete(oldest.key);
    }
    return run;
  }

  private memoryChars(): number {
    let n = 0;
    for (const run of this.runs.values()) n += run.chars;
    return n;
  }

  private trim(run: Run): void {
    while (run.order.length > MAX_RUN_STEPS) {
      const id = run.order.shift()!;
      run.chars -= sizeOf(run.records.get(id)!);
      run.records.delete(id);
    }
    // Too much detail: the oldest steps keep their line, not their input and output.
    for (const id of run.order) {
      if (run.chars <= MAX_RUN_CHARS) break;
      const r = run.records.get(id)!;
      if (r.output === undefined && r.input === undefined && r.text === undefined && r.app?.structuredContent === undefined) continue;
      // An app keeps where it's drawn from, not its result.
      const app = r.app ? { app: { server: r.app.server, tool: r.app.tool, resourceUri: r.app.resourceUri } } : {};
      const light = { ...summaryOf(r), truncated: true, ...(r.isError ? { isError: true } : {}), ...app };
      run.chars += sizeOf(light) - sizeOf(r);
      run.records.set(id, light);
    }
  }

  private scheduleSave(run: Run): void {
    if (!this.dir || run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      this.saveLater(run);
    }, SAVE_DELAY_MS);
    run.timer.unref?.();
  }

  private madeDir = false;
  private prunedAt = 0;

  private text(run: Run): string {
    return JSON.stringify({ key: run.key, version: run.version, steps: run.order.map((id) => run.records.get(id)) });
  }

  private ensureDir(): void {
    if (this.madeDir) return;
    mkdirSync(this.dir!, { recursive: true, mode: 0o700 });
    this.madeDir = true;
  }

  /** Write a run now, all of it, before going on (a run ending, Beluga quitting). */
  private save(run: Run): void {
    if (!this.dir) return;
    try {
      this.ensureDir();
      const file = path.join(this.dir, fileName(run.key));
      if (run.saved === run.version && this.touch(file)) return;
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, this.text(run), { mode: 0o600 });
      renameSync(tmp, file);
      run.saved = run.version;
      this.pruneSoon();
    } catch {
      // Details are a nicety: a full disk must not stop Claude.
    }
  }

  /**
   * Write a run while it goes on (BLG-407): without holding up the daemon, one write per run at a
   * time (changes meanwhile are written right after it), and not at all when nothing changed.
   */
  private saveLater(run: Run): void {
    if (!this.dir || run.saved === run.version) return;
    if (run.writing) {
      run.again = true;
      return;
    }
    const version = run.version;
    const file = path.join(this.dir, fileName(run.key));
    const tmp = `${file}.${process.pid}.${version}.tmp`;
    run.writing = true;
    let text: string;
    try {
      this.ensureDir();
      text = this.text(run);
    } catch {
      run.writing = false;
      return;
    }
    void writeFile(tmp, text, { mode: 0o600 })
      .then(() => {
        // Written in full meanwhile (the run ended): that one is newer, and stays.
        if ((run.saved ?? -1) >= version) return void dropTmp(tmp);
        // Renamed here, on the daemon's thread, so it can never land after a newer full write.
        renameSync(tmp, file);
        run.saved = version;
        this.pruneSoon();
      })
      .catch(() => void dropTmp(tmp))
      .finally(() => {
        run.writing = false;
        if (run.again) {
          run.again = false;
          this.saveLater(run);
        }
      });
  }

  private load(key: string): Run | undefined {
    if (!this.dir) return undefined;
    try {
      const data = JSON.parse(readFileSync(path.join(this.dir, fileName(key)), 'utf8')) as { key?: string; version?: number; steps?: StepRecord[] };
      if (data.key !== key || !Array.isArray(data.steps)) return undefined;
      const steps = data.steps.filter((r): r is StepRecord => Boolean(r && typeof r.id === 'string' && typeof r.title === 'string'));
      const version = data.version ?? 1;
      return { key, order: steps.map((r) => r.id), records: new Map(steps.map((r) => [r.id, r])), chars: steps.reduce((n, r) => n + sizeOf(r), 0), version, ...(data.version !== undefined ? { saved: version } : {}) };
    } catch {
      return undefined;
    }
  }

  /**
   * The file already has this version: only its time is brought up to now, as writing it again
   * would (the oldest files are the ones to go) → false when it isn't there to touch.
   */
  private touch(file: string): boolean {
    try {
      const now = new Date();
      utimesSync(file, now, now);
      return true;
    } catch {
      return false;
    }
  }

  /** Clear out the oldest runs' files, at most once a minute (BLG-407), off the daemon's thread. */
  private pruneSoon(): void {
    if (!this.dir || Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = Date.now();
    void this.prune().catch(() => undefined);
  }

  private async prune(): Promise<void> {
    const dir = this.dir!;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    if (files.length <= DISK_RUNS) return;
    const dated = (await Promise.all(files.map(async (f) => ({ f, t: await stat(path.join(dir, f)).then((s) => s.mtimeMs, () => undefined) }))))
      .filter((d): d is { f: string; t: number } => d.t !== undefined)
      .sort((a, b) => a.t - b.t);
    // Removed in one go on the daemon's thread, each only if it wasn't written since it was looked at.
    for (const { f, t } of dated.slice(0, dated.length - DISK_RUNS)) {
      try {
        const file = path.join(dir, f);
        if (statSync(file).mtimeMs === t) unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  }
}

/** The book key for a run of your Claude (request ids are unique). */
export const runKey = (requestId: string): string => `run:${requestId}`;
/** The book key for a turn imported from a Claude Code transcript (its id is only unique within that transcript). */
export const importedKey = (sessionId: string, itemId: string): string => `imp:${sessionId}:${itemId}`;
