/**
 * What an app keeps of a tool result, as Claude Code hands it in the user message's
 * `tool_use_result` ({ content, structuredContent, _meta }): the `structuredContent` and the
 * result's own `_meta` (SEP-1865: data a server means for its view and never for the model, which
 * Claude Code leaves out of the tool_result the model reads). Both are untrusted third-party data,
 * kept beside the step for the app only, each bounded. Pure.
 */

/** The most characters (as JSON) of structured content kept for an app; the result's `_meta` gets as many again. */
export const STRUCTURED_MAX = 256_000;

/** The structured content of a tool_use_result, when it has some that fits. */
export function boundStructured(toolUseResult: unknown): unknown {
  const value = memberOf(toolUseResult, 'structuredContent');
  return value === undefined || value === null || !fits(value) ? undefined : value;
}

/** The result's `_meta` of a tool_use_result, when it is an object that fits. */
export function boundResultMeta(toolUseResult: unknown): Record<string, unknown> | undefined {
  const value = memberOf(toolUseResult, '_meta');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return undefined;
  return fits(value) ? (value as Record<string, unknown>) : undefined;
}

function memberOf(toolUseResult: unknown, key: string): unknown {
  if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult) || !(key in toolUseResult)) return undefined;
  return (toolUseResult as Record<string, unknown>)[key];
}

function fits(value: unknown): boolean {
  try {
    return JSON.stringify(value).length < STRUCTURED_MAX;
  } catch {
    return false;
  }
}
