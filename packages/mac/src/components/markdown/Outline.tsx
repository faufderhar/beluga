import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { cx } from '../ui.js';
import { scrollParent, scrollToElement } from './md-dom.js';
import m from './markdown.module.css';

interface Heading {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

/** The headings an outline lists (not the footnotes' hidden one). */
const HEADINGS = ':is(h1, h2, h3)[id]:not(.sr-only)';
/** A heading counts as the one you're reading once it's this close to the top. */
const READING_LINE = 96;

/**
 * "On this page": the document's h1–h3 beside it, the one you're reading marked as you scroll,
 * each a click away.
 */
export function Outline({ article, version }: { article: RefObject<HTMLElement | null>; version: string }) {
  const [heads, setHeads] = useState<readonly Heading[]>([]);
  const [active, setActive] = useState<string>();

  useLayoutEffect(() => {
    const el = article.current;
    if (!el) return;
    setHeads([...el.querySelectorAll<HTMLElement>(HEADINGS)].map((h) => ({ id: h.id, text: (h.textContent ?? '').trim(), level: Number(h.tagName.slice(1)) })));
  }, [version]);

  useEffect(() => {
    const el = article.current;
    const root = el ? scrollParent(el) : undefined;
    if (!el || !root || !heads.length) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const line = root.getBoundingClientRect().top + READING_LINE;
      const all = [...el.querySelectorAll<HTMLElement>(HEADINGS)];
      // Scrolled to the very end: the last section is the one you're reading (it may never reach the top).
      const atEnd = root.scrollHeight > root.clientHeight + 2 && root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const passed = all.filter((h) => h.getBoundingClientRect().top <= line);
      setActive((atEnd ? all.at(-1) : passed.at(-1) ?? all[0])?.id);
    };
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [heads]);

  if (heads.length < 2) return null;
  const top = Math.min(...heads.map((h) => h.level));
  const go = (id: string): void => {
    const target = article.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!target) return;
    setActive(id);
    scrollToElement(target, { smooth: true });
  };
  return (
    <nav className={m.outline} aria-label="Outline">
      <div className={m.outlineTitle}>On this page</div>
      <ul className={m.outlineList} translate="no">
        {heads.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cx(m.outlineItem, h.id === active && m.outlineOn)}
              style={{ paddingLeft: 10 + (h.level - top) * 12 }}
              aria-current={h.id === active ? 'location' : undefined}
              title={h.text}
              onClick={(e) => {
                e.preventDefault();
                go(h.id);
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
