/**
 * A part of the window that threw while drawing (BLG-905), in the short shape the daemon's black
 * box keeps (diagnostics.windowCrash): which part, its error, and where it came from. Pure, so
 * it's tested on its own (tests/mac-crash-model.test.ts).
 */

export interface WindowCrash {
  readonly part: string;
  readonly message: string;
  readonly stack?: string;
}

/** The limits diagnostics.windowCrash takes. */
const PART_MAX = 200;
const MESSAGE_MAX = 1000;
const STACK_MAX = 4000;
/** Enough of each stack to see where it broke, not the whole of React under it. */
const STACK_LINES = 12;
const COMPONENT_LINES = 8;

const firstLines = (text: string | null | undefined, n: number): string[] =>
  (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n);

/** What to note about `error`, thrown while drawing `part` (`componentStack`: React's, from componentDidCatch). */
export function crashOf(part: string, error: unknown, componentStack?: string | null): WindowCrash {
  const message = (error instanceof Error ? error.message : String(error)) || 'Unknown error';
  const code = firstLines(error instanceof Error ? error.stack : undefined, STACK_LINES);
  const components = firstLines(componentStack, COMPONENT_LINES);
  const stack = [...code, ...(components.length ? ['components:', ...components] : [])].join('\n').slice(0, STACK_MAX);
  return { part: part.slice(0, PART_MAX) || 'window', message: message.slice(0, MESSAGE_MAX), ...(stack ? { stack } : {}) };
}
