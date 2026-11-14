/**
 * A look that never piles up (BLG-942): while the last one is still on its way (a busy or slow
 * daemon), the next beats are skipped. Without it a 1 s poll whose answer took 12 s had a dozen
 * on their way at once, each one more for the daemon to do, all landing together when it caught up.
 * `look` returns what it's waiting for (nothing: it didn't ask, so the next beat may).
 */
export function oneAtATime(look: () => PromiseLike<unknown> | void): () => void {
  let waiting = false;
  return () => {
    if (waiting) return;
    const asked = look();
    if (!asked) return;
    waiting = true;
    const done = (): void => {
      waiting = false;
    };
    asked.then(done, done);
  };
}
