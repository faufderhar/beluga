import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import { IconButton } from '../ui.js';
import { rangesIn, scrollParent } from './md-dom.js';
import f from '../../chat/find.module.css';
import { chordLabel } from '../../lib/shortcuts-model.js';

type HighlightCtor = new (...ranges: Range[]) => unknown;
const registry = (): Map<string, unknown> | undefined => (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
const HighlightClass = (): HighlightCtor | undefined => (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

/** Mark every match, and the current one more strongly (the same marks as Find in a conversation). */
function paint(ranges: readonly Range[], current: number): void {
  const reg = registry();
  const H = HighlightClass();
  if (!reg || !H) return;
  if (!ranges.length) {
    reg.delete('beluga-find');
    reg.delete('beluga-find-current');
    return;
  }
  reg.set('beluga-find', new H(...ranges.filter((_r, i) => i !== current)));
  reg.set('beluga-find-current', new H(...(ranges[current] ? [ranges[current]] : [])));
}

/** Scroll the page so a match sits a third of the way down, unless it's already in view. */
function reveal(range: Range, within: HTMLElement): void {
  const root = scrollParent(within);
  if (!root) return;
  const box = range.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  if (box.top >= view.top + 40 && box.bottom <= view.bottom - 40) return;
  root.scrollTo({ top: root.scrollTop + box.top - view.top - view.height / 3 });
  // Sideways too, for long code lines.
  const pre = (range.startContainer.parentElement ?? within).closest('pre');
  if (pre && pre.scrollWidth > pre.clientWidth) {
    const p = pre.getBoundingClientRect();
    if (box.left < p.left || box.right > p.right) pre.scrollLeft += box.left - p.left - p.width / 3;
  }
}

/**
 * Find in this file (⌘F, as in Safari): every match marked, Return / ⌘G for the next one,
 * ⇧Return / ⇧⌘G for the one before, Esc to close. `version` changes when the file's text does.
 */
export function DocFind({ root, version }: { root: RefObject<HTMLElement | null>; version: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [ranges, setRanges] = useState<readonly Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const show = (): void => {
      setOpen(true);
      requestAnimationFrame(() => input.current?.select());
    };
    const step = (e: Event): void => {
      const delta = (e as CustomEvent<number>).detail || 1;
      setOpen(true);
      setAt((a) => a + delta);
    };
    document.addEventListener('beluga:find', show);
    document.addEventListener('beluga:find-step', step);
    return () => {
      document.removeEventListener('beluga:find', show);
      document.removeEventListener('beluga:find-step', step);
    };
  }, []);

  // Look again when the words or the file change (async parts, like diagrams, draw a bit later).
  useLayoutEffect(() => {
    const el = root.current;
    const q = query.trim();
    if (!open || !el || !q) return setRanges([]);
    const look = (): void => setRanges(rangesIn(el, q));
    look();
    const later = setTimeout(look, 400);
    return () => clearTimeout(later);
  }, [open, query, version]);

  const count = ranges.length;
  const current = count ? ((at % count) + count) % count : 0;
  useLayoutEffect(() => {
    paint(open ? ranges : [], current);
    const r = ranges[current];
    if (open && r && root.current) reveal(r, root.current);
  }, [ranges, current, open]);
  useEffect(() => () => paint([], 0), []);

  if (!open) return null;
  const close = (): void => {
    setOpen(false);
    setAt(0);
    // Back to reading: the page takes the keyboard (Space, Page Down).
    const page = root.current ? scrollParent(root.current) : undefined;
    page?.focus({ preventScroll: true });
  };
  return (
    <div className={f.bar} role="search" aria-label="Find in this file">
      <Icon name="search" size={13} className={f.glass} />
      <input
        ref={input}
        autoFocus
        className={`${f.input} selectable`}
        placeholder="Find in this file"
        aria-label="Find in this file"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            setAt((a) => a + (e.shiftKey ? -1 : 1));
          }
        }}
      />
      <span className={f.count} aria-live="polite">
        {query.trim() ? (count ? `${current + 1} of ${count}` : 'No matches') : ''}
      </span>
      <span className={f.steps}>
        <IconButton size="small" icon="chevronUp" label="Previous match" keys={chordLabel('Shift+Cmd+G')} disabled={!count} onClick={() => setAt((a) => a - 1)} />
        <IconButton size="small" icon="chevronDown" label="Next match" keys={chordLabel('Cmd+G')} disabled={!count} onClick={() => setAt((a) => a + 1)} />
      </span>
      <button type="button" className={f.done} onClick={close}>
        Done
      </button>
    </div>
  );
}
