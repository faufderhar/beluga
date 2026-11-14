import { z } from 'zod';

/**
 * MCP Apps (src/mcp-apps): the app of a step of your Claude's work, for the window's frame, and
 * what the app asks of Beluga. Browser-safe.
 */

const id = z.string().min(1).max(200);

export const MCP_APPS_API = {
  // A step's app → McpAppView (shared/mcp-apps.ts): its frame URL on this computer's app host, the
  // tool call's input and result, or why there's none (missing, unavailable). (channel, itemId, stepId)
  'apps.get': { args: z.tuple([id, id, id]) },
  // The app on a step calls a tool of its own server (SEP-1865 tools/call) → AppActResult: gated
  // (own server, visibility 'app', readOnly or you allowed it). (channel, itemId, stepId, tool, arguments)
  'apps.call': { args: z.tuple([id, id, id, id, z.record(z.string(), z.unknown())]) },
  // The app on a step reads a ui:// resource of its own server (resources/read) → AppActResult. (channel, itemId, stepId, uri)
  'apps.read': { args: z.tuple([id, id, id, z.string().min(1).max(2048)]) },
  // The app on a step posts a message as you in its chat, marked as the app's, and starts a turn
  // (SEP-1865 ui/message: { role: 'user', content }) → AppActResult. (channel, itemId, stepId, params)
  'apps.message': { args: z.tuple([id, id, id, z.record(z.string(), z.unknown())]) },
  // The app on a step sets what it tells the model (ui/update-model-context: { content, structuredContent }):
  // the latest per app, for your Claude's next turn there, as data → AppActResult. (channel, itemId, stepId, params)
  'apps.context': { args: z.tuple([id, id, id, z.record(z.string(), z.unknown())]) },
} as const;
