import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type MotionValue, motion, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react';
import { leanFor } from '../tasks/board-drag.js';

/**
 * Something picked up and carried (a board's card, a sidebar's chat row): it lifts a little and
 * swings left and right with the way it's pulled, then rights itself. The board's feel, in one place.
 */

const LIFT_SCALE = 1.035;
const LIFT_SPRING = { type: 'spring', stiffness: 500, damping: 30 } as const;
const LEAN_SPRING = { stiffness: 260, damping: 22 };

/** How far it leans, from how fast `x` moves (none with reduced motion). */
export function useLean(x: MotionValue<number>): MotionValue<number> {
  const reduce = useReducedMotion() ?? false;
  return useSpring(useTransform(useVelocity(x), (v) => (reduce ? 0 : leanFor(v))), LEAN_SPRING);
}

/** What follows the pointer, over everything. `down`: it's being put down (back to its own size). */
export function Lifted({ x, y, lean, width, down = false, className, children, ...data }: { x: MotionValue<number>; y: MotionValue<number>; lean: MotionValue<number>; width: number; down?: boolean; className?: string | undefined; children: ReactNode } & { [key: `data-${string}`]: string }) {
  const reduce = useReducedMotion() ?? false;
  return createPortal(
    <motion.div className={className} style={{ x, y, width, rotate: lean }} initial={reduce ? false : { scale: 1 }} animate={{ scale: down ? 1 : LIFT_SCALE }} transition={LIFT_SPRING} aria-hidden="true" {...data}>
      {children}
    </motion.div>,
    document.body,
  );
}
