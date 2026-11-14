import type { Session } from '../core/session.js';
import { telemetryOf } from '../telemetry/launch.js';
import type { Args, Method } from './api.js';

/** What each `telemetry.*` method does (see telemetry-api.ts). */

type TelemetryMethod = Extract<Method, `telemetry.${string}`>;
type TelemetryHandlers = { readonly [M in TelemetryMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TELEMETRY_HANDLERS = {
  'telemetry.choose': (s, level, via) => telemetryOf(s).choose(level, via),
  'telemetry.answer': (s, answer, level) => telemetryOf(s).answer(answer, level),
  'telemetry.exclude': (s, root, excluded) => telemetryOf(s).exclude(root, excluded),
  'telemetry.mark': (s, name, detail) => telemetryOf(s).mark(name, detail),
} satisfies TelemetryHandlers;
