import { type MeasureText, guessWidth } from './plan-layout.js';

/*
 * The plan canvas sizes its cards before React draws them (plan-layout.ts), so it measures their words
 * the way the screen will set them: in the app's own font (--font, which follows the language), on a
 * canvas. Chinese, Japanese and Korean run about twice as wide as Latin, and capitals wider than
 * lower case, so counting characters can't tell whether a line fits.
 */

let ctx: CanvasRenderingContext2D | null | undefined;

/** The width of `text` in the app's font; a guess where there's no canvas. */
export const measureText: MeasureText = (text, fontSize, fontWeight = 400) => {
  if (ctx === undefined) ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) return guessWidth(text, fontSize, fontWeight);
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  return ctx.measureText(text).width;
};
