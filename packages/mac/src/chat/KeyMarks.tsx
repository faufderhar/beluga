// The chat box's words, marked where a key is (BLG-977): while the card asks, each key it asks
// about is tinted in place (a dashed underline when it's only maybe one), so you see which words it
// means. And a word you pick gets a small Keep as Key pill just above it.
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Kbd, cx } from '../components/ui.js';
import { pickable } from './key-paste-model.js';
import m from './mention.module.css';
import s from './key-marks.module.css';

/** A word picked in the box that could be kept as a key. */
export interface TextPick {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** A key the card asks about, as marked in the box. */
export interface KeyMark {
  readonly value: string;
  readonly soft: boolean;
}

const samePick = (a: TextPick | undefined, b: TextPick | undefined): boolean => a?.start === b?.start && a?.end === b?.end && a?.value === b?.value;

/** What's picked in the box now, when it could be a key (one token, long enough); none while `off`. */
export function useTextPick(input: RefObject<HTMLTextAreaElement | null>, off: boolean): TextPick | undefined {
  const [pick, setPick] = useState<TextPick>();
  useEffect(() => {
    const el = input.current;
    if (!el || off) {
      setPick(undefined);
      return;
    }
    const look = (): void => {
      const next = document.activeElement === el ? pickable(el.value, el.selectionStart, el.selectionEnd) : undefined;
      setPick((was) => (samePick(was, next) ? was : next));
    };
    // A drag ends on mouseup; the keyboard (⇧→, ⌘A) on keyup; selectionchange covers the rest. Never
    // on `input`: a render in the middle of a keystroke makes React put the box's old words back.
    const events = ['select', 'mouseup', 'keyup', 'focus', 'blur'] as const;
    for (const e of events) el.addEventListener(e, look);
    document.addEventListener('selectionchange', look);
    look();
    return () => {
      for (const e of events) el.removeEventListener(e, look);
      document.removeEventListener('selectionchange', look);
    };
  }, [input, off]);
  return pick;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: 'sure' | 'soft' | 'pick';
}

/** Where each mark is in the text: every place a key's words are, and the pick (when it isn't one). */
function spansOf(text: string, marks: readonly KeyMark[], pick: TextPick | undefined): Span[] {
  const out: Span[] = [];
  for (const k of marks) {
    for (let at = text.indexOf(k.value); at >= 0; at = text.indexOf(k.value, at + k.value.length)) out.push({ start: at, end: at + k.value.length, kind: k.soft ? 'soft' : 'sure' });
  }
  if (pick && !out.some((o) => o.start < pick.end && pick.start < o.end)) out.push({ ...pick, kind: 'pick' });
  return out.sort((a, b) => a.start - b.start).filter((o, i, all) => i === 0 || o.start >= all[i - 1]!.end);
}

export interface KeyMarksProps {
  readonly text: string;
  readonly marks: readonly KeyMark[];
  /** The card ended without keeping them (Not a Key): the marks fade out. */
  readonly fading: boolean;
  readonly pick: TextPick | undefined;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly className: string;
  readonly keys: string | undefined;
  readonly onPick: (pick: TextPick) => void;
}

/**
 * Behind the box (as MentionHighlighter): the same words, invisible, with the marks drawn under
 * them; it follows the box's scrolling. The pill floats above a picked word, over the box.
 */
export function KeyMarks({ text, marks, fading, pick, input, className, keys, onPick }: KeyMarksProps) {
  const layer = useRef<HTMLDivElement>(null);
  const picked = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number }>();
  const spans = useMemo(() => spansOf(text, marks, pick), [text, marks, pick]);
  const shown = spans.length > 0;

  useEffect(() => {
    const el = input.current;
    if (!el || !shown) return;
    const follow = (): void => {
      if (layer.current) layer.current.scrollTop = el.scrollTop;
    };
    follow();
    el.addEventListener('scroll', follow);
    return () => el.removeEventListener('scroll', follow);
  }, [input, shown, text]);

  // The pill sits over the picked word's first line, centred on it.
  useLayoutEffect(() => {
    const word = picked.current;
    const wrap = layer.current?.offsetParent;
    if (!word || !wrap) return setAt((was) => (was ? undefined : was));
    const line = word.getClientRects()[0];
    const box = wrap.getBoundingClientRect();
    if (!line) return setAt((was) => (was ? undefined : was));
    const next = { x: Math.round(Math.max(8, Math.min(box.width - 8, line.left - box.left + line.width / 2))), y: Math.round(line.top - box.top) };
    setAt((was) => (was?.x === next.x && was.y === next.y ? was : next));
  }, [pick, spans, text]);

  if (!shown) return null;
  const pieces: React.ReactNode[] = [];
  let last = 0;
  spans.forEach((sp, i) => {
    if (sp.start > last) pieces.push(<span key={`t${i}`}>{text.slice(last, sp.start)}</span>);
    pieces.push(
      <span key={`m${i}:${sp.kind}`} ref={sp.kind === 'pick' ? picked : undefined} className={cx(sp.kind === 'pick' ? s.pickRoom : s.mark, sp.kind === 'soft' && s.soft)} data-key-mark={sp.kind}>
        {text.slice(sp.start, sp.end)}
      </span>,
    );
    last = sp.end;
  });
  if (last < text.length) pieces.push(<span key="end">{text.slice(last)}</span>);
  return (
    <>
      <div ref={layer} className={cx(className, m.highlighter, s.layer, fading && s.fading)} aria-hidden="true" data-key-marks>
        {pieces}
        {'​'}
      </div>
      {pick && at ? (
        <button
          key={`${pick.start}:${pick.end}`}
          type="button"
          className={s.pill}
          style={{ left: at.x, top: at.y }}
          // The box keeps its focus (and its selection) while the pill is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(pick)}
          data-key-pick
        >
          <Icon name="key" size={11} />
          Keep as Key
          {keys ? <Kbd>{keys}</Kbd> : null}
        </button>
      ) : null}
    </>
  );
}
