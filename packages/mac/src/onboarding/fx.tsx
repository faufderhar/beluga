import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';

/**
 * The onboarding's small motion pieces (in the spirit of Magic UI and React Bits, written for
 * this app's CSS rather than Tailwind): words that come into focus one after another, a number
 * that counts up, and the shared easing.
 */

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: 'spring', stiffness: 320, damping: 32, mass: 0.9 } as const;
export const SOFT_SPRING = { type: 'spring', stiffness: 140, damping: 22 } as const;

/** A headline that resolves word by word: each rises a little and comes out of a blur. */
export function Words({ text, delay = 0, stagger = 0.055, className }: { readonly text: string; readonly delay?: number; readonly stagger?: number; readonly className?: string }) {
  const still = useReducedMotion() ?? false;
  // In another language (src/i18n) the line resolves phrase by phrase: its words aren't split by spaces.
  const shown = t(text);
  const words = shown === text ? text.split(' ') : (shown.match(/[^。，、！？\s]+[。，、！？]?\s?/g) ?? [shown]);
  return (
    <span className={className} aria-label={shown}>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          aria-hidden="true"
          style={{ display: 'inline-block', whiteSpace: 'pre', willChange: 'transform, filter, opacity' }}
          initial={still ? false : { opacity: 0, y: '0.32em', filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.7, ease: EASE_OUT, delay: delay + i * stagger }}
        >
          {word}
          {i < words.length - 1 && shown === text ? ' ' : ''}
        </motion.span>
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
