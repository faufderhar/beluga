import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogItem } from '@beluga/core/store.js';
import { Icon } from '../components/Icon.js';
import { IconButton } from '../components/ui.js';
import s from './find.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';

/** The words of one conversation item that Find looks through. */
function searchable(item: LogItem): string {
  switch (item.type) {
    case 'chat':
    case 'system':
      return item.text;
    case 'agent':
      return `${item.text}\n${item.steps.join('\n')}`;
    case 'shell':
      return `${item.command}\n${item.output ?? ''}`;
    default:
      return '';
  }
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
const highlights = (): Map<string, unknown> | undefined => (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
const Highlight = (): HighlightCtor | undefined => (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

/** Every place `query` appears in the text under `root` (case-insensitive). */
function rangesIn(root: Element, query: string): Range[] {
  const q = query.toLowerCase();
  const out: Range[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(q); at >= 0 && q; at = text.indexOf(q, at + q.length)) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      out.push(r);
    }
  }
  return out;
}

/** Mark the matches on screen (the current item's more strongly), where the browser can. */
function paint(log: HTMLElement | null, query: string, current: number | undefined): void {
  const reg = highlights();
  const H = Highlight();
  if (!reg || !H) return;
  if (!log || !query) {
    reg.delete('beluga-find');
    reg.delete('beluga-find-current');
    return;
  }
  const all: Range[] = [];
  const now: Range[] = [];
  for (const row of log.querySelectorAll<HTMLElement>('[data-index]')) {
    const ranges = rangesIn(row, query);
    (Number(row.dataset.index) === current ? now : all).push(...ranges);
  }
  reg.set('beluga-find', new H(...all));
  reg.set('beluga-find-current', new H(...now));
}

export interface FindState {
  readonly open: boolean;
  readonly query: string;
  /** Which match is current (an index into the matches). */
  readonly at: number;
}

/**
 * Find in this conversation (⌘F): type to find, Return / ⌘G for the next match, ⇧Return / ⇧⌘G
 * for the one before, Esc to close. `onGo` scrolls the log to an item.
 */
export function FindBar({ items, logRef, onGo }: { items: readonly LogItem[]; logRef: React.RefObject<HTMLElement | null>; onGo: (index: number) => void }) {
  const [find, setFind] = useState<FindState>({ open: false, query: '', at: 0 });
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = find.query.trim().toLowerCase();
    if (!find.open || !q) return [];
    return items.flatMap((it, i) => (searchable(it).toLowerCase().includes(q) ? [i] : []));
  }, [items, find.query, find.open]);
  const at = matches.length ? ((find.at % matches.length) + matches.length) % matches.length : 0;
  const current = matches[at];

  useEffect(() => {
    // In a terminal (the agent's, beside the chat), ⌘F finds in that terminal instead (agent-term/TermPane.tsx).
    const inTerminal = (): boolean => Boolean(document.activeElement?.closest('.xterm, [data-term-find]'));
    const open = (): void => {
      if (inTerminal()) return;
      setFind((f) => ({ ...f, open: true }));
      requestAnimationFrame(() => input.current?.select());
    };
    const step = (e: Event): void => {
      if (inTerminal()) return;
      const delta = (e as CustomEvent<number>).detail || 1;
      setFind((f) => (f.open ? { ...f, at: f.at + delta } : { ...f, open: true }));
    };
    document.addEventListener('beluga:find', open);
    document.addEventListener('beluga:find-step', step);
    return () => {
      document.removeEventListener('beluga:find', open);
      document.removeEventListener('beluga:find-step', step);
    };
  }, []);
  // Go to the current match when it changes (not on every streamed word).
  useEffect(() => {
    if (current !== undefined) onGo(current);
  }, [current, find.query]);
  // Repaint after every render: scrolling the log draws other rows.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => paint(logRef.current, find.open ? find.query.trim() : '', current));
    return () => cancelAnimationFrame(frame);
  });
  useEffect(() => () => paint(null, '', undefined), []);

  if (!find.open) return null;
  const close = (): void => {
    setFind({ open: false, query: find.query, at: 0 });
    document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
  };
  const step = (delta: number): void => setFind((f) => ({ ...f, at: f.at + delta }));
  return (
    <div className={s.bar} role="search" aria-label="Find in this conversation">
      <Icon name="search" size={13} className={s.glass} />
      <input
        ref={input}
        autoFocus
        className={`${s.input} selectable`}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        value={find.query}
        spellCheck={false}
        onChange={(e) => setFind({ open: true, query: e.target.value, at: 0 })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className={s.count} aria-live="polite">
        {find.query.trim() ? (matches.length ? `${at + 1} of ${matches.length}` : 'No matches') : ''}
      </span>
      <span className={s.steps}>
        <IconButton size="small" icon="chevronUp" label="Previous match" keys={shortcutKeys('conv-find-prev')} disabled={!matches.length} onClick={() => step(-1)} />
        <IconButton size="small" icon="chevronDown" label="Next match" keys={shortcutKeys('conv-find-next')} disabled={!matches.length} onClick={() => step(1)} />
      </span>
      <button type="button" className={s.done} onClick={close}>
        Done
      </button>
    </div>
  );
}
