/**
 * A tool result's `structuredContent`, as Claude Code hands it in the user message's
 * `tool_use_result` ({ content, structuredContent }). Kept beside the step for the app, bounded. Pure.
 */

/** The most characters (as JSON) of structured content kept for an app. */
export const STRUCTURED_MAX = 256_000;

/** The structured content of a tool_use_result, when it has some that fits. */
export function boundStructured(toolUseResult: unknown): unknown {
  if (!toolUseResult || typeof toolUseResult !== 'object' || !('structuredContent' in toolUseResult)) return undefined;
  const value = (toolUseResult as { structuredContent?: unknown }).structuredContent;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).length < STRUCTURED_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}
