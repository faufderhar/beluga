import { z } from 'zod';
import { TRACE_FIELD_KEY, TRACE_FIELD_MAX, TRACE_PROVIDER_IDS } from '../shared/trace-destinations.js';

/**
 * Your own traces (BLG-1014, shared/trace-destinations.ts): the observability tools you connect in
 * Settings › Traces, which get your agents' turns as OpenTelemetry spans. Apart from usage
 * statistics. Screens never get a key back, only which are saved. Browser-safe: zod only.
 */

const provider = z.enum(TRACE_PROVIDER_IDS);
const fields = z.record(z.string().regex(TRACE_FIELD_KEY), z.string().max(TRACE_FIELD_MAX));

export const TRACES_API = {
  // Every tool you connected, how it's doing, and its fields without the secrets (only which are saved).
  'traces.list': { args: z.tuple([]) },
  // Connect a tool, or change one: a secret left empty keeps the saved one; `on` and `text` unset keep theirs. → the list.
  'traces.save': { args: z.tuple([z.object({ id: provider, on: z.boolean().optional(), text: z.boolean().optional(), fields: fields.optional() })]) },
  // Disconnect a tool: its keys are forgotten. → the list.
  'traces.remove': { args: z.tuple([provider]) },
  // Send Test: one small trace with what's typed (empty secrets: the saved ones), nothing saved. → whether it took it, in words.
  'traces.test': { args: z.tuple([provider, fields.optional()]) },
} as const;
