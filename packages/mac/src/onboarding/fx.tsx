import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { Fragment, type ReactNode, useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';

/**
 * The onboarding's small motion pieces (in the spirit of Magic UI and React Bits, written for
 * this app's CSS rather than Tailwind): words that come into focus one after another, a number
 * that counts up, and the shared easing.
 */

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: 'spring', stiffness: 320, damping: 32, mass: 0.9 } as const;
export const SOFT_SPRING = { type: 'spring', stiffness: 140, damping: 22 } as const;

/**
 * A line's pieces, each with whether a space follows it: words in English, phrases in another
 * language (src/i18n), whose words aren't split by spaces.
 */
export function wordsOf(text: string, shown: string): ReadonlyArray<{ readonly word: string; readonly space: boolean }> {
  const parts = shown === text ? text.split(' ').map((w, i, all) => `${w}${i < all.length - 1 ? ' ' : ''}`) : (shown.match(/[^。，、！？\s]+[。，、！？]?\s*/g) ?? [shown]);
  return parts.filter((p) => p.trim()).map((p) => ({ word: p.trimEnd(), space: p !== p.trimEnd() }));
}

/**
 * A headline that resolves word by word: each rises a little and comes out of a blur.
 *
 * The spaces are real text between the words, never inside them: the line breaks where the same
 * words in plain text would, from the first frame to the last. (With the space inside each word,
 * WebKit on some Macs, Intel ones among them, laid the line out one way while it animated and
 * another once it settled.) No lasting will-change either: Motion promotes each word only while it
 * moves, so a slower graphics chip isn't left holding a layer per word.
 */
export function Words({ text, delay = 0, stagger = 0.055, className }: { readonly text: string; readonly delay?: number; readonly stagger?: number; readonly className?: string }) {
  const still = useReducedMotion() ?? false;
  const shown = t(text);
  const words = wordsOf(text, shown);
  return (
    <span className={className} aria-label={shown}>
      {words.map(({ word, space }, i) => (
        <Fragment key={`${word}-${i}`}>
          <motion.span
            aria-hidden="true"
            style={{ display: 'inline-block' }}
            initial={still ? false : { opacity: 0, y: '0.32em', filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, ease: EASE_OUT, delay: delay + i * stagger }}
          >
            {word}
          </motion.span>
          {space && i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </span>
  );
}

/** Fades and lifts in after `delay` (for lines under a headline). */
export function Rise({ children, delay = 0, y = 10, className }: { readonly children: ReactNode; readonly delay?: number; readonly y?: number; readonly className?: string }) {
  const still = useReducedMotion() ?? false;
  return (
    <motion.div className={className} initial={still ? false : { opacity: 0, y, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.65, ease: EASE_OUT, delay }}>
      {children}
    </motion.div>
  );
}

/** A number counting up from `from` to `value` once it's on screen, formatted by `format`. */
export function Ticker({ value, from = 0, format, duration = 1.6, delay = 0 }: { readonly value: number; readonly from?: number; readonly format: (n: number) => string; readonly duration?: number; readonly delay?: number }) {
  const still = useReducedMotion() ?? false;
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true });
  const n = useMotionValue(still ? value : from);
  const shown = useTransform(n, (v) => format(v));
  useEffect(() => {
    if (!seen || still) return;
    const run = animate(n, value, { duration, delay, ease: EASE_OUT });
    return () => run.stop();
  }, [seen, value]);
  return (
    <motion.span ref={ref} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {shown}
    </motion.span>
  );
}
