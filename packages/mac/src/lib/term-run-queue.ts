/**
 * The keys a Run (lib/term-run.ts) types, on their way to a terminal: the terminal may not be
 * there yet (the drawer slides in, its shell starts), so they wait here for it, a few seconds at most.
 * Pure: no screen in it.
 */

/** How long a command waits for a terminal to appear before it's dropped (never run much later). */
export const RUN_WAIT_MS = 8000;

type Typer = (data: string) => void;

let waiting: { readonly data: string; readonly at: number } | undefined;
/** The terminals that take a run (the drawer's or the panel's); the newest one takes it. */
const typers: Typer[] = [];

/** Hand keys to the terminal that's showing, or keep them until one is. */
export function sendRun(data: string, now: number = Date.now()): void {
  const typer = typers.at(-1);
  if (typer) {
    waiting = undefined;
    typer(data);
  } else waiting = { data, at: now };
}

/** A terminal that takes runs, while it's on screen → stop. It types what's waiting for it, if anything. */
export function takeRuns(type: Typer, now: number = Date.now()): () => void {
  typers.push(type);
  const ready = waiting && now - waiting.at <= RUN_WAIT_MS ? waiting.data : undefined;
  waiting = undefined;
  if (ready) type(ready);
  return () => {
    const i = typers.lastIndexOf(type);
    if (i >= 0) typers.splice(i, 1);
  };
}
