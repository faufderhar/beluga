import { sideCalls } from '../side-calls.js';
import type { AgentBackend, AgentRunInput, TerminalSink } from '../types.js';
import type { Complete, RuntimeId } from './types.js';

/** Runtimes' names, for the words a routed call says when one can't do something. */
const RUNTIME_LABELS: Readonly<Record<string, string>> = { codex: 'Codex', opencode: 'OpenCode', copilot: 'Copilot', grok: 'Grok Build' };

/** The side calls a backend may offer (agent/side-calls.ts). */
export type SideCallBackend = Pick<AgentBackend, 'nameTask' | 'titlePlan' | 'titleChat' | 'answerChat' | 'fixSetup' | 'fixRun' | 'workOutScripts' | 'draftTask' | 'describeProject' | 'reviewPr'>;

/**
 * Where a side call goes (BLG-503): `own`, your default agent's runtime's one-shot call (Codex's),
 * then `claude`, Claude's backend, when there's no `own`, or it failed. Neither: the plain answer.
 */
export interface SideRoute {
  readonly own?: { readonly complete: Complete; readonly cwd: string; readonly model?: string };
  readonly claude?: () => SideCallBackend | undefined | Promise<SideCallBackend | undefined>;
}

/**
 * A side call (naming a worktree, a draft, a setup fix…) on your agent's runtime, falling back to
 * Claude's when that one failed. The side calls keep their own plain fallbacks (a slug, no draft),
 * so a failure is seen at its runtime call: any that threw (not stopped by its own time limit).
 */
export async function routeSideCall<T>(route: SideRoute, run: (on: SideCallBackend) => Promise<T> | undefined, plain: T): Promise<T> {
  if (route.own) {
    const { complete, cwd, model } = route.own;
    let failed = false;
    const watched: Complete = (req) =>
      complete(req).catch((err: unknown) => {
        if (!req.signal?.aborted) failed = true;
        throw err;
      });
    const out = await Promise.resolve(run(sideCalls(watched, cwd, model))).catch(() => {
      failed = true;
      return undefined;
    });
    if (!failed) return out ?? plain;
  }
  const claude = await Promise.resolve(route.claude?.()).catch(() => undefined);
  const out = claude ? await Promise.resolve(run(claude)).catch(() => undefined) : undefined;
  return out ?? plain;
}

/**
 * One backend for the session layer that runs each turn on its place's runtime (BLG-445): this
 * worktree's Claude and that one's Codex side by side. `backendFor` makes (once) and returns a
 * runtime's backend, already guarded (guard.ts); undefined for one this Beluga doesn't run.
 * Everything that isn't a turn (naming a worktree, side calls) stays with the default's; usage is
 * asked of every runtime in `alsoUsage` too.
 */
export function routedBackend(fallback: AgentBackend, fallbackRuntime: RuntimeId, backendFor: (id: RuntimeId) => AgentBackend | undefined, alsoUsage: readonly RuntimeId[] = []): AgentBackend {
  const made = new Map<RuntimeId, AgentBackend>([[fallbackRuntime, fallback]]);
  const pick = (id: RuntimeId): AgentBackend | undefined => {
    if (!made.has(id)) {
      const b = backendFor(id);
      if (b) made.set(id, b);
    }
    return made.get(id);
  };
  /** MCP Apps go through Claude Code (the only runtime that records apps). */
  const claudeOnly = <T>(method: 'mcpReadUiResource' | 'mcpAppTools' | 'mcpAppCall' | 'mcpAppRead', use: (claude: AgentBackend) => Promise<T>): Promise<T> => {
    const claude = pick('claude');
    return claude?.[method] ? use(claude) : Promise.reject(new Error('Claude Code isn’t running here.'));
  };
  return Object.assign(Object.create(fallback) as AgentBackend, {
    run: (input: AgentRunInput) => {
      const id = input.place?.agent?.runtime ?? fallbackRuntime;
      const backend = pick(id);
      if (!backend) return Promise.reject(new Error(`${input.place?.agent?.label ?? id} isn't set up on this Mac. Pick another agent for this worktree.`));
      return backend.run(input);
    },
    // The agent's own terminal on a conversation (BLG-534): its runtime's, as its turns are.
    terminal: (input: AgentRunInput, sink: TerminalSink) => {
      const id = input.place?.agent?.runtime ?? fallbackRuntime;
      const backend = pick(id);
      if (!backend?.terminal) return Promise.reject(new Error(`${input.place?.agent?.label ?? id} conversations stay in the chat: the terminal view is Claude Code’s (and local models’, which run in it).`));
      return backend.terminal(input, sink);
    },
    // A side question (/btw) forks the conversation's own session: on its runtime, or not at all.
    btw: (req: Parameters<NonNullable<AgentBackend['btw']>>[0]) => {
      const id = req.runtime ?? fallbackRuntime;
      const backend = pick(id);
      if (!backend?.btw) return Promise.reject(new Error(`Side questions aren’t available on ${RUNTIME_LABELS[id] ?? 'this agent'} yet`));
      return backend.btw(req);
    },
    // Usage: the default's comes back (Claude's, filed by the session); the others in `alsoUsage`
    // report their own through the bridge, under their own agent (Codex's plan windows, BLG-474).
    refreshUsage: async () => {
      for (const id of alsoUsage) if (id !== fallbackRuntime) void pick(id)?.refreshUsage?.().catch(() => undefined);
      return fallback.refreshUsage?.();
    },
    // MCP servers (Settings, BLG-518): the asked runtime's own (Codex's from its config.toml), else the default's.
    mcpServers: async (projects: readonly string[], runtime?: RuntimeId) => (await pick(runtime ?? fallbackRuntime)?.mcpServers?.(projects)) ?? [],
    mcpSignIn: async (projects: readonly string[], name: string, runtime?: RuntimeId) => (await pick(runtime ?? fallbackRuntime)?.mcpSignIn?.(projects, name)) ?? { error: `${(runtime && RUNTIME_LABELS[runtime]) ?? 'Your agent'} isn’t running here.` },
    mcpSignedIn: (name: string, runtime?: RuntimeId) => pick(runtime ?? fallbackRuntime)?.mcpSignedIn?.(name) ?? Promise.resolve(undefined),
    // MCP Apps: through Claude Code.
    mcpReadUiResource: (projects: readonly string[], server: string, uri: string) => claudeOnly('mcpReadUiResource', (c) => c.mcpReadUiResource!(projects, server, uri)),
    mcpAppTools: (projects: readonly string[], server: string) => claudeOnly('mcpAppTools', (c) => c.mcpAppTools!(projects, server)),
    mcpAppCall: (projects: readonly string[], server: string, tool: string, args: Readonly<Record<string, unknown>>) => claudeOnly('mcpAppCall', (c) => c.mcpAppCall!(projects, server, tool, args)),
    mcpAppRead: (projects: readonly string[], server: string, uri: string) => claudeOnly('mcpAppRead', (c) => c.mcpAppRead!(projects, server, uri)),
    mcpSigningIn: (name: string, runtime?: RuntimeId) => pick(runtime ?? fallbackRuntime)?.mcpSigningIn?.(name) ?? false,
    mcpSetEnabled: async (projects: readonly string[], name: string, enabled: boolean, runtime?: RuntimeId) =>
      (await pick(runtime ?? fallbackRuntime)?.mcpSetEnabled?.(projects, name, enabled)) ?? { error: 'This agent’s servers are turned on and off in its own settings.' },
  });
}
