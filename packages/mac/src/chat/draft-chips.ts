import { useEffect, useRef, type RefObject } from 'react';

/**
 * Chips on their way to a chat's draft: words for a message box that may not be on screen yet (a
 * drop on a row opens its chat, and its box comes after). Each box takes what waits for its draft,
 * when it's on screen and whenever more comes. Never sends anything.
 */

const waiting = new Map<string, string>();
const boxes = new Set<() => void>();

export function putChips(key: string, words: string): void {
  const before = waiting.get(key);
  waiting.set(key, before ? `${before} ${words}` : words);
  for (const give of boxes) give();
}

/** A box takes the chips for draft `key`. */
export function useDraftChips(key: string, insert: (words: string) => void): void {
  const latest = useRef(insert);
  latest.current = insert;
  useEffect(() => {
    const give = (): void => {
      const words = waiting.get(key);
      if (words === undefined) return;
      waiting.delete(key);
      latest.current(words);
    };
    give();
    boxes.add(give);
    return () => void boxes.delete(give);
  }, [key]);
}

/** The caret after the box shows its new words. */
export function caretAfterDraw(box: RefObject<HTMLTextAreaElement | null>, caret: number): void {
  requestAnimationFrame(() => {
    box.current?.focus();
    box.current?.setSelectionRange(caret, caret);
  });
}
