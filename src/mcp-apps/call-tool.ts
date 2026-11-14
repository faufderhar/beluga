import type { AppActResult, AppReadResult, AppStepRef, AppToolResult } from '../shared/mcp-apps.js';
import { gateToolCall } from './domain/tool-gate.js';
import type { McpAppServer } from './ports/app-server.js';
import { type StepAppDeps, appOnStep } from './step-app.js';

/**
 * `apps.call` and `apps.read`: an app acting on its own server (SEP-1865 tools/call and
 * resources/read from its frame). The server is the one of the app's step, never one the app
 * names. Each call passes the tool gate (domain/tool-gate.ts); a tool that isn't readOnly asks you
 * first.
 */

export type AskAnswer = 'yes' | 'no' | 'always';

export interface AppActDeps extends StepAppDeps {
  readonly server: McpAppServer;
  /** Allow / Allow Always / Decline, in the app's chat. */
  readonly ask: (server: string, tool: string, channel: string) => Promise<AskAnswer>;
  readonly always: AppAlways;
}

/** The most characters (as JSON) of arguments an app may send. */
export const ARGS_MAX = 256_000;

export async function callAppTool(deps: AppActDeps, ref: AppStepRef, tool: string, args: Readonly<Record<string, unknown>>): Promise<AppActResult<AppToolResult>> {
  const place = appOnStep(deps, ref);
  if (!place.ok) return place;
  const server = place.result.server;
  if (!fits(args)) return { ok: false, reason: 'refused', message: 'Its arguments are too big.' };
  try {
    const listed = (await deps.server.tools(server)).find((t) => t.name === tool);
    const decision = gateToolCall({ appServer: server, server, tool: listed, approved: deps.always.has(server, tool) });
    if (decision.kind === 'refuse') return { ok: false, reason: 'refused', message: decision.message };
    if (decision.kind === 'ask') {
      const answer = await deps.ask(server, tool, ref.channel);
      if (answer === 'no') return { ok: false, reason: 'declined', message: `You declined ${tool}.` };
      if (answer === 'always') deps.always.add(server, tool);
    }
    return { ok: true, result: await deps.server.call(server, tool, args) };
  } catch (err) {
    return failed(err);
  }
}

export async function readAppResource(deps: AppActDeps, ref: AppStepRef, uri: string): Promise<AppActResult<AppReadResult>> {
  const place = appOnStep(deps, ref);
  if (!place.ok) return place;
  if (!uri.startsWith('ui://')) return { ok: false, reason: 'refused', message: 'An app may only read ui:// resources.' };
  try {
    return { ok: true, result: await deps.server.read(place.result.server, uri) };
  } catch (err) {
    return failed(err);
  }
}

/** The tools you said Always to, per server (until Beluga quits). */
export class AppAlways {
  private readonly allowed = new Set<string>();

  has(server: string, tool: string): boolean {
    return this.allowed.has(key(server, tool));
  }

  add(server: string, tool: string): void {
    this.allowed.add(key(server, tool));
  }
}

function fits(args: unknown): boolean {
  try {
    return JSON.stringify(args).length <= ARGS_MAX;
  } catch {
    return false;
  }
}

function failed(err: unknown): AppActResult<never> {
  return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) };
}

function key(server: string, tool: string): string {
  return `${server}\n${tool}`;
}
