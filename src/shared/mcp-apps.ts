/**
 * MCP Apps in a chat (src/mcp-apps): a tool call whose tool
 * declares a `ui://` resource keeps what its app needs on its step, and `apps.get` gives the Mac
 * the frame to draw it in. Browser-safe: types only.
 */

/** What a step of a UI tool keeps for its app (beside the step's own input and output). */
export interface StepApp {
  /** The MCP server's name, as Claude Code knows it. */
  readonly server: string;
  /** The tool's own name on that server. */
  readonly tool: string;
  /** The `ui://` resource that draws it. */
  readonly resourceUri: string;
  /** The result's `structuredContent`, when it had some that fit (see mcp-apps/domain/result.ts). */
  readonly structuredContent?: unknown;
}

/** `apps.get`: an app to draw, or why there is none. */
export type McpAppView =
  | {
      readonly ok: true;
      /** The frame's address on this computer's app host (loopback, an id nobody can guess). */
      readonly url: string;
      readonly server: string;
      readonly tool: string;
      readonly resourceUri: string;
      /** The tool call's arguments (bounded, secrets redacted). */
      readonly input: Readonly<Record<string, unknown>>;
      /** The tool's result: its text (as the step keeps it) and its structured content. Absent while it runs. */
      readonly result?: { readonly text?: string; readonly structuredContent?: unknown; readonly isError?: boolean };
      readonly prefersBorder?: boolean;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'unavailable'; readonly message: string };

/** MCP's CallToolResult as a server sent it, for its app: untrusted data, drawn only in the app's frame. */
export interface AppToolResult {
  readonly content: ReadonlyArray<Readonly<Record<string, unknown>> & { readonly type: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** MCP's ReadResourceResult, for an app. */
export interface AppReadResult {
  readonly contents: ReadonlyArray<{ readonly uri: string; readonly mimeType?: string; readonly text?: string; readonly blob?: string; readonly _meta?: Record<string, unknown> }>;
}

/** Where an app was drawn: the step of your Claude's work that called its tool. */
export interface AppStepRef {
  readonly channel: string;
  readonly itemId: string;
  readonly stepId: string;
}

/**
 * `apps.call` / `apps.read`: what the server answered, or why nothing ran: missing (no app on that step), refused (Beluga's gate), declined (you said no), failed (it could not run).
 */
export type AppActResult<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly reason: 'missing' | 'refused' | 'declined' | 'failed'; readonly message: string };

/** Only a card that called an MCP tool (`mcp__…`) can have an app: the others never read their steps for one. */
export function mayHaveApps(steps: readonly string[]): boolean {
  return steps.some((x) => x.startsWith('mcp__'));
}
