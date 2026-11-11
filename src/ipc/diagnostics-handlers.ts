import { blackbox } from '../core/blackbox/recorder.js';
import { makeReport } from '../core/blackbox/report.js';
import { installedVersion } from '../core/version.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `diagnostics.*` method does (see diagnostics-api.ts). */

type DiagnosticsMethod = Extract<Method, `diagnostics.${string}`>;
type DiagnosticsHandlers = { readonly [M in DiagnosticsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const DIAGNOSTICS_HANDLERS = {
  'diagnostics.report': () => makeReport({ version: installedVersion() }),
  'diagnostics.windowProblem': (_s, p) => {
    const what = p.kind === 'stalled' ? 'never finished loading' : 'failed to load';
    blackbox.record('error', `window: chunk ${p.chunk} ${what} after ${Math.round(p.ms)} ms: ${p.message}`);
  },
  'diagnostics.windowCrash': (_s, p) => {
    blackbox.record('error', `window: ${p.part} crashed: ${p.message}${p.stack ? `\n${p.stack}` : ''}`);
  },
} satisfies DiagnosticsHandlers;
