import { CompletionError, type Complete } from './runtime/types.js';

/** How long the stand-in may think before autopilot goes on with its own safe answer. */
const STAND_IN_TIMEOUT_MS = 3 * 60_000;

/** What the stand-in is asked: the whole question in `prompt`, its rules in `system` (core/autopilot/model.ts). */
export interface StandInRequest {
  readonly prompt: string;
  readonly system: string;
  readonly signal?: AbortSignal;
}

/**
 * Full Autopilot's stand-in (BLG-981): one turn, no tools, no saved session. It answers for you
 * what your agent would have asked you; the reply is JSON that core/autopilot reads. Throws on
 * trouble (core goes on with a safe answer of its own and says so).
 */
export async function standIn(req: StandInRequest, opts: { cwd: string; complete: Complete; model?: string }): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  req.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, STAND_IN_TIMEOUT_MS);
  timer.unref();
  try {
    return await opts.complete({ prompt: req.prompt, cwd: opts.cwd, system: req.system, maxTurns: 1, signal: abortController.signal, ...(opts.model ? { model: opts.model } : {}) });
  } catch (err) {
    if (abortController.signal.aborted) throw new Error(req.signal?.aborted ? 'Stopped' : 'it took too long');
    if (err instanceof CompletionError) throw new Error('it ended without an answer');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', stop);
  }
}
