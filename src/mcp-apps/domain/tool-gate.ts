import type { CatalogTool } from '../ports/tool-catalog.js';
import { toolVisibility } from './ui-meta.js';

/**
 * Whether an app may call a tool (SEP-1865 tools/call from the frame). Pure. An app calls only
 * tools of its own server whose visibility includes 'app'. A readOnly tool runs; any other asks
 * you first (Allow / Allow Always / Decline), unless you said Always to that server's tool.
 */

export type GateDecision = { readonly kind: 'run' } | { readonly kind: 'ask' } | { readonly kind: 'refuse'; readonly message: string };

export interface GateInput {
  /** The server of the app's own step. */
  readonly appServer: string;
  /** The server the call is for. */
  readonly server: string;
  /** The tool as that server lists it; undefined: it has none of that name. */
  readonly tool: CatalogTool | undefined;
  /** You said Always to this server's tool. */
  readonly approved: boolean;
}

export function gateToolCall({ appServer, server, tool, approved }: GateInput): GateDecision {
  if (server !== appServer) return { kind: 'refuse', message: 'An app may only call tools of its own server.' };
  if (!tool) return { kind: 'refuse', message: 'Its server has no tool of that name.' };
  if (!toolVisibility(tool._meta).includes('app')) return { kind: 'refuse', message: `${tool.name} is not for apps to call.` };
  if (isReadOnly(tool) || approved) return { kind: 'run' };
  return { kind: 'ask' };
}

function isReadOnly(tool: CatalogTool): boolean {
  return tool.annotations?.readOnly === true || tool.annotations?.readOnlyHint === true;
}
