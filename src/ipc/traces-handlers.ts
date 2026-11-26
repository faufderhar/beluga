import type { Session } from '../core/session.js';
import { tracesOf } from '../telemetry/launch.js';
import type { Args, Method } from './api.js';

/** What each `traces.*` method does (see traces-api.ts). */

type TracesMethod = Extract<Method, `traces.${string}`>;
type TracesHandlers = { readonly [M in TracesMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TRACES_HANDLERS = {
  'traces.list': (s) => tracesOf(s).views(),
  'traces.save': (s, change) => tracesOf(s).save(change),
  'traces.remove': (s, id) => tracesOf(s).remove(id),
  'traces.test': (s, id, typed) => tracesOf(s).test(id, typed),
} satisfies TracesHandlers;
