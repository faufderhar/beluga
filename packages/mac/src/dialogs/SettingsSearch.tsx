import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { type SettingsPane, useApp } from '../lib/beluga.js';
import { type PaneResults, SETTINGS_FIND_EVENT, type SettingHit, flatHits, hitAnchors, searchSettings } from '../lib/settings-search.js';
import { PANES, SETTINGS, THREAD_LIMITS_GROUP } from './settings-index.js';
import s from './settings.module.css';
import { locale, t } from '../i18n/index.js';

type Pane = (typeof PANES)[number];
type Hit = SettingHit<SettingsPane>;

const LIST_ID = 'settings-search-results';
const optionId = (i: number): string => `settings-hit-${i}`;
/** How long the row found stays lit, and how long the jump waits for a pane that loads its rows. */
const FOUND_MS = 1800;
const WAIT_MS = 700;

export interface SettingsSearch {
  readonly field: RefObject<HTMLInputElement | null>;
  readonly query: string;
  /** Words typed and no result opened since: the results show instead of the pane. */
  readonly showing: boolean;
  readonly results: readonly PaneResults<SettingsPane>[];
  readonly hits: readonly Hit[];
  readonly active: number;
  /** The panes with a match, the others dim in the sidebar while words are typed. */
  readonly matched: ReadonlySet<SettingsPane>;
  readonly type: (query: string) => void;
  readonly move: (to: number) => void;
  readonly pick: (hit: Hit) => void;
  /** A pane picked in the sidebar: it shows, the words stay. */
  readonly browse: () => void;
  readonly clear: () => void;
}

/**
 * Settings' search (BLG-740): the words typed, the results, the one ↑/↓ is on, and the jump to a
 * row once one is picked (its pane opens, the row scrolls into view, lights up and takes focus).
 */
/** In another language, a row is found by its words there too (src/i18n), as the page shows them. */
function inLanguage<T extends { readonly label: string; readonly detail?: string | undefined; readonly keywords?: string | undefined }>(e: T): T {
  if (locale() === 'en') return e;
  return { ...e, keywords: [e.keywords ?? '', t(e.label), e.detail ? t(e.detail) : ''].join(' ') };
}

export function useSettingsSearch(panes: readonly Pane[], pane: SettingsPane, open: (pane: SettingsPane) => void, scroll: RefObject<HTMLElement | null>): SettingsSearch {
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [active, setActive] = useState(0);
  const [jump, setJump] = useState<{ hit: Hit; at: number }>();
  // Thread limits show with agent threads on, in the pane and here.
  const threadsOn = useApp((st) => st.prefs.agentThreads ?? false);
  const results = useMemo(() => {
    const entries = threadsOn ? SETTINGS : SETTINGS.filter((e) => e.group !== THREAD_LIMITS_GROUP);
    return searchSettings(query, entries.map(inLanguage), panes.map(inLanguage));
  }, [query, panes, threadsOn]);
  const hits = useMemo(() => flatHits(results), [results]);
  const matched = useMemo(() => new Set(results.map((r) => r.pane.id)), [results]);

  // ⌘F focuses the field, its words selected to type over.
  useEffect(() => {
    const find = (): void => {
      field.current?.focus();
      field.current?.select();
    };
    document.addEventListener(SETTINGS_FIND_EVENT, find);
    return () => document.removeEventListener(SETTINGS_FIND_EVENT, find);
  }, []);

  useEffect(() => {
    if (!jump || jump.hit.pane !== pane || !scroll.current) return;
    return revealSetting(scroll.current, jump.hit);
  }, [jump, pane]);

  return {
    field,
    query,
    showing: query.trim() !== '' && !browsing,
    results,
    hits,
    active: Math.min(active, Math.max(0, hits.length - 1)),
    matched,
    type: (q) => {
      setQuery(q);
      setBrowsing(false);
      setActive(0);
    },
    move: (to) => setActive(hits.length ? (to + hits.length) % hits.length : 0),
    pick: (hit) => {
      setBrowsing(true);
      open(hit.pane);
      setJump({ hit, at: Date.now() });
    },
    browse: () => setBrowsing(true),
    clear: () => {
      setQuery('');
      setBrowsing(false);
      setActive(0);
      field.current?.focus();
    },
  };
}

/**
 * Scroll a pane to a hit's row (or, when that row isn't showing, its group), light it up for a
 * moment and move focus there: its first control, or the row itself. A pane that loads its rows
 * gets a moment; a hit with no anchor (a whole pane) opens at the top. Returns the cleanup.
 */
export function revealSetting(container: HTMLElement, hit: Hit): () => void {
  const anchors = hitAnchors(hit);
  const started = performance.now();
  let frame = 0;
  let unlight: ReturnType<typeof setTimeout> | undefined;
  let settle: ResizeObserver | undefined;
  const find = (kinds: ReadonlyArray<'row' | 'group'>): HTMLElement | null => {
    for (const a of anchors) {
      if (!kinds.includes(a.kind)) continue;
      const el = container.querySelector<HTMLElement>(a.kind === 'row' ? `[data-setting="${a.anchor}"]` : `[data-setting-group="${a.anchor}"]`);
      if (el) return el;
    }
    return null;
  };
  const land = (el: HTMLElement | null): void => {
    if (!el) {
      container.scrollTop = 0;
      return;
    }
    const still = document.documentElement.dataset.motion === 'reduce';
    el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    el.setAttribute('data-found', '');
    // Rows above it that load late push it down: while it's lit, it's scrolled to again.
    if (typeof ResizeObserver !== 'undefined') {
      let first = true;
      // (Its first call is only the sizes they have now: the scroll above is under way.)
      settle = new ResizeObserver(() => (first ? (first = false) : el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })));
      for (const part of container.children) settle.observe(part);
    }
    unlight = setTimeout(() => {
      el.removeAttribute('data-found');
      settle?.disconnect();
    }, FOUND_MS);
    const control = el.matches('[data-setting]') ? el.querySelector<HTMLElement>('input:not([type="hidden"]):not([hidden]), button:not([disabled]), select, textarea, [tabindex="0"]') : null;
    if (control) control.focus({ preventScroll: true });
    else {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }
  };
  const look = (): void => {
    const row = find(['row']);
    if (row || !anchors.some((a) => a.kind === 'row') || performance.now() - started > WAIT_MS) return land(row ?? find(['group']));
    frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => {
    cancelAnimationFrame(frame);
    if (unlight) clearTimeout(unlight);
    settle?.disconnect();
  };
}

/** The field at the top of Settings' sidebar: ↑/↓ move through the results, Return opens one. */
export function SettingsSearchField({ search }: { search: SettingsSearch }) {
  const { field, query, showing, hits, active } = search;
  return (
    <label className={s.search}>
      <Icon name="search" size={12} />
      <input
        ref={field}
        type="text"
        role="combobox"
        aria-label="Search settings"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={LIST_ID}
        {...(showing && hits[active] ? { 'aria-activedescendant': optionId(active) } : {})}
        placeholder="Search"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => search.type(e.target.value)}
        onFocus={() => (query ? search.type(query) : undefined)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            search.move(active + (e.key === 'ArrowDown' ? 1 : -1));
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault();
            search.pick(hits[active]);
          }
        }}
      />
      {query ? (
        <button type="button" className={s.searchClear} aria-label="Clear the search" onClick={search.clear}>
          <Icon name="x" size={10} />
        </button>
      ) : null}
    </label>
  );
}

/** The results, grouped by pane, where the pane shows while words are typed; or that nothing matches. */
export function SettingsSearchResults({ search, panes }: { search: SettingsSearch; panes: readonly Pane[] }) {
  const { results, hits, active, query } = search;
  const list = useRef<HTMLDivElement>(null);
  // Keep the one ↑/↓ is on in view.
  useEffect(() => {
    list.current?.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const count = hits.length;
  return (
    <>
      {/* Read out as it changes: how many were found, or (shown too) that nothing matches. */}
      <div className={count ? s.srOnly : s.searchEmpty} role="status">
        {count ? (
          `${count} ${count === 1 ? 'setting' : 'settings'} found`
        ) : (
          <>
            <Icon name="search" size={18} />
            No settings match “{query.trim()}”
          </>
        )}
      </div>
      <div ref={list} id={LIST_ID} role="listbox" aria-label="Settings found" className={s.results} hidden={!count}>
        {results.map((r) => {
          const icon = panes.find((p) => p.id === r.pane.id)?.icon ?? 'gear';
          const headId = `${LIST_ID}-${r.pane.id}`;
          return (
            <div key={r.pane.id} role="group" aria-labelledby={headId} className={s.resultGroup}>
              <div id={headId} className={s.resultPane}>
                <Icon name={icon} size={12} />
                {r.pane.label}
              </div>
              {r.hits.map((hit) => {
                const i = hits.indexOf(hit);
                const where = hit.entry?.group && hit.entry.group !== hit.label ? hit.entry.group : undefined;
                return (
                  <div
                    key={hit.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    aria-label={`${r.pane.label} › ${hit.label}`}
                    {...(hit.detail ? { 'aria-description': hit.detail } : {})}
                    className={cx(s.result, i === active && s.resultOn)}
                    // The field keeps focus: ↑/↓ and Return still work after a hover.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i !== active && search.move(i)}
                    onClick={() => search.pick(hit)}
                  >
                    <span className={s.resultLabel}>
                      {where ? <span className={s.resultWhere}>{where} › </span> : null}
                      {hit.label}
                    </span>
                    {hit.detail ? <span className={s.resultDetail}>{hit.detail}</span> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
