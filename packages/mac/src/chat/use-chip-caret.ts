import { type RefObject, useEffect, useRef } from 'react';
import { type BoxSelection, type ChipSpan, boxRange, chipToDelete, snapToChips } from './chip-caret.js';

const selectionOf = (el: HTMLTextAreaElement): BoxSelection =>
  el.selectionDirection === 'backward' ? { anchor: el.selectionEnd, focus: el.selectionStart } : { anchor: el.selectionStart, focus: el.selectionEnd };

/**
 * Keeps the box's caret and selection off the inside of its chips (chip-caret.ts), and makes
 * Backspace or Delete at the edge of one of `whole` take it whole. Images are left out of `whole`:
 * their own key handling (use-attachments' onRefKey) also lets their picture go.
 */
export function useChipCaret(input: RefObject<HTMLTextAreaElement | null>, text: string, spans: readonly ChipSpan[], whole: readonly ChipSpan[]): void {
  const live = useRef({ text, spans, whole });
  live.current = { text, spans, whole };
  const any = spans.length > 0;

  useEffect(() => {
    const el = input.current;
    if (!el || !any) return;
    let pointing = false;
    let composing = false;
    let lastFocus: number | undefined;

    const snap = (fromKeys: boolean): void => {
      if (pointing || composing || document.activeElement !== el) return;
      const now = selectionOf(el);
      // Just typed: the chips are where they were in the words before; nothing to keep off yet.
      if (el.value !== live.current.text) {
        lastFocus = now.focus;
        return;
      }
      const next = snapToChips(live.current.spans, now, fromKeys ? lastFocus : undefined);
      lastFocus = next.focus;
      if (next.anchor === now.anchor && next.focus === now.focus) return;
      const r = boxRange(next);
      el.setSelectionRange(r.start, r.end, r.direction);
    };

    const onSelection = (): void => snap(true);
    const onPointerDown = (): void => {
      pointing = true;
      window.addEventListener('pointerup', onPointerUp, { once: true });
      window.addEventListener('pointercancel', onPointerUp, { once: true });
    };
    // After a click or a drag (the browser has placed the caret by then).
    function onPointerUp(): void {
      pointing = false;
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      requestAnimationFrame(() => snap(false));
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || composing || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key !== 'Backspace' && e.key !== 'Delete') || el.value !== live.current.text) return;
      const chip = chipToDelete(live.current.whole, el.selectionStart, el.selectionEnd, e.key);
      // Select it: the key then deletes it as the box deletes any selection (⌘Z brings it back).
      if (chip) el.setSelectionRange(chip.start, chip.end);
    };
    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
    };

    lastFocus = selectionOf(el).focus;
    document.addEventListener('selectionchange', onSelection);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionend', onCompositionEnd);
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('compositionstart', onCompositionStart);
      el.removeEventListener('compositionend', onCompositionEnd);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [input, any]);
}
