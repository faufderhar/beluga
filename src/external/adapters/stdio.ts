import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * `beluga mcp stdio`: for a client with no OAuth (a local model, a small tool). It only pipes to the
 * listener: the grant, its rules and its audit are the same as for any agent. The token comes from
 * the environment, as the MCP spec says for stdio, and never from the command line.
 */
export async function bridgeStdio(url: string, token: string, clientClosed: Promise<void>): Promise<void> {
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  stdio.onmessage = (msg: JSONRPCMessage) => {
    remote.send(msg).catch((err: unknown) => {
      // A request must still get an answer, or the client waits on it forever.
      if ('id' in msg && 'method' in msg) void stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Beluga refused or can't be reached: ${err instanceof Error ? err.message : String(err)}` } });
    });
  };
  remote.onmessage = (msg) => void stdio.send(msg);
  await remote.start();
  await stdio.start();
  await clientClosed;
  await remote.close().catch(() => undefined);
}
