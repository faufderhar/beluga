import * as Popover from '@radix-ui/react-popover';
import { type ChangeEvent, type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { OptionIcon, type SelectEntry, type SelectOption, useTypeahead } from './select-parts.js';
import { type MoveKey, type Placement, filterEntries, firstEnabled, flatOptions, menuRows, moveActive, placeMenu, typeahead } from './select-model.js';
import { cx } from './ui.js';
import s from './select.module.css';

interface MenuProps<T extends string> {
  readonly listId: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly SelectEntry<T>[];
  readonly search: boolean;
  readonly searchPlaceholder?: string | undefined;
  readonly mono?: boolean | undefined;
  readonly size: 'regular' | 'small' | 'large';
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly pressed: RefObject<{ x: number; y: number } | null>;
  readonly onChoose: (value: T) => void;
  readonly onClose: () => void;
}

const MOVES: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'] satisfies MoveKey[];
/** How far the pointer has to travel after pressing the button for letting go over a row to pick it. */
const DRAG = 4;

/** The chosen option, or the first you can pick. */
function startAt<T extends string>(options: readonly SelectOption<T>[], value: T): number {
  const at = options.findIndex((o) => o.value === value && !o.disabled);
  return at >= 0 ? at : firstEnabled(options, 0, 1);
}

/** Scrolls a row into its list's view (`center` when the menu opens), never the page. */
function reveal(list: HTMLElement | null, row: HTMLElement | null | undefined, center = false): void {
  if (!list || !row) return;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (center) list.scrollTop = top - list.clientHeight / 2 + row.offsetHeight / 2;
  else if (top < list.scrollTop) list.scrollTop = top - 4;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
}

/** The open menu of a Select (mounted while open, so each opening starts fresh). */
export function SelectMenu<T extends string>(p: MenuProps<T>) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterEntries(p.options, query), [p.options, query]);
  const rows = useMemo(() => menuRows(shown), [shown]);
  const opts = useMemo(() => flatOptions(shown), [shown]);
  const [active, setActive] = useState(() => startAt(opts, p.value));
  const [place, setPlace] = useState<Placement & { alignOffset: number }>();
  /** Once it's open below (or flipped above), it stays there while you filter, at the same height above. */
  const [locked, setLocked] = useState<{ side: 'top' | 'bottom'; height: number }>();
  const content = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const outside = useRef(false);
  const type = useTypeahead();
  const optionId = (i: number): string => `${p.listId}-o${i}`;
  const rowAt = (i: number): HTMLElement | null => (i >= 0 ? document.getElementById(optionId(i)) : null);

  // Measure once, then place: the chosen row over the button when the menu fits that way, its text
  // lined up with the button's; else below.
  useLayoutEffect(() => {
    const menu = content.current;
    const button = p.trigger.current;
    if (!menu || !button) return;
    const m = menu.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const chosen = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const c = chosen?.getBoundingClientRect();
    const placement = placeMenu({ triggerTop: b.top, triggerHeight: b.height, menuHeight: m.height, selectedTop: c ? c.top - m.top : undefined, selectedHeight: c?.height, viewportHeight: window.innerHeight, search: p.search, margin: 10 });
    let alignOffset = 0;
    if (placement.mode === 'over' && chosen) {
      const text = button.querySelector('[data-select-text]')?.getBoundingClientRect();
      const label = chosen.querySelector('[data-option-label]')?.getBoundingClientRect();
      if (text && label) alignOffset = Math.round(text.left - b.left - (label.left - m.left));
    }
    setPlace({ ...placement, alignOffset });
  }, []);

  // Dropped below (a long list): open with the chosen row in view.
  useLayoutEffect(() => {
    if (place?.mode === 'below') reveal(list.current, rowAt(active), true);
  }, [place]);
  useEffect(() => {
    if (place) reveal(list.current, rowAt(active));
  }, [active]);
  // Opened before its options came (a project's branches): once there are enough for a field, the
  // focus goes to it, as it would have on opening (unless you've moved it since).
  useEffect(() => {
    if (p.search && document.activeElement === list.current) field.current?.focus({ preventScroll: true });
  }, [p.search]);
  useEffect(() => {
    if (place?.mode !== 'below') return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const menu = content.current;
        if (menu) setLocked({ side: menu.dataset.side === 'top' ? 'top' : 'bottom', height: menu.offsetHeight });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [place]);

  // Press-drag-release only counts for the press that opened the menu.
  useEffect(() => {
    const done = (): void => {
      p.pressed.current = null;
    };
    document.addEventListener('pointerup', done);
    return () => document.removeEventListener('pointerup', done);
  }, []);

  const pick = (i: number): void => {
    const o = opts[i];
    if (o && !o.disabled) p.onChoose(o.value);
  };
  const filter = (e: ChangeEvent<HTMLInputElement>): void => {
    const q = e.target.value;
    const next = flatOptions(filterEntries(p.options, q));
    setQuery(q);
    setActive(q.trim() ? firstEnabled(next, 0, 1) : startAt(next, p.value));
    if (list.current) list.current.scrollTop = 0;
  };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const k = e.key;
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (MOVES.includes(k)) {
      // In the search field, Home and End move the caret.
      if (p.search && (k === 'Home' || k === 'End')) return;
      handled();
      setActive((a) => moveActive(opts, a, k as MoveKey));
    } else if (k === 'Enter' || (k === ' ' && !p.search)) {
      handled();
      pick(active);
    } else if (k === 'Tab') {
      handled();
      p.onClose();
    } else if (!p.search && k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handled();
      const at = typeahead(opts, type(k), active);
      if (at >= 0) setActive(at);
    }
  };

  return (
    <Popover.Content
      ref={content}
      role="presentation"
      className={cx(s.menu, p.size === 'small' && s.menuSmall, p.mono && s.mono)}
      data-placed={place ? '' : undefined}
      data-mode={place?.mode}
      side={locked?.side ?? 'bottom'}
      style={locked?.side === 'top' ? { minHeight: locked.height } : undefined}
      align="start"
      sideOffset={place?.sideOffset ?? 4}
      alignOffset={place?.alignOffset ?? 0}
      collisionPadding={8}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        (p.search ? field.current : list.current)?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(e) => {
        // Back to the button, unless you clicked somewhere else to close it.
        e.preventDefault();
        if (!outside.current) p.trigger.current?.focus({ preventScroll: true });
      }}
      onInteractOutside={(e) => {
        // The button toggles the menu itself.
        if (p.trigger.current?.contains(e.target as Node)) e.preventDefault();
        else outside.current = true;
      }}
      onEscapeKeyDown={(e) => {
        // A Mac search field: Esc clears it first.
        if (query) {
          e.preventDefault();
          setQuery('');
          setActive(startAt(flatOptions(p.options), p.value));
        } else p.trigger.current?.focus({ preventScroll: true });
      }}
      onKeyDown={keyDown}
    >
      {p.search ? (
        <div className={s.searchRow}>
          <Icon name="search" size={12} />
          <input
            ref={field}
            className={s.search}
            type="text"
            aria-label="Filter the list"
            aria-controls={p.listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            placeholder={p.searchPlaceholder ?? 'Search'}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={filter}
          />
        </div>
      ) : null}
      <div
        ref={list}
        id={p.listId}
        role="listbox"
        aria-label={p.label}
        tabIndex={p.search ? -1 : 0}
        aria-activedescendant={!p.search && active >= 0 ? optionId(active) : undefined}
        className={s.list}
        // Clicking a row leaves the focus where it is (the search field).
        onMouseDown={(e) => e.preventDefault()}
      >
        {rows.map((r) => {
          if (r.kind === 'separator') return <div key={r.key} role="separator" className={s.separator} />;
          if (r.kind === 'header') {
            return (
              <div key={r.key} role="presentation" className={s.header}>
                {r.label}
              </div>
            );
          }
          const o = r.option;
          const id = optionId(r.index);
          const selected = o.value === p.value;
          return (
            <div
              key={`${o.value}-${r.index}`}
              id={id}
              role="option"
              aria-selected={selected}
              aria-disabled={o.disabled || undefined}
              aria-labelledby={`${id}-l`}
              aria-describedby={o.description ? `${id}-d` : undefined}
              data-active={r.index === active || undefined}
              className={cx(s.option, o.description && s.twoLine)}
              onPointerMove={() => !o.disabled && r.index !== active && setActive(r.index)}
              onPointerLeave={() => setActive(-1)}
              onPointerUp={(e) => {
                const from = p.pressed.current;
                if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG) pick(r.index);
              }}
              onClick={() => pick(r.index)}
            >
              <span className={s.check}>{selected ? <Icon name="check" size={11} strokeWidth={2.2} data-check="" /> : null}</span>
              {o.icon ? (
                <span className={s.optionIcon}>
                  <OptionIcon icon={o.icon} size={p.size === 'small' ? 12 : 13} />
                </span>
              ) : null}
              <span className={s.optionText}>
                <span id={`${id}-l`} className={s.optionLabel} data-option-label="">
                  {o.label}
                </span>
                {o.description ? (
                  <span id={`${id}-d`} className={s.optionDescription}>
                    {o.description}
                  </span>
                ) : null}
              </span>
              {o.badge ? <span className={s.badge}>{o.badge}</span> : null}
            </div>
          );
        })}
        {opts.length ? null : <div className={s.empty}>{query ? 'No matches' : 'Nothing to choose'}</div>}
      </div>
    </Popover.Content>
  );
}
