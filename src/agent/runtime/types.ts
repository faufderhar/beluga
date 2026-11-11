import type { ToolSuite } from '../tool-kit.js';
import type { AgentBackend, AgentRunInput, RoomBridge } from '../types.js';

/**
 * The seam between Beluga and whatever agent does the work (Claude Code today; Codex, a local
 * model or any Agent Client Protocol agent later). Beluga's session layer (core/session.ts,
 * core/agent-host.ts) talks to an AgentRuntime and the AgentBackend it makes, never to an SDK:
 * every `@anthropic-ai/claude-agent-sdk` import lives under src/agent/runtime/claude/.
 *
 * AgentRunInput (agent/types.ts) is the product's requirements list, so a run keeps that shape:
 * a runtime takes the whole input and honours what its capabilities say it can. Where it can't,
 * the session layer reads RuntimeCapabilities and adapts (no steer box, no plan toggle, a sandbox)
 * instead of assuming Claude.
 *
 * Names follow Zed's Agent Client Protocol where one exists, so an ACP adapter maps one to one:
 * `initialize` → `capabilities`, `session/new` / `session/load` → `run` with `place.resume`,
 * `session/prompt` → the prompt and its follow-ups, `session/cancel` → `signal` and
 * `Steer.interrupt`, `session/request_permission` → `canUseTool`, `session/update` → `onEvent` /
 * `onStep`.
 *
 * What runner.ts does today, and where it goes through this seam:
 * - start a run (prompt stream, cwd, extra folders, model, effort, env, max turns, the system-prompt
 *   additions: briefs, scratch, ask-only): `AgentBackend.run(AgentRunInput)`, with `place`
 * - resume: `AgentPlace.resume` + `onSession` (capability `canResume`)
 * - fork: `AgentPlace.forkSession` (capability `canFork`)
 * - steer: `AgentRunInput.onSteer` → `Steer` (capability `canSteer`)
 * - interrupt, Send now: `Steer.interrupt` / `Steer.force` (capability `canInterrupt`)
 * - follow-ups while background agents work: `AgentRunInput.onFollowUps` (capability `hasBackgroundAgents`)
 * - plan mode and plan approval: `AgentRunInput.plan`, `askUser({ kind: 'plan' })` (capability `hasPlanMode`)
 * - questions to the person: `AgentRunInput.askUser` (capability `canAskUser`)
 * - subagents: `onEvent('sub', …)` (capability `hasSubagents`)
 * - canUseTool / vetTool / canUseSecret: called before every tool when `canGateEveryTool`
 * - hooks: PreToolUse is how Claude gates every tool (the same callbacks); PostCompact feeds
 *   `onEvent('compact', …)` (capability `hasCompaction`)
 * - usage: `onEvent('usage', …)`, `RoomBridge.reportUsage`, `AgentBackend.refreshUsage` (capability `hasUsage`)
 * - model list: `AgentBackend.listModels` (capability `hasModelList`)
 * - process handle: `AgentRunInput.onProcess` → `RunProcess` (capability `hasProcess`)
 * - Beluga's tools (room, board, plans, views, Mac, phone, sentinels): `toolMounts`
 * - images in a prompt: capability `promptImages` (ACP's promptCapabilities.image)
 * - side calls (naming a worktree, drafting a task, a chat answer, fixing setup): `complete`
 *
 * SAFETY RULE. Beluga's guarantees (.env files blocked, a friend's vetTool limits, the owner
 * approving risky actions, a main folder staying read-only: agent/policy.ts) hold only when the
 * runtime asks Beluga before EVERY tool call it makes, its own built-in tools included. A runtime
 * that can't (`canGateEveryTool: false`) gets no guest and no run without a sandbox, and a
 * friend's task only when its own sandbox confines every step (`hasSandbox`; see `safetyFor`).
 */

/**
 * How long a runtime gets to stop a running turn when asked (Steer.interrupt, Send now, Stop):
 * the same contract for every runtime. Past it, the interrupt says it couldn't.
 */
export const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * How long a run may stay open after answering while its background agents (Claude's) or
 * sub-agents (Codex's) still work: the same limit for every runtime.
 */
export const BACKGROUND_LIMIT_MS = 3 * 60 * 60_000;

/** Which runtime: 'claude' or 'codex' (the AgentRef protocol work names the rest). */
export type RuntimeId = string;

/** What a runtime can do, asked by the session layer, policy and the screens instead of assuming. */
export interface RuntimeCapabilities {
  /**
   * Every tool call, built-ins included, waits on Beluga's vetTool / policy / canUseTool before it
   * runs (Claude: the PreToolUse hook and canUseTool). False: policy.ts's guarantees don't hold and
   * the run needs a sandbox (see the safety rule above).
   */
  readonly canGateEveryTool: boolean;
  /**
   * Its own sandbox confines every step it takes to the run's folders, with secrets (.env files,
   * keys, credential stores) unreachable and the network off for friends (Codex's permission
   * profiles). With it, a runtime that can't gate every tool may still take friends' tasks.
   */
  readonly hasSandbox: boolean;
  /** A message sent in while it works is taken in at its next step (Steer). */
  readonly canSteer: boolean;
  /** A running turn can be stopped and the next message answered (Steer.interrupt / force). */
  readonly canInterrupt: boolean;
  /** Read-only planning, then a plan for the person to approve (AgentRunInput.plan). */
  readonly hasPlanMode: boolean;
  /** Sub-agents whose steps show as their own ('sub' events). */
  readonly hasSubagents: boolean;
  /** The run stays open after answering while background agents work (onFollowUps). */
  readonly hasBackgroundAgents: boolean;
  /** Plan limits and per-turn tokens/cost ('usage' events, refreshUsage). */
  readonly hasUsage: boolean;
  /** A conversation can be continued by its session id (ACP's loadSession). */
  readonly canResume: boolean;
  /** A conversation can be branched into a new one (AgentPlace.forkSession). */
  readonly canFork: boolean;
  /** It can ask the person a question mid-run (askUser). */
  readonly canAskUser: boolean;
  /** It compacts its own context and says so ('compact' events). */
  readonly hasCompaction: boolean;
  /** It lists the models it offers (listModels). */
  readonly hasModelList: boolean;
  /** Its process can be watched and killed for sure (onProcess). */
  readonly hasProcess: boolean;
  /**
   * Claude Code's skills and custom commands (`/name`): 'native' (Claude Code runs them itself) or
   * 'mapped' (skills and commands translated, what can't be said in a "not on Codex" note).
   */
  readonly skills: 'native' | 'mapped';
  /** Images can go in a prompt (ACP's promptCapabilities.image). */
  readonly promptImages: boolean;
  /**
   * How Beluga's own tools reach it: 'in-process' (Claude's fast path, createSdkMcpServer),
   * 'stdio' (the standalone `beluga mcp-serve` server, scoped to the run by a token) or 'http'
   * (the tool host itself on 127.0.0.1, the run's token as a bearer: Copilot's ACP takes no stdio).
   */
  readonly toolMounts: readonly ('in-process' | 'stdio' | 'http')[];
}

/** What a runtime is made with: the room's folder and bridge, the default model. */
export interface RuntimeOptions {
  readonly cwd: string;
  /** Let the agent edit files in cwd without asking (share was marked :rw). */
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** The agent's own executable (Claude Code's path); unset: the runtime finds it. */
  readonly executablePath?: string;
  /**
   * Your saved variables (Settings › Environment) for something of your own starting in `cwd`, as
   * your runs there get them, read fresh each call: Settings' MCP check uses them, so a token kept
   * there isn't reported missing (#442). Never for a friend's run, never logged or shown.
   */
  readonly ownEnv?: (cwd: string) => Readonly<Record<string, string>>;
}

/**
 * A one-shot side call (BLG-441): name a worktree, draft a task, answer room chat, fix a setup.
 * No conversation, no saved session, no settings files, few or no tools, one answer.
 */
export interface CompletionRequest {
  readonly prompt: string;
  /** Pictures the prompt is about (a chat's pasted images), before its text. Given: the prompt streams in. */
  readonly images?: ReadonlyArray<{ readonly mime: string; readonly data: string }>;
  /** The whole system prompt (instead of the runtime's own). */
  readonly system: string;
  readonly cwd: string;
  /** "haiku" (small and fast), "sonnet", or a full id; a runtime maps an alias to its own. Unset: its default. */
  readonly model?: string;
  /** Built-in tools it may use (Read, Glob, Grep, Bash); none when unset. */
  readonly tools?: readonly string[];
  /** Of those (and the suites' tools, by full name), the ones that run without asking. */
  readonly allowedTools?: readonly string[];
  /** Beluga's tools for this call, by server name (a chat's read_earlier); nothing else is mounted. */
  readonly suites?: Readonly<Record<string, ToolSuite>>;
  /** Asked before each tool call: allowed (run without asking) or denied, and the reason told to the model. */
  readonly vetTool?: (toolName: string, input: Record<string, unknown>) => { readonly allow: boolean; readonly reason: string };
  /** At most this many turns (default 1). */
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

/** Why a side call has no answer: it ran out of turns, failed, or ended saying nothing. */
export class CompletionError extends Error {
  constructor(readonly kind: 'max_turns' | 'failed' | 'no_answer') {
    super(kind === 'max_turns' ? 'ran out of turns' : kind === 'failed' ? 'could not answer' : 'stopped without an answer');
  }
}

/** A runtime's side call: the answer's text, or a CompletionError (an abort rejects as the runtime does). */
export type Complete = (req: CompletionRequest) => Promise<string>;

/** Whether a runtime is ready on this Mac (installed, signed in), what to do when not, and its models. */
export interface RuntimeStatus {
  readonly state: 'ready' | 'signed_out' | 'missing';
  readonly fix?: string;
  readonly models: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description: string; readonly efforts?: readonly string[] }>;
}

/** One agent kind Beluga can run. */
export interface AgentRuntime {
  readonly id: RuntimeId;
  /** Its name for people ("Claude", "Codex"). */
  readonly label: string;
  readonly capabilities: RuntimeCapabilities;
  /** A backend for one room or workspace: runs turns (AgentBackend.run) and the extras it supports. */
  create(opts: RuntimeOptions): AgentBackend;
  /** A side call (agent/side-calls.ts): its answer's text, or a CompletionError. */
  readonly complete: Complete;
  /** Whether it's installed and signed in here, and its models (the picker greys it out until it is). */
  status?(): Promise<RuntimeStatus>;
}

/** How a run is kept safe on a runtime. */
export type RunSafety =
  /** Beluga vets every tool call (policy.ts holds). */
  | { readonly kind: 'gated' }
  /** It can't: the run needs a sandbox, and refuses what only per-tool gating made safe. */
  | { readonly kind: 'sandbox'; readonly refuse?: string };

/**
 * The safety rule as code: no per-tool gating ⇒ sandbox required (its secrets, .env files
 * included, kept out by the sandbox, not by asking). A guest can't run at all without gating; a
 * friend's task (vetTool) only on a runtime whose sandbox confines every step (BLG-452: Codex's
 * workspace-write, network off, secrets unreachable; see runtime/codex/sandbox.ts).
 */
export function safetyFor(caps: RuntimeCapabilities, input?: Pick<AgentRunInput, 'vetTool' | 'guest' | 'asOwner'>): RunSafety {
  if (caps.canGateEveryTool) return { kind: 'gated' };
  const refuse = input?.vetTool && !input.asOwner && !caps.hasSandbox
    ? "This agent can't check each step against a friend's limits, so it can't take friends' tasks."
    : input?.guest
      ? "This agent can't check each step, so it can't answer guests."
      : undefined;
  return refuse ? { kind: 'sandbox', refuse } : { kind: 'sandbox' };
}
