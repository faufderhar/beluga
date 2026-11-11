/**
 * The Agent Client Protocol messages Beluga uses with `opencode acp` (protocol version 1), in the
 * shapes OpenCode 1.19 sends them (recorded from a real one). Only what Beluga reads or sends.
 */

export const ACP_VERSION = 1;

export interface InitializeResponse {
  readonly protocolVersion: number;
  readonly agentCapabilities?: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: { readonly image?: boolean; readonly embeddedContext?: boolean };
    readonly sessionCapabilities?: { readonly fork?: object; readonly resume?: object; readonly close?: object; readonly list?: object };
  };
  readonly agentInfo?: { readonly name?: string; readonly version?: string };
}

/** A select option a session offers (OpenCode's: model, effort, mode). */
export interface ConfigOption {
  readonly id: string;
  readonly category?: string;
  readonly currentValue: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string; readonly description?: string }>;
}

export interface SessionResponse {
  readonly sessionId?: string;
  readonly configOptions?: readonly ConfigOption[];
}

/** One stdio MCP server, as session/new takes it. */
export interface AcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** One MCP server over HTTP, as session/new takes it (Copilot takes only these from a client). */
export interface AcpHttpMcpServer {
  readonly type: 'http';
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export type ContentBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly mimeType: string; readonly data: string };

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
  readonly stopReason: StopReason;
  /** An agent's own additions (Grok Build's tokens and cost for the turn). */
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly thoughtTokens?: number; readonly cachedReadTokens?: number; readonly cachedWriteTokens?: number };
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A tool call's content: text it gave back, or a file's diff. */
export type ToolContent = { readonly type: 'content'; readonly content: { readonly type: string; readonly text?: string } } | { readonly type: 'diff'; readonly path: string; readonly oldText?: string | null; readonly newText: string } | { readonly type: string };

export interface ToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolStatus;
  readonly locations?: ReadonlyArray<{ readonly path: string; readonly line?: number }>;
  readonly rawInput?: Record<string, unknown>;
  readonly rawOutput?: unknown;
  readonly content?: readonly ToolContent[];
  /** An agent's own additions (Grok Build's tool id). */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** What `session/update` carries (the kinds Beluga reads). */
export type SessionUpdate =
  | { readonly sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk'; readonly content: { readonly type: string; readonly text?: string } }
  | ({ readonly sessionUpdate: 'tool_call' | 'tool_call_update' } & ToolCall)
  | { readonly sessionUpdate: 'usage_update'; readonly used: number; readonly size: number; readonly cost?: { readonly amount: number; readonly currency: string } }
  | { readonly sessionUpdate: 'available_commands_update'; readonly availableCommands: ReadonlyArray<{ readonly name: string; readonly description?: string }> }
  | { readonly sessionUpdate: 'plan'; readonly entries: ReadonlyArray<{ readonly content: string; readonly status: string }> }
  | { readonly sessionUpdate: 'config_option_update'; readonly configOptions: readonly ConfigOption[] }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string };

/** `session/request_permission`: one tool call, and the answers it takes. */
export interface PermissionRequest {
  readonly sessionId: string;
  readonly toolCall: ToolCall;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>;
}

/** Beluga only ever answers once: allowed this time, or rejected (never "always"). */
export function permissionAnswer(req: PermissionRequest, allow: boolean): { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' } } {
  const want = allow ? 'allow_once' : 'reject_once';
  const option = req.options.find((o) => o.kind === want);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}
