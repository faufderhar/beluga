import type { ClaudeAnswer, ClaudeQuestion } from '../../../protocol.js';
import type { RunEnd } from '../../../shared/run-failure.js';
import type { UsageUpdate } from '../../usage.js';
import type { AcpDialect } from '../opencode/events.js';

/**
 * What one ACP agent does past the protocol, for the core (runner.ts, complete.ts, status.ts) to
 * call. Every member may be left out: the core then does what works for any ACP agent (its
 * instructions ahead of a new conversation's first message, the generic tool dialect, Beluga's
 * tools over HTTP when it takes them so, else stdio).
 * Methods, not function properties, so an agent's own narrower types fit.
 */
export interface AcpExtension {
  /** Beluga's instructions for a run as the `_meta` of session/new and session/load (unset: ahead of a new conversation's first message). */
  instructions?(text: string): Record<string, unknown>;
  /** Its tools as Beluga's (unset: the generic dialect, acp/dialect.ts). */
  readonly tools?: {
    /** Its calls in Beluga's names and fields; `known` is the tools mounted for this run (their Beluga names). */
    dialect(known: ReadonlySet<string>): AcpDialect;
    /** Beluga's MCP tool name for one of its tool names, or undefined: not one of Beluga's. */
    belugaToolOf(name: string, suites: readonly string[], known?: ReadonlySet<string>): string | undefined;
  };
  /** How Beluga's tools reach it (unset: HTTP when it says it takes them so, else stdio). */
  readonly mount?: 'http' | 'stdio';
  /** True: its model list starts with Default, the model it's set to. */
  readonly defaultModel?: boolean;
  /** A model it knows, or undefined for its own (default: acpModel). */
  model?(model: string | undefined): string | undefined;
  /** Beluga's effort as one of the session's options (its thinking level), or undefined: none. */
  effort?(effort: string | null | undefined): { readonly id: string; readonly value: string } | undefined;
  /** A file of its own notes for this conversation: written without being judged. */
  ownNote?(sessionId: string, file: string): boolean;
  /** Its own question tool: asked of the person as Beluga's card, the answer its next turn. */
  readonly questions?: {
    /** The tool's name, as the dialect's toolOf says it. */
    readonly tool: string;
    detect(raw: Record<string, unknown> | undefined): ClaudeQuestion | undefined;
    answer(asked: ClaudeQuestion, reply: ClaudeAnswer): string;
  };
  /** True: `/compact` is its own command, its summary kept out of the chat. */
  readonly compact?: boolean;
  /** What it's told after a turn it ended silently on a declined step (default: declinedNote). */
  declinedNote?(why: readonly string[]): string;
  /** A failed run as its own (default: acpFailure with its id). */
  failure?(end: RunEnd & { readonly cause?: unknown }): Error;
  /** What's left of your plan's quota, for the usage tab. */
  quota?(): Promise<UsageUpdate | undefined>;
  /** Once a daemon: what earlier looks left behind. */
  tidy?(): Promise<unknown>;
  /** Drops a conversation it keeps (after a look or a side call). */
  dropSession?(sessionId: string): Promise<unknown>;
  /** After a look's process stopped: what it left (its log). */
  afterLook?(pid: number): Promise<unknown>;
  /**
   * Flags it starts with after its spec's `args`, made ready first (Antigravity: a Gemini folder
   * without your global rules). A version that says it doesn't know one ("flag provided but not
   * defined") is started without them, and that executable goes on without them while the daemon
   * runs. Failing to make them ready starts it without them too.
   */
  launch?(): Promise<readonly string[]>;
}
