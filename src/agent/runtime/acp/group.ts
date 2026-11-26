/**
 * An ACP agent's whole process group. On macOS and Linux each agent starts in a group of its own
 * (spawned `detached`), so what it starts in turn (a language server, a shell, a dev server it
 * left up) goes with it, not only the process Beluga holds. Windows keeps ending the one process.
 */

/** How a group is reached (tests: a fake). `signal(0)` asks whether any of it is still there. */
export interface GroupSignals {
  /** Throws ESRCH once nothing of the group is left, EPERM where it may not be signalled. */
  signal(sig: NodeJS.Signals | 0): void;
  wait(ms: number): Promise<void>;
  now(): number;
}

type Outcome = 'sent' | 'gone' | 'refused';

const send = (g: GroupSignals, sig: NodeJS.Signals | 0): Outcome => {
  try {
    g.signal(sig);
    return 'sent';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'refused';
  }
};

/**
 * End a group: SIGTERM, then SIGKILL for what is still there after `graceMs`. True once it's gone
 * (or was already); false when the system wouldn't let it be signalled. EPERM while it winds down
 * (macOS says so of a leader that exited and isn't reaped yet) is "still there" until the grace is
 * up, and never makes it wait longer.
 */
export async function endGroup(g: GroupSignals, graceMs = 2_000, pollMs = 50): Promise<boolean> {
  const first = send(g, 'SIGTERM');
  if (first === 'gone') return true;
  const until = g.now() + graceMs;
  while (g.now() < until) {
    await g.wait(pollMs);
    if (send(g, 0) === 'gone') return true;
  }
  const last = send(g, 'SIGKILL');
  if (last !== 'sent') return last === 'gone';
  // SIGKILL can't be ignored: give it a moment to land.
  const by = g.now() + graceMs;
  while (g.now() < by) {
    if (send(g, 0) === 'gone') return true;
    await g.wait(pollMs);
  }
  return false;
}

/** The group led by `pid`, on this computer. */
export const groupOf = (pid: number): GroupSignals => ({
  signal: (sig) => void process.kill(-pid, sig),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

/** Whether agents get a group of their own here. */
export const ownGroups = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';
