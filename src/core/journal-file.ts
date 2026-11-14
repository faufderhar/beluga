import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readLines } from '../net/mesh/files.js';

/**
 * Something big that changes a little at a time, kept on disk as a snapshot (`<name>.json`) and a
 * journal (`<name>.log`) of what changed since (BLG-942): the board (core/board/board-file.ts), the
 * team's copy of it (core/team/board-sync.ts). A change writes only the records it touched, a line
 * each, never the whole thing: these are megabytes, and rewriting them a few times a second was
 * most of what saving cost.
 *
 * What's kept is records by key (a task each), plus a little else (`meta`: a board's settings, the
 * team's clocks) written whole when it changes. Records are compared by identity: their owner
 * replaces a record to change it, never edits one in place.
 *
 * Every journal line has a sequence number; the snapshot says which it covers. Now and then (the
 * journal grew past half the snapshot, and 2 MB) the journal is folded in: it's set aside
 * (`<name>.log.<seq>`), a new snapshot is written in the background and renamed into place, and
 * what was set aside is removed. `flush` (quitting) writes the snapshot whole. Reading takes the
 * snapshot and replays every journal line it doesn't cover, in order, so a crash at any moment
 * loses nothing that was written: at worst a line is replayed over a snapshot that already had it.
 */

/** Fold the journal in once it's past half the snapshot, and at least this big. */
export const FOLD_MIN_BYTES = 2_000_000;

export interface JournalShape<R> {
  /** The records now, by key, in order. */
  readonly records: () => Iterable<readonly [string, R]>;
  /** The rest, small (compared as JSON, written whole when it changes). */
  readonly meta: () => unknown;
  /** A record as written, with its key (default: the record as it is). */
  readonly pack?: (record: R, key: string) => unknown;
  /** A written record's key (its line in the journal says only the record). */
  readonly keyOf: (written: unknown) => string | undefined;
  /** The snapshot file's contents (each file keeps its own format). */
  readonly toSnapshot: (meta: unknown, records: readonly unknown[], seq: number) => unknown;
  /** A snapshot read back: its meta, its records as written, and the journal line it covers. */
  readonly fromSnapshot: (raw: Record<string, unknown>) => { readonly meta: unknown; readonly records: readonly unknown[]; readonly seq: number };
}

/** What was read: undefined meta/records when there was nothing; `raw` undefined when the snapshot can't be read. */
export interface JournalRead {
  /** The snapshot as it was (the file's own shape), before the journal is replayed; undefined: unreadable. */
  readonly raw: Record<string, unknown> | undefined;
  readonly meta: unknown;
  /** Every record as written, in order, after the journal. */
  readonly records: readonly unknown[];
  /** The snapshot or a journal line has `flag` in its text (BoardFile: names from before the rename). */
  readonly flagged: boolean;
}

type Line = { readonly s: number } & ({ readonly m: unknown } | { readonly u: unknown } | { readonly d: string });

export class JournalFile<R> {
  private readonly snapshot: string;
  private readonly journal: string;
  /** The records as last written, by key (by identity). */
  private readonly saved = new Map<string, R>();
  private savedMeta: string | undefined;
  private seq = 0;
  private journalBytes = 0;
  private snapshotBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Snapshots begun: a background one finishing after a newer one (quitting) is dropped. */
  private snapshots = 0;
  private folding = false;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly shape: JournalShape<R>,
    private readonly delayMs = 300,
    private readonly foldMinBytes = FOLD_MIN_BYTES,
  ) {
    this.snapshot = path.join(dir, `${name}.json`);
    this.journal = path.join(dir, `${name}.log`);
  }

  /** The snapshot with every later journal line replayed over it. undefined: nothing saved yet. */
  read(flag?: string): JournalRead | undefined {
    const journals = this.journals();
    let snap: Record<string, unknown> | undefined;
    let flagged = false;
    try {
      const text = readText(this.snapshot);
      if (text !== undefined) {
        this.snapshotBytes = text.length;
        if (flag) flagged = text.includes(flag);
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { raw: undefined, meta: undefined, records: [], flagged };
        snap = parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: undefined, meta: undefined, records: [], flagged };
    }
    if (!snap && !journals.length) return undefined;
    const base = snap ? this.shape.fromSnapshot(snap) : { meta: undefined, records: [], seq: 0 };
    const records = [...base.records];
    let meta = base.meta;
    const at = new Map<string, number>();
    records.forEach((r, n) => {
      const key = this.shape.keyOf(r);
      if (key !== undefined) at.set(key, n);
    });
    const lines = journals.flatMap((f) => readLines(f) as Line[]).filter((l) => l && typeof l.s === 'number' && l.s > base.seq);
    lines.sort((a, b) => a.s - b.s);
    if (flag && !flagged) flagged = lines.some((l) => JSON.stringify(l).includes(flag));
    this.seq = Math.max(base.seq, lines.at(-1)?.s ?? 0);
    for (const l of lines) {
      if ('m' in l) meta = l.m;
      else if ('u' in l) {
        const key = this.shape.keyOf(l.u);
        if (key === undefined) continue;
        const n = at.get(key);
        if (n === undefined) {
          at.set(key, records.length);
          records.push(l.u);
        } else records[n] = l.u;
      } else if ('d' in l && typeof l.d === 'string') {
        const n = at.get(l.d);
        if (n !== undefined) records[n] = undefined;
        at.delete(l.d);
      }
    }
    this.journalBytes = lines.reduce((sum, l) => sum + JSON.stringify(l).length + 1, 0);
    return { raw: snap ?? {}, meta, records: records.filter((r) => r !== undefined), flagged };
  }

  /** What's held now is what's on disk (after reading it): only changes from here are written. */
  baseline(): void {
    this.saved.clear();
    for (const [key, r] of this.shape.records()) this.saved.set(key, r);
    this.savedMeta = JSON.stringify(this.shape.meta() ?? null);
  }

  /** Something changed: written soon (once for every change meanwhile). */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeChanges();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Quitting: all of it, in one snapshot, now; the journal goes. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writeChanges();
    const journals = this.journals();
    if (!journals.length) return;
    const text = this.snapshotText();
    this.snapshots++;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.snapshot}.${process.pid}.sync.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.snapshot);
    this.snapshotBytes = text.length;
    for (const f of journals) rmSync(f, { force: true });
    this.journalBytes = 0;
  }

  /** Set aside with a snapshot that couldn't be read: its journal can't be read without it. */
  setAside(suffix: string): void {
    for (const f of this.journals()) renameSync(f, `${f}.${suffix}`);
  }

  private journals(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const set = new RegExp(`^${this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.log\\.\\d+$`);
    // The one being written, and any set aside for a fold that hasn't finished (<name>.log.<seq>).
    return names.filter((n) => n === `${this.name}.log` || set.test(n)).map((n) => path.join(this.dir, n));
  }

  private line(l: Omit<Line, 's'>): string {
    return JSON.stringify({ s: ++this.seq, ...l });
  }

  private pack(r: R, key: string): unknown {
    return this.shape.pack ? this.shape.pack(r, key) : r;
  }

  /** The records that changed (and the meta, and the ones gone) since the last write, as journal lines. */
  private writeChanges(): void {
    const lines: string[] = [];
    const meta = JSON.stringify(this.shape.meta() ?? null);
    const metaWas = this.savedMeta;
    if (meta !== this.savedMeta) {
      lines.push(this.line({ m: JSON.parse(meta) as unknown }));
      this.savedMeta = meta;
    }
    const here = new Set<string>();
    const wrote: string[] = [];
    const gone: Array<[string, R]> = [];
    for (const [key, r] of this.shape.records()) {
      here.add(key);
      if (this.saved.get(key) === r) continue;
      lines.push(this.line({ u: this.pack(r, key) }));
      this.saved.set(key, r);
      wrote.push(key);
    }
    for (const [key, was] of [...this.saved]) {
      if (here.has(key)) continue;
      lines.push(this.line({ d: key }));
      this.saved.delete(key);
      gone.push([key, was]);
    }
    if (!lines.length) return;
    const text = `${lines.join('\n')}\n`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.journal, text, { mode: 0o600 });
      this.journalBytes += text.length;
    } catch {
      // A full disk: what didn't go is written with the next change (it's still not what was saved).
      for (const key of wrote) this.saved.delete(key);
      for (const [key, was] of gone) this.saved.set(key, was);
      this.savedMeta = metaWas;
      return;
    }
    if (this.journalBytes > Math.max(this.foldMinBytes, this.snapshotBytes / 2)) this.fold();
  }

  /** Fold the journal into a new snapshot, in the background. */
  private fold(): void {
    if (this.folding) return;
    const set = `${this.journal}.${this.seq}`;
    try {
      renameSync(this.journal, set);
    } catch {
      return;
    }
    const covers = this.journals().filter((f) => f !== this.journal);
    this.journalBytes = 0;
    this.folding = true;
    const mine = ++this.snapshots;
    const text = this.snapshotText();
    const tmp = `${this.snapshot}.${process.pid}.${this.seq}.tmp`;
    void writeFile(tmp, text, { mode: 0o600 })
      .then(() => {
        // A newer snapshot was written meanwhile (quitting): that one stays.
        if (this.snapshots !== mine) return void rm(tmp, { force: true }).catch(() => undefined);
        renameSync(tmp, this.snapshot);
        this.snapshotBytes = text.length;
        for (const f of covers) rmSync(f, { force: true });
      })
      .catch(() => void rm(tmp, { force: true }).catch(() => undefined))
      .finally(() => {
        this.folding = false;
      });
  }

  /** All of it as a snapshot covering every journal line so far. */
  private snapshotText(): string {
    const records = [...this.shape.records()].map(([key, r]) => this.pack(r, key));
    return JSON.stringify(this.shape.toSnapshot(this.shape.meta(), records, this.seq));
  }
}

/** A file's text; undefined when it isn't there (any other failure throws: it's there and can't be read). */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
