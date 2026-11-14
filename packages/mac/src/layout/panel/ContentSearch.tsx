import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentResults, LineMatch, NameResults } from '@beluga/core/workspace-files.js';
import { Icon } from '../../components/Icon.js';
import { cx } from '../../components/ui.js';
import { useBeluga } from '../../lib/beluga.js';
import { scrollWithin } from '../../lib/scroll-within.js';
import s from './panel.module.css';
import k from './content-search.module.css';

/**
 * The Files tab searching what's in the files (not their names): as you type, a moment after you
 * stop, the daemon asks ripgrep (a newer query stops the older one there, and late answers are
 * dropped here). Results come by file, each line with what matched marked; picking one opens the
 * file at that line.
 */

export interface SearchFlags {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeWord: boolean;
}

/** Shorter than this, a plain-text query would match nearly every line. */
export const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

export interface SearchState {
  readonly results?: ContentResults;
  /** The query the results are for. */
  readonly query?: string;
  readonly searching: boolean;
  readonly error?: string;
}

export function useContentSearch(wsId: string, query: string, flags: SearchFlags, on: boolean): SearchState {
  const { client } = useBeluga();
  const [state, setState] = useState<SearchState>({ searching: false });
  const seq = useRef(0);
  const q = query.trim() ? query : '';
  const key = `${wsId}\0${q}\0${flags.caseSensitive}\0${flags.regex}\0${flags.wholeWord}`;
  useEffect(() => {
    const mine = ++seq.current;
    if (!on || q.trim().length < (flags.regex ? 1 : MIN_QUERY)) {
      setState({ searching: false });
      return;
    }
    setState((st) => ({ ...st, searching: true }));
    const t = setTimeout(() => {
      client.api.files
        .searchContent(wsId, q, { ...flags, slot: 'files-tab' })
        .then((results) => {
          if (mine !== seq.current || results.cancelled) return;
          setState(results.error ? { searching: false, error: results.error, query: q } : { searching: false, results, query: q });
        })
        .catch((err: unknown) => mine === seq.current && setState({ searching: false, error: err instanceof Error ? err.message : String(err), query: q }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, on]);
  return state;
}

export interface NameSearchState {
  readonly results?: NameResults;
  readonly query?: string;
  readonly searching: boolean;
  readonly error?: string;
}

/** The Files tab filtering by name: every file in the folder whose path matches, from the daemon, a moment after you stop typing. */
export function useNameSearch(wsId: string, query: string, flags: SearchFlags, on: boolean): NameSearchState {
  const { client } = useBeluga();
  const [state, setState] = useState<NameSearchState>({ searching: false });
  const seq = useRef(0);
  const q = query.trim() ? query : '';
  const key = `${wsId}\0${q}\0${flags.caseSensitive}\0${flags.regex}\0${flags.wholeWord}`;
  useEffect(() => {
    const mine = ++seq.current;
    if (!on || !q) {
      setState({ searching: false });
      return;
    }
    setState((st) => ({ ...st, searching: true }));
    const t = setTimeout(() => {
      client.api.files
        .searchNames(wsId, flags.regex ? q : q.trim(), { ...flags, slot: 'files-tab' })
        .then((results) => {
          if (mine !== seq.current || results.cancelled) return;
          setState(results.error ? { searching: false, error: results.error, query: q } : { searching: false, results, query: q });
        })
        .catch((err: unknown) => mine === seq.current && setState({ searching: false, error: err instanceof Error ? err.message : String(err), query: q }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, on]);
  return state;
}

/** A preview line with what matched marked. */
function MarkedLine({ m }: { m: LineMatch }): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  m.ranges.forEach(([a, b], i) => {
    if (a > at) out.push(m.text.slice(at, a));
    out.push(
      <mark key={i} className={s.mark}>
        {m.text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < m.text.length) out.push(m.text.slice(at));
  return out;
}

/** The toggles at the end of the search box: Match Case, Whole Word, Regular Expression. */
export function FlagToggles({ flags, onChange }: { flags: SearchFlags; onChange: (f: SearchFlags) => void }) {
  const toggle = (flag: keyof SearchFlags, label: string, glyph: string) => (
    <button type="button" className={cx(k.flag, flags[flag] && k.flagOn)} aria-pressed={flags[flag]} aria-label={label} title={label} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange({ ...flags, [flag]: !flags[flag] })}>
      {glyph}
    </button>
  );
  return (
    <span className={k.flags}>
      {toggle('caseSensitive', 'Match Case', 'Aa')}
      {toggle('wholeWord', 'Whole Word', 'ab')}
      {toggle('regex', 'Regular Expression', '.*')}
    </span>
  );
}

interface Pick {
  readonly path: string;
  readonly line: number;
}

/** The results, by file; ↑↓ move, Return opens, ← → fold a file. */
export function ContentResultsList({ state, query, listRef, onOpen, onEscape }: { state: SearchState; query: string; listRef: RefObject<HTMLDivElement | null>; onOpen: (path: string, line: number) => void; onEscape: () => void }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<Pick>();
  const files = state.results?.files ?? [];
  useEffect(() => setFolded(new Set()), [state.results]);
  const picks = useMemo(() => files.flatMap((f) => (folded.has(f.path) ? [{ path: f.path, line: 0 }] : [{ path: f.path, line: 0 }, ...f.matches.map((m) => ({ path: f.path, line: m.line }))])), [files, folded]);
  const same = (a: Pick | undefined, b: Pick): boolean => a?.path === b.path && a.line === b.line;
  useEffect(() => {
    scrollWithin(listRef.current?.querySelector('[data-cursor="true"]'));
  }, [cursor]);

  const fold = (p: string, to?: boolean): void => {
    const next = new Set(folded);
    if (to ?? !next.has(p)) next.add(p);
    else next.delete(p);
    setFolded(next);
  };
  const onKey = (e: KeyboardEvent): void => {
    const i = picks.findIndex((p) => same(cursor, p));
    const move = (to: number): void => setCursor(picks[Math.max(0, Math.min(picks.length - 1, to))]);
    if (e.key === 'ArrowDown') (e.preventDefault(), move(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(i < 0 ? 0 : i - 1));
    else if (e.key === 'ArrowLeft' && cursor) (e.preventDefault(), fold(cursor.path, true), setCursor({ path: cursor.path, line: 0 }));
    else if (e.key === 'ArrowRight' && cursor && !cursor.line) (e.preventDefault(), fold(cursor.path, false));
    else if (e.key === 'Enter' && cursor) {
      e.preventDefault();
      if (cursor.line) onOpen(cursor.path, cursor.line);
      else fold(cursor.path);
    } else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onEscape());
  };

  const r = state.results;
  const note = state.error ? (
    <div className={cx(s.treeNote, k.error)}>{state.error}</div>
  ) : query.trim().length < MIN_QUERY && !r ? (
    <div className={s.treeNote}>Type to search in the files’ contents</div>
  ) : r && !r.count && !state.searching ? (
    <div className={s.treeNote}>No lines with “{state.query}”</div>
  ) : null;

  return (
    <div ref={listRef} className={cx(s.list, s.tree)} role="tree" aria-label="Lines found" aria-busy={state.searching} tabIndex={0} onKeyDown={onKey}>
      {r && r.count ? (
        <div className={k.summary} role="status">
          {r.count === 1 ? '1 line' : `${r.count.toLocaleString()} lines`} in {r.files.length === 1 ? '1 file' : `${r.files.length.toLocaleString()} files`}
          {r.truncated ? ' (the first ones)' : ''}
          {state.searching ? <Icon name="refresh" size={11} className={k.busy} /> : null}
        </div>
      ) : state.searching ? (
        <div className={s.treeNote}>Searching…</div>
      ) : null}
      {note}
      {files.map((f) => {
        const open = !folded.has(f.path);
        const name = f.path.split('/').pop() ?? f.path;
        const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
        const head = { path: f.path, line: 0 };
        return (
          <div key={f.path} role="group">
            <div
              role="treeitem"
              aria-level={1}
              aria-expanded={open}
              aria-selected={same(cursor, head)}
              data-cursor={same(cursor, head)}
              className={cx(s.row, s.treeRow, k.file, same(cursor, head) && s.rowOn)}
              title={f.path}
              onClick={() => (setCursor(head), fold(f.path))}
            >
              <span className={s.chevron}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={9} />
              </span>
              <Icon name="file" size={13} className={s.fileIcon} />
              <span className={k.name}>{name}</span>
              {dir ? <span className={k.dir}>{dir}</span> : null}
              <span className={s.flex} />
              <span className={k.count}>{f.matches.length}</span>
            </div>
            {open
              ? f.matches.map((m) => {
                  const pick = { path: f.path, line: m.line };
                  const on = same(cursor, pick);
                  return (
                    <div key={m.line} role="treeitem" aria-level={2} aria-selected={on} data-cursor={on} className={cx(s.row, k.line, on && s.rowOn)} title={`${f.path}:${m.line}`} onClick={() => (setCursor(pick), onOpen(f.path, m.line))}>
                      <span className={k.no}>{m.line}</span>
                      <span className={k.text}>
                        <MarkedLine m={m} />
                      </span>
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}
