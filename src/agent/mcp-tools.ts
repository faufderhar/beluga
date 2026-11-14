import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import type { McpTools } from './types.js';

/**
 * Your MCP servers as tools (server `beluga_mcp`): the agent sees which need a sign-in and starts
 * one itself, so the user signs in from the chat, never with /mcp in a terminal. Your own runs only.
 */

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

export function createMcpTools(mcp: McpTools) {
  return toolSuite({
    name: 'beluga_mcp',
    version: '0.1.0',
    tools: [
      tool('mcp_servers', 'Your MCP servers: how each is (connected, needs sign-in, failed) and whether mcp_sign_in can sign in to it.', {}, async () => text(await mcp.servers())),
      tool(
        'mcp_sign_in',
        'Sign in to one of your MCP servers that needs authentication. Opens its sign-in page in the user’s browser and waits for them to finish; its tools then load in this turn. When it says it is still waiting, tell the user to finish in the browser, then call it again.',
        { name: z.string().min(1).max(200).describe('The server’s name or the name shown, as mcp_servers lists it') },
        async (a) => {
          const res = await mcp.signIn(a.name);
          return text(res.text, !res.ok);
        },
      ),
    ],
  });
}
