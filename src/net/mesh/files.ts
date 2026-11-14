import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Small helpers for the network's files under ~/.beluga: everything is written readable only
 * by you (0600), whole files atomically (temp file, then rename), logs a line at a time.
 */

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * A JSON file kept in step with something large that changes often (BLG-942): the board, the
 * team's copy of it, an outbox, the plans. Written a moment after a change, once for every change
 * meanwhile, without holding up the daemon: the text is made on its thread (compact: these are
 * megabytes), the bytes go to disk off it, one write at a time (changes during one are written right
 * after it), and the finished file is renamed into place on the thread, so an older write can never
 * land after a newer one. `flush()` writes now, before going on (stopping, quitting, tests).
 * A write that fails (a full disk) is tried again on the next change.
 */
export class JsonFile {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private saved = 0;
  private writing = false;
  private again = false;

  constructor(
    private readonly file: string,
    /** What the file holds now (asked when it's written, so it's always the newest). */
    private readonly value: () => unknown,
    private readonly delayMs = 1000,
  ) {}

  /** Something changed: written soon. */
  changed(): void {
    this.version++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeLater();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** A change not written yet. */
  get pending(): boolean {
    return this.saved !== this.version;
  }

  /** Write it now, synchronously, if anything changed since the last write. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const version = this.version;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${version}.sync.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value()), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.saved = version;
  }

  private writeLater(): void {
    if (!this.pending) return;
    if (this.writing) {
      this.again = true;
      return;
    }
    const version = this.version;
    const tmp = `${this.file}.${process.pid}.${version}.tmp`;
    let text: string;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      text = JSON.stringify(this.value());
    } catch {
      return;
    }
    this.writing = true;
    void writeFile(tmp, text, { mode: 0o600 })
      .then(() => {
        // Written in full meanwhile (flush): that one is newer, and stays.
        if (this.saved >= version) return void rm(tmp, { force: true }).catch(() => undefined);
        renameSync(tmp, this.file);
        this.saved = version;
      })
      .catch(() => void rm(tmp, { force: true }).catch(() => undefined))
      .finally(() => {
        this.writing = false;
        if (this.again) {
          this.again = false;
          this.writeLater();
        }
      });
  }
}

/** Every line of a JSON-lines file that parses (a torn last line after a crash is skipped). */
export function readLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function appendLine(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** Rewrite a JSON-lines file in one go (used to compact or drop entries). */
export function writeLines(file: string, values: readonly unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, values.map((v) => `${JSON.stringify(v)}\n`).join(''), { mode: 0o600 });
  renameSync(tmp, file);
}

/** JSON with keys in a fixed order, so the same value always hashes and signs the same. */
export function canonical(value: unknown, depth = 0): string {
  // Nothing Beluga writes nests this deep; refusing it keeps hostile input from blowing the stack.
  if (depth > 32) throw new Error('Too deeply nested');
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(',')}}`;
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** A file name safe for an id we didn't make ourselves. */
export const safeName = (id: string): string => id.replace(/[^\w-]/g, '_').slice(0, 80);
